/**
 * Reading Claude Code's dialogs off the pane.
 *
 * Every dialog — the model picker, a permission prompt, the trust screen, the
 * feedback form, /help — is drawn under a rule the full width of the pane, and
 * that rule is the LAST one on screen: a dialog owns everything below it. When
 * no dialog is up, the last rule is the one under the input box, and all that
 * follows is the status area.
 *
 * So the reading is: take what comes after the last full-width rule, and ask
 * whether it is a dialog or the status area. A dialog either offers options or
 * says how to leave; the status area does neither. Measured across every state
 * reachable on a real session:
 *
 *   state              last rule   options   "Esc"   verdict
 *   idle / streaming       ─          0        no     not a dialog
 *   /context               ─          0        no     not a dialog
 *   model picker           ▔          5        yes    dialog
 *   Switch model?          ▔          2        no     dialog (by options)
 *   permission prompt      ─          4        yes    dialog
 *   trust screen           ─          2        yes    dialog
 *   /help                  ▔          0        yes    dialog (by Esc)
 *   /status                ▔          0        yes    dialog (by Esc)
 *   feedback text form     ▔          0        yes    dialog (by Esc)
 *
 * Reading only the LAST rule is what keeps this simple. An earlier version
 * looked for the input box between rules, which meant recognising the rule
 * ABOVE it — and that one carries the session's title on a named session
 * (`────… Cork · Long Task Dev ────…`), so it was not recognised, the box was
 * not found, and the status area was reported to a real chat as a dialog. The
 * rule above the box is not consulted here at all.
 *
 * The rule must be exactly the pane's width, which is what keeps a transcript
 * apart from a frame: message text is indented and can never reach the edge —
 * a model asked to print 155 rule characters on a 155-wide pane put 153 on one
 * line and 2 on the next. Only the top-level layout draws edge to edge.
 */

/** The character above an overlay, and the one framing the input box. */
const OVERLAY_RULE = "▔";
const INPUT_RULE = "─";
const CURSOR = "❯";

/**
 * The key every dialog offers for leaving, and the only word this reads.
 *
 * Just the key name, not a phrase: the wording around it differs ("Esc to
 * cancel", "Enter to confirm · Esc to cancel", "Esc to cancel · Tab to
 * amend") and matching a phrase would tie cork to one of them.
 */
const LEAVE_KEY = "Esc";

export interface DialogOption {
  /** The option's text, with any numbering left in place. */
  text: string;
  /** Whether the cursor is on this one. */
  selected: boolean;
}

export interface Dialog {
  /** `overlay` floats over the conversation; `takeover` replaces the screen. */
  kind: "overlay" | "takeover";
  /** The first line of the dialog — "Select model", "Bash command". */
  title: string;
  /** Everything in the dialog that is not an option or the footer, in order. */
  body: string[];
  /**
   * The dialog exactly as drawn, dedented and with trailing blanks dropped.
   *
   * Kept verbatim because this is what a person is shown: the two columns of
   * the model picker line up on spaces, the cursor and the tick are claude's
   * own, and re-flowing any of it turns a faithful copy into cork's paraphrase.
   */
  screen: string[];
  /** Which lines of `screen` are options. */
  optionRows: number[];
  /**
   * The option list is taller than the screen, so what cork can see is not all
   * of it. claude marks this with an arrow where the cursor would be
   * (`↓ 10. Bash(git push:*)`). Numbering a partial list would invite someone
   * to choose an option they were never shown.
   */
  folded: boolean;
  options: DialogOption[];
  /** Index of the selected option, or null when nothing is selected. */
  selected: number | null;
  /** The key-hint line, when there is one. */
  footer: string;
  /**
   * Whether `/pick <n>` can answer this one.
   *
   * False covers two cases cork cannot tell apart and does not need to: a
   * dialog with nothing to choose (a text form, /help), and a list whose
   * options run past the screen. Either way the numbers cork could print
   * would not address what is being asked, so both get sent to the terminal.
   *
   * An earlier field called this `needsTyping`, which claimed more than cork
   * knows: "no options on screen" is not the same as "wants text", and
   * /permissions — a list whose cursor was parked in its search box — was
   * announced as a form to fill in.
   */
  answerable: boolean;
}

