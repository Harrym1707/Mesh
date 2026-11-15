# Output-token reduction — academic literature mine (2026-10-28)

Axis owner: output-token-reduction miner. Scope: decode-side waste (A5) — response
length/verbosity, reasoning-token (CoT) economics, structured-output token efficiency
on the **output** side, stop/format steering. Caching (A1) and batch (A6) are out of
scope by dispatch.

## The one thing to take away

**Output reduction is NOT a free lossless lever for a request-rewrite proxy. Every
technique in the literature works by changing what the model emits, so every one is
LOSSY and must clear a replay/task quality gate before MESH can bill it. The only
output levers MESH can pull black-box are (a) provider-native effort/verbosity dials
that are already first-class request-body fields, and (b) a *stable* concise-style
instruction set in the cached prefix. Everything else in the literature either needs a
second model, needs fine-tuning, or needs per-turn prompt edits that bust the cache —
and the biggest published numbers (84%, 80%, 68%) come from exactly those rejected
methods, measured on math/reasoning benchmarks that do not resemble MESH's agent
traffic.** This is consistent with the existing lever-backlog verdict that output is a
measured 29.3% of a well-cached agent's bill, gate-determined, estimated-baseline forever.

---

## MESH frame (why most of the literature is off-target for us)

MESH can only (1) rewrite the outgoing request body and (2) read provider-reported usage
after. It cannot touch decoding, logits, or run a second model. So an output-reduction
lever is really an **input-side instruction or parameter that steers generation shorter**.
That filter kills most of the field:

- A method that **trains/fine-tunes** the model to be concise (TALE-PT, most "efficient
  reasoning" post-training, self-training concise CoT) → **REJECT** (white-box).
- A method that needs a **second model** to estimate a budget, route a paradigm, or judge
  → **REJECT** (no model bundled on-machine; a classifier call is itself billable waste).
- A method that **re-edits the prompt every turn** (per-turn adaptive budget, continuous
  hints during generation) → fights the volatility guard: the edited bytes bust the
  cached prefix, and on a well-cached agent the lost cache read can cost more than the
  output saved.
- What survives: **provider effort/verbosity parameters** (native request fields) and a
  **one-time stable concise instruction** that lives in the cached prefix and is never
  re-edited.

Economic anchor (MESH measured, `docs/rnd/knowledge/2026-10-26-output-token-ground-truth.md`):
output = **29.3%** of a well-cached agent's bill; each output token is re-read ~27× and
carries ~**1.5× echo leverage** (saving one output token also saves ~0.5× its price in
later cache reads); the **top 10% of turns hold 47–64% of output** and those fat turns are
the most quality-critical. Reasoning tokens are billed as output tokens on OpenAI and
Anthropic (provider docs, below), so reasoning compression lands directly on the output
line — this is the single largest honest target inside A5.

---

## Techniques (measured numbers, honesty-labelled)

### 1. Provider-native effort / verbosity dials — THE black-box output lever

**Mechanism.** Set a request-body field that tells the model to spend fewer output tokens:
Anthropic `output_config.effort` (low/medium/high/xhigh/max), OpenAI `reasoning_effort`
(minimal/low/medium/high) and GPT-5 `verbosity` (low/medium/high). These are first-class
fields MESH already forwards — the cleanest possible black-box rewrite.

- Anthropic effort "affects **all tokens** in the response, including text, tool calls and
  thinking… lower effort also means fewer and terser tool calls" and `low` = "Most
  efficient. Significant token savings with some capability reduction." (provider doc,
  **literature-claim**, no public % attached). GA on Claude 4/5 family, no beta header.
- OpenAI `reasoning_effort: minimal` "minimizes reasoning to return an answer quickly…
  outputs very few or no reasoning tokens"; GPT-5 `verbosity: low` = "terse UX with minimal
  prose." Reasoning tokens are billed as output (**provider-doc / literature-claim**).

**Measured number:** none published by providers as a clean %. Savings are
**gate-determined / estimated-baseline forever** — the counterfactual (what the model
would have emitted at default effort) is never observable per request.

