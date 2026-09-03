import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../config/paths.js";

/**
 * Where the cork daemon's "run me in the background, keep me alive, start me at
 * boot" contract is fulfilled. macOS has launchd; Linux has the systemd --user
 * instance. Both give the same three things launchd always gave cork — a managed
 * background process, crash restart, and start-at-login — so the CLI commands
 * (start/stop/restart/status) stay platform-agnostic and defer the mechanism here.
 *
 * The systemd path is a --user service, never a system one: it needs no root, is
 * scoped to this user, and mirrors a launchd LaunchAgent exactly. Whether it
 * outlives an SSH session and starts at boot is a property of the user instance
 * (`loginctl enable-linger <user>`), not of this unit — with linger on it behaves
 * like launchd; without it, it stops when the last session ends. cork does not
 * flip linger on the user's behalf.
 */

const IS_MAC = process.platform === "darwin";

/** launchd label / systemd unit name — the daemon is `cork.service` under systemd. */
const LAUNCHD_LABEL = "com.cork.daemon";
const SYSTEMD_UNIT = "cork";

export type DaemonState = {
  /** A managed daemon is registered with the service manager (may be stopped). */
  present: boolean;
  /** The running process id, or null when registered-but-stopped or absent. */
  pid: number | null;
  /** Human name of the manager, for `cork status`. */
  manager: string;
};

/** Absolute path to the cork executable, for an ExecStart / ProgramArguments that
 *  the service manager launches with no shell PATH resolution of its own. */
function corkBin(): string {
  try {
    return execSync("which cork", { encoding: "utf-8" }).trim();
  } catch {
    return process.argv[1];
  }
}

/**
 * Other cork daemons already running, excluding this process and its immediate
 * relatives. Used to refuse a second foreground start that would fight the first
 * over the same tmux server and sockets.
 */
export function otherCorkProcesses(): { pid: number; command: string }[] {
  try {
    const output = execSync(
      `ps -eo pid,ppid,command | grep -E '[c]ork start' || true`,
      { encoding: "utf-8" }
    ).trim();
    if (!output) return [];

    const selfPid = process.pid;
    const selfPpid = process.ppid;

    return output
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) return null;
        const pid = parseInt(match[1], 10);
        const ppid = parseInt(match[2], 10);
        // Exclude self, parent, and children of self.
        if (pid === selfPid || pid === selfPpid || ppid === selfPid) return null;
        return { pid, command: match[3] };
      })
      .filter((x): x is { pid: number; command: string } => x !== null);
  } catch {
    return [];
  }
}

// ─────────────────────────────── macOS: launchd ───────────────────────────────

