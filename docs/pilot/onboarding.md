# MESH pilot onboarding — the one path

Since release 0.2.1 (2026-11-16) there is one way to set MESH up: install it
from the website, then run `mesh start` (Claude Code) or `mesh proxy` (any
other app or agent). Everyone sets it up this way, in a pilot or not, so every
ledger lands in the same place. The current release is 0.2.3 (read
2026-11-18); it does not change the path.

**MESH is open to everyone:** no signup, no account, no waiting list. Nobody
needs to ask before installing or using it ([Get started](../site/start.md)).
**A pilot is optional.** It adds three things for a team that wants them: an
agreed measuring window, hands-on help, and an invoice checked by hand under
the [pilot agreement](./pilot-agreement.md).

The step-by-step for the person at the keyboard is the
[tester guide](./TESTER-GUIDE.md). This page does not repeat it. It says what
a team in a pilot does, what to agree at kickoff, and the details the
operator needs. The steps are the same ones anyone follows; a team may well
have installed MESH before a pilot is ever discussed.

**Draft.** Nothing here has been sent to anyone. MESH has not yet run on a
customer's real traffic; a pilot is the first time it will.

---

## What a partner does

"Partner" on this page means a team that has chosen to run a pilot.

Needs Node.js 22 or newer, on macOS or Linux. On Windows the installer runs
inside WSL only (native PowerShell is not supported), and that path has not
been walked with anyone yet.

### 1. Install

```bash
curl -fsSL https://www.mesh-technology.com/install.sh | sh
```

Prefer npm? `npm install -g @harrym1707/mesh` gives the same `mesh` command.

`mesh version` should print `mesh 0.2.3` or later on a fresh install (read
2026-11-18). An older install moves to it on its own, or at once with
`mesh update`. `mesh doctor` checks Node,
the proxy, the Claude Code wiring, the background service and the ledger.

### 2. Connect — one of two commands

| The partner runs | Command | What it does |
|---|---|---|
| Claude Code | `mesh start` | Starts the proxy, points Claude Code at it through `~/.claude/settings.json`, and puts the setting back on Ctrl+C |
| Their own app or agent | `mesh proxy` | Starts the same proxy and leaves Claude Code alone. The partner sets one base URL and keeps their own API key |

For `mesh proxy` the setting is `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` for
Anthropic clients, or `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` for OpenAI and
OpenAI-compatible clients. The command prints both.

- **Same machine.** The proxy listens on `127.0.0.1` only, so it runs on the
  machine (or in the container) that the calling app runs on.
- **Another OpenAI-compatible provider:** `mesh proxy --openai-base https://your-provider.example`.
- **Port 8787 taken:** `mesh proxy --port 8788`, and use 8788 in the base URL.

### 3. Check it is working

1. `curl http://127.0.0.1:8787/mesh/health` prints
   `{"status":"ok","service":"mesh-proxy"}`.
2. After the first request, the MESH window prints `1 request seen`.
3. `mesh verify` ends with `All checks passed.`
4. `mesh status` shows requests seen and the saving so far.

If the request count never moves, the app is still talking to the provider
directly: the base URL has not reached it. `mesh doctor` checks the rest.

### 4. Run normal traffic for the agreed window

Nothing else changes for the partner. Each request MESH reduces appends one
line to the ledger.

### 5. Recompute the figure

```bash
mesh verify
```

It re-checks the hash chain of every ledger file in `~/.mesh/ledger/` and
recomputes the invoice figure from them, with no network calls.

For a second opinion that shares no code path with the installed `mesh`, the
MIT-licensed `@harrym1707/verify` package (0.1.0) does the same recompute on
one ledger file at a time:

```bash
npx -y -p @harrym1707/verify mesh-verify ~/.mesh/ledger/proxy-anthropic.jsonl
```

Name the file. `mesh-verify` reads exactly one file, and it is not meant for
the `.features.jsonl` files that sit beside the ledger (see below): given one
of those it reports a broken chain. If the partner's recomputation disagrees
with ours, theirs wins.

---

## Where the ledger is

**`~/.mesh/ledger/`**, for both `mesh start` and `mesh proxy`.

| File | What it is |
|---|---|
| `proxy-anthropic.jsonl`, `proxy-openai.jsonl` | The ledger: one hash-chained file per application and provider. Usage numbers, lever names and hashes; no prompt or answer text. This is what an invoice is computed from |
| `*.features.jsonl` | Not the ledger. Counts and keyed hashes Theo uses to tune MESH, with no content. Not needed for billing; do not pass these files to `mesh-verify` |

The file name starts with `proxy` unless the app sends an `x-mesh-application`
header, in which case it starts with that name.