**Lossless?** LOSSY — changes the emitted sequence. Must pass a trajectory-level task gate.
**Black-box?** YES — native request field, no model access.
**Caching interaction — CRITICAL and double-edged:**
- Anthropic doc, verbatim: changing **top-level** effort "invalidates prompt caching… pick
  an effort level at the start and keep it constant" within a cached conversation. So a
  naive per-turn effort lever on an always-on agent *busts the cache on every change* —
  the exact failure the volatility guard exists to prevent.
- The escape hatch is the **per-message effort beta** (`mid-conversation-output-config-2026-07-01`,
  Opus 5/5.5, Sonnet 5.5, Haiku 5.5, Fable/Mythos 5.x): an effort-only system message
  "preserves the prompt cache." A MESH effort lever on Anthropic MUST use this path, not
  top-level, or it nets negative on cached traffic.
- Further caveat (Opus 5 doc): "changing effort does not reliably shorten *responses*…
  prompt for length instead" — effort steers *thinking* volume, not necessarily visible
  output length. So effort ≠ a verbosity control on every model; verify per model.

**MESH verdict:** SHIP-CANDIDATE, and it is already lever **P4** in `lever-backlog.md`
(effort governor). This mine adds two hard constraints P4 must encode: (1) use the
per-message effort beta on Anthropic so the dial doesn't bust the cache; (2) don't assume
effort shortens visible output on Opus-class models — gate on measured output delta, not
on the dial setting.

---

### 2. Concise / constrained chain-of-thought via instruction (CCoT, Chain-of-Draft)

**Mechanism.** Append a style instruction to the prompt: "be concise", "≤ N words per
reasoning step", a fixed token budget. Pure request-byte rewrite.

- **Concise Chain-of-Thought (CCoT)**, Renze & Guven, arXiv:2401.05618 (GPT-3.5, GPT-4,
  MCQA): response length **−48.70%** for both models, per-token cost **−22.67%**,
  "negligible impact" on general accuracy — **but math accuracy −27.69% on GPT-3.5**.
  (**literature-claim**.) The math penalty is the headline risk, not the length win.
- **Chain of Draft (CoD)**, Xu et al. (Zoom), arXiv:2502.18600 ("≤5 words per step",
  few-shot). Measured, GPT-4o / Claude 3.5 Sonnet:
  - GSM8K: tokens −78.6% / −79.0%, accuracy 95.4→91.1 / 95.8→91.4 (**−4.3 / −4.4 pts**).
  - Sports: tokens −47.7% / −92.4%, accuracy *up* (95.9→98.3 / 93.2→97.3).
  - Coin flip: tokens −68% / −86%, accuracy flat at 100%.
  (**measured**, paper Table.) Headline "7.6% of CoT tokens / −80%" is the best case
  (Claude sports), not the average; GSM8K costs several accuracy points.

**Stated limitations (from the CoD paper, load-bearing for MESH):** needs **manually
crafted few-shot draft examples**; **no zero-shot evaluation**; tested only on two flagship
models (no small models); the word limit is "just a general guideline" the model may
ignore.

**Lossless?** LOSSY. **Black-box?** Partially — the *instruction* is a byte rewrite, but
CoD's few-shot exemplars mean MESH would have to **inject input tokens** (adding to the
input bill and busting the cache) to get the published numbers; zero-shot "be concise" is
the only truly cheap form and it is the under-tested form.
**Caching interaction:** a *stable* concise instruction placed once in the system prefix is
cache-safe (never re-edited). Few-shot exemplar injection or per-turn budget text is not.
**MESH verdict:** RESEARCH, leaning REJECT-as-proxy-lever. Injecting a brevity instruction
into a customer's system prompt is dangerous (the −27.69% math cliff, the "may ignore it"
non-determinism) and is really the customer's prompt-engineering choice, not a transparent
proxy's. If pursued, only as (a) a stable prefix instruction, (b) opt-in per route, (c)
behind the same trajectory gate as P4.

---

### 3. Reasoning / CoT compression frameworks (TALE, Sketch-of-Thought, overthinking fixes)

Big published numbers live here, and almost all of it is REJECT for MESH.

