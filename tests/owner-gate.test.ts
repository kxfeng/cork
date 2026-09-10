import { describe, it, expect } from "vitest";
import { detectOwner } from "../src/channels/lark/client.js";

/**
 * Who may use the bot.
 *
 * The allowlist is the only gate in front of a Claude running in
 * bypassPermissions mode, so the failure that mattered was an empty list
 * reading as "everybody" — one unnoticed lookup failure during setup and the
 * bot answered the whole tenant. Empty now means nobody, matching Telegram,
 * and the paths that fill the list have to be dependable enough for that to be
 * safe rather than merely strict.
 */

/** Serve canned HTTP responses in order, recording the URLs asked for. */
function fetchReturning(...responses: Array<{ status?: number; body: unknown } | Error>) {
  const urls: string[] = [];
  let i = 0;
  const impl = async (url: string) => {
    urls.push(String(url));
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    } as any;
  };
  return { impl, urls };
}

const TOKEN_OK = { body: { code: 0, tenant_access_token: "t-1" } };
const OWNER_OK = {
  body: { code: 0, data: { app: { owner: { owner_id: "ou_owner" }, creator_id: "ou_creator" } } },
};

async function withFetch<T>(impl: any, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("detectOwner", () => {
  it("returns the app owner", async () => {
    const { impl } = fetchReturning(TOKEN_OK, OWNER_OK);
    const got = await withFetch(impl, () => detectOwner("feishu", "cli_x", "s"));
    expect(got.openId).toBe("ou_owner");
  });

  it("falls back to the creator when there is no owner id", async () => {
    const { impl } = fetchReturning(TOKEN_OK, {
      body: { code: 0, data: { app: { creator_id: "ou_creator" } } },
    });
    const got = await withFetch(impl, () => detectOwner("feishu", "cli_x", "s"));
    expect(got.openId).toBe("ou_creator");
  });

  it("treats a denied app-info call as permanent, not retryable", async () => {
    // The failure mode that started this: HTTP 200, non-zero code, nothing
    // thrown. The old code caught only exceptions, so this slipped through as
    // an empty owner and setup carried on looking successful. Retrying cannot
    // grant a permission, so setup must route around it instead of failing.
    const { impl } = fetchReturning(TOKEN_OK, {
      body: { code: 99991672, msg: "permission denied" },
    });
    const got = await withFetch(impl, () => detectOwner("feishu", "cli_x", "s"));
    expect(got.openId).toBe("");
    expect(got.retryable).toBe(false);
    expect(got.reason).toContain("99991672");
  });

  it("treats a bad token response as retryable", async () => {
    const { impl } = fetchReturning({ body: { code: 10003, msg: "bad secret" } });
    const got = await withFetch(impl, () => detectOwner("feishu", "cli_x", "s"));
    expect(got.openId).toBe("");
    expect(got.retryable).toBe(true);
  });

  it("treats a network error as retryable", async () => {
    const { impl } = fetchReturning(new Error("ECONNRESET"));
    const got = await withFetch(impl, () => detectOwner("feishu", "cli_x", "s"));
    expect(got.retryable).toBe(true);
    expect(got.reason).toContain("ECONNRESET");
  });

  it("reports an app with neither owner nor creator as permanent", async () => {
    const { impl } = fetchReturning(TOKEN_OK, { body: { code: 0, data: { app: {} } } });
    const got = await withFetch(impl, () => detectOwner("feishu", "cli_x", "s"));
    expect(got.openId).toBe("");
    expect(got.retryable).toBe(false);
  });

  it("asks the domain's own host", async () => {
    const { impl, urls } = fetchReturning(TOKEN_OK, OWNER_OK);
    await withFetch(impl, () => detectOwner("lark", "cli_x", "s"));
    expect(urls.every((u) => u.startsWith("https://open.larksuite.com"))).toBe(true);
  });
});
