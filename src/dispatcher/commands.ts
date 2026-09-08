import type { Channel, IncomingMessage } from "../channels/types.js";
import type { SessionManager } from "../session/manager.js";
import { resolveWorkspacePath } from "../config/loader.js";
import { collectStatus, formatStatusMarkdown } from "../session/status.js";
import { findScriptCommand, runScriptCommand } from "./script-commands.js";
import {
  loadAutopilot,
  updateAutopilot,
  stopAutopilot,
  isRunning,
  readGoal,
  checkGoal,
  goalFilePath,
  MAX_GOAL_CHARS,
  MAX_GOAL_LINE_CHARS,
  archiveRun,
  saveAutopilot,
  type GoalProblem,
  type AutopilotRecord,
  type AutopilotStopReason,
} from "../session/autopilot.js";
import { formatDuration } from "../session/transcript-watcher.js";
import { readableTime, zoneLabel } from "../time.js";
import fs from "node:fs";

export interface CommandResult {
  handled: boolean;
}

/**
 * Send a command reply, threading it back into the originating Lark thread when
 * the triggering message was in one — so `/status` etc. answer inside the thread
 * rather than the main chat.
 */
function sendCmdReply(
  channel: Channel,
  message: IncomingMessage,
  content: string
): Promise<unknown> {
  return channel.sendReply(
    message.chatId,
    content,
    message.threadId
      ? { replyToMessageId: message.messageId, replyInThread: true }
      : undefined
  );
}

export async function handleCommand(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  const text = message.text.trim();

  if (text === "/status") {
    return handleStatus(channel, message, sessionManager);
  }

  if (text === "/new" || text.startsWith("/new ")) {
    return handleNew(channel, message, sessionManager, text);
  }

  if (text === "/workspace") {
    return handleWorkspace(channel, message, sessionManager);
  }

  if (text === "/mention-off") {
    return handleMentionOff(channel, message, sessionManager);
  }

  if (text === "/mention-on") {
    return handleMentionOn(channel, message, sessionManager);
  }

  if (text === "/pick" || text.startsWith("/pick ")) {
    return handlePick(channel, message, sessionManager, text.slice(5).trim());
  }

  if (text === "/model" || text.startsWith("/model ")) {
    return handleModel(channel, message, sessionManager, text.slice(6).trim());
  }

  if (isAutopilotCommand(text)) {
    return handleAutopilot(channel, message, sessionManager, text);
  }

  // Built-ins are matched above, so a user script can never shadow one.
  return handleScript(channel, message, sessionManager, text);
}

/**
 * Answer `/name …` from ~/.cork/commands/name when such an executable exists.
 * Anything else falls through to claude, unchanged.
 */
async function handleScript(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  text: string
): Promise<CommandResult> {
  if (!text.startsWith("/")) return { handled: false };

  const space = text.search(/\s/);
  const name = (space === -1 ? text : text.slice(0, space)).slice(1);
  const args = space === -1 ? "" : text.slice(space + 1).trim();

  const file = findScriptCommand(name);
  if (!file) return { handled: false };

  const session = sessionManager.getSession(
    message.channel,
    message.chatId,
    message.threadId
  );
  // "" when this chat has no session yet — a script gets an empty
  // CORK_SESSION_KEY rather than an id that addresses nothing.
  const key =
    session?.key ??
    sessionManager.sessionKeyFor(
      message.channel,
      message.chatId,
      message.threadId
    ) ??
    "";
  const workspace = session?.meta.workspace ?? sessionManager.defaultWorkspace();

  const { reply } = await runScriptCommand(
    name,
    file,
    args,
    message,
    key,
    workspace
  );

  if (reply) await sendCmdReply(channel, message, reply);
  return { handled: true };
}

async function handleStatus(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  const session = sessionManager.getSession(message.channel, message.chatId, message.threadId);

  let reply = `📊 **Session Status**\n`;

  if (session) {
    reply += formatStatusMarkdown(await collectStatus(session.key, session.meta));
  } else {
    reply += `No session yet (send a message to start one)`;
  }

  await sendCmdReply(channel, message, reply);
  return { handled: true };
}

