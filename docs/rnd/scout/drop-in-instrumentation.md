# Scout: drop-in instrumentation / one-line SDK wrapping

Area owner: GitHub scout. Date: 2026-10-29. MESH license: BUSL-1.1 (needs permissive deps; MIT/Apache/BSD fine, GPL/AGPL a problem).

## The problem we're solving

`wrapMesh` tried to intercept the real Anthropic/OpenAI SDK with a JS `Proxy` around the
*instance*. That breaks on the real `@anthropic-ai/sdk` because its methods read `#private`
class fields — a Proxy is a different object, so `this.#field` throws
`TypeError: attempted to get private member ... on an object whose class did not declare it`.

**The industry fix (every mature observability tool uses it):** don't Proxy the instance.
Patch the *prototype method* on the SDK class (e.g. `Anthropic.Messages.prototype.create`)
using a function-wrapping shim (`shimmer`/`wrap`), hooked at module-load time via
`require-in-the-middle` (CJS) + `import-in-the-middle` (ESM). The original method still runs
with `this` bound to the original instance, so `#private` fields are intact; only the method
is wrapped. This is the single most important pattern for making `wrapMesh` robust.

## Ranked findings

### 1. nodejs/import-in-the-middle (+ require-in-the-middle) — the core mechanism
- https://github.com/nodejs/import-in-the-middle  (~170+ stars, actively released, Node.js org, Apache-2.0)
- Companion: https://github.com/elastic/require-in-the-middle (CJS, MIT)
- What it does: intercepts module loading so you can modify a package's exports at load time.
  `import-in-the-middle` works around ESM immutability via Node module-customization hooks;
  `require-in-the-middle` does the CJS equivalent. Used by New Relic, Sentry, OpenTelemetry.
- What MESH borrows: **depend on both directly.** Register a hook for `@anthropic-ai/sdk`
  and `openai`, and on load wrap the client's `*.create` prototype methods. This is what makes
  `wrapMesh` truly one-line *and* survive private fields, ESM, and CJS. This is the fix.
- Effort: adopt-as-dep + ~1 instrumentation module per provider.

### 2. traceloop/openllmetry (JS: openllmetry-js) — reference instrumentation structure
- https://github.com/traceloop/openllmetry  (large traction, very active, Apache-2.0)
- JS packages instrument OpenAI/Anthropic/etc; `Traceloop.init()` registers OTel instrumentors.
- What MESH borrows: a copyable blueprint for a per-provider instrumentation module —
  how they wrap streaming vs non-streaming `create`, accumulate token counts off the response,
  and unwrap cleanly. We don't need OTel; we need their patch/unwrap shape for the ledger meter.
- Effort: copy-pattern (study their `instrumentation-anthropic` / `-openai` wrap code).

### 3. Arize-ai/openinference (JS instrumentation-anthropic / -openai) — private-fields-safe, Anthropic-specific
- https://github.com/Arize-ai/openinference  (active, Apache-2.0)
- Exposes `instrumentation.manuallyInstrument(Anthropic)` — you pass the SDK *module/class* in,
  and it patches the prototype. This is exactly the "don't Proxy the instance" pattern, and the
  manual hook is their documented ESM escape hatch when load-time hooking isn't wired up.
- What MESH borrows: the `manuallyInstrument(SDK)` escape-hatch API as a fallback for stacks
  where module hooks can't be installed — gives us a second, always-works entry point for
  `wrapMesh` besides the auto-hook. Also the cleanest Anthropic-specific wrap reference.
- Effort: copy-pattern (mirror their manual-instrument entry point + Anthropic wrap).

### 4. open-telemetry/opentelemetry-js (InstrumentationBase + shimmer) — the wrap/unwrap discipline
- https://github.com/open-telemetry/opentelemetry-js  (very high traction, Apache-2.0)
- `InstrumentationBase` + `shimmer` (`wrap`/`unwrap`/`massWrap`) is the canonical safe
  monkeypatch helper; idempotent wrapping, version-guarded patches, clean teardown.
- What MESH borrows: depend on `shimmer` (BSD-2) for the actual method wrapping instead of
  hand-rolling it, and copy the version-range guard + "already patched?" idempotency checks so
  double-`wrapMesh()` and multiple SDK versions don't double-count tokens.
- Effort: adopt-as-dep (shimmer) + copy-pattern (idempotency/version guards).

### 5. Helicone/ai-gateway — the base-URL proxy model (architecture reference)
- https://github.com/Helicone/ai-gateway  (fully OSS, Apache-2.0; Rust)
- The "change one base URL" install for OpenAI/Anthropic with routing + fallbacks — the same
  posture as MESH's hosted blind gateway.
- What MESH borrows: architecture only — their base-URL + passthrough + per-provider routing
  layout as a sanity check for `gw.mesh-technology.com`. Rust, so no code reuse; study-only.
- Effort: study-only.

### 6. langfuse (@langfuse/openai `observeOpenAI`) — the explicit-wrapper ergonomics
- https://github.com/langfuse/langfuse  (very high traction; SDKs MIT — permissive, core repo MIT)
- `observeOpenAI(new OpenAI())` returns an instrumented client without a proxy footgun.
- What MESH borrows: the `wrapMesh(client)` call-signature ergonomics and docs framing for the
  explicit-wrap path (the non-magic fallback when auto-hooking is off). Pattern, not dep.
- Effort: copy-pattern (API ergonomics only).

## License verdict
All six are permissive (Apache-2.0 / MIT / BSD-2) — safe to depend on or copy from under MESH's
BUSL-1.1. No GPL/AGPL exposure found in this set. Direct deps worth adopting: `import-in-the-middle`,
`require-in-the-middle`, `shimmer`.
