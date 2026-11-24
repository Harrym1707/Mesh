# Draft outreach 2 — Helicone user re-evaluating their stack

**STATUS: DRAFT. Not sent. Sending is the founder's act.**
Audience: a team that adopted Helicone for LLM observability/cost tracking and
is deciding what to do next. **VERIFY BEFORE SENDING:** the "maintenance mode"
framing must be re-confirmed against Helicone's repo/announcements on the day
of sending; if it cannot be confirmed, use the alternate opening below.
Personalise the [bracketed] fields.

Savings figures refreshed 2026-11-16 to [docs/NUMBERS.md](../NUMBERS.md) (last
reconciled 2026-10-27). Re-check them against that file on the day of sending.
On 2026-11-23 each figure was labelled with the levers it needed: none is
what a fresh install gives, and no default-install percentage exists to quote.
The letter is for a team running its own agents on the API.

---

**Subject:** Your Helicone request data is still worth something

Hi [name],

With Helicone in maintenance mode, teams I've spoken to are deciding whether to
migrate observability — but the request logs you already have answer a more
useful question first: *what does your traffic actually look like, and is
anything in it left to reduce?*

I built a local CLI that reads a Helicone request export (your file, your
machine, no upload) and produces a triage: each traffic stream classified by
shape, an estimated band per stream labelled with the measurement it is
drawn from, your existing cache savings credited
to you and excluded, unpriced models flagged rather than zeroed — and an
explicit "do not pay us" verdict when your traffic is already well-optimised.
It's an estimate derived from your own logs, not a benchmark slide and not a
measurement of your bill.

Two things the quote is **not**: it is not a gateway (it reads a file you
already have, and nothing is added to your request path to get it), and it is
not a migration pitch (the quote is useful whatever you do about
observability). Trying Mesh itself afterwards is a separate decision; that
part runs as a small proxy on your own machine. By default it does two
things: it keeps your prompts cacheable, and it writes a ledger of every
request that you can recompute yourself. I can't tell you it will lower your
provider bill: nobody has measured it against a real bill yet.

Calibration, our own numbers as of 27 October 2026. None of them is what
a fresh install gives: out of the box Mesh makes three lossless changes (it
compacts tool schemas, removes exact duplicate context and repairs the order
of a cacheable prefix), and each figure below needed more switched on. On
real API traffic we have one measured figure: 18.2% **(LIVE)**, the net
saving on a mixed 30-request basket of our own test agents, run on 26 October
2026 with the Anthropic cache stamp and a tool-result cap switched on, both
of which are off in a fresh install; the three default changes account for
under half of it. The rest is modelled on a simulator and not yet proven on
anyone's real bill: busy interactive agents 25.9–29.4% **(SIMULATOR; with
tool-description trimming, history compaction, an output cap and a
tool-result cap on)**, one-shot templated workloads 45.5% **(SIMULATOR; with
description trimming, history compaction and an output cap on)**,
latency-tolerant workloads on discounted execution tiers 57.7% net
**(SIMULATOR; the interactive levers plus a discounted execution tier,
OpenAI-priced, assumes some requests fall back to the standard tier)**. The
command behind each figure is at
https://github.com/Harrym1707/Mesh/blob/main/docs/NUMBERS.md. Not
promises — your export produces your number, with every caveat printed in the
report.

