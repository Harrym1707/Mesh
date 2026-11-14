# Dataset analysis findings — 2026-10-27 (sample-derived, calibration only)

Engineering findings report for MESH R&D. Consolidates three independent sampling passes run 2026-10-27 — production serving traces (Tier 1), agent/tool-use trajectories (Tier 2), chat traffic (Tier 3) — into one calibration reference for the lever backlog.

Honesty contract for this doc: every figure carries its sample size and is **sample-derived, not a billed or published savings %**. Nothing here is extrapolated to a fleet-wide or billed percentage. Token counts are provider-reported where the source carried them (Mooncake, Azure, BurstGPT, SWE-Bench-Verified-O1 `usage`) and tokenizer-proxy otherwise (MESH `approximateTokenCount` for agent corpora; tiktoken `cl100k_base` for WildChat, read as ±~10% vs the Claude tokenizer). Sources a tier marked unreachable (LMSYS-Chat-1M, ToolBench) contribute no numbers and appear only under "What the data does NOT support."

MESH defaults these calibrate against: cacheable minimum 1024 (Sonnet/Opus/Fable) / 2048 (Haiku); semantic-compaction pre-pass `maxTokens=200`, `minimumTurns=3`, `keepRecentTurns=2`; cache TTL 5m (1.25x write premium) vs 1h (2x write premium).

---

## Headline findings

The 5–8 statistics that most change what we build. Format: finding (with n) -> lever change (before/after arithmetic) -> confidence.

1. **Serving traffic is prefill-dominated.** Output:input medians are 0.005–0.28 across every serving cut (Mooncake conv n=12,031 median 0.038; tool-agent n=23,608 median 0.006; Azure-2023-code n=8,819 median 0.011; Azure-2024-code n=242,851 median 0.005) — the only exceptions are BurstGPT GPT-4 (0.3) and conversation-log (0.4) cuts. -> **Prioritize cache levers (placement, TTL, cacheable-minimum) and batch-tier routing over output-side levers for Tier-1 traffic**; output levers earn nothing on this shape. -> **High** (reproduced across 4 independent trace families).

2. **Tool-agent prefix reuse is 55.3% at the block level** (Mooncake `hash_ids`, 409,616 512-tok blocks, 226,316 repeats; conversation 36.6% of 288,500 blocks), and 100% of conversation + tool-agent requests show at least some reuse. -> **This is the prize for the cache-placement lever on serving traffic**, far larger than any cacheable-minimum tuning. -> **High** (full 1-hour trace, not sampled), bounded to 1 hour of wall-clock.

3. **Tool-agent reuse gaps are caught 92.6% by a 5m TTL; conversation only 78.5%** (Mooncake inter-reuse gaps: tool-agent n=226,316 p90=243s; conversation n=105,710 p90=519s, max 3,030s). Paying the 2x 1h write premium buys tool-agent only +6.4pp (->99.0%) but recovers conversation's full ~21.5% tail (max gap 50min < 1h). -> **Make the TTL idle-gap guard workload-aware: 5m default, stamp 1h only when realized reuse-gap p90 > 300s.** Conversation (p90 519s) qualifies; tool-agent (p90 243s) does not. -> **High** for the split rule; the conversation tail past 50min is UNKNOWN (bounded by trace length).

4. **Semantic pre-pass `maxTokens=200` over-fires on agent tool-results.** Median tool-result size is 302 tok (SWE-rebench n=13,084), 291 (SWE-smith n=2,518), 270 (tau-bench n=1,164) — so a 200 floor flags 64% / 58% / 68% of ALL results, compacting the typical observation. At 500 the fired fraction drops to 33% / 34.5% / 3.5% (the genuinely oversized tail). -> **Raise pre-pass `maxTokens` 200 -> 500.** -> **High** (two code corpora + one CS corpus agree). NB this contradicts the Tier-1 read (see headline 8) — the split is agent-trajectory vs serving-trace tool-result, resolved under Lever backlog.

5. **Output re-emission is ~0% on agent/tool traffic.** Line-level `measureOutputReEmission` (exact ported method): median 0.0% in all four agent corpora, mean 0.1–4.9%, p99 3.4% (SWE-rebench n=13,083), holding even when tool-call arguments (where file edits live) are counted as output. -> **Do not size any agent-side output-mutation lever off the 24%/61%-p90 re-emission band** — that band is chat/file-reprint-shaped only; metering stays honest and reports ~0 here. -> **High** (robust across 4 corpora including tool-call args).

