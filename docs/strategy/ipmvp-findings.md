# IPMVP / ESPC findings for the MESH measurement exhibit

(Research agent report, 2026-10-25; primary documents full-text verified except items marked UNVERIFIED.)

All primary documents extracted and verified against actual text. Here is the report.

---

# IPMVP/ESPC → MESH Measurement Exhibit: Transferable Knowledge

**Method note:** All findings below were verified against full text of the primary documents (PDFs downloaded and text-extracted), except items marked UNVERIFIED. Section/clause numbers are from the documents themselves, not summaries.

---

## 1. IPMVP core structure

Source: IPMVP Volume I, EVO 10000-1:2012 (the last freely-published full edition; the current edition is "IPMVP Core Concepts," available via evo-world.org registration — UNVERIFIED whether 2022 or later is current).

### The universal savings equation (Ch. 4.1 / Eq. 1a)

> Savings = (Baseline Energy − Reporting-Period Energy) ± Routine Adjustments ± Non-Routine Adjustments

Savings are **never measured directly** — they are the absence of consumption, so the entire protocol exists to make the counterfactual term defensible. This is exactly MESH's problem: "what the customer would have paid" is the counterfactual.

### The four options (Ch. 4.6, Table 2)

| Option | Name | What's measured | MESH analogue |
|---|---|---|---|
| **A** | Retrofit Isolation: Key Parameter Measurement | Field-measure only the *key* parameter(s); estimate the rest (documented, justified estimates) | Measure token counts, **stipulate** prices/routing shares |
| **B** | Retrofit Isolation: All Parameter Measurement | Continuous/short-term measurement of **all** energy of the affected system at an isolation boundary | **Closest fit for MESH**: continuous metering of actual usage per app/spool, all parameters from the ledger |
| **C** | Whole Facility | Utility-meter-level analysis of the entire facility; regression on independent variables | Whole-account LLM spend regression vs. counterfactual |
| **D** | Calibrated Simulation | Computer model calibrated to measured data; used when baseline doesn't exist (new construction) | Replaying traffic through a counterfactual pricing simulator |

**Mapping judgment:** MESH is an **Option B analogue with Option C characteristics** — like B, it meters every request inside a defined boundary (not whole-bill regression); like C, the baseline is a *computed* counterfactual rather than a physically isolated meter. The key IPMVP insight (Ch. 4.8.1): Option A's stipulated values exist precisely to *eliminate adjustment disputes* — "Values estimated for use in IPMVP Option A are usually chosen to eliminate the need for adjustments when changes happen within the measurement boundary." MESH can borrow this: **stipulate the counterfactual price schedule at signing** (e.g., "list price of the model actually called, at rates frozen in Exhibit X"), and recompute only quantities, never prices. That converts most "traffic-shape" disputes into non-disputes.

Also relevant: Option C guidance (Ch. 4.9) says savings should **exceed ~10% of baseline energy** to be confidently discriminated from noise — the energy version of "don't bill savings smaller than your measurement uncertainty."

### Baseline: definition, documentation, freezing (Ch. 4.5.1; M&V Plan item 3)

The baseline period must: represent **all operating modes** (a full operating cycle, max-to-min); include only periods where **all energy-governing factors are known**; and **coincide with the period immediately before commitment** to the retrofit. Baseline documentation (Ch. 5, item 3) must capture: the period identification, all consumption data, all coincident independent-variable data, and **all static factors** (occupancy, schedules, equipment inventory with nameplate data — "photographs or videotapes are effective"). Either party may define the baseline "providing the other party is given adequate opportunity to verify them."

The baseline is frozen by **recording it in the contract-attached M&V Plan**; it changes only through the defined adjustment mechanism. MESH analogue: the counterfactual pricing basis (model→price map, routing policy assumed in "without MESH" world) must be enumerated in the exhibit, hash-committed, and reciprocally verifiable — which mesh-verify already gives you. The "full operating cycle" requirement maps to: the baseline traffic profile must span the customer's real variation (batch vs. interactive, weekday/weekend, launch spikes) before rates are set.

### Adjustments (Ch. 4.5.3, 4.6, 8.2) — the "traffic shape changed" machinery