/** A line drawn edge to edge out of one character: the top of a frame. */
function isRule(line: string, width: number): boolean {
  const s = line.trim();
  if (s.length !== width || s.length === 0) return false;
  if (s[0] !== INPUT_RULE && s[0] !== OVERLAY_RULE) return false;
  return new Set(s).size === 1;
}

/**
 * The dialog on screen, or null when the session is taking input normally.
 */
export function readDialog(pane: string, width: number): Dialog | null {
  const lines = pane.split("\n").map((l) => l.replace(/\s+$/, ""));
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (isRule(lines[i], width)) last = i;
  if (last === -1) return null;

  const region = lines.slice(last + 1);
  const { options, selected, rows } = readOptions(region);
  const canLeave = region.some((l) => l.includes(LEAVE_KEY));

  // The status area offers nothing to choose and no way out, because it is not
  // asking anything. That is the whole test.
  if (options.length === 0 && !canLeave) return null;

  const taken = new Set(options.map((o) => o.text));
  const rest = region
    .filter((l) => l.trim())
    .filter((l) => !taken.has(stripCursor(l)));
  const tail = rest[rest.length - 1]?.trim() ?? "";
  const footer = tail.includes(LEAVE_KEY) ? tail : "";

  const screen = dedent(region);
  const folded = screen.some((l) => /^[↓↑]/.test(l.trim()));

  return {
    kind: lines[last].trim()[0] === OVERLAY_RULE ? "overlay" : "takeover",
    title: rest[0]?.trim() ?? "",
    body: rest.slice(1, footer ? rest.length - 1 : undefined).map((l) => l.trim()),
    screen,
    // `screen` only drops trailing blanks, so an option's index is unchanged.
    optionRows: rows.filter((i) => i < screen.length),
    folded,
    options,
    selected,
    footer,
    answerable: options.length > 0 && !folded,
  };
}

/**
 * The region with its shared left margin removed and trailing blanks dropped.
 *
 * Only the margin every line shares: the columns options line up on are
 * relative, and taking them away would break the alignment this exists to
 * keep.
 */
function dedent(region: string[]): string[] {
  let end = region.length;
  while (end > 0 && !region[end - 1].trim()) end--;
  const kept = region.slice(0, end);
  const margins = kept
    .filter((l) => l.trim())
    .map((l) => l.length - l.trimStart().length);
  const shift = margins.length ? Math.min(...margins) : 0;
  return kept.map((l) => l.slice(shift));
}

function stripCursor(line: string): string {
  return line.replace(new RegExp(`^\\s*${CURSOR}?\\s*`), "").trim();
}

/**
 * The options, found by column rather than by shape.
 *
 * Only the selected option carries a marker, and the column its text starts at
 * is the column every sibling shares — which holds whether or not the dialog
 * numbers them. Measured: the model picker and permission prompts number
 * theirs ("1. Yes"), while the trust screen and the feedback list do not
 * ("Yes, I trust this folder"), and both come out of this the same way.
 */
function readOptions(region: string[]): {
  options: DialogOption[];
  selected: number | null;
  /** Index in `region` of each option, so the screen can be shown faithfully. */
  rows: number[];
} {
  const cursor = region.findIndex((l) => l.trim().startsWith(CURSOR));
  if (cursor === -1) return { options: [], selected: null, rows: [] };

  const col = new RegExp(`^\\s*${CURSOR}\\s*`).exec(region[cursor])![0].length;

  // Walk up first: the cursor is not always on the first option.
  let start = cursor;
  while (start > 0) {
    const prev = region[start - 1];
    if (!prev.trim()) break;
    if (prev.length - prev.trimStart().length !== col) break;
    start--;
  }

  const options: DialogOption[] = [];
  const rows: number[] = [];
  let selected: number | null = null;
  for (let i = start; i < region.length; i++) {
    const line = region[i];
    if (!line.trim()) break;
    const isSel = line.trim().startsWith(CURSOR);
    const indent = line.length - line.trimStart().length;
    if (!isSel && indent !== col) {
      if (options.length) break;
      continue;
    }
    if (isSel) selected = options.length;
    options.push({ text: stripCursor(line), selected: isSel });
    rows.push(i);
  }
  return { options, selected, rows };
}

/** A short, stable description of what is on screen, for change detection. */
export function dialogSignature(d: Dialog): string {
  return [d.title, ...d.options.map((o) => o.text)].join(" | ");
}