- **TALE (Token-Budget-Aware Reasoning)**, Han et al., arXiv:2412.18547 /
  ACL-Findings 2025. TALE-EP (prompt a budget): **−67% tokens, <3% accuracy drop**.
  TALE-PT (post-training): **−~50%**. (**literature-claim**.)
  - TALE-EP needs a **budget-estimation LLM call** per problem → second-model cost →
    **REJECT** for MESH as specified. The *insight* (an explicit token budget in the
    prompt compresses reasoning) is reusable only through the native effort dial (§1).
  - TALE-PT is fine-tuning → **REJECT** (white-box).
- **Sketch-of-Thought (SoT)**, Aytes et al., arXiv:2503.05179: across 18 datasets, token
  reduction **up to −84%** with "minimal accuracy loss", sometimes higher accuracy.
  (**literature-claim**.) But SoT uses a **lightweight routing model** to pick a reasoning
  paradigm at test time plus paradigm exemplars → **REJECT** (second model + input-token
  injection).
- **Overthinking of o1-like LLMs**, Chen et al., arXiv:2412.21187: o1-like models burn
  **1,953% more tokens** than conventional models on trivial questions (e.g. "2+3"); **>92%
  of correct answers** are in the first solution round (~39% of tokens). Their mitigation
  (FCS+Reflection, SimPO) is **post-training** → **REJECT**, but the measured waste profile
  is the strongest argument for the §1 effort dial on simple/low-difficulty routes.
  (**measured** for the waste numbers; mitigation is white-box.)
- **"Don't overthink" prompt** on OptimalThinkingBench (arXiv:2508.13141): a plain prompt
  nudge cut tokens "by up to **29%** without impacting accuracy" on simple queries.
  (**literature-claim**.) This is the one black-box, no-exemplar form in the cluster — a
  stable prefix nudge — but it only helps on easy queries, so it needs trusted difficulty
  context to route (don't apply it to hard turns).

**MESH verdict:** the frameworks are REJECT (second model / fine-tuning). The *finding*
that reasoning models massively overspend on easy inputs is real and measured, and it
routes straight into the §1 effort dial conditioned on trusted difficulty — not into a new
compression lever.

---

### 4. Structured-output token efficiency (JSON vs terse, on the OUTPUT side)

**Mechanism.** The *shape* a customer asks the model to emit changes output-token count.
Two opposing facts:

- **JSON output costs more tokens than terse/natural output** — the "JSON tax": structural
  tokens (braces, quoted keys, delimiters) inflate a short payload, e.g. ~11 data tokens
  wrapped in ~24 structure tokens; `{"sentiment":"positive"}` ≈ 7 tok vs "The sentiment is
  positive" ≈ 5 tok (~40% more). (**literature-claim / blog**, direction is robust, exact %
  is workload-specific.) So steering output toward a terser schema (short keys, no
  pretty-print, arrays over repeated objects) reduces output tokens.
- **…but constraining output format degrades reasoning.** *Let Me Speak Freely?*,
  Tam et al., arXiv:2408.02442: forcing JSON mode cut GSM8K exact-match by **−17%**
  (LLaMA-3-8B) to **−24%** (Gemini-1.5-Flash), and up to **−63%** on Last-Letter.
  (**literature-claim**, small/mid models.) So format is not free on the quality side.

**Lossless?** The *token-shape* change (short keys, no whitespace, compact separators) on an
already-JSON output is **near-lossless on information** but still **LOSSY on bytes the model
emits** — it changes the emitted sequence and can change behavior, so it still needs a gate.
Switching a customer away from JSON entirely is deeply lossy and often breaks their parser.
**Black-box?** YES as a request rewrite (change the format instruction / response_schema),
but it rewrites the customer's own output contract — high blast radius.
**Caching interaction:** the format instruction is a stable prefix element → cache-safe if
set once.
**MESH verdict:** RESEARCH, low priority. The direction (terser output schema = fewer output
tokens) is real but (a) it rewrites the customer's output contract, which a transparent
proxy should not do silently, and (b) the quality cliff on reasoning tasks is large. Meter
it / surface it to the customer before ever mutating it. Note this is the OUTPUT-side mirror
of the input-side A2 encoding work — don't double-count.

---

### 5. max_tokens / stop-sequence steering — not a billable lever

**Mechanism.** Cap output with `max_tokens` / `max_completion_tokens`, or add `stop`
sequences. Request-body fields, black-box.

