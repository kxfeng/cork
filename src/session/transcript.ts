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
    latest = {
      model: typeof msg.model === "string" ? msg.model : null,
      inputTokens: usage.input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
    };
  }
  return latest;
}

/** Pretty model id (`claude-opus-4-7` → `Opus 4.7`). */
export function formatModelName(modelId: string | null): string {
  if (!modelId) return "(unknown)";
  const m = modelId.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (!m) return modelId;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2]}.${m[3]}`;
}

/** Default context window in tokens, by model family. */
export function contextWindowFor(modelId: string | null): number {
  if (!modelId) return 200_000;
  if (/opus-4|sonnet-4/i.test(modelId)) return 1_000_000;
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
