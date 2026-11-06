# 00. Executive Summary

CommerceBill is a Windows desktop billing application for a single Indian GST-registered business. This review is read-only and evidence-based; it changes no application code, configuration, schema or dependency. Statutory comments are a software gap assessment, not tax or legal advice.

## Snapshot

| Item         | Fact                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product      | Electron shell + local Fastify API + React UI over an embedded PostgreSQL 18 (beta), managed by the app; per-user unsigned NSIS installer                                                                                   |
| Code         | npm monorepo: 3 apps + 23 packages (4 are README only); 512 tracked files (253 TS, 67 TSX, 14 SQL migrations)                                                                                                               |
| Data         | 35 tables, 52 triggers; immutable posted invoices, append-only ledgers, exact decimal money                                                                                                                                 |
| Scope today  | Setup, sign-in, business profile, customers, items, inventory (receipts/adjustments), manual sales orders, DEMO tax invoices with PDF/print, payments and receivables, tax configuration, encrypted verified backup/restore |
| Billing mode | Production billing is gated off. All invoices are DEMO until a tax review, valid seller GST, HSN policy and a verified backup exist                                                                                         |
| Deployment   | Local, single Windows 11 machine. Hosting, remote access and auditor access are future work. Accountant review is on hold                                                                                                   |

## Overall assessment

The engineering foundation is **stronger than the feature set**. Posting is atomic, idempotent and immutable; arithmetic is exact; backup/restore is verified; the Electron/API trust boundaries are carefully built; and test coverage is broad (see `08_…`). The product is, however, **not usable for real billing**:

1. A mistaken invoice cannot be corrected (no credit/debit note, cancellation, refund or return).
2. Tax rates, categories and state data are unreviewed placeholders, and the HSN list is empty.
3. The default invoice number (18 characters) may exceed the commonly cited 16-character limit.
4. No due dates, terms, ageing, receipts, reports or exports, so the business and its accountant cannot run month-end.
5. No services, additional charges or invoice-level discounts; no purchasing or supplier side.

## Top confirmed findings

1. **G-001** No correction documents: go-live blocker.
2. **G-002** Tax reference data unreviewed (R-040, R-083); production gate correctly refuses real billing.
3. **G-GST-02** No invoice-number length limit; default format renders 18 characters.
4. **S-01** `npm audit`: 17 advisories including a high one on Electron (packaged runtime).
5. **G-003** Backups are manual, passphrase is unrecoverable, no off-computer copy.
6. **G-007** Invoices have no due date or terms; receivables cannot be aged.
7. **G-009** No reports/exports (sales register, GST summary, HSN summary).
8. **G-010** Audit log is append-only but cannot be viewed or exported.
9. **G-013** No services, charges, invoice discount; items limited to goods with line discounts.
10. **G-022** Production database engine is a PostgreSQL 18 beta.

## What is solid

Seller/GST/PAN validation, place-of-supply mechanics, tax split and rounding, gap-free per-year numbering, stock ledger with non-negative balances, derived receivables, optimistic concurrency, backup integrity checks, upgrade safety backup, no card data stored (reference field rejects card-like numbers), and a documented risk register.

## Recommendation

Do not enable production billing. Sequence: Phase 0 baseline and approvals, Phase 1 security/backup hardening, Phase 2 corrections and the rest of the golden workflow, then Phase 3 accountant review before any real invoice (`11_…`). Ask the questions in `13_…` first; several (turnover, e-invoice applicability, numbering) change the plan.

## How to read this package

`01` stack, `02` structure, `03` features, `04` workflows, `05` data, `06` GST, `07` security, `08` tests, `09` UX/ops, `10` gaps, `11` backlog, `12` diagrams, `13` questions, `14` index, plus `COMMERCEBILL_REVIEW_MANIFEST.md`.
