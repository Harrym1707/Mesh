# Phase 0 spike — plan (DRAFT / THEORY, uncommitted)

> **⛔ PARKED 2026-11-07 — not being run. See [the decision record](./2026-11-07-image-video-PARKED-decision.md).**
> This spike was never run; image/video is parked as advisory-only. The plan stays as the recipe
> to follow *if* a design partner or a real-traffic opportunity ever reopens it.

**Status: DRAFT, uncommitted, theory.** A plan for a throwaway measurement experiment. No product
code, no suppression, no billing — the spike only *watches*. Companion to
[the scope of works](./2026-11-05-image-video-credit-reduction-SOW.md). Date **2026-11-05**.

---

## 1. The one question this spike answers

> **In real image/video traffic, what share of credit spend is exact duplicates + billed failures?**

That single number decides everything downstream:
- **High enough** → the net-new foundation (generation transport + credit pricing) is worth
  building; proceed to Phase 1 (served exact-dedupe, failure accounting).
- **Too low** → MESH cannot honestly cut generation spend; we say so and stop. (`do_not_charge`,
  in MESH's own language.)

We are *not* trying to build the product in Phase 0. We are buying the one fact the whole business
case rests on — the frequency number that no provider publishes and the SOW flags as UNKNOWN.

## 2. What we measure (and the decision gate)

Logged per generation request, then aggregated:

| Metric | What it tells us | Feeds lever |
|---|---|---|
| **Exact-duplicate rate** (same fingerprint seen before) | ceiling on don't-pay-twice savings | A1 |
| **Billed-failure rate** (failed *and* charged — e.g. Runway `SAFETY.INPUT`) | don't-pay-for-nothing savings | A2 |
| **Near-duplicate rate** (report-only) | size of the fuzzy edge; false-positive risk | A1 (info) |
| **Requests per session/task** | re-roll intensity (proxy for the behavioural waste) | A4/A5 (info) |
| **Cost captured per call?** (yes/no + value) | validates the provider actually returns a cost | F2 |

**Decision gate (set the threshold with Harry before we start):** e.g. *if exact-dup + billed-
failure spend ≥ N% of total credit spend over the window → GO; else → STOP.* Writing the kill
condition down first is what makes this a spike and not an open-ended build.

## 3. Scope — deliberately tiny

**Build:** a measurement-only shim in front of **one** provider endpoint — a thin pass-through
(or SDK wrapper) that forwards every request unchanged and logs a row per call. Throwaway code,
lives outside the product (e.g. `spikes/`), not wired into `proxy.ts`.

**Log per request (hashes only, never response bodies — honour the no-store rule):**
`{ ts, canonical_fingerprint (sha256 of prompt+params+seed+refs), provider_cost_or_credits,
status, error_class, session_or_task_id if available }`.

**Analyse:** a small script over the JSONL → the five metrics above + the implied $ saving ceiling,
recomputable by hand (MESH-style: the number is verifiable, not asserted).

**Explicit non-goals (do NOT do in Phase 0):** no suppression, no caching/serving, no quality gate,
no billing, no multi-provider, no ledger integration, no behaviour change of any kind. Observe-only.

## 4. The key open decision — where does the traffic come from?

MESH's whole claim is "measured on *your own* traffic," so the spike needs real generation calls
flowing through an **API we can sit in front of**. This is the practical blocker:

- **Higgsfield web app → not proxyable.** If Harry works in the Higgsfield web UI, those calls
  can't be intercepted. We'd need either (a) routing some real work through the **Higgsfield API**
  instead, or (b) a usage-history export — but an export likely won't carry enough to fingerprint
  prompt-level duplicates, so (a) is the honest path.
- **Provider candidates (all return a usable cost, unlike gpt-image/BFL):**
  - **Higgsfield API** — most representative (his own ecosystem), returns USD per generation, *and*
    has a native idempotency key so we'd also get a free read on A3. Needs him to route real work through the API.
  - **Runway** — best **billed-failure** signal (documented `SAFETY.INPUT` not-refunded class) + a clean per-second credit ledger. Video.
  - **Stability** — cleanest technical proof (flat $0.08/image, echoes both seed and cost), best for validating the dedupe/fingerprint mechanics. May not reflect his real workflow.

**Recommendation:** start with the **Higgsfield API** if Harry can push a slice of real work
through it (most representative + bonus idempotency read); otherwise **Runway** for the failure
signal. Pick by *where real traffic actually is* — that's the decision to make before building.

## 5. Timebox & effort

- **Build:** ~2–3 days (one provider shim + log schema + analysis script). Spike quality, disposable.
- **Collect:** a bounded window — e.g. **2 weeks of normal usage** *or* **until ~300–500 real
  generations**, whichever first. Small-N caveat applies (one user ≠ the market).
- **Decide:** half a day to run the analysis against the pre-agreed gate and write a one-page GO/STOP.

## 6. Risks & how the spike stays honest

- **Small / unrepresentative N** — one person's traffic. Treat the result as directional; a GO
  means "worth a bigger pilot," not "proven at scale."
- **Provider cost field missing/unreliable** — if the chosen provider doesn't return a trustworthy
  per-call cost, the $ ceiling is an estimate; label it so. (Validating this *is* part of the spike.)
- **Fingerprint false positives** — intentional seed sweeps / one-word re-prompts look like
  near-dupes. Keep near-dup **report-only** and key the exact fingerprint on the *full* param set,
  not the seed alone.
- **It costs real credits to generate the traffic** — but measurement is passive, so it's just
  Harry's normal spend; no extra generations fired by the spike.
- **Honesty:** the output is a recomputable number from a logged JSONL, not a projection — same
  discipline as the rest of MESH.

## 7. Definition of done

One page: the five metrics on real traffic, the implied saving ceiling, and a **GO / STOP** call
against the pre-agreed threshold — enough to decide whether to build the Phase 1 foundation.

---

*Theory only. Nothing in this plan has been built or committed; this document is itself uncommitted.*
