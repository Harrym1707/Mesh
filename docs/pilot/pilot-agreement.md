# Pilot agreement + onboarding email (draft)

> **Draft material. Not sent, and not reviewed by a lawyer.** Sending is the
> founder's act, not an agent's. This is a deliberately minimal,
> plain-language understanding for a **pilot** — see "Still needed before
> general availability" at the end. Have a lawyer review it before relying on
> it. Updated 2026-11-19; the current release is MESH 0.2.4.
>
> **Nobody needs this document to use MESH.** MESH is open to everyone: no
> signup, no account, no waiting list ([Get started](../site/start.md)). A
> pilot is optional. This understanding covers only what a pilot adds: an
> agreed measuring window, hands-on help and an invoice checked by hand.

---

## Part A — Onboarding email (copy/paste, fill the brackets)

> **Subject: MESH pilot — cut your LLM bill, pay only a share of what we verifiably save**
>
> Hi [name],
>
> Thanks for trying MESH. You don't need this email, or anything from me, to
> use it: MESH is open to everyone and you can install it today. A pilot is
> the hands-on version, for a team that wants an agreed measuring window, help
> with setup and an invoice checked by hand. Here's exactly what one involves
> and what it costs you — short version: a few minutes of setup, no
> infrastructure change, and you pay us nothing unless we verifiably save you
> money.
>
> **Setup (about five minutes).** You install MESH on your own machine with one
> command, then run `mesh start` if you use Claude Code, or `mesh proxy` and
> point your app's base URL at it. That's it — any language, any OpenAI- or
> Anthropic-compatible client. Step-by-step: [the tester guide]. Your API key
> is not stored; it passes straight through to your provider.
>
> **What runs for two weeks.** Normal traffic. MESH reduces each request before
> it reaches your provider (losslessly by default), and writes a local,
> tamper-evident ledger of usage numbers — never your prompts or responses.
> With a short kickoff before and a debrief after, the whole pilot is about
> four weeks.
>
> **How you're billed.** At the end we recompute, from your own ledger, the net
> amount MESH saved you, and the fee is **1% of that**, rounded down to the
> cent. If MESH saved you nothing, the invoice is **$0** — and you can check
> our number yourself with one command: `mesh statement --period YYYY-MM`
> recomputes a month from your own ledger. During the pilot any invoice is
> drafted,
> checked by a person and agreed with you before it is issued; nothing is ever
> charged automatically.
>
> If you'd like to run it as a pilot, reply "yes" and I'll send the one-pager
> and agree the dates with you.
>
> [founder]

---

## Part B — The pilot understanding (the terms, in plain language)

This sets out how a MESH pilot works between **[MESH operator]** ("we") and
**[partner]** ("you"). It is intentionally short.

It is optional. MESH is open to everyone, and you can install and use it
without agreeing to anything here; the website's
[Terms of use](../site/terms.md) cover that. Your "yes" to this understanding
is what starts a pilot: the measuring window and any invoice at the end of it.

### 1. Your API keys — we never hold them

MESH runs as a proxy **on your own machines**. Your provider API key passes
through to your provider (Anthropic, OpenAI, or an OpenAI-compatible host)
**verbatim**. We do not store, log, or transmit your keys. *(Enforced in
code: the proxy forwards your auth header untouched and holds no credential —
checked against a stand-in provider on 2026-11-07 and again on 2026-11-16, see
[VERIFICATION.md](./VERIFICATION.md).)*

### 2. Your prompts and responses — we never see them

MESH analyses requests **on your machine** to reduce them, and sends them to
your provider and nowhere else. It does not write prompt or completion
**content** to the ledger. There is no MESH telemetry endpoint and no hosted
MESH service in the request path. The one exception is yours to switch on:
request capture (`--capture <file>`), off by default, writes copies of your
own requests to a file you name on your own disk so that a proposed change can
be tested against your provider under your key.

### 3. What data is kept, and where

The only thing MESH records is a local, append-only, **hash-chained ledger** of
**usage numbers** per request: request/task ids, timestamps, provider, model,
token counts (as your provider reports them), price-catalogue hashes, dollar
figures, and the names of the reduction levers applied. **There is no field for
prompt or completion content.**

