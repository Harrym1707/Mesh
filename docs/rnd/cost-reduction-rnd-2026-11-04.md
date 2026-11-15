# Cost-reduction R&D — new candidate levers (2026-11-04)

Produced overnight 2026-11-04 by a research team of 8 agents (one grounding synthesis +
7 avenue researchers doing live web research): response-level caching, provider-native
cost features, output/reasoning reduction, request packing, model cascades/routing,
prompt/context compression, and RAG/retrieval efficiency. Each avenue returned structured
candidates with primary sources; this document synthesises, ranks, and de-duplicates them
against the shipped catalogue and the standing backlog.

**Scope discipline.** This is a *candidate* report. Nothing here is billable; every factor
is a hypothesis for the replay/trajectory gate to prove or disprove on the customer's own
traffic. No product code under `packages/` was modified. Basis labels on every number:
`measured` / `literature-claim` / `derived` / `provider-doc` / `reasoned` / `unmeasured`.

**De-dup baseline.** Candidates were checked against three things that already exist, not
just `PUBLISHED_LEVERS`:
- the shipped catalogue in `packages/core/src/savings-model.ts`;
- the shipped SDK features — notably `ExactResponseCache` (`packages/sdk-js/src/exact-cache.ts`),
  static replay-gated model substitution (`docs/COST_QUALITY_ROUTING.md`), and the Theo
  enforceable levers `fresh-tool-result-cap`, `stale-history-compaction`,
  `cross-turn-memory-dedup`, `cache-prefix-repair`, `execution-tier-flex`, the cache-TTL
  and output-effort groups (`packages/sdk-js/src/theo-policy.ts`);
- the standing backlog and fundamentals mines (`docs/rnd/lever-backlog.md`, the 2026-10-28
  inference-cost-structure and output-token-reduction mines, the token-efficiency scout).

The honest headline: **this is a mature catalogue.** Four of the seven avenues (output,
RAG, compression, cascades) returned essentially *no* shippable lever that beats what is
already catalogued — a finding in itself, recorded in §4 and §5. The genuinely-new money
is concentrated in **three places**: call-elimination that the proxy does not yet do
(coalescing, packing), a provider-native tool-loading mechanism that has matured past the
flaw that sank `progressiveDisclosure`, and two uncatalogued provider rate features.

---

## 1. Shortlist to prototype first (ranked)

Ranking = honest expected impact × confidence in the measurement path × fit with the
transparent, answer-preserving, verified-savings product.

### S1. Anthropic Tool Search / `defer_loading` — provider-native tool-definition deferral

**The single best new lever for the tool-heavy-agent vertical**, because it delivers
`progressiveDisclosure`'s prompt win *without* the round-trip penalty that makes
`progressiveDisclosure` net-negative in production.

- **Mechanism.** Inject Anthropic's `tool_search` tool and mark the long tail of the
  catalogue `defer_loading: true`, keeping 3–5 tools resident. The model searches for the
  definitions it needs; retrieval happens **server-side inside the same `/v1/messages`
  request**, so there is no extra client round trip and no sandbox.
- **Why it beats what we have.** `progressiveDisclosure` (reduction 0.91, `roundTripMultiplier`
  **1.5** → ~13% realised) and `codeMode` (0.9, needs a sandbox) both pay a structural tax
  to cut the catalogue. Tool Search is the same ~85%+ cut on tool-definition tokens with
  **no client hop** and **the cached prefix preserved** — it is the mechanism those two
  levers were approximating, now shipped natively.
- **Cost axis.** Token-COUNT, input side, `toolSchemas`. The full tools array is still sent
  each request, but deferred definitions are not expanded into the prompt until searched.
- **Honest band.** `literature-claim`: Anthropic's doc states a "~55k tokens in definitions
  … reduces this by over 85 percent" for a typical multi-server setup. Set the factor **≤ 0.80
  of deferred-definition tokens**, below the 85% claim, and apply it only to the deferrable
  tail (resident tools excluded). On cached turns the definitions already price at 0.05–0.10x,
  so the realised saving concentrates on cold/cache-miss turns — the same discipline the
  backlog imposes on all tool-schema levers. Realised factor is `unmeasured` until replay.
