# Decision: image/video credit reduction — PARKED (advisory-only)

**Status: DECISION RECORD, uncommitted, theory.** Date **2026-11-07**. Decided by Harry.

## The decision

Stop pursuing image/video credit reduction as a build. **Park it.** If Mesh touches
image/video at all, it is **advisory only** ("you re-rolled this 6 times", "this prompt
is a duplicate") — never a silently billed saving. Mesh stays focused on token-billed
LLM traffic, where the levers are proven.

This closes — for now — the feasibility work in:
- [Scope of works](./2026-11-05-image-video-credit-reduction-SOW.md)
- [Phase 0 spike plan](./2026-11-05-phase0-spike-plan.md)
- [Economics](./knowledge/2026-10-27-image-video-economics.md) · [Workflow discovery](./knowledge/2026-11-05-image-video-generation-workflow-discovery.md)

## Why — the evidence that led here

1. **Pricing is per-image / per-second / per-megapixel, not per-token.** Mesh's core
   lever (cut tokens) cannot reduce a per-generation charge. The only honest lever is
   reducing the *number* of billable generations.

2. **The lossless, auto-billable slice is ~1%.** Analysis of the only real traffic
   firehose that exists — DiffusionDB, 14M real Stable Diffusion generations, Aug 2022:
   - Byte-identical regenerations (same prompt + params + seed) = **0.86%** of generations.
     That is the lossless exact-cache ceiling. Small.
   - Genuine re-rolls (same user re-requesting an identical prompt on a later occasion) =
     **~11% of clicks** — real money, but suppressing them returns an old image instead of
     a fresh try, i.e. **lossy** → advisory / quality-gated, never auto-billed.
   - The scary "86% duplicates" is a mirage: 84% of it is one click returning a *batch* of
     different images (different seeds) — intended, not waste.

3. **No modern data to improve on that.** No public 2025/26 generation *usage-traffic*
   dataset exists (checked HuggingFace exhaustively, 2026-11-07). Everything public is
   training corpora, curated prompt lists, or research benchmarks — all galleries of KEPT
   outputs that hide re-rolls and show zero billed failures. The modern number only exists
   in live traffic.

4. **The main provider may not even charge for failures.** The Higgsfield API reportedly
   does not bill failed requests — which removes one of the two clean levers ("recover
   billed failures") for Harry's primary provider. (Unverified; was a third-party claim.)

5. **Getting a real number costs money or a design partner.** Validation would require
   routing real work through an interceptable provider API (Harry has no API and web-app
   traffic isn't proxyable) — not worth it given 1–4.

## What would reopen this

- A design partner doing high-volume, API-driven image/video work who'll share a live read.
- A provider shift to token-style or deterministic (seed-exposed) pricing that makes
  lossless dedupe meaningfully large.
- Hard evidence from real traffic that duplicates + billed failures are a large, $-weighted
  share of spend (the Phase 0 spike, if ever run).

## What we keep from the work

- The economics + workflow knowledge docs (useful reference).
- The DiffusionDB analysis scripts and the "don't inflate duplicate counts" discipline.
- The insight that *honest* image/video dedupe depends on seed capture (lever A6).

---

*Theory only. Nothing built or committed.*
