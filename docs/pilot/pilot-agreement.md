# Pilot agreement + onboarding email (draft)

> **Draft material.** Nothing here has been sent. Sending is the founder's act,
> not an agent's. This is a deliberately minimal, plain-language understanding
> for **design partners only** — see "Still needed before general availability"
> at the end. Have a lawyer review before relying on it beyond a pilot.

---

## Part A — Onboarding email (copy/paste, fill the brackets)

> **Subject: MESH pilot — cut your LLM bill, pay only a share of what we verifiably save**
>
> Hi [name],
>
> Thanks for trying MESH. Here's exactly what a pilot involves and what it costs
> you — short version: a few minutes of setup, no infrastructure change, and you
> pay us nothing unless we verifiably save you money.
>
> **Setup (about five minutes).** You run one local command that starts a MESH
> proxy on your own machine, and point your app's base URL at it. That's it —
> any language, any OpenAI- or Anthropic-compatible client. Step-by-step:
> [onboarding.md]. Your API key never leaves your process; it passes straight
> through to your provider.
>
> **What runs for ~2 weeks.** Normal traffic. MESH reduces each request before it
> reaches your provider (losslessly by default), and writes a local, tamper-
> evident ledger of usage numbers — never your prompts or responses.
>
> **How you're billed.** At the end we recompute, from your own ledger, the net
> amount MESH saved you, and bill **1% of that**. If MESH saved you nothing, the
> invoice is **$0** — and you can recompute our number yourself to the cent with
> a tiny open-source tool. During the pilot every invoice is a draft we review by
> hand and send you as an invoice; nothing is ever auto-charged.
>
> If that's fair, reply "yes" and I'll send the one-pager to get you started.
>
> [founder]

---

## Part B — The pilot understanding (the terms, in plain language)

This sets out how a MESH pilot works between **[MESH operator]** ("we") and
**[partner]** ("you"). It is intentionally short.

### 1. Your API keys — we never hold them

MESH runs as a proxy **on your own machines**. Your provider API key passes
through to your provider (Anthropic, OpenAI, or an OpenAI-compatible host)
**verbatim**. We do not read, store, log, or transmit your keys. *(Enforced in
code: the proxy forwards your auth header untouched and holds no credential —
verified 2026-11-07, see [VERIFICATION.md].)*

### 2. Your prompts and responses — we never see them

MESH analyses requests **in your process** to reduce them, and never writes
prompt or completion **content** anywhere. There is no MESH telemetry endpoint
and no hosted service in the request path.

### 3. What data is kept, and where

The only thing MESH records is a local, append-only, **hash-chained ledger** of
**usage numbers** per request: request/task ids, timestamps, provider, model,
token counts (as your provider reports them), price-catalogue hashes, dollar
figures, and the names of the reduction levers applied. **There is no field for
prompt or completion content.**

- **Where:** on **your** disk — `./mesh-ledger/` (proxy mode) or `~/.mesh/ledger`
  (the Claude Code launcher). You choose; it never leaves your machine unless you
  send us a copy for billing.
- **What we retain:** nothing structurally — all artifacts (ledger, invoice) live
  on your side. For billing you send us ledger spools (usage + hashes only); we
  keep those with the invoice as the audit trail.
- Full detail, sourced to the code paths that enforce it: [data-handling.md].

### 4. The fee — a share of *verified* savings, billed by hand

- The fee is **1% of net verified savings** for the billing period. "Verified"
  means recomputed from your own hash-chained ledger — a pure function you can
  run yourself (`npx -y -p @harrym1707/verify mesh-verify <your spools>`).
- **No savings → no charge.** If savings are zero, negative, below a cent of fee,
  or your stack was already optimised, the verdict is **`do_not_charge`** and the
  invoice is **$0**.
- **If your recomputation disagrees with ours, yours wins.**
- During the pilot, **every invoice is created as a draft, reviewed by a human,
  and sent to you as an invoice** — never an automatic direct-debit pull.

### 5. No lock-in, no risk to your app

MESH sits in front of your provider and may reduce a request, but returns your
provider's response unchanged, and a failure in MESH never breaks your request
path. Stop any time by pointing your base URL back at your provider.

### 6. Term

The pilot runs for **[~4 weeks]** from setup, or until either side ends it with a
short note. Either party may stop at any time.

---

## Still needed before general availability (flagged honestly)

This document is a pilot stand-in, **not** production legal paper. Before MESH is
sold generally we still need:

- **Real Terms of Service** and a proper **Data Processing Agreement (DPA)**,
  reviewed by counsel. The current honest position is that MESH's architecture
  (no prompt data ingress, keys never held) makes most DPA questions moot — but
  that argument is not a signed DPA.
- **Security/compliance posture:** there is no SOC 2 / ISO certification yet
  (pre-revenue). Guarantees today are "code you can read," not an auditor's
  report.
- A defined liability, warranty, and indemnity position (deliberately omitted
  here to keep the pilot light).

Until those exist, treat this as a good-faith understanding between a founder and
an early design partner, nothing more.
