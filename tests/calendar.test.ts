import { describe, expect, it } from "vitest";
import {
  assignEventDates,
  attachTimestamps,
  formatHumanDate,
  localParts,
  mulberry32,
  scheduleSession,
  sliceId,
  turnTimestamps,
  zonedTimeToUtc,
} from "../src/core/calendar.js";
import type { StoryEvent } from "../src/core/ir.js";

const UTC = "UTC";
const SHANGHAI = "Asia/Shanghai"; // UTC+8, no DST

const ev = (id: string, dayOffset: number, causedBy: string[] = []): StoryEvent => ({
  id,
  dayOffset,
  title: `Event ${id}`,
  detail: `Detail of ${id}`,
  causedBy,
});

describe("zonedTimeToUtc / localParts", () => {
  it("converts Shanghai wall-clock time to the correct UTC instant", () => {
    const d = zonedTimeToUtc(2025, 3, 15, 14, 32, SHANGHAI);
    expect(d.toISOString()).toBe("2025-03-15T06:32:00.000Z");
  });

  it("round-trips through localParts", () => {
    const d = zonedTimeToUtc(2025, 12, 31, 23, 59, SHANGHAI);
    const p = localParts(d, SHANGHAI);
    expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2025, 12, 31, 23, 59]);
  });
});

describe("assignEventDates", () => {
  it("anchors day 0 at LOCAL midnight of the persona timezone", () => {
    const dated = assignEventDates([ev("a", 0), ev("b", 10)], "2025-03-01", SHANGHAI);
    expect(dated[0].date.toISOString()).toBe("2025-02-28T16:00:00.000Z");
    expect(localParts(dated[1].date, SHANGHAI).day).toBe(11);
  });

  it("rejects malformed start dates", () => {
    expect(() => assignEventDates([ev("a", 0)], "not-a-date", UTC)).toThrow();
  });
});

describe("scheduleSession", () => {
  it("is deterministic under a fixed seed", () => {
    const dated = assignEventDates([ev("a", 0), ev("b", 10)], "2025-03-01", SHANGHAI);
    const s1 = scheduleSession(dated, mulberry32(42), SHANGHAI);
    const s2 = scheduleSession(dated, mulberry32(42), SHANGHAI);
    expect(s1.getTime()).toBe(s2.getTime());
  });

  it("schedules at plausible LOCAL daytime hours, never UTC day hours that are local night", () => {
    const dated = assignEventDates([ev("a", 0), ev("b", 10)], "2025-03-01", SHANGHAI);
    for (let seed = 0; seed < 100; seed++) {
      const s = scheduleSession(dated, mulberry32(seed), SHANGHAI);
      const p = localParts(s, SHANGHAI);
      expect(p.hour).toBeGreaterThanOrEqual(9);
      expect(p.hour).toBeLessThan(21);
      // local date must be on/after the latest event's local date (Mar 11)
      expect(s.getTime()).toBeGreaterThanOrEqual(dated[1].date.getTime());
      expect(s.getTime()).toBeLessThan(dated[1].date.getTime() + 2 * 86_400_000);
    }
  });

  it("refuses to schedule a session with no events", () => {
    expect(() => scheduleSession([], mulberry32(1), UTC)).toThrow();
  });
});

describe("turnTimestamps", () => {
  it("produces monotonically increasing timestamps inside the 30-minute window", () => {
    const start = new Date("2025-03-15T14:00:00Z");
    const at = turnTimestamps(start, 12, mulberry32(7));
    expect(at).toHaveLength(12);
    expect(at[0].getTime()).toBe(start.getTime());
    for (let i = 1; i < at.length; i++) {
      expect(at[i].getTime()).toBeGreaterThan(at[i - 1].getTime());
    }
    expect(at[11].getTime()).toBeLessThanOrEqual(start.getTime() + 30 * 60_000);
  });

  it("compresses gaps when they would overflow the window", () => {
    const start = new Date("2025-03-15T14:00:00Z");
    const at = turnTimestamps(start, 60, mulberry32(3)); // absurd turn count
    expect(at[59].getTime()).toBeLessThanOrEqual(start.getTime() + 30 * 60_000);
  });
});

describe("attachTimestamps", () => {
  it("rejects length mismatches instead of silently dropping turns", () => {
    expect(() => attachTimestamps([{ role: "user", text: "hi" }], [])).toThrow();
  });
});

describe("date formatting", () => {
  it("renders the correct local weekday (2025-03-15 was a Saturday)", () => {
    // 06:32 UTC = 14:32 Shanghai, still Saturday
    expect(formatHumanDate(new Date("2025-03-15T06:32:00Z"), SHANGHAI)).toBe(
      "Saturday, 15 March 2025",
    );
  });

  it("weekday follows the persona timezone, not UTC", () => {
    // 2025-03-15 23:00 UTC is already Sunday the 16th in Shanghai
    expect(formatHumanDate(new Date("2025-03-15T23:00:00Z"), UTC)).toBe(
      "Saturday, 15 March 2025",
    );
    expect(formatHumanDate(new Date("2025-03-15T23:00:00Z"), SHANGHAI)).toBe(
      "Sunday, 16 March 2025",
    );
  });

  it("derives slice ids from LOCAL time", () => {
    expect(sliceId(new Date("2025-03-15T06:32:00Z"), SHANGHAI)).toBe("20250315-1432");
    expect(sliceId(new Date("2025-03-15T06:32:00Z"), UTC)).toBe("20250315-0632");
  });
});
