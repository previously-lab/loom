import { z } from "zod";

/** A story event as authored in the story bible: dates are RELATIVE (dayOffset),
 *  absolute dates are assigned by the calendar engine, never by the model. */
export const StoryEventSchema = z.object({
  id: z.string().min(1),
  dayOffset: z.number().int().nonnegative(),
  title: z.string().min(1),
  detail: z.string().min(1),
  causedBy: z.array(z.string()).default([]),
});
export type StoryEvent = z.infer<typeof StoryEventSchema>;

export const PersonaSchema = z.object({
  name: z.string().min(1),
  summary: z.string().min(1),
});
export type Persona = z.infer<typeof PersonaSchema>;

/** Seed content for the Previously v1.0 evolution data layer (optional).
 *  Mirrors the kernel's `memory/evolution/direction.md` skeleton: a USER
 *  PORTRAIT over six fixed dimensions plus a bounded pool of falsifiable
 *  hypotheses. When absent, writers fall back to the kernel's own minimal
 *  template. */
export const PORTRAIT_SECTIONS = [
  "Traits & cognitive style",
  "Triggers & rhythms",
  "Patterns & loops",
  "Strengths & resilience",
  "Communication preferences",
  "Values & boundaries",
] as const;

export const PortraitEntrySchema = z.object({
  section: z.enum(PORTRAIT_SECTIONS),
  /** Descriptive, portrait-grade text — never imperatives. Slice pointers
   *  ride the trailing "— refs:" tail only, never the body. */
  text: z.string().min(1),
  refs: z.array(z.string()).default([]),
});
export type PortraitEntry = z.infer<typeof PortraitEntrySchema>;

/** A trait-level guess, mirroring the kernel's hypothesis line format:
 *  `- [proposed YYYY-MM-DD-HHMM] <guess> — falsify if: <condition>`. */
export const HypothesisSchema = z.object({
  proposed: z.string().regex(/^\d{4}-\d{2}-\d{2}-\d{4}$/),
  guess: z.string().min(1),
  falsifyIf: z.string().min(1),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const DirectionSchema = z.object({
  portrait: z.array(PortraitEntrySchema).default([]),
  hypotheses: z.array(HypothesisSchema).max(10).default([]),
});
export type Direction = z.infer<typeof DirectionSchema>;

export const PlaybooksSchema = z.object({
  recall: z.string().optional(),
  search: z.string().optional(),
  thinkdeep: z.string().optional(),
});
export type Playbooks = z.infer<typeof PlaybooksSchema>;

export const StoryBibleSchema = z.object({
  persona: PersonaSchema,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
  events: z.array(StoryEventSchema).min(1),
  direction: DirectionSchema.optional(),
  playbooks: PlaybooksSchema.optional(),
});
export type StoryBible = z.infer<typeof StoryBibleSchema>;

/** An event with its absolute date resolved by the calendar engine. */
export const DatedEventSchema = StoryEventSchema.extend({ date: z.date() });
export type DatedEvent = z.infer<typeof DatedEventSchema>;

export const TurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
});
export type Turn = z.infer<typeof TurnSchema>;

export const DatedTurnSchema = TurnSchema.extend({ at: z.date() });
export type DatedTurn = z.infer<typeof DatedTurnSchema>;

/** Raw slice content as returned by the generation model (screenwriter mode). */
export const SliceContentSchema = z.object({
  turns: z.array(TurnSchema).min(2),
});
export type SliceContent = z.infer<typeof SliceContentSchema>;

/** Slice marking: semantic compression produced by the analyzer pass,
 *  mirroring Previously's turn-analyzer frontmatter. */
export const MarkingSchema = z.object({
  focus: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  open_loops: z.array(z.string()).default([]),
  emotional_tone: z.string().min(1),
});
export type Marking = z.infer<typeof MarkingSchema>;

/** The neutral intermediate representation (IR) of one generated slice. */
export interface Slice {
  sliceId: string;
  start: Date;
  end: Date;
  timezone: string;
  events: DatedEvent[];
  turns: DatedTurn[];
  marking?: Marking;
  /** Snapshot of long- and short-term memory as of the start of this slice. */
  previously?: string;
}
