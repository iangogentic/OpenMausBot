export interface ZonedDailySchedule {
  time: string;
  weekdays: number[];
  timeZone: string;
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DAY_MS = 86_400_000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  // Bound user-controlled timezone cache growth while retaining the common
  // case where every routine uses the controller's one zone.
  if (formatterCache.size >= 128) formatterCache.clear();
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, created);
  return created;
}

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function normalizeTimeZone(value: unknown, fallback = systemTimeZone()): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || candidate.length > 100) return fallback;
  try {
    formatter(candidate).format(0);
    return candidate;
  } catch {
    throw new Error("Choose a valid IANA timezone");
  }
}

export function zonedDateParts(at: number, timeZone: string): ZonedDateParts {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(at))) {
    if (part.type === "literal" || part.type === "timeZoneName") continue;
    const numeric = Number(part.value);
    if (Number.isFinite(numeric)) values[part.type] = numeric;
  }
  const year = values.year;
  const month = values.month;
  const day = values.day;
  const hour = values.hour;
  const minute = values.minute;
  if ([year, month, day, hour, minute].some((value) => !Number.isInteger(value))) {
    throw new Error("Could not resolve timezone calendar fields");
  }
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute! };
}

function sameMinute(parts: ZonedDateParts, year: number, month: number, day: number, hour: number, minute: number) {
  return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute;
}

/** Resolve one wall-clock minute without inheriting the server process zone.
 * A DST gap has no result. A repeated fall-back minute resolves to its first
 * occurrence, so a daily routine still runs once rather than twice. */
export function zonedWallClockInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsets = new Set<number>();
  for (const deltaHours of [-36, -12, 0, 12, 36]) {
    const probe = desiredUtc + deltaHours * 60 * 60_000;
    const parts = zonedDateParts(probe, timeZone);
    const roundedProbe = Math.floor(probe / 60_000) * 60_000;
    offsets.add(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - roundedProbe);
  }
  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = desiredUtc - offset;
    if (sameMinute(zonedDateParts(candidate, timeZone), year, month, day, hour, minute)) {
      matches.push(candidate);
    }
  }
  return matches.length ? Math.min(...matches) : null;
}

export function nextZonedDailyOccurrence(schedule: ZonedDailySchedule, after: number): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.time);
  if (!match) throw new Error("Time must use HH:MM");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const timeZone = normalizeTimeZone(schedule.timeZone);
  const weekdays = new Set(schedule.weekdays);
  const current = zonedDateParts(after, timeZone);
  const calendarStart = Date.UTC(current.year, current.month - 1, current.day);
  for (let offset = 0; offset <= 8; offset += 1) {
    const calendar = new Date(calendarStart + offset * DAY_MS);
    if (!weekdays.has(calendar.getUTCDay())) continue;
    const candidate = zonedWallClockInstant(
      calendar.getUTCFullYear(),
      calendar.getUTCMonth() + 1,
      calendar.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
    if (candidate !== null && candidate > after) return candidate;
  }
  return null;
}

export function zonedDailyOccurrences(
  schedule: ZonedDailySchedule,
  from: number,
  to: number,
  limit = 400,
): number[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const out: number[] = [];
  let cursor = from - 1;
  while (out.length < limit) {
    const next = nextZonedDailyOccurrence(schedule, cursor);
    if (next === null || next >= to) break;
    if (next >= from) out.push(next);
    cursor = next + 1;
  }
  return out;
}
