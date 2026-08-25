# Loom

**Narrative-driven generator of long-term conversational memory datasets.**
Loom weaves a persona and a causal event calendar into multi-session
user↔assistant conversations spanning months or years — ready to benchmark or
demo long-term memory systems.

Loom is developed by the [Previously](https://previously.ldwid.com) project.
Previously itself stores memory in its own on-disk slice format, and Loom
writes that format natively — but Loom is a **general-purpose tool**, built to
be useful to anyone evaluating long-term memory: it also emits
**LoCoMo-compatible JSON**, so datasets generated here plug directly into the
benchmark harnesses the community already runs.

## Relationship to LoCoMo

[LoCoMo](https://arxiv.org/abs/2402.17753) (ACL 2024, 800+ citations) is the
de-facto standard benchmark for very long-term conversational memory, and its
core methodology — persona + temporal event graph driving multi-session
generation — remains sound. Its *implementation*, however, dates from the
GPT-3.5 era: turn-by-turn generation resending the full transcript per turn,
string-parsed JSON, an image pipeline most users don't need, and a dataset
whose annotation errors the community is still patching years later
([#27](https://github.com/snap-research/locomo/issues/27),
[#40](https://github.com/snap-research/locomo/issues/40),
[#43](https://github.com/snap-research/locomo/issues/43)).

Loom keeps the methodology and rebuilds everything around it:

- **Code owns the calendar.** Models author events with *relative* offsets and
  causal links (`causedBy`); every absolute date, weekday, session timestamp,
  and turn timestamp is computed by a timezone-aware calendar engine. The
  model is never allowed to write a date — the entire class of "wrong weekday"
  annotation bugs (locomo #40) is eliminated by construction.
- **Whole-session generation.** One call writes one session with structured
  JSON output — cheaper and more coherent than per-turn resampling, and
  retried with backoff plus a corrective re-ask when output fails validation.
- **Validation is part of the pipeline, not an afterthought.** A pure-code
  temporal lint cross-checks weekday/date mentions against the calendar; QA
  evidence pointers are verified to resolve against real dialog ids, with
  adversarial (unanswerable) items kept in a separate `adversarial_answer`
  field (locomo #11/#41).
- **Two-stage semantics.** A screenwriter pass writes dialogue; a separate
  analyzer pass compresses each finished session into indexing metadata
  (focus / summary / tags / open loops / emotional tone) — mimicking how a
  real memory system marks slices at close, not how an author would
  describe them.
- **Personas and event graphs ship with the data.** LoCoMo never released its
  persona definitions ([#24](https://github.com/snap-research/locomo/issues/24));
  in Loom they *are* the input, so every dataset is fully reproducible from
  its story bible.

## How it works

```
story bible (YAML)          persona + events with relative offsets & causal links
      │
      ▼
calendar engine             absolute dates, session schedule, turn timestamps
      │
      ▼
screenwriter generation     one LLM call per session, foreground/background
      │                     event layering, rolling cross-session summary
      ▼
analyzer + lint             marking metadata; temporal consistency checks
      │
      ▼
writers                     Previously slice tree · LoCoMo-compatible JSON
```

A story bible looks like this:

```yaml
persona:
  name: Maya Chen
  summary: >-
    A 29-year-old indie developer in Hangzhou building a habit-tracking app…
startDate: "2025-03-01"
timezone: Asia/Shanghai
events:
  - id: quit-job
    dayOffset: 0            # relative — the calendar engine assigns the date
    title: Maya gives notice at her fintech job
    detail: …
  - id: first-beta
    dayOffset: 10
    title: Tidepool closed beta goes live
    detail: …
    causedBy: [quit-job]    # causal links must point strictly backwards
```

## Quickstart

Requires Node 20+, pnpm, and a [DeepSeek](https://api-docs.deepseek.com) API key.

```bash
pnpm install
export DEEPSEEK_API_KEY=sk-...

# one session (a ~30-minute slice), standalone
pnpm generate --story stories/example --slice 0

# the full arc, with cross-session continuity and 8 QA annotations
pnpm generate --story stories/example --all --qa 8

# only one output format
pnpm generate --story stories/example --all --format locomo     # out/locomo.json
pnpm generate --story stories/example --all --format previously # out/slices/...
```

Useful flags: `--turns N` (turns per session), `--gap-days N` and
`--max-events N` (pacing), `--seed N` (deterministic scheduling),
`--max-cost USD` (hard budget guard, aborts when exceeded).

Previously output lands at `out/slices/YYYY/MM/DD/HHMM/timeline/core.md`;
LoCoMo output is `out/locomo.json`, an array of samples in the
`locomo10.json` shape (`conversation` with `Dn:m` dialog ids,
`session_summary`, `event_summary`, `qa`).

## Cost

Measured with `deepseek-v4-flash` at off-peak rates (thinking disabled;
prefix caching applies on reruns):

| Workload | Tokens | Cost |
|---|---|---|
| One 10-turn slice (generate + mark + summarize) | ~2k in / ~1.2k out | ~$0.001 |
| Two sessions + 4 QA items (full pipeline) | ~5k in / ~1.8k out | ~$0.003 |

A full 36-slice persona with several review iterations stays in the
single-digit-RMB range. Run batches at night or on weekends for off-peak
pricing; `--max-cost` is the hard guard.

## Development

```bash
pnpm test        # unit tests (calendar, event graph, consistency, writers, retry)
pnpm exec tsc --noEmit
```

## Known limitations

- **Adversarial QA needs human review.** The generator can produce
  "unanswerable" questions that are actually answerable from the transcript —
  the exact bug class tracked in locomo #43. `validateQa` guarantees pointers
  resolve; semantic correctness is yours to audit.
- Screenwriter mode writes both roles in one call, so dialogue can be
  smoother than real chat. A replay mode (feeding generated user turns to a
  real agent runtime) is on the roadmap.
- DeepSeek is the only built-in provider for now.

## Roadmap

- [ ] Replay mode for authentic assistant-side artifacts (tool traces, card
      evolution)
- [ ] Static HTML review export for human auditing
- [ ] Previously index aggregation (`timeline/index.json`, `strands.json`)
- [ ] Additional providers

## Attribution

Methodology (persona + temporal event graph → session generation → human
review) follows LoCoMo. No LoCoMo code or data is redistributed here.

```bibtex
@article{maharana2024evaluating,
  title={Evaluating very long-term conversational memory of llm agents},
  author={Maharana, Adyasha and Lee, Dong-Ho and Tulyakov, Sergey and Bansal, Mohit and Barbieri, Francesco and Fang, Yuwei},
  journal={arXiv preprint arXiv:2402.17753},
  year={2024}
}
```

## License

MIT (code). Generated datasets are yours; if you publish one, a citation of
this repo and the LoCoMo paper is appreciated.
