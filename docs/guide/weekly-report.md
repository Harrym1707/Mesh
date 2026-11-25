# The weekly report

Once a week Mesh tells you what it did for you, in money. You do not need an
account and Mesh does not need your email address: the report is made on your
own computer, from your own ledger, and it stays there.

## What it says

```
  Mesh, your week (16 to 22 Nov).
  You paid your provider $412.10.
  Without Mesh: $498.30.
  Mesh saved you $86.20.
  Mesh's fee on that: $0.86.
  You keep $85.34.
  1,204 requests, ledger verified.
```

- **You paid your provider** is what the week's requests cost, worked out from
  the usage your provider reported and its published prices.
- **Without Mesh** is what the same requests would have cost without the
  savings. It is worked out, not measured: what you paid plus what Mesh saved.
- **Mesh saved you** is the saving Mesh can prove from your ledger. Nothing is
  counted that the ledger does not verify.
- **Mesh's fee on that** is 1% of the saving, rounded down to the cent.
- **You keep** is the saving minus the fee.
- **Requests, ledger verified** is how many requests went through Mesh that
  week, and that the record of them has not been altered.

All amounts are US dollars. A week runs from Monday 00:00 to the next Monday
00:00 in your own time zone.

Below that, one or two lines say what Theo, Mesh's token engineer, did that
week, and one line gives the month so far:

```
  Theo, your token engineer, found a further saving that needs your OK: mesh theo --proposals

  This month so far (November): saved $212.40, fee so far $2.12.
  Details: mesh report --detail
```

## When Mesh did not save you money

The report says so, plainly.

- **Saved nothing.** "Mesh saved you $0.00 this week, so you owe nothing. Your
  setup is already lean."
- **Cost more than it saved.** It can happen that a week comes out slightly
  negative. The report says how much, that it counts against Mesh's fee, and
  that you owe nothing.
- **A very small saving.** If 1% of the saving is under one cent, the report
  states the saving and says nothing is owed for it.
- **No requests.** "Mesh saw no requests last week, so it is not connected.
  Fix: mesh setup". Mesh is installed but your tools are not sending their
  requests through it. The report only says this when it has seen no requests
  since that week either.
- **Not running yet.** If your first requests came after the week being
  reported, the report says "Mesh was not running yet last week" and names
  the report that has them: "This week so far: mesh report --this-week". A
  quiet week between busy ones reads "Mesh saw no requests last week, but it
  has seen requests since." Neither is a connection problem.
- **The ledger could not be verified.** "Mesh could not verify your ledger last
  week, so there is no figure. Run: mesh verify". Mesh shows no number it
  cannot stand behind.

If some requests used a model that is not in Mesh's price list, one extra line
says how many. They are not in the cost lines and no saving is claimed for
them.

## What Theo's lines mean

Theo watches your traffic and looks for further savings. His lines are kept
apart from the money on purpose.

- **"Found a further saving that needs your OK."** Theo has tested a change on
  your own traffic and it held up. Nothing changes until you say yes. See it
  with `mesh theo --proposals`. A proposal is not a saving: it is never added
  to "Mesh saved you", to the fee, to "you keep" or to the month so far.
- **"A change Theo proposed and you accepted on 12 Nov saved $4.20 this week
  (verified, included above)."** A change you said yes to is now earning. The
  figure comes from your ledger and is already inside "Mesh saved you".
- **"Theo tested a change and held it back"** or **"switched a change back
  off."** It did not prove safe on your traffic, so it is not in use.
- **"Theo checked your traffic 9 times this week and found nothing more worth
  changing."** He looked; there was nothing to do.
- **"Theo did not run this week"** or **"has not run yet."** Theo runs
  alongside `mesh start` and the background service unless you turned him off.

## How it reaches you

- **Any time:** run `mesh report`. Add `--detail` for the breakdown, or
  `--open` to see it as a page in your browser.
- **Once a week, by itself:** while Mesh is running, on the first check after
  Monday 08:00 it saves last week's report as a page in `~/.mesh/reports/` and
  shows one notification on your desktop with the one-line version, for
  example "Mesh saved you $86.20 last week (fee $0.86). Details: mesh report
  --open". It does not open a window or a browser by itself. If your computer
  was off on Monday, the report comes the next time Mesh is running that week.
  If it was off for several weeks, you get the latest week only.
- **Once, in your terminal:** the first `mesh` command you run after a new
  week's report is ready prints the same one line, once.

Notifications use what your system already has: `osascript` on macOS, and
`notify-send` on Linux when it is installed. Where neither is there, the page
is still saved and `mesh report` still works.

## Turning the notification off

```sh
mesh report --off
```

That stops the weekly notification and the once-a-week line in your terminal.
`mesh report` still works whenever you want it. Turn it back on with
`mesh report --on`. To keep the page but never show a notification (on a
server, for example), set the environment variable `MESH_NO_NOTIFY=1` for the
process that runs Mesh.

## Where the numbers come from

They come from your ledger, the record Mesh keeps in `~/.mesh/ledger` of every
request it handled. The report uses the same calculation as
`mesh statement`, the one the invoice is made from. It does not have its own
idea of what counts as a saving:

- savings on a task that later failed are not counted;
- savings you already had before Mesh, such as your own caching, are not
  counted;
- a change that cost more than it saved counts against Mesh;
- a model that is not in the price list is not priced at all.

Because a failed task cancels the savings on its earlier requests, the figure
for a past week can go down if a task from that week fails later in the same
month.

## Why the weekly fee can differ from your invoice by a few cents

**Your invoice is the monthly statement, not the weekly report.** Mesh bills
once a month, for a calendar month in UTC, and rounds the fee down to the cent
once, on the month's total.

The weekly report rounds its fee down every week. Four weeks that each saved
$0.99 show a fee of $0.00 each, while the month's $3.96 has a fee of $0.03. So
the weekly fees added together can be a few cents away from the invoice. Two
more things can move them apart:

- A week where Mesh cost you money counts against the rest of that month, so
  the invoice can come to less than the weekly fees added together.
- A week that crosses the end of a month is split between two invoices.
  `mesh report --detail` shows the two parts.

The savings themselves always add up: take each week's part that falls inside
a month, add them, and you get that month's statement. And the invoice is
never more than 1% of the month's verified saving, rounded down.

To see a month the way it will be billed:

```sh
mesh report --month 2026-11
mesh statement --period 2026-11
```

## Nothing leaves your machine

The report is worked out on your computer. Mesh sends no usage data, no
figures and no report to anyone, and making the report makes no network call.
The page in `~/.mesh/reports/` is a single file with no outside links, images
or scripts, so opening it contacts nothing either.

A report holds money, counts and dates, and, in the detail only, the names of
the savings methods and the model ids. It never holds your prompts, the
contents of your requests, request ids, application names or keys.
