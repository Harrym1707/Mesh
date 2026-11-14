# Scout — LLM Gateways & Proxies

**Area:** llm-gateways-proxies
**Date:** 2026-10-29
**For:** MESH (transparent LLM cost-reducer: proxy/gateway + SDK shim, token reduction, hash-chained savings ledger, 1% billing on verified savings). Pure-TS/Node today. BUSL-1.1.

## Verdict

**Portkey Gateway is the one to mine.** It is the only top-tier, actively-maintained, provider-agnostic gateway that is (a) **TypeScript/Node** — MESH's exact stack, so patterns are copy-pasteable, not translatable — and (b) **MIT-licensed**, so we can lift components into a BUSL-1.1 codebase without friction. It also ships a Cloudflare Workers deploy path, which is directly relevant to MESH's "deploy blind into any environment" hosted-gateway goal. Everything else is a study-only reference because of language (Go/Rust/Python) or license (GPL).

License fit recap for MESH (BUSL-1.1 distributor):
- **MIT / Apache-2.0** → fine to depend on and to copy code from (with attribution).
- **GPL-3.0** → problem. Do **not** vendor or link code; study architecture/behaviour only. (Helicone's `ai-gateway` is GPL-3.0.)

---

## 1. Portkey Gateway — `Portkey-AI/gateway`  ★ ADOPT / COPY-PATTERN

- **URL:** https://github.com/Portkey-AI/gateway
- **Traction:** ~13.3k stars; very active (Gateway 2.0 shipped Mar 2026; Portkey acquired by Palo Alto Networks May 2026, OSS gateway continues under the same license).
- **License:** **MIT** (verified against the repo's LICENSE file — note: some blog posts say "Apache 2.0 as of Mar 2026"; the actual LICENSE file is MIT, copyright Portkey Inc. Confirm the exact SHA you vendor from, but either way it is permissive and fine for BUSL).
- **Stack:** TypeScript/Node, deploys to Node, Docker, and **Cloudflare Workers** (`wrangler.toml`).
- **What it does:** Blazing-fast AI gateway routing to 1,600+ models behind one OpenAI-compatible API, with fallbacks, retries, load-balancing, caching, and 50+ guardrails. Config-driven (JSON) routing.
- **What MESH borrows (concrete):**
  1. **Provider-adapter pattern** (`src/providers/*`): each provider is a module that maps the unified OpenAI-shaped request → provider-native request and the provider response → unified response. This is exactly the transform layer MESH needs to stay "provider-agnostic (OpenAI-compatible + Anthropic)". Copy the adapter interface shape; we already lean Claude-first so we'd only need a handful.
  2. **Streaming passthrough**: Portkey proxies SSE streams transparently while still parsing usage/`finish_reason` out of the final chunk. MESH needs this to meter savings on streamed responses without buffering the whole body — study their chunk-tee approach.
  3. **Config-driven routing object** (`retry`, fallbacks, weights): a clean schema for per-request policy. MESH can model its gating/lever config on this shape.
  4. **Cloudflare Workers deploy target**: a real, worked example of running the same TS gateway at the edge — directly useful for standing up `gw.mesh-technology.com` without hand-rolling infra.
- **Effort:** Low-to-medium. Same language + MIT means adapter and streaming code can be adapted directly rather than reimplemented.

## 2. LiteLLM — `BerriAI/litellm`  ★ STUDY / COPY-PATTERN (behaviour only)

- **URL:** https://github.com/BerriAI/litellm
- **Traction:** ~45–60k stars; ~96M monthly PyPI downloads. The de-facto standard; heavily maintained.
- **License:** **MIT** (fine).
- **Stack:** **Python** (library + self-hosted proxy). Different stack from MESH, so this is a behaviour/spec reference, not a code dependency.
- **What it does:** One OpenAI-compatible interface over 140+ providers / 1,890+ models; proxy adds virtual keys, cost tracking, fallbacks, caching, RBAC.
- **What MESH borrows (concrete):**
  1. **Provider + model mapping tables** and the **cost/usage accounting model** — LiteLLM has the most exhaustive, battle-tested per-model token-price and usage-normalisation data and logic. MESH's "meter savings → ledger" needs exactly this normalisation (prompt/completion/cached token counting across providers); use LiteLLM's model map as the canonical reference to validate MESH's own numbers.
  2. **Virtual-key + spend-tracking proxy design** as a product reference for how teams expect onboarding/metering to feel.
- **Effort:** Medium (reimplement in TS; MIT lets us port logic and data tables with attribution).

## 3. Bifrost — `maximhq/bifrost`  ★ STUDY (architecture)

- **URL:** https://github.com/maximhq/bifrost
- **Traction:** Rapidly growing; aggressive, reproducible benchmarks (claims 9.5x throughput / 54x lower P99 than LiteLLM; <~11–200µs overhead at 5k RPS).
- **License:** Apache-2.0 (per project; **verify the exact file before any code reuse** — not verified in this pass). Go stack makes it study-only regardless.
- **Stack:** **Go**, OpenAI-compatible, drop-in proxy; also MCP/agent gateway.
- **What it does:** High-performance LLM gateway: failover, load-balancing across keys/providers, semantic caching, virtual keys, budgets.
- **What MESH borrows (concrete):**
  1. **Streaming-accumulator framework** idea — how to accumulate streamed chunks into a canonical response for metering while passing bytes through untouched. This is the performance-critical pattern for MESH's meter-on-stream path.
  2. **Low-overhead proxy architecture** as the bar: MESH's gateway must add negligible latency to be a credible "drop-in base URL". Their benchmarking harness (`maximhq/bifrost-benchmarking`, Vegeta + mock provider) is a ready-made methodology MESH can replicate to publish its own overhead numbers (trust-building for a cost-reducer).
- **Effort:** Study-only (Go → no direct reuse); architecture + benchmark methodology are the takeaways.

## 4. Helicone AI Gateway — `Helicone/ai-gateway`  ★ STUDY (behaviour; license blocks reuse)

- **URL:** https://github.com/Helicone/ai-gateway
- **Traction:** ~640 stars; **note: last functional commit ~July 2025, mostly a license change since** — momentum has stalled. The broader `Helicone/helicone` observability platform (~6.2k stars, Apache-2.0) is the maintained part.
- **License:** **GPL-3.0** on `ai-gateway` → **do not vendor or link**. Apache-2.0 on the main `helicone` repo.
- **Stack:** Rust reverse-proxy; drop-in via base URL `https://ai-gateway.helicone.ai`.
- **What MESH borrows (concrete, behaviour only):**
  1. **"Change one base URL" onboarding** executed cleanly — the exact frictionless install MESH is targeting. Study the UX/headers contract (how they pass auth + route selection via headers without breaking OpenAI clients), not the code.
  2. **One-line observability capture** model — relevant to MESH's provably-blind learning stream: how they attach metadata to a passthrough request without altering the payload the provider sees.
- **Effort:** Study-only. GPL-3.0 makes the gateway code off-limits; borrow the UX contract and base-URL ergonomics only.

## 5. LangDB AI Gateway — `langdb/ai-gateway`  ★ STUDY (architecture)

- **URL:** https://github.com/langdb/ai-gateway
- **Traction:** Smaller but active; enterprise-positioned.
- **License:** **Apache-2.0** (permissive — reuse would be fine if it were our stack).
- **Stack:** **Rust**, OpenAI-compatible, Docker + Cargo distribution.
- **What it does:** Governed enterprise gateway over 250+ models with tracing/analytics and **dynamic routing by cost and quality**, real-time cost control.
- **What MESH borrows (concrete):**
  1. **Cost-aware routing policy** design — MESH is fundamentally a cost story; LangDB's "route by cost/quality" decision model is a good reference for a future MESH lever that picks the cheapest adequate model.
  2. **Real-time cost-control / budget-enforcement** architecture as a reference for enforcing savings guarantees at the gateway.
- **Effort:** Study-only (Rust); Apache-2.0 keeps the door open if any component is ever reimplemented.

---

## Recommendation for MESH's hosted gateway

1. **Base the provider-transform + streaming-passthrough core on Portkey's adapter pattern** (same stack, MIT). This is the single highest-leverage borrow and de-risks the "any environment" goal.
2. **Use LiteLLM's model/cost tables** to validate MESH's token-savings accounting (MIT, port the data).
3. **Adopt Bifrost's benchmarking methodology** to publish MESH's own proxy-overhead numbers — credibility is core to a "we only bill verified savings" pitch.
4. **Mirror Helicone/LangDB's base-URL + header onboarding contract** so MESH is a true drop-in, without touching GPL code.
