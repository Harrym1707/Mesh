# Billing — what still needs YOUR Stripe TEST credentials

Everything below the line in [Closed without Stripe](#closed-without-stripe) is
proven on this branch by the automated suite, with **no live key and no network
to Stripe** — a fake `BillingStripe` stands in for the real client everywhere.

What remains needs a **real Stripe TEST account** (an `sk_test_…` key and a test
`cus_…` customer). These steps exercise Stripe's own API responses, which a fake
client cannot stand in for. **Never use an `sk_live_…` key for any of this** —
the client, the worker and the API server all refuse one (see the guard tests),
and these steps create real objects only in Stripe **test mode**.

> You run these yourself. This repo will not ask for, store, or paste a Stripe
> key. Put your test key in `~/.config/mesh/stripe.env` (git-ignored) or pass it
> on the command line of the step you are running.

---

## Closed without Stripe

Proven on this branch by `vitest run` (820 passing), no live key, no network:

- **`sk_live_` guard** — the automated path (`createStripeClient` with no
  `allowLive`, and `buildContext` for the API server) refuses a live key before
  any network call; only the deliberate human `mesh-bill --live` path may pass
  `allowLive`. `packages/core/src/stripe-client.test.ts`,
  `apps/api/src/context.test.ts`.
- **Ledger ↔ invoice seam** — the billing worker's invoice input is the same
  append-only hash-chained ledger metering writes into; ingest refuses tampered
  or forked batches; a spool corrupted on disk makes settle skip with zero
  Stripe calls and no billed-record. `packages/core/src/billing-ledger-seam.test.ts`.
- **Money-safety fixes 1–6** (persistent idempotency, mandatory period, ceiling
  + advance-notice gate, carry-forward deficit, server-side savings
  re-derivation, live-path gate). `packages/core/src/billing-money-safety.test.ts`,
  `stripe-billing.test.ts`, `billing-worker.test.ts`.
- **Edges** — period-boundary isolation, the aggregate-savings ceiling across
  periods, the sub-cent rounding floor, currency passthrough, under-claim
  allowance. `packages/core/src/billing-edge-cases.test.ts`.

---

## Needs a Stripe TEST account

Each step says the one thing it proves that a fake client cannot.

### 1. Test key is accepted; the guard lets test mode through
```bash
STRIPE_TEST_SECRET_KEY=sk_test_xxx node --import tsx -e \
  'import("./packages/core/dist/src/index.js").then(m => console.log(m.createStripeClient(process.env.STRIPE_TEST_SECRET_KEY).mode))'
# expect: test
```
Proves: a real `sk_test_…` key constructs a live-in-test client (the fake always
reports `mode: "test"` by fiat).

### 2. `mesh-bill` creates a real DRAFT invoice in test mode
Build core first (`corepack pnpm -s exec tsc -b`), have a test customer
`cus_…`, and a valid ledger spool (e.g. from `mesh verify`'s export, or a
synthetic chain). Then:
```bash
STRIPE_TEST_SECRET_KEY=sk_test_xxx node --import tsx scripts/mesh-bill.ts \
  --customer cus_TEST --period 2026-10 --fee 1 your-spool.jsonl
```
Proves: the create-invoice-then-attach-item sequence lands a non-empty **draft**
in the Stripe dashboard (the empty-draft fix against Stripe's real
`auto_advance=false` behaviour). Leave it as a draft; do not finalize unless you
mean to.

### 3. End-to-end settle through the worker (bank_transfer rail)
Point the worker at a data dir holding a test account (`paymentChoice:
"bank_transfer"`) and its ledger spool:
```bash
MESH_DATA_DIR=./.mesh-data MESH_STRIPE_TEST_SECRET_KEY=sk_test_xxx \
  node --import tsx scripts/mesh-bill-worker.ts --period 2026-10
```
Proves: `createInvoice (send_invoice) → createInvoiceItem → finalizeInvoice`
against Stripe's real finalize, and that the durable billed-record is written so
a second run reports `ALREADY BILLED`. (`--dry-run` needs no key and is already
exercised logically by the suite.)

### 4. Direct-debit rail — mandate collection + pull
Needs a test customer with a **confirmed test mandate** (ACH/BACS/SEPA):
collect it via the self-serve checkout-session flow (`createMandateCheckoutSession`
→ complete the Stripe test checkout → `getSetupIntent` →
`setDefaultPaymentMethod`), then run the worker in two passes:
```bash
# pass 1 — issue the advance notice (required before any direct-debit pull)
... node --import tsx scripts/mesh-bill-worker.ts --period 2026-10 --mode advance_notice
# pass 2 — the actual pull
... node --import tsx scripts/mesh-bill-worker.ts --period 2026-10
```
Proves: the mandate's `payment_method` is used as the invoice default, and
`finalizeInvoice → payInvoice` pulls against it — the one path the fake cannot
stand in for (real `charge_automatically` + mandate semantics). Confirm the test
PaymentIntent succeeds in the dashboard.

### 5. Admin API billing run + refund (test mode)
With the API server booted against a test key (`MESH_STRIPE_TEST_SECRET_KEY`,
`MESH_ADMIN_TOKEN`):
```bash
curl -s -H "authorization: Bearer $MESH_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"period":"2026-10"}' http://localhost:PORT/v1/admin/billing/run
# then, against a resulting payment_intent:
curl -s -H "authorization: Bearer $MESH_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"paymentIntentId":"pi_test_xxx"}' http://localhost:PORT/v1/admin/refunds
```
Proves: `POST /v1/admin/billing/run` settles through the real client and the
response `stripeMode` is `test`; `POST /v1/admin/refunds` issues a real
test-mode refund. (The 400 on a missing period and the preview-only path need no
key.)

### 6. Idempotency against Stripe's own key window
Re-run step 2 or 3 twice within ~24h with the **same** customer+period+amount.
Proves: Stripe recognises the idempotency key and returns the same objects
rather than duplicating them — the Stripe-side half of the double-charge
defence that complements the durable billed-record (which the suite already
proves works independently of Stripe's 24h window).

---

### Safety reminders for every step
- Only `sk_test_…` (or a restricted `rk_test_…`) keys. The guard refuses
  `sk_live_…`; do not pass `--live` / `allowLive`.
- `mesh-bill` leaves a **draft** unless you pass `--finalize`; review it in the
  dashboard before finalizing anything, even in test mode.
- These create objects in your Stripe **test** data only — clear them from the
  test dashboard afterwards if you like; they never touch live.