async function handleNew(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  text: string
): Promise<CommandResult> {
  const pathArg = text.slice("/new".length).trim();

  // Validate path
  if (pathArg && pathArg.includes("..")) {
    await sendCmdReply(channel, message, "❌ Invalid path: '..' not allowed");
    return { handled: true };
  }

  const workspace = pathArg ? resolveWorkspacePath(pathArg) : undefined;

  if (workspace) {
    fs.mkdirSync(workspace, { recursive: true });
  }

  const meta = sessionManager.createNewSession(
    message.channel,
    message.chatId,
    message.threadId,
    workspace
  );

  let reply = `✅ New session created\n`;
  reply += `Workspace: \`${meta.workspace}\`\n`;
  reply += `Session: \`${meta.sessionId}\``;

  await sendCmdReply(channel, message, reply);
  return { handled: true };
}

async function handleWorkspace(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  const session = sessionManager.getSession(message.channel, message.chatId, message.threadId);
  const workspace = session?.meta.workspace || "(no session)";
  await sendCmdReply(channel, message, `📂 Current workspace: \`${workspace}\``);
  return { handled: true };
}

/**
 * `/pick <n|esc>` — answer the dialog claude is showing.
 *
 * Every dialog is answered the same way, by walking the cursor and pressing
 * Enter, so this works on the ones that number their options and the ones that
 * do not. The numbers here are cork's, in the order the options were drawn and
 * the order they were listed in the message.
 */
async function handlePick(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  arg: string
): Promise<CommandResult> {
  const session = sessionManager.getSession(
    message.channel,
    message.chatId,
    message.threadId
  );
  if (!session) {
    await sendCmdReply(channel, message, "ℹ️ No session here yet — say something first.");
    return { handled: true };
  }

  const dialog = sessionManager.currentDialog(session.key);
  if (!dialog) {
    await sendCmdReply(channel, message, "ℹ️ Dialog not on screen");
    return { handled: true };
  }

  // Nothing is pressed for an argument cork cannot read, so this is a failure
  // to answer like any other rather than a category of its own.
  const wantsEsc = /^esc(ape)?$/i.test(arg);
  if (!arg || (!wantsEsc && !/^\d+$/.test(arg))) {
    await sendCmdReply(channel, message, "⚠️ Dialog not answered — invalid option");
    return { handled: true };
  }

  const target = wantsEsc ? ("esc" as const) : Number(arg) - 1;
  const r = await sessionManager.answerDialog(session.key, target);

  if (!r.ok) {
    await sendCmdReply(channel, message, `⚠️ Dialog not answered — ${r.reason}`);
    return { handled: true };
  }
  // "closed" for Esc, the same word the watcher uses when someone closes one
  // at the terminal: it is the same event, and two names for it read as two
  // different things having happened.
  const done = r.title ? ` — ${r.title}` : "";
  await sendCmdReply(
    channel,
    message,
    wantsEsc ? `✅ Dialog closed${done}` : `✅ Dialog answered — ${r.chosen}`
  );
  return { handled: true };
}

/**
 * `/model <name>` — put THIS session on another model, and only this one.
 *
 * Typing `/model <name>` into claude itself would also write the machine-wide
 * default, so cork drives the picker instead and presses `s`. See
 * SessionManager.switchModel for the walk and why each step is there.
 *
 * With no argument this reports what the session is on. Cork does not offer a
 * list of its own: the models a session can reach depend on entitlements and
 * change with every release, so the only honest list is the one claude just
 * drew, which is what a failed match hands back.
 */
