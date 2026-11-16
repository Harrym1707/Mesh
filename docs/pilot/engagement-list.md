# Engagement list — where the reconciliation conversation already exists

**STATUS: DRAFTS ONLY. Nothing below has been posted, commented, or sent.
Posting is the founder's act.** Every thread was re-verified by fetch on
2026-10-13; states and figures below are from the threads themselves.

## Why these threads

MESH's wedge claim — "your proxy's spend number and your provider's invoice
disagree, and the drift is cache-token pricing" — is not our assertion. LiteLLM
operators measured it themselves, in public, with numbers. These threads are
the proof-of-pain and the audience list.

## The named threads (github.com/BerriAI/litellm)

### 1. Issue #19681 — "Cost calculation incorrectly charges for cached tokens"
- **Verified 2026-10-13: CLOSED (completed).** Opened 2026-01-24.
- Reporter measured LiteLLM billing $5.09 where the correct cost was $0.46 —
  a ~10.9x overcharge on high-cache-hit traffic; "makes accurate cost
  monitoring impossible" (reporter's words).
- Relevance: the oldest and starkest case that gateway-reported spend is not an
  invoice. MESH's answer: price from a dated, sourced catalogue; cached tokens
  priced at their actual rates; drift reported as reconciliation, not hidden.

### 2. Issue #33772 — "OpenAI cache-write tokens dropped from cost calculation"
- **Verified 2026-10-13: CLOSED (completed).** Opened 2026-07-17.
- Cache-write tokens billed at base input rate (or zero) instead of 1.25x;
  reporter confirmed proxy-reported spend **materially below** OpenAI invoices
  on cache-heavy traffic. Also notes tiered/flex pricing keys missing.
- Relevance: under-counting, the opposite direction of #19681 — the drift is
  structural, not a single bug. MESH's ledger prices the cache-write TTL split
  from provider-verbatim usage, and prices splitless MESH-placed writes at the
  2x premium so any error under-claims.

### 3. Issue #34801 — "gpt-5.6 prompt caching: cache-read tokens under-counted vs OpenAI billed usage (~8.5%)"
- **Verified 2026-10-13: CLOSED.** Opened 2026-07-27.
- Reporter reconciled 40 requests against OpenAI billing: 65,304 cached tokens
  billed by OpenAI vs 49,563 recorded by LiteLLM; ~8.5% spend overstatement.
- Relevance: this reporter did, by hand, exactly what `mesh-quote`'s
  reconciliation section automates. Of the profiles on this list, the one a
  hands-on pilot would suit best.

## Engagement rules (all three threads are closed)

- MESH is open to everyone, so nothing here invites anyone into something
  closed: a reporter can install it without hearing from us. What outreach
  offers is the quote tool and, for a team that wants one, a hands-on pilot.
- **Do not necropost a pitch into a closed issue.** The honest, useful moves:
  1. Reach the reporters directly (GitHub profile → listed contact) with the
     LiteLLM letter ([outreach-litellm.md](./outreach-litellm.md)), referencing
     *their own* thread.
  2. Cite the threads in published content (the reconciliation explainer) as
     third-party evidence — they are public, numbered, and quotable.
  3. If a comment is ever warranted (e.g. a new related issue opens), it must
     be diagnostic-first: offer the reconciliation method, not the product.
- Standing constraints from the honesty rules, with figures from
  [docs/NUMBERS.md](../NUMBERS.md) (last reconciled 2026-10-27; refreshed here
  2026-11-16):
  - Lead with the one LIVE figure, 18.2% (mixed 30-request basket of MESH's
    own test agents, run 2026-10-26). Every other MESH savings figure is
    SIMULATOR and is said to be.
  - 34.3% (SIMULATOR, sparse interactive, 1h TTL) never appears in
    engagement.
  - The async figure is 57.7% net (SIMULATOR), only with the latency-tolerant
    and OpenAI-priced caveats; the 64.3% ceiling is never quoted on its own.
  - The provider cache's own savings are always credited to the operator.
  - No mention of competitor incidents.

## Draft comment (held, unposted — only for a future OPEN reconciliation thread)

> We hit the same class of drift reconciling proxy spend against provider
> invoices. What worked: treat token counts as ground truth from the provider's
> `usage` block, and re-price them against a dated price table rather than
> trusting any logger's `cost` field — then diff the two and report rows the
> table can't price as "unpriced" instead of zero. We open-sourced the shape of
> that reconciliation if useful: [link]. (Happy to share the method regardless
> of tooling.)

## Secondary audience (no named threads yet — research task, not outreach)

- Helicone users: letter drafted ([outreach-helicone.md](./outreach-helicone.md));
  the "maintenance mode" premise is **unverified in this repo** and must be
  confirmed on send day.
- LiteLLM Discord #cost-tracking and r/LLMDevs cost threads: candidates for the
  same diagnostic-first approach; collect specific threads before drafting.