- **Where:** on **your** disk, in `~/.mesh/ledger/`. It never leaves your
  machine unless you send us a copy for billing.
- **Beside it:** files ending `.features.jsonl` hold counts and keyed hashes
  that MESH uses to tune itself. They contain no content, stay on your machine
  and are not needed for billing.
- **What we retain:** nothing structurally — all artifacts (ledger, invoice) live
  on your side. For billing you send us the ledger files (usage + hashes only); we
  keep those with the invoice as the audit trail.
- Full detail, sourced to the code paths that enforce it: [data-handling.md](./data-handling.md).

### 4. The fee — a share of *verified* savings, billed by hand

- The fee is **1% of net verified savings** for the billing period. "Verified"
  means recomputed from your own hash-chained ledger — a pure function you can
  run yourself with `mesh verify`, which makes no network calls. For a
  recompute that does not use the installed program at all, the MIT-licensed
  `@harrym1707/verify` package does the same on one ledger file at a time:
  `npx -y -p @harrym1707/verify mesh-verify ~/.mesh/ledger/proxy-anthropic.jsonl`.
- **One month at a time.** Billing runs by calendar month in UTC.
  `mesh statement --period YYYY-MM` (MESH 0.2.4 or later) recomputes one
  month from your ledger, prints the saving by lever, the fee and the
  verdict, and writes a statement file; you send us that file and the ledger
  files it was made from. `mesh verify` and `mesh-verify` give the total
  since install, not a month. An invoice is drafted only after its month has
  ended. [How a pilot window that is shorter than a month, or crosses a
  month end, is invoiced: founder to decide before this is sent.]
- **Rounding.** The fee is rounded down to the cent, so it is never more
  than 1% of the saving.
- **No savings → no charge.** If savings are zero or negative, if 1% of them
  comes to less than one cent, or if your stack was already optimised, the
  verdict is **`do_not_charge`** and the invoice is **$0**.
- The public explanation is the website's
  [Pricing and billing](../site/pricing.md) page.
- **If your recomputation disagrees with ours, yours wins.**
- During the pilot, **any invoice is drafted, checked by a person and agreed
  with you before it is issued.** Nothing is ever charged automatically.

### 5. No lock-in, no risk to your app

MESH sits in front of your provider and may reduce a request, but returns your
provider's response unchanged, and a failure in its metering never reaches
your request path. Stop any time: Ctrl+C in the MESH window (with `mesh start`,
Claude Code is put back as it was), or point your base URL back at your
provider.

### 6. What MESH changes on its own

By default only lossless levers are on. Theo, the part of MESH that studies
your traffic, stays at his default setting (`recommend`) for the whole pilot:
he proposes any change that alters what is sent and waits for your yes. We
will not ask you to switch on automatic adoption (`--autonomy optimise`)
during a pilot, and ask that you do not.

### 7. Term

The pilot runs for **[about 4 weeks]** from kickoff, of which **[14 days]** is
the measuring window, or until either side ends it with a short note. Either
party may stop at any time.

---

## Still needed before general availability (flagged honestly)

This document is a pilot stand-in, **not** production legal paper. Before MESH is
sold generally we still need:

- **Terms reviewed by counsel** and a proper **Data Processing Agreement
  (DPA)**. The website has carried [Terms of use](../site/terms.md) and a
  [Privacy policy](../site/privacy.md) since 12 November 2026; they are first
  drafts that no lawyer has reviewed, and there is no DPA. The current honest
  position is that MESH's architecture (no prompt data ingress, keys never
  held) makes most DPA questions moot — but that argument is not a signed DPA.
- **Security/compliance posture:** there is no SOC 2 / ISO certification yet
  (pre-revenue). Guarantees today are "code you can read," not an auditor's
  report.
- A liability, warranty, and indemnity position agreed for pilots. This
  document deliberately states none; the website Terms contain one, unreviewed.
  How this understanding and those Terms fit together is an open question for
  a lawyer.

Until those exist, treat this as a good-faith understanding between a founder and
a team in an early pilot, nothing more.
