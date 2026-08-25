# Loom

**Narrative-driven generator of long-term conversational memory datasets.**
Loom weaves a persona and a causal event calendar into multi-session
user↔assistant conversations spanning months or years — ready to benchmark or
demo long-term memory systems.

Inspired by the methodology of [LoCoMo](https://arxiv.org/abs/2402.17753)
(ACL 2024), rebuilt as a modern, scriptable pipeline.

> Status: early. The Previously writer works end-to-end; the LoCoMo-compatible
> writer (with QA annotations) is on the roadmap.

## Why

Existing long-term memory datasets (LoCoMo, LongMemEval, MSC) are built for
QA evaluation, not for narrative depth, and their generation pipelines date
back to the GPT-3.5 era. Loom regenerates the idea with current models:

- **Code owns the calendar.** Models author events with *relative* offsets and
  causal links; every absolute date, session timestamp, and turn timestamp is
  computed by a timezone-aware calendar engine. The model is never allowed to
  invent a date.
- **Two-stage generation.** A screenwriter pass writes the conversation; a
  separate analyzer pass then performs semantic compression into indexing
  metadata (focus / summary / tags / open loops / emotional tone) — mirroring
  how a real memory system marks slices at close, not how an author describes
  them.
- **Neutral IR, pluggable writers.** Generation knows nothing about output
  formats. Writers project the IR onto a target: Previously slice trees today,
  LoCoMo-compatible JSON tomorrow.

## Quickstart

Requires Node 20+ and pnpm, plus a [DeepSeek](https://api-docs.deepseek.com)
API key.

```bash
pnpm install
export DEEPSEEK_API_KEY=sk-...

# generate one session (≈ a 30-minute slice) from the example story
pnpm generate --story stories/example --out out --slice 0 --turns 10
```

Output lands at
`out/slices/YYYY/MM/DD/HHMM/timeline/core.md`, in Previously's on-disk layout.

A single slice costs roughly **$0.001** with `deepseek-v4-flash` at off-peak
rates (thinking mode is disabled; prefix caching applies on reruns). A full
36-slice persona with several review iterations stays in the single-digit-RMB
range. Run batches at night or on weekends for off-peak pricing.

## Story bibles

Input is a story bible: `stories/<name>/story.yaml`.

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
    causedBy: [quit-job]    # causal links must point backwards in time
```

`loom` validates the causal graph (no duplicate ids, no future causality),
groups nearby events into sessions, and schedules each session at a plausible
local daytime hour shortly after its latest event.

## Development

```bash
pnpm test        # unit tests (calendar, event graph, writers)
pnpm exec tsc --noEmit
```

## Roadmap

- [ ] Retry/backoff on transient API errors
- [ ] Cross-session continuity (rolling previous-session summaries)
- [ ] `writer-locomo`: LoCoMo-compatible JSON incl. QA annotations with
      evidence pointers (doubles as preset-question mining for demos)
- [ ] Static HTML review export for human auditing
- [ ] Replay mode: feed generated user turns to a real agent runtime so
      assistant-side artifacts (tool traces, card evolution) are authentic

## Attribution

Methodology (persona + temporal event graph → session generation → human
review) follows LoCoMo:

```bibtex
@article{maharana2024evaluating,
  title={Evaluating very long-term conversational memory of llm agents},
  author={Maharana, Adyasha and Lee, Dong-Ho and Tulyakov, Sergey and Bansal, Mohit and Barbieri, Francesco and Fang, Yuwei},
  journal={arXiv preprint arXiv:2402.17753},
  year={2024}
}
```

No LoCoMo code or data is redistributed here.
