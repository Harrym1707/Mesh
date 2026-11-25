# Mesh: a local proxy for LLM API traffic, with a bill you can recompute

Mesh is a local proxy for LLM API traffic, for teams running their own agents on the Anthropic or OpenAI API: out of the box it makes three lossless changes to each request and records every saving in a hash-chained ledger on your own machine, so you can recompute the bill yourself.

The fee is 1% of verified savings for the month, rounded down to the cent, and nothing else; no fee is due unless billing has been agreed in writing.

## What a fresh install does today

Out of the box Mesh makes three lossless changes to a request before it
forwards it:

- **Tool-schema compaction.** Removes schema keys the model never reads. The
  schema decodes to the same tools.
- **Exact-duplicate removal.** Removes a block of context that appears twice,
  byte for byte.
- **Cache-prefix repair.** Moves a value that changes on every request (a
  timestamp, a request id) out of the part of the prompt a provider cache can
  reuse. Nothing is deleted.

On Mesh's own 30-request test basket (LIVE, run 2026-10-26, not a customer's
traffic) those three account for under half of the 18.2% recorded; the rest
came from two levers that are off by default, a 5-minute Anthropic cache stamp
and a gate-approved cap on oversized tool results. A Claude Code user gains
little on the defaults. Mesh has no customers yet, so no figure on this site
is a measurement of a real provider bill.

Every larger figure below needed levers that you or Theo switch on.
[How to switch them on](start.md) · [which levers each figure needed](evidence.md)

## The figures, by traffic shape, and what each one needed

"SIMULATOR" means modelled on a harness at the providers' published prices,
per completed task, with at least 36 of 40 tasks fully correct. "LIVE" means
real API calls on a test basket Mesh wrote. The "J stack" is tool-description
trimming, exact-duplicate removal, cache-prefix repair, a cap on oversized
tool results, stale-history compaction and an output cap; four of those six
are off in a fresh install. [How these numbers are made](methodology.md)

| Your traffic looks like | Figure | Label and date | Levers it needed |
|---|---:|---|---|
| A mixed basket of five test agents | **18.2%** of real spend | LIVE, run 2026-10-26, Mesh's own test basket | The three defaults plus a 5-minute cache stamp and a gate-approved tool-result cap, both off by default. The defaults account for under half |
| Multi-turn Claude agents that place no cache breakpoints | **37.9%** | SIMULATOR, verified 2026-10-22 | The 5-minute Anthropic cache stamp alone, off by default, measured on top of the J stack in both arms |
| The same, full stack against a raw uncached baseline | **57.3%** lower simulated cost, 5 points lower clean-task quality | SIMULATOR, verified 2026-10-22 | The J stack plus the cache stamp. Fails the agreed quality limit; not a qualified saving |
| Background or batch work that can wait | **57.7%** net (64.3% ceiling) | SIMULATOR, verified 2026-10-13 | The J stack plus the provider's discounted flex tier, none of it on by default; net of assumed fallback rates |
| One-shot calls on a shared template | **45.5%**, up to **72.8%** where the work can wait | SIMULATOR, verified 2026-10-13 | Cache-prefix repair, which is on by default and carries most of the 45.5% on a provider that caches automatically, plus description trimming, history compaction and an output cap; the 72.8% adds the flex tier |
| Interactive agents, sparse traffic | **34.3%** | SIMULATOR, verified 2026-10-22 | The J stack plus the 1-hour Anthropic cache stamp; the stamp and four of the J levers are off by default; may overstate on some models |
| Interactive agents, busy traffic | **25.9–29.4%** | SIMULATOR, verified 2026-10-13 | The J stack. The three defaults alone move this simulated bill very little |
| Stacks that are already optimised | **0–5%: do not pay us** | SIMULATOR, fixture, 2026-10-11 | None. Mesh says so and no fee is due |

Savings depend on the shape of your traffic and on which levers are switched
on. The only way to know yours is to run Mesh on your own requests and read
the ledger; `mesh verify` recomputes it with no network calls.

## How it works

Mesh sits between your app and your provider on your own machine. A fresh
install makes the three lossless changes above and nothing else. The levers
that are off by default do more and need a decision from you:

- **Cache stamp.** Anthropic's prompt cache is opt-in. Where a client places
  no cache breakpoints, Mesh can place one on the stable part of the prompt,
  and it withholds the stamp where the prefix changes between turns or is
  under the provider's minimum. Off by default.
- **Tool-result cap, description trimming, history compaction, output
  limits.** These can change an answer, so Mesh treats them as lossy: each
  stays off until a replay of your own recorded requests shows quality held.
- **Discounted tiers.** For work you flag as able to wait, the provider's own
  cheaper tier. Off by default.

Theo, the agent that runs beside the proxy, can prove and propose three of
the lossy levers on your own traffic, and waits for your yes.

## Why you can check the number on your invoice

- What you paid is the **usage your provider reported**, priced at its
  published rate. What you would have paid is worked out by Mesh from the
  tokens it removed, and those rows are labelled *estimated baseline* on the
  statement.
- Every request writes a **hash-chained ledger event** on your machine; the
  invoice is a pure function over those events that **you can recompute
  yourself**, to the cent.
- Savings you already had, from your provider's cache or your gateway's, are
  itemised and **never billed**.
- A lever that lost money in a month **counts against the fee**.

[Methodology](methodology.md) · [Per-shape detail](segments.md) ·
[Comparison with alternatives](comparison.md) · [FAQ](faq.md) ·
[Evidence for every figure](evidence.md) · [Pricing](pricing.md)
