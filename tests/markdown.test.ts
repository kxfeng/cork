import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scanCodeRanges,
  extractImageRefs,
  buildSegments,
} from "../src/channels/lark/markdown.js";
import {
  buildPostContent,
  buildPostContentFromSegments,
  injectAtMentions,
} from "../src/channels/lark/card.js";

/**
 * Image references decide what gets uploaded and sent, so the risk here is
 * two-sided: missing a real image loses content, but grabbing an illustrative
 * one posts a file the model never meant to send.
 */
let dir: string;
let img: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-md-"));
  img = path.join(dir, "chart.png");
  fs.writeFileSync(img, "not really a png");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scanCodeRanges", () => {
  it("covers fenced blocks", () => {
    const text = "before\n```\ncode\n```\nafter";
    const [range] = scanCodeRanges(text);
    expect(text.slice(range[0], range[1])).toContain("code");
  });

  it("covers an unterminated fence to the end", () => {
    const text = "before\n```\ncode never closed";
    const [range] = scanCodeRanges(text);
    expect(range[1]).toBe(text.length);
  });

  it("covers inline code", () => {
    const text = "use `npm test` now";
    const ranges = scanCodeRanges(text);
    expect(ranges.some(([s, e]) => text.slice(s, e) === "`npm test`")).toBe(true);
  });
});

describe("extractImageRefs", () => {
  it("finds a real local image", () => {
    const refs = extractImageRefs(`see ![](${img}) here`);
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe(img);
  });

  it("keeps document order for several images", () => {
    const b = path.join(dir, "b.png");
    fs.writeFileSync(b, "x");
    const refs = extractImageRefs(`![](${img}) then ![](${b})`);
    expect(refs.map((r) => r.path)).toEqual([img, b]);
  });

  it("ignores a reference inside a fenced block", () => {
    expect(extractImageRefs("```\n![](" + img + ")\n```")).toHaveLength(0);
  });

  it("ignores a reference inside inline code", () => {
    expect(extractImageRefs("write `![](" + img + ")` to embed")).toHaveLength(0);
  });

  it("ignores a remote URL", () => {
    expect(extractImageRefs("![](https://example.com/a.png)")).toHaveLength(0);
  });

  it("ignores a path that does not exist", () => {
    expect(extractImageRefs("![](/nope/missing.png)")).toHaveLength(0);
  });

  it("ignores a directory", () => {
    expect(extractImageRefs(`![](${dir})`)).toHaveLength(0);
  });

  it("handles a path wrapped in angle brackets", () => {
    const spaced = path.join(dir, "my chart.png");
    fs.writeFileSync(spaced, "x");
    const refs = extractImageRefs(`![](<${spaced}>)`);
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe(spaced);
  });

  it("does not treat a plain link as an image", () => {
    expect(extractImageRefs(`[report](${img})`)).toHaveLength(0);
  });
});

describe("buildSegments", () => {
  it("interleaves prose and images in order", () => {
    const text = `before ![](${img}) after`;
    const refs = extractImageRefs(text);
    const segs = buildSegments(text, refs, ["img_key_1"]);
    expect(segs).toEqual([
      { kind: "md", text: "before" },
      { kind: "img", imageKey: "img_key_1" },
      { kind: "md", text: "after" },
    ]);
  });

  it("merges prose either side of a skipped image into one paragraph", () => {
    // A failed upload must not introduce a paragraph break the model never
    // wrote — the text around it is still one paragraph.
    const b = path.join(dir, "b.png");
    fs.writeFileSync(b, "x");
    const text = `see ![](${img}) and ![](${b}) end`;
    const refs = extractImageRefs(text);
    const segs = buildSegments(text, refs, ["key_1", null]);
    expect(segs).toHaveLength(3);
    expect(segs[1]).toEqual({ kind: "img", imageKey: "key_1" });
    expect((segs[2] as { text: string }).text).toBe(`and ![](${b}) end`);
  });

  it("keeps the markdown token when the upload failed", () => {
    const text = `look ![](${img}) ok`;
    const refs = extractImageRefs(text);
    const segs = buildSegments(text, refs, [null]);
    expect(segs.every((s) => s.kind === "md")).toBe(true);
    expect(segs.map((s) => (s as { text: string }).text).join(" ")).toContain(img);
  });
});

describe("buildPostContentFromSegments", () => {
  it("gives each image its own paragraph", () => {
    const json = JSON.parse(
      buildPostContentFromSegments([
        { kind: "md", text: "hello" },
        { kind: "img", imageKey: "img_1" },
      ])
    );
    expect(json.zh_cn.content).toEqual([
      [{ tag: "md", text: "hello" }],
      [{ tag: "img", image_key: "img_1" }],
    ]);
  });
});

