# Image & video economics for token-priced models — and where MESH honestly bites

Day-shift output for the 2026-10-27 dispatch. Engineering notes.

All provider facts read **2026-10-27** unless a page stamps its own date. Every
price carries its URL + checked date. Every computed number shows the arithmetic.
Source quality labelled inline: **[primary]** = provider doc/pricing/repo I read
directly; **[aggregator]** = third-party tracker because the provider's own cell
was blank/truncated/behind a calculator → exact number UNKNOWN from primary.

Adversarial critique applied: Anthropic 4:3 cap corrected 4,784→**4,740**;
Opus-vs-Gemini ratio corrected ~90×→**124×**; always-on frame label corrected to
640×360 (299 tok); gpt-5.1 reclassified as a **tile** model everywhere; SDK line
citations demoted to "reported". No FATAL items were found in the drafts.

---

## Vision input tokens

Three billing shapes. In all three the token count is computed on the image
**after** the provider's own server-side downscale; the base64 bytes are never
tokenised (a 6 MB and a 200 KB encoding of the same post-resize dimensions cost
identical visual/tile tokens).

### Formulas per provider

**Anthropic (Claude) — patch, hard downscale cap.**
Vision docs https://platform.claude.com/docs/en/build-with-claude/vision and
resize rule .../vision-coordinates#how-claude-resizes-and-pads-images; pricing
https://claude.com/pricing (all read 2026-10-27).
Formula (verbatim): each patch is a 28×28-px block; an image costs
`⌈width/28⌉ × ⌈height/28⌉` visual tokens (≈ `w·h/750`). Two tiers:

| Tier | Models | Max long edge | Max visual tokens |
|---|---|---|---|
| High-res | Claude 4.7+ (Opus/Sonnet/Haiku 5.5) | 2,576 px | 4,784 |
| Standard | older models | 1,568 px | 1,568 |

Resize picks the largest aspect-preserving size satisfying **both** limits; for
nearly all photos the token budget binds, not the edge. Input prices confirmed:
Opus 5.5 $4/M, Sonnet 5.5 $2/M, Haiku 5.5 $0.10/M, Haiku 4.5 $1/M.

**OpenAI (GPT vision) — tile or patch, hard downscale cap.**
https://developers.openai.com/api/docs/guides/images-vision (redirected from
platform.openai.com; read 2026-10-27); pricing
https://developers.openai.com/api/docs/pricing (read 2026-10-27).
- Tile models (gpt-4o, gpt-4.1, **gpt-5.1**): `detail:high/auto` → fit a 2048²
  square, then shortest side to 768, then count 512-px tiles:
  `total = base + tiles×tile_tok`. `detail:low` = base tokens only, any size.

  | Model | Base | Tile |
  |---|---|---|
  | gpt-4o, gpt-4.1 | 85 | 170 |
  | gpt-5.1 | 70 | 140 |
  | gpt-4o-mini | 2,833 | 5,667 |
