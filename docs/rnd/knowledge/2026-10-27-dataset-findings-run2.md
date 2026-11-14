# Dataset analysis findings RUN 2 — 2026-10-27 (deeper always-on + autonomous; sample-derived, calibration only)

Extends run 1: `docs/rnd/knowledge/2026-10-27-dataset-findings.md`. Public data only. Every
number carries its sample size (n). Nothing is extrapolated to a billed %. Gated/unreachable
sources contribute no numbers. Token figures off HF corpora use the ported
`approximateTokenCount` / `measureOutputReEmission` (re-validated byte-identical to the TS),
so they are a proxy (±~15% vs the Claude tokenizer), not provider `usage`.

Three parallel pulls feed this run:
- **Serving/cache depth** — Mooncake full 1-hour trace + Azure LLM Inference 2024 wide weekly slice.
- **SWE-agent depth** — SWE-rebench-openhands-trajectories at n=2,000 (≈10× run 1's n=200).
- **Agent breadth** — 4 non-SWE agent corpora (APIGen-MT, ToolACE, glaive, Mind2Web).

---

## Confirmed at larger n

**Cacheable-min admission (run-1 finding (2)) — CONFIRMED, now stable over a full Azure week.**
- Mooncake (full 1-hr trace): conversation 88.7% ≥1024 / 76.7% ≥2048 (n blocks in dataset-1 slice);
  tool-agent 94.8% ≥1024 / 89.1% ≥2048. Identical to run 1.
- Azure 2024 pooled, whole week 05-10→05-17: conv n=1,347,059 → 48.7% ≥1024 / 32.7% ≥2048
  (per-window range 46.9–50.2%); code n=1,554,446 → 72.1% ≥1024 / 46.5% ≥2048 (range 65.3–75.6%).
  Run 1's single 3-hour slice (conv 48.7/32.7; code 70.2/45.0) was **not** an artifact — within ~2pp all week.
- The 1024 floor keeps doing real work on Azure conv all week (over half fall below it). No change to the lever.

**Prefix / block reuse (run-1 finding (3)) — CONFIRMED exactly.** Same 1-hour Mooncake trace recomputed
identical: block-reuse conv 36.6% / tool-agent 55.3%; reuse-gap p90 conv=519s / tool=243s.

**Tool-result size distribution (SWE, drives `maxTokens` 200→500) — CONFIRMED at 10× n.**
n=127,328 SWE-rebench tool-results (run 1: n=13,084): median **293** (run 1: 302), mean 679, p90 1,731,
p99 6,074, max 13,817. `>200` fires on **62.0%** (run 1: 64%); `>500` fires on **31.7%** (run 1: 33%).
Median still ~1.5× the current 200 floor, so a 200 pre-pass compacts the *typical* observation, not just the tail.

**Tool-schema weight — CONFIRMED EXACTLY (SWE) and generalises (off-SWE, heavier).**
SWE-rebench: 5 tools = 15,672 bytes = 4,962 tok, identical across all 2,000 trajectories (min=median=max),
= 50.8% of first request (median). Off-SWE it is the *floor*: schema share of cold first request is
APIGen 66.9% (n=550 traj), ToolACE 79.7% (n=600), glaive 72.5% (n=800). Confirmed and promoted below.

**Output re-emission ~0% on agents — CONFIRMED, now across 7 agent corpora.** New this run: APIGen
median 0.0% / token-weighted 4.57% (n=5,220 turns); ToolACE 0.0% / 0.2% (n=2,695); glaive 0.0% / 1.51%
(n=2,569). With the 4 run-1 corpora this is 7 independent agent datasets all ≪ the chat 24% / 61%-p90 band.

**History gates `minimumTurns`=3 / `keepRecentTurns`=2 — CONFIRMED across 3 more corpora.** SWE-rebench
~61 turns/traj (n=129,334 turns). Off-SWE: APIGen median 9 turns, ToolACE 4, glaive 3 (so glaive mostly
skips the ≥3 floor — correct, it is near-stateless). Stale-oversized (>200 tok, older than last 2 turns):
SWE median 36/traj, 100% of trajectories have ≥3 — unchanged from run 1.

**Duplicate-context dedup ceiling ~7% — CONFIRMED.** SWE-rebench within-trajectory byte-identical
duplicate tool-results 9,101/127,328 = **7.15%** (run 1: 6.9%); APIGen 8.9% (228/2,557). Ceiling ~7–9%.

---

## Revised

**TTL guard (run-1 finding (1): "stamp 1h for a workload when p90>300s") — REVISED. This is run 2's
main finding.** The p90>300s coverage trigger does **not** survive write-premium pricing. Charging
Anthropic's premiums (write 5m=1.25×, 1h=2.0×, read=0.1×, uncached=1.0×) on cacheworthy blocks (≥2 uses):

| workload (Mooncake) | cacheworthy n | flat 5m@1.25× | flat 1h@2.0× | oracle per-block | blocks preferring 1h |
|---|---|---|---|---|---|
| conversation | 44,144 | 38.7% | 34.0% | 47.5% | 39.2% |
| tool-agent | 39,481 | 65.7% | 61.8% | 69.4% | 31.8% |
| synthetic | 18,251 | 60.1% | 54.0% | 63.0% | 36.1% |

Flat-1h *loses* to flat-5m on all three workloads (conversation −4.7pp) because the 2.0× write is taxed on
every cacheworthy block, including the 60.8%/68.2% with no reuse gap in (300s, 3600s]. Per block, 1h beats
5m iff it has ≥1 such long-then-reused gap. **Replace the workload-p90 trigger with per-prefix adaptive
promotion:** 5m default; promote an individual prefix to 1h only after an observed >300s-then-reused gap.
Oracle adaptive beats flat-5m by +8.76pp (conv) / +3.67pp (tool) / +2.90pp (synth).

**SWE output re-emission "~0%" (run 1) — REVISED / SHARPENED (headline for the SWE pull).** The ~0%
replicates only under run 1's implicit context definition (context = non-assistant msgs only: median 0.0% /
token-weighted 0.18%, n=129,334). The faithful reading of the shipped metric — context = full request body
including re-sent prior assistant turns — gives **6.2% median / 11.6% mean / 3.25% token-weighted**. Cause:
the agent re-issuing near-identical tool-call commands turn after turn. Both still ≪ 24%, so the lever
conclusion is unchanged; run 1's 0% was a definition artifact, not a true zero. Honest agent ceiling ~3.25%.

