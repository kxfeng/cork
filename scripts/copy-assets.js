#!/usr/bin/env node
/** tsc only emits .js — copy non-.ts assets into dist alongside it. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Web UI static files.
const from = path.join(root, "src", "web", "public");
const to = path.join(root, "dist", "web", "public");
if (fs.existsSync(from)) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
}

// Cork skill templates, one dir each (tsc emits only .js, so the .md files must
// be copied alongside). Every src/skills/<name>/SKILL.md ships.
const skillsFrom = path.join(root, "src", "skills");
if (fs.existsSync(skillsFrom)) {
  for (const entry of fs.readdirSync(skillsFrom, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = path.join(skillsFrom, entry.name, "SKILL.md");
    if (!fs.existsSync(from)) continue;
    const to = path.join(root, "dist", "skills", entry.name, "SKILL.md");
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}