- **Risk.** `needs-verification`. It changes what the model sees and adds a server-side
  search step; Anthropic reports accuracy *rises*, but that is vendor-reported. Gate on a
  tool-selection / task-completion grader.
- **Transparency & round trips.** Mostly transparent: inject the search tool + `defer_loading`,
  keep 3–5 tools resident. `roundTripMultiplier ≈ 1.0` (retrieval is in-request). A deferred
  tool cannot carry `cache_control` (400 error), so the stamping path must place breakpoints
  on resident tools only.
- **Availability.** Stable on Opus/Sonnet/Haiku 4.5+ and all 5.x; **not on Bedrock Converse**
  — detect and suppress there.
- **Mesh encoding.** `id: tool-search-defer`, `targets: ["toolSchemas"]`, `reduction: 0.80`
  (of the deferrable tail), `roundTripMultiplier: 1.0`, `risk: needs-verification`.
  Source: platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool (2026-11-04).
- **Overlap.** Supersedes backlog T2 (deferred tool loading) with maturity data; it is the
  Anthropic-native, round-trip-free alternative to `progressiveDisclosure`/`codeMode`. Make
  the three mutually exclusive per route (apply the best-fitting one, never stack).

### S2. In-flight request coalescing (single-flight de-duplication)

The cleanest ethos fit in the whole report: **provably lossless, zero quality risk,
realised-only billing** — and it closes a gap the shipped exact-cache leaves open.

- **Mechanism.** When byte-identical requests (same normalised body + scope) are in flight
  concurrently, send **one** upstream call and fan the single response back to all callers.
  Classic single-flight / thundering-herd collapse.
- **Why it is new.** The shipped `ExactResponseCache` only serves a *completed, stored*
  response (`exact-cache.ts`); two identical requests that arrive before the first returns
  both miss and both bill in full. Coalescing covers exactly that concurrent window.
- **Distinct from P5 (fan-out serialization).** P5 holds *different* requests that share a
  *prefix* to convert cache writes into reads. Coalescing holds *identical* requests to make
  N−1 of them disappear entirely. Different mechanism, different evidence, complementary.
- **Cost axis.** Eliminates whole calls (all input + output on the collapsed duplicates).
  Not a segment shrink → a `call-elimination` class.
