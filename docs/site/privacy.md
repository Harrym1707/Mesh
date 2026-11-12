# Privacy policy

Mesh is built so that your prompts, completions and API keys stay on your machine and never reach us. This page says what does and does not leave it. Last updated 12 November 2026.

## Who is responsible

Mesh is a trading name of **Flux AI Technologies Limited**, a company registered in England and Wales with company number 17543982. For the personal data described below, that company is the controller.

## What stays on your machine

The Mesh software runs locally. None of the following is sent to us:

- Your API keys. They pass straight through to your AI provider and are not stored, logged or written to the ledger.
- Your prompts and completions.
- The ledger under `~/.mesh/ledger/`: usage numbers, model names, timestamps, saving figures and hashes for each request.
- The feature records Mesh uses to tune itself: counts and keyed hashes, not content.
- Request capture, if you turn it on. It is off by default. When on, it writes copies of your own requests, including prompt content, to a file you name on your own disk, limited in size, so that proposed changes can be tested. Delete the file to remove them.

When Mesh tests a proposed change it replays your captured requests to **your** AI provider using **your** key. We are not in that path.

## What reaches us or others

| When | What | Who receives it |
|---|---|---|
| You visit this website | Your IP address and browser details, as with any web request | GitHub, which hosts the site. Pages also load a font from Google Fonts and, on the home page, images from Lorem Picsum, so those services receive the same |
| You install or update Mesh | A download request for the installer, the runtime and its version file | GitHub (website) or npm |
| You configure a metering endpoint | Usage records for each request, without prompt text, sent to the address you set. Off unless you set it | Whoever runs the endpoint you configured |
| You email us or agree a pilot or paid plan | Your name, work contact details, organisation, and the messages you send | Us |
| We bill you | The ledger files you send us for the invoice (usage numbers and hashes, no prompts), and invoice records | Us, and our accountants where needed |

This website sets no cookies and runs no analytics or advertising scripts. We do see aggregate download and repository-visit counts published by GitHub and npm; they do not identify you.

We do not take card payments at present. If that changes, the payment provider will be named here first.

## Why we use it, and for how long

- **Contact and pilot details**: to answer you and to perform our agreement with you (contract; our legitimate interest in running the business). Kept while we are in contact and for up to two years afterwards.
- **Billing records and the ledger files behind an invoice**: to invoice you and to keep the accounts the law requires (contract; legal obligation). Kept for six years after the end of the financial year they relate to.

We do not sell personal data and do not use it for advertising.

## Where it goes

GitHub, npm and Google are based in the United States and process the request data described above under their own privacy terms. We do not send them anything else about you.

## Your rights

Under UK data protection law you can ask us for a copy of your personal data, ask us to correct or delete it, ask us to restrict or stop using it, and ask for it in a portable form. You can also complain to the Information Commissioner's Office at ico.org.uk.

## Children

Mesh is a developer tool and is not directed at children.

## Changes

The date at the top shows the latest version. Earlier versions remain in the public history of the source repository.

## Contact

Write to Flux AI Technologies Limited at its registered office, shown on the Companies House register under company number 17543982.
