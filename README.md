# Mesh: a local proxy for LLM API traffic, with a bill you can recompute

[![savings: recompute it yourself](https://img.shields.io/static/v1?label=savings&message=recompute%20it%20yourself&color=brightgreen)](docs/site/evidence.md)
[![fee: 1% of verified savings](https://img.shields.io/static/v1?label=fee&message=1%25%20of%20verified%20savings&color=blue)](https://www.mesh-technology.com/pricing.html)
[![npm @harrym1707/sdk](https://img.shields.io/npm/v/@harrym1707/sdk?label=%40harrym1707%2Fsdk)](https://www.npmjs.com/package/@harrym1707/sdk)

Mesh is a local proxy for LLM API traffic, for teams running their own agents on the Anthropic or OpenAI API: out of the box it makes three lossless changes to each request and records every saving in a hash-chained ledger on your own machine, so you can recompute the bill yourself.

The fee is 1% of verified savings for the month, rounded down to the cent, and nothing else; no fee is due unless billing has been agreed in writing.

- **Who it is for.** Teams that call the Anthropic or OpenAI API from their
  own agents (coding, browsing, support, RAG, multi-agent). It also works
  with Claude Code, but a Claude Code user gains little on the defaults.
- **Integration is one URL.** Run the proxy and point your client's
  `base_url` at it. Any language. Your API key passes through verbatim; Mesh
  never holds credentials, and prompts never leave your machine.
- **The invoice is a pure function of a ledger you hold.** Every request
  writes one hash-chained event; run `mesh verify` on your own ledger and you
  must get the same number. If Mesh saved nothing, it says `do_not_charge`.
- **Status.** Mesh has no customers yet and has not been measured on a
  customer's provider bill. Every figure below is from Mesh's own test basket
  or its simulator, and says which.

## What a fresh install does today

Out of the box Mesh makes three lossless changes: tool-schema compaction,
exact-duplicate removal and cache-prefix repair. On Mesh's own 30-request test
basket (LIVE, run 2026-10-26, not a customer's traffic) those three account
for under half of the 18.2% recorded; the rest came from two levers that are
off by default, a 5-minute Anthropic cache stamp and a gate-approved cap on
oversized tool results. A Claude Code user gains little on the defaults. The
larger figures below needed levers that you or Theo switch on;
[docs/site/start.md](docs/site/start.md) says how.

## The published figures, and what each one needed

LIVE means real API calls on a test basket Mesh wrote. SIMULATOR means
modelled on a harness at the providers' published prices. The "J stack" is
tool-description trimming, exact-duplicate removal, cache-prefix repair, a cap
on oversized tool results, stale-history compaction and an output cap; four
of those six are off in a fresh install.

| Workload | Figure | Label and date | Levers it needed |
|---|---|---|---|
| Mixed basket of five test agents (30 requests, claude-sonnet-5-5) | **18.2%** of real spend | LIVE, run 2026-10-26 | The three defaults plus a 5-minute cache stamp and a gate-approved tool-result cap, both off by default. Spools in `evals/live-exports-2026-10-26/` |
| Multi-turn Claude that places no cache breakpoints | **37.9%** | SIMULATOR, verified 2026-10-22 | The 5-minute Anthropic cache stamp alone, off by default |
| The same, full stack against a raw uncached baseline | **57.3%** lower simulated cost, 5 points lower clean-task quality | SIMULATOR, verified 2026-10-22 | The J stack plus the cache stamp. Fails the quality limit; not a qualified saving |
| Background or batch work that can wait | **57.7%** net (64.3% ceiling) | SIMULATOR, verified 2026-10-13 | The J stack plus the provider's flex tier, not on by default |
| One-shot calls on a shared template | **45.5%**, up to **72.8%** where the work can wait | SIMULATOR, verified 2026-10-13 | Cache-prefix repair (on by default, carries most of the 45.5% on a provider that caches automatically) plus description trimming, history compaction and an output cap; the 72.8% adds the flex tier |
| Sparse interactive agents | **34.3%** | SIMULATOR, verified 2026-10-22 | The J stack plus the 1-hour Anthropic cache stamp, off by default |
| Busy interactive agents | **25.9–29.4%** | SIMULATOR, verified 2026-10-13 | The J stack; the three defaults alone move this simulated bill very little |
| Stacks that are already optimised | **0–5%** | SIMULATOR, fixture, 2026-10-11 | Nothing to switch on; Mesh tells you not to pay |

Every figure traces to a command, a date and its levers:
[docs/site/evidence.md](docs/site/evidence.md). The 18.2% (LIVE, run 2026-10-26, with a cache stamp and a tool-result cap
switched on) predates a correction of 2026-10-29 to how tool-schema
compaction is measured; the evidence page explains what that changes.

## Quick start (no code changes)

Open to everyone: no signup, no account. Needs Node 22 or newer.

```bash
curl -fsSL https://www.mesh-technology.com/install.sh | sh   # macOS, Linux, WSL
# or: npm install -g @harrym1707/mesh
```

Then connect what you run:

```bash
mesh proxy    # your own app or agent: prints the base URL to set
mesh start    # Claude Code: points it at Mesh, restores it on Ctrl+C
mesh verify   # re-check the ledger and recompute the invoice yourself
```

(No install: `npx -y -p @harrym1707/sdk mesh-proxy` runs the proxy on its own.
Prefer building from source? `git clone https://github.com/Harrym1707/Mesh && cd Mesh`,
then `corepack enable && pnpm install && pnpm build` and `node --import tsx evals/run-proxy.ts`.)

For your own app, set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or
`OPENAI_BASE_URL=http://127.0.0.1:8787/v1`, or change one line:

```js
// Anthropic SDK
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });
// OpenAI SDK
const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" });
```

The three default changes are applied before a request reaches the provider,
responses (including SSE streams) come back byte-identical, and a hash-chained
ledger spool appears under `~/.mesh/ledger/` (`./mesh-ledger/` with the `npx`
proxy). The defaults are **lossless only**: compacted tool schemas decode
identically, removed duplicates are exact, prefix repair reorders text
without deleting it. Lossy levers stay off until a replay gate proves on your
own traffic that quality held.

## Quick start: SDK mode (one line)

```js
import { withMesh } from "@harrym1707/sdk"; // npm install @harrym1707/sdk

const client = withMesh(new Anthropic(), {
  applicationId: "my-app",
  tokenReduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true },
  ledger: { path: "./mesh-ledger.jsonl", provider: "anthropic" },
});
```

Works with Anthropic `messages.create`, OpenAI `responses.create`, and
`chat.completions.create` on one shared hash chain.

## What each lever does, and whether it is on

On in a fresh install (lossless):

- **Tool-schema compaction.** Removes schema keys the model never reads.
- **Exact-duplicate removal.** Removes context that appears twice, byte for
  byte.
- **Cache-prefix repair.** Moves a value that changes on every request (a
  timestamp, a request id) out of the part of the prompt a provider cache can
  reuse.

Off until you switch it on:

- **The Anthropic cache stamp.** Anthropic's prompt cache is opt-in. Where a
  client places no `cache_control`, Mesh can stamp the stable prefix (writes
  cost 1.25×, reads 0.1×). It defers whenever you placed your own, keeps
  volatile values outside the breakpoint, and never stamps a prefix that
  churns between turns. Add `{ "lever": "cache-ttl-5m", "class": "lossless" }`
  to the `levers` list in `~/.mesh/theo-policy.json`, or set
  `cacheTtl: "5m"` in the SDK.
- **The cap on oversized fresh tool results**, **tool-description trimming**,
  **stale-history compaction** and **output limits.** These can change an
  answer, so they are lossy: each needs an approved replay-gate verdict from
  your own recorded requests before it is applied or billed. Theo can prove
  and propose three of them (description trimming, history compaction, lower
  output effort).
- **Execution tiers.** OpenAI flex is the same model at half price for work
  that can wait; Mesh bills from the tier the provider actually served.

## What Mesh never does

- Never sends your prompts anywhere: analysis runs in-process, and the ledger
  records usage numbers, lever names and hashes — not content.
- Never claims savings you already had: your own cache hits and gateway-cache
  discounts are itemised in `excluded` and never billed.
- Never calls an estimate a measurement: what you paid is the provider's
  reading; what you would have paid is Mesh's `estimated-baseline`.
- Never clamps a negative: a cache-write premium that didn't pay off counts
  against Mesh on the invoice.
- Never bills a lossy lever without an approved replay-gate verdict from your
  own recorded traffic.

## Already running LiteLLM, Helicone or Langfuse?

You are one file export away from a quote, including the
"do not pay us" verdict:

```bash
npx -y -p @harrym1707/sdk mesh-quote your-export.jsonl --format litellm
```

## Reproduce every number

```bash
./node_modules/.bin/vitest run          # the full test suite
node --import tsx evals/run-agent-ab.ts # the measurement harness, all arms
node --import tsx evals/run-live-agents.ts  # five agents end-to-end (set ANTHROPIC_API_KEY for real traffic)
```

Method: [docs/site/methodology.md](docs/site/methodology.md) · figures by
workload shape: [docs/site/segments.md](docs/site/segments.md) · comparison,
including independent measurements of competing tools:
[docs/site/comparison.md](docs/site/comparison.md) · FAQ:
[docs/site/faq.md](docs/site/faq.md)

## License

The fee is 1% of verified savings for the month, rounded down to the cent, and nothing else; no fee is due unless billing has been agreed in writing.

[Business Source License 1.1](LICENSE): free to read, evaluate, develop
against, and use non-commercially. Production or commercial use requires a
commercial agreement. Each version converts to Apache 2.0 on its Change Date.
