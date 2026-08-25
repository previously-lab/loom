import { z } from "zod";
import type { Persona } from "./ir.js";
import { chatJson, type Usage } from "./generate.js";

/** LoCoMo QA categories (documented in snap-research/locomo issue #29):
 *  1 single-hop, 2 temporal, 3 multi-hop, 4 open-domain, 5 adversarial.
 *  Category 5 is UNANSWERABLE by design and uses adversarial_answer —
 *  keeping it in a separate field is a lesson from locomo issues #11/#41. */
export const QaItemSchema = z
  .object({
    question: z.string().min(1),
    category: z.number().int().min(1).max(5),
    answer: z.string().optional(),
    adversarial_answer: z.string().optional(),
    evidence: z.array(z.string()).default([]),
  })
  .superRefine((q, ctx) => {
    if (q.category === 5) {
      if (!q.adversarial_answer) {
        ctx.addIssue({ code: "custom", message: "category 5 requires adversarial_answer" });
      }
    } else if (!q.answer) {
      ctx.addIssue({ code: "custom", message: `category ${q.category} requires answer` });
    }
  });
export type QaItem = z.infer<typeof QaItemSchema>;

const QaBatchSchema = z.object({ qa: z.array(QaItemSchema) });

/** Validate QA items against the actual dialog ids present in the data.
 *  LoCoMo's issue tracker (#27/#35/#42/#43) is a years-long trail of broken
 *  evidence pointers — so evidence that does not resolve is a hard error. */
export function validateQa(qa: QaItem[], validDiaIds: Set<string>): string[] {
  const errors: string[] = [];
  qa.forEach((q, i) => {
    for (const ev of q.evidence) {
      if (!/^D\d+:\d+$/.test(ev)) {
        errors.push(`qa[${i}] evidence "${ev}" is not a valid dia id (Dn:m)`);
      } else if (!validDiaIds.has(ev)) {
        errors.push(`qa[${i}] evidence "${ev}" does not exist in the conversation`);
      }
    }
    if (q.category !== 5 && q.evidence.length === 0) {
      errors.push(`qa[${i}] (category ${q.category}) has no evidence pointers`);
    }
  });
  return errors;
}

export interface QaTurn {
  diaId: string;
  speaker: string;
  text: string;
}

/** Generate QA pairs with evidence pointers over the whole conversation.
 *  Runs once per dataset, not per session. */
export async function generateQa(
  apiKey: string,
  persona: Persona,
  turns: QaTurn[],
  count: number,
): Promise<{ qa: QaItem[]; usage: Usage }> {
  const index = turns.map((t) => `${t.diaId} ${t.speaker}: ${t.text}`).join("\n");
  const system = [
    "You author QA annotations for a long-term conversational memory benchmark.",
    "Output STRICT JSON only: {\"qa\": [{\"question\", \"category\", \"answer\", \"adversarial_answer\", \"evidence\": []}]}",
    "Categories: 1=single-hop (one turn), 2=temporal (date/order reasoning), 3=multi-hop (across sessions), 4=open-domain, 5=adversarial (unanswerable from the transcript).",
    "- evidence: array of dia ids (like \"D2:3\") that contain the answer. Required for categories 1-4.",
    "- Category 5 items MUST use adversarial_answer (a plausible but wrong/unsupported answer) and empty evidence.",
    "- Questions must be answerable ONLY from the transcript, never from persona assumptions.",
  ].join("\n");
  const user = [
    `Persona: ${persona.name} — ${persona.summary}`,
    ``,
    `Transcript with dialog ids:`,
    index,
    ``,
    `Write exactly ${count} QA items, mixed across categories 1, 2, 3 and 5.`,
  ].join("\n");

  const { data, usage } = await chatJson(
    apiKey,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    QaBatchSchema,
  );
  return { qa: data.qa, usage };
}
