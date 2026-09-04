import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

/**
 * The web terminal hands out an interactive shell, so these auth tests are
 * load-bearing, not hygiene.
 *
 * The token is the gate, always — loopback is not an authentication story, since
 * a reverse proxy can republish the port and a proxied caller can assert any
 * Host/Origin it likes. The Origin / Sec-Fetch-Site checks are the second layer:
 * they stop a page the user merely *visits* from driving the server through their
 * browser (WebSocket ignores CORS, so this is a real attack even with a token).
 *
 * Runs against its own CORK_DIR and its own tmux server (CORK_TMUX_LABEL) so it
 * can never touch the user's live sessions.
 */
// An opaque session id, the way the store names one. The chat it serves is
// stated in the meta below, not in the id.
const KEY = "web-test-session";
const LABEL = "corktest-web";

/**
 * A fresh port per server, rather than one port rebound by every test.
 *
 * fetch() pools connections per origin and the pool outlives a test. Reusing
 * one port meant a socket opened against the server a previous test stopped
 * could be handed to the next test's request, which then died on the RST as
 * ECONNRESET — a failure that read as a bug in the code under test. A distinct
 * origin has an empty pool, so there is nothing stale to hand out.
 *
 * Measured, not assumed: roughly one full-suite run in seven failed this way
 * before, and one in thirty-five after. That is a real reduction and not a
 * cure — the surviving failure was never captured, so whether it shares this
 * cause is unknown.
 */
let PORT = 7788;
let SELF = `http://127.0.0.1:${PORT}`;

let dir: string;
let server: { start(): Promise<void>; stop(): Promise<void>; url(): string };

const api = (p: string) => `${SELF}${p}`;

/** Raw request so we can forge Host/Origin — fetch() ignores both. */
function rawGet(headers: Record<string, string>, pathQ: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(PORT, "127.0.0.1", () => {
      const h = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
      c.write(`GET ${pathQ} HTTP/1.1\r\n${h}\r\nConnection: close\r\n\r\n`);
    });
    let b = "";
    c.on("data", (d) => (b += d));
    c.on("end", () => resolve(b.split("\r\n")[0]));
    c.on("error", () => resolve("ERROR"));
  });
}

/** Like rawGet, but returns the whole response head so headers can be asserted. */
function rawFull(headers: Record<string, string>, pathQ: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(PORT, "127.0.0.1", () => {
      const h = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
      c.write(`GET ${pathQ} HTTP/1.1\r\n${h}\r\nConnection: close\r\n\r\n`);
    });
    let b = "";
    c.on("data", (d) => (b += d));
    c.on("end", () => resolve(b));
    c.on("error", () => resolve("ERROR"));
  });
}

let token: string;

async function startServer(cfg: Record<string, unknown> = {}) {
  vi.resetModules(); // paths.ts / tmux.ts read their env at import time
  PORT += 1;
  SELF = `http://127.0.0.1:${PORT}`;
  const { WebServer } = await import("../src/web/server.js");
  // No session manager: the routes under test read the store directly, which is
  // also the shape the daemon presents for a session it has not loaded.
  server = new WebServer({ port: PORT, ...cfg } as never);
  await server.start();
  token = new URL(server.url()).searchParams.get("token")!;
}

/** Headers a browser would send for our page's own fetch. */
const ours = (extra: Record<string, string> = {}) => ({
  Origin: SELF,
  "Sec-Fetch-Site": "same-origin",
  ...extra,
});