- **Routine adjustments**: for factors *expected* to change (weather, production volume). Handled by a pre-agreed mathematical model written into the M&V Plan; applied automatically each period. MESH analogue: volume growth, prompt-length drift — anything your per-request recomputation already normalizes away. In MESH's design, per-request metering makes most routine adjustment **structural rather than statistical** (a major advantage over Option C energy deals).
- **Non-routine adjustments (= "baseline adjustments")** (Ch. 8.2): for **static factors** not expected to change: facility size, equipment design, shifts, occupancy type. Triggered when "a change occurs to equipment or operations within the measurement boundary after the baseline period." Key requirements:
  - Static factors "must be **monitored for change throughout the reporting period**" and the M&V Plan must say **who tracks and reports each static factor** (owner, ESCO, or third party).
  - "Where the nature of future changes can be anticipated, methods for making the relevant non-routine adjustments **should be included in the M&V Plan**" — i.e., pre-agree the formula before the dispute exists.
  - M&V reports must include "**all details of any baseline non-routine adjustment** … explanation of the change in conditions, all observed facts and assumptions, and the engineering calculations" (Ch. 6).
  
  MESH static-factor analogues: customer switches model family for product reasons unrelated to MESH; adds/removes an app from a spool; changes provider contract to negotiated enterprise rates; adopts caching/batching independently of MESH. Each needs a named owner-of-record and a pre-agreed quantification method.

### IPMVP adherence clause language (Ch. 7) — directly reusable

IPMVP provides model contract language: *"The determination of actual energy and monetary savings will follow current best practice, as defined in IPMVP Volume I, EVO 10000-1:2012"* plus naming the approving party and Option. MESH equivalent: the pilot agreement should name the MESH measurement spec **by version hash**, name the approver of the measurement exhibit, and state that savings reports are valid only if produced per that spec (IPMVP: "IPMVP-adherent savings can only be reported for the reporting period that uses IPMVP-adherent procedures").

### Pricing the savings (Ch. 8.1) — underrated and directly on point

