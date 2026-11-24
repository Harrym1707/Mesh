# Launch checklist

**Draft; nothing has been posted.** Refreshed 2026-11-24 for Mesh 0.2.5.

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
      LIVE, run 2026-10-26, measured with the cache stamp and a tool-result
      cap switched on, so not out of the box): the landing page's headline
      and its receipt both read it
- [ ] What the posts say about billing still matches the Pricing and billing
      page and the Terms (docs/site/pricing.md, docs/site/terms.md), word for
      word: 1% of verified savings for the month, rounded down to the cent,
      and nothing else; no fee is due unless billing has been agreed in
      writing; nothing charged automatically
- [ ] A fresh install still applies exactly three levers
      (`~/.mesh/theo-policy.json` after the first run lists
      tool-schema-compaction, duplicate-context-removal and
      cache-prefix-repair, and nothing else). If that has changed, every
      post's "out of the box" paragraph has to change with it
- [ ] Every figure in the post you are about to make says, in its own
      sentence, "out of the box" or which levers were switched on; no post
      states an out-of-the-box percentage unless one is now in
      docs/NUMBERS.md; no post calls Mesh a token compressor or promises a
      smaller bill
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
   computed by Mesh. If our number and yours disagree, yours prevails.
2. **"Why not just set cache_control myself?"** Answer: you absolutely can,
   and if your stack is already optimised our quote literally says "do not
   pay us." Out of the box Mesh does not place it for you either: it keeps
   your prefix stable so a cache can hit, and placing cache_control is the
   cache stamp, one opt-in line in the policy file. What Mesh adds is the
   record of what changed and what it was worth, which you can recompute.
   Our own test run found a five-turn agent paying full rate for its entire
   history every turn, which is why the lever exists.
3. **"BUSL isn't open source."** Answer: correct, and we don't claim it is.
   Source-available, free to use non-commercially and evaluate, Apache-2.0 on
   the Change Date. Installing and running it is free. No fee is due unless
   billing has been agreed in writing; where it has, the fee is 1% of
   verified savings for the month, rounded down to the cent, and nothing
   else. That's the whole business.
4. **"The savings numbers are simulated."** Answer: the bands are SIMULATOR
   numbers, labelled so everywhere they appear, and each was modelled with
   named levers switched on, not out of the box. The one LIVE number is
   18.2% net on a mixed 30-request basket (run 2026-10-26, real API traffic
   from our own test agents, spools in the repo), and it is not an
   out-of-the-box figure either: that run had the cache stamp and a
   tool-result cap switched on, and the three out-of-the-box changes account
   for under half of it. It is the ledger's arithmetic, not a provider
   invoice compared before and after. Running it on your own traffic
   replaces every number with yours; `mesh verify` recomputes it.
5. **"What about my data?"** Answer: the proxy runs on your machine; your
   prompts go to your own provider and nowhere else; the ledger stores usage
   numbers and hashes, not content; your API key passes through to the
   provider and is never stored.
6. **"Who is using it?"** Answer: nobody but us yet. Mesh has not run on any
   customer's traffic; there are no customers, testimonials or case studies.
   Every number we quote is from our own test runs and labelled. It is open
   to anyone, no signup, so your own ledger is the number that matters.
7. **"So how do you actually bill me?"** Answer: no fee is due unless
   billing has been agreed in writing. Where it has, the fee is 1% of
   verified savings for the month, rounded down to the cent, and nothing
   else; the month is the calendar month in UTC.
   Nothing is charged automatically. After the month you run
   `mesh statement --period YYYY-MM`; it recomputes the month from your
   ledger and writes a statement file signed by your own install, whose key
   fingerprint (`mesh statement --key`) you registered once when billing was
   agreed. You send that file and the ledger files; we recompute the same
   figure and send a statement and an invoice. If the figures differ for the
   same ledger, yours wins. The page: https://www.mesh-technology.com/pricing.html
   Do not add anything the page does not say; the invoice currency is set
   in the written agreement.
