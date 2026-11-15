# Scope of Works (DRAFT / THEORY) — image & video credit reduction in MESH

> **⛔ PARKED 2026-11-07 — advisory-only. See [the decision record](./2026-11-07-image-video-PARKED-decision.md).**
> This scoping stands as reference; it is not being built. Short version: honest auto-billable
> savings for image/video are ~1% (lossless), the real waste (~11% re-rolls) is lossy/advisory,
> and there's no public modern traffic to validate against. Mesh stays focused on token-billed LLM traffic.

**Status: DRAFT, uncommitted, theory.** Nothing here is built or decided. This is a
feasibility scoping pass to answer one question — *can MESH reduce image/video credit spend
without reducing quality, and if so, what would it take?* We iterate on this before any code.

Date **2026-11-05**. Built from four parallel specialist reviews (architecture, provider APIs,
measurement/ledger, quality-neutrality), each grounded in the actual MESH code (commit `e1155ac`)
and the two knowledge docs ([economics](./knowledge/2026-10-27-image-video-economics.md),
[workflow discovery](./knowledge/2026-11-05-image-video-generation-workflow-discovery.md)).

---

## 1. The headline answer

**Yes, it can be done — but only a narrow slice is honestly billable, and nothing works until a
shared foundation is built.** Plainly:

- **Today, an image or video generation call doesn't even pass through MESH.** The proxy routes
  only Anthropic + OpenAI *text* endpoints; the SDK wraps only text methods; the price catalogue
  can only price *tokens*, not a credit/image/second. So **every lever below is blocked on the
  same net-new foundation** (§3).
- Once that foundation exists, **one lever bills cleanly as a verified, lossless saving**:
  **exact-duplicate suppression when MESH serves the stored asset** (reusing the existing
  `exact_cache` mechanism). It is provider-dependent and modest.
- **The biggest real waste — re-rolls — is human behaviour.** MESH can *measure* it and *nudge*
  the cheaper workflow (iterate on image credits, then animate), but it cannot book that as a
  lossless saving. It's advisory value, not an invoice line.
- **Two levers are effectively dead ends:** draft→promote (no provider offers a seed-faithful
  draft except one outside our set) and step-trimming (doesn't reduce a flat per-image charge, and
  the newest models have removed the `steps` knob entirely).

This is consistent with MESH's own ethos — we publish where we lose. On generation, MESH loses on
the headline charge and wins only on paying-twice / paying-for-nothing.

---

## 2. Per-lever feasibility verdict

Each lever scored on four axes: **Build** (can MESH's code do it), **API** (do providers expose
what it needs), **Provable** (can the saving be verified on the ledger), **Quality** (is it
provably quality-neutral). Verdict is the honest synthesis.

| Lever | Build | API support | Provable saving | Quality-safe | **Verdict** |
|---|---|---|---|---|---|
| **A1 Exact-duplicate suppression** | Reuse-heavy (SDK); net-new store + price | Determinism varies (Veo strong; gpt-image/Kling no seed) | **VERIFIABLE** *if MESH serves the asset*; else report-only | **Lossless** (identical bytes) | **Build-worthy core.** The one clean billable lever. |
| **A2 Billed-failure accounting** | Reuse (accounting); net-new (avoidance) | Runway clean; Higgsfield partial; rest UNKNOWN | Behaviour-contingent (you still paid) | Lossless | **Transparency, not a saving.** Report it; don't bill it. |
| **A3 Idempotency / retry dedup** | Detection **ships**; latch net-new | **Only Higgsfield** has a real server key; else client-side | VERIFIABLE if MESH collapses the retry | Lossless | **Folds into A1** + a single-flight latch. |
| **A4 Image-first workflow** | Advisory only (not a transform) | Broadly supported (all video = I2V) | Not event-measurable (cross-session) | Gated (I2V can differ) | **Advice, not billing.** Biggest practical saving, unbookable. |
| **A5 Consistency reference-sheet** | Advisory only | Refs widely accepted (fidelity not guaranteed) | Not event-measurable | Gated | **Advice, not billing.** "Largest waste" but anecdote-only. |
| **A6 Seed capture & reuse** | Capture = record-only; reuse = net-new | Stability best (in+echo); FLUX in-only; many no seed | Capture defensible; reuse → A1 slice | Lossless *iff* deterministic (usually not) | **Capture is cheap & honest; reuse is the drift trap.** |
| **B1 Draft → promote** | Mostly net-new; narrow | **No** faithful draft across the named set | Estimated, lossy, task-gated | Hardest to prove | **Not feasible now.** Revisit if faithful-draft APIs appear. |
| **B2 Step-trim** | Reuses gate; premise fails | **Only FLUX.1[dev]** exposes `steps` | $0 on flat-priced providers | Lossy | **Likely a non-lever.** Flat pricing = no saving. |

