# Token Engineering Lab — implementation log

Concise, auditable record of what was built and why. Newest first.

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
