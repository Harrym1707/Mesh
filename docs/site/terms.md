# Terms of use

These terms cover the Mesh website, the Mesh software you install from it or from npm, and any paid arrangement with us. Last updated 12 November 2026.

## Who we are

Mesh is a trading name of **Flux AI Technologies Limited**, a company registered in England and Wales with company number 17543982. "We" and "us" mean that company.

## The short version

- Mesh runs on your own machine. Installing and running it is free.
- Your API key, prompts and completions stay with you. See the [privacy policy](privacy.md).
- You owe us nothing unless we have agreed billing with you, and then only a share of savings you can recompute yourself.
- The software is provided as it is. It changes the requests you send to your AI provider, so read the section on what it does before you rely on it.

## The software licence

The Mesh software is licensed under the Business Source License 1.1. The `LICENSE` file in the [source repository](https://github.com/Harrym1707/Mesh/blob/main/LICENSE) is the licence; these terms do not replace it.

That licence allows evaluation, development, testing and personal non-commercial use. Production or commercial use needs an agreement with the licensor, which is us: Flux AI Technologies Limited owns the software and is the licensor named in that file. **These terms are that agreement for one case:** if you accept them, you may run Mesh in production to reduce the cost of your own or your organisation's AI usage, for as long as you keep to these terms. You may not offer Mesh, or a product built from it, to others as a product or service. Anything else needs a separate written agreement.

## What the software does

- Mesh sits between your tools and your AI provider and removes tokens from requests before they are sent. By default it applies only changes designed not to alter the provider's answer.
- Changes that can alter an answer are applied only after they have been measured on your own traffic, and only when you accept them or have chosen a setting that applies them automatically.
- Mesh records each request's usage in a ledger on your machine and estimates savings from the provider's own reported usage.
- The background service and the launcher check our website for a newer version and install it after verifying its checksum. Set `MESH_NO_AUTO_UPDATE` to stop the background service updating itself, and use `mesh update --rollback` to return to the previous version.

You remain responsible for your account with your AI provider, for what you send to it, for its charges, and for checking that the results you get are fit for your purpose. We do not promise that Mesh will save you money.

## Fees

- No fee is due unless we have agreed billing with you in writing. Email is enough.
- Where we have, the fee is 1% of verified savings for the month, and nothing else.
- Verified savings are computed from the ledger on your machine. You can recompute them yourself with `mesh verify` or the separate `@harrym1707/verify` package. If your recomputation of the same ledger differs from our statement, yours prevails.
- If the verdict for a month is `do_not_charge`, you owe nothing for that month.
- We do not take payment automatically. We send a statement and an invoice.
- Fees exclude VAT and similar taxes, which are added where they apply.

## Acceptable use

Do not use Mesh or this website to break the law, to interfere with someone else's systems, or to misrepresent Mesh's figures as measurements where they are labelled as estimates. Do not remove licence or attribution notices.

## Ownership and feedback

The software, the website and the Mesh name and marks belong to us. Nothing here transfers ownership. If you send us suggestions, we may use them without owing you anything.

## Ending

You can stop at any time: `mesh uninstall` removes the background service and restores your tool's settings, and your ledger stays on your machine. We may end your permission to use Mesh in production if you seriously or repeatedly break these terms. Fees already earned remain payable.

## Our liability

Nothing in these terms limits liability for death or personal injury caused by negligence, for fraud, or for anything else that cannot be limited by law. If you are a consumer, your statutory rights are not affected.

Subject to that:

- The software and website are provided "as is", without warranties of any kind beyond those that cannot be excluded by law.
- We are not liable for loss of profits, revenue, business, data or goodwill, for charges from your AI provider, or for any indirect or consequential loss.
- Our total liability to you arising from Mesh in any 12-month period is limited to the greater of the fees you paid us in that period and £100.

## Changes

We may change these terms. The date at the top shows the latest version, and earlier versions remain in the public history of the source repository. If a change matters to someone we bill, we will tell them before it applies.

## Law

These terms are governed by the law of England and Wales, and its courts have jurisdiction. If you are a consumer living elsewhere in the United Kingdom you may also bring a claim where you live.

## Contact

Write to Flux AI Technologies Limited at its registered office, shown on the Companies House register under company number 17543982. For security reports use the private reporting channel described in the repository's `SECURITY.md`.
