#!/usr/bin/env node
/**
 * node-pty ships prebuilt binaries, but its `spawn-helper` can land without the
 * executable bit (pnpm hard-links it out of the store, and node-pty's own
 * postinstall only handles Windows). Without +x, every pty.spawn fails with a
 * bare "posix_spawnp failed". Restore it.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let root;
try {
  root = path.dirname(require.resolve("node-pty/package.json"));
} catch {
  process.exit(0); // not installed — nothing to fix
}

const prebuilds = path.join(root, "prebuilds");
if (!fs.existsSync(prebuilds)) process.exit(0);

for (const dir of fs.readdirSync(prebuilds)) {
  const helper = path.join(prebuilds, dir, "spawn-helper");
  if (!fs.existsSync(helper)) continue;
  const mode = fs.statSync(helper).mode;
  if (mode & 0o111) continue; // already executable
  fs.chmodSync(helper, 0o755);
  console.log(`fixed node-pty spawn-helper permissions: ${dir}`);
}