describe("fileTypeFor", () => {
  it("maps document extensions to their Lark type", async () => {
    const { fileTypeFor } = await import("../src/channels/lark/client.js");
    expect(fileTypeFor("/a/report.pdf")).toBe("pdf");
    expect(fileTypeFor("/a/notes.DOCX")).toBe("doc"); // case-insensitive
    expect(fileTypeFor("/a/data.xlsx")).toBe("xls");
    expect(fileTypeFor("/a/deck.ppt")).toBe("ppt");
  });

  it("falls back to stream for anything else", async () => {
    const { fileTypeFor } = await import("../src/channels/lark/client.js");
    // Video/audio deliberately included: sending them as a plain file always
    // works, whereas `mp4` would additionally require a cover image.
    expect(fileTypeFor("/a/clip.mp4")).toBe("stream");
    expect(fileTypeFor("/a/voice.opus")).toBe("stream");
    expect(fileTypeFor("/a/archive.zip")).toBe("stream");
    expect(fileTypeFor("/a/README")).toBe("stream"); // no extension
  });
});

describe("extractImageRefs — path safety", () => {
  it("ignores a relative path", () => {
    // The daemon's cwd is "/" under launchd, not the session workspace, so a
    // relative path cannot be resolved meaningfully — and might match something
    // unrelated. Left as text instead.
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      expect(extractImageRefs("![](chart.png)")).toHaveLength(0);
      expect(extractImageRefs("![](./chart.png)")).toHaveLength(0);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("scanImages — skip diagnostics", () => {
  it("reports why each reference was not sent", async () => {
    const { scanImages } = await import("../src/channels/lark/markdown.js");
    const text = [
      `![](${img})`,                       // sent
      "![](https://example.com/a.png)",    // remote
      "![](chart.png)",                    // relative
      "![](/nope/gone.png)",               // missing
      "```\n![](/also/ignored.png)\n```",  // in code → not reported at all
    ].join("\n");

    const { refs, skipped } = scanImages(text);
    expect(refs.map((r) => r.path)).toEqual([img]);
    expect(skipped.map((s) => ({ path: s.path, reason: s.reason }))).toEqual([
      { path: "https://example.com/a.png", reason: "remote" },
      { path: "chart.png", reason: "relative" },
      { path: "/nope/gone.png", reason: "missing" },
    ]);
    // Positions are recorded so the reference can be escaped in place.
    expect(skipped.every((s) => s.end > s.start)).toBe(true);
  });
});

describe("escapeSkipped", () => {
  it("wraps skipped references so Lark renders them as text", async () => {
    const { scanImages, escapeSkipped } = await import(
      "../src/channels/lark/markdown.js"
    );
    // Lark parses the md element itself, turning an un-uploaded `![](x)` into
    // "<Image data error>". Backticks are the one form it leaves alone.
    const text = "rel ![](chart.png) and missing ![](/nope/x.png) done";
    const escaped = escapeSkipped(text, scanImages(text));
    expect(escaped).toBe(
      "rel `![](chart.png)` and missing `![](/nope/x.png)` done"
    );

    // Rescanning the escaped text finds nothing — they are inline code now.
    expect(scanImages(escaped).skipped).toEqual([]);
  });

  it("leaves a real image untouched", async () => {
    const { scanImages, escapeSkipped } = await import(
      "../src/channels/lark/markdown.js"
    );
    const text = `ok ![](${img}) done`;
    expect(escapeSkipped(text, scanImages(text))).toBe(text);
  });
});

describe("injectAtMentions", () => {
  it("prepends at elements to the first paragraph", () => {
    const base = buildPostContent("hello");
    const out = JSON.parse(injectAtMentions(base, ["ou_1", "ou_2"]));
    expect(out.zh_cn.content[0]).toEqual([
      { tag: "at", user_id: "ou_1" },
      { tag: "at", user_id: "ou_2" },
      { tag: "text", text: " " },
      { tag: "md", text: "hello" },
    ]);
  });

  it("returns the post unchanged when there are no mentions", () => {
    const base = buildPostContent("hi");
    expect(injectAtMentions(base, [])).toBe(base);
  });

  it("keeps the message when the post structure is unexpected", () => {
    // A mention is a courtesy; malformed input must cost the @mention, never the
    // message. Same best-effort contract as the image and attachment paths.
    for (const bad of ['{"not":"a post"}', "not json at all", "{}"]) {
      expect(() => injectAtMentions(bad, ["ou_1"])).not.toThrow();
      expect(injectAtMentions(bad, ["ou_1"])).toBe(bad);
    }
  });
});
