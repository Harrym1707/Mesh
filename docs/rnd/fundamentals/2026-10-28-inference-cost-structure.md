# Inference cost structure — from the hardware up to the rate card

**Axis:** inference-cost-structure (fundamentals literature mine)
**Date:** 2026-10-28
**Author:** harryjpmanley@icloud.com (R&D lit-mine, inference-cost-structure axis)
**Scope:** WHY tokens cost what they cost (prefill/decode, KV-cache, attention scaling,
continuous batching, speculative decoding) and the PRICING STRUCTURE that falls out of
it across Anthropic, OpenAI, Google Gemini, DeepSeek — hunting rate-arbitrage slack MESH
has NOT catalogued.

> **Honesty labels on every number:** `measured` / `derived-from-data` /
> `literature-claim` / `reasoned` / `estimate`. Provider list prices are read directly
> off the vendor doc on the fetch date and labelled `provider-doc` (a literal reading,
> not a MESH measurement); ratios we compute from them are `derived-from-data`.
> **Prices move.** Several providers show dated step-ups on the page itself (Gemini) and
> the model line-up is the Oct-2026 live catalogue, not the Jan-2026 training snapshot.
> Treat the **structural ratios** as the durable finding; re-fetch the absolute numbers
> before anything bills.

---

## 0. The one-paragraph answer (for the founder)

A token costs what it costs because of **two different physical operations with two
different bottlenecks**, and the providers price the bottleneck, not the token. Reading
your prompt (**prefill**) is a big parallel matrix-multiply that saturates the GPU's
compute units — cheap per token, which is why *input* is the low number. Writing the
answer (**decode**) emits one token at a time, and each token must stream the *entire*
model weights plus the whole KV-cache through memory — the GPU's math units sit mostly
idle waiting on memory bandwidth, so *output* is the high number (4–8× input across every
provider). Everything MESH can arbitrage is a **discount the provider gives back when you
relax the constraint that makes decode expensive**: let them batch you (batch/flex/
off-peak ≈ 50% off, because continuous batching amortises the weight-streaming cost
across many concurrent users), or let them skip prefill entirely (cache read ≈ 10% of
input, 2% on DeepSeek). The NEW slack this mine found: **(a) the entire Google Gemini
rate arm** (batch 50%, cache-read ~10%, a 1.8× priority premium to strip); **(b) long-
context PRICE CLIFFS** — Claude Haiku jumps **5×** over 100K tokens, Gemini Pro **2×**
over 200K — so trimming a prompt *across the threshold* is a step-function 2–5× cut on
the **whole** request, not just the trimmed bytes; and **(c) DeepSeek off-peak 50%**, a
pure clock-based arbitrage (defer latency-tolerant traffic to the cheap UTC window).

---

## PART A — WHY tokens cost what they cost (the fundamentals)

### A.1 Prefill is compute-bound, decode is memory-bound — the root of the input/output price gap

The decisive fact is **arithmetic intensity** (FLOPs per byte moved from memory), read
against the GPU **roofline** (a sloped memory-bound region set by bandwidth, a flat
compute ceiling set by peak FLOPS, meeting at a "ridge").

- **Prefill** processes all prompt tokens at once → large matrix–matrix multiplies.
  Arithmetic intensity ≈ the number of tokens in the batch, because FLOPs scale as
  `2·B·d_in·d_out` while bytes moved (weight-dominated) ≈ `2·d_in·d_out`, so the matrix
  dims cancel. It sits **at/above the ridge → compute-bound**, near peak throughput.
  `literature-claim` (roofline derivation, Towards Data Science / zeroentropy / spheron).
- **Decode** emits one token per step → matrix–*vector* products. Arithmetic intensity
  ≈ **1 FLOP/byte regardless of dimension**, far down the **memory-bound** slope, a small
  fraction of peak. Each step re-streams the weights + KV-cache. `literature-claim`.
- Scale anchor: on an **H100 in bf16, decode needs ~280 tokens of batch size to cross
  the ridge**; serving batches of 1–32 stay memory-bound. `literature-claim`
  (TDS "Prefill is compute-bound, decode is memory-bound", 2026).

