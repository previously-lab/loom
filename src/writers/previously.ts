import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import type { Slice } from "../core/ir.js";
import { localParts } from "../core/calendar.js";

/** Directory layout mirroring Previously: slices/YYYY/MM/DD/HHMM/timeline/core.md.
 *  The path is derived from the persona's LOCAL time, matching real usage. */
export function sliceDir(root: string, slice: Slice): string {
  const p = localParts(slice.start, slice.timezone);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return join(
    root,
    "slices",
    String(p.year),
    String(p.month).padStart(2, "0"),
    String(p.day).padStart(2, "0"),
    `${hh}${mm}`,
  );
}

export function renderCoreMd(slice: Slice): string {
  const fm = stringify({
    slice_id: slice.sliceId,
    focus: slice.marking?.focus ?? "",
    status: "closed",
    start: slice.start.toISOString(),
    end: slice.end.toISOString(),
    timezone: slice.timezone,
    summary: slice.marking?.summary ?? "",
    tags: slice.marking?.tags ?? [],
    open_loops: slice.marking?.open_loops ?? [],
    emotional_tone: slice.marking?.emotional_tone ?? "",
  }).trim();
  const body = slice.turns
    .map((t, i) => `## Turn ${i + 1} — ${t.at.toISOString()} (${t.role})\n\n${t.text}`)
    .join("\n\n");
  return `---\n${fm}\n---\n\n${body}\n`;
}

export async function writeSlice(root: string, slice: Slice): Promise<string> {
  const dir = join(sliceDir(root, slice), "timeline");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "core.md");
  await writeFile(file, renderCoreMd(slice), "utf8");
  return file;
}