If you'd run it on one export and tell me where it's wrong, that is the most
useful thing you could do for it. Five minutes, one JSON file out, full
methodology shared. You don't need anything from me first: Mesh is open to
everyone, with no signup and no waiting list, and you can install it today
(https://www.mesh-technology.com/start.html). If you would rather have a hand, I
can run it with you as a hands-on pilot: an agreed measuring window, help
with setup and an invoice you can check yourself.

[sign-off]

P.S. Business model, stated up front. No fee is due unless we have agreed
billing with you in writing. Where we have, the fee is 1% of verified savings
for the month, rounded down to the cent, and nothing else. It is computed
from a ledger on your machine that you can recompute yourself, and if the
verdict for a month is `do_not_charge` you owe nothing for that month. The
quote is free and stays on your machine regardless.

---

## Alternate opening (if maintenance-mode framing is not confirmable)

> Teams that invested in Helicone have months of request logs sitting in
> exports — and those logs answer a question observability dashboards don't:
> what the traffic looks like stream by stream, and whether anything in it is
> left to reduce?

## Claim audit (internal, do not send)

| Claim in letter | Label | Source |
|---|---|---|
| Helicone "maintenance mode" | **UNVERIFIED in repo** — carried from sprint brief; re-verify on send day or use alternate opening | sprint-chain brief 2026-10-13 |
| 18.2% on a mixed 30-request basket, with the cache stamp and a tool-result cap on | LIVE, run 2026-10-26, NOT a fresh install | docs/NUMBERS.md, LIVE table: `MESH_LIVE_KEEP=1 evals/run-live-agents.ts`, claude-sonnet-5-5, spools in `evals/live-exports-2026-10-26/`. MESH's own test basket, not a customer's traffic. That run had levers on that a fresh install leaves off: the Anthropic cache stamp (`cache-ttl-5m`) and a gate-approved tool-result cap (`fresh-tool-result-cap`). Summing the `levers` rows of those spools on 2026-11-23: the tool-result cap and the cache stamp together earned more than the default levers did (schema compaction and duplicate removal; prefix repair earned nothing), so the defaults are under half of the saving. No default-install percentage is in docs/NUMBERS.md, so none is stated |
| 25.9–29.4% busy interactive agents, with description trimming, history compaction, an output cap and a tool-result cap on | SIMULATOR, NOT a fresh install | docs/NUMBERS.md, SIMULATOR table: arm J, `4e51734` (commit of 2026-10-13). Lever set as arm J is defined in `evals/run-agent-ab.ts` on `main`; all four are off in a fresh install |
| 45.5% one-shot templated, with description trimming, history compaction and an output cap on | SIMULATOR, NOT a fresh install | docs/NUMBERS.md, SIMULATOR table: arm H of arms H/I, `7b08666` (commit of 2026-10-12). The other arm, 72.8%, adds a discounted execution tier to the same levers and is left out of the letter |
| 57.7% net async, with the interactive levers plus a discounted execution tier on | SIMULATOR, NOT a fresh install | docs/NUMBERS.md, SIMULATOR table: arm K, `4e51734` (commit of 2026-10-13), served-tier priced. Net of assumed fallback rates; the 64.3% ceiling, from the same levers, is never quoted on its own. OpenAI-priced |
| The quote is "not a gateway"; MESH itself is a local proxy | code | `mesh-quote` reads an export file (`packages/core/src/quote-report.ts`); the pilot path is `mesh start` / `mesh proxy` ([onboarding.md](./onboarding.md)) |
| "open to everyone, no signup, no waiting list", install today | site | `docs/site/start.md` and `docs/site/faq.md` on `main`; the link is the built start page |
| "hands-on pilots: measuring window, help with setup, an invoice you can check" | plan | [PILOT_PLAN.md](./PILOT_PLAN.md). Optional; no number of places is stated in the letter |
| "no upload, your machine" | code-enforced | quote-report.ts + packaged local bin, no network path |
| Helicone export parsing works | implemented, fixture-tested | packages/core/src/helicone.ts; gateway-triage gate 9/9 |
| The fee sentences in the P.S. | site, word for word | `docs/site/terms.md`, Fees (last updated 18 November 2026): "No fee is due unless we have agreed billing with you in writing", "the fee is 1% of verified savings for the month, rounded down to the cent, and nothing else", "If the verdict for a month is `do_not_charge`, you owe nothing for that month" |
| "keeps your prompts cacheable, and writes a ledger you can recompute"; no promise of a lower bill | code, and a limit stated | The default levers (`packages/sdk-js/src/theo-policy.ts`) include cache-prefix repair; the ledger is recomputed by `mesh verify` and `mesh statement`. No measurement of MESH against a real provider bill exists, so the letter says so and promises none |
| Not said in the letter, and not needed at first contact | site | A customer who agrees billing registers their install's statement key (`mesh statement --key`, MESH 0.2.5 or later) and is billed only from statements it signed: `docs/site/pricing.md`, [order-form.md](./order-form.md). Nobody needs a key to install, test or get a quote |
| 34.3% sparse interactive, with the interactive levers plus a 1-hour cache stamp on | omitted deliberately | SIMULATOR, not a fresh install (docs/NUMBERS.md, arm L, `6f08b72`) |
