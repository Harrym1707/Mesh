# MESH — cut your LLM API bill, pay only a share of verified savings

[![savings: recompute it yourself](https://img.shields.io/static/v1?label=savings&message=recompute%20it%20yourself&color=brightgreen)](docs/site/evidence.md)
[![fee: share of verified savings](https://img.shields.io/static/v1?label=fee&message=%25%20of%20verified%20savings&color=blue)](https://www.mesh-technology.com)
[![npm @harrym1707/sdk](https://img.shields.io/npm/v/@harrym1707/sdk?label=%40harrym1707%2Fsdk)](https://www.npmjs.com/package/@harrym1707/sdk)

MESH reduces what each LLM request costs — on Claude (Anthropic), OpenAI, and
any OpenAI-compatible API — and meters the savings into an append-only,
hash-chained ledger **you can recompute yourself**. The fee is a percentage of
verified savings: if MESH saves nothing, the invoice says `do_not_charge`.

Three things no other cost tool says on its front page:

1. **Integration is one URL.** Run the MESH proxy and point your client's
   `base_url` at it. No SDK adoption, any language. Your API key passes
   through verbatim — MESH never holds credentials.
2. **The published numbers include where MESH loses.** Already-optimised
   stacks get a `doNotPayUs` verdict, and our busy-interactive ceiling (~29%
   before cache enablement) is printed next to the wins.
3. **The invoice is a pure function of a ledger you hold.** Every request
   writes one hash-chained event with provider-verbatim usage; run
   `recomputeInvoice` on your own spool and you must get our number.

## How much does it save?

| Workload | Band | Status |
|---|---|---|
| Multi-turn Claude, cache TTL only | **37.9%** | simulator-measured vs the same J prompt stack with cache disabled; both arms clean 38/40 |
| Full J + 5m cache stack vs raw uncached baseline | **57.3% lower cost, but −5 pp clean-task quality** | diagnostic only; fails the agreed −2 pp quality limit and is not a qualified win |
| Background / batch / latency-tolerant (OpenAI flex tier) | **57.7% net** (64.3% ceiling) | simulator-measured, billed from the SERVED tier |
| One-shot templated API traffic | **45.5%**, up to 72.8% | simulator-measured |
| Interactive agents (busy / sparse) | **25.9% / 34.3%** | simulator-measured |
| Latest live export (30 requests, claude-sonnet-5-5, 2026-10-26) | **18.2% net** (agents 0–38.1%) | measured on live API traffic; hash-chained spools in `evals/live-exports-2026-10-26/` — recompute it yourself |
| Already-optimised stacks | **0–5%** | we tell you not to pay us |

Every number traces to a command and a commit: see
[docs/site/evidence.md](docs/site/evidence.md). Savings are measured **per
completed task**, never per request, and quality is gated by replaying your
own recorded requests — a failed task voids its savings.

## Quick start: proxy mode (no code changes)

```bash
npx -y -p @harrym1707/sdk mesh-proxy
```

(Prefer building from source? `git clone https://github.com/Harrym1707/Mesh && cd Mesh`,
then `corepack enable && pnpm install && pnpm build` and `node --import tsx evals/run-proxy.ts`.)

Then change one line in your app:

```js
// Anthropic SDK
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });
// OpenAI SDK
const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" });
```

Requests are reduced before they reach the provider, responses (including SSE
streams) come back byte-identical, and a hash-chained ledger spool appears
under `./mesh-ledger/`. Reduction is **lossless-only by default**: compacted
tool schemas decode identically, removed duplicates are exact, prefix repair
reorders text without deleting it. Lossy levers stay off until a replay gate
proves on your own traffic that quality held.

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

## Where the savings come from

- **Anthropic's prompt cache is opt-in, and most agents never opt in.** An
  unstamped Claude agent re-pays full rate for its entire conversation history
  every turn (our live export measured exactly that: zero cache traffic on a
  five-turn agent). MESH stamps the stable prefix — writes 1.25×, reads 0.1× —
  and defers whenever you placed your own `cache_control`. Volatile values
  (a per-turn clock, a request id) are kept outside the breakpoint, and a
  conversation whose prefix churns between turns is never stamped at all: a
  breakpoint that can never be read back only buys write premiums, so MESH
  refuses to place one.
- **Fresh tool results are capped at injection**, before they bill once at the
  full input rate (headlines, errors and file paths survive verbatim; the
  replay gate approved this lever at zero quality delta).
- **Prefix repair**: one timestamp at the top of a shared template disables
  provider caching entirely; MESH relocates it.
- **Schema compaction and exact-duplicate removal**: lossless, on every request.
- **Execution tiers**: OpenAI flex is the same model at 50% off for work that
  can wait; MESH bills from the tier the provider actually served.

## What MESH never does

- Never sends your prompts anywhere: analysis runs in-process, and the ledger
  records usage numbers, lever names and hashes — not content.
- Never claims savings you already had: your own cache hits and gateway-cache
  discounts are itemised in `excluded` and never billed.
- Never clamps a negative: a cache-write premium that didn't pay off counts
  against MESH on the invoice.
- Never bills a lossy lever without an approved replay-gate verdict from your
  own recorded traffic.

## Already running LiteLLM, Helicone or Langfuse?

You are one file export away from a quote, including the honest
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

Method: [docs/site/methodology.md](docs/site/methodology.md) · segment bands:
[docs/site/segments.md](docs/site/segments.md) · honest comparison, including
independent measurements of competing tools:
[docs/site/comparison.md](docs/site/comparison.md) · FAQ:
[docs/site/faq.md](docs/site/faq.md)

## License

The fee is **1% of verified savings, monthly — nothing else**. A month that
saved nothing bills nothing.

[Business Source License 1.1](LICENSE): free to read, evaluate, develop
against, and use non-commercially. Production or commercial use requires a
commercial agreement — which is the point: MESH charges a percentage of
verified savings, nothing else. Each version converts to Apache 2.0 on its
Change Date.
