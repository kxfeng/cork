import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import { listSessions, loadSession } from "../session/store.js";
import type { SessionManager } from "../session/manager.js";
import { TMUX_PREFIX, tmuxLabel, liveTmuxSessions } from "../session/tmux.js";
import { paths } from "../config/paths.js";
import type { WebConfig } from "../config/schema.js";
import { collectStatus } from "../session/status.js";
import { getLogger } from "../logger.js";

const logger = getLogger("web");
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Attaching to a cork pane is equivalent to a shell on this machine, so what
 * gates this server is worth stating plainly.
 *
 * THE TOKEN IS THE GATE. Everything else is defence in depth.
 *
 * It is tempting to argue that a loopback-bound server needs no secret — a peer
 * on 127.0.0.1 is a local process, and a local process could just run
 * `tmux attach` anyway. That argument is false, because "reached us on loopback"
 * does not mean "is local": any reverse proxy (nginx, ngrok, cloudflared,
 * ssh -R) can republish this port to the world, and the request that then
 * arrives carries whatever headers the proxy and its client chose. `Host` is
 * routinely rewritten to 127.0.0.1 by proxy configs, and a non-browser caller
 * can simply assert `Origin: http://127.0.0.1:<port>`. So the token is checked
 * on every request, whatever we are bound to.
 *
 * The provenance headers below still earn their place: they are what stops a page
 * the user merely *visits* from driving this server through their browser — which
 * is a real attack even with a token, since WebSocket ignores CORS entirely and a
 * hostile page can open ws://127.0.0.1/ws directly. Unlike a proxied request,
 * these are set by the browser itself and script cannot forge them (both are
 * forbidden header names):
 *
 *   Origin           — present on every fetch and WS handshake; ours is
 *                      http://127.0.0.1:<port>, an attacker's is their site.
 *   Sec-Fetch-Site   — none (user typed/bookmarked) | same-origin (our page's
 *                      own request) | cross-site (someone else started it).
 *
 * Host being loopback additionally defeats DNS rebinding: the attacker's name
 * resolves to 127.0.0.1, but the Host header still says evil.com.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * The token is also accepted from a cookie, set on the first request that carries
 * it in the query string. That keeps the token out of the URL for every
 * subsequent visit (a bookmark to http://127.0.0.1:<port>/ just works) without
 * weakening anything: SameSite=Strict means a request initiated by any other site
 * carries no cookie at all, and HttpOnly keeps it away from script.
 */
const COOKIE = "cork_web_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * A closed tab does not reliably send a WebSocket close frame, so without this
 * the `tmux attach` behind it lives on as a ghost client — and since tmux sizes a
 * window across ALL its clients, a ghost keeps squeezing the pane for everyone
 * still watching. Ping each socket; a client that misses a beat is terminated,
 * which runs the close handler that reaps its pty.
 */
const HEARTBEAT_MS = 15_000;

/** Read the persisted token, minting one on first use. Kept 0600 — it is a key. */
export function readOrCreateToken(): string {
  const file = path.join(paths.corkDir, "web-token");
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(paths.corkDir, { recursive: true });
  fs.writeFileSync(file, token + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}

/** Constant-time compare so the token cannot be recovered by timing the response. */
function tokenMatches(given: string | null, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(host);
}

/** Pull our token out of a Cookie header, if it is there. */
function cookieToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

/**
 * Whether the browser says this request came from our own page (or from the user
 * typing the URL) rather than from another site's script. See LOOPBACK_HOSTS.
 * `strict` additionally demands an Origin — the WebSocket handshake always
 * carries one, so its absence means the caller is not a browser.
 */
function sameOrigin(
  headers: http.IncomingHttpHeaders,
  port: number,
  strict = false
): boolean {
  const origin = headers.origin;
  if (origin) {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    if (!LOOPBACK_HOSTS.has(u.hostname) || u.port !== String(port)) return false;
  } else if (strict) {
    return false;
  }

  // Sent by every current browser. Absent for curl and friends, which is fine:
  // a local process needs no exploit, it can just attach to tmux.
  const site = headers["sec-fetch-site"];
  if (site && site !== "none" && site !== "same-origin") return false;

  return true;
}

const ASSETS: Record<string, { file: string; type: string }> = {
  "/assets/xterm.js": {
    file: "@xterm/xterm/lib/xterm.js",
    type: "text/javascript",
  },
  "/assets/xterm.css": { file: "@xterm/xterm/css/xterm.css", type: "text/css" },
  "/assets/addon-fit.js": {
    file: "@xterm/addon-fit/lib/addon-fit.js",
    type: "text/javascript",
  },
  "/assets/addon-webgl.js": {
    file: "@xterm/addon-webgl/lib/addon-webgl.js",
    type: "text/javascript",
  },
};

/** Resolve a bundled xterm asset out of node_modules, wherever cork is installed. */
function assetPath(rel: string): string | null {
  // dist/web/ -> package root is two levels up; also try the source layout.
  for (const root of [path.join(here, "..", ".."), path.join(here, "..", "..", "..")]) {
    const p = path.join(root, "node_modules", rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export class WebServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  /** The live browser attachment per session key — a second one replaces the first. */
  private attached = new Map<string, WebSocket>();
  private readonly host: string;
  private readonly token: string;

  constructor(
    private config: WebConfig,
    /** Absent in tests that only exercise the HTTP surface; status then reads disk. */
    private sessions?: SessionManager
  ) {
    this.host = config.host ?? "127.0.0.1";
    this.token = readOrCreateToken();
  }

  /** The URL to open once; after that the cookie carries the token. */
  url(): string {
    return `http://${this.host}:${this.config.port}/?token=${this.token}`;
  }

  /** Browser provenance + loopback Host. Defence in depth, not the gate. */
  private originOk(
    headers: http.IncomingHttpHeaders,
    strict = false
  ): boolean {
    // Host is only meaningful as a rebinding defence while we are loopback-bound.
    if (LOOPBACK_HOSTS.has(this.host) && !hostIsLoopback(headers.host)) {
      return false;
    }
    return sameOrigin(headers, this.config.port, strict);
  }

  /** The gate: a valid token, from the query string or the cookie it sets. */
  private tokenOk(url: URL, headers: http.IncomingHttpHeaders): boolean {
    if (tokenMatches(url.searchParams.get("token"), this.token)) return true;
    return tokenMatches(cookieToken(headers.cookie), this.token);
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      // WebSocket is exempt from CORS, so this handshake is the single most
      // attackable surface here. Demand an Origin (strict): a real browser always
      // sends one, and a hostile page's will not be ours.
      if (!this.originOk(req.headers, true) || !this.tokenOk(url, req.headers)) {
        socket.destroy();
        return;
      }
      const key = url.searchParams.get("session");
      if (!key) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.attach(ws, key));
    });

    this.heartbeat = setInterval(() => {
      for (const ws of this.wss!.clients) {
        const c = ws as WebSocket & { isAlive?: boolean };
        if (c.isAlive === false) {
          c.terminate(); // fires "close" → reaps the pty
          continue;
        }
        c.isAlive = false;
        c.ping();
      }
    }, HEARTBEAT_MS);

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, this.host, () => resolve());
    });

    // Logged without the token — a log is no place for a key. `cork status`
    // prints the full URL; the token itself lives in ~/.cork/web-token (0600).
    logger.info("web terminal listening", {
      url: `http://${this.host}:${this.config.port}/`,
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.wss?.clients.forEach((c) => c.terminate());
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // close() only stops accepting — it then waits for every open connection
      // to end. A browser sitting on the page holds a keep-alive socket, so
      // without this `cork restart` stalls until the 5s keepAliveTimeout.
      this.server.closeAllConnections();
    });
    this.server = null;
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (!this.originOk(req.headers)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    // Assets carry no secrets and the page needs them before it can talk to the
    // API at all.
    const asset = ASSETS[url.pathname];
    if (asset) {
      const p = assetPath(asset.file);
      if (!p) {
        res.writeHead(404).end("asset not found");
        return;
      }
      res.writeHead(200, { "content-type": asset.type });
      fs.createReadStream(p).pipe(res);
      return;
    }

    if (!this.tokenOk(url, req.headers)) {
      res
        .writeHead(401)
        .end("unauthorized — open the URL printed by `cork status`");
      return;
    }

    // Authenticated by ?token=… — hand back a cookie so the URL never needs to
    // carry it again. SameSite=Strict: a request another site initiates (including
    // a WebSocket handshake) sends no cookie, so this cannot be replayed off-site.
    if (url.searchParams.has("token")) {
      res.setHeader(
        "set-cookie",
        `${COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`
      );
    }

    if (url.pathname === "/api/sessions") {
      const live = liveTmuxSessions();
      const sessions = listSessions()
        .map(({ key, meta }) => ({
          key,
          channel: meta.channel ?? "lark",
          chatName: meta.chatName,
          chatType: meta.chatType,
          workspace: meta.workspace,
          lastActiveAt: meta.lastActiveAt,
          isThread: !!meta.threadId,
          alive: live.has(TMUX_PREFIX + key),
        }))
        .sort((a, b) => {
          if (a.alive !== b.alive) return a.alive ? -1 : 1;
          return (b.lastActiveAt || "").localeCompare(a.lastActiveAt || "");
        });
      res.writeHead(200, { "content-type": "application/json" });
      // defaultWorkspace rides along so the create dialog can prefill it
      // without a second round trip; the page refreshes this list anyway.
      res.end(
        JSON.stringify({
          sessions,
          defaultWorkspace: this.sessions?.defaultWorkspace() ?? "",
        })
      );
      return;
    }

    // What `/status` reports in a chat, as JSON. Falls back to the record on
    // disk when the daemon has not loaded this session: unlike the chat command,
    // the Info button is reachable for a session that is not running, and
    // answering "no session" for one the user can see in the list would be a lie.
    if (url.pathname === "/api/session/status") {
      const key = url.searchParams.get("session") || "";
      const meta = this.sessions?.getSessionByKey(key)?.meta ?? loadSession(key);
      if (!meta) {
        res.writeHead(404).end("no such session");
        return;
      }
      collectStatus(key, meta)
        .then((status) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(status));
        })
        .catch((err) => {
          logger.error("failed to collect status", { key, err });
          res.writeHead(500).end("failed to read session status");
        });
      return;
    }

    // Open a Claude Code session that belongs to no chat. Separate from the
    // lifecycle arm below because it takes a body rather than a key, and
    // answers with the key it minted so the page can select it straight away.
    if (url.pathname === "/api/session/create" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on("end", () => {
        let msg: { name?: string; workspace?: string };
        try {
          msg = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400).end("bad json");
          return;
        }
        if (!this.sessions) {
          res.writeHead(503).end("no session manager");
          return;
        }
        try {
          const { key } = this.sessions.createLocalSession({
            name: msg.name,
            workspace: msg.workspace,
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ key }));
        } catch (err) {
          logger.error("failed to create local session", { err });
          res.writeHead(500).end(String((err as Error).message || err));
        }
      });
      return;
    }

    // Actions on one session, keyed by name. They differ only in which manager
    // call they make: start brings the pane up (resuming the same Claude
    // session), stop kills the pane but keeps the record, delete kills it and
    // forgets the pairing, rename retitles a local one. None of them touch the
    // chat, and none delete Claude's own transcript.
    const action =
      req.method === "POST"
        ? url.pathname.match(/^\/api\/session\/(start|stop|delete|rename)$/)?.[1]
        : undefined;
    if (action) {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on("end", () => {
        let msg: { session?: string; name?: string };
        try {
          msg = JSON.parse(body);
        } catch {
          res.writeHead(400).end("bad json");
          return;
        }
        if (!msg.session) {
          res.writeHead(400).end("session is required");
          return;
        }
        if (action === "rename" && !msg.name?.trim()) {
          res.writeHead(400).end("name is required");
          return;
        }
        if (!this.sessions) {
          res.writeHead(503).end("no session manager");
          return;
        }
        const key = msg.session;
        const ok =
          action === "start"
            ? this.sessions.startSessionByKey(key)
            : action === "stop"
              ? this.sessions.stopSessionByKey(key)
              : action === "rename"
                ? this.sessions.renameSessionByKey(key, msg.name as string)
                : this.sessions.forgetSessionByKey(key);
        logger.info("web session action", { action, key, ok });
        if (!ok) {
          // Rename also refuses a chat session, whose title the platform owns
          // and overwrites — a distinct answer from "no such session", and one
          // the page cannot get around by hiding its own button.
          res
            .writeHead(action === "rename" ? 409 : 404)
            .end(
              action === "rename"
                ? "only a local session can be renamed"
                : "no such session"
            );
          return;
        }
        res.writeHead(204).end();
      });
      return;
    }

    if (url.pathname === "/") {
      const html = path.join(here, "public", "index.html");
      if (!fs.existsSync(html)) {
        res.writeHead(500).end("index.html missing from the build");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      fs.createReadStream(html).pipe(res);
      return;
    }

    res.writeHead(404).end("not found");
  }

  /** Bridge a browser terminal to `tmux attach` for one session. */
  private attach(ws: WebSocket, key: string): void {
    const target = TMUX_PREFIX + key;

    const live = ws as WebSocket & { isAlive?: boolean };
    live.isAlive = true;
    ws.on("pong", () => (live.isAlive = true));

    // At most one browser per session. Two tabs on the same pane would be two
    // tmux clients, and tmux would size the window to fit both — so the smaller
    // tab silently truncates the larger one's output.
    this.attached.get(key)?.close();
    this.attached.set(key, ws);
    let term: pty.IPty;
    try {
      term = pty.spawn(
        "tmux",
        // -u forces UTF-8 output. A tmux client that believes its terminal is not
        // UTF-8 renders every wide character as `_` before it ever reaches us —
        // and launchd starts the daemon with no locale at all, so without this
        // (and LANG below) every CJK character in a pane arrives as underscores.
        ["-u", "-L", tmuxLabel(), "attach", "-t", target],
        {
          name: "xterm-256color",
          cols: 120,
          rows: 30,
          cwd: process.env.HOME,
          env: {
            ...(process.env as Record<string, string>),
            LANG: process.env.LANG || "en_US.UTF-8",
          },
        }
      );
    } catch (err) {
      logger.warn("failed to attach", { key, err });
      ws.send(`\r\n\x1b[31mfailed to attach to ${target}\x1b[0m\r\n`);
      ws.close();
      return;
    }

    logger.info("browser attached", { key });

    term.onData((d) => {
      if (ws.readyState === ws.OPEN) ws.send(d);
    });
    term.onExit(() => ws.close());

    ws.on("message", (raw) => {
      let msg: { type?: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "resize" && msg.cols && msg.rows) {
        // The pane must track the browser's viewport or the TUI wraps at the
        // wrong column.
        term.resize(msg.cols, msg.rows);
        return;
      }
      if (msg.type === "input" && typeof msg.data === "string") {
        term.write(msg.data);
      }
    });

    ws.on("close", () => {
      // Detach this client only. `tmux attach` exits on kill; the session and
      // the Claude process inside it keep running.
      try {
        term.kill();
      } catch {
        /* already gone */
      }
      if (this.attached.get(key) === ws) this.attached.delete(key);
      logger.info("browser detached", { key });
    });
  }
}
