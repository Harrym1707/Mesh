# Token-spend reverse-engineering — lever backlog

(Produced 2026-10-26 by the reverse-engineering workflow: 3 spend anatomists over real wire captures, 2 provider billing-mechanism inverters, 3 practice/literature miners, synthesis, and 3 adversarial reviews per top candidate. 34 agents, all verdicts recorded. This is the nightly R&D agent's standing queue.)


Standing queue for the nightly R&D agent. Every band carries its basis label (measured / derived-from-captures / literature-claim / reasoned / estimate). Adversarial conditions are load-bearing: a lever ships only when its conditions hold, and a condition that cannot be met converts the lever to killed.

---

## 1. Where the residual spend sits

The fixture-era picture ("output is 54–70% of post-MESH residual") is falsified: the 220/320-token output quantities in `evals/run-workload-matrix.ts` are fixture inventions, and the first measured ground truth (`docs/rnd/knowledge/2026-10-26-output-token-ground-truth.md`, 40 real agent trajectories, API-reported usage) puts cache reads at **51.6%** of a well-cached agent's bill, output at **29.3%** (with ~1.5x echo leverage — each output token is re-read ~27x downstream), and shows heavy right-skew (top 10% of turns carry 47–64% of output tokens). The honest residual map is therefore: (a) the **entire OpenAI arm**, where none of the validated Anthropic cache machinery runs and where the counterfactual is *automatic* caching, not zero caching; (b) **rate/tier arbitrage never exercised** — batch (documented 50%), flex, and premium-flag hygiene; (c) **cadence losses** — 5m-TTL expiries on >5m gaps and fan-out cache races, both currently invisible because no capture carries timestamps; (d) **output/reasoning tokens**, addressable only behind trajectory-level gates; and (e) **fat tool results in real agent loops**, plausibly large but currently unmeasurable because the fixtures omit them. Two substrate defects corrupt every number until fixed: the token counter's measured +28% prose / −13% JSON bias, and a cache simulator with no concurrency or TTL-expiry semantics.

---

## 2. PURSUE levers, ranked

Ranking = honest expected impact × confidence in the measurement path. Three adversarial verdicts per lever; all survived as pursue-with-conditions. Conditions below are the merged, deduplicated set — all are binding.

### P1. Batch-tier routing (Anthropic Message Batches + OpenAI Batch API), prewarm Anthropic-only

- **Mechanism**: Route customer-tagged latency-tolerant routes through batch endpoints at the documented flat 50% discount on all usage; for shared-context Anthropic batches, fire one *synchronous* 1h-TTL prewarm (max_tokens: **1** — zero is rejected at the wire) so items read the shared prefix instead of racing writes. Bytes identical; only transport and latency change.
- **Shapes**: batch-classification shape, nightly evals, bulk RAG indexing, queue-drained fan-outs. Never interactive traffic.
- **Class**: rate-arbitrage.
- **Honest band**: 50% on routed traffic is a published price, not an estimate (literature-claim, deterministic arithmetic on verbatim batch-results usage). The 0.05x stacked prefix figure is **Anthropic-only, best-case upper bound** (in-batch cache hits are documented best-effort); **OpenAI Batch applies no prompt-caching discount** — that stacking claim is corrected. Routable fleet share: unmeasured, per-customer, never quoted ("10–40%" deleted).
- **Measurement plan**: per-`custom_id` tier delta from provider-verbatim batch-results usage against the frozen signing-date schedule; expired items / sync fallbacks bill zero; prewarm's full undiscounted cost books as MESH-caused negative immediately; 50-item prewarm-vs-no-prewarm A/B before any stacked figure appears anywhere.
- **Adversarial conditions**: (1) **Cache-economics routing gate** — route to batch only when the route's trailing verbatim sync ledger shows worst-case batch cost (zero hits, full write premiums at 0.5x) strictly below realized sync cost; this mechanically excludes cache-hot shapes like the 2s-cadence classification loop, where batching *destroys* a warm 0.1x stream and the naive ledger would book the loss as savings. (2) Tier counterfactual fix: for batch events bill min(naive delta, delta vs a counterfactual granting the route its trailing sync cache-read ratio), inferred component labelled estimated-baseline, negatives net against MESH. (3) Dispatch stamped items only after the prewarm response shows `cache_creation_input_tokens > 0`; strip `cache_control` if dispatch will slip past TTL. (4) Live outcome monitor before billable rollout — completed-task parity vs sync baseline, expiry-rate auto-disable, queue-age telemetry; the consent tag is authorization, not a detector. (5) Exactly-once: `custom_id` = ledger `requestId`; `taskId` survives demux so failed-task poisoning spans transports; executionMode always from the response. (6) All-or-nothing per task; explicit per-route opt-in disclosing up-to-24h latency *and* provider-side persistence (OpenAI input files, Anthropic ~29-day retention) — blocked for ZDR customers absent explicit acceptance. (7) Byte-pin transform version + breakpoint placement across prewarm and all items of a cohort; record the shared-prefix hash. (8) Batch-results usage needs its own adapter in `provider-usage.ts`, live-verified for per-request cache-field itemization.

### P2. Cadence-aware Anthropic cache-lifetime policy (5m/1h selection + mixed-TTL layering; keep-alive pings last)

- **Mechanism**: Choose TTL per prefix from the proxy's observed inter-arrival histogram: <5m gaps keep 5m (free refresh); 5m–60m gaps layer 1h on the frozen system+tools core over 5m history (documented A/B/C split; 1h beats 5m-only from the first >5m revisit: 2.1x vs 2.5x at n=2); optional docs-sanctioned keep-alive pings for predicted 5–15m gaps. `cache_control` is metadata — model-read bytes identical.
- **Shapes**: human-paced chat, slow multi-agent rounds, resumed memory sessions, agents with >5m think gaps. Worthless on tight loops.
- **Class**: provider-mechanism (lossless; no replay gate).
- **Honest band**: per >5m revisit, 0.9x-minus-amortized-premium **vs the uncached customer request** — the single permitted counterfactual. The "~92% vs 5m rewrite" framing is killed (it measured against MESH's own losing policy; that slice is a *correction to the existing stamp lever's negatives*, never new billable savings). Portfolio number: computable **only from customer timestamps** — "fully computable from capture timestamps" is false, no capture carries timestamps (basis: documented multipliers + synthetic-gap ESTIMATE until then).
- **Measurement plan**: extend `cache-simulator.ts` with per-entry TTL expiry from request start, mixed-TTL split pricing, ping arms; replay with synthetic 2m/8m/45m schedules (labelled ESTIMATE); live verification from verbatim `usage.cache_creation` ephemeral_5m/1h split + `cache_read_input_tokens`, which `savings-ledger.ts` already prices with negatives netted, never clamped.
- **Adversarial conditions**: (1) TTL sticky per prefix hash — decided at first stamp from the gap histogram, never flipped mid-conversation; 1h requires ≥2 observed >5m revisits of that prefix (cold start stays 5m; mispredicted 1h ≈ 1.6x the exposure of a wasted 5m write). (2) Byte-identity assertion in the layered path: stamped request equals input modulo `cache_control`; fail closed to single-TTL 5m if layering would reorder blocks. (3) Live-verify before default-on: what a changed TTL marker on an already-cached prefix bills, and whether max_tokens:0 pings are accepted at all (Anthropic has historically required ≥1) — rides the ~$5 live export. (4) Pings ship last, opt-in, with a MESH-originated-spend ledger class (cost books negative at origination, earned back only by same-prefix reads; late ping books the full write premium against MESH), hard per-prefix/per-day caps, full error isolation from the client path, an RPM-headroom budget monitored *outside* the ledger (429 harm is invisible to spend netting — 429s on real traffic during ping windows are a kill signal), and suppression on documented-incompatible shapes (streaming, extended thinking, forced tool_choice, batches). (5) Ping eligibility gated on verbatim evidence of a prior cache write on that hash, never on the local token estimate (28% overcount). (6) Update `anthropicCacheableMinimumTokens` per P6 before gating 1h stamps. (7) Start recording arrival timestamps in proxy and all future captures.

### P3. OpenAI prompt-cache enablement — pre-5.6 core only (prefix-repair port + capped prompt_cache_key)

- **Mechanism**: Port cache-prefix repair (relocate volatile values, byte-stable serialization) to OpenAI-shaped requests to extend the *automatic* 0.1x cached prefix — no write premium pre-5.6, so a wrong repair costs cache misses, never money. Deterministic `prompt_cache_key` per stable prefix for routing affinity, rate-capped. The 128-alignment and GPT-5.6 stamping sub-levers are killed/blocked respectively (see §3 and conditions).
- **Shapes**: all five on the OpenAI arm; largest where stable prefix dominates.
- **Class**: provider-mechanism — but repair *reorders lines the model reads*, so under house rules the repair component is honestly **lossy-gate-required** for billing (see condition 2), even though pre-5.6 provider cost is loss-bounded.
- **Honest band**: **unknown-incremental, to be measured.** The quoted 20–60% transfer from the Anthropic arm is invalid twice over: the OpenAI counterfactual is automatic caching already running on raw traffic (Anthropic's is honestly zero because caching is opt-in and frameworks measurably place no stamps), and the only OpenAI model in the captures is gpt-4o whose cached-read ratio is **0.5x, not 0.1x** (`model-prices.ts`) — the transferred band overstates ~1.8x on precisely the evidenced traffic. Honest band = simulateCache(OPENAI_CACHE, repaired) − simulateCache(OPENAI_CACHE, raw), stated per model family. Basis: derived-from-captures once re-run; currently none.
- **Measurement plan**: add the OpenAI rule-set to `cache-simulator.ts` (partly shipped); replay the OpenAI arms of `frameworks-2026-10-25.jsonl` raw vs repaired; publish gross and incremental bands separately, quote only incremental. Validate the simulator's predicted `cached_tokens` against live verbatim usage within a stated tolerance before anything bills — until then the lever is record-only (the simulator encodes the same doc assumptions as the band, so simulator-only evidence can confirm but never falsify).
- **Adversarial conditions**: (1) Attribution before billing: verbatim `cached_tokens` measures *total* caching, not MESH-caused caching, and pre-5.6 the ledger routes it to never-billed `providerCacheAlreadyOwnedUsd`; bill only an observed-minus-counterfactual delta labelled estimated-baseline with simulator version + unmodified-prefix hashes on the event — or bill nothing and market it as unbilled customer value. (2) Repair reclassified as content-reordering: billable only behind the replay gate with date-anchor and ID-echo probes (PREFIX_BREAKERS false-positives — a date anchor demoted from prompt-opening to lost-in-the-middle — are exactly what the gate exists to catch); "lossless" reserved for transforms leaving the read token sequence identical. (3) `prompt_cache_key`: caller-flagged, per-stable-prefix (never fleet-wide), local per-key rate observer suppressing the stamp above ~15 req/min with headroom, plus a cached_tokens-rate regression monitor that auto-drops the key when hit rate falls below the unstamped trailing baseline — key-routing regressions are invisible in usage, which is why the gate exists; version-pin the claim. (4) The volatility guard does **not** port: rebuild conversation identity for Chat Completions (system travels as `messages[0]` — a per-turn clock there changes the conversation *key* every turn and the guard answers stamp:true forever); key on the first non-system message, watch leading system/developer messages as prefix; regression test derived from the LangGraph capture proving suppression by turn 2. (5) GPT-5.6 arm blocked until: one real 5.6 usage payload confirms write-premium field names (`cache_write_tokens_details` appears in no capture); `normalizeProviderUsage`, `LedgerUsage`, the price catalogue, and `auditEventPricing` all carry 30m/12h write classes (premiums priced at $0 by the current normaliser = automatic kill); caller-flagged per workload, never default; 1.30x minimum margin ported. (6) Note the Chat Completions limit honestly: repaired volatile tail still precedes the whole history in the serialized prompt, so repair recovers the system head, not the history.

### P4. Per-route effort governor (reasoning.effort + output_config.effort); max_tokens demoted

- **Mechanism**: Provider-sanctioned effort dials on opt-in templated/worker routes — OpenAI `reasoning.effort` down-tuning, Anthropic `output_config.effort` low/medium. The only lever class touching output spend. max_tokens right-sizing is **demoted to an unbilled runaway-cost circuit breaker** at/above p99.9 (its only savings mechanism is truncation, which is failure by definition — see §3).
- **Shapes**: multi-agent worker roles, batch classification, templated RAG. Never orchestrators or open-ended planning.
- **Class**: lossy-gate-required; 0% billable pre-gate.
- **Honest band**: **unknown, gate-determined.** The "54–70% of residual / can exceed every input lever combined" framing is retired as fixture-derived; re-based motivation: output is a measured 29.3% of a well-cached agent's bill with ~1.5x cache-read echo leverage per output token saved (measured, 2026-10-26 ground truth). Savings concentrate in the fat top-decile turns, which are also the most quality-critical — expect fewer passing routes than the dial range implies. Ledger basis is **estimated-baseline forever**: the counterfactual (what the model would have emitted at higher effort) is never observable per request.
- **Measurement plan**: acquire measured per-route output/reasoning distributions from live export #3 *before* designing the policy (choose trial routes from measured skew); then **trajectory-level** paired gate — whole-task runs where candidate responses feed forward, quality = customer task-completion metric, cost = total per-task verbatim spend including turn count, retries, and cache-echo. Gate runs are hash-chained ledger events; the per-route ratio freezes at gate-pass so every savedUsd is auditor-recomputable.
- **Adversarial conditions**: (1) Bill at **task** granularity using the existing `taskId`: a completed task whose total verbatim cost exceeded baseline (turn inflation, truncation-retry, TTL-crossing rewrites from slower wall-clock) books a negative lever entry — without this the lever bills on tasks it made more expensive. (2) The shipped `replay-gate.ts` is structurally disallowed for effort candidates: per-request replay cannot see turn inflation, and `exactTextGrader`/`toolSelectionGrader` penalize the lever's intended behavior (fewer tool calls); a customer-supplied task-completion grader is a hard precondition per route. (3) Add a tail bound beside the mean bound (worst-decile quality floor) — mean-only approval masks tail failure on exactly the routes where the tail is the product. (4) Effort switches only at conversation boundaries, enforced by cross-turn state (volatility-guard architecture, not stateless per-request policy); any resulting cache write nets against *this* lever. (5) Counterfactual = the customer's own wire config per route, frozen at signing; never provider defaults; if the framework already pins effort, the route is unreachable — detect, don't assume. (6) Mandatory re-gate on model version change, traffic-shape change-log entry, or trailing quality drift; ratio suspended (bills zero) until re-pass. (7) Circuit-breaker caps derive only from distributions at the same effort setting; `stop_reason=max_tokens` on a tool call is a lever-caused failure (task voided, retry cost netted).

### P5. Shared-prefix fan-out serialization (cache race-loss repair)

- **Mechanism**: Provider rule: a cache entry exists only after the first response *starts*, so simultaneous same-prefix fan-outs all pay 1.25x writes. The proxy holds same-prefix-hash arrivals behind an in-flight latch until the first response's headers arrive, converting N−1 writes into N−1 reads. Bytes untouched; only send timing moves — the most genuinely lossless lever in the portfolio.
- **Shapes**: multi-agent fan-out exclusively; high-QPS RAG/batch bursts secondarily.
- **Class**: lossless.
- **Honest band**: per-racer delta formula only — (1.25x−0.1x)/1.25x ≈ 92% of the shared-prefix cost per *actual* racer — with volume explicitly **UNMEASURED**: the captures carry no timestamps, so shared-prefix groups cannot be distinguished from sequential turns that already hit cache. Retire the ~92% headline until collision frequency is measured. Basis: documented cache-availability semantics; frequency estimate pending.
- **Measurement plan**: add entry-available-at-first-response-START concurrency semantics to `cache-simulator.ts` **in the same change** and restate the multi-agent band under them first (it will come *down*) — the lever's credit is the delta against the corrected baseline, never the current optimistic one. Add local arrival-timestamp logging to the proxy (privacy-clean) and report observed collision rates. Live gate: verbatim usage flipping `cache_creation` → `cache_read` on racers.
- **Adversarial conditions**: (1) The token gate is blind to the real failure mode (latency/timeouts/retry storms): record per-latch hold time, held-request timeout/retry counts, task parity; auto-disable per prefix hash on breach. (2) Hold cap derived from measured cold-write TTFB at the prefix's size — a cold 47K-token write is seconds, not "a few hundred ms" — and kept under client TTFB watchdogs; a tripped client retry is a duplicate full-price request that erases the saving. (3) Release-on-error immediately when the held-for request 429s/errors (separate path from the stall timeout). (4) Latch keys on post-transform bytes up to the MESH breakpoint; engage only on actual collision, only for stamp-approved prefixes above the per-model minimum, never when the prefix is known-warm within TTL; blocked until the tokenizer overcount fix and the pending live byte-match of MESH prefix hashing vs provider keying both land. (5) Billing evidence: count a racer only when proxy logs show arrival before the first request's first response byte AND that first request's verbatim usage shows `cache_creation` covering the shared prefix; counterfactual labelled inferred-from-documented-semantics until one cheap live A/B validates the flip. (6) Prewarm variant dominated by the latch; if kept, max_tokens:1, own opt-in, full cost netted. (7) Disclose the timing change. Timestamped multi-agent capture is a prerequisite and remains the top missing input.

### P6. Tokenizer recalibration + minimum-table rework (free count_tokens) — substrate, not savings

- **Mechanism**: (a) Ship the 1.30x guard margin now (tonight's P1); batch-calibrate `approximateTokenCount` per content class against Anthropic's free `count_tokens`, correction factors keyed by (counter-implementation hash, tokenizer generation, content class). (b) Per-model-class minimum table from a pinned doc capture, live-probed before activation. (c) is killed as a product change (see §3) and survives only as a regression fixture asserting catalogue cached rates against the frozen pricing-page copy.
- **Shapes**: all stamped shapes; structurally incapable of degrading task completion (no byte the model reads changes).
- **Class**: provider-mechanism (hygiene).
- **Honest band**: for (b), *only* the measured share of customer traffic with true prefixes in [512, 1024) per shape — to be measured, not asserted. Struck from the band: the RAG-unstick claim (the template is ~342 true tokens, below 512 by the lever's own numbers — it stays correctly suppressed), the +5–7.5pp ledger uplift (the billing path already prices per-model via `model-prices.ts` `cachedInput`; claiming it would double-count MESH's fee base), the nonexistent 4096 minimum, and "Mythos 5.1". Converted no-op stamps are hygiene (zero billed before, zero after), not savings — a below-minimum stamp is a silent no-op that pays **no** write premium; the P1's cost is a false lever record, and customer-facing material must not say otherwise. Basis: measured (28% overcount) + literature-claim pending live probes.
- **Measurement plan**: calibration offline, on MESH-owned fixtures (`evals/wire-captures/`) or customer-side under the customer's own key against content already bound for that provider — never cross-provider, never retained bodies, never on the hot path. Verification inherent: correct guard shows `cache_creation` then `cache_read`; no-op shows 0/0.
- **Adversarial conditions**: (1) **Close the loop**: a post-flight no-op detector (stamped, creation=0, read=0 → auto-suppress that traffic class, never recorded as a lever, visible alarm) ships before any guard loosening — today's guard is pre-flight only and would no-op-stamp silently forever. (2) Floor relaxation per model class only after one live probe shows `cache_creation_input_tokens > 0` on a sub-1024 true-token prefix for that class; until then the frozen 2026-10-08 capture (1024/2048) stands; unrecognized ids keep the conservative floor. (3) Newly admitted 512–1023 surface stamps 5m TTL only (break-even ~0.26 reads/write vs ~1.05 for 1h). (4) One coherent rule: corrected counts + small residual margin (~1.1x) *replace* the interim 1.30x — never stack (stacking ≈ 1.66x effective floor, silently forfeited savings); mixed-content prefixes counted per-segment. (5) Re-verify the 1.28x prose figure against the *shipped* word-run counter (the calibration doc describes ceil(len/4) — factors fitted to one implementation applied to another are noise). (6) Stamp calibration version into any event whose estimated-baseline lever used the corrected counter. (7) Gate (b)'s rollout on the pending split-block byte-match verification.

### P7. Stale tool-result reduction — unstamped arms only, re-banded

- **Mechanism**: age-based masking of stale `tool_result` bodies (goose cutoff pattern) and same-file-read supersession, plus optional Anthropic context-management beta injection — **restricted to traffic where the cuts fall outside any live cached prefix**, because the surviving verdict showed the spec is internally contradictory on its strongest shape: MESH stamps system + last message, so all stale results sit *inside* the stamped prefix, and constraint (c) ("cut strictly after the last live breakpoint") permits masking nothing on stamped traffic. Violating (c) has quantified loss arithmetic (break-even ~26 remaining turns at P=80k/N=24k — unknowable at decision time); a sliding age window re-edits every turn and is strictly net-negative — the self-inflicted LiteLLM loss shape, invisible to the volatility guard, which is fed the raw request on the assumption every lever is byte-stable across turns.
- **Shapes**: long-horizon tool loops on *unstamped or cache-cold* traffic; near-zero elsewhere.
- **Class**: lossy-gate-required.
- **Honest band**: **low single digits on stamped Anthropic traffic** (stale bytes there bill at 0.1x — valuing cleared tokens at full input rate is a ~10x overclaim); potentially 10–35% only on genuinely uncached traffic, and that remains **reasoned** until a fat-tool-result capture exists — the current capture has at most one tool_result per request (7 markers / 11 requests); the "42x repetition" was padding inside single bodies plus history re-sends. The fixture-gap premise stands; the count did not.
- **Measurement plan**: (1) lossless counting of tool_result age/byte distributions in existing captures; (2) acquire the fat-tool-result coding-agent capture and build a sixth matrix shape; (3) two-arm breakpoint-aware vs naive simulation; (4) replay gate counting added re-fetch turns as negative savings; provider context-editing verified by a small live run (it changes server-side billing). Cache invalidation netted via verbatim `cache_read_input_tokens` in every arm.
- **Adversarial conditions**: (1) No masking inside a live stamped prefix, ever; cut points must be pure functions of the replaced text (no mutating "latest-read" pointers — each re-read re-invalidates the suffix). (2) No sliding windows: cut schedules must be byte-stable across turns or the volatility-guard contract must be extended to see MESH's own edits. (3) Arm (a) (provider context-editing) is unschedulable against breakpoints (provider clears oldest-first at its own points) — treat as mutually exclusive with MESH stamping per route, priced against the 0.1x counterfactual, never the 84% literature ceiling (earned on uncached context). (4) Hard override above ~80% context fill. (5) Pass-ordering fixtures in `token-reduction.ts`; double-compaction detection when the customer app also summarizes. (6) All loss modes are ledger-visible (cache_read/creation deltas) and net against MESH — that nettability is why this is pursue, not kill.

---

## 3. KILLED (killing is a finding)

- **128-token boundary alignment (OpenAI)** — unverifiable by construction (hidden provider framing tokens + ±28% local counter), EV bounded below 128 tokens/request at a 0.1–0.5x delta, and its failure mode (volatile byte promoted into the stable region) silently zeroes the entire downstream cache; padding variants are model-visible content at full price. Revisit only after count_tokens calibration, and only as boundary-move-never-pad.
- **GPT-5.6 Anthropic-band transfer ("20–60%, up to 90% of prefix")** — double-counted against the wrong counterfactual (OpenAI caches automatically) and wrong read ratio on the only evidenced model (gpt-4o: 0.5x, not 0.1x; ~1.8x overstatement).
- **Ledger read-multiplier "fix" (lever 2c)** — attacks a strawman: `priceLedgerUsage` already prices cache reads per-model via the catalogue; the claimed +5–7.5pp would double-claim MESH's own fee base. Survives only as a simulator-fallback tightening + frozen-pricing fixture.
- **RAG-unstick headline (lever 2b)** — self-refuting: the template is ~342 true tokens, below the proposed 512 floor; the 23.3%-of-spend impact does not follow.
- **max_tokens right-sizing as a billable lever** — bills nothing until it truncates, and truncation is failure (invalid JSON mid-tool-call, costlier retry); its only savings mechanism is its failure mode. Demoted to an unbilled circuit breaker.
- **max_tokens:0 prewarms/pings as specced** — Anthropic requires max_tokens ≥ 1; the spec 400s at the wire. Corrected to max_tokens:1 wherever the parent lever survives; inside Message Batches, prewarms are invalid entirely (sync-only).
- **OpenAI batch cache-stacking (the 0.05x figure on OpenAI)** — OpenAI documents no prompt-caching discount on the Batch API; on cache-hot prompt-heavy routes batching there can cost ~0.5x vs ~0.1x cached sync while the naive ledger books a saving.
- **Sliding age-window masking on stamped traffic (lever 7b as specced)** — strictly net-negative per turn (1.25(P−N) cost vs 0.1N benefit), the measured LiteLLM loss shape self-inflicted, invisible to the volatility guard.
- **"Portfolio band computable from capture timestamps" (lever 3)** — no capture in the repo carries timestamps; synthetic-gap results are arithmetic, not measurement.
- **"Output is 54–70% of residual" (lever 6 motivation)** — fixture-invented quantities, falsified by the 2026-10-26 measured ground truth (29.3%).
- **"~92% per racer" and "10–40% of fleet" as headline numbers** — per-racer delta formula and per-customer measured share respectively; volumes were zero-evidence guesses doing headline work.

---

## 4. Tail (unreviewed — queue for adversarial review in this order)

- **T1. Tool-schema canonical ordering + pydantic-aware minifier extension** (lossless) — measured 3.4x schema bloat in the capture; canonical tool order protects the top of the cache hash hierarchy against reorder breakage; safest lever on the list, direct band 2–12% of input (derived-from-captures), cache-protection value possibly larger; strict-mode `additionalProperties:false` is load-bearing.
- **T2. Deferred tool loading / Tool Search injection on >20-tool catalogues** (lossy-gate-required) — Anthropic-reported 85% tool-definition cut with accuracy *up*; the honest home for per-agent tool-subsetting; the cache interaction (tier churn invalidating the stamped prefix) is the trap and can exceed the schema savings.
- **T3. Responses-chain rehydration** (lossless enabler) — 0% direct; converts previous_response_id chains (lever-immune, re-billing all prior input every turn) into client-managed history the full stack can touch; opaque reasoning items are pass-through-never-drop, and naive rehydration can break implicit server-side caching — assert `cached_tokens` non-regression.
- **T4. Premium-tier and flag hygiene audit** (rate-arbitrage, detect-first) — fast 2x / priority 2x / inference_geo 1.1x / regional 10% / rejected_prediction_tokens; the audit is the measurement (prevalence 0 in current captures); geo/regional flags may be legal requirements — flag, never auto-strip; speed/geo flips must join the volatility-guard invalidator list.
- **T5. Flex-first routing hardening + served-tier verification** (rate-arbitrage) — flex at batch rates with clean-429 $0 fallback; the whole tier family's billability hinges on verifying `response.service_tier` reports the tier actually served; unverifiable = unbillable, priced at standard until confirmed.

---

## 5. Open questions needing live API spend or customer traffic

Ranked by how much each improves the quality of the % saved:

1. **Live export #3 (Anthropic, founder's key)** — carries: the ~$5 split-block byte-match of MESH prefix hashing vs provider cache keying (blocks P5 and P3's repair confidence); count_tokens calibration per content class (blocks P6, unblocks any 128-boundary revisit); measured per-route **output-token and turns-per-task distributions** (P4 is sized on fixtures until this lands).
2. **One live OpenAI billing export through the proxy** — the Anthropic export's analogue; the entire P3 band is simulator-only until it exists, and the simulator can confirm but never falsify its own assumptions.
3. **Timestamps** — arrival-timestamp logging in the proxy and all future captures. Blocks: P5 collision frequency (the lever's entire value), P2 gap histograms, and converts P2/P5 bands from ESTIMATE to measured.
4. **Fat-tool-result wire capture** (coding-agent loop against the recording stub; the anatomy's top-ranked missing input) — P7's band is unmeasurable without it; becomes the sixth matrix shape.
5. **One real GPT-5.6 usage payload** — write-premium field names/shapes (`cache_write_tokens_details` appears in no capture); whether explicit stamping replaces or supplements automatic caching. Hard gate on P3's 5.6 arm.
6. **Per-model-class minimum-floor probes** — one stamped sub-1024 true-token prefix per current model class showing `cache_creation > 0` (nearly free; gates P6b).
7. **Two undocumented cache behaviors** — what a changed TTL marker on an already-cached prefix bills, and whether max_tokens-minimal pings are accepted and refresh the entry (gates P2's layering default and ping arm).
8. **Batch-results verification** — Anthropic batch results' per-request cache-field itemization; whether OpenAI Batch applies cached pricing at all; batch usage field semantics vs sync (gates P1 billing).
9. **Served-tier verification** — does `response.service_tier` report the tier actually served (gates T5 and the whole tier family's "measured" basis).
10. **Customer traffic distributions** — share of true prefixes in the 512–4095 window (P6b's entire upside); per-route task-completion graders or any completion signal (hard precondition for P4); whether customer frameworks pass effort/max_tokens through unpinned; opt-in-tagged latency-tolerant route share (P1's fleet impact).

---

*Document basis note: every number above is labelled measured, derived-from-captures, literature-claim, reasoned, or estimate per the honesty rules. Where a verdict corrected a counterfactual, the corrected band stands and the original is recorded in §3. Negative lever outcomes net against MESH in the ledger; nothing here is billable ahead of its conditions.*
## P1.5 — count_tokens-verified minimum guard (added 2026-10-26, from live export #3)

Live finding: the chars/4 approximation UNDERCOUNTS some content — the batch
classifier's rule-list preamble measures 611 approx tokens but 927 real
(provider `count_tokens`, free endpoint). The 1.3 APPROX_OVERCOUNT_MARGIN was
calibrated on prose where chars/4 overcounts; short repetitive lines with
digits and punctuation go the other way. Tonight the margined guard still
reached the right verdict (927 < 1024 minimum → suppress), but the error is
bidirectional, so the margin can both leave money on the table (suppressing a
cacheable prefix) and let a sub-minimum stamp through.

Lever: when the margined approximate count is within ±25% of the per-model
minimum, resolve with one `count_tokens` call (free, ~100ms, prompt stays on
the customer's machine — the call goes to the same provider that will see the
prompt anyway, but it IS a request: must be opt-in-consistent with proxy mode
semantics and ledger-recorded as a diagnostic, never guessed). Outside the
band, keep the margin and skip the call. Exact placement decisions at zero
marginal cost on the shapes where the heuristic is least trustworthy.

Also from export #3: export #2's batch-classifier claim (+$0.0101, 6,286 cache
reads on a prefix count_tokens now shows is sub-minimum) cannot be re-audited
because its spools were not retained. Standing rule from tonight: every live
export runs with MESH_LIVE_KEEP=1 and commits its spools to
evals/live-exports-<date>/ before any number is published.

## From day-shift 2026-10-27 (agent reverse-engineering + image/video)

Full findings: docs/rnd/knowledge/2026-10-27-agent-reverse-engineering.md and
.../2026-10-27-image-video-economics.md. Distilled for the nightly queue:

- **DECISIVE FRAMING (agents):** the single determinant of whether MESH can help
  an account is "does the agent already cache its prefix". Cached agents (Cline,
  OpenHands, SWE-agent, CrewAI native, Aider-with-flag) are do-not-pay-us; the
  resend-levers are already-done or net-negative there (editing a cached prefix
  forces a 1.25x re-write). Uncached paths (LangGraph default, AutoGen default,
  gpt-researcher) are where the cache lever is real at $2 vs $0.10 /MTok.
  ACTION: add a "do your agents already cache?" triage question to the quote flow.
- **P3 — idle-expiry keep-warm metering.** 5-min ephemeral TTL (Cline et al.)
  expires across think/test gaps; prefix re-bills write vs read (100k prefix ≈
  $0.24/expired turn). METERING+advice lever (recommend 1h tier / keep-warm),
  NOT a shipped quantified saving until TTL + gap distribution measured.
- **P3 — empty-response billed-resend metering.** Only byte-identical *billed*
  resend class found (Cline empty-retry already surfaced; gpt-researcher empty-200,
  freq UNKNOWN). Visibility feature, not a derivable saving.
- **REJECTED (negative result, logged):** cross-agent relay cache-sharing in
  multi-agent frameworks — relay content differs per agent role; no shared-prefix
  win. Do not pursue.
- **IMG/VIDEO honest verdict:** MESH CANNOT reduce the per-image/per-second
  generation charge — say so on the site (new do-not-pay-us segment). Vision-input
  right-sizing saves $0 tokens up to the provider's own downscale cap (provider
  discards those pixels anyway); only sub-cap downscale saves tokens and is LOSSY
  → gate-only. The one shipped lever that applies: candidate 7, cache-prefix stamp
  over STABLE video-frame prefixes (5-turn 1-min-clip chat: $3.23 -> ~$0.26+write).
- **NET-NEW CODE flagged (not today):** image/frame-aware reduce-request (resize,
  frame dedup) + a Gemini generateContent proxy route — none exist at 59a034a.

## P1 batch routing — SHIPPED (pricing + selection) + follow-on (2026-10-27)

DONE today: Anthropic Batch API rates catalogued (50% of standard, from the
page's definitive "Save 50% with batch processing", dated 2026-10-27, cache-write
premium deliberately omitted → unpriced not guessed). The workload matrix now
prices the async-eligible shape under BOTH caching and batch-routing and picks
the cheaper per shape (lever selection — the first non-caching lever that helps
already-well-cached accounts). 5 catalogue tests + eval green. Site caveats
updated (the "Anthropic batch uncatalogued" catch is now closed).

FOLLOW-ON (not shipped): the batch ROUTING EXECUTION. Cataloguing + selecting
is measurement; CAPTURING the 50% needs the proxy to submit latency-tolerant
Anthropic traffic to the async Message Batches API (/v1/messages/batches:
submit → poll → return), which changes a sync call into an async one — only
valid where the caller opted into latency tolerance. Design needs: an explicit
per-request "batch-ok" signal (never inferred), a submit/poll path in proxy.ts,
and a ledger event priced at the catalogued batch rate. Until then MESH meters
and recommends the batch opportunity but does not silently reroute.

## Queued from dataset analysis 2026-10-27 (docs/rnd/knowledge/2026-10-27-dataset-findings.md)

Sample-derived calibration deltas. Nightly R&D implements with tests, by vertical.

ALWAYS-ON:
- Workload-aware TTL guard: default 5m, stamp 1h only when realized reuse-gap
  p90 > 300s. Evidence: Mooncake tool-agent gap p90=243s (5m catches 92.6%) vs
  conversation p90=519s/max 3,030s (1h recovers the ~21.5% tail); WildChat 27.6%
  of continuations evict at 300s → 14.2% at 600s. Replaces flat TTL default.
- Volatility guard: size to the ~2.5% prefix-busting minority (SWE-O1 zero-cache
  4/163 against 50.8% fleet cache-hit), not a dominant-failure lever.

AUTONOMOUS:
- Semantic pre-pass maxTokens 200→500 FOR AGENT TRAJECTORIES ONLY (serving-trace
  tool-results stay 200). At 200 the floor flags 58–68% of ALL tool-results
  (medians 270–302 tok); at 500 only the 3.5–34.5% oversized tail. Make the
  default workload-scoped, not a global 200.
- keepRecentTurns=2 and minimumTurns=3 CONFIRMED tuned (WildChat sweep: =2 is the
  savings plateau; agent corpora median 11–60 turns ≫ 3). Close the UNTUNED flags.
- Tool-schema compaction confirmed high-value: SWE-rebench 5 tools = 4,962 tok
  (48% of first request), ~298k schema-tok/trajectory before cache.
- Duplicate-context dedup ceiling ~7% (byte-identical tool-results 6.8–7.3%).

ONE-SHOT:
- Batch-tier routing keyed on traffic-class/output-shape not raw size: BurstGPT
  Log Type separates API (median output 7) from Conversation (243), ~35× gap.
- Cacheable minimum: keep 1024/2048 per-model, do NOT globalize (SWE-O1 needs
  2048; tau-bench 1,801-tok policy doc needs 1024).

CORRECTIONS TO RECONCILE (honesty — do before any dependent claim ships):
- Agent output re-emission is ~0% (median 0.0% across 4 corpora, 13k+ turns), NOT
  the 24%/61% band. output-diagnostics.ts header + the 2026-10-26 ground-truth
  doc cite ~24% — that is chat/file-reprint-shaped only. Re-scope the claim; do
  not size any AGENT output-mutation lever off 24%.
- The 34.3% sparse-interactive ceiling is NOT reproducible from pure chat; it
  needs tool-bearing interactive sessions. Verify before leaning on the top of
  that band.
- Pin the re-emission metric aggregation (per-message 5-gram p90=35.5% vs
  per-conversation-worst p90=71.3%; the old 61% sits between) before the
  output-metering lever's trigger threshold is set.

## Run-2 verdicts on the queued deltas (2026-10-27, docs/.../2026-10-27-dataset-findings-run2.md)

Deeper pull (Mooncake full trace, Azure full week n≈2.9M, SWE-rebench n=2,000 =10x,
4 non-SWE agent corpora). Verdicts:

- **WORKLOAD-AWARE TTL (p90>300s → 1h): FALSIFIED. Shipped then REVERTED same night
  (revert of 38a9a9e).** Once the 2x 1h write premium is charged on every cacheworthy
  block, flat-1h LOSES to flat-5m on all three Mooncake workloads (conversation −4.7pp):
  the premium is taxed on the 60-68% of blocks with no (300s,3600s] reuse gap. A whole-
  conversation p90 trigger makes exactly that losing choice. CORRECT DESIGN (re-queued,
  build carefully with review): PER-PREFIX adaptive 5m→1h promotion — 5m default, promote
  an individual prefix only after an observed >300s-then-reused gap on THAT prefix. Oracle
  adaptive beats flat-5m +8.8/+3.7/+2.9pp (conv/tool/synth). The stamp currently applies
  one TTL per request, so true per-prefix promotion is a non-trivial change — do not ship
  a conversation-level approximation without pricing it against flat-5m first.
- **maxTokens 200→500 (agent tier): CONFIRMED at 10x n** (SWE n=127,328 median 293, fires
  62.0%→31.7%) and across non-SWE. Kept (commit 4000d41). CAVEAT run 2 adds: it is a safe
  trigger FLOOR, not a universal target — web/document agents (Mind2Web ~28k-tok median
  "tool results") would see 56x compaction, so for those keepRecentTurns is the guard, not
  maxTokens. A web-agent compaction profile is net-new work.
- **Output re-emission ~0% on agents: CONFIRMED across 7 corpora, SHARPENED.** Run-1 "0%"
  was a context-definition artifact; faithful metric (context = full re-sent body) is 3.25%
  token-weighted on SWE — still ≪ the chat 24% band. No agent output lever off 24%.
- **Cacheable-min 1024/2048 split: CONFIRMED** stable over a full Azure week. No change.
- **Tool-schema compaction: PROMOTE** — 67-80% of cold first request off-SWE (vs 48-51% SWE),
  the heaviest single component; always >1024/2048 so independently cacheable.
- **Dedup ceiling ~7-9%, history gates 3/2: CONFIRMED.** Output-side levers de-prioritized
  for Tier-1 (Azure out:in ≤0.05 median over 2.9M requests).
