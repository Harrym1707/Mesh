# Draft outreach 2 — Helicone user re-evaluating their stack

**STATUS: DRAFT. Not sent. Sending is the founder's act.**
Audience: a team that adopted Helicone for LLM observability/cost tracking and
is deciding what to do next. **VERIFY BEFORE SENDING:** the "maintenance mode"
framing must be re-confirmed against Helicone's repo/announcements on the day
of sending; if it cannot be confirmed, use the alternate opening below.
Personalise the [bracketed] fields.

Savings figures refreshed 2026-11-16 to [docs/NUMBERS.md](../NUMBERS.md) (last
reconciled 2026-10-27). Re-check them against that file on the day of sending.

---

**Subject:** Your Helicone request data is still worth something

Hi [name],

With Helicone in maintenance mode, teams I've spoken to are deciding whether to
migrate observability — but the request logs you already have answer a more
valuable question first: *how much of your LLM bill is actually reducible?*

I built a local CLI that reads a Helicone request export (your file, your
machine, no upload) and produces a triage: each traffic stream classified by
shape, an honest savings band per stream, your existing cache savings credited
to you and excluded, unpriced models flagged rather than zeroed — and an
explicit "do not pay us" verdict when your traffic is already well-optimised.
It's a quote derived from your traffic, not a benchmark slide.

Two things the quote is **not**: it is not a gateway (it reads a file you
already have, and nothing is added to your request path to get it), and it is
not a migration pitch (the quote is useful whatever you do about
observability). Trying MESH itself afterwards is a separate decision; that
part runs as a small proxy on your own machine.

Calibration, our own numbers as of 27 October 2026. On real API traffic we
have one measured figure: 18.2% **(LIVE)**, the net saving on a mixed
30-request basket of our own test agents, run on 26 October 2026. The rest is
modelled on a simulator and not yet proven on anyone's real bill: busy
interactive agents 25.9–29.4% **(SIMULATOR)**, one-shot templated workloads
45.5% **(SIMULATOR)**, latency-tolerant workloads on discounted execution
tiers 57.7% net **(SIMULATOR, OpenAI-priced, assumes some requests fall back
to the standard tier)**. The command behind each figure is at
https://github.com/Harrym1707/Mesh/blob/main/docs/NUMBERS.md. Not
promises — your export produces your number, with every caveat printed in the
report.

If you'd run it on one export and tell me where it's wrong, you'd be one of the
3–5 design partners I'm looking for. Five minutes, one JSON file out, full
methodology shared.

[sign-off]

P.S. Business model, stated up front: 1% of verified savings only — measured
from provider-reported usage into an append-only ledger whose invoice you can
recompute to the cent yourself, $0 when verified savings are $0. The quote is
free and stays on your machine regardless.

---

## Alternate opening (if maintenance-mode framing is not confirmable)

> Teams that invested in Helicone have months of request logs sitting in
> exports — and those logs answer a question observability dashboards don't:
> how much of the bill is actually reducible, stream by stream?

## Claim audit (internal, do not send)

| Claim in letter | Label | Source |
|---|---|---|
| Helicone "maintenance mode" | **UNVERIFIED in repo** — carried from sprint brief; re-verify on send day or use alternate opening | sprint-chain brief 2026-10-13 |
| 18.2% on a mixed 30-request basket | LIVE, run 2026-10-26 | docs/NUMBERS.md, LIVE table: `MESH_LIVE_KEEP=1 evals/run-live-agents.ts`, claude-sonnet-5-5, spools in `evals/live-exports-2026-10-26/`. MESH's own test basket, not a customer's traffic |
| 25.9–29.4% busy interactive agents | SIMULATOR | docs/NUMBERS.md, SIMULATOR table: arm J, `4e51734` (commit of 2026-10-13) |
| 45.5% one-shot templated | SIMULATOR | docs/NUMBERS.md, SIMULATOR table: arm H of arms H/I, `7b08666` (commit of 2026-10-12). The other arm, 72.8%, is left out of the letter |
| 57.7% net async | SIMULATOR | docs/NUMBERS.md, SIMULATOR table: arm K, `4e51734` (commit of 2026-10-13), served-tier priced. Net of assumed fallback rates; the 64.3% ceiling is never quoted on its own. OpenAI-priced |
| The quote is "not a gateway"; MESH itself is a local proxy | code | `mesh-quote` reads an export file (`packages/core/src/quote-report.ts`); the pilot path is `mesh start` / `mesh proxy` ([onboarding.md](./onboarding.md)) |
| "3–5 design partners" | plan | [PILOT_PLAN.md](./PILOT_PLAN.md), Cohort |
| "no upload, your machine" | code-enforced | quote-report.ts + packaged local bin, no network path |
| Helicone export parsing works | implemented, fixture-tested | packages/core/src/helicone.ts; gateway-triage gate 9/9 |
| 1% of verified savings / $0 verdict | implemented | savings-ledger.ts recomputeInvoice, do_not_charge verdict |
| 34.3% sparse interactive, 1h TTL | omitted deliberately | SIMULATOR (docs/NUMBERS.md, arm L, `6f08b72`) |
