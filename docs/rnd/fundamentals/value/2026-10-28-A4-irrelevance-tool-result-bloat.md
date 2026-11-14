# A4-irrelevance — stale/irrelevant tool-result bloat in agent trajectories

Axis: **A4-irrelevance** (the biggest-but-lossy axis). Date: 2026-10-28.
Mandate: measure, on REAL agent trajectories + framework captures, how much
INPUT is stale/irrelevant tool-result bloat that could be dropped or digested
without hurting task completion — and whether a deterministic, cache-stable
compaction is shippable, net of the already-shipped A1 prefix cache.

Basis labels on every number: **measured / derived-from-data / literature-claim / estimate.**
Measuring stick: python3 + tiktoken **o200k_base** (not chars/4).
Scripts: `evals/fundamentals/value/{swe_agent_droppability,compaction_net_of_cache,obs_shrink_on_arrival,toolbench_shrink}.py`.

---

## TL;DR verdict

Tool observations ARE the dominant token class in agent input (62–83% of
emitted tokens; 62% of the no-cache input bill — measured). But the clear,
defensible, *billable-today* value in A4 is **small (~0–1.5%)** on the real
workloads I could measure, for two independent reasons:

1. **The harnesses already cap/paginate tool results.** Observation *sizes*
   are mostly small (SWE-agent median 214 tok; ToolBench pre-capped median 61,
   max 625). The droppable mass sits in a thin fat tail, not the body.
2. **The shipped A1 prefix cache already recovered ~84% of the re-emission
   cost.** Dropping stale observations from the *middle* of the prefix busts
   the cache (forces a full re-write of the downstream suffix), so naive
   drop-stale compaction is **net-NEGATIVE** under caching: −8% to −14% pooled,
   and *worse* on long trajectories. This is the cache-pinning blocker,
   quantified.

The only cache-stable lever is **digest-on-arrival** (shrink each fresh
observation before it is first cached — append-only, never touches cached
tokens). Its lossless component is ~0–1.5% here (harnesses already squeezed
it); its material component is **lossy head+tail/structural truncation of
OVERSIZED results**, which needs the replay gate. On harness-paginated code
agents the ceiling is single-digit %. **The one place the number could be
large is the workload I could NOT measure locally: raw browsing / document /
data agents that inject full pages, files, or logs (10–50K-token
observations).** That is the biggest opportunity and the cheapest thing to test.

---

## Data measured

| Source | What | n | Access |
|---|---|---|---|
| `nebius/SWE-agent-trajectories` (HF) | full SWE code-agent trajectories w/ real bash+file observations | 300 sampled of 6670 | parquet, tiktoken |
| `Yhyu13/ToolBench_toolllama_G123_dfs` (HF) | API-agent (DFS) trajectories, `function` = raw API JSON results | 762 (test split) | parquet, tiktoken |
| `evals/trace-analysis/swebench-output-distributions.json` (local) | mini-SWE-agent + OpenHands+GPT-5 distributions | 20 traj each | prior measured |
| Mooncake `toolagent_trace.jsonl` (no-auth) | request input/output lengths for a tool-agent workload | 23 608 reqs | raw |
| `evals/wire-captures/*.jsonl` (local) | framework request bodies | 11 + 12 | raw — too small/synthetic for A4 |

---

## 1. Shape: agent input is observation-dominated (measured)

- **Mooncake tool-agent** request sizes [measured, n=23 608]: input median **6 346**,
  p90 16 810, max 126 195 tokens; output median **30**, mean 182. Input:output
  ≈ **200:1**. Agent requests are overwhelmingly input, so input-side levers
  are where any money is. (The trace is block-hash only — no content, no
  reconstructable multi-turn — so it bounds *shape*, not droppability.)

- **Emitted-token share by class** [measured]:
  | workload | system | task | assistant | **observations** |
  |---|---|---|---|---|
  | SWE-agent (nebius, n=300) | 7.5% | 6.4% | 18.2% | **67.8%** |
  | mini-SWE-agent bash (local, n=20) | 5.2% (sys+task) | | 32.9% | **61.8%** |
  | OpenHands+GPT-5 (local, n=20) | 8.2% | | 8.6% | **83.2%** |
  | ToolBench DFS (n=762) | 62.2% | 10.0% | 17.2% | 10.6% * |

  \* ToolBench's system prompt carries all the API schemas (an A2/tool-schema
  story), and its observations are **pre-truncated to ~1024 chars** by the
  ToolBench pipeline itself — direct evidence that practitioners already cap
  fat results.

- **Of the no-cache input bill** (sum of re-emitted prefixes), observations =
  **61.7%** on SWE-agent [derived-from-data, n=300]. Observations dominate the
  bill because every one is re-sent on every later turn.

## 2. But observations are mostly small — fat tail is thin (measured)

Observation token sizes:
| workload | median | p90 | p99 | max |
|---|---|---|---|---|
| SWE-agent (nebius) | 214 | 1 097 | 1 440 | 9 945 |
| ToolBench DFS | 61 | 379 | 604 | 625 (pre-capped) |
| mini-SWE-agent (local) | 143 | 676 | 4 435 | 13 505 |
| OpenHands+GPT-5 (local) | 308 | 2 185 | 5 990 | 9 971 |

The raw fat tail exists (p99 4–6K, max 10–13K on the un-paginated local
systems) but is a **small share of observations** (on SWE-agent only 0.8% of
observations exceed 1 500 tokens). OpenHands observations run ~2× fatter than
SWE-agent because it paginates less.

## 3. The crux: net of the shipped A1 cache, drop-stale compaction LOSES money

