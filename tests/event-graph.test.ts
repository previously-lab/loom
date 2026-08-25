import { describe, expect, it } from "vitest";
import { groupEventsIntoSessions, validateEventGraph } from "../src/core/event-graph.js";
import type { StoryEvent } from "../src/core/ir.js";

const ev = (id: string, dayOffset: number, causedBy: string[] = []): StoryEvent => ({
  id,
  dayOffset,
  title: `Event ${id}`,
  detail: `Detail of ${id}`,
  causedBy,
});

describe("validateEventGraph", () => {
  it("accepts a valid causal chain", () => {
    expect(() =>
      validateEventGraph([ev("a", 0), ev("b", 10, ["a"]), ev("c", 20, ["b"])]),
    ).not.toThrow();
  });

  it("rejects duplicate ids", () => {
    expect(() => validateEventGraph([ev("a", 0), ev("a", 5)])).toThrow(/Duplicate/);
  });

  it("rejects causes pointing at unknown events", () => {
    expect(() => validateEventGraph([ev("a", 5, ["ghost"])])).toThrow(/unknown cause/);
  });

  it("rejects causes that are not strictly earlier (no future causality)", () => {
    expect(() => validateEventGraph([ev("a", 10, ["b"]), ev("b", 20)])).toThrow(/not earlier/);
    expect(() => validateEventGraph([ev("a", 10, ["b"]), ev("b", 10)])).toThrow(/not earlier/);
  });
});

describe("groupEventsIntoSessions", () => {
  it("groups nearby events and splits on large gaps", () => {
    const sessions = groupEventsIntoSessions(
      [ev("a", 0), ev("b", 3), ev("c", 40), ev("d", 42)],
      14,
    );
    expect(sessions.map((s) => s.map((e) => e.id))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps chronological order even if input is shuffled", () => {
    const sessions = groupEventsIntoSessions([ev("b", 3), ev("a", 0)], 14);
    expect(sessions[0].map((e) => e.id)).toEqual(["a", "b"]);
  });
});
