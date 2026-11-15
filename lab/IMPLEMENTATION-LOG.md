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
3a. ~~Wire the tiers into the pipeline~~ — **Done — iteration 5.**
3b. ~~Long-session variant~~ and 5. ~~Cache-TTL sensitivity~~ — **Done — iteration 4.**

**Added 2026-11-14 (iteration 7), ahead of the list below:**
- **One small live run** on the corrected cache guard, to turn the
  DERIVED-FROM-LIVE figure for the coding agent (20.7% of its bill, 6.1% of the
  live basket) into LIVE. Needs a provider key — Harry's call.
- **A browsing workload with a real grader**, so the two stale-snapshot levers
  (`needs_gate`) can be judged. Without one they stay lab-only.
- **Exclude page snapshots from the generic fresh tool-result cap.** On the
  browsing shape the cap truncates every page the agent is about to act on.
- **Stamping an unflagged workload once its prefix repeats** (the live support
  chat) is still lab-only; in the product the cache flag comes from the caller
  or a Theo policy.

**Added 2026-11-12 (iteration 6):**
- ~~Span-keyed cache stamping into the product~~ — **Done — iteration 7**, for
  workloads that carry the cache flag.
- **Output.** 57.7% of the remaining live bill and no measured lever. Needs a
  task-completion gate with a real model before `outputEffort` can be judged.

**Open after the 24-hour run (in priority order):**
- **Real replay gate for the `needs_gate` levers** (fresh tool-result cap,
  block-array prefix repair). Needs real traffic or a provider key — Harry's call.
- **Cadence-aware TTL selection in the proxy.** The lab shows the mechanism
  (5m stamp loses 12.3% at slow cadence; 1h saves 27.0%); the product still
  takes the TTL as a caller flag.
- **Block-array prefix repair into the product**, off by default behind the gate.
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

### Iteration 7 — 2026-11-14 · the cache guard fix ships; browsing agents

Harry: "as long as it does not affect quality then do it"; look at
vercel-labs/agent-browser and "see if we can do it better"; "make sure we ship
this to live code".

