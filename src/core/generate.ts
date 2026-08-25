import type {
  DatedEvent,
  Marking,
  Persona,
  SliceContent,
} from "./ir.js";
import { MarkingSchema, SliceContentSchema } from "./ir.js";
import { formatHumanDate, formatHumanTime } from "./calendar.js";

const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-v4-flash";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface ChatResult {
  content: string;
  usage: Usage;
}

/** Blocking single call against DeepSeek's OpenAI-compatible endpoint.
 *  Thinking is explicitly disabled — generation does not need reasoning tokens. */
export async function chat(
  apiKey: string,
  messages: { role: "system" | "user"; content: string }[],
): Promise<ChatResult> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
    };
  };
  return {
    content: data.choices[0].message.content,
    usage: {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      cacheHitTokens: data.usage.prompt_cache_hit_tokens ?? 0,
      cacheMissTokens: data.usage.prompt_cache_miss_tokens ?? 0,
    },
  };
}

/** V4-Flash off-peak pricing (USD per 1M tokens), official docs 2026-08. */
export function estimateCost(u: Usage): number {
  return (
    (u.cacheHitTokens * 0.007 + u.cacheMissTokens * 0.22 + u.completionTokens * 0.66) / 1e6
  );
}

function describeEvents(events: DatedEvent[], all: DatedEvent[], timeZone: string): string {
  const byId = new Map(all.map((e) => [e.id, e]));
  return events
    .map((e) => {
      const causes = e.causedBy
        .map((id) => byId.get(id))
        .filter((c): c is DatedEvent => !!c)
        .map((c) => `"${c.title}" (${formatHumanDate(c.date, timeZone)})`)
        .join("; ");
      return [
        `- "${e.title}" — happened on ${formatHumanDate(e.date, timeZone)}.`,
        `  Details: ${e.detail}`,
        causes ? `  Caused by earlier event(s): ${causes}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

/** Screenwriter mode: one call writes the whole slice (both roles). */
export async function generateSliceContent(
  apiKey: string,
  persona: Persona,
  timeZone: string,
  sessionStart: Date,
  sessionEvents: DatedEvent[],
  allEvents: DatedEvent[],
  turnCount: number,
): Promise<{ slice: SliceContent; usage: Usage }> {
  const system = [
    "You are a scriptwriter generating a synthetic long-term memory dataset.",
    "You write ONE chat session between a user and their personal AI assistant.",
    "Output STRICT JSON only: {\"turns\": [{\"role\": \"user\"|\"assistant\", \"text\": \"...\"}]}",
    "Rules:",
    "- Alternate roles naturally, always starting with the user.",
    "- The user talks about their real life, grounded in the provided events and persona.",
    "- The assistant is warm, concrete, and remembers what the user says within this session only.",
    "- Never invent calendar dates. If time matters, use ONLY the dates given below.",
    "- Dialogue must sound like real chat: contractions, fragments, no essay-style replies.",
  ].join("\n");

  const user = [
    `Persona: ${persona.name} — ${persona.summary}`,
    ``,
    `Session date: ${formatHumanDate(sessionStart, timeZone)}, starting at ${formatHumanTime(sessionStart, timeZone)}.`,
    ``,
    `Events that recently happened in ${persona.name}'s life (ground the conversation in these):`,
    describeEvents(sessionEvents, allEvents, timeZone),
    ``,
    `Write exactly ${turnCount} turns.`,
  ].join("\n");

  const { content, usage } = await chat(apiKey, [
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  return { slice: SliceContentSchema.parse(JSON.parse(content)), usage };
}

/** Analyzer pass: semantic compression of a finished slice into marking
 *  metadata, mirroring Previously's turn-analyzer at slice close. */
export async function analyzeSlice(
  apiKey: string,
  persona: Persona,
  timeZone: string,
  sessionStart: Date,
  slice: SliceContent,
): Promise<{ marking: Marking; usage: Usage }> {
  const transcript = slice.turns.map((t) => `${t.role}: ${t.text}`).join("\n");
  const system = [
    "You are the memory system's slice analyzer. A chat session has just ended.",
    "Compress it into indexing metadata. Output STRICT JSON only:",
    "{\"focus\": string, \"summary\": string, \"tags\": string[], \"open_loops\": string[], \"emotional_tone\": string}",
    "- focus: the single dominant topic, a short phrase.",
    "- summary: 2-3 sentences, factual, third person.",
    "- tags: 2-5 lowercase keywords for later retrieval.",
    "- open_loops: commitments or unresolved threads the user mentioned (may be empty).",
    "- emotional_tone: one or two words.",
  ].join("\n");
  const user = [
    `User persona: ${persona.name} — ${persona.summary}`,
    `Session date: ${formatHumanDate(sessionStart, timeZone)}, ${formatHumanTime(sessionStart, timeZone)}.`,
    ``,
    transcript,
  ].join("\n");

  const { content, usage } = await chat(apiKey, [
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  return { marking: MarkingSchema.parse(JSON.parse(content)), usage };
}
