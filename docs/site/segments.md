# What Mesh saves on LLM API traffic, by workload shape

Mesh is a local proxy for LLM API traffic, and what it saves depends on the
shape of that traffic and on which levers are switched on. Each shape below
gives its figure with label and date, and the levers that figure needed.

One percentage for everyone would be wrong for most. Each section also gives
the mechanism and what would change the figure. Method:
[methodology](methodology.md). Traceability: [evidence](evidence.md).

## What a fresh install does today

Out of the box Mesh makes three lossless changes: tool-schema compaction,
exact-duplicate removal and cache-prefix repair. On Mesh's own 30-request
test basket (LIVE, run 2026-10-26, not a customer's traffic) those three
account for under half of the 18.2% recorded; the rest came from a 5-minute
Anthropic cache stamp and a gate-approved cap on oversized tool results, both
off by default. A Claude Code user gains little on the defaults. Every figure
in the headings below is SIMULATOR (modelled on a harness, not a measurement
of anyone's bill) and needed levers that you or Theo switch on;
[how to switch them on](start.md).

The "J stack" named below is one fixed set of levers: tool descriptions
trimmed to 40 tokens, exact-duplicate removal, cache-prefix repair, a cap on
oversized fresh tool results, stale-history compaction and a 2,000-token
output cap. Four of those six are off in a fresh install.

## Background, batch and other work that can wait

**Figure:** 57.7% net, 64.3% ceiling (SIMULATOR, verified 2026-10-13; needed
the J stack plus the provider's discounted flex tier, none of which a fresh
install switches on beyond exact-duplicate removal and cache-prefix repair).
Use the net figure.

**Mechanism:** your provider sells the same model at half price for work that
can wait (OpenAI's flex service tier on a synchronous API). Mesh applies the
tier only to traffic you flag as able to wait, and bills from the tier the
provider actually served: a request bounced back to the standard tier counts
at full rate. The net figure assumes 10% fallback to the default tier and 5%
retries; those rates are assumptions, not measurements. Quality on the
harness: 38 of 40 tasks clean.

**What changes it:** your real fallback rate, and how much of your traffic
can wait at all.

## One-shot API calls on a shared template

**Figure:** 45.5%, and 72.8% where the work can wait (SIMULATOR, verified
2026-10-13; the 45.5% needed cache-prefix repair, which is on by default and
carries most of it, plus tool-description trimming, stale-history compaction
and an output cap, which are not; the 72.8% adds the flex tier).

**Mechanism:** a value that changes on every request (a timestamp, a request
id) at the top of an otherwise identical prompt stops the provider's cache
from ever matching. Mesh moves it below the shared part. The figure is priced
on a provider that caches automatically (OpenAI). On Anthropic, where caching
is opt-in, the repair pays only if a cache breakpoint exists: your own, or
Mesh's cache stamp, which is off by default.

**What changes it:** how large the shared template is, whether a changing
value really sits at its top, and whether your provider caches without being
asked.

## Interactive agents

**Figures:** busy traffic 25.9–29.4% (SIMULATOR, verified 2026-10-13; needed
the J stack, and on this harness the three defaults alone move the simulated
bill very little). Sparse traffic 34.3% (SIMULATOR, verified 2026-10-22;
needed the J stack plus the 1-hour Anthropic cache stamp, off by default; may
overstate on some models because per-model cache minimums are not in the
simulator).

**Mechanism:** on busy agent traffic the provider's own cache already takes
35–40% off before Mesh does anything
(SIMULATOR, harness re-run 2026-11-24; never claimed by Mesh). What
is left is the tokens billed at the full rate the first time they appear.
The lever that reaches those is the cap on oversized fresh tool results: it
keeps the headline, error lines and file paths, and the replay gate approved
it at zero quality delta on Mesh's recorded fixture. It can change what the
model sees, so Mesh treats it as lossy and it is off by default. Stale history
is compacted byte-stably and tool descriptions are trimmed; both are lossy and
off by default.

**On Claude, where the client places no cache breakpoints:** Anthropic's
prompt cache is opt-in, and an agent that never places `cache_control`
re-pays the full rate for its whole history every turn. Mesh can stamp the
stable prefix with a 5-minute breakpoint. On the harness the cache stamp
alone is 37.9% lower cost than the same J stack with caching disabled
(SIMULATOR, verified 2026-10-22; needed the 5-minute Anthropic cache stamp,
off by default; both arms 38 of 40 clean). The 57.3% full-stack comparison
(SIMULATOR, verified 2026-10-22; needed the J stack plus the cache stamp)
used a raw uncached baseline with 40 of 40 clean tasks against 38 of 40 for
the candidate. That fails the agreed quality limit, so 57.3% is diagnostic
and not a qualified saving. Validation of the cache stamp on a customer's
traffic is still open. If you already place your own breakpoints, Mesh defers
and never claims that saving.

**What changes it:** how oversized your tool results are (the fixture's are
highly compressible; yours may not be), whether your client already caches,
and how far apart your requests arrive.

## Always-on agents

An agent that never stops (an ops monitor, an autonomous worker, a
multi-agent team) re-sends its history on every turn. In public SWE-bench
agent trajectories that Mesh analysed on 2026-10-26 (coding agents on a
benchmark, not a customer's traffic), each output token was re-read about 27
more times in later turns, and about 52% of a well-cached agent's bill was
cache reads. Those are usage statistics, not savings.

**What matters is cadence.** A loop whose calls arrive under five minutes
apart keeps the provider's 5-minute cache warm. An agent that polls every ten
minutes or waits on webhooks lets the cache expire in every gap and pays the
write premium again each time it wakes. Mesh's volatility and minimum guards
refuse the cache placements that would lose money there. A policy that picks
the 1-hour tier for prefixes whose gaps exceed five minutes is in
development; it has no published figure.

**What exists today for long-lived agents:** in a fresh install, exact
duplicate removal, cache-prefix repair and tool-schema compaction. Switched
on by you: the guarded cache stamp, and, once a replay of your own requests
has approved them, stale-history digests and the fresh-tool-result cap. In
the same public trajectories tool results reached 2,500–10,000 tokens at the
99th percentile, 4–8% of agent actions were byte-identical retries and about
24% of output tokens repeated text already in the context; Mesh's ledger can
show your own figures for those. None of that is billed.

## Stacks that are already optimised: do not pay us

**Mechanism:** none, and that is the point. If your input already arrives
largely cached, or your gateway's response cache already answers a large
share of requests, Mesh's quote says so and its verdict is `doNotPayUs`. The
band for such stacks is 0–5% (SIMULATOR, fixture, 2026-10-11; no levers
needed, nothing to switch on). A vendor paid on
savings that charges for savings you already had is buying a dispute; Mesh
declines up front.
