import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { StoryBibleSchema, type DatedEvent, type Marking, type Slice } from "./core/ir.js";
import { validateEventGraph, groupEventsIntoSessions } from "./core/event-graph.js";
import {
  assignEventDates,
  attachTimestamps,
  mulberry32,
  scheduleSession,
  sliceId,
  turnTimestamps,
} from "./core/calendar.js";
import { lintTranscript } from "./core/consistency.js";
import {
  analyzeSlice,
  estimateCost,
  generateSliceContent,
  generatePreviouslySnapshot,
  summarizeSession,
  type Usage,
} from "./core/generate.js";
import { generateQa, validateQa, type QaItem } from "./core/qa.js";
import { buildManifest, writePreviouslyDataset, writeSliceFiles } from "./writers/previously.js";
import { collectDiaIds, toLocomoSample, writeLocomo } from "./writers/locomo.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}
const has = (name: string) => process.argv.includes(`--${name}`);

interface PersistedTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
}

interface PersistedSlice {
  sliceId: string;
  start: string;
  end: string;
  timezone: string;
  events: DatedEvent[];
  turns: PersistedTurn[];
  marking?: Marking;
  previously?: string;
}

interface RunState {
  lastIndex: number;
  rollingSummary?: string;
  spent: number;
  slices: PersistedSlice[];
}

function serializeSlice(slice: Slice): PersistedSlice {
  return {
    sliceId: slice.sliceId,
    start: slice.start.toISOString(),
    end: slice.end.toISOString(),
    timezone: slice.timezone,
    events: slice.events,
    turns: slice.turns.map((t) => ({
      role: t.role,
      text: t.text,
      at: t.at.toISOString(),
    })),
    marking: slice.marking,
    previously: slice.previously,
  };
}

function deserializeSlice(p: PersistedSlice): Slice {
  return {
    sliceId: p.sliceId,
    start: new Date(p.start),
    end: new Date(p.end),
    timezone: p.timezone,
    events: p.events,
    turns: p.turns.map((t) => ({
      role: t.role,
      text: t.text,
      at: new Date(t.at),
    })),
    marking: p.marking,
    previously: p.previously,
  };
}

