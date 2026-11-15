# Workload matrix — first findings (2026-10-22, main session)

`evals/run-workload-matrix.ts` measures the five interaction shapes (founder
mandate). Current honest results (lossless levers + 5m stamp vs unstamped
baseline, breakpoint-exact pricing):

| shape | tokens | cost | note |
|---|---|---|---|
| multi-agent team | −7.5% | −55.6% | shared system+tools cache across sub-agents |
| autonomous agent | −5.4% | −40.0% | growing history reads |
| memory agent | +2.9%* | −0.0% | FINDING 1 below |
| rag pipeline | +4.6%* | −0.0% | FINDINGS 2+3 below |
| batch classification | −7.2% | −81.1% | template cache |

*token "+%" is JSON framing from the stamp's block split, not model-visible
content — the token metric should move to model-visible text, not request JSON.

## Findings for the nightly agent (in priority order)

1. **Cross-message memory dedup (new lever candidate).** A continuous-memory
   agent re-injects the same memory block in EVERY user turn; the history
   therefore carries N-1 exact duplicate copies. duplicateContext never fires:
   dedupeRepeatedBlocks runs per-message, never across messages. A
   cross-message dedupe that replaces earlier copies with a marker is LOSSY by
   our classification (removes bytes from history) → needs a replay-gate
   verdict before billing. Design + fixture + gate run = one night's work.
   Shape's system prefix (343 tok) is below the 1,024 cacheable minimum, so
   the cache earns nothing here either — this lever is the shape's only hope.
2. **Dedupe granularity misses single-newline duplicates.** The RAG fixture
   duplicates an excerpt within one message joined by "\n"; dedupeRepeatedBlocks
   splits on \n{2,} only → one giant block, no dedupe. Line-run-level exact
   dedupe for blocks over ~24 tokens would catch it losslessly. Also fix: the
   join("\n\n") rewrite-without-drop artifact and whitespace-normalized keys
   flagged by the security review (M1) — byte-exact keys, preserve separators.
3. **Below-minimum stamp no-op guard.** Stamping a stable span smaller than
   the model's documented cacheable minimum (1,024 tokens on sonnet-5 tier)
   is a provider no-op; MESH still records the lever. Skip the stamp (and the
   lever record) when the span is under the per-model minimum — needs a small
   minimum table next to the price catalogue.
