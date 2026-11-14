# A3/A4 — Prompt compression literature (LLMLingua family, Selective Context, gist tokens)

Axis: **A3A4-prompt-compression**. Question for MESH: can any published
prompt-compression technique shrink INPUT tokens by rewriting request bytes
only — no model/logit access, no second LLM, inside a ~tens-of-ms latency
budget — and can we bill it?

**Headline (one sentence):** Every mature prompt-compression method in the
literature is LOSSY and requires running a *second model* — either a small
causal LM for perplexity scoring (LLMLingua / LongLLMLingua / Selective
Context) or a trained token classifier (LLMLingua-2) or a fine-tuned target
(gist/soft-prompt) — so under MESH's "no bundled LLM today + tens-of-ms
budget + lossless-bills-unconditionally" constraints the entire family is
**REJECT today**; the single least-bad research candidate is
LLMLingua-2-small, and even it is lossy (needs a replay quality gate), takes
~0.4-3 s wall-clock, and busts prefix caching on every turn.

---

## The MESH gate, applied up front

MESH can only (a) rewrite the outgoing request body before forwarding and
(b) read provider-reported usage after. It **cannot run a second LLM unless
bundled on-machine (none bundled today)**, cannot see target logits, and has
a ~tens-of-ms interactive budget. Two rules decide everything below:

- **Lossless bills unconditionally; lossy needs a replay quality gate.** All
  prompt compression here deletes or rewrites tokens the model would have
  read → it changes what the model sees → **lossy**. None of it is an A2
  (lossless, same-information) lever. It lives in A3 (redundancy,
  near-lossless at best) and A4 (irrelevance, lossy).
