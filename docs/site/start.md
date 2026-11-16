# Get started in five minutes

MESH sits between your app and your AI provider, removes the tokens you were
about to pay for twice, and writes every request into a tamper-evident ledger
you can audit yourself. No signup, no account, no key handover: your API key
passes through to the provider and is never stored. Works with Claude
(Anthropic), OpenAI, and any OpenAI-compatible endpoint.

## Install

One command (needs Node 22 or newer, which Claude Code already uses):

```bash
curl -fsSL https://www.mesh-technology.com/install.sh | sh
```

The installer drops one tiny launcher that fetches and checksum-verifies the
runtime, and keeps it up to date. It never touches your API key. Read it
first if you like:
`curl -fsSL https://www.mesh-technology.com/install.sh | less`. Or grab the
launcher directly:
`curl -fsSL https://www.mesh-technology.com/mesh -o mesh && chmod +x mesh && ./mesh start`.

Check it: `mesh version`. If anything looks off, `mesh doctor` says what and
how to fix it.

## Claude Code — one command

```bash
mesh start
```

That points Claude Code at MESH and runs **Theo** — your token engineer —
alongside you. Use Claude Code exactly as normal; press Ctrl+C to stop and
Claude Code reverts cleanly. Check your own verified number any time with
`mesh verify`.

Want it on for every session without starting anything? `mesh install` runs
MESH as a background service (macOS); `mesh uninstall` removes it and puts
Claude Code back.

## Your own app or agent — one command, one setting

```bash
mesh proxy
```

Same proxy, same Theo, and it leaves Claude Code alone. It prints the two
settings to copy:

```text
connect  Anthropic clients   ANTHROPIC_BASE_URL=http://127.0.0.1:8787
         OpenAI-style        OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

Set the one your app uses and keep your own API key — MESH passes it through
verbatim. The official SDKs read those environment variables, so often there
is no code to change at all:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 python my_agent.py
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 node my-app.js
```

Or set it in code:

```js
// Anthropic SDK
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });

// OpenAI SDK — also any OpenAI-compatible endpoint
const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" });
```

```python
anthropic = Anthropic(base_url="http://127.0.0.1:8787")
openai = OpenAI(base_url="http://127.0.0.1:8787/v1")
```

Any language or framework works if it lets you set a base URL — Go, curl,
LangChain, the Vercel AI SDK, whatever you run today.

**Is it up?** `curl http://127.0.0.1:8787/mesh/health` answers
`{"status":"ok","service":"mesh-proxy"}`. A few seconds after your first
request, the `mesh proxy` window prints `1 request seen`.

**What goes through MESH.** MESH reduces and meters the three generation
endpoints: `/v1/messages`, `/v1/chat/completions` and `/v1/responses`.
Everything else your app sends to the same base URL — embeddings, token
counting, model lists, batches, file uploads — is forwarded to your provider
exactly as it came, and the provider's answer comes back untouched. Pointing
an app at MESH does not take a working call away.

**Another provider.** For any OpenAI-compatible host (Grok, DeepSeek,
Mistral, a local model server), start with
`mesh proxy --openai-base https://your-provider.example`.

**Port taken?** MESH tells you whether it is already running there (nothing
to start) or names a free port: `mesh proxy --port 8788`.

Checked on 2026-11-16 with the Claude Code command-line tool and the official
Anthropic and OpenAI SDKs in TypeScript and Python, against a stand-in
provider that records what reaches it: messages, streaming, token counting,
embeddings, model lists, batches and file uploads.

## No install: the proxy from npm

If you would rather not install anything:

```bash
npx -y -p @harrym1707/sdk mesh-proxy
```

You'll see:

```text
MESH proxy listening on http://127.0.0.1:8787
Ledger spools: ./mesh-ledger
```

Point your app at it the same way. This is the proxy on its own: the ledger is
written to `./mesh-ledger` in the folder you started it from, and there is no
Theo, dashboard or `mesh verify`. To switch on the Claude prompt-cache lever
too (our single biggest measured saver, 37.9% on multi-turn traffic), start it
as `MESH_PROXY_CACHE_TTL=5m npx -y -p @harrym1707/sdk mesh-proxy`.

## Run your traffic as normal

Responses come back byte-identical, streaming included. Reduction is
**lossless-only by default**: compacted tool schemas decode identically,
removed duplicates are exact, and if anything fails your request goes through
untouched. Each request appends one hash-chained event to your ledger
(`~/.mesh/ledger/` with `mesh`, `./mesh-ledger/` with the npm proxy) — usage
numbers, lever names and hashes. Never your prompts.

See what it did at any time: `mesh status` for the total, `mesh dashboard` for
a live local page.

## Check our maths yourself

This is the part no other cost tool offers: the invoice is a pure function of
a ledger file **you** hold. With `mesh` it is one command, and it makes no
network calls:

```bash
mesh verify
```

With the npm proxy, verify the chain and recompute the invoice with the same
published package:

```bash
node -e '
const { readFileSync } = require("node:fs");
const { verifyLedgerChain, recomputeInvoice } = require("@harrym1707/sdk");
const records = readFileSync(process.argv[1], "utf8").trim().split(/\n/).map(JSON.parse);
const chain = verifyLedgerChain(records);
if (!chain.ok) throw new Error("chain broken at seq " + chain.seq);
console.log("chain verified:", chain.length, "records");
console.log(JSON.stringify(recomputeInvoice(records.map(r => r.event)), null, 2));
' mesh-ledger/proxy-anthropic.jsonl
```

If MESH saved you nothing, the verdict line literally reads
`"verdict": "do_not_charge"` — that is the honest outcome on traffic that is
already lean, and we publish it as such.

## Already measuring with LiteLLM, Helicone or Langfuse?

You don't need to route any traffic to get a quote. Export your existing logs
and run them through the quote tool — the verdict can be "do not pay us":

```bash
npx -y -p @harrym1707/sdk mesh-quote your-export.jsonl --format litellm
```

## What it costs

**1% of verified savings, monthly — nothing else.** No subscription, no
seats, no minimum. Savings are measured per completed task from the
provider's own reported usage; a month that saved nothing bills nothing. The
measurement rules are published in full in the [methodology](methodology.md),
and every number we quote traces to a command and a commit on the
[evidence](evidence.md) page.

## What MESH never does

- Never sends your prompts anywhere — analysis runs entirely on your machine.
- Never stores or forwards your API key beyond the provider you chose.
- Never claims savings you already had: your own cache hits are itemised and excluded.
- Never hides a loss: a lever that cost you money counts against us on the invoice.

## Want a guided pilot?

Open a [pilot request](../pilot/runbook.md) — bring an export from your
existing gateway and leave with a per-segment quote from your own traffic,
including the honest band for your workload shape.