Keep the default location. `mesh start` and `mesh proxy` accept `--ledger <dir>`,
but `mesh verify` reads `~/.mesh/ledger/` only, so a ledger written somewhere
else is not covered by it.

## What to agree at kickoff

These are agreed for a pilot. None of them is needed to use MESH. Record them
in the [engagement list](./engagement-list.md):

1. **Which command:** `mesh start` or `mesh proxy`, and on which machine.
2. **The window.** A pilot is about four weeks end to end; 14 days of that is
   measurement ([PILOT_PLAN.md](./PILOT_PLAN.md) has the timeline).
3. **Theo stays on `recommend`,** the default. He applies lossless levers on
   his own and puts anything that changes what is sent to the partner as a
   proposal (`mesh theo --proposals`, `--accept`, `--reject`). Nobody turns on
   `--autonomy optimise` during a pilot: automatic adoption is not ready for
   real traffic.
4. **Levers.** A fresh install enforces three lossless levers: tool-schema
   compaction, duplicate-context removal and cache-prefix repair. A lossy
   lever runs only if the partner accepts a proposal for it. There is also
   one opt-in lever, JSON tool-result compaction, added in 0.2.2. It is off
   by default and Theo does not adopt it. Whether to use it in a pilot is
   agreed at kickoff; the
   [configure guide](../guide/configure.md#optional-compact-json-tool-results)
   says how, and when not to. It needs 0.2.3 or later: 0.2.2 dropped a lever
   added by hand at Theo's next background cycle.
5. **How the ledger reaches us** at the end of the window: the partner sends
   the ledger files from `~/.mesh/ledger/` (not the `.features.jsonl` files)
   after looking at them.
6. **The build can change during the window.** A `mesh` installed from the
   website keeps itself up to date from it (each runtime is checked against
   its published checksum before it runs). How an npm install is updated was
   not checked. Note what `mesh version` prints at
   kickoff and at the end. `mesh update --rollback` goes back to the previous
   runtime.

---

## No-install alternative: the proxy from npm

> **Not the pilot default.** Use this only for a partner who will not install
> anything. It is the proxy on its own, and its ledger is in a different
> folder.

```bash
npx -y -p @harrym1707/sdk mesh-proxy
```

It listens on `http://127.0.0.1:8787` and the app is pointed at it in the same
way. What differs from the installed `mesh`:

- **Ledger folder: `./mesh-ledger/`** in the folder the command was started
  from, not `~/.mesh/ledger/`.
- No Theo, no `mesh dashboard`, no `mesh status`, no `mesh verify`.
- Settings are environment variables: `MESH_PROXY_PORT` (default `8787`),
  `MESH_PROXY_LEDGER_DIR` (default `./mesh-ledger`), and `MESH_PROXY_CACHE_TTL`
  (`5m` or `1h`) to switch on the Anthropic prompt-cache stamp, which is off
  unless set.
- The recompute is the independent tool, one file at a time:
  `npx -y -p @harrym1707/verify mesh-verify mesh-ledger/proxy-anthropic.jsonl`.

If a partner uses this, write the ledger folder down at kickoff; the operator's
billing step reads from it.

## From source

For a partner who would rather run source they have read:

```bash
git clone https://github.com/Harrym1707/Mesh && cd Mesh
corepack pnpm install && corepack pnpm build
node --import tsx packages/cli/src/main.ts proxy
```

This is the same `mesh` command table run in place, so the ledger is still
`~/.mesh/ledger/`, and `verify`, `status` and `doctor` are run the same way
(`node --import tsx packages/cli/src/main.ts verify`). A source run reports
itself as `mesh 0.0.0 (build dev)` and does not update itself.

## What MESH never does (on every path)

- Never holds the partner's API key. It passes through to their provider.
- Never stores prompt or answer text in the ledger. Request capture, which
  does write prompt text to a local file the partner names, is off unless they
  turn it on with `--capture`.
- Never takes what was spent from its own counting: spend comes from the
  provider's reported usage. Where the saving of a token-reduction lever is an
  estimate of the tokens it removed, the ledger line and the invoice line say
  `estimated-baseline`.
- Never charges without a ledger the partner can recompute. No saving means
  `do_not_charge`, and the invoice is $0.

## What was checked, and when

The commands on this page were checked against the code on `main` on
2026-11-16, and the `mesh proxy` path was run from source that day against a
stand-in provider, with no real provider key. On 2026-11-18 the same steps
were run on 0.2.3 as installed from the website. The details are in the dated
sections at the end of [VERIFICATION.md](./VERIFICATION.md). The release's own
checks on the installed builds, 0.2.1 to 0.2.3, are in
[the release runbook](../ops/release-0.2.0-runbook.md).
