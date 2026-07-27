import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../config/paths.js";
import { getLogger } from "../logger.js";

const logger = getLogger("skill");

/**
 * The skill template, versioned as plain markdown beside this module so it can
 * be edited without touching code. copy-assets.js ships it into dist, so this
 * resolves under both `tsx src/…` (dev) and `node dist/…`.
 */
const TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "SKILL.md"
);

/** Skill name — the dir claude keys it by. Must match the template frontmatter. */
export const SKILL_NAME = "cork";

/** The dir claude scans for skills when it gets agentDir via --add-dir. */
export function skillsRoot(): string {
  return path.join(paths.agentDir, ".claude", "skills");
}

/** Absolute path of the rendered skill, at the layout claude discovers. */
export function skillPath(): string {
  return path.join(skillsRoot(), SKILL_NAME, "SKILL.md");
}

/**
 * (Re)write cork's injected skill so the on-disk copy always matches the running
 * cork version. Called on daemon start. The template is copied verbatim — no
 * substitution — so nothing about the environment is baked in: the skill reads
 * the bot's app id from cork's config at runtime, and resolves the owner from
 * the triggering message's senderId. No id, secret, or personal data ever lands
 * in the file.
 *
 * Never throws. A missing or unreadable template costs the skill, not the
 * daemon — startup must not die because one asset failed to ship.
 */
export function writeSkill(): void {
  // Create the root FIRST: startSession passes agentDir to claude via
  // --add-dir, so it has to exist even when the template below fails — an
  // --add-dir pointing at nothing would take every session down with it.
  try {
    fs.mkdirSync(skillsRoot(), { recursive: true });
  } catch (err) {
    logger.error("failed to create skills root", { err });
    return;
  }

  try {
    const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
    const file = skillPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, template);
    logger.info("wrote cork skill", { file });
  } catch (err) {
    logger.error("failed to write cork skill", { template: TEMPLATE_PATH, err });
    return; // nothing written — see pruneStaleSkills on why that blocks pruning
  }

  pruneStaleSkills();
}

/**
 * Delete skill dirs cork does not ship. Renaming the skill would otherwise
 * leave the old copy behind forever and claude would load both — the stale one
 * still carrying whatever instructions the rename was meant to replace.
 *
 * Only runs after a successful write: rendering nothing means the asset failed
 * to ship, which is a packaging bug, not a reason to wipe the skill a working
 * install already has on disk.
 */
function pruneStaleSkills(): void {
  try {
    for (const entry of fs.readdirSync(skillsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === SKILL_NAME) continue;
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
