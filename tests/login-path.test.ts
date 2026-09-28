import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loginShell,
  minimalPath,
  resolveLoginPath,
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

describe("the unit's PATH", () => {
  it("is the node running cork and the system dirs, never the caller's PATH", () => {
    process.env.PATH = "/caller/only/bin:/usr/bin";
    const p = minimalPath();
    expect(p.split(":")[0]).toBe(path.dirname(process.execPath));
    expect(p).toContain("/usr/bin");
    expect(p).not.toContain("/caller/only/bin");
  });

  it("is what the systemd unit is written with", async () => {
    process.env.PATH = "/caller/only/bin:/usr/bin";
    const { generateUnit } = await import("../src/daemon/service.js");
    const unit = generateUnit();
    expect(unit).toContain(`Environment="PATH=${minimalPath()}"`);
    expect(unit).not.toContain("/caller/only/bin");
  });

  it("is what the launchd plist is written with", async () => {
    process.env.PATH = "/caller/only/bin:/usr/bin";
    const { generatePlist } = await import("../src/daemon/service.js");
    const plist = generatePlist();
    expect(plist).toContain(`<string>${minimalPath()}</string>`);
    expect(plist).not.toContain("/caller/only/bin");
  });
});

describe("withEntries", () => {
  it("appends only what is missing, keeping order", () => {
    expect(withEntries("/a:/b", "/b:/c:/a:/d")).toBe("/a:/b:/c:/d");
  });
});
