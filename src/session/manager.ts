import { v4 as uuidv4 } from "uuid";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import {
  newSessionId,
  sessionDir,
  loadSession,
  saveSession,
  deleteSession,
  listSessions,
  findSessionId,
  LOCAL_CHANNEL,
  type SessionMeta,
} from "./store.js";
import { resolveWorkspacePath } from "../config/loader.js";
import {
  transcriptPath,
  lastTranscriptModel,
  formatModelName,
} from "./transcript.js";
import { readDialog, type Dialog } from "./dialog.js";
import {
  parseModelPicker,
  chooseModelRow,
  switchConfirmYes,
  lastModelNotice,
} from "./model-picker.js";
import type { CorkConfig } from "../config/schema.js";
import type { IncomingMessage } from "../channels/types.js";
import type { UdsServer, UdsMessage } from "../daemon/uds-server.js";
import { paths } from "../config/paths.js";
import { getLogger } from "../logger.js";
import { TranscriptWatcher, type AutopilotHooks } from "./transcript-watcher.js";
import {
  TMUX_PREFIX,
  corkTmux,
  ensureCorkTmuxServer,
  killCorkTmuxServer,
  liveTmuxSessions,
} from "./tmux.js";
import {
  loadAutopilot,
  updateAutopilot,
  stopAutopilot,
  isRunning,
  type AutopilotRecord,
  type AutopilotStopReason,
} from "./autopilot.js";

export { TMUX_PREFIX };

/** A session with no chat behind it — see LOCAL_CHANNEL. */
function isLocal(meta: SessionMeta): boolean {
  return meta.channel === LOCAL_CHANNEL;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = getLogger("session-manager");

const STARTING_TIMEOUT_MS = 30_000;

/**
 * What claude compacts at when the config says nothing — its own default for
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE's absence is the same ballpark, and the only
 * thing this affects is when one advisory message is sent.
 */
const DEFAULT_COMPACT_PERCENT = 75;

/**
 * How long to keep looking for the typed command at the prompt before calling
 * the attempt failed.
 *
 * The TUI lays a long multi-line input out over a noticeable time — a 21-line
 * goal was not on screen half a second after the last key. Checking once and
 * retyping is how a goal ended up in the box twice.
 */
const PROMPT_SETTLE_MS = 8_000;

/**
 * Key presses used to empty the input box, in each direction.
 *
 * Backspace takes what is before the cursor and Delete what is after, and both
 * are needed: a cleared draft was measured down to the last few characters,
 * which were sitting after the cursor and which the next attempt then typed
 * around. Comfortably past MAX_GOAL_CHARS so the longest allowed goal cannot
 * outlast it.
 */
const CLEAR_PRESSES = 4000;

/**
 * Scrollback lines to read when looking for the input box.
 *
 * A 3000-character goal wraps to well over a hundred display lines on a narrow
 * pane; this covers that with room to spare. Extra history costs nothing —
 * the check reads the LAST `❯` line, which is always the input box.
 */
const CAPTURE_SCROLLBACK = 400;

/**
 * How long to wait for a session started on demand to be ready for typing.
 *
 * Longer than the state machine's own 30-second starting timeout, so a session
 * that is going to fail has failed by the time this gives up.
 */
const SESSION_START_WAIT_MS = 45_000;
const SESSION_START_POLL_MS = 500;

/**
 * Pause between typing the command and pressing Enter.
 *
 * Sent back to back, the Enter is simply lost: the text lands in the input box
 * and stays there, unsubmitted, with the pane looking for all the world like it
 * is waiting for the user. The TUI needs a moment to take in a few hundred
 * characters before it will act on the key that follows them.
 */
const TYPE_SETTLE_MS = 500;

/** How many times to clear-and-retype before giving up on a dirty prompt. */
const TYPE_ATTEMPTS = 3;

/**
 * How long to wait for claude to finish a turn before typing into its pane.
 *
 * Long enough for an ordinary turn to end, short enough that `/autopilot stop`
 * on a task that never goes quiet still gets sent — the transcript check is
 * what decides whether it worked, not this.
 */
/**
 * How long the model picker gets to draw, and how long the switch that follows
 * gets to land. The second is the generous one: pressing `s` can raise a
 * confirmation, and answering it starts a fresh wait.
 */
const PICKER_DRAW_MS = 15_000;
const MODEL_SETTLE_MS = 30_000;
const PICKER_POLL_MS = 300;

const QUIET_WAIT_MS = 45_000;
const QUIET_POLL_MS = 500;

/**
 * How many times to press Escape to bring the turn in progress to a stop.
 *
 * One is not always enough: with editorMode "vim" the first press only leaves
 * INSERT mode — measured, one press left the model still streaming 12 seconds
 * later, three stopped it in 2.2. In the default mode one does it and the
 * extra two are no-ops.
 */
const ESCAPE_PRESSES = 3;

/**
 * What cork should press to get past a dialog claude is showing.
 *
 * `moves` is how far DOWN from the currently selected option the wanted one
 * is, so the answer is that many Down presses and then Enter. It is worked out
 * by finding both lines in the pane rather than assuming an order: the trust
 * prompt puts the option cork wants second, the resume prompt does too, and
 * neither is guaranteed to keep doing so.
 *
 * Known dialogs, and why cork picks what it picks:
 *
 * - the `--dangerously-load-development-channels` prompt → yes, that is what
 *   the channel MCP is;
 * - the first-run trust prompt, whose default is **"No, exit"** — Enter alone
 *   would quit claude and the session would die at startup with nothing but a
 *   30-second timeout to show for it;
 * - the resume prompt claude shows for a session that is old and large
 *   ("This session is 4h 32m old and 226.2k tokens… We recommend resuming from
 *   a summary") → the full session. A cork session is one continuous
 *   conversation from the user's side, hours apart in the same Lark thread, and
 *   a summary leaves the model having forgotten what it said an hour ago. Never
 *   "Don't ask me again": that is the user's setting to change, not cork's.
 *
 * Anything else returns null, and the caller reports it rather than guessing —
 * pressing keys into an unrecognised dialog is how a `/goal` ended up typed
 * into one.
 */
export interface DialogAnswer {
  /** Down presses before Enter. */
  moves: number;
  /** For the log. */
  dialog: string;
}

const DIALOGS: { dialog: string; when: RegExp; want: RegExp }[] = [
  {
    dialog: "dev-channel",
    when: /Loading development channels|I am using this for local development/,
    want: /I am using this for local development/,
  },
  {
    dialog: "trust",
    when: /Is this a project you (?:created or one you )?trust|Yes, I trust this folder/,
    want: /Yes, I trust this folder/,
  },
  {
    dialog: "resume",
    when: /Resume from summary|Resume full session/,
    want: /Resume full session/,
  },
];

export function dialogAction(pane: string): DialogAnswer | null {
  for (const { dialog, when, want } of DIALOGS) {
    if (!when.test(pane)) continue;
    const moves = movesToOption(pane, want);
    if (moves !== null) return { moves, dialog };
  }
  return null;
}

/**
 * How many Down presses separate the selected option from the wanted one, or
 * null if either cannot be found.
 *
 * The selected option is the line claude marks with `❯`. Counting lines
 * between them makes the order irrelevant — and a wanted option ABOVE the
 * selection is not answered at all rather than answered wrongly, since Down
 * would walk away from it.
 */
function movesToOption(pane: string, want: RegExp): number | null {
  const lines = pane.split("\n");
  const selected = lines.findIndex((l) => l.trimStart().startsWith("❯"));
  const wanted = lines.findIndex((l) => want.test(l));
  if (selected < 0 || wanted < 0 || wanted < selected) return null;
  return wanted - selected;
}

/**
 * Whether the pane is showing a numbered choice list — the shape every claude
 * startup dialog has. Used only to tell "waiting on a question cork cannot
 * answer" apart from "still booting", so the user is told about the first and
 * not pestered about the second.
 */
export function looksLikeDialog(pane: string): boolean {
  return pane
    .split("\n")
    .some((l) => /^(?:❯\s*)?\d+\.\s+\S/.test(l.trimStart()));
}

const SGR = /\x1b\[([0-9;]*)m/g;

/** The line's characters, with every escape sequence removed. */
export function stripSgr(line: string): string {
  return line.replace(SGR, "");
}

/**
 * The line's characters minus anything drawn dim.
 *
 * An empty input box is not empty on screen: claude fills it with a greyed
 * suggestion, sometimes written from the message before it, which reads
 * exactly like something a person typed. SGR 2 is what separates them, and it
 * survives only in a `-e` capture. Plain text with no escapes comes back
 * unchanged, so this is safe on a capture taken without `-e`.
 */
export function litText(line: string): string {
  let out = "";
  let dim = false;
  let last = 0;
  SGR.lastIndex = 0;
  for (let m = SGR.exec(line); m !== null; m = SGR.exec(line)) {
    if (!dim) out += line.slice(last, m.index);
    for (const code of (m[1] === "" ? "0" : m[1]).split(";")) {
      const c = Number(code);
      if (c === 0 || c === 22) dim = false;
      else if (c === 2) dim = true;
    }
    last = SGR.lastIndex;
  }
  if (!dim) out += line.slice(last);
  return out;
}

/**
 * Whether the pane's input line begins with the command cork just typed.
 *
 * The input box is the last `❯` line — claude also prefixes command OUTPUT with
 * `❯`, so the FIRST such line is usually something else entirely, and matching
 * on it is how a diagnosis went wrong for several rounds.
 *
 * Only the opening of the command is compared: a long one wraps, and the pane
 * is a fixed width.
 */
export function commandIsAtPrompt(pane: string, command: string): boolean {
  const lines = pane.split("\n");
  let input: string | null = null;
  for (const line of lines) {
    if (stripSgr(line).trimEnd().startsWith("❯")) input = line;
  }
  if (input === null) return false;
  const typed = litText(input).trimEnd().slice(1).trim();
  // A multi-line command only ever shows its first line on the prompt row;
  // the rest are continuation rows carrying no marker.
  const head = command.split("\n")[0].slice(0, 24);
  return typed.startsWith(head);
}

/**
 * What claude itself says this session is doing, or null when it cannot be
 * read. Claude keeps a small registry of live sessions under
 * ~/.claude/sessions/<pid>.json, keyed by its own session id.
 *
 * Observed values: "busy" (mid-turn), "shell" (waiting on a tool), "idle".
 */
export function claudeSessionStatus(sessionId: string): string | null {
  const dir = path.join(os.homedir(), ".claude", "sessions");
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (d?.sessionId === sessionId) return typeof d.status === "string" ? d.status : null;
    } catch {
      // A half-written registry file; the next one may still match.
    }
  }
  return null;
}

