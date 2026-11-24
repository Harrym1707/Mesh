# Draft outreach 3 — a team that has published its own LLM cost work

**STATUS: DRAFT. Not sent. Sending is the founder's act.**
Audience: an engineering team that runs its own agents on the API (coding,
browsing, support, RAG or multi-agent) and has written in public about its
own LLM cost or prompt-caching work, and so has probably already taken the
easy savings. A first note, short on purpose: it offers a ledger they can check,
expects a small number or none, and asks for one workload. No organisation or
person is named in this file; the prospect list is kept privately.
Personalise the [bracketed] fields before sending.

Savings figures checked 2026-11-19 against [docs/NUMBERS.md](../NUMBERS.md)
(last reconciled 2026-10-27). Re-check them against that file on the day of
sending.

---

**Subject:** Your post on [their topic] — a ledger you could check it with

Hi [name or team],

I read [their post, with link]. [One sentence on the specific thing they
found, in their own terms.]

I built Mesh, a proxy that runs on your own machine between your agents and
Anthropic or OpenAI. It does two things I think are worth your time. It keeps
your prompts cacheable: by default it makes only changes designed not to
alter the provider's answer (it compacts tool schemas, removes exact
duplicate context and repairs the order of a cacheable prefix). And it writes
a hash-chained ledger on your disk of what each request cost and what Mesh
counts as saved, so the figure can be recomputed by you (`mesh verify`) and
not only by me. Where a
saving is an estimate of the tokens removed, and not a provider reading, the
line says so. Your API key passes through to your provider and is not stored,
and your prompts are not written to the ledger or sent to me.

