import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The composer's send() is inline script in the page, tied to the DOM and a live
 * socket, so this reads the source rather than running it. What it guards is the
 * byte shape that reaches the pane, which is the whole fix: bare text followed
 * at once by "\r" lets Claude Code swallow the Enter into what it takes for a
 * paste, and a long multi-line message then sits in the prompt unsent.
 */
const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/web/public/index.html"),
  "utf-8"
);

function sendBody(): string {
  const start = html.indexOf("function send()");
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("\n      }\n", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("web composer send", () => {
  it("wraps the text in bracketed paste markers when the pane has turned them on", () => {
    const body = sendBody();
    expect(body).toMatch(/term\.modes\.bracketedPasteMode\s*\?\s*"\\x1b\[200~" \+ text \+ "\\x1b\[201~"\s*:\s*text/);
  });

  it("submits with a carriage return sent after a delay, not in the same burst", () => {
    const body = sendBody();
    const textSend = body.indexOf('type: "input", data }');
    const timer = body.indexOf("setTimeout(");
    const enter = body.indexOf('data: "\\r"');
    expect(textSend).toBeGreaterThan(-1);
    expect(timer).toBeGreaterThan(textSend);
    expect(enter).toBeGreaterThan(timer);
    expect(body).toMatch(/},\s*SUBMIT_DELAY_MS\);/);
    expect(html).toMatch(/const SUBMIT_DELAY_MS = \d+;/);
  });

  it("sends the Enter to the socket the text went to", () => {
    const body = sendBody();
    expect(body).toContain("const sock = ws;");
    expect(body).toMatch(/sock\.readyState === 1\) sock\.send\(JSON\.stringify\(\{ type: "input", data: "\\r" \}\)\)/);
  });
});
