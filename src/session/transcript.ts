import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

export interface TranscriptUsage {
  model: string | null;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Path to claude code's per-session JSONL transcript.
 * Claude Code stores transcripts under ~/.claude/projects/<workspace>/<sessionId>.jsonl
 * where <workspace> is the absolute workspace path with `/` replaced by `-`.
 */
export function transcriptPath(workspace: string, sessionId: string): string {
  const slug = workspace.replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

/**
 * Stream the transcript and return the LAST assistant message that carried a
 * `message.usage` block. That row reflects the tokens actually loaded into
 * context for the most recent model turn — which is what Claude Code's
 * `/context` view shows. Returns null if the file is missing or has no usage.
 */
export async function readLatestUsage(
  workspace: string,
  sessionId: string
): Promise<TranscriptUsage | null> {
  const file = transcriptPath(workspace, sessionId);
  if (!fs.existsSync(file)) return null;

  let latest: TranscriptUsage | null = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj?.message;
    if (!msg || typeof msg !== "object") continue;
    const usage = msg.usage;
    if (!usage || typeof usage !== "object") continue;
    // Claude Code synthesizes assistant rows for API errors and they carry a
    // usage block too. Taking one as "latest" would report `<synthetic>` as the
    // model and size the context window off a name that isn't a model.
    if (msg.model === "<synthetic>") continue;
    latest = {
      model: typeof msg.model === "string" ? msg.model : null,
      inputTokens: usage.input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
    };
  }
  return latest;
}

/**
 * Parse a modern model id into family and version. Handles both the two-part
 * form (`claude-opus-4-7`) and the one-part form the 5 series uses
 * (`claude-opus-5`), and tolerates the `[1m]` suffix and date suffixes.
 * Returns null for pre-4 ids like `claude-3-5-sonnet-20241022`, whose family
 * and version are swapped.
 */
function parseModelId(
  modelId: string
): { family: string; major: number; minor: number } | null {
  const m = modelId.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (!m) return null;
  return {
    family: m[1].toLowerCase(),
    major: Number(m[2]),
    minor: m[3] ? Number(m[3]) : 0,
  };
}

/** Pretty model id (`claude-opus-4-7` → `Opus 4.7`, `claude-opus-5` → `Opus 5`). */
export function formatModelName(modelId: string | null): string {
  if (!modelId) return "(unknown)";
  const parsed = parseModelId(modelId);
  if (!parsed) return modelId;
  const { family, major, minor } = parsed;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return minor > 0 ? `${name} ${major}.${minor}` : `${name} ${major}`;
}

/**
 * Default context window in tokens, guessed from the model id.
 *
 * 1M is the default because that is where models have been heading; the 200K
 * cases are listed instead, so a model newer than this code reads as 1M rather
 * than as the smallest window we know of.
 *
 * This is a guess, and knowingly so. Claude Code runs a model in either a base
 * or a `[1m]` variant, but strips that suffix before writing `message.model`
 * to the transcript — the two are indistinguishable by the time we read them.
 * The authoritative number is `context_window.context_window_size` in the
 * statusLine hook payload, which cork does not subscribe to. Being off on a
 * percentage in a status line is not worth that plumbing.
 */
export function contextWindowFor(modelId: string | null): number {
  if (!modelId) return 200_000;
  const parsed = parseModelId(modelId);
  if (!parsed) return 200_000; // pre-4 ids: `claude-3-5-sonnet-…`
  const { family, major } = parsed;
  if (major >= 5) return 1_000_000;
  // Within the 4 series only opus is 1M — sonnet tops out at 4.6, which is not,
  // and no haiku is.
  if (family === "opus") return 1_000_000;
  return 200_000;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * Render the model+context summary as `model | used/total | pct%`.
 * Caller prefixes a label (e.g. `Claude context: ` or `📊 Context: `).
 * Falls back to a placeholder when no transcript exists yet.
 */
export function formatModelContext(usage: TranscriptUsage | null): string {
  if (!usage) return "(no claude session yet)";
  const total = contextWindowFor(usage.model);
  const used = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  return `${formatModelName(usage.model)} | ${formatTokens(used)}/${formatTokens(total)} | ${pct}%`;
}
