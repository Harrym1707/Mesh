# Theo — the per-user token engineer agent (design sketch)

Worked out collaboratively 2026-10-29. Theo is the user-facing agent that keeps finding
each user cost savings on top of MESH, personalised to their traffic, without the user
changing anything.

## North star

> **Save the user money without them changing a single thing — and never degrade their product.**

Every design choice below serves that one sentence.

## The division of labour

- **MESH** is the engine: the proxy reduces tokens (lossless-first), meters savings into the
  hash-chained ledger, and emits the **blind feature stream** (irreversible keyed hashes +
  structural counts, no content). It runs in the request path, fast.
- **Theo** is the loop + the face: an **async, per-user optimiser out of the request path**.
  He never touches content, never slows a request. Mechanically he tunes MESH's lever config;
  to the user he's the agent that says "I found you more savings." He improves MESH's config —
  nothing else.

## Theo's senses, hands, conscience, memory — already built

| Theo needs | MESH primitive | Status |
|---|---|---|
| perceive the workflow (privacy-safe) | blind feature stream | built (tonight) |
| act | the per-request reduction config (`MeshTokenReductionConfig`) | built |
| prove a saving + hold quality | the replay gate | exists |
| measure savings + ROI | ledger + `recomputeInvoice` | exists |
| cheap offline hypotheses | the cache/workload simulator | exists |

Theo is mostly an **orchestration layer** over pieces that already exist. That's why he's buildable.

## The control mechanism (Theo → MESH, never in the request path)

- The proxy reads a **per-app policy** = the lever config, per route. Today it's static
  (lossless default).
- Theo owns a **versioned per-user policy document**: for each route, which levers are active,
  their params, and — for every lossy lever — the gate result (savings %, measured quality
  delta Y, grader used, date proven) that justifies it. The policy is self-documenting: each
  lever carries *why it's on*.
- **Theo's only action is to publish a new policy version.** The proxy hot-reloads it and
  enforces it synchronously. Decide async (Theo), enforce sync (proxy) — clean separation.
- **Rollback = publish the previous version.** A drift monitor can do this automatically.

## Theo's per-user state (the profile)

1. **Workload map** — per route: shape (chat / agent / RAG / batch), volume, cost share, cache
   behaviour, output-length distribution, tool-schema size, reuse signatures. All from blind
   features + ledger. This is "understand the workflow."
2. **Tolerance map** — per route: criticality tier + quality ceiling (max allowed Y).
   **Default = strict/Critical.** Loosened only by: revealed preference (accept/reject on
   proposals), behavioural-drift incidents, and optional user context. Governs how aggressive
   Theo may be.
3. **Lever portfolio** — the live config: per route, levers on + params, each with its gate
   result, grader, date, basis. This *is* the policy the proxy runs.
4. **Hypothesis queue** — ranked candidate levers not yet active, scored by offline simulation
   on the user's own features + fleet priors. What Theo tries next. (Free.)
5. **Experiment log** — every gate run: candidate, result, pass/fail, cost. No re-testing;
   shows his work; feeds the monthly ROI.
6. **Drift monitors** — per active lever: a continuous behavioural + usage signal with
   auto-rollback thresholds. The "never degrade" enforcement.
7. **Exploration ledger** — spend-to-find vs savings-found. Powers the monthly ROI line,
   MESH's own budget management, and the attention dial.

## Theo's loop

1. **Observe** → refresh the workload map from new features + ledger.
2. **Hypothesise** → offline simulate candidates on the user's features + fleet priors → rank
   the queue. *Free.*
3. **Prove** → run the top candidate through the gate on **recorded baselines** (the real
   traffic already happened, so only the candidate variant costs; **MESH fronts it**). *The
   learning step.*
4. **Decide**:
   - lossless pass → **autopilot**: publish + notify after.
   - lossy pass within the route's ceiling → **propose** "saves ~X, may cost ~Y quality";
     apply on accept. Y is the *measured* gate number. If Y is above the route's ceiling,
     Theo doesn't even surface it (protect the product over the saving).
5. **Monitor** → drift monitors on active levers; auto-rollback + notify on breach. Purely
   passive — the user changes nothing; their natural retry/regeneration behaviour is the
   thermometer, not the target.
6. **Report** → one or two lines monthly: *"This month MESH saved you £X. Theo found an extra
   £Y, and it only cost £Z to discover."* Honest both ways (quiet months say so).
7. **Compound** → anonymised outcomes → fleet model → better warm-start priors for everyone
   (privacy-safe: features are irreversible; consent-gated for cross-use).

## Day-0 vs Theo

- **Day 0:** proxy deploys with the lossless-default policy → **savings immediately**, no user
  action, no Theo yet. Theo's portfolio starts as that baseline.
- **Then Theo works** — growing the portfolio per route, personalised.

## How Theo understands the user (three stacked, optional-to-richer sources)

1. **Monitoring** (always on, zero effort) — the blind features.
2. **Revealed preference** (zero effort) — which proposals they accept/reject teaches per-route
   tolerance *without a questionnaire*. The proposal *is* the question, and it's a useful one.
3. **Optional context** (opt-in, as much or as little as they want) — "just chatting to Claude"
   vs "a team of agents running." A warm-start accelerant, never a gate.

## The grader stack (what makes "don't degrade" a mechanism, not a promise)

Measuring Y (quality held) is the hard part, roughly lowest-friction first:

1. **Behavioural drift** — watch the user's own retry/regeneration/edit rate in the feature
   stream; a lever that raises it dropped quality → auto-rollback. Zero friction, no content,
   real-world truth. The always-on safety net.
2. **Structural graders** — tool calls still match, JSON still valid, format held. Free where
   they apply.
3. **LLM-as-judge** on a sample — automatic but a model judging a model; fine for tolerant
   routes, not to be trusted alone on critical ones.
4. **User-supplied eval** — gold standard; reserved for high-stakes routes where the user
   *wants* to hand one over.

**Rule: grader strength caps aggression.** On a route with only weak signals, Theo stays
lossless — he never trades quality he cannot measure.

## The budget model

- **Tier 1 (free):** offline analysis + simulation on features. Finds most opportunities.
- **Tier 2 (cheap, MESH-fronts):** live gate confirmation of top lossy candidates, using
  recorded baselines so only the candidate variant costs. MESH pays — finding savings is our
  cost of goods, recouped via the 1% fee; a per-user exploration cap protects us.
- **The attention dial** (low/med/high) lets the user scale how hard Theo hunts.
- Net: the user never pays to be optimised; they only ever see net savings.

## The honesty invariants Theo inherits from MESH

- Never claim a saving not proven on the user's own traffic via provider-reported usage.
- Never enable a lossy lever without a gate pass within the route's quality ceiling.
- Grader strength caps aggression; weak grader → lossless only.
- Every lossy proposal shows measured save-X / drop-Y.
- Monthly ROI includes the cost-to-find — Theo proves himself like any lever.
- The user changes nothing; passive drift auto-rolls-back anything that costs them.

## Open / next

- The grader stack (esp. the behavioural-drift signal) is the deepest build.
- The novel-lever frontier (parked): Theo proposing *new reduction code*, gated — "finds new
  savings" rather than selecting from a menu.
- Then: coding agents (separate discussion).
