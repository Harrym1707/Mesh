# Token Engineering Lab — implementation log

Concise, auditable record of what was built and why. Newest first.

## 24-hour improvement loop — 2026-11-10 21:38 GMT → 2026-11-11 21:38 GMT

**North star:** blended % saved for the end user (`pnpm lab:status`).
**Rules for every iteration:** pick the top open queue item · build it in `lab/`
(product packages only for additive, opt-in, tested code) · run the full suite +
`typecheck:lab` · qualify honestly (basis label on every number; never inflate) ·
log it here · commit locally only when green · do not push (left for review).

### Standing queue (highest value first)

1. ~~Block-array prefix repair, measured.~~ **Done — iteration 2** (74.8% of the
   volatile session, SIMULATOR, gate-required).
2. ~~Simulated task-completion grader~~ and 3. ~~Paying-shape tier~~ —
   **Done together — iteration 3** (`lab/paying-shape.ts`).
3a. **Wire the tiers into the pipeline.** Let the Evaluation agent judge lossy
   leads with the paying-shape harness (simulated grader, 2% ceiling) instead of
   leaving them INCONCLUSIVE; record basis + grader on every verdict.
3b. **Long-session variant.** History compaction added 0 on the 5-turn fixture.
   Run 12+ turn sessions (the fixture's builders accept any turn) to see where
   compaction and the fresh-result cap actually pay, under the same gate.
3c. **Calibrate the modelled mix against LIVE.** Use the LIVE per-agent figures
   from `docs/NUMBERS.md` where they exist (coding 38.1%, RAG 22.0%); the RAG
   fixture overstates real traffic 2.5× and should be rebuilt or down-weighted.
4. **Already-caching share.** Make the fleet number an explicit range model over
   the share of customer traffic that already caches.
5. **Cache-TTL sensitivity.** Spacing sweep (30s / 8m / 45m) × 5m vs 1h TTL via
   `simulateCache` to make the cadence-aware TTL lead measurable.
6. **Red-team hardening.** Property tests for every reducer: never increases
   tokens, idempotent, preserves fenced code, byte-identical on clean input.
7. README + floorplan refresh; final report at 24h.

### Iteration 4 — 03:02 → 13:00 · session-length and cadence × TTL sweeps

(Wall-clock stretched because the host machine kept sleeping; see "Environment".)

**Built** `lab/sweeps.ts` (+ `pnpm lab:sweep [--tasks n] [--full]`) on a
generalised `runPayingShapeArm` (turns, tasks, task spacing, turn gap, 5m/1h
TTL). Default arguments are byte-for-byte the previous run, so the
`docs/NUMBERS.md` cross-check still pins it.

**Measured (SIMULATOR; repo agent fixture; 10 tasks; whole bill)**

Session length — savings compound as history grows, all at 10/10 clean:

| Turns | Lossless | + fresh tool-result cap | + history compaction |
|---|---|---|---|
| 5 | 31.4% | 46.4% | 46.4% |
| 12 | 49.4% | 61.4% | 61.4% |
| 20 | 59.4% | 70.4% | 70.4% |

Turn cadence × cache TTL (lossless stack, 5 turns; gaps are synthetic ESTIMATES):

| Gap between turns | 5m TTL | 1h TTL | Better |
|---|---|---|---|
| 3s | 31.4% (hits 71%) | 27.0% | 5m |
| 2m | 31.4% (hits 71%) | 27.0% | 5m |
| 8m | **−12.3%** (hits 0%) | 27.0% (hits 71%) | 1h |
| 45m | **−12.3%** (hits 0%) | 27.0% (hits 71%) | 1h |

**Findings**
- **A 5-minute stamp on a slow conversation makes the bill worse.** Once turns
  are more than 5 minutes apart every write expires unread: −12.3%, where the
  1-hour TTL saves 27.0%. Picking the TTL from observed inter-arrival gaps (a
  blind feature) is worth ~39 points on slow traffic. This makes the
  cadence-aware TTL lead (lever-backlog P2) measurable for the first time here.
- **History compaction is subsumed by the fresh tool-result cap.** Isolated at
  12 turns: compaction alone +2.2 pt (and it costs cache hits, 87% → 75%); the
  cap alone +7.8 pt; both together = the cap alone. With the cap on at
  injection, nothing stale and oversized is left to compact.
- **Longer sessions pay more.** Lossless alone goes 31% → 59% from 5 to 20
  turns. The 5-turn fixture understates long-running agents.

**Qualification / caveats.** Simulated grader; synthetic gaps; the fixture's
tool results are uniform ~2.5 KB, so the cap-vs-compaction result may differ on
traffic with a few very large and many small results. The stamping count now
ignores `cache-ttl-suppressed` records (a withheld stamp is not a stamp).

**Environment.** The host slept repeatedly (wakeups hours late, load average
58 on wake). A vitest run that spans a sleep reports wall-clock "timeouts" in
unrelated tests. Verification runs are therefore made under `caffeinate -i`
with a raised test timeout; no test logic depends on wall-clock.

### Iteration 3 — 23:45 · paying-shape tier, quality gate, and the LIVE anchor

**Found** `docs/NUMBERS.md` is the source of truth: one LIVE number (18.2% on a
mixed 30-request basket; coding 38.1%, RAG 22.0%, support 10.3%, batch 0%,
lean 0%), everything else SIMULATOR, and "0–5%" as the documented
do-not-pay-us band — which is where the wire-capture floor (0.06%) sits.

**Built**
- `lab/paying-shape.ts`: drives the repo's shared agent fixture (uncached
  Claude agent, 40 tasks × 5 turns) through `reduceRequest` + `simulateCache`,
  adding one lever per rung, graded by the fixture's simulated model and judged
  against the lab's 2% quality ceiling. Ladder runs are memoised per spacing.
