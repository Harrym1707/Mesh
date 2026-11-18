# MESH pilot runbook (one page)

> **MESH is open to everyone:** no signup, no account, no waiting list. You
> can install and use it today without asking anyone
> ([Get started](../site/start.md)), and the day-0 quote below is free to run
> on its own. A pilot is optional: an agreed measuring window, hands-on help
> and an invoice checked by hand, for a team that wants them.
>
> Two parts. The first is what a team in a pilot does, day 0 to day 14. The
> second, the [Operator playbook](#operator-playbook--manual-billing), is the
> founder's side: onboarding a partner, collecting and checking their ledger,
> and drafting an invoice by hand. Setup follows the one path in
> [onboarding.md](./onboarding.md). Current release: MESH 0.2.3 (2026-11-18).
>
> **Draft.** Nothing here has been sent to anyone, and MESH has not yet run on
> a customer's real traffic.

**What MESH is.** A small program that runs on your own machine, between your
app (or Claude Code) and your AI provider. It removes tokens you were about to
pay for twice and writes one line per request into a hash-chained ledger that
you hold. The fee is 1% of *verified* savings: what you spent is taken from
your provider's own reported usage, the saving is recorded in that ledger, and
you can recompute the figure on your own machine. If MESH saves you nothing,
the verdict is **do_not_charge** and the invoice is $0.

**What the pilot costs you.** One install, one command, one base URL setting
(none for Claude Code), and two weeks of normal traffic. Your API key passes
through to your provider and is not stored. Your prompts and answers are not
written to the ledger and are not sent to us (see
[data-handling.md](./data-handling.md)).

**How long.** The measuring window on this page is 14 days. With kickoff
before it and the invoice and a debrief after it, a pilot is about four weeks
end to end ([PILOT_PLAN.md](./PILOT_PLAN.md)).

---

## Day 0 — the quote (optional, your machine, read-only)

For a team that already has a gateway. It needs no install and routes no
traffic.

1. Export spend logs from your gateway (LiteLLM `/spend/logs`, Helicone
   requests, or Langfuse generations — JSON).
2. `npx -y -p @harrym1707/sdk mesh-quote <export-file> --format litellm`
   (or `helicone`, `langfuse`). The tool reads the file locally and writes
   `quote.json`.
3. Read the quote: each traffic stream classified into a segment
   (consumer / app-layer / in-house-agent / already-optimised), an honest band
   per stream citing the measurement it is an analogue of, your own gateway and
   provider-cache savings **credited to you and excluded**, unpriced models
   reported as unpriced (never zeroed), and — when true — the explicit
   **"do not pay us"** answer.

If the quote says MESH is not worth it on your traffic, the pilot ends here and
that is the correct outcome.

## Day 1 — install and connect (about five minutes)

1. Install: `curl -fsSL https://www.mesh-technology.com/install.sh | sh`, then
   `mesh version`.
2. Connect: `mesh start` if you use Claude Code, or `mesh proxy` for your own
   app or agent, with your client's base URL set to the address it prints.
3. Check: `curl http://127.0.0.1:8787/mesh/health`, one request from your app,
   then `mesh verify`.

The [tester guide](./TESTER-GUIDE.md) has every step, what to expect and how
to remove it. Only lossless levers are on by default: the request your
provider receives means exactly what your app sent. A failure in the metering
never reaches your request path, and calls MESH does not reduce (embeddings,
token counting, model lists, batches, file uploads) are passed to your
provider untouched.

## Days 2–13 — measure

- Each request MESH reduces appends one line to the ledger in
  `~/.mesh/ledger/`: usage as your provider reported it, the levers applied
  and hashes. A failed request bills nothing. Savings you already had
  (provider caching you placed or got by default, gateway cache hits) are
  recorded and never billed.
- `mesh status` shows the running total; `mesh dashboard` opens a live page on
  your own machine.
- Theo, the part of MESH that studies your traffic, runs alongside at his
  default autonomy, `recommend`. He applies lossless levers himself. Anything
  that changes what is sent he puts to you as a proposal and waits for your
  yes. Leave him on `recommend`; do not switch on `--autonomy optimise` during
  a pilot.
- A lossy lever bills only with an approved replay-gate verdict on your own
  traffic. The gate replays a sample of your requests to your own provider
  under your key; the sample comes from request capture, which is off unless
  you turn it on.

## Day 14 — the invoice you can check

1. `mesh verify` re-checks the hash chain of your ledger and recomputes the
   figure, with no network calls. Tampering with any line is detected and the
   position named.
2. For a recompute that does not use the installed `mesh` at all, run the
   MIT-licensed tool on each ledger file:
   `npx -y -p @harrym1707/verify mesh-verify ~/.mesh/ledger/proxy-anthropic.jsonl`.
3. Negative components **net against MESH** (for example a 1-hour cache-write
   surcharge that never earned its reads); they are never clamped to zero.
4. Invoice = 1% of the net verified savings for the period, or
   **do_not_charge**. If your recomputation disagrees with ours, yours wins.

---

## What MESH never does in a pilot

- Never stores your prompts or answers in the ledger, and never sends them
  anywhere but the provider you chose.
- Never stores your API key.
- Never takes what you spent from its own counting: spend is your provider's
  reported usage. Where a lever's saving is an estimate of the tokens it
  removed, the ledger and the invoice line say `estimated-baseline`.
- Never claims savings your gateway or the provider's default caching already
  gave you.
- Never quotes a savings number without its LIVE or SIMULATOR label.

## What a pilot partner should expect, numerically

From [docs/NUMBERS.md](../NUMBERS.md) (last reconciled 2026-10-27), which is
the only source for MESH savings figures:

- **18.2% — LIVE.** Net saving on a mixed 30-request basket (coding, rag,
  support, batch, lean) on claude-sonnet-5-5, run 2026-10-26. This is MESH's
  own test basket against the real API, not a customer's traffic.
- **25–73% — SIMULATOR.** What the simulator models suggest depending on
  workload. Modelled on a harness and not yet proven on anyone's real bill.

**Your** number comes from your own ledger on day 14, and only that number is
ever billed. It may be small, or zero: on traffic that is already lean MESH
says `do not pay us`, and that is a real result.

---

# Operator playbook — manual billing

The founder's side of a pilot. For the first partners every invoice figure is
recomputed, checked by a person and created **only as a draft in Stripe test
mode**. Nothing is charged automatically, and no live Stripe key is used at
any step. This playbook stops at a reviewed test-mode draft: issuing a real
invoice or taking a payment is a separate decision for the founder and is not
set up or described here.

The commands were checked against `main` on 2026-11-16; what was run, and
what was only read, is in [VERIFICATION.md](./VERIFICATION.md).

## 0. One-time operator setup

- A Stripe account with a **test** secret key, stored outside the repository,
  for example `~/.config/mesh/stripe.env` containing
  `STRIPE_TEST_SECRET_KEY=sk_test_…`. Never put a key in a file in this
  repository.
- A local checkout built once: `corepack pnpm install && corepack pnpm build`
  (`mesh-bill` reads the compiled `packages/core/dist`).

## 1. Start a pilot

The team may already be using MESH; installing and using it needs nobody's
go-ahead. These steps are what turns that into a pilot.

1. Agree the kickoff points in [onboarding.md](./onboarding.md#what-to-agree-at-kickoff)
   and record them in [engagement-list.md](./engagement-list.md): which
   command (`mesh start` or `mesh proxy`), the 14-day window, and that the
   ledger is in `~/.mesh/ledger/` on their machine.
2. Send the pilot agreement and onboarding email
   ([pilot-agreement.md](./pilot-agreement.md)) and get a plain-text "yes" back
   before the measuring window starts and before any invoice is drafted. The
   yes is for the pilot, not for using MESH. Sending is the founder's act.
3. Create their Stripe **customer** in test mode and note the `cus_…` id. No
   payment method is needed to create and review a draft.

## 2. Collect and verify their ledger

The partner's ledger is the set of hash-chained files in `~/.mesh/ledger/` on
their machine, one per application and provider (`proxy-anthropic.jsonl`,
`proxy-openai.jsonl`). Ask them to run `mesh verify` and `mesh status` and
send the output, then the ledger files themselves. The ledger holds usage
numbers and hashes and no prompt text; see [data-handling.md](./data-handling.md).

**Leave the `.features.jsonl` files out.** They sit in the same folder, are
not part of the ledger, and are not needed for billing. Both tools below read
one of them as a broken chain.

**Verify the chain before you look at the number.** `mesh-verify` is the
MIT-licensed, zero-dependency recompute tool; it reads one file per run:

```bash
for f in ./their-ledger/*.jsonl; do
  case "$f" in *.features.jsonl) continue ;; esac
  npx -y -p @harrym1707/verify mesh-verify "$f" || break
done
```

For each file it prints `chain verified: N record(s), every hash links` and
the recomputed invoice. If it reports a broken chain on a ledger file,
**stop**: do not bill a ledger that does not verify. (`mesh-bill` enforces
this too, below, but check it first.)

A partner on the no-install npm proxy has their ledger in `./mesh-ledger/`
instead ([onboarding.md](./onboarding.md#no-install-alternative-the-proxy-from-npm));
the files and the check are the same.

## 3. Draft the invoice (test mode: draft, then review)

`mesh-bill` recomputes one invoice across the ledger files you pass,
re-verifies each chain, and creates a Stripe **draft**. It does not charge.

```bash
source ~/.config/mesh/stripe.env    # exports STRIPE_TEST_SECRET_KEY
node --import tsx scripts/mesh-bill.ts \
  --customer cus_THEIR_ID \
  --period 2026-11 \
  --fee 1 \
  --label "partner-name" \
  ./their-ledger/proxy-anthropic.jsonl ./their-ledger/proxy-openai.jsonl
```

Pass each ledger file by name; a `*.jsonl` wildcard would pick up the
`.features.jsonl` files too. Read the output before doing anything else:

```
Mode: TEST  ·  period: 2026-11  ·  fee: 1%
Net verified savings: $<X>  ·  verdict: <charge | do_not_charge>
Will create (draft=true): <N> usd cents to cus_THEIR_ID
```

**The honesty checks — respect every one:**

- **`verdict: do_not_charge`** (no net saving, a deficit carried forward from
  an earlier period, or a fee that rounds below one cent) → `mesh-bill` prints
  `DO NOT BILL` and creates nothing. The invoice is
  **$0**. This is a correct, expected outcome; tell the partner so plainly.
- **`CHAIN BROKEN` (exit 1)** → a file failed verification. Do not bill. Check
  that no `.features.jsonl` file was passed, then go back to the partner for a
  clean copy.
- **`Mode:` must read `TEST`.** `mesh-bill` refuses a `sk_live_…` key unless
  `--live` is passed. Never pass `--live` and never use a live key in a pilot.
- Leave `--finalize` off. Without it the invoice stays a draft.
- Re-running the same customer, period and amount is idempotent at Stripe.

If the verdict is `charge`, the draft now exists in the **Stripe test
dashboard**. Review it there and compare the amount with the partner's own
`mesh verify` output and your `mesh-verify` runs. What the partner is then
sent, and how they pay, is agreed with them by hand.

## 4. After the draft

- Record the draft's id, the net verified savings figure and the verdict in
  [engagement-list.md](./engagement-list.md).
- Keep the partner's ledger files: the invoice is a pure function of them, so
  "run it yourself" is always the dispute path.
- If a partner disputes the figure, the resolution is their own recompute on
  their own ledger. If it disagrees with ours, **theirs wins**.

## Manual-billing guardrails (do not remove)

- Test mode only; live keys are refused without `--live`, and `--live` is not
  used.
- A broken or unverified chain is a hard stop.
- No prompt content is read or sent — only usage-derived totals.
- No automatic charge of any kind during the pilot. Draft, then a person
  reviews it, every time.
