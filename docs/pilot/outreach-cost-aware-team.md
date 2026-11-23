# Draft outreach 3 — a team that has published its own LLM cost work

**STATUS: DRAFT. Not sent. Sending is the founder's act.**
Audience: an engineering team that has written in public about its own LLM
cost or prompt-caching work, and so has probably already taken the easy
savings. A first note, short on purpose: it offers a ledger they can check,
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

I built MESH, a proxy that runs on your own machine between your agents and
Anthropic or OpenAI. By default it makes only changes designed not to alter
the provider's answer: it compacts tool schemas, removes exact duplicate
context and repairs the order of a cacheable prefix. It writes a hash-chained
ledger on your disk of what each request cost and what was saved, so the
figure can be recomputed by you (`mesh verify`) and not only by me. Where a
saving is an estimate of the tokens removed, and not a provider reading, the
line says so. Your API key passes through to your provider and is not stored,
and your prompts are not written to the ledger or sent to me.

You have already done the hard part, so I will not promise you a big number.
The one figure I have from real API traffic is 18.2% **(LIVE)**: the net
saving on a mixed 30-request basket of my own test agents, run on 26 October
2026. Every other figure I publish is simulator output and labelled
**SIMULATOR**
(https://github.com/Harrym1707/Mesh/blob/main/docs/NUMBERS.md). No customer
has run MESH yet. If your traffic has nothing left to save, it says so in
plain words: `nothing to bill yet — do not pay us`.

It is open to everyone, with no signup:
https://www.mesh-technology.com/start.html. Installing and running it is
free. A fee exists only if we agree billing in writing first, and then it is
1% of the month's verified saving. Would you try it on one workload and tell
me what `mesh status` prints?

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
6. Keep the sentence "No customer has run MESH yet" for as long as it is
   true.
7. Do not add a figure for what MESH would save them. There is none.

## Claim audit (internal, do not send)

| Claim in letter | Label | Source |
|---|---|---|
| A proxy on your own machine, between your agents and Anthropic or OpenAI | code | The proxy binds `127.0.0.1` (`packages/sdk-js/src/proxy.ts`); [data-handling.md](./data-handling.md) |
| By default only changes designed not to alter the provider's answer; the three named | code and site | The default policy is `tool-schema-compaction`, `duplicate-context-removal`, `cache-prefix-repair`, all classed lossless (`packages/sdk-js/src/theo-policy.ts`); the wording is `docs/site/terms.md`, "What the software does" |
| A hash-chained ledger on your disk of what each request cost and what was saved | code | `packages/core/src/savings-ledger.ts`; `~/.mesh/ledger/` |
| You can recompute the figure with `mesh verify` | code | `packages/cli/src/verify.ts`. It totals the whole ledger; a single month is `mesh statement --period YYYY-MM` on 0.2.4 or later |
| An estimated saving is labelled as one | code | Ledger lines carry `basis: "estimated-baseline"` for token-reduction levers |
| Key passes through and is not stored; prompts not in the ledger and not sent to us | code and site | [data-handling.md](./data-handling.md); `docs/site/privacy.md`. Request capture, off by default, is the one way prompt text is written to disk, and it stays on their machine |
| 18.2% on a mixed 30-request basket | LIVE, run 2026-10-26 | docs/NUMBERS.md, LIVE table: `MESH_LIVE_KEEP=1 evals/run-live-agents.ts`, claude-sonnet-5-5, spools in `evals/live-exports-2026-10-26/`. MESH's own test basket, not a customer's traffic |
| Every other published figure is simulator output, labelled | SIMULATOR | docs/NUMBERS.md, SIMULATOR table. No simulator figure is quoted in this letter |
| "No customer has run MESH yet" | true on 2026-11-19 | No customer traffic has gone through MESH; remove the sentence only when that changes |
| `nothing to bill yet — do not pay us` | code | Printed by `mesh start` and `mesh proxy` when the verdict is not `charge` (`packages/cli/src/start.ts`); seen on the installed 0.2.3 on 2026-11-18 and 0.2.4 on 2026-11-19 ([VERIFICATION.md](./VERIFICATION.md)) |
| Open to everyone, no signup; the start page link | site | `docs/site/start.md` and `docs/site/faq.md`; the link answered 200 on 2026-11-19 |
| Free to install and run; a fee only if billing is agreed in writing first; 1% of the month's verified saving | site | `docs/site/terms.md`, Fees (last updated 18 November 2026); `docs/site/pricing.md`. The letter does not say "exactly" 1% |
| "I will not promise you a big number" | by design | docs/NUMBERS.md has a "do not pay us" reference row for already-optimised stacks. It is context, not a MESH saving, and no figure from it is quoted here |
