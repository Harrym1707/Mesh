# MESH tester guide

For the first people using MESH on their own traffic. Written 2026-11-16 for
MESH 0.2.1. It takes about five minutes to set up.

**Draft.** This has not been sent to anyone. Sending it is the founder's act.

## What you are testing

MESH is a small program that runs on your own machine, between your app (or
Claude Code) and your AI provider. It removes tokens you were about to pay for
twice, and writes one line per request into a ledger file you hold, so the
saving can be checked by you and not only by us.

- Your API key passes through to your provider. MESH does not store it.
- Your prompts and answers stay on your machine. The ledger holds usage
  numbers, lever names and hashes, never content.
- By default only lossless levers are on: the request your provider receives
  means exactly what your app sent.

## Before you start

- Node.js 22 or newer (`node --version`). Claude Code already uses it.
- macOS or Linux. On Windows, tell us first; the installer below is a shell
  script and we have not walked the Windows path with a tester yet.

## 1. Install

```bash
curl -fsSL https://www.mesh-technology.com/install.sh | sh
```

Then check it:

```bash
mesh version
```

It should print `mesh 0.2.1` or later. If the command is not found, open a new
terminal window and try again, or run it by its full path:
`~/.mesh/bin/mesh version`. `mesh doctor` checks the rest of the setup.

## 2. Connect — pick the one that matches what you run

### A. You use Claude Code

```bash
mesh start
```

Leave that window open and use Claude Code as normal in another one. Press
Ctrl+C in the MESH window to stop; Claude Code is put back exactly as it was.

### B. You run your own app or agent

```bash
mesh proxy
```

It prints two settings. Use the one that matches your client and keep your own
API key:

| Your client talks to | Set this | To |
|---|---|---|
| Anthropic (Claude) | `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` |
| OpenAI, or an OpenAI-compatible provider | `OPENAI_BASE_URL` | `http://127.0.0.1:8787/v1` |

The official Anthropic and OpenAI SDKs read those environment variables, so
for most apps this is the whole change:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 python my_agent.py
```

If your framework takes the base URL in code or config instead (LangChain,
the Vercel AI SDK, LiteLLM and most others do), put the same address there.

Using a provider other than OpenAI behind the OpenAI-style API? Start MESH
with its address: `mesh proxy --openai-base https://your-provider.example`.

## 3. Check it is working

1. **The proxy is up.** `curl http://127.0.0.1:8787/mesh/health` prints
   `{"status":"ok","service":"mesh-proxy"}`.
2. **Your traffic is going through it.** Send one request from your app. Within
   a few seconds the MESH window prints `1 request seen`.
3. **The record is sound.** `mesh verify` ends with `All checks passed.`

If step 2 never prints, your app is still talking to the provider directly:
the base URL setting has not reached it. `mesh doctor` checks the rest.

## What to expect

- **Nothing should break.** MESH reduces three kinds of request (Anthropic
  messages, OpenAI chat completions, OpenAI responses). Everything else your
  app sends to the same address, such as embeddings, token counting, model
  lists, batches and file uploads, is passed to your provider untouched. If a
  call that worked before fails through MESH, that is a bug we want to hear
  about the same day.
- **The first number may be small, or zero.** The default levers are the safe
  ones. On traffic that is already lean, MESH says so in plain words:
  `nothing to bill yet — do not pay us`. That is a real result, not a fault.
- **Theo will suggest more.** Theo is the part of MESH that studies your
  traffic. When he finds a saving that changes what is sent, he proposes it in
  the MESH window and waits for your yes. Please leave his autonomy at the
  default (`recommend`). Do not switch on `--autonomy optimise` during this
  test: automatic adoption is not ready for real traffic yet.
- **No automatic charge.** This tool cannot take a payment. MESH's fee is 1% of
  verified savings, and during this test any invoice is agreed with you by
  hand before it exists.

## Seeing what it did

| Command | What it shows |
|---|---|
| `mesh status` | Requests seen and savings so far |
| `mesh dashboard` | A live page on your own machine |
| `mesh verify` | Re-checks the ledger and recomputes the figure, with no network calls |

The ledger is in `~/.mesh/ledger/`. It is yours.

## What we would like back

After a few days of normal use:

1. What `mesh status` prints.
2. What `mesh verify` prints.
3. Anything that broke, slowed down or surprised you, with the time it happened.
4. If you are willing: the files in `~/.mesh/ledger/`. They contain no prompts
   or answers; open one and look before you send it.

Send them to whoever gave you this guide.

## Stopping and removing

- Stop: Ctrl+C in the MESH window. With `mesh start`, Claude Code is restored.
- If the MESH window was killed and Claude Code cannot connect: `mesh restore`.
- Always-on mode (macOS), if you turned it on with `mesh install`:
  `mesh uninstall` stops it and restores Claude Code.
- Remove everything: delete the `~/.mesh` folder (the launcher, the runtime and
  your ledger live there, so copy the ledger out first if you want to keep it)
  and the `# MESH` line the installer added to your shell profile. For your own
  app, take the base URL setting back out.

## If something goes wrong

| You see | What it means | What to do |
|---|---|---|
| `MESH is already running on port 8787` | It is already up (always-on mode, or another window) | Nothing to start; point your app at it |
| `Port 8787 is in use by another program` | Something else has the port | `mesh proxy --port 8788`, and use 8788 in the base URL |
| Your app gets `Upstream unreachable` | MESH could not reach your provider | Check your network; the provider may be down |
| An error from your provider (rate limit, bad key) | The provider's own answer, passed through unchanged | Handle it as you would without MESH |
| Claude Code cannot connect after a crash | It still points at a MESH that is gone | `mesh restore` |
| Anything else | | `mesh doctor`, and send us the output |

To take MESH out of the picture while you investigate, stop it and remove the
base URL setting. Your app then talks to the provider directly, as before.

## Known limits (2026-11-16)

- Tested with the Claude Code command-line tool and the official Anthropic and
  OpenAI SDKs (TypeScript and Python) against a stand-in provider. A tester's
  real traffic is the first of its kind; that is why your feedback matters.
- Always-on mode is macOS only.
- Realtime (WebSocket) APIs cannot go through the proxy; keep those clients
  pointed at the provider.
- Azure OpenAI's address format (`/openai/deployments/...`) is passed through
  to the provider but not reduced or metered.
