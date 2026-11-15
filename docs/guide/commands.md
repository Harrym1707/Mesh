# Command reference

Run `mesh <command> --help` for a command's own options. `mesh` with no command
(or `--help`) prints the summary.

## `mesh start`

Start the proxy, point Claude Code at it, and run Theo alongside you. Reverts
`~/.claude/settings.json` cleanly on exit (Ctrl+C).

| Option | Meaning |
|---|---|
| `--port <n>` | Port for the local proxy. Default `8787`. |
| `--ledger <dir>` | Where to write the hash-chained ledger. Default `~/.mesh/ledger`. |
| `--openai-base <url>` | Send OpenAI-style traffic to this host instead of `api.openai.com` — any OpenAI-compatible provider (Grok, DeepSeek, Mistral, Llama, …). |
| `--anthropic-base <url>` | Send Anthropic traffic to this host instead of `api.anthropic.com`. |
| `--no-install` | Don't touch `~/.claude/settings.json`; just run the proxy. |
| `--help` | Show usage. |

MESH is **not Claude-specific**. The proxy picks the upstream from each request
(Anthropic's `x-api-key` vs an OpenAI-style bearer) and passes your own key
straight through. Point any OpenAI-style client at it with
`OPENAI_BASE_URL=http://127.0.0.1:8787/v1`, and use `--openai-base` (or the
`MESH_OPENAI_UPSTREAM` environment variable) to target a non-OpenAI provider.

## `mesh status`

Is the service up, and what has Theo saved so far? Reports whether the launchd
service is installed, whether the proxy is answering on `127.0.0.1:8787`, and the
request count plus verified savings and verdict from your ledger.

## `mesh dashboard`

A live local web view of what MESH is doing for you — the terminal `status`,
in a page that refreshes itself. Serves a self-contained page on `127.0.0.1`
(default port `8799`) and opens it in your browser. It shows your verified
savings and verdict, the per-lever breakdown, and what Theo is doing right now:
the levers he's applying and the ones he's holding behind the replay-gate, with
your quality ceiling. It reads your own ledger and Theo policy — nothing leaves
the machine, and the numbers match `mesh verify` exactly.

| Option | Meaning |
|---|---|
| `--port <n>` | Port for the dashboard. Default `8799`. |
| `--proxy-port <n>` | Proxy port to show as up/down. Default `8787`. |
| `--ledger <dir>` | Ledger to read. Default `~/.mesh/ledger`. |
| `--no-open` | Don't open a browser; just print the URL. |

## `mesh install`

Always-on mode (macOS launchd). Copies the self-updating bootstrap to a stable
path (`~/.mesh/bin/mesh`), writes and loads a launchd agent (`dev.meshtoken.mesh`)
that runs the proxy at login and restarts it if it stops, points Claude Code at
MESH permanently, and confirms the proxy came up. Logs to `~/.mesh/daemon.log`.

| Option | Meaning |
|---|---|
| `--port <n>` | Port for the service's proxy. Default `8787`. |

On non-macOS platforms this reports that it isn't wired up yet and tells you to
use `mesh start`.

**Stays current on its own.** The background service checks for a newer
published runtime a few times a day and, when one lands, downloads and
checksum-verifies it (keeping the previous one as a rollback) and restarts onto
it — so an always-on install never serves a stale MESH. Set `MESH_NO_AUTO_UPDATE`
to pin it to the installed runtime (then update deliberately with `mesh update`).

## `mesh uninstall`

Stop and remove the background service and restore Claude Code to normal. **Your
ledger is kept** at `~/.mesh/ledger` — recompute it any time with `mesh verify`.
macOS only, like `install`.

## `mesh verify`

Re-prove MESH's claims on this machine, with no network calls. Four checks:
provenance (the build commit), reducer (removes tokens losslessly from a sample),
ledger (your hash-chain verifies), and determinism (the invoice recomputes to the
identical number twice). Exits non-zero if any check fails, so it is safe in CI or
a hook.

## `mesh doctor`

Diagnose this machine: Node version, the cached runtime, the proxy, Claude Code
wiring, the background service, and the ledger — each marked ✓ / ⚠ / ✗ with a
one-line fix. Pass `--json` for machine-readable output. Exits non-zero on a hard
failure. See [Troubleshooting](troubleshooting.md).

## `mesh restore`

Put Claude Code's settings back if a `mesh start` session was killed and left
Claude Code pointed at a proxy that is no longer running. `mesh start` restores
them by itself on Ctrl+C, on a closed terminal and on a crash; this is for a
hard kill or a machine that went down. It restores the value that was there
before MESH, and does nothing when the configuration is working.

## `mesh version`

Print the installed version, build commit, Node version, and platform. Pass
`--json` for machine-readable output. `mesh --version` and `mesh -v` work too.

## `mesh analyse`

Measure a traffic log (OpenAI Responses / Chat Completions, Anthropic Messages,
or bare usage rows) and report what a reduction is worth — entirely locally.
Requires `--input <file.jsonl>` (repeatable). Run `mesh analyse --help` for the
full option list. Prompt text is never written to the report; cache-breaking
values are redacted unless `--show-examples` is passed.

## `mesh stop`

Stop the background service without removing it — the service definition is
kept, and Claude Code reverts to normal so it never points at a stopped proxy.
Resume always-on any time with `mesh install`. Your ledger is untouched.

## `mesh update`

Update the runtime now instead of waiting for the once-a-day automatic check.
It fetches the manifest and, if newer, downloads and checksum-verifies the
runtime, keeping the current one as a rollback point before swapping it in.

```bash
mesh update              # update to the latest verified runtime
mesh update --rollback   # restore the previous runtime
```

It never overwrites a working runtime until the replacement passes its checksum.