**"Median tool-result ≈ 270–302" (run 1) — REVISED: observation-type-specific, NOT universal.** It holds
tightly for DB-record/file-read agents (SWE 291–302; CS agents APIGen airline 258 / retail 314; tau-bench 270),
but does NOT generalise: synthetic-API agents run 16–98 tok (ToolACE 97.5 n=952, glaive 16 n=575), and web
agents run **~28,237 tok median** (Mind2Web cleaned_html, n=2,070, real pages). ~1000× span across agent types.

**SWE request-size median — minor downward revision.** 41,116 → **38,102** tok/turn (−7.3%), attributable to
run 1's head-200 slice vs this position-stratified n=2,000 draw. Shape (≈61 turns, monotonic growth, max 179,520)
intact.

---

## New findings

**Mooncake reuse-gap right-censoring — the hidden long-tail is empirically small.** A block's final use starts
a reuse-wait we never see complete. Conversation: 182,790 censored waits (63.4% of all); of those 88.9% had
>300s of trace remaining and were still never reused (79.4% had >600s); only 11.0% were genuine "ran out of
trace" cases. Tool-agent: 183,300 censored (44.7%); 89.6% had >300s remaining unreused. **A block quiet for
~300s almost never returns within the hour** — this weakens, not strengthens, the case for a long TTL, and
characterizes run 1's "tail past 50min UNKNOWN" as ~11% of waits, not a large mass.

**Mooncake reuse-gap tail, finer TTL tiers (all gaps).** Conversation n=105,710 gaps: p90 519 / p95 627 /
p99 1,578 / p99.9 2,877 / max 3,030; coverage 5m 78.5% → 10m 93.7% → 1h 100%. Tool-agent n=226,316: p90 243 /
p95 384 / p99 609 / max 3,015; 5m 92.6% → 10m 99.0%. Conversation's past-5m tail is overwhelmingly the
300–600s band (5m→10m recovers +15.2pp; 10m→1h only +6.3pp). 1h reaches 100% only because the trace is
bounded at T=3,537s.

**Azure full-week idle-gap tails — closed as structurally UNKNOWN, not under-sampled.** Fleet inter-arrival
gaps pooled: conv (n=1.35M) p99 161ms, max **0.60s**; code (n=1.55M) p99 186ms, max **1.07s**; zero gaps >5s
in either, all week. Diurnal variation is in rate (26–82 req/s), not idle gaps. Azure-2024 cannot show
cache-TTL idle-gap tails — the aggregate stream is never idle and there is no prefix/session linkage. The
reuse-gap tail is a per-prefix property only Mooncake can observe. This retires run 1's "pull the full week
to get idle gaps" action item: the week was pulled; the gaps are not in this dataset by construction.

**Azure prefill-dominance over the whole week.** out:in medians conv ~0.048 / p90 0.221; code ~0.004 / p90 0.060,
rock-stable across ~2.9M requests / 7 days. Output-side levers earn ~nothing on Azure serving traffic.

