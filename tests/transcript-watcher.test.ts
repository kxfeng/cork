import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TranscriptWatcher,
  WATCHER_CONSTANTS,
  isMidStreamErrorRow,
  isReplyToolCallRow,
  isFreshUserInput,
} from "../src/session/transcript-watcher.js";

const { BACKOFF_START_MS, BACKOFF_MAX_MS, WATCHER_SENDER_ID, RETRY_MESSAGE_TEXT } =
  WATCHER_CONSTANTS;

// --- Row builders ---

const larkUserRow = (sender: string, text: string) =>
  JSON.stringify({
    type: "user",
    isMeta: true,
    message: {
      role: "user",
      content: `<channel source="cork-channel" chatId="oc_x" senderId="${sender}" messageId="om_y">\n${text}\n</channel>`,
    },
  });

const typedUserRow = (text: string) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  });

const watcherInjectionRow = (text: string) =>
  JSON.stringify({
    type: "user",
    isMeta: true,
    message: {
      role: "user",
      content: `<channel source="cork-channel" chatId="oc_x" senderId="${WATCHER_SENDER_ID}" messageId="cork-watcher-123">\n${text}\n</channel>`,
    },
  });

const stopHookRow = () =>
  JSON.stringify({
    type: "user",
    isMeta: true,
    message: {
      role: "user",
      content:
        "Stop hook feedback:\nYou did not call the mcp__cork-channel__reply tool this turn...",
    },
  });

const toolResultRow = () =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "x", content: "ok" },
      ],
    },
  });

const midStreamErrorRow = () =>
  JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    error: "server_error",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "API Error: Connection closed mid-response. The response above may be incomplete.",
        },
      ],
    },
  });

const timeoutErrorRow = () =>
  JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    error: "server_error",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Request timed out" }],
    },
  });

const fiveHundredErrorRow = () =>
  JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    error: "server_error",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_x"}',
        },
      ],
    },
  });

const replyToolCallRow = () =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "mcp__cork-channel__reply",
          input: { text: "hi" },
        },
      ],
    },
  });

const turnDurationRow = () =>
  JSON.stringify({
    type: "system",
    subtype: "turn_duration",
    durationMs: 1234,
  });

// --- Test harness ---

let injectCalls: { text: string; senderId: string }[] = [];
let injectShouldSucceed = true;
const inject = (text: string, senderId: string): boolean => {
  injectCalls.push({ text, senderId });
  return injectShouldSucceed;
};

let currentTime = 0;
const now = () => currentTime;

function advance(ms: number): void {
  currentTime += ms;
  vi.advanceTimersByTime(ms);
}

function makeWatcher(): TranscriptWatcher {
  return new TranscriptWatcher({
    workspace: "/tmp/test-cork-watcher",
    sessionId: "test-sid",
    sessionKey: "test_key",
    inject,
    now,
  });
}

