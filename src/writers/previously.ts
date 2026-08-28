import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import type { Direction, Mutation, Persona, Playbooks, Slice, StoryBible } from "../core/ir.js";
import { localParts } from "../core/calendar.js";

/** Directory layout mirroring Previously: episodic/slices/YYYY/MM/DD/HHMM.
 *  The path is derived from the persona's LOCAL time, matching real usage. */
export function sliceDir(root: string, slice: Slice): string {
  const p = localParts(slice.start, slice.timezone);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return join(
    root,
    "episodic",
    "slices",
    String(p.year),
    String(p.month).padStart(2, "0"),
    String(p.day).padStart(2, "0"),
    `${hh}${mm}`,
  );
}

/** Remote path fragment for strands and indexes: YYYY/MM/DD/HHMM. */
export function slicePath(slice: Slice): string {
  const p = localParts(slice.start, slice.timezone);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return [
    String(p.year),
    String(p.month).padStart(2, "0"),
    String(p.day).padStart(2, "0"),
    `${hh}${mm}`,
  ].join("/");
}

function sliceMonth(slice: Slice): string {
  const p = localParts(slice.start, slice.timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

function sliceDate(slice: Slice): string {
  const p = localParts(slice.start, slice.timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function addressAs(name: string): string {
  const first = name.split(/\s+/)[0];
  return first || name;
}

export function renderCoreMd(slice: Slice): string {
  const fm = stringify({
    slice_id: slice.sliceId,
    focus: slice.marking?.focus ?? "",
    status: "closed",
    start: slice.start.toISOString(),
    end: slice.end.toISOString(),
    timezone: slice.timezone,
    summary: slice.marking?.summary ?? "",
    tags: slice.marking?.tags ?? [],
    open_loops: slice.marking?.open_loops ?? [],
    emotional_tone: slice.marking?.emotional_tone ?? "",
  }).trim();
  const body = slice.turns
    .map((t, i) => `## Turn ${i + 1} — ${t.at.toISOString()} (${t.role})\n\n${t.text}`)
    .join("\n\n");
  return `---\n${fm}\n---\n\n${body}\n`;
}

export function renderPreviouslyMd(slice: Slice): string {
  if (slice.previously) return slice.previously;
  const date = sliceDate(slice);
  return `# Previously On\n\n_Active slice: ${slice.sliceId} | Updated: ${date}_\n\n## 长期记忆\n\n### User identity\n\n_No beliefs yet._\n\n### User patterns\n\n_No beliefs yet._\n\n### Agent strategies\n\n_No beliefs yet._\n\n## 短期记忆\n\n### Current context\n\n_No beliefs yet._\n`;
}

export function renderAgentMd(): string {
  return "";
}

export function renderProfileMd(persona: Persona, timezone: string): string {
  const fm = stringify({
    name: persona.name,
    timezone,
    locale: "en",
    address_as: addressAs(persona.name),
  }).trim();
  return `---\n${fm}\n---\n${persona.summary}\n`;
}

export function renderCurrentPreviously(persona: Persona, slices: Slice[]): string {
  const last = slices[slices.length - 1];
  if (last?.previously) {
    return last.previously;
  }
  const updated = last ? new Date().toISOString() : new Date().toISOString();
  return `# Previously On\n\n_Active slice: ${last?.sliceId ?? "none"} | Format: user card v2 | Updated: ${updated}_\n\n## Identity\n\n- Name: ${persona.name}\n- Address them as: ${addressAs(persona.name)}\n- Locale: en\n- Timezone: ${last?.timezone ?? "UTC"}\n\n## Past\n\n${persona.summary}\n\n## Now\n\n_No active hooks._\n\n## Horizon\n\n_No open commitments._\n\n## Self-model\n\n- Treat this as read-only seed data; evolve only from real conversation turns.\n`;
}

export function renderTimelineMd(slices: Slice[]): string {
  const sorted = [...slices].sort((a, b) => b.start.getTime() - a.start.getTime());
  const lines: string[] = [
    "# Timeline",
    "",
    `_Generated: ${new Date().toISOString()}_`,
    `_Slices: ${slices.length}_`,
    "_Needs marking: 0_",
    "_Schema: 1_",
    "",
  ];

  let currentMonth = "";
  let currentDay = "";
  for (const slice of sorted) {
    const month = sliceMonth(slice);
    const day = sliceDate(slice).slice(5); // MM-DD
    if (month !== currentMonth) {
      currentMonth = month;
      currentDay = "";
      lines.push(`## ${month}`);
    }
    if (day !== currentDay) {
      currentDay = day;
      lines.push(`### ${day}`);
    }
    const turns = `${slice.turns.length} turns`;
    const tone = slice.marking?.emotional_tone ?? "neutral";
    const tags = (slice.marking?.tags ?? []).join(",");
    const focus = slice.marking?.focus ?? "";
    lines.push(
      `- **${slice.sliceId}** ${focus} · ${turns} · ${tone} [${tags}]`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ─── v1.0 evolution data layer (kernel: memory/evolution/, agent-playbooks/) ─

/** Byte-identical copy of the kernel's minimal direction.md template
 *  (Aftrbrez src/lib/evolution/store.ts DIRECTION_TEMPLATE) — used when the
 *  story bible does not seed its own direction. */
const DIRECTION_TEMPLATE = `# Direction

_(Not set yet — what "better for the user" means across slices gets written here.)_

# Anti-goals

_(Not set yet — the drift guardrails: what we must NOT evolve into.)_

# Evidence

_(Each direction conclusion links its supporting slice pointers here.)_

# Log

_(Append-only: when the direction changed, and on what evidence.)_
`;

/** Byte-identical copy of the kernel's mutations archive header
 *  (Aftrbrez src/lib/evolution/store.ts MUTATIONS_HEADER). */
const MUTATIONS_HEADER = `# Mutations Archive

Append-only log of accepted evolution mutations (design v1.0 §2.7). No
automatic rollback, no cooldown, no mutation budget — a mutation that proves
ineffective is marked \`ineffective\` here later, never deleted.
`;

export function renderDirectionMd(direction?: Direction): string {
  if (!direction) return DIRECTION_TEMPLATE;
  return [
    "# Direction",
    "",
    direction.direction.trim(),
    "",
    "# Anti-goals",
    "",
    direction.antiGoals.trim(),
    "",
    "# Evidence",
    "",
    direction.evidence.trim() ||
      "_(Each direction conclusion links its supporting slice pointers here.)_",
    "",
    "# Log",
    "",
    direction.log.trim() ||
      "_(Append-only: when the direction changed, and on what evidence.)_",
    "",
  ].join("\n");
}

/** Byte-compatible with the kernel's renderMutationRecord (store.ts). */
export function renderMutationRecord(m: Mutation): string {
  const evidence = m.evidence.length
    ? m.evidence.map((e) => `  - ${e}`).join("\n")
    : "  - (none recorded)";
  return [
    `## ${m.ts} — ${m.target}`,
    "",
    `- **Summary:** ${m.summary}`,
    `- **Expected benefit:** ${m.expectedBenefit}`,
    `- **Evidence:**`,
    evidence,
  ].join("\n");
}

export function renderMutationsMd(mutations: Mutation[]): string {
  if (mutations.length === 0) return MUTATIONS_HEADER;
  return `${MUTATIONS_HEADER}\n${mutations.map(renderMutationRecord).join("\n\n")}\n`;
}

/** Writes evolution/direction.md, evolution/mutations.md, and any seeded
 *  agent-playbooks/. fitness.json is deliberately NOT written — the kernel
 *  degrades a missing store to empty (readFitness). Returns written paths. */
export async function writeEvolutionFiles(
  root: string,
  story: StoryBible,
): Promise<string[]> {
  const written: string[] = [];
  const evolutionDir = join(root, "evolution");
  await mkdir(evolutionDir, { recursive: true });
  const directionFile = join(evolutionDir, "direction.md");
  await writeFile(directionFile, renderDirectionMd(story.direction), "utf8");
  written.push(directionFile);
  const mutationsFile = join(evolutionDir, "mutations.md");
  await writeFile(mutationsFile, renderMutationsMd(story.mutations), "utf8");
  written.push(mutationsFile);

  const playbooks: Playbooks | undefined = story.playbooks;
  if (playbooks) {
    const dir = join(root, "agent-playbooks");
    await mkdir(dir, { recursive: true });
    for (const agent of ["recall", "search", "thinkdeep"] as const) {
      const content = playbooks[agent];
      if (!content) continue;
      const file = join(dir, `${agent}.md`);
      await writeFile(file, content, "utf8");
      written.push(file);
    }
  }
  return written;
}

export interface MonthlyIndex {
  month: string;
  slices: {
    id: string;
    focus: string;
    summary: string;
    tags: string[];
    status: string;
    start: string;
    open_loops: string[];
    decisions: string[];
  }[];
}

export function buildMonthlyIndexes(slices: Slice[]): Map<string, MonthlyIndex> {
  const sorted = [...slices].sort((a, b) => a.start.getTime() - b.start.getTime());
  const map = new Map<string, MonthlyIndex>();
  for (const slice of sorted) {
    const month = sliceMonth(slice);
    let entry = map.get(month);
    if (!entry) {
      entry = { month, slices: [] };
      map.set(month, entry);
    }
    entry.slices.push({
      id: slice.sliceId,
      focus: slice.marking?.focus ?? "",
      summary: slice.marking?.summary ?? "",
      tags: slice.marking?.tags ?? [],
      status: "closed",
      start: slice.start.toISOString(),
      open_loops: slice.marking?.open_loops ?? [],
      decisions: [],
    });
  }
  return map;
}

export function buildStrands(slices: Slice[]): Record<string, string[]> {
  const map = new Map<string, string[]>();
  const sorted = [...slices].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const slice of sorted) {
    const path = slicePath(slice);
    for (const tag of slice.marking?.tags ?? []) {
      const list = map.get(tag) ?? [];
      list.push(path);
      map.set(tag, list);
    }
  }
  const sortedKeys = [...map.keys()].sort();
  const result: Record<string, string[]> = {};
  for (const key of sortedKeys) {
    result[key] = map.get(key)!;
  }
  return result;
}

interface TreeNode {
  _files?: string[];
  [key: string]: TreeNode | string[] | undefined;
}

export function buildManifestTree(slices: Slice[], playbookAgents: string[] = []): TreeNode {
  const sorted = [...slices].sort((a, b) => a.start.getTime() - b.start.getTime());
  const slicesTree: TreeNode = {};

  for (const slice of sorted) {
    const p = localParts(slice.start, slice.timezone);
    const year = String(p.year);
    const month = String(p.month).padStart(2, "0");
    const day = String(p.day).padStart(2, "0");
    const hh = String(p.hour).padStart(2, "0");
    const mm = String(p.minute).padStart(2, "0");
    const hhmm = `${hh}${mm}`;

    const yNode = (slicesTree[year] ?? {}) as TreeNode;
    slicesTree[year] = yNode;

    const mNode = (yNode[month] ?? {}) as TreeNode;
    yNode[month] = mNode;
    mNode._files = ["_index.json"];

    const dNode = (mNode[day] ?? {}) as TreeNode;
    mNode[day] = dNode;

    const sNode: TreeNode = {
      _files: ["previously.md"],
      timeline: {
        _files: ["agent.md", "core.md"],
      },
    };
    dNode[hhmm] = sNode;
  }

  const tree: TreeNode = {
    user: {
      _files: ["profile.md"],
    },
    episodic: {
      _files: ["current-previously.md", "strands.json", "timeline.md"],
      slices: slicesTree,
    },
    evolution: {
      _files: ["direction.md", "mutations.md"],
    },
  };
  if (playbookAgents.length > 0) {
    tree["agent-playbooks"] = {
      _files: playbookAgents.map((a) => `${a}.md`),
    };
  }
  return tree;
}

export interface Manifest {
  version: number;
  personas: Record<string, {
    name: string;
    description: string;
    blurb: string;
    topics: string[];
    sliceCount: number;
    dateRange: [string, string];
    tree: TreeNode;
  }>;
}

export function buildManifest(persona: Persona, slices: Slice[], playbooks?: Playbooks): Manifest {
  const sorted = [...slices].sort((a, b) => a.start.getTime() - b.start.getTime());
  const id = persona.name.toLowerCase().replace(/\s+/g, "-");
  const startMonth = sorted.length > 0 ? sliceMonth(sorted[0]) : "";
  const endMonth = sorted.length > 0 ? sliceMonth(sorted[sorted.length - 1]) : "";
  const tagSet = new Set<string>();
  for (const slice of slices) {
    for (const tag of slice.marking?.tags ?? []) tagSet.add(tag);
  }
  const topics = [...tagSet].sort();
  const blurb = persona.summary.length > 200
    ? `${persona.summary.slice(0, 200)}…`
    : persona.summary;
  const playbookAgents = playbooks
    ? (["recall", "search", "thinkdeep"] as const).filter((a) => playbooks[a])
    : [];
  return {
    version: 1,
    personas: {
      [id]: {
        name: persona.name,
        description: `${slices.length} sessions across ${startMonth} → ${endMonth}`,
        blurb,
        topics,
        sliceCount: slices.length,
        dateRange: [startMonth, endMonth],
        tree: buildManifestTree(slices, playbookAgents),
      },
    },
  };
}

export async function writeSliceFiles(root: string, slice: Slice): Promise<string> {
  const dir = sliceDir(root, slice);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "previously.md"), renderPreviouslyMd(slice), "utf8");
  const timelineDir = join(dir, "timeline");
  await mkdir(timelineDir, { recursive: true });
  await writeFile(join(timelineDir, "core.md"), renderCoreMd(slice), "utf8");
  await writeFile(join(timelineDir, "agent.md"), renderAgentMd(), "utf8");
  return join(dir, "previously.md");
}

export async function writeSlice(root: string, slice: Slice): Promise<string> {
  const dir = join(sliceDir(root, slice), "timeline");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "core.md");
  await writeFile(file, renderCoreMd(slice), "utf8");
  return file;
}

export async function writePreviouslyDataset(
  root: string,
  story: StoryBible,
  slices: Slice[],
): Promise<string> {
  const persona = story.persona;
  const sorted = [...slices].sort((a, b) => a.start.getTime() - b.start.getTime());
  if (sorted.length === 0) {
    throw new Error("Cannot write Previously dataset with no slices");
  }
  const timezone = sorted[0].timezone;

  // user/profile.md
  const userDir = join(root, "user");
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, "profile.md"), renderProfileMd(persona, timezone), "utf8");

  // episodic/ root files
  const episodicDir = join(root, "episodic");
  await mkdir(episodicDir, { recursive: true });
  await writeFile(
    join(episodicDir, "current-previously.md"),
    renderCurrentPreviously(persona, sorted),
    "utf8",
  );
  await writeFile(join(episodicDir, "strands.json"), JSON.stringify(buildStrands(sorted), null, 2), "utf8");
  await writeFile(join(episodicDir, "timeline.md"), renderTimelineMd(sorted), "utf8");

  // monthly indexes
  const monthly = buildMonthlyIndexes(sorted);
  for (const [month, index] of monthly) {
    const [year, mm] = month.split("-");
    const idxDir = join(episodicDir, "slices", year, mm);
    await mkdir(idxDir, { recursive: true });
    await writeFile(join(idxDir, "_index.json"), JSON.stringify(index, null, 2), "utf8");
  }

  // per-slice files
  for (const slice of sorted) {
    const dir = sliceDir(root, slice);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "previously.md"), renderPreviouslyMd(slice), "utf8");
    const timelineDir = join(dir, "timeline");
    await mkdir(timelineDir, { recursive: true });
    await writeFile(join(timelineDir, "core.md"), renderCoreMd(slice), "utf8");
    await writeFile(join(timelineDir, "agent.md"), renderAgentMd(), "utf8");
  }

  // v1.0 evolution data layer: evolution/ + agent-playbooks/
  await writeEvolutionFiles(root, story);

  return episodicDir;
}
