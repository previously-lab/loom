import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readFile as rf } from "node:fs/promises";
import { StoryBibleSchema, type StoryBible, type Slice } from "../src/core/ir.js";
import {
  buildManifest,
  buildStrands,
  renderCoreMd,
  renderDirectionMd,
  sliceDir,
  writeEvolutionFiles,
  writePreviouslyDataset,
  writeSlice,
} from "../src/writers/previously.js";

const dirs: string[] = [];

function fakeSlice(overrides?: Partial<Slice> & { localStart?: string }): Slice {
  const start = overrides?.localStart
    ? new Date(overrides.localStart)
    : new Date("2025-03-15T14:00:00Z");
  const at = new Date(start.getTime() + 3 * 60_000);
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
    ...overrides,
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

  it("writes slices to the episodic/slices/YYYY/MM/DD/HHMM layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-"));
    dirs.push(root);
    const slice = fakeSlice();
    // 14:00 UTC = 22:00 Asia/Shanghai — directory naming follows local time
    expect(sliceDir(root, slice)).toBe(join(root, "episodic", "slices", "2025", "03", "15", "2200"));

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

  it("writes the full Previously dataset", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-"));
    dirs.push(root);
    const persona = { name: "Maya Chen", summary: "Indie developer in Hangzhou." };
    const bible = {
      persona,
      startDate: "2025-03-15",
      timezone: "Asia/Shanghai",
      events: [],
    };
    const slices = [fakeSlice()];

    await writePreviouslyDataset(root, bible, slices);

    const profile = await readFile(join(root, "user", "profile.md"), "utf8");
    expect(profile).toContain("Maya Chen");
    expect(profile).toContain("Asia/Shanghai");
    expect(profile).toContain("Indie developer in Hangzhou.");

    const current = await readFile(join(root, "episodic", "current-previously.md"), "utf8");
    expect(current).toContain("# Previously On");
    expect(current).toContain("Maya Chen");
    expect(current).toContain("Format: user card v2");
    expect(current).not.toContain("## Self-model");

    const timeline = await readFile(join(root, "episodic", "timeline.md"), "utf8");
    expect(timeline).toContain("# Timeline");
    expect(timeline).toContain("20250315-1400");

    const strands = JSON.parse(await readFile(join(root, "episodic", "strands.json"), "utf8"));
    expect(strands.tidepool).toEqual(["2025/03/15/2200"]);
    expect(strands.beta).toEqual(["2025/03/15/2200"]);

    const index = JSON.parse(
      await readFile(join(root, "episodic", "slices", "2025", "03", "_index.json"), "utf8"),
    );
    expect(index.month).toBe("2025-03");
    expect(index.slices).toHaveLength(1);
    expect(index.slices[0].id).toBe("20250315-1400");

    const previously = await readFile(
      join(root, "episodic", "slices", "2025", "03", "15", "2200", "previously.md"),
      "utf8",
    );
    expect(previously).toContain("# Previously On");
    expect(previously).toContain("20250315-1400");

    const core = await readFile(
      join(root, "episodic", "slices", "2025", "03", "15", "2200", "timeline", "core.md"),
      "utf8",
    );
    expect(core).toContain("slice_id: 20250315-1400");

    const agent = await readFile(
      join(root, "episodic", "slices", "2025", "03", "15", "2200", "timeline", "agent.md"),
      "utf8",
    );
    expect(agent).toBe("");
  });

  it("writes a manifest with the correct persona id, slice count, and date range", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-"));
    dirs.push(root);
    const persona = { name: "Maya Chen", summary: "Indie developer." };
    const slices = [
      fakeSlice({ localStart: "2025-03-15T14:00:00.000Z" }),
      fakeSlice({
        localStart: "2025-04-20T09:00:00.000Z",
        sliceId: "20250420-1700",
        marking: {
          focus: "Marathon training",
          summary: "Maya starts training.",
          tags: ["marathon"],
          open_loops: [],
          emotional_tone: "determined",
        },
      }),
    ];

    const manifest = buildManifest(persona, slices);
    expect(manifest.version).toBe(1);
    const entry = manifest.personas["maya-chen"];
    expect(entry).toBeDefined();
    expect(entry.name).toBe("Maya Chen");
    expect(entry.sliceCount).toBe(2);
    expect(entry.dateRange).toEqual(["2025-03", "2025-04"]);
    expect(entry.topics).toEqual(["beta", "marathon", "tidepool"]);
    type DayNode = Record<string, { _files: string[] }>;
    type MonthNode = Record<string, DayNode | { _files: string[] }> & { _files?: string[] };
    const tree = entry.tree as unknown as {
      episodic: { _files: string[]; slices: Record<string, unknown> };
      user: { _files: string[] };
    };
    expect(tree.episodic._files).toEqual([
      "current-previously.md",
      "strands.json",
      "timeline.md",
    ]);
    expect(tree.user._files).toEqual(["profile.md"]);
    const year2025 = tree.episodic.slices["2025"] as Record<string, unknown>;
    const month03 = year2025["03"] as { _files: string[] };
    expect(month03._files).toEqual(["_index.json"]);
    const day15 = (year2025["03"] as Record<string, unknown>)["15"] as Record<string, { _files: string[] }>;
    expect(day15["2200"]._files).toEqual(["previously.md"]);
  });

  it("builds strands from multiple slices", () => {
    const slices = [
      fakeSlice({ localStart: "2025-03-15T14:00:00.000Z" }),
      fakeSlice({
        localStart: "2025-04-20T09:00:00.000Z",
        sliceId: "20250420-1700",
        marking: {
          focus: "Marathon training",
          summary: "Maya starts training.",
          tags: ["tidepool", "marathon"],
          open_loops: [],
          emotional_tone: "determined",
        },
      }),
    ];
    const strands = buildStrands(slices);
    expect(strands.tidepool).toEqual(["2025/03/15/2200", "2025/04/20/1700"]);
    expect(strands.beta).toEqual(["2025/03/15/2200"]);
    expect(strands.marathon).toEqual(["2025/04/20/1700"]);
  });
});

