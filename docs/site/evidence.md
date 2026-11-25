# Evidence: every Mesh savings figure, with its label, date and the levers it needed

Mesh is a local proxy for LLM API traffic, and this page traces each figure
the site quotes to the command that produces it, the date it was measured and
the levers that were switched on when it was measured.

Last updated: 2026-11-24.

## What a fresh install does today

Out of the box Mesh makes three lossless changes to a request: tool-schema
compaction, exact-duplicate removal and cache-prefix repair. No figure in the
table below was measured with only those three switched on across the whole
run. On Mesh's own 30-request test basket (LIVE, run 2026-10-26, not a
customer's traffic) the three default changes account for under half of the
18.2% recorded; the rest came from two levers that are off by default, a
5-minute Anthropic cache stamp and a gate-approved cap on oversized tool
results. A Claude Code user gains little on the defaults. Mesh has no
customers yet and has not run on a customer's traffic, so nothing here is a
measurement of a real provider bill. How to switch on more than the defaults
is on [Get started](start.md).

## What the labels mean

- **LIVE** means measured on real API calls that Mesh paid for, on a test
  basket Mesh wrote. It does not mean a customer's traffic.
- **SIMULATOR** means modelled on a harness at the providers' published prices
  and cache rules. It is not a measurement of anyone's bill.
- **Out of the box** means with the three default changes only. Anything else
  names the levers that were switched on.

## The figures

Reproduce any of them from the repo root. Harness:
`node --import tsx evals/run-agent-ab.ts` and
`node --import tsx evals/run-cache-decomposition.ts`. The simulator rows were
re-run on `main` on 2026-11-24 and printed the same figures.

The "J stack" named below is one fixed set of levers: tool descriptions
trimmed to 40 tokens, exact-duplicate removal, cache-prefix repair, a cap on
oversized fresh tool results, stale-history compaction and a 2,000-token
output cap. Four of those six are off in a fresh install.

| Figure | Label and date | Levers it needed | On in a fresh install? | Where it comes from |
|---|---|---|---|---|
| **18.2%** of real spend ($0.0365 of $0.2010) | LIVE, run 2026-10-26, Mesh's own 30-request test basket on claude-sonnet-5-5 | The three defaults, plus on the coding agent a 5-minute Anthropic cache stamp, a gate-approved cap on oversized tool results and stale-history compaction | No. The cache stamp and the tool-result cap are off by default and earned more than half of it | `MESH_LIVE_KEEP=1 node --import tsx evals/run-live-agents.ts`; spools in `evals/live-exports-2026-10-26/`, hash chains verified; commit `68ab94e` |
| Coding agent **38.1%** ($0.0225) | LIVE, run 2026-10-26, same basket | 5-minute cache stamp, tool-result cap, tool-schema compaction | No. Most of it came from the stamp and the cap | same run. The cache placement that lost $0.0063 in the second export earns here because the volatility guard refuses to stamp a prefix that changes every turn |
| RAG agent **22.0%** ($0.0086) | LIVE, run 2026-10-26, same basket | Exact-duplicate removal only | Yes, out of the box, on a test prompt Mesh wrote to paste the same excerpt twice. A prompt with no exact duplicate gets nothing from this lever | same run |
| Support agent **10.3%** ($0.0054) | LIVE, run 2026-10-26, same basket | Tool-schema compaction only, as it was measured before the correction of 2026-10-29 | The lever is on by default, but this figure would not be recorded today: see the note under the table | same run |
| Batch and already-lean agents: $0 | LIVE, run 2026-10-26, same basket | None earned anything. The batch agent's cache stamp was withheld because its prefix is under the provider's cacheable minimum | Not applicable | same run; the provider's own `count_tokens` confirms the prefix is under Anthropic's documented minimum |
| **18.0%** of real spend | LIVE, run 2026-10-19, same basket; superseded by the run of 2026-10-26 | 5-minute cache stamp and the tool-result cap with its gate verdict, on top of the defaults | No | `evals/run-live-agents.ts`; commit `ebec869`. Its spools were not kept, so it cannot be re-audited; its batch claim is contradicted by the later run |
| **9.3%** of real spend | LIVE, run 2026-10-19, first smoke run; superseded | Levers switched on (set not recorded) | No | commit `d84e256`. The old cache placement lost money; per-agent outcomes were mixed |
| Multi-turn Claude, cache stamp alone: **37.9%** | SIMULATOR, verified 2026-10-22 | The 5-minute Anthropic cache stamp, measured on top of the J stack in both arms | No. The stamp is off by default | `evals/run-cache-decomposition.ts`: J stack with the stamp against the same J stack with caching disabled; both arms 38 of 40 clean; commit `6f08b72` |
| Full stack against a raw uncached baseline: **57.3%** lower simulated cost, with 5 points lower clean-task quality | SIMULATOR, verified 2026-10-22 | The J stack plus the 5-minute cache stamp | No. Fails the agreed quality limit; not a qualified saving | same script, second row; commit `6f08b72` |
| Async or batch-eligible work: **57.7% net** (64.3% ceiling; quote the net) | SIMULATOR, verified 2026-10-13 | The J stack plus the provider's discounted flex tier, on traffic flagged as able to wait | No | arm K; the net assumes 10% fallback to the default tier and 5% retries, priced at the tier served; commit `4e51734` |
| One-shot templated calls: **45.5%**, and **72.8%** where the work can wait | SIMULATOR, verified 2026-10-13 | 45.5%: cache-prefix repair plus tool-description trimming, stale-history compaction and an output cap. 72.8%: the same plus the flex tier | Partly. Cache-prefix repair is on by default and carries most of the 45.5%; the rest is not. Priced on a provider that caches automatically (OpenAI) | one-shot section, arms H and I ($0.569 to $0.310 and $0.155); commits `7b08666`, `4e51734` |
| Busy interactive agents: **25.9–29.4%** | SIMULATOR, verified 2026-10-13 | The J stack | No. On this harness the three defaults alone move the simulated bill very little | arm J across three provider blocks, 38 of 40 clean; commits `c7b03d4`, `4e51734` |
| Sparse interactive agents: **34.3%** | SIMULATOR, verified 2026-10-22 | The J stack plus the 1-hour Anthropic cache stamp | No | arm L; commit `6f08b72`. May overstate on some models: per-model cache minimums are not in the simulator |

