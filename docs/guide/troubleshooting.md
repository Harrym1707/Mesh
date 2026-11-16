# Troubleshooting

## Start here: `mesh doctor`

```bash
mesh doctor
```

It checks, in order, and marks each ✓ / ⚠ / ✗ with a one-line fix:

- **node** — your Node version (22 LTS recommended; older than 20 is a hard fail).
- **runtime** — whether a fetched runtime is cached, or MESH is running in place.
- **proxy** — whether the proxy is answering on `127.0.0.1:8787`.
- **claude** — Claude Code wiring: what `ANTHROPIC_BASE_URL` points at in
  `~/.claude/settings.json`.
- **service** — whether the always-on launchd service is installed (macOS).
- **ledger** — record count and whether the hash-chain verifies.

Add `--json` for machine-readable output. A hard failure exits non-zero.

## Common issues

### Proxy not running

`doctor` shows `⚠ proxy  not running on :8787`. Start it:

```bash
mesh start
```

If you expect the always-on service to be running, check
`mesh status`; if it shows the service installed but the proxy down, read
`~/.mesh/daemon.log`.

### Claude Code isn't going through MESH

`doctor`'s **claude** line should read `ANTHROPIC_BASE_URL → http://127.0.0.1:8787`.
If it says "not set" or points elsewhere, run `mesh start` (or `mesh install`) to
wire it up. If it says `~/.claude/settings.json is not valid JSON`, fix or remove
that file first — MESH deliberately won't overwrite invalid JSON.

### Claude Code can't connect after MESH stopped

`doctor`'s **claude** line shows `✗` and says the address was left by a MESH
session that is no longer running, or that nothing is listening there. This
happens only if `mesh start` was killed outright or the machine went down:
Claude Code is still pointed at the proxy. Put it back:

```bash
mesh restore
```

Or run `mesh start` again. Then open a new Claude Code session.

### Node too old

Upgrade to Node 22 LTS from <https://nodejs.org>. MESH warns on Node 20–21 and
refuses to run on anything older.

### Port 8787 already in use

Something else is on the default port. Run MESH on another port and point your
client at it:

```bash
mesh start --port 9000
```

For the always-on service, use `mesh install --port 9000`.

### Checksum or download failure on install

If the bootstrap reports the runtime failed its checksum, it refuses to run that
copy — try again, as it is usually a corrupted download. If it can't reach
`https://www.mesh-technology.com` on a fresh machine with no cached runtime, check your
connection and retry; an existing install keeps working offline from its cache.

### Ledger chain broken

The ledger should never break. If `doctor` or `verify` reports a broken chain,
run `mesh verify` and report it (see [Data and privacy](data-and-privacy.md) for
where the ledger lives).

## Still stuck?

See the project's security and reporting guidance, or open an issue on the
repository.