async function handleModel(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  requested: string
): Promise<CommandResult> {
  const session = sessionManager.getSession(
    message.channel,
    message.chatId,
    message.threadId
  );
  if (!session) {
    await sendCmdReply(channel, message, "ℹ️ No session here yet — say something first.");
    return { handled: true };
  }

  if (!requested) {
    const current = sessionManager.currentModel(session.key);
    await sendCmdReply(
      channel,
      message,
      current
        ? `🧠 This session is on ${current}`
        : "🧠 Could not read the model off the terminal — `/model <name>` to set one"
    );
    return { handled: true };
  }

  const r = await sessionManager.switchModel(session.key, requested);

  if (r.ok && r.already) {
    await sendCmdReply(channel, message, `🧠 Already on ${r.model}`);
    return { handled: true };
  }
  if (r.ok) {
    await sendCmdReply(channel, message, `🧠 Switched to ${r.model}`);
    return { handled: true };
  }

  let reply = `⚠️ Model not switched — ${r.reason}`;
  if (r.options?.length) {
    reply += `\n\nOn offer in this session:\n${r.options.map((o) => `- ${o}`).join("\n")}`;
  }
  if (r.screen) {
    reply += `\n\nThe terminal is showing this — it may need you:\n\`\`\`\n${dialogExcerpt(r.screen)}\n\`\`\``;
  }
  await sendCmdReply(channel, message, reply);
  return { handled: true };
}

/** The part of a captured pane worth putting in a chat message. */
function dialogExcerpt(pane: string): string {
  const lines = pane.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  return lines.slice(-20).join("\n").slice(-1200);
}

async function handleMentionOff(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  if (message.chatType !== "group") {
    await sendCmdReply(channel, message, "ℹ️ /mention-off only applies to group chats.");
    return { handled: true };
  }
  sessionManager.setMentionRequired(message.channel, message.chatId, false);
  await sendCmdReply(channel, message, "✅ Mention requirement disabled. Owner messages will be processed without @bot.");
  return { handled: true };
}

async function handleMentionOn(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  if (message.chatType !== "group") {
    await sendCmdReply(channel, message, "ℹ️ /mention-on only applies to group chats.");
    return { handled: true };
  }
  sessionManager.setMentionRequired(message.channel, message.chatId, true);
  await sendCmdReply(channel, message, "✅ Mention requirement enabled. @bot is required again.");
  return { handled: true };
}

/**
 * `/autopilot` and its short form `/ap`. The long one is the name; the short
 * one is what anybody actually types, `/ap status` being nine characters
 * shorter than the thing it stands for.
 */
const AUTOPILOT_COMMANDS = ["/autopilot", "/ap"] as const;

function isAutopilotCommand(text: string): boolean {
  return AUTOPILOT_COMMANDS.some((c) => text === c || text.startsWith(`${c} `));
}

/** The text after the command word, whichever spelling was used. */
function autopilotArg(text: string): string {
  const cmd = AUTOPILOT_COMMANDS.find((c) => text === c || text.startsWith(`${c} `));
  return cmd ? text.slice(cmd.length).trim() : "";
}

/**
 * `/autopilot …` — the four steps of running one, in the order they happen.
 *
 *   /autopilot <what you want done>   talk it through with the model, which
 *                                    writes GOAL.md and PROJECT.md
 *   /autopilot start                  type GOAL.md's first line into the pane as
 *                                    `/goal …` and start watching
 *   /autopilot stop                   clear the goal and stop watching
 *   /autopilot status                 where it is up to
 *
 * The drafting step is deliberately NOT answered here: cork rewrites the
 * message and lets it through to the model, because agreeing on a goal is a
 * conversation, not a command. Everything else is settled without a model turn.
 */
