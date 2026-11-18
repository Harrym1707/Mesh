# Evidence — every published number, traced

Each figure on this site maps to the command that produces it and the commit it
was verified at. Reproduce any of them from the repo root. (Numbers were
independently re-verified by a checker separate from the implementer at each
listed commit; the harness run prints every row below.)

Harness: `node --import tsx evals/run-agent-ab.ts` · tests:
`./node_modules/.bin/vitest run` (354 passing) · gates: the three suites under
`evals/run-*-triage.ts` and `evals/run-analysis-regression.ts` against freshly
generated fixtures (27/27).

| Published figure | Where it comes from | Verified at |
|---|---|---|
| Async 64.3% ceiling / **57.7% net** (quote the net) | arm K rows, async-eligible segment: ceiling assumes 0% tier fallback; net assumes 10% default + 5% 429-retry, priced per event at the SERVED tier | `4e51734` |
| Interactive 25.9–29.4% | arm J across openai-30s / openai-600s / anthropic-5m blocks, clean 38/40 | `c7b03d4`, re-verified `4e51734` |
| Proxy mode: zero-code integration | `packages/sdk-js/src/proxy.ts` + `evals/run-proxy.ts`; e2e tests cover reduction-before-forward, byte-identical passthrough, SSE streaming with usage parsed after the last byte, per-app hash chains, credential passthrough | `d31b125` |
| Proxy overhead: adds ~22 ms p50 / ~24 ms p95 / ~30 ms p99 per request | `node --import tsx evals/run-proxy-overhead.ts` — proxied minus direct against the same instant loopback stub, 800 requests/arm at concurrency 8, ~31 KB agent request bodies, full lossless stack + 5m cache stamp + ledger append (darwin/arm64; absolute values vary by machine — rerun the command on yours). Against provider calls measured in seconds this is under 1% of request latency | run 2026-10-20 |
| **THIRD live export: 18.2% of real spend** ($0.0365 of $0.2010), hash chains verified, spools committed to this repo | `MESH_LIVE_KEEP=1 node --import tsx evals/run-live-agents.ts` on claude-sonnet-5-5, 30 requests. Coding-agent $0.0225/38.1% — the cache placement that LOST −$0.0063 in export #2 now earns: the volatility guard shipped in between refuses the volatile-prefix stamp. Rag $0.0086/22.0%, support $0.0054/10.3%, already-lean $0 (correct). Batch-classifier $0: the minimum guard suppressed its stamp, and the provider's own `count_tokens` API confirms the prefix is 927 real tokens — under Anthropic's documented 1024 cacheable minimum, so the suppression is right. That contradicts export #2's batch claim (below), which can no longer be re-audited; receipts are retained from now on. Spools: `evals/live-exports-2026-10-26/` — verify them yourself with mesh-verify | run 2026-10-26 |
| SECOND live export: 18.0% of real spend, every active agent billing | `evals/run-live-agents.ts` keyed rerun with the 5m cache stamp + the freshcap gate verdict wired: coding-agent $0.0206 (cap+schemas net of a −$0.0063 cache miss from its per-turn clock), batch-classifier +$0.0101 (cache stamp EARNING live, 6,286 reads — the one figure export #3's count_tokens check now contradicts: the batch prefix is under the provider's cacheable minimum, and these spools were not retained to re-audit, a process failure we fixed by committing export #3's spools), rag $0.0086, support $0.0054, already-lean $0 | run 2026-10-19, spools audited in session, not retained |
| Multi-turn Claude cache-only comparison: 37.9% | `node --import tsx evals/run-cache-decomposition.ts` — J + 5m stamp vs the identical J stack with cache disabled; both arms clean 38/40, 97% hits, 200/200 stamps metadata-only. Isolates the pure cache effect | re-verified `6f08b72` (was 37.6% at `6249f86`; moves with the newline fix below) |
| Full J + 5m stack vs raw uncached A: 57.3% lower simulated cost | same decomposition script, row 2: quality 38/40 vs the raw baseline's 40/40 (−5 pp; within the published >=36/40 gate, but a real delta) — quote 37.9% for the cache lever and label this one with its quality cost | re-verified `6f08b72` (was 57.1% at `6249f86`) |
| Sparse interactive 34.3% | arm L, 1h cache TTL via the shipped `cacheTtl` stamp (stable-prefix placement), 600s spacing | fixed and re-verified `6f08b72`: ab210c1's stable/tail split silently dropped the separating newline between the two blocks, a model-visible content change; arm L's own metadata-only guard had started hard-crashing on it (and the eval's comparison helper had never been updated for the two-block shape). Was 34.0% at `67eeac6`, unreproducible between `ab210c1` and `6f08b72`. |
| First real-traffic export: 9.3% net of spend | `evals/run-live-agents.ts`, 30 requests on claude-sonnet-5-5; a smoke run, NOT a band — lossy levers were recorded-unbilled and the old cache placement lost money (per-agent outcomes ranged −24% to +34% of that agent's spend) | `d84e256` run 2026-10-19, superseded by the second export |
| One-shot 45.5% / 72.8% | one-shot section, arms H and I ($0.569 → $0.310 / $0.155) | `7b08666`, re-verified `4e51734` |
| Provider cache's own 35–40% (never claimed by MESH) | "what the cache itself is worth" section of the harness output | `33028df` onward |
| "Do not pay us" 0–5% | support-assistant fixture, 77% pre-cached, triage verdict | `ff04a70` |
| Replay gate approving fresh-cap at 0.00 quality delta and rejecting the 2000-token output cap at −5.50pp | `evals/run-replay-gate-freshcap.ts` | `ab5b4c7` |
| Ledger determinism, exclusions, recomputable invoice | `packages/core/src/savings-ledger.test.ts`; canonical-invoice contract | `597e842`, `10407bf` |

## Open items (also stated wherever the affected number appears)

- **Concurrent multi-agent fan-out races the cache (found 2026-11-18, see
  `docs/rnd/2026-11-18-NOTES.md`).** The existing `cache-ttl-5m`/`cache-ttl-1h`
  lever, applied with no concurrency awareness, LOSES money versus not
  caching at all when several requests sharing one prefix are sent in the
  same instant (every racer writes, none read) — measured at +16.2% worse
  than uncached on a 3/5/10-sub-agent fixture
  (`node --import tsx evals/run-fanout-race.ts`). No published figure above
  is affected (they come from `run-agent-ab.ts`'s non-concurrent traffic),
  but this is a real risk on multi-agent deployments today. A lossless fix
  (`FanoutLatch`, `packages/sdk-js/src/fanout-latch.ts`) ships opt-in and
  off by default, pending a real TTFB measurement to size its hold cap —
  not yet validated on live traffic.
- Anthropic's own docs (fetched 2026-11-18) list Sonnet 5.5's and Opus 5.5's
  cacheable minimum as 512 tokens; `model-prices.ts`'s
  `anthropicCacheableMinimumTokens` (captured 2026-10-08) still returns
  1,024 for both. Flagged for verification, not yet corrected — see the
  2026-11-18 NOTES.
- Per-model cacheable minimums not yet simulated → 34.3% may overstate on some
  models.
- Anthropic batch rate NOW catalogued (2026-10-27): the pricing page states a
  definitive "Save 50% with batch processing", so Anthropic batch events price
  natively at half standard. The workload matrix now evaluates batch-routing
  against caching per shape and picks the cheaper (`evals/run-workload-matrix.ts`).
- Package freshness gate and automated CJS smoke not yet in the build script
  (the CJS tarball was smoke-tested manually at `4e51734`).
- **The banded figures are simulator-measured.** A first real-traffic export
  exists (30 requests, see the table) and found one lever losing money on
  one-shot traffic — fixed at `ec191c5` and re-verified. The bands stay
  simulator-labelled until a pilot-scale export replaces them.

## Independent sources cited on the comparison page

- codepointer.dev — 614M-token replay of rtk/headroom/caveman: 3.7% actual.
- archestra.ai — progressive disclosure: ~77% modelled vs ~13% measured.
- RouterArena (arXiv:2510.00202) — independent router leaderboard.
- Anthropic & OpenAI published pricing pages — all rates in
  `packages/core/src/model-prices.ts` carry source URL and capture date.
