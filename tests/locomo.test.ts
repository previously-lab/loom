import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectDiaIds, locomoDateTime, toLocomoSample, writeLocomo } from "../src/writers/locomo.js";
import { validateQa, type QaItem } from "../src/core/qa.js";
import type { Slice } from "../src/core/ir.js";

const dirs: string[] = [];

function slice(n: number): Slice {
  const start = new Date(`2025-03-0${n}T06:51:00Z`); // 14:51 Asia/Shanghai
  return {
    sliceId: `2025030${n}-1451`,
    start,
    end: new Date(start.getTime() + 20 * 60_000),
    timezone: "Asia/Shanghai",
    events: [
      {
        id: `ev-${n}`,
        dayOffset: n,
        title: `Event ${n}`,
        detail: "…",
        causedBy: n > 1 ? [`ev-${n - 1}`] : [],
        date: start,
      },
    ],
    turns: [
      { role: "user", text: `user line of session ${n}`, at: start },
      { role: "assistant", text: `assistant line of session ${n}`, at: start },
    ],
  };
}

const persona = { name: "Maya Chen", summary: "indie dev" };

describe("locomo writer", () => {
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it("formats session date_time in LoCoMo style, local timezone", () => {
    // 06:51 UTC = 2:51 pm Shanghai
    expect(locomoDateTime(new Date("2025-03-22T06:51:00Z"), "Asia/Shanghai")).toBe(
      "2:51 pm on 22 March, 2025",
    );
  });

  it("projects slices into the locomo10.json sample shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-"));
    dirs.push(root);
    const sample = toLocomoSample(
      "maya-chen-v1",
      persona,
      "Assistant",
      [slice(1), slice(2)],
      ["summary one", "summary two"],
    );
    expect(sample.conversation.speaker_a).toBe("Maya Chen");

    const s1 = sample.conversation.session_1 as { dia_id: string; speaker: string }[];
    expect(s1[0].dia_id).toBe("D1:1");
    expect(s1[1].speaker).toBe("Assistant");
    expect(sample.conversation.session_2_date_time).toBe("2:51 pm on 2 March, 2025");
    expect(sample.session_summary.session_1_summary).toBe("summary one");

    const ev = sample.event_summary.events_session_2 as {
      events: { caused_by: string[] }[];
    }[];
    expect(ev[0].events[0].caused_by).toEqual(["ev-1"]);

    expect([...collectDiaIds(sample)].sort()).toEqual(["D1:1", "D1:2", "D2:1", "D2:2"]);

    const file = await writeLocomo(root, sample);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].sample_id).toBe("maya-chen-v1");
  });
});

describe("validateQa", () => {
  const valid = new Set(["D1:1", "D1:2", "D2:1"]);
  const base: QaItem = { question: "q", category: 1, answer: "a", evidence: ["D1:1"] };

  it("accepts well-formed items", () => {
    expect(validateQa([base], valid)).toEqual([]);
  });

  it("rejects evidence pointing at nonexistent dialog ids", () => {
    const errs = validateQa([{ ...base, evidence: ["D9:9"] }], valid);
    expect(errs[0]).toMatch(/does not exist/);
  });

  it("rejects malformed evidence pointers", () => {
    const errs = validateQa([{ ...base, evidence: ["turn 3"] }], valid);
    expect(errs[0]).toMatch(/not a valid dia id/);
  });

  it("requires evidence for answerable categories", () => {
    const errs = validateQa([{ ...base, evidence: [] }], valid);
    expect(errs[0]).toMatch(/no evidence/);
  });

  it("category 5 (adversarial) needs adversarial_answer and no evidence", () => {
    const ok: QaItem = {
      question: "q",
      category: 5,
      adversarial_answer: "plausible but wrong",
      evidence: [],
    };
    expect(validateQa([ok], valid)).toEqual([]);
  });
});
