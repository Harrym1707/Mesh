# Scout: Token-Efficiency / Compression

**Area:** token-efficiency-compression
**Date:** 2026-10-29
**MESH context:** transparent LLM cost-reducer — proxy/gateway + drop-in SDK shim. Lossless-first token reduction, savings metered into a hash-chained ledger, bill 1% of *verified* savings. Pure-TS/Node today. License: **BUSL-1.1** (GPL deps are a problem; MIT/Apache are fine).

Scope for this scan: what is **black-box usable** (request-byte rewrite only, no change to caller semantics) and **license-clean** for MESH to depend on or copy.

---

## Verdict up front

The highest-leverage, lowest-risk win is **TOON** (structured-data → token-dense serialization): MIT, pure TypeScript, trending hard, and it is exactly a "rewrite the request bytes" transform that fits a lossless-first proxy — the decode is deterministic, so savings are *verifiable*, which is the whole MESH billing premise.

Accurate **token counting** (gpt-tokenizer / js-tiktoken) is a dependency MESH almost certainly already needs to meter savings honestly for OpenAI-compatible traffic.

The **LLMLingua** family is the famous name in "prompt compression," but it is **lossy, model-based, Python-origin, and ships a 57 MB–2 GB ML model** — it does *not* fit a lossless-first black-box proxy and should be treated as study-only, not a dependency.

---

## Repos (ranked)

### 1. TOON — `toon-format/toon`  ⭐ ~25.6k · MIT · TypeScript
Token-Oriented Object Notation. Compact, human-readable re-serialization of the JSON data model (indentation + tabular form for uniform arrays). `encode(json)` / `decode()` round-trips.
- **Benchmarks (their numbers):** ~40–43% fewer tokens vs JSON on mixed structured data (244 retrieval Qs across 4 models), with equal-or-better retrieval accuracy; ~33% vs JSON on a mixed-structure track. Flat tabular data is ~6% *worse* than CSV but adds length/field-list guards.
- **What MESH borrows:** a drop-in request-body transform for the common case of structured data (tool outputs, RAG chunks, JSON arrays) embedded in prompts. Deterministic decode means the savings are provable → feeds the verified-savings ledger directly. Can **adopt as a dependency** (`@toon-format/toon`) or **copy the encoder pattern** if BUSL hygiene wants zero runtime deps.
- **Caveat / honest fit:** only helps when the payload actually contains JSON-ish structured data; it is not general prose compression, and it is not *always* a win (flat tables lose to CSV). MESH must gate it on a token-count check (encode both, keep the smaller) so it never *costs* tokens — which is also what makes the saving measurable.
- **Effort:** adopt-as-dep (low) / copy-pattern (medium).

### 2. gpt-tokenizer — `niieani/gpt-tokenizer`  ⭐ ~857 · MIT · pure JS
Fastest low-footprint pure-JS tokenizer. Supports all OpenAI encodings incl. `cl100k_base` and `o200k_base` (GPT-4o / GPT-5 / o-series). `countTokens()`, `isWithinTokenLimit()`, per-model entry points for small bundles. No native deps.
- **What MESH borrows:** exact, local, pre-flight token counting for OpenAI-compatible traffic — the measurement layer under "verified savings." Lets the proxy compute before/after token deltas without a round-trip and decide whether a rewrite (e.g. TOON) is net-positive before sending.
- **Caveat:** OpenAI vocab only — **no Claude/Anthropic** support. For the Claude-first path, pair with Anthropic's own `count_tokens` API / SDK (authoritative counts) and treat tiktoken as an estimate only.
- **Effort:** adopt-as-dep (low).

### 3. js-tiktoken — `dqbd/tiktoken` (js)  ⭐ (part of ~4k repo) · MIT · pure JS port + WASM option
OpenAI's BPE vocab in JS. `js-tiktoken` is the pure-JS build (3M+ weekly downloads, universal compat); `@dqbd/tiktoken` is a WASM build with higher large-text throughput on Node backends.
- **What MESH borrows:** the alternative / fallback tokenizer dependency to gpt-tokenizer — pick one. js-tiktoken wins on ubiquity and trust; gpt-tokenizer wins on bundle size and short-text speed. Either satisfies the metering need.
- **Caveat:** same OpenAI-only limitation; redundant with #2 — choose one, don't ship both.
- **Effort:** adopt-as-dep (low). Mostly listed so the choice is explicit.

### 4. LLMLingua / LLMLingua-2 — `microsoft/LLMLingua` (⭐ ~6.8k, MIT, Python) + JS port `atjsh/llmlingua-2-js` (⭐ ~33, MIT, TS)
The reference "prompt compression" stack: a small BERT-class model classifies and drops low-information tokens, claiming up to ~20x compression. The JS port runs in Node/browser via `@huggingface/transformers` + `js-tiktoken`.
- **Why it is NOT a fit for MESH's core:** (a) **lossy** — it deletes tokens, changing prompt semantics; incompatible with a lossless-first, "we didn't change your meaning" proxy and with provable savings. (b) **model-dependent** — downloads 57 MB (TinyBERT) to 2.2 GB (XLM-RoBERTa) and runs inference per request; heavy for a thin gateway, and the compute cost can exceed the token saving. (c) Python-origin; the JS port is immature (33 stars, experimental) and pulls a large transformers runtime.
- **What MESH could borrow (later, opt-in only):** the *idea* of an explicitly-opt-in, clearly-labeled lossy tier ("aggressive mode") for users who accept it — but only behind a consent flag, never as a default, and never billed as lossless savings. Study the token-classification approach, don't depend on it.
- **Effort:** study-only (the Python repo) / reject as a core dependency (the JS port).

### 5. awesome-llm-token-optimization — `pleasedodisturb/awesome-llm-token-optimization`  · MIT · curated list
Curated index of token-cost-reduction strategies, tools, papers, and production resources.
- **What MESH borrows:** a ready-made landscape map to keep this scan fresh — a cheap place to re-scan for new lossless transforms, caching/dedup patterns, and tokenizer updates without re-searching from scratch.
- **Effort:** study-only (reference).

---

## Recommendation for MESH

1. **Ship TOON as the first structured-data lever** behind an "encode-both, keep-smaller, record-delta" gate — it is the one here that is simultaneously black-box, lossless (round-trippable), measurable, and MIT. Favour **copy-pattern** over dep if you want zero runtime deps under BUSL.
2. **Adopt one tokenizer** (gpt-tokenizer *or* js-tiktoken) for OpenAI-compatible metering; use **Anthropic's own token-count API** as the authority on the Claude path. This is the measurement spine of verified savings.
3. **Do not** wire LLMLingua into the default path. If a lossy tier is ever offered, it must be opt-in, labeled, and excluded from lossless-savings billing.

**License summary:** every recommended item (TOON, gpt-tokenizer, js-tiktoken, the awesome-list) is **MIT** → clean to depend on or vendor under BUSL-1.1. No GPL encountered in the recommended set. LLMLingua is also MIT but rejected on *technical/product* grounds (lossy + heavy model), not license grounds.
