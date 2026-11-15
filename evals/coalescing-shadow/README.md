# Shadow-mode measurement: in-flight request coalescing (S2)

Candidate S2 in [`docs/rnd/cost-reduction-rnd-2026-11-04.md`](../../docs/rnd/cost-reduction-rnd-2026-11-04.md)
is lossless single-flight de-duplication: when byte-identical requests are in flight
concurrently, send **one** upstream call and fan the single response back to all callers,
so N−1 of N duplicates disappear. Its honest pre-sale saving is **0** — the volume of
concurrent duplicates is per-customer and unmeasured. This harness measures that volume on
real traffic **without changing behaviour and without making a call**, so a real saving can
later be derived from the customer's own data instead of guessed.

This is an **R&D prototype** living under `evals/`, deliberately outside `packages/`. It makes
no product-code change and nothing imports it yet. Keying is an inlined mirror of
`packages/sdk-js/src/exact-cache.ts` so the measured keys match what a real coalescer built on
the same canonicalization would collapse.

## Files

- `recorder.ts` — observe-only recorder. Two content-free events per request (`start`/`end`).
- `analyze.ts` — offline analyzer. Reconstructs single-flight overlaps and reports the
  coalescable rate, avoidable usage, and modelled hold-time distribution.
- `synthetic.ts` — fabricated traffic to exercise the pipeline end to end (NOT a measurement).
- `recorder.test.ts` — vitest suite (keying, content-freeness, single-flight reconstruction).

## Run it now (synthetic, no live traffic)

```bash
npx tsx evals/coalescing-shadow/synthetic.ts > /tmp/shadow-events.jsonl
npx tsx evals/coalescing-shadow/analyze.ts /tmp/shadow-events.jsonl --max-hold-ms 3000
```

```bash
npx vitest run evals/coalescing-shadow/recorder.test.ts
```

`--max-hold-ms N` caps how long a follower may wait for the leader (client TTFB tolerance);
followers over the cap are counted but NOT treated as a saving. `--include-gated` also counts
non-deterministic requests (those need caller opt-in before a latch is safe).

## Wiring it into the SDK later (not done here)

The recorder is a pure module with two hooks. When S2 graduates, call it alongside
`ExactResponseCache` in `packages/sdk-js/src/openai.ts` (around the cache-key block, lines
~232–304), delete the inlined keyer, and pass the SDK's own canonical key:

```ts
const shadow = new ShadowCoalescingRecorder({
  getScopeKey: (request) => options.exactCache?.getScopeKey(request),
  emit: appendToJsonlOrFeatureStream,     // the blind feature stream is the natural sink
});
// at request admission:
const handle = shadow.begin(routedRequest);
// after the upstream response resolves (or errors):
shadow.end(handle, usageFromProviderResponse);
```

Shadow mode holds nothing and merges nothing, so it is safe to run in production at full
traffic. Only once the measured rate justifies it would a real latch be built — and that is a
`packages/` change for separate review, not part of this prototype.

## Privacy

The only identifiers emitted are irreversible SHA-256 hashes (of the canonical request and of
the scope key) plus structural fields: model name, timestamps, provider-reported usage, and an
ineligibility reason. No request or response content is recorded. This matches the proxy's
blind-feature-stream ethos, and `recorder.test.ts` asserts a secret in the prompt never appears
in any event.

## What this can and cannot tell you (honesty)

- **Can:** the share of keyable traffic with a concurrent byte-identical twin, per scope; the
  usage those avoidable calls carried; the hold time a follower would have waited.
- **Cannot:** a realised saving. Followers ran independently in shadow mode, so their usage is
  the call a latch *would* avoid, and the hold time assumes the leader's *observed* latency — a
  real latch changes load and may differ. The output is labelled MODELLED throughout. Realised
  savings come only from the ledger once the lever is live.
- **Determinism gate:** at temperature > 0 with no seed, sharing one sample across callers
  freezes randomness (a visible behaviour change), so those requests are reported separately as
  an opt-in band, never folded into the safe band by default.
- **Dependency on timestamps:** this is the same missing input flagged across the backlog (P5
  collision frequency, P2 gap histograms). The recorder is also the thing that starts producing
  the arrival timestamps those levers need.
