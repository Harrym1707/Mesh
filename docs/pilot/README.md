# MESH pilot kit

Everything a pilot conversation needs, in one directory.

**Who it is for.** Teams that run their own agents on the API: coding,
browsing, support, RAG and multi-agent systems that call Anthropic or OpenAI
constantly. Someone who only uses Claude Code should expect little from a
fresh install; the path is supported, but the kit is not aimed at them.

**MESH is open to everyone:** no signup, no account, no waiting list. Anyone
can install and use it today without asking anyone
([Get started](../site/start.md)). **A pilot is optional.** It is for a team
that wants an agreed measuring window, hands-on help and an invoice checked
by hand. It is not a condition of using MESH, and nothing in this directory
is needed in order to use it.

**All of it is draft material: nothing here has been posted or sent, and
sending is the founder's act, not an agent's.** No partner has been
approached, and MESH has not yet run on a customer's real traffic.

The price is the one on the website's
[Pricing and billing](../site/pricing.md) page: 1% of verified savings,
monthly, rounded down to the cent, nothing else. This kit describes how that is measured and invoiced by hand inside a
pilot. For a customer who wants to pay outside a pilot there is a draft
[order form](./order-form.md); it is unreviewed, and the decisions it leaves
open are listed at its end.

Written for the one setup path that MESH 0.2.1 introduced on 2026-11-16. The
current release, 0.2.5 (read 2026-11-23), keeps it: install from the
website, then `mesh start` (Claude Code) or `mesh proxy` (any other app), with
the ledger in `~/.mesh/ledger/`.