function generatePlist(): string {
  const bin = corkBin();

  // launchd starts the daemon from a bare environment — it never sources the
  // user's shell profile. Carry NODE_EXTRA_CA_CERTS across if the shell running
  // `cork start` has it set, so a daemon behind a TLS-inspecting proxy trusts the
  // same CAs the user's shell does. Unset ⇒ omitted.
  const extraCa = process.env.NODE_EXTRA_CA_CERTS;
  const extraCaEnv = extraCa
    ? `    <key>NODE_EXTRA_CA_CERTS</key>\n    <string>${extraCa}</string>\n`
    : "";

  // Exec cork directly (no `node` prefix) so package-manager wrappers like the
  // pnpm shell shim work — node would choke on their `#!/bin/sh` body. The
  // dist/index.js shebang routes to node when the symlink resolves straight to it.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>start</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${paths.stdoutLog}</string>
  <key>StandardErrorPath</key>
  <string>${paths.stderrLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH || "/usr/bin:/bin:/usr/local/bin"}</string>
    <key>HOME</key>
    <string>${process.env.HOME || ""}</string>
${extraCaEnv}  </dict>
</dict>
</plist>`;
}

function launchdLoaded(): boolean {
  try {
    const output = execSync(`launchctl list ${LAUNCHD_LABEL} 2>&1`, {
      encoding: "utf-8",
    });
    return !output.includes("Could not find service");
  } catch {
    return false;
  }
}

function launchdPid(): number | null {
  try {
    const output = execSync(`launchctl list ${LAUNCHD_LABEL} 2>&1`, {
      encoding: "utf-8",
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    if (match) return parseInt(match[1], 10);
    const lines = output.trim().split("\n");
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 1) {
        const pid = parseInt(parts[0], 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function launchdInstallStart(): void {
  const dir = path.dirname(paths.launchdPlist);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(paths.launchdPlist, generatePlist(), "utf-8");
  execSync(`launchctl load ${paths.launchdPlist} 2>&1`);
  execSync(`launchctl start ${LAUNCHD_LABEL} 2>&1`);
}

function launchdTeardown(): void {
  try {
    execSync(`launchctl unload ${paths.launchdPlist} 2>&1`);
  } catch {
    /* not loaded */
  }
  try {
    fs.unlinkSync(paths.launchdPlist);
  } catch {
    /* already gone */
  }
}

// ────────────────────────────── Linux: systemd ───────────────────────────────

/** Whether this user's systemd instance is reachable. False in contexts with no
 *  user bus (a bare `ssh host cmd`, cron, a stripped container), where the daemon
 *  can still be run with `cork start --foreground`. */
function systemdUserOk(): boolean {
  try {
    execSync("systemctl --user show --property=Version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function generateUnit(): string {
  const bin = corkBin();
  // systemd --user starts from a minimal environment; give the daemon (and every
  // tool it shells out to — node, claude, tmux) the PATH of the shell that ran
  // `cork start`, plus HOME, and NODE_EXTRA_CA_CERTS when set. Values are quoted so
  // a PATH with an unusual entry cannot break the line.
  const env: string[] = [
    `Environment="PATH=${process.env.PATH || "/usr/bin:/bin:/usr/local/bin"}"`,
    `Environment="HOME=${process.env.HOME || ""}"`,
  ];
  if (process.env.NODE_EXTRA_CA_CERTS) {
    env.push(`Environment="NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}"`);
  }
  return [
    "[Unit]",
    "Description=Cork daemon (Claude Code <-> IM bridge)",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    // start --daemon runs in the foreground and never returns, which is what
    // Type=simple expects; systemd tracks it as MainPID.
    `ExecStart=${bin} start --daemon`,
    // launchd's KeepAlive, restricted to crashes so a clean `cork stop` stays down.
    "Restart=on-failure",
    "RestartSec=2",
    ...env,
    "",
    "[Install]",
    // launchd's RunAtLoad: pulled in when the user instance reaches default.target
    // (at boot, if linger is on; otherwise at first login).
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function systemctlUser(args: string): void {
  execSync(`systemctl --user ${args}`, { stdio: "pipe" });
}

function systemdActive(): boolean {
  try {
    // is-active exits non-zero (throws) when the unit is not active.
    const out = execSync(`systemctl --user is-active ${SYSTEMD_UNIT}`, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return out === "active";
  } catch {
    return false;
  }
}

function systemdPid(): number | null {
  try {
    const out = execSync(
      `systemctl --user show ${SYSTEMD_UNIT} -p MainPID --value`,
      { encoding: "utf-8", stdio: "pipe" }
    ).trim();
    const pid = parseInt(out, 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writeUnit(): void {
  fs.mkdirSync(path.dirname(paths.systemdUnit), { recursive: true });
  fs.writeFileSync(paths.systemdUnit, generateUnit(), "utf-8");
  systemctlUser("daemon-reload");
}

function systemdInstallStart(): void {
  if (!systemdUserOk()) {
    throw new Error(
      "systemd user instance is not reachable (systemctl --user cannot connect " +
        "to a bus). Run `cork start --foreground`, or open a login session so " +
        "the user manager is available."
    );
  }
  writeUnit();
  // enable → start at boot/login; --now → start it right away.
  systemctlUser(`enable --now ${SYSTEMD_UNIT}`);
}

function systemdRestart(): void {
  if (!systemdUserOk()) {
    throw new Error(
      "systemd user instance is not reachable (systemctl --user cannot connect)."
    );
  }
  // Rewrite the unit so a moved cork binary / changed env is picked up, keep it
  // enabled for boot, then (re)start to run the current build now.
  writeUnit();
  systemctlUser(`enable ${SYSTEMD_UNIT}`);
  systemctlUser(`restart ${SYSTEMD_UNIT}`);
}

function systemdTeardown(): void {
  // disable --now stops it and drops the autostart symlink; then remove the unit
  // file, mirroring the way the macOS path deletes its plist.
  try {
    systemctlUser(`disable --now ${SYSTEMD_UNIT}`);
  } catch {
    /* not enabled / not running */
  }
  try {
    fs.unlinkSync(paths.systemdUnit);
  } catch {
    /* already gone */
  }
  try {
    systemctlUser("daemon-reload");
  } catch {
    /* bus gone */
  }
}

// ──────────────────────────── platform-agnostic API ───────────────────────────

/** The manager's name for status text. */
export function managerName(): string {
  return IS_MAC ? "launchd" : "systemd (user)";
}

/** Whether a managed daemon is registered, and its pid if it is running. */
export function daemonState(): DaemonState {
  if (IS_MAC) {
    const present = launchdLoaded();
    return { present, pid: present ? launchdPid() : null, manager: managerName() };
  }
  const active = systemdActive();
  const present = active || fs.existsSync(paths.systemdUnit);
  return { present, pid: active ? systemdPid() : null, manager: managerName() };
}

/**
 * Register the daemon with the service manager and start it in the background.
 * A no-op-ish success when it is already running (caller reports that). Throws
 * with a human message when the manager cannot be reached.
 */
export function installAndStart(): void {
  if (IS_MAC) launchdInstallStart();
  else systemdInstallStart();
}

/** Stop the daemon and drop its registration (no autostart afterwards). */
export function teardown(): void {
  if (IS_MAC) launchdTeardown();
  else systemdTeardown();
}

/** Stop and start again, rewriting the definition so a new build is picked up. */
export function restart(): void {
  if (IS_MAC) {
    launchdTeardown();
    // Give launchd a moment to release the label and the daemon to release its
    // UDS / log handles before relaunching.
    execSync("sleep 0.5");
    launchdInstallStart();
  } else {
    systemdRestart();
  }
}
