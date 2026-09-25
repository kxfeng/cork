#!/usr/bin/env node
/**
 * Remove from dist/ whatever no longer has a source.
 *
 * tsc and copy-assets only ever add and overwrite, so a deleted or renamed
 * module leaves its old .js behind, and a removed skill directory would keep
 * shipping its SKILL.md. Run after both, never instead of a clean build: dist
 * stays whole throughout, which matters because a running cork executes its
 * hooks and channel MCP straight out of dist/ while this checkout rebuilds.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const src = path.join(root, "src");
const rel = (p) => path.relative(root, p);

/** The source a compiled file came from, or null when the name is not tsc's. */
function sourceOf(file) {
  const m = path.relative(dist, file).match(/^(.*?)(\.d\.ts\.map|\.d\.ts|\.js\.map|\.js)$/);
  return m ? path.join(src, `${m[1]}.ts`) : null;
}

/** Files copied verbatim by copy-assets: kept while the original exists. */
function isCopiedAsset(file) {
  const r = path.relative(dist, file).split(path.sep);
  return (r[0] === "web" && r[1] === "public") || (r[0] === "skills" && r[2] === "SKILL.md");
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (fs.existsSync(dist)) {
  for (const file of walk(dist)) {
    let keep;
    if (isCopiedAsset(file)) keep = fs.existsSync(path.join(src, path.relative(dist, file)));
    else {
      const source = sourceOf(file);
      keep = source === null || fs.existsSync(source);
    }
    if (!keep) {
      fs.rmSync(file);
      console.log(`pruned ${rel(file)}`);
    }
  }
  // Directories left empty by the above, deepest first.
  const dirs = [];
  (function collect(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) collect(path.join(dir, e.name));
    }
    dirs.push(dir);
  })(dist);
  for (const dir of dirs) {
    if (dir !== dist && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      console.log(`pruned ${rel(dir)}/`);
    }
  }
}
