/**
 * Reading and driving Claude Code's model picker from the pane text.
 *
 * Switching a session's model without touching the machine-wide default is
 * only possible through the interactive picker: `/model <name>` typed as one
 * command "behaves like Enter" and writes the `model` field into user
 * settings, which would move every NEW claude on this machine — measured, and
 * documented at code.claude.com/docs/en/model-config. The picker's `s` key is
 * the session-only path, and it leaves the settings file byte-identical.
 *
 * So cork types `/model`, reads the picker off the screen, walks the cursor to
 * the row the user asked for, and presses `s`. Everything here is the reading
 * half: pure functions over captured text, so the rules can be tested without
 * a terminal.
 *
 * Nothing here guesses. A request that matches no row, or more than one, comes
 * back as a refusal — the list changes with entitlements and with every new
 * model, and picking "the closest one" would silently put a session on a model
 * nobody asked for. The refusal names the rows a name did reach, so the caller
 * can print the list claude drew and take a number back.
 */

import { readDialog, type Dialog } from "./dialog.js";

/** One line of the picker: `  3. Fable    Fable 5.1 · Most capable for …`. */
export interface PickerRow {
  /** The number claude prints, 1-based. Not used for navigation. */
  n: number;
  /** The left column: "Fable", "Opus (1M context)", "Default (recommended)". */
  label: string;
  /** The right column, in full. */
  description: string;
  /** The concrete model, i.e. the description up to its first "·". */
  modelName: string;
  /** Whether claude marked this row as the one in use (a "✔"). */
  current: boolean;
}

export interface PickerView {
  rows: PickerRow[];
  /** Index into `rows` of the highlighted one. */
  cursor: number;
}

/**
 * The picker's own footer. The generic reader says a dialog is up; this says
 * the dialog is the model picker rather than something else that appeared
 * while cork was typing. Both halves are required: "Esc to cancel" alone
 * appears under every dialog claude draws.
 */
const PICKER_FOOTER = /Enter to set as default.*s to use this session only/;

/**
 * The picker as it stands on screen, or null when the pane is not showing one.
 *
 * The frame, the options and the cursor come from `readDialog`, which knows
 * nothing about models — the only thing added here is splitting each option
 * into the two columns claude prints and recognising the tick on the row in
 * use.
 */
export function parseModelPicker(pane: string, width: number): PickerView | null {
  const d = readDialog(pane, width);
  if (!d || !PICKER_FOOTER.test(d.footer) || d.selected === null) return null;
  if (d.options.length === 0) return null;

  const rows: PickerRow[] = d.options.map((o, i) => {
    const m = /^(\d+)\.\s+(.*)$/.exec(o.text);
    const rest = m ? m[2] : o.text;
    const split = rest.search(/\s{2,}/);
    const labelRaw = (split === -1 ? rest : rest.slice(0, split)).trim();
    const description = split === -1 ? "" : rest.slice(split).trim();
    return {
      n: m ? Number(m[1]) : i + 1,
      label: labelRaw.replace("✔", "").trim(),
      description,
      modelName: description.split("·")[0].trim(),
      current: labelRaw.includes("✔"),
    };
  });

  return { rows, cursor: d.selected };
}

export type Choice =
  | { ok: true; index: number; row: PickerRow }
  | { ok: false; reason: string; matched: number[] };

/**
 * The rows as a person reads them, one per line, numbered as claude numbered
 * them and ticked where claude ticked.
 *
 *     1  Default (recommended)  Opus 5.5 with 1M context
 *   ✔ 6  Opus 5 (1M context)    Newer version available
 *
 * Both columns are kept because neither is enough on its own: claude names the
 * NEW Opus `Opus (1M context)` with no version in it, and puts "5.5" only in
 * the right column — while the OLD one is the row that reads `Opus 5`. A list
 * of labels alone would invite picking exactly the wrong one.
 *
 * The label column is padded to the widest label so the two columns line up,
 * the same way they do on claude's own screen.
 */
export function formatPickerRows(rows: PickerRow[]): string {
  const nWidth = Math.max(...rows.map((r) => String(r.n).length), 1);
  const labelWidth = Math.max(...rows.map((r) => r.label.length), 1);
  return rows
    .map((r) => {
      const tick = r.current ? "✔" : " ";
      const n = String(r.n).padStart(nWidth);
      const label = r.modelName ? r.label.padEnd(labelWidth) : r.label;
      return `${tick} ${n}  ${label}${r.modelName ? `  ${r.modelName}` : ""}`;
    })
    .join("\n");
}

