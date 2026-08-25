import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Persona, Slice } from "../core/ir.js";
import type { QaItem } from "../core/qa.js";

/** "2:51 pm on 22 March, 2025" — LoCoMo's session date_time format,
 *  rendered in the persona's local timezone. */
export function locomoDateTime(d: Date, timeZone: string): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${p.dayPeriod.toLowerCase()} on ${p.day} ${p.month}, ${p.year}`;
}

export interface LocomoSample {
  sample_id: string;
  conversation: Record<string, unknown>;
  session_summary: Record<string, string>;
  event_summary: Record<string, unknown>;
  qa: QaItem[];
}

/** Project IR slices onto the LoCoMo locomo10.json sample shape.
 *  Dialog ids are assigned here (D<session>:<turn>), never by the model. */
export function toLocomoSample(
  sampleId: string,
  persona: Persona,
  assistantName: string,
  slices: Slice[],
  sessionSummaries: string[],
  qa: QaItem[] = [],
): LocomoSample {
  const conversation: Record<string, unknown> = {
    speaker_a: persona.name,
    speaker_b: assistantName,
  };
  const sessionSummary: Record<string, string> = {};
  const eventSummary: Record<string, unknown> = {};

  slices.forEach((slice, i) => {
    const n = i + 1;
    conversation[`session_${n}`] = slice.turns.map((t, j) => ({
      speaker: t.role === "user" ? persona.name : assistantName,
      dia_id: `D${n}:${j + 1}`,
      text: t.text,
    }));
    conversation[`session_${n}_date_time`] = locomoDateTime(slice.start, slice.timezone);
    if (sessionSummaries[i]) sessionSummary[`session_${n}_summary`] = sessionSummaries[i];
    eventSummary[`events_session_${n}`] = [
      {
        speaker: persona.name,
        events: slice.events.map((e) => ({
          id: e.id,
          title: e.title,
          date: locomoDateTime(e.date, slice.timezone),
          caused_by: e.causedBy,
        })),
      },
    ];
  });

  return {
    sample_id: sampleId,
    conversation,
    session_summary: sessionSummary,
    event_summary: eventSummary,
    qa,
  };
}

/** All dia ids a sample exposes — the valid evidence pointer domain. */
export function collectDiaIds(sample: LocomoSample): Set<string> {
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(sample.conversation)) {
    if (!/^session_\d+$/.test(key)) continue;
    for (const turn of value as { dia_id: string }[]) ids.add(turn.dia_id);
  }
  return ids;
}

export async function writeLocomo(root: string, sample: LocomoSample): Promise<string> {
  await mkdir(root, { recursive: true });
  const file = join(root, "locomo.json");
  await writeFile(file, JSON.stringify([sample], null, 2), "utf8");
  return file;
}