beforeEach(() => {
  injectCalls = [];
  injectShouldSucceed = true;
  currentTime = 1_700_000_000_000;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Pure helpers ---

describe("TranscriptWatcher pure helpers", () => {
  it("isMidStreamErrorRow recognises the mid-stream connection drop", () => {
    expect(isMidStreamErrorRow(JSON.parse(midStreamErrorRow()))).toBe(true);
  });

  it("isMidStreamErrorRow rejects 'Request timed out'", () => {
    expect(isMidStreamErrorRow(JSON.parse(timeoutErrorRow()))).toBe(false);
  });

  it("isMidStreamErrorRow rejects 500 server_error", () => {
    expect(isMidStreamErrorRow(JSON.parse(fiveHundredErrorRow()))).toBe(false);
  });

  it("isReplyToolCallRow recognises the cork-channel reply tool", () => {
    expect(isReplyToolCallRow(JSON.parse(replyToolCallRow()))).toBe(true);
  });

  it("isReplyToolCallRow rejects an error row", () => {
    expect(isReplyToolCallRow(JSON.parse(midStreamErrorRow()))).toBe(false);
  });

  it("isFreshUserInput accepts a real Lark message (isMeta:true, channel-wrapped)", () => {
    expect(
      isFreshUserInput(JSON.parse(larkUserRow("ou_real_user", "hello")))
    ).toBe(true);
  });

  it("isFreshUserInput accepts typed user text", () => {
    expect(isFreshUserInput(JSON.parse(typedUserRow("hello")))).toBe(true);
  });

  it("isFreshUserInput rejects our own cork-watcher injection", () => {
    expect(
      isFreshUserInput(JSON.parse(watcherInjectionRow("retry plz")))
    ).toBe(false);
  });

  it("isFreshUserInput rejects a stop-hook block reason injection", () => {
    expect(isFreshUserInput(JSON.parse(stopHookRow()))).toBe(false);
  });

  it("isFreshUserInput rejects a tool_result row (array content)", () => {
    expect(isFreshUserInput(JSON.parse(toolResultRow()))).toBe(false);
  });
});

// --- State machine ---

describe("TranscriptWatcher retry scheduling", () => {
  it("schedules a retry when a turn ends with a mid-stream error", () => {
    const w = makeWatcher();
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );

    expect(injectCalls).toHaveLength(0); // timer pending, hasn't fired
    advance(BACKOFF_START_MS);
    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0].text).toBe(RETRY_MESSAGE_TEXT);
    expect(injectCalls[0].senderId).toBe(WATCHER_SENDER_ID);
  });

  it("does NOT retry when the error is 'Request timed out'", () => {
    const w = makeWatcher();
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${timeoutErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    advance(BACKOFF_START_MS * 10);
    expect(injectCalls).toHaveLength(0);
  });

  it("does NOT retry when the error is 500 server_error", () => {
    const w = makeWatcher();
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${fiveHundredErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    advance(BACKOFF_START_MS * 10);
    expect(injectCalls).toHaveLength(0);
  });

  it("does NOT retry when the reply tool was called earlier in the same turn", () => {
    const w = makeWatcher();
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${replyToolCallRow()}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    advance(BACKOFF_START_MS * 10);
    expect(injectCalls).toHaveLength(0);
  });

  it("ignores a clean turn end with no error", () => {
    const w = makeWatcher();
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${replyToolCallRow()}\n` +
        `${turnDurationRow()}\n`
    );
    advance(BACKOFF_START_MS * 10);
    expect(injectCalls).toHaveLength(0);
  });

  it("a real user message cancels a pending retry and resets backoff", () => {
    const w = makeWatcher();
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    // 3 seconds in, a fresh user input arrives
    advance(3000);
    w.ingest(`${larkUserRow("ou_user", "ok continue please")}\n`);
    // Original timer would fire at +10s
    advance(BACKOFF_START_MS);
    expect(injectCalls).toHaveLength(0);
  });

  it("our own watcher injection does NOT cancel a pending retry", () => {
    // (defensive — a fresh error after we inject should still re-schedule)
    const w = makeWatcher();
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    // The watcher's own injection row appears in transcript first…
    w.ingest(`${watcherInjectionRow(RETRY_MESSAGE_TEXT)}\n`);
    // Timer should still fire (not cancelled).
    advance(BACKOFF_START_MS);
    expect(injectCalls).toHaveLength(1);
  });

  it("a stop-hook block reason does NOT cancel a pending retry", () => {
    const w = makeWatcher();
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    w.ingest(`${stopHookRow()}\n`);
    advance(BACKOFF_START_MS);
    expect(injectCalls).toHaveLength(1);
  });

  it("doubles backoff for a second error within the 5-min window", () => {
    const w = makeWatcher();

    // First error → 10s → retry fires
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    advance(BACKOFF_START_MS);
    expect(injectCalls).toHaveLength(1);

    // 1 minute later, another mid-stream error in a new turn
    advance(60_000);
    w.ingest(
      `${larkUserRow("ou_user", "more work")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );

    // 10s — should NOT fire yet (now 20s delay)
    advance(10_000);
    expect(injectCalls).toHaveLength(1);

    // 10s more — total 20s — fires
    advance(10_000);
    expect(injectCalls).toHaveLength(2);
  });

  it("resets backoff to 10s after a 5+ minute quiet period", () => {
    const w = makeWatcher();

    // First error → 10s retry
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    advance(BACKOFF_START_MS);
    expect(injectCalls).toHaveLength(1);

    // 6 minutes of quiet
    advance(6 * 60_000);

    // Another error
    w.ingest(
      `${larkUserRow("ou_user", "more work")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    advance(BACKOFF_START_MS);
    expect(injectCalls).toHaveLength(2);
  });

  it("caps backoff at BACKOFF_MAX_MS even after many failures", () => {
    const w = makeWatcher();
    const triggerError = () =>
      w.ingest(
        `${larkUserRow("ou_user", "work")}\n` +
          `${midStreamErrorRow()}\n` +
          `${turnDurationRow()}\n`
      );

    // First retry: 10s
    triggerError();
    advance(BACKOFF_START_MS);
    expect(injectCalls).toHaveLength(1);

    // Burn through 10 consecutive in-window failures.
    for (let i = 0; i < 10; i++) {
      // Stay within the 5-min window from the previous retry.
      advance(1000);
      triggerError();
      // Advance long enough to fire the next retry (max wait = cap).
      advance(BACKOFF_MAX_MS);
    }
    // Total injections: 1 (initial) + 10 (loop) = 11
    expect(injectCalls).toHaveLength(11);
  });

  it("does NOT bump lastRetryAt when inject returns false (session disconnected)", () => {
    injectShouldSucceed = false;
    const w = makeWatcher();
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    advance(BACKOFF_START_MS);
    // inject was attempted but failed → no state should leak forward
    expect(injectCalls).toHaveLength(1);

    // Restore success; next error should start at base delay (10s),
    // not at a doubled value.
    injectShouldSucceed = true;
    advance(60_000); // some quiet
    w.ingest(
      `${larkUserRow("ou_user", "more work")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    advance(BACKOFF_START_MS);
    expect(injectCalls).toHaveLength(2);
  });

  it("stop() cancels the pending timer so it does not fire", () => {
    const w = makeWatcher();
    w.ingest(
      `${larkUserRow("ou_user", "do something")}\n` +
        `${midStreamErrorRow()}\n` +
        `${turnDurationRow()}\n`
    );
    w.stop();
    advance(BACKOFF_START_MS * 2);
    expect(injectCalls).toHaveLength(0);
  });
});
