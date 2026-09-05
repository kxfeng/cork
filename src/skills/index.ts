import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../config/paths.js";
import { getLogger } from "../logger.js";

const logger = getLogger("skill");

/**
 * Skill templates, versioned as plain markdown beside this module so they can be
 * edited without touching code: `src/skills/<name>/SKILL.md`. copy-assets.js
 * ships them into dist, so this resolves under both `tsx src/…` (dev) and
 * `node dist/…`.
 */
const TEMPLATE_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * The skills cork injects into every session. Each name is both the directory
 * here and the name claude keys the skill by, and must match the `name:` in that
 * skill's frontmatter.
 *
 * Anything else under the skills root is pruned, so renaming a skill here
 * removes the old copy rather than leaving claude loading both.
 */
export const SKILL_NAMES = ["cork", "cork-autopilot"] as const;

/** The dir claude scans for skills when it gets agentDir via --add-dir. */
export function skillsRoot(): string {
  return path.join(paths.agentDir, ".claude", "skills");
}

/** Absolute path of a rendered skill, at the layout claude discovers. */
export function skillPath(name: string): string {
  return path.join(skillsRoot(), name, "SKILL.md");
}

/**
 * (Re)write cork's injected skills so the on-disk copies always match the
 * running cork version. Called on daemon start. Templates are copied verbatim —
 * no substitution — so nothing about the environment is baked in: a skill reads
 * the bot's app id from cork's config at runtime, and resolves the owner from
 * the triggering message's senderId. No id, secret, or personal data ever lands
 * in a file.
 *
 * Never throws. A missing or unreadable template costs that skill, not the
 * daemon — startup must not die because one asset failed to ship.
 */
export function writeSkills(): void {
  // Create the root FIRST: startSession passes agentDir to claude via
  // --add-dir, so it has to exist even when every write below fails — an
  // --add-dir pointing at nothing would take every session down with it.
  try {
    fs.mkdirSync(skillsRoot(), { recursive: true });
  } catch (err) {
    logger.error("failed to create skills root", { err });
    return;
  }

  let written = 0;
  for (const name of SKILL_NAMES) {
    const template = path.join(TEMPLATE_ROOT, name, "SKILL.md");
    try {
      const content = fs.readFileSync(template, "utf8");
      const file = skillPath(name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      written++;
      logger.info("wrote cork skill", { file });
    } catch (err) {
      logger.error("failed to write skill", { name, template, err });
    }
  }

  // Prune only after everything shipped: rendering nothing means the assets
  // failed to ship, which is a packaging bug, not a reason to wipe the skills a
  // working install already has on disk.
  if (written === SKILL_NAMES.length) pruneStaleSkills();
}

/**
 * Delete skill dirs cork does not ship. Renaming a skill would otherwise leave
 * the old copy behind forever and claude would load both — the stale one still
 * carrying whatever instructions the rename was meant to replace.
 */
function pruneStaleSkills(): void {
  const keep = new Set<string>(SKILL_NAMES);
  try {
    for (const entry of fs.readdirSync(skillsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      fs.rmSync(path.join(skillsRoot(), entry.name), {
        recursive: true,
        force: true,
      });
      logger.info("pruned stale skill", { name: entry.name });
    }
  } catch (err) {
    logger.error("failed to prune stale skills", { err });
  }
}
