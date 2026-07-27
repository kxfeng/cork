import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The skill cork injects into every session. Properties that were silently
 * broken once, or would be silent if broken: the text must come from the
 * versioned src/skills/SKILL.md (NOT a string inlined in the .ts — that
 * regressed and shipped a stale copy), and a missing template must not take the
 * daemon down, since writeSkill runs during startup.
 */
const TEMPLATE = path.join(process.cwd(), "src", "skills", "SKILL.md");

let dir: string;

async function loadSkill() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  return import("../src/skills/index.js");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-skill-"));
  process.env.CORK_DIR = dir;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function skillsRootDir(): string {
  return path.join(dir, "agent", ".claude", "skills");
}

function written(): string {
  return fs.readFileSync(path.join(skillsRootDir(), "cork", "SKILL.md"), "utf8");
}

describe("writeSkill", () => {
  it("copies the versioned template verbatim", async () => {
    // No substitution anymore: the skill reads the bot app id from config at
    // runtime, so the written file must match the template byte for byte.
    const { writeSkill } = await loadSkill();
    writeSkill();

    const out = written();
    expect(out).toBe(fs.readFileSync(TEMPLATE, "utf8"));
    expect(out).toContain("name: cork"); // frontmatter claude needs
  });

  it("bakes in no app id — the skill reads it from config at runtime", async () => {
    // The whole point of #2: the id must NOT be frozen into the file. Guard both
    // the old placeholder and the concrete id, and assert the runtime read is
    // present instead.
    const { writeSkill } = await loadSkill();
    writeSkill();
    const out = written();
    expect(out).not.toContain("{{APP_ID}}");
    expect(out).not.toMatch(/cli_[a-z0-9]{16}/); // no concrete bot id frozen in
    expect(out).toContain("config.jsonc"); // reads the id at runtime instead
  });

  it("names the skill dir the same as the template frontmatter", async () => {
    // claude keys a skill by its dir name; if SKILL_NAME and the frontmatter
    // disagree the skill is confusing at best, so pin them to each other.
    const { writeSkill, SKILL_NAME, skillPath } = await loadSkill();
    writeSkill();
    expect(path.basename(path.dirname(skillPath()))).toBe(SKILL_NAME);
    expect(written().split("\n")).toContain(`name: ${SKILL_NAME}`);
  });

  it("takes its text from SKILL.md, not from a string inside the module", async () => {
    // The regression this guards: the renderer once carried its own inlined
    // copy, so edits to the .md changed nothing and a stale (wrong-language)
    // skill shipped. Finding the template's own line in the output proves the
    // file is the single source of truth.
    const marker = fs
      .readFileSync(TEMPLATE, "utf8")
      .split("\n")
      .find((l) => l.startsWith("description:"));
    expect(marker).toBeTruthy();

    const { writeSkill } = await loadSkill();
    writeSkill();
    expect(written()).toContain(marker!.trim());
  });

  it("ships an English template", async () => {
    // The skill is authored in English by request; a CJK character means a
    // localized copy crept back in.
    const { writeSkill } = await loadSkill();
    writeSkill();
    expect(/[一-龥]/.test(written())).toBe(false);
  });

  it("prunes a skill dir cork does not ship", async () => {
    // A renamed skill would otherwise linger forever and claude would load both
    // copies — the stale one still carrying what the rename meant to replace.
    const { writeSkill } = await loadSkill();
    const stale = path.join(skillsRootDir(), "cork-task", "SKILL.md");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "skill left behind by an earlier name");

    writeSkill();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(skillsRootDir(), "cork"))).toBe(true);
  });

  it("keeps what is on disk when the template could not be read", async () => {
    // Rendering nothing means the asset failed to ship — a packaging bug, not a
    // signal to prune the skill a working install already has.
    const { writeSkill } = await loadSkill();
    writeSkill(); // populate first
    const stale = path.join(skillsRootDir(), "cork-task");
    fs.mkdirSync(stale, { recursive: true });

    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT: template missing");
    });
    try {
      expect(() => writeSkill()).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(path.join(skillsRootDir(), "cork"))).toBe(true);
    expect(fs.existsSync(stale)).toBe(true); // pruning did not run either
  });

  it("survives a missing template instead of killing daemon startup", async () => {
    const { writeSkill } = await loadSkill();
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT: template missing");
    });
    try {
      expect(() => writeSkill()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    // The dir --add-dir points at still exists — that part must never fail.
    expect(fs.existsSync(skillsRootDir())).toBe(true);
  });
});
