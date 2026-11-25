# Mesh FAQ: what the local LLM proxy does, what it saves and what it costs

Mesh is a local proxy for LLM API traffic, for teams running their own agents
on the Anthropic or OpenAI API. The fee is 1% of verified savings for the month, rounded down to the cent, and nothing else; no fee is due unless billing has been agreed in writing.

The answers below say what a fresh install does and what each published
figure needed.

## How much does Mesh save out of the box?

A fresh install makes three lossless changes: tool-schema compaction,
exact-duplicate removal and cache-prefix repair. On Mesh's own 30-request test
basket (LIVE, run 2026-10-26, not a customer's traffic) those three account
for under half of the 18.2% recorded; the rest came from a 5-minute Anthropic
cache stamp and a gate-approved cap on oversized tool results, both off by
default. A Claude Code user gains little on the defaults. Mesh has no
customers yet, so there is no measurement on a real provider bill. The larger
figures on this site are SIMULATOR figures that needed levers you or Theo
switch on; [Evidence](evidence.md) lists the levers behind each one.

## How do I switch on more than the defaults?

Three routes, all on your own machine. Theo, the agent that runs beside the
proxy, can prove three lossy levers on your own recorded requests (tool
description trimming, stale-history compaction, lower output effort) and
propose them; you accept with `mesh theo --accept <lever>`. He needs a capture
of your requests and a provider key to replay them, both opt-in. The
Anthropic cache stamp is not something Theo proposes today: you add it to the
levers list in `~/.mesh/theo-policy.json`. The SDK takes the same levers as
options. The steps are on [Get started](start.md).

## How do I install Mesh?

One command: `curl -fsSL https://www.mesh-technology.com/install.sh | sh`
(macOS, Linux or WSL; or `npm install -g @harrym1707/mesh`). Then `mesh proxy`
for your own app or agent, or `mesh start` if you use Claude Code. It starts a
local proxy with a hash-chained ledger, and you set your client's base URL to
`http://127.0.0.1:8787` (Anthropic) or `http://127.0.0.1:8787/v1` (OpenAI).
It is open to everyone: no signup, no account, no waiting list, and your API
key passes through without being stored. The full walk-through, including
recomputing the invoice yourself with `mesh verify`, is on
[Get started](start.md). To run the proxy without installing anything, use
`npx -y -p @harrym1707/sdk mesh-proxy`.

## Does Mesh work with my language or framework?

Yes, if it can set a base URL: Python, TypeScript, Go, curl, LangChain,
LlamaIndex and most others. Proxy mode does not depend on the language. The
one-line SDK mode (`withMesh(client)`) is TypeScript and JavaScript today.
Mesh covers Claude (Anthropic), OpenAI and any OpenAI-compatible endpoint.

## Does Mesh help Claude Code users?

It works with Claude Code: `mesh start` points Claude Code at the proxy and
puts it back when you stop. A Claude Code user gains little on the defaults,
because Claude Code already places its own cache breakpoints and its built-in
tools leave the three default changes little to remove. Mesh is aimed at
teams that call the API from their own agents.

## What does Mesh do for agents that run all the time?

Long-lived agents re-send their whole history every turn. Out of the box Mesh
removes exact duplicates, repairs the cache prefix and compacts tool schemas.
Switched on by you, it can also place a guarded cache stamp where the client
places none, and, once a replay of your own requests has approved them,
digest stale history and cap oversized tool results. The figures for these
shapes are SIMULATOR figures with those levers on; see
[savings by shape](segments.md).

## Can Mesh break my app?

The default levers are lossless: compacted schemas decode identically, removed
duplicates are exact, prefix repair reorders text without deleting it, and the
reducer never throws: any failure returns your request untouched. Lossy levers
(output caps, description trimming, tool-result capping) are off until a
replay gate proves on your own recorded requests that quality held.

## Why does Mesh quote a range and not one number?

Because savings depend on the shape of your traffic and on which levers are
switched on. A quote comes from your own export and names your shape; a vendor
quoting everyone one number is wrong for most of them. Sometimes the verdict
is `doNotPayUs`.

## Is the async figure real?

It is 57.7% net (SIMULATOR, verified 2026-10-13; needed the J lever stack, defined on the [evidence](evidence.md) page, plus
the provider's discounted flex tier, which a fresh install does not switch
on). It is a measurement of a simulation at the providers' published prices,
net of assumed fallback rates, with 38 of 40 tasks clean. It is not a
measurement of anyone's bill.

## How can a bill be based on money I did not spend?

The way energy performance contracts have done it since 1995: a defined
baseline, measurements, and an adjustment method agreed in advance. Every
request writes an append-only hash-chained event; the invoice is a pure
function over those events; you can re-run it and must get the same number.
What you paid is the provider's own reported usage. What you would have paid
is worked out by Mesh from the tokens it removed, and those rows are labelled
*estimated baseline*. Savings you already had are itemised and excluded.
Negative savings, such as a cache-write premium that did not pay off, reduce
the bill; they are never clamped to zero.

## Do I have to change my code?

One line or none. Proxy mode needs no code: run the Mesh proxy locally and
point your client's `base_url` at it. Your API key passes through verbatim
(Mesh never holds credentials), responses stream back untouched, and every
request appends a hash-chained ledger event. SDK mode wraps your existing
client (`withMesh(client)`). A stream whose usage cannot be read is recorded
*unpriced*, never guessed.

## What does Mesh do with my prompts?

Analysis runs locally; prompts never leave your machine. The ledger records
usage numbers, lever names, hashes and verdict references, not prompt text.
One optional exception you control: the SDK can POST usage metadata (never
prompt text) to an endpoint **you configure yourself**; it is off unless you
set it. Full detail: [data handling](../pilot/data-handling.md).

## What happens if the provider changes prices?

The price catalogue is dated and source-linked. A new rate is a new dated
entry; history is never silently repriced, and an uncovered date is
"unpriced", which excludes the row rather than guessing.

## What does Mesh cost?

The fee is 1% of verified savings for the month, rounded down to the cent, and nothing else; no fee is due unless billing has been agreed in writing.
No subscription, no seats, no minimum. A month that saved nothing bills
nothing, and a lever that lost money in a month counts against the fee.
[Pricing and billing](pricing.md) sets out how it works.

## Where does Mesh fall short?

- A fresh install makes three lossless changes only, and on Mesh's own test
  basket (LIVE, run 2026-10-26) those account for under half of the 18.2%
  recorded with a cache stamp and a tool-result cap switched on.
- A Claude Code user gains little on the defaults.
- No figure comes from a customer's traffic. Mesh has no customers yet.
- Busy interactive agents reach 25.9–29.4% on the harness (SIMULATOR, verified
  2026-10-13; needed the J lever stack, four of whose six levers are off by
  default), because the provider's cache already does most of the work.
- The 34.3% sparse figure (SIMULATOR, verified 2026-10-22; needed the J stack
  plus the 1-hour cache stamp, off by default) awaits a per-model
  cache-minimum correction and may come down for some models.
