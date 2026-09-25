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
import { formatPickerRows, type PickerRow } from "../session/model-picker.js";
import { formatTokens, type CompactOutcome } from "../session/transcript.js";
import { readableTime, zoneLabel } from "../time.js";
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
    return handleAllow(channel, message, "allow");
  }

  if (text === "/disallow" || text.startsWith("/disallow ")) {
    return handleAllow(channel, message, "disallow");
  }

  if (isAutopilotCommand(text)) {
    return handleAutopilot(channel, message, sessionManager, text);
  }

  // Built-ins are matched above, so a user script can never shadow one.
  return handleScript(channel, message, sessionManager, text);
}

/**
 * `/allow @A @B` and `/disallow @A`: who may talk to the bot without
 * commanding it. Answered by cork alone — it is a list edit, and a model turn
 * would only make it slow.
 *
 * The targets are the message's own @mentions, this bot's excluded. Only an
 * owner gets here (see handleCommand), and nothing here can make anyone an
 * owner.
 */
async function handleAllow(
  channel: Channel,
  message: IncomingMessage,
  verb: "allow" | "disallow"
): Promise<CommandResult> {
  const targets = (message.mentions ?? []).filter((m) => !m.self);
  const reply = (t: string) => sendCmdReply(channel, message, t).then(() => ({ handled: true }));
  if (!channel.updateAllows) return reply(`⚠️ /${verb} is not supported on this channel`);
  if (targets.length === 0) {
    return reply(
      verb === "allow"
        ? "Nothing to allow — mention who to add"
        : "Nothing to disallow — mention who to remove"
    );
  }
  const ids = targets.map((t) => t.id);
  const change =
    verb === "allow" ? channel.updateAllows(ids, []) : channel.updateAllows([], ids);
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

/**
 * How long `/autopilot start` waits for a busy model to come to a stop, and
 * how often it looks while waiting.
 *
 * A minute covers the ordinary case — the model is finishing the very answer
 * that told the user the work was ready to start — without leaving a start
 * hanging so long that nobody connects the two. Two seconds is short enough
 * that the goal goes in as soon as the turn ends; the poll reads one small
 * JSON file, and cork's other wait on the same signal uses 500ms.
 */
export const START_WAIT_MS = 60_000;
export const START_POLL_MS = 2_000;

/**
 * Sessions where `/autopilot start` is waiting for the model to stop.
 *
 * In memory on purpose. The wait holds nothing worth surviving a daemon
 * restart: a restart replaces the pane, so the model is not busy any more,
 * and `/autopilot status` reads `drafting` — the truth, since nothing has
 * been typed. Retyping `/autopilot start` is a plainer recovery than
 * resurrecting an intent nobody can see.
 *
 * The token is shared with the waiter rather than read back out of the map,
 * so a cancel still lands on a start that has gone past the wait and is
 * typing.
 */
const pendingStarts = new Map<string, { cancelled: boolean }>();

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

/** What a refused GOAL.md gets told, wherever the start was refused from. */
function goalRefusal(problem: GoalProblem, key: string): string {
  // Refuse rather than send something truncated or mangled: a goal that is
  // wrong in a way nobody notices is worse than one that never started.
  return (
    `⚠️ Autopilot did not start\n\n${goalProblemMessage(problem)}` +
    `\n\nGOAL.md: \`${goalFilePath(key)}\``
  );
}

/**
 * Said when the session is waiting on a person rather than working.
 *
 * Deliberately does not name what it is waiting on. Claude reports `waiting`
 * for a permission prompt, an elicitation, a worker or sandbox request, and
 * for its own full-screen commands — five different things, one of which is
 * somebody reading /help. Naming the wrong one is worse than naming none, and
 * whatever it is, it is on screen where the answer has to be given anyway.
 */
const WAITING_REPLY =
  "⚠️ Autopilot did not start — the session is waiting on something at the " +
  "terminal. Deal with it, then `/ap start` again";

/**
 * Type GOAL.md into the pane as a `/goal`, and hand the outcome to the watcher.
 *
 * Nothing here reports success: typing a command and the command taking effect
 * are different events, and only the transcript says whether the second one
 * happened. The watcher is what reads it, and what tells the user — so this
 * returns a reply only when it did not even get as far as typing.
 *
 * Reached either from `/autopilot start` directly or from the waiter, once the
 * model has stopped, which is why GOAL.md is read here rather than passed in:
 * a minute is long enough for it to have been edited, and the file is the
 * whole point of the indirection.
 */
async function beginRun(
  sessionManager: SessionManager,
  key: string,
  token?: { cancelled: boolean }
): Promise<string | null> {
  const goal = readGoal(key);
  const problem = checkGoal(goal, key);
  if (problem) return goalRefusal(problem, key);

  // The file, whole. What the evaluator reads after every turn and what the
  // model was given to work from are then the same text, with nothing to keep
  // in step and no second copy to drift.
  const condition = goal as string;
  const sent = await sessionManager.sendSlashCommand(key, `/goal ${condition}`);
  if (!sent.ok) {
    stopAutopilot(key, "start-failed", sent.reason);
    return `⚠️ Autopilot did not start — could not set the goal: ${sent.reason}`;
  }

  // `/autopilot stop` arrived while the goal was being typed — which takes up
  // to a minute and a half, and no longer blocks the chat behind it. There is
  // no record to stop, since it is written below, but the goal is in the pane
  // now and has to come back out.
  if (token?.cancelled) {
    void sessionManager
      .interruptPane(key)
      .then(() => sessionManager.sendSlashCommand(key, "/goal clear"))
      .catch(() => {});
    return null; // `/autopilot stop` already said what it did
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
 * Start a run, waiting the model out first if it is mid-turn.
 *
 * The wait is what makes a start ordinary. Asking for one right after the
 * model has said the work is ready is the normal case, and the model is
 * usually still finishing that very sentence — so the old answer, "the model
 * is busy, try again in a moment", put the user in charge of a detail cork can
 * watch for itself. Now it asks the model to stop, waits a minute for it, and
 * says nothing at all when that works.
 *
 * It waits in the background rather than here. The router serialises messages
 * per chat, so a minute spent inside this function is a minute the group
 * cannot say anything else — including "never mind".
 */
async function startAutopilot(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  key: string
): Promise<string | null> {
  const rec = loadAutopilot(key);
  if (isRunning(rec)) {
    return "⚠️ Autopilot is already running here — `/ap status` shows it";
  }
  if (pendingStarts.has(key)) {
    // Covers both halves of a start in flight — waiting for the model, and
    // typing the goal in afterwards — because a second start is the wrong
    // thing to do in either.
    return "⚠️ Autopilot is already starting here — `/ap stop` calls it off";
  }

  const activity = sessionManager.sessionActivity(key);
  if (activity === "waiting") return WAITING_REPLY;
  if (activity !== "busy") return beginRun(sessionManager, key);

  // Checked before the wait as well as inside it, so a GOAL.md that was never
  // going to be accepted is refused now rather than a minute from now.
  const problem = checkGoal(readGoal(key), key);
  if (problem) return goalRefusal(problem, key);

  sessionManager.dispatchSystemMessage(
    key,
    message.chatId,
    "The user wants to start autopilot, which cork can only do while this " +
      "session is idle. Finish or park what you are doing and stop, rather " +
      "than starting anything further.",
    "cork:autopilot"
  );

  const token = { cancelled: false };
  pendingStarts.set(key, token);
  void waitThenStart(channel, message, sessionManager, key, token).catch((err) => {
    pendingStarts.delete(key);
    logger.error("autopilot start waiter failed", { err, key });
  });
  return null; // silent unless the wait runs out
}

/**
 * Watch for the model to stop, then start the run.
 *
 * Every way out clears the pending entry before saying anything, and the one
 * that starts the run holds it until the goal has been typed — so neither
 * `/autopilot stop` nor a second `/autopilot start` can slip through a gap.
 */
async function waitThenStart(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  key: string,
  token: { cancelled: boolean }
): Promise<void> {
  const deadline = Date.now() + START_WAIT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, START_POLL_MS));
    if (token.cancelled) return; // `/autopilot stop`; the map entry is gone already

    // A run that began some other way while this was waiting — a `/goal` typed
    // at the terminal, most plausibly. Nothing to start, and nothing to say.
    if (isRunning(loadAutopilot(key))) {
      pendingStarts.delete(key);
      return;
    }

    const activity = sessionManager.sessionActivity(key);
    if (activity === "waiting") {
      pendingStarts.delete(key);
      await sendCmdReply(channel, message, WAITING_REPLY);
      return;
    }
    if (activity !== "busy") {
      const reply = await beginRun(sessionManager, key, token);
      pendingStarts.delete(key);
      if (reply) await sendCmdReply(channel, message, reply);
      return;
    }
    if (Date.now() >= deadline) {
      pendingStarts.delete(key);
      await sendCmdReply(
        channel,
        message,
        "⚠️ Autopilot did not start — the model has been busy for a minute. " +
          "It was asked to stop; `/ap start` again once it has"
      );
      return;
    }
  }
}

