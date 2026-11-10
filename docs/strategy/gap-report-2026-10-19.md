# MESH gap report — the road to a commercial product

*2026-10-19. Eight gap areas, each researched by one agent and then challenged by a second agent whose job was to break it. Where the challenger found errors, the corrected ("sharpened") plan below replaces the original. Appendix B lists every error the challengers caught.*

---

## 1. Executive summary

Three gaps matter most, in plain English:

1. **MESH contradicts itself in public, today.** The first command on the homepage fails on a fresh clone (no install step), the pilot kit says the fee is 25% while the site and license story say 15%, and the comparison page carries stale competitor facts. For a product whose entire brand is honesty, these are the most damaging gaps — and the cheapest, fixable in hours.
2. **There is no path from a happy customer to money in the bank.** No legal entity (the license names you personally), no signable pilot agreement, no production-use grant (the BUSL license forbids production use without one), no `mesh invoice` command, no Stripe account. A customer who wanted to pay tomorrow literally could not.
3. **MESH is flying blind on itself.** No adoption data (GitHub traffic stats expire unarchived every 14 days), no nightly eval runs (a lever regression is only caught if someone remembers to run a script), no spend report a customer can look at, and a price catalogue that silently goes stale. The measurement machinery is excellent — nothing watches it.

Everything else — reliability numbers, the zero-key demo, the Stripe transmitter, the open verification spec — builds on those three. The good news: the challengers confirmed the core moat is real. **No competitor anywhere bills a percentage of verified savings with a customer-recomputable ledger.** The road to commercial is mostly plumbing and paperwork, not invention.

---

## 2. The eight areas

### 2.1 Billing — how do we charge anyone?

**The gap.** The code can compute a customer-recomputable invoice and even project it into Stripe-ready meter rows (`packages/core/src/stripe-sink.ts`), but the chain stops at a local file. No Stripe account, no transmitter, no CLI command that renders an invoice. Today collecting the 15% fee means emailing someone a number and hoping.

**Sharpened recommendation** *(challenger found 6 violations — see Appendix B)*. Do manual Stripe Invoicing now, build toward the self-serve meter transmitter later:

1. `mesh invoice --period YYYY-MM` is a **customer-side** command (the ledger never leaves their machine): it runs the existing `recomputeInvoiceWithAudit` with `feePercent: 15` — fee math, `amountDueCents`, and the charge/do_not_charge verdict **already exist in core** (savings-ledger.ts lines ~397, 438–441); do not reinvent them — asserts the Stripe-row projection reconciles to the cent, refuses to emit a billable bundle when the verdict is do_not_charge, and writes an evidence bundle (invoice JSON + meter JSONL + chain head — numbers and hashes only, privacy promise intact). The customer sends MESH that bundle; the pilot agreement must name this monthly export explicitly, plus a chain-head sharing cadence so the hash chain actually protects against retroactive edits.
2. Bill pilots via Stripe hosted invoices against the received bundle; prefer Bacs/ACH rails over cards. Verify Stripe's actual invoicing fee first (the researched "$2 cap on the 0.4%" was unsubstantiated).
3. Spec `packages/billing-stripe` as a separate opt-in package (core stays network-free), with the transmitter running **MESH-side** on the received file — never MESH Stripe keys on customer machines. Transmit only non-negative hourly windows; reconcile negatives as an invoice-level credit note. The local file stays the honest record with negatives preserved.
4. VAT: first confirm where the two pilot customers are established. Overseas B2B is outside UK VAT scope ("reverse charge" — the customer accounts for it) and doesn't count toward the £90k registration threshold; any UK customer does count.
5. Skip dedicated billing platforms (Metronome/Orb/Lago) until a contract needs commits or ramps. (Note: Metronome is **not** Stripe-owned — researcher error.)

**First actions (Claude can build):** the `mesh invoice` command; the one-page pilot billing agreement template with reverse-charge wording; the billing-stripe design doc; the negative-window policy written into the honesty rules ("negatives are never dropped — they net at the invoice as a credit"); a lock-test that a doubled/shuffled spool yields byte-identical meter output and an identical invoice total.

**FOUNDER-ONLY:** create the Stripe account (identity verification, UK bank); decide business structure before the first real invoice (sole trader vs Ltd); sign pilot billing agreements; enable Bacs/ACH on the account; watch the £90k UK VAT threshold.

### 2.2 Spend tracking — what does the customer see?

