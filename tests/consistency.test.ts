import { describe, expect, it } from "vitest";
import { lintTranscript } from "../src/core/consistency.js";
import { groupEventsIntoSessions } from "../src/core/event-graph.js";
import type { StoryEvent, Turn } from "../src/core/ir.js";

const spanStart = new Date(Date.UTC(2025, 2, 1)); // 2025-03-01
const spanEnd = new Date(Date.UTC(2026, 2, 1));

const t = (text: string): Turn => ({ role: "user", text });

describe("lintTranscript", () => {
  it("passes clean text", () => {
    expect(
      lintTranscript([t("See you next week!"), t("It happened in 2025.")], spanStart, spanEnd),
    ).toEqual([]);
  });

  it("flags years outside the story span", () => {
    const w = lintTranscript([t("Back in 2019 I lived abroad.")], spanStart, spanEnd);
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/2019/);
    expect(w[0].turn).toBe(1);
  });

  it("flags weekday/date mismatches (2025-03-15 was a Saturday, not a Monday)", () => {
    const w = lintTranscript(
      [t("We met on Monday, March 15, 2025.")],
      spanStart,
      spanEnd,
    );
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/weekday/);
  });

  it("accepts correct weekday/date combos", () => {
    expect(
      lintTranscript([t("We met on Saturday, March 15, 2025.")], spanStart, spanEnd),
    ).toEqual([]);
  });

  it("without a year, accepts a weekday/date combo if ANY year in span matches", () => {
    // March 15 is a Saturday in 2025 (span 2025–2026)
    expect(lintTranscript([t("on Saturday, March 15")], spanStart, spanEnd)).toEqual([]);
  });

  it("ignores bare dates with no weekday (nothing to cross-check)", () => {
    expect(lintTranscript([t("Deadline is March 20.")], spanStart, spanEnd)).toEqual([]);
  });
});

describe("groupEventsIntoSessions pacing", () => {
  const ev = (id: string, dayOffset: number): StoryEvent => ({
    id, dayOffset, title: id, detail: id, causedBy: [],
  });

  it("splits sessions that exceed maxEventsPerSession even within the gap", () => {
    const sessions = groupEventsIntoSessions(
      [ev("a", 0), ev("b", 1), ev("c", 2), ev("d", 3)],
      14,
      3,
    );
    expect(sessions.map((s) => s.map((e) => e.id))).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("keeps sparse grouping when under the max", () => {
    const sessions = groupEventsIntoSessions([ev("a", 0), ev("b", 30)], 14, 3);
    expect(sessions.map((s) => s.map((e) => e.id))).toEqual([["a"], ["b"]]);
  });
});