- `lab/numbers.ts`: reads the LIVE headline and per-agent figures out of
  `docs/NUMBERS.md` at runtime (linked, never copied; never invents a number).
- `lab:status` now leads with LIVE, then labels every lab figure SIMULATOR /
  experimental / not for external quoting, and shows LIVE beside modelled where
  the doc has a per-agent figure.

**Measured (SIMULATOR; whole bill, input + output; 30s task spacing)**

| Arm | Saving | Clean | vs 2% ceiling |
|---|---|---|---|
| Lossless only (schema + dedup + 5m stamp) | 39.6% | 40/40 | PASS |
| + cache-prefix repair | 41.1% | 40/40 | PASS* |
| + description truncation (40 tok) | 41.5% | 40/40 | PASS* |
| + fresh tool-result cap | **51.4%** | 40/40 | PASS* |
| + history compaction | 51.4% | 40/40 | PASS* (adds nothing here) |
| + output cap 2,000 (full stack) | 57.3% | 38/40 | **FAIL (−5.0pp)** |

- **Harness cross-check:** full stack 57.3% and cache contribution 37.9% match
  the SIMULATOR rows in `docs/NUMBERS.md` to one decimal; pinned by a test.
- **Ceiling-breaker: the output cap.** It buys 5.9 points for 2 failed tasks in
  40. The best stack inside the ceiling is the full stack *minus* the cap:
  51.4% at 40/40. This independently reproduces the lever-backlog verdict that
  max-token right-sizing only saves by truncating.
- **History compaction adds nothing on 5-turn sessions** → queue 3b.

**Qualification / caveats.**
- \* "PASS" on a lossy rung is only as good as the simulated grader. It does not
  model sensitivity to where a date anchor sits (prefix repair), and the
  fixture's discriminating phrase survives a 40-token description cut. These
  rungs still need the real replay gate before any saving is billed.
- Calibration against LIVE: the constructed RAG fixture (54.8%) overstates real
  traffic (LIVE 22.0%) by 2.5×; coding is modelled at 30.9% vs LIVE 38.1%.
  The modelled mix is therefore renamed from "upper bound" to "modelled mix" —
  it is neither a bound nor a measurement → queue 3c.
- None of the lab's figures are in `docs/NUMBERS.md`; that file is Harry's to
  update. Flag for the final report.

**Verification:** 566 tests green (7 new), `typecheck:lab` clean.

### Iteration 2 — 22:42 · block-array prefix repair, measured on the capture

**Built** `lab/experiments/block-array-repair.ts` (lab-local, NOT in the product):
relocates volatile lines (timestamps, UUIDs) out of each block-array `system`
text block into one trailing unstamped block, so the stamped block stays
byte-identical across turns. Every line survives verbatim; only position
changes. No-op on a string system, on a system with nothing volatile, and on a
block that would be left empty; idempotent. Added as a fourth capture arm
(`blockRepair`) alongside a `GATE_REQUIRED_ARMS` list.

**Measured (SIMULATOR, derived-from-captures).** Volatile LiteLLM session input
cost $0.1615 → $0.0406, **74.8% saved**, landing within 7% of what the stable
session already pays. Stable and framework sessions: unchanged. Cost-weighted
across all six capture sessions: 55.8% — but that figure is carried by one
session and must not be read as a fleet number.

**Qualification / caveats.**
- GATE-REQUIRED: it moves a date anchor from the top of the prompt to the end of
  the system section. Cost effect is measured; quality effect is not. It stays
  out of the lossless floor (still 0.06%) and cannot be promoted from this harness.
- The simulator matches by character prefix and bills the post-hit remainder as
  fresh rather than as a 1.25× write; on this session that under-costs the
  repaired arm by roughly the message tail (hundreds of tokens against ~7,000).
- `lab:status` now labels every figure SIMULATOR (none is LIVE), per the
  standing decision of 2026-10-28, and prints floor / gated / upper bound.

**Verification:** 559 tests green (4 new), `typecheck:lab` clean.

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
