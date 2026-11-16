# The data-handling answer

The question every pilot conversation reaches within ten minutes: *"what do you
see, and where does it go?"* This is the answer, and every sentence is sourced
to the code path that enforces it. Corrected on 2026-11-16 for MESH 0.2.1; the
website's [privacy policy](../site/privacy.md) is the public statement of the
same position.

## Short version

MESH runs entirely on your machines. In a pilot it is a **local proxy**: a
program on your own machine, listening on `127.0.0.1`, that sits between your
app (or Claude Code) and your AI provider. Your API key passes through to your
provider and is not stored. The ledger it appends contains **token counts,
model IDs, timestamps, dollar figures, lever names and hashes — never prompt
or completion content**. Nothing about your traffic is sent to MESH: there is
no telemetry endpoint and no hosted MESH service in the request path. The only
requests to MESH's own addresses are downloads of the software itself.

MESH is published: the installer and runtime are on
`https://www.mesh-technology.com`, and `@harrym1707/mesh` and
`@harrym1707/sdk` (0.2.1, 2026-11-16) and `@harrym1707/verify` (0.1.0) are on
the public npm registry. The source is public at
`https://github.com/Harrym1707/Mesh`.

## The quote path (pre-contract, read-only)

- `mesh-quote <export> --format litellm|helicone|langfuse` is a packaged Node
  bin (`npx -y -p @harrym1707/sdk mesh-quote`) that parses your gateway
  export, prices it against a bundled catalogue, and writes `quote.json`. It
  is pure and deterministic (`packages/core/src/quote-report.ts`); it makes no
  network requests. (`npx` itself downloads the package from npm the first
  time.)
- What it reads from the export: request IDs, model names, timestamps, token
  counts, and the gateway's own reported cost (informational only). If your
  proxy stores prompt bodies in its spend logs, the parser can read them
  **locally** for segment signals (`packages/core/src/litellm.ts`) — they never
  leave the file on your disk, and the quote works without them. If you prefer,
  strip message bodies from the export before running the tool; token counts
  are what the quote is built from.
- Unreadable rows are counted and reported, never silently dropped; models the
  catalogue cannot price are reported `unpriced`, never zeroed.
- The quote is reproducible: it embeds a content hash of the price catalogue
  and a deterministic fingerprint of the accepted rows.

## The proxy path (in-pilot)

This is how a pilot runs: `mesh start` for Claude Code, `mesh proxy` for any
other app ([onboarding.md](./onboarding.md)).

- **Local only.** The proxy binds `127.0.0.1` and refuses cross-origin browser
  requests (`packages/sdk-js/src/proxy.ts`). Your requests go from your app to
  the proxy on the same machine, and from there to your provider (reduced,
  when a lever applies). They go nowhere else.
- **Your API key** is forwarded to your provider in the header your client
  sent it in. It is not stored, not logged and not written to the ledger.
- **The ledger.** Each request MESH reduces appends one `BillableEvent` to a
  local, append-only, hash-chained file in `~/.mesh/ledger/`
  (`packages/core/src/savings-ledger.ts`). The event contains: request and
  application IDs, the invoice period, a timestamp, provider, model,
  execution mode, the provider's reported token usage (including the
  cache-write TTL split when the provider reports one), the catalogue
  version, USD figures, lever records and a status. **There is no field for
  prompt or completion content.** A ledger failure cannot throw into your
  request path.
- **The feature records.** Beside each ledger file, `mesh` writes a
  `.features.jsonl` file that Theo uses to tune MESH: counts (messages, tools,
  approximate tokens per role) and keyed hashes of content blocks. The key is
  a random per-user file, `~/.mesh/blind.key`, readable only by you. No
  prompt or completion text is written. These files are not the ledger and
  are not needed for billing; they stay on your machine.
- **Request capture is the one exception, and it is yours to switch on.**
  `--capture <file>` is off by default. When on, it appends copies of your own
  requests, prompt content included, to the file you name: owner-only, capped
  at 50 requests and 5 MB by default. Delete the file to remove them.
- **Requests MESH does not reduce** (embeddings, token counting, model lists,
  batches, file uploads) are forwarded to your provider unchanged and write no
  ledger line.

## The SDK wrapper (not the pilot path)

`@harrym1707/sdk` also exports `withMesh`, which wraps a provider client
in-process. It is not what a pilot uses. If you do use it: the ledger is
opt-in and written where you tell it, and the wrapper can mirror ledger events
(usage records, no prompt text) to an address you configure, only when both
`MESH_API_URL` and `MESH_ACCOUNT_KEY` are set (`packages/sdk-js/src/wrap.ts`).
It is off unless you set both, and the `mesh` commands set neither.

## What does leave your machine

| When | What | To whom |
|---|---|---|
| Every request | The request itself, reduced when a lever applies, with your key | Your own AI provider, as before |
| Install, and update checks | Download requests for the installer, the runtime and its version file. The installed `mesh` looks at the version file about once a day when you run it, and fetches a newer runtime when there is one; the always-on service does the same a few times a day unless `MESH_NO_AUTO_UPDATE` is set. These are plain downloads and carry nothing about your traffic | GitHub, which hosts the website, or npm |
| A replay gate, if you run one | The sampled requests from your capture file | Your own AI provider, under your key |
| Billing, at the end of a pilot | The ledger files you choose to send us | Us |

The metering sink is a pure projection of ledger events into Stripe Billing
Meters *rows in a local file* (`packages/core/src/stripe-sink.ts`); nothing is
transmitted.

## The replay gate (optional, quality verification)

Replaying a sample of your traffic to verify a lossy lever does send those
sampled requests to **your own provider** under your key — the same place they
already went. MESH never sees them; the gate verdict (approved/rejected) is
what lands in the ledger.

## What MESH retains after a pilot

Nothing, structurally: all artifacts (export, quote, ledger, invoice) live on
your side. The invoice is a pure function of the ledger, so the dispute path
is "run it yourself" (`mesh verify`), not "trust our database." If you send us
ledger files for an invoice, we keep them with the invoice as the audit trail;
the [privacy policy](../site/privacy.md) says for how long.

## Honest limitations

- These guarantees are enforced by code you can read, not by a SOC 2 report:
  MESH has no compliance certifications yet (pre-revenue, zero customers).
- MESH has not yet run on a customer's real traffic. The behaviour above was
  checked against a stand-in provider, not under a partner's workload.
- The website's Terms and Privacy policy are first drafts that no lawyer has
  reviewed, and there is no DPA. If you need a DPA or security questionnaire,
  the honest answer today is that the architecture makes most questions moot
  (no data ingress), and we will sign reasonable paper for a design
  partnership.