- **Black-box = rewrite request bytes with no model/logit access.** Token-
  pruning methods are black-box *with respect to the target* (they never
  touch the target's logits) — but they are NOT byte-only: they need an
  auxiliary model to *decide* what to cut. That auxiliary model is itself a
  second LLM/encoder MESH would have to bundle. So "works with black-box
  LLMs" in these papers ≠ "works for MESH as a pure byte rewrite."

---

## Technique-by-technique (measured numbers, honesty-labelled)

### 1. LLMLingua (Jiang et al., EMNLP 2023) — arXiv 2310.05736
- **Mechanism:** budget controller + iterative token-level pruning. Uses a
  small causal LM (GPT-2 / LLaMA-7B) to compute token **perplexity**; drops
  low-information tokens. Requires running that small LM; needs its logits
  (white-box on the *compressor*, black-box on the target).
- **Measured:** up to **20x** compression with a **~1.5-point** performance
  drop on the authors' benchmarks; 2,366-token prompt → 117 tokens with
  "almost unchanged" performance *(literature-claim, author-reported)*.
  Degrades sharply past ~25-30x on GSM8K *(literature-claim)*.
- **Lossless/lossy:** LOSSY. **Black-box for MESH:** NO — needs a bundled
  7B compressor LM (12.5-16.5 GB RAM, independent benchmark below).
- **Verdict: REJECT** (second LLM required; latency; lossy).

### 2. LongLLMLingua (Jiang et al., 2023) — arXiv 2310.06839
- **Mechanism:** question-aware coarse-to-fine compression + document
  reordering for long-context/RAG. Same small-LM perplexity dependency,
  made *query-conditional*.
- **Measured:** **up to 21.4% accuracy boost at ~4x fewer tokens** on
  NaturalQuestions multi-doc QA with GPT-3.5-Turbo; up to **94.0% cost
  reduction** on LooGLE; 1.4x-2.6x end-to-end latency accel at 2x-6x on
  ~10k-token prompts *(all literature-claim, author-reported)*.
- **Note:** the query-aware step makes the rewrite depend on the *current
  question* → maximally cache-hostile (see caching section).
- **Lossless/lossy:** LOSSY. **Black-box for MESH:** NO (second LLM).
- **Verdict: REJECT** (second LLM; per-query volatility).

### 3. LLMLingua-2 (Pan et al., ACL Findings 2024) — arXiv 2403.12968
- **Mechanism:** reframes compression as **token classification** (keep/drop)
  with a Transformer *encoder* (XLM-RoBERTa-large or mBERT) trained on
  GPT-4-distilled data. **Does NOT need target logits, and does NOT run a
  causal LM for perplexity** — just a forward pass of a small bidirectional
  encoder over the request text. This is the closest thing to "byte rewrite"
  in the family, but it is still a bundled neural model.
- **Measured (author-reported):** MeetingBank in-domain QA F1 **86.9 vs 67.5**
  for LLMLingua; LongBench avg **39.1 vs 34.6** at 5x; GSM8K 1-shot EM
  **79.08** (≈ LLMLingua) at 5x; BBH **70.0** at 3x. **3x-6x faster** than
  prior compressors; end-to-end **1.6x-2.9x** at 2x-5x. MeetingBank 3x QA:
  14.9 s → 7.5 s end-to-end, compressor itself **0.4 s** (vs 2.1 s for
  LLMLingua). Model-inference-only **0.01-0.03 s** on A100. RAM **0.66-3.25 GB**.
- **Lossless/lossy:** LOSSY (deletes tokens). **Black-box for MESH:** NO as a
  byte rewrite — but it is the **only** family member whose compute profile
  (small encoder, 10-30 ms pure inference, sub-GB small variant) is even in
  the conversation IF we ever bundle a model.
- **Verdict: RESEARCH** (least-bad candidate; still lossy + bundled model +
  seconds of wall-clock at long contexts + cache-bust).

### 4. Selective Context (Li et al., 2023) — arXiv 2304.12102
- **Mechanism:** compute **self-information** (negative log-prob) for each
  lexical unit using a base causal LM (paper used GPT-3 **Curie 6.7B**; GPT-2
  / OPT / LLaMA also work); drop low-self-information tokens/phrases/sentences.
  Requires running that LM over the full input.
- **Measured (author-reported), summarization:** at **0.35** reduction (cut
  35%): BLEU 0.212 (−0.062), ROUGE-1 0.533 (−0.037), ROUGE-2 0.265 (−0.056),
  BERTScore-F1 0.903 (−0.008). At **0.50** reduction: BLEU 0.170 (−0.104),
  ROUGE-1 0.500 (−0.070), BERTScore-F1 0.896 (−0.015). Authors recommend
  ≤0.35 as the usable threshold — i.e. real-world safe compression is modest,
  not 20x.
- **Lossless/lossy:** LOSSY. **Black-box for MESH:** NO (second LLM).
- **Verdict: REJECT** (second LLM; modest safe ratio).

### 5. Gist tokens (Mu et al., NeurIPS 2023) — arXiv 2304.08467
- **Mechanism:** fine-tune the target with a modified attention mask so a
  prompt is distilled into a few "gist" activation tokens that are then
  KV-cached. Up to **26x** compression, "minimal quality loss", up to **40%
  FLOPs** / **4.2% wall-time** reduction *(literature-claim)*.
- **Lossless/lossy:** LOSSY. **Black-box for MESH:** NO — **white-box**:
  requires fine-tuning the target and injecting *continuous embeddings*, which
  a provider HTTP API will not accept as request bytes.
- **Verdict: REJECT** (white-box; not byte-expressible).

### 6. Soft-prompt family — ICAE, AutoCompressor, 500xCompressor, xRAG, CC
  (surveyed in arXiv 2410.12388)
- **Mechanism:** encode context into learned continuous vectors. 500xCompressor
  reports 6x-480x at **62.3%-72.9%** capability retention *(literature-claim)*.
- **Lossless/lossy:** LOSSY. **Black-box for MESH:** NO — soft prompts are
  embeddings, not text; cannot be sent over a text-completion API, and most
  need a fine-tuned/aligned target.
- **Verdict: REJECT** (white-box / not byte-expressible). Same for
  context-distillation generally (trains the target — white-box).

---

## The decisive independent datapoint — "Prompt Compression in the Wild" (arXiv 2604.02985)

This is a third-party benchmark (not the method authors), so it is the honest
counterweight to the author-reported ratios above. Measured on A100:

- **Compression WALL-CLOCK is seconds, not ms.** LLMLingua: **~13 s** to
  compress a 48k-token prompt (21 s total). LLMLingua-2: **under 3 s** for
  48k (its small encoder *inference* is 10-30 ms, but tokenization/packing
  dominate). On Apple M1 Pro, 3-5x slower than A100.
- **"Compression overhead outweighs any benefits"** in most real scenarios.
  Net speed-up only appears for prompts **>2,000 tokens AND ratios ≥5x**;
  for inputs ≤4,000 tokens on vLLM, compression *adds* latency.
- **Max observed end-to-end gain: ~18%**, and only under optimal conditions.
- **Rate adherence:** LLMLingua misses its target ratio badly at length
  (mean abs error >0.15 at 8k+ tokens); LLMLingua-2 holds the target well.
- **Quality under compression (~3.7x) is task-dependent and sometimes
  cliff-like:** summarization robust to ~5.7x; but passage-counting drops
  "below 20% → below 4.5%", passage-retrieval sometimes <50%, TREC/LSHT-ZH
  up to −52%, code-gen edit-similarity drops materially. *(measured,
  third-party.)*

Honesty label on this whole section: **measured, third-party** — the
strongest evidence we have, and it points the opposite way to the headline
ratios the method papers advertise.

---

## Caching interaction (MESH A1 is DONE — protect it)

- Every method here **re-edits the prompt bytes on each request**. LongLLMLingua
  is query-conditional, so the compressed bytes change with every user
  question — the worst case.
- MESH's largest confirmed win is retransmission/caching (A1). A token-pruning
  rewrite applied to an otherwise-stable, cacheable prefix would **change the
  prefix bytes and bust the provider's prompt cache**, converting cache-reads
  (cheap) back into full input (expensive). On a well-cached agent the cache
  is ~50%+ of spend — so compressing the cacheable region can be **net
  negative** even before the quality gate.
- Any future use would have to be confined to the **non-cacheable, per-turn
  tail** and gated by the volatility guard. That is a narrow, low-value slice.

---

## Bottom line for MESH

1. **No prompt-compression method is a lossless A2 lever** — none can be billed
   unconditionally; all require a replay quality gate.
2. **All require a second model** MESH does not bundle: a causal LM (LLMLingua /
   LongLLMLingua / Selective Context) or a token-classifier encoder
   (LLMLingua-2), or they are white-box soft prompts (gist / ICAE / 500x).
   Under "no bundled LLM today," the whole family is **REJECT today**.
3. **Latency kills the generic case anyway:** 0.4-3 s+ compression wall-clock
   vs a ~tens-of-ms budget; third-party net gain capped at ~18% and only for
   long (>2k-token), high-ratio (≥5x) prompts.
4. **Caching conflict:** per-turn byte rewrites bust the A1 cache win, which is
   larger than anything compression offers.
5. **The only thing worth a sandbox** is LLMLingua-2-small as a *future,
   opt-in, long-context, non-cached-tail, quality-gated* lever — explicitly a
   RESEARCH item, contingent on MESH ever bundling an on-machine encoder.
   Sandbox skeleton: `evals/fundamentals/prompt_compression_probe.py`.

Primary sources: LLMLingua https://arxiv.org/abs/2310.05736 ·
LongLLMLingua https://arxiv.org/abs/2310.06839 ·
LLMLingua-2 https://arxiv.org/abs/2403.12968 (ACL
https://aclanthology.org/2024.findings-acl.57/) ·
Selective Context https://arxiv.org/abs/2304.12102 ·
Gist tokens https://arxiv.org/abs/2304.08467 ·
Survey https://arxiv.org/abs/2410.12388 ·
In-the-wild benchmark https://arxiv.org/abs/2604.02985
