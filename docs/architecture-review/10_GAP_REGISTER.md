# 10. Gap Register

Each gap is a record with all required fields. Severity: Critical / High / Medium / Low. Effort: XS (<0.5 d), S (1-2 d), M (3-5 d), L (2-3 wk), XL (>3 wk). Phases are defined in `11_ENHANCEMENT_BACKLOG.md`. Evidence paths are relative to the repository root. "Verification" names the test or check that proves closure. Statutory statements are the reviewer's understanding and need accountant confirmation (see `06_…`).

| ID       | Area                                                  | Severity | Phase | Effort |
| -------- | ----------------------------------------------------- | -------- | ----- | ------ |
| G-001    | Corrections (credit/debit note, cancellation)         | Critical | 2     | XL     |
| G-002    | Tax reference data unreviewed                         | Critical | 3     | M      |
| G-003    | Backup off-computer copy and passphrase recovery      | High     | 1     | M      |
| G-004    | Electron dependency advisory                          | High     | 1     | S      |
| G-005    | Unsigned installer                                    | High     | 7     | S      |
| G-GST-02 | Invoice number length not enforced                    | High     | 3     | S      |
| G-006    | No invoice drafts                                     | Medium   | 2     | M      |
| G-007    | No due date, terms, ageing                            | High     | 2     | M      |
| G-008    | No payment receipt document                           | Medium   | 2     | S      |
| G-009    | No reports or exports                                 | High     | 6     | L      |
| G-010    | No audit viewer/export                                | Medium   | 1     | M      |
| G-011    | Users/roles have no UI                                | Medium   | 2     | M      |
| G-012    | Invoice date restricted to today                      | Medium   | 2     | S      |
| G-013    | Services/additional charges/invoice discount          | High     | 2     | L      |
| G-014    | Order to invoice link (MTO-2)                         | Medium   | 4     | L      |
| G-015    | Suppliers, purchasing, payables                       | High     | 4     | XL     |
| G-016    | E-invoice (IRN/QR) and e-way bill                     | High     | 3     | XL     |
| G-017    | Cess, reverse charge, export, SEZ                     | Medium   | 3     | L      |
| G-018    | E-commerce import and reconciliation                  | Medium   | 5     | XL     |
| G-019    | Payment gateway integration                           | Medium   | 5     | L      |
| G-020    | No scheduled backup / jobs                            | Medium   | 6     | M      |
| G-021    | Period close and opening balances                     | Medium   | 3     | L      |
| G-022    | Embedded PostgreSQL 18 beta                           | High     | 7     | M      |
| G-023    | No dependency-boundary lint, README-only packages     | Low      | 6     | S      |
| G-024    | Load and volume testing absent                        | Medium   | 7     | M      |
| G-025    | Native print/save and target-laptop verification      | Medium   | 0     | S      |
| G-026    | Single-organization login assumption                  | Low      | 7     | M      |
| G-027    | CSP broader than needed in packaged build             | Low      | 7     | XS     |
| G-028    | Flaky load-sensitive tests (R-104)                    | Low      | 0     | S      |
| G-029    | Specification drift (3,316-line master spec vs built) | Low      | 0     | S      |

## Full records

### G-001 Corrections are impossible

- **Area:** Billing / sales. **Description:** Posted invoices are immutable and there is no credit note, debit note, cancellation, refund or return flow.
- **Current evidence:** Trigger `sales_invoices_immutable`; numbering types exist but no tables (`prisma/schema.prisma`); R-088, R-094; workflows 12-14 in `04_…`.
- **Severity:** Critical. **Business impact:** A single wrong real invoice cannot be fixed lawfully; go-live blocker.
- **Compliance/security relevance:** Credit/debit notes are the normal statutory correction route; unsupported means mismatched returns and tax.
- **Remediation:** Credit note against a posted invoice (full/partial, tax reversed from stored snapshot), debit note, cancellation via credit note, payment reversal, stock-return decision. New immutable tables, numbering sequences, document templates.
- **Dependencies:** G-002, G-GST-02, G-007. **Effort:** XL. **Phase:** 2 (data) then 3 (statutory).
- **Acceptance criteria:** Credit note reduces receivable and tax exactly; cannot exceed the invoice; immutable; numbered gap-free; printed; audit written.
- **Verification:** New integration tests (post invoice, credit, assert balances/tax/stock); property test that invoice minus credits is never negative.
- **Rollback:** Forward-only migration; restore the verified pre-upgrade backup.

