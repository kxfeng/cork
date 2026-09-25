import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Owners and allows: owners may talk to the bot and command it, allows may
 * only talk to it. `/allow @someone` grows the allows list from chat, in place
 * in config.jsonc, taking effect on the next message.
 */

let dir: string;
const CONFIG = `{
  // hand-written, and meant to stay that way
  "defaultWorkspace": "~/Workspace",
  "channels": {
    "lark": {
      "appId": "cli_x", // the app
      "appSecret": "s",
      "domain": "feishu",
      "owners": ["ou_owner"],
      "ackEmoji": "OnIt"
    }
  }
}
`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-allows-"));
  process.env.CORK_DIR = dir;
  fs.writeFileSync(path.join(dir, "config.jsonc"), CONFIG);
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
});

afterEach(() => {
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const readConfig = () => fs.readFileSync(path.join(dir, "config.jsonc"), "utf-8");

async function larkChannel() {
  const { loadConfig } = await import("../src/config/loader.js");
  const { LarkChannel } = await import("../src/channels/lark/index.js");
  const cfg = loadConfig().channels.lark!;
  return { ch: new LarkChannel(cfg), cfg };
}

describe("editConfigValue", () => {
  it("changes one key and leaves the comments and the rest alone", async () => {
    const { editConfigValue, loadConfig } = await import("../src/config/loader.js");
    editConfigValue(["channels", "lark", "allows"], ["ou_coko"]);
    const out = readConfig();
    expect(out).toContain("// hand-written, and meant to stay that way");
    expect(out).toContain('"appId": "cli_x", // the app');
    expect(loadConfig().channels.lark?.allows).toEqual(["ou_coko"]);
    expect(fs.statSync(path.join(dir, "config.jsonc")).mode & 0o777).toBe(0o600);
  });
});

describe("updateAllows", () => {
  it("adds, skips owners and repeats, and is live without a restart", async () => {
    const { ch, cfg } = await larkChannel();
    const change = ch.updateAllows(["ou_coko", "ou_owner", "ou_coko"], []);
    expect(change).toEqual({ added: ["ou_coko"], removed: [], unchanged: ["ou_owner", "ou_coko"] });
    expect(cfg.allows).toEqual(["ou_coko"]); // the object the event handler reads
    expect(readConfig()).toContain('"allows"');
    expect(readConfig()).toContain("// the app");
  });

  it("removes, and leaves the file untouched when nothing changed", async () => {
    const { ch } = await larkChannel();
    ch.updateAllows(["ou_coko"], []);
    const before = readConfig();
    expect(ch.updateAllows([], ["ou_nobody"]).unchanged).toEqual(["ou_nobody"]);
    expect(readConfig()).toBe(before);
    expect(ch.updateAllows([], ["ou_coko"]).removed).toEqual(["ou_coko"]);
  });
});

describe("/allow and /disallow", () => {
  async function run(text: string, mentions: unknown[], channelOver: object = {}) {
    const { handleCommand } = await import("../src/dispatcher/commands.js");
    const replies: string[] = [];
    const { ch } = await larkChannel();
    const channel = {
      name: "lark",
      updateAllows: ch.updateAllows.bind(ch),
      sendReply: async (_c: string, t: string) => {
        replies.push(t);
        return { messageId: "om_r" };
      },
      ...channelOver,
    };
    const r = await handleCommand(
      channel as never,
      { chatId: "oc_1", messageId: "om_1", text, fromOwner: true, mentions } as never,
      {} as never
    );
    return { r, replies };
  }

  const SELF = { name: "XiaoK", id: "ou_self", self: true };
  const COKO = { name: "CoKo", id: "ou_coko" };
  const ANN = { name: "Ann (QA)", id: "ou_ann" };

  it("allows everyone mentioned but itself, answered by cork", async () => {
    const { r, replies } = await run("/allow", [SELF, COKO, ANN]);
    expect(r).toEqual({ handled: true });
    expect(replies).toEqual(["Allowed: CoKo (ou_coko), Ann (QA) (ou_ann)"]);
  });

  it("says who was already allowed", async () => {
    await run("/allow", [COKO]);
    const { replies } = await run("/allow", [COKO]);
    expect(replies).toEqual(["Already allowed: CoKo"]);
  });

  it("answers a mix of new and existing in one line, owners counting as allowed", async () => {
    await run("/allow", [COKO]);
    const { replies } = await run("/allow", [ANN, COKO, { name: "Boss", id: "ou_owner" }]);
    expect(replies).toEqual([
      "Allowed: Ann (QA) (ou_ann) · already: CoKo, Boss",
    ]);
  });

  it("answers a mixed /disallow the same way", async () => {
    await run("/allow", [COKO]);
    const { replies } = await run("/disallow", [COKO, ANN]);
    expect(replies).toEqual([
      "Disallowed: CoKo (ou_coko) · already: Ann (QA)",
    ]);
  });

  it("says who was already disallowed", async () => {
    const { replies } = await run("/disallow", [ANN]);
    expect(replies).toEqual(["Already disallowed: Ann (QA)"]);
  });

  it("disallows", async () => {
    await run("/allow", [COKO]);
    const { replies } = await run("/disallow", [SELF, COKO]);
    expect(replies).toEqual(["Disallowed: CoKo (ou_coko)"]);
  });

  it("asks who, when nobody but itself was mentioned", async () => {
    const { replies } = await run("/allow", [SELF]);
    expect(replies).toEqual(["Nothing to allow — mention who to add"]);
  });

  it("is refused where the channel keeps no allows list", async () => {
    const { replies } = await run("/allow", [COKO], { updateAllows: undefined });
    expect(replies[0]).toContain("not supported");
  });

  it("is not a command from someone who is only allowed", async () => {
    const { handleCommand } = await import("../src/dispatcher/commands.js");
    const r = await handleCommand(
      {} as never,
      { text: "/allow", fromOwner: false, mentions: [COKO] } as never,
      {} as never
    );
    expect(r).toEqual({ handled: false });
  });
});

describe("the mentions attribute", () => {
  it("pairs each name with its id, whatever the name holds", async () => {
    const { formatMentions } = await import("../src/session/manager.js");
    expect(
      formatMentions([
        { name: "CoKo", id: "ou_93" },
        { name: "张三(测试)", id: "ou_11" },
        { name: 'a=b "c"\nd', id: "ou_22" },
      ])
    ).toBe('CoKo=ou_93; 张三(测试)=ou_11; a=b  c  d=ou_22');
  });
});

describe("the role attribute", () => {
  it("names a guest as one, and everyone else as the owner", async () => {
    const { channelMeta } = await import("../src/session/manager.js");
    const base = { chatId: "oc_1", senderId: "ou_x", messageId: "om_1" } as never;
    expect(channelMeta({ ...(base as object), fromOwner: false } as never).role).toBe("guest");
    expect(channelMeta({ ...(base as object), fromOwner: true } as never).role).toBe("owner");
    // A channel with no owner/guest split (Telegram) admits owners only.
    expect(channelMeta(base).role).toBe("owner");
  });

  it("carries the guest reminder on a guest's message and nowhere else", async () => {
    // The instructions a resumed session holds may predate the guest rule
    // entirely, so this attribute is the only place that message says it.
    const { channelMeta } = await import("../src/session/manager.js");
    const base = { chatId: "oc_1", senderId: "ou_x", messageId: "om_1" } as never;
    expect(channelMeta({ ...(base as object), fromOwner: false } as never).note).toBe(
      "guest: risky actions need the owner's OK"
    );
    expect(channelMeta({ ...(base as object), fromOwner: true } as never).note).toBeUndefined();
    expect(channelMeta(base).note).toBeUndefined();
  });
});

describe("the bot's identity", () => {
  it("reaches the pane quoted, and is left out while unknown", async () => {
    const { SessionManager } = await import("../src/session/manager.js");
    const mgr = new SessionManager({ claude: {} } as never) as any;
    expect(mgr.identityEnv("lark")).toBe("");
    mgr.identify = () => ({ name: "Xiao'K", openId: "ou_self" });
    expect(mgr.identityEnv("lark")).toBe(
      "CORK_BOT_NAME='Xiao'\\''K' CORK_BOT_OPEN_ID='ou_self' "
    );
  });

  it("carries the primary owner, by name when one is cached", async () => {
    const { SessionManager } = await import("../src/session/manager.js");
    const mgr = new SessionManager({ claude: {} } as never) as any;
    mgr.identify = () => ({
      name: "CoKo",
      openId: "ou_self",
      owner: { name: "O'Brien", openId: "ou_owner" },
    });
    expect(mgr.identityEnv("lark")).toBe(
      "CORK_BOT_NAME='CoKo' CORK_BOT_OPEN_ID='ou_self' " +
        "CORK_OWNER_NAME='O'\\''Brien' CORK_OWNER_OPEN_ID='ou_owner' "
    );
  });

  it("passes the owner's id alone rather than an empty name", async () => {
    // Nothing has looked the owner up yet — an id still says who to ask.
    const { SessionManager } = await import("../src/session/manager.js");
    const mgr = new SessionManager({ claude: {} } as never) as any;
    mgr.identify = () => ({
      name: "CoKo",
      openId: "ou_self",
      owner: { name: "", openId: "ou_owner" },
    });
    expect(mgr.identityEnv("lark")).toBe(
      "CORK_BOT_NAME='CoKo' CORK_BOT_OPEN_ID='ou_self' CORK_OWNER_OPEN_ID='ou_owner' "
    );
  });

  it("says nothing about an owner when there is none", async () => {
    const { SessionManager } = await import("../src/session/manager.js");
    const mgr = new SessionManager({ claude: {} } as never) as any;
    mgr.identify = () => ({ name: "CoKo", openId: "ou_self" });
    expect(mgr.identityEnv("lark")).toBe(
      "CORK_BOT_NAME='CoKo' CORK_BOT_OPEN_ID='ou_self' "
    );
  });
});

describe("the primary owner a session is told about", () => {
  it("is the first entry in owners, named from the cache alone", async () => {
    const { LarkChannel } = await import("../src/channels/lark/index.js");
    const { clearNameCache } = await import("../src/channels/lark/names.js");
    clearNameCache();
    const ch = new LarkChannel({
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      owners: ["ou_owner", "ou_second"],
      ackEmoji: "",
    } as never) as any;
    ch.botOpenId = "ou_self";
    ch.botName = "CoKo";

    // Cold cache: the id travels on its own, and no request is made for it.
    expect(ch.botIdentity()).toEqual({
      name: "CoKo",
      openId: "ou_self",
      owner: { name: "", openId: "ou_owner" },
    });

    // Once a message from the owner has been named, the name comes along.
    const { lookupName } = await import("../src/channels/lark/names.js");
    await lookupName({ getUserName: async () => "Xiongfeng Ke" }, "ou_owner", "user");
    expect(ch.botIdentity().owner).toEqual({ name: "Xiongfeng Ke", openId: "ou_owner" });
  });

  it("is absent while the bot's own id is unknown, and when owners is empty", async () => {
    const { LarkChannel } = await import("../src/channels/lark/index.js");
    const cfg = {
      appId: "cli_test",
      appSecret: "secret",
      domain: "feishu",
      owners: ["ou_owner"],
      ackEmoji: "",
    };
    const unresolved = new LarkChannel(cfg as never) as any;
    expect(unresolved.botIdentity()).toBeUndefined();

    const ownerless = new LarkChannel({ ...cfg, owners: [] } as never) as any;
    ownerless.botOpenId = "ou_self";
    ownerless.botName = "CoKo";
    expect(ownerless.botIdentity()).toEqual({ name: "CoKo", openId: "ou_self" });
  });
});
