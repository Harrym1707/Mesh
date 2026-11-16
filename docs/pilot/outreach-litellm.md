# Draft outreach 1 — LiteLLM proxy operator

**STATUS: DRAFT. Not sent. Sending is the founder's act.**
Audience: a team running the LiteLLM proxy in production, with `/spend/logs`
accumulating. Diagnostic-first; pricing appears only as a postscript.
Personalise the [bracketed] fields before sending.

Savings figures refreshed 2026-11-16 to [docs/NUMBERS.md](../NUMBERS.md) (last
reconciled 2026-10-27). Re-check them against that file on the day of sending.

---

**Subject:** Does your LiteLLM spend log match your provider invoice?

Hi [name],

If you reconcile LiteLLM's spend numbers against your OpenAI or Anthropic
invoice, you have probably seen them drift — cache-read and cache-write tokens
are the usual culprits (e.g. LiteLLM issues #19681, #33772, #34801, where
operators measured proxy-reported spend off by 8.5% to 10x on cache-heavy
traffic before fixes landed).

I built a small tool that takes one `/spend/logs` export and, locally on your
machine (no network calls, nothing uploaded), produces:

- a reconciliation of the log's reported costs against a dated, sourced price
  catalogue — models it can't price are reported as unpriced, never zeroed;
- a per-stream triage of where LLM spend reduction is actually available on
  *your* traffic — and where it isn't: savings your gateway cache or the
  provider's prompt cache already give you are credited to you and explicitly
  excluded;
- when the honest answer is "there's nothing here worth paying anyone for," the
  report says exactly that.

For calibration, our own numbers as of 27 October 2026. On real API traffic
we have one measured figure: 18.2% **(LIVE)**, the net saving on a mixed
30-request basket of our own test agents, run on 26 October 2026. Everything
else is modelled on a simulator and not yet proven on anyone's real bill: busy
interactive agents 25.9–29.4% **(SIMULATOR)**, one-shot templated workloads
45.5% **(SIMULATOR)**, latency-tolerant work sent to discounted flex/batch
tiers 57.7% net **(SIMULATOR, OpenAI-priced, assumes some requests fall back
to the standard tier)**. The command behind each figure is at
https://github.com/Harrym1707/Mesh/blob/main/docs/NUMBERS.md. None of
these is a promise about your traffic — the entire point of the tool is that
your number comes from your logs, caveats included.

Would you be open to running it on one export? It's a single Node binary, takes
about five minutes, and the output is a JSON report you keep. You don't need
anything from me to do it: MESH is open to everyone, with no signup and no
waiting list, and you can install it today (https://www.mesh-technology.com/start.html).
If you would rather have a hand, I can run it with you as a hands-on pilot:
an agreed measuring window, help with setup and an invoice you can check
yourself. Real
traffic is what will confirm (or kill) these simulator figures, and I'll share
the full methodology either way.

[sign-off]

P.S. The business model, for transparency: if a pilot goes ahead, MESH bills
1% of *verified* savings — measured per completed task from provider-reported
usage, recorded in a hash-chained ledger you can recompute yourself, with a
built-in "do_not_charge" verdict when the net is zero or negative. The quote
run is free and local either way.

---

## Claim audit (internal, do not send)

| Claim in letter | Label | Source |
|---|---|---|
| Issues #19681 / #33772 / #34801, 8.5%–10x drift | sourced | github.com/BerriAI/litellm issues, verified 2026-10-13 (all three now closed — phrased as "before fixes landed") |
| 18.2% on a mixed 30-request basket | LIVE, run 2026-10-26 | docs/NUMBERS.md, LIVE table: `MESH_LIVE_KEEP=1 evals/run-live-agents.ts`, claude-sonnet-5-5, spools in `evals/live-exports-2026-10-26/`. MESH's own test basket, not a customer's traffic |
| 25.9–29.4% busy interactive agents | SIMULATOR | docs/NUMBERS.md, SIMULATOR table: arm J, `4e51734` (commit of 2026-10-13) |
| 45.5% one-shot templated | SIMULATOR | docs/NUMBERS.md, SIMULATOR table: arm H of arms H/I, `7b08666` (commit of 2026-10-12). The other arm, 72.8%, is left out of the letter |
| 57.7% net async | SIMULATOR | docs/NUMBERS.md, SIMULATOR table: arm K, `4e51734` (commit of 2026-10-13), served-tier priced. Net of assumed fallback rates; the 64.3% ceiling is never quoted on its own. OpenAI-priced, hence the label in the letter |
| "open to everyone, no signup, no waiting list", install today | site | `docs/site/start.md` and `docs/site/faq.md` on `main`; the link is the built start page |
| "hands-on pilots: measuring window, help with setup, an invoice you can check" | plan | [PILOT_PLAN.md](./PILOT_PLAN.md). Optional; no number of places is stated in the letter |
| "no network calls, nothing uploaded" | code-enforced | quote-report.ts pure function; packaged bin makes no fetch |
| 1% of verified savings, do_not_charge | implemented | savings-ledger.ts recomputeInvoice |
| 34.3% sparse interactive, 1h TTL | **omitted deliberately** | SIMULATOR (docs/NUMBERS.md, arm L, `6f08b72`). Left out of outreach on 2026-10-13 because per-model cacheable minimums were not enforced; that reason was not re-checked on 2026-11-16 |
