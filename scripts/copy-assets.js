#!/usr/bin/env node
/** tsc only emits .js — copy the web UI's static files into dist alongside it. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "web", "public");
const to = path.join(root, "dist", "web", "public");

if (!fs.existsSync(from)) process.exit(0);
fs.mkdirSync(to, { recursive: true });
for (const f of fs.readdirSync(from)) {
  fs.copyFileSync(path.join(from, f), path.join(to, f));
}
