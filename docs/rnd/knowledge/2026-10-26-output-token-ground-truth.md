# Output-token ground truth — real agent trajectories (2026-10-26)

Source: public SWE-bench Verified submissions (S3 bucket per submission
metadata) — mini-SWE-agent v1.13.3 + Claude Sonnet 4.5 (20 trajs, 1,070
assistant turns, incl. API-reported usage) and OpenHands + GPT-5 (20 trajs,
607 turns, visible-text lower bound; GPT-5 hidden reasoning absent). Scripts
+ pooled results committed in evals/trace-analysis/. Tokenizer tiktoken
o200k_base (undercounts Claude output ~18-22% vs API-reported; both given).
These are distributions OF THESE SYSTEMS on SWE-bench, not universal truths.

## The numbers

- Per-turn output: median tiny (26-71 tok), p90 183-710, p99 1.2-1.6k —
  heavily right-skewed. TOP 10% OF TURNS CARRY 47-64% of output tokens.
- Real billed split (mini @ Sonnet 4.5 prices, $0.64/traj): output 29.3%,
  cache reads 51.6%, cache writes 19.0%, uncached input ~0.1%. On a
  well-cached agent output is the #2 cost line — and every output token is
  re-read ~27x in later turns, adding ~50% of its own price in cache reads.
- RE-EMISSION: 24.2% / 24.7% of all output tokens are lines already verbatim
  in prior context (two systems, convergent). Code lines 34.8% / 43.1%
  re-emitted; prose only ~2.5%. Concentrated in a minority of fat turns
  (p50=0, p99=0.8 per-turn fraction).
- REWRITE vs DIFF: bash-style whole-file heredoc rewrites are 57%
  compressible to changed-lines (~6.9% of that system's total output);
  OpenHands' str_replace tool shape structurally eliminates the waste
  (anchor overhead 42% of edit emission but near-minimal).
- Duplicate byte-identical actions: 8.1% / 4.1% of actions — retries MESH
  can flag free.
- Tool results: p99 2.5k / 6k tokens (OpenHands admits 10k-token results —
  fresh-result cap headroom confirmed on real traffic shape).

## Lever implications (feeds the reverse-engineering backlog)

1. RE-EMISSION REFERENCE LEVER (output side): detect context-duplicate lines
   in completions; nudge reference-instead-of-reprint via system guidance, or
   score re-emission per ledger event so customers SEE the waste (metering
   first, mutation later — output mutation is deep lossy territory).
   Measured target: ~24% of output = ~7% of a cached agent's total bill,
   before the cache-read echo.
2. DIFF-ENCOURAGEMENT lever (gated, advisory-first): measured ceiling ~57%
   of whole-file-rewrite turns for bash-style agents; agents with str_replace
   tools don't need it — detection must be shape-aware.
3. Output levers need only inspect completions >~200 tokens (turn
   concentration) — bounded latency cost.
4. Retry-duplicate flagging: 4-8% of actions, free to meter.

Open: chat-shape distributions (second miner), and our own real traffic via
ANTHROPIC_BASE_URL dogfooding (founder, 10 min).
