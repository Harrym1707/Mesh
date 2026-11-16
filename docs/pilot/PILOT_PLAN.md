# MESH pilot — plan

> **Draft, updated 2026-11-16 for MESH 0.2.1.** No partner has been
> approached or signed. Setup follows the one path in
> [onboarding.md](./onboarding.md).
>
> **MESH is open to everyone:** no signup, no account, no waiting list.
> Anyone can install and use it today without asking
> ([Get started](../site/start.md)). **A pilot is optional:** an agreed
> measuring window, hands-on help and an invoice checked by hand, for a team
> that wants them. This plan is about pilots. Nothing in it limits who may
> use MESH.

The pilot exists to retire the one caveat that sits on every number in this repo:
**MESH has processed zero real customer traffic.** One real gateway's traffic,
measured and billed end-to-end, is worth more than any further synthetic harness.

## What we are testing

1. **Does MESH save real money on real traffic?** Net verified savings per
   partner, from their own hash-chained ledger — not a projection.
2. **Does the honesty model survive contact with a customer?** `do_not_charge`
   when appropriate, the partner recomputing our invoice and agreeing, no
   surprise on the data question.
3. **Is onboarding a five-minute job?** One install, one command (`mesh start`
   or `mesh proxy`), one base-URL change for an app, no infra change, no key
   sharing.

## Who a pilot suits

This is who a hands-on pilot is expected to suit, and who outreach is aimed
at. It is not a condition of using MESH. Teams already spending enough on LLM
APIs to care, who can change one base URL without a committee:

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

## How many pilots at once

- **3–5 pilots at a time.** That is how many can be run and billed by hand,
  each with someone sitting with the result, and enough that one dud doesn't
  sink the read. It is a limit on hands-on pilots, not on who may use MESH.
- Aim for a spread of workload shapes (at least one agent, one RAG/chat, one
  batch/async) so the savings bands get tested where they differ most.

## Success metric

**Realised verified savings per partner**, defined exactly as the product bills:
net savings from the partner's own ledger, recomputed and agreed by the partner,
over the pilot window.

- **Primary (per partner):** net verified savings > 0 **and** the partner
  recomputes our invoice figure and agrees with it.
- **Headline (across the pilots):** at least **3 partners with a positive, partner-verified**
  savings figure, and **zero disputed invoices** (dispute = the partner's own
  recompute disagrees with ours).
- A partner whose honest verdict is `do_not_charge` is **not** a failure of the
  pilot — it's the honesty model working. It is a failure of *fit*; note it and
  move on.

## What we measure (per partner)

| Measure | Source |
|---|---|
| Net verified savings ($ and %) | the partner's `mesh verify`; `mesh-verify` and `mesh-bill` on the ledger files they send |
| Savings by lever (cache stamp, schema compaction, dup removal, tier arbitrage) | invoice line items |
| `do_not_charge` events and why | invoice verdict + reasons |
| Did the partner recompute and agree? | their `mesh verify` run (or `mesh-verify` on a ledger file) |
| Time to onboard; any request-path incident | kickoff notes (target: minutes; incidents: zero) |
| Objections raised (esp. data / security) | engagement notes → feeds the real DPA |

## Timeline (about 4 weeks per partner, pilots rolling)

The measuring window is 14 days, the "day 0 to day 14" of the
[runbook](./runbook.md). Kickoff before it and the invoice and debrief after
it make a pilot about four weeks end to end.

- **Week 0 — kickoff.** Send the [pilot agreement](./pilot-agreement.md) and
  get a "yes". The yes is for the measuring window and any invoice; the team
  does not need it to install or use MESH and may already be running it. Set
  up or confirm onboarding ([onboarding.md](./onboarding.md)); optional day-0
  quote from a gateway export.
- **Weeks 1–2 — measure (14 days).** Normal traffic through the proxy, ledger
  in `~/.mesh/ledger/` on the partner's machine. Lossless levers on. Theo
  stays on his default autonomy, `recommend`, and is never set to `optimise`
  during a pilot; a lossy lever runs only behind an approved replay gate on
  the partner's own traffic and their yes to the proposal.
- **Week 3 — invoice.** Operator runs the manual-billing playbook
  ([runbook.md](./runbook.md#operator-playbook--manual-billing)): collect the
  ledger, verify the chain, draft the invoice in Stripe test mode, review it.
  The partner recomputes independently with `mesh verify`.
- **Week 4 — debrief.** Did the number hold? Would they pay it ongoing? What
  blocked them? Decide: convert, extend, or close out.

## Billing during the pilot

**Manual only.** Each invoice is created as a draft in Stripe test mode and
reviewed by a person. No live Stripe key is used and nothing is charged
automatically; what a partner is then sent, and how they pay, is agreed with
them by hand and is the founder's decision. The auto-billing path is a
separate hardening track and is **not** used for pilot partners. Fee: **1% of
net verified savings**, monthly; `do_not_charge` → $0.

## Known gaps to close before general availability

- **Reviewed terms and a DPA.** The [pilot agreement](./pilot-agreement.md) is
  a minimal, plain-language stand-in for pilots, not reviewed by
  a lawyer. The website's Terms and Privacy pages (12 November 2026) are
  unreviewed first drafts, and there is no DPA.
- **Compliance.** No SOC 2 / ISO yet; the architecture (no prompt data leaves the
  partner's machines) is the current answer, not a certificate.
- **Savings figures are not yet from customer traffic.** The one LIVE figure is
  18.2% on MESH's own mixed 30-request test basket (run 2026-10-26); every
  other figure is SIMULATOR. All of them are in
  [docs/NUMBERS.md](../NUMBERS.md), and this pilot exists to replace them with
  real-traffic numbers.
- **Billing outside a pilot.** The website states the price (1% of verified
  savings, monthly, nothing else). How someone who uses MESH without a pilot
  is invoiced is not defined in this kit; there are no accounts, no
  self-serve signup and no automatic billing.
- **First real traffic.** The 0.2.1 path was tested with Claude Code and the
  official Anthropic and OpenAI SDKs against a stand-in provider, not against
  a real provider under a partner's workload. The tester guide's
  ["Known limits"](./TESTER-GUIDE.md#known-limits-2026-11-16) lists what is
  not covered (Windows, realtime APIs, Azure OpenAI's address format,
  always-on mode outside macOS).