| File | What it is |
|---|---|
| [TESTER-GUIDE.md](./TESTER-GUIDE.md) | The setup guide for anyone running MESH on their own traffic, in a pilot or not: install, connect Claude Code or their own app, check it works, what to expect, what to send back, how to remove it. Written 2026-11-16; checked against MESH 0.2.5 on 2026-11-23. |
| [onboarding.md](./onboarding.md) | **Start here.** What a team in a pilot does on the one setup path (the same path as everyone else), what to agree at kickoff, where the ledger is, and the no-install alternative. Points to the tester guide for the steps. |
| [runbook.md](./runbook.md) | The one-page partner runbook (day 0 → day 14) **and** the step-by-step [Operator playbook](./runbook.md#operator-playbook--manual-billing) for drafting an invoice by hand in Stripe test mode. |
| [PILOT_PLAN.md](./PILOT_PLAN.md) | The pilot plan: who a pilot suits, how many are run by hand at once (3–5), success metric, timeline (about four weeks, 14 days of it measuring), and what we measure. |
| [pilot-agreement.md](./pilot-agreement.md) | Draft lightweight pilot agreement + onboarding email (keys never held, data kept and where, fee basis, no charge if no savings). Covers a pilot only; nobody needs it to use MESH. Not sent and not reviewed by a lawyer. |
| [order-form.md](./order-form.md) | Draft order form for a paying customer, in or out of a pilot: parties, the fee and when nothing is due, the billing period, what is measured, the right to recompute, the statement key the customer registers, what is sent, invoices, term. Incorporates the website Terms. **For the founder and a solicitor: not legal advice, not reviewed, not to be sent.** Blanks, not values, wherever a decision is still open. |
| [VERIFICATION.md](./VERIFICATION.md) | A dated record: the happy-path checks run on 2026-11-07 against the build of that day, kept as written, plus the checks run on 2026-11-16, on the installed 0.2.3 on 2026-11-18, on the installed 0.2.4 on 2026-11-19, and on the installed 0.2.5 (the statement key) on 2026-11-23. |
| [data-handling.md](./data-handling.md) | The data-handling answer, verbatim-usable, sourced to the code paths it describes. |
| [outreach-litellm.md](./outreach-litellm.md) | Draft letter 1: LiteLLM proxy operator (spend logs ready to triage). Written 2026-10-13; savings figures refreshed 2026-11-16. |
| [outreach-helicone.md](./outreach-helicone.md) | Draft letter 2: Helicone user re-evaluating their stack. Written 2026-10-13; savings figures refreshed 2026-11-16. |
| [outreach-cost-aware-team.md](./outreach-cost-aware-team.md) | Draft letter 3: a first note to a team that has published its own LLM cost or caching work. Written 2026-11-19. Names no organisation. |
| [engagement-list.md](./engagement-list.md) | Where the conversation already exists: the named LiteLLM threads, verified 2026-10-13, with draft responses. Savings figures refreshed 2026-11-16. |

## Number discipline

[docs/NUMBERS.md](../NUMBERS.md) is the single source of truth for savings
figures (last reconciled 2026-10-27). Every figure in this directory must be
in that file, match it exactly, and carry its label:

- **LIVE** — measured on real API traffic, real money. So far this is MESH's
  own test basket, not a customer's traffic.
- **SIMULATOR** — modelled on a harness and labelled as such; not yet proven on
  anyone's real bill.

**And every figure says, in the same sentence, whether it is out of the box
or which levers it needed.** A fresh install applies three lossless levers
only: tool-schema compaction, duplicate-context removal and cache-prefix
repair. Every published figure was produced with more than that switched on.
There is no default-install percentage in `docs/NUMBERS.md`, so none is
stated anywhere in this kit; until there is one, the only thing that may be
said about a fresh install is that its three changes account for under half
of the LIVE figure.

If a number is not in `docs/NUMBERS.md`, it is not a MESH number and is not
stated.

The standing caveat on *every* number: **MESH has processed zero real customer
traffic.** The first real partner's ledger retires that caveat, which is what
the pilot is for.

## What to quote (from docs/NUMBERS.md, reconciled 2026-10-27)

| Figure | Label | What it measures |
|---|---|---|
| **18.2%** | LIVE, run 2026-10-26, not out of the box | Net saving on a mixed 30-request basket (coding, rag, support, batch, lean), claude-sonnet-5-5, with the Anthropic cache stamp and a gate-approved tool-result cap switched on, both off in a fresh install. The three default levers account for under half of it |
| 25–73% | SIMULATOR, not out of the box | What the simulator models suggest depending on workload, each with further levers switched on (tool-description trimming, history compaction, output and tool-result caps, and for the top of the range a discounted execution tier); not proven on a real bill |

Always lead with the LIVE 18.2%, say it was measured with the cache stamp
and a tool-result cap on, and label the rest SIMULATOR with its levers. The
per-workload SIMULATOR rows, with the command and commit behind each, are in
[docs/NUMBERS.md](../NUMBERS.md); quote them from there, not from memory, and
never without the label and the levers. A partner's own number comes from
their own ledger and replaces all of these.

The levers behind each row, as the simulator arms are defined in
`evals/run-agent-ab.ts` on `main` (read 2026-11-23): the one-shot rows use
description trimming, history compaction and an output cap; the busy
interactive row adds a tool-result cap; the async row adds a discounted
execution tier; the sparse row adds a 1-hour cache stamp. The split of the
LIVE figure by lever is from the `levers` rows in
`evals/live-exports-2026-10-26/`, summed on 2026-11-23: the tool-result cap
and the cache stamp together earned more than the default levers did, which
is all "under half" claims. The split is not in `docs/NUMBERS.md`, so no
figure for it is quoted here.

## The outreach drafts

Three letters, all drafts, none sent. Which to use:

- **[outreach-litellm.md](./outreach-litellm.md)** for a team running the
  LiteLLM proxy with spend logs: it leads with reconciling those logs.
- **[outreach-helicone.md](./outreach-helicone.md)** for a team with Helicone
  request exports: it leads with a quote from one export.
- **[outreach-cost-aware-team.md](./outreach-cost-aware-team.md)** for a team
  that has published its own cost or caching work and where neither gateway
  is known to be in use: it leads with the ledger and expects a small number
  or none. Written 2026-11-19, with its own "before sending" list.

`outreach-litellm.md`, `outreach-helicone.md` and `engagement-list.md` were
written on 2026-10-13. Their MESH savings figures were refreshed to
`docs/NUMBERS.md` on 2026-11-16, and on 2026-11-23 each figure was labelled
with the levers it needed: each letter leads with the LIVE 18.2%, says it was
measured with the cache stamp and a tool-result cap on, labels the rest
SIMULATOR with its levers, and has a claim audit that names the row in
`docs/NUMBERS.md` behind every figure. Two things in them were **not**
re-checked on 2026-11-16 and must be before anything is sent:

- the figures quoted from the public LiteLLM issue threads (last verified
  2026-10-13);
- the Helicone "maintenance mode" premise, which has never been verified.
