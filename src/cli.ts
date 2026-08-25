import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { StoryBibleSchema, type Slice } from "./core/ir.js";
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
  summarizeSession,
  type Usage,
} from "./core/generate.js";
import { generateQa, validateQa, type QaItem } from "./core/qa.js";
import { writeSlice } from "./writers/previously.js";
import { collectDiaIds, toLocomoSample, writeLocomo } from "./writers/locomo.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}
const has = (name: string) => process.argv.includes(`--${name}`);

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
    rollingSummary = sum.summary;
    summaries.push(sum.summary);

    // Code-side temporal lint — cheap, catches what models get wrong.
    const spanStart = dated[0].date;
    const spanEnd = new Date(Math.max(...dated.map((e) => e.date.getTime())) + 400 * 86_400_000);
    for (const w of lintTranscript(gen.slice.turns, spanStart, spanEnd)) {
      console.log(`[lint] session #${idx} turn ${w.turn}: ${w.message}`);
    }

    const at = turnTimestamps(start, gen.slice.turns.length, rng);
    const slice: Slice = {
      sliceId: sliceId(start, tz),
      start,
      end: at[at.length - 1],
      timezone: tz,
      events: sessionEvents,
      turns: attachTimestamps(gen.slice.turns, at),
      marking: ana.marking,
    };
    slices.push(slice);

    if (format === "previously" || format === "both") {
      const file = await writeSlice(outDir, slice);
      console.log(`[write] previously: ${file}`);
    }
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
