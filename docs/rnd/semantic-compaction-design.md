# Local-model semantic compaction — prototype design note

Status: PROTOTYPE (Q2.1 from `dispatch-2026-10-27-strategy.md`). Reviewable, gated,
tested against a deterministic stub. NOT shippable — see "What's left" below.

- Code: `packages/sdk-js/src/semantic-compaction.ts`
- Tests: `packages/sdk-js/src/semantic-compaction.test.ts`
  (run: `npx vitest run packages/sdk-js/src/semantic-compaction.test.ts`, commit on branch
  `feat/semantic-compaction-proto`)
- Exports: `compactStaleContext`, `reduceRequestAsync`, `SemanticCompactor`,
  `SemanticCompactionConfig`, `SemanticCompactionResult` (via `packages/sdk-js/src/index.ts`)

## What it is

A pluggable lever that compresses **stale tool-result bodies in old turns** by
handing their text to a compactor the **customer supplies**. MESH bundles no
model. The adapter interface is deliberately tiny:

```ts
type SemanticCompactor = {
  compact(input: { text: string; maxTokens: number; kind: "tool-result" }): Promise<string> | string;
};
```

What it will and will not touch, enforced in code and covered by tests:

- ONLY tool-result bodies (environment output): chat `tool` role, Responses
  `function_call_output`, Anthropic `tool_result` blocks inside a user message.
- ONLY in STALE turns (strictly before the `keepRecentTurns` boundary).
- ONLY when OVERSIZED (> `maxTokens`).
- NEVER model output (assistant messages are left verbatim, always).
- NEVER user text (human turns are left verbatim, always — including the user's
  own text that sits alongside an Anthropic `tool_result` block in the same message).
- NEVER the live / last user turn or anything in the recent-turn window.
- NEVER system or developer instructions.

This is narrower than the existing deterministic `historyCompaction` lever,
which does digest stale *assistant* bodies. The dispatch brief's rule — "NEVER
model output" — is taken literally here: a local model paraphrasing the model's
own prior output is exactly the kind of compounding drift we refuse to risk.

## The sync-vs-async decision: a PRE-PASS, not an async reducer

`reduceRequest` (`reduce-request.ts`) is a pure, synchronous, hot-path function.
The proxy, `withMesh`, the savings ledger, and — critically — the replay gate's
tight per-request loop all call it synchronously, and its purity (same request
in, same bytes out) is what lets consecutive requests re-emit byte-identical
history so a provider's exact-prefix cache keeps matching. Local model inference
is async and I/O-bound.

Two bridges were considered:

- **(A) Make `reduceRequest` async.** Rejected. It would force every call site
  above — including the gate's hot loop and the cache-byte-stability reasoning —
  to become async, converting a pure deterministic core into a promise-returning
  one for the sake of one optional, non-deterministic lever. The blast radius is
  the whole SDK, and the determinism the gate relies on becomes harder to argue.

- **(B) A PRE-PASS.** CHOSEN. `compactStaleContext(request, config)` is an async
  stage that runs BEFORE the sync reducer, produces an already-compacted request,
  and hands that to `reduceRequest` unchanged. It isolates the one model-driven,
  I/O-bound, non-deterministic step into its own awaitable function and leaves
  the deterministic core exactly as it is. `reduceRequest` never learns a model
  was involved; it just sees a request whose stale tool results are shorter.

`reduceRequestAsync(request, reductionConfig, semanticConfig)` is the thin
composition: `await` the pre-pass, then call the untouched synchronous
`reduceRequest`, merging the compaction change into the summary so before/after
spans the whole pipeline. Callers that do not use semantic compaction keep
calling `reduceRequest` directly and never take on a promise. The async lever is
intentionally NOT a field on the synchronous `MeshTokenReductionConfig`, because
the sync reducer cannot await — making that explicit is the point of the design.

## On-machine / no-egress guarantee