- **Honest band.** **Project 0; bill realised-only.** Basis: `unmeasured` — the one public
  hint is Cloudflare AI Gateway's note that two simultaneous identical requests may both miss.
  Duplicate-burst frequency is per-customer and unmeasured; quoting any percentage would be a
  guess. Each collapse is exactly verifiable (the stored call's provider `usage` × price), which
  suits 1%-of-verified-savings billing perfectly.
- **Risk.** Lossless when the original would have been deterministic. Inherit the exact-cache
  determinism gate (temperature 0 or seeded, or explicit opt-in): at temperature > 0, sharing
  one sample across callers freezes randomness, which is a visible behaviour change — so
  restrict to the same eligibility as `ExactResponseCache` and never coalesce tool-use,
  streaming, or `conversation`/`previous_response_id` requests.
- **Transparency & latency.** Transparent to the client; the held duplicates wait for the one
  in-flight response. **Adversarial conditions (load-bearing):** release-on-error immediately
  (a held request must not inherit the leader's 429/5xx); cap hold time under the client TTFB
  watchdog; never coalesce across tenant scope. A tripped client retry is a duplicate
  full-price call that erases the saving — the same failure mode P5 guards against.
- **Mesh encoding.** `id: inflight-coalescing`, class `call-elimination`, `reduction`
  projected 0 / realised measured, `risk: deterministic` (gated to deterministic-eligible
  requests), `roundTripMultiplier` effectively < 1 on collapsed bursts but modelled as
  realised-only.
- **Overlap.** Extends shipped `ExactResponseCache`; complementary to P5. No catalogue duplicate.

### S3. Request packing (multi-item batching in one call)

The **biggest genuinely-new token-COUNT lever**, and it owns the one-shot/varied vertical —
the vertical the R&D doctrine names as the easiest to prove and the best landing-page receipt,
and the one where prefix caching cannot help because there is no stable cacheable prefix.

- **Mechanism.** Pack K independent small items (classify/extract/tag) into one prompt as a
  numbered list; one call returns K numbered answers. The fixed overhead — system prompt,
  instructions, response schema, few-shot examples — is paid once per K items instead of K times.
- **Cost axis.** Token-COUNT, input side, `systemPrompt` (and the shared `toolSchemas`/response
  schema when identical per call). Reduces call count ~1/K. Per-item `userTurn` and `output`
  tokens do **not** shrink, so the saving is bounded by the fixed-overhead share of the bill.
- **Honest band.** `measured` (classification tasks, 2024-era models):
  - MPP (arXiv:2406.10786, 7 LLMs × 6 benchmarks): cost savings "ranged from **30.7% to 82.0%**"
    at the largest batch size holding ≥95% of single-item accuracy; mean accuracy 75.5%→72.3%
    (−3.2 pts).
  - BatchPrompt (arXiv:2309.00384): BoolQ tokens −82% at b=16, but naive accuracy fell
    (GPT-3.5 86.8%→77.5%); single-item accuracy recovered only with multi-round voting (which
    gives back much of the saving — do not adopt).
  - Batch Prompting (arXiv:2301.08721): "up to 5x" fewer tokens at b=6; b=3–4 is the balance.
  - ACL 2026 (arXiv:2603.22608, 16 LLMs incl. Claude Sonnet 4.6): slight degradation at 20–100
    instances, then collapse; instance count predicts the drop better than context length.
  - Set the factor at **0.50 on `systemPrompt`** — below the 1−1/K theory at K=3 (0.67) and
    below every measured token drop — gated to K=3–4, cap 8 pending replay. Realised is
    `unmeasured` on Claude 5.x (no first-party numbers found).
- **Risk.** `needs-verification`, lossy. Per-item accuracy moves (−1 to −20 pts by task/model/K);
  weak models, long inputs, and mixed unrelated tasks are worst. Shuffle item order in the
  replay check (position-bias evidence conflicts across papers).
- **Transparency — the honest limit.** **Not transparent by default.** A proxy cannot merge
  separate client calls without either (a) a held-window collector that packs and
  demultiplexes responses (high build; loses streaming and per-item output limits; one
  malformed item fails the call), or (b) an explicit Mesh batch endpoint/SDK the client sends
  an item array to (changes the contract). Ship (b) first; (a) is opt-in per route, deferred.
  Provider usage arrives per packed call → Mesh must apportion tokens across clients to bill.
- **Mesh encoding.** `id: request-packing`, `targets: ["systemPrompt"]` (+`toolSchemas` when the
  schema is shared), `reduction: 0.50`, **`roundTripMultiplier: 1`** — critically *not* 1/K: the
  multiplier scales the whole bill, and item/output tokens do not shrink, so the call-count win
  is already captured by the amortised-overhead reduction; encoding both double-counts it.
  `risk: needs-verification`.
- **Overlap.** Orthogonal to the Batch API (packing cuts tokens; Batch cuts price-per-token —
  they can stack in principle). Overlaps prefix caching **inversely**: where a stable cached
  prefix exists, the overhead already costs ~5–10% of face value and packing saves little, so
  cut the factor toward 0 there. Packing wins where caching cannot: one-shot/varied, sparse
  traffic (5-minute TTL expiries), sub-minimum prefixes, or no-caching providers.

### S4. GPT-5.6+ cache-write hygiene (explicit-mode write avoidance)

Deterministic, transparent, provider-native, and **timely**: GPT-5.6 introduced an automatic
cache-write premium that did not exist before, which partially invalidates the "no write
premium pre-5.6" assumption behind backlog P3.

- **Mechanism.** From GPT-5.6, OpenAI bills cache writes at **1.25x** uncached input (30-minute
  lifetime), apparently **even for automatic caching** (verify with one live payload). Setting
  `prompt_cache_options.mode: "explicit"` with no breakpoint means no caching and no write. So
  for a prefix unlikely to be reused inside the TTL, suppress the write to avoid the 25% surcharge.
- **Cost axis.** Token-COST, input, cached-vs-uncached. Eliminates no calls.
- **Honest band.** `derived` from provider multipliers: avoiding a never-reused write saves
  ~20% of that prefix's input cost (1.25→1.0). Break-even for a "defer the write to the second
  sighting" policy: reuse probability p < ~22% (from 1.0 + 1.25p < 1.25 + 0.1p). The fleet share
  of never-reused prefixes is `unmeasured` — quote no portfolio figure. Bill observed-minus-
  counterfactual only, since automatic caching is itself the counterfactual (same attribution
  discipline as P3).
- **Risk.** `deterministic` — same tokens, different rate, output unchanged. Needs prefix-reuse
  history in the proxy to decide.
- **Transparency & latency.** Transparent (add `prompt_cache_options`/breakpoints). No latency
  cost for explicit mode; the `prewarm` option adds a billed, output-less request and saves no
  money (reject it, as the backlog rejects max_tokens:0 prewarms).
- **Usage fields (answers backlog open-Q5).** `cache_write_tokens`;
  `cache_write_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens`; `cached_tokens` counts billed
  reads only. Source: developers.openai.com/api/docs/guides/prompt-caching (2026-11-04).
- **Mesh encoding.** `id: openai-cache-write-avoidance`, `targets: ["systemPrompt","toolSchemas"]`
  (the stable prefix), effect = avoid the 0.25x write premium on never-reused prefixes,
  `risk: deterministic` + attribution caveat.
- **Overlap.** Extends backlog P3 and open-Q5; a sibling of the Anthropic TTL work (P2). The 12h
  OpenAI lifetime (2.5x write, Responses API only) is a direct P2-style TTL-selection port.

### S5. Gemini Flex — synchronous 50% tier (new rate-arbitrage sibling)

Opens the Gemini arm's rate ladder beyond the Batch API the 2026-10-28 mine already noted, and
it is **synchronous**, so a far lower latency ceiling than async batch.

- **Mechanism.** `service_tier: "flex"` gives "a 50% cost reduction compared to standard rates"
  on a synchronous call with a 1–15 min latency target. Requests are sheddable: a 429/503 is
  **not** auto-promoted to Standard, so the proxy must retry/fall back.
- **Cost axis.** Token-COST, whole request (same model, same bytes, timing/availability only).
- **Honest band.** `provider-doc`: 0.5 on routes tagged latency-tolerant, **only on tokens
  actually served on Flex**; unserved attempts that fall back to Standard get nothing. Billing
  of failed 429/503 attempts is unstated — verify before billing. Routable fleet share
  `unmeasured`. Source: aistudio.google.com/docs/flex-inference (2026-11-04).
- **Risk.** `deterministic`. **Adversarial conditions:** explicit per-route opt-in disclosing
  up-to-15-min (unbounded under shedding) latency; retry-to-Standard logic; served-tier
  verification (whether the response echoes the served tier is unconfirmed for Gemini —
  unverifiable = unbillable, same rule as backlog T5).
- **Transparency.** Needs a Gemini `generateContent` route, which **does not exist yet**
  (backlog line ~183) — so this is architecture-gated, not drop-in.
- **Mesh encoding.** `id: gemini-flex`, class `rate-arbitrage`, whole-request, `reduction: 0.5`
  on served latency-tolerant tokens, `risk: deterministic`.
- **Overlap.** Same lever class as Anthropic/OpenAI Batch (P1) and OpenAI flex (T5); it is the
  Gemini synchronous sibling. One lever class, parameterised by interface, per the 2026-10-28
  fundamentals framing.

---

## 2. Why this shortlist, in one paragraph

**S1 (Tool Search)** is first because it is the highest-impact lever for the highest-priority
vertical (tool-heavy agents), it is provider-native (low build, no sandbox), and it is the
round-trip-free version of a win the catalogue currently buys at a loss. **S2 (coalescing)** is
second because it is the purest fit for the product — lossless, realised-only, impossible to
overstate — and it is a small extension of code that already ships. **S3 (packing)** is third:
the biggest new token-COUNT lever and the one-shot vertical's receipt, but it is lossy and needs
a collector/endpoint, so it carries more build and gate risk. **S4 (OpenAI write hygiene)** and
**S5 (Gemini Flex)** are deterministic provider-native wins that extend existing rate/caching
work; both are clean but each is gated (S4 on one live-payload verification, S5 on a Gemini
route). S1–S2 are the two to build first.

---

## 3. Second-wave / pursue-with-conditions

- **Columnar / keys-once JSON re-serialization** (TOON-family). Rewrite uniform object arrays
  in tool results / retrieved JSON so keys appear once (valid JSON: `{"cols":[...],"rows":[[...]]}`),
  or CSV/markdown-table. Pure-TS, ~50 lines, no model, no licence issue. Band: `measured`
  ~−10% on the *matched sub-payload only* (Mesh's own A2 measurement: on 243 real tool_results,
  +10.7% on the 30% with uniform arrays, −8.7% on the other 70% — so an "encode both, keep
  smaller, record delta" guard is mandatory). Blended end-to-end impact is low single digits.
  `risk: needs-verification` (information-lossless but behaviour-affecting: Haiku-class and
  small models move several points; independent TOON tests found no consistent accuracy win).
  `targets: ["retrievedContext","history"]`, `reduction: 0.10`. Ship as the tabular branch of a
  TOON-family lever, not a headline. Beats TOON on *risk* (no new notation, no "prompt tax"),
  not on tokens.

- **Semantic response cache** — experimental, opt-in, **not in the default catalogue**. Return a
  cached answer for a semantically-similar query (embedding similarity). Decisive counter-evidence
  for our traffic: LiteLLM's own docs say semantic caching "is designed for single-shot prompts"
  and on agentic/multi-turn traffic "will replay stale responses" (consecutive turns embed at
  ~0.99 similarity; raising the threshold does not fix it). vCache (arXiv:2502.03771) is the only
  source with a correctness guarantee: 18.1% hit rate at a 1% error bound. Project 0; defensible
  only for opted-in single-shot endpoints (FAQ/classification), gated behind shadow-mode
  measurement. A false hit returns a *wrong answer*, which is worse than a missed saving.

- **Near-duplicate / cross-turn retrieval dedup** — extends `duplicateContextRemoval` from exact
  to (a) near-duplicate overlapping chunks and (b) chunks already present in earlier turns.
  Byte-exact cross-turn dedup (arXiv:2605.09611) measured 0.16% (clean single retrieval) → 24%
  (enterprise) → 80% (multi-turn WildChat) — so the existing 0.1 factor only holds as a
  *measured-per-customer* number, never a general prior. Near-dup (cosine) is lossy (can merge a
  topically-similar chunk that differs on a key fact — arXiv:2607.24332). **Action:** check in
  code whether `duplicateContextRemoval` / `cross-turn-memory-dedup` already match a retrieved
  chunk across turns; if so this is covered. Keep exact=`deterministic`, near-dup=`needs-verification`,
  no fixed factor.

- **Terse-reasoning prompt injection (one lever: CoD / SoT / Concise-CoT)** — append a terse-
  reasoning instruction to compress the visible chain-of-thought. `measured` but narrow: Chain of
  Draft (arXiv:2502.18600) GSM8K −79% tokens at −4.3 pts accuracy (GPT-4o/Claude 3.5 Sonnet, 2024
  models); Sketch-of-Thought (arXiv:2503.05179) −69% to −76% at ≤1 pt; the zero-shot form (no
  few-shot exemplars) is much worse (Claude 3.5 Sonnet 90.4%→65.5% on GSM8K zero-shot CoD).
  Factor **≤ 0.40 of the CoT-bearing output share only**, set from replay. `risk`: high,
  **trajectory/task-completion gate mandatory** (per-request replay cannot see turn inflation),
  **opt-in**, English-leaning. Lower-tier because: the prior output-token mine leaned reject, all
  evidence is non-reasoning-mode 2024 models (prompt length-control is documented *unreliable* on
  R1/reasoning models — arXiv:2504.07128, 2503.04697), few-shot exemplars add input cost that must
  be netted out, and it overlaps the `outputBudget` effort governor conceptually. Fold CoD/SoT/
  Concise-CoT into ONE lever, not four.

- **Few-shot exemplar trimming** — detect over-provisioned demonstrations (≥8 `<example>` blocks)
  and trim to the minimum that holds accuracy on replay. `targets: ["systemPrompt"]`,
  `reduction: 0.15` (`derived`: keeping 5 of 8 ≈ −37.5% of exemplar tokens ≈ ~19% of segment if
  exemplars are half of it), `risk: needs-verification`. Token savings are `unmeasured` in any
  published source (LangChain: "3 dynamic examples matched or beat 13" — a quality finding, not a
  cost one). Keeps the prefix stable, so cache-safe. Dynamic per-query selection is **advice-only**
  (breaks prefix caching, needs an embedding call).

- **GPT-5 `verbosity` dial** — a provider output-length parameter distinct from `reasoning_effort`,
  possibly uncatalogued. One measured point (gpt-5-mini poem: low 560 / medium 849 / high 1288
  tokens → low ~34% below medium). No published factor; measure-first. **Fold into the
  `outputBudget`/effort-governor family**, not a standalone lever.

- **Extended threshold-cliff table** — the 2026-10-28 B.3 "threshold arbitrage" class extends to
  more providers: xAI grok-4.20–4.7 doubles *all* tokens at 200k; OpenAI has a 272k cliff (input/
  cached 2x, output 1.5x). `provider-doc`. Same band-edge detector, hysteresis, and lossless-vs-
  lossy-crossing rules as B.3. Extends an existing class; not a new lever.

- **OpenAI 12h cache-TTL selection** — 2.5x write vs 1.25x for 30 min, reads equal; break-even at
  ~1.09 revisits with >30-min gaps inside 12h. Direct port of P2's gap-histogram policy to OpenAI
  multipliers (Responses API only). Extends P2.

- **xAI / Mistral / Bedrock cache + tier arbitrage** — provider-native analogues of P1/P3/T5
  (xAI 75% cached read on 4.6/4.7, `prompt_cache_key` affinity; Mistral 90% cached + 50% batch;
  Bedrock four `service_tier`s incl. flex −50% / priority +75%, with `ResolvedServiceTier` giving
  served-tier verification — closing backlog open-Q9 for Bedrock). Incremental, `unmeasured`
  fleet share. One rate-arbitrage class, parameterised by provider.

---

## 4. Hygiene / diagnostics (surface to the customer; not billable savings levers)

These are visibility features, not reductions. The honesty rule: a converted no-op or an avoided
premium that the provider already gives free is hygiene, never a lever record.

- **Predicted-outputs waste flag.** Compute `rejected_prediction_tokens × completion price` from
  usage and flag customers paying for it. (Predicted Outputs itself is rejected as a cost lever —
  see §5.)
- **Tool-use overhead audit.** Tool-use system-prompt tokens per request (286 on Opus/Sonnet/Haiku
  5.5; `tool_choice: any|tool` costs ~120–130 more than `auto`). Fixed overhead to surface.
- **Silent-repricing alerts.** Gemini 2.5 Pro/Flash reroute to 3.x models on 2026-12-01 at higher
  rates; Anthropic tokenizer inflation (Opus 4.7+ "~1x–1.35x as many tokens"; Fable/Sonnet 5 ~30%
  more) makes cross-generation per-token price comparisons unreliable and matters for
  `COST_QUALITY_ROUTING.md`; deprecations (Opus 4.8 fast mode removed 2026-11-30). Alert, never
  auto-act.

---

## 5. Rejected — with reason (killing is a finding)

- **Exact-request response cache as "new"** — it is **already shipped** (`ExactResponseCache`,
  per-tenant, TTL, excludes streaming/tools/`conversation`). Not a candidate; the real gap it
  leaves (concurrent duplicates) is S2.
- **Live per-request model cascades / routing (FrugalGPT arXiv:2305.05176, RouteLLM
  arXiv:2406.18665)** — changes the answerer, so out of the transparent answer-preserving default.
  The independent LLMRouterBench (arXiv:2601.07206, 400k instances, 33 models) finds commercial
  routers "fail to reliably outperform a simple baseline"; the big published numbers (85–98%) are
  2023-era classification or bought with 3–6 accuracy points; and per-turn switching busts the
  prompt-cache prefix (TurnCost arXiv:2610.15093: a weak model at 20% list price is a *net loss*
  once caching is counted; per-step FrugalGPT/RouteLLM/Hybrid give "only 31–44%"). Mesh already
  ships the one defensible form — **static, replay-gated, per-task-class substitution with
  baseline fallback** (`docs/COST_QUALITY_ROUTING.md`). Do not add a live scorer/judge cascade.
- **OpenAI Predicted Outputs as a cost lever** — rejected tokens are billed at completion rates;
  best case (100% accurate prediction) is cost-*neutral*, and any divergence raises cost (measured
  N=1: 37% faster, **72% more expensive**). It is a latency feature, not a cost lever. Keep only
  the waste flag (§4).
- **Anthropic token-efficient tool use** — dead: built into Claude 4+ and the
  `token-efficient-tools-2025-02-19` header "has no effect". Billing it charges for a saving the
  provider gives free. Only a Sonnet 3.7 holdout would benefit; none evidenced.
- **Constrained / grammar decoding for token cuts** — the published "token savings" are
  fast-forwarded tokens on *self-hosted* engines (a latency/compute effect); a hosted API bills
  the output either way. No billed-token reduction for an API consumer.
- **Learned prompt compressors (CPC arXiv:2409.01227, Provence arXiv:2501.16214, Squeez
  arXiv:2604.04979, ACON arXiv:2510.00615, EXIT)** — all need a 0.4B–7B model (GPU) and/or extra
  LLM calls; several have non-commercial or unconfirmed licences (Provence CC BY-NC-ND). Mesh is
  pure-TS/BUSL-1.1 and bundles no model. Study-only reference ceilings. The LLMLingua-2-JS port
  exists (MIT) but ships 57MB–2.2GB ONNX models and has no quality validation.
- **Soft-prompt / gist-token / KV methods (ICAE, AutoCompressor, Gist, 500xCompressor, xRAG)** —
  need model internals or fine-tuning; cannot be sent as text to a provider API. Not black-box.
- **Deterministic lexical / POS prompt compression** — negative evidence. CAVEWOMAN
  (arXiv:2606.24083): a telegraphic filter saved ~15 input tokens but GPT-4o GSM8K fell 89.8→74.4,
  models answered *longer*, and net cost **rose ~1.15x (up to 1.8x)** because output tokens cost
  several times input. Referential dangling (arXiv:2608.04569): hard compressors split dependent
  evidence in up to 60% of multi-hop examples. Never apply input compression to `userTurn` for
  reasoning tasks.
- **Cache-Augmented Generation (CAG), Contextual Retrieval, late chunking** — index/architecture-
  side, outside a request-path proxy's reach. CAG cannot be synthesised by the proxy and the RAG
  counterfactual is unobservable after a switch (unbillable). Contextual Retrieval *adds* ~50–100
  tokens/chunk and Anthropic's own post says top-20 beats top-5/10 — zero token saving. At most a
  doc-only advisory (CAG break-even ≈ corpus < ~10× retrieved context, queried ≥ every TTL).
- **max_tokens right-sizing as a billable lever** — already demoted to a circuit breaker; its only
  savings mechanism is truncation, which is failure.
- **TALE-EP budget-estimation** — adds a round trip (an estimation call whose token cost the paper
  never reports) and is fragile below a reasonable budget. Do not encode separately; the insight
  lives in the effort dial.

---

## 6. De-dup matrix (candidate → nearest existing thing)

| Candidate | Nearest existing | Verdict |
|---|---|---|
| S1 Tool Search / defer_loading | backlog T2; `progressiveDisclosure`/`codeMode` | **New, supersedes T2** — round-trip-free, native |
| S2 In-flight coalescing | `ExactResponseCache`; P5 fan-out | **New** — covers the concurrent-duplicate gap |
| S3 Request packing | Batch API; prefix caching | **New** — orthogonal; owns the no-stable-prefix case |
| S4 OpenAI write hygiene | P3; open-Q5 | **New, extends P3** — post-GPT-5.6 write premium |
| S5 Gemini Flex | P1/T5 rate-arbitrage | **New sibling** — synchronous Gemini 50% |
| Columnar JSON | TOON scout | Branch of TOON-family, not a duplicate |
| Semantic cache | — | New but experimental/opt-in only |
| Near-dup / cross-turn dedup | `duplicateContextRemoval`, `cross-turn-memory-dedup` | Extends; check code first |
| Terse-reasoning injection | `outputBudget`; 2026-10-28 output mine | New mechanism, prior mine leaned reject |
| Few-shot trimming | `promptCompression` | New, modest, systemPrompt |
| GPT-5 verbosity | `outputBudget` | Fold into effort family |
| Threshold cliffs (xAI/OpenAI) | 2026-10-28 B.3 | Extends existing class |
| OpenAI 12h TTL | P2 | Port of P2 |
| Routing/cascades | `COST_QUALITY_ROUTING.md` | Already shipped in its defensible form |

---

## 7. Repo-accuracy finding (recommended correction, not applied here)

The compression avenue found the `promptCompression` evidence citation in
`packages/core/src/savings-model.ts` (lines ~250–257) **misattributes** the "up to 20x" claim to
arXiv:2403.12968 (LLMLingua-2). The 20x figure is from LLMLingua-**1** (arXiv:2310.05736);
LLMLingua-2's own published range is 2x–5x (max ~14x on GSM8K demonstrations only). The current
factor (0.5 ≈ 2x) is still conservative on *ratio*, but the quality claim belongs to a different
paper, and an independent audit (arXiv:2608.26175) puts LLMLingua-2's retained context utility at
0.74–0.82 at 2x on English and near-collapse on non-English — so the `needs-verification` risk
class is correct and the lever should be **gated to English-dominant traffic**. Flagged for a
product-code change under separate review (no `packages/` edit was made in this R&D pass).

---

## 8. Open questions needing live spend or customer traffic (new, ranked)

1. **One live GPT-5.6 payload** — confirm whether *automatic* cache writes bill the 1.25x premium
   (gates S4) and settle the `cache_write_tokens_details` field semantics.
2. **Duplicate-burst frequency per customer** — arrival-timestamped proxy logs for identical
   requests (gates S2's entire volume; same timestamp dependency as P5).
3. **One-shot classification/extraction traffic sample** — fixed-overhead share and per-item
   replay agreement on Claude 5.x (gates S3's factor; no first-party packed-prompt numbers exist).
4. **A Gemini `generateContent` route + served-tier verification** — whether the response echoes
   the served tier (gates S5 billing).
5. **Code-block / uniform-array share of customer context** — gates the columnar and code-format
   branches (Mesh's own 243-payload sample: only 30% had a uniform array).

---

*Basis note: every number above carries its label. Where a factor is "project 0 / realised-only"
that is deliberate — the honest number for a call-elimination lever whose volume is unmeasured is
the one the ledger reports after the fact, never a pre-sale percentage. Negative outcomes net
against Mesh in the ledger; nothing here is billable ahead of its conditions.*