### G-002 Tax reference data unreviewed (R-040, R-083)

- **Evidence:** `tax_categories`/`tax_rates` `origin`/`review_status`; jurisdiction table `FUB-GST-1-JURISDICTIONS`; production gate fingerprint. **Severity:** Critical. **Impact:** Wrong rates or state codes would produce wrong tax on real invoices.
- **Relevance:** GST correctness. **Remediation:** Accountant reviews rates, categories, state/UT codes; record review; load real HSN/SAC list (R-077). **Dependencies:** accountant availability (on hold). **Effort:** M. **Phase:** 3.
- **Acceptance:** Review record with matching fingerprint; gate reports ready. **Verification:** `tax-configuration.int`; gate test. **Rollback:** Add a new review; old data untouched (effective-dated rows).

### G-003 Backup copy and passphrase recovery

- **Evidence:** ADR-0027, R-098, R-099. **Severity:** High. **Impact:** Machine loss means total data loss. **Relevance:** Availability/integrity. **Remediation:** Guided external-copy step with receipt, recovery-sheet procedure, later scheduling. **Dependencies:** none. **Effort:** M. **Phase:** 1.
- **Acceptance:** A backup copied to external media is restorable on a clean machine. **Verification:** `backup-restore.int` extension plus manual drill. **Rollback:** Remove the step.

### G-004 Electron advisory

- See S-01 in `07_…`. **Severity:** High. **Effort:** S. **Phase:** 1. **Acceptance:** no high/critical production advisories. **Verification:** `npm audit --omit=dev`, release gate. **Rollback:** revert lockfile.

### G-005 Unsigned installer

- See S-03. **Severity:** High. **Effort:** S (after certificate purchase). **Phase:** 7 (user decision: signing later). **Verification:** valid Authenticode signature. **Rollback:** previous build.

### G-GST-02 Invoice number length

- **Evidence:** `packages/numbering/src/validate.ts`; default `INV/{FY}/000001` is 18 characters. **Severity:** High. **Impact:** If a 16-character limit applies, every default invoice is non-conformant. **Relevance:** GST numbering rule (verify with accountant). **Remediation:** Enforce a maximum rendered length in validation and in a DB check; change the default format (e.g. shorter prefix and compact FY). **Dependencies:** accountant confirmation. **Effort:** S. **Phase:** 3 (do before any real invoice).
- **Acceptance:** Rendering any valid format yields <= 16 characters or is rejected at configuration. **Verification:** numbering unit + integration tests. **Rollback:** formats apply to future numbers only; sequences unchanged.

### G-006 No invoice drafts

- **Evidence:** No draft status; `status` always POSTED. **Severity:** Medium. **Impact:** Lost work; slower billing. **Remediation:** Draft table, editable, converted to a posted invoice in the same atomic transaction. **Effort:** M. **Phase:** 2. **Acceptance:** Draft survives restart and posts identically. **Verification:** integration test. **Rollback:** drop draft table (forward-only migration + backup).

### G-007 No due date, terms, ageing

- **Evidence:** `sales_invoices` lacks due-date; `customers.payment_terms_days` unused; `/receivables` shows balances only. **Severity:** High. **Impact:** No collections follow-up. **Remediation:** Add `due_date`, terms text, ageing buckets, statements. **Effort:** M. **Phase:** 2. **Acceptance:** Ageing matches the ledger. **Verification:** payments/receivables integration tests. **Rollback:** nullable column.

### G-008 No receipt document

- **Evidence:** receipt number allocated, no rendering. **Severity:** Medium. **Remediation:** Receipt HTML/PDF from the stored payment. **Effort:** S. **Phase:** 2. **Verification:** PDF test. **Rollback:** remove route.

### G-009 No reports or exports

- **Evidence:** `packages/reporting` is README only; no routes. **Severity:** High. **Impact:** Accountant and GSTR work impossible. **Remediation:** Sales register, GST summary, HSN summary, receivables, stock valuation; CSV/XLSX export. **Effort:** L. **Phase:** 6 (GST ones in 3). **Acceptance:** Totals reconcile to ledger. **Verification:** reconciliation tests. **Rollback:** read-only; remove routes.

### G-010 Audit viewer and export

- **Evidence:** `audit_logs` has no read API (R-063). **Severity:** Medium. **Remediation:** Permissioned read API, filter, CSV export, retention policy. **Effort:** M. **Phase:** 1. **Verification:** permission and content tests. **Rollback:** remove route.

