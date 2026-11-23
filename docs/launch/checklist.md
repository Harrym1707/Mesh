# Launch checklist

**Draft; nothing has been posted.** Refreshed 2026-11-23 for MESH 0.2.5.

Everything here must be true BEFORE the first post goes up. A launch spike
lasts hours; a broken first impression lasts. Every box is left unticked on
purpose: tick one only on the morning of the launch, after doing it yourself
that morning. What was seen when this file was refreshed is in "Seen on
2026-11-23" at the end; it is a record, not a tick.

## Product readiness (verify the morning of)

- [ ] The one path works from a clean machine (no repo, no login) — this is
      the first thing every visitor will run:
      `curl -fsSL https://www.mesh-technology.com/install.sh | sh` (and
      `npm install -g @harrym1707/mesh`), then `mesh version` prints
      `mesh 0.2.5` or later on BOTH routes. The website and npm are published
      separately; if one is behind, hold any post that gives that route
- [ ] `mesh start` connects Claude Code and puts it back on Ctrl+C;
      `mesh proxy` answers `curl http://127.0.0.1:8787/mesh/health`;
      `mesh verify` ends with `All checks passed.`
- [ ] The no-install alternative still starts:
      `npx -y -p @harrym1707/sdk mesh-proxy`
- [ ] The statement commands work on a clean install: `mesh statement --key`
      prints a 64-character fingerprint; after a few requests through
      `mesh proxy`, `mesh statement --period YYYY-MM` (the current month)
      prints the month, writes `mesh-statement-YYYY-MM.json` and says it is
      signed by this install's statement key; `mesh statement --check` on
      that file passes. With no traffic yet, `--period` says
      `No ledger found`, which is correct
