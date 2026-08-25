import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readFile as rf } from "node:fs/promises";
import { StoryBibleSchema, type Slice } from "../src/core/ir.js";
import { renderCoreMd, sliceDir, writeSlice } from "../src/writers/previously.js";

const dirs: string[] = [];

function fakeSlice(): Slice {
  const start = new Date("2025-03-15T14:00:00Z");
  const at = new Date("2025-03-15T14:03:00Z");
  return {
    sliceId: "20250315-1400",
    start,
    end: at,
    timezone: "Asia/Shanghai",
    events: [],
    turns: [
      { role: "user", text: "I finally shipped the beta today.", at: start },
      { role: "assistant", text: "That is huge — how are you feeling?", at },
    ],
    marking: {
      focus: "Tidepool beta launch",
      summary: "Maya shipped the closed beta of Tidepool.",
      tags: ["tidepool", "beta"],
      open_loops: ["rewrite onboarding"],
      emotional_tone: "excited",
    },
  };
}

describe("StoryBibleSchema", () => {
  it("parses the example story bible", async () => {
    const raw = parse(await rf(join(__dirname, "../stories/example/story.yaml"), "utf8"));
    const bible = StoryBibleSchema.parse(raw);
    expect(bible.persona.name).toBe("Maya Chen");
    expect(bible.events).toHaveLength(4);
  });
});

describe("previously writer", () => {
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("writes slices to the YYYY/MM/DD/HHMM layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-"));
    dirs.push(root);
    const slice = fakeSlice();
    // 14:00 UTC = 22:00 Asia/Shanghai — directory naming follows local time
    expect(sliceDir(root, slice)).toBe(join(root, "slices", "2025", "03", "15", "2200"));

    const file = await writeSlice(root, slice);
    const md = await readFile(file, "utf8");

    const [, fmRaw, body] = md.split("---\n");
    const fm = parse(fmRaw);
    expect(fm.slice_id).toBe("20250315-1400");
    expect(fm.status).toBe("closed");
    expect(fm.tags).toEqual(["tidepool", "beta"]);
    expect(fm.open_loops).toEqual(["rewrite onboarding"]);
    expect(body).toContain("## Turn 1 — 2025-03-15T14:00:00.000Z (user)");
    expect(body).toContain("## Turn 2 — 2025-03-15T14:03:00.000Z (assistant)");
  });

  it("round-trips frontmatter through YAML without loss", () => {
    const slice = fakeSlice();
    const md = renderCoreMd(slice);
    const fm = parse(md.split("---\n")[1]);
    expect(fm.focus).toBe(slice.marking!.focus);
    expect(fm.emotional_tone).toBe(slice.marking!.emotional_tone);
    expect(fm.start).toBe(slice.start.toISOString());
  });
});
