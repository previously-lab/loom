import type { DatedEvent, DatedTurn, StoryEvent, Turn } from "./ir.js";

/** Deterministic RNG (mulberry32) so scheduling is reproducible under a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// ---------------------------------------------------------------------------
// Timezone handling. All scheduling happens in the PERSONA's local timezone;
// the Date objects we carry are absolute UTC instants. Conversion uses Intl
// (full ICU in modern Node), no external dependency.
// ---------------------------------------------------------------------------

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

const partFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partFormatterCache.set(timeZone, f);
  }
  return f;
}

export function localParts(d: Date, timeZone: string): LocalParts {
  const p = Object.fromEntries(
    partFormatter(timeZone)
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

/** Interpret a wall-clock time in `timeZone` and return the UTC instant. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const p = localParts(new Date(guess), timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return new Date(guess - (asIfUtc - guess));
}

export function parseLocalDate(iso: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Invalid date: ${iso}`);
  return zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, timeZone);
}

// ---------------------------------------------------------------------------
// Scheduling. The model never writes dates; code owns the calendar.
// ---------------------------------------------------------------------------

/** Assign absolute dates to story events in the persona's local timezone. */
export function assignEventDates(
  events: StoryEvent[],
  startDate: string,
  timeZone: string,
): DatedEvent[] {
  const base = parseLocalDate(startDate, timeZone);
  return events.map((e) => ({
    ...e,
    date: new Date(base.getTime() + e.dayOffset * DAY),
  }));
}

/** Schedule a session shortly after its latest triggering event (LoCoMo-style),
 *  at a plausible LOCAL daytime hour (09:00–20:59 persona time). */
export function scheduleSession(
  events: DatedEvent[],
  rng: () => number,
  timeZone: string,
): Date {
  if (events.length === 0) throw new Error("Cannot schedule a session with no events");
  const latest = events.reduce((a, b) => (a.date > b.date ? a : b)).date;
  const dayJitter = Math.floor(rng() * 2); // 0 or 1 day after the event
  const hour = 9 + Math.floor(rng() * 12); // 09:00–20:xx local
  const minute = Math.floor(rng() * 60);
  const anchor = new Date(latest.getTime() + dayJitter * DAY);
  const p = localParts(anchor, timeZone);
  return zonedTimeToUtc(p.year, p.month, p.day, hour, minute, timeZone);
}

/** Spread turn timestamps across a slice window (default 30 min, mirroring
 *  Previously's maxSliceMinutes). Gaps are 1–4 minutes; if they would overflow
 *  the window they are compressed proportionally. */
export function turnTimestamps(
  sessionStart: Date,
  turnCount: number,
  rng: () => number,
  windowMinutes = 30,
): Date[] {
  if (turnCount < 1) throw new Error("turnCount must be >= 1");
  const raw = Array.from({ length: turnCount }, () => 1 + Math.floor(rng() * 4));
  const total = raw.reduce((a, b) => a + b, 0);
  const scale = total > windowMinutes ? windowMinutes / total : 1;
  const out: Date[] = [];
  let acc = 0;
  for (const gap of raw) {
    out.push(new Date(sessionStart.getTime() + acc * MINUTE));
    acc += gap * scale;
  }
  return out;
}

export function attachTimestamps(turns: Turn[], at: Date[]): DatedTurn[] {
  if (turns.length !== at.length) {
    throw new Error(`turns (${turns.length}) and timestamps (${at.length}) length mismatch`);
  }
  return turns.map((t, i) => ({ ...t, at: at[i] }));
}

// ---------------------------------------------------------------------------
// Formatting — always in the persona's local timezone.
// ---------------------------------------------------------------------------

function zonedFormatter(timeZone: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", { timeZone, ...opts });
}

/** "Saturday, 15 March 2025" — given to the model so it never invents dates. */
export function formatHumanDate(d: Date, timeZone: string): string {
  const f = zonedFormatter(timeZone, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  // en-US renders "Saturday, March 15, 2025"; normalize to "Saturday, 15 March 2025".
  const parts = Object.fromEntries(
    f.formatToParts(d).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}`;
}

/** "14:32" local time. */
export function formatHumanTime(d: Date, timeZone: string): string {
  return zonedFormatter(timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** Slice id + directory fragment in LOCAL time, e.g. 20250315-1432. */
export function sliceId(d: Date, timeZone: string): string {
  const p = localParts(d, timeZone);
  const mm = String(p.minute).padStart(2, "0");
  return `${p.year}${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}-${String(p.hour).padStart(2, "0")}${mm}`;
}
