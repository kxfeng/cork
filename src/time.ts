import { loadConfig } from "./config/loader.js";

/**
 * Times, in the zone the person reading them is in.
 *
 * Everything cork stores is UTC, which is right for a record and wrong for a
 * person: a daemon on a server is usually not in the reader's zone — this one
 * runs in UTC while its user is in UTC+8 — so a stored timestamp shown raw is
 * off by hours with nothing to say so. Configured once (`timezone` in
 * config.jsonc), used everywhere a time is shown or put in a name.
 */

/**
 * Resolved once. Changing the zone means editing the config, which means
 * restarting the daemon — the same as every other setting here.
 */
let cached: string | undefined;

export function displayZone(): string {
  if (cached === undefined) cached = loadConfig().timezone?.trim() || machineZone();
  return cached;
}

/** Test seam: forget the resolved zone so the next call reads config again. */
export function resetZoneCache(): void {
  cached = undefined;
}

function machineZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The zone's parts for an instant, or null when the zone name is not real. */
function parts(at: Date, zone: string): Record<string, string> | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  } catch {
    return null; // a zone name the platform does not know
  }
}

/** "2026-09-05 17:45" — to the minute, which is all anyone asked for. */
export function readableTime(at: Date, zone = displayZone()): string {
  const p = parts(at, zone);
  if (!p) return at.toISOString().slice(0, 16).replace("T", " ");
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "20260905-174525" — sorts as time, and is safe in a file name. */
export function stampTime(at: Date, zone = displayZone()): string {
  const p = parts(at, zone);
  if (!p) return at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

/**
 * "UTC+8" — derived from the zone rather than configured alongside it, so it
 * stays right across a daylight-saving boundary.
 */
export function zoneLabel(at: Date, zone = displayZone()): string {
  let name: string | undefined;
  try {
    name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
  } catch {
    return "UTC";
  }
  // "GMT+08:00" → "UTC+8", "GMT+05:30" → "UTC+5:30", "GMT" → "UTC"
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
  if (!m) return "UTC";
  return `UTC${m[1]}${Number(m[2])}${m[3] === "00" ? "" : `:${m[3]}`}`;
}