/**
 * The pane's text, including enough scrollback to hold a long input.
 *
 * `capture-pane` alone returns the VISIBLE region, and a multi-line goal is
 * taller than the pane: the `❯` marking the start of the input box scrolls off
 * the top, and the check for "is the command at the prompt" then has nothing to
 * find. That is not hypothetical — a 21-line goal on a 154x47 pane (the web
 * terminal resizes it to the browser's viewport) filled the screen with its own
 * continuation lines and the command was never submitted.
 */
function capturePane(tmuxName: string): string {
  // `-e` keeps the escape sequences, which is the only way to tell claude's
  // grey placeholder ("Try \"fix typecheck errors\"", or a suggested next
  // prompt it wrote from your last message) apart from text someone typed:
  // stripped of colour the two are identical, and cork has read a suggestion
  // as a leftover draft before.
  return execSync(corkTmux(`capture-pane -t "${tmuxName}" -p -e -S -${CAPTURE_SCROLLBACK}`), {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** The pane's visible text, or "" when it cannot be read yet. */
function capturePaneSafe(tmuxName: string): string {
  try {
    return execSync(corkTmux(`capture-pane -t "${tmuxName}" -p`), {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return ""; // pane not up yet
  }
}

/** Single-quote for /bin/sh, the way tmux will receive it. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

type SessionState = "inactive" | "starting" | "connected";

interface QueuedMessage {
  chatId: string;
  content: string;
  meta: Record<string, string>;
}

interface PendingReaction {
  messageId: string;
  reactionId: string;
}

interface ActiveSession {
  key: string;
  meta: SessionMeta;
  state: SessionState;
  messageQueue: QueuedMessage[];
  startingTimer?: ReturnType<typeof setTimeout>;
  // Two independent readiness gates. Connection completes only when both
  // are true. Decoupled because either event can in principle land first,
  // and we never want to flush queued messages before the dialog is gone.
  channelRegistered: boolean;
  dialogDismissed: boolean;
  pendingReactions: PendingReaction[];
  /** Most recent real inbound Lark message id for this session. Used to send
   * the model's reply back into the right thread (im.message.reply). Updated
   * on each real dispatch; not touched by synthetic system messages. */
  lastInboundMessageId?: string;
  /** Per-session transcript watcher — created at spawn, stopped at killTmux. */
  transcriptWatcher?: TranscriptWatcher;
}

/**
 * Manages Claude Code sessions via tmux + UDS.
 *
 * State machine per session:
 *   inactive → starting → connected
 *      ↑         |            |
 *      |      timeout/        |
 *      |      failure         |
 *      |_________|     disconnect
 *      |_____________________|
 *
 * Events:
 * - "reply" (sessionKey, content) — reply from Claude, forward to Lark
 * - "permission_request" (sessionKey, msg) — permission prompt from Claude
 * - "notify" (sessionKey, text) — cork itself has something to tell the chat
 *   (an autopilot run finished, stalled, or could not be restarted)
 */
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ActiveSession>();
  /**
   * Sessions whose dialog cork is working right now — the background check
   * stays quiet for these, or cork reports its own keystrokes to the chat.
   *
   * Counted rather than flagged: switchModel holds it across the whole picker
   * walk and calls answerDialog inside that, so a plain set would be cleared
   * by the inner call while the outer one was still driving.
   */
  private dialogDrivers = new Map<string, number>();
  private udsServer: UdsServer | null = null;

  /**
   * (channel, chatId, threadId) → session id.
   *
   * A session id says nothing about the chat it serves (see store.ts), so
   * routing an inbound message needs this lookup. Built lazily from the store
   * the first time it is asked for, then maintained in memory: a message must
   * not cost a directory scan, and the daemon is the only writer.
   */
  private idIndex = new Map<string, string>();
  private idIndexLoaded = false;

  constructor(private config: CorkConfig) {
    super();
  }

  private static indexKey(
    channel: string,
    chatId: string,
    threadId?: string
  ): string {
    // NUL cannot appear in any of the three, so this join is unambiguous.
    return `${channel}\u0000${chatId}\u0000${threadId ?? ""}`;
  }

  private loadIdIndex(): void {
    if (this.idIndexLoaded) return;
    this.idIndexLoaded = true;
    for (const { key, meta } of listSessions()) this.rememberId(key, meta);
  }

  private rememberId(key: string, meta: SessionMeta): void {
    this.idIndex.set(
      SessionManager.indexKey(meta.channel ?? "lark", meta.chatId, meta.threadId),
      key
    );
  }

  private forgetId(meta: SessionMeta): void {
    this.idIndex.delete(
      SessionManager.indexKey(meta.channel ?? "lark", meta.chatId, meta.threadId)
    );
  }

  /**
   * The id of the session serving this chat/thread, or undefined when none
   * exists yet. The store is consulted only on a miss so that a session created
   * by another process (the migration script, say) is still found.
   */
  private keyFor(
    channel: string,
    chatId: string,
    threadId?: string
  ): string | undefined {
    this.loadIdIndex();
    const hit = this.idIndex.get(
      SessionManager.indexKey(channel, chatId, threadId)
    );
    if (hit) return hit;
    const found = findSessionId(channel, chatId, threadId);
    if (found) {
      this.idIndex.set(
        SessionManager.indexKey(channel, chatId, threadId),
        found
      );
      return found;
    }
    return undefined;
  }

  /**
   * Public form of keyFor — the id of the session serving a chat/thread, or
   * undefined when it has none yet. Used for log context and for addressing a
   * session the caller did not already hold.
   */
  sessionKeyFor(
    channel: string,
    chatId: string,
    threadId?: string
  ): string | undefined {
    return this.keyFor(channel, chatId, threadId);
  }

  /** As keyFor, but mints an id when the chat has no session yet. */
  private keyForOrNew(
    channel: string,
    chatId: string,
    threadId?: string
  ): string {
    const existing = this.keyFor(channel, chatId, threadId);
    if (existing) return existing;
    const key = newSessionId();
    this.idIndex.set(SessionManager.indexKey(channel, chatId, threadId), key);
    return key;
  }

  setUdsServer(uds: UdsServer): void {
    this.udsServer = uds;

    uds.on("register", (key: string) => {
      this.onChannelRegistered(key);
    });

    uds.on("disconnect", (key: string) => {
      this.onChannelDisconnected(key);
    });
  }

  getSession(
    channel: string,
    chatId: string,
    threadId?: string
  ): ActiveSession | undefined {
    const key = this.keyFor(channel, chatId, threadId);
    return key ? this.sessions.get(key) : undefined;
  }

  getSessionByKey(key: string): ActiveSession | undefined {
    return this.sessions.get(key);
  }

  /** Where a session lands when nobody says otherwise — the web view offers it
   * as the prefilled workspace when creating one. */
  defaultWorkspace(): string {
    return resolveWorkspacePath(this.config.defaultWorkspace);
  }

  /** Whether a session record exists in memory or on disk for this chat/thread.
   * Used to detect a brand-new thread (no record yet) that needs seeding. */
  sessionExists(channel: string, chatId: string, threadId?: string): boolean {
    const key = this.keyFor(channel, chatId, threadId);
    if (!key) return false;
    return this.sessions.has(key) || loadSession(key) !== null;
  }

  /**
   * Whether a group chat requires an @bot mention. Single source of truth:
   * the in-memory session.meta when the session is live, the persisted
   * SessionMeta otherwise. Defaults to true for chats with no record yet.
   */
  getMentionRequired(channel: string, chatId: string): boolean {
    const key = this.keyFor(channel, chatId);
    if (!key) return true;
    const session = this.sessions.get(key);
    if (session) return session.meta.mentionRequired ?? true;
    return loadSession(key)?.mentionRequired ?? true;
  }

  /**
   * Update a chat's @bot requirement. Writes through the same SessionMeta
   * object the rest of the manager persists, so a later dispatch save can
   * never clobber it with a stale value.
   */
  setMentionRequired(channel: string, chatId: string, value: boolean): void {
    const key = this.keyFor(channel, chatId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (session) {
      session.meta.mentionRequired = value;
      saveSession(key, session.meta);
      return;
    }
    // No live session: update the persisted meta directly if one exists.
    // If none exists yet, there is nothing to act on — the session will be
    // created with the default on its first message.
    const meta = loadSession(key);
    if (meta) {
      meta.mentionRequired = value;
      saveSession(key, meta);
    }
  }

  /**
   * Name a session whose chat title wasn't known when it was created.
   * `prepareSession` warms a chat before anyone has spoken in it, so it has
   * only the chat id to go on; the caller looks the title up afterwards and
   * hands it here rather than making the warm-up wait on an API round trip.
   */
  setChatName(channel: string, chatId: string, name: string): void {
    if (!name) return;
    const key = this.keyFor(channel, chatId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (session) {
      session.meta.chatName = name;
      saveSession(key, session.meta);
      return;
    }
    const meta = loadSession(key);
    if (meta) {
      meta.chatName = name;
      saveSession(key, meta);
    }
  }

  /**
   * Ensure session metadata is loaded into memory (from disk or newly created).
   * Does NOT start tmux — just loads metadata.
   */
  ensureSession(message: IncomingMessage): ActiveSession {
    const key = this.keyForOrNew(
      message.channel,
      message.chatId,
      message.threadId
    );

    let session = this.sessions.get(key);
    if (session) return session;

    const existingMeta = loadSession(key);
    const sid = existingMeta?.sessionId || uuidv4();
    const workspace =
      existingMeta?.workspace ||
      resolveWorkspacePath(this.config.defaultWorkspace);

    const meta: SessionMeta = existingMeta || {
      sessionId: sid,
      channel: message.channel,
      chatId: message.chatId,
      threadId: message.threadId,
      chatType: message.chatType,
      chatName: message.chatName || message.chatId,
      workspace,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastMessagePreview: "",
      claudeSessionStarted: false,
      mentionRequired: true,
    };

    session = {
      key,
      meta,
      state: "inactive",
      messageQueue: [],
      channelRegistered: false,
      dialogDismissed: false,
      pendingReactions: [],
    };
    this.sessions.set(key, session);

    // Persist newly-minted meta immediately so any accepted message creates
    // a visible session record — including slash commands that short-circuit
    // before dispatch (e.g. /mention-off, /status). Existing on-disk meta
    // already reflects what is persisted, so no rewrite is needed.
    if (!existingMeta) {
      saveSession(key, meta);
    }

    return session;
  }

  trackPendingReaction(key: string, messageId: string, reactionId: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.pendingReactions.push({ messageId, reactionId });
  }

  /**
   * Take every ack this session is still holding, emptying the queue.
   *
   * Called when the model speaks. It clears the lot rather than one per reply
   * because a reply cannot say which message it answers — nothing in the reply
   * carries a message id, and the newest inbound id is only a guess that goes
   * wrong the moment a second message arrives mid-turn. What a reply does prove
   * is that everything queued before it has been dealt with, whether answered
   * or deliberately passed over.
   *
   * The old code popped exactly one, which assumed every message draws exactly
   * one reply. A turn that stays silent broke that assumption permanently: the
   * queue kept an entry forever, and every later reply cleared someone else's
   * ack, leaving the acknowledged message wearing one and an ignored message
   * clean.
   */
  takePendingReactions(key: string): PendingReaction[] {
    const session = this.sessions.get(key);
    if (!session) return [];
    return session.pendingReactions.splice(0);
  }

  /**
   * Dispatch a user message to the appropriate Claude Code session.
   * Handles the 3-state machine: inactive → starting → connected.
   */
  async dispatch(
    message: IncomingMessage
  ): Promise<void> {
    const key = this.keyForOrNew(
      message.channel,
      message.chatId,
      message.threadId
    );
    let session = this.sessions.get(key);

    if (!session) {
      session = this.ensureSession(message);
    }

    // Update meta
    session.lastInboundMessageId = message.messageId;
    session.meta.lastActiveAt = new Date().toISOString();
    const firstLine = message.text.split("\n").find((l) => l.trim()) || "";
    session.meta.lastMessagePreview = firstLine.slice(0, 50);
    if (message.chatName) {
      session.meta.chatName = message.chatName;
    }
    saveSession(key, session.meta);

    const udsMsg: QueuedMessage = {
      chatId: message.chatId,
      content: message.text,
      meta: {
        chatId: message.chatId,
        senderId: message.senderId,
        messageId: message.messageId,
        // Omitted rather than blank when unresolved — an empty attribute would
        // read as "this message has no sender".
        ...(message.senderName ? { sender: message.senderName } : {}),
        ...(message.mentionsYou === undefined
          ? {}
          : { mentionYou: String(message.mentionsYou) }),
      },
    };

    switch (session.state) {
      case "inactive":
        session.messageQueue.push(udsMsg);
        this.startSession(session);
        break;

      case "starting":
        session.messageQueue.push(udsMsg);
        logger.debug("session starting, message queued", { key });
        break;

      case "connected":
        this.sendToChannel(session, udsMsg);
        break;
    }
  }

  /**
   * Inject a synthetic user message — an auto-retry from the transcript watcher,
   * or text typed into the web terminal — into the session over the same UDS path
   * a real channel message would take, bypassing the meta updates and the queue.
   *
   * Deliberately does NOT touch `lastInboundMessageId`: it is not a real platform
   * message, so a reply must still thread onto the last one that was (otherwise
   * Lark's im.message.reply would be handed an id it has never heard of).
   *
   * Returns false if the session is not currently connected — the caller should
   * treat that as "drop silently".
   */
  dispatchSystemMessage(
    key: string,
    chatId: string,
    text: string,
    senderId: string,
    origin = "cork-watcher"
  ): boolean {
    const session = this.sessions.get(key);
    if (!session || session.state !== "connected") {
      logger.info("system message skipped — session not connected", {
        key,
        state: session?.state,
      });
      return false;
    }
    const udsMsg: QueuedMessage = {
      chatId,
      content: text,
      meta: {
        chatId,
        senderId,
        messageId: `${origin}-${Date.now()}`,
      },
    };
    this.sendToChannel(session, udsMsg);
    return true;
  }

  /**
   * Type a slash command into the session's pane, and confirm claude code took
   * it as a COMMAND rather than as a message.
   *
   * That confirmation is the whole point. Two ways this fails silently, both
   * observed:
   *
   *   - anything already in the input box puts our text after it, so `/goal`
   *     is no longer at the start of the line and the whole thing is sent as an
   *     ordinary chat message. Nothing reports this.
   *   - past ~800 characters claude folds the input into a pasted block, with
   *     the same result. (Callers keep commands far below that; see
   *     MAX_GOAL_CHARS.)
   *
   * A third, found the same way: sending the text and the Enter back to back
   * loses the Enter. The command sits in the input box unsubmitted, and the
   * pane looks exactly like a prompt waiting for input. Hence the pause between
   * them, and the Enter re-pressed while waiting.
   *
   * So: clear the input first, type, pause, submit, then look for the command
   * in the transcript. Do NOT try to read the input box back instead — an empty one
   * shows placeholder text that looks exactly like content, and the check would
   * be pinned to whatever claude's placeholder says this month.
   *
   * Cork does not wait for the model to be idle — an autopilot run that is working
   * never is. What it waits for instead is the command to actually run, which
   * is not the same as it being accepted:
   *
   *   - while the model is between tool calls, a slash command runs at once;
   *   - while the model is streaming, the TUI QUEUES the input ("Press up to
   *     edit queued messages") and runs it when the turn ends — measured at
   *     over ten seconds.
   *
   * Both look identical from outside, which is why the confirmation window is
   * generous rather than tight.
   */
  async sendSlashCommand(
    key: string,
    command: string,
    // Test seam, like runScriptCommand's timeout: the real waits are tens of
    // seconds, which is right in production and useless in a unit test.
    timing: {
      confirmMs?: number;
      quietMs?: number;
      settleMs?: number;
      startMs?: number;
    } = {}
  ): Promise<{ ok: boolean; reason?: string }> {
    const session = this.sessions.get(key);
    const meta = session?.meta ?? loadSession(key);
    if (!meta) return { ok: false, reason: "no such session" };

    const tmuxName = `${TMUX_PREFIX}${key}`;
    // The pane may not be up at all: a session nothing has spoken to since the
    // daemon started has no claude process behind it. An ordinary message gets
    // a start for free — the dispatcher queues it and delivers it once the
    // session connects — but a slash command is typed straight into the pane,
    // so there has to be one first.
    if (!liveTmuxSessions().has(tmuxName)) {
      const started = await this.ensureConnected(
        key,
        timing.startMs ?? SESSION_START_WAIT_MS
      );
      if (!started) {
        return { ok: false, reason: "the session's terminal could not be started" };
      }
    }

    // Refuse outright while a dialog owns the screen. This is the one path in
    // cork that puts characters into the pane — messages and the watcher's
    // nudges go over UDS to the channel MCP and never touch it — and with a
    // dialog up those characters become keypresses: `s` in the model picker
    // means "this session only", a digit in a permission prompt picks an
    // answer. Worse, the check that guards typing looks for the last line
    // starting with the prompt marker, and a dialog's selected option starts
    // with the same marker, so it would report a clean prompt that is not one.
    const blocking = this.currentDialog(key);
    if (blocking) {
      return {
        ok: false,
        reason: `claude is showing a dialog (${blocking.title || "no title"}) — answer it first`,
      };
    }

    // Wait for claude to come out of the middle of a turn before typing.
    //
    // A slash command typed while the model is streaming does not reliably run
    // as a command: the TUI queues the input, and what happens to a queued
    // slash command is not something cork can count on — an end-to-end run had
    // one delivered to the model as an ordinary chat message, which set no goal
    // and reported nothing. Typed at a quiet moment it runs immediately, every
    // time.
    //
    // Bounded, and then sent anyway: an autopilot run that is working may never be
    // idle, and `/goal clear` still has to reach it. Best effort, with the
    // transcript check below as the thing that actually decides.
    await this.waitForQuietPane(meta.sessionId, timing.quietMs ?? QUIET_WAIT_MS);

    // Type it, and check it actually landed at the START of the input before
    // submitting. Anything already in the box pushes the command along the line,
    // and a `/goal` that is not first is not a command at all — it is sent as an
    // ordinary chat message, with nothing anywhere reporting it. That is not
    // hypothetical: an end-to-end run found the box holding a line no part of
    // cork had put there.
    //
    // Note what is checked: not "is the box empty" (an empty one shows
    // placeholder text that reads exactly like content, so that test would be
    // pinned to claude's placeholder wording), but "is OUR text at the front",
    // which is a fact about something cork itself just sent.
    const lines = command.split("\n");
    let typed = false;
    for (let attempt = 0; attempt < TYPE_ATTEMPTS && !typed; attempt++) {
      try {
        // Escape is NOT sent on the first attempt, because what it does depends
        // on the mode the pane is already in. Measured, with editorMode "vim"
        // (a user-level setting every cork session inherits), while the model
        // was streaming: Escape from INSERT only switches to NORMAL and the
        // model keeps going; Escape from NORMAL **interrupts the model**. A
        // pane sits in NORMAL after any earlier interrupt or stray Escape, so
        // sending one unconditionally means sometimes killing the turn cork was
        // only trying to type alongside.
        //
        // `i` alone reaches a typable state from every ordinary mode without
        // that risk: INSERT takes it as a character (the sweep below removes
        // it), NORMAL enters INSERT, and with editorMode "normal" there are no
        // modes to be in. Later attempts do send Escape, for the one state `i`
        // cannot leave: pressing `/` in NORMAL opens the **history filter**
        // panel — not vim's search, as this comment used to claim — where every
        // keystroke becomes filter text. Escape closes it, and claude's own
        // hint line there reads "Esc i / for slash commands".
        if (attempt > 0) {
          execSync(corkTmux(`send-keys -t "${tmuxName}" Escape`), { stdio: "pipe" });
        }
        execSync(corkTmux(`send-keys -t "${tmuxName}" i`), { stdio: "pipe" });
        // Empty the box in both directions. Backspace alone leaves anything
        // sitting after the cursor — measured: a draft cleared down to the
        // three characters the cursor had been left in front of, which the
        // next attempt then typed around. tmux's `-N` repeats the key without
        // one process per press.
        execSync(
          corkTmux(`send-keys -t "${tmuxName}" -N ${CLEAR_PRESSES} BSpace`),
          { stdio: "pipe" }
        );
        execSync(corkTmux(`send-keys -t "${tmuxName}" -N ${CLEAR_PRESSES} DC`), {
          stdio: "pipe",
        });

        // The first line goes in ALONE, and is checked before the rest follows.
        //
        // This is the only moment the check can work. Once the box holds more
        // lines than the pane is tall, the TUI shows the tail of the draft and
        // the `❯` marks wherever the display was cut — not the start of the
        // input — so "is the command at the front of the line" has nothing to
        // read. Verified on a 21-line goal: the text was all there, the `❯`
        // line was blank, and cork retyped over it three times.
        execSync(
          corkTmux(`send-keys -t "${tmuxName}" -l -- ${shellQuote(lines[0])}`),
          { stdio: "pipe" }
        );

        const settleBy = Date.now() + (timing.settleMs ?? PROMPT_SETTLE_MS);
        for (;;) {
          await new Promise((r) => setTimeout(r, TYPE_SETTLE_MS));
          typed = commandIsAtPrompt(capturePane(tmuxName), command);
          if (typed || Date.now() >= settleBy) break;
        }
        if (!typed) {
          // Logged here rather than after the lines below, where it used to sit
          // and could never run: `continue` had already been taken.
          logger.warn("input line did not start with the command, retrying", {
            key,
            attempt: attempt + 1,
          });
          continue; // clear and try again; nothing has been submitted
        }

        // The rest, line by line, with M-Enter (a soft newline) between them.
        // Claude folds any single input that is long OR pasted as several lines
        // into a `[Pasted text]` block, where a leading `/goal` is not a command
        // at all — sent as an ordinary message, silently. Typed this way each
        // line is its own short input, and the newlines still reach the
        // condition intact.
        for (const line of lines.slice(1)) {
          execSync(corkTmux(`send-keys -t "${tmuxName}" M-Enter`), { stdio: "pipe" });
          execSync(
            corkTmux(`send-keys -t "${tmuxName}" -l -- ${shellQuote(line)}`),
            { stdio: "pipe" }
          );
        }
        // Let the TUI take them in before Enter — see TYPE_SETTLE_MS.
        await new Promise((r) => setTimeout(r, TYPE_SETTLE_MS));
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    }

    if (!typed) {
      return {
        ok: false,
        reason:
          "could not get a clean prompt to type into — something else is in the input box",
      };
    }

    try {
      execSync(corkTmux(`send-keys -t "${tmuxName}" Enter`), { stdio: "pipe" });
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }

    // Typed and submitted. Whether claude took it as a COMMAND is not settled
    // here: the answer lands in the transcript, sometimes a minute later if it
    // queued behind a turn, and the watcher is what reads it. Cork's own
    // notion of the task is `starting` / `stopping` until then, and every
    // message the user gets about it comes from that reading.
    return { ok: true };
  }

  /**
   * The pane's width in columns.
   *
   * Not the 200 cork asks for at `new-session`: tmux's `window-size latest`
   * resizes the window to whatever client attached last, and keeps that size
   * after the client leaves — the web terminal has left panes at 155 for days.
   * Every frame claude draws spans exactly this many columns, so reading a
   * dialog starts here.
   */
  private paneWidth(tmuxName: string): number | null {
    try {
      const out = execSync(
        corkTmux(`display-message -p -t "${tmuxName}" '#{pane_width}'`),
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const n = Number(out);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * When someone attached to this pane last typed into it, or null when nobody
   * is attached.
   *
   * Both ways in are ordinary tmux clients: `tmux -L cork attach` from a
   * terminal, and the web terminal, which runs `tmux attach` under a pty of
   * its own (see web/server.ts). So one question answers both — and
   * `client_activity` answers the second half, which is whether the person is
   * still there.
   */
  private clientActivity(tmuxName: string): number | null {
    let out: string;
    try {
      out = execSync(
        corkTmux(`list-clients -t "${tmuxName}" -F '#{client_activity}'`),
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
    } catch {
      return null; // no such session; nothing is attached to it either
    }
    if (!out) return null; // the session exists, with nobody looking at it
    const times = out
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (times.length === 0) return null;
    return Math.max(...times) * 1000; // tmux reports seconds
  }

  /** The dialog this session is showing, or null. */
  currentDialog(key: string): Dialog | null {
    const tmuxName = `${TMUX_PREFIX}${key}`;
    const width = this.paneWidth(tmuxName);
    if (width === null) return null;
    return readDialog(capturePaneSafe(tmuxName), width);
  }

  /**
   * Whether cork is the one working a dialog right now.
   *
   * The background check must stay quiet while `switchModel` has the picker
   * open, or cork reports its own keystrokes to the chat as something needing
   * attention.
   */
  isDrivingDialog(key: string): boolean {
    return (this.dialogDrivers.get(key) ?? 0) > 0;
  }

  private beginDriving(key: string): void {
    this.dialogDrivers.set(key, (this.dialogDrivers.get(key) ?? 0) + 1);
  }

  private endDriving(key: string): void {
    const n = (this.dialogDrivers.get(key) ?? 0) - 1;
    if (n > 0) this.dialogDrivers.set(key, n);
    else this.dialogDrivers.delete(key);
  }

  /**
   * Answer the dialog on screen: walk the cursor onto `target` and press
   * Enter, or press Escape for "esc".
   *
   * Always by arrow keys, never by typing the option's number. Some of the
   * dialogs claude draws do not number their options at all (the trust screen
   * offers a bare "Yes, I trust this folder"), so a digit is not something
   * every dialog has — and pressing one into a dialog that reads digits
   * differently would answer a question nobody asked.
   *
   * The cursor is re-read after the arrows and before Enter. Moving it is
   * fire-and-forget, and an Enter on the wrong row is the one mistake here
   * that cannot be taken back.
   */
  async answerDialog(
    key: string,
    target: number | "esc",
    timing: { pollMs?: number } = {}
  ): Promise<{ ok: boolean; chosen?: string; title?: string; reason?: string }> {
    const tmuxName = `${TMUX_PREFIX}${key}`;
    const pollMs = timing.pollMs ?? PICKER_POLL_MS;
    const press = (keys: string) =>
      execSync(corkTmux(`send-keys -t "${tmuxName}" ${keys}`), { stdio: "pipe" });

    this.beginDriving(key);
    try {
      const before = this.currentDialog(key);
      if (!before) return { ok: false, reason: "there is no dialog on screen" };

      if (target === "esc") {
        press("Escape");
        await new Promise((r) => setTimeout(r, pollMs));
        this.dialogHandled(key);
        return { ok: true, title: before.title };
      }

      if (!before.answerable) {
        // Either there is nothing on screen to choose, or the list runs past
        // the bottom of it. Both mean the same thing here: a count walked from
        // what cork can see would land somewhere nobody chose.
        return { ok: false, reason: "no options to choose here" };
      }
      const want = before.options[target];
      if (!want) {
        return {
          ok: false,
          reason: `no option ${target + 1}, this one has ${before.options.length}`,
        };
      }
      if (before.selected === null) {
        return { ok: false, reason: "nothing is selected" };
      }

      const delta = target - before.selected;
      if (delta !== 0) {
        press(`-N ${Math.abs(delta)} ${delta > 0 ? "Down" : "Up"}`);
        await new Promise((r) => setTimeout(r, pollMs));
      }

      const after = this.currentDialog(key);
      if (!after || after.selected === null || after.options[after.selected]?.text !== want.text) {
        return { ok: false, reason: `could not select "${want.text}"` };
      }

      press("Enter");
      await new Promise((r) => setTimeout(r, pollMs));
      this.dialogHandled(key);
      return { ok: true, chosen: want.text, title: before.title };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    } finally {
      this.endDriving(key);
    }
  }

  /**
   * Cork answered the dialog, so the watcher must not announce it closing.
   *
   * Otherwise every `/pick` is reported twice: once by the reply, and again by
   * the next dialog check, which sees an empty screen and says so.
   */
  private dialogHandled(key: string): void {
    this.sessions.get(key)?.transcriptWatcher?.dialogHandled();
  }

  /**
   * What this session is on, or null when neither source can say.
   *
   * claude's own `/model` result line first — it is the name the picker
   * shows, and it says what this session was actually set to. Falling back to
   * the transcript when there is none: a session where nobody has run
   * `/model` is on whatever served its last turn. That second answer is
   * coarser — an id with no long-context variant, rendered by the same rule
   * the context readout uses — but it is right about the family and version.
   *
   * The status line is deliberately not read. It is the user's to customise,
   * and an earlier version keyed on "<model> | Context:" — a shape that holds
   * only for the status line this machine happens to have.
   */
  currentModel(key: string): string | null {
    const notice = lastModelNotice(capturePaneSafe(`${TMUX_PREFIX}${key}`));
    if (notice) return notice.model;
    const meta = this.sessions.get(key)?.meta ?? loadSession(key);
    if (!meta) return null;
    const id = lastTranscriptModel(meta.workspace, meta.sessionId);
    return id ? formatModelName(id) : null;
  }

  /**
   * Put this session on `requested` without moving the machine-wide default.
   *
   * `/model <name>` would be one step, and is the wrong one: it "behaves like
   * Enter" and writes the `model` field into user settings, which is the
   * default every NEW claude on this machine then starts with — cork would be
   * reaching outside the session it was asked about. The picker's `s` key is
   * the session-scoped path, and it leaves the settings file byte-identical.
   *
   * The walk is: type `/model`, read the rows, step the cursor onto the one the
   * user named, CONFIRM the cursor arrived, press `s`, then watch for either
   * the status line changing or the "Switch model?" cost confirmation. The
   * confirmation is not always raised — claude suppresses it once the cost has
   * been acknowledged — so it is watched for, never waited on.
   *
   * Two things are deliberately not done. The cursor is never moved on faith:
   * a re-read stands between the arrow keys and `s`, because pressing `s` on
   * the wrong row would quietly put the session on a model nobody asked for.
   * And an unrecognised dialog is never answered — it comes back to the caller
   * with its text, for a person to read.
   */
  async switchModel(
    key: string,
    requested: string,
    // Test seam, as on sendSlashCommand: the real waits are tens of seconds.
    timing: { drawMs?: number; settleMs?: number; pollMs?: number } = {}
  ): Promise<{
    ok: boolean;
    model?: string;
    already?: boolean;
    reason?: string;
    options?: string[];
    screen?: string;
  }> {
    const tmuxName = `${TMUX_PREFIX}${key}`;
    const pollMs = timing.pollMs ?? PICKER_POLL_MS;
    const press = (keys: string) =>
      execSync(corkTmux(`send-keys -t "${tmuxName}" ${keys}`), { stdio: "pipe" });
    const closePicker = () => {
      try {
        press("Escape");
      } catch {
        // Already gone, or the pane is. Nothing here can help either way.
      }
    };

    const width = this.paneWidth(tmuxName);
    if (width === null) return { ok: false, reason: "the session's terminal is not up" };

    this.beginDriving(key);
    try {
      return await this.walkModelPicker(key, tmuxName, width, requested, timing);
    } finally {
      this.endDriving(key);
    }
  }

  /** The picker walk itself. Split out so the caller owns the driving flag. */
  private async walkModelPicker(
    key: string,
    tmuxName: string,
    width: number,
    requested: string,
    timing: { drawMs?: number; settleMs?: number; pollMs?: number }
  ): Promise<{
    ok: boolean;
    model?: string;
    already?: boolean;
    reason?: string;
    options?: string[];
    screen?: string;
  }> {
    const pollMs = timing.pollMs ?? PICKER_POLL_MS;
    const press = (keys: string) =>
      execSync(corkTmux(`send-keys -t "${tmuxName}" ${keys}`), { stdio: "pipe" });
    const closePicker = () => {
      try {
        press("Escape");
      } catch {
        // Already gone, or the pane is. Nothing here can help either way.
      }
    };

    // What claude last said about a model, before cork asks for anything. A
    // switch is confirmed by a notice that was NOT already there: the pane
    // carries scrollback, and an old "Set model to Fable 5.1" would otherwise
    // read as this switch having worked.
    const noticeBefore = lastModelNotice(capturePaneSafe(tmuxName))?.line ?? null;

    const opened = await this.sendSlashCommand(key, "/model");
    if (!opened.ok) return { ok: false, reason: opened.reason };

    // The picker replaces the screen; until it has, there is nothing to read.
    const drawDeadline = Date.now() + (timing.drawMs ?? PICKER_DRAW_MS);
    let view = null as ReturnType<typeof parseModelPicker>;
    for (;;) {
      view = parseModelPicker(capturePaneSafe(tmuxName), width);
      if (view) break;
      if (Date.now() >= drawDeadline) {
        return { ok: false, reason: "the model picker did not open" };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    const choice = chooseModelRow(view.rows, requested);
    if (!choice.ok) {
      closePicker();
      return { ok: false, reason: choice.reason, options: choice.options };
    }

    // Already there: close the picker rather than switch to the model the
    // session is on. A no-op switch is not free — it invalidates the prompt
    // cache, so the next message re-reads the whole conversation.
    if (choice.row.current) {
      closePicker();
      return { ok: true, already: true, model: choice.row.modelName || choice.row.label };
    }

    const delta = choice.index - view.cursor;
    if (delta !== 0) {
      try {
        press(`-N ${Math.abs(delta)} ${delta > 0 ? "Down" : "Up"}`);
      } catch (err) {
        closePicker();
        return { ok: false, reason: (err as Error).message };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    // Read it back. The arrow keys are fire-and-forget, the row order is
    // claude's to change, and `s` acts on wherever the cursor actually is.
    const after = parseModelPicker(capturePaneSafe(tmuxName), width);
    if (!after || after.rows[after.cursor]?.label !== choice.row.label) {
      closePicker();
      return {
        ok: false,
        reason: `could not put the cursor on ${choice.row.label}`,
      };
    }

    try {
      press("s");
    } catch (err) {
      closePicker();
      return { ok: false, reason: (err as Error).message };
    }

    const want = choice.row;
    const settleDeadline = Date.now() + (timing.settleMs ?? MODEL_SETTLE_MS);
    let answeredConfirm = false;
    for (;;) {
      const pane = capturePaneSafe(tmuxName);

      const yes = switchConfirmYes(pane, width);
      if (yes !== null) {
        // Answer it once. Twice would mean cork is in a loop it cannot see.
        if (answeredConfirm) {
          return {
            ok: false,
            reason: "the switch confirmation came back after being answered",
            screen: pane,
          };
        }
        answeredConfirm = true;
        const answered = await this.answerDialog(key, yes, { pollMs });
        if (!answered.ok) return { ok: false, reason: answered.reason, screen: pane };
        continue;
      }

      if (!parseModelPicker(pane, width)) {
        const notice = lastModelNotice(pane);
        if (notice && notice.line !== noticeBefore) {
          if (notice.kind === "set") return { ok: true, model: notice.model };
          // "Kept model as X" — the picker closed without switching. The row
          // already in use is answered further up, so this is not that.
          return {
            ok: false,
            reason: `claude kept the model as ${notice.model}`,
            screen: pane,
          };
        }
        // The picker is gone and claude has said nothing: something else is
        // on screen — a consent prompt, a PreModelSwitch hook asking. Cork
        // does not press keys into a dialog it cannot name; the caller shows
        // it to a person instead.
        const other = readDialog(pane, width);
        if (other) {
          return {
            ok: false,
            reason: `claude is asking something cork does not recognise: ${other.title}`,
            screen: pane,
          };
        }
      }

      if (Date.now() >= settleDeadline) {
        // The picker is gone, nothing else is on screen, and no notice could
        // be read — claude's wording moved. The switch went through; only the
        // name for it is missing, so the reply uses the word that was asked
        // for rather than refusing a switch that happened.
        if (!parseModelPicker(pane, width)) return { ok: true, model: requested };
        return {
          ok: false,
          reason: `the model did not change to ${want.label}`,
          screen: pane,
        };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Block until claude reports it is not mid-turn, or the budget runs out.
   * Returns the status it settled on, for the log.
   */
  private async waitForQuietPane(
    sessionId: string,
    maxMs: number
  ): Promise<string | null> {
    const deadline = Date.now() + maxMs;
    let status: string | null = null;
    for (;;) {
      status = claudeSessionStatus(sessionId);
      // null: no registry entry (an older claude, or a session it has not
      // written yet) — nothing to wait for, so do not.
      if (status === null || status !== "busy") return status;
      if (Date.now() >= deadline) {
        logger.info("typing into a busy pane anyway", { sessionId });
        return status;
      }
      await new Promise((r) => setTimeout(r, QUIET_POLL_MS));
    }
  }

  /**
   * What the transcript watcher needs to run autopilot for this session.
   *
   * Everything here is a capability the watcher deliberately does not import:
   * it decides WHEN to act from the transcript alone, and these decide what
   * acting means. `contextWindow` is the one piece it cannot observe — nothing
   * in the transcript states the model's window — so it is configured, and
   * being wrong about it only moves one advisory message.
   */
  private autopilotHooks(key: string): AutopilotHooks {
    return {
      read: () => loadAutopilot(key),
      update: (patch: Partial<AutopilotRecord>) => {
        updateAutopilot(key, patch);
      },
      stop: (reason: AutopilotStopReason, detail?: string) => {
        stopAutopilot(key, reason, detail);
      },
      notify: (text: string) => this.emit("notify", key, text),
      isAlive: () => liveTmuxSessions().has(`${TMUX_PREFIX}${key}`),
      restart: () => this.startSessionByKey(key),
      clearGoal: () => {
        // Interrupt first, same as `/autopilot stop` does: the model is working
        // on the goal, and a command typed into a busy pane queues behind it.
        this.interruptPane(key);
        // Not waited on, exactly as the command handler does not wait: the
        // watcher records the attempt now, and the transcript is what says
        // whether the goal actually went.
        void this.sendSlashCommand(key, "/goal clear").catch(() => {});
      },
      contextWindow: () => this.config.claude.contextWindow ?? 0,
      compactPercent: () => this.config.claude.autoCompactPercent ?? DEFAULT_COMPACT_PERCENT,
    };
  }

  /**
   * Bring back the sessions that were mid-long-task when cork stopped.
   *
   * Only the "should cork be watching this" flag is restored from disk; whether
   * the goal is still live is settled by the watcher's first pass over the
   * transcript, exactly as it would be for a task that ended while cork was up.
   * A goal met during the outage therefore closes out through the ordinary
   * path, with no startup special case to keep in step with it.
   *
   * Panes are gone by now (cork kills its tmux server on start), so this
   * respawns them; claude restores the goal from its own transcript on resume.
   */
  /**
   * Whether claude says this session is between turns.
   *
   * `/goal` typed into a busy pane is queued behind the turn in progress —
   * measured at 53 seconds on a long answer — so a start that needs to be
   * prompt asks first. A session with no registry entry (an older claude, or
   * one that has not written it yet) counts as idle: there is nothing to wait
   * for and refusing on that basis would be refusing on no evidence.
   */
  sessionIsIdle(key: string): boolean {
    const meta = this.sessions.get(key)?.meta ?? loadSession(key);
    if (!meta) return false;
    const status = claudeSessionStatus(meta.sessionId);
    return status === null || status === "idle";
  }

  /**
   * Bring the turn in progress to a stop, so a command typed next runs at once
   * rather than queueing behind it. See stopAutopilotRun for why more than one.
   */
  interruptPane(key: string, presses = ESCAPE_PRESSES): void {
    const tmuxName = `${TMUX_PREFIX}${key}`;
    if (!liveTmuxSessions().has(tmuxName)) return;
    for (let i = 0; i < presses; i++) {
      try {
        execSync(corkTmux(`send-keys -t "${tmuxName}" Escape`), { stdio: "pipe" });
      } catch {
        return; // pane went away; nothing to interrupt
      }
    }
  }

  /**
   * Make sure the watcher for this session is live, for a task that has just
   * been started. A connected session already has one; this covers the case
   * where it does not yet.
   */
  watchAutopilot(key: string): void {
    if (this.sessions.get(key)?.transcriptWatcher) return;
    this.startSessionByKey(key);
  }

  resumeAutopilots(): string[] {
    const resumed: string[] = [];
    for (const { key, meta } of listSessions()) {
      if (isLocal(meta)) continue;
      if (!isRunning(loadAutopilot(key))) continue;
      this.rememberId(key, meta);
      if (this.startSessionByKey(key)) resumed.push(key);
    }
    if (resumed.length > 0) {
      logger.info("resumed autopilot runs", { keys: resumed });
    }
    return resumed;
  }

  /**
   * Tear down every session belonging to a chat — the chat's own session and any
   * thread sessions under it. For when the chat itself is gone: disbanded, or the
   * bot removed from it. Nobody can reach those panes again, so leaving them
   * running holds a Claude process and a tmux pane per dead chat.
   *
   * Sweeps disk as well as memory. A session the daemon has not touched since
   * restart is not in `sessions`, but its tmux pane can still be alive (the tmux
   * server outlives the daemon) and its record would otherwise resurrect the
   * dead chat in `cork status`.
   *
   * Returns the keys destroyed.
   */
  destroyChatSessions(channel: string, chatId: string): string[] {
    // A session id says nothing about its chat, so membership is decided by the
    // meta — both for sessions this process holds and for records only on disk.
    const belongs = (meta: SessionMeta) =>
      (meta.channel ?? "lark") === channel && meta.chatId === chatId;

    const keys = new Set<string>();
    for (const [key, session] of this.sessions) {
      if (belongs(session.meta)) keys.add(key);
    }
    for (const { key, meta } of listSessions()) if (belongs(meta)) keys.add(key);

    for (const key of keys) {
      // Runs even for a disk-only key: the pane may have outlived the daemon.
      this.killTmux(key);
      const session = this.sessions.get(key);
      if (session?.startingTimer) clearTimeout(session.startingTimer);
      const meta = session?.meta ?? loadSession(key);
      if (meta) this.forgetId(meta);
      this.sessions.delete(key);
      deleteSession(key);
    }

    if (keys.size > 0) {
      logger.info("destroyed sessions for gone chat", {
        channel,
        chatId,
        keys: [...keys],
      });
    }
    return [...keys];
  }

  /**
   * Bring up the pane for a session that already has a record. A chat nobody
   * has spoken in since the daemon restarted has a record but no pane, and the
   * web view offers to start it directly rather than making the user go say
   * something in the chat. Resume applies as usual, so the model picks up its
   * own history rather than starting cold.
   *
   * These three (start/stop/forget) are keyed by session rather than by chat,
   * unlike `destroyChatSessions` — the web view lists a chat and each of its
   * threads separately and acts on exactly the one that was clicked.
   */
  /**
   * Make sure the session has a claude process that is ready to be typed into,
   * starting one if it has none. False when it did not come up in time.
   *
   * "Connected" rather than "the tmux session exists": a pane that is still
   * answering the trust prompt would take a typed command as an answer to it.
   */
  private async ensureConnected(key: string, timeoutMs: number): Promise<boolean> {
    if (this.sessions.get(key)?.state === "connected") return true;
    if (!this.startSessionByKey(key)) return false;
    logger.info("starting a session to type a command into", { key });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SESSION_START_POLL_MS));
      if (this.sessions.get(key)?.state === "connected") return true;
    }
    logger.warn("session did not connect in time for a command", { key });
    return false;
  }

  startSessionByKey(key: string): boolean {
    const meta = this.sessions.get(key)?.meta ?? loadSession(key);
    if (!meta) return false;
    this.prepareSession({
      channel: meta.channel ?? "lark",
      chatId: meta.chatId,
      threadId: meta.threadId,
      workspace: meta.workspace,
    });
    return true;
  }

  /**
   * Kill a session's pane but keep its record, so starting it again resumes the
   * same Claude session. Queued messages are dropped rather than held: they were
   * addressed to a pane that no longer exists, and delivering them whenever it
   * next comes up would replay them out of context.
   */
  stopSessionByKey(key: string): boolean {
    if (!this.sessions.has(key) && !loadSession(key)) return false;
    this.killTmux(key);
    const session = this.sessions.get(key);
    if (session) {
      if (session.startingTimer) clearTimeout(session.startingTimer);
      session.startingTimer = undefined;
      session.state = "inactive";
      session.messageQueue = [];
      session.channelRegistered = false;
      session.dialogDismissed = false;
    }
    logger.info("stopped session", { key });
    return true;
  }

  /**
   * Drop a session entirely: kill the pane and forget cork's record of it. The
   * chat is left alone, and so is Claude's own session file — that transcript is
   * Claude's, not cork's, and stays on disk where `claude -r` can still reach
   * it. Only cork stops tracking the pairing.
   */
  forgetSessionByKey(key: string): boolean {
    const meta = this.sessions.get(key)?.meta ?? loadSession(key);
    if (!meta) return false;
    this.killTmux(key);
    const session = this.sessions.get(key);
    if (session?.startingTimer) clearTimeout(session.startingTimer);
    this.forgetId(meta);
    this.sessions.delete(key);
    deleteSession(key);
    logger.info("forgot session", { key });
    return true;
  }

  /**
   * Create a session that belongs to no chat and start its pane.
   *
   * The point is the browser view: a Claude Code session you can open, drive
   * and tear down there without inventing a Lark group to hang it on. It is an
   * ordinary session in every other respect — same key shape, same store file,
   * same tmux name — so the list, the terminal bridge and start/stop/delete all
   * work on it with no special case. What it lacks is the chat wiring: no
   * channel MCP, no Stop hook, nothing to reply to. See buildClaudeArgs.
   */
  createLocalSession(opts: { name?: string; workspace?: string }): {
    key: string;
    meta: SessionMeta;
  } {
    // A random chat id keeps the shape identical to a chat session's — it just
    // names nothing on the other side. Uniqueness is the id's job now, so this
    // no longer needs to redraw on a clash.
    const chatId = uuidv4().slice(0, 8);
    const key = newSessionId();
    const workspace = resolveWorkspacePath(
      opts.workspace?.trim() || this.config.defaultWorkspace
    );
    const meta: SessionMeta = {
      sessionId: uuidv4(),
      channel: LOCAL_CHANNEL,
      chatId,
      chatType: "p2p",
      chatName: opts.name?.trim() || path.basename(workspace),
      workspace,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastMessagePreview: "",
      claudeSessionStarted: false,
      mentionRequired: false,
    };
    saveSession(key, meta);
    this.rememberId(key, meta);

    const session: ActiveSession = {
      key,
      meta,
      state: "inactive",
      messageQueue: [],
      channelRegistered: false,
      dialogDismissed: false,
      pendingReactions: [],
    };
    this.sessions.set(key, session);
    this.startSession(session);
    logger.info("created local session", { key, workspace });
    return { key, meta };
  }

  /** How long a session title may be, matching Lark's own limit on a group name. */
  static readonly MAX_NAME = 60;

  /**
   * Retitle a local session.
   *
   * Local only, and enforced here rather than by hiding a button: a chat
   * session's title is overwritten from the platform on every message it
   * receives (see dispatch), so a rename would survive until the next one and
   * then silently revert. Offering it at all would be a lie.
   *
   * Returns false for an unknown key, a chat session, or a name that is empty
   * once stripped — the caller turns that into a status code.
   */
  renameSessionByKey(key: string, name: string): boolean {
    // Control characters would land in a tmux status line and a chat title.
    const clean = name
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .trim()
      .slice(0, SessionManager.MAX_NAME);
    if (!clean) return false;

    const session = this.sessions.get(key);
    const meta = session?.meta ?? loadSession(key);
    if (!meta || !isLocal(meta)) return false;

    meta.chatName = clean;
    saveSession(key, meta);
    logger.info("renamed session", { key, name: clean });
    return true;
  }

  createNewSession(
    channel: string,
    chatId: string,
    threadId?: string,
    workspace?: string
  ): SessionMeta {
    // Reuse the id when this chat already has a session: /new means "start the
    // conversation over", not "become a different session". deleteSession below
    // still wipes the directory, so nothing from the old one survives.
    const key = this.keyForOrNew(channel, chatId, threadId);
    const ws = workspace
      ? resolveWorkspacePath(workspace)
      : resolveWorkspacePath(this.config.defaultWorkspace);

    // Kill existing tmux session
    const existing = this.sessions.get(key);
    if (existing) {
      this.killTmux(key);
      if (existing.startingTimer) clearTimeout(existing.startingTimer);
    }
    this.sessions.delete(key);
    // The chat carries on existing, so what it has already finished carries on
    // too: `/new` restarts the conversation, it does not undo the work. Only
    // forgetting a session or losing the chat takes the archive with it.
    deleteSession(key, { keepArchive: true });

    const meta: SessionMeta = {
      sessionId: uuidv4(),
      channel,
      chatId,
      threadId,
      chatType: "p2p",
      chatName: chatId,
      workspace: ws,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastMessagePreview: "",
      claudeSessionStarted: false,
      mentionRequired: true,
    };

    saveSession(key, meta);
    return meta;
  }

  /**
   * Warm a session ahead of the first user message: create or reuse its meta and
   * start Claude Code now, so that by the time the user speaks the pane is
   * already connected and the message is answered without the startup wait.
   *
   * Used by the new-chat flow — cork creates the group, greets the owner, then
   * prepares the session in the background. Idempotent: if the session is
   * already starting or connected it only reconciles `mentionRequired` and
   * returns, never spawning a second pane. Safe against the race with a user
   * message that arrives first — both run on the one event loop and share the
   * sessions map, so whichever gets there first starts it and the other reuses
   * it (see dispatch).
   */
  prepareSession(opts: {
    channel: string;
    chatId: string;
    threadId?: string;
    workspace?: string;
    mentionRequired?: boolean;
  }): void {
    const { channel, chatId, threadId } = opts;
    const key = this.keyForOrNew(channel, chatId, threadId);

    let session = this.sessions.get(key);
    if (!session) {
      const meta: SessionMeta = loadSession(key) || {
        sessionId: uuidv4(),
        channel,
        chatId,
        threadId,
        chatType: "group",
        chatName: chatId,
        workspace: resolveWorkspacePath(
          opts.workspace || this.config.defaultWorkspace
        ),
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        lastMessagePreview: "",
        claudeSessionStarted: false,
        mentionRequired: true,
      };
      session = {
        key,
        meta,
        state: "inactive",
        messageQueue: [],
        channelRegistered: false,
        dialogDismissed: false,
        pendingReactions: [],
      };
      this.sessions.set(key, session);
    }

    // Reconcile the mention flag whether the session is new or pre-existing —
    // the new-chat flow wants the group to answer without an @mention.
    if (opts.mentionRequired !== undefined) {
      session.meta.mentionRequired = opts.mentionRequired;
    }
    saveSession(key, session.meta);

    // Already warm (or warming): do not spawn a second pane.
    if (session.state !== "inactive") return;

    // Warm with an empty queue — when Claude connects nothing is pending, so it
    // just waits for the user's first message.
    this.startSession(session);
  }

  async shutdown(): Promise<void> {
    // Stop each session's watcher (timer + fs handle) — their panes are torn
    // down wholesale by the single kill-server below, so we don't need a
    // per-session kill-session here.
    for (const [, session] of this.sessions) {
      if (session.startingTimer) clearTimeout(session.startingTimer);
      if (session.transcriptWatcher) {
        session.transcriptWatcher.stop();
        session.transcriptWatcher = undefined;
      }
    }
    this.sessions.clear();
    // One kill-server closes every cork pane AND the (exit-empty off) server
    // process itself, leaving nothing behind on the cork socket.
    killCorkTmuxServer();
  }

  // --- Private ---

  /**
   * Decide whether to `claude -r` (resume) or start fresh, and mutate `meta`
   * accordingly. Claude Code deletes transcripts idle past cleanupPeriodDays
   * (default 30), so a session cork last touched weeks ago may have had its
   * transcript reaped. `claude -r <gone-id>` then hangs instead of erroring, and
   * the session times out on every message with no way to recover itself. When
   * the transcript is missing, tell the user it was auto-cleaned, mint a fresh
   * id, persist it, and start clean instead of resuming into nothing.
   *
   * Returns true to resume, false to start a new session. Exists as its own
   * method so the decision can be unit-tested without spawning tmux.
   */
  resolveResume(key: string, meta: SessionMeta): boolean {
    if (!meta.claudeSessionStarted) return false;
    if (fs.existsSync(transcriptPath(meta.workspace, meta.sessionId))) return true;

    logger.warn("resume transcript missing — starting a fresh session", {
      key,
      sessionId: meta.sessionId,
    });
    this.emit(
      "error",
      key,
      "Claude Code 会话已被自动清理(默认闲置超过 30 天),已为你新建一个会话继续。"
    );
    meta.sessionId = uuidv4();
    meta.claudeSessionStarted = false;
    saveSession(key, meta);
    return false;
  }

  /**
   * Assemble claude's argv for a session. Exists as its own method — like
   * resolveResume — so the flags can be unit-tested without spawning tmux;
   * --add-dir in particular is the only thing making cork's injected skill
   * visible to the launched process, and a silent regression there would cost
   * the whole new-chat flow with no other symptom.
   */
  buildClaudeArgs(meta: SessionMeta, resume: boolean, key?: string): string[] {
    const claudeArgs = resume
      ? ["-r", meta.sessionId]
      : ["--session-id", meta.sessionId];

    // `permissionMode` governs how a prompt reaches a chat, which a local
    // session has none of; its prompts surface in the pane instead. They are
    // created deliberately, one at a time, on the user's own machine — so they
    // skip, the way someone opening a terminal here would have typed it.
    if (isLocal(meta) || this.config.claude.permissionMode === "bypassPermissions") {
      claudeArgs.push("--dangerously-skip-permissions");
    }

    if (this.config.claude.extraArgs.length > 0) {
      claudeArgs.push(...this.config.claude.extraArgs);
    }

    // Everything below exists to wire a session to its chat, so for a local one
    // it is not merely unnecessary but wrong: the channel MCP would register a
    // session nobody can reply to, and the Stop hook would block every turn
    // demanding a channel reply that cannot happen.
    if (isLocal(meta)) return claudeArgs;

    claudeArgs.push("--mcp-config", this.mcpConfigPath);
    claudeArgs.push("--settings", this.settingsPath);
    // Load cork's skills (new-chat, …) without touching ~/.claude or the
    // workspace: claude scans <agentDir>/.claude/skills for an --add-dir dir.
    claudeArgs.push("--add-dir", paths.agentDir);
    // The session's own directory, so the model can read and write the files
    // cork keeps there for it (GOAL.md, PROJECT.md, AUTOPILOT.json). Without
    // this they sit outside every dir claude is allowed to touch.
    if (key) claudeArgs.push("--add-dir", sessionDir(key));
    claudeArgs.push(
      "--dangerously-load-development-channels",
      "server:cork-channel"
    );

    return claudeArgs;
  }

  /**
   * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<pct>` for the pane, or "" when the config
   * asks for nothing usable.
   *
   * Claude Code reads it as an integer percentage in (0, 100] and compacts at
   * `min(floor(window * pct/100), window - 13000)`. Anything outside that range
   * is ignored by claude, so cork drops it here rather than putting a value in
   * the environment that silently does nothing.
   *
   * Its own name for this internally is `testPctOverride` and it is not in the
   * public docs, so treat it as best-effort: if a future claude stops honouring
   * it, sessions fall back to compacting at `window - 13000` and keep working.
   */
  private autoCompactEnv(): string {
    const pct = this.config.claude.autoCompactPercent;
    if (pct === undefined) return "";
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      logger.warn("ignoring out-of-range autoCompactPercent", { pct });
      return "";
    }
    return `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='${Math.floor(pct)}' `;
  }

  /**
   * Put one Claude Code process in a fresh tmux session. The only part of
   * starting a session that touches the outside world, split out so the state
   * machine around it can be tested without a tmux server — the same reason
   * resolveResume and buildClaudeArgs are their own methods. Throws if tmux
   * refuses; the caller decides what that means for the session.
   */
  spawnPane(key: string, meta: SessionMeta, claudeArgs: string[]): void {
    // CORK_SESSION_KEY is passed via env, inherited by Claude → MCP subprocess
    // A locale is part of the pane's contract with everything Claude Code shells
    // out to. launchd starts the daemon without one, the tmux server inherits
    // that, and a session's processes inherit the server's environment rather
    // than the environment of the client that created it — so without this the
    // pane runs with no LANG at all.
    //
    // What that costs is not obvious until it bites: macOS command line tools
    // fall back to the C encoding when the locale says nothing, and treat UTF-8
    // as single bytes. `printf 中文 | pbcopy` with no locale puts ‰∏≠Êñá on the
    // clipboard — each UTF-8 byte read as one Mac OS Roman character. It reads
    // back correctly through pbpaste, which makes the same mistake in reverse,
    // so the corruption only shows up once the text is pasted somewhere else.
    const locale = process.env.LANG || process.env.LC_ALL || "en_US.UTF-8";
    // CORK_CHANNEL_NAME is passed explicitly because the session key no longer
    // carries the channel: the channel MCP used to read it off the key prefix
    // and tell the model which platform it is replying to.
    const claudeCmd =
      `LANG='${locale}' LC_CTYPE='${locale}' ` +
      `CORK_SESSION_KEY='${key}' ` +
      `CORK_CHANNEL_NAME='${meta.channel ?? "lark"}' ` +
      this.autoCompactEnv() +
      `claude ${claudeArgs.join(" ")}`;

    // Ensure cork's dedicated tmux server is up (with exit-empty off, clean
    // process line) before the new-session, so the session never forks the
    // server itself and inherit a dirty argv. It is also where ~/.cork/env is
    // injected: the pane is forked by the server, so nothing put on this
    // client's env would reach claude.
    ensureCorkTmuxServer();

    execSync(
      corkTmux(
        `new-session -d -s "${TMUX_PREFIX}${key}" -x 200 -y 50 ` +
          `"cd '${meta.workspace}' && ${claudeCmd}"`
      ),
      { stdio: "pipe" }
    );
  }

  private startSession(session: ActiveSession): void {
    const { key, meta } = session;

    // Ensure workspace exists
    fs.mkdirSync(meta.workspace, { recursive: true });
    // And the session's own dir: buildClaudeArgs passes it as --add-dir, and
    // claude refuses to launch when an --add-dir does not exist. Every path
    // that gets here has saved the session (which creates it) — this is the
    // belt to that braces, because the failure would be "no session ever
    // starts again".
    fs.mkdirSync(sessionDir(key), { recursive: true });

    // Resume the existing Claude session, or start a new one with the stored
    // UUID. resolveResume downgrades to "new" when the transcript was reaped.
    const resume = this.resolveResume(key, meta);
    const claudeArgs = this.buildClaudeArgs(meta, resume, key);

    // CORK_SESSION_KEY is passed via env, inherited by Claude → MCP subprocess
    // A locale is part of the pane's contract with everything Claude Code shells
    // out to. launchd starts the daemon without one, the tmux server inherits
    // that, and a session's processes inherit the server's environment rather
    // than the environment of the client that created it — so without this the
    // pane runs with no LANG at all.
    //
    // What that costs is not obvious until it bites: macOS command line tools
    // fall back to the C encoding when the locale says nothing, and treat UTF-8
    // as single bytes. `printf 中文 | pbcopy` with no locale puts ‰∏≠Êñá on the
    // clipboard — each UTF-8 byte read as one Mac OS Roman character. It reads
    // back correctly through pbpaste, which makes the same mistake in reverse,
    // so the corruption only shows up once the text is pasted somewhere else.
    const tmuxName = `${TMUX_PREFIX}${key}`;
    logger.info("starting tmux session", {
      key,
      tmuxName,
      workspace: meta.workspace,
      resume,
    });

    try {
      this.spawnPane(key, meta, claudeArgs);
    } catch (err) {
      logger.error("failed to start tmux session", { key, err });
      session.state = "inactive";
      session.messageQueue = [];
      this.emit("error", key, `Failed to start Claude Code: ${(err as Error).message}`);
      return;
    }

    // A local session is running the moment its pane is. Everything below waits
    // on signals a chat session produces and this one never will — and waiting
    // is not passive: the starting timeout would kill the pane after 30s, and
    // the dialog poller would type Enter into a prompt that has no dialog on it.
    if (isLocal(meta)) {
      session.state = "connected";
      if (!meta.claudeSessionStarted) {
        meta.claudeSessionStarted = true;
        saveSession(key, meta);
      }
      return;
    }

    session.state = "starting";
    session.channelRegistered = false;
    session.dialogDismissed = false;

    // Poll the tmux pane and dismiss the development channel confirmation
    // dialog. Sends Enter while the dialog text is on screen and stops once
    // it disappears, so we don't fire stray Enters into the main prompt.
    this.pollAndDismissChannelDialog(session, tmuxName);

    // Start the transcript watcher for this session. fs.watchFile handles
    // the not-yet-existing transcript gracefully (claude code creates it
    // after the first row); watcher reads only rows written from now on.
    //
    // Stop any previous one FIRST. A pane that dies on its own does not go
    // through killTmux, so its watcher is still running when the session is
    // started again — and simply overwriting the field would leave it holding a
    // file watch and a timer forever. With an autopilot run that is not just a leak:
    // two watchers would nudge the same stalled session twice and race to
    // restart the same dead pane.
    session.transcriptWatcher?.stop();
    session.transcriptWatcher = new TranscriptWatcher({
      workspace: meta.workspace,
      sessionId: meta.sessionId,
      sessionKey: key,
      inject: (text, senderId) =>
        this.dispatchSystemMessage(key, meta.chatId, text, senderId),
      dialog: {
        // Null while the session is still starting: cork answers claude's own
        // startup dialogs itself (trust, dev-channel, resume), and reporting
        // those would be telling the user about something already handled.
        read: () =>
          this.sessions.get(key)?.state === "connected"
            ? this.currentDialog(key)
            : null,
        driving: () => this.isDrivingDialog(key),
        clientActivity: () => this.clientActivity(`${TMUX_PREFIX}${key}`),
      },
      notify: (text: string) => this.emit("notify", key, text),
      autopilot: this.autopilotHooks(key),
    });
    session.transcriptWatcher.start();

    // Starting timeout
    session.startingTimer = setTimeout(() => {
      if (session.state === "starting") {
        logger.warn("session starting timeout", { key });
        session.state = "inactive";
        const queued = session.messageQueue.length;
        session.messageQueue = [];
        this.killTmux(key);
        this.emit(
          "error",
          key,
          `Claude Code failed to start within ${STARTING_TIMEOUT_MS / 1000}s (${queued} message(s) dropped)`
        );
      }
    }, STARTING_TIMEOUT_MS);
  }

  private onChannelRegistered(key: string): void {
    const session = this.sessions.get(key);
    if (!session) {
      logger.warn("channel registered for unknown session", { key });
      return;
    }
    session.channelRegistered = true;
    this.tryCompleteConnection(session);
  }

  /**
   * Complete connection only when both readiness gates are satisfied:
   * the dev-channel dialog has been dismissed AND the channel MCP has
   * registered over UDS. Either event may fire first.
   */
  private tryCompleteConnection(session: ActiveSession): void {
    if (session.state !== "starting") return;
    if (!session.channelRegistered || !session.dialogDismissed) {
      logger.debug("waiting for both gates", {
        key: session.key,
        channelRegistered: session.channelRegistered,
        dialogDismissed: session.dialogDismissed,
      });
      return;
    }
    this.completeConnection(session.key);
  }

  private completeConnection(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    if (session.startingTimer) {
      clearTimeout(session.startingTimer);
      session.startingTimer = undefined;
    }

    session.state = "connected";

    // Mark Claude session as started so we use -r (resume) next time
    if (!session.meta.claudeSessionStarted) {
      session.meta.claudeSessionStarted = true;
      saveSession(key, session.meta);
    }

    logger.info("session connected", { key, queuedMessages: session.messageQueue.length });

    // Flush queued messages
    for (const msg of session.messageQueue) {
      this.sendToChannel(session, msg);
    }
    session.messageQueue = [];
  }

  private onChannelDisconnected(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    logger.info("channel disconnected, session → inactive", { key });
    session.state = "inactive";
    if (session.startingTimer) {
      clearTimeout(session.startingTimer);
      session.startingTimer = undefined;
    }
  }

  private sendToChannel(session: ActiveSession, msg: QueuedMessage): void {
    if (!this.udsServer) {
      logger.error("UDS server not set");
      return;
    }

    const sent = this.udsServer.sendToChannel(session.key, {
      type: "message",
      content: msg.content,
      meta: msg.meta,
    });

    if (sent) {
      logger.debug("sent message to channel", {
        key: session.key,
        contentLen: msg.content.length,
      });
    } else {
      logger.warn("failed to send to channel, marking disconnected", {
        key: session.key,
      });
      session.state = "inactive";
    }
  }

  /**
   * Watch the tmux pane for the dialogs claude shows before it is usable, and
   * answer them. Stops once no dialog is on screen, so stray keys never reach
   * the main prompt.
   *
   * Two of them, and they are NOT answered the same way — see dialogAction.
   */
  private pollAndDismissChannelDialog(
    session: ActiveSession,
    tmuxName: string
  ): void {
    const POLL_INTERVAL_MS = 500;
    const POLL_TIMEOUT_MS = 15_000;
    const POLL_START_DELAY_MS = 1000;

    const key = session.key;
    const startedAt = Date.now();
    let dialogSeen = false;
    let unknownTicks = 0;
    let quietTicks = 0;

    const markDismissed = () => {
      if (session.dialogDismissed) return;
      session.dialogDismissed = true;
      this.tryCompleteConnection(session);
    };

    const send = (keys: string) => {
      try {
        execSync(corkTmux(`send-keys -t "${tmuxName}" ${keys}`), { stdio: "pipe" });
      } catch {
        // pane not ready yet; the next tick tries again
      }
    };

    const tick = () => {
      if (session.state !== "starting") return;

      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        logger.warn("channel dialog poll timeout", { key, dialogSeen });
        markDismissed();
        return;
      }

      const pane = capturePaneSafe(tmuxName);

      const action = dialogAction(pane);
      if (action) {
        dialogSeen = true;
        unknownTicks = 0;
        quietTicks = 0;
        logger.info("answering a startup dialog", { key, ...action });
        for (let i = 0; i < action.moves; i++) send("Down");
        send("Enter");
        setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }

      // Anything else with a choice list on it is a question cork has no
      // answer for. Cork presses nothing — typing into one of these is how a
      // `/goal` once ended up inside a dialog — and stops gating startup on
      // it: the session is usable if the dialog turns out not to matter, and
      // if it does matter the user will notice by talking to it. It is only
      // logged; a chat message about a dialog nobody can see is noise.
      //
      // Both counters want two ticks in a row: claude redrawing one dialog
      // into the next flashes half-written screens either way.
      if (!looksLikeDialog(pane)) {
        unknownTicks = 0;
        quietTicks++;
      } else if (++unknownTicks >= 2) {
        logger.warn("startup dialog not recognised, leaving it alone", {
          key,
          dialogSeen,
        });
        markDismissed();
        return;
      }

      // Known dialogs come one after another, so keep looking after answering
      // one. Cork does not try to recognise the input interface itself: the
      // channel MCP registering over UDS is what says claude is up.
      if (dialogSeen && quietTicks >= 2) {
        markDismissed();
        return;
      }

      setTimeout(tick, POLL_INTERVAL_MS);
    };

    setTimeout(tick, POLL_START_DELAY_MS);
  }

  /**
   * Write ~/.cork/mcp-config.json. Resolves the bundled channel-mcp script
   * relative to this module's own location, so it works regardless of
   * where cork is installed and does not depend on PATH. Called once at
   * daemon startup so the config always reflects the running cork install.
   * Per-session identity (CORK_SESSION_KEY) is passed via env on the tmux
   * command line, not in this file.
   */
  writeMcpConfig(): void {
    const sockPath = process.env.CORK_SOCKET || paths.socketPath;
    const channelServerPath = path.join(
      __dirname,
      "../channel-mcp/server.js"
    );
    const mcpConfig = {
      mcpServers: {
        "cork-channel": {
          command: "node",
          args: [channelServerPath],
          env: {
            CORK_SOCKET: sockPath,
          },
        },
      },
    };
    fs.mkdirSync(paths.corkDir, { recursive: true });
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  }

  private get mcpConfigPath(): string {
    return `${paths.corkDir}/mcp-config.json`;
  }

  private get settingsPath(): string {
    return `${paths.corkDir}/claude-settings.json`;
  }

  /**
   * Write ~/.cork/claude-settings.json — passed to claude via `--settings`,
   * which merges it as an *additional* settings layer on top of the user's
   * own ~/.claude/settings.json and project settings (never replacing them).
   *
   * Two hooks are registered:
   *
   * - `Stop` — detects turns where the model answered without going through
   *   the cork-channel reply tool, and recovers them.
   * - `PreCompact` — adds what a summariser cannot know about an autopilot
   *   run (where GOAL.md and PROJECT.md are, and what must survive) to
   *   claude's own summarisation prompt. Silent for every other session.
   *
   * Both scripts are resolved relative to this module, so they work
   * regardless of install location. Called once at daemon startup, like
   * writeMcpConfig().
   */
  writeClaudeSettings(): void {
    const stopHook = path.join(__dirname, "../hooks/stop-hook.js");
    const preCompactHook = path.join(__dirname, "../hooks/pre-compact-hook.js");
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: `node '${stopHook}'` }],
          },
        ],
        PreCompact: [
          {
            hooks: [{ type: "command", command: `node '${preCompactHook}'` }],
          },
        ],
      },
    };
    fs.mkdirSync(paths.corkDir, { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
  }

  private killTmux(key: string): void {
    // Tear down the watcher first — the underlying jsonl will stop being
    // written to as soon as claude code exits, but the poll is harmless
    // either way. Stop here so the timer + fs handle are released.
    const session = this.sessions.get(key);
    if (session?.transcriptWatcher) {
      session.transcriptWatcher.stop();
      session.transcriptWatcher = undefined;
    }

    const tmuxName = `${TMUX_PREFIX}${key}`;
    try {
      execSync(corkTmux(`kill-session -t "${tmuxName}"`), { stdio: "pipe" });
      logger.info("killed tmux session", { tmuxName });
    } catch {
      // Session may not exist
    }
  }
}
