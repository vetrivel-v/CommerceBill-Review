# 09. UX and Operational Review

Basis: code and component review of `apps/web/src`, the Electron shell, and the project's own guides and tests. No usability testing with real users was performed; the target laptop was not inspected.

## 1. Screens and navigation

Left navigation (`apps/web/src/nav.ts`): Dashboard, Billing (new invoice, invoice list/detail/print), Orders, Customers, Items (products), Inventory, Receivables, Tax (categories/rates, HSN/SAC), Settings (Business Profile, Backup, Diagnostics). Setup wizard on first run; sign-in screen afterwards. Readiness "Fix" links on the dashboard and billing screens jump to the screen that resolves a blocker (Business Profile, Tax, Backup).

## 2. Strengths

- **Guided first run:** setup wizard validates GSTIN/PAN/PIN with the same shared rules as the server.
- **Preview before post:** invoice totals come from the server calculation and are previewed before posting; posting is atomic and idempotent (double-click safe).
- **Explicit blockers:** the production gate lists exactly what is missing (tax review, seller GST, HSN policy, verified backup).
- **DEMO marking:** demo documents are visibly marked so they cannot be mistaken for tax invoices.
- **Plain-language errors:** stable error codes mapped to messages (`apps/web/src/messages.ts`).
- **Safe destructive paths:** restore requires verification first, takes a verified safety backup, and runs in maintenance mode.
- **Accessible kit:** shared component kit (`packages/ui`) with labelled fields and badges; component tests cover search, paging and forms.

## 3. Weaknesses and usability gaps

| #    | Area                | Observation                                                                                                                                     |
| ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| U-1  | Corrections         | No way to cancel, credit or reverse a wrong invoice. Users will have to leave mistakes in place.                                                |
| U-2  | Drafts              | No saved draft invoice; a closed window loses an unposted invoice.                                                                              |
| U-3  | Date handling       | Invoice date must be today; late entry of yesterday's bill is impossible.                                                                       |
| U-4  | Reports             | No sales register, GST summary, ageing, stock valuation or CSV/Excel export. The accountant cannot get data out without direct database access. |
| U-5  | Receipt document    | A payment is recorded but nothing printable is produced for the customer.                                                                       |
| U-6  | Sharing             | No email/WhatsApp sending; manual save PDF then attach.                                                                                         |
| U-7  | Terms and due dates | Not captured or printed; receivables cannot be aged.                                                                                            |
| U-8  | Users and roles     | Management exists only as API; no screen to add a cashier or reset a password.                                                                  |
| U-9  | Audit               | No viewer; nobody can answer "who changed this".                                                                                                |
| U-10 | Units and tax rates | Units have no screen; tax rate changes need service/API calls.                                                                                  |
| U-11 | Search              | Customer and item search exist; invoice search/filters are basic.                                                                               |
| U-12 | Barcode/thermal     | No thermal receipt layout; barcode field exists but no scanner-oriented flow.                                                                   |
| U-13 | Stock               | Single warehouse in practice; no stock count, transfer, low-stock alert.                                                                        |
| U-14 | Order to invoice    | Orders cannot be turned into invoices (MTO-2 planned).                                                                                          |

## 4. Operations on the target laptop

- **Install:** per-user NSIS installer, unsigned (SmartScreen warning expected). Installed once by the owner; credentials are created in the setup wizard.
- **Data location:** managed embedded PostgreSQL under the user's application data folder; started and stopped by the app. Orphaned database processes are detected and recovered (`runtime.int`).
- **Backups:** manual, encrypted, verified by restore into an isolated database. No schedule; no automatic external copy. Operators must be trained to copy backups off the machine.
- **Upgrade:** a verified safety backup is taken before migrations; a failing migration leaves the database untouched.
- **Diagnostics:** Settings > Diagnostics shows version, database status and log location; logs are redacted.
- **Resilience:** crash/kill recovery is tested; power-loss and disk-full behaviour on the real laptop are not tested.
- **Printing:** Save PDF and Print go through Electron; native dialogs and a physical printer have not been verified (R-093).
- **Performance:** no load or volume test with realistic data (thousands of invoices); R-104 notes load-sensitive test flakiness, not product latency.
- **Support:** no remote support channel, crash reporter or update mechanism; updates are manual installers.

## 5. Manual verification still required

Native Save/Print dialogs, physical printer output, install/uninstall/upgrade on the target Windows 11 laptop, power-cut recovery, backup to an external drive, a day of realistic data entry, and accountant review of the printed invoice.
