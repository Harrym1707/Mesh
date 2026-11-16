# MESH pilot kit

Everything a design-partner conversation needs, in one directory. **All of it is
draft material: nothing here has been posted or sent, and sending is the
founder's act, not an agent's.** No partner has been approached, and MESH has
not yet run on a customer's real traffic.

Updated 2026-11-16 for MESH 0.2.1 and its one setup path: install from the
website, then `mesh start` (Claude Code) or `mesh proxy` (any other app), with
the ledger in `~/.mesh/ledger/`.

| File | What it is |
|---|---|
| [TESTER-GUIDE.md](./TESTER-GUIDE.md) | What to hand a tester: install, connect Claude Code or their own app, check it works, what to expect, what to send back, how to remove it. Written 2026-11-16 for MESH 0.2.1. |
| [onboarding.md](./onboarding.md) | **Start here.** What a design partner does on the one setup path, what to agree at kickoff, where the ledger is, and the no-install alternative. Points to the tester guide for the steps. |
| [runbook.md](./runbook.md) | The one-page partner runbook (day 0 → day 14) **and** the step-by-step [Operator playbook](./runbook.md#operator-playbook--manual-billing) for drafting an invoice by hand in Stripe test mode. |
| [PILOT_PLAN.md](./PILOT_PLAN.md) | The pilot plan: target customer, cohort size (3–5), success metric, timeline (about four weeks, 14 days of it measuring), and what we measure. |
| [pilot-agreement.md](./pilot-agreement.md) | Draft lightweight pilot agreement + onboarding email (keys never held, data kept and where, fee basis, no charge if no savings). Not sent and not reviewed by a lawyer. |
| [VERIFICATION.md](./VERIFICATION.md) | A dated record: the happy-path checks run on 2026-11-07 against the build of that day, kept as written, plus the checks run on 2026-11-16 for this refresh. |
| [data-handling.md](./data-handling.md) | The data-handling answer, verbatim-usable, sourced to the code paths it describes. |
| [outreach-litellm.md](./outreach-litellm.md) | Draft letter 1: LiteLLM proxy operator (spend logs ready to triage). Written 2026-10-13; see the note below. |
| [outreach-helicone.md](./outreach-helicone.md) | Draft letter 2: Helicone user re-evaluating their stack. Written 2026-10-13; see the note below. |
| [engagement-list.md](./engagement-list.md) | Where the conversation already exists: the named LiteLLM threads, verified 2026-10-13, with draft responses. See the note below. |

## Number discipline

[docs/NUMBERS.md](../NUMBERS.md) is the single source of truth for savings
figures (last reconciled 2026-10-27). Every figure in this directory must be
in that file, match it exactly, and carry its label:

- **LIVE** — measured on real API traffic, real money. So far this is MESH's
  own test basket, not a customer's traffic.
- **SIMULATOR** — modelled on a harness and labelled as such; not yet proven on
  anyone's real bill.

If a number is not in `docs/NUMBERS.md`, it is not a MESH number and is not
stated.

The standing caveat on *every* number: **MESH has processed zero real customer
traffic.** The first real partner's ledger retires that caveat, which is what
the pilot is for.

## What to quote (from docs/NUMBERS.md, reconciled 2026-10-27)

| Figure | Label | What it measures |
|---|---|---|
| **18.2%** | LIVE, run 2026-10-26 | Net saving on a mixed 30-request basket (coding, rag, support, batch, lean), claude-sonnet-5-5. The current headline live number |
| 25–73% | SIMULATOR | What the simulator models suggest depending on workload; not proven on a real bill |

Always lead with the LIVE 18.2% and label the rest SIMULATOR. The per-workload
SIMULATOR rows, with the command and commit behind each, are in
[docs/NUMBERS.md](../NUMBERS.md); quote them from there, not from memory, and
never without the label. A partner's own number comes from their own ledger
and replaces all of these.

## Older figures in the outreach drafts

`outreach-litellm.md`, `outreach-helicone.md` and `engagement-list.md` were
written on 2026-10-13, before `docs/NUMBERS.md` was reconciled, and have not
been updated. They still label harness figures "measured" and carry figures
that have since moved. Check every figure in them against `docs/NUMBERS.md`
before any of them is used.