**Reality:** these save tokens **only by truncating**, and a truncated response is a failure
(invalid JSON mid-object, cut-off tool call, a retry at full price). OpenAI/Anthropic docs
confirm `max_tokens`/`max_completion_tokens` cap *reasoning + visible output together*, so a
tight cap can starve reasoning and silently wreck answer quality. This matches the existing
backlog verdict: **max_tokens right-sizing is demoted to an unbilled runaway-cost circuit
breaker at ≥p99.9**, never a savings lever (its only savings mechanism is its failure mode).
**Lossless?** n/a (truncation = failure). **Black-box?** YES. **MESH verdict:** REJECT as
billable; keep as a safety cap only. Stop-sequence steering is the same story unless the
customer's own grammar guarantees a clean early stop (rare, customer-specific).

---

### 6. Token-efficient tool use (Anthropic) — already default, do NOT double-count

**Mechanism.** Anthropic beta `token-efficient-tools-2025-02-19` trims the token footprint of
tool-call emission. "Saves an average of **14%** output tokens, up to 70%." (provider doc,
**literature-claim**.) **But** it is Claude-3.7-only as a beta and **on by default for all
Claude 4+ models**. So for any customer already on Claude 4/5 the NET saving over what they
already have is **~0** — billing it would charge for a saving the provider gives free. Only
a Claude-3.7 holdout route has headroom. **MESH verdict:** mostly already-captured; a
do-not-double-count flag, not a lever.

---

## What this means for the backlog (deltas, not new levers)

1. **Reinforces P4 (effort governor) as the only ship-candidate output lever**, and hardens
   it with two provider-doc constraints the current P4 text doesn't encode: use the
   **per-message effort beta** on Anthropic so the dial doesn't invalidate the cache, and
   **gate on measured output delta** because on Opus-class models effort steers thinking,
   not visible length.
2. **Confirms the "estimated-baseline forever" honesty flag** — no paper offers an observable
   per-request counterfactual; every number here is a benchmark average on math/reasoning
   data, not MESH agent traffic.
3. **Supplies the missing motivation data for routing the dial by difficulty:** reasoning
   models overspend ~20× on trivial inputs (measured, 2412.21187) and >92% of the answer is
   in round one — so the effort dial pays most on *low-difficulty* routes, and almost
   nothing (at high quality risk) on the fat top-decile turns.
4. **Rejects, with citations, the headline compression methods** (TALE, SoT, CoD few-shot,
   all post-training efficient-reasoning) as white-box / second-model / cache-busting — so
   the research team doesn't chase an 84% number that MESH structurally cannot bill.
5. **Flags the JSON-output tax (§4) and token-efficient-tool-use default (§6)** as
   do-not-double-count boundaries against the input-side A2 encoding work and the provider's
   own built-in savings.

## Sources

- Chain of Draft — https://arxiv.org/abs/2502.18600 (html: https://arxiv.org/html/2502.18600v1)
- Concise Chain-of-Thought (CCoT) — https://arxiv.org/abs/2401.05618
- Token-Budget-Aware Reasoning (TALE) — https://arxiv.org/abs/2412.18547 (ACL: https://aclanthology.org/2025.findings-acl.1274.pdf)
- Sketch-of-Thought — https://arxiv.org/abs/2503.05179
- On the Overthinking of o1-Like LLMs — https://arxiv.org/abs/2412.21187 (html: https://arxiv.org/html/2412.21187)
- OptimalThinkingBench — https://arxiv.org/abs/2508.13141
- Let Me Speak Freely? (format restriction) — https://arxiv.org/abs/2408.02442
- Anthropic effort parameter — https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic token-efficient tool use — https://docs.claude.com/en/docs/agents-and-tools/tool-use/token-efficient-tool-use
- Anthropic token-saving updates — https://www.anthropic.com/news/token-saving-updates
- OpenAI GPT-5 params (verbosity, reasoning_effort) — https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_new_params_and_tools
- OpenAI response-length control — https://help.openai.com/en/articles/5072518-controlling-the-length-of-openai-model-responses
- "JSON tax" output overhead — https://nehmeailabs.com/post/structured-output-overhead
