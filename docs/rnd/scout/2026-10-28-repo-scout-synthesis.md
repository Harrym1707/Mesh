# Repo Scout Synthesis — what MESH should borrow

_Synthesized 2026-10-29 from six area scouts under `docs/rnd/scout/`. MESH is
BUSL-1.1, pure-TS/Node. License rule throughout: **MIT / Apache-2.0 / BSD / MPL
(separate process) are fine to depend on or copy; GPL / AGPL are study-only,
never vendored or linked.**_

This is the selective list — the few borrows that move MESH, not every repo the
scouts logged. Each is tagged `adopt-as-dep` (take it as a dependency),
`copy-pattern` (lift the design/code into MESH), or `study-only` (read it,
don't import it).

---

## The three quick wins (do these next)

These are the highest-leverage, lowest-effort borrows, and all three are
`adopt-as-dep` with clean MIT/Apache licenses. They are also the concrete
"ship the efficiency gains" path:

1. **TOON as the first structured-data lever** — the biggest *new* lossless
   saving available, and provable by construction.
2. **A real tokenizer (gpt-tokenizer) on the OpenAI path** — turns MESH's
   `approximateTokenCount` into honest, billable measurement.
3. **import-in-the-middle + shimmer** — the actual fix for the known
   `wrapMesh` private-fields crash on the real `@anthropic-ai/sdk`.

Details for each are in their area sections below.

---

## 1. Token efficiency / compression — the savings engine

### ⭐ TOON — `toon-format/toon` · MIT · TypeScript · ~25.6k★ · **adopt-as-dep**
https://github.com/toon-format/toon

The single highest-leverage borrow in the whole scan. Token-Oriented Object
Notation re-serializes the JSON data model densely (~40% fewer tokens on
structured payloads) with a **deterministic `encode`/`decode` round-trip**.
That round-trip is the point: the saving is lossless and *provable*, so it feeds
the hash-chained verified-savings ledger directly — exactly MESH's billing
premise. It is the same language and license as MESH, so it drops straight into
`packages/core/src/token-reduction.ts` as a new lever.

- **Reason:** a black-box request-byte rewrite for the common case (tool
  outputs, RAG chunks, JSON arrays in prompts). Gate it `encode-both-keep-
  smaller, record-delta` so it can never cost tokens (flat tables lose to CSV),
  which is also what makes the delta measurable.
- **License fit:** MIT — adopt the dep, or copy the encoder to stay zero-dep
  under BUSL. Clean either way.

### gpt-tokenizer — `niieani/gpt-tokenizer` · MIT · pure JS · **adopt-as-dep**
https://github.com/niieani/gpt-tokenizer

MESH today meters with `approximateTokenCount` (±15%, explicitly "not good
enough to bill on"). `token-reduction.ts` already takes an injectable
`countTokens` — so wiring an exact OpenAI tokenizer (`cl100k_base`/`o200k_base`)
is a near-zero-friction change that makes the OpenAI-path savings honest.

- **Reason:** the measurement spine under "verified savings"; lets the proxy
  decide if a rewrite (e.g. TOON) is net-positive *before* sending.
- **Caveat:** OpenAI vocab only — on the Claude-first path keep Anthropic's own
  `count_tokens` as the authority and treat tiktoken as an estimate. Pick
  **one** of gpt-tokenizer / js-tiktoken, don't ship both.
- **License fit:** MIT — clean.

### LLMLingua — **rejected for the core path** (study-only)
Lossy, model-dependent (57 MB–2.2 GB download + per-request inference), Python-
origin with an immature JS port. Incompatible with lossless-first and provable
savings. Only ever a future opt-in, clearly-labeled "aggressive" tier, never a
default and never billed as lossless.

---

## 2. Drop-in instrumentation — fix the `wrapMesh` shim

### ⭐ import-in-the-middle (+ require-in-the-middle) + shimmer · **adopt-as-dep**
- https://github.com/nodejs/import-in-the-middle · Apache-2.0
- https://github.com/elastic/require-in-the-middle · MIT
- `shimmer` (from opentelemetry-js) · BSD-2

This is the *fix*, not a nice-to-have. `wrapMesh` Proxied the SDK instance,
which throws on the real `@anthropic-ai/sdk` because its methods touch
`#private` class fields. Every mature observability tool solves this the same
way: hook module load and wrap the **prototype method**
(`Anthropic.Messages.prototype.create`) with `shimmer`, so the original method
runs with `this` intact. Adopt the three deps, write one instrumentation module
per provider.

- **Reason:** makes `wrapMesh` genuinely one-line *and* survive private fields,
  ESM, and CJS. Copy opentelemetry-js's "already patched?" idempotency +
  version guards so double-wrapping doesn't double-count tokens.
- **License fit:** Apache-2.0 / MIT / BSD-2 — all clean.

### copy-pattern references
- **traceloop/openllmetry** (Apache-2.0) — the per-provider streaming vs
  non-streaming `create` wrap + token-accumulation shape. Take the shape, drop
  the OTel export.
- **Arize-ai/openinference** (Apache-2.0) — mirror `manuallyInstrument(SDK)` as
  the always-works explicit fallback entry point when load-time hooks can't be
  installed.
- **langfuse `observeOpenAI`** (MIT) — ergonomics/docs framing for the explicit
  `wrapMesh(client)` call signature.

---

## 3. LLM gateways / proxies — the hosted blind gateway core

### ⭐ Portkey Gateway — `Portkey-AI/gateway` · MIT · TypeScript · ~13.3k★ · **copy-pattern**
https://github.com/Portkey-AI/gateway

The only top-tier, actively-maintained, provider-agnostic gateway that is
**MESH's exact stack and license** — so its code is adaptable, not just
readable. Three things to lift:

1. **Provider-adapter pattern** (`src/providers/*`): unified-request ↔ provider-
   native transform. This is the clean way to stay "OpenAI-compatible +
   Anthropic" (MESH already has `adapters.ts`/`gateway.ts` to grow into it).
2. **SSE streaming passthrough** that tees `usage`/`finish_reason` out of the
   final chunk without buffering — required to meter savings on streamed
   responses.
3. **Cloudflare Workers deploy target** — a worked example for standing up
   `gw.mesh-technology.com` at the edge without hand-rolling infra.
- **License fit:** MIT — clean to adapt into BUSL with attribution.

### LiteLLM — `BerriAI/litellm` · MIT · Python · **copy-pattern (data/behaviour)**
Port its exhaustive per-model price + usage-normalisation tables to validate
MESH's savings accounting across providers (MESH already has
`model-prices.ts`/`litellm.ts` — use LiteLLM as the canonical cross-check).
Python, so data/behaviour reference, not a code dep.

### Bifrost benchmark methodology — `maximhq/bifrost` · Go · **study-only**
Replicate its Vegeta + mock-provider harness to publish MESH's own proxy-
overhead numbers (MESH already has `evals/run-proxy-overhead.ts` to extend).
Credible latency numbers are trust currency for a "we only bill verified
savings" pitch. Go, so methodology only.

### Helicone ai-gateway / LangDB — **study-only** (Helicone is GPL-3.0 → do not
vendor). Borrow only the "change one base URL" + header contract and cost-aware
routing *design*.

