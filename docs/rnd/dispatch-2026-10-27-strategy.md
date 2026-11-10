# Strategy dispatch — 2026-10-27 (founder notes)

> FOUNDER DECISIONS 2026-10-27 (same day, after first pass):
> - **Pricing stays 1% of verified savings — PARKED, do not pursue 1%-of-spend
>   now.** Q1 kept only as a future-options note.
> - **The "do your agents already cache?" triage question is REJECTED** — it
>   frames MESH as a caching bolt-on. Do not build it.
> - Build priority is levers that are visibly MORE than caching (Q2 local
>   semantic compaction, Q4 routing). Ship, don't strategise.

Four founder questions to dig into. Nightly R&D: extend each section; hold the
honesty policy (docs/strategy, mesh-honesty-rules) as a hard constraint — a
pricing or lever idea that requires abandoning "prompts never leave the
machine" or "only bill verified value" must be flagged as a brand break, not
quietly adopted. First-pass reasoning below is the starting point, not the
answer.

## Q1 — Repurpose to a usage model ≈ 1% of the user's spend. Engineering? Auto-pricing?

The metering for 1%-of-spend is LESS engineering than today's 1%-of-savings,
and most of it already exists:
- The proxy already records `actualUsd` per request in the hash-chained ledger
  and the statement already sums "total spend across spools". 1% of spend =
  `sum(actualUsd) × 0.01`. No counterfactual, no baseline, no quality gate in
  the BILLING path (quality gates still protect the customer's product, just
  not the invoice math). The dispute surface collapses to near zero.
- Auto-pricing = Stripe metered/usage-based billing: each period the report
  tool computes the fee and reports a usage record to Stripe; Stripe charges
  the card on file. Needs: Stripe (being set up), a usage-reporting cron, and a
  signed authorisation to charge. Buildable this week once the entity's Stripe
  is live.

The STRATEGIC fork (must not be decided silently):
- 1%-of-spend bills the customer whether or not we help them. It kills the
  "do not pay us" verdict and the honesty moat we just defended. An
  already-optimised customer pays for nothing and churns.
- 1%-of-savings is honest and self-selecting but revenue is thin/uncertain
  exactly where accounts are well-built (see 2026-10-27 agent finding:
  cache-saturated agents save little).
- HYBRID worth modelling: bill a simple % of spend, but keep the savings
  ledger as the value-proof artifact AND cap the fee so the customer is always
  net-ahead (fee ≤ a fraction of verified savings). Predictable-ish revenue +
  honesty preserved + trivial dispute surface. OPEN QUESTION for the team:
  model the revenue of (a) 1% spend, (b) 1% savings, (c) hybrid-capped across
  the three account archetypes (uncached / badly-cached / optimised).

## Q2 — What can open-source (local) models do for product quality?

The throughline: local OSS models are the ONLY way to do semantic (lossy)
reduction while honouring the inviolable "prompts never leave the machine"
rule. Without them, semantic compression means shipping prompts to an API — we
forbid that. So OSS models unlock the entire lossy roadmap. Candidates:
1. On-machine semantic compaction of stale context / oversized tool results
   (summarise old turns, compress logs) via a small local model — validated by
   the replay gate. Biggest single quality lever we don't have yet.
2. Local quality JUDGE for the replay gate — free, private, no API egress to
   score whether a lossy lever held quality.
3. Local exact tokenizers (tiktoken for OpenAI; OSS model tokenizers) — kills
   the chars/4 miscount (see P1.5) for every model that publishes one.
4. Local embeddings for SEMANTIC dedup and semantic caching (near-duplicate
   context/retries beyond byte-exact) — on machine, private.
5. Routing the trivial fraction of calls to a local OSS model = 100% cost
   elimination on those calls, not a percentage trim (ties to Q4).

## Q3 — Money/data no object: the best possible token solution?

Data and trust are the moats; levers are commoditisable. The dream stack:
1. The largest real, consented token-economics dataset in existence → true
   savings distributions per segment, every band with a confidence interval
   (today we have simulators + an 18.2% live run).
2. A continuously-updated cost oracle: every provider/tier/cache/batch rule,
   always current.
3. LEARNED levers, not heuristics: a per-account bandit/RL policy that
   discovers which levers to apply and tunes them against that customer's own
   quality signal. The product self-optimises per account.
4. A fine-tuned local compaction model — best-in-world "squeeze this context
   without losing task quality", running on-machine.
5. Closed-loop quality: the replay gate as a continuous online monitor, good
   enough to push lossy levers aggressively because regressions are caught
   instantly.
6. The measurement STANDARD: get the verifier audited (Big 4), publish it as
   the IPMVP-for-LLM-spend that finance/procurement trust. Trust is the moat.

## Q4 — If we solve model orchestration (all-in-one), what changes?

This is the answer to "is MESH defensible once caching is solved" — yes,
because routing is an independent, LARGER, unsaturated lever:
- Caching/dedup shave a % off a bill; routing a request from a frontier model
  to a cheap tier or a local OSS model is a step-change (10–100× per request,
  or → $0 for local). The biggest savings live here, not in caching.
- It makes MESH valuable to even a perfectly-cached agent: route the trivial
  40% of calls elsewhere while holding quality — savings no caching touches.
- Position shift: from "cost proxy" to "the inference control plane" every
  request flows through. Bigger, stickier, higher switching cost.
- THE HARD PART (and the risk): routing quality is brutal — RouterArena's
  best-funded router ranked 12th of 12 (on our own comparison page). Per-request
  quality gating IS the whole difficulty; get it wrong and we degrade the
  customer's product, violating quality-first. Orchestration is the
  highest-value AND highest-risk lever — must be gated harder than any lossy
  text lever, and the verified-savings discipline gets harder (saving vs which
  baseline model, at what quality?). Competes with LiteLLM/OpenRouter who own
  routing today — our wedge is the measurement/verification layer they lack.

## For the team
Model Q1's three pricing archetypes with real arithmetic. Prototype Q2.1
(local semantic compaction behind the replay gate) as the highest-value new
lever. Scope Q4 routing as a design doc with the quality-gate front and centre
— do NOT ship routing without a per-request quality gate.
