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

// Cork skill template (tsc emits only .js, so the .md must be copied alongside).
const skillFrom = path.join(root, "src", "skills", "SKILL.md");
const skillTo = path.join(root, "dist", "skills", "SKILL.md");
if (fs.existsSync(skillFrom)) {
  fs.mkdirSync(path.dirname(skillTo), { recursive: true });
  fs.copyFileSync(skillFrom, skillTo);
}