**Off-SWE agent shapes (new corpora).** Web/document agents need a distinct compaction profile: a 28k-token
median page compacted to 500 is a 56× reduction vs the ~5× the pre-pass was tuned for, so for
web/browser/document workloads `keepRecentTurns` (not `maxTokens`) is the real safety guard. Off-SWE tool
schema is the single largest cold-first-request component (67–80%), heavier than SWE's 48–51%. Request size
spans ~135× across agent types (glaive 305 → SWE 41k tok/turn), reinforcing "key batch-tier on
output-shape/traffic-class, not raw size."

---

## Lever backlog deltas

Ready for `docs/rnd/lever-backlog.md`:

- **TTL guard — REVISED.** Drop "stamp 1h for a workload when p90>300s." Replace with **per-prefix adaptive
  5m→1h promotion** (5m default; promote on an observed >300s-then-reused gap). Flat-1h is net-negative vs
  flat-5m on all Mooncake workloads (conv −4.7pp). Oracle adaptive +8.8 / +3.7 / +2.9pp (conv/tool/synth).
- **`maxTokens` 200→500 (agent tier) — CONFIRMED,** now on APIGen (n=2,557) + whole non-SWE family. Fired
  fraction 62.0%→31.7% on 127,328 SWE results. Universal-for-agents *as a safe trigger floor*: tail-selective
  on the medium family (APIGen airline 4.7%, retail 25.6%, SWE 33–34.5% fire at 500), harmlessly inert on
  short-function agents (ToolACE 3.9%, glaive 0%). NOT a universal compression *target* — web agents (28k median)
  need their own profile.
- **Cacheable-min 1024/2048 split — CONFIRMED,** stable over a full Azure week (conv 46.9–50.2% ≥1024; code
  65.3–75.6%). No change.
- **Tool-schema compaction — PROMOTE.** Confirmed exact on SWE (4,962 tok × 61 turns ≈ 302,700 schema-tok/traj;
  30% trim ≈ 1,489 tok/cold-turn) and is the heaviest single cold-first-request component off-SWE (67–80%;
  APIGen ~32.5k schema-tok/traj, 30% trim ≈ 1,027 tok/cold-turn). Schema always >1024/2048 → independently
  cacheable. Raise priority.
- **De-prioritize output-side levers for Tier-1 permanently — CONFIRMED.** Prefill-dominance (out:in ≤0.05
  median) over ~2.9M Azure requests / 7 days.
- **Output re-emission metering — CONFIRMED/SHARPENED.** Honest agent ceiling ~3.25% token-weighted (faithful) /
  ~0.18% (run-1 definition) on SWE; 0.2–4.6% token-weighted across the other agent corpora. No agent
  output-mutation lever may be sized off the 24% / 61%-p90 chat band.
- **Duplicate-context dedup — CONFIRMED.** Size expectations at ~7–9% of tool-result messages.
- **History gates `minimumTurns`=3 / `keepRecentTurns`=2 — CONFIRMED** across 3 more corpora. No change.

---

## Still UNKNOWN

- **Gated/unreachable datasets contributed no numbers (said loudly):** `THUDM/AgentBench` (404/private);
  `gaia-benchmark/GAIA`, `GAIA-benchmark/GAIA`, `gaia-benchmark/validation` (gated/404);
  `xlam-function-calling-60k`, `ToolBench/ToolBench`, `sierra-research/tau-bench`, `webarena` mirrors (gated/404).
  No figures computed for any of these.
- **No provider `usage` / cache fields** in SWE-rebench or the HF agent corpora — token counts are the
  `approximateTokenCount` proxy (±~15%), not billed. Azure 2024 has no cache flag and no session linkage.
- **Azure cache-TTL idle-gap tails are unobservable by construction** (max fleet gap ~1s, no prefix/session
  linkage) — not a sampling shortfall. Mooncake is the sole public cache-TTL proxy.
- **Sampling caveats:** SWE-rebench is position-stratified (2,000 of 67,074 = 3.0%), not uniform-random;
  Azure is HTTP-Range window sampling (15 windows of ~8 MB). The genuine "ran out of trace" Mooncake
  reuse-wait horizon (~11% of conversation waits) is still unknown beyond T=3,537s.
- **Benchmark vs production:** every agent corpus here is benchmark/instruction data, not a billed serving
  trace — apples-to-apples with run 1's Tier 2, but none is weighted to a fleet %.

---

*Raw slices/scripts under the scratchpad `data/` dir: `mc_*.jsonl`, `az24w_*.csv`,
`apigen_strat.jsonl`, `toolace.jsonl`, `glaive.jsonl`, `mind2web_obs.jsonl`, `analyze.py`, `mesh_lib.py`.*
