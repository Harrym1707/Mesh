# A3 Redundancy — the CLEAR, DEFENSIBLE value (and its honest ceiling)

Date: 2026-10-28. Axis: **A3 near-lossless redundancy**. Analyst mandate: confirm
or refute the ~7-9% exact-duplicate ceiling on real multi-turn captures + a
WildChat multi-turn sample; decide whether ANY defensible redundancy value
exists beyond what `dedupeRepeatedBlocks` / `dedupeRepeatedLeadingBlock` already
take, or whether A3 is near-exhausted. Give the honest ceiling BY WORKLOAD.

Every number carries a basis label: **measured / derived-from-data /
literature-claim / estimate**. Measuring stick: python3 + tiktoken o200k_base.
Sandboxes under `evals/fundamentals/value/`. This file is appended as work lands.

MESH constraints: black-box byte rewrite of the outgoing request + read provider
usage. LOSSLESS (model reads equivalent token sequence) bills unconditionally;
LOSSY (changes what the model sees) must clear a task-completion replay gate.

---

## 0. What is ALREADY shipped (the baseline to beat)

Three redundancy levers already live in the reducer — any A3 "value" must be
*incremental* to these:

1. **`dedupeRepeatedBlocks` (LOSSLESS, on by default via `duplicateContext`)** —
   `packages/core/src/token-reduction.ts:94`. Removes byte-identical duplicate
   blocks (≥24 tokens) *within a single text*, at paragraph (`\n{2,}`) and line
   (`\n`) granularity. Never touches fenced code. Applied per-message (`duplicate
   -context-removal` only ever sees one message's text at a time —
   `reduce-request.ts:102`).
2. **`dedupeRepeatedLeadingBlock` / `cross-turn-memory-dedup` (LOSSY, replay-
   gated, OFF by default)** — `token-reduction.ts:301`. Removes a repeated
   *leading* block that is byte-identical to turn 1's opening, across the `user`
   turns of a message array (the continuous-memory/persona-prefix pattern).
   Replaces with a `[mesh: N tokens … omitted]` marker.
3. **Stale-history compaction + fresh-tool-result-cap (LOSSY, gated)** —
   `reduce-request.ts`. Digests/caps oversized tool-result *bodies* (whole stale
   tool results), not a redundancy lever per se but it already reclaims the
   largest single token mass in agent traffic (tool_results).

So the A3 question is narrow and precise: **is there byte-identical or near-
identical redundancy that (a) crosses message boundaries, or is near- not exact-
identical, so the shipped levers miss it, AND (b) lands OUTSIDE the cacheable
prefix so removing it is a real net saving rather than a cache-bust?**

---

## 1. Measured results (four independent real datasets)

Sandboxes: `evals/fundamentals/value/a3_redundancy_probe.py` (chat),
`a3_agent_probe.py` (agents). tiktoken o200k_base throughout.

### 1a. WildChat-1M multi-turn (n=354 English convos, turn≥3, 845,476 tok) — MEASURED
| slice | tokens | % of conv | billable? |
|---|---|---|---|
| shipped within-message exact-dup (already taken) | 3,855 | 0.46% | lossless, shipped |
| **cross-message exact-dup residual** (shipped misses) | 68,800 | **8.14%** | — |
| &nbsp;&nbsp;↳ lands in **cached prefix** (A1 serves @0.1x) | 58,841 | 6.96% | ~0 net (cache-bust) |
| &nbsp;&nbsp;↳ lands in **uncached tail** (clean A3 save) | 9,959 | **1.18%** | near-lossless, GATED |
| near-identical msg mass (0.80–0.995) | 51,147 | 6.05% | lossy, GATED |

The raw 8.14% **confirms** the ~7–9% duplicate ceiling — but **~85% of it is in
the cacheable prefix**, where MESH's shipped A1 already discounts it 10×.
Deduping there changes prefix bytes and busts the cache it rides on, for
near-zero net. The honest clean save is **1.18%**.

### 1b. mini-SWE-agent v1.13.3 + Sonnet-4.5 (n=16 real SWE-bench trajs, 482,165 tok) — MEASURED
| slice | tokens | % conv | % of tool_result tok |
|---|---|---|---|
| tool_results (the token mass) | 298,081 | 61.8% | 100% |
| shipped within-msg exact-dup already taken | 9,479 | 1.97% | — |
| **EXACT-dup fresh tool_result (clean, cache-safe A3)** | 6,876 | **1.43%** | 2.31% |
| near-dup fresh tool_result (0.85–0.999, lossy) | 13,411 | 2.78% | 4.50% |
| &nbsp;&nbsp;↳ true recoverable after diff-encode | 10,881 | 2.26% | 3.65% |

