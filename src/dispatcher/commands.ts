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
  goalFilePath,
  archiveRun,
  saveAutopilot,
  headline,
} from "../session/autopilot.js";
import { sessionDir } from "../session/store.js";
import { formatDuration } from "../session/transcript-watcher.js";
import { formatPickerRows, type PickerRow } from "../session/model-picker.js";
import { formatTokens, type CompactOutcome } from "../session/transcript.js";
import { readableTime } from "../time.js";
import { getLogger } from "../logger.js";
import fs from "node:fs";

const logger = getLogger("commands");

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
  // `commandText` where the channel provides one: in a group the bot must be
  // named to be reached at all, so a command arrives as "@bot /status" and
  // would match nothing. That field is the same message with our own leading
  // mention removed; `message.text` keeps it, since the model should see what
  // was actually said.
  if (message.fromOwner === false) return { handled: false };
  const text = (message.commandText ?? message.text).trim();

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

  if (text === "/compact" || text.startsWith("/compact ")) {
    return handleCompact(channel, message, sessionManager, text.slice(8).trim());
  }

  if (text === "/exit") {
    return handleExit(channel, message, sessionManager);
  }

  if (text === "/allow" || text.startsWith("/allow ")) {
    return handleAllow(channel, message, sessionManager, "allow");
  }

  if (text === "/disallow" || text.startsWith("/disallow ")) {
    return handleAllow(channel, message, sessionManager, "disallow");
  }

  if (isAutopilotCommand(text)) {
    return handleAutopilot(channel, message, sessionManager, text);
  }

  // Built-ins are matched above, so a user script can never shadow one.
  return handleScript(channel, message, sessionManager, text);
}

/**
 * `/allow @A @B` and `/disallow @A`: who may talk to the bot in this chat
 * without commanding it. Answered by cork alone — it is a list edit, and a model turn
 * would only make it slow.
 *
 * The targets are the message's own @mentions, this bot's excluded. Only an
 * owner gets here (see handleCommand), and nothing here can make anyone an
 * owner.
 */