/** "2", "2 and 6", "2, 5 and 6" — the numbers as a sentence names them. */
function listNumbers(ns: number[]): string {
  if (ns.length <= 1) return String(ns[0] ?? "");
  return `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;
}

const norm = (s: string) => s.trim().toLowerCase();
const firstWord = (s: string) => norm(s).split(/[\s(]/)[0];

/**
 * Which row the user meant.
 *
 * A plain number is claude's own row number, answering the list cork printed.
 * Everything else is a name, and matching runs widest-last so an exact name
 * always beats a family word:
 * "Opus" and "Opus (1M context)" can both be on screen, and only the exact
 * label separates them. A family word matching both is an ambiguity, and an
 * ambiguity is reported, never resolved by position.
 *
 * The "Default" row is reachable only by asking for it by name. It is not a
 * model — it follows whatever the settings file says — so a request for a
 * family must never land on it even when it happens to render that family.
 */
export function chooseModelRow(rows: PickerRow[], requested: string): Choice {
  const want = norm(requested);
  if (!want) {
    return { ok: false, reason: "no model given", matched: [] };
  }

  // A number addresses the row claude itself numbered, which is how someone
  // answers the list cork just showed them. It reaches Default too: the list
  // showed that row, so refusing to select it would be refusing what was
  // offered. A name still must not land there — see below.
  if (/^\d+$/.test(want)) {
    const n = Number(want);
    const i = rows.findIndex((r) => r.n === n);
    if (i === -1) return { ok: false, reason: `there is no option ${n} here`, matched: [] };
    return { ok: true, index: i, row: rows[i] };
  }

  const isDefaultRow = (r: PickerRow) => firstWord(r.label) === "default";
  const pool = want === "default" ? rows : rows.filter((r) => !isDefaultRow(r));

  const tries: ((r: PickerRow) => boolean)[] = [
    (r) => norm(r.label) === want,
    (r) => norm(r.modelName) === want,
    (r) => firstWord(r.label) === want,
  ];

  for (const match of tries) {
    const hits = pool.filter(match);
    if (hits.length === 1) {
      return { ok: true, index: rows.indexOf(hits[0]), row: hits[0] };
    }
    if (hits.length > 1) {
      const ns = hits.map((r) => r.n);
      return {
        ok: false,
        reason: `"${requested}" matches ${listNumbers(ns)}`,
        matched: ns,
      };
    }
  }

  return {
    ok: false,
    reason: `no model here is called "${requested}"`,
    matched: [],
  };
}

/**
 * The index of the "Yes" option on the "Switch model?" confirmation, or null.
 *
 * It is raised when the conversation is cached against the model being left,
 * and it does NOT appear every time: claude remembers that the cost was
 * acknowledged and skips it for a while (measured — a second switch moments
 * later went straight through). So this is something to look for, never
 * something to wait on.
 *
 * An index rather than a key, because the answer is given the way every other
 * dialog is answered: walk the cursor there and press Enter. Some dialogs
 * claude draws do not number their options at all, so there is not always a
 * digit to press.
 */
export function switchConfirmYes(pane: string, width: number): number | null {
  const d = readDialog(pane, width);
  if (!d || !/^Switch model\?/.test(d.title)) return null;
  const i = d.options.findIndex((o) => /^(?:\d+\.\s*)?Yes\b/.test(o.text));
  return i === -1 ? null : i;
}

/** What claude printed under a `/model`: it switched, or it did not. */
export interface ModelNotice {
  kind: "set" | "kept";
  /** claude's own name for the model, taken whole. */
  model: string;
  /** The line as it was drawn, for telling a fresh notice from an old one. */
  line: string;
}

/**
 * claude's own word on what a `/model` did — the last one on the pane.
 *
 * Measured shapes, all three under the `⎿` claude draws for a command's
 * result:
 *
 *   ⎿  Set model to Fable 5.1 for this session only
 *   ⎿  Set model to Opus 5 (1M context) (default) for this session only
 *   ⎿  Kept model as Opus 5 (1M context)
 *
 * The name is taken whole, brackets and all, because it is claude's own label
 * and cork has no better one.
 *
 * This is read instead of the status line. The status line belongs to the
 * user — it is theirs to customise, and an earlier version that keyed on
 * "<model> | Context:" would have failed to confirm any switch the moment
 * they changed it. The `⎿` anchor also keeps prose out: this very sentence,
 * drawn in the transcript above, is not a result line.
 */
export function lastModelNotice(pane: string): ModelNotice | null {
  let found: ModelNotice | null = null;
  for (const raw of pane.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("\u23BF")) continue;
    let m = /Set model to (.+?) for this session only$/.exec(line);
    if (m) {
      found = { kind: "set", model: m[1].trim(), line };
      continue;
    }
    m = /Kept model as (.+?)$/.exec(line);
    if (m) found = { kind: "kept", model: m[1].trim(), line };
  }
  return found;
}