6. **Cacheable minimum is genuinely per-model/per-workload, confirmed by a direct contradiction in the sample.** SWE-Bench-Verified-O1 realized provider cache only in ≥2,560-tok, 128-aligned blocks (n=159) -> argues 2048 for that model; tau-bench's fixed policy doc is exactly 1,801 tok (n=200, present in 100% of requests) and falls between 1024 and 2048 -> a 2048 floor would strand a prefix in every request, 1024 captures it. -> **Keep the 1024/2048 split per-model; do not globalize to one constant.** -> **High** (two workloads argue opposite directions).

7. **Real agent cache-hit ratio is ~half of prompt tokens, with a small zero-cache minority.** SWE-Bench-Verified-O1 provider `cached_tokens`/`prompt_tokens`: per-call median 45.3%, fleet aggregate 50.8% (1,184,000/2,328,888); zero-cache calls 4/163 = 2.5%. -> **Size the cache-placement volatility guard to the 2.5% prefix-busting minority** — real, worth guarding, but not a dominant failure mode. -> **Medium** (n=163 calls, 10 trajectories).

8. **BurstGPT `Log Type` cleanly separates batch-eligible from interactive traffic.** API-log (n=170,104): median output 7 tok, out:in p99 1.6, 86% of rows; Conversation-log (n=27,719): median output 243 tok, out:in p90 7.0 — a ~35x median-output gap. -> **Route batch-tier on traffic-class / output-shape, not raw request size.** Cleanest batch candidates: BurstGPT API-log, Azure-code, Mooncake tool-agent. -> **High** for the separator; head-slice sampling caveat applies (see below).

---

## Per-tier detail

### Tier 1 — Production serving traces (sample-derived)

**Mooncake (Kimi/Moonshot) — full 1-hour trace, not sampled.** `hash_ids` = remapped 512-tok prefix-block hashes.

Token distributions (tokens, input / output):

| file | n | input med / p90 / p99 / mean | output med / p90 / p99 / mean |
|---|---|---|---|
| conversation | 12,031 | 6,909 / 27,367 / 85,400 / 12,035 | 350 / 597 / 1,119 / 343 |
| tool-agent | 23,608 | 6,346 / 16,806 / 61,661 / 8,596 | 30 / 507 / 898 / 182 |
| synthetic | 3,993 | 11,587 / 38,611 / 66,456 / 15,326 | 69 / 389 / 768 / 149 |

Prefix reuse (infinite-cache upper bound, timestamp order):

| file | 512-tok blocks | unique | block reuse rate | per-req cacheable-prefix frac (med / p90 / mean) | reqs w/ any reuse |
|---|---|---|---|---|---|
| conversation | 288,500 | 182,790 | 36.6% (105,710 repeat) | 33.3% / 92.9% / 38.4% | 12,030/12,031 = 100% |
| tool-agent | 409,616 | 183,300 | 55.3% (226,316 repeat) | 75.0% / 92.3% / 63.0% | 23,604/23,608 = 100% |
| synthetic | 121,877 | 43,924 | 64.0% | 0.0% / 98.7% / 42.3% | 1,782/3,993 = 44.6% |

Shared system-prefix block id 0: present in 100% of conversation requests, 46.3% of tool-agent, 0% of synthetic. Block-0 reuse-gap median = 0.00s (p90 ≤ 3s) in both — the system prefix is re-hit continuously.

Inter-reuse idle gaps (seconds between consecutive uses of a block):

| file | n gaps | median | p90 | p95 | p99 | max | caught by 5m (300s) | caught by 1h |
|---|---|---|---|---|---|---|---|---|
| conversation | 105,710 | 114s | 519s | 627s | 1,578s | 3,030s | 78.5% | ~100% (max 50min) |
| tool-agent | 226,316 | 0s | 243s | 384s | 609s | 3,015s | 92.6% | 99.0% |