async function handleAutopilot(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  text: string
): Promise<CommandResult> {
  const arg = autopilotArg(text);
  const key = sessionManager.sessionKeyFor(
    message.channel,
    message.chatId,
    message.threadId
  );
  if (!key) {
    await sendCmdReply(channel, message, "❌ No session here yet — say something first.");
    return { handled: true };
  }

  if (arg === "status") {
    await sendCmdReply(channel, message, autopilotStatus(key));
    return { handled: true };
  }

  if (arg === "start") {
    const reply = await startAutopilot(channel, message, sessionManager, key);
    if (reply) await sendCmdReply(channel, message, reply);
    return { handled: true };
  }

  if (arg === "stop") {
    const reply = await stopAutopilotRun(sessionManager, key);
    if (reply) await sendCmdReply(channel, message, reply);
    return { handled: true };
  }

  // Anything else — including nothing at all — starts the drafting
  // conversation. A bare `/autopilot` is the useful case rather than a mistake:
  // a job worth running for hours is usually one the user would rather talk
  // through than fit into a single line, and the model can ask.
  if (isRunning(loadAutopilot(key))) {
    // Dropping straight into drafting would leave the current goal set with
    // nobody watching it: cork would stop nudging and stop reporting, while the
    // model kept working toward it.
    await sendCmdReply(
      channel,
      message,
      "❌ Autopilot is already running here. Run `/autopilot stop` first."
    );
    return { handled: true };
  }

  // Mark the session as drafting and let the message through untouched —
  // `handled: false` so the dispatcher routes it on.
  //
  // Deliberately NOT rewritten into instructions. The model already has
  // everything it needs: `/autopilot` is what the cork-autopilot skill triggers
  // on, and cork puts the session's own directory on the model's allowed dirs,
  // so it can see where GOAL.md goes. Pasting boilerplate in front of the
  // user's words would only bury them — and make every session's message
  // preview read the same.
  // File the last run before anything overwrites it. Only a run that has
  // ENDED is archived; there is no other state this branch can be reached in
  // with a goal still worth keeping.
  const archived = archiveRun(key);

  // The whole record, not a patch. Drafting is a run that has not begun, and
  // every field but `state` describes one that has: times, counters, the
  // verdict. Clearing the ones that looked dangerous left the rest to leak —
  // a drafting session reported `Started: … 1h3min`, which was the previous
  // run's whole duration, presented as if it were this one's. Whatever the
  // last run left behind is in the archive now; the record starts empty.
  saveAutopilot(key, { state: "drafting" });

  // Said before the model sees the message, because this branch takes anything
  // it does not recognise — including a question that merely begins with
  // `/ap `, which is how this session once started drafting a goal nobody had
  // asked for. Both sides were content: cork wrote the record, the model
  // answered the question, and the one person who could tell the two apart was
  // the only one not told. Changing the record is worth a line.
  await sendCmdReply(
    channel,
    message,
    archived
      ? "📝 Autopilot drafting — previous run archived."
      : "📝 Autopilot drafting."
  );
  return { handled: false };
}

/**
 * Type GOAL.md into the pane as a `/goal`, and hand the outcome to the watcher.
 *
 * Nothing here reports success: typing a command and the command taking effect
 * are different events, and only the transcript says whether the second one
 * happened. The watcher is what reads it, and what tells the user — so this
 * returns a reply only when it did not even get as far as typing.
 */
async function startAutopilot(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  key: string
): Promise<string | null> {
  const rec = loadAutopilot(key);
  if (isRunning(rec)) {
    return "ℹ️ Autopilot is already running here. `/autopilot status` shows it.";
  }

  const goal = readGoal(key);
  const problem = checkGoal(goal, key);
  if (problem) {
    // Refuse rather than send something truncated or mangled: a goal that is
    // wrong in a way nobody notices is worse than one that never started.
    return (
      `❌ Autopilot did not start.\n\n${goalProblemMessage(problem)}` +
      `\n\nGOAL.md: \`${goalFilePath(key)}\``
    );
  }

  // Only into an idle session. A command typed while the model is mid-turn is
  // queued behind it — measured at 53 seconds on a long answer — and a start
  // that lands a minute late is one the user has already given up on. Rather
  // than wait, say so, and ask the model to come to a stop so the next attempt
  // finds a quiet pane.
  if (!sessionManager.sessionIsIdle(key)) {
    sessionManager.dispatchSystemMessage(
      key,
      message.chatId,
      "The user wants to start autopilot, which cork can only do while this " +
        "session is idle. Finish or park what you are doing and stop, rather " +
        "than starting anything further.",
      "cork:autopilot"
    );
    return (
      "⏳ Autopilot did not start — the model is busy right now. It has been " +
      "asked to stop; try `/autopilot start` again in a moment."
    );
  }

  // The file, whole. What the evaluator reads after every turn and what the
  // model was given to work from are then the same text, with nothing to keep
  // in step and no second copy to drift.
  const condition = goal as string;
  const sent = await sessionManager.sendSlashCommand(key, `/goal ${condition}`);
  if (!sent.ok) {
    stopAutopilot(key, "start-failed", sent.reason);
    return `❌ Autopilot did not start — could not set the goal: ${sent.reason}`;
  }

  updateAutopilot(key, {
    state: "starting",
    goal: condition,
    startedAt: new Date().toISOString(),
    pendingSince: Date.now(),
    stoppedAt: undefined,
    stopReason: undefined,
    stopDetail: undefined,
    nudgeCount: 0,
    stuckWarned: false,
    restartCount: 0,
    compactCount: 0,
    clearAttempts: 0,
    driftChecks: 0,
  });
  sessionManager.watchAutopilot(key);
  return null; // the watcher speaks next
}

