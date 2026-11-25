# Get started with Mesh, a local proxy for Anthropic and OpenAI API traffic

Mesh is a local proxy for LLM API traffic, for teams running their own agents on the Anthropic or OpenAI API: out of the box it makes three lossless changes to each request and records every saving in a hash-chained ledger on your own machine, so you can recompute the bill yourself.

The fee is 1% of verified savings for the month, rounded down to the cent, and nothing else; no fee is due unless billing has been agreed in writing.
No signup, no account, no key handover: your API key passes through to the
provider and is never stored. Setup takes about five minutes.

## What a fresh install does, and what it does not

Out of the box Mesh makes three lossless changes: tool-schema compaction,
exact-duplicate removal and cache-prefix repair. On Mesh's own 30-request test
basket (LIVE, run 2026-10-26, not a customer's traffic) those three account
for under half of the 18.2% recorded; the rest came from a 5-minute Anthropic
cache stamp and a gate-approved cap on oversized tool results, both off by
default. A Claude Code user gains little on the defaults. The larger figures
on this site needed levers that you or Theo switch on; the section
"Switching on more than the defaults" below says how.

## Install

Mesh is open to everyone: no signup, no account, no waiting list. One command
(needs Node 22 or newer, which Claude Code already uses):

```bash
curl -fsSL https://www.mesh-technology.com/install.sh | sh
```

That is for macOS and Linux. On Windows, run the same command inside WSL:
Mesh installs as a Linux program, and native PowerShell is not supported yet.
Prefer npm? `npm install -g @harrym1707/mesh` gives you the same `mesh`
command.

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

That points Claude Code at Mesh and runs **Theo**, the agent that looks for
further levers, alongside you. Use Claude Code exactly as normal; press Ctrl+C
to stop and Claude Code reverts cleanly. Check your own verified number any
time with `mesh verify`. Expect it to be small: Claude Code already places its
own cache breakpoints, and its tools leave the three default changes little
to remove.

Want it on for every session without starting anything? `mesh install` runs
Mesh as a background service (macOS); `mesh uninstall` removes it and puts
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

Set the one your app uses and keep your own API key — Mesh passes it through
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

**What goes through Mesh.** Mesh reduces and meters the three generation
endpoints: `/v1/messages`, `/v1/chat/completions` and `/v1/responses`.
Everything else your app sends to the same base URL — embeddings, token
counting, model lists, batches, file uploads — is forwarded to your provider
exactly as it came, and the provider's answer comes back untouched. Pointing
an app at Mesh does not take a working call away.

**Another provider.** For any OpenAI-compatible host (Grok, DeepSeek,
Mistral, a local model server), start with
`mesh proxy --openai-base https://your-provider.example`.

**Port taken?** Mesh tells you whether it is already running there (use that
one) or names a free port: `mesh proxy --port 8788`.

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
Theo, dashboard or `mesh verify`. The Anthropic cache stamp is off here too;
to switch it on, start the proxy as
`MESH_PROXY_CACHE_TTL=5m npx -y -p @harrym1707/sdk mesh-proxy`. On the
harness that stamp alone is 37.9% lower cost on multi-turn Claude traffic
that places no cache breakpoints of its own (SIMULATOR, verified 2026-10-22;
needed the 5-minute cache stamp, which is off by default).

## Run your traffic as normal

Responses come back byte-identical, streaming included. Reduction is
**lossless-only by default**: compacted tool schemas decode identically,
removed duplicates are exact, and if anything fails your request goes through
untouched. Each request appends one hash-chained event to your ledger
(`~/.mesh/ledger/` with `mesh`, `./mesh-ledger/` with the npm proxy) — usage
numbers, lever names and hashes. Never your prompts.

See what it did at any time: `mesh status` for the total, `mesh dashboard` for
a live local page.

## Switching on more than the defaults

Everything beyond the three default changes is off until you decide
otherwise. There are three routes, and none of them is automatic today.

**Theo's proposals.** Theo runs beside `mesh start` and `mesh proxy` and, by
default, only recommends. He can prove and propose three lossy levers: tool
description trimming, stale-history compaction and a lower output effort.
To prove one he replays a sample of your own requests against your provider,
both ways, so he needs two things you opt into: a local capture of your
requests (`--capture <file>`) and a provider key for the replay
(`--gate-key-file <path>`, or the key in your environment). The replay makes
paid calls to your provider. Without a capture Theo proposes nothing. When a
lever passes, he tells you the measured saving and quality cost and waits:

```bash
mesh theo --proposals
mesh theo --accept <lever>
```

**The Anthropic cache stamp.** This is the lever behind the largest figures
on this site, and Theo does not propose it today. To switch it on with
`mesh start` or `mesh proxy`, add it to the `levers` list in
`~/.mesh/theo-policy.json`; a running proxy applies the change to
conversations that start after it, and one already in flight keeps the policy
it started with:

```json
{ "lever": "cache-ttl-5m", "class": "lossless" }
```

Mesh then places a 5-minute cache breakpoint on the stable part of an
Anthropic prompt, withholds it where the prefix changes between turns or is
under the provider's minimum, and leaves your request alone if you already
place `cache_control` yourself. A cache write costs more than an ordinary
read, so a stamp that is never read back loses money; that loss is recorded
in your ledger and counts against the fee. Checked on 2026-11-25 against a
stand-in provider: a fresh install sends no cache breakpoint, and with this
line added the next conversation carries one.

**The SDK.** `withMesh(client, { tokenReduction: { ... } })` takes each lever
as an option, including `cacheTtl: "5m"` and the cap on oversized tool
results. A lossy lever is billed only with an approved replay-gate verdict.
The tool-result cap has no one-step route in the proxy today: it is lossy,
and Theo does not yet prove it.

## Check our maths yourself

The invoice is a pure function of a ledger file **you** hold. With `mesh` it
is one command, and it makes no network calls:

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

If Mesh saved you nothing, the verdict line literally reads
`"verdict": "do_not_charge"` — that is the honest outcome on traffic that is
already lean, and we publish it as such.

## Already measuring with LiteLLM, Helicone or Langfuse?

You don't need to route any traffic to get a quote. Export your existing logs
and run them through the quote tool — the verdict can be "do not pay us":

```bash
npx -y -p @harrym1707/sdk mesh-quote your-export.jsonl --format litellm
```

## What it costs

The fee is 1% of verified savings for the month, rounded down to the cent, and nothing else; no fee is due unless billing has been agreed in writing.
No subscription, no seats, no minimum; a month that saved nothing bills
nothing. What you paid is your provider's own reported usage; what you would
have paid is worked out by Mesh from the tokens it removed and is labelled an
estimated baseline. How billing works, month by month, is on
[Pricing and billing](pricing.md). The measurement rules are in the
[methodology](methodology.md), and every figure we quote traces to a command,
a date and the levers it needed on the [evidence](evidence.md) page.

## What Mesh never does

- Never sends your prompts anywhere — analysis runs entirely on your machine.
- Never stores or forwards your API key beyond the provider you chose.
- Never claims savings you already had: your own cache hits are itemised and excluded.
- Never hides a loss: a lever that cost you money counts against us on the invoice.

## Stuck, or want a hand?

You do not need to ask anyone before you start. If something does not work,
or you would like help setting Mesh up on your own traffic,
[open an issue on GitHub](https://github.com/Harrym1707/Mesh/issues/new) and
say what you ran and what you saw. `mesh doctor` prints the details worth
including. If you already have an export from LiteLLM, Helicone or Langfuse,
bring it: the quote tool reads it and says which workload shape you are.
