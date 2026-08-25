import type { Turn } from "./ir.js";

export interface LintWarning {
  turn: number; // 1-based
  message: string;
}

const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Pure, LLM-free temporal consistency lint over a generated transcript.
 *  LoCoMo's issue tracker shows annotation/time errors survive human editing
 *  for years — so anything checkable by code is checked by code.
 *
 *  Checks:
 *  1. Explicit absolute years outside the story span.
 *  2. "Weekday, Month D [YYYY]" combos whose weekday does not match the
 *     calendar. If no year is given, every year inside the span is tried;
 *     the mention is only flagged when NO plausible year matches.
 */
export function lintTranscript(
  turns: Turn[],
  spanStart: Date,
  spanEnd: Date,
): LintWarning[] {
  const warnings: LintWarning[] = [];
  const startYear = spanStart.getUTCFullYear();
  const endYear = spanEnd.getUTCFullYear();

  const yearRe = /\b((?:19|20)\d{2})\b/g;
  const dateRe =
    /\b(?:(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:\w{2})?(?:,?\s+((?:19|20)\d{2}))?/gi;

  turns.forEach((t, i) => {
    for (const m of t.text.matchAll(yearRe)) {
      const y = Number(m[1]);
      if (y < startYear - 1 || y > endYear) {
        warnings.push({
          turn: i + 1,
          message: `year ${y} is outside the story span ${startYear}–${endYear}`,
        });
      }
    }
    for (const m of t.text.matchAll(dateRe)) {
      const [, wd, mon, dayStr, yearStr] = m;
      const month = MONTHS[mon.toLowerCase()];
      const day = Number(dayStr);
      if (!wd) continue; // date without weekday — nothing to cross-check
      const claimed = WEEKDAYS.indexOf(wd.toLowerCase());
      const years = yearStr
        ? [Number(yearStr)]
        : Array.from({ length: endYear - startYear + 1 }, (_, k) => startYear + k);
      const anyMatch = years.some((y) => weekdayOf(y, month, day) === claimed);
      if (!anyMatch) {
        warnings.push({
          turn: i + 1,
          message: `"${m[0]}" — weekday does not match the calendar for any plausible year in span`,
        });
      }
    }
  });
  return warnings;
}