8. **"What do I get if I just install it?"** Answer, straight: three
   changes to each request, none of which alters the provider's answer.
   Mesh compacts tool schemas so they decode identically, removes exact
   duplicate context, and keeps the cacheable prefix stable by moving a
   per-request timestamp out of it. Plus the ledger: every request recorded
   on your disk, recomputable with `mesh verify`. That is all a fresh
   install does. It does not switch Anthropic's cache on for you, and it
   applies nothing that could change an answer. There is no measured
   out-of-the-box percentage, so do not give one, and do not estimate one in
   a thread. Our 18.2% (LIVE, run 2026-10-26) needed the cache stamp and a
   tool-result cap switched on; the three out-of-the-box changes are under
   half of it. If you only use Claude Code, expect little: it already
   manages its own prompt cache. If your stack is already lean, expect the
   do-not-pay-us verdict.
9. **"How do I switch the rest on?"** Answer, only what exists today:
   - The cache stamp: add `{ "lever": "cache-ttl-5m", "class": "lossless" }`
     to the `levers` list in `~/.mesh/theo-policy.json`; a running proxy
     picks it up on its next request. With the no-install proxy,
     `MESH_PROXY_CACHE_TTL=5m`.
   - Levers that can change an answer (trimming tool descriptions,
     compacting stale history, a lower output-effort setting): record a
     sample of your own requests with `mesh proxy --capture <file>`; Theo
     replays it with your key and measures saving and quality; what holds
     inside your quality ceiling is proposed (`mesh theo --proposals`) and
     you accept it with `mesh theo --accept <lever>`. Say that this loop has
     only been run against a stand-in provider so far.
   - The tool-result cap: in the SDK; the installed proxy holds it back
     without a gate proof, and nothing in the CLI proves it today. Do not
     say when or whether that changes.
10. **"Isn't this just another token compressor?"** Answer: no, and we do
    not sell it as one. Removing tokens is not the same as lowering a bill;
    a change that disturbs a cached prefix makes the provider write it
    again, and our own cache stamp lost money on an early live run until a
    guard fixed it. Out of the box Mesh compacts tool schemas, removes
    exact duplicate context, and otherwise works to keep your prompt
    cacheable. Nobody has measured Mesh against a real provider
    bill, us included, and we do not promise a smaller one. What we offer is
    a record: per-request usage as the provider reported it, a baseline you
    can re-derive, and a verdict that can be "do not pay us". Concede the
    general point fast; it is correct.
    *Background for you, not for quoting unless you have read it yourself:*
    arXiv 2607.12161, "Token Reduction Is Not Cost Reduction" (v5, 12 Aug
    2026), studied token-reduction tools under Claude Code and reports that
    removing tokens and reducing billed cost are only weakly related, with
    one setup's billed cost going up. It does not study Mesh. It was read
    for this file on 2026-11-24 through a fetch of its abstract page and
    part of its HTML, not in full, so no figure from it is given here.

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
  landing page showed 18.2%, the figure measured with the cache stamp and a
  tool-result cap switched on, as its headline and on its receipt (the wrong
  receipt figure noted here on 2026-11-18 was corrected in release 0.2.4).
  That page does not say the figure needed levers that are off on a fresh
  install (the cache stamp and a tool-result cap), so its headline is not an
  out-of-the-box figure; correcting the site is another team's work, and a
  post that links the site should not lean on that headline.
- A fresh install's `~/.mesh/theo-policy.json` listed three lossless levers
  and nothing else. A test request went to the stand-in provider with no
  `cache_control` added. After adding the `cache-ttl-5m` line to the policy
  file, the same request arrived with `cache_control`. A hand-added
  `fresh-tool-result-cap` (lossy, no gate proof) was held back: the proxy
  printed that it was holding one lossy lever until a replay proves it, and
  the tool result arrived uncapped. `mesh theo --proposals` said none were
  waiting.

Not done that day: `mesh start` with Claude Code; `npm install -g`; the
no-install proxy's banner (it was started but its output was not read);
Linux; Windows under WSL; the GEO audit; CI and nightly-evals; the README on
a phone; the issue template on GitHub.