Cacheable-minimum admission (input ≥ threshold): conversation 88.7% ≥1024, 76.7% ≥2048; tool-agent 94.8% ≥1024, 89.1% ≥2048. The ~11% of conversation under 1024 is correctly left un-cached (write premium would not amortize). Output re-emission anomaly ceiling (sample bounds only; no text in trace): size an output-side flag near p99 — ~1,100 tok conversation, ~900 tok tool-agent. Caveat: 1 hour wall-clock only; no model-id; idle-gap tail past ~1h unobservable (max gap bounded by trace length -> true conversation tail past 50min UNKNOWN).

**Azure LLM Inference Trace 2024 — START-OF-WEEK SLICE ONLY** (first ~10MB byte-range of each 1-week file; conv slice 2024-05-12 00:00->02:33, code slice 2024-05-10 00:00->03:22). Arrival/idle-gap calibration from this slice is NOT valid at fleet-week scale.

| service | n | input med / p90 / p99 / mean | output med / p90 / p99 / mean | out:in med/p90/p99 | ≥1024 / ≥2048 |
|---|---|---|---|---|---|---|
| conv | 240,619 | 931 / 3,877 / 6,583 / 1,651 | 41 / 400 / 771 / 118 | 0.047 / 0.217 / 0.804 | 48.7% / 32.7% |
| code | 242,851 | 1,813 / 5,885 / 7,685 / 2,386 | 9 / 49 / 305 / 25 | 0.005 / 0.079 / 1.096 | 70.2% / 45.0% |

Over half of conv requests fall below the 1024 floor — the floor is doing real work. Cache-TTL idle-gap CANNOT be calibrated from this slice (no cache field, 3-hour window); pulling the full week (1.13 GB) deferred.

**Azure LLM Inference Trace 2023 (Splitwise) — full files, one service-day.**

| service | n | input med / p90 / p99 / mean | output med / p90 / p99 / mean | out:in med/p90/p99 | ≥1024 / ≥2048 |
|---|---|---|---|---|---|---|
| code | 8,819 | 1,469 / 5,188 / 7,436 / 2,048 | 13 / 55 / 252 / 28 | 0.011 / 0.143 / 1.156 | 62.1% / 37.5% |
| conv | 19,366 | 1,020 / 2,735 / 4,142 / 1,155 | 129 / 424 / 601 / 211 | 0.279 / 0.592 / 4.982 | 49.4% / 14.0% |

Conv median input 1,020 sits right on the 1024 floor; 49.4% clear 1024, only 14.0% clear 2048 — sharpest confirmation that the Haiku 2048 floor is materially stricter than 1024 for conversational traffic.

**BurstGPT — 200k-row head slice** (first 200,000 data rows of 1.43M; after dropping 2,177 zero/zero rows, n=197,823). Time-ordered head, not a uniform draw. README Session-ID/Elapsed columns confirmed absent (only 6 columns) -> no session/turn calibration.

| cut | n | input med / p90 / p99 / mean | output med / p90 / p99 / mean | out:in med/p90/p99 | ≥1024 |
|---|---|---|---|---|---|
| all (nonzero) | 197,823 | 116 / 1,518 / 3,060 / 435 | 36 / 241 / 581 / 100 | 0.1 / 1.3 / 10.7 | 13.3% |
| ChatGPT | 188,445 | 115 / 1,471 / 3,061 / 419 | 24 / 218 / 552 / 92 | 0.1 / 1.3 / 7.9 | 12.5% |
| GPT-4 | 9,378 | 566 / 1,783 / 2,858 / 766 | 238 / 492 / 782 / 256 | 0.3 / 5.4 / 20.0 | 30.2% |
| logtype=Conversation | 27,719 | 519 / 1,666 / 2,403 / 701 | 243 / 531 / 924 / 268 | 0.4 / 7.0 / 26.6 | 29.1% |
| logtype=API | 170,104 | 107 / 1,294 / 3,063 / 392 | 7 / 181 / 292 / 73 | 0.1 / 1.2 / 1.6 | 10.8% |

Only 13.3% of BurstGPT reaches 1024 (10.8% of API-log); input median 116 is an order of magnitude below Mooncake/Azure — a short-prompt high-volume API regime where cache levers are largely inert and batch-tier + tool-schema compaction carry savings. Per-model prior: GPT-4 traffic ~5x heavier both sides than ChatGPT (input median 566 vs 115, output 238 vs 24; p90 output 492 vs 218).