---

## 4. Frictionless local deploy — `mesh init` / `mesh run`

### ⭐ package-manager-detector — `antfu-collective/...` · MIT · pure-TS · **adopt-as-dep**
https://github.com/antfu-collective/package-manager-detector

Tiny, zero-dep, exact fit, and the detection engine inside `@antfu/ni` (~22k★),
so battle-tested. `mesh init` calls `detect()`; `mesh run` with no command calls
`resolveCommand(pm, 'run', ['dev'])` so bare `mesh run` works instead of forcing
`mesh run -- npm run dev`. `evals/mesh-run.ts` already has the run-wrapper shape
to drop this into.
- **License fit:** MIT — clean.

### Infisical + supabase/cli — **copy-pattern**
- **Infisical** (MIT core) — the `init` (writes a persistent `.mesh/config`:
  ledger dir, cache-ttl, provider) + stateless `run` (reads it) two-command
  split, so later runs need no flags. Avoid vendoring its `ee/` dirs.
- **supabase/cli** (MIT) — (a) the `config.toml` convention (one declarative
  file, versionable in-repo) and (b) the multi-channel install matrix
  (brew + `curl | bash` + Releases binaries) to replace MESH's npx-only
  distribution so the Phase-2 install lands on any OS.

### ngrok-go — `ngrok/ngrok-go` · Go · **study-only**
Architecture blueprint only for Phase-2: an agent that dials out to
`gw.mesh-technology.com` and exposes the blind gateway with no open ports / no TLS
setup. The one-line/one-listener ergonomics is the target for how invisible the
hosted hop should feel. Go, so pattern not dep.

