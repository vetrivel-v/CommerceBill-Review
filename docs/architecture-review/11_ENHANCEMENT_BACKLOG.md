# 11. Enhancement Backlog (proposal only, nothing implemented)

Ordered by phase. Each item lists the gap(s) it closes, a rough effort (XS-XL) and the exit test. Do not start any item without an explicit decision; sequencing within a phase is a recommendation.

## Phase 0: Protect and baseline

| Item                                                                | Closes | Effort | Exit test                                    |
| ------------------------------------------------------------------- | ------ | ------ | -------------------------------------------- |
| Tag a known-good baseline once the review is accepted               | -      | XS     | clean tree, gate green on the committed tree |
| Stabilise load-sensitive tests (R-104) without loosening thresholds | G-028  | S      | 5 consecutive green gate runs                |
| Target-laptop checklist: install, print/save, restart, uninstall    | G-025  | S      | signed-off checklist                         |
| Reconcile master spec with built scope (one "as built" doc)         | G-029  | S      | reviewed doc                                 |

## Phase 1: Critical data integrity and security

| Item                                           | Closes | Effort | Exit test                     |
| ---------------------------------------------- | ------ | ------ | ----------------------------- |
| Backup external copy step + recovery procedure | G-003  | M      | restore on clean machine      |
| Electron and `fast-uri` upgrades               | G-004  | S      | audit clean for high/critical |
| Audit viewer/export with retention             | G-010  | M      | permission and content tests  |

## Phase 2: Complete the golden billing workflow

| Item                                                                       | Closes | Effort | Exit test                              |
| -------------------------------------------------------------------------- | ------ | ------ | -------------------------------------- |
| Credit notes, debit notes, cancellation, payment reversal (data and rules) | G-001  | XL     | balance/tax/stock reconciliation tests |
| Due date, terms, ageing, statements                                        | G-007  | M      | ageing equals ledger                   |
| Drafts                                                                     | G-006  | M      | draft survives restart                 |
| Service lines, charges, invoice discount                                   | G-013  | L      | property tests                         |
| Receipt document                                                           | G-008  | S      | PDF test                               |
| Controlled back-dating                                                     | G-012  | S      | facts tests                            |
| Users/roles screens                                                        | G-011  | M      | UI tests                               |

## Phase 3: GST and statutory documents (needs accountant)

| Item                                                        | Closes   | Effort | Exit test                 |
| ----------------------------------------------------------- | -------- | ------ | ------------------------- |
| Accountant review of rates/categories/states; real HSN list | G-002    | M      | review record, gate ready |
| Invoice-number length rule and new default                  | G-GST-02 | S      | numbering tests           |
| Credit/debit note statutory print formats                   | G-001    | M      | accountant sign-off       |
| Cess, reverse charge, export, SEZ as needed                 | G-017    | L      | tax-engine tests          |
| E-invoice and e-way bill (if applicable)                    | G-016    | XL     | sandbox acceptance        |
| Period close and opening balances                           | G-021    | L      | lock/unlock tests         |
| GST summary and HSN summary reports                         | G-009    | M      | reconcile to ledger       |

## Phase 4: Inventory, purchasing, fulfilment

Suppliers and purchase orders (G-015, XL); stock counts and transfers (L); order-to-invoice and reservations (G-014, L).

## Phase 5: E-commerce and payment integration

Order import (CSV first, then marketplace APIs) and reconciliation (G-018, XL); hosted payment gateway with signed idempotent webhooks, no card data stored (G-019, L).

## Phase 6: Reporting, automation, UX

Sales register, ageing, stock valuation, exports (G-009, L); scheduled backups and jobs (G-020, M); boundary lint and package cleanup (G-023, S); email/WhatsApp sending; thermal layout.

## Phase 7: Production hardening and deployment

Code signing (G-005); stable PostgreSQL (G-022); volume tests (G-024); CSP tightening (G-027); hosting/remote access design, tenant model (G-026); monitoring; update channel.

## Dependency notes

Credit notes (Phase 2) gate any real billing. Accountant review (Phase 3) is an external dependency that the owner has put on hold; Phase 2 work that does not depend on it can proceed, but production billing must stay disabled until Phase 2 corrections and Phase 3 review are done.