**The gap.** The ledger records everything a spend view needs, but customers have no way to see it short of writing their own JSONL parser. Competitors (LiteLLM, Helicone, Langfuse) all ship spend dashboards; "recompute the invoice yourself" currently reads as *weaker* visibility than the tools MESH claims to beat on honesty.

**Sharpened recommendation** *(5 violations)*. Ship a **static local HTML report** (`mesh report`): one self-contained file, zero network requests — the only version where the privacy claim is mechanically checkable (open devtools, see nothing leave). Corrections that matter:

- The CLI has **no subcommand dispatcher at all** today — `parse()` reads flags directly and the documented `mesh analyse` invocation would actually throw. Build dispatch first (~0.5 day), then register `analyse` / `report` / `invoice`.
- `hourWindowOf` in stripe-sink.ts is module-private; export it or extract it into a new pure `aggregateLedgerSeries()` in core, with a test that report totals equal `recomputeInvoice`'s to the cent.
- The report must refuse to render a broken hash chain (naming the failing record), and the headline chart must **visually separate measured savings from estimated-baseline savings** — never render an estimate in the same visual register as a measurement.
- Footer identity = the verified chain head (final seq + hash) + catalogue versions + the exact recompute command. Not a "traffic fingerprint" (that's a different artifact).
- Any competitive copy (Helicone maintenance mode, Langfuse pricing) must be verified against **primary sources** before it ships on mesh-technology.com — the researcher's citations were third-party blogs, which would break the honesty rules.

Localhost live dashboard is v2 on design-partner pull; a hosted dashboard is "never until a customer explicitly asks" — it burns the differentiation.

**First actions (Claude):** CLI dispatcher + `mesh report`; `aggregateLedgerSeries` + reconciliation test; the single-file HTML template with inline SVG charts; fold `scripts/recompute-invoice.ts` into the CLI as `mesh invoice`; generate the report against the two real live exports.

**FOUNDER-ONLY:** approve which redacted real-export numbers appear in the site demo screenshot; decide whether "open devtools: zero network requests" becomes a standing marketing claim.

### 2.3 Adoption telemetry — who is even using this?

**The gap.** MESH cannot distinguish 0 users from 100. Packages are unpublished (no npm stats), GitHub traffic data silently expires every 14 days with nothing archiving it, and the site has no analytics.

**Sharpened recommendation** *(5 violations, one honesty-critical)*. Ship two zero-product-code measures this week: a daily GitHub Actions archiver for traffic/stars/referrers (every un-archived 14-day window is lost forever), and a cookieless analytics snippet (GoatCounter or Cloudflare Web Analytics) on mesh-technology.com with a one-line FAQ disclosure. Add **no** in-product ping; count the real funnel (mesh-quote runs → pilot-request issues → signed exports) by hand.

**But the researcher's flagship claim was false.** "No product code phones home" is wrong: `packages/sdk-js/src/telemetry.ts` ships a TelemetryClient that POSTs per-request metadata to any endpoint the user configures (inert when unconfigured). Publishing "the package makes no network calls except to your provider" as worded would hand a code-reading skeptic a one-line rebuttal. The honest wording: *"MESH never sends anything to us. The SDK calls only your model provider — plus an optional POST of request metadata (never prompt content) to a telemetry endpoint you yourself configure; leave it unset and no such call ever happens."* Make the claim durable with (a) a CI test asserting fetch/http usage in packages/ appears only in allowlisted files, and (b) a published payload schema for telemetry.ts — or delete telemetry.ts entirely and the claim becomes unconditionally true. Founder's call.

**First actions (Claude):** `.github/workflows/traffic-archive.yml`; analytics snippet in `scripts/build-site.ts`; corrected no-phone-home FAQ/llms.txt/README wording + the CI allowlist test; npm download polling gated on publish; weekly adoption rollup line for the sprint diary. (Extend the **existing** `evals/run-geo-audit.ts`, don't create it.)

**FOUNDER-ONLY:** npm-publish @harrym1707/sdk (prerequisite for download stats; re-verify the "npx mesh-proxy resolves to a stranger's package" claim against the registry first); create a fine-grained GitHub PAT (Administration:read) as the TRAFFIC_TOKEN secret; create the analytics account; publicly commit the policy "no in-product telemetry; any future ping is opt-in with a published schema" — or decide to delete telemetry.ts.

### 2.4 Improvement loop — how does MESH get better over time?

**The gap.** Every eval harness is hand-run, so regressions are caught only when someone remembers. The price catalogue was captured once (2026-10-08) with no staleness alarm. The one known money-losing heuristic (the 5-minute cache stamp vs per-turn timestamps) has no tripwire.

**Sharpened recommendation** *(7 violations, two factual errors)*. Build the loop in dependency order, with corrections:

1. **Fix the 5m-stamp bug first — but by observation, not regex.** Suppressing the stamp whenever a timestamp regex matches anywhere would false-positive on stable mid-prompt dates (knowledge cutoffs) and create the *opposite* money-loser. Detect volatility by comparing consecutive requests' system prompts per conversation (the cross-request analysis already exists in `packages/core/src/token-reduction.ts` — the detectors are its `BREAKER_PATTERNS`, **not** in cache-simulator.ts as researched, and need exporting). When the stable portion ahead of the volatility clears the 1,024-token minimum, stamp that stable sub-prefix rather than giving up caching.
2. **Ledger tripwire** in core (pure, beside recomputeInvoice): flag any lever whose netted savings are negative over a trailing window. This, not the static detector, is the generic catch for future heuristic bugs — zero new data collection.
3. **nightly.yml** (cron) running the **existing** gated scorecard `evals/run-analysis-regression.ts` first (the researcher proposed rebuilding what already exists), then the three seeded harnesses with `--json` flags; fail on deviation from committed baselines.
4. **Trend dashboard — not via gh-pages.** The researched plan doesn't work: Pages deploys from an artifact, no gh-pages branch exists, and switching the Pages source would take down mesh-technology.com. Instead commit the nightly JSON history in-repo and render trends through build-site.ts (inheriting its self-verification), keeping threshold alerts. Label every number as seeded-fixture output — never blended with the 18.0% live-export figure.
5. **Price freshness:** hard gate where numbers are *published* (build-site self-verification and the existing geo-audit job), warn-only in plain CI — stale prices should block publishing numbers, not unrelated builds. Weekly diff against LiteLLM's price file strictly as a drift *alarm* that opens an issue; a human re-verifies provider pages.
6. Design the customer-side spool format now; build the continuous replay gate when a design partner signs. Its verdicts feed `gateVerdictOverrides`, so a failed quality gate automatically stops billing the lossy lever — the honesty loop closes itself.

**FOUNDER-ONLY:** keep the repo active (GitHub disables cron workflows after 60 days of inactivity); optionally approve a small nightly live-run API budget (~$1–5/night); recruit and sign the design partner; decide whether stale prices block releases or only publication.

### 2.5 Onboarding — the first five minutes

**The gap.** The very first command a new user copies from the homepage **fails** ("Cannot find package 'tsx'" — no install step is shown anywhere, no Node version stated). Survivors hit contradictory docs (QUICKSTART.md describes a retired telemetry-receiver product; the runbook says 25% vs 15% everywhere else), and the product's core trust command — recompute the invoice yourself — is documented in zero places.

**Sharpened recommendation** *(4 violations)*. Minimal patch today, npm publish this week, zero-key demo after:

- The proposed "preflight error in run-proxy.ts" is **impossible** — `node --import tsx` fails before any user code runs. Instead commit a dependency-free launcher (`node start.mjs`) that checks node_modules, prints `corepack pnpm install`, and spawns the proxy; make that the homepage one-liner until npm publish lands.
- Document the recompute command with the **real** spool filename format `mesh-ledger/<app>-<provider>.jsonl` (hyphen, per proxy.ts:160) — better, have the proxy print the exact command with the literal filename after the first ledger write.
- Fee: **15% is canonical** (README, FAQ, LICENSE framing, and the business model all agree; the runbook is the lone outlier). Fix the runbook; founder sign-off is a formality.
- Zero-key demo (`pnpm demo`): proxy already supports upstream overrides for mocks. Two honesty guards: demo spools in a separate directory (`./mesh-ledger-demo/`) and DEMO stamped into the invoice output itself, so demo numbers can never be mistaken for a real ledger.
- (Dropped: the x-api-key "misrouting" worry — only GET passthrough infers provider from headers; billable POSTs route by path.)

**First actions (Claude):** fix README + site hero snippet (add install step + engines field + launcher); fix runbook 25%→15% and reconcile its no-proxy framing; rewrite or delete QUICKSTART.md; add the "Check the invoice yourself" README section; build `pnpm demo`; document the Anthropic user-scoped-key workspace-header requirement.

**FOUNDER-ONLY:** create the npm account/org for the @mesh-ai scope (it may be taken — check), enable 2FA, run the first publish; confirm 15% as canonical; approve the DEMO labeling convention.

### 2.6 Pilot contract — nothing is signable

**The gap.** Strong pilot kit, zero signable documents: no pilot agreement, no measurement exhibit, and no production-use license grant — the BUSL-1.1 license explicitly forbids production use without "a commercial agreement with the Licensor", so a design partner cannot legally run the pilot on production traffic today. The Licensor is Harry Manley personally, not an entity. *(Not legal advice; a lawyer must review before anything is signed.)*

**Sharpened recommendation** *(verdict: holds; challenger sharpened four points)*. Use Common Paper's free standards as the chassis (evaluate their **Design Partner Agreement** alongside the Pilot Agreement; use their free Mutual NDA rather than drafting one) + three MESH-specific attachments + one flat-fee lawyer review (budget to ~$5k if the lawyer also blesses the "MESH is not a GDPR data processor" position). Corrections:

- The license "blocker" is softer than researched: Harry **is** the Licensor, so a one-paragraph written production-use grant (an email suffices) unblocks a willing partner **today**. The formal rider comes later.
- **Entity formation is the true gating item**, not a parallel chore: until an entity exists and the LICENSE is re-issued under it, every signature and all pilot liability is personal. Sequence it before lawyer engagement — governing law and contract party depend on it.
- Dispute ladder fix: don't make the customer's recomputation "presumptively correct" — recomputeInvoice is deterministic, so a differing result means divergent *inputs*. The contractual rule is mechanical: the deterministic recompute over the agreed ledger + the catalogue hash embedded in it controls; the reconciliation window is for agreeing which ledger/hash is authoritative.

The crown-jewel attachment is Exhibit A (Measurement & Verification), transcribed from savings-ledger.ts semantics: baseline definition, verified definition (unmeasured levers never billed, failed tasks voided, negatives netted), prospective-only price changes, the recompute-first dispute ladder, and "quality gates only get stricter" in writing. No competitor can offer "you recompute our invoice."

**First actions (Claude):** fix the fee contradiction across docs/pilot/* and regenerate the site; draft Exhibit A from code semantics; mark up the Common Paper cover page; draft the one-page BUSL pilot license rider; convert data-handling.md into Exhibit B representations.

**FOUNDER-ONLY:** form the entity **first** (UK Ltd or equivalent; re-issue LICENSE under it); decide canonical fee + whether pilots get a monthly fee cap; engage the lawyer; set up signature tooling and sign; choose governing law.

### 2.7 Reliability — the SRE's three questions

**The gap.** The proxy is a single localhost Node process in the customer's production request path with no health endpoint, no published latency numbers, no load testing, and a billing ledger that silently and permanently stops recording on its first write error. A pilot customer's SRE will ask "what happens when it dies, how much latency does it add, can I run two" — every answer today is "unknown" or "it breaks the billing chain."

**Sharpened recommendation** *(verdict: holds; three corrections)*. Do, in order: (1) measure and publish proxy overhead (p50/p95/p99 added-ms vs a mock upstream at 1/10/50 concurrency) — the unmeasured latency number is the top pilot blocker for a product whose pitch is measurement; (2) `/healthz` + a stateless-rollback runbook ("worst case: restart in <5s, or flip base_url back — zero data loss, your keys never lived here"); (3) the ledger durability pack. Corrections:

- **Pull the backpressure fix forward** out of the deferred HA option: honoring `res.write`'s return value (~10 lines) closes the only genuinely unbounded memory path (slow client + fast upstream); with the existing 32MB cap that makes full HA deferrable.
- **The ledger must recover, not just alert:** when the spool tail defect is exactly one unterminated final line (the crash-mid-append signature), skip it and resume from the last complete record — billing-safe because invoicing already dedupes by requestId. Loud-disable (stderr + /healthz flag) stays the response for any *other* corruption, which could indicate tampering.
- Published overhead numbers must pin hardware, MESH version, and the exact reproduce command — or be framed as "measure it yourself: `pnpm eval:proxy-overhead`", which is more on-brand anyway.

Also: daily spool rotation + instance-ID in filenames (two instances sharing one directory currently interleave one file and corrupt the hash chain — the exact naive multi-instance setup a customer would deploy); document "one spool dir per instance; invoices merge and dedupe."

**FOUNDER-ONLY:** sign off the published overhead claim format (it becomes a standing commitment); decide the stated pilot reliability posture (single supervised instance + 30-second rollback, recommended) rather than promising unbuilt HA.

### 2.8 Competitive moat — what to deepen, what to ignore

**The gap.** The moat is real and unoccupied — nobody bills % of verified savings with a customer-recomputable ledger — but MESH trails on three fronts it should mostly *not* chase: routers win bigger headlines via model substitution (the self-graded quality trade the replay gate exists to expose), observability tools own real-time dashboards (crowded and free — integrate, don't compete), and provider-native caching keeps shifting the addressable waste. Meanwhile the comparison page holds stale facts (Helicone was acquired by Mintlify 2026-03-03 and is in maintenance mode; the RouterArena "12th of 12" claim predates the live leaderboard).

**Sharpened recommendation** *(5 violations)*. Deepen two moats: (1) publish the ledger schema + recomputeInvoice semantics + stripe-sink invariants as an open **verification spec** ("audit our invoice yourself"); (2) **triage-from-exports as distribution** — Helicone's ~16k orgs sit on a maintenance-mode product and MESH already reads their exports; add an OpenRouter reader. Corrections:

- **Before any outreach ships:** the ready-to-send outreach letters still say 25% vs the published 15% — a live honesty contradiction, higher priority than the comparison-page fixes.
- The "leaving Helicone" draft **already exists** (docs/pilot/outreach-helicone.md, founder-gated); remaining work is ~0.5–1 day.
- Re-derive the "~29% busy-agent ceiling" **per provider**, not as one row: live export 2 proved Anthropic has *no* implicit caching (0 cache reads unstamped; MESH's placement lever measured 37.6% cache-only), so cheaper Anthropic cache hits **enlarge** MESH's addressable value while OpenAI auto-caching shrinks it. The current "provider cache already delivers 35–40%" sentence is false for Anthropic and undersells MESH.
- Catalogue cache-rate updates must cite **provider pricing pages**, never the blog/Medium sources researched; drop or primary-source the Martian valuation.
- The spec's "one-line audit" headline is gated on npm publish; until then quote the repo-truthful `evals/run-invoice.ts` command.

**FOUNDER-ONLY:** decide whether to name routers publicly at all; approve the "leaving Helicone" outreach angle; choose the verification spec's license (a spec for third-party auditors arguably wants a permissive license, separate from BUSL code).

---

## 3. Ranked roadmap

Ordered: pilot-blocking truth fixes first, then the revenue path, then the feedback loops, then moat work. **Owner: C = Claude can build; F = founder-only; C+F = Claude builds, founder provides account/decision/signature.**

| # | Action | Area | Effort | Owner |
|---|--------|------|--------|-------|
| 1 | Fix the fee contradiction: 25%→15% in docs/pilot/runbook.md and both outreach letters; regenerate site | contract, moat, onboarding | 1h | C (F confirms 15%) |
| 2 | Fix the broken quickstart: install step in README + site hero, `engines` field, dependency-free `start.mjs` launcher | onboarding | 2–4h | C |
| 3 | Rewrite or delete docs/QUICKSTART.md (documents a retired product) | onboarding | 1h | C |
| 4 | Document "recompute the invoice yourself" in README with the real hyphenated spool filename; proxy prints the exact command after first ledger write | onboarding | 2h | C |
| 5 | Comparison-page refresh: Helicone maintenance mode, RouterArena re-anchor with checked-on date, per-provider cache-ceiling re-derivation, Langfuse v4 "where we lose" note — all from primary sources | moat | 0.5–1d | C |
| 6 | Correct the no-phone-home claim (FAQ + llms.txt + README) and add the CI fetch-allowlist test; document telemetry.ts payload schema (or delete it, per founder) | telemetry | 0.5d | C+F |
| 7 | Measure proxy overhead: `evals/run-proxy-overhead.ts`, p50/p95/p99 at 1/10/50 concurrency, pinned hardware + reproduce command | reliability | 1d | C |
| 8 | `/healthz` endpoint + docs/pilot/RELIABILITY.md (failure modes, 30-second rollback, supervisor config, multi-instance rule) | reliability | 0.5d | C |
| 9 | Backpressure fix: honor `res.write` return with drain await | reliability | 0.5d | C |
| 10 | Ledger durability pack: tail-read resume that *recovers* from one unterminated final line, loud disable elsewhere, daily rotation, instance-ID filenames + never-share-a-file test | reliability | 2–3d | C |
| 11 | GitHub traffic archiver workflow (data is being lost every 14 days, right now) | telemetry | 0.5d | C+F (PAT secret) |
| 12 | Cookieless site analytics snippet + FAQ disclosure | telemetry | 1h | C+F (account) |
| 13 | **Form the legal entity; re-issue LICENSE under it** (gates all signatures; liability is personal until done) | contract | days–weeks | **F** |
| 14 | One-paragraph production-use grant text (email-ready) to unblock a willing pilot immediately | contract | 1h | C drafts, **F sends** |
| 15 | **npm publish @harrym1707/sdk** (check scope availability + the npx-squatting claim first; enable 2FA) | onboarding, telemetry, moat | 1d | C prepares, **F publishes** |
| 16 | CLI subcommand dispatcher (none exists — documented `mesh analyse` would throw), then register analyse/report/invoice | spend, billing | 0.5d | C |
| 17 | `mesh invoice` (customer-side): reuse existing feePercent/amountDueCents/do_not_charge, assert meter-row reconciliation, emit evidence bundle | billing | 1d | C |
| 18 | `mesh report`: `aggregateLedgerSeries` in core (export hourWindowOf), single-file HTML with measured-vs-estimated visually split, chain-head footer, to-the-cent reconciliation test | spend | 2–3d | C |
| 19 | Idempotency lock-test: doubled/shuffled spool → byte-identical meter JSONL + identical invoice total | billing | 0.5d | C |
| 20 | Negative-window policy written into the honesty rules (never dropped; netted as invoice credit) | billing | 1h | C |
| 21 | Pilot billing agreement template (15%, monthly, recomputation right, reverse-charge VAT wording) | billing | 0.5d | C drafts, **F signs** |
| 22 | Draft Exhibit A (Measurement & Verification) from savings-ledger.ts semantics, with the mechanical dispute rule | contract | 1d | C |
| 23 | Common Paper chassis markup (Pilot vs Design Partner standard) + BUSL pilot rider + Exhibit B data-handling representations | contract | 1–2d | C drafts, **F + lawyer** |
| 24 | **Engage flat-fee lawyer** (~$1.5–5k) for the contract pack + GDPR-processor position | contract | — | **F** |
| 25 | 5m-stamp fix by *observed* cross-request volatility (export BREAKER_PATTERNS from token-reduction.ts; stamp stable sub-prefix when ≥1,024 tokens) + regression test | loop | 1–2d | C |
| 26 | Ledger tripwire: pure function flagging any lever with negative netted savings over a trailing window; surface in invoice report | loop | 1–2d | C |
| 27 | nightly.yml: schedule the existing run-analysis-regression.ts + three harnesses with `--json`, fail on baseline deviation | loop | 0.5–1d | C |
| 28 | Trend dashboard via committed JSON history rendered through build-site.ts (NOT gh-pages — would break the site); label all numbers seeded-fixture | loop | 1–2d | C |
| 29 | Price-freshness gate at publish points (build-site + geo-audit job), warn-only in CI; weekly LiteLLM drift alarm opening an issue | loop | 1d | C |
| 30 | `pnpm demo` zero-key path: mock upstream → ledger → recomputed invoice in <5 min; separate mesh-ledger-demo/ dir, DEMO stamped in output | onboarding | 1–2d | C (F approves labeling) |
| 31 | **Create Stripe account** + enable Bacs/ACH; bill the first pilot via hosted invoice against the evidence bundle | billing | — | **F** |
| 32 | packages/billing-stripe design doc: MESH-side transmitter, non-negative transmission, credit-note reconciliation | billing | 1d | C |
| 33 | OpenRouter export reader for mesh-quote + "migrating off Helicone" runbook section | moat | 0.5–1d | C (F approves angle) |
| 34 | Open verification spec draft (ledger schema, recompute semantics, sink invariants) with repo-truthful audit command; GEO surfaces | moat | 2d | C (F picks spec license) |
| 35 | Weekly adoption rollup script (one line: views, clones, stars, downloads, pilot issues) | telemetry | 0.5d | C |
| 36 | Design the customer-side replay spool format; build the continuous gate **when a design partner signs** | loop | 3–5d, gated | C (F recruits partner) |
| 37 | **Recruit and sign one design partner**; monitor £90k VAT threshold; keep repo active so cron workflows stay enabled | contract, billing, loop | ongoing | **F** |

---

## 4. Appendix A — what to explicitly NOT do

- Don't chase routers on headline percentage (model substitution is the self-graded quality trade the replay gate exists to expose).
- Don't build real-time dashboards (crowded, free, not the moat — emit ledger metrics into Langfuse/LiteLLM instead if asked).
- Don't build a hosted ingestion dashboard until a customer explicitly requests it (burns the local-first differentiation).
- Don't add any in-product telemetry ping; if ever added, opt-in with a published schema — stricter than Homebrew/Next.js, because honesty is the product.
- Don't adopt a usage-billing platform (Metronome/Orb/Lago) before a contract needs commits or ramps.
- Don't build full HA proxy mode before a pilot's traffic demands it (backpressure fix + cap makes it deferrable).

## 5. Appendix B — what the challengers killed

Every researcher finding was independently challenged. All eight verdicts **held**, but the challengers caught the following errors before they could ship — the honesty filter working:

**Billing (6):** cli main.ts isn't literally "zero matches" for billing (a --date flag exists); the plan reinvented fee math core already has (feePercent, amountDueCents, do_not_charge at savings-ledger.ts ~397/438–441); the data flow was ambiguous about *who runs the invoice on what data* (fixed: customer-side command, bundle export); "Metronome is Stripe-owned" is false; Stripe's "$2 cap on the 0.4% invoicing fee" unverified; the VAT analysis silently assumed both pilots are overseas.

**Spend tracking (5):** no CLI subcommand dispatcher exists — the documented `mesh analyse` would throw; `hourWindowOf` is private and can't be "reused" as written; competitor claims were sourced to third-party blogs (publishing them would break the honesty rules); the headline chart would have rendered estimates indistinguishably from measurements; the footer "fingerprint" was the wrong artifact (traffic fingerprint ≠ ledger chain head).

**Adoption telemetry (5, one honesty-critical):** "no product code phones home" is **false** — telemetry.ts ships a configurable fetch()-POST of request metadata; the proposed marketing claim would have been false the day it shipped; run-geo-audit.ts already exists (extend, don't create); the "npx mesh-proxy squatting" claim was relayed unverified; (everything else repo-verified correct).

**Improvement loop (7, two factual):** there is **no gh-pages branch** — the benchmark-dashboard plan as written would be invisible or would take down mesh-technology.com; the volatile-token detectors are in token-reduction.ts (unexported), not cache-simulator.ts; the regex-based 5m-stamp fix would create the *opposite* money-loser on stable mid-prompt dates; run-analysis-regression.ts already exists (don't rebuild it); blanket CI failure on stale prices blocks unrelated builds (gate publication instead); benchmark-action effort optimistic; plus one encoded caution — never blend fixture numbers with live verified figures.

**Onboarding (4):** the proposed preflight error in run-proxy.ts is impossible (`--import tsx` fails before user code runs); the x-api-key misrouting risk was overstated (GET passthrough only); the documented spool filename used the wrong separator (dot vs the real hyphen); minor line-number miss on the site snippet.

**Pilot contract (0 violations; 4 sharpenings):** the license blocker is softer (Harry is the Licensor — an email grant unblocks today); entity formation is the true gating item, sequence it first; "customer recomputation presumptively correct" contradicted the determinism claim (replaced with a mechanical rule); use Common Paper's free NDA and consider their Design Partner standard; budget legal review to $5k.

**Reliability (0 violations; 3 sharpenings):** pull the ~10-line backpressure fix out of deferred HA; the ledger fix must *recover* from a crash-torn final line, not just alert (loud-disable alone bricks the revenue record); published overhead numbers must pin hardware + version + reproduce command.

**Competitive moat (5):** the outreach letters still say 25% (missed by the researcher while recommending outreach); the "leaving Helicone" draft already exists (option was ~2x overcosted); "provider caching uniformly shrinks MESH's addressable waste" is backwards for Anthropic (live export 2: zero implicit cache reads; MESH's stamp measured 37.6% cache-only — cheaper hits *widen* MESH's value); catalogue updates must never come from the cited blogs; the "one-line audit" headline is gated on npm publish.
