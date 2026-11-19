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
> [onboarding.md](./onboarding.md). Current release: MESH 0.2.4 (2026-11-19).
> The fee and the monthly routine are explained for everyone on the
> website's [Pricing and billing](../site/pricing.md) page.
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
- `mesh status` shows the running total since your ledger began;
  `mesh dashboard` opens a live page on your own machine.
- Theo, the part of MESH that studies your traffic, runs alongside at his
  default autonomy, `recommend`. He applies lossless levers himself. Anything
  that changes what is sent he puts to you as a proposal and waits for your
  yes. Leave him on `recommend`; do not switch on `--autonomy optimise` during
  a pilot.
- A lossy lever bills only with an approved replay-gate verdict on your own
  traffic. The gate replays a sample of your requests to your own provider
  under your key; the sample comes from request capture, which is off unless
  you turn it on.

## Day 14 — the figure you can check

1. `mesh statement --period YYYY-MM` recomputes one calendar month (UTC) from
   your own ledger. It re-checks the hash chain, prints the saving by lever,
   the fee and the verdict, and writes a statement file,
   `mesh-statement-YYYY-MM.json`. No network calls. It needs MESH 0.2.4 or
   later.
2. `mesh verify` re-checks the whole ledger and gives the total since
   install, not a month. Tampering with any line is detected and the position
   named. For a recompute that does not use the installed `mesh` at all, run
   the MIT-licensed tool on each ledger file:
   `npx -y -p @harrym1707/verify mesh-verify ~/.mesh/ledger/proxy-anthropic.jsonl`.
3. Negative components **net against MESH** (for example a 1-hour cache-write
   surcharge that never earned its reads); they are never clamped to zero.
4. Invoice = 1% of the net verified savings for the month, rounded down to
   the cent, or **do_not_charge** when that comes to less than one cent. The
   fee is never more than 1% of the saving. If your recomputation disagrees
   with ours, yours wins.
5. An invoice is drafted only after its month has ended: you run
   `mesh statement` again then, and send the statement file and the ledger
   files it was made from. Until then the statement says the period has not
   ended and its figures can still change.

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

**The procedure for drafting an invoice is Product's
[first-invoice runbook](../ops/first-invoice-runbook.md).** Follow it step by
step; this playbook covers only what a pilot adds before and after it, and
does not repeat its commands beyond the dry run. What was run for this kit,
and what was only read, is in [VERIFICATION.md](./VERIFICATION.md).

## 0. One-time operator setup

- A Stripe account with a **test** secret key, held by the founder and
  stored outside the repository. Never put a key in a file in this
  repository. The dry run in step 3 needs no key at all.
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
   payment method is needed to create and review a draft. This is the
   founder's step.

## 2. After the month has ended: ask for the statement and the ledger

Billing runs by calendar month in UTC, and `mesh-bill` refuses a month that
has not ended. So the invoice for a pilot waits for the end of the month the
window falls in. How a window that crosses a month end is invoiced is not
decided.

Ask the partner for three things (first-invoice runbook, step 1):

1. **The statement file.** They run `mesh statement --period YYYY-MM` on the
   machine MESH runs on, after the month has ended. It writes
   `mesh-statement-YYYY-MM.json`. It needs 0.2.4 or later; if `mesh version`
   prints 0.2.3 or earlier, they update first (`mesh update`).
2. **The ledger files:** every `<application>-<provider>.jsonl` in
   `~/.mesh/ledger/` (`proxy-anthropic.jsonl`, `proxy-openai.jsonl`). The
   `.features.jsonl` files beside them are not needed.
3. **What `mesh verify` prints.**

None of these holds prompts, answers or keys; see
[data-handling.md](./data-handling.md). Never produce the statement yourself
from the files you received: it must be the partner's own.

For an independent check of each ledger file, `mesh-verify` is the
MIT-licensed, zero-dependency recompute tool. It reads one file per run and
totals the whole file, and it reads a `.features.jsonl` file as a broken
chain, so skip those:

```bash
for f in ./their-ledger/*.jsonl; do
  case "$f" in *.features.jsonl) continue ;; esac
  npx -y -p @harrym1707/verify mesh-verify "$f" || break
done
```

A partner on the no-install npm proxy has their ledger in `./mesh-ledger/`
instead ([onboarding.md](./onboarding.md#no-install-alternative-the-proxy-from-npm))
and has no `mesh statement`; they need the installed `mesh` before they can
be invoiced.

## 3. Dry run first, every time

`--dry-run` reads no Stripe key and sends nothing. It verifies each chain,
recomputes the month, checks the partner's statement against the ledger files
and against its own recompute, and prints exactly what would be created.

```bash
node --import tsx scripts/mesh-bill.ts --dry-run \
  --customer cus_THEIR_ID \
  --period 2026-11 \
  --fee 1 \
  --statement ./received/mesh-statement-2026-11.json \
  ./received/proxy-anthropic.jsonl ./received/proxy-openai.jsonl
```

Read the output before doing anything else:

```
Mode: DRY RUN (no Stripe key read, nothing sent)  ·  period: 2026-11  ·  fee: 1%  ·  spools read: <N>
Events in period: <N>  ·  billed: <N>  ·  marked unpriced: <N>
Net verified savings: $<X>
Statement: statement matched: <N> spools, <N> records (<N> in 2026-11), net verified savings $<X>, fee <N> cents.
```

**The honesty checks — respect every one:**

- **`DO NOT BILL — do_not_charge`** (no net saving, or 1% of it below one
  cent) → nothing is created, not even a zero-value draft. The invoice is
  **$0**. This is a correct, expected outcome; tell the partner so plainly.
- **`DO NOT BILL`, statement and ledger disagree** → the files passed are not
  the ones the statement was made from, or the figures differ. Do not work
  around it; go back to the partner.
- **`CHAIN BROKEN`** → a file failed verification. Do not bill, and do not
  "fix" a file; ask the partner to send it again.
- **`--period` is required,** and a real run refuses a month that has not
  ended. There is no flag to override the clock.
- **The fee is rounded down to the cent,** so it is never more than 1% of
  the saving.

## 4. The draft is the founder's step

Creating the Stripe draft needs the Stripe **test** key, which only the
founder handles: first-invoice runbook, step 9 onward, including its check
that the period has not been billed already and its by-hand step for a
deficit carried from an earlier month. The draft is a send-an-invoice draft;
nothing is collected automatically. Leave `--finalize` off, never pass
`--live`, and never use a live key in a pilot.

What the partner is then sent, and how they pay, is agreed with them by hand.

## 5. Afterwards

- Record the draft's id, the net verified savings figure and the verdict in
  [engagement-list.md](./engagement-list.md).
- Keep the partner's statement and ledger files, unchanged: the invoice is a
  pure function of them, so "run it yourself" is always the dispute path.
- If a partner disputes the figure, the resolution is their own
  `mesh statement` on their own ledger. If it disagrees with ours, **theirs
  wins**.

## Manual-billing guardrails (do not remove)

- Test mode only; `--live` is not used, and no assistant handles a Stripe
  key.
- A broken or unverified chain is a hard stop. So is a statement that does
  not match the ledger files.
- No prompt content is read or sent — only usage-derived totals.
- No automatic charge of any kind during the pilot. Dry run, then a draft,
  then a person reviews it, every time.