**MESH consequence (reasoned):** the 4–8× output:input price multiple is not a margin
choice, it is the compute-vs-bandwidth gap. This is the physical reason the backlog's
output levers (A5) are structurally worth more *per token* than input levers — but also
why providers soften output cost with speculative decoding (A.4) and why output volume on
our traced traffic is small (out:in medians ≤0.05 on serving cuts, per
`knowledge/2026-10-27-dataset-findings.md`). The gap is real; the token counts are not
there on our shape. Both remain true.

### A.2 KV-cache and attention scaling — the root of the long-context premium

Attention compute in prefill scales **O(n²)** in sequence length; the KV-cache **memory**
footprint scales **O(n)** and must be held in VRAM for every concurrent request for the
life of the decode. `literature-claim` (standard transformer-serving result; PagedAttention/
vLLM is the canonical mitigation — it pages KV blocks to cut fragmentation).

**MESH consequence (reasoned):** long context is expensive on *both* axes (quadratic
attention, linear memory that squeezes the batch size that makes decode efficient), which
is exactly why providers put a **price cliff** at a context threshold rather than a smooth
curve — see B.3. This is the mechanism that makes "threshold arbitrage" real money, not a
rounding effect.

### A.3 Continuous batching — the root of the batch/flex/off-peak 50% discount