- [ ] The Pricing and billing page loads
      (https://www.mesh-technology.com/pricing.html) and the landing
      page links to it
- [ ] www.mesh-technology.com loads fast; /start.html renders; GEO audit green
      (`MESH_SITE_ORIGIN=https://www.mesh-technology.com node --import tsx evals/run-geo-audit.ts`)
- [ ] CI green on main; nightly-evals has a passing run
- [ ] README front section reads correctly on the GitHub mobile app (most HN
      readers open the repo on a phone first)

## Repo as a landing page

- [ ] Issues enabled, pilot-quote template visible under "New issue" (GitHub
      issues are the only contact route; there is no email address)
- [ ] README, site and docs/NUMBERS.md show the same live number (18.2% net,
      LIVE, run 2026-10-26): the landing page's headline and its receipt both
      read 18.2%
- [ ] What the posts say about billing still matches the Pricing and billing
      page and the Terms (docs/site/pricing.md, docs/site/terms.md): 1% of
      verified savings for the month, rounded down to the cent; no fee until
      billing is agreed in writing; nothing charged automatically
- [ ] LICENSE question pre-answered: the README's BUSL section says plainly
      "free to use and evaluate; production use needs a commercial agreement;
      converts to Apache-2.0 on the Change Date" — commenters WILL raise this
- [ ] No TODOs, placeholder text, or broken links in any file a visitor
      reaches within two clicks of the README

## Hard questions we must answer honestly in comments (prepare, don't improvise)

1. **"You're billing a counterfactual."** Answer: yes — the same way energy
   performance contracts have since the 1990s: agreed baseline, provider-
   verbatim measurements, and an invoice that is a pure function of a ledger
   you hold and can recompute with `mesh verify`. Say which side is which:
   the "after" is the provider's own reported usage; the "before" baseline is
   computed by MESH. If our number and yours disagree, yours prevails.
2. **"Why not just set cache_control myself?"** Answer: you absolutely can,
   and if your stack is already optimised our quote literally says "do not
   pay us." MESH is for the teams that haven't — our own live test run
   measured a five-turn agent paying full rate for its entire history every
   turn — plus the verification layer that shows what changed.
3. **"BUSL isn't open source."** Answer: correct, and we don't claim it is.
   Source-available, free to use non-commercially and evaluate, Apache-2.0 on
   the Change Date. Installing and running it is free; a fee exists only
   once billing is agreed in writing, and it is 1% of verified savings for
   the month, rounded down to the cent. That's the whole business.
4. **"The savings numbers are simulated."** Answer: the bands are SIMULATOR
   numbers and labelled so everywhere they appear; the one LIVE number is
   18.2% net on a mixed 30-request basket (run 2026-10-26, real API traffic
   from our own test agents, spools in the repo). Running it on your own
   traffic replaces every number with yours; `mesh verify` recomputes it.
5. **"What about my data?"** Answer: the proxy runs on your machine; your
   prompts go to your own provider and nowhere else; the ledger stores usage
   numbers and hashes, not content; your API key passes through to the
   provider and is never stored.
6. **"Who is using it?"** Answer: nobody but us yet. MESH has not run on any
   customer's traffic; there are no customers, testimonials or case studies.
   Every number we quote is from our own test runs and labelled. It is open
   to anyone, no signup, so your own ledger is the number that matters.
7. **"So how do you actually bill me?"** Answer: not until we have agreed it
   in writing; until then no fee exists. Then it is 1% of verified savings
   for the calendar month, rounded down to the cent, so never more than 1%.
   Nothing is charged automatically. After the month you run
   `mesh statement --period YYYY-MM`; it recomputes the month from your
   ledger and writes a statement file signed by your own install, whose key
   fingerprint (`mesh statement --key`) you registered once when billing was
   agreed. You send that file and the ledger files; we recompute the same
   figure and send a statement and an invoice. If the figures differ for the
   same ledger, yours wins. The page: https://www.mesh-technology.com/pricing.html
   Do not add anything the page does not say; the invoice currency is set
   in the written agreement.

## Mechanics

- [ ] Founder available for the first 3 hours after posting to answer
      comments personally (this decides whether a post lives or dies)
- [ ] Never ask anyone to upvote, and never upvote from a second account —
      vote-ring detection buries the post permanently
- [ ] One community per day, not a blast — each post tailored (see
      communities.md), each answered properly
- [ ] Watch the traffic archiver + npm downloads afterward; the ops agent's
      Friday report captures the week

## Who fires what

| Action | Owner |
|---|---|
| Posting anywhere (HN, Reddit, PH, X, Discord) | Founder, always |
| Drafts, timing advice, comment-reply drafts | Claude |
| Answering GitHub issues that arrive | Founder sends; Claude drafts |
| Measuring the spike (traffic, downloads, mentions) | Ops agent (Fridays) + traffic archiver |

## Seen on 2026-11-23 (a record, not a tick; redo each on the morning)

Run by the session that refreshed this file, on macOS arm64 with Node 24, in
a throwaway home folder, against a stand-in provider on localhost. No real
provider was called and no real key was used.

- Website install: `mesh version` printed `mesh 0.2.5 (build 59363e8)`; the
  live `mesh-version.json` named build `59363e8`.
- npm: `npx -y @harrym1707/mesh version` printed
  `mesh 0.2.5 (build 932bcd0)`. The registry shows 0.2.5 published at 19:56
  UTC that day; a few minutes earlier it still gave 0.2.4.
- `mesh statement --key` printed a 64-character fingerprint and the path of
  the private key file.
- After three requests through `mesh proxy` to the stand-in provider,
  `mesh statement --period 2026-11` printed the month (verdict
  `do_not_charge`, fee 0 cents), wrote `mesh-statement-2026-11.json` and
  said it was signed by the install's statement key;
  `mesh statement --check` on that file passed both the seal and the
  signature; `mesh verify` ended with `All checks passed.`
- https://www.mesh-technology.com/pricing.html answered 200, and the live
  landing page showed 18.2% as its headline and on its receipt (the wrong
  receipt figure noted here on 2026-11-18 was corrected in release 0.2.4).

Not done that day: `mesh start` with Claude Code; `npm install -g`; the
no-install proxy's banner (it was started but its output was not read);
Linux; Windows under WSL; the GEO audit; CI and nightly-evals; the README on
a phone; the issue template on GitHub.
