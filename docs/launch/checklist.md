# Launch checklist

**Draft; nothing has been posted.** Refreshed 2026-11-18 for MESH 0.2.3.

Everything here must be true BEFORE the first post goes up. A launch spike
lasts hours; a broken first impression lasts.

## Product readiness (verify the morning of)

- [ ] The one path works from a clean machine (no repo, no login) — this is
      the first thing every visitor will run:
      `curl -fsSL https://www.mesh-technology.com/install.sh | sh` (and
      `npm install -g @harrym1707/mesh`), then `mesh version` prints
      `mesh 0.2.3`
- [ ] `mesh start` connects Claude Code and puts it back on Ctrl+C;
      `mesh proxy` answers `curl http://127.0.0.1:8787/mesh/health`;
      `mesh verify` ends with `All checks passed.`
- [ ] The no-install alternative still starts:
      `npx -y -p @harrym1707/sdk mesh-proxy`
- [ ] www.mesh-technology.com loads fast; /start.html renders; GEO audit green
      (`MESH_SITE_ORIGIN=https://www.mesh-technology.com node --import tsx evals/run-geo-audit.ts`)
- [ ] CI green on main; nightly-evals has a passing run
- [ ] README front section reads correctly on the GitHub mobile app (most HN
      readers open the repo on a phone first)

## Repo as a landing page

- [ ] Issues enabled, pilot-quote template visible under "New issue" (GitHub
      issues are the only contact route; there is no email address)
- [ ] README, site and docs/NUMBERS.md show the same live number (18.2% net,
      LIVE, run 2026-10-26). On 2026-11-18 the landing page's receipt reads
      22.0%, which is not in docs/NUMBERS.md: reconcile before posting
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
   the Change Date. We charge 1% of verified savings in production; that's
   the whole business.
4. **"The savings numbers are simulated."** Answer: the bands are SIMULATOR
   numbers and labelled so everywhere they appear; the one LIVE number is
   18.2% net on a mixed 30-request basket (run 2026-10-26, real API traffic
   from our own test agents, spools in the repo). Running it on your own
   traffic replaces every number with yours; `mesh verify` recomputes it.
5. **"What about my data?"** Answer: the proxy runs on your machine; prompts
   never leave it; the ledger stores usage numbers and hashes, not content;
   your API key passes through and is never stored.
6. **"Who is using it?"** Answer: nobody but us yet. MESH has not run on any
   customer's traffic; there are no customers, testimonials or case studies.
   Every number we quote is from our own test runs and labelled. It is open
   to anyone, no signup, so your own ledger is the number that matters.

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