/** The Bearer header the page attaches to every API call, read from localStorage. */
const auth = (extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${token}`,
  ...extra,
});

/** Connect a WebSocket the way a browser would: chosen Origin, token via query
 *  (the browser WebSocket API cannot set headers). */
function wsConnect(
  origin: string,
  query = `session=${KEY}`,
  headers: Record<string, string> = {}
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const q = query.includes("token=") ? query : `${query}&token=${token}`;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${q}`, {
      origin,
      headers,
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

describe("web terminal", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-web-test-"));
    process.env.CORK_DIR = dir;
    process.env.CORK_TMUX_LABEL = LABEL;
    fs.mkdirSync(path.join(dir, "sessions", KEY), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sessions", KEY, "session.json"),
      JSON.stringify({
        sessionId: "s1",
        channel: "test",
        chatId: "web-chat",
        chatType: "p2p",
        chatName: "Web Chat",
        workspace: "/tmp",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        lastMessagePreview: "",
        claudeSessionStarted: true,
        mentionRequired: false,
      })
    );
  });

  afterEach(async () => {
    await server?.stop();
    try {
      execSync(`tmux -L ${LABEL} kill-server 2>/dev/null`);
    } catch {
      /* no server */
    }
    delete process.env.CORK_DIR;
    delete process.env.CORK_TMUX_LABEL;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("token gate", () => {
    it("puts the token in the URL for the first visit", async () => {
      await startServer();
      expect(new URL(server.url()).searchParams.get("token")).toBeTruthy();
    });

    it("rejects a request with no token", async () => {
      await startServer();
      const r = await fetch(api("/api/sessions"), { headers: ours() });
      expect(r.status).toBe(401);
    });

    it("rejects a wrong token", async () => {
      await startServer();
      const r = await fetch(api(`/api/sessions?token=${"0".repeat(48)}`), {
        headers: ours(),
      });
      expect(r.status).toBe(401);
    });

    it("accepts an Authorization: Bearer token and sets no cookie", async () => {
      await startServer();
      const r = await fetch(api("/api/sessions"), { headers: ours(auth()) });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { sessions: { key: string }[] };
      expect(body.sessions.map((s) => s.key)).toContain(KEY);
      // The whole point of dropping cookies: nothing is ever stored host-wide that
      // another cork on the same host, different port, would then receive.
      expect(r.headers.get("set-cookie")).toBeNull();
    });

    it("serves the HTML shell without a token, so a reload/bookmark loads", async () => {
      // The page authenticates from localStorage after it loads, so the shell
      // itself must be reachable with no credential at all.
      await startServer();
      const line = await rawGet(
        { Host: `127.0.0.1:${PORT}`, "Sec-Fetch-Site": "none" },
        "/"
      );
      expect(line).toContain("200");
    });

    it("rejects a WebSocket with no token", async () => {
      await startServer();
      await expect(
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${KEY}`, {
            origin: SELF,
          });
          ws.on("open", () => resolve(ws));
          ws.on("error", reject);
        })
      ).rejects.toThrow();
    });
  });

  describe("browser provenance (second layer)", () => {
    it("blocks another site's script — hostile Origin", async () => {
      await startServer();
      const line = await rawGet(
        {
          Host: `127.0.0.1:${PORT}`,
          Origin: "http://evil.example.com",
          "Sec-Fetch-Site": "cross-site",
          Authorization: `Bearer ${token}`,
        },
        "/api/sessions"
      );
      expect(line).toContain("403");
    });

    it("blocks a cross-site request even with our Origin and a valid token", async () => {
      // Sec-Fetch-Site is a forbidden header: page script cannot set it, so a
      // cross-site value proves the request did not come from our page.
      await startServer();
      const line = await rawGet(
        {
          Host: `127.0.0.1:${PORT}`,
          Origin: SELF,
          "Sec-Fetch-Site": "cross-site",
          Authorization: `Bearer ${token}`,
        },
        "/api/sessions"
      );
      expect(line).toContain("403");
    });

    it("blocks a forged Host — DNS rebinding defence", async () => {
      await startServer();
      const line = await rawGet(
        { Host: "evil.example.com", "Sec-Fetch-Site": "none" },
        `/api/sessions?token=${token}`
      );
      expect(line).toContain("403");
    });

    it("rejects a WebSocket from a hostile origin — WS ignores CORS", async () => {
      await startServer();
      await expect(wsConnect("http://evil.example.com")).rejects.toThrow();
    });
  });

  /**
   * `ssh -L 6781:localhost:6780` (or any reverse proxy) makes the browser reach
   * cork at one port while cork listens on another. The page then lives at the
   * external port and every fetch / WebSocket it makes carries that port in Host
   * and Origin — not cork's listen port. Two regressions live here:
   *   1. Same-origin must be judged against the browser's port (the Host header),
   *      or the WebSocket handshake is rejected and the pane reads "detached".
   *   2. No cookie is ever set, so a second cork reached at 127.0.0.1 on another
   *      port can never receive this one's token (cookies are not isolated by
   *      port; localStorage, where the page keeps the token, is).
   */
  describe("behind a port forward (ssh -L / reverse proxy)", () => {
    const EXT = 19999; // the external port the browser sees; PORT is what we listen on

    it("accepts a WebSocket whose Origin/Host carry the forwarded port", async () => {
      execSync(`tmux -L ${LABEL} new-session -d -s cork_${KEY} 'sleep 30'`);
      await startServer();
      const ws = await wsConnect(`http://127.0.0.1:${EXT}`, `session=${KEY}`, {
        host: `127.0.0.1:${EXT}`,
      });
      expect(ws.readyState).toBe(1);
      ws.close();
    }, 15_000);

    it("still rejects a WebSocket whose Origin and Host disagree", async () => {
      // Origin (listen port) ≠ Host (forwarded port): not same-origin, so a page
      // that is not ours cannot slip through just by being on some loopback port.
      execSync(`tmux -L ${LABEL} new-session -d -s cork_${KEY} 'sleep 30'`);
      await startServer();
      await expect(
        wsConnect(SELF, `session=${KEY}`, { host: `127.0.0.1:${EXT}` })
      ).rejects.toThrow();
    }, 15_000);

    it("accepts a Bearer API call under the forwarded Host, and sets no cookie", async () => {
      await startServer();
      const head = await rawFull(
        {
          Host: `127.0.0.1:${EXT}`,
          Origin: `http://127.0.0.1:${EXT}`,
          "Sec-Fetch-Site": "same-origin",
          Authorization: `Bearer ${token}`,
        },
        "/api/sessions"
      );
      expect(head.split("\r\n")[0]).toContain("200"); // origin judged Host↔Origin, not listen port
      expect(head.toLowerCase()).not.toContain("set-cookie");
    });

    it("ignores cookies entirely — a stray token cookie does not authenticate", async () => {
      // Whatever another cork on this host may have set, cork no longer reads any
      // cookie, so a request carrying one but no Bearer/query token is unauthorized.
      await startServer();
      const line = await rawGet(
        {
          Host: `127.0.0.1:${EXT}`,
          Origin: `http://127.0.0.1:${EXT}`,
          "Sec-Fetch-Site": "same-origin",
          Cookie: `cork_web_token=${token}; cork_web_token_${PORT}=${token}`,
        },
        "/api/sessions"
      );
      expect(line).toContain("401");
    });
  });

  describe("status (/api/session/status)", () => {
    const get = (qs: string, headers: Record<string, string> = {}) =>
      fetch(api(`/api/session/status${qs}`), {
        headers: ours(auth(headers)),
      });

    it("answers for a session the daemon never loaded", async () => {
      // The Info button is reachable for a stopped session, so this has to read
      // the record on disk rather than the manager's in-memory map — which is
      // empty here, exactly as it is after a daemon restart.
      await startServer();
      const r = await get(`?session=${KEY}`);
      expect(r.status).toBe(200);
      const s = await r.json();
      expect(s).toMatchObject({
        key: KEY,
        chatName: "Web Chat",
        channel: "test",
        workspace: "/tmp",
        sessionId: "s1",
      });
      expect(s.terminal).toContain(`cork_${KEY}`);
    });

    it("404s for a key with no record anywhere", async () => {
      await startServer();
      expect((await get("?session=nope")).status).toBe(404);
      expect((await get("")).status).toBe(404);
    });

    it("rejects an unauthenticated read", async () => {
      await startServer();
      const r = await fetch(api(`/api/session/status?session=${KEY}`), {
        headers: ours(), // no token, no cookie
      });
      expect(r.status).toBe(401);
    });

    it("rejects a read from another site", async () => {
      await startServer();
      const r = await get(`?session=${KEY}`, {
        Origin: "http://evil.example.com",
        "Sec-Fetch-Site": "cross-site",
      });
      expect(r.status).toBe(403);
    });
  });

  describe("pane bridge", () => {
    const tmuxClients = () => {
      try {
        const out = execSync(
          `tmux -L ${LABEL} list-clients -t cork_${KEY} 2>/dev/null || true`,
          { encoding: "utf-8" }
        ).trim();
        return out ? out.split("\n").length : 0;
      } catch {
        return 0;
      }
    };

    /**
     * A ghost `tmux attach` is not merely a leaked process: tmux sizes a window
     * across ALL its clients, so a browser that has gone away keeps squeezing the
     * pane for everyone still watching it. Closing the socket must reap the pty.
     * (The other half — a tab that dies without sending a close frame — is caught
     * by the heartbeat; see HEARTBEAT_MS.)
     */
    it("reaps the pty when the browser disconnects", async () => {
      execSync(`tmux -L ${LABEL} new-session -d -s cork_${KEY} 'sleep 30'`);
      await startServer();
      expect(tmuxClients()).toBe(0);

      const ws = await wsConnect(SELF);
      await new Promise((r) => setTimeout(r, 600));
      expect(tmuxClients()).toBe(1);

      ws.close();
      await new Promise((r) => setTimeout(r, 800));
      expect(tmuxClients()).toBe(0);
    }, 15_000);

    /** Two tabs on one pane would be two tmux clients fighting over its width. */
    it("keeps only the newest browser attached to a session", async () => {
      execSync(`tmux -L ${LABEL} new-session -d -s cork_${KEY} 'sleep 30'`);
      await startServer();

      const first = await wsConnect(SELF);
      await new Promise((r) => setTimeout(r, 600));
      expect(tmuxClients()).toBe(1);

      const second = await wsConnect(SELF); // a second tab
      await new Promise((r) => setTimeout(r, 900));
      expect(tmuxClients()).toBe(1); // still one — the first was dropped
      expect(first.readyState).not.toBe(1); // ...and it was the first one

      second.close();
    }, 15_000);

    it("streams the tmux pane to the browser", async () => {
      execSync(`tmux -L ${LABEL} new-session -d -s cork_${KEY} 'echo CORK_WEB_OK; sleep 30'`);
      await startServer();
      const ws = await wsConnect(SELF);
      const out = await new Promise<string>((resolve) => {
        let buf = "";
        ws.on("message", (d) => (buf += d.toString()));
        setTimeout(() => {
          ws.close();
          resolve(buf);
        }, 1500);
      });
      expect(out).toContain("CORK_WEB_OK");
    }, 15_000);

    it("delivers browser keystrokes to the pane", async () => {
      // `cat` echoes whatever it is fed, so a keystroke that lands comes back.
      execSync(`tmux -L ${LABEL} new-session -d -s cork_${KEY} 'cat'`);
      await startServer();
      const ws = await wsConnect(SELF); // already open by the time this resolves
      const out = await new Promise<string>((resolve) => {
        let buf = "";
        ws.on("message", (d) => (buf += d.toString()));
        // Let tmux paint the pane before typing into it.
        setTimeout(
          () => ws.send(JSON.stringify({ type: "input", data: "CORK_TYPED\r" })),
          400
        );
        setTimeout(() => {
          ws.close();
          resolve(buf);
        }, 2000);
      });
      expect(out).toContain("CORK_TYPED");
    }, 15_000);

    /**
     * Wide characters reached the browser as runs of `_` once, with the daemon
     * started by launchd (no locale in its environment at all) — a tmux client
     * that does not believe its terminal is UTF-8 mangles them exactly that way.
     * `-u` plus a LANG on the pty is the documented guard and the symptom went
     * away, but it has not reproduced since, so this only pins the end-to-end
     * behaviour: CJK in a pane must arrive intact. It is NOT a regression test for
     * the locale itself — stripping the guard does not currently fail it.
     */
    it("streams CJK from the pane through to the browser", async () => {
      execSync(`tmux -L ${LABEL} new-session -d -s cork_${KEY} 'printf "中文测试\\n"; sleep 30'`);
      await startServer();
      const ws = await wsConnect(SELF);
      const out = await new Promise<string>((resolve) => {
        let buf = "";
        ws.on("message", (d) => (buf += d.toString()));
        setTimeout(() => {
          ws.close();
          resolve(buf);
        }, 1500);
      });
      expect(out).toContain("中文测试");
      expect(out).not.toMatch(/_{4,}/); // the mangled form
    }, 15_000);
  });
});