async function loadState(outDir: string): Promise<RunState | null> {
  try {
    const raw = await readFile(join(outDir, ".loom-state.json"), "utf8");
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

async function saveState(outDir: string, state: RunState): Promise<void> {
  await writeFile(join(outDir, ".loom-state.json"), JSON.stringify(state, null, 2), "utf8");
}

async function main() {
  const storyDir = arg("story");
  const outDir = arg("out", "out");
  const seed = Number(arg("seed", "42"));
  const turnCount = Number(arg("turns", "10"));
  const gapDays = Number(arg("gap-days", "14"));
  const maxEvents = Number(arg("max-events", "3"));
  const qaCount = Number(arg("qa", "0"));
  const maxCost = Number(arg("max-cost", "0.10"));
  const format = arg("format", "both"); // previously | locomo | both
  const runAll = has("all");
  const singleIndex = has("slice") ? Number(arg("slice")) : null;
  const resume = has("resume");
  if (!runAll && singleIndex === null) {
    throw new Error("Pass --all to generate every session, or --slice N for a single one");
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

  const bible = StoryBibleSchema.parse(
    parse(await readFile(join(storyDir, "story.yaml"), "utf8")),
  );
  validateEventGraph(bible.events);
  const tz = bible.timezone;
  const dated = assignEventDates(bible.events, bible.startDate, tz);
  const sessions = groupEventsIntoSessions(bible.events, gapDays, maxEvents);

  const indices = runAll ? sessions.map((_, i) => i) : [singleIndex!];
  if (singleIndex !== null && singleIndex >= sessions.length) {
    throw new Error(`Only ${sessions.length} session(s), asked for #${singleIndex}`);
  }
  if (singleIndex !== null && singleIndex > 0) {
    console.log("[warn] single-slice mode: no prior-session summary, continuity is standalone");
  }

  const rng = mulberry32(seed);
  const slices: Slice[] = [];
  const summaries: string[] = [];
  let rollingSummary: string | undefined;
  let spent = 0;
  let lastIndex = -1;

  if (resume) {
    const state = await loadState(outDir);
    if (state) {
      lastIndex = state.lastIndex;
      rollingSummary = state.rollingSummary;
      spent = state.spent;
      for (const p of state.slices) {
        slices.push(deserializeSlice(p));
      }
      console.log(`[resume] continuing from session #${lastIndex + 1}, ${slices.length} slice(s) already on disk, spent ~$${spent.toFixed(4)}`);
    } else {
      console.log("[resume] no previous state found, starting fresh");
    }
  }

  const track = (u: Usage, label: string) => {
    const c = estimateCost(u);
    spent += c;
    console.log(
      `[${label}] in=${u.promptTokens} (hit=${u.cacheHitTokens}) out=${u.completionTokens} ~$${c.toFixed(6)} | total ~$${spent.toFixed(6)}`,
    );
    if (spent > maxCost) {
      throw new Error(`Budget exceeded: ~$${spent.toFixed(4)} > --max-cost $${maxCost}`);
    }
  };

  for (const idx of indices) {
    if (idx <= lastIndex) {
      console.log(`[skip] session #${idx} already generated`);
      continue;
    }

    const sessionEvents = sessions[idx].map((e) => dated.find((d) => d.id === e.id)!);
    const start = scheduleSession(sessionEvents, rng, tz);
    console.log(
      `[plan] session #${idx}: ${sessionEvents.map((e) => e.id).join(", ")} at ${start.toISOString()}`,
    );

    const gen = await generateSliceContent(
      apiKey, bible.persona, tz, start, sessionEvents, dated, turnCount, rollingSummary,
    );
    track(gen.usage, "gen");

    const ana = await analyzeSlice(apiKey, bible.persona, tz, start, gen.slice);
    track(ana.usage, "mark");

    const sum = await summarizeSession(
      apiKey, bible.persona, tz, start, gen.slice, rollingSummary,
    );
    track(sum.usage, "sum");
    summaries.push(sum.summary);

    const id = sliceId(start, tz);
    rollingSummary = sum.summary;

    // Code-side temporal lint — cheap, catches what models get wrong.
    const spanStart = dated[0].date;
    const spanEnd = new Date(Math.max(...dated.map((e) => e.date.getTime())) + 400 * 86_400_000);
    for (const w of lintTranscript(gen.slice.turns, spanStart, spanEnd)) {
      console.log(`[lint] session #${idx} turn ${w.turn}: ${w.message}`);
    }

    const at = turnTimestamps(start, gen.slice.turns.length, rng);
    const slice: Slice = {
      sliceId: id,
      start,
      end: at[at.length - 1],
      timezone: tz,
      events: sessionEvents,
      turns: attachTimestamps(gen.slice.turns, at),
      marking: ana.marking,
    };

    // Write slice files immediately so progress is never lost.
    const file = await writeSliceFiles(outDir, slice);
    slices.push(slice);
    lastIndex = idx;

    // Persist state for resume.
    await saveState(outDir, {
      lastIndex,
      rollingSummary,
      spent,
      slices: slices.map(serializeSlice),
    });

    console.log(`[write] slice: ${file}`);
  }

  // Only the LAST slice gets a rich Previously snapshot; it is what the app reads.
  if ((format === "previously" || format === "both") && slices.length > 0) {
    const last = slices[slices.length - 1];
    if (last.marking) {
      const snap = await generatePreviouslySnapshot(
        apiKey,
        bible.persona,
        tz,
        last.start,
        last.sliceId,
        last.marking,
        rollingSummary,
      );
      track(snap.usage, "prev-final");
      last.previously = snap.content;
      await writeSliceFiles(outDir, last);
      console.log(`[write] previously snapshot: ${last.sliceId}`);
    }
  }

  if ((format === "previously" || format === "both") && slices.length > 0) {
    const dir = await writePreviouslyDataset(outDir, bible.persona, slices);
    console.log(`[write] previously: ${dir}`);

    const manifest = buildManifest(bible.persona, slices);
    const manifestFile = join(outDir, "..", "manifest.json");
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
    console.log(`[write] manifest: ${manifestFile}`);
  }

  if (format === "locomo" || format === "both") {
    let qa: QaItem[] = [];
    const sample = toLocomoSample(
      `${bible.persona.name.toLowerCase().replace(/\s+/g, "-")}-v1`,
      bible.persona,
      "Assistant",
      slices,
      summaries,
      qa,
    );
    if (qaCount > 0) {
      const turns = slices.flatMap((s, i) =>
        s.turns.map((t, j) => ({
          diaId: `D${i + 1}:${j + 1}`,
          speaker: t.role === "user" ? bible.persona.name : "Assistant",
          text: t.text,
        })),
      );
      const gen = await generateQa(apiKey, bible.persona, turns, qaCount);
      track(gen.usage, "qa");
      qa = gen.qa;
      sample.qa = qa;
      const errors = validateQa(qa, collectDiaIds(sample));
      for (const e of errors) console.log(`[qa-lint] ${e}`);
      if (errors.length > 0) console.log(`[qa-lint] ${errors.length} problem(s) — review before publishing`);
    }
    const file = await writeLocomo(outDir, sample);
    console.log(`[write] locomo: ${file}`);
  }

  console.log(`[done] ${slices.length} session(s), total ~$${spent.toFixed(6)} (off-peak estimate)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