### Why each verdict (the sharpest constraint)

- **A1 — the core.** MESH can always fingerprint a request client-side; the catch is whether a
  repeat is genuinely identical. **Veo** is deterministic at a fixed seed; **Stability/FLUX.1/.2**
  expose a seed; **gpt-image and Kling have no seed at all** (so only a byte-identical payload
  counts as a dup there). It bills only on the slice where **MESH serves the stored asset** (same
  as text `exact_cache`); merely *reporting* a duplicate is behaviour-contingent. Net-new cost: a
  response-body store (which breaches the proxy's "never store content" invariant → lives in the
  SDK or a consciously-relaxed proxy mode) and a per-unit price to value the avoided call.
- **A2 — honesty line.** A billed failure delivered no asset, so flagging/reclaiming it is clean —
  but *reporting a charge the customer already paid is not a MESH saving*. Only Runway
  (`SAFETY.INPUT` not refunded) is a cleanly documented billed-failure class; most providers'
  refund rules are UNKNOWN. Pre-emptive blocking is fallible (benign prompts get refused), so it's
  advisory, not lossless.
- **A3 — mostly already here.** Duplicate *detection* ships today (metering only — the dup is
  still forwarded and billed). **Higgsfield is the only provider with a real server-side
  `Idempotency-Key`** that returns the original without re-charging; everywhere else there's no key
  to reuse, so MESH's only recourse is client-side collapse (= A1) plus an in-flight **latch** to
  close the concurrent-retry race.
- **A4 / A5 — real money, wrong shape.** "Lock the look on cheap image credits, then animate" and
  "build a character sheet once" are **API-supported everywhere** (every video model does
  image-to-video; nearly all accept reference images). But they're *workflow changes across
  sessions*, not a transform on one request — there is no event to anchor a saving to, and no
  provider exposes keep-rate telemetry. MESH can nudge and measure after the fact; it cannot book
  these. They are the **highest-impact** patterns and the **least billable**.
- **A6 — capture yes, reuse careful.** Capturing the seed (record-only, via the existing blind-
  features sidecar pattern) is cheap and honest *where the provider echoes it* — **Stability does;
  BFL takes a seed but never echoes it; FLUX 3 and gpt-image have no seed**. Reusing a seed to
  claim a saving is the canonical trap: a seed you believe reproduces but which silently drifts
  (most hosted APIs are non-deterministic). Seed *sweeps* are also intentional exploration, so
  flagging them as waste is a false positive.
