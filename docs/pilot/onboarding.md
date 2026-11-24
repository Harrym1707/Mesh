# MESH pilot onboarding — the one path

Since release 0.2.1 (2026-11-16) there is one way to set MESH up: install it
from the website, then run `mesh start` (Claude Code) or `mesh proxy` (any
other app or agent). Everyone sets it up this way, in a pilot or not, so every
ledger lands in the same place. The current release is 0.2.5 (read
2026-11-23, on the website and on npm); it does not change the path.

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

`mesh version` should print `mesh 0.2.5` or later on a fresh install by
either route (read 2026-11-23). An older website install moves to it on its
own, or at once with `mesh update`. A pilot needs 0.2.5 or later, because the
monthly statement must be signed and earlier releases do not sign it. `mesh doctor` checks Node,
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
4. `mesh status` shows requests seen and the saving since install.

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
recomputes the total from them, with no network calls. That total covers
everything since install, as `mesh status` does.

For one calendar month (UTC), which is what an invoice covers:

```bash
mesh statement --period YYYY-MM
```

It re-checks the chain, recomputes that month, prints the saving by lever,
the fee and the verdict, and writes `mesh-statement-YYYY-MM.json` in the
folder it was run from (`--out <file>` to put it elsewhere). From 0.2.5 the
file is signed with the install's statement key, and the command prints
`Signed by this install's statement key:` and the fingerprint. For a month
that has not ended it says so, and the figures can still change.
`mesh statement --check <file>` tells whether a statement file has been
altered since it was written, whether its signature verifies, and which key
signed it.

### 6. Register the statement key (a pilot or a paying customer only)

A pilot ends in an invoice, and we bill only from a statement signed by a key
the partner has registered. So, once, when the pilot is agreed:

```bash
mesh statement --key
```

It prints the fingerprint of this install's statement key, creating the key
the first time: 64 hexadecimal characters. The partner sends us the
fingerprint through the channel agreed in writing. It is public and safe to
share.

- The key itself is in `~/.mesh/identity/statement-key.json`, readable only
  by the user. It never leaves the machine and is never sent to anyone.
- The monthly statement is then run on that same machine.
- After a reinstall or a move to a new machine the fingerprint is different,
  and the new one is registered the same way before the next statement.
- If the key file is damaged, `mesh statement` stops and says so. It does not
  make a new key on its own.

Someone who is only trying MESH, with no billing agreed, does not need to
register anything.

For a second opinion that shares no code path with the installed `mesh`, the
MIT-licensed `@harrym1707/verify` package (0.1.0) does the same recompute on
one ledger file at a time, over the whole file:

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
   If the team was already running MESH, note the kickoff time: the ledger
   then holds earlier lines too, and the window's lines are picked out by
   timestamp.
2. **The window.** A pilot is about four weeks end to end; 14 days of that is
   measurement ([PILOT_PLAN.md](./PILOT_PLAN.md) has the timeline).
3. **Theo stays on `recommend`,** the default. He applies lossless levers on
   his own and puts anything that changes what is sent to the partner as a
   proposal (`mesh theo --proposals`, `--accept`, `--reject`). Nobody turns on
   `--autonomy optimise` during a pilot: automatic adoption is not ready for
   real traffic.
4. **Levers.** A fresh install enforces three lossless levers: tool-schema
   compaction, duplicate-context removal and cache-prefix repair. See
   [What a fresh install does](#what-a-fresh-install-does-and-how-more-is-switched-on)
   below for what that leaves out. A lossy
   lever runs only if the partner accepts a proposal for it. There is also
   one opt-in lever, JSON tool-result compaction, added in 0.2.2. It is off
   by default and Theo does not adopt it. Whether to use it in a pilot is
   agreed at kickoff; the
   [configure guide](../guide/configure.md#optional-compact-json-tool-results)
   says how, and when not to. It needs 0.2.3 or later: 0.2.2 dropped a lever
   added by hand at Theo's next background cycle.
5. **What reaches us, and when.** At kickoff, the statement key fingerprint
   (step 6 above), through a channel agreed in writing that is not the one
   the monthly files will use. Then, billing runs by calendar month: after
   the month has ended the partner runs `mesh statement --period YYYY-MM` on
   the machine whose key they registered and sends the statement file and
   the ledger files from `~/.mesh/ledger/` (not the `.features.jsonl`
   files), after looking at them. How a window that crosses a month end is
   invoiced is not decided.
6. **The build can change during the window.** A `mesh` installed from the
   website keeps itself up to date from it (each runtime is checked against
   its published checksum before it runs). How an npm install is updated was
   not checked. Note what `mesh version` prints at
   kickoff and at the end. `mesh update --rollback` goes back to the previous
   runtime.

---

## What a fresh install does, and how more is switched on

Stated once, plainly, because the published figures were not measured this
way.

**Out of the box** MESH applies three lossless levers and nothing else:
tool-schema compaction, duplicate-context removal and cache-prefix repair
(the default policy, `~/.mesh/theo-policy.json`). The request the provider
receives means what the app sent. No savings percentage has been published
for this configuration on its own. The one LIVE figure, 18.2% (run
2026-10-26), was measured with the Anthropic cache stamp and a tool-result
cap switched on, both off in a fresh install; the three default levers
account for under half of it. A team whose client already caches, as Claude
Code does, should expect little from the defaults.

**How more is switched on today,** as the code and the
[configure guide](../guide/configure.md) on `main` have it:

- **Theo's proposals.** On the default autonomy, `recommend`, Theo applies
  the lossless levers himself. He can prove three answer-changing levers on
  the partner's own traffic and then propose them: tool-description
  trimming, stale-history compaction and a lower output effort. Proving
  needs request capture (`mesh start --capture <file>` or
  `mesh proxy --capture <file>`, off by default, which writes prompt text to
  that local file) and a replay to the partner's own provider under their
  key (`mesh theo --gate <file>`). The partner answers with
  `mesh theo --proposals`, `--accept <lever>` or `--reject <lever>`. Nobody
  sets `--autonomy optimise`.
- **The policy file.** The proxy enforces levers listed in
  `~/.mesh/theo-policy.json`, and from 0.2.3 Theo keeps one added by hand.
  The configure guide gives the steps for one such lever, JSON tool-result
  compaction. A lever that can change an answer is still withheld unless it
  carries a replay-gate proof.
- **The cache stamp and the tool-result cap,** the two levers behind most of
  the LIVE figure, are not among the levers Theo proposes, and the configure
  guide gives no steps for them in the installed `mesh`. The no-install npm
  proxy below can switch the cache stamp on with `MESH_PROXY_CACHE_TTL`, and
  the SDK wrapper takes both as options. Do not tell a partner that the
  installed `mesh` will reach the measured configuration by itself.

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
- No Theo, no `mesh dashboard`, no `mesh status`, no `mesh verify` and no
  `mesh statement`, so a partner on this path cannot produce the monthly
  statement an invoice needs.
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
were run on 0.2.3 as installed from the website, on 2026-11-19
`mesh statement` was run on 0.2.4, and on 2026-11-23 the statement key and a
signed statement were run on 0.2.5. The details are in the dated
sections at the end of [VERIFICATION.md](./VERIFICATION.md). The release's own
checks on the installed builds, 0.2.1 to 0.2.3, are in
[the release runbook](../ops/release-0.2.0-runbook.md); the billing and
statement-key procedure is in
[the first-invoice runbook](../ops/first-invoice-runbook.md).