### G-011 Users and roles UI

- **Evidence:** API-only `security.user.*`. **Severity:** Medium. **Remediation:** Users/roles screens, password reset by administrator. **Effort:** M. **Phase:** 2. **Verification:** UI + real-API tests. **Rollback:** hide screens.

### G-012 Invoice date restricted to today

- **Evidence:** `INVOICE_DATE_NOT_TODAY`. **Severity:** Medium. **Remediation:** Controlled back-dating within the open period with reason and permission (confirm with accountant). **Effort:** S. **Phase:** 2. **Verification:** facts tests. **Rollback:** feature flag.

### G-013 Services, additional charges, invoice discount

- **Evidence:** `ITEM_KIND_UNSUPPORTED`; line discount only. **Severity:** High. **Remediation:** Service lines, charge lines (freight, packing), invoice discount allocated across lines. **Effort:** L. **Phase:** 2. **Verification:** tax-engine property tests. **Rollback:** guarded by data version.

### G-014 Order to invoice (MTO-2)

- **Evidence:** orders (MTO-1) stop at confirmation. **Severity:** Medium. **Remediation:** Convert order to invoice with reservation/dispatch semantics. **Effort:** L. **Phase:** 4. **Verification:** order-to-invoice integration test. **Rollback:** link nullable.

### G-015 Suppliers, purchasing, payables

- **Evidence:** none exist. **Severity:** High (for stock-holding business). **Remediation:** Suppliers, purchase orders, receipts, bills, supplier payments, ITC data. **Effort:** XL. **Phase:** 4.

### G-016 E-invoice and e-way bill

- **Evidence:** placeholders in `integrations/`. **Severity:** High (threshold dependent: unable to determine). **Remediation:** Confirm applicability; schema mapping from invoice snapshot; IRN/QR columns; sandbox first. **Effort:** XL. **Phase:** 3.

### G-017 Cess, reverse charge, export, SEZ

- **Evidence:** explicit unsupported errors. **Severity:** Medium. **Remediation:** Add per business need after accountant input. **Effort:** L. **Phase:** 3.

### G-018 E-commerce import and reconciliation

- **Evidence:** placeholder folders only; `channel`/`external_order_id` columns exist. **Severity:** Medium. **Effort:** XL. **Phase:** 5.

### G-019 Payment gateway

- **Evidence:** none. **Remediation:** hosted/tokenized checkout only; webhooks signed and idempotent; no card data stored. **Effort:** L. **Phase:** 5.

### G-020 Scheduled backups and jobs

- **Evidence:** none. **Effort:** M. **Phase:** 6.

### G-021 Period close

- **Evidence:** `financial_years.is_locked` without workflow. **Effort:** L. **Phase:** 3.

### G-022 Embedded PostgreSQL 18 beta

- **Evidence:** managed runtime pins 18 beta while `docker-compose.yml` uses 17. **Severity:** High. **Remediation:** Move to a stable PostgreSQL release when available; test the upgrade path. **Effort:** M. **Phase:** 7. **Verification:** runtime and restore tests. **Rollback:** restore pre-upgrade backup.

### G-023 Architecture hygiene

- **Evidence:** four README-only packages; no boundary lint. **Effort:** S. **Phase:** 6.

### G-024 Volume testing

- **Evidence:** no performance tests. **Effort:** M. **Phase:** 7.

### G-025 Target-laptop verification

- **Evidence:** R-093; native dialogs untested. **Effort:** S. **Phase:** 0.

### G-026 Single-organization login

- **Evidence:** `packages/auth`. **Effort:** M. **Phase:** 7 (only if hosted).

### G-027 CSP tightening

- **Evidence:** `apps/web/index.html`. **Effort:** XS. **Phase:** 7.

### G-028 Flaky tests (R-104)

- **Evidence:** memory-pressure failures. **Effort:** S. **Phase:** 0.

### G-029 Specification drift

- **Evidence:** `COMMERCEBILL_MASTER_SPEC_V2.md` vs built scope. **Effort:** S. **Phase:** 0.

For G-016 to G-029, the acceptance criterion is "feature behaves as specified in an approved design and its named tests pass"; verification is the new integration/UI tests plus a full gate run; rollback is a forward-only migration with the verified pre-upgrade backup as the recovery point. These are intentionally less detailed because they are not yet designed.
