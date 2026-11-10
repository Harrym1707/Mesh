# Knowledge acquisition run — 2026-10-25

Four gaps the founder asked us to close. Everything below is measured or
primary-sourced; wire captures live in evals/wire-captures/. Items marked
NIGHTLY are specced for the nightly R&D agent, priority order.

## 1. Framework wire shapes (measured — evals/wire-captures/frameworks-2026-10-25.jsonl)

Captured the actual request bytes of LangGraph 1.2.17 (Anthropic + OpenAI
arms), OpenAI Agents SDK 0.24.0 (Responses), and a raw Anthropic SDK tool
loop, each running a 2-tool agent against a recording stub. Structural facts:

- **ZERO cache_control from every stack, every request.** The core MESH
  thesis — Anthropic's cache is opt-in and the popular frameworks never opt
  in — is now verified at current versions, not asserted. Launch-grade.
- **Tool-schema bloat is framework-made**: the Agents SDK serializes two tiny
  tools in 592 bytes vs 173 raw (3.4x) — pydantic `title` on every property
  AND on the args object ("tool_get_weather_args"), additionalProperties,
  etc. Our minifier strips property-name-restating titles; NIGHTLY (P2):
  verify it also catches pydantic's `<fn>_args` object titles and the
  capitalised-property form ("City" vs "city"), add wire-capture-based
  fixtures from this file to the schema tests.
- LangGraph OpenAI arm: system travels as messages[0], `stream: false` on
  invoke(); max_completion_tokens injected. Agents SDK: instructions string +
  `include` field. NIGHTLY (P3): confirm whether LangChain's .stream() path
  sets stream_options.include_usage (if not, MESH events on that path are
  honestly UNPRICED — document in FAQ if so).
- These captures are now the seed fixtures for lever work: NIGHTLY standing
  rule — prefer fixtures derived from wire-captures/ over invented ones.

## 2. LiteLLM volatility test (measured — evals/wire-captures/litellm-volatility-2026-10-25.jsonl)

LiteLLM 1.106.4, `enable_anthropic_prompt_caching: true`, 6-turn volatile-
clock system vs stable control, recorded at a stub:
- OBSERVED: stamps system[0] + trailing user turn EVERY request, both arms;
  the volatile clock is byte 0 of the stamped block; no stability check of
  any kind (hook confirmed stateless in their source); no signal of any sort
  after 6 consecutive zero-read responses. Control-arm placement is sound.
- INFERRED (documented billing rules, not live-billed): the volatile arm
  pays the 1.25x write premium on effectively the whole input every turn
  with zero reads — strictly worse than caching off. Exactly the loss MESH's
  volatility guard prevents and nets against MESH when it happens.
- Comparison page updated to cite this as measured (version-pinned).

## 3. Token-counter calibration (measured vs tiktoken o200k_base)

approximateTokenCount = ceil(len/4). approx/true ratios: prose 1.28
(OVERCOUNTS 28%), tool-schema JSON 0.96, TypeScript 1.04, messages JSON 0.87
(undercounts), raw wire bodies 0.97.
- PRODUCT BUG, NIGHTLY (P1): the minimum-cacheable guard compares the approx
  count to the 1,024/2,048 minimums. On prose-heavy prefixes the 1.28x
  overcount means a true ~800-token prefix passes the guard and the provider
  silently no-ops the stamp. Fix: require approx >= 1.30x the per-model
  minimum (conservative; a boundary stamp earns pennies, a no-op stamp earns
  a false lever record). Update the guard tests' fixture sizes accordingly.
- estimated-baseline billing is ratio-based (removed/before, same content
  type in both terms) so the bias largely cancels there; note it in
  methodology if asked.
- Anthropic-tokenizer calibration still open: needs the free count_tokens
  endpoint = a fresh API key (founder). Run it alongside live export #3.

## 4. IPMVP / ESPC measurement-contract knowledge (primary-sourced)

Full report with clause citations: docs/strategy/ipmvp-findings.md. The
decades-tested mechanics we adopt:
- Freeze the counterfactual PRICE SCHEDULE at signing (Option A-style
  stipulation): recompute quantities, never prices → kills most disputes.
  Founder decision needed: price-floor rule if providers cut list prices.
- Measurement exhibit structured on FEMP Appendix C, WITH a dispute-
  resolution section inside the exhibit itself + a lost-data method.
- Every statement carries a "running log of traffic-shape impacts"
  (NIGHTLY P4: add a changes-observed section to mesh-report sourced from
  the volatility guard + lever-mix deltas).
- Negative periods: CUMULATIVE NETTING WITH CARRY-FORWARD (the federal G.5
  mechanic): fee = 1% x max(0, cumulative verified savings - savings already
  billed). PRODUCT CHANGE, NIGHTLY (P1, with design care): recomputeInvoice
  takes an optional prior-billed figure; mesh-report shows the carry-forward
  line. Payments must never exceed aggregate verified savings.
- Invoices gate on customer acceptance (written or deemed after 30 days),
  mesh-verify = the witnessing step; escalation ladder: discrepancy notice
  with specific ledger entries -> 30-day reconciliation -> non-binding
  neutral expert -> contract remedies; undisputed service continues.