- Patch models (gpt-5.4/5.5, gpt-6-astra, gpt-4.1-mini, o-series):
  `patches = ⌈w/32⌉×⌈h/32⌉`, `billable = ⌈patches × mult⌉` (mult 1.2×; 4.1-mini
  1.62×), per-model patch caps, oversized rejected rather than auto-resized.
  Per-model caps are reported-but-reverify. (Critique fix: gpt-5.1 is **tile**,
  not patch — the draft's video section had it in the wrong family.)

Input prices confirmed: 4o $2.50/M, 4.1 $2.00/M, 5.1 $1.25/M.

**Google Gemini — tile (lower confidence).**
https://ai.google.dev/gemini-api/docs/image-understanding + .../pricing
(read 2026-10-27). 258 tokens if both dims ≤ 384 px; larger images tiled into
768×768 tiles at 258 tok each, crop-unit ≈ `floor(min(w,h)/1.5)`. Max 3,600
image files/request. Prices Flash $0.30/M, Pro $1.25/M (≤200k). **UNKNOWN**
whether Gemini enforces a hard max-resolution downscale cap like the other two;
Gemini tile counts below are estimates.

### The right-sizing lever — lossless/lossy boundary

Test image 4032×3024 (4:3, 12.2 MP stock iPhone photo).

- **Anthropic (hi-res).** Raw → downscaled to ≈2212×1659, token-budget-bound.
  Largest 4:3 grid ≤4,784 is **79×60 = 4,740** (80×60=4,800 overflows, so the
  16:9-only 4,784 ceiling is unreachable at 4:3 — critique fix). Right-sized to
  2212×1659 → also 79×60 = 4,740. **Identical → lossless right-size saves 0 tok.**
  - Opus 5.5: 4740×4/1e6 = $0.018960 → **$18.96/1,000**
  - Sonnet 5.5: 4740×2/1e6 = $0.009480 → **$9.48/1,000**
  - Haiku 5.5: 4740×0.10/1e6 = $0.000474 → **$0.47/1,000**
  (The provider's own 16:9 worked example still lands at 4,784: 3840×2160 →
  2576×1449 = 92×52 = 4,784 → $19.14/1,000 on Opus. That example is correct; it
  is just 16:9, not 4:3.)
- **OpenAI `detail:high`.** 4032×3024 → fit 2048² → 2048×1536 → shortest side to
  768 → **1024×768 = 4 tiles**, whether raw or pre-resized. **Lossless = 0 tok.**
  - gpt-4o: 85+170×4 = 765 tok × $2.50/M = $0.001913 → **$1.91/1,000**
  - gpt-4.1: 765 × $2.00/M = $0.001530 → **$1.53/1,000**
  - gpt-5.1: 70+140×4 = 630 tok × $1.25/M = $0.000788 → **$0.79/1,000**
- **Gemini (ESTIMATE).** crop unit floor(3024/1.5)=2016 → ≈2×2 = 4 tiles ≈ 1,032
  tok. Flash ≈$0.31/1,000; Pro ≈$1.29/1,000.

**The boundary, stated plainly:**

| Portion | What it is | Token saving | $ saving |
|---|---|---|---|
| **Lossless** (raw → provider's max-useful size) | Provider discards the extra pixels anyway above its threshold | **0 on every provider checked** | **$0** |
| **Lossy** (below the threshold) | You pick smaller than the provider would keep | Real & computable | Real, at a fidelity cost that must be measured |

Lossy worked example (Anthropic hi-res): drop to 1269×952 = 46×34 = **1,564 tok**.
Saving vs the 4,740 cap on Opus = (4740−1564)×4/1e6 = 3176×4/1e6 = $0.012704 →
**$12.70/1,000** (critique fix: was $12.88, computed off the wrong 4,784 base).
OpenAI lossy lever is `detail:low` (base only): gpt-4o 85 tok → $0.21/1,000;
gpt-5.1 70 tok → $0.09/1,000. Both discard fidelity → under MESH honesty rules,
opt-in and gated against task accuracy, never defaulted or sold as free.

### Proxy feasibility

Requests carry base64 images, so a proxy can decode → resize → re-encode →
forward on-machine (prompts never leave the box). Lossless resize to the cap buys
**payload/bandwidth/latency and request-limit safety (10 MB/image, 32 MB/request),
zero token-bill change** — a 4032×3024 JPEG (~2–5 MB; base64 ~2.7–6.7 MB) → 1024×768
(~100–250 KB; base64 ~130–330 KB) is a ~90–95% payload cut, $0 tokens (byte sizes
ESTIMATE, depend on JPEG quality). CPU: decode + Lanczos + re-encode of 12 MP is
~20–80 ms on one modern core (ESTIMATE), negligible beside the round-trip but it
is the proxy doing it. Format gotchas (real): apply **EXIF orientation before**
resize or the model sees a sideways image; don't transcode PNG/screenshot text to
low-Q JPEG (Anthropic docs warn heavy compression hurts text); flatten RGBA for
JPEG; keep `media_type` matching the re-encoded bytes or the request errors; use
only the first frame of an animated GIF; base64 inflates ×1.333.

---

## Generation APIs

### Pricing map

| Provider / model | Unit | Price | Source |
|---|---|---|---|
| OpenAI gpt-image-2.5 / gpt-image-2 | per token | text-in $5/M; image-in $8/M; **image-out $30/M** | developers.openai.com/api/docs/pricing **[primary, 2026-10-27]** |
| OpenAI gpt-image-1.5 | per token | text-in $5 / out $10; image-in $8 / **out $32** per M | same **[primary]** |
| OpenAI gpt-image-1-mini | per token | text-in $2; image-in $2.50 / out $8 per M | same **[primary]** |
| OpenAI gpt-image-1, DALL·E 3 | — | **retired** (gpt-image-1 off 2026-10-23) | intuitionlabs **[aggregator]** |
| OpenAI Sora 2 / Videos API | per second | $0.10/s 720p, Pro $0.30–0.50/s — **API removed 2026-09-24, no successor** | eesel.ai, framesurfer [aggregator]; **removal now confirmed [primary] developers.openai.com/api/docs/deprecations (read 2026-11-05)** |
| Google Veo 3.1 | per second | $0.75/s (≈$6 / 8-s clip); Veo 3 Fast $0.10/s video-only, $0.15/s +audio | costgoat, atlascloud **[aggregator]**; cloud.google.com table truncated → tiers UNKNOWN primary |
| Google Imagen 4 | per image | Fast $0.02 / Std $0.04 / Ultra $0.06 — ⚠️ **Imagen API appears SHUT DOWN as of 2026-11-05, replaced by Gemini-native image (Nano Banana); re-verify before relying on these figures** | developersdigest [aggregator]; retirement **[primary] aistudio.google.com/docs/imagen (read 2026-11-05)** |
| Runway Gen-4 Turbo / 4.5 | per second (1 cr=$0.01) | Turbo 5 cr/s=$0.05/s; 4.5 12 cr/s=$0.12/s; $10 min | activepieces, apiframe **[aggregator]**; docs.dev.runwayml.com confirms credit ledger **[primary, mechanism]** |
| Stability Stable Image Ultra | per image | 8 cr = **$0.08** | docs.stability.ai/pricing **[primary, 2026-10-27]** |
| Stability SD3.5 L/Turbo/M/Flash | per image | $0.065 / $0.04 / $0.035 / $0.025 | same **[primary]** |
| Stability Core / SDXL | per image | $0.03 / from $0.009 | same **[primary]** |
| BFL FLUX.1 [pro]/Ultra | per image (credits) | reported $0.04 / $0.06 | pricepertoken, costbench **[aggregator]**; docs.bfl.ai confirms per-image credit model, **price cells blank on fetch → exact UNKNOWN primary** |
| BFL FLUX.2 [pro] | per megapixel | reported $0.030 first MP + $0.015/add'l | pricepertoken **[aggregator]**; docs.bfl.ai "megapixel-based" **[primary, structure]** |
| BFL FLUX 3 Image / Klein | per image by res tier | reported $0.041–0.607 / $0.008–0.036 | openrouter, layer3labs **[aggregator]**; docs.bfl.ai confirms tiers **[primary, structure]** |
| BFL FLUX 3 Video | per second (draft/full) | UNKNOWN exact | docs.bfl.ai structure only **[primary]** |

Only **Stability $0.08** (primary) and the OpenAI/Anthropic/Gemini **token**
prices are solid. Every Veo/Runway/Imagen/BFL figure and the Sora/gpt-image-1
dates are aggregator-sourced; derived duplicate costs inherit that uncertainty.

### Billed-failure / retry / duplicate findings

- **OpenAI SDK auto-retry.** Python SDK default `max_retries=2` (3 requests max)
  on 408/409/429/≥500; it mints **one** `stainless-python-retry-<uuid>` key and
  reuses it across its own retries, so those **dedup server-side and should not
  double-bill**. Double-bill risk is **app-level** retries (new key each call)
  and **nested retry layers** that multiply requests (huggingface/smolagents
  #3034 "9 requests per rate limit"; openclaw #127533). (Exact repo line numbers
  in the draft are **reported, not re-verified** — the substance holds.)
- **OpenAI moderation billing (reported, not provider-published):** a prompt that
  passes input moderation but is blocked later is still billed; 400 content-blocks
  may still bill input tokens; input-filter rejections are not billed.
- **Runway (primary):** `SAFETY.INPUT.*` failures are **not refunded** — a narrow,
  real billed-failure class. Other classes (`INTERNAL.BAD_OUTPUT`,
  `INPUT_PREPROCESSING.INTERNAL`, `INTERNAL`/null) are retryable **and refunded**.
- **Google Veo/Vertex (aggregator citing Google):** bills only successful seconds;
  safety-blocked requests incur no generation fee → billed-failure waste ≈ zero.
- **Stability / BFL:** failure billing **UNKNOWN** (docs silent).
- **Duplicate detection — universal gap.** Idempotency for submitting generation
  work is almost universally absent (survey github.com/a1adams/batch-image-
  generation-apis, vendor-doc-linked): OpenAI, Runway, Stability, BFL keep no
  idempotency key; Gemini explicitly non-idempotent ("same request twice → two
  jobs"); only niche Wireflow replays on a key. So identical re-requests bill in
  full, every time. Derivable per-duplicate waste (unit price billed again):
  - Stable Image Ultra: 8 cr × $0.01 = **$0.08** [price primary]
  - Runway Gen-4.5 10-s clip: 12 cr/s × 10 × $0.01 = **$1.20** [rate aggregator]
  - Veo 3.1 8-s clip: $0.75 × 8 = **$6.00** [rate aggregator]
  - Runway SAFETY.INPUT billed failure: full clip credits, zero output delivered
  Duplicate **frequency** in any customer's traffic is **UNKNOWN** — measure it.

### HONEST VERDICT per workload

Only OpenAI image models are token-priced; everything else is flat per-image or
per-second. **MESH's text-token levers cannot reduce the generation charge on any
per-image or per-second provider** — you cannot trim a prompt to make a Runway
second or a Stable Image Ultra image cost less. Even on OpenAI the cost is
dominated by **image-output tokens** ($30–32/M), a fixed function of
resolution/quality; text-input ($5/M) is a rounding error, and the per-image token
count is UNKNOWN (pricing page says "use the calculator").

- **OpenAI image:** flag duplicates + (reported) moderation-billed failures; text
  levers touch only the trivial text-input line. **Partial, honest, small.**
- **Runway video:** measure duplicates ($0.05–0.12/s re-billed) + the one truly
  billed failure class (SAFETY.INPUT). **Real, narrow.**
- **Google Veo/Imagen:** failures largely not billed; no idempotency.
  **Duplicate detection only; otherwise MESH cannot help.** (Update 2026-11-05:
  the **Imagen API appears retired**, replaced by Gemini-native image — the live
  path is `generate_content`, not the per-image Imagen endpoint; re-verify.)
- **Stability:** duplicate detection derivable ($0.08/Ultra); failure billing
  UNKNOWN. **Duplicate help; rest UNKNOWN.**
- **BFL FLUX:** duplicate help; failure billing + idempotency UNKNOWN; plus the
  naming note below (the collision is now resolved by our FLUX→MESH rename).
  **Duplicate help only.**
- **Sora / OpenAI Videos API:** **retired 2026-09-24. No live workload — MESH
  cannot help.**

One line: on generation APIs MESH's only broadly-defensible value is
**duplicate-request detection** (universal, arithmetic-derivable, action-
contingent — MESH reports, the customer must suppress) plus **billed-failure
accounting on the two providers that actually charge (Runway safety-input, OpenAI
moderation)**. The headline generation charge is per-unit and **MESH cannot reduce
it** — say so.

---

## Video understanding

Two billing worlds. **Gemini ingests video natively**, metered tokens/second.
**Claude and GPT accept no video** — the caller rips frames and sends image
blocks, each tokenised by the vision formula. "GPT/Claude watches a video" is
always a caller-built frame pipeline.

### Billing math

**Gemini native** (ai.google.dev/gemini-api/docs/video-understanding, read
2026-10-27; pricing page "Last Updated 2026-10-26 UTC"): 1 fps default; **66
tok/frame low (default)**, **258 tok/frame high**, **audio 32 tok/s** (separate).
Roll-up ≈100 tok/s low (66+32=98), ≈300 high (258+32=290). `fps` and
`media_resolution` are caller-controllable; an agentic mode loads only needed
transcript/frames/audio, "up to 88% fewer tokens" on long content. 2.0-class =
258 tok/s at 1 fps (no low tier). Prices Flash $0.30/M, Pro $1.25/$2.50,
Flash-Lite $0.10; **2.0 Flash not listed → UNKNOWN**.

1 minute = 60 s:

| Setting | Tokens | $ Flash $0.30/M | $ Pro $1.25/M |
|---|---|---|---|
| low, 1 fps, +audio | 60×(66+32)=**5,880** | $0.0018 | $0.0074 |
| high, 1 fps, +audio | 60×(258+32)=**17,400** | $0.0052 | $0.0218 |
| high, fps 0.5, +audio | 30×258+60×32=**9,660** | $0.0029 | $0.0121 |
| low, video-only | 60×66=**3,960** | $0.0012 | $0.0050 |

Per hour, high+audio Flash: 17,400×60 = 1,044,000 tok = **$0.31/hr** (Pro $1.31).
Levers exactly: `media_resolution` high→low = **−74%** of frame component;
`fps` 1→0.5 halves frames only (audio fixed) → high-res 1-min 17,400→9,660 =
**−44.5%** total.

**Claude frames** (1 min @ 1 fps = 60 frames, 1920×1080 source). Hi-res: 1920×1080
not downsized = 69×39... per the doc's own table = **2,691 tok/frame**; standard
downsizes 1456×819 = **1,560 tok/frame**.

| Tier / model | Tok/frame | Tok/min | $/min | $/hr |
|---|---|---|---|---|
| Hi-res Opus 5.5 $4/M | 2,691 | 161,460 | **$0.646** | **$38.75** |
| Std Haiku 4.5 $1/M | 1,560 | 93,600 | **$0.094** | **$5.62** |

A 1-min hi-res Opus clip is **~124×** a Gemini Flash hi-res minute ($0.646 ÷
$0.0052 = 124.2× — critique fix, draft said ~90×): 2,691 tok × $4/M dwarfs 258 tok
× $0.30/M, and the frame pipeline carries no audio economy.

**GPT frames** (1 min @ 1 fps, 720p high detail). Dev-forum figure (not primary):
720p ≈ 920 patches (⌈1280/32⌉×⌈720/32⌉ = 40×23 = 920); ×1.2 ≈ 1,104 billable.
60 × 920 = 55,200 → ×1.2 ≈ **66,240 billable tok/min**; $ = × the model's rate.
(Note gpt-5.1 is tile, not patch — GPT frame pipelines on patch models are
gpt-5.4+/mini/o-series.)

**Accuracy crossover is UNKNOWN from provider docs.** Gemini says low is the
intended default, escalate resolution only for small text, `fps 0.5` for long/
static content. No provider publishes an accuracy-vs-fps or -resolution curve.

### Frame right-sizing / dedup

Right-size (the image lever, per frame; Claude hi-res):
- 1920×1080 = 2,691 tok → **1280×720** (46×26) = **1,196 tok** = **−55.6%**
- 1920×1080 → **640×360** (23×13) = **299 tok** = **−88.9%**
At 60 frames/min on Opus $4/M, the 1280×720 right-size saves 161,460→71,760 tok =
**$0.359/min**. Lossy → quality gate required.

Dedup near-identical consecutive frames: **byte-identical** → lossless drop (same
philosophy as the text `dedupeRepeatedBlocks`, but note that lever is **text-only
today** and would not catch image blocks); **perceptual near-dupes** → lossy →
gate. Provider guidance on VLM frame dedup: **none/UNKNOWN**; only research
supports it (FrameFusion arxiv 2501.01986 ~70% reduction; EVS arxiv 2510.14624;
perceptual-hash + Hamming dropping). Both unbuilt.

### Always-on / stream monitor arithmetic

An agent on a live stream re-sends an overlapping trailing window each query.
Redundancy factor = window_length / query_cadence.
`tokens/hr = (3600/cadence_s) × window_s × tok_per_s_of_video`.

Gemini (low+audio 98 tok/s; high+audio 290):

| Window | Cadence | Redundancy | Low tok/hr | $/day Flash low | $/day Flash high |
|---|---|---|---|---|---|
| 10 s | 5 s | 2× | 705,600 | **$5.08** | **$15.03** |
| 30 s | 5 s | 6× | 2,116,800 | **$15.24** | **$45.10** |
| 10 s | 10 s | 1× | 352,800 | **$2.54** | **$7.52** |

(10s/5s: 720 q/hr × 10 s × 98 tok/s = 705,600 tok/hr × $0.30/M × 24 = $5.08, per
stream, × camera count.)

Claude/GPT frame monitor is far worse: a 10-frame window of 1280×720 hi-res =
10×1,196 = 11,960 tok/query; every-5-s (720 q/hr) = 8.6M tok/hr × $4/M (Opus) =
**$34.4/hr ≈ $826/day/stream**. Haiku 4.5 standard-tier at **640×360 (299 tok —
critique fix, draft mislabelled this as 512×512)**: 10×299×720 = 2,152,800 tok/hr
× $1/M = **$51.6/day/stream** (true 512×512 = 19×19 = 361 tok → ~$62/day). The
redundancy factor IS the lever: bill each second once, dedupe static frames,
cache the stable window → derivable ~83% ceiling on the re-sent portion at 6×.
Unbuilt.

---

## Lever candidates for the backlog

Each: mechanism + why it might be wrong.

1. **Image/frame right-size (proxy, lossy, gated).** Mechanism: decode → resize
   below the provider cap → re-encode, on-machine, before forward. *Why wrong:*
   lossless portion is $0 tokens (provider downscales anyway); only sub-cap
   downscale saves tokens, and that is lossy — must clear a continuous-grader gate
   per task, so the honest saving may be near-zero on tasks that need the pixels.
2. **Payload/latency right-size (proxy, lossless).** Mechanism: same resize to the
   cap. *Why wrong:* it saves bandwidth and keeps requests under the 10/32 MB
   limits but **0 tokens** — do not book it as token savings; its pitch is latency
   + limit-safety only.
3. **Duplicate-generation detection (metering).** Mechanism: fingerprint
   submitted generation requests, flag byte-identical/near re-sends on the ledger.
   *Why wrong:* MESH only reports; the saving is contingent on the customer
   suppressing. Duplicate frequency is UNKNOWN until measured; near-dupe matching
   risks false positives on legitimately-repeated prompts.
4. **Billed-failure accounting.** Mechanism: match provider error classes to
   whether they billed (Runway SAFETY.INPUT not refunded; OpenAI late moderation).
   *Why wrong:* only two providers are confirmed to charge; Veo bills successes
   only; Stability/BFL UNKNOWN. OpenAI moderation-billing is community-reported,
   not provider-published — could be wrong.
5. **Idempotency-hygiene flag.** Mechanism: verify customer retries carry a reused
   key (OpenAI SDK does; app-level + most providers do not) and flag the uncovered
   double-bill surface. *Why wrong:* catches only the retry-storm subset; most
   providers have no key to reuse, so the "fix" is customer-side dedup, not MESH.
6. **Frame dedup (byte-exact lossless + perceptual lossy).** Mechanism: drop
   repeated frames before forwarding. *Why wrong:* text-only `dedupeRepeatedBlocks`
   won't touch image blocks — this is net-new image-aware code; perceptual dedup is
   lossy and only research-backed, no provider blessing → gate-only.
7. **Re-sent video context caching (multi-turn / always-on).** Mechanism: Anthropic
   cache-prefix/TTL stamp (`cache-volatility-guard.ts`, `reduce-request.ts`) is
   content-agnostic; if a video's frame blocks sit in a stable prefix, turns 2–5
   read at ~0.1×. Worked: 1-min clip = 60 hi-res frames = 161,460 tok, 5-turn chat
   uncached = 5×161,460 = 807,300 tok = $3.23 on Opus, of which 4/5 ($2.58) is pure
   re-send → cache turns $2.58 into ≈$0.26 + one write premium. *Why wrong:* this is
   the one shipped lever that applies, but only if frames land in a stable prefix;
   the Files-API `file_id` route cuts upload bytes/latency only (frame still
   tokenised every turn unless cached) — don't conflate the two.

**Repo reality (verified at commit `59a034a`):** `proxy.ts` routes only Anthropic
`/v1/messages` and OpenAI `/v1/responses` + `/v1/chat/completions` — **no Gemini
`generateContent` path**; `reduce-request.ts` is text-only (no image/base64/resize/
frame/patch references). So candidates 1,2,6 are net-new code, and **MESH cannot
touch Gemini native video at all today**. Only candidate 7's cache lever already
ships.

---

## Brand note — Black Forest Labs' FLUX name collision (resolved by the MESH rename)

Black Forest Labs ships a commercial image/video API literally named **FLUX**
(FLUX.1, FLUX.2, FLUX 3, Kontext, Klein) at `docs.bfl.ai` **[primary]**. Our
product was **formerly also named FLUX**; it is now **MESH**, which resolves the
collision this note originally flagged. Residual facts to keep in mind:
- The old name "FLUX" collided in search with a well-funded model vendor; the
  rename to MESH removes that overlap. Any historical FLUX-era copy or links still
  carry the collision until they are migrated.
- If we ever instrument a BFL-model workload, "**MESH measuring FLUX**" is now
  unambiguous in UI (our layer = MESH, the model = FLUX) — the former
  "FLUX measuring FLUX" problem is gone.
- GEO note (historical): FLUX-era guidance was to avoid targeting image-generation
  keywords under the bare name FLUX; moot under MESH, but any surviving
  FLUX-branded pages still shouldn't.

---

## What we still don't know

- Whether **Gemini enforces a hard max-resolution downscale cap** like
  Anthropic/OpenAI — its tile counts here are estimates from the crop-unit rule.
- **gpt-image per-image token count** — pricing page says "use the calculator";
  no primary per-image count, so OpenAI generation $ is not derivable to the cent.
- **Failure billing on Stability and BFL** — docs silent.
- **OpenAI late-moderation billing** — community-reported, not provider-published.
- **Duplicate/retry-storm frequency** in any real customer's traffic — no provider
  telemetry; must be measured, not assumed.
- **Veo/Runway/Imagen/BFL exact prices + gpt-image-1 date** — aggregator-sourced;
  primary cells were blank/truncated on fetch. (Sora removal date is now confirmed
  primary — see the pricing map. Imagen's live status itself is now in doubt — see
  the Imagen row.)
- **GPT per-model patch caps** (30k reject threshold, 2,500-patch budgets) —
  reported from a single rendered page, not cross-verified.
- **Accuracy-vs-fps / -resolution crossover** — no provider publishes a curve.
