import fs from "node:fs";

/**
 * Markdown → Feishu post. The model writes ordinary markdown and references
 * local images with `![](path)`; this module finds those references so the
 * channel can upload them and inline them at the right spot.
 */

/** A local image the model referenced, and where in the text it sat. */
export interface ImageRef {
  /** Absolute path on disk. */
  path: string;
  /** Byte offsets of the whole `![...](path)` token. */
  start: number;
  end: number;
}

/**
 * Half-open ranges covering fenced blocks and inline code. Anything inside is
 * illustrative — a model explaining `![](x.png)` must not have that turn into a
 * real upload — so image extraction skips these entirely.
 */
export function scanCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Fenced blocks: ``` or ~~~, closed by a matching fence or by end of text.
  const fence = /^[ \t]*(`{3,}|~{3,})/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    const marker = m[1][0];
    const len = m[1].length;
    const open = m.index;
    const closer = new RegExp(`^[ \\t]*${marker === "`" ? "`" : "~"}{${len},}[ \\t]*$`, "gm");
    closer.lastIndex = fence.lastIndex;
    const close = closer.exec(text);
    const end = close ? close.index + close[0].length : text.length;
    ranges.push([open, end]);
    fence.lastIndex = end;
  }

  // Inline code spans, ignoring any that fall inside a fenced block above.
  const inline = /`+[^`\n]*`+/g;
  while ((m = inline.exec(text))) {
    const at = m.index;
    if (!ranges.some(([s, e]) => at >= s && at < e)) {
      ranges.push([at, at + m[0].length]);
    }
  }

  return ranges;
}

const IMAGE_TOKEN = /!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)\s*\)/g;

/**
 * Local images referenced as `![](path)`, in document order.
 *
 * Deliberately conservative — a reference is only returned when it is outside
 * code AND names a file that exists. That drops URLs and illustrative paths
 * without needing to reason about intent, and means a miss degrades to plain
 * text rather than to a failed send.
 */
/** Why a reference outside code was not turned into an upload. */
export type SkipReason = "remote" | "relative" | "missing";

export interface ImageScan {
  refs: ImageRef[];
  /** Skipped references, so a reply that silently lost an image can be traced. */
  skipped: Array<{ path: string; reason: SkipReason; start: number; end: number }>;
}

/**
 * Wrap skipped references in backticks so Lark leaves them alone.
 *
 * A post's `md` element is rendered by Lark, which parses markdown image syntax
 * itself — so a reference we declined to upload does not survive as text, it
 * becomes "<Image data error>" and the reader learns nothing. Inline code is the
 * one form Lark does not touch (proven by the fenced and inline examples that do
 * survive), so it keeps the path visible and debuggable.
 */
export function escapeSkipped(text: string, scan: ImageScan): string {
  if (scan.skipped.length === 0) return text;
  let out = text;
  // Back to front: earlier offsets stay valid as later ones are rewritten.
  for (const s of [...scan.skipped].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + "`" + out.slice(s.start, s.end) + "`" + out.slice(s.end);
  }
  return out;
}

export function scanImages(text: string): ImageScan {
  const code = scanCodeRanges(text);
  const refs: ImageRef[] = [];
  const skipped: ImageScan["skipped"] = [];

  IMAGE_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMAGE_TOKEN.exec(text))) {
    const start = m.index;
    if (code.some(([s, e]) => start >= s && start < e)) continue; // illustrative

    // `![](<path with spaces>)` is legal markdown; strip the angle brackets.
    let path = m[1];
    if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1);

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      skipped.push({ path, reason: "remote", start, end: start + m[0].length });
      continue;
    }

    // Absolute only. A relative path would resolve against the daemon's cwd
    // ("/" under launchd), not the session's workspace where the model wrote
    // the file — so it would either silently miss or, worse, match an unrelated
    // file of the same name. Leaving it as text is the honest outcome.
    if (!path.startsWith("/")) {
      skipped.push({ path, reason: "relative", start, end: start + m[0].length });
      continue;
    }

    try {
      if (!fs.statSync(path).isFile()) {
        skipped.push({ path, reason: "missing", start, end: start + m[0].length });
        continue;
      }
    } catch {
      skipped.push({ path, reason: "missing", start, end: start + m[0].length });
      continue;
    }

    refs.push({ path, start, end: start + m[0].length });
  }

  return { refs, skipped };
}

export function extractImageRefs(text: string): ImageRef[] {
  return scanImages(text).refs;
}

/** One piece of a post message: markdown prose, or an uploaded image. */
export type PostSegment =
  | { kind: "md"; text: string }
  | { kind: "img"; imageKey: string };

/**
 * Split text at the given image references, pairing each with its uploaded key.
 * `keys[i]` corresponds to `refs[i]`; a null key means the upload failed, in
 * which case the original markdown token is kept as text so the reply still
 * carries the reference.
 */
export function buildSegments(
  text: string,
  refs: ImageRef[],
  keys: Array<string | null>
): PostSegment[] {
  const segments: PostSegment[] = [];
  let cursor = 0;

  // Prose either side of a skipped image belongs to one paragraph — appending
  // keeps it that way instead of introducing a paragraph break the model never
  // wrote.
  const addText = (raw: string): void => {
    if (!raw.trim()) return;
    const last = segments[segments.length - 1];
    if (last?.kind === "md") last.text += raw;
    else segments.push({ kind: "md", text: raw });
  };

  refs.forEach((ref, i) => {
    const key = keys[i];
    if (key) {
      addText(text.slice(cursor, ref.start));
      segments.push({ kind: "img", imageKey: key });
    } else {
      // Keep the failed reference inline rather than silently dropping it.
      addText(text.slice(cursor, ref.end));
    }
    cursor = ref.end;
  });

  addText(text.slice(cursor));

  // Trim only at the paragraph edges, so interior spacing survives.
  return segments.map((s) =>
    s.kind === "md" ? { kind: "md" as const, text: s.text.trim() } : s
  );
}
