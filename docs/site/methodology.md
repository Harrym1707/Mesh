# How Mesh measures and verifies LLM API savings

Mesh is a local proxy for LLM API traffic that records each saving in a
ledger on your own machine. This page sets out the rules a figure must pass
before Mesh publishes it, and the rules a saving must pass before it can
appear on an invoice.

Last updated: 2026-11-24.

## What a fresh install does today

Out of the box Mesh makes three lossless changes: tool-schema compaction,
exact-duplicate removal and cache-prefix repair. On Mesh's own 30-request test
basket (LIVE, run 2026-10-26, not a customer's traffic) those three account
for under half of the 18.2% recorded; the rest came from a 5-minute Anthropic
cache stamp and a gate-approved cap on oversized tool results, both off by
default. A Claude Code user gains little on the defaults. The larger figures
on this site needed levers that you or Theo switch on:
[how to switch them on](start.md), [which levers each figure needed](evidence.md).

## Why the method matters

The LLM cost-saving market has a measurement problem, documented by
independent work rather than by Mesh: three popular open-source token trimmers
claiming 60–90% savings delivered **3.7%** when independently replayed over
614M tokens of real traffic; a prompt-slimming technique modelled at ~77%
measured **~13%** in production. The gap comes from measuring per *request*
instead of per *completed task*, and from ignoring provider cache economics.
Removing tokens is not the same as lowering a bill, and Mesh does not claim
that it is: no measurement of Mesh on a customer's provider bill exists yet.

## The rules every published figure passes

1. **Labelled, dated, and with its levers.** Every figure says whether it is
   LIVE (real API calls on a test basket Mesh wrote) or SIMULATOR (modelled on
   a harness), the date it was measured, and whether it is what a fresh
   install gives or which levers were switched on.
2. **Per completed task, not per request.** A technique that shrinks each
   prompt but multiplies round trips has saved nothing. The harness runs
   multi-turn tasks end to end and prices the whole task.
3. **Quality held, measured.** A claimed arm must keep at least 36 of 40 tasks
   fully correct and complete. A changed tool call is a hard failure; a
   shortened answer is scored by degree.
4. **Provider cache rules simulated faithfully**: minimum cacheable prefix,
   longest-exact-prefix matching, hit granularity, time-to-live expiry, and
   write premiums. The simulator can and does show caching as a **net loss**
   on unfavourable traffic; that case has a unit test.
5. **The provider's existing contribution is never claimed.** On busy agent
   traffic, the provider's cache alone saves 35–40% on the harness before Mesh
   does anything (SIMULATOR, harness re-run 2026-11-24). That figure is printed separately and excluded
   from every Mesh claim.
6. **Tier savings are billed at the tier actually served.** Discounted-tier
   requests can be bounced back to full price under load; the published async
   figure of 57.7% net (SIMULATOR, verified 2026-10-13; needed the J lever
   stack plus the flex tier, which a fresh install does not switch on) is net
   of assumed fallback rates, and per-request billing reads the service tier
   from the provider's response, not from the request.
7. **Lossy levers pass a replay gate first.** Changes that could affect
   answers (description trimming, output caps, tool-result capping) are
   enabled only after replaying your recorded requests both ways. The gate has
   rejected Mesh's own levers; those rejections are documented.
8. **Unpriced means excluded, never zero.** A model or billing date the price
   catalogue cannot price is excluded from baselines and invoices, with the
   reason stated. The catalogue is dated and source-linked; a price change
   never silently reprices history.

## How a saving is verified

Each saving is the difference between two costs for the same request.

- **What you paid** is the usage your provider reported for that request,
  priced at the provider's published rate for that day.
- **What you would have paid** is worked out by Mesh from the tokens it
  removed before sending, priced at the same rate. The ledger marks these
  rows `estimated-baseline`, because the request that was not sent has no
  provider reading. Savings from the lossless levers are recorded this way.
- Where a saving can be read directly from the provider's own figures, such
  as a cheaper processing tier, the row is marked measured.

Every request emits an append-only, hash-chained event carrying the
provider's usage, the catalogue version, the levers applied and any gate
verdict references. `recomputeInvoice(events)` is a pure function: run it
yourself, or run `mesh verify`, and you must get the same number.

## What SIMULATOR means, and what it does not

The SIMULATOR figures come from a 40-task, 5-turn agent harness (plus
one-shot variants) with multi-kilobyte tool results. They are measurements
**of the simulation**, with named levers switched on; they are not
measurements of a fresh install and not measurements of your traffic. The
only way to get that number is to run Mesh on your own requests and read the
ledger on your machine.

Known open items: per-model cacheable minimums are not yet in the simulator,
so the sparse-traffic 34.3% (SIMULATOR, verified 2026-10-22; needed the J
stack plus the 1-hour cache stamp, off by default) may overstate on some
models. The 18.2% (LIVE, run 2026-10-26 with a cache stamp and a tool-result
cap switched on) was measured before a correction of 2026-10-29 to how
tool-schema compaction is measured; the detail is on the
[evidence](evidence.md) page.