describe("evolution layer (v1.0)", () => {
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  function fakeBible(overrides?: Partial<StoryBible>): StoryBible {
    return {
      persona: { name: "Maya Chen", summary: "Indie developer." },
      startDate: "2025-03-15",
      timezone: "Asia/Shanghai",
      events: [],
      ...overrides,
    };
  }

  it("falls back to the kernel's minimal direction template when unseeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-"));
    dirs.push(root);
    const written = await writeEvolutionFiles(root, fakeBible());

    const direction = await readFile(join(root, "evolution", "direction.md"), "utf8");
    expect(direction).toContain("# Portrait");
    expect(direction).toContain("## Traits & cognitive style");
    expect(direction).toContain("## Triggers & rhythms");
    expect(direction).toContain("## Patterns & loops");
    expect(direction).toContain("## Strengths & resilience");
    expect(direction).toContain("## Communication preferences");
    expect(direction).toContain("## Values & boundaries");
    expect(direction).toContain("# Hypotheses");
    expect(direction).toContain("_(Not set yet");

    // The kernel dropped the mutations archive — loom must not generate it
    await expect(
      readFile(join(root, "evolution", "mutations.md"), "utf8"),
    ).rejects.toThrow();

    // No playbooks seeded → no agent-playbooks directory entries
    expect(written.some((f) => f.includes("agent-playbooks"))).toBe(false);
  });

  it("renders a seeded direction with the portrait + hypotheses skeleton", () => {
    const md = renderDirectionMd({
      portrait: [
        {
          section: "Traits & cognitive style",
          text: "Builds structure before acting under uncertainty.",
          refs: ["2025-03-15-1400", "2025-03-20-0900"],
        },
      ],
      hypotheses: [
        {
          proposed: "2025-03-15-1400",
          guess: "Prefers concrete next steps over open-ended advice",
          falsifyIf: "She asks for exploration without an action plan",
        },
      ],
    });
    const sections = md.split("\n").filter((l) => l.startsWith("# "));
    expect(sections).toEqual(["# Portrait", "# Hypotheses"]);
    expect(md).toContain(
      "- Builds structure before acting under uncertainty. — refs: 2025-03-15-1400, 2025-03-20-0900",
    );
    // Hypothesis lines follow the kernel's fixed per-line format
    expect(md).toContain(
      "- [proposed 2025-03-15-1400] Prefers concrete next steps over open-ended advice — falsify if: She asks for exploration without an action plan",
    );
  });

  it("writes seeded playbooks only for provided agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-"));
    dirs.push(root);
    await writeEvolutionFiles(
      root,
      fakeBible({ playbooks: { recall: "Read full slices on emotional topics." } }),
    );
    const recall = await readFile(join(root, "agent-playbooks", "recall.md"), "utf8");
    expect(recall).toBe("Read full slices on emotional topics.");
    await expect(
      readFile(join(root, "agent-playbooks", "search.md"), "utf8"),
    ).rejects.toThrow();
  });
});
