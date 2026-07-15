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
const PORT = 7788;
const KEY = "test_web-chat";
const LABEL = "corktest-web";
const SELF = `http://127.0.0.1:${PORT}`;

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

let token: string;

/** Records what the web server hands to the session manager. */
let dispatched: { key: string; text: string }[] = [];
let dispatchOk = true;

async function startServer(cfg: Record<string, unknown> = {}) {
  vi.resetModules(); // paths.ts / tmux.ts read their env at import time
  const { WebServer } = await import("../src/web/server.js");
  const fakeSessions = {
    dispatchWebMessage(key: string, text: string) {
      dispatched.push({ key, text });
      return dispatchOk;
    },
  };
  server = new WebServer({ port: PORT, ...cfg } as never, fakeSessions as never);
  await server.start();
  token = new URL(server.url()).searchParams.get("token")!;
}

/** Headers a browser would send for our page's own fetch. */
const ours = (extra: Record<string, string> = {}) => ({
  Origin: SELF,
  "Sec-Fetch-Site": "same-origin",
  ...extra,
});

/** Connect a WebSocket the way a browser would: chosen Origin, token via cookie. */
function wsConnect(
  origin: string,
  query = `session=${KEY}`,
  headers: Record<string, string> = {}
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${query}`, {
      origin,
      headers: { cookie: `cork_web_token=${token}`, ...headers },
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
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sessions", `${KEY}.json`),
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
    dispatched = [];
    dispatchOk = true;
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

    it("accepts ?token=… and hands back a SameSite=Strict cookie", async () => {
      await startServer();
      const r = await fetch(api(`/api/sessions?token=${token}`), { headers: ours() });
      expect(r.status).toBe(200);

      const cookie = r.headers.get("set-cookie") ?? "";
      expect(cookie).toContain(`cork_web_token=${token}`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
    });

    it("accepts the cookie afterwards, so the URL needs no token", async () => {
      await startServer();
      const r = await fetch(api("/api/sessions"), {
        headers: ours({ Cookie: `cork_web_token=${token}` }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { sessions: { key: string }[] };
      expect(body.sessions.map((s) => s.key)).toContain(KEY);
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
          Cookie: `cork_web_token=${token}`,
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
          Cookie: `cork_web_token=${token}`,
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

  describe("composer (/api/send)", () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(api("/api/send"), {
        method: "POST",
        headers: ours({
          "content-type": "application/json",
          Cookie: `cork_web_token=${token}`,
          ...headers,
        }),
        body: JSON.stringify(body),
      });

    it("hands the composed text to the session, not to the pane", async () => {
      await startServer();
      const r = await post({ session: KEY, text: "line one\nline two" });
      expect(r.status).toBe(204);
      expect(dispatched).toEqual([{ key: KEY, text: "line one\nline two" }]);
    });

    it("rejects an unauthenticated send", async () => {
      await startServer();
      const r = await fetch(api("/api/send"), {
        method: "POST",
        headers: ours({ "content-type": "application/json" }), // no token, no cookie
        body: JSON.stringify({ session: KEY, text: "hi" }),
      });
      expect(r.status).toBe(401);
      expect(dispatched).toEqual([]);
    });

    it("rejects a send from another site", async () => {
      await startServer();
      const r = await post(
        { session: KEY, text: "hi" },
        { Origin: "http://evil.example.com", "Sec-Fetch-Site": "cross-site" }
      );
      expect(r.status).toBe(403);
      expect(dispatched).toEqual([]);
    });

    it("rejects empty text", async () => {
      await startServer();
      expect((await post({ session: KEY, text: "   " })).status).toBe(400);
      expect(dispatched).toEqual([]);
    });

    it("reports a disconnected session as 409", async () => {
      await startServer();
      dispatchOk = false;
      expect((await post({ session: KEY, text: "hi" })).status).toBe(409);
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
