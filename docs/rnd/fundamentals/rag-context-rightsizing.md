# RAG context rightsizing — input-token waste in retrieval-augmented requests

**Axis:** rag-context-rightsizing (A3 redundancy, A4 irrelevance; touches A2 encoding)
**Author:** FLUX R&D literature mine, 2026-10-28
**Status (2026-11-13):** T1 (overlap/duplicate de-duplication) shipped as the
`chunkOverlapDedup` lever — `packages/core/src/token-reduction.ts`
(`dedupeOverlappingSentences`), `packages/sdk-js/src/reduce-request.ts`.
Measured 6.5–15.6% on a synthetic fixture
(`evals/run-rag-chunk-overlap-dedup.ts`); see
`docs/rnd/2026-11-13-NOTES.md` for the honest limits (sentence-boundary
assumption, synthetic fixture, not yet a published number). T2 (top-k tail
truncation) is still open — flagged as the next night's natural follow-on.
**Scope rule:** FLUX is a transparent proxy. It can only (a) rewrite the outgoing
request body before forwarding and (b) read provider-reported usage after. No model
weights, no logits/hidden states, no second LLM unless bundled on-machine (none bundled
today). Interactive latency budget ~tens of ms.

---

## TL;DR for FLUX

A RAG request ships a block of retrieved chunks inside `messages` (usually one user turn
or an appended system block). The literature is unambiguous that **a large fraction of
that block is not used by the model** — but almost every published method that exploits
this needs something FLUX does not have (a scorer model, or the generator's logits).

Where that leaves FLUX on this axis:

- **Two black-box, no-model levers survive** and are worth shipping behind the replay
  quality gate:
  1. **Retrieved-chunk overlap / duplicate de-duplication** (A3, near-lossless) — RAG
     indexers emit overlapping chunks (stride < chunk size), so adjacent retrieved
     chunks literally repeat token spans; near-duplicate documents repeat whole chunks.
     Detectable and removable by string matching alone. **Best fit on this axis.**
  2. **Top-k tail truncation** (A4, lossy, gate-required) — drop the lowest-ranked
     retrieved chunks the client's retriever already ordered. Pure byte rewrite, no
     model needed, because the client supplies the ranking.
- **Everything with a strong compression ratio is model-gated** (LLMLingua family,
  rerankers) → `research`, only viable if FLUX bundles a small model and the latency
  fits. **Or logit-gated** (Information Gain Pruning) → `reject`, white-box.
- **Chunk-size tuning is upstream of FLUX** (an index-build decision) → `reject` for a
  request-time proxy.

**Caching interaction (favorable, with one trap):** retrieved context is the *volatile*
part of a RAG prompt — it changes every query — so it is normally **not** part of a
stable cached prefix. Editing it therefore does **not** bust a cached prefix, which is
the opposite of the usual FLUX volatility problem. The trap: some clients place retrieved
docs *above* stable instructions/system text; editing there would invalidate the cached
suffix. FLUX must confine edits to the volatile region and leave any stable prefix byte-
identical.

---

## The evidence base: how much retrieved context is actually used

### 1. Over-retrieval saturates well below the context window (Databricks Mosaic)
*Leng et al., "Long Context RAG Performance of Large Language Models", arXiv:2411.03538
(2024). Databricks DocsQA / FinanceBench / HotpotQA / Natural Questions; 13–20 LLMs;
chunk size 512, stride 256 (≈50% overlap); FAISS + text-embedding-3-large.*

- Retrieval **recall saturates** (the generation upper bound) at: Natural Questions
  **8k tokens ≈ 13 chunks**; Databricks DocsQA 96k; HotpotQA/FinanceBench 128k.
  *(measured.)* Past the saturation point, more retrieved tokens add no new answer-
  bearing content — pure A4 waste for that query.
- **Generation quality peaks and then declines** far below max context for most models:
  Mixtral-8x7b peaks ≈4k, DBRX-Instruct ≈8k, Claude-3-Sonnet ≈16k, Llama-3.1-405b
  declines after 32k, GPT-4-Turbo after 64k. Only gpt-4o / claude-3.5-sonnet / gpt-4o-mini
  show "little to no deterioration". *(measured.)*
- Distinct failure modes at long context: Claude-3.5 copyright-refusals 3.7% @16k →
  **49.5% @64k**; DBRX instruction-following failures 5.2% @8k → **50.4% @32k**.
  *(measured.)*

**FLUX read:** when a client over-fetches (ships 20–50 chunks "to be safe"), the tail past
the saturation count is removable with no quality loss on that query. The saving is
workload-specific and must be gated.

### 2. "Lost in the middle" — context position wastes retrieved tokens
*Liu et al., "Lost in the Middle: How Language Models Use Long Contexts", TACL 2024
(arXiv:2307.03172). GPT-3.5/4, Claude, open models; multi-doc QA, 1 gold doc among
distractors, gold position swept.*

- U-shaped accuracy by gold-document position: GPT-3.5-Turbo **75.8%** when the answer
  doc is first → **53.8%** when the same doc is in the middle of 20 docs — a **~22 pp
  drop** from position alone. *(measured.)* Confirmed to persist on 1M-token models in
  follow-up work (2026).

**FLUX read:** does not reduce tokens directly, but establishes that middle chunks in a
long retrieved block are weakly used → trimming/reordering the middle is low-risk.
Reordering is token-neutral (not a saving lever) and *changes what the model sees* (lossy,
gate) — note, don't ship as a "saving".

### 3. Half of real retrieved context is insufficient/off-topic
*Hagström et al., "A Reality Check on Context Utilisation for RAG", arXiv:2412.17031
(2024). CounterFact / ConflictQA / DRUID; Llama-3.1-8B, Pythia.*

- On **DRUID** (real retrieved context, not synthetic), **~50% of retrieved context lacks
  a clear stance or is insufficient** to address the query. *(measured.)*
- Synthetic RAG benchmarks "exaggerate context characteristics rare in real retrieved
  data, which leads to inflated context utilisation results" — i.e. real deployments
  carry *more* dead weight than benchmarks imply. *(measured / authors' conclusion.)*

### 4. Models often don't need the retrieved context at all (Google)
*Joren et al., "Sufficient Context: A New Lens on RAG", arXiv:2411.06037 (2024/ICLR
2025). FreshQA / Musique / HotpotQA at 6k-token context; Gemini-1.5-Pro, GPT-4o,
Claude-3.5-Sonnet, Gemma-27B.*

- Fraction of instances with **sufficient** context: FreshQA 77.4%, HotpotQA 45.5%,
  Musique 44.6% — i.e. **~45–55% of multi-hop RAG context is insufficient**. *(measured.)*
- Models answer **>35% of insufficient-context instances correctly** anyway (parametric
  knowledge), "indicating retrieved context often proves unnecessary for correct answers."
  *(measured.)*

**FLUX read:** a large, measured share of retrieved tokens is noise — but §4 also warns
the gate must catch cases where trimming tips a *sufficient* context into *insufficient*.

---

## Techniques, ranked by FLUX applicability

### SHIP-CANDIDATES (black-box, no model, gate-required)

#### T1. Retrieved-chunk overlap / duplicate de-duplication — A3, near-lossless
**Mechanism:** RAG indexers chunk with overlap (stride < chunk size: Databricks used
512/256 = 50% overlap; 10–20% is the common default). When adjacent chunks of one
document are both retrieved, the overlap region is **byte-for-byte duplicated** in the
prompt. Near-duplicate source docs also yield whole repeated chunks. FLUX can detect
repeated spans / near-identical chunks by hashing + string match and emit each span once.
**Saving:** at 50% stride with adjacent chunks retrieved, up to ~50% of *those* chunks'
tokens are redundant; at the common 15% overlap, ~15% of overlapping-pair tokens.
*(reasoned / derived-from-data — depends on how many retrieved chunks are adjacent;
measure per workload.)*
**Lossless?** Near-lossless: the model reads the same information with duplicate spans
removed. Bill-wise, exact-duplicate removal is defensible as lossless; merged-overlap
needs the gate because join boundaries change bytes.
**Black-box?** Yes — string matching on the request body, no model.
**Caching:** retrieved region is volatile → editing it does not bust a stable prefix.
Safe.

#### T2. Top-k tail truncation — A4, lossy
**Mechanism:** the client's retriever already ranks chunks; FLUX drops the lowest-ranked
tail (e.g. 20→N) that sits past the measured saturation count. Pure body rewrite.
**Saving basis:** §1 — NQ saturates at ≈13 chunks; a client shipping 30 wastes ~17.
Reranking studies report **matching the quality of all chunks at ≈1/3 the token cost**
when only the top-ranked subset is kept *(literature-claim; blog-level, treat as upper
bound, verify on gate)*.
**Lossless?** Lossy — changes what the model sees. Mandatory replay quality gate;
§4 is the risk (dropping a chunk that carried sufficiency).
**Black-box?** Yes — relies on the client's existing ranking, no FLUX scorer.
**Caching:** volatile region, safe. One trap: if chunks are reordered/renumbered,
downstream citation indices can shift — keep stable chunk IDs if present.

### RESEARCH (strong ratios, but need a bundled model + latency headroom)

#### T3. LLMLingua-2 — task-agnostic token compression — A3/A4, lossy
*Pan et al., arXiv:2403.12968 (ACL 2024).* Lightweight BERT-base token classifier drops
low-information tokens. **2–5× compression**, **1.6–2.9× faster** than LLMLingua-1,
"task-agnostic" (no question needed → stable, cache-friendlier than question-aware).
*(literature-claim, measured in paper.)*
**FLUX fit:** needs a bundled ~0.1–0.5B classifier; adds inference latency per request —
tight against the tens-of-ms budget. Viable only if bundled and latency-profiled.
Lossy → gate.

#### T4. LongLLMLingua — question-aware compression — A4, lossy
*Jiang et al., arXiv:2310.06839 (ACL 2024).* Uses a small LM's perplexity + question-aware
coarse/fine selection + doc reorder. On **NaturalQuestions: +21.4% accuracy at ~4× fewer
tokens** (GPT-3.5-Turbo); **94.0% cost reduction on LooGLE**; $28.5/$27.4 saved per 1k
samples on LongBench/ZeroScrolls; end-to-end **1.4–2.6× latency speedup** at 2–6×
compression on ~10k-token prompts. *(measured in paper.)*
**FLUX fit:** needs a bundled ~7B LM for perplexity → a 7B forward pass per request
blows the interactive latency budget. **Research only**; borderline `reject` for
interactive. Question-aware → busts cache if the retrieved block were cached (usually it
isn't). Strongest *numbers* on this axis, weakest *fit*.

#### T5. Reranking to shrink top-k — A4, lossy
*e.g. Cohere Rerank; RankRAG arXiv:2407.02485.* Over-fetch, cross-encoder rescores, keep
top-N. Reported **~1/3 token cost at matched quality**, **~49% TTFT reduction** with
<0.02 ROUGE delta *(literature-claim / vendor-blog level).*
**FLUX fit:** needs a bundled cross-encoder reranker; same latency/bundling caveat as T3.
Research. (Distinct from T2: T2 trusts the client's ranking and needs no model; T5
re-ranks with FLUX's own model.)

### REJECT

#### R1. Information Gain Pruning (IGP) — white-box
*Song et al., "Less is More for RAG", arXiv:2601.17532 (2026).* Prunes passages by the
generator's own information gain. **76–79% final-stage token reduction** (TopM=5, ~837→203
tokens) with **+12–20% relative F1** and 4.6–6.0× token efficiency on NQ/TriviaQA/PopQA
(Qwen2.5, Llama-3.x). *(measured.)*
**Why reject:** "requires only step-wise logits (or TopK log-probabilities)" from the
generator — **logit access FLUX does not have**. Cited here only as a measured *upper
bound*: ~75–80% of a retrieved block can be redundant/low-gain.

#### R2. Chunk-size / overlap tuning — upstream of FLUX
*machinelearningplus / PreMAI / CARROT (arXiv:2411.00744).* Optimal chunk size 128–512
tokens, task-dependent (256 single-hop, 512 multi-hop in CARROT). **Index-build decision**
made before the request exists; a request-time proxy cannot re-chunk. Reject for FLUX,
but the overlap it creates is exactly what **T1** harvests.

---

## Latency caveat (applies to T3–T5)
*Prompt Compression in the Wild (arXiv:2604.02985)* reports that compression's own compute
can offset the latency saved by shorter prompts, especially when KV/prefix caching already
amortizes the long prompt. *(literature-claim — PDF numbers not extracted; flagged for
follow-up.)* For FLUX this is decisive: any bundled-model lever must show net latency ≥0
*after* its own inference cost, inside the tens-of-ms budget. T1/T2 (no model) avoid this
entirely.

## What to measure next in the sandbox
`evals/fundamentals/rag_context_rightsizing.py`:
1. **Overlap/duplicate rate** in real retrieved blocks (HF RAG datasets) — the direct T1
   saving, derived-from-data.
2. **Top-k saturation curve** per workload — the N past which recall/answers stop
   improving, to set the T2 truncation point and feed the gate.

## Sources
- Leng et al. 2024, Long Context RAG Performance — https://arxiv.org/abs/2411.03538 ;
  https://www.databricks.com/blog/long-context-rag-performance-llms
- Liu et al. 2024 (TACL), Lost in the Middle — https://arxiv.org/abs/2307.03172
- Hagström et al. 2024, Reality Check on Context Utilisation — https://arxiv.org/abs/2412.17031
- Joren et al. 2024, Sufficient Context — https://arxiv.org/abs/2411.06037 ;
  https://research.google/blog/deeper-insights-into-retrieval-augmented-generation-the-role-of-sufficient-context/
- Pan et al. 2024, LLMLingua-2 — https://arxiv.org/abs/2403.12968
- Jiang et al. 2024, LongLLMLingua — https://arxiv.org/abs/2310.06839 ; https://aclanthology.org/2024.acl-long.91/
- Song et al. 2026, Less is More for RAG (IGP) — https://arxiv.org/abs/2601.17532
- Lin et al. 2024, RankRAG — https://arxiv.org/abs/2407.02485
- Chen et al. 2024, CARROT — https://arxiv.org/abs/2411.00744
- Prompt Compression in the Wild — https://arxiv.org/abs/2604.02985
