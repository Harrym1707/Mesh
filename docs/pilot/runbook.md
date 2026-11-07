# MESH pilot runbook (one page)

> **New in this kit:** the single canonical way to set a partner up is now
> [onboarding.md](./onboarding.md) (proxy mode). The partner-facing day-0→day-14
> narrative below still holds; the step-by-step **operator** side — onboarding a
> partner, collecting and verifying their ledger, and billing them by hand — is
> the [Operator playbook](#operator-playbook--manual-billing) at the end of this
> file. What each command actually does was verified on `main`; see
> [VERIFICATION.md](./VERIFICATION.md).

**What MESH is.** An SDK wrapper that reduces LLM spend with cache-safe token
reduction, prompt-cache placement, and execution-tier arbitrage — and bills 1%
of *verified* savings. Verified means: measured per completed task from
provider-reported usage, quality held by a gated replay, recorded in an
append-only hash-chained ledger you can recompute to the cent on your own
machine. If MESH saves you nothing, the verdict is **do_not_charge** and the
invoice is $0.

**What the pilot costs you.** One file export, one wrapper line, two weeks of
normal traffic. No infrastructure change, no proxy in your request path, no
data leaves your machines (see [data-handling.md](./data-handling.md)).

---

## Day 0 — the quote (30 minutes, your machine, read-only)

1. Export spend logs from your gateway (LiteLLM `/spend/logs`, Helicone
   requests, or Langfuse generations — JSON).
2. `npx mesh-quote <export-file> --format litellm` (runs locally, no network).
3. Read the quote: each traffic stream classified into a segment
   (consumer / app-layer / in-house-agent / already-optimised), an honest band
   per stream citing the measurement it is an analogue of, your own gateway and
   provider-cache savings **credited to you and excluded**, unpriced models
   reported as unpriced (never zeroed), and — when true — the explicit
   **"do not pay us"** answer.

If the quote says MESH is not worth it on your traffic, the pilot ends here and
that is the correct outcome.

## Day 1 — install (five minutes, cannot break your app)

1. `npm install` the MESH SDK tarball.
2. Wrap your client: `withMesh(openai)` — OpenAI Responses, Chat Completions,
   and Anthropic `messages.create` all go through one shared handler.
3. Ledger on: billable events (token counts and hashes only, never prompt
   content) append to a local file. The ledger is opt-in and try/caught — a
   ledger failure can never throw into your request path.

Only lossless levers run by default (schema compaction, duplicate removal,
cache-prefix repair, output caps). Lossy levers stay off until step 3.

## Days 2–13 — measure

- MESH records provider-verbatim usage per request; failed tasks void all their
  turns; savings you already had (provider cache on appended history, gateway
  cache hits) are recorded and never billed.
- Optional: run the replay gate on a sample of your traffic. A lossy lever
  (e.g. fresh tool-result capping) bills **only** with an approved replay-gate
  verdict; a changed tool call is a hard zero.
- Latency-tolerant workloads you flag get tier arbitrage (OpenAI flex /
  batch, 50% off list, zero quality mechanism involved).

## Day 14 — the invoice you can check

1. `recomputeInvoice(events, catalogue)` — a pure function over your own event
   file and a content-hashed, dated, sourced price catalogue. Byte-identical
   across runs; tampering with any event is detected and the position named.
2. Negative components **net against MESH** (e.g. a 1h cache-write surcharge
   that never earned its reads), never clamped.
3. Invoice = 1% of the net verified savings for the period, or
   **do_not_charge**.

---

## What MESH never does in a pilot

- Never proxies or stores your prompts; never sends your data anywhere
  (the metering sink itself is local and network-free).
- Never bills from its own token estimates — provider-reported usage only.
- Never claims savings your gateway or the provider's default caching already
  gave you.
- Never quotes a number without its measured / simulator-measured / projected
  label and segment caveat.

## What a pilot partner should expect, numerically

Bands from the quotable matrix in [README.md](./README.md) — e.g. interactive
agents 26.0–29.4% (measured, synthetic harness), async-tolerant 64.3%
(measured, OpenAI-priced), one-shot 45.5% (measured). These are harness
numbers against synthetic traffic: **your** number comes from your export on
day 0 and your ledger on day 14, and only the day-14 number is ever billed.

---

# Operator playbook — manual billing

This is the founder/operator side of a pilot. During the pilot we bill the first
few partners **by hand**: every invoice is reviewed by a human and created in
Stripe **test mode** (or finalized to send as an invoice), never pulled as an
automatic direct debit. Auto-billing is a separate hardening track; do not use
it for pilot partners.

Each command below was run on `main` on 2026-11-07 ([VERIFICATION.md](./VERIFICATION.md)).

## 0. One-time operator setup

- A Stripe account. Keep a **test** secret key handy; store it out of the repo,
  e.g. `~/.config/mesh/stripe.env` containing `STRIPE_TEST_SECRET_KEY=sk_test_…`.
- A local checkout built once: `corepack enable && pnpm install && pnpm build`
  (this builds `packages/core`, which `mesh-bill` reads from
  `packages/core/dist`).

## 1. Onboard a design partner

1. Pick **one** onboarding row for this partner from [onboarding.md](./onboarding.md)
   (proxy via npm is the default) and record it in
   [engagement-list.md](./engagement-list.md): the ledger location and the
   agreed pilot window.
2. Send the pilot agreement / onboarding email
   ([pilot-agreement.md](./pilot-agreement.md)) and get a plain-text "yes" back
   before any traffic flows.
3. Create their Stripe **customer** (test mode) and note the `cus_…` id. No
   payment method is needed to create and review a draft.

## 2. Collect and verify their ledger

The partner's ledger is a set of hash-chained `.jsonl` spools at the location you
agreed (proxy → `./mesh-ledger/`; launcher → `~/.mesh/ledger`). Have them send
you the spool files (usage numbers and hashes only — no prompt content is in
them; see [data-handling.md](./data-handling.md)).

**Verify the chain before you even look at the number.** The partner can run this
themselves and so can you — it is the MIT, zero-dependency recompute tool:

```bash
npx -y -p @harrym1707/verify mesh-verify ./their-spools/*.jsonl
```

It prints `chain verified: N record(s), every hash links` and the recomputed
invoice. If it reports a broken chain, **stop** — do not bill an unverifiable
ledger. (`mesh-bill` enforces this too, below, but check it first.)

## 3. Bill them manually (draft → review → confirm)

Always start in **test mode** with a **draft**. `mesh-bill` recomputes the
invoice from the spools, re-verifies the chain, and creates a Stripe draft — it
never charges.

```bash
source ~/.config/mesh/stripe.env    # exports STRIPE_TEST_SECRET_KEY
node --import tsx scripts/mesh-bill.ts \
  --customer cus_THEIR_ID \
  --period 2026-11 \
  --fee 1 \
  --label "partner-name" \
  ./their-spools/*.jsonl
```

Read the output before doing anything else:

```
Mode: TEST  ·  period: 2026-11  ·  fee: 1%
Net verified savings: $<X>  ·  verdict: <charge | do_not_charge>
Will create (draft=true): <N> usd cents to cus_THEIR_ID
```

**The honesty checks — respect every one:**

- **`verdict: do_not_charge`** (no savings, or the 1% fee rounds below a cent, or
  the partner's stack was already optimised) → `mesh-bill` prints `DO NOT BILL`
  and creates nothing. The invoice is **$0**. This is a correct, expected outcome
  — tell the partner so plainly.
- **`CHAIN BROKEN … DO NOT BILL` (exit 1)** → the ledger failed verification. Do
  not bill. Go back to the partner for a clean spool.
- **A `sk_live_…` key is refused** unless you pass `--live` deliberately. There is
  no reason to bill live during the pilot — leave it in test mode.
- Re-running the same customer+period+amount is idempotent at Stripe (no double
  charge).

If the verdict is `charge` and the figure looks right, the draft now exists in
the **Stripe test dashboard**. Review it there, eyeball the amount against the
`mesh-verify` recompute, and **either** finalize/send it from the Stripe
dashboard **or** re-run with `--finalize` to finalize+send. For the pilot, prefer
**invoice-send** (the partner pays an invoice) over an automatic charge.

## 4. After billing

- Record the invoice id, the net-verified-savings figure, and the verdict in
  [engagement-list.md](./engagement-list.md).
- Keep the partner's spools — the invoice is a pure function of them, so "run it
  yourself" is always the dispute path.
- If a partner disputes the figure, the resolution is `mesh-verify` on their own
  spools. If their recomputation disagrees with ours, **theirs wins**.

## Manual-billing guardrails (do not remove)

- Test mode by default; live keys refused without `--live`.
- Broken/unverified chain is a hard stop.
- No prompt content is ever read or sent — only usage-derived totals.
- No automatic direct-debit pulls during the pilot. Draft → human review →
  confirm, every time.
