// Datetime formatting helpers. The tables app returns SQLite TIMESTAMP
// values like "2026-05-13 06:22:28" (no timezone marker — UTC by
// convention). We coerce to a Date, then render two views: relative
// ("3 minutes ago") for "when did this happen" and absolute compact
// ("May 13, 06:22") for "exactly when."

const REL_UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.345, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function parseDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string") return null;
  // SQLite "YYYY-MM-DD HH:MM:SS" is missing the timezone — treat as UTC.
  const iso = v.includes("T") ? v : v.replace(" ", "T") + (v.endsWith("Z") ? "" : "Z");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function relativeTime(v: unknown, now: Date = new Date()): string {
  const d = parseDate(v);
  if (!d) return "";
  let diff = (d.getTime() - now.getTime()) / 1000;
  for (const [step, unit] of REL_UNITS) {
    if (Math.abs(diff) < step) return rtf.format(Math.round(diff), unit);
    diff /= step;
  }
  return "";
}

const dtFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDateTime(v: unknown): string {
  const d = parseDate(v);
  return d ? dtFormatter.format(d) : "";
}
