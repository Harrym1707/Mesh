# Mesh pricing: 1% of verified savings on your LLM API bill

The fee is 1% of verified savings for the month, rounded down to the cent, and nothing else; no fee is due unless billing has been agreed in writing.

Mesh is a local proxy for LLM API traffic, for teams running their own agents
on the Anthropic or OpenAI API. Installing and running it is free and needs
no account. There is no subscription, no seat price, no minimum and no setup
fee, and a fee exists only for months in which Mesh recorded a net saving.

Last updated: 2026-11-24.

## What it costs

The fee is 1% of the net verified savings in a calendar month. You keep the
other 99%.

These rows are arithmetic to show the scale of the fee, not results:

| Your monthly LLM spend | If the ledger showed 10% saved | If it showed 20% | If it showed 40% |
|---|---|---|---|
| $10,000 | fee $10 | fee $20 | fee $40 |
| $100,000 | fee $100 | fee $200 | fee $400 |
| $1,000,000 | fee $1,000 | fee $2,000 | fee $4,000 |

The percentages in that table are examples chosen to show the arithmetic.
They are not measurements and not a forecast. What a fresh install does
today: three lossless changes (tool-schema compaction, exact-duplicate
removal, cache-prefix repair). On Mesh's own 30-request test basket (LIVE,
run 2026-10-26, not a customer's traffic) those three account for under half
of the 18.2% recorded; the rest came from a 5-minute Anthropic cache stamp
and a gate-approved cap on oversized tool results, both off by default. A
Claude Code user gains little on the defaults, and Mesh has not yet been
measured on a customer's provider bill. The larger figures, each with its
label, date and the levers it needed, are on
[Savings by shape](segments.md) and [Evidence](evidence.md);
[Get started](start.md) says how to switch levers on. Some setups save
nothing, and then the fee is nothing.

## When nothing is due

- **You have not agreed billing with us.** Use Mesh as long as you like.
- **The month's verdict is `do_not_charge`.** That is the outcome when net
  savings are zero or negative, or when 1% of them comes to less than one
  cent.
- **The saving was already yours.** Savings from caching you had switched on
  yourself, at your provider or your gateway, are itemised and left out.
- **The work failed.** Savings on a task that did not complete are not
  counted.
- **We could not price it.** A request on a model or date that is not in the
  published price list is excluded. It is never counted as a saving.

A lever that cost you money in a month is set against the ones that saved you
money in that month. Our losses reduce the fee; they are not hidden.

The fee is rounded down to the cent, so it is never more than 1%.

## How to start paying

- **Try it first.** Run Mesh on your own traffic and look at the result:
  `mesh status` for the running total, `mesh verify` to re-check the ledger.
- **Tell us.** If the saving is worth having,
  [open an issue](https://github.com/Harrym1707/Mesh/issues/new) with the
  title "Billing". Please do not post your figures or your ledger in a public
  issue; we reply with a private way to continue.
- **Agree it in writing.** We settle who the customer is, the billing month,
  the currency, and where invoices go. Until that exists, no fee is due.
- **Register your statement key.** On the machine where Mesh runs, run
  `mesh statement --key` and send us the fingerprint it prints, once, in the
  same written channel. It is public and safe to share; the private half never
  leaves your machine. We only bill from statements signed by that key, so
  nobody else, including us, can produce a statement in your name. If you
  reinstall Mesh or move machine, the fingerprint changes: register the new
  one the same way before your next statement.

## What happens each month

After the month ends, you run one command on the machine whose key you
registered (Mesh 0.2.5 or later):

```bash
mesh statement --period 2026-11
```

It re-checks your ledger's hash chain, recomputes the month, prints the
savings by lever and the fee, and writes a statement file signed by your
install's key. If you run Mesh on several machines, bring all their ledger
files to the registered machine and run it there over all of them. Then:

- **You send us the statement file and the ledger files it was made from.**
  They hold usage numbers, lever names, model names and hashes. They never
  hold your prompts, your answers or your API key. Open them and look before
  you send them.
- **We recompute the same figure from the same ledger** and send you a
  statement and an invoice. We do not take payment automatically.
- **If your number and ours differ for the same ledger, yours wins.**

The billing month is the calendar month in UTC: a request counts in the month
it started in. `mesh verify` and `mesh status` show the total since you
installed Mesh, not one month; the month's figure is the one on the statement.

## What "verified" means

Each saving is the difference between two costs for the same request.

- **What you paid** comes from the usage your provider reported back for that
  request, priced at the provider's published rate for that day.
- **What you would have paid** is worked out by Mesh: the tokens it removed
  from the request before sending it, priced at the same rate. On the
  statement these rows are labelled *estimated baseline*, because the request
  that was not sent has no provider reading.
- Where a saving can be read directly from the provider's own figures, such as
  a cheaper processing tier, its row is labelled *measured*.

The rules are published in full in the [methodology](methodology.md). The
ledger, the price list and the arithmetic are all on your machine, so you can
check every line without trusting us.

## Currency and tax

Figures are computed in US dollars, the currency the providers price in. The
invoice currency is set in the billing agreement. Fees exclude VAT and similar
taxes, which are added where they apply.

## If you disagree with an invoice

Recompute it. `mesh statement --check <file>` tells you whether a statement
file has been altered since it was written and whether its signature verifies,
and `mesh statement --period`
rebuilds the month from your ledger. If the figures do not match ours, send us
yours and we use it. The contract terms are in the [Terms](terms.md).