Raw slices saved at `/private/tmp/claude-501/-Users-harrymanley-Library-Application-Support-Claude-scratch-workspaces-6f830402-2748-4cce-858b-3f838cb7b533-8fd76122-fdca-4438-bb46-a144702e46a3-scratch-2026-10-08-6a3036/45a500e7-4064-49fe-89a4-a563c99426c8/scratchpad/data/`.

### Tier 2 — Agent / tool-use trajectories (sample-derived)

Rows pulled live via HuggingFace datasets-server rows API and raw GitHub. Token figures use MESH `approximateTokenCount` (ported to Python, verified byte-identical on 4 test strings); re-emission uses the exact `measureOutputReEmission` from `packages/core/src/output-diagnostics.ts`.

**1. nebius/SWE-rebench-openhands-trajectories — n=200 trajectories (of 67,074).** Richest source: ships a separate `tools` field.
- Tool schema: 5 tools/traj (fixed), 15,672 bytes = 4,962 MESH tokens, identical across all 200. 48.0% of first request (median); 12.1% median / 15.6% mean across all turns.
- History: 60.5 assistant turns/traj median, p90 100, max 100. Request size per turn (n=13,083): median 41,116, p90 75,534, max 131,776 tok.
- Output re-emission (assistant content + tool_call args, n=13,083): median 0.0%, mean 0.1%, p90 0.0%, p99 3.4%. Tool-call-args-only: all 0.0%.
- Byte-identical duplicate tool-results: 904/13,084 = 6.9%. Consecutive byte-identical (retry proxy): 0/26,167 = 0.00%.
- Tool-result sizes (n=13,084): median 302, mean 690, p90 1,750, p99 5,781, max 13,230 tok. Stale oversized (>200, older than last 2 turns): median 38/traj, mean 41, p90 61; 100% of trajectories have ≥3.

**2. AlexCuadron/SWE-Bench-Verified-O1 — n=10 trajectories / 163 LLM calls (of 495).** CATALOGUE CORRECTION: this mirror retains full provider `usage`, real `cost`, and `cached_tokens` (catalogue row 5 marked token counts UNKNOWN on public mirrors — corrected).
- prompt_tokens: median 13,350, mean 14,287, p90 25,192, max 46,223. completion_tokens: median 1,365, mean 1,954 (reasoning_tokens median 1,280). cached_tokens: median 2,560, mean 7,263, max 32,000.
- Cache-hit ratio (cached/prompt): per-call median 45.3%, mean 51.7%, p90 96.6%; fleet aggregate 50.8%. Zero-cache calls: 4/163 = 2.5%. Real cost median $0.257/call, sample total $45.17. Nonzero `cached_tokens` all multiples of 128, minimum realized 2,560 (n=159).

**3. SWE-bench/SWE-smith-trajectories — n=100 trajectories (of 24,100).** Native `tool_calls` present but tool *definitions* not stored (system message median 21 tok) -> no tool-schema-bytes signal.
- Assistant turns/traj: median 22, mean 26.2, p90 42, max 120. Request tokens/turn (n=2,618): median 16,127, p90 41,831, max 114,031.
- Tool-result sizes (n=2,518): median 291, mean 916, p90 2,036, p99 7,058, max 46,221. >200 tok: 58.0%; >500: 34.5%; >1,000: 18.3%.
- Output re-emission: median 0.0%, mean 4.9%, p90 0.0%. Byte-identical tool-results: 170/2,518 = 6.8%. Consecutive dup: 0/5,236 = 0.00%. Stale oversized (>200, older than last 2): median 12/traj, mean 14.6, p90 25.

**4. tau-bench gpt-4o-airline — n=200 trajectories (all in file).** Customer-service shape; fixed policy doc resent as system message every turn.
- Policy/system doc: exactly 1,801 tokens, fixed (min=median=max across all 200). ≈49% of first request.
- Assistant turns/traj: median 11, mean 12.3, p90 20, max 30. Request tokens/turn (n=2,454): median 3,204, p90 6,285, max 12,407.
- Tool-result sizes (n=1,164): median 270, mean 258, p90 384, max 3,232 — tighter than code agents. Output re-emission: median 0.0%, mean 2.0%, p90 0.0%. Byte-identical tool-results: 85/1,164 = 7.3%. Stale oversized (>200, older than last 2): median 3/traj, mean 3.6, max 20. >200: 67.8%; >500: 3.5%; >1,000: 2.5%.

