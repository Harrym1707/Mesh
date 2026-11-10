# Fundamentals — Information theory of prompt redundancy (axis: info-theory-redundancy)

Date: 2026-10-28. Author axis: info-theory-redundancy. Scope: ground how much
of a prompt is *theoretically recoverable* and **by which MESH axis**, from
primary information-theory + context-utilisation literature. Every number
carries an honesty label (measured / derived-from-data / literature-claim /
reasoned / estimate). Sandbox: `evals/fundamentals/redundancy-decomposition.mjs`.

MESH constraints assumed throughout: black-box only (rewrite request bytes,
read provider usage); no weights/logits/hidden states; no second LLM bundled
today; ~tens-of-ms latency budget; bill 1% of VERIFIED savings; lossless =
billed unconditionally, lossy = must clear the replay quality gate.

---

## TL;DR — the one load-bearing finding

**Shannon redundancy of a prompt is real and large (natural-language text is
~50-75% redundant), but it is NOT the redundancy MESH can bill.** The model
never reads bytes — it reads BPE tokens, and the tokenizer has *already* folded
most of that statistical redundancy into its merges. The gzip/entropy number is
therefore a ceiling on an *already-spent* compression, not on MESH-addressable
savings. What survives for a byte-rewrite proxy splits cleanly:

- **A2 encoding overhead** — structural/whitespace/schema bytes the model reads
  as identical information once decoded. Genuinely **lossless**, small (single-
  digit % of tokens on real bodies), MESH bills unconditionally.
- **A3 literal / verbose redundancy** — byte-identical repeats (provable) and
  verbose paraphrase (needs a model). The provable part is **near-lossless**
  and replay-gated; the verbose part is **lossy** and needs a model we don't
  have.
- **A4 irrelevance** — context the task never uses. The literature
  (lost-in-the-middle, RULER, extractive-compression results) shows this slice
  is *large* (often 80-90% of long contexts), but identifying it is
  task-specific and **lossy** — it needs a model/reranker, so it is **research /
  REJECT** for a pure byte lever.

The sophisticated prompt-compression methods that achieve the headline 2-20x
numbers (LLMLingua family, Selective Context) are **all REJECT as shipped**:
every one requires running a second model (GPT-2/LLaMA-7B/Curie for
self-information, a 355M BERT for token classification). They are the right
*measuring sticks* for the recoverable ceiling and the right *research targets*
if we ever bundle a tiny on-machine scorer — but they are not black-box
byte-rewrites.

---

## 1. Shannon redundancy of natural language — the ceiling, and why it's spent

Classic result, repeatedly re-measured:

- Shannon's own estimate: English ~**1.0 bit/character**, bounded **0.6-1.3
  bits/char** over 100-char spans (literature-claim).
- Cover & King (gambling): **1.25-1.35 bits/char** (literature-claim).
- Teahan & Cleary (PPM compression): **1.46 bits/char** (literature-claim).
- Kontoyiannis (string matching): **1.77 bits/char** (literature-claim).
- Large crowdsourced Shannon-game (Mechanical Turk, MDPI Entropy 2019):
  **h ≈ 1.22 bits/char** (literature-claim, measured in-paper).
- Against a max of ~**4.7 bits/char** (log2 of ~26-27 symbols), this implies
  English **relative entropy ~25-50%**, i.e. **redundancy ~50-75%**
  (reasoned from the above).

**Why this is already spent for us (reasoned, primary-grounded):** a BPE/
byte-pair tokenizer *is* a compressor — it exists precisely to merge frequent,
predictable byte sequences into single tokens. The provider bills per token, so
the predictable-character redundancy Shannon measured has already been monetised
*down* by the tokenizer before MESH ever sees the request. A byte-level
re-encode (gzip-style) cannot be sent to the model — the model only accepts the
token vocabulary — so none of the 50-75% character redundancy is recoverable as
a token saving by lossless means. **This is the single most important guardrail
for this axis: never quote a compression-ratio-of-bytes number as a token
saving.** The sandbox demonstrates the gap live (74.5% gzip redundancy vs ~0 of
it billable).

Sources:
- A New Look at the Classical Entropy of Written English — https://arxiv.org/abs/0911.2284
- Entropy Rate Estimation for English via a Large Cognitive Experiment (Mechanical Turk), MDPI Entropy 2019 — https://www.mdpi.com/1099-4300/21/12/1201
- Teahan & Cleary, The Entropy of English using PPM — https://gwern.net/doc/cs/algorithm/information/compression/1996-teahan.pdf

---

## 2. Code and structured data are *more* redundant than prose

- Hindle, Barr, Su et al., *On the Naturalness of Software* (ICSE 2012): source
  code is **more repetitive and predictable than natural language** — simple
  n-gram models reach markedly lower cross-entropy on code than on English
  (literature-claim; the paper's headline is code is "even more natural"/
  lower-entropy than English corpora under matched n-gram models). Buggy code
  has measurably higher entropy than correct code (Ray et al., follow-on).
