# R&D doctrine — sampling + the three verticals (standing, from 2026-10-27)

Founder-set structure for all dataset analysis and lever work. The nightly R&D
routine and every analysis workflow follow this unless a dispatch overrides it.

## Sampling doctrine (how to aim at datasets with millions of rows)

The volume is a population to sample, not a corpus to consume. Four rules:

1. **Sample the shape that pays us, not the average.** The average public-chat
   row is a 1–2 turn Q&A with no history to cache or dedupe — noise for MESH.
   Filter to the paying shape first (e.g. ≥6 turns, has tool calls, long
   context) and sample within it. The filter is part of the finding.
2. **Weight by tokens, not by row count.** Tokens are heavily concentrated (top
   ~10% of agent turns hold ~47–64% of output). A count-weighted sample is
   dominated by trivial rows; a token-weighted sample lands where savings live.
3. **A few thousand rows per stratum is enough.** For a median/p90 the millionth
   row adds nothing. Stratify into the verticals below and pull a few thousand
   per stratum, so each band is calibrated by matching data, not one blended
   average.
4. **Record the exact filter + sample size as part of every citation**
   (e.g. "n=3,000 WildChat convos, ≥6 turns"). Reproducible, never cherry-picked.

**Honesty flag that governs all three verticals:** biggest token volume is NOT
automatically biggest MESH-addressable saving. Well-built agents already cache,
so measure NET of what the agent already does, never bill a saving the customer
already has, and hunt the waste caching does NOT remove.

## The three verticals (priority order)

### 1. Always-on agent token reduction — HIGHEST PRIORITY
- **Shape:** long-lived, continuous agents re-sending growing history 24/7
  (monitors, memoryful assistants, streaming watchers).
- **Priority datasets:** Mooncake (its `hash_ids` prefix-reuse signal is the
  only public cache proxy), long multi-turn WildChat/LMSYS, Azure 2024 arrival
  pattern (idle-gap distribution).
- **Levers to tune:** cache placement + volatility guard, cache-TTL idle-gap
  policy (keep-warm vs 1h tier), history + semantic compaction of stale tool
  results, output re-emission metering.
- **The hunt:** caching already took the easy resend here — find idle-TTL
  expiry, volatile-prefix churn, and re-emission. This is where the compounding
  lives and where most customer spend sits.

### 2. Autonomous agent token reduction
- **Shape:** multi-step goal-directed loops (coding agents, task agents) that
  iterate tool calls toward a goal.
- **Priority datasets:** OpenHands run logs, SWE-agent trajectories, ToolBench,
  tau-bench — real request bodies with tool schemas and outputs.
- **Levers to tune:** tool-schema compaction (cold/cache-miss turns only),
  fresh-tool-result cap, output diff / re-emission, and the new
  semantic-compaction pre-pass (stale oversized tool results are its home turf —
  this vertical calibrates its maxTokens/minimumTurns/keepRecentTurns defaults).
- **The hunt:** diff-shaped output and stale tool-result bloat; respect that
  Cline/OpenHands/SWE-agent already cache + cap (do-not-pay-us on those).

### 3. One-shot token reduction
- **Shape:** stateless, templated single/few calls (classification, extraction,
  generation) — no history growth.
- **Priority datasets:** batch-classification shapes, BurstGPT single-turn,
  short WildChat rows.
- **Levers to tune:** tool-schema compaction, exact duplicate-context dedup,
  batch-tier routing (the 50% Anthropic/OpenAI lever), per-model cacheable
  minimum.
- **Strategic role:** lowest per-customer token volume but the easiest to PROVE
  and the best demo (clean 45.5–72.8% / batch 50% bands, no quality risk) —
  the vertical that wins the first pilots and the landing-page receipt.

## Team division
One analyst (or sub-team) per vertical, each sampling its priority datasets
under the sampling doctrine and tuning only its levers; a synthesis step merges
findings into one report and the winning parameter changes into
[lever-backlog.md](lever-backlog.md). Weight effort: always-on > autonomous >
one-shot.
