import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loginShell,
  minimalPath,
  resolveLoginPath,
  which,
  withEntries,
} from "../src/daemon/login-path.js";

/**
 * The daemon takes PATH from the user's login shell, not from whoever started
 * it: `systemd-run cork restart` once wrote systemd's bare PATH into the unit and
 * the next daemon could not find claude.
 */

let dir: string;
const savedPath = process.env.PATH;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-login-path-"));
});

afterEach(() => {
  process.env.PATH = savedPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in login shell: `body` runs first, then the command it was given. */
function fakeShell(body: string): string {
  const f = path.join(dir, "fakesh");
  fs.writeFileSync(f, `#!/bin/sh\n${body}\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });
  return f;
}

describe("resolveLoginPath", () => {
  it("reads PATH as the login shell sets it, whatever the rc files print", () => {
    const shell = fakeShell('echo "welcome back"; export PATH=/home/u/.local/bin:/usr/bin');
    expect(resolveLoginPath({ shell })).toBe("/home/u/.local/bin:/usr/bin");
  });

  it("does not care about the PATH it was started with", () => {
    process.env.PATH = "/usr/bin:/bin";
    const shell = fakeShell("export PATH=/opt/tools/bin:/usr/bin");
    expect(resolveLoginPath({ shell })).toBe("/opt/tools/bin:/usr/bin");
  });

  it("still takes PATH from a shell whose rc files end in an error", () => {
    const f = path.join(dir, "failsh");
    fs.writeFileSync(f, '#!/bin/sh\nexport PATH=/a/bin:/usr/bin\n/bin/sh -c "$2"\nexit 3\n', {
      mode: 0o755,
    });
    expect(resolveLoginPath({ shell: f })).toBe("/a/bin:/usr/bin");
  });

  it("gives up on a shell that hangs", () => {
    const shell = fakeShell("sleep 5");
    const started = Date.now();
    expect(resolveLoginPath({ shell, timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("gives up on a shell that never prints PATH, or is not there", () => {
    const f = path.join(dir, "mute");
    fs.writeFileSync(f, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(resolveLoginPath({ shell: f })).toBeNull();
    expect(resolveLoginPath({ shell: path.join(dir, "missing") })).toBeNull();
  });

  it("works with this machine's real login shell", () => {
    const got = resolveLoginPath();
    expect(got).toMatch(/\//);
  });
});

describe("loginShell", () => {
  it("prefers $SHELL, then the account's shell", () => {
    expect(loginShell({ SHELL: "/bin/zsh" })).toBe("/bin/zsh");
    expect(loginShell({})).toBe(os.userInfo().shell || "/bin/sh");
  });
});

/** A dir holding executables with these names. */
function binDir(name: string, cmds: string[]): string {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  for (const c of cmds) fs.writeFileSync(path.join(d, c), "#!/bin/sh\n", { mode: 0o755 });
  return d;
}

describe("which", () => {
  it("finds the first executable on PATH, without following symlinks", () => {
    const a = binDir("a", ["tool"]);
    const b = binDir("b", ["tool", "other"]);
    fs.symlinkSync(path.join(b, "other"), path.join(a, "linked"));
    expect(which("tool", `${a}:${b}`)).toBe(path.join(a, "tool"));
    expect(which("linked", `${a}:${b}`)).toBe(path.join(a, "linked"));
    expect(which("missing", `${a}:${b}`)).toBeNull();
  });

  it("skips a file that is not executable", () => {
    const a = binDir("a", []);
    fs.writeFileSync(path.join(a, "tool"), "", { mode: 0o644 });
    expect(which("tool", a)).toBeNull();
  });
});

describe("the unit's PATH", () => {
  it("is node's dir, claude's dir and the system dirs — nothing else the caller has", () => {
    const node = binDir("node-bin", ["node"]);
    const claude = binDir("claude-bin", ["claude"]);
    const extra = binDir("extra", ["go"]);
    const p = minimalPath(`${extra}:${node}:${claude}:/usr/bin`).split(":");
    expect(p[0]).toBe(node);
    expect(p[1]).toBe(claude);
    expect(p).toContain("/usr/bin");
    expect(p).not.toContain(extra);
  });

  it("falls back to the running node when the login PATH has none", () => {
    const p = minimalPath(binDir("empty", []));
    expect(p.split(":")[0]).toBe(path.dirname(process.execPath));
  });

  it("is what the systemd unit is written with", async () => {
    const login = `${binDir("node-bin", ["node", "cork"])}:${binDir("claude-bin", ["claude"])}:/usr/bin`;
    const { generateUnit } = await import("../src/daemon/service.js");
    const unit = generateUnit(login);
    expect(unit).toContain(`Environment="PATH=${minimalPath(login)}"`);
    expect(unit).toContain(`ExecStart=${path.join(dir, "node-bin", "cork")} start --daemon`);
  });

  it("is what the launchd plist is written with", async () => {
    const login = `${binDir("node-bin", ["node", "cork"])}:${binDir("claude-bin", ["claude"])}:/usr/bin`;
    const { generatePlist } = await import("../src/daemon/service.js");
    const plist = generatePlist(login);
    expect(plist).toContain(`<string>${minimalPath(login)}</string>`);
    expect(plist).toContain(`<string>${path.join(dir, "node-bin", "cork")}</string>`);
  });
});

describe("withEntries", () => {
  it("appends only what is missing, keeping order", () => {
    expect(withEntries("/a:/b", "/b:/c:/a:/d")).toBe("/a:/b:/c:/d");
  });
});