### Tier 3 — Chat traffic (sample-derived)

**WildChat-1M (allenai/WildChat-1M) — n=995 unique conversations** (1000 rows pulled, offset 0–900, deduped on `conversation_hash`). Contiguous head-of-split convenience sample, not random. Composition: models gpt-4-0314 (593) / gpt-3.5-turbo-0301 (402) — 2 models, 2023 vintage; languages English 523 / Chinese 232 / Russian 63 / rest. No `system` role present in any row; no tool calls. Token counts use tiktoken `cl100k_base` as a proxy (±~10% directional).

- Turn-count (n=995): mean 2.78 rounds, median 2, p75 3, p90 7, p95 9, max 20. 1-turn 46.9% / 2-turn 19.5% / 3–5 turns 21.9% / 6+ turns 11.7%; ≥3 rounds = 33.6%.
- Per-message tokens: USER p50 21 / p90 266 / mean 152 (n=2,762); ASSISTANT p50 289 / p90 705 / mean 344 (n=2,762). Confirms the 2026-10-26 output ground-truth build (p50 236 / p90 702) — p90 near-exact, p50 higher (slice + cl100k vs that build's tokenizer).
- Cumulative request size by round: r1 (n=995) p50 29 / p90 457; r2 (n=528) p50 458 / p90 1,394; r3 (n=334) p50 789 / p90 1,923; r4 (n=240) p50 1,138 / p90 2,474; r5 (n=169) p50 1,489 / p90 2,864.
- Cacheable minimum per round (n=2,762): ≥1024 tok = 34.7% (65.3% too small to cache); ≥2048 = 17.7% (82.3% too small). The 2048 floor would strand an extra 17pp of rounds vs 1024 on chat-shaped traffic.
- Boilerplate: opener share (`as an AI` / `I'm sorry but` / `Certainly!` / `Sure,` / `I cannot` …) = 7.46% of messages but only ~0.26% of assistant tokens (~2,467 of 950,366) — a rounding error in token mass.
- Re-emission, two metrics: (a) mechanical history-resend fraction of turn-2+ requests pooled (n=1,766) p50 97.8% / p90 99.6%; (b) lexical 5-gram content overlap of turn-2+ messages (n=3,843) p50 0% / p75 4.1% / p90 35.5% / mean 9.4%; assistant-only (n=2,683) p90 25.0% / mean 7.2%; user-only (n=1,160) p90 79.0% / mean 14.6% (paste-back); per-conversation worst turn (n=977) p75 13.0% / p90 71.3%.
- Cache-TTL idle gaps (assistant-message timestamps only, n=1,767): p25 44s / p50 112s / p75 333s / p90 866s / p95 1,826s / max 22,053s. Gaps > 300s (5m TTL) evict: 27.6%; > 600s: 14.2%.
- Cost model on the sample (Anthropic ratios: cache-write 1.25x, cache-read 0.10x, output uncacheable; 995 convs, 2,998,404 input tok re-sent, 950,366 output tok): ideal naive caching input-only 51.6%, blended 26.5% (output@3x) / 20.0% (output@5x); guarded caching (multi-turn & ≥1024 only) blended 22.4% (3x) / 16.9% (5x), input-only 43.7%. All four blended figures land inside the 13–27% chat-caching caveat.
- Semantic-compaction pre-pass on this sample: eligible (≥3 rounds) 33.6% (n=334), of which 86.5% have an older region >200 tok (compaction bites). Older-region mass p50 1,063 / p90 3,469 tok -> implied compression at maxTokens=200 is 5.3x (p50) / 17.3x (p90). Compaction-only blended reduction 16.1% (3x) / 12.1% (5x), input-only 31.4%. Tuning sweep (input-only reduction): keepRecentTurns=2 ties =3 at 31.4% and dominates =1 (20.6%); maxTokens 100 vs 200 buys only +2.0pp (33.4 vs 31.4) at the cost of p90 compression 17x->35x.

---

## Lever backlog deltas

Concrete parameter changes / new-lever proposals this data justifies, ready to drop into `docs/rnd/lever-backlog.md`:

- **TTL idle-gap guard — make workload-aware (NEW split rule).** Default 5m; stamp 1h only when the realized reuse-gap p90 > 300s. Evidence: Mooncake tool-agent gap p90=243s (5m catches 92.6%, 1h adds only +6.4pp) -> stays 5m; Mooncake conversation gap p90=519s, max 3,030s < 1h (5m catches 78.5%, 1h recovers the full ~21.5% tail) -> stamps 1h. WildChat chat traffic corroborates the interactive-tail case: 27.6% of multi-turn continuations evict at 300s, dropping to 14.2% at 600s (a 13.4pp recovery). Replaces a flat TTL default with a p90-keyed guard.

- **Semantic pre-pass `maxTokens` 200 -> 500 for agent-trajectory tool-results.** At 200 the floor flags 64% / 58% / 68% of ALL tool-results (SWE-rebench n=13,084 median 302; SWE-smith n=2,518 median 291; tau-bench n=1,164 median 270); at 500 it flags 33% / 34.5% / 3.5% (the oversized tail only). Keep 200 as a Tier-1 serving-trace setting (see "does not support") and expose ~120 as an aggressive tier. Net: default becomes workload-scoped, not a single global 200.

- **Semantic pre-pass `keepRecentTurns` — keep 2 (CONFIRMED, close the UNTUNED flag).** WildChat sweep: =2 is the savings plateau (31.4% input-only, ties =3, dominates =1 at 20.6%). Agent corpora: after protecting the last 2 turns there are still 38 / 12 / 3 stale-oversized results/traj against 41k / 16k / 3.2k-tok median requests. No change; mark tuned.

- **Semantic pre-pass `minimumTurns` — keep 3 (CONFIRMED, close the UNTUNED flag).** Structural floor = keepRecentTurns+1. WildChat: fires on the 33.6% with ≥3 rounds, skips the 66.4% single/2-turn. Agent corpora median turns 60 / 22 / 11, all ≫ 3. No change; mark tuned.

- **Cacheable minimum — keep the 1024/2048 split per-model; do NOT globalize (CONFIRMED).** SWE-Bench-Verified-O1 realized cache only in ≥2,560 128-aligned blocks (n=159) -> 2048 for that model; tau-bench 1,801-tok policy doc (n=200, in 100% of requests) falls between 1024 and 2048 -> needs 1024 or loses a universal prefix. Serving traces admit 77–95% at 1024 (Mooncake) while correctly excluding the short-prompt BurstGPT regime (87% under 1024). Add a per-model note that the floor is a profitability knob, not a global constant.

- **Batch-tier routing — key on traffic-class / output-shape, not raw request size (NEW lever spec).** BurstGPT `Log Type` separates API-log (n=170,104, median output 7 tok, out:in p99 1.6, 86% of rows) from Conversation-log (n=27,719, median output 243, out:in p90 7.0) — a ~35x median-output gap. Cleanest batch candidates: BurstGPT API-log, Azure-code (median output 9–13), Mooncake tool-agent (median output 30, 94.8% input ≥1024). Request-size tier still motivated as a secondary signal (workload shapes vary 10x+: tau-bench 3.2k-tok/11-turn vs code agents 41k-tok/60-turn).

- **Cache-placement volatility guard — size to the ~2.5% prefix-busting minority.** SWE-Bench-Verified-O1: zero-cache calls 4/163 = 2.5% against a fleet 50.8% cache-hit baseline. Guard is real and worth building but should be sized as a minority-case guard, not a dominant-failure-mode lever.

- **Per-model output-re-emission prior — scale the heavier-model prior ~2–3x the light-model prior.** BurstGPT GPT-4 p90 output 492 vs ChatGPT 218 (n=9,378 / 188,445). Mooncake output anomaly ceiling ~1,100 tok conv / ~900 tok tool-agent (p99) for an output-side flag that will not trip on normal traffic.

- **New metric to pin before the output-re-emission-metering lever ships:** the "turn-2+ re-emission p90 = 61%" figure is definition-ambiguous — WildChat pooled per-message 5-gram overlap p90 = 35.5%, per-conversation worst-turn p90 = 71.3%; 61% sits between two aggregations. Pin aggregation (per-message vs per-conversation-worst) and n-gram width in the ground-truth build before this feeds the lever's trigger threshold.

- **Duplicate-context dedup — ceiling ~7% of tool-result messages.** Byte-identical repeats 6.9% / 6.8% / 7.3% across SWE-rebench / SWE-smith / tau-bench; consecutive duplicates 0.00% (not retries — intra-conversation re-reads). Plus WildChat user-side paste-back (p90 79% lexical overlap) is a dedup target, not an output-metering one. Size dedup expectations to ~7%, modest but real.

- **Tool-schema compaction — confirmed high-value.** SWE-rebench: 5 tools = 4,962 tok (48% of first request), resent ~60x/traj ≈ 298k schema-tokens/trajectory before cache; a 30% trim ≈ 1,490 tok/turn. Schema bytes are dominated by tool descriptions, not tool count. (Tool schema always exceeds 2,048 -> independently cacheable regardless of the minimum.)

---

## What the data does NOT support

Findings we expected but the sample could not confirm, plus everything marked UNKNOWN. Per the honesty rules these are reported as gaps, not filled with invented numbers.

- **No billed or published savings %.** Nothing here is a billed figure. The WildChat cost model (blended 16.9–26.5% on 995 convs) confirms the "input caching caps chat at 13–27%" caveat as internally consistent but is a sample cost-model result, not a per-task gated-replay number. The interactive/chat band 25.9–34.3% is only PARTIALLY reproduced: caching alone reaches the low-20s blended, compaction stacks toward ~26–30% (the lower band), and the **34.3% ceiling is NOT reproducible from chat-shaped traffic** — it requires tool-bearing interactive sessions WildChat lacks. Flag: verify the top of the interactive band is driven by tool-bearing sessions, not pure chat.

- **`minimumTurns` and `keepRecentTurns` cannot be calibrated from Tier 1.** None of the five serving traces carry session/turn linkage (Mooncake has no session id; BurstGPT's README Session-ID column is confirmed absent; Azure has no session field). These gates are calibrated from Tier-2 (agent turn counts) and Tier-3 (WildChat rounds) only. The Tier-1 contribution here is UNKNOWN.

- **Semantic pre-pass `maxTokens` stays 200 for serving-trace tool-results — the 500 move is agent-only.** On Tier-1 output/generated-token distributions (the closest proxy for tool-result size) only ~10–15% exceed 200 (Mooncake tool-agent p90 507; Azure-code p90 55). The 200->500 recalibration is justified for agent trajectories, NOT for serving traffic; applying it globally would under-compact the serving tier. The two reads are reconciled by scoping, not by a single number.

- **LMSYS-Chat-1M contributed zero.** Gated-access premise did not hold for token identity `harrym1707` (read scope): repo metadata resolves 200 but every data file returns HTTP 403 ("restricted … not in the authorized list", `gated: auto`). No LMSYS statistics computed — UNKNOWN. To unblock: approve the access request for `harrym1707` on the LMSYS gate form.

- **ToolBench not sampled.** Catalogue row 6 lists only the repo URL; data ships via unconfirmed Google Drive / Tsinghua Cloud links, and ~20 HF community mirrors are of unverified provenance. Per the honesty rules no mirror was sampled — UNKNOWN this pass. Tool-schema evidence comes from the three confirmed-resolving trajectory datasets instead.

- **Agent output-re-emission does NOT match the 24%/61%-p90 band.** We expected the re-emission band to apply to agent/tool traffic; it does not — median 0.0% across all four agent corpora even counting tool-call args. The 24%/61% band is chat/file-reprint-shaped only. No agent-side output-mutation lever should be sized off it.

- **System-prefix / tool-schema ratio is UNKNOWN from chat corpora.** WildChat has no `system` field and no tools, so true system-prefix ratio cannot be measured there (structural gap); those levers need Tier-2 agent traces or live wire-captures. Boilerplate-opener stripping is unsupported for chat (0.26% of token mass).

- **Diurnal / weekly arrival and idle-gap patterns are UNKNOWN at fleet scale.** Azure-2024 is a 2.5–3.4h start-of-window slice; BurstGPT is a 0.14% time-ordered head; Mooncake is 1 hour. Idle-gap tails beyond the respective windows (Mooncake conversation past 50min especially) are bounded by trace length, not observed — do not treat the TTL arithmetic as fleet-week-valid.

- **No model-id on serving traces.** Mooncake carries no model-id field, so per-model TTL/cache behavior on that corpus is inferred from workload file, not model. Per-model priors above lean on BurstGPT (ChatGPT vs GPT-4) and SWE-Bench-Verified-O1 (single o1 model) only.