- **B1 — blocked by the market.** A preview-gate only preserves quality if the cheap draft renders
  the *identical* take at full res. **No provider in our set does this** — every "draft" is a
  different, cheaper model/resolution (BFL even states "changing the resolution makes a new
  generation"). The only known seed-faithful draft→promote is ByteDance Seedance 2.5, which isn't
  in our set and isn't exposed as a faithful-promote API even through Higgsfield. Also needs a
  net-new image/video grader and per-customer calibration.
- **B2 — the premise fails twice.** Lowering steps cuts provider *compute*, not a *flat per-image
  charge* — so on Stability (flat/image) and BFL (per-MP) it saves **$0** (the same "lossless
  right-size = 0 tokens" trap from the economics doc). And only **FLUX.1[dev]** still exposes
  `steps`; FLUX.2/FLUX 3 dropped it, Stability abstracts it, gpt-image never had it. The knob is
  disappearing.

---

## 3. The shared foundation (prerequisite for everything)

None of the levers can operate until these exist. **This is the real scope decision** — it's the
cost of entry before any lever pays off.

| # | Foundation item | Why | Rough size |
|---|---|---|---|
| **F1** | **Generation transport** — proxy route(s) + SDK interception for image/video endpoints (`/v1/images/*`, Gemini `generateContent`, Runway/BFL/Stability/Higgsfield) | Today none of these flow through MESH at all | **L** |
| **F2** | **Per-unit price catalogue + usage shape** — a non-token rate type (per image / second / MP / credit), a generation `LedgerUsage`, and a `normalizeProviderUsage` adapter per provider | MESH can't price a credit today; can't value any saving without it | **M–L** |
| **F3** | **Generation request fingerprint + content-aware cache path** — extend `ExactResponseCache` to accept generation bodies (prompt+params+refs+seed) | Powers A1 / A3 / A6-dup | **M** |
| **F4** | **Kept-asset signal from the customer** — the per-completed-task unit for image/video is a *kept asset*, and no provider exposes keep-rate | Needed for any per-task accounting (A2 framing, B1) | **M** (needs customer integration) |

A hard caveat on F2: for several providers the per-call cost/credit figure **isn't returned by the
API** (gpt-image per-image token count is UNKNOWN; BFL price cells blank; Veo/Runway rates
aggregator-only). Only **Runway's credit ledger** and **Stability's flat $0.08/image** are
primary-derivable. So even "verifiable" levers are *verifiable-conditional-on* the provider
returning a cost — otherwise they drop to estimated or can't be priced.

---

## 4. Recommended build order (if we proceed)

**Phase 0 — decide if the foundation is worth it.** Before any lever, F1+F2+F3 is real work whose
*only* clean payoff is served exact-dedupe (A1) plus metering/transparency. Prototype the cheapest
proof: route **one** provider that returns a real cost (**Runway** or **Stability**), capture
verbatim generation usage on the ledger, and measure **duplicate + billed-failure frequency on
real traffic** — the number the whole business case rests on and which no provider publishes.
*If dupes/failures are rare in practice, stop here — the foundation isn't worth it.*

**Phase 1 — the defensible core (only if Phase 0's numbers justify it):**
1. **A1 served exact-duplicate suppression** (SDK, opt-in) on the routed provider — the one billable lossless lever.
2. **A3 single-flight latch** — closes the concurrent-retry double-bill; leverage **Higgsfield's native idempotency key** where present.
3. **A6 seed capture** (record-only) and **A2 billed-failure accounting** — transparency that strengthens the ledger without over-claiming.

**Advisory layer — no foundation needed, ship as guidance:**
- **A4 image-first** and **A5 consistency-sheet** as workflow nudges + a field-A/B harness that
  reports credits-per-kept-asset. Market the saving; measure it after the fact; **never book it**.

**Parked / not worth building now:**
- **B1 draft→promote** — revisit only if seed-faithful draft APIs become available and a grader is justified.
- **B2 step-trim** — non-lever against flat per-unit pricing and a vanishing knob. Drop unless a step-metered provider enters scope.

---

## 5. Must-measure before relying on anything (all UNKNOWN today)

- **Duplicate and billed-failure frequency in real customer traffic** — sets whether A1/A2/A3 are worth the foundation. No provider telemetry; must be measured.
- **Per-provider seed bit-determinism** (gates A1/A6-as-lossless) — mostly likely false; verify by submitting the same seed twice and checking byte-equality.
- **Which providers return a usable per-call cost/credit** (gates F2, and whether a lever is verifiable vs estimated).
- **Refund semantics** for BFL, Stability, Ideogram, Kling; Higgsfield's idempotency-key retention window.
- **Keep-rate / re-roll distribution** per tool (gates the A4/A5 advisory story) — anecdote only today.

---

## 6. One-paragraph honest summary (for the brief)

MESH can be extended to image and video, but the honest, *billable* credit saving is narrow:
**don't-pay-twice (served exact-duplicate suppression) and don't-pay-for-nothing (billed-failure
accounting)** — both provider-dependent, both gated on net-new generation plumbing and a credit-
pricing layer MESH doesn't have yet. It **cannot** reduce the per-image/per-second charge, and the
**largest** real waste (re-rolls, especially video consistency re-rolls) is customer behaviour MESH
can measure and nudge but not book as a lossless saving. Draft→promote and step-trimming don't
survive contact with the current provider APIs. The sober recommendation is a small Phase 0 spike
on one provider to measure duplicate/failure frequency on real traffic — because that single
unknown decides whether any of this is worth building.

---

*Provenance: four read-only specialist reviews, 2026-11-05 — architecture (code `e1155ac`),
provider-API capability matrix, measurement/ledger, quality-neutrality. Nothing in the repo was
modified to produce this. This document is itself uncommitted.*