- Use the **same price schedule** for baseline and reporting-period cost (Cb and Cr) — never value saved units at a different rate than consumed units.
- Use **marginal prices**, never blended/average prices ("average prices create inaccurate statements of cost savings and should not be used"). MESH: value saved tokens at the actual per-token marginal rate of the model avoided, incl. tier breakpoints — the analogue of demand charges and ratchets.
- Where a third party invested, "the price schedule for savings reporting is **not normally allowed to drop below that which prevailed at the time of commitment**" — a price floor protecting the investor against provider price cuts. MESH must decide this explicitly: if Anthropic/OpenAI cut list prices 50%, does the counterfactual reprice? (Energy-industry answer: floor at signing-date prices, or the ESCO's payback evaporates through no fault of its own. Honesty-rule answer may differ — flag for the founder.)
- If a price-schedule change **was caused by the ECM itself** (fuel switching, Ch. 8.1.3), the new schedule applies to the reporting side only; if the change was exogenous, same schedule both sides. MESH analogue: discounts the customer earned *because of* MESH-driven volume shifts vs. discounts they'd have gotten anyway.

---

## 2. The M&V Plan as a contract exhibit — real tables of contents

### IPMVP's 13 required topics (Vol. I, Ch. 5) → MESH exhibit skeleton

1. ECM Intent → what MESH does and the operational verification that it's running
2. **Selected Option and Measurement Boundary** → which apps/spools/API keys are in scope; interactive effects outside the boundary (e.g., MESH-induced routing raises spend on an out-of-scope account) must be described even if ignored
3. **Baseline: period, energy, conditions** → counterfactual pricing basis, frozen price map, static factors
4. Reporting Period → billing cadence
5. **Basis for Adjustment** → avoided-cost (reporting-period conditions) vs. normalized; MESH = avoided cost: "savings under the traffic you actually ran"
6. **Analysis Procedure** → "the exact data analysis procedures, algorithms and assumptions … all terms and the range of independent variables over which it is valid" → the recompute algorithm, by version
7. **Energy Prices** → price schedule used to value savings + what happens when prices change
8. **Meter Specifications** → the ledger: hash-chain spec, commissioning, calibration analogue (cross-check against provider invoices), **method of dealing with lost data**
9. Monitoring Responsibilities → who records what; who tracks each static factor
10. Expected Accuracy → quantified uncertainty of the savings figure
11. Budget → cost of M&V itself (IPMVP rule of thumb: M&V cost <10% of annual savings — MESH's 1% fee means measurement must be nearly free, which the automated ledger provides)
12. Report Format → sample savings report attached
13. Quality Assurance

### FEMP 4.0 Appendix C — the federally **required** M&V Plan outline (verbatim structure)

1. Executive summary: proposed annual savings table + M&V plan summary per ECM
2. **Whole-project data / global assumptions**: 2.1 Risk & responsibility allocation (references the Risk/Responsibility Matrix); 2.2 Rate data and escalation factors; 2.3 Schedule & reporting **incl. witnessing requirements** (post-install report 30–60 days after acceptance, annual report 30–60 days after each performance year, 30-day owner review period); 2.4 O&M reporting; 2.5 Construction-period savings; 2.6 Rebates; **2.7 Dispute Resolution — "Describe plan for resolving disputes regarding issues such as baseline, baseline adjustment, energy savings calculation, and use of periodic measurements"**
3. **Per-ECM section** (repeat per measure): 3.1 overview & option used; 3.2 baseline development (variables, key performance factors, **government witnessing of measurements, sampling plan, calibration certification, data format (.xls/.csv), completed data forms**); 3.3 savings calculations (**all stipulated values, all equations, "details of any savings or baseline adjustments that may be required"**, rates used); 3.4 O&M savings justification; 3.5 proposed annual savings table (baseline use / post-install use / savings, per commodity); 3.6 post-installation M&V activities; 3.7 performance-period verification activities (schedule, witnessing, data collected, analysis)

Notable: **dispute resolution is a section of the measurement exhibit itself**, not just the master contract. MESH should mirror this — the measurement exhibit should state the recompute-and-compare procedure a disputing customer follows, before escalation.

---

## 3. Dispute mechanics in real ESPC contracts

Source: 2017 DOE IDIQ ESPC Generic Contract (conformed 09/2023).

### Who verifies (C.4)

- The **contractor (ESCO) performs M&V and writes the reports**; the **owner witnesses and approves**. "Prior to installation of ECMs, the ordering agency shall **witness measurements and review calculations, records (e.g., utility bills) and other elements of the baseline, to confirm its accuracy**" (C.4.2.B). Baseline witnessing per FEMP's "Guide to Government Witnessing and Review of M&V Activities."
- Annual M&V report "**must be accepted, in writing, by the authorized ordering agency official(s)**. Review and acceptance … **constitutes documentation to determine amount of Contractor payment**" (C.4.2.D). Payment is gated on owner sign-off of the measurement, every period.
- Third parties are optional, not standard: IPMVP Ch. 4.3 — "A third party **may** verify that the M&V Plan adheres to IPMVP."
- MESH analogue: the seller computes, the buyer verifies — mesh-verify is the "witnessing" function, but ESPC practice says make customer **acceptance in writing** the trigger for invoicing, with a deemed-acceptance window (30 days per FEMP Table C-3) so silence doesn't stall billing.

### The running log of impacts (C.4.2.E) — directly liftable

Each annual report must include "a section that documents, **on a continuous, annual basis, the changes or impacts that have affected the ability of the project to generate energy savings**. This 'running log of impacts', with associated impact on energy savings, is included so that when these become significant, a TO adjustment can be investigated." MESH: a standing "traffic-shape change log" in every statement, quantified but not necessarily billed, so adjustments are negotiated from a shared record instead of reconstructed in a dispute.

### Adjustment-vs-baseline-change preference (C.4.1.B) — liftable verbatim

"Where such factors beyond the Contractor's control potentially exist, the ordering agency and Contractor **will agree on the formal change control process to adjust the baseline** … **Where feasible, adjustments to the calculation methodology for savings are preferred over changes to the baseline.** Such adjustments make it easier to present the actual savings." And: "The definition of all elements of the pre-installation baseline will be agreed upon **before the TO is awarded**."

### Dispute escalation ladder (H.19 + FAR 52.233-1)

1. "Best efforts to **informally resolve** any contractual issue in controversy by mutual agreement" (H.19.A).
2. Voluntary **non-binding ADR** — mediation/fact-finding by "a neutral party … an individual, a board comprised of independent experts, or a company with specific expertise" whose opinions are **inadmissible in later litigation**; refusal to participate requires written reasons (H.19.B–E).
3. Formal claim → contracting officer final decision → appeal (FAR 52.233-1 Disputes). Critically, under the Disputes clause the contractor must **continue performing** while the dispute is pending.

MESH ladder analogue: (1) customer recomputes via mesh-verify and files a discrepancy notice with the specific ledger entries; (2) 30-day good-faith reconciliation, optionally with a named neutral technical expert whose findings are non-binding and inadmissible; (3) contract remedies. Plus: service continues during disputes; only the disputed portion of the fee is withheld/escrowed.

### Negative savings periods / shortfalls

- The standard federal structure is **guarantee + true-up in arrears**, from the IDIQ definitions (Attachment J-2, "Guaranteed Annual Cost Savings"): "For the first interval (generally 12 months) after Government acceptance of construction, **the contractor is paid as if the savings guarantee is being met. The annual M&V report establishes savings. If savings fall short of the guarantee, the contractor will pay back the shortfall over the next interval by accepting lower payments.**"
- Clause **G.5** (Payment to the Government for Guaranteed Annual Savings Shortfall): agency "shall adjust the payment schedule … to **recover the ordering agency's overpayments in the previous year** and to reflect the lower performance level into the current year," with payments restored "when the ECM performance level is restored."
- FEMP 4.0 (App. B.6): the agency "may use the annual report to **reconcile payments made … for previous billing periods** if previous payments were based on expected savings that then need to be adjusted to reflect verified savings." Also: "M&V needs to show only that the **overall cost savings guarantee** has been met and not that the predicted savings for each ECM have been achieved" — portfolio-level truth, not per-measure truth.
- **Excess savings**: generally retained by the government — excess over the guarantee is characterized as "one-time energy cost savings" belonging to the agency (J-2 definitions); the ESCO's payment is capped by its schedule. (MESH differs — 1% of actual savings scales with upside — but the symmetric principle to adopt is the statutory one: **aggregate payments never exceed aggregate verified savings**. The J-7 risk matrix states weather-risk acceptance "shall be contingent upon aggregate payments not exceeding aggregate savings.")
- MESH negative-period rule, in energy terms: a negative month is a shortfall netted against the next statement (fee = 1% × max(0, cumulative-to-date verified savings minus savings already billed)), i.e., **cumulative netting with carry-forward**, not invoice-and-forget. This is exactly the G.5 mechanic.

---

## 4. Failure modes of %-of-savings deals → protocol countermeasures → MESH attack surface

Sources: GAO-15-432 (2015), GAO-05-340 (2005, via search summary), GSA OIG A240046 (2025, via search summary), LBNL-49601, IPMVP/FEMP text.

| Failure mode (documented) | Evidence | Protocol countermeasure | MESH mapping |
|---|---|---|---|
| **Gamed/faulty baseline** — overstated operating hours, wrong assumptions → overpayments | Army Audit Agency findings cited in GAO-05-340: "baselines established by the ESCOs were faulty, resulting in overpayments" | Owner **witnesses baseline measurements** before award (IDIQ C.4.2.B); baseline must immediately precede commitment (IPMVP 4.5.1); either party may set baseline but other party gets verification opportunity (IPMVP Ch. 5 item 3) | Customer (or neutral) must be able to recompute the counterfactual **before signing**, on their own pre-MESH traffic sample; never let MESH unilaterally author an unwitnessed baseline |
| **Stacking exogenous changes into "savings"** — agency removes equipment, contractor keeps reporting savings from it | GAO-15-432: 14 of 20 projects overstated; one project reported $104K/yr (≈40% of reported savings) "not achieved" after equipment removal; "contractors were **not required to reduce the amount of savings they report**" when conditions changed | Static-factor monitoring with named owner per factor (IPMVP 8.2); **running log of impacts** (IDIQ C.4.2.E); GAO recommendation: require contractors to **report savings not achieved due to agency actions** | Require the MESH statement to separately disclose "savings attributable to customer-initiated changes" (their own model switches, their own caching) and exclude them — this is precisely the memory honesty-rules territory |
| **Stipulations quietly shifting risk** — savings "verified" against stipulated values nobody re-measures | GAO-05-340 theme: government "did not know whether it received contractor-claimed energy savings"; FEMP 3.1: "stipulations have the potential to shift risk to the customer" | FEMP: stipulations allowed only with "diligent estimation," documented in plan (App. C 3.3.2: "all stipulated values used"); Option A requires justification + periodic inspection that estimate conditions still hold | Every stipulated element of the counterfactual (price map, assumed routing) must be listed in one exhibit section and re-affirmed periodically; don't bury assumptions in code |
| **Review/witnessing atrophy** — owner stops checking, contractor's numbers become unaudited | GAO-15-432: officials "did not perform some oversight activities … because they were unaware of these duties"; GSA OIG 2025: PBS skipped baseline witnessing, let O&M contractor staff serve as "government" witnesses | Written acceptance of each annual report gates payment (IDIQ C.4.2.D); witnessing schedule is a required exhibit section (FEMP App. C 2.3.1) | Make mesh-verify runs **zero-effort and logged** (statement isn't payable until a verify run — by customer or automated on their infra — matches the hash); avoid the "customer rubber-stamps because verifying is work" decay |
| **Shared-savings dispute spiral** (the direct MESH ancestor) | LBNL-49601: 1985–93 shared-savings era — "shared savings can result in **disputes over exact savings levels**, particularly as project terms increase"; industry migrated to guaranteed savings (86% of performance-based projects) | The migration itself is the lesson: pure %-of-measured-savings puts the *entire* measurement in contention every invoice | MESH's mitigations are structural: per-request determinism, customer recomputability, short billing cycles. Still, consider the energy industry's hedge: an annual **cap/collar or minimum-fee-waiver** so small measurement deltas can't flip an invoice into a dispute |
| **Measurement drift / model decay** | EVO AM&V white paper: FSU (fractional savings uncertainty) formulas "**should not be relied upon**" with hourly data (autocorrelation underestimates error); "low levels of whole-building savings may not always be measurable" | Strict model-fit criteria up front; savings must be "clearly and consistently discernible year-round"; 10%-of-baseline floor (IPMVP 4.9) | MESH's deterministic recompute largely avoids statistical drift, but the analogue exists: provider API/pricing metadata drift vs. the frozen price map. Schedule periodic recalibration checkpoints (ledger vs. provider invoice reconciliation) in the exhibit |
| **M&V cost eating the deal** | IPMVP 8.5: M&V budget should stay under ~10% of average annual savings | Cost/accuracy tradeoff declared in plan (item 11) | At a 1% fee, MESH's measurement must cost ≪1% of savings — automated verification is not optional, it is the economics |

The EVO advanced-M&V white paper is the closest thing to MESH's regime (continuous interval metering): it confirms that even with granular data, **non-routine event detection remains the open problem** ("Challenges in identifying, validating, and adjusting for non-routine events affecting savings exist") and that practitioners need "a point of contact at the site … essential to evaluate non-routine events." Translation: the measurement exhibit should obligate the **customer** to notify MESH of material traffic-shape changes (new app launches, model migrations), mirroring the ESPC owner's duty to report facility changes — detection can't be purely algorithmic.

---

## 5. Shortest-path citations for the lawyer

1. **IPMVP Volume I (EVO 10000-1:2012)** — the conceptual spine: options, baseline, adjustments, M&V Plan contents (Ch. 4, 5, 7, 8.1–8.3). Public copy: https://www.eeperformance.org/uploads/8/6/5/0/8650231/ipmvp_volume_i__2012.pdf (current "Core Concepts" edition via https://evo-world.org — registration required; UNVERIFIED which year is current)
2. **FEMP M&V Guidelines 4.0 (2015)** — esp. Section 3 (risk/responsibility matrix) and **Appendix C (required M&V Plan outline, incl. §2.7 Dispute Resolution)**, Appendices D–E (report outlines): https://www.energy.gov/documents/mvguide40pdf — note a **5.0 draft** exists: https://www.energy.gov/sites/default/files/2024-03/femp-mv-5-0-guidelines_DRAFT.pdf
3. **2017 DOE IDIQ ESPC Generic Contract (conformed 09/2023)** — the actual clause language: C.4 (M&V, witnessing, written acceptance, running log of impacts), **G.5 (shortfall payback)**, H.19 (ADR), J-2 definitions (guarantee mechanics), J-7 (risk matrix), J-8 (M&V plan attachment incl. J-8.2.7 dispute resolution): https://www.energy.gov/sites/default/files/2024-04/femp-2017-doe-idiq-espc-generic-contract_updated-092023.pdf
4. **GAO-15-432, "Energy Savings Performance Contracts: Additional Actions Needed"** — the failure-mode catalog (overstated savings, unreported agency-caused shortfalls): https://www.gao.gov/products/gao-15-432 (PDF: https://www.gao.gov/assets/gao-15-432.pdf)
5. **EVO, "IPMVP's Snapshot on Advanced Measurement & Verification"** — continuous-metering M&V, NRE/NRA state of the art, model-fit criteria: https://evo-world.org/images/corporate_documents/NRE-NRA_White_Paper_Final_2701.pdf

Supporting: LBNL-49601 (shared-vs-guaranteed history): https://eta-publications.lbl.gov/sites/default/files/report-lbnl-49601.pdf · ASHRAE Guideline 14 ("Measurement of Energy, Demand and Water Savings") — paywalled; FEMP 4.0 §1.2.2 describes it as consistent with IPMVP but with quantitative uncertainty methods and no guidance on stipulations. Secondary sources report G14 calibration criteria of NMBE ±5% / CV(RMSE) 15% (monthly) and ±10% / 30% (hourly) — **UNVERIFIED against the guideline text itself**.

### UNVERIFIED items
- ASHRAE G14-2023 exact numeric criteria (above) and any G14 maximum-savings-uncertainty criterion — guideline is paywalled.
- Current IPMVP edition year and whether its NRA guidance has materially changed since the 2012 Volume I and the AM&V white paper.
- GAO-05-340 and GSA OIG details come from search-result summaries of those documents, not full-text extraction (the specific $104K/40% figure and the 14-of-20 figure in GAO-15-432 **were** confirmed via the GAO product page).

### Top liftable drafting moves (condensed)
1. Freeze the counterfactual **price schedule** at signing (Option A-style stipulation) so only quantities are ever recomputed; declare the price-floor rule for provider price cuts.
2. Structure the exhibit on FEMP Appendix C, including a **Dispute Resolution section inside the measurement exhibit** (§2.7 analogue) and a **lost-data method** (IPMVP item 8).
3. Require a **running log of traffic-shape impacts** in every statement (IDIQ C.4.2.E), with a named party responsible for tracking each static factor (IPMVP 8.2) and a customer duty to notify material changes.
4. Prefer **methodology adjustments over baseline rewrites** (IDIQ C.4.1.B verbatim principle); pre-agree NRA formulas for anticipated changes.
5. Gate invoices on **customer acceptance of the savings report** (written or deemed after 30 days), with mesh-verify as the witnessing mechanism.
6. Handle negative periods by **cumulative netting with carry-forward** (G.5 mechanic) and cap aggregate fees at 1% of aggregate verified savings — payments never exceed savings.
7. Escalation ladder: discrepancy notice with specific ledger entries → 30-day good-faith reconciliation → non-binding neutral expert (findings inadmissible) → contract remedies; service and undisputed payments continue during disputes.
---

**FOUNDER DECISION (2026-10-26, recorded):** on provider list-price cuts the
counterfactual REPRICES HONESTLY — savings are always valued at the price
schedule actually in force during the reporting period, never floored at
signing-date rates. Smaller fee in that scenario, by design; the measurement
exhibit should state this plainly as a customer protection.
