# Scout: verifiable-ledgers-metering

_Scouted 2026-10-29. Area: tamper-evident / verifiable logging + usage-metering._

## Context: where MESH is today

`packages/core/src/savings-ledger.ts` is an append-only, **linear hash chain**
(`seq`, `prevHash`, `eventHash`) over `node:crypto` SHA-256, with a deterministic,
idempotent `recomputeInvoice`. It is strong on *recomputability* (customer re-derives
every USD figure from the same price catalogue) but has two structural gaps the repos
below can close:

1. **No sub-linear proofs.** A linear chain means a verifier must replay the whole
   spool to check any one event. A Merkle structure gives O(log n) inclusion proofs
   ("event X is in the billed set") and consistency proofs ("the ledger you showed me
   last month is a prefix of this month's") — exactly what a customer auditing a 1%
   invoice wants.
2. **No independent anchor.** Today the chain is self-attested; MESH could in principle
   rewrite history before a customer first sees it. An external transparency-log anchor
   (sigstore/Rekor) or periodic root publication removes "trust MESH's own clock."

License note: MESH is **BUSL-1.1**. MIT/Apache deps are fine. AGPL (Lago) is a hard no
as a linked dependency — pattern-study only. BUSL deps (immudb) are usable but add a
competitor-carve-out clause; prefer not to link.

---

## Ranked findings

### 1. transparency-dev/merkle + merkletreejs — the proof layer MESH is missing
- **transparency-dev/merkle** (Go, Apache-2.0, ~200★, maintained by the ex-Google
  trillian team) — https://github.com/transparency-dev/merkle — the canonical RFC 6962
  log-merkle, inclusion/consistency proof construction + verification. Reference for the
  *algorithms*, not a dependency (MESH is TS).
- **merkletreejs** (TypeScript, **MIT**, ~1.2k★, actively developed) —
  https://github.com/merkletreejs/merkletreejs — construct Merkle trees + verify proofs
  in JS, incl. Merkle Mountain Range (append-friendly).
- **Borrow:** depend on `merkletreejs` (MIT) to layer a Merkle tree over the existing
  event stream, OR copy the compact RFC-6962 inclusion/consistency verifier from
  transparency-dev/merkle (~300 LOC) into pure TS for a zero-dep core. Emit a signed
  tree head (STH) per billing period; ship the inclusion-proof verifier so a customer
  verifies a single billed event without the full spool.
- **Effort:** copy-pattern (verifier) or adopt-as-dep (merkletreejs). ~1-2 days to wrap
  the ledger and add proof emission.

### 2. sigstore/rekor — external anchoring so "we couldn't rewrite it" is provable
- Go, **Apache-2.0**, ~1k★ on the core repo, heavily maintained (CNCF/Linux Foundation),
  production transparency log. https://github.com/sigstore/rekor
- Rekor stores entries in an immutable Merkle tree (Trillian backend) and returns a
  signed, timestamped inclusion proof. A public-good Rekor instance exists; Rekor V2 is
  tile-based and lighter to run.
- **Borrow (architecture):** periodically anchor MESH's signed tree head (one hash per
  billing period) into a Rekor instance. The customer then verifies the MESH ledger root
  against an **independent** append-only log with its own timestamps — this is the
  cheapest path to "tamper-evident without trusting MESH's clock," and it directly
  supports the confidential-computing story (attested enclave signs the STH, Rekor
  timestamps it). No API spend; anchoring is one small entry per period.
- **Effort:** study-only now, copy-pattern later. Don't vendor the Go server; integrate
  via its REST API or self-host. Backs the Nitro-Enclave roadmap cleanly.

### 3. OpenMeter — the metering engine pattern (Apache-2.0, AI-focused, trending)
- Go + TS SDKs, **Apache-2.0**, ~2.5k★, now part of Kong, actively maintained,
  explicitly built "for AI, API and usage-based products." https://github.com/openmeterio/openmeter
- Event ingestion → real-time aggregation (dedup by idempotency key) → usage →
  billing. Processes billions of events; cloud-events based.
- **Borrow:** the metering *architecture* — idempotent event ingestion keyed by
  requestId (MESH already dedups by requestId; OpenMeter validates the pattern at scale),
  windowed aggregation, and the separation of metering from invoicing. Apache-2.0 TS SDK
  means MESH can study or even depend on client pieces without license risk. Also a model
  for the *hosted* gateway's metering plane as MESH scales past single-process ledgers.
- **Effort:** copy-pattern / study-only. Adopt its aggregation shape if the in-memory
  ledger needs to become a streaming pipeline; don't swap the billing core (MESH's
  recompute-from-catalogue model is more verifiable than OpenMeter's).

### 4. google/trillian — the scale ceiling (study-only)
- Go, **Apache-2.0**, ~3.1k★, Google-maintained, powers Rekor + CT logs.
  https://github.com/google/trillian
- A verifiable log/map served from a pluggable storage layer (MySQL), gRPC "personality"
  API. This is what you graduate to when the ledger outgrows a file/process.
- **Borrow:** the *personality* pattern (your domain logic in front of a generic
  verifiable log) and the storage-backed log design. Not a dependency — it's Go + MySQL
  heavyweight — but the architecture is the proven end-state if MESH's ledger must become
  a multi-tenant hosted service. Reference for how to keep proofs cheap at billions of
  entries.
- **Effort:** study-only. Informs the hosted-gateway data-plane design, not near-term code.

### 5. immudb — immutable DB with built-in cryptographic verification (license caveat)
- Go, **BUSL (Codenotary)**, ~8.9k★, actively maintained. https://github.com/codenotary/immudb
- SQL/KV/document store that is append-only with a built-in Merkle tree over the whole
  payload and per-transaction cryptographic verification — "blockchain without the
  complexity."
- **Borrow:** if MESH wants a *storage engine* that gives tamper-evidence for free instead
  of hand-rolling it, immudb is the closest turnkey option. **But** its BUSL license has a
  hosted-competitor carve-out — awkward for a BUSL product that itself ships a hosted
  gateway. Use as design reference (how they bind payload→Merkle→signed root) rather than a
  dependency; revisit only if self-hosting it behind MESH (not re-offering it) is clearly
  within its grant.
- **Effort:** study-only (license friction makes adopt-as-dep a reject).

### Rejected / pattern-only
- **Lago** (getlago/lago-api, ~7k★, **AGPLv3**) — https://github.com/getlago/lago-api —
  excellent open metering + usage-billing stack (subscriptions, pricing iterations,
  payment orchestration). **AGPL makes it a non-starter as a linked dependency for a BUSL
  product.** Study the data model (meters, charges, netting) only; do not import.

---

## Recommended next steps for MESH (concrete)
1. **Add a Merkle layer over the existing chain** using `merkletreejs` (MIT) or a copied
   RFC-6962 verifier; emit a signed tree head + per-event inclusion proof so a customer
   verifies one billed event in O(log n) without the full spool. (Biggest verifiability
   win, lowest effort.)
2. **Anchor the periodic STH into sigstore/Rekor** for an independent, timestamped proof
   that the ledger wasn't rewritten — this is also the natural signing boundary for the
   Nitro-Enclave attestation roadmap.
3. Keep MESH's recompute-from-catalogue billing core; borrow OpenMeter's idempotent
   ingestion + windowed aggregation only if/when the ledger must become a streaming,
   multi-tenant plane; hold trillian as the known scale end-state.
