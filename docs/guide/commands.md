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

## `mesh report`

What Mesh did for you last week, in money, in a few short sentences. Read from
your own ledger; nothing leaves the machine. The plain-language guide is
[the weekly report](weekly-report.md).

```sh
mesh report
```

```
  Mesh, your week (16 to 22 Nov).
  You paid your provider $412.10.
  Without Mesh: $498.30.
  Mesh saved you $86.20.
  Mesh's fee on that: $0.86.
  You keep $85.34.
  1,204 requests, ledger verified.

  Theo, your token engineer, checked your traffic 9 times this week and found nothing more worth changing.

  This month so far (November): saved $86.20, fee so far $0.86.
  Details: mesh report --detail
```

| Option | Meaning |
|---|---|
| (none) | The last full week: Monday 00:00 to the next Monday 00:00 in your own time zone. |
| `--week YYYY-MM-DD` | The week that date falls in. |
| `--this-week` | This week so far. Labelled as not finished: it can still change. |
| `--month [YYYY-MM]` | A billing month in the same plain style. Default: this month. For a finished month it also names your statement (`mesh statement --period YYYY-MM`). |
| `--detail` | Add the breakdown below the plain part: per lever, per model, the request counts and the notes. |
| `--json` | Print one JSON object (schema `mesh-report/1`) instead of text. |
| `--html [path]` | Write the report as one self-contained HTML page (no external files, no scripts). Default `~/.mesh/reports/<week start>.html`. |
| `--open` | Write that page and open it. Only in a terminal; anywhere else the path is printed and nothing is opened. |
| `--off` / `--on` | Switch the weekly notification and the once-a-week terminal line off or on. |
| `--deliver` | Run the weekly check now, as the background service does hourly: write the page and show the notification if one is due. |
| `--ledger <dir>` | Ledger to read. Default `~/.mesh/ledger`. |

**Where the figures come from.** They are the bill's own arithmetic: the week's
requests are picked by the time they started and put through the same
calculation `mesh statement` runs. "You paid your provider" is the price-list
cost of the week's priced requests, from your provider's own reported usage.
"Mesh saved you" is net verified savings. "Without Mesh" is worked out, not
measured: what you paid plus what Mesh saved, the same way the statement works
out its baseline. The fee is 1% of the week's saving, rounded down to the cent.

**The weekly fee is a guide; the invoice is the monthly statement.** A billing
month is a calendar month in UTC, and the invoice rounds the fee down once, on
the month's total. Each weekly fee is rounded down on its own, so the weekly
fees can add up to a few cents less than the invoice. A week where Mesh cost
you money counts against the same month's savings, so the invoice can also come
to less than the weekly fees added up. It is never more than 1% of the month's
verified saving. Split any month into the parts of each week that fall inside
it and the savings add up to that month's statement; a week that crosses a
month end is counted in two parts, shown under `--detail`.

**What can change a past week.** If a task fails, the savings on all its
requests in that billing month stop counting, as on the statement, so an
earlier week's figure can go down. Requests on models that are not in the price
list are not in the cost lines; the report says how many there were.

**The cases.** Saved nothing: "Mesh saved you $0.00 this week, so you owe
nothing." Mesh cost more than it saved: the report says how much, that it
counts against Mesh's fee, and that nothing is owed. A fee under one cent: the
saving is stated and nothing is owed for it. No requests, and none since
either: "Mesh saw no requests last week, so it is not connected. Fix: mesh
setup". No requests that week but requests after it: "Mesh was not running yet
last week (16 to 22 Nov). This week so far: mesh report --this-week" (or, for a
quiet week between busy ones, "Mesh saw no requests last week, but it has seen
requests since."); the second line names the report that has them. A ledger whose hash chain
does not verify: no figure at all, "Run: mesh verify", and the command exits 1
(the same with `--json`); every other case exits 0.

