# Token Engineering Lab — implementation log

Concise, auditable record of what was built and why. Newest first.

## 24-hour improvement loop — 2026-11-10 21:38 GMT → 2026-11-11 21:38 GMT

**North star:** blended % saved for the end user (`pnpm lab:status`).
**Rules for every iteration:** pick the top open queue item · build it in `lab/`
(product packages only for additive, opt-in, tested code) · run the full suite +
`typecheck:lab` · qualify honestly (basis label on every number; never inflate) ·
log it here · commit locally only when green · do not push (left for review).

### Standing queue (highest value first)

1. **Block-array prefix repair, measured.** Build the volatile-line relocation as
   a lab-local experimental transform and measure it on the LiteLLM capture with
   `simulateCache` (expected ≈76% of that session's input bill). Gate-required.
2. **Simulated task-completion grader.** Reuse `evals/agent-fixture.ts`
   (`buildAnthropicRequest` + `answer()`, which has real quality consequences) so
   LOSSY levers — description truncation, fresh tool-result cap, history
   compaction, output effort — can run the pipeline with a measured quality
   delta instead of sitting INCONCLUSIVE. Label the grader as simulated.
3. **Paying-shape tier.** Qualify on the repo's uncached agent-fixture sessions
   through `reduceRequest` + `simulateCache` — a third, labelled tier between
   constructed fixtures (upper bound) and the wire captures (floor).
4. **Already-caching share.** Make the fleet number an explicit range model over
   the share of customer traffic that already caches.
5. **Cache-TTL sensitivity.** Spacing sweep (30s / 8m / 45m) × 5m vs 1h TTL via
   `simulateCache` to make the cadence-aware TTL lead measurable.
6. **Red-team hardening.** Property tests for every reducer: never increases
   tokens, idempotent, preserves fenced code, byte-identical on clean input.
7. README + floorplan refresh; final report at 24h.

### Iteration 1 — 21:38 · qualification on real wire captures

**Built** `lab/captures.ts`: replays the Mesh-owned framework wire captures
(LangChain, OpenAI SDK, Agents SDK, Anthropic SDK, LiteLLM) through the
product's own `reduceRequest` and `simulateCache`, net of the customer's own
caching (Anthropic stamps already present; OpenAI automatic caching).

**Finding (basis: derived-from-captures) — the headline needed correcting.**
Lossless levers save **0.06%** cost-weighted on the real captures. The framework
requests are 300–700 tokens (below the 1,024-token cache minimum, no duplicate
blocks; only the Agents SDK tool schema yields 2.5%), and the LiteLLM customer
already stamps its own cache. The 38.2% modelled number comes from fixtures I
constructed with redundancy in them, so it is an UPPER BOUND for uncached,
redundancy-heavy traffic — not a real-traffic measurement. `lab:status` now
prints both: upper bound (constructed fixtures) and floor (real captures).

**Opportunity found in the same data.** The LiteLLM "volatile" session (a clock
at the head of a block-array system prompt) costs **4.2× the stable one — 76.4%
of its input bill** — because every turn pays the 1.25× write premium and never
reads. Mesh's prefix repair only handles a string `system`. Recorded as a lead
(`block-array-prefix-repair`, gate-required) and promoted to queue item 1.

**Verification:** 555 tests green, `typecheck:lab` clean.

## 2026-11-09 — Initial build (end-to-end operational)

**Decision: top-level `lab/`, not `packages/lab`.** The Lab is internal R&D
tooling (parallel to `evals/`, `scripts/`, `floorplan/`), not shipped to
customers. It runs via `tsx` like `evals/` and imports core with `../packages/
core/src/*.js` (NodeNext ESM, matching the repo).

**Decision: agents are deterministic modules operating REAL primitives, with an
LLM seam left open.** The mission says "prefer working software over mock
architecture." Each agent is a narrow function over the ledger; the reduction is
measured by the real core reducers and the real replay gate, so the pipeline is
fully operational and testable today. Swapping a rule-based Scout/Design for an
LLM-backed one later is additive (same structured inputs/outputs).

**Decision: permissions enforced by the ledger, not convention.** `advance()`
derives the required capability from the record's current status, so only the
responsible role can move a record. The Builder holds neither `record:promote`
nor `record:evaluate` — the two load-bearing separations are structural.

**Decision: hash-chained event log reusing the savings-ledger construction.**
`sha256(seq, prevHash, canonicalEvent)`. Bug found and fixed during the first
demo run: the canonicalizer emitted `undefined`-valued keys as `null` while
`JSON.stringify` drops them on write, so re-hashing on read failed; the
canonicalizer now skips `undefined` keys. `pnpm lab:verify` is green.

**Decision: quality gates use two thresholds.** The 2% ceiling maps to the
replay gate's `maximumAccuracyDrop` (the real guarantee); a separate
`minimumCandidateAccuracy` (0.7 default) is the Wilson lower-bound sanity floor,
which small sample sizes cannot otherwise clear even at 100% accuracy.

**Files:** `types.ts`, `constraints.ts`, `permissions.ts`, `registry.ts`,
`fixtures.ts`, `catalog.ts`, `ledger.ts`, `orchestrator.ts`, `cli.ts`,
`index.ts`, `agents/{scout,research,design,builder,red-team,evaluation,maintainer}.ts`,
`lab.test.ts`, `README.md`.

**Wiring:** `vitest.config.ts` includes `lab/**/*.test.ts`; `package.json` gains
`lab:demo|run|status|verify` and `typecheck:lab`; `.gitignore` excludes the
runtime `lab/ledger/`.

**Verification:** `pnpm lab:demo` runs a full workflow — Scout discovers 6 leads;
dedup promotes at a measured **54.8%** token reduction with **0%** quality drop;
a cache-TTL spec-only lead evaluates INCONCLUSIVE; the prompt-rewrite idea is
rejected at Research on the content-blind / no-customer-app constraints; the
48-event audit trail verifies intact. Lab suite: 18/18 green; full repo suite:
542/542 green; `typecheck:lab` clean.

**Known next steps (not blocking the Definition of Done):**
- LLM-backed Scout discovery and Design drafting behind the existing seam.
- Real runnable implementations for the spec-only leads (cache-TTL needs
  timestamped captures; stale-tool needs a fat-tool-result capture) — both
  currently and correctly INCONCLUSIVE for want of data.
- A trajectory-level evaluator for output-side levers (per lever-backlog P4).
