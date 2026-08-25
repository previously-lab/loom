import { z } from "zod";
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
const MAX_RETRIES = 3;

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

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Blocking single call against DeepSeek's OpenAI-compatible endpoint.
 *  Thinking is explicitly disabled — generation does not need reasoning tokens.
 *  Retries on network errors and 5xx with exponential backoff; 4xx is fatal. */
export async function chat(apiKey: string, messages: ChatMessage[]): Promise<ChatResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(API_URL, {
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
    } catch (err) {
      lastErr = err; // network error — retryable
      continue;
    }
    if (res.ok) {
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
    const body = await res.text();
    if (res.status >= 500) {
      lastErr = new Error(`DeepSeek API ${res.status}: ${body}`);
      continue;
    }
    throw new Error(`DeepSeek API ${res.status}: ${body}`); // 4xx — do not retry
  }
  throw lastErr;
}

/** Chat + strict JSON validation against a zod schema. One corrective retry:
 *  if the model returns malformed JSON, the error is fed back and it tries again. */
export async function chatJson<S extends z.ZodTypeAny>(
  apiKey: string,
  messages: ChatMessage[],
  schema: S,
): Promise<{ data: z.output<S>; usage: Usage }> {
  let total: Usage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
  const thread = [...messages];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, usage } = await chat(apiKey, thread);
    total = {
      promptTokens: total.promptTokens + usage.promptTokens,
      completionTokens: total.completionTokens + usage.completionTokens,
      cacheHitTokens: total.cacheHitTokens + usage.cacheHitTokens,
      cacheMissTokens: total.cacheMissTokens + usage.cacheMissTokens,
    };
    try {
      return { data: schema.parse(JSON.parse(content)), usage: total };
    } catch (err) {
      if (attempt === 1) throw err;
      thread.push(
        { role: "assistant", content },
        {
          role: "user",
          content: `Your output failed validation: ${String(err).slice(0, 400)}\nReply with corrected strict JSON only.`,
        },
      );
    }
  }
  throw new Error("unreachable");
}

export function sumUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens,
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

function describeBackground(events: DatedEvent[], timeZone: string): string {
  return events
    .map((e) => `- "${e.title}" (${formatHumanDate(e.date, timeZone)})`)
    .join("\n");
}

/** Screenwriter mode: one call writes the whole slice (both roles).
 *  Foreground events MUST be discussed; background events are context the user
 *  may allude to naturally. `previousSummary` carries continuity across sessions. */
export async function generateSliceContent(
  apiKey: string,
  persona: Persona,
  timeZone: string,
  sessionStart: Date,
  sessionEvents: DatedEvent[],
  allEvents: DatedEvent[],
  turnCount: number,
  previousSummary?: string,
): Promise<{ slice: SliceContent; usage: Usage }> {
  const pastBackground = allEvents.filter(
    (e) => !sessionEvents.some((s) => s.id === e.id) && e.date < sessionStart,
  );
  const system = [
    "You are a scriptwriter generating a synthetic long-term memory dataset.",
    "You write ONE chat session between a user and their personal AI assistant.",
    "Output STRICT JSON only: {\"turns\": [{\"role\": \"user\"|\"assistant\", \"text\": \"...\"}]}",
    "Rules:",
    "- Alternate roles naturally, always starting with the user.",
    "- The user talks about their real life, grounded in the provided events and persona.",
    "- The assistant is warm, concrete, and remembers prior sessions ONLY via the provided session summary.",
    "- Never invent calendar dates. If time matters, use ONLY the dates given below.",
    "- Dialogue must sound like real chat: contractions, fragments, no essay-style replies.",
    "- The foreground events MUST come up. Background events may be referenced only if they come up naturally; never force them.",
  ].join("\n");

  const user = [
    `Persona: ${persona.name} — ${persona.summary}`,
    ``,
    `Session date: ${formatHumanDate(sessionStart, timeZone)}, starting at ${formatHumanTime(sessionStart, timeZone)}.`,
    ``,
    previousSummary
      ? `Summary of previous sessions (shared memory of both speakers):\n${previousSummary}`
      : `This is the FIRST session ever between the user and this assistant. Neither knows the other yet.`,
    ``,
    `Foreground events (must be discussed this session):`,
    describeEvents(sessionEvents, allEvents, timeZone),
    pastBackground.length > 0
      ? `\nBackground (earlier events the user may allude to, briefly):\n${describeBackground(pastBackground, timeZone)}`
      : null,
    ``,
    `Write exactly ${turnCount} turns.`,
  ]
    .filter((x) => x !== null)
    .join("\n");

  const { data, usage } = await chatJson(
    apiKey,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    SliceContentSchema,
  );
  return { slice: data, usage };
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

  const { data, usage } = await chatJson(
    apiKey,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    MarkingSchema,
  );
  return { marking: data, usage };
}

const SummarySchema = z.object({ summary: z.string().min(1) });

/** Rolling cross-session memory: fold the latest session into the running
 *  summary. This is the ONLY continuity channel between sessions. */
export async function summarizeSession(
  apiKey: string,
  persona: Persona,
  timeZone: string,
  sessionStart: Date,
  slice: SliceContent,
  previousSummary?: string,
): Promise<{ summary: string; usage: Usage }> {
  const transcript = slice.turns.map((t) => `${t.role}: ${t.text}`).join("\n");
  const system = [
    "You maintain the running summary of an ongoing series of chat sessions.",
    "Output STRICT JSON only: {\"summary\": string}",
    "- Merge the new session into the existing summary. Keep facts, decisions, commitments, and dates.",
    "- Drop small talk. Stay under 150 words. Third person, past tense.",
  ].join("\n");
  const user = [
    `User persona: ${persona.name} — ${persona.summary}`,
    `Session date: ${formatHumanDate(sessionStart, timeZone)}.`,
    previousSummary ? `Running summary so far:\n${previousSummary}` : "No prior sessions.",
    ``,
    `New session transcript:\n${transcript}`,
  ].join("\n");

  const { data, usage } = await chatJson(
    apiKey,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    SummarySchema,
  );
  return { summary: data.summary, usage };
}
