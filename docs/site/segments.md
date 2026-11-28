# What MESH saves, segment by segment

Savings are a property of your workload's shape. One global percentage would be
a lie to someone; these are the four shapes, each with its mechanism, its
measured band, and what would change the number. All figures simulator-measured
per [methodology](methodology.md); traceability in [evidence](evidence.md).

## Background / batch / latency-tolerant work — 57.7% net (64.3% ceiling)

**Mechanism:** your provider sells the same model at 50% off for work that can
wait (OpenAI's flex service tier on a synchronous API; Anthropic's batches,
which stack with prompt caching). MESH applies the tier only to traffic you
flag latency-tolerant, stacks it with every token lever below, and bills from
the tier the provider *actually served* — bounced requests bill at full rate.
**The number to use is 57.7%** (net of assumed 10% default-fallback + 5% retry
rates); 64.3% is the zero-fallback ceiling. Quality: identical model, identical
answers; 38/40 clean on the harness.
**What changes it:** your real fallback rate (telemetry replaces the
assumption), and Anthropic-side pricing once its batch rate is catalogued.

## One-shot API traffic on a shared template — 45.5%, up to 72.8%

**Mechanism:** the most common silent waste we model: a per-request value (a
timestamp, a request id) at the top of an otherwise identical prompt, which
disables provider caching entirely. MESH relocates it, the prefix caches at
one-tenth price, and schema/duplicate levers stack on top. Add the tier for
latency-tolerant one-shots and the band reaches 72.8%.
**What changes it:** how big your shared template is and whether a breaker is
actually present — the five-minute quote measures both from your export.

## Interactive agents — 25.9–29.4% busy, 34.3% sparse

**Mechanism:** busy agent traffic is already heavily subsidised by the
provider's cache (35–40% on its own, which we never claim), so MESH's honest
headroom is the *fresh* tokens: oversized tool results are capped at injection
(headlines, errors and file paths preserved verbatim; the replay gate approved
this lever at exactly zero quality delta), stale history is compacted
byte-stably, schemas are slimmed. Sparse traffic adds the 1-hour cache TTL
(2× write premium billed honestly, netted when negative) for 34.3%.
**What changes it:** how oversized your tool results actually are (our fixture's
are highly compressible; your yield scales with yours), and the pending
per-model cache-minimum fix, which may lower the sparse figure on some models.
**On Claude the ceiling is different — and higher.** Anthropic's prompt
cache is opt-in, and agents that never place `cache_control` re-pay full
rate for their whole conversation history every turn (our first live export
measured exactly that: a five-turn agent with zero cache traffic). MESH
stamps the stable prefix with a 5-minute-TTL breakpoint. In the deterministic
fixture, the cache-only comparison is **37.9% lower cost** than the identical
J prompt stack with caching disabled; both arms have 38/40 clean tasks and the
stamp is metadata-only. The earlier **57.3%** full-stack comparison used a raw
uncached baseline with 40/40 clean tasks, while the candidate had 38/40 (−5 pp).
That fails the agreed −2 pp quality limit, so 57.3% is diagnostic and not a
qualified full-stack saving. Real-traffic cache validation remains open. If
you already place your own breakpoints, MESH defers and never claims this.
**This is also where we tell you our ceiling:** if someone promises an
interactive agent 70%, ask for their per-task evidence.

## Always-on agents — where the compounding lives

An agent that never stops — an ops monitor, an autonomous worker, a
multi-agent team running around the clock — re-buys its own memory on every
single turn, forever. Every output token an agent emits is re-sent as input
on every later turn, so the history can become the biggest line on its bill. Mesh's
levers target exactly that: lossless history clean-up and breakpoint-exact
cache placement. We have no live measurement on an always-on agent yet. The
only live number we have is 18.2% on a mixed 30-request basket
(LIVE, claude-sonnet-5-5, run 2026-10-26; see docs/NUMBERS.md); simulator figures
for agent workloads are listed with their labels in the evidence page.

**The always-on trap is cadence.** A busy loop (calls under five minutes
apart) keeps the provider's 5-minute cache warm for free — every read
refreshes the clock, and MESH's stamp earns indefinitely. But an always-on
agent that is *bursty* — polling every ten minutes, waiting on webhooks —
silently expires its cache in every gap and re-pays the write premium on its
whole history each time it wakes. MESH's volatility and minimum guards
already refuse the placements that lose money there; a cadence-aware TTL
policy (choosing the 1-hour tier for prefixes whose observed gaps exceed five
minutes) is in development and will be published with its own measured band,
like everything else here.

**What ships today for long-lived agents:** correct, guarded cache placement;
byte-stable history digests and the gated fresh-tool-result cap for unbounded
context growth (real traces show tool results reaching 2,500–10,000 tokens at
p99); exact-duplicate removal; byte-identical retry flagging (4–8% of real
agent actions in public traces); and output-waste metering — on real agent
trajectories, ~24% of output tokens re-emit text already in the context, and
your statement shows your own number, measured, not billed.
**What changes it:** your cadence (the gap histogram decides the cache
economics) and your tool-result sizes.

## Already-optimised stacks — 0–5%: do not pay us

**Mechanism:** none, and that is the point. If your input already arrives
largely cached, or your gateway's response cache already answers a big share of
requests, MESH's triage says so and the quote's verdict is `doNotPayUs`. On our
fixture of such a stack the addressable saving was 2.4%. A percentage-of-savings
vendor that charges you for savings you already had is buying a dispute; we
decline up front.
