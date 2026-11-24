# We caught our own cache lever claiming a saving that could never happen

*(**Draft, not published.** Written 2026-10-26; the install path at the end
was checked again on 2026-11-23 against Mesh 0.2.5 and is unchanged.
Publishing is the founder's act; retype it in your own words first. On
2026-11-24 the SIMULATOR figures it quotes were each given the levers they
were modelled with, since none is what a fresh install gives, and the
closing paragraph was re-aimed at teams running their own agents.)*

Anthropic won't cache a prompt prefix below a minimum length: 1,024 tokens
for Opus- and Sonnet-class models, 2,048 for Haiku-class ones. Send a
shorter prefix with a `cache_control` breakpoint on it and the API doesn't
error — it just quietly skips caching and bills the request as if the
breakpoint wasn't there. No signal comes back. The only way to know is to
already know the number and check your own prefix length against it before
you send.

Mesh's proxy wasn't doing that check. `stampAnthropicCacheTtl`, the function
in `packages/sdk-js/src/reduce-request.ts` that actually places
`cache_control` on requests going through the proxy, placed a breakpoint on any stable
prefix it found and recorded a `cache-ttl-5m` (or `cache-ttl-1h`) lever every
time — a line in the savings ledger claiming "this request got cheaper
because of caching." Below Anthropic's minimum, that claim is false. The
request cost exactly what it would have cost with no breakpoint at all. Had
anyone been billed on it, the fee would have been 1% of a saving that was
never real.

This wasn't a hypothetical edge case we went looking for. It was already
flagged as an open item on our own evidence page — "per-model cacheable
minimums not yet simulated → 34.3% may overstate on some models" (34.3% is a
SIMULATOR number, modelled with the tool-result cap and the one-hour cache
stamp switched on, so not out of the box) — and our
workload-matrix eval fixtures were tripping it on every run: a RAG fixture
with a ~550-token system prefix and a memory-agent fixture re-injecting a
~450-token block, both comfortably under the 1,024-token floor, both
recording a cache-ttl lever that Anthropic was silently discarding on the
wire.

## The fix

Two changes, both small:

1. `packages/core/src/model-prices.ts` gained
   `anthropicCacheableMinimumTokens(modelId)` — 2,048 for anything matching
   `/haiku/i`, 1,024 otherwise, matched on the raw model id rather than a
   resolved catalogue entry, because the minimum is a property of the model
   *class*, not of whether we happen to have it priced.

2. `stampAnthropicCacheTtl` now measures the full prefix a candidate
   breakpoint would cover — tools plus the stable system text for the
   single-breakpoint case, tools plus system plus every prior message for
   the multi-turn case — against that minimum *before* placing anything. If
   the prefix doesn't clear the bar, nothing gets stamped and nothing gets
   claimed. If every candidate breakpoint gets skipped this way, the change
   list now records a `cache-ttl-suppressed` lever naming the measured token
   count and the minimum it missed, instead of going silent — the same
   pattern we already use for the cross-turn volatility guard refusing to
   stamp a prefix that's churning.

Nothing about this touches cost. The lever was a no-op before the fix too —
Anthropic was never going to cache those prefixes either way. The only thing
that changed is that we stopped claiming credit for it. Four new tests in
`reduce-request.test.ts` cover the guard directly: a short system prompt
suppressed on Sonnet, the identical prefix stamping fine on Sonnet but
suppressed on Haiku (proving the per-model distinction isn't just a flat
constant), and the no-system-prompt multi-turn case. 394 tests passed on the
tree at that commit.

One thing we deliberately didn't do yet: the published SIMULATOR bands
(25.9–29.4% busy interactive, with tool-description trimming and the
tool-result cap switched on; 34.3% sparse interactive, with those plus the
one-hour cache stamp; 57.7% net async, with the flex execution tier on
batch-eligible work; all modelled, none out of the box, none proven on a
real bill) come from
`packages/core/src/cache-simulator.ts`, which still hardcodes a flat
1,024-token minimum across all three Anthropic cache policies with no
per-model split. Every eval those bands are drawn from runs on
`claude-sonnet-5-5`, for which 1,024 is exactly correct — so no published
number moved. Teaching the simulator itself to vary by model touches the
savings-model and every eval script that constructs a `CachePolicy`; that's
a real refactor, and we're leaving it for a separate pass rather than
quietly folding it into a bug fix.

## Why bother writing this up

The honesty rule we hold our own numbers to — every published figure traces
to a runnable command, and the harness that regenerates them is allowed to
only ever get stricter — doesn't mean much if it only applies to the
headline percentages and not to the lever-by-lever accounting underneath
them. A savings ledger that can silently claim a saving for a no-op is the
same category of problem as a comparison page that overstates a competitor,
just pointed at ourselves. We'd rather find this kind of thing in our own
eval fixtures, on a Sunday night, than have someone else find it in their
invoice.

The commit is `647a053` if you want to read the diff yourself; the ledger
and the model-prices table are both in this repo, so the check described
above is one you can run against your own traffic rather than take our word
for.

To run Mesh on your own agents (open to anyone, no signup): install with
`curl -fsSL https://www.mesh-technology.com/install.sh | sh` (macOS, Linux,
or inside WSL on Windows) or `npm install -g @harrym1707/mesh`; then
`mesh proxy` for your own app or agent with
`ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or
`OPENAI_BASE_URL=http://127.0.0.1:8787/v1` (`mesh start` is the route for
Claude Code); then `mesh verify`. Out of the box Mesh compacts tool schemas,
removes exact duplicate context and keeps the cacheable prefix stable; the
cache stamp this post is about is off until you switch it on. Questions:
https://github.com/Harrym1707/Mesh/issues/new
