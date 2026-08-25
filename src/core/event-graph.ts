import type { StoryEvent } from "./ir.js";

/** Validate a story event graph: unique ids, and causedBy links that only
 *  point backwards in time (causality must not reference future events). */
export function validateEventGraph(events: StoryEvent[]): void {
  const byId = new Map<string, StoryEvent>();
  for (const e of events) {
    if (byId.has(e.id)) throw new Error(`Duplicate event id: ${e.id}`);
    byId.set(e.id, e);
  }
  for (const e of events) {
    for (const ref of e.causedBy) {
      const cause = byId.get(ref);
      if (!cause) throw new Error(`Event ${e.id} references unknown cause ${ref}`);
      if (cause.dayOffset >= e.dayOffset) {
        throw new Error(
          `Event ${e.id} (day ${e.dayOffset}) is caused by ${ref} (day ${cause.dayOffset}) which is not earlier`,
        );
      }
    }
  }
}

/** Group events into sessions: consecutive events within `gapDays` of each
 *  other share one session, and a session never holds more than
 *  `maxEventsPerSession` events (pacing control). Chronological order. */
export function groupEventsIntoSessions(
  events: StoryEvent[],
  gapDays = 14,
  maxEventsPerSession = 3,
): StoryEvent[][] {
  const sorted = [...events].sort((a, b) => a.dayOffset - b.dayOffset);
  const sessions: StoryEvent[][] = [];
  let current: StoryEvent[] = [];
  let lastOffset = -Infinity;
  for (const e of sorted) {
    const tooSparse = current.length > 0 && e.dayOffset - lastOffset > gapDays;
    const tooFull = current.length >= maxEventsPerSession;
    if (tooSparse || tooFull) {
      sessions.push(current);
      current = [];
    }
    current.push(e);
    lastOffset = e.dayOffset;
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}