### 1c. OpenHands + GPT-5 (n=16 real SWE-bench trajs, 552,598 tok) — MEASURED
| slice | tokens | % conv | % of tool_result tok |
|---|---|---|---|
| tool_results | 458,524 | 83.0% | 100% |
| shipped within-msg exact-dup already taken | 5,541 | 1.00% | — |
| **EXACT-dup fresh tool_result (clean, cache-safe A3)** | 7,827 | **1.42%** | 1.71% |
| near-dup fresh tool_result (lossy) | 8,688 | 1.57% | 1.89% |
| &nbsp;&nbsp;↳ true recoverable after diff-encode | 5,042 | 0.91% | 1.10% |

### 1d. Mooncake toolagent + conversation traces (n=35,639 real requests, hash_id blocks) — MEASURED
Within-request duplicate 512-token blocks: **0 of 698,116 blocks (0.00%)**. Large
verbatim duplication is entirely CROSS-request (shared prefix = A1), never within
a single request. Corroborates that A3's residual is small sub-block line repeats,
not large blocks.

### The convergent finding
The clean, cache-safe, near-lossless A3 ceiling is **~1.2–1.4% of conversation
tokens** — WildChat 1.18%, mini+Sonnet 1.43%, OpenHands+GPT-5 1.42%. Three very
different workloads, one number. The duplicate tool_results are tiny (mini:
median 15 tok, mean 39; 68% of their mass is <200 tok) — repeated `git status`,
`ls`, small greps, re-run tests — so they sit BELOW the shipped fresh-result cap
(600-tok default) and digest thresholds: the shipped caps genuinely miss them,
which is where the incremental value is, but each hit is small.

---

## 2. Verdict — is there defensible A3 value beyond what's shipped?

**Unconditionally lossless (billable now): A3 adds ~0 new value.** The only
unconditional-lossless redundancy is byte-identical duplication the model reads
twice in one breath — within a single message — and `dedupeRepeatedBlocks`
already takes it (~1–2% conv, measured). A2 structural canonicalisation takes the
rest. There is no new unconditionally-lossless slice to find; A3-lossless is
EXHAUSTED.

**Near-lossless, GATED: one real incremental lever, ~1.4% on agent workloads.**
Cross-turn **exact-duplicate fresh tool_result replacement**: when an agent
re-runs a command and the provider returns byte-identical output, MESH replaces
the *fresh* (uncached) copy with a reference marker to the identical earlier copy
that already sits in the cached prefix. This does NOT edit the cached prefix (no
cache-bust) and nets the fresh copy's full uncached cost. Measured **1.43% / 1.42%
of conv tokens** on two independent agent stacks. It is NEAR-lossless (the model
no longer re-reads the content at the fresh position — same quality profile as
the shipped-but-off `crossTurnMemoryDedup`), so it is **GATED**, not billable
unconditionally.

**The ~8% ceiling is confirmed-as-count, refuted-as-value.** ~85% of raw
cross-turn duplication lives in the cached prefix where A1 already discounts it
10×. Quoting 8% as A3 savings would double-count A1 and fail per-task measurement
— exactly the honesty trap the product's moat forbids.

**Lossy upside (research, not ship): near-identical tool_results.** Diff-encoding
near-identical tool_results (re-read of a file that changed by 1–2 lines) could
recover another ~1–2% of tool_result tokens, but needs a diff-reference mechanism
the reducer doesn't have and a higher-risk replay gate. Research, not a byte
lever today.

## 3. Biggest opportunity + cheapest experiment

**Biggest opportunity:** the cross-turn exact-dup fresh-tool_result lever on
**coding-agent** workloads (agents that re-run `ls`/`git status`/tests/greps).
~1.4% of conv tokens, cache-safe, consistent across stacks. It is incremental
because the duplicates are too small for the shipped fresh-result cap to catch.
Modest but real and defensible — and it extends existing machinery rather than
needing a new model.

**Cheapest experiment (confirms or kills it):** extend the EXISTING
`crossTurnMemoryDedup` replay-gate harness to the newest tool_result — replay the
40 recorded SWE-bench trajectories (already downloaded under
`evals/fundamentals/value/traj/`) with each fresh exact-duplicate tool_result
replaced by a reference marker, and confirm the agent's task-completion / final
patch is unchanged. **Pure offline replay on recorded traces — zero API spend.**
One eval run confirms the ~1.4% is billable-after-gate or kills it.
