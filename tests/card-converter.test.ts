import { describe, it, expect } from "vitest";
import {
  convertCard,
  extractCardImageKeys,
} from "../src/channels/lark/card-converter.js";

// Build a raw_card_content envelope: json_card is a stringified card,
// json_attachment is an already-parsed object (matching the real API shape).
function envelope(card: unknown, attachment?: unknown): string {
  return JSON.stringify({
    json_card: JSON.stringify(card),
    json_attachment: attachment,
    card_schema: 1,
  });
}

describe("convertCard", () => {
  it("renders the header title into a <card> wrapper", () => {
    const out = convertCard(
      envelope({
        header: { title: { tag: "plain_text", content: "Test Alarm" } },
        body: { elements: [{ tag: "markdown", content: "service down" }] },
      })
    );
    expect(out.startsWith('<card title="Test Alarm">')).toBe(true);
    expect(out).toContain("service down");
    expect(out.trimEnd().endsWith("</card>")).toBe(true);
  });

  it("extracts text from div, note, column_set, action and hr", () => {
    const out = convertCard(
      envelope({
        body: {
          elements: [
            { tag: "div", text: { tag: "plain_text", content: "Status: critical" } },
            { tag: "hr" },
            { tag: "note", elements: [{ tag: "plain_text", content: "a footnote" }] },
            {
              tag: "column_set",
              columns: [
                { tag: "column", elements: [{ tag: "plain_text", content: "left" }] },
                { tag: "column", elements: [{ tag: "plain_text", content: "right" }] },
              ],
            },
            {
              tag: "action",
              actions: [{ tag: "button", text: { tag: "plain_text", content: "Ack" } }],
            },
          ],
        },
      })
    );
    expect(out).toContain("Status: critical");
    expect(out).toContain("---"); // hr
    expect(out).toContain("a footnote");
    expect(out).toContain("left");
    expect(out).toContain("right");
    expect(out).toContain("[Ack]"); // button
  });

  it("falls back gracefully for unknown element tags", () => {
    const out = convertCard(
      envelope({
        body: {
          elements: [{ tag: "some_future_tag", content: "still readable" }],
        },
      })
    );
    expect(out).toContain("still readable");
  });

  it("returns a placeholder for unparseable content", () => {
    expect(convertCard("not json")).toBe("(card message)");
    expect(convertCard("{}")).toBe("(card message)");
  });

  it("handles a degraded (non-envelope) card via the legacy path", () => {
    const out = convertCard(
      JSON.stringify({
        header: { title: { content: "Legacy Card" } },
        body: { elements: [{ tag: "markdown", content: "legacy body" }] },
      })
    );
    expect(out).toContain("Legacy Card");
    expect(out).toContain("legacy body");
  });
});

describe("extractCardImageKeys", () => {
  it("resolves imageID references through json_attachment.images", () => {
    const keys = extractCardImageKeys(
      envelope(
        {
          body: {
            elements: [{ tag: "img", property: { imageID: "57" } }],
          },
        },
        { images: { "57": { origin_key: "img_v3_real_key" } } }
      )
    );
    expect(keys).toEqual(["img_v3_real_key"]);
  });

  it("keeps already-real img keys and drops unresolved numeric refs", () => {
    const keys = extractCardImageKeys(
      envelope({
        body: {
          elements: [
            { tag: "img", property: { imageID: "img_v3_direct" } },
            { tag: "img", property: { imageID: "999" } },
          ],
        },
      })
    );
    expect(keys).toEqual(["img_v3_direct"]);
  });

  it("returns an empty list when there are no images", () => {
    expect(
      extractCardImageKeys(
        envelope({ body: { elements: [{ tag: "markdown", content: "x" }] } })
      )
    ).toEqual([]);
  });
});