/**
 * Get rid of the goal, and hand the outcome to the watcher.
 *
 * The model is, by definition, mid-turn when autopilot is stopped — it is
 * working on the goal. So the pane is interrupted first: Escape leaves the
 * turn, and a command typed into the quiet that follows runs at once instead
 * of queueing behind an answer that may have a minute left in it.
 *
 * The interrupt presses Escape only while the model is mid-turn, one press
 * at a time — see interruptTurn for the Rewind dialog blind presses opened.
 */
async function stopAutopilotRun(
  sessionManager: SessionManager,
  key: string
): Promise<string | null> {
  // A start that is still waiting for the model has written no record — the
  // record is written when the goal is typed, which has not happened yet. Read
  // without this, the state says `drafting`, `/autopilot stop` answers that
  // nothing is running, and autopilot starts half a minute later anyway: the
  // user says never mind, cork says there was nothing to mind, and then it
  // does it.
  const pending = pendingStarts.get(key);
  if (pending) {
    pending.cancelled = true;
    pendingStarts.delete(key);
    return "✈️ Autopilot start cancelled — cork was waiting for the model to stop";
  }

  const rec = loadAutopilot(key);
  if (!isRunning(rec)) {
    return "✈️ Autopilot is not running here";
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
  //
  // The clear follows the interrupt rather than racing it: typed while the
  // turn is still ending, it lands behind the turn, and the dialog check it
  // starts with would be reading a screen that is about to change.
  void sessionManager
    .interruptPane(key)
    .then(() => sessionManager.sendSlashCommand(key, "/goal clear"))
    .catch(() => {});
  updateAutopilot(key, {
    state: "stopping",
    pendingSince: Date.now(),
    clearAttempts: 1,
  });
  return null; // the watcher confirms the goal is actually gone
}

function autopilotStatus(key: string): string {
  // Before the record, because the record has nothing to say about a start
  // that has not typed its goal yet: it reads `drafting`, or whatever the
  // session was before, which is true and leaves out the part that is moving.
  if (pendingStarts.has(key)) {
    return (
      "✈️ Autopilot starting — waiting for the model to stop before " +
      "setting the goal. `/ap stop` calls it off"
    );
  }

  const rec = loadAutopilot(key);

  // `idle` is also what a session with no record at all reads as, and the two
  // are the same thing to the user: nothing here. Saying "Autopilot: idle"
  // invites the question of which autopilot.
  if (rec.state === "idle") {
    return (
      "✈️ Autopilot is not running here — " +
      "`/ap <what you want done>` starts one"
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
  // Same shape as every other autopilot notice: ✈️ when all is well, ⚠️ when
  // someone should look. A run whose goal went with the terminal is not doing
  // anything, whatever the state says — no cause given: what is blocking it
  // changes minute to minute and is not something to act on; that the goal is
  // missing is. An ending nobody asked for is the other case worth a look.
  const attention =
    !!rec.needsRearm ||
    (rec.state === "stopped" &&
      !!rec.stopReason &&
      rec.stopReason !== "met" &&
      rec.stopReason !== "user-stop");
  const lines = [
    `${attention ? "⚠️" : "✈️"} Autopilot ${rec.state}` +
      (rec.needsRearm ? " — goal not re-armed" : ""),
  ];

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
  "rearm-failed": "the goal was lost with the terminal and could not be set again",
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
      return "There is no GOAL.md for this session yet. Run `/ap <what you want done>` first.";
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
