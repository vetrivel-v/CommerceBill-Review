# MTO-1: Items and manual Sales Orders: Completion Report

Date: 2026-10-29. Decision record: [ADR-0031](adr/0031-item-roles-and-manual-sales-orders.md). First step of the approved made-to-order roadmap (MTO-1, MTO-2, SAFE-1, MTO-3, MTO-4, ECOM-1, ECOM-2+; see PROJECT_STATE). Not built and not started: invoice from order (MTO-2), corrections (SAFE-1), purchasing, BOM, production, attachments (Deferred), marketplace import. R-040 stays open; production billing is not enabled.

## What was delivered

- **Items.** Product stays the table; the screens say "Items". New `item_role` and `fulfilment_mode`, backfilled (every existing product is SELLABLE; tracked goods STOCKED, untracked goods MADE_TO_ORDER). Raw materials, components and packaging have no price, track stock, and cannot be ordered or invoiced (database triggers, the invoice engine, and a billing search that asks for sellable items only). Role and kind are independent: nothing infers tax treatment (R-126).
- **Units.** Grams accept one decimal place (the stock column keeps four); SHEET and SPOOL added. No unit conversion.
- **Orders.** `sales_orders`, `sales_order_lines`, `sales_order_events`; numbering `SO/{FY}/` provisioned for existing and new organizations; channel labels; optional unique external order id per channel; buyer, billing and delivery snapshots with an optional customer link; due date; agreed price and text customization per line; exact totals; idempotent creation; optimistic versions; status workflow enforced by a database trigger and the application; append-only history; audit without buyer details.
- **Screens.** Items (role filter, role-aware form, fulfilment shown), Orders list (search, status and source filters, paging), New order, Order detail/edit with status actions and history, an Orders card on the Dashboard, an "Orders" navigation entry.
- **Recovery.** Restore-time integrity checks for item roles, orders and lines, order numbers and invoice lines; upgrade of a populated pre-MTO database; MTO-era backup verified.

## Status model (reachable in MTO-1)

DRAFT to CONFIRMED or CANCELLED; CONFIRMED to NEEDS_INFO, CANCELLED or CLOSED; NEEDS_INFO to CONFIRMED or CANCELLED. IN_PRODUCTION and READY are in the vocabulary but unreachable. INVOICED and PAID are never stored. Reasons are required for NEEDS_INFO, CLOSED and cancelling a non-draft.

## Verification

Tests added: `tests/integration/sales-orders.int.test.ts` (items and orders through the real API), `orders-ui.int.test.tsx` (real screens, real API, real PostgreSQL), `mto-recovery.int.test.ts` (populated pre-MTO upgrade; backup and integrity checks), `packages/sales-orders` unit tests, updated Items tests. Visual review with fictional data at 1000 and 1280 px: Items list, sellable and raw-material forms, Orders list, New order, order detail with customization, history, Dashboard card. Defects found and fixed in review: address cards repeated their titles and left blank space (now one Addresses card with a "same as delivery" switch); the orders table is tightened at 1000 px.

The final release gate and the commit are reported in the hand-over message.

## Decisions made while implementing (for review)

- The Items form keeps the existing **Track inventory** control for sellable goods and shows the resulting fulfilment mode (Stocked or Made to order) beside it, instead of adding a second control that must agree with it. The API accepts a mode and derives tracking from it.
- A tax category is still stored for every item, materials included (R-124).
- CLOSED is allowed from CONFIRMED with a reason so that an order finished outside CommerceBill is not stuck; it creates no invoice and touches no stock.
- `IN_PRODUCTION` and `READY` are stored vocabulary only; no transition reaches them.

## Known limits

No invoice from order, production, purchasing, attachments (R-123), marketplace import, unit conversion, or order-level discounts and charges. Order totals are agreed values before GST. See R-122 to R-127.

## MTO-2 acceptance criteria (recorded, not started)

See PROJECT_STATE, "Approved made-to-order roadmap".
