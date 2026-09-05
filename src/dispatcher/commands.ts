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
  type GoalProblem,
} from "../session/autopilot.js";
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
  updateAutopilot(key, {
    state: "drafting",
    goal: undefined,
    stopReason: undefined,
    stopDetail: undefined,
  });
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
    return `❌ ${goalProblemMessage(problem)}\n\nGOAL.md: \`${goalFilePath(key)}\``;
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
    return "⏳ The model is busy right now. It has been asked to stop — try `/autopilot start` again in a moment.";
  }

  // The file, whole. What the evaluator reads after every turn and what the
  // model was given to work from are then the same text, with nothing to keep
  // in step and no second copy to drift.
  const condition = goal as string;
  const sent = await sessionManager.sendSlashCommand(key, `/goal ${condition}`);
  if (!sent.ok) {
    stopAutopilot(key, "start-failed", sent.reason);
    return `❌ Could not set the goal: ${sent.reason}`;
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

  sessionManager.interruptPane(key);
  const sent = await sessionManager.sendSlashCommand(key, "/goal clear");
  if (!sent.ok) {
    // Never typed, so there is nothing to wait for. The goal is still set and
    // outlives the pane — claude restores it from the transcript on resume —
    // so say what has to be done about it.
    stopAutopilot(key, "stop-failed", sent.reason);
    return (
      `🛑 Stopped watching this run, but \`/goal clear\` could not be ` +
      `typed: ${sent.reason}\n\nThe goal is still set — run \`/goal clear\` ` +
      `in the pane, or try \`/autopilot stop\` again.`
    );
  }

  updateAutopilot(key, {
    state: "stopping",
    pendingSince: Date.now(),
    clearAttempts: 1,
  });
  return null; // the watcher confirms the goal is actually gone
}

function autopilotStatus(key: string): string {
  const rec = loadAutopilot(key);
  const lines = [`📋 **Autopilot**: ${rec.state}`];

  if (rec.goal) lines.push(`**Goal:** ${preview(rec.goal)}`);
  if (rec.startedAt) lines.push(`Started: ${rec.startedAt}`);
  if (rec.state === "stopped") {
    if (rec.stopReason) lines.push(`Ended: ${rec.stopReason}`);
    if (rec.stopDetail) lines.push(`Why: ${preview(rec.stopDetail, 300)}`);
  }
  if (rec.state === "running") {
    if (rec.nudgeCount) lines.push(`Nudges since last progress: ${rec.nudgeCount}`);
    if (rec.compactCount) lines.push(`Compactions: ${rec.compactCount}`);
    if (rec.driftChecks) lines.push(`Goal checks asked for: ${rec.driftChecks}`);
  }
  if (rec.state === "drafting") {
    lines.push(`Waiting for GOAL.md — run \`/autopilot start\` when it is ready.`);
  }
  if (rec.state === "starting") {
    lines.push("Waiting for the goal to register — cork reports as soon as it does.");
  }
  if (rec.state === "stopping") {
    lines.push("Waiting for the goal to clear — cork reports as soon as it has.");
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