You have already done the hard part, so I will not promise you a smaller
bill. Nobody has measured Mesh against a real provider bill yet, me included.
The one figure I have from real API traffic is 18.2% **(LIVE)**: the net
saving on a mixed 30-request basket of my own test agents, run on 26 October
2026 with the Anthropic cache stamp and a tool-result cap switched on, both
of which are off in a fresh install; the three default changes above account
for under half of it. I have no figure yet for a fresh install on its own.
Every other figure I publish is simulator output, modelled with further
levers switched on, and labelled **SIMULATOR**
(https://github.com/Harrym1707/Mesh/blob/main/docs/NUMBERS.md). No customer
has run Mesh yet. If your traffic has nothing left to save, it says so in
plain words: `nothing to bill yet — do not pay us`.

It is open to everyone, with no signup:
https://www.mesh-technology.com/start.html. Installing and running it is
free. No fee is due unless we have agreed billing with you in writing. Where
we have, the fee is 1% of verified savings for the month, rounded down to the
cent, and nothing else. Would you try it on one workload and tell me what
`mesh status` prints?

[your name]

---

## Before sending (internal, do not send)

1. Re-open the recipient's post and confirm it still says what the note
   claims. Quote their finding in their terms, not ours.
2. Confirm how they call the provider (their own API key, and which
   provider) before implying a fit. MESH sits in front of Anthropic, OpenAI
   and OpenAI-compatible endpoints, on the machine the calls are made from.
3. Re-check every figure against [docs/NUMBERS.md](../NUMBERS.md).
4. Confirm the start page link loads.
5. Never state or imply that any organisation uses or has tested MESH.
6. Keep the sentence "No customer has run Mesh yet" for as long as it is
   true.
7. Do not add a figure for what MESH would save them. There is none.
8. Do not quote the 18.2% without its two levers and "under half", and do not
   state or imply a percentage for a fresh install: none is in
   docs/NUMBERS.md.
9. If they call the provider only through Claude Code, say plainly that the
   defaults should save them little; this note is written for a team calling
   the API from its own agents.
10. Do not describe Mesh as a token compressor, and do not say or imply that
    it will make their provider bill smaller. No such measurement exists.
    Lead with the two things that are true: it keeps prompts cacheable, and
    its ledger can be recomputed.
11. In the text that is sent, the name is "Mesh" and the fee is given in the
    Terms' own words.

## Claim audit (internal, do not send)

| Claim in letter | Label | Source |
|---|---|---|
| A proxy on your own machine, between your agents and Anthropic or OpenAI | code | The proxy binds `127.0.0.1` (`packages/sdk-js/src/proxy.ts`); [data-handling.md](./data-handling.md) |
| By default only changes designed not to alter the provider's answer; the three named | code and site | The default policy is `tool-schema-compaction`, `duplicate-context-removal`, `cache-prefix-repair`, all classed lossless (`packages/sdk-js/src/theo-policy.ts`); the wording is `docs/site/terms.md`, "What the software does" |
| A hash-chained ledger on your disk of what each request cost and what was saved | code | `packages/core/src/savings-ledger.ts`; `~/.mesh/ledger/` |
| You can recompute the figure with `mesh verify` | code | `packages/cli/src/verify.ts`. It totals the whole ledger; a single month is `mesh statement --period YYYY-MM` (0.2.4 or later; signed from 0.2.5) |
| An estimated saving is labelled as one | code | Ledger lines carry `basis: "estimated-baseline"` for token-reduction levers |
| Key passes through and is not stored; prompts not in the ledger and not sent to us | code and site | [data-handling.md](./data-handling.md); `docs/site/privacy.md`. Request capture, off by default, is the one way prompt text is written to disk, and it stays on their machine |
| 18.2% on a mixed 30-request basket, with the cache stamp and a tool-result cap on | LIVE, run 2026-10-26, NOT a fresh install | docs/NUMBERS.md, LIVE table: `MESH_LIVE_KEEP=1 evals/run-live-agents.ts`, claude-sonnet-5-5, spools in `evals/live-exports-2026-10-26/`. MESH's own test basket, not a customer's traffic. That run had levers on that a fresh install leaves off: the Anthropic cache stamp (`cache-ttl-5m`) and a gate-approved tool-result cap (`fresh-tool-result-cap`). Summing the `levers` rows of those spools on 2026-11-23: the tool-result cap and the cache stamp together earned more than the default levers did (schema compaction and duplicate removal; prefix repair earned nothing), so the defaults are under half of the saving. No default-install percentage is in docs/NUMBERS.md, so none is stated |
| Every other published figure is simulator output, modelled with further levers on, labelled | SIMULATOR | docs/NUMBERS.md, SIMULATOR table; the lever sets are the arm definitions in `evals/run-agent-ab.ts`. No simulator figure is quoted in this letter |
| "I have no figure yet for a fresh install on its own" | true on 2026-11-23 | docs/NUMBERS.md has no default-install row |
| "No customer has run Mesh yet" | true on 2026-11-19 | No customer traffic has gone through MESH; remove the sentence only when that changes |
| `nothing to bill yet — do not pay us` | code | Printed by `mesh start` and `mesh proxy` when the verdict is not `charge` (`packages/cli/src/start.ts`); seen on the installed 0.2.3 on 2026-11-18 and 0.2.4 on 2026-11-19 ([VERIFICATION.md](./VERIFICATION.md)) |
| Open to everyone, no signup; the start page link | site | `docs/site/start.md` and `docs/site/faq.md`; the link answered 200 on 2026-11-19 |
| Free to install and run; the two fee sentences | site, word for word | `docs/site/terms.md`: "Installing and running it is free" (short version) and Fees (last updated 18 November 2026): "No fee is due unless we have agreed billing with you in writing", "the fee is 1% of verified savings for the month, rounded down to the cent, and nothing else" |
| "I will not promise you a smaller bill"; nobody has measured it against a real provider bill | a limit stated | The LIVE figure is MESH's own test basket priced from provider-reported usage; no comparison of a real provider bill with and without MESH exists. The letter leads with cacheable prompts and the recomputable ledger and promises no bill reduction |
| Not said in the letter, and not needed at first contact | site | A customer who agrees billing registers their install's statement key (`mesh statement --key`, MESH 0.2.5 or later) and is billed only from statements it signed: `docs/site/pricing.md`, [order-form.md](./order-form.md). Nobody needs a key to install, test or get a quote |