Simulated the real provider prefix-cache model faithfully (cache hit = longest
common **prefix**; divergence at msg *i* forces re-write of msgs *i..end* that
turn). Multipliers: cache-write **1.25×**, cache-read **0.10×** (Anthropic;
repo cost doc confirms read is actually 0.05× → my sim is *conservative*,
i.e. favorable to compaction). Mechanical stale signal = a later identical
observation, OR a later view of the same file path. [all derived-from-data, n=300]

| policy | pooled billed input | vs no-cache | **net vs A1 cache** |
|---|---|---|---|
| no-cache (naive agent) | 80 719 758 | — | — |
| **A1 cache (shipped baseline)** | 13 161 818 | **16.3%** | — |
| + drop-stale **eager** | 14 963 169 | | **−13.7%** (worse) |
| + drop-stale **batch 2 000** | 14 279 393 | | **−8.5%** (worse) |

- **A1 cache alone already recovers 83.7% of the no-cache bill.**
- Per-trajectory net of compaction over the cache baseline: eager median
  **+0.16%** (≈zero), mean −6.3%; batch median −1.0%. **Long trajectories
  (≥20 turns) are WORSE, not better: batch median −8.2%** — the cache-bust
  re-write of a bigger downstream suffix outweighs the read-savings.
- There is a narrow winning regime (per-traj best +38%: one large stale block
  dropped very early, many turns remaining), but the mechanical policy loses on
  average. **This is the cache-pinning blocker, quantified: any compaction that
  edits already-cached tokens is net-negative under the shipped cache.**

## 4. The only cache-stable lever: digest-on-arrival (append-only)

Shrink each observation the turn it is produced, *before* it enters the cached
prefix. Append-only ⇒ never busts the cache ⇒ savings strictly positive.
Net-of-cache weight = write-once (1.25×) + read×(remaining turns) (0.10×).
[measured/derived, n=300 SWE-agent]

| transform | emitted obs | net-of-cache obs cost | lossless? |
|---|---|---|---|
| **L1** strip ANSI/ctrl, collapse blank lines, trim ws | **−0.1%** | −0.0% | near-lossless (A2/A3) |
| **L2** head+tail truncation, cap 1 500 (trunc 0.8% of obs) | −1.7% | **−1.3%** | lossy (A4, gated) |
| **L2** head+tail truncation, cap 800 (trunc 26.6% of obs) | −17.5% | **−15.5%** | lossy, risky |

Translated to **total input bill** (obs ≈ 62% of it): safe cap ≈ **−0.8%**
total; aggressive cap ≈ **−9–10%** total but truncates a quarter of all
observations and *will* sometimes elide lines the agent needed → needs the
replay gate. On ToolBench the equivalent numbers are −1.5% (L1) / −2.8% (L2
cap-500) — tiny, because the data is already capped.

L1 near-lossless ≈ 0% here because these datasets are already normalized text.
On raw wire capture (real ANSI, carriage returns, pretty-printed JSON) L1 would
recover more, but that is A2/A3 redundancy, not A4 irrelevance.

## 5. Where the big number could live (NOT measured here)

Raw **browsing / document / data agents** that inject full HTML pages, whole
files, or full logs produce observations of **10–50K tokens** [literature/estimate —
no local dataset]. For those, deterministic head+tail or structural extraction
(e.g. keep the first/last N lines + any lines matching the agent's query, or
DOM main-content extraction) to a ~2K cap on arrival would cut **80–95% of that
observation**, cache-stable and net-positive. This is the only regime where A4
is both large and defensible — and I could not measure it because no local
un-paginated browsing trajectory dataset was available within the robustness
budget.

---

## Clear value, by workload (each labelled)

| workload shape | recoverable (obs cost, net of cache) | basis | lossless or gated |
|---|---|---|---|
| Harness-paginated code agents (SWE-agent, OpenHands) | **~1.3% safe / up to ~15% aggressive** of obs cost (≈0.8%–9% of total input) | derived-from-data, n=300 (+n=20 local) | gated (lossy truncation) — lossless part ≈0% |
| API-agent, pre-capped results (ToolBench) | **~1.5–2.8%** of obs cost | measured, n=762 | mostly gated; lossless ~1.5% |
| Raw browsing / document / data agents (full pages/files/logs) | **~50–90%** of oversized-obs cost *if* raw results are 10–50K tok | estimate / literature | gated (lossy) |

**Lossless-or-gated: MIXED.** The lossless slice (whitespace/ANSI/JSON-whitespace
normalization) is ~0–1.5% and near-worthless on harness-normalized traffic. The
material slice is gated lossy truncation.

**Biggest opportunity:** cache-stable **digest-on-arrival truncation of
oversized tool results** on workloads the harness does NOT already paginate
(browsing/document/data). On harness-paginated code agents the ceiling is
single-digit % because the fat tail is thin and A1 already captured re-emission.

**Cheapest experiment that confirms or kills it:** capture ~20 raw
browsing/document-agent trajectories with observation-capping DISABLED (or pull
an un-paginated browser-use / OpenHands-web set), measure the raw observation
token distribution, apply deterministic head+tail truncation at a 2K cap on
arrival, and run the existing replay gate (`evals/run-effort-gate.ts` style) on
task completion. One decision: does completion hold when oversized observations
are head+tail-truncated on arrival? If yes AND raw obs are fat → A4 is real and
large on that workload. If completion drops → A4 is gated-and-small everywhere,
and MESH should not chase it beyond the near-lossless normalizer.

**Confidence: medium.** Two real workloads measured directly + two more from
local measured data; the cache simulation is faithful and conservative. The
open risk is the unmeasured raw-browsing workload (where the big number might
be) and the absence of an actual replay-gate run (no API budget this session).