**Theo's lines.** Under the money, one or two lines say what Theo did that
week, read from his own records: a change that needs your OK
(`mesh theo --proposals`), a change you accepted that is now earning (the
ledger's figure for it, already inside the saved total), a change he held back
or switched off, or that he looked and found nothing. A proposal is never a
saving: it is not added to the saved total, the fee, "you keep" or the month so
far. No lever is named in these lines.

**`--json`.** One object: `schema`, `ok`, `mesh { version, build }`, `kind`
(`week` or `month`), `case` (`saved`, `saved_nothing`, `cost_more`,
`no_requests`, `no_requests_then`, `not_verified`), `since` (null except for
`no_requests_then`: `{ first, span, command }`, where `first` is true when
nothing is recorded before the span either and `command` is the report that
has the later requests), `period { kind, id, startDate, endDate,
timeZone, startsAt, endsBefore, finished, relative, label }`, `currency`,
`ledgerVerified`, `requests`, `paidProviderUsd`, `withoutMeshUsd`, `savedUsd`,
`feePercent`, `feeCents`, `feeUsd`, `feeBelowOneCent`, `keepUsd`,
`unpricedRequests`, `monthToDate { period, requests, savedUsd, feeCents,
feeUsd, verdict }`, `theo`, `detail { levers, models, requests, alreadyYoursUsd,
pieces, notes }`, the words already made from it (`headline`, `monthLine`,
`oneLine`) and `notifications` (`on` or `off`). When the ledger does not verify,
`ok` is false and every money field is `null`.

**What a report holds.** Money, counts and dates; lever names and model ids in
the detail only. Never a prompt, a tool argument, a request id, an application
name, a file name from your ledger, or a key.

## `mesh statement`

Your statement for one billing period, recomputed on your own machine from your
own ledger, with no network calls. Not in release 0.2.3 or earlier: `mesh --help`
lists `statement` once your installed version has it.

```sh
mesh statement --period 2026-11
```

It prints, and writes to `mesh-statement-2026-11.json` in the current folder:

- the result of the ledger's hash-chain check, the ledger's head hash, and the
  first and last event hashes of the period;
- the number of requests, and how many were left out and why: part of a failed
  task, a model that is not in the price list, or savings you already had from
  your own caching;
- one row per lever: its name, the requests it fired on, and its verified saving
  (a lever that cost more than it saved shows as a negative row and counts
  against MESH);
- baseline cost, actual cost and net verified savings;
- the fee at 1% of net verified savings, rounded down to the cent so it is never
  more than 1%, and the verdict: `charge` or `do_not_charge`, with the reason
  when nothing is charged (a fee below one cent is not charged);
- any deficit carried forward, and the price catalogue the ledger was priced
  against.

All amounts are US dollars.

**A statement is not an invoice.** MESH issues the invoice separately, from the
same ledger and with the same calculation this command runs. If your
recomputation disagrees with ours, yours wins.

**The period** is a calendar month in UTC. A request belongs to the month it
started in, which is stamped on its ledger record when it is written; the invoice
selects records by the same stamp. Running the command before the month has ended
is allowed and says so: the figures can still change.

**A broken chain is not a statement.** If any spool's hash chain does not verify,
the command prints where it breaks, shows no figures, writes no file, and exits
non-zero.

**The file** holds numbers, lever names, model ids and hashes only: no prompts, no
request content, no request or task ids, no keys. It ends with a `sha256` of its
own content, so a later `mesh statement --check <file>` shows whether it was
altered after it was written. That seal catches accidental changes; the proof of
the figures is recomputing them from the ledger.

**The signature.** From the release after 0.2.4 (planned as 0.2.5), every
statement is also signed, so MESH can tell a statement written by your install
from one written by anyone who holds a copy of your ledger files.

- The first time it is needed, `mesh statement` creates a **statement key** for
  this install: an Ed25519 key pair in `~/.mesh/identity/statement-key.json`
  (the folder is readable by you only, mode 0700, the file mode 0600). The
  private half never leaves this machine. It is never printed, never sent, and
  never written into the statement, the ledger or any file you are asked to
  send. Making the key needs no network.
- The key's **fingerprint** is 64 hexadecimal characters (the sha256 of the
  public half). It is public and safe to share. Print it with:

  ```sh
  mesh statement --key
  ```

  Give it to MESH **once, when billing is agreed, through the channel agreed in
  writing**, and not in the same message as a statement. From then on MESH bills
  only from a statement signed by that key.
- The statement file gains a `signature` object: the algorithm (`ed25519`), the
  public key, its fingerprint, a sentence saying exactly what is signed (the
  value of the file's `sha256` field), and the signature. The printed statement
  ends with `Signed by this install's statement key: <fingerprint>`.
- `mesh statement --check <file>` also reports whether the signature verifies
  against the key named in the file, and prints that key's fingerprint. This
  shows the file is consistent with itself. It does not show whose key it is:
  anyone can make a key and sign with it. What shows the statement is yours is
  MESH comparing the fingerprint with the one you registered.

What the signature shows, and what it does not: it shows the statement was
written by an install holding the registered key, so nobody else, MESH included,
can write a statement in your name from files they were sent. It does not show
that the ledger on your machine was complete, and it does not replace the rule
that matters most: the figures are yours to recompute, and if your
recomputation disagrees with ours, yours wins.

A statement written by 0.2.4 has no signature. MESH does not bill from it;
update and run `mesh statement --period YYYY-MM` again.

**If the key changes.** The key belongs to one install. Reinstalling into an
empty home folder, moving to another machine, or losing
`~/.mesh/identity/statement-key.json` gives you a new key with a new
fingerprint, and a statement signed by it is refused until you have registered
the new fingerprint with MESH the same way as the first: through the agreed
channel, before your next statement, and not alongside it. To keep the same
fingerprint when you move machine, copy the key file to the same place on the
new one and keep it private. `mesh statement` never replaces a key file: if the
file is there but cannot be read as a key, the command stops and says so. To
start a new key on purpose, move the old file aside (keep it), run
`mesh statement --key`, and register the new fingerprint. On Windows the mode
bits do not apply; the file is protected by your user profile's own permissions.

| Option | Meaning |
|---|---|
| `--period YYYY-MM` | The billing period, a calendar month in UTC. Required. |
| `--ledger <dir>` | Ledger to read. Default `~/.mesh/ledger`. |
| `--out <file>` | Where to write the statement file. Default `./mesh-statement-YYYY-MM.json`. |
| `--json` | Print the statement as JSON instead of text. The file is still written. |
| `--check <file>` | Check a statement file against its `sha256` seal and check that its signature verifies against the key named in the file, then exit. Exits non-zero if either fails or the file is not signed. |
| `--key` | Print the fingerprint of this install's statement key, creating the key if there is none yet, then exit. Needs no ledger and no period. |

Pass one or more spool files after the options to read exactly those instead of
a ledger directory.

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