### A correction that affects the live run of 2026-10-26

The run of 2026-10-26 was made three days before a correction to how
tool-schema compaction is measured. Until 2026-10-29 that lever counted the
removal of JSON formatting as a saving; the provider counts the same tokens
either way, so formatting is no longer counted (commit `58581e1`). The
tool-schema part of that run's 18.2% (LIVE, run 2026-10-26, with a cache stamp
and a tool-result cap switched on), which includes all of the support
agent's 10.3% (LIVE, same run, tool-schema compaction only), was measured
under the old rule. Running the same basket through
today's code against a local stand-in provider (2026-11-24) records no
tool-schema saving on those requests. The basket has not been re-run on live
traffic since, so the figure stands as measured on 2026-10-26 and should be
read with this note.

## Figures that are not savings

| Figure | What it is | Where it comes from |
|---|---|---|
| Proxy overhead: about 22 ms p50, 24 ms p95, 30 ms p99 added per request | Latency, measured on one machine (darwin/arm64), run 2026-10-20, with the three defaults plus the 5-minute cache stamp and the ledger | `node --import tsx evals/run-proxy-overhead.ts`; rerun it on your own machine |
| The provider's own cache: 35–40% | What the provider's cache saves on busy agent traffic before Mesh does anything. SIMULATOR, harness re-run 2026-11-24. Mesh never claims it | "what the cache itself is worth" section of the harness |
| "Do not pay us": 0–5% | The band for stacks that are already optimised. SIMULATOR, fixture, 2026-10-11 | support-assistant fixture, commit `ff04a70` |
| Replay gate approving the tool-result cap at 0.00 quality delta and rejecting the 2,000-token output cap | A gate result on Mesh's recorded fixture, not on a customer's traffic | `evals/run-replay-gate-freshcap.ts`, commit `ab5b4c7` |
| Ledger determinism, exclusions, recomputable invoice | Tests | `packages/core/src/savings-ledger.test.ts` |
| Proxy mode: no code change | Tests | `packages/sdk-js/src/proxy.ts`, `evals/run-proxy.ts` |

## Open items

- No figure here comes from a customer's traffic. Mesh has no customers yet.
- The 18.2% (LIVE, run 2026-10-26, with a cache stamp and a tool-result cap
  switched on) has not been repeated since the tool-schema correction of
  2026-10-29, and has never been run with the three defaults alone.
- Per-model cacheable minimums are not in the simulator, so the 34.3% sparse
  figure (SIMULATOR, verified 2026-10-22, J stack plus the 1-hour cache stamp) may overstate on
  some models.
- The 57.7% net async figure (SIMULATOR, verified 2026-10-13, J stack plus
  the flex tier) rests on
  assumed fallback and retry rates, not measured ones.
- The second live export's spools were not kept. Spools are committed from
  the third export onward.

## Independent sources cited on the comparison page

- codepointer.dev: 614M-token replay of rtk, headroom and caveman.
- archestra.ai: progressive disclosure, modelled against measured.
- RouterArena (arXiv:2510.00202): independent router leaderboard.
- Anthropic and OpenAI published pricing pages: every rate in
  `packages/core/src/model-prices.ts` carries its source URL and capture date.
