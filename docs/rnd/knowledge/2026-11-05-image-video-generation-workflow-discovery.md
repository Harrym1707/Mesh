# Image & video generation — end-to-end workflow & credit-burn map

Discovery synthesis, **2026-11-05**. Understanding phase only — **levers are parked for
phase 2 and are not decided here**, per the brief ("understand the patterns end to end
before we think up ways to reduce credits").

**Companion to** [`2026-10-27-image-video-economics.md`](./2026-10-27-image-video-economics.md),
which owns the **billing mechanics** (per-token / per-image / per-second pricing, billed-failure
classes, duplicate detection, and the honest verdict that MESH's text-token levers *cannot*
reduce a per-image or per-second generation charge). **This doc owns the layer that one lacks:
the end-to-end workflow and the human behaviour that actually burns credits.**

Rigor follows the house style: every factual claim carries a source and the date read; sources
are labelled **[primary]** (provider's own doc/pricing/SDK), **[aggregator]** (third-party
tracker/wrapper/vendor blog), or **[community]** (forum/Reddit/creator anecdote). Numbers are
marked **UNKNOWN** rather than guessed. Assembled from four parallel research tracks (Higgsfield,
image workflow, video workflow, waste-pattern synthesis); all web facts read 2026-11-05 unless a
source stamps its own date.

> **"FLUX" disambiguation.** Throughout this doc, **FLUX / BFL FLUX = Black Forest Labs' image
> model** (FLUX.1, FLUX.2, FLUX 3, Kontext, Klein). It is **not** our product — our product is
> **MESH**. Keep them distinct; the collision is exactly why MESH was renamed.

---

## TL;DR — the burn map on one screen

1. **The market has converged on one async pipeline** (five stages below), near-identical across
   image and video tools; only the control names differ.
2. **Re-rolls are the dominant waste**, and **consistency re-rolls across a multi-shot video
   sequence are the single largest source** — re-rolling shot *N* because the character/scene
   drifted vs shot *N−1*. Converging anecdote: **~3–5 generations per usable clip** in disciplined
   hands, **20–27×** in exploratory/agency work; **~25% clip-survival**. Images cluster at
   **~4–6 generations per kept image** for skilled users (dozens for trial-and-error).
3. **A *true* cheap-preview-that-promotes-to-the-identical-final is rare.** Most "draft" tiers are
   a *different, cheaper sibling model* whose output is **not guaranteed to reproduce** on the
   flagship — so the common "draft cheap, render full" advice is weaker in practice than it sounds.
   Only ByteDance Seedance 2.5 offers an explicit seed-faithful draft→promote.
4. **This reframes the whole credit story.** Per the economics doc, MESH's token levers cannot
   shave a per-image or per-second charge. So the *only* defensible credit-reduction surfaces are
   behavioural/structural: **not spending full credits on rejects** (preview-gate before the full
   render), **duplicate/near-duplicate detection**, **billed-failure accounting**, and
   **workflow nudges** (consistency-sheet-first; batch/parallel discipline). All phase 2.
5. **Two corrections to the 2026-10-27 economics doc** surfaced and need a primary re-check:
   **Google Imagen's API appears retired** (replaced by Gemini-native "Nano Banana"), and the
   **Sora/OpenAI Videos API retirement (2026-09-24) is now confirmed** against OpenAI's own
   deprecations page. See [§Corrections](#corrections-to-the-2026-10-27-economics-doc).
6. **Evidence honesty:** there is **no provider telemetry** on waste frequency anywhere. The best
   single-sample source is an Adobe survey (N=1,008, self-reported); everything else is a vendor
   dataset, a vendor FAQ, or forum anecdote, labelled as such. The re-roll multipliers are
   *directional*, not benchmarks.

---

## The unified workflow (idea → final asset)

Both image and video tools reduce to the same five stages. Video adds duration/motion/audio to
the control surface and far higher per-unit cost, which is why the same behaviour burns far more
there.

| # | Stage | What happens | Where cost enters |
|---|---|---|---|
| 1 | **Prompt & reference construction** | positive prompt; sometimes negative prompt, style ref, character/subject ref, image ref (img2img), server-side prompt auto-expansion | free to write, but auto-expansion silently changes the *billed* prompt and can cause off-target re-rolls |
| 2 | **Model / endpoint / parameter selection** | pick model + tier + operation endpoint; set resolution, steps, guidance, aspect ratio, N, duration, fps, seed | the first cost lever the user controls — tier/res/steps/duration/N all scale the charge |
| 3 | **Submit → queue → poll → retrieve** | async for most video + BFL (submit→task id→poll→signed URL, minutes-long; caps on active tasks); synchronous for gpt-image (+ streaming partials) | long async waits push users to fire **parallel speculative generations** instead of waiting to judge one |
| 4 | **Evaluate the candidate(s)** | does motion read / composition hold / identity persist / prompt followed? | the decision point that triggers (or avoids) the loop below |
| 5 | **Iteration loop** (the expensive part) | re-roll (new seed/prompt), variations, inpaint/outpaint, **extend/keyframe** (video), **consistency re-rolls across shots** (video), upscale, finishing (stitch/audio/lip-sync) | **most credits are spent here**, on candidates that are then discarded |

Two structural notes that shape the loop:
- **Generate-N-keep-1 is often the enforced default, not a user choice.** Midjourney returns a
  4-image grid (≈75% structural discard floor *before* any re-rolls); Imagen used `sampleCount`.
  BFL FLUX is the opposite — **one image per submitted task, no `N`** — so the same waste shows up
  as repeated submissions instead.
- **Conversational tools collapse the loop into chat turns.** Google Gemini-native image
  ("Nano Banana") and gpt-image via the Responses API keep image state server-side; each edit is a
  turn that re-references the prior image. Whether each turn re-bills the full prior-image context
  is **UNKNOWN** and matters for cost.

---

## The credit-burn heat map

Ranked by estimated **total credit spend** (frequency × unit cost), with the stage it occurs at
and the strength of the evidence. **All multipliers are directional — no provider publishes
keep-rate or re-roll telemetry.**

| Rank | Waste pattern | Stage | Image / Video | Typical magnitude | Evidence |
|---|---|---|---|---|---|
| 1 | **Consistency re-rolls across a multi-shot sequence** (character/scene drift → re-roll shot after shot) | 5 | Video | called the single largest source; folds into the 3–5× / 20–27× below | [community] Google dev forum + [aggregator] invideo |
| 2 | **Re-rolls to get one usable clip** | 5 | Video | **~3–5× list** disciplined, **20–27×** agency; ~25% clip-survival (164→41 kept) | [aggregator] invideo/clixie/Segmind; [community] |
| 3 | **Over-rendering full res/duration before composition is locked** | 2→3 | Both | a wrong 10 s render at 0:02 wastes the full 10 s; one creator cut cost ~66% by drafting | [aggregator] invideo/Picsart/CuriousRefuge (N=1) |
| 4 | **Generate-N-keep-1 / grid keep-one** | 4 | Image | median **~4 gens/kept** (Magnific, trending 4.7→3.6); Midjourney ~75% grid floor | [aggregator] Magnific dataset; inference |
| 5 | **Billed failures / moderation refusals** | 3 | Both | web usually refunds *with exceptions*; Runway `SAFETY.INPUT` not refunded; forum reports "75 credits, nothing usable" | [primary] Runway; [community] Google forum |
| 6 | **Subscription-credit breakage** (monthly expiry, fast-hours burned on exploration) | — | Both | Runway Standard/Pro credits expire each refresh; MJ Fast hours don't roll over; Kling no rollover | [primary] Runway/MJ policies; [community] behaviour |
| 7 | **Steps / seed over-rendering** (steps at ceiling "to be safe"; 100-seed sweeps) | 2 | Image | 50 steps ≈ 2.5× the time of 20; knee ~20–30 for BFL FLUX (disputed) | [aggregator] runware/theneuralbase |
| 8 | **Batch multipliers & off-web drain** (Higgsfield batch 2/3/4 = N×; MCP/CLI always bills even on "unlimited") | 2 | Both | batch-of-4 = 4× single; off-web ignores "unlimited" pools | [primary] Higgsfield help center |
| 9 | **Prompt auto-expansion** (`prompt_upsampling`, `magic_prompt`, Imagen rewrite) | 1 | Image | changes billed prompt; net effect on spend **UNKNOWN** | [primary] feature exists |

**Image keepers cluster at ~4–6 generations; video keepers at ~3–5× (worse with consistency).**
Unit cost is far higher for video, so video dominates total spend despite images having higher
*generation counts*.

---

## Track 1 — Higgsfield (your production tool)

Scope: short-form video + image platform (higgsfield.ai), an aggregator/creative suite wrapping
35+ (marketed "50+" in the API) third-party and in-house models behind one subscription, plus a
**separate** pay-as-you-go API. It was absent from the 2026-10-27 economics doc; this fills that gap.

**Structural finding:** Higgsfield has largely shifted from a pure per-credit-balance model to an
**"unlimited models + free-generation pools"** subscription. Credits still exist and still meter
pay-per-use/non-"unlimited" models and *all* off-web usage (MCP/CLI/Canvas/Supercomputer), but the
live pricing page no longer advertises a per-tier monthly credit balance the way older (Aug 2026)
blogs describe. The live page is authoritative; the credit-tier blogs are stale.

### Workflow (idea → finished asset)
Per Higgsfield's own walkthrough [primary, higgsfield.ai/blog/AI-Video-Generator-How-to-Create-on-Higgsfield]:
1. **Choose workflow** — image-to-video (people/products/specific face or object) vs text-to-video (abstract scenes).
2. **Get a source image (optional)** — upload, or generate a still in **Soul Cinema**/Soul first; **Soul ID** builds a reusable consistent character from 20–80 photos. Guidance: review the still *before* animating, "since that frame is what the video model animates."
3. **Write the prompt** — T2V: subject + action + setting + camera; I2V: describe *motion/camera* only.
4. **Choose model + settings** — model, mode, duration, resolution, aspect ratio, references (example: Seedance 2.5, References mode, 10 s, 1080p, 16:9).
5. **Presets / camera controls** — Higgsfield's signature layer: ready-made camera moves (dolly, push-in, pull-out, pan, track, crane, whip pan, bullet time, boom, Snorricam, FPV drone, slow orbit, 3D rotation, arc). Count reported **20+ to 70+** — exact **UNKNOWN**. Seed param for repeatability.
6. **Keyframes** — **Wan 2.7** first-and-last-frame control (Plus+); Kling 4.0 accepts up to 10 reference images.
7. **Start low-res** — test at 720p first ("fewer credits, faster"); Generate button **shows price before confirming**.
8. **Review the full clip** — check for drift/freezing near the end, not just frame 1.
9. **Iterate one variable at a time** — prompt OR source image OR model (this is where re-rolls burn credits).
10. **Upscale / edit** — advertised; exact steps + credit cost **UNKNOWN** from primary.
11. **Export** from generation history.

Adjacent products on the homepage [primary]: GPT Image 2.6, Genjutsu / Genjutsu Lite, Mangaka
(comics), Ideogram Vector 1.0 (SVG), Playable (prompt→mobile game), Supercomputer Agent
("powered by GPT-6 Astra"), Cinema Studio 4.0, AI Influencer Studio, and **Higgsfield MCP for
Claude** (generate inside Claude).

### Billing — two separate systems
**A. Web app — subscription (credits + "unlimited" pools).** Live plans [primary, higgsfield.ai/pricing]:

| Plan | Price | "Unlimited" models | Free-gen pools (headline) | Parallel gens |
|---|---|---|---|---|
| Starter Monthly | **$19/mo** | 3 | ~100 Nano Banana Pro/mo; 300 Soul V2 & Cinema; no Seedance 2.0 | 2 video, 4 image |
| Plus Monthly | **$59/mo** | 8 | 500 Nano Banana Pro/mo; 3k Soul V2 & Cinema; all models incl. Seedance 2.0 | 6 video, 8 image |
| Plus Annual | **$47/mo** (billed yearly, 20% off) | 10 | 6k Nano Banana Pro/yr; 5,000 Soul V2 & Cinema; all models | 6 video, 8 image |
| One-time | **$3** | — | 40 credits + 2-day unlimited Soul 2.0 + Fast gens | — |

- Credit cost depends on **model, resolution, and duration**; exact per-model numbers are **not
  published** — shown only on the Generate button. **Batch size IS a multiplier** — batch 2/3/4
  charges each output separately [primary].
- Per-generation credit figures are all [aggregator], rough: Nano Banana Pro ~2 cr/image; Seedance
  2.0 ~22 cr; Seedance 2.0 @15 s/720p ~90 cr; Kling 3.0 @8 s/720p ~8–14 cr; Sora 2 @10 s ~300 cr;
  1080p ~1.5× 720p.

**B. API — pay-as-you-go in USD (not credits)** [primary, higgsfield.ai/blog/higgsfield-api]. Top
up a USD balance, pay per generation, halts at $0, funds expire 1 year, optional auto-top-up. A web
plan grants **no** API access. Sample rates [primary]: Soul 2 image $0.0032/img; Marketing Studio
image $0.0059/img; DoP video $0.125 flat; Kling 2.5 $0.042/s; Kling 2.6 $0.07/s; Seedance 2.5
$0.0738/s; Kling 3.0 $0.112/s; Wan 3.0 $0.20/s; Seedance 2.0 $0.9332/s (**anomalous vs 2.5 —
re-verify**). **API is transparent per-second USD; web hides the rate behind credits + a
Generate-button quote.**

### Where credits burn (Higgsfield-specific)
- **Re-rolls / one-variable-at-a-time iteration** — each regen is a fresh charge; low-res-first exists precisely to make the inevitable re-rolls cheaper. [primary guidance]
- **Batch** — batch 2/3/4 = 2/3/4× single cost. [primary]
- **Failed generations** — "most" auto-refund within minutes, but **specific (unnamed) models may not refund** — a real billed-failure class. API: failed requests not charged. [primary]
- **Off-web usage always costs credits** — MCP/CLI/Canvas/Supercomputer deduct credits *even for "Unlimited" web models*, and free pools don't apply. A structural drain for automation. [primary]
- **"Unlimited" is conditional** — specific models at specific res/duration caps only; "subject to dynamic speed adjustments" at peak. [primary]
- **No documented true draft/preview render** — the only lever is "test at 720p first." [primary]

### Models wrapped
Third-party [primary]: Veo 3.1; Kling 2.5/2.6/3.0/4.0; Seedance 2.0/2.5; Wan 2.7/3.0; MiniMax/Hailuo
2.3/H3; PixVerse 6; LTX 2.5 Pro; Nano Banana Pro + GPT Image 2.6; Seedream 5.0 Pro; Ideogram Vector
1.0; Recraft; Grok; Sora 2 [aggregator]. In-house: Soul 2 / Soul Cinema / Soul ID, DoP, Marketing
Studio Image, Genjutsu, Mangaka, Cinema Studio. **BFL FLUX did not surface in Higgsfield's catalog —
no naming collision arose here.**

### Higgsfield — what we still don't know
Exact per-model/res/duration web credit costs (not published); current live credit allowances
(the $9/$29/$79 × 120/600/1,800 structure appears superseded); which models don't refund failures;
whether a true draft render exists; upscale/edit steps + cost; exact preset count and whether
presets alter cost; free/Business tier details and top-up pack prices; the anomalous Seedance 2.0
API rate; docs.higgsfield.ai structure (introduction URL 404'd 2026-11-05).

---

## Track 2 — Image generation: workflow & patterns

*Behaviour/workflow layer only; pricing is in the economics doc.*

### The market splits into two interaction models
- **Parameterised diffusion job** (BFL FLUX, Stability, Ideogram, Imagen-as-was, Midjourney,
  gpt-image via Images API): assemble prompt + params, submit, get N candidates, iterate with
  discrete edit ops. **Credits burn per submitted job regardless of whether you keep the output.**
- **Conversational multimodal** (Gemini-native "Nano Banana" / Nano Banana 2; gpt-image via the
  Responses API): each edit is a chat turn building on the prior image, state kept server-side.
  This is **displacing** the old parameterised Imagen API (see Corrections). [community]

### Workflow stages
1. **Prompt construction.** Positive (universal); negative prompt on Stability + Midjourney `--no`, **absent** on BFL FLUX 3 and gpt-image [primary docs.bfl.ml]; style ref (MJ `--sref`, Ideogram, Stability Style); character ref (MJ `--cref`); image ref/img2img (BFL `image_prompt`; FLUX.2 editing up to 10 refs; gpt-image source+mask; Ideogram Remix `image_weight` 1–100); **prompt auto-expansion** (BFL `prompt_upsampling` default false; Ideogram `magic_prompt` AUTO default; Imagen auto-rewrote) — *the prompt that bills is not the prompt the user typed*.
2. **Model & endpoint selection.** Providers split one logical task across many endpoints/tiers — BFL has separate endpoints per model *and* per operation (generate, Kontext edit, Fill inpaint, Expand/Outpaint, FLUX 3); Stability has Generate/Edit/Control families; gpt-image has model + quality low/med/high.
3. **Parameters & cost relevance.** Resolution/size; aspect ratio; **steps** (BFL FLUX.1 dev default **28**, range 1–50 — a direct compute lever); **guidance** (default 3, range 1.5–5); **seed** (Replicate does *not* echo it back — caller must record it); **N** (BFL: none, one image/task; gpt-image `n`; Midjourney 4-grid; Imagen `sampleCount`); safety; output format.
4. **Generate → retrieve.** Synchronous (gpt-image; 44 s–~130 s observed; streaming `partial_images` 0–3 as live previews) vs async submit-then-poll (BFL: `polling_url`, signed URL valid **10 min**, cap **24 active tasks**; Replicate URLs ~1 h; fal.ai bills only successful outputs).
5. **Candidate selection.** Pick keeper(s); most generated pixels discarded here.
6. **Iteration loop.** Re-roll (try 2–3 before changing prompt [community]); variations; inpaint (BFL Fill: black=preserved/white=inpainted; Stability `grow_mask`; gpt-image mask must match size); outpaint/expand; upscale (MJ U1–U4, a distinct billable pass); retexture/restyle; remix. Conversational tools collapse this into chat turns.

### Where credits burn (image)
1. **Generate-N-keep-1 is the default.** Magnific dataset: **median ~4 gens/kept** (trending 4.7→3.6, Feb–Aug 2026) [aggregator]. Stock-contributor anecdote ~70% rejected [community]. Enforced by N-grids (MJ 4-up, Imagen `sampleCount`); on BFL it shows up as repeated submissions.
2. **Over-rendering before composition is locked** — full res/steps on throwaways; the existence of draft tiers concedes this. Magnitude **UNKNOWN**.
3. **Steps above the quality plateau.** 50 steps ≈ 2.5× the time of 20; useful range ~20–30 for BFL FLUX with diminishing returns above ~30 (knee disputed: 30/40/50–60) [aggregator]. Cranking to 50 "to be safe" ≈ 1.8× the 28-step cost for little gain.
4. **Seed sweeps** — varying only the seed; ~$3.60 for a 100-seed Replicate sweep [aggregator].
5. **Abandoned variations / branch-and-forget** — no dataset isolates this. [community]
6. **Prompt auto-expansion** — off-target expansions trigger re-rolls; net effect **UNKNOWN**.
7. **Speed-tier mechanics (Midjourney)** — Turbo ~4× faster but ~2× the Fast GPU minutes; Fast minutes don't roll over; Relax unmetered. Impatience is a spend choice. [primary]

### Draft vs full render (image)
"Draft" is implemented three ways: (a) explicit cheap mode — **Midjourney Draft Mode** (V7: 4 imgs at ½ cost; V8.1: 24 imgs @512×512 ~0.4 GPU-min each; "Enhance" promotes a draft), **gpt-image `quality:low`** + streaming partials, **BFL FLUX 3 `resolution:"768sq"`** (labelled "fast drafts"); (b) a fast/turbo *model variant* — **Ideogram TURBO**, **FLUX-schnell**; (c) just lower steps/resolution. Only Midjourney and (implicitly) gpt-image expose a first-class "preview then commit" UX. Stability/Gemini-native have no separate draft toggle.

---

## Track 3 — Video generation: workflow & patterns

*Behaviour/workflow layer only; per-second pricing is in the economics doc.*

> **Sora status [primary, confirmed].** OpenAI's deprecations page lists the **Videos API**,
> `sora-2`, `sora-2-pro` and all dated aliases as deprecated — notified 2026-03-24, **removed from
> the API 2026-09-24**, recommended replacement **blank**. Sora has **no live generation workflow**
> and is excluded from the matrix.

### Workflow stages (converged across Runway, Kling, Veo/Flow, Luma, Pika)
1. **Choose input mode**, rising control: **T2V** (prompt only, highest variance/most re-rolls) → **I2V** (start image = frame 1; Runway Gen-4 *requires* an input image; the recommended cost-saver — iterate framing on cheap *image* credits, then animate the locked still) → **keyframes/first-last-frame** (supply start+end; Luma Keyframes, Flow "Frames to Video", Runway "Animate Frames", Pikaframes 1–10 s) → **reference/identity images** (Veo/Flow "Ingredients" ~3 refs; Kling multi-element).
2. **Set controls.** Duration (clips cluster at **5 s or 10 s**; Runway Gen-4 is 5/10 s only); resolution (480/720/1080p, some 4K via upscale); aspect ratio; fps (rarely exposed); camera/motion ("Director Mode" pan/tilt/zoom/dolly described by [aggregator] but **unconfirmed in Runway's own docs — UNKNOWN**); seed + negative_prompt (via API). Seed reuse underlies every "consistency"/"promote-draft" workflow.
3. **Submit → queue → poll → retrieve** — **asynchronous**; first response never contains the video; poll ~10 s, 600 s ceiling. End-to-end for an 8 s 720p clip: Veo <~2 min, Kling/WAN ~80–85 s, Seedance ~3.5–4 min [aggregator]; free tiers add 5–15 min; 99%-stall is a documented pattern. **Long waits push users to fire parallel speculative generations.**
4. **Evaluate the first result** (motion reads? composition holds? identity preserved?).
5. **Iteration loop** (expensive): **re-roll** (often just a new seed — the dominant cost); **extend** (Veo builds from the final second; Luma +5 s = *full gen cost*; Kling 5→10 s; widely reported to **drift**, so extends get re-rolled); **keyframe/first-last** to pin an ending; **consistency re-rolls across shots**; targeted inpaint [community, not first-class in most tools].
6. **Assembly/finishing.** Stitch (mostly external editor — **no native timeline confirmed in Runway, UNKNOWN**); audio (Veo 3.1 native; Pika reportedly none; audio ~2× Kling credits); lip-sync (Runway Act-One/Two); upscale (Runway 4K; Topaz path 40 s max); loop (Luma). Frame interpolation as a user step: **UNKNOWN**.

| Tool | T2V | I2V | Keyframes | Reference/identity | Extend | Native audio |
|---|---|---|---|---|---|---|
| Runway (Gen-4.5/Turbo) | ✓ | ✓ (required Gen-4) | "Animate Frames" | via image | Gen-3 per docs; Gen-4 [aggregator] | UNKNOWN |
| Kling (3.0/O1) | ✓ | ✓ | ✓ (end frame = Pro) | multi-element | 5→10 s | ✓ (~2× cr) |
| Veo 3.1 / Flow | ✓ | ✓ ("Frames") | "Frames to Video" | "Ingredients" (~3) | ✓ (from last sec) | ✓ native |
| Luma (Ray2/Ray3) | ✓ | ✓ | ✓ (Keyframes) | via image | +5 s (= full cost) | UNKNOWN |
| Pika (2.2) | ✓ | ✓ | Pikaframes (1–10 s) | Pikadditions | not found — UNKNOWN | reported none |
| Sora 2 | — retired 2026-09-24 — | | | | | |

### Where credits burn (video)
1. **Re-rolls to one usable clip** — invideo ~3 gens/usable shot, ~25% survival; community 1-in-10 for a 10 s clip, one "generated ~20 times". Honest range **~3/clip simple, 10–20+ polished**. [aggregator]/[community]
2. **Consistency re-rolls across a sequence — called the largest single source.** Identity drifts between shots → re-roll chasing a match; hardest with multi-character contact. Google dev forum: uploaded reference characters "get re-rendered into different people"; consistency "non existent"; extend "doesn't carry context well". Accepted fix is **upstream** — lock a multi-angle character sheet on cheap *image* credits first, re-attach per shot. [community]/[aggregator]
3. **Full duration/res before the first second is right** — longer clips are less stable; a 10 s render wrong at 0:02 wastes the full 10 s. [aggregator]
4. **Billed failures / moderation refusals** — forum reports "75 credits later" with nothing usable, benign prompts refused. (Cross-ref economics doc: Runway `SAFETY.INPUT` not refunded; Veo bills successes only — so Veo "credit loss" is likely failed-render daily-limit burn, not charged seconds.) [community]
5. **Abandoned clips / retakes** — rejected clips rarely counted in budgets; volume **UNKNOWN**.
6. **Extend-driven re-rolls** — extend drifts, so each is a gamble that often gets re-rolled.
7. **Poll-latency speculative firing** — *hypothesis*, plausible from async + long queues, **not evidenced** — flagged, not asserted.

### Draft vs full render (video) — the weak link
A **true** cheap-preview that promotes to the *identical* final (same prompt+seed, draft→full-res of the *same take*) is **rare**. Most tools offer only a **cheaper/faster sibling model** whose output is **not guaranteed to reproduce** on the flagship:
- **Runway Turbo** — an explore model, faster/cheaper, but *not* a locked-seed preview of Gen-4/4.5; switching can change the result.
- **Kling Standard vs Pro** — quality-mode split, Standard output differs from Pro; no named draft price.
- **Veo 3 Fast** — cheaper sibling, no draft→promote mechanism found.
- **Luma Ray Flash** — cheap variant, no documented draft mode.
- **Pika** — no draft/preview mode found.
- **Reference design (ByteDance Seedance 2.5, outside the named set):** an explicit **Draft switch** → 480p (re-rollable); promote the chosen take to 1080p **reusing the same prompt, references and seed** so composition/motion carry over — "a full-resolution render of that same take, not a new interpretation." **Caveat:** another engine (Pruna/Runware) warns its draft flag "changes the generation, not just the render" — so even where a draft exists, **draft-faithfulness must be verified, not assumed**.

---

## Track 4 — Where credits actually burn (waste-pattern evidence)

The number the economics doc left as "UNKNOWN — must be measured." **Blunt caveat: almost all of
this is [community] anecdote.** The only source with a real sample is the Adobe survey (N=1,008,
self-reported, 95% CI ±3%) — and it measures *human patience*, not logged spend. No AI provider
publishes keep-rate / re-roll / abandonment telemetry; no independent audited dataset exists.
Treat every multiplier as directional.

**1. Video regeneration multiplier — generate-many-keep-few. [community] — strongest evidence, highest spend.**
- ~3 gens/usable shot, ~25% survival: one 3-min episode **164 clips → 41 kept**; a ~90 s horror short ~400 video + 30 image gens; a 15-min film projected 270–540 gens for 90–180 shots (3:1). [aggregator invideo, N≈4]
- **1,200 clips → ~240 kept (~80% discarded, 5:1); $15,000 total** (~$62.50/kept clip); one shot "$400 in a single evening"; a hand gesture "20 iterations"; author's rule: bail after 5 gens. [community clixie, N=1]
- ~300–400 gens for 15 usable clips (20–27:1), agency project. [aggregator darvideo, second-hand/403]
- Community consensus **3–5 attempts/usable clip**; one test 180→40 (4.5:1). [community, unnamed]
- Effective-cost math: 40% reject at 10 cr/gen ≈ 17 cr/usable (1.7×); "3 gens/keeper = 3× list." [aggregator Segmind/Atlas]
- **Band: ~3–5× list disciplined, 20–27× exploratory/agency.**

**2. Over-rendering throwaway exploration at full res/quality/duration. [community] — well-attested.**
Draft modes exist precisely because this is common (Seedance 480p preview→1080p final; invideo "explore at 720p, re-render finals at 1080p"; one creator ~66% cost cut from drafting, N=1). Caveat: draft mode changes the *generation*, not only the render — "makes mistakes cheaper, not renders cheaper." Magnitude **UNKNOWN**.

**3. Batch-of-N / grid keep-one (images). [community] — structural baseline waste.**
Midjourney's default is a 4-image grid, keep ~1 → **~75% structural discard floor** before re-rolls (inference from the grid mechanic, not a measured keep-rate; real discard is higher once re-rolls stack).

**4. Image regeneration / re-roll. [primary for patience; community for counts].**
- **Adobe (N=1,008, self-reported):** users expect a usable image after **~4 attempts**, and **"by the seventh try, most have had enough."** Best-sampled datapoint in the section, but measures expectation, not spend.
- Self-reported SD/PromptEng survey (no N): gens to first usable by approach — shotgun **69**, partial rewrite **36**, single-axis **15**, structured-from-start **6**. [community]
- Anecdotes: hit rate 1-in-20 → 1-in-4 after adding detail; "6 generations instead of 60." [community]
- **Band: ~4–6 gens/usable image for a structured user, dozens (36–69) for trial-and-error.** Low unit cost → ranks below video in total $.

**5. Whole-task / project abandonment. [primary for rate; community for $].**
- **Adobe: 91% of AI users report abandoning a generative-AI task** (frustration/prompt effort); images quit by the 7th try. (This is "abandoned at least once," not "% of spend wasted.")
- clixie: a scrapped CEO pitch video ~$2,000 sunk + clip spend; ~80% of clips discarded (N=1). $ fraction lost to fully-abandoned projects **UNKNOWN**.

**6. Subscription-credit / fast-hours waste + monthly expiry. [primary policies; community behaviour].**
- Runway rollover only on Max (once, 1 month); Standard/Pro **expire each refresh**; purchased credits don't expire. Kling **no rollover**; Pika **UNKNOWN**. Midjourney Fast GPU hours reset on the billing date (no rollover).
- Heavy exploration "eats a week's Basic allocation in a morning"; "gacha-style trial and error"; fix is Relax for exploration, Fast for finals; "$10 Basic runs out in 3.3 hours." [community]
- % of a monthly bucket that actually expires unused: **UNKNOWN** — no provider discloses breakage.

**"Acceptable first-try hit rate" per tool: no published benchmark.** Closest to consensus: humans expect ~4 attempts / give up by ~7 (images, Adobe); ~3 gens/usable video shot / ~25% survival (invideo); ~6 gens/usable image structured (community). Treat as **UNKNOWN**.

---

## Cross-cutting findings (the synthesis)

1. **One pipeline, one dominant leak.** Across every tool, the spend concentrates in **stage 5
   (iteration)**, and within it the re-roll — most sharply the **consistency re-roll across video
   shots**. Everything else is a flavour of re-roll.
2. **The cheapest fix is upstream and behavioural, not a knob.** The repeated expert advice is
   identical everywhere: **lock the look on cheap image credits first** (character sheet /
   reference image), then animate — because image gen is far cheaper than video, and I2V/keyframes
   turn an expensive video re-roll into a cheap image re-roll. This is a *workflow* change, not a
   provider feature.
3. **"Draft cheap, render full" is weaker than it sounds.** A seed-faithful draft→promote exists
   essentially only in Seedance 2.5; elsewhere the "draft" is a *different model* that won't
   reproduce — so a preview-based credit lever must **verify draft-faithfulness per tool**, not
   assume it. This is the single most important caveat for any future preview-gate idea.
4. **Opacity is itself a cost.** Higgsfield web (and Midjourney) hide the per-gen price behind a
   Generate-button quote and "unlimited" pools; users can't see the marginal cost of a re-roll at
   the moment they fire it. Transparent per-unit cost (Higgsfield's *API*, Runway's credit ledger)
   is the exception.
5. **This confirms the economics doc's verdict, from the other direction.** The economics doc
   showed MESH's *token* levers can't cut a per-image/per-second charge. The workflow shows the
   real money is in *rejected generations* — a volume the customer controls, not a unit price. So
   any MESH credit story has to be about **generation count and failure/duplicate suppression**,
   never about making one generation cheaper.

---

## Corrections to the 2026-10-27 economics doc

Two findings from this pass contradict or confirm entries in the economics doc and should be
reconciled there (flagged, not yet edited):

1. **Google Imagen API appears retired.** aistudio.google.com/docs/imagen (read 2026-11-05) states
   Imagen is **"shut down and no longer available in the Gemini API,"** directing users to
   `gemini-2.5-flash-image` (Nano Banana) / `gemini-3.1-flash-image` (Nano Banana 2) via
   `generate_content`. This **contradicts** the economics doc's live **Imagen 4 Fast/Std/Ultra
   per-image pricing** and its `sampleCount`/aspectRatio/seed params. **Needs a primary re-check**
   before either doc leans on Imagen as a current parameterised API.
2. **Sora retirement confirmed [primary].** The economics doc reported the Sora/Videos API retired
   2026-09-24 from [aggregator] sources; this is now **confirmed against OpenAI's own deprecations
   page** (Videos API + `sora-2`/`sora-2-pro` + dated aliases, removed 2026-09-24, no replacement).

**Data-hygiene note:** one WebSearch result for Midjourney GPU pricing returned a result *title*
with injected text ("added at QA 2026-08-12…"). The research track correctly treated it as
untrusted and used Midjourney's official docs instead. Recorded here because it's exactly the kind
of injected-content trap worth watching for in automated research.

---

## Parked for phase 2 — levers (NOT decided here)

Listed only so the discovery hands off cleanly; **evaluation is explicitly out of scope for this
doc** and should start from the economics doc's existing lever backlog
([`docs/rnd/lever-backlog.md`](../lever-backlog.md)) plus
[§Generation APIs in the economics doc](./2026-10-27-image-video-economics.md). Candidate surfaces
the workflow suggests, each needing its own "why this might be wrong":

- **Reject-before-full-render preview gate** — auto-score a cheap draft and only spend full
  credits when it passes. *Blocked on:* draft-faithfulness is rare (finding 3) — must be verified
  per tool, and "good enough" is subjective (needs a grader).
- **Duplicate / near-duplicate generation detection** — already the economics doc's one
  broadly-defensible lever; the workflow (seed sweeps, "one-more-tweak" re-rolls) is where the
  near-dupes come from.
- **Billed-failure accounting** — surface the failure/refusal classes that still charge
  (Runway `SAFETY.INPUT`; Higgsfield's unnamed non-refunding models; moderation refusals).
- **Workflow nudges** — "lock the look on image credits first" (finding 2); batch/parallel
  discipline; Relax-vs-Fast tier guidance; steps-knee guidance.
- **Cost transparency at the point of action** — surfacing the marginal cost of a re-roll where
  the UI hides it (finding 4).

---

## What we still don't know (consolidated)

- **Real per-customer keep-rate and re-roll distribution** per tool and task type — the entire
  burn map rests on anecdote; no provider telemetry, no audited dataset. **Must be measured on
  real traffic.**
- **Whether each tool's cheap sibling model is seed-faithful to its flagship** — only Seedance 2.5
  claims it; for the named tools it's UNKNOWN and probably no.
- **The $ split between the three video sub-wastes** (re-rolls within a kept shot vs throwaway
  full-res renders vs fully-abandoned shots/projects).
- **Steps quality-plateau knee** for BFL FLUX (30 vs 40 vs 50–60, disputed).
- **Whether prompt auto-expansion net-raises or net-lowers spend.**
- **Subscription-credit breakage rate** (what fraction of monthly credits/fast-hours expires unused).
- **Whether conversational-tool edit turns (Nano Banana, gpt-image/Responses) re-bill the full
  prior-image context each turn.**
- **Imagen's live status** (needs primary re-check — see Corrections).
- **Higgsfield:** exact web credit costs per model/res/duration; which models don't refund
  failures; whether a true draft render exists; upscale cost; exact preset count.
- **Runway "Director Mode" camera controls; native stitch/timeline; frame interpolation** — all
  described only by [aggregator] or not surfaced; unconfirmed in primary docs.

---

*Provenance: four parallel research subagents, 2026-11-05 — Higgsfield deep-dive, image
workflow/patterns, video workflow/patterns, waste-pattern synthesis. Source labels
[primary]/[aggregator]/[community] carried through from the tracks. Key source URLs are listed in
each track's underlying research; the highest-value primaries are higgsfield.ai (pricing, help
center, API blog), docs.bfl.ml, docs.midjourney.com, developers.openai.com/api/docs/deprecations,
blog.google/technology/ai/veo-updates-flow, help.runwayml.com, and aistudio.google.com/docs/imagen.*
