# Draft outreach 1 — LiteLLM proxy operator

**STATUS: DRAFT. Not sent. Sending is the founder's act.**
Audience: a team running the LiteLLM proxy in production, with `/spend/logs`
accumulating. Diagnostic-first; pricing appears only as a postscript.
Personalise the [bracketed] fields before sending.

Savings figures refreshed 2026-11-16 to [docs/NUMBERS.md](../NUMBERS.md) (last
reconciled 2026-10-27). Re-check them against that file on the day of sending.
On 2026-11-23 each figure was labelled with the levers it needed: none is
what a fresh install gives, and no default-install percentage exists to quote.
The letter is for a team running its own agents on the API.

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
- a per-stream triage of *your* traffic by shape, with an estimate of where
  there may be something left to reduce and where there isn't: savings your
  gateway cache or the provider's prompt cache already give you are credited
  to you and explicitly excluded;
- when the honest answer is "there's nothing here worth paying anyone for," the
  report says exactly that.

Mesh itself is separate from this tool. By default it does two things: it
keeps your prompts cacheable, and it writes a ledger of every request that
you can recompute yourself. I can't tell you it will lower your provider
bill: nobody has measured it against a real bill yet.

For calibration, our own numbers as of 27 October 2026. None of them is
what a fresh install gives: out of the box Mesh makes three lossless changes
(it compacts tool schemas, removes exact duplicate context and repairs the
order of a cacheable prefix), and each figure below needed more switched on.
On real API traffic we have one measured figure: 18.2% **(LIVE)**, the net
saving on a mixed 30-request basket of our own test agents, run on 26 October
2026 with the Anthropic cache stamp and a tool-result cap switched on, both
of which are off in a fresh install; the three default changes account for
under half of it. Everything else is modelled on a simulator and not yet
proven on anyone's real bill: busy interactive agents 25.9–29.4%
**(SIMULATOR; with tool-description trimming, history compaction, an output
cap and a tool-result cap on)**, one-shot templated workloads 45.5%
**(SIMULATOR; with description trimming, history compaction and an output cap
on)**, latency-tolerant work sent to discounted flex/batch tiers 57.7% net
**(SIMULATOR; the interactive levers plus a discounted execution tier,
OpenAI-priced, assumes some requests fall back to the standard tier)**. The
command behind each figure is at
https://github.com/Harrym1707/Mesh/blob/main/docs/NUMBERS.md. None of
these is a promise about your traffic — the entire point of the tool is that
your number comes from your logs, caveats included.

Would you be open to running it on one export? It's a single Node binary, takes
about five minutes, and the output is a JSON report you keep. You don't need
anything from me to do it: Mesh is open to everyone, with no signup and no
waiting list, and you can install it today (https://www.mesh-technology.com/start.html).
If you would rather have a hand, I can run it with you as a hands-on pilot:
an agreed measuring window, help with setup and an invoice you can check
yourself. Real
traffic is what will confirm (or kill) these simulator figures, and I'll share
the full methodology either way.

[sign-off]

P.S. The business model, for transparency. No fee is due unless we have agreed billing with you in writing.
Where we have, the fee is 1% of verified savings for the month, rounded down
to the cent, and nothing else. Verified savings are computed from a
hash-chained ledger on your machine that you can recompute yourself, and if
the verdict for a month is `do_not_charge` you owe nothing for that month.
The quote run is free and local either way.

---

## Claim audit (internal, do not send)

| Claim in letter | Label | Source |
|---|---|---|
| Issues #19681 / #33772 / #34801, 8.5%–10x drift | sourced | github.com/BerriAI/litellm issues, verified 2026-10-13 (all three now closed — phrased as "before fixes landed") |
| 18.2% on a mixed 30-request basket, with the cache stamp and a tool-result cap on | LIVE, run 2026-10-26, NOT a fresh install | docs/NUMBERS.md, LIVE table: `MESH_LIVE_KEEP=1 evals/run-live-agents.ts`, claude-sonnet-5-5, spools in `evals/live-exports-2026-10-26/`. MESH's own test basket, not a customer's traffic. That run had levers on that a fresh install leaves off: the Anthropic cache stamp (`cache-ttl-5m`) and a gate-approved tool-result cap (`fresh-tool-result-cap`). Summing the `levers` rows of those spools on 2026-11-23: the tool-result cap and the cache stamp together earned more than the default levers did (schema compaction and duplicate removal; prefix repair earned nothing), so the defaults are under half of the saving. No default-install percentage is in docs/NUMBERS.md, so none is stated |
| 25.9–29.4% busy interactive agents, with description trimming, history compaction, an output cap and a tool-result cap on | SIMULATOR, NOT a fresh install | docs/NUMBERS.md, SIMULATOR table: arm J, `4e51734` (commit of 2026-10-13). Lever set as arm J is defined in `evals/run-agent-ab.ts` on `main`; all four are off in a fresh install |
| 45.5% one-shot templated, with description trimming, history compaction and an output cap on | SIMULATOR, NOT a fresh install | docs/NUMBERS.md, SIMULATOR table: arm H of arms H/I, `7b08666` (commit of 2026-10-12). The other arm, 72.8%, adds a discounted execution tier to the same levers and is left out of the letter |
| 57.7% net async, with the interactive levers plus a discounted execution tier on | SIMULATOR, NOT a fresh install | docs/NUMBERS.md, SIMULATOR table: arm K, `4e51734` (commit of 2026-10-13), served-tier priced. Net of assumed fallback rates; the 64.3% ceiling, from the same levers, is never quoted on its own. OpenAI-priced, hence the label in the letter |
| "open to everyone, no signup, no waiting list", install today | site | `docs/site/start.md` and `docs/site/faq.md` on `main`; the link is the built start page |
| "hands-on pilots: measuring window, help with setup, an invoice you can check" | plan | [PILOT_PLAN.md](./PILOT_PLAN.md). Optional; no number of places is stated in the letter |
| "no network calls, nothing uploaded" | code-enforced | quote-report.ts pure function; packaged bin makes no fetch |
| The fee sentences in the P.S. | site, word for word | `docs/site/terms.md`, Fees (last updated 18 November 2026): "No fee is due unless we have agreed billing with you in writing", "the fee is 1% of verified savings for the month, rounded down to the cent, and nothing else", "If the verdict for a month is `do_not_charge`, you owe nothing for that month" |
| "keeps your prompts cacheable, and writes a ledger you can recompute"; no promise of a lower bill | code, and a limit stated | The default levers (`packages/sdk-js/src/theo-policy.ts`) include cache-prefix repair; the ledger is recomputed by `mesh verify` and `mesh statement`. No measurement of MESH against a real provider bill exists, so the letter says so and promises none |
| Not said in the letter, and not needed at first contact | site | A customer who agrees billing registers their install's statement key (`mesh statement --key`, MESH 0.2.5 or later) and is billed only from statements it signed: `docs/site/pricing.md`, [order-form.md](./order-form.md). Nobody needs a key to install, test or get a quote |
| 34.3% sparse interactive, with the interactive levers plus a 1-hour cache stamp on | **omitted deliberately** | SIMULATOR, not a fresh install (docs/NUMBERS.md, arm L, `6f08b72`). Left out of outreach on 2026-10-13 because per-model cacheable minimums were not enforced; `docs/site/faq.md` still says the figure awaits that correction |