The inviolable honesty rule is that prompts never leave the customer's machine.
MESH's code here adds **zero** network egress: `compact` is a function the
customer passes, and MESH does nothing but `await` it. MESH bundles, downloads,
and calls no cloud model. The only compactor MESH will ever invoke is the local,
on-machine one the customer wired in. There is no default compactor; absent one,
the lever is a no-op. This is a property of the code (no `fetch`, no import of a
model), not a promise — reviewers can confirm the module imports only the token
counter and the reducer types.

## Gate dependency (double-gated)

The lever is LOSSY (a model paraphrase is not the original bytes), so it is OFF
by default and gated twice:

1. **Billing gate (existing mechanism).** It emits a `ReductionChange` with
   `lever: "semantic-compaction"`, `lossless: false`, and tokens-before/after.
   The savings ledger (`savings-ledger.ts`) already refuses to bill any lossy
   lever without an approved `gateVerdicts["semantic-compaction"]` entry — the
   same path that governs `tool-schema-description-trim`, the output cap, and the
   other behaviour-changing levers.

2. **Reducer-level guard (stricter, new).** Unlike the deterministic levers,
   this pre-pass will not touch a single byte without an `approved` gate verdict
   in its own config. A deterministic truncation is predictable enough to inspect
   by eye; a model paraphrase is not, so it may not run on the customer's traffic
   until a gate has proven, on that customer's own recorded requests, that
   quality held. Absent or `rejected` ⇒ byte-identical no-op, with a recorded
   `skippedReason` saying why (mirroring the `cache-ttl-suppressed` record style).

Compaction can also never grow a request: a compacted body is kept only when it
is actually shorter than the original, else the original bytes are retained.

## What's left before it can ship

This is a prototype. Honest gaps, not hidden:

1. **A real adapter.** No local model is wired in; the tests use a deterministic
   stub (fixed summary / truncation). A real adapter (e.g. a small quantised
   on-device summariser) is needed, plus guidance on which local models are good
   enough.
2. **Calibration data.** `minimumTurns`/`keepRecentTurns` (3 / 2) are CONFIRMED tuned against WildChat +
   agent corpora (2026-10-27 findings); `maxTokens` recalibrated 200 -> 500 from
   the agent tool-result median (~270-302 tok) so it fires on the oversized tail,
   not the typical observation. Re-confirm at larger n in run 2.
3. **Gate integration.** The lever is wired to the gate's *billing* contract and
   carries a reducer-level verdict guard, but there is no eval script yet that
   runs `replayGate` over semantic compaction on a fixture the way
   `run-replay-gate-freshcap.ts` does for the fresh cap. That eval — with a
   grader that can see paraphrase-induced quality loss — is the proof that would
   let a verdict be issued at all. Until it exists and passes on a customer's own
   traffic, no saving may be billed.
4. **No published savings number.** Per the honesty rules, nothing is claimed
   here. The only runnable command today is the unit test above; it proves the
   mechanism and the guards, not a dollar figure. Any future number must trace to
   a gate run on real traffic at a named commit, with paraphrase-aware grading.

5. **CROSS-TURN STABILITY — the hard blocker (added in review, 2026-10-27).**
   A model paraphrase is non-deterministic, but a stale tool-result body is
   RESENT every turn. If turn N compacts a body to summary A and turn N+1
   re-runs the compactor and gets summary B, the cached prefix churns on every
   turn — which is exactly the loss the cross-turn volatility guard
   (`cache-volatility-guard.ts`) exists to prevent. As written, `compactStaleContext`
   re-compacts all eligible bodies on every call, so it would FIGHT the cache
   lever and can make an agent MORE expensive, not less. This lever MUST NOT be
   enabled alongside caching until the compacted result is pinned: compact a
   given body once, key the result by a hash of the original bytes, and re-emit
   the identical compacted bytes on every subsequent turn (or require the
   compactor to be deterministic for identical input). Until that pinning exists,
   semantic compaction is only safe on the no-cache path, and the gate eval in
   (3) must measure net cost WITH caching on, not just quality.
