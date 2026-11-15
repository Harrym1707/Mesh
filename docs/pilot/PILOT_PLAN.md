# MESH design-partner pilot — plan

The pilot exists to retire the one caveat that sits on every number in this repo:
**MESH has processed zero real customer traffic.** One real gateway's traffic,
measured and billed end-to-end, is worth more than any further synthetic harness.

## What we are testing

1. **Does MESH save real money on real traffic?** Net verified savings per
   partner, from their own hash-chained ledger — not a projection.
2. **Does the honesty model survive contact with a customer?** `do_not_charge`
   when appropriate, the partner recomputing our invoice and agreeing, no
   surprise on the data question.
3. **Is onboarding a five-minute job?** One proxy command, one base-URL change,
   no infra change, no key sharing.

## Target ICP

Teams already spending enough on LLM APIs to care, who can change one base URL
without a committee:

- **Primary:** small/mid AI product teams running agent or RAG workloads on
  Anthropic and/or OpenAI, **$5k–$100k/mo** of API spend, no dedicated FinOps.
- **Signal they're a fit:** multi-turn agents that don't use prompt caching;
  large tool schemas resent every turn; latency-tolerant batch/classification
  jobs; "our LLM bill is scary and nobody owns it."
- **Already have a gateway (LiteLLM / Helicone / Langfuse)?** Even better — they
  can get a pre-contract quote from one export (`mesh-quote`) before installing
  anything.
- **Out of scope for the pilot:** teams already running a tuned caching + batch
  stack (MESH will honestly say `do_not_charge` — fine as a credibility demo,
  but not a billing pilot), and anyone who can't self-serve a config change.

## Cohort

- **3–5 design partners.** Small enough to bill each one by hand and sit with the
  result; large enough that one dud doesn't sink the read.
- Aim for a spread of workload shapes (at least one agent, one RAG/chat, one
  batch/async) so the savings bands get tested where they differ most.

## Success metric

**Realised verified savings per partner**, defined exactly as the product bills:
net savings from the partner's own ledger, recomputed and agreed by the partner,
over the pilot window.

- **Primary (per partner):** net verified savings > 0 **and** the partner
  recomputes our invoice figure and agrees with it.
- **Headline (cohort):** at least **3 partners with a positive, partner-verified**
  savings figure, and **zero disputed invoices** (dispute = partner's own
  `mesh-verify` disagrees with ours).
- A partner whose honest verdict is `do_not_charge` is **not** a failure of the
  pilot — it's the honesty model working. It is a failure of *fit*; note it and
  move on.

## What we measure (per partner)

| Measure | Source |
|---|---|
| Net verified savings ($ and %) | `mesh-verify` / `mesh-bill` on their ledger |
| Savings by lever (cache stamp, schema compaction, dup removal, tier arbitrage) | invoice line items |
| `do_not_charge` events and why | invoice verdict + reasons |
| Did the partner recompute and agree? | their `mesh-verify` run |
| Time to onboard; any request-path incident | kickoff notes (target: minutes; incidents: zero) |
| Objections raised (esp. data / security) | engagement notes → feeds the real DPA |

## Timeline (≈4 weeks per partner, cohort rolling)

- **Week 0 — kickoff.** Send the [pilot agreement](./pilot-agreement.md), get a
  "yes", set up onboarding ([onboarding.md](./onboarding.md)), optional day-0
  quote from a gateway export.
- **Weeks 1–2 — measure.** Normal traffic through the proxy; lossless levers on;
  any lossy lever only behind an approved replay gate on their own traffic.
- **Week 3 — invoice.** Operator runs the manual-billing playbook
  ([runbook.md](./runbook.md#operator-playbook--manual-billing)): collect ledger,
  verify chain, draft invoice, review, send. Partner recomputes independently.
- **Week 4 — debrief.** Did the number hold? Would they pay it ongoing? What
  blocked them? Decide: convert, extend, or close out.

## Billing during the pilot

**Manual only.** Each invoice is created in Stripe test mode as a draft, reviewed
by a human, and sent as an invoice (not an automatic direct-debit pull). The
auto-billing path is a separate hardening track and is **not** used for pilot
partners. Fee: **1% of net verified savings**, monthly; `do_not_charge` → $0.

## Known gaps to close before general availability

- **Real ToS and DPA.** The [pilot agreement](./pilot-agreement.md) is a minimal,
  plain-language stand-in for design partners only — not GA paper.
- **Compliance.** No SOC 2 / ISO yet; the architecture (no prompt data leaves the
  partner's machines) is the current answer, not a certificate.
- **Savings bands are still mostly synthetic** until this pilot replaces them with
  real-traffic numbers — which is the entire point.