async function handleAllow(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  verb: "allow" | "disallow"
): Promise<CommandResult> {
  const targets = (message.mentions ?? []).filter((m) => !m.self);
  const reply = (t: string) => sendCmdReply(channel, message, t).then(() => ({ handled: true }));
  if (!channel.admitsEverywhere) return reply(`⚠️ /${verb} is not supported on this channel`);
  if (targets.length === 0) {
    return reply(
      verb === "allow"
        ? "Nothing to allow — mention who to add"
        : "Nothing to disallow — mention who to remove"
    );
  }
  const ids = targets.map((t) => t.id);
  const admitted = channel.admitsEverywhere.bind(channel);
  const change =
    verb === "allow"
      ? sessionManager.updateAllows(message, ids, [], admitted)
      : sessionManager.updateAllows(message, [], ids, admitted);
  // One line. Whoever changed is named with their id, so the right person can
  // be checked; whoever was already so gets just a name — nothing changed for
  // them, but leaving them out would read as someone mentioned and missed.
  const nameOf = (id: string) => targets.find((t) => t.id === id)?.name ?? id;
  const withIds = (list: string[]) => list.map((id) => `${nameOf(id)} (${id})`).join(", ");
  const names = (list: string[]) => list.map(nameOf).join(", ");
  const changed = verb === "allow" ? change.added : change.removed;
  const done = verb === "allow" ? "Allowed" : "Disallowed";
  if (changed.length === 0) {
    return reply(`Already ${done.toLowerCase()}: ${names(change.unchanged)}`);
  }
  return reply(
    `${done}: ${withIds(changed)}` +
      (change.unchanged.length ? ` · already: ${names(change.unchanged)}` : "")
  );
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
 * How to answer any list this command prints.
 *
 * A number first, because it is the one form that cannot be ambiguous: claude
 * names the new Opus `Opus (1M context)` with no version in it and the old one
 * `Opus 5 (1M context)`, so "opus" reaches both and reads like a trap.
 */
const MODEL_HINT = "`/model <n>` to switch, or `/model <name>`";

/** The rows in a block, where a chat will not re-flow the columns. */
function modelList(rows: PickerRow[]): string {
  return `\`\`\`\n${formatPickerRows(rows)}\n\`\`\``;
}

/**
 * `/model <name|n>` — put THIS session on another model, and only this one.
 *
 * Typing `/model <name>` into claude itself would also write the machine-wide
 * default, so cork drives the picker instead and presses `s`. See
 * SessionManager.switchModel for the walk and why each step is there.
 *
 * Every answer that is not a switch carries the list: with no argument, and
 * when a name reached no row or several. Cork has no list of its own — what a
 * session is offered depends on entitlements and moves with every release — so
 * it reads claude's picker for it and closes it again. A number off that list
 * is what comes back, which is why the list is never a dead end.
 *
 * The listing is deliberately NOT an interactive pick. Keeping the picker open
 * to take a `/pick` would hold the pane for as long as it takes someone to
 * read the message — minutes or hours — and the session can do nothing while
 * it is up. Worse, `/pick` answers with Enter, and Enter on this picker is
 * "set as default for new sessions", the very thing this command exists to
 * avoid. So the picker is closed immediately and reopened for the answer.
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
    const list = await sessionManager.listModels(session.key);
    if (list.ok) {
      const current = list.rows.find((r) => r.current)?.label;
      const head = current ? `🧠 On ${current}` : "🧠 On offer in this session";
      await sendCmdReply(
        channel,
        message,
        `${head}\n\n${modelList(list.rows)}\n${MODEL_HINT}`
      );
      return { handled: true };
    }
    // The picker would not open. The session still knows what it is on, and
    // saying that beats saying nothing.
    const current = sessionManager.currentModel(session.key);
    await sendCmdReply(
      channel,
      message,
      current
        ? `🧠 This session is on ${current} — could not read the list (${list.reason})`
        : `🧠 Could not read the model off the terminal — ${MODEL_HINT}`
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
  if (r.rows?.length) {
    reply += `\n\n${modelList(r.rows)}\n${MODEL_HINT}`;
  }
  if (r.screen) {
    reply += `\n\nThe terminal is showing this — it may need you:\n\`\`\`\n${dialogExcerpt(r.screen)}\n\`\`\``;
  }
  await sendCmdReply(channel, message, reply);
  return { handled: true };
}

/**
 * `/compact [instructions]` — have claude summarise this conversation now.
 *
 * Typed into the pane (see SessionManager.compactSession for why not the
 * channel), then reported twice: once when it is in, and again when claude
 * has finished — which takes seconds for a small context and minutes for a
 * large one. The second report is not awaited here; holding the chat's queue
 * for the length of a summary would hold every other command with it.
 *
 * No dialog has been seen from `/compact` (measured); should one appear, the
 * dialog watcher reports it like any other.
 */
async function handleCompact(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  instructions: string
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

  const sent = await sessionManager.compactSession(session.key, instructions);
  if (!sent.ok) {
    await sendCmdReply(channel, message, `⚠️ Not compacted — ${sent.reason}`);
    return { handled: true };
  }
  await sendCmdReply(channel, message, "📦 Compacting…");

  void sessionManager
    .waitForCompact(session.key, sent.sentAt)
    .then((o) => sendCmdReply(channel, message, compactReport(o)))
    .catch((err) => logger.warn("compact report failed", { err: (err as Error).message }));
  return { handled: true };
}

function compactReport(o: CompactOutcome | null): string {
  if (!o) return "⚠️ No word from /compact after 10 minutes — have a look at the terminal.";
  if (!o.compacted) return `⚠️ /compact did not compact: ${o.said || "(no output)"}`;
  return (
    `📦 Compacted — ${formatTokens(o.preTokens)} → ${formatTokens(o.postTokens)} tokens` +
    ` in ${formatDuration(o.durationMs)}`
  );
}

/**
 * `/exit` — end this session's claude. The record stays, so the next message
 * resumes the same conversation; this is a restart of one session, where
 * `cork restart` is a restart of all of them.
 */
async function handleExit(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
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

  const r = await sessionManager.exitSession(session.key);
  let reply: string;
  switch (r.result) {
    case "exited":
      reply = "👋 Claude exited — the next message resumes this conversation.";
      break;
    case "not-running":
      reply = "ℹ️ Claude is not running here — the next message starts it again.";
      break;
    case "autopilot":
      reply = "⚠️ Autopilot is running here — `/ap stop` first, or it brings the session straight back";
      break;
    case "asking":
      reply = `⏳ Claude is asking before it exits${r.title ? ` (${r.title})` : ""} — answer it with \`/pick\`.`;
      break;
    case "failed":
      reply = `⚠️ Not exited — ${r.reason}`;
      break;
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
 * `/autopilot …` — the steps of running one, in the order they happen.
 *
 *   /autopilot <what you want done>   talk it through with the model, which
 *                                    writes GOAL.md and PROJECT.md
 *   /autopilot start                  tell the model to begin, and watch
 *   /autopilot stop                   end the run
 *   /autopilot status                 where it is up to
 *
 * The run ends on its own when the model says it is done and cork's evaluator
 * agrees (see SessionManager.evaluateAutopilot), or judges the goal
 * impossible. Nothing here types into the pane: the model is told things as
 * messages, which queue behind a turn in progress like any other.
 *
 * The drafting step is deliberately NOT answered here: cork marks the record
 * and lets the message through to the model, because agreeing on a goal is a
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
    await sendCmdReply(channel, message, startAutopilot(sessionManager, key));
    return { handled: true };
  }

  if (arg === "stop") {
    await sendCmdReply(channel, message, stopAutopilotRun(sessionManager, message, key));
    return { handled: true };
  }

  // Anything else — including nothing at all — starts the drafting
  // conversation. A bare `/autopilot` is the useful case rather than a mistake:
  // a job worth running for hours is usually one the user would rather talk
  // through than fit into a single line, and the model can ask.
  if (isRunning(loadAutopilot(key))) {
    // Dropping straight into drafting would leave the current run with nobody
    // watching it: cork would stop nudging and stop reporting, while the model
    // kept working toward the old goal.
    await sendCmdReply(
      channel,
      message,
      "⚠️ Autopilot is already running here — `/ap stop` first"
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
      ? "✈️ Autopilot drafting — previous run archived"
      : "✈️ Autopilot drafting"
  );
  return { handled: false };
}

/**
 * What sets the model going. The whole contract in one message: where the
 * files are, what to keep current, and how the run ends — the skill says the
 * same at length, but a model that has just been compacted may not have it
 * loaded, and this message is what the summary quotes.
 */
export function startText(dir: string): string {
  return (
    `Autopilot has started. Read GOAL.md and PROJECT.md in ${dir} and begin the ` +
    "work. Keep PROJECT.md current as you go. When you believe every condition " +
    `in GOAL.md is met, write ${dir}/EVIDENCE.md — for each condition, where a ` +
    "reviewer who can read files and this session's recorded transcript, but " +
    "cannot run anything, can confirm it — and call the cork tool with " +
    "`autopilot done`. Cork's evaluator judges the claim and tells you what it found."
  );
}

const STOP_TEXT =
  "Autopilot was stopped by the user. Finish or park the step in hand, leave " +
  "PROJECT.md current, and stop working toward the goal.";

/**
 * Start a run: the record says `running`, the watcher comes up, and the model
 * is told to begin once its pane is connected. Replies at once — the message to
 * the model is queued behind whatever it is doing, so there is nothing to wait
 * for and nothing a wait could learn.
 */
function startAutopilot(sessionManager: SessionManager, key: string): string {
  const rec = loadAutopilot(key);
  if (isRunning(rec)) {
    return "⚠️ Autopilot is already running here — `/ap status` shows it";
  }
  if (readGoal(key) === null) {
    return (
      "⚠️ Autopilot did not start — there is no GOAL.md for this session yet, or " +
      "it is empty. Run `/ap <what you want done>` first." +
      `\n\nGOAL.md: \`${goalFilePath(key)}\``
    );
  }

  // Starting again over a run that ended — the same goal, after an
  // `impossible` or a stop — files that run first, the way drafting a new
  // goal does. Its PROJECT.md and EVIDENCE.md go to the archive; GOAL.md stays,
  // since it is this run's goal too. Every run begins with the goal alone.
  const archived = rec.state === "stopped" ? archiveRun(key, { keepGoal: true }) : null;

  const started = updateAutopilot(key, {
    state: "running",
    startedAt: new Date().toISOString(),
    stoppedAt: undefined,
    stopReason: undefined,
    stopDetail: undefined,
    nudgeCount: 0,
    restartCount: 0,
    compactCount: 0,
    driftChecks: 0,
    lastGoalCheckAt: undefined,
    evaluatingSince: undefined,
    evaluations: [],
  });
  void sessionManager.beginAutopilot(key, startText(sessionDir(key))).then((told) => {
    if (told) return;
    // The record is running and the watcher will nudge, but the model never
    // heard where its files are; the chat should know the start is lame.
    logger.warn("autopilot started but the model could not be told to begin", { key });
    sessionManager.emit(
      "notify",
      key,
      `${headline("running", started)}\nthe session could not be reached to begin — it will be nudged`
    );
  });
  return archived ? "✈️ Autopilot started — previous run archived" : "✈️ Autopilot started";
}

/**
 * End a run on request. The record ends now; the model is told, so it stops
 * working toward a goal nobody is watching any more. An evaluation in flight
 * is left to finish — its verdict goes on the record and changes nothing else.
 */
function stopAutopilotRun(
  sessionManager: SessionManager,
  message: IncomingMessage,
  key: string
): string {
  if (!isRunning(loadAutopilot(key))) return "✈️ Autopilot not running";
  const ended = stopAutopilot(key, "user-stop");
  sessionManager.dispatchSystemMessage(key, message.chatId, STOP_TEXT, "cork:autopilot", "cork-autopilot");
  return headline("stopped (manually)", ended);
}

function autopilotStatus(key: string): string {
  const rec = loadAutopilot(key);

  // `idle` is also what a session with no record at all reads as, and the two
  // are the same thing to the user: nothing here.
  if (rec.state === "idle") return "✈️ Autopilot not running";

  // The first line is the state, with how long when there is a how long; the
  // goal follows in full while it is still being drafted or worked toward.
  // Nothing about cork's own bookkeeping, and no verdict line — a verdict was
  // announced when it happened.
  const goal = readGoal(key);
  const block = goal ? `\`\`\`\n${goal}\n\`\`\`` : "";

  if (rec.state === "drafting") {
    return [
      "✈️ Autopilot drafting",
      "`/ap start` when GOAL.md is right",
      block || "(GOAL.md is not written yet)",
    ].join("\n");
  }

  if (rec.state === "running") {
    const head = headline(`running${rec.evaluatingSince ? " (evaluating)" : ""}`, rec);
    return [head, block].filter(Boolean).join("\n");
  }

  // stopped: how it ended is the whole message, and the goal is over.
  const reason = rec.stopReason ?? "";
  const how =
    reason === "met" ? "completed" : `stopped${reason ? ` (${ENDINGS[reason] ?? reason})` : ""}`;
  return headline(how, rec);
}

/**
 * Why a run stopped, as the word in the parenthesis: `stopped (manually)`.
 *
 * The stored value is an enum autopilot.ts defines; "user-stop" is precise to
 * whoever wrote it and opaque to everyone else. Records from before this
 * version may hold reasons no longer produced, which fall through to the raw
 * word. `met` is not here: that run reads `completed`.
 */
const ENDINGS: Record<string, string> = {
  impossible: "impossible",
  "user-stop": "manually",
  unreachable: "unreachable",
};

/**
 * Text short enough to read in a chat message. GOAL.md and a verdict both run
 * long; quoting either in full turns a status line into a wall.
 */
function preview(text: string, max = 200): string {
  const oneLine = text.replace(/\s*\n\s*/g, " · ");
  const chars = [...oneLine];
  return chars.length <= max ? oneLine : `${chars.slice(0, max).join("")}…`;
}