Orca introduced **iteration-level (continuous) scheduling**: new requests' prefills are
injected between decode steps instead of waiting for a batch to drain, eliminating
head-of-line blocking. Reported **36.9× throughput over FasterTransformer at comparable
latency** (GPT-3 175B). `literature-claim` (Orca, OSDI'22). Anyscale's reproduction:
**up to 23× throughput** vs naive batching. `literature-claim` (Anyscale blog).
Sarathi-Serve adds **chunked prefill** (piggyback decodes onto prefill chunks) to remove
the prefill-vs-decode latency tradeoff — now the standard paradigm in vLLM. `literature-claim`
(Sarathi, arXiv:2308.16369 / arXiv:2403.02310).

**MESH consequence (reasoned, and this is the important one):** the **batch / flex /
off-peak ≈ 50% discount is the provider handing back continuous-batching throughput.**
When you accept latency tolerance, the provider packs you into denser batches where the
fixed cost of streaming weights is amortised across more concurrent tokens — decode moves
*toward the ridge*. So every "latency-tolerant → 50% off" lever (Anthropic Batch, OpenAI
Batch/flex, Gemini Batch, DeepSeek off-peak) is **the same physical trade** wearing four
different interfaces (a queue, a flag, a queue, and a clock). MESH should treat them as one
lever class with one gate, parameterised by interface.

### A.4 Speculative decoding — why output cost is softening (provider-side, not ours)

A small draft model proposes k tokens, the target model verifies them in **one parallel
forward pass**; accepted tokens are **distributionally identical** to plain sampling →
**lossless**. Measured **2–3× decode speedup** (Leviathan et al. T5-XXL 2–3×; Chen et al.
70B Chinchilla 2–2.5×). `literature-claim` (arXiv:2211.17192, arXiv:2302.01318). Yield
math: α=0.8, draft=5 → ~3.69× expected speedup. `literature-claim`.

**MESH consequence (reasoned):** this is **provider-side and white-box → REJECT as a MESH
lever** (needs a draft model + logits; MESH bundles no on-machine model). We catalogue it
only because it explains why output prices are not *even higher* given A.1, and why a
provider can afford a flex tier. It is context for the rate map, not a lever.

---

## PART B — the PRICING STRUCTURE and the rate-arbitrage slack

### B.0 Cross-provider rate card (provider-doc, fetched 2026-10-28)

All $/MTok. Ratios in B.1. **Model names are the Oct-2026 live catalogue.**

| Provider / model | Input | Cached read | Output | Batch/off-peak | Cache write | Premium flags |
|---|---|---|---|---|---|---|
| **Anthropic** Sonnet 5.5 | 2.00 | 0.10 (5m) | 10.00 | −50% | 2.50 (5m) / ~5.00 (1h) | fast 2×, US-geo 1.1× |
| Anthropic Opus 5.5 | 4.00 | 0.20 | 20.00 | −50% | 5.00 | fast 2× (2.5× faster) |
| Anthropic Fable 5.1 | 10.00 | 0.25 | 50.00 | −50% | 12.50 | — |
| Anthropic **Haiku 5.5 ≤100K** | 0.10 | 0.01–0.05 | 0.50 | −50% | 0.125–0.625 | — |
| Anthropic **Haiku 5.5 >100K** | **0.50** | (scales) | **2.50** | −50% | (scales) | ← **5× CLIFF** |
| **OpenAI** GPT-5 | 1.25 | 0.125 | 10.00 | −50% | n/a (auto) | Fast ~2×, Ultrafast ~3×, regional +10% |
| **Gemini** 3.1 Pro ≤200K | 2.00 | 0.20 | 12.00 | −50% | +storage/hr | priority 1.8× |
| Gemini 3.1 Pro **>200K** | **4.00** | 0.40 | **18.00** | −50% | +storage/hr | ← **2×/1.5× CLIFF** |
| Gemini 3.8 Flash | 0.75→1.50* | 0.075→0.15 | 3.75→7.50* | −50% | $0.50–1/MTok/hr | priority 1.8× |
| **DeepSeek** flash (peak) | 0.30 | 0.006 | 1.20 | — | n/a (auto) | — |
| DeepSeek flash **(off-peak)** | **0.15** | 0.003 | **0.60** | **−50% by clock** | — | — |

\* Gemini shows a dated step-up on the page itself (e.g. 3.8 Flash input $0.75 through
2026-12-31, $1.50 from 2027-01-01). `provider-doc`.

Sources: claude.com/pricing, developers.openai.com/api/docs/pricing, ai.google.dev/gemini-api/docs/pricing,
api-docs.deepseek.com — all fetched 2026-10-28.

### B.1 The two structural constants (derived-from-data)

Across **four independent providers**, two ratios recur — because they map to the two
mechanisms in Part A:

1. **Cache read ≈ 10% of input** (skip prefill compute, A.1):
   Anthropic 0.10/2.00 = **0.05–0.10×**; OpenAI 0.125/1.25 = **0.10×** (90% off);
   Gemini 0.20/2.00 = **0.10×**; DeepSeek 0.006/0.30 = **0.02×** (even cheaper — hit is
   nearly free). `derived-from-data`.
2. **Batch / off-peak ≈ 50%** (share continuous-batching throughput, A.3):
   Anthropic, OpenAI, Gemini all **−50%**; DeepSeek off-peak **−50%** by clock.
   `derived-from-data` / `provider-doc`.

**This gives MESH a provider-agnostic rate map:** a lever proven on Anthropic has a
pre-justified analogue on three other providers because the *mechanism* is identical.

### B.2 NEW SLACK #1 — the entire Google Gemini rate arm is uncatalogued

The backlog catalogues Anthropic batch + OpenAI flex. **Gemini is a third provider with
the full ladder and is absent from the backlog:**
- **Batch API −50%** (`provider-doc`) — same lever class as P1, drop-in.
- **Context caching:** *implicit* caching is automatic and (on Flash tiers) free at the
  ~10% read rate; *explicit* caching adds a **per-hour storage fee** ($4.50/MTok/hr Pro,
  $0.50–1 Flash) — a genuinely different cost model from Anthropic's one-off write premium
  (Gemini you pay **rent**, Anthropic you pay a **deposit**). `provider-doc`.
- **Priority Tier = 1.8× standard** (`provider-doc`) — a premium flag to **detect and
  strip/avoid**, exactly the family as Anthropic `fast 2×` and OpenAI `Fast ~2×` (extends
  backlog T4/T6 to Gemini).
- **Lossless/billing:** batch routing is lossless (bytes identical, latency only) →
  billable like P1. **Caching interaction:** because implicit caching is *automatic*
  (like OpenAI), the counterfactual on Gemini is **auto-caching, not zero caching** — so
  MESH cache levers here bill only the **incremental** delta, same discipline the backlog
  already imposes on the OpenAI arm (P3 §1). Carry that rule to Gemini verbatim.

### B.3 NEW SLACK #2 — long-context PRICE CLIFFS ("threshold arbitrage")

This is a **new lever class** the backlog does not name. Providers price long context as a
**step function**, not a slope (because of A.2 — quadratic attention + linear KV memory):

- **Claude Haiku 5.5: >100K tokens → input ×5 (0.10→0.50), output ×5 (0.50→2.50).**
  `provider-doc`. Cache read/write also step up.
- **Gemini 3.1 Pro: >200K → input ×2 (2.00→4.00), output ×1.5 (12→18).** `provider-doc`.
- (Historical: Anthropic Sonnet's 1M-context beta carried a >200K 2×/1.5× premium; the
  current 5.5 page did not surface one for Sonnet — **re-verify before relying**. `reasoned`.)

**Why this is different from ordinary trimming:** ordinary A2/A3/A4 trimming saves the
*removed* tokens at the marginal rate. Threshold arbitrage saves on the **entire request**
by flipping it into the cheaper price band. Worked example (`derived-from-data`, Haiku):
a 105K-token request trimmed to 98K removes 7K tokens (~1.5× over threshold worth), but
the remaining 98K reprice from $0.50 to $0.10/MTok → input cost **$52.5→$9.8 per MTok-
request-equivalent**, a **~5× cut on the 98K that stayed**. The 7K you removed is a
rounding error next to the band flip.

- **Lossless or lossy:** depends on *how* you cross the threshold. Lossless if you cross by
  A2 encoding compaction (same info, fewer tokens). Lossy if by A4 irrelevance-dropping →
  replay quality gate. **Say which per transform.**
- **Black-box:** yes — pure request-byte rewrite, no model access. ✅
- **Caching interaction (the trap):** the cliff lives at the *front* on cold turns but any
  edit that crosses it **mutates cached bytes → busts the prefix** (volatility guard). BUT
  this is the rare case where busting may pay: a one-time cache-write re-cost is trivial
  against a 5× band flip sustained over a long session. Gate it: only cross-threshold-trim
  when `(band_flip_saving) > (prefix_rewrite_cost)` on the trailing ledger, and only once
  (don't oscillate around the boundary — hysteresis, like the P2 TTL sticky rule).
- **Detector:** cheap and exact — MESH already counts prompt tokens; fire when a request
  lands in a 1.0–1.3× window *above* a known provider threshold (the only zone where a
  feasible trim flips the band). Most long requests are far above and unflippable; the
  value is concentrated in the band-edge minority. `reasoned`.

### B.4 NEW SLACK #3 — DeepSeek off-peak 50%: temporal (clock) arbitrage

DeepSeek bills **peak 01:00–04:00 and 06:00–10:00 UTC Mon–Fri; everything else (incl.
weekends, Chinese holidays) is off-peak at exactly −50%.** `provider-doc`. ~35 peak hrs /
133 off-peak hrs per week → **~79% of the week is already the cheap rate**. `derived-from-data`.

- **New lever class: temporal rate arbitrage.** Same physical trade as batch (A.3) but the
  provider exposes it on a **clock**, not a queue. For latency-tolerant DeepSeek traffic,
  **defer the request into the off-peak window** → 50% with *no* async-queue latency ceiling
  (just a scheduling delay up to the next window, worst case ~6h vs batch's 24h).
- **Lossless:** bytes identical, timing only → billable like batch. ✅ Black-box. ✅
- **Caching interaction:** none at the byte level; but note DeepSeek caching is automatic
  (hit ~2% of miss — the cheapest cache in the market), so MESH bills incremental only.
- **Gate:** only defer when the route is tagged latency-tolerant AND the deferral lands
  before the client's deadline; peak→off-peak boundary crossing must not strand a request.
  Same consent/opt-in discipline as P1 batch.
- **Honest caveat:** applies only to customers actually on DeepSeek; MESH has no traced
  DeepSeek traffic yet (`estimate` on fleet share = unknown, do not quote).

### B.5 NEW SLACK #4 — the OpenAI tier ladder is deeper than catalogued

Backlog has flex + batch. Fetch confirms the fuller ladder (`provider-doc`):
`Standard 1× · Batch/Flex 0.5× · Fast ~2× (renamed from "Priority" 2026-07-30) ·
Ultrafast ~3× · regional/FedRAMP +10%` and **cached input −90% (0.1×)**.
- **Ultrafast ~3×** is a NEW premium-flag entry for the hygiene audit (backlog T4/T6) —
  a request carrying `service_tier` in the Fast/Ultrafast family is paying 2–3×; detect
  and flag (never auto-strip — may be a deliberate SLA choice). `provider-doc`.
- **Flex = batch rate** confirmed; billability still gated on verifying
  `response.service_tier` reports the tier *served* (backlog open-question #9 stands).

---

## PART C — what is REJECT (white-box / model-access), recorded not ranked

| Mechanism | Why REJECT for MESH |
|---|---|
| Speculative decoding (A.4) | Needs draft model + target logits; MESH bundles no on-machine model. Provider-side only. |
| Quantization / FP8 / weight compression | Touches weights — out of MESH's bytes-only reach. |
| PagedAttention / KV-cache paging (A.2) | Serving-engine internal; MESH cannot schedule the provider's VRAM. |
| Chunked prefill / continuous batching (A.3) | Provider scheduler; MESH only *consumes* its price signal (the batch discount). |
| Fine-tuned draft/eagle heads, Medusa | Model-access; REJECT. |

These are **context for the rate map**, not levers. The only thing MESH extracts from them
is: *the discounts are real and physically grounded, so they are safe to arbitrage.*

---

## PART D — ship/research/reject for the backlog

| Finding | MESH fit | Why |
|---|---|---|
| Gemini Batch −50% + implicit-cache 10% (B.2) | **ship-candidate** | Drop-in P1 analogue; mechanism identical; incremental-only billing rule ported from OpenAI arm. |
| Threshold arbitrage / price cliffs (B.3) | **ship-candidate** | New class; exact cheap detector; 2–5× band flip; needs the cross-threshold gate + hysteresis. |
| DeepSeek off-peak temporal arbitrage (B.4) | **research** | Lever is clean & lossless, but zero traced DeepSeek fleet share today — build when a customer appears. |
| OpenAI Ultrafast 3× + Gemini priority 1.8× hygiene (B.2/B.5) | **ship-candidate** | Extends existing premium-flag audit (T4/T6) to two more providers; detect-and-flag. |
| Speculative decoding / batching internals (A) | **reject** | White-box / provider-side; recorded as rate-map justification only. |

**Durable takeaway for the founder's "fundamentals from the ground up" ask:** the rate
card is not arbitrary — **cache-read ≈ 10%** falls out of *skip-prefill*, **batch/off-peak
≈ 50%** falls out of *continuous-batching throughput*, and **long-context cliffs** fall out
of *quadratic attention + linear KV memory*. Because the mechanism is industry-wide, every
lever MESH proves on one provider has a pre-justified analogue on the other three. The
uncatalogued money is: **all of Gemini, the threshold cliffs on Haiku/Gemini, and DeepSeek's
clock.**

---

### Sources (primary first)
- Orca continuous batching (OSDI'22) — iteration-level scheduling, 36.9× vs FasterTransformer. https://www.anyscale.com/blog/continuous-batching-llm-inference
- Sarathi / chunked prefill — arXiv:2308.16369, arXiv:2403.02310 (Sarathi-Serve)
- Speculative decoding — Leviathan et al. arXiv:2211.17192; Chen et al. arXiv:2302.01318
- Roofline / arithmetic intensity — https://towardsdatascience.com/prefill-is-compute-bound-decode-is-memory-bound-why-your-gpu-shouldnt-do-both/ ; https://zeroentropy.dev/concepts/arithmetic-intensity/
- Anthropic pricing — https://claude.com/pricing (fetched 2026-10-28)
- OpenAI pricing — https://developers.openai.com/api/docs/pricing (fetched 2026-10-28)
- Google Gemini pricing + Batch API — https://ai.google.dev/gemini-api/docs/pricing ; https://ai.google.dev/gemini-api/docs/batch-api (fetched 2026-10-28)
- DeepSeek pricing (peak/off-peak, cache) — https://api-docs.deepseek.com/quick_start/pricing (fetched 2026-10-28)
