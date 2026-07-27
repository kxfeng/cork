import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Skill injection has two halves that must agree, and nothing at runtime
 * complains when they stop agreeing: writeSkill puts SKILL.md somewhere, and
 * buildClaudeArgs tells claude where to look via --add-dir. If either side
 * drifts, sessions still start, messages still get answered — the model just
 * silently never learns the new-chat flow.
 *
 * What these tests can prove: cork passes --add-dir, and the file it writes
 * lands at the layout claude scans under it. What they cannot prove: that
 * claude honours --add-dir at all. That is an external contract of the claude
 * binary, verified by hand with a probe skill, not here.
 */
const WS = "/tmp/cork-skill-injection-ws";

let dir: string;

async function load() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const [{ SessionManager }, { paths }, skill] = await Promise.all([
    import("../src/session/manager.js"),
    import("../src/config/paths.js"),
    import("../src/skills/index.js"),
  ]);
  const mgr = new SessionManager({
    defaultWorkspace: WS,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  return { mgr, paths, ...skill };
}

const META = { sessionId: "sess-1", workspace: WS } as never;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-skill-inject-"));
  process.env.CORK_DIR = dir;
});

afterEach(() => {
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("--add-dir skill injection", () => {
  it("passes --add-dir with the agent dir as its value", async () => {
    const { mgr, paths } = await load();
    const args: string[] = mgr.buildClaudeArgs(META, false);

    const i = args.indexOf("--add-dir");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(paths.agentDir);
  });

  it("also passes it when resuming an existing claude session", async () => {
    // A resumed session gets a different argv branch (-r vs --session-id). The
    // skill has to load either way, or every pre-existing group loses new-chat.
    const { mgr, paths } = await load();
    const args: string[] = mgr.buildClaudeArgs(META, true);

    expect(args.slice(0, 2)).toEqual(["-r", "sess-1"]);
    expect(args[args.indexOf("--add-dir") + 1]).toBe(paths.agentDir);
  });

  it("writes the skill at the layout claude scans under --add-dir", async () => {
    // claude looks for <added-dir>/.claude/skills/<name>/SKILL.md. This pins
    // the relative path so shortening it (a tempting ~/.cork/skills/cork
    // simplification) fails loudly instead of silently hiding the skill.
    const { paths, skillPath } = await load();
    expect(path.relative(paths.agentDir, skillPath())).toBe(
      path.join(".claude", "skills", "cork", "SKILL.md")
    );
  });

  it("writeSkill leaves a readable SKILL.md inside the dir that gets passed", async () => {
    const { mgr, writeSkill, SKILL_NAME } = await load();
    writeSkill();

    const args: string[] = mgr.buildClaudeArgs(META, false);
    const added = args[args.indexOf("--add-dir") + 1];
    const file = path.join(added, ".claude", "skills", SKILL_NAME, "SKILL.md");
    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, "utf8");
    expect(body).toContain(`name: ${SKILL_NAME}`);
  });

  it("creates the dir even when the template is unreadable", async () => {
    // --add-dir pointing at a nonexistent path is fatal to the launch, so a
    // failed template must cost the skill, not every session.
    const { mgr, paths, writeSkill } = await load();
    const readFileSync = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(() => {
        throw new Error("template missing");
      });
    try {
      expect(() => writeSkill()).not.toThrow();
    } finally {
      readFileSync.mockRestore();
    }

    expect(fs.existsSync(paths.agentDir)).toBe(true);
    expect(mgr.buildClaudeArgs(META, false)).toContain("--add-dir");
  });
});
