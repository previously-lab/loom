// One-off repair: sync .loom-state.json with on-disk slice files.
// Disk is the source of truth (it carries hand-applied fixes that state missed).
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2]; // e.g. ../you/user
const statePath = join(root, ".loom-state.json");
const state = JSON.parse(await readFile(statePath, "utf8"));

// Walk episodic/slices/YYYY/MM/DD/HHMM/timeline/core.md
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name === "core.md") yield p;
  }
}

function parseTurns(body) {
  // ## Turn N — <ISO> (<role>)\n\n<text until next header or EOF>
  const re = /## Turn \d+ — (\S+) \((user|assistant)\)\n\n/g;
  const matches = [...body.matchAll(re)];
  return matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    return { at: m[1], role: m[2], text: body.slice(start, end).trimEnd() };
  });
}

let synced = 0, missed = 0;
for await (const corePath of walk(join(root, "episodic", "slices"))) {
  let raw = await readFile(corePath, "utf8");
  if (raw.includes("\r\n")) {
    // Normalize hand-edited CRLF files to LF (repo convention; git autocrlf
    // treats them as identical anyway).
    raw = raw.replace(/\r\n/g, "\n");
    await writeFile(corePath, raw, "utf8");
    console.log("[eol] normalized to LF:", corePath);
  }
  const sliceId = raw.match(/slice_id:\s*(\S+)/)?.[1];
  if (!sliceId) { console.log("[skip] no slice_id in", corePath); continue; }
  const entry = state.slices.find((s) => s.sliceId === sliceId);
  if (!entry) { console.log("[miss] state has no entry for", sliceId); missed++; continue; }
  const body = raw.split("---\n").slice(2).join("---\n");
  const turns = parseTurns(body);
  if (turns.length < 2) { console.log("[warn] few turns in", sliceId); }
  entry.turns = turns;
  const prevPath = join(corePath, "..", "..", "previously.md");
  try {
    let prev = await readFile(prevPath, "utf8");
    if (prev.includes("\r\n")) {
      prev = prev.replace(/\r\n/g, "\n");
      await writeFile(prevPath, prev, "utf8");
    }
    entry.previously = prev;
  } catch { /* no previously.md */ }
  synced++;
}

await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
console.log(`synced ${synced} slice(s), missed ${missed}`);