- Implication for MESH (reasoned): agent/coding traffic — our highest-value
  vertical — carries the *most* statistical redundancy, but again it is
  tokenizer-captured. The MESH-addressable slice in code/JSON is the
  **structural** one (A2: pretty-print whitespace, restated schema keys,
  pydantic `title` bloat already documented in our wire captures) plus
  **literal duplication** (A3), not the deep n-gram predictability.

Source:
- Hindle et al., On the Naturalness of Software — https://cs.uwaterloo.ca/~m2nagapp/courses/CS846/1179/papers/hindle_icse12.pdf

---

## 3. Empirical recoverable-redundancy ceilings from prompt-compression papers

These give the *measured* ceiling on how much of a prompt is non-essential for
the task — the A3-verbose + A4-irrelevance budget. **All are lossy and all need
a model, so all are REJECT as black-box levers.** They are cited as the ceiling,
not as ship candidates.

| Method | Mechanism | Measured compression / quality | Model needed | MESH verdict |
|---|---|---|---|---|
| **LLMLingua** (EMNLP'23) | small LM perplexity ranks & drops tokens; budget controller + iterative | up to **20x** (2,366→117 tok) with "almost unchanged" perf; at 20x on a reasoning task **77.33 EM** vs Selective-Context 44.20 (literature-claim, in-paper measured) | GPT2-small / LLaMA-7B | REJECT (second model) |
| **LLMLingua-2** (ACL'24) | 355M XLM-RoBERTa token classifier, distilled from GPT-4 preserve/discard labels | **2x-5x** typical; MeetingBank in-domain ~3x: QA EM **86.92 vs 87.75** original; out-of-domain 5x: LongBench **39.1 vs 44.0**, GSM8K **79.08 vs 78.85**, BBH **70.02 vs 70.07**; **1.6-2.9x** end-to-end latency cut; 3-6x faster than LLMLingua (literature-claim, in-paper measured) | 355M BERT (110M "small") | REJECT today; **RESEARCH** if a ~100-355M scorer is ever bundled on-machine |
| **Selective Context** (EMNLP'23) | self-information from a base LM; drop low-information lexical units | at **50%** context cut: BERTScore-F1 **.887 (−.023)**, ROUGE-1 **.449 (−.12)**, BLEU **.179 (−.17)**; retains ~**57.2%** of tokens; 36% memory / 32% time cut (literature-claim, in-paper measured) | LLaMA-7B / Curie | REJECT (second model) |
| **Extractive (reranker) compression** (Jha et al. 2024 survey/char.) | rank & keep whole relevant chunks, drop the rest | up to **~10x** "with minimal accuracy degradation"; 2WikiMultihopQA **7.75x while +7.89 acc**; MuSiQue **4.14x while +7.16 acc**; implies ~**80-90% of tokens lack task-critical info** on multi-doc QA (literature-claim, in-paper measured) | reranker/embedder | REJECT as generic lever (task-specific, needs retrieval scorer); informs A4 ceiling |

**Two honest reads of this table:**

1. The ceiling is enormous — on retrieval-style long contexts, **80-90% of
   tokens are task-irrelevant** (A4). That is where the real money is, and it is
   exactly where MESH's pure-byte toolkit is weakest, because finding the
   irrelevant 85% requires understanding the task.
2. **Token-pruning disrupts quality more than chunk-level extraction.** The
   characterisation paper finds LLMLingua-style unstructured pruning "typically
   exhibits the worst behaviour," attributed to "disruption of grammar and
   sentence comprehension." Lesson for any MESH lossy lever we ever build:
   **operate at structural boundaries (whole tool results, whole stale turns),
   never mid-sentence token deletion.** This directly supports the existing
   semantic-compaction design (drop whole stale oversized tool results) over any
   token-salience pruning.

Sources:
- LLMLingua (EMNLP'23) — https://arxiv.org/abs/2310.05736 · https://github.com/microsoft/LLMLingua
- LLMLingua-2 (ACL'24) — https://arxiv.org/abs/2403.12968
- Selective Context — https://arxiv.org/abs/2310.06201
- Characterizing Prompt Compression Methods for Long Context Inference — https://arxiv.org/abs/2407.08892
- Prompt Compression for LLMs: A Survey — https://arxiv.org/abs/2410.12388

---

## 4. Context-utilisation studies — how much context the model actually uses (bounds A4)

- **Lost in the Middle** (Liu et al., TACL 2023, arXiv 2307.03172). Multi-doc QA
  over 10/20/30 docs. **Measured** U-shape: GPT-3.5-Turbo at 20 docs scored
  **75.8%** (relevant doc first) → **53.8%** (middle) → **63.2%** (last) — a
  **22.0-point** best-to-worst gap; at 30 docs **73.4% → 50.5% → 63.7%**
  (**22.9-point** gap). Claude-1.3 was flatter (**59.9 → 55.9 → 60.1**).
  Key-value retrieval: GPT-3.5 fell to **45.6%** worst-case at 300 pairs without
  query-aware contextualisation (literature-claim, in-paper measured).
  - MESH read: middle-of-context tokens are frequently *paid for and ignored*.
    That is genuine A4 waste — but it is **lossy to remove** (you must decide
    what's irrelevant) and **model/position-dependent**. Not a byte lever; it
    quantifies the prize, not a method.
- **RULER** (Hsieh et al. 2024, arXiv 2404.06654). "Effective context length"
  (longest length still above an 85.6% threshold) is routinely **far below the
  advertised window** — e.g. Yi-34B **93.3% @4K → 77.3% @128K**, effective ~32K
  vs a claimed 200K (literature-claim, in-paper measured).
  - MESH read: customers pay for context past the model's effective length that
    returns degraded accuracy — an A4 over-provisioning signal. Lossy to act on;
    useful as a *diagnostic* MESH could surface ("you're sending 120K into a
    model with ~32K effective length") even before any rewrite.

Sources:
- Lost in the Middle — https://arxiv.org/abs/2307.03172 · https://arxiv.org/html/2307.03172v3
- RULER — https://arxiv.org/abs/2404.06654

---

## 5. Caching interaction (rule 3) — redundancy work vs the prefix cache

- **A2 lossless minify** at the *client* boundary is a one-time canonicalisation;
  if applied stably it does **not** fight caching (same bytes every turn). If
  applied as a per-request rewrite it must be deterministic or it busts the
  cached prefix — prefer canonicalise-once.
- **A3 literal dedup** is the dangerous one: duplicated spans most often live in
  the *system / tool-schema prefix* — exactly the cacheable region. Deduping
  there changes the prefix bytes and **busts the cache it was meant to help**,
  and a lever that must re-edit the prefix every turn fights the volatility
  guard. Rule: dedup only *outside* the cached prefix, or fold it into the
  one-time prefix canonicalisation, never as a per-turn edit.
- **A4 context pruning** (if ever built, lossy) changes the middle/tail of the
  message array — lower cache-risk than prefix edits, but any change upstream of
  a cache breakpoint invalidates everything after it. Prune *below* the last
  breakpoint only.

---

## 6. Sandbox — `evals/fundamentals/redundancy-decomposition.mjs`

Zero-dep Node (uses only `zlib`). Decomposes each captured request body into
A2 (lossless JSON minify), A3 (literal byte-duplicate lines + self-repeating
string fields — a conservative floor), and the gzip Shannon proxy, and prints
the honest gap between the gzip number and the billable number.

Run (MEASURED on `frameworks-2026-10-25.jsonl`, n=11 — note this is a **stress
fixture** padded with repeated system lines, so its A3 figure is not
representative traffic):

```
A2 lossless (minify JSON)     : 23.4% of raw pretty-printed bytes  [LOSSLESS]
A3 literal-dup spans (floor)  : 49.8% of minified bytes            [NEAR-LOSSLESS, replay-gated]
gzip redundancy of minified   : 74.5%                              [SHANNON PROXY — NOT billable]
```

Reading: the 74.5% gzip figure is the Shannon-style byte redundancy — **none of
it is a token saving** because BPE already captured it. The A2 23.4% is inflated
by comparing *pretty-printed* input to minified (most clients send compact JSON,
so real A2 is smaller); it is the only strictly-lossless slice. The A3 49.8% is
inflated by this fixture's deliberate repetition — but the mechanism (byte-
identical span dedup) is the one provable near-lossless move, and it belongs
*outside the cache prefix*. Point the script at real traffic
(`node evals/fundamentals/redundancy-decomposition.mjs <file.jsonl>`) to get a
representative split, and swap `ceil(len/4)` for a real tokenizer before quoting
any token delta.

---

## 7. What this axis concludes for the lever backlog

1. **Do not build a byte-entropy / gzip-style lever.** It targets redundancy the
   tokenizer already spent; the saving is unbillable. (Guardrail against a
   plausible-sounding dead end.)
2. **A2 structural canonicalisation is the only lossless redundancy win** and it
   is small — it rides along with the existing tool-schema minifier /
   whitespace normalisation, priced unconditionally, verified per-provider that
   decoded-JSON re-tokenisation makes it token-neutral-or-better.
3. **A3 literal dedup is a real near-lossless lever** but is cache-hostile in the
   prefix — restrict to non-prefix / one-time canonicalisation and replay-gate.
4. **The big prize (A4, 80-90% on long contexts) is lossy and needs a model we
   don't bundle.** Mark LLMLingua-2 (355M) as the leading **RESEARCH** candidate
   *if and only if* we ever ship a bundled on-machine scorer within the ~tens-of-
   ms budget; until then it is REJECT. The lost-in-the-middle / RULER findings
   justify a **diagnostic-only** product surface ("you're paying for ignored /
   beyond-effective-length context") that carries no quality risk.
5. **Structural-boundary over token-salience, always** — the characterisation
   paper's grammar-disruption finding backs the existing semantic-compaction
   design (whole stale tool results) over any mid-sentence pruning.
