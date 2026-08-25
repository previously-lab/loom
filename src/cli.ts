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
import { analyzeSlice, estimateCost, generateSliceContent } from "./core/generate.js";
import { writeSlice } from "./writers/previously.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

async function main() {
  const storyDir = arg("story");
  const outDir = arg("out", "out");
  const sessionIndex = Number(arg("slice", "0"));
  const seed = Number(arg("seed", "42"));
  const turnCount = Number(arg("turns", "10"));

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

  const bible = StoryBibleSchema.parse(
    parse(await readFile(join(storyDir, "story.yaml"), "utf8")),
  );
  validateEventGraph(bible.events);
  const tz = bible.timezone;
  const dated = assignEventDates(bible.events, bible.startDate, tz);
  const sessions = groupEventsIntoSessions(bible.events);
  if (sessionIndex >= sessions.length) {
    throw new Error(`Only ${sessions.length} session(s) available, asked for #${sessionIndex}`);
  }
  const sessionEvents = sessions[sessionIndex];
  const datedSessionEvents = sessionEvents.map(
    (e) => dated.find((d) => d.id === e.id)!,
  );

  const rng = mulberry32(seed);
  const start = scheduleSession(datedSessionEvents, rng, tz);
  console.log(
    `[plan] session #${sessionIndex}: ${sessionEvents.map((e) => e.id).join(", ")} at ${start.toISOString()}`,
  );

  const gen = await generateSliceContent(
    apiKey,
    bible.persona,
    tz,
    start,
    datedSessionEvents,
    dated,
    turnCount,
  );
  console.log(
    `[gen]  in=${gen.usage.promptTokens} (hit=${gen.usage.cacheHitTokens}) out=${gen.usage.completionTokens} ~$${estimateCost(gen.usage).toFixed(6)}`,
  );

  const ana = await analyzeSlice(apiKey, bible.persona, tz, start, gen.slice);
  console.log(
    `[mark] in=${ana.usage.promptTokens} (hit=${ana.usage.cacheHitTokens}) out=${ana.usage.completionTokens} ~$${estimateCost(ana.usage).toFixed(6)}`,
  );

  const at = turnTimestamps(start, gen.slice.turns.length, rng);
  const slice: Slice = {
    sliceId: sliceId(start, tz),
    start,
    end: at[at.length - 1],
    timezone: bible.timezone,
    events: datedSessionEvents,
    turns: attachTimestamps(gen.slice.turns, at),
    marking: ana.marking,
  };

  const file = await writeSlice(outDir, slice);
  const total = estimateCost({
    promptTokens: gen.usage.promptTokens + ana.usage.promptTokens,
    completionTokens: gen.usage.completionTokens + ana.usage.completionTokens,
    cacheHitTokens: gen.usage.cacheHitTokens + ana.usage.cacheHitTokens,
    cacheMissTokens: gen.usage.cacheMissTokens + ana.usage.cacheMissTokens,
  });
  console.log(`[done] wrote ${file}`);
  console.log(`[cost] total ~$${total.toFixed(6)} (off-peak estimate)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