/**
 * Get rid of the goal, and hand the outcome to the watcher.
 *
 * The model is, by definition, mid-turn when autopilot is stopped — it is
 * working on the goal. So the pane is interrupted first: Escape leaves the
 * turn, and a command typed into the quiet that follows runs at once instead
 * of queueing behind an answer that may have a minute left in it.
 *
 * Three presses because one is not always enough: with editorMode "vim" the
 * first only leaves INSERT mode (measured: one press left the model streaming
 * 12 seconds later, three stopped it in 2.2). In the default mode one is
 * enough and the extra two do nothing.
 */
async function stopAutopilotRun(
  sessionManager: SessionManager,
  key: string
): Promise<string | null> {
  const rec = loadAutopilot(key);
  if (!isRunning(rec)) {
    return "🛑 Autopilot is not running here.";
  }

  // Typed, not waited on, and the record is written in the same breath.
  //
  // Whether it was submitted changes nothing here. A clear that never reached
  // the input box is not the end of the stop: the reasons it does not get
  // typed — a draft already in the box, a dialog, the history filter panel —
  // are states the pane is in for a moment, and the watcher's retry interrupts
  // before it types, which can be the thing that clears them. So both outcomes
  // wait on the same confirmation, and reporting failure here only to succeed
  // a minute later is worse than saying nothing.
  //
  // Waiting would also open a window there is no need to open. Typing can take
  // a minute and a half, and the run can end inside it — the goal met, or
  // cleared by hand — with the transcript side saying so and closing the run.
  // Writing `stopping` after that would reopen a run that is already over.
  // Written now, before anything can happen, there is no window at all.
  sessionManager.interruptPane(key);
  void sessionManager.sendSlashCommand(key, "/goal clear").catch(() => {});
  updateAutopilot(key, {
    state: "stopping",
    pendingSince: Date.now(),
    clearAttempts: 1,
  });
  return null; // the watcher confirms the goal is actually gone
}

function autopilotStatus(key: string): string {
  const rec = loadAutopilot(key);

  // `idle` is also what a session with no record at all reads as, and the two
  // are the same thing to the user: nothing here. Saying "Autopilot: idle"
  // invites the question of which autopilot.
  if (rec.state === "idle") {
    return (
      "📋 Autopilot is not running in this session. " +
      "`/autopilot <what you want done>` starts one."
    );
  }

  // The state, the goal, and how long it has been going. Nothing else.
  //
  // What used to be here was cork talking about itself: nudges, compactions,
  // goal checks, and a line under each transitional state saying what it was
  // waiting for. None of it says how the task is doing, and the counters
  // invite a judgement they cannot support — three nudges is a healthy paced
  // task as often as it is a stuck one. The state already names what is
  // happening, and the log has the rest.
  const lines = [`📋 **Autopilot**: ${rec.state}`];

  if (rec.goal) lines.push(`Goal: ${preview(rec.goal)}`);
  if (rec.startedAt) lines.push(`Started: ${startedLine(rec)}`);

  // How it ended, for a run that has. `stopped` alone does not say whether the
  // job got done, and that is the first thing anyone asks — the verdict was
  // announced when it happened, but a chat scrolls and this is where someone
  // comes to look it up. The reason is a word cork chose, so it is spelled out
  // rather than shown as the enum it is stored as.
  if (rec.state === "stopped" && rec.stopReason) {
    lines.push(`Ended: ${ENDINGS[rec.stopReason] ?? rec.stopReason}`);
    // Why, in the evaluator's own words, or the failure's. It runs to
    // thousands of characters on a real verdict, so it is cut to a couple of
    // lines; AUTOPILOT.json keeps all of it.
    if (rec.stopDetail) lines.push(`Why: ${preview(rec.stopDetail, 300)}`);
  }
  return lines.join("\n");
}

