# Stage 14 — Production hardening plan

Stage 14 of the build roadmap is the pre-enterprise hardening pass: the
controls an enterprise buyer's security review expects before they route real
provider keys and production traffic through MESH. The roadmap lists twelve
items. They are not one kind of work: some are self-contained logic that lives
in the repo and can be built and tested now, and some are infrastructure,
accounts, or external attestations that code alone cannot produce.

This document sorts the twelve into those two buckets, says what "done" means
for each in-repo piece, and flags the external ones so they are tracked rather
than silently skipped or faked.

The guiding constraint from `MESH_build_pack/02_TECHNICAL_ARCHITECTURE.md` §10:

> Every request is tenant-scoped. Enforce `tenant_id`, `application_id`,
> `policy_id` at every persistence boundary. No cross-tenant cache entries.
> Use signed policy versions and immutable audit events for production
> decisions.

That single sentence is the spine of this stage: **signed policy versions**,
**immutable audit events**, and **tenant scoping** are the three load-bearing
in-repo pieces, and the rest either support them or depend on external infra.

`packages/core` has zero runtime dependencies and uses only `node:` builtins
(see `SECURITY.md`). Everything built here keeps that promise: signing,
hashing, and encryption config use `node:crypto` only.

---

## A. Buildable in-repo now

These are pure, deterministic TypeScript modules with vitest coverage. They
land in a new `packages/core/src/security/` module so they do not touch the
routing files the concurrent Stage 6 work is editing. They reuse the
hash-chained, recomputable pattern already proven by the savings ledger
(`packages/core/src/savings-ledger.ts`): canonical JSON → `sha256` →
`(seq, prevHash, eventHash)` chain, verifiable end to end with the exact break
point named.

| # | Item | Module | What "done" means |
|---|------|--------|-------------------|
| 1 | **Audit logging** | `security/audit-log.ts` | Append-only, hash-chained audit events for every production decision (policy publish, rollout change, rollback, access grant). Tamper-evident: a perturbed, reordered, or dropped event is reported with its exact sequence number. Tenant/app/policy scoping carried on every event. |
| 2 | **RBAC** | `security/rbac.ts` | Role→permission model (owner/admin/operator/analyst/viewer), a pure `authorize()` that enforces the `tenant_id` + `application_id` boundary from §10, and deny-by-default semantics. No cross-tenant authorization is representable. |
| 3 | **Encryption config + retention controls** | `security/data-protection.ts` | Declarative, validated configuration for encryption (at rest / in transit, key reference, algorithm allow-list) and per-data-class retention windows. A pure `recordsToPurge()` that, given a retention policy and dated records, returns exactly what is past its window — the logic a retention job runs, independent of the store it runs against. |
| 4 | **Policy signing** | `security/policy-signing.ts` | Detached Ed25519 signatures over the canonical form of a routing/quality policy version, with verification. A production decision can cite the signed digest of the exact policy it used; a tampered policy fails verification. |
| 5 | **Immutable rollout history** | `security/rollout-history.ts` | Append-only, hash-chained record of rollout state transitions (enable, percentage change, rollback) per policy. Reduces to the current rollout state and is independently verifiable, so "what was live at time T, and who changed it" is answerable and tamper-evident. |

Shared helper: `security/hash-chain.ts` — the generic
`(seq, prevHash, entryHash)` chain extracted from the savings-ledger pattern,
used by both the audit log and the rollout history so the two agree byte for
byte with the ledger's approach. Barrel: `security/index.ts`, re-exported from
`packages/core/src/index.ts`.

### Self-hosted evaluation (partial, in-repo)

"Self-hosted evaluation" is mostly a deployment story (bucket B), but the part
that is code already exists: the evaluator, replay gate, and quality policy
are pure functions in `packages/core` with no hosted dependency, so a customer
can run evaluation entirely in their own environment. This plan documents that
and leaves the packaging/deployment artifacts (Helm chart, container,
air-gapped install) to bucket B.

---

## B. Needs external infrastructure, accounts, or attestation — flagged, not attempted

These cannot be produced by code in this repo. Attempting them here would
either be a stub masquerading as the real control, or would require
credentials and infrastructure this session does not have. They are listed so
they are tracked, with the concrete blocker and what would unblock them.

| Item | Why it is external | Unblocks when |
|------|--------------------|---------------|
| **SOC 2 preparation** | An attestation by a third-party auditor against evidence collected over a 3–12 month observation window. Code can *produce evidence* (the audit log and rollout history here are examples), but the report itself is an engagement with an auditor. | A SOC 2 auditor is engaged and an observation period is defined. |
| **SSO** | Requires an identity provider (Okta/Entra/Google Workspace), registered OAuth/OIDC or SAML app, client secrets, and callback URLs — external accounts and credentials. The RBAC model here is the *authorization* half and is designed to consume an authenticated subject + claims from whatever IdP is wired up. | An IdP tenant and app registration exist; SSO config/secrets are provisioned. |
| **Private networking** | VPC/PrivateLink/peering, DNS, and firewall configuration in a cloud account. Pure infrastructure. | A target cloud environment and network design are chosen. |
| **Data residency** | Region-pinned storage and routing across real deployed infrastructure (Postgres/ClickHouse/object storage in-region, region-aware request routing). The retention/encryption config here carries a residency region field so the policy is expressible, but enforcement is an infra property. | Multi-region infrastructure is provisioned. |
| **Incident response** | Partly a document (runbook, severity matrix, on-call rotation) and partly tooling (PagerDuty, status page). The document can be drafted; the tooling and rotation are external. Scoped out of the code implementation here; a runbook can be a fast follow. | On-call tooling is chosen and a rotation is staffed. |
| **Self-hosted evaluation (packaging)** | The evaluation *logic* is in-repo (see A). Shipping it as a self-hostable unit needs a container image, chart, and release pipeline — build/infra artifacts. | A packaging target (container/Helm) is agreed. |

---

## Why these five, in this order

1. **Immutable audit log** and **rollout history** are the evidence SOC 2 and
   enterprise review ask for first, and they reuse a pattern already trusted in
   this codebase, so they are the highest-confidence build.
2. **Policy signing** closes the §10 requirement directly ("signed policy
   versions") and gives audit events something tamper-proof to cite.
3. **RBAC** is the authorization boundary; it is the in-repo half of SSO and is
   useful immediately even before an IdP exists.
4. **Encryption + retention config** makes the data-governance posture explicit
   and testable, and carries the residency field that the (external) residency
   work will enforce.

All five are additive new modules. None edits the routing engine, so they do
not collide with concurrent Stage 6 router work.