**1. Product change — the cache guard decides each breakpoint separately.**
`packages/sdk-js/src/cache-volatility-guard.ts`, `reduce-request.ts`.
- The guard now compares the content the system breakpoint would actually cover
  (after Mesh's levers), supplied by the reducer, instead of the client's raw
  `{tools, system}`. A clock that prefix repair has moved behind the breakpoint
  is no longer churn.
- A history that does not extend withholds only the breakpoint on the newest
  message. The tools + system breakpoint stays: it sits before the history.
- Each track recovers after two consecutive stable turns, as before.
- Quality: placement only. A test asserts that, with the markers removed, the
  guarded request equals the unguarded one on every turn of both live shapes.
  Money: a span that really changes is still suppressed (tested); nothing is
  stamped that the existing first-turn rule would not already stamp.
- The guard as it shipped for the live run is frozen in
  `lab/experiments/legacy-guard.ts` so the replica still reproduces the spool
  (stamp, stamp, –, –, –). Under the product guard the same replica is stamped
  on all five turns: **SIMULATOR −53.4% input** on the replica;
  **DERIVED-FROM-LIVE 20.7% of the live coding agent's bill, 6.1% of the
  $0.20103 basket** — a counterfactual, not a re-run. LIVE stays 18.2%.
- Not covered: the live support chat (never stamped) carries no cache flag, so
  this fix does not reach it. Its 29.1%–36.9% needs the flag from the caller or
  a Theo policy (`cache-ttl-5m` is already a policy lever).
- Reaches users only when this branch is merged and a release is cut; the
  release branch (`theo/autonomous-agent`) does not have it yet.

**2. agent-browser — what it does, and what Mesh can do that it cannot.**
agent-browser (Rust CLI over CDP) returns a page as a compact accessibility
snapshot with an element ref per line; `snapshot -i` keeps interactive elements
only. Its site claims ~200–400 tokens against ~3,000–5,000 for a full DOM, with
no method given. That cuts the cost of EACH snapshot, at the source, and needs
the customer to swap their browser tool. It leaves every earlier snapshot in
the transcript, re-sent on every later turn — the quadratic part.

`lab/browsing-shape.ts` (+ `pnpm lab:browse`) is a synthetic 6/12/24-snapshot
shop checkout priced with explicit breakpoints. **SIMULATOR, synthetic; sizes,
script and length are ESTIMATES; no grader.** Whole bill:

| Arm (12 snapshots) | vs no Mesh | vs Mesh today | Page text readable | Customer change |
|---|---|---|---|---|
| Mesh defaults (no cache flag) | 0.0% | — | 79/79 | no |
| Mesh today (lossless + cache flag) | 73.5% | 0.0% | 79/79 | no |
| Interactive-only at the source (agent-browser idea) | 80.4% | 26.3% | 0/79 | yes |
| Mesh: stale-snapshot line dedup | 76.8% | 12.7% | 79/79 | no |
| Mesh: stale snapshots superseded | 81.8% | 31.6% | 7/79 | no |
| Source-side + Mesh supersession | 85.5% | 45.4% | 0/79 | yes |

- Old snapshots being re-sent are 64.8% of the raw input bill at 12 snapshots
  (48.0% at 6, 76.2% at 24). The Mesh arms grow with session length: line dedup
  3.3% / 12.7% / 22.6%, supersession 21.4% / 31.6% / 44.6% at 6 / 12 / 24.
- Out of the box Mesh saves nothing on this shape. The cache flag is what pays.
- `lab/experiments/page-snapshots.ts` (lab-local): line dedup drops from each
  older snapshot only the lines the next one repeats, with dead refs masked so
  tools that renumber refs do not defeat it — every element and text line is
  kept at its last occurrence (tested). Supersession replaces older snapshots
  with a stub. Both move the breakpoint to just before the fresh snapshot;
  with the breakpoint ON it, every write is spoiled one turn later (tested).
- Both change what the model reads → both rest at `needs_gate`, quality
  unmeasured. The two ideas are complementary, not rivals.
- Warning arm: the generic fresh tool-result cap truncates all 12 fresh pages.

**Verification:** full suite green, `tsc -b` and `typecheck:lab` clean (counts
in the commit message).

### Iteration 6 — 2026-11-12 · what the LIVE run still leaves on the table (agents)

Asked: find more ways to cut token usage on agentic workflows. Instead of
another fixture, this reads the LIVE spools (`evals/live-exports-2026-10-26/`,
the run behind the 18.2% in `docs/NUMBERS.md`) — content-blind: token counts,
lever ids, dollars.

**Built**
- `lab/live-study.ts` (+ `pnpm lab:live`): `liveResidual()`, `guardStudy()`,
  `stampStudy()`, and a span pricing model for replicas.
- `lab/live-shapes.ts`: constant-for-constant replicas of the live coding agent
  and support chat (the script itself cannot be imported — importing runs it).
  A test checks the replicas still match the script.
- `lab/experiments/span-keyed-stamp.ts` (lab-local, NOT in the product).

**Finding 1 — LIVE: output is most of what is left.** After Mesh, output is
**57.7%** of the remaining live bill (coding agent 62.5%); fresh uncached input
is 39.2%; cache reads + writes together 3.0%. The lab has no measured lever for
output. That is now the largest open item, with a LIVE basis.

**Finding 2 — the cache guard suppresses breakpoints that would still read.**
The live coding agent's spool: stamped, stamped, then `cache-ttl-suppressed` on
turns 3–5. Turn 2 read 2,267 cached tokens, so the repaired prefix is provably
stable; turns 3–5 then paid full price for that same prefix. The replica
reproduces this pattern exactly under the product guard. Two causes, each
pinned by its own test:
1. The guard hashes the RAW `{tools, system}`, so a per-turn clock reads as
   churn even after `repairCachePrefix` has moved it out of the stamped span.
2. It is all-or-nothing: a history that does not extend also suppresses the
   tools + system breakpoint, which sits before the history and still reads.

The existing product test that shows the repaired placement "earns" calls the
reducer without the guard; the proxy installs the guard automatically. No
branch (`main`, `integration/trunk`, `theo/autonomous-agent`) changes this.

**Finding 3 — a reusable prefix that was never stamped.** The live support chat
shipped the same tools + system on all six requests and carried no stamp
(`cacheTtl` is a per-workload caller flag); every request was billed fresh.

**Experiment — span-keyed stamping.** Key the system breakpoint on the exact
span Mesh would stamp (tools + stamped system blocks, after Mesh's deterministic
levers): stamp once that span has been seen before; keep the message breakpoint
only when the raw history extends. Lossless — it emits only bytes the product
already emits, stamped or unstamped (tested).

| Agent | Basis | Stamp once the span repeats | Stamp at first sight (known route) |
|---|---|---|---|
| Coding agent replica, input cost | SIMULATOR | −35.6% | −53.4% |
| Coding agent, share of live bill | DERIVED-FROM-LIVE | 13.8% ($0.00816) | 20.7% ($0.01224) |
| Support chat replica, input cost | SIMULATOR | −54.3% | −69.1% |
| Support chat, share of live bill | DERIVED-FROM-LIVE | 29.1% ($0.01519) | 36.9% ($0.01927) |
| Both, share of the $0.20103 live basket | DERIVED-FROM-LIVE | 11.6% | 15.7% |

**Qualification.**
- DERIVED-FROM-LIVE is counterfactual arithmetic on verbatim provider usage with
  the documented multipliers (write 1.25×, read 0.1×). It is **not** a re-run:
  no request was sent. It is not LIVE and does not change the 18.2%.
- The live basket is 30 requests; the "agents" in it are scripted. The coding
  agent's history is rebuilt each turn by the script, which is one of the two
  triggers. Real agents that window or summarise their history hit the same
  path; how common that is on customer traffic is unknown.
- "Stamp once the span repeats" never pays a write premium on a prefix that does
  not repeat (tested: cost equals uncached). "At first sight" does lose on
  non-repeating prefixes (tested), so it needs a route already known to repeat.
- The support-chat figure uses the 2,267-token prefix the provider actually
  cached in the coding run (same tools + system), not the replica's estimate.

**Pipeline.** New lead `span-keyed-cache-stamping` → promoted as lossless, with
basis recorded and a Red Team note that the saving is a counterfactual.

**Verification:** 584 tests green (10 new), `typecheck:lab` clean.

### Iteration 5 — 14:36 → 21:00 · harness evidence in the pipeline; `needs_gate`

**Built**
- `lab/evidence.ts`: the one place a lead's techniqueKey maps to the harness
  measurement behind it (paying-shape rung, cadence sweep, wire capture), each
  with its basis and grader.
- New terminal status **`needs_gate`**: a LOSSY lever whose saving is measured
  but whose quality was judged only by a simulated grader (or not at all). It is
  worth pursuing and is never promoted from this harness.
- Builder binds a lead to its harness; Red Team attacks the evidence (simulated
  grader, synthetic inputs, a bill that goes up); Evaluation applies the same
  gates (≥3 saving, ≤2% quality drop); Maintainer promotes only lossless levers.
- Two new leads so the ledger remembers them: fresh tool-result cap, and the
  output-token cap (recorded as a failure so it is not re-investigated blind).

**Pipeline verdicts on harness evidence (SIMULATOR)**

| Lead | Evidence | Verdict |
|---|---|---|
| Cadence-aware cache TTL | 22.2% at 8-minute turn gaps in the pipeline's 4-task evidence run (27.0% in the 10-task sweep), where a 5m stamp loses money; lossless | **PROMOTED** |
| Fresh tool-result cap | +9.9 pt on the paying shape, 40/40 simulated | **NEEDS GATE** |
| Block-array prefix repair | 74.8% of one captured volatile session; quality unmeasured | **NEEDS GATE** |
| Output-token cap | +5.9 pt but −5.0 pp quality | FAILED (quality) |
| Tool-description truncation | +0.4 pt | FAILED (not meaningful) |
| Stale tool-result (history) compaction | +0.0 pt on top of the fresh cap | FAILED (subsumed) |
| Reasoning-effort / output-conciseness governors | no harness, needs a real model | INCONCLUSIVE |

**Qualification.** "+N pt" is points of whole-bill saving a lever adds on top
of the rung below it on the repo agent fixture; it is not a fleet number. The
cadence figure rests on a synthetic gap. `needs_gate` items need a real replay
gate on real traffic — that needs a provider key and Harry's go-ahead, so it
was not attempted. (Correction: commit `aeaf811`'s message quotes 27.0% for the
promoted TTL lever; the pipeline's own evidence run reads 22.2%.)

**Verification:** 574 tests green (6 new), `typecheck:lab` clean (run under
`caffeinate`, wall-clock timeouts raised).

### Close of the 24-hour run — 21:30 GMT, 2026-11-11

Five iterations landed in the 24 hours; the host slept for roughly half of it.
Final `pnpm lab:status` on a fresh ledger (28 leads, 240-event audit trail intact):

- **LIVE 18.2%** (docs/NUMBERS.md) — unchanged; the lab ran no live traffic.
- **Floor 0.1%** on real wire captures with lossless levers (SIMULATOR).
- **Paying shape 39.6% lossless / 51.4% inside the 2% ceiling** (SIMULATOR).
- **Modelled mix 38.2%** (constructed fixtures × ESTIMATE weights) — known to
  be miscalibrated against LIVE (RAG 54.8% modelled vs 22.0% LIVE).
- 15 promoted (all lossless), 2 awaiting a real gate, 5 failed/rejected, 6 inconclusive.

Nothing was pushed, `docs/NUMBERS.md` was not edited, and no paid API call was made.

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