/**
 * Text short enough to read in a chat message.
 *
 * Both things this is used on run long: GOAL.md is the whole condition now, and
 * the evaluator's reasoning came to 3300 characters on a real run. Quoting
 * either in full turns a status line into a wall.
 */
/**
 * How a run ended, in words rather than in cork's vocabulary.
 *
 * The stored value is an enum this file happens to define; "user-stop" and
 * "unreachable" are precise to whoever wrote them and opaque to everyone else.
 */
const ENDINGS: Record<AutopilotStopReason, string> = {
  met: "completed — the goal was met",
  failed: "the goal was judged unachievable",
  "user-stop": "stopped on request",
  "start-failed": "never started",
  "stop-failed": "the goal could not be cleared",
  unreachable: "the session could not be brought back",
};

/**
 * When it started and how long that is, as one line.
 *
 * The record keeps UTC, which is right for a record and wrong for a person:
 * the daemon's clock is not the one the reader is looking at. Shown in the
 * configured zone and labelled, so it is never ambiguous which of the two a
 * timestamp is. The elapsed time is usually the actual question, and for a run
 * that has ended it is how long the whole thing took.
 */
function startedLine(rec: AutopilotRecord): string {
  const started = Date.parse(rec.startedAt as string);
  if (!Number.isFinite(started)) return rec.startedAt as string;
  const at = new Date(started);
  const stamp = `${readableTime(at)} (${zoneLabel(at)})`;
  const ms = (rec.stoppedAt ? Date.parse(rec.stoppedAt) : Date.now()) - started;
  if (!Number.isFinite(ms) || ms <= 0) return stamp;
  return `${stamp} · ${formatDuration(ms)}${rec.stoppedAt ? "" : " ago"}`;
}

function preview(text: string, max = 200): string {
  const oneLine = text.replace(/\s*\n\s*/g, " · ");
  const chars = [...oneLine];
  return chars.length <= max ? oneLine : `${chars.slice(0, max).join("")}…`;
}

function goalProblemMessage(problem: GoalProblem): string {
  switch (problem) {
    case "missing":
      return "There is no GOAL.md for this session yet. Run `/autopilot <what you want done>` first.";
    case "empty":
      return "GOAL.md is empty — it has to state the completion condition.";
    case "self-referential":
      return (
        "The goal is judged against PROJECT.md, which you rewrite as the work " +
        "goes on. That is a standard you could pass by editing the file, and " +
        "the evaluator — which re-reads whatever it was last shown — could not " +
        "tell. State the condition in GOAL.md itself, where nothing moves it."
      );
    case "is-command":
      return (
        "GOAL.md must be the condition itself, not a command. Cork prefixes it " +
        "with `/goal` — starting it with a slash makes the condition begin " +
        "with a command name."
      );
    case "too-long":
      return (
        `GOAL.md is longer than ${MAX_GOAL_CHARS} characters. The whole file ` +
        `becomes the goal, and the evaluator re-reads all of it after every ` +
        `turn — past this length it stops reading it closely. Cut it to what ` +
        `actually decides whether the job is done.`
      );
    case "line-too-long":
      return (
        `A single line of GOAL.md is longer than ${MAX_GOAL_LINE_CHARS} ` +
        `characters. Claude folds any one input past ~800 into a paste, where ` +
        `the \`/goal\` stops being a command at all — silently. Break the long ` +
        `line up; the file as a whole can stay as it is.`
      );
  }
}