---

## 5. Verifiable ledger / metering — close the two structural gaps

`savings-ledger.ts` is a strong linear hash chain with recomputable invoices,
but (a) a verifier must replay the whole spool to check one event, and (b) the
chain is self-attested. Two borrows close both:

### ⭐ merkletreejs — `merkletreejs/merkletreejs` · MIT · TS · **adopt-as-dep**
Layer a Merkle tree over the existing event stream; emit a signed tree head per
billing period + an inclusion-proof verifier so a customer checks one billed
event in **O(log n)** without the full spool. Biggest verifiability win, lowest
effort (~1–2 days). Alternatively copy the RFC-6962 verifier (~300 LOC) from
**transparency-dev/merkle** (Apache-2.0) for a zero-dep core that matches the
certificate-transparency standard.
- **License fit:** MIT / Apache-2.0 — clean.

### sigstore/rekor — Apache-2.0 · **study-only**
Anchor the periodic signed tree head into a Rekor instance for an **independent,
timestamped** append-only log — removes "trust MESH's own clock" and is the
natural signing boundary for the Nitro-Enclave roadmap. Integrate via REST /
self-host; don't vendor the Go server.

### OpenMeter — Apache-2.0 · **copy-pattern (later)**
Idempotent ingestion keyed by requestId (validates MESH's existing dedup at
scale) + windowed aggregation + metering/invoicing separation — adopt only
if/when the in-process ledger must become a streaming multi-tenant plane. Keep
MESH's recompute-from-catalogue billing core (more verifiable than OpenMeter's).
Reject **Lago** (AGPLv3) as a dep; immudb (BUSL competitor carve-out) stays a
design reference only.

---

## 6. Confidential computing / attestation — the Phase-3 "provably blind" layer

The honest shape: MESH is TS; the enclave world is Rust/Go/C. The Node proxy
runs **unchanged** as the enclave's application behind a thin supervisor; the
one piece MESH writes in its own stack is the client-side verifier.

### aws/aws-nitro-enclaves-nsm-api — Apache-2.0 · **adopt-as-dep (in-enclave)**
First-party AWS. The in-enclave supervisor calls it to mint the attestation
document (CBOR/COSE_Sign1) and embed a nonce + the proxy pubkey. Non-negotiable
building block for the Nitro path.

### @epsilon-data/nitro-verify — MIT · TS · **copy-pattern (vendor)**
The only Nitro verifier already in MESH's language (Node + browser WebCrypto).
Vendor its small, auditable code into MESH's SDK/CLI so customers pin the
published PCRs and confirm the gateway is the exact audited binary — turning "we
can't read it" into something the client *checks*. Traction is ~0, so vet and
pin the code rather than take a live dep.

### brave/nitriding-daemon — MPL-2.0 (archived) · **copy-pattern**
The canonical gateway-in-enclave *shape* (TLS-terminating supervisor +
`/attestation` endpoint + vsock↔IP, pubkey bound into the doc). Runs as a
separate process → no BUSL contamination. Archived, so re-implement the pattern.
Read **Amnesic-Systems/veil** (GPL-3.0) as current state of the art but **do not
fork or copy** — clean-room only.

### aws-nitro-enclaves-sdk-c — Apache-2.0 · **study-only**
The KMS-key-release-gated-on-PCRs pattern: `MESH_PROXY_BLIND_KEY` becomes a key
KMS only decrypts for the attested enclave. Copy the condition-key policy
design; MESH won't link the C library. Park **confidential-containers/trustee**
(Apache-2.0) as the multi-TEE scaling story.

---

## Sequencing

- **Now (ship efficiency):** TOON lever + gpt-tokenizer metering + the
  import-in-the-middle/shimmer `wrapMesh` fix. All adopt-as-dep, all MIT/
  Apache/BSD, all land in files that already exist.
- **Next (hosted gateway):** Portkey adapter + streaming-passthrough pattern;
  package-manager-detector + `mesh init`/`config.toml`; Bifrost-style overhead
  benchmark for trust.
- **Then (verifiability):** merkletreejs proof layer over the ledger, then Rekor
  anchoring.
- **Phase-3 (attestation):** nsm-api inside, nitro-verify vendored client-side,
  KMS PCR-sealed blind key.
