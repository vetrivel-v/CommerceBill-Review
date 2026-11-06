# 14. File and Route Index

HTTP verbs below were extracted by script from `apps/api/src/*-routes.ts` and may be re-checked against the source. All routes except `/health*`, `/auth/login` and the bootstrap `/setup/*` routes require a signed-in session; the permission key is enforced in each handler. `/internal/*` routes require the control secret and are used only by the desktop shell.

## 1. API routes (apps/api/src)

| Method and path                                                                                                                          | File                         | Permission key (as reviewed)                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| GET /health, GET /health/db                                                                                                              | `app.ts`                     | none                                                                                               |
| POST /auth/login                                                                                                                         | `auth-routes.ts`             | none (rate limited, lockout)                                                                       |
| POST /auth/logout, POST /auth/change-password, GET /auth/me                                                                              | `auth-routes.ts`             | signed in                                                                                          |
| GET /setup/status, GET/PUT /setup/draft, POST /setup/complete                                                                            | `setup-routes.ts`            | bootstrap only while no organization exists                                                        |
| GET /business-profile; PUT /business-profile                                                                                             | `business-profile-routes.ts` | `org.settings.read`; `org.settings.update`                                                         |
| GET /dashboard/summary                                                                                                                   | `dashboard-routes.ts`        | signed in                                                                                          |
| GET /customers, GET /customers/:id; POST /customers; PATCH /customers/:id                                                                | `customer-routes.ts`         | `customer.read`; `customer.write`                                                                  |
| GET /products, /products/:id, /products/references, /products/references/hsn-sac; POST /products; PATCH /products/:id                    | `product-routes.ts`          | `product.read`; `product.write`                                                                    |
| GET /warehouses, GET /inventory/stock, GET /inventory/movements, GET /inventory/movements/:id (plus movement creation)                   | `inventory-routes.ts`        | `warehouse.read`, `inventory.stock.read`, stock write keys                                         |
| POST /invoices/preview                                                                                                                   | `invoice-routes.ts`          | `sales.invoice.write`                                                                              |
| POST /invoices                                                                                                                           | `invoice-routes.ts`          | `sales.invoice.post`                                                                               |
| GET /invoices, GET /invoices/:id (and print/PDF data)                                                                                    | `invoice-routes.ts`          | `sales.invoice.read`                                                                               |
| POST /payments; GET /payments, /payments/:id                                                                                             | `payment-routes.ts`          | `sales.payment.record`; `sales.payment.read`                                                       |
| GET /receivables, /receivables/customers/:customerId                                                                                     | `payment-routes.ts`          | `sales.payment.read`                                                                               |
| GET /orders, /orders/:id; POST /orders; PUT /orders/:id; POST /orders/:id/status                                                         | `sales-order-routes.ts`      | `sales.order.read`; `sales.order.write`                                                            |
| GET /tax/configuration, /tax/configuration/reviews, /tax/hsn-sac                                                                         | `tax-routes.ts`              | `tax.config.read`                                                                                  |
| POST /tax/configuration/reviews, POST /tax/billing-mode, PUT /tax/hsn-requirement, POST/PATCH /tax/hsn-sac, POST /tax/hsn-sac/:id/review | `tax-routes.ts`              | `tax.config.update`, `tax.config.review`                                                           |
| GET /roles, GET /users, GET /users/:id; POST /users; POST /users/:id/disable, /enable, /reset-password; PUT /users/:id/roles             | `user-routes.ts`             | `security.role.read`, `security.user.read`, `security.user.manage`, `security.user.reset_password` |
| GET /backup/status, /backup/history, /backup/readiness                                                                                   | `backup-routes.ts`           | `backup.history.read`                                                                              |
| POST /backup, POST /backup/:id/verify, PUT /backup/retention, POST /backup/retention/apply                                               | `backup-routes.ts`           | `backup.create`                                                                                    |
| POST /backup/restore/inspect, POST /backup/restore                                                                                       | `backup-routes.ts`           | `backup.restore`                                                                                   |
| PUT /internal/backup/destination, POST /internal/backup/restore-source                                                                   | `backup-routes.ts`           | control secret                                                                                     |

Not present: any route for audit logs, reports, purchasing, credit notes, e-invoice, uploads or webhooks.

## 2. UI routes (apps/web/src/App.tsx and nav.ts)

Setup wizard (first run), sign-in, dashboard, `/billing` (list), `/billing/new`, `/billing/:id`, `/billing/:id/print`, `/billing/:id/payment`, `/orders` (list, new, detail), `/customers` (list, new, edit), `/products` (list, new, edit), `/inventory`, `/inventory/:productId/:action`, `/receivables`, `/tax`, `/tax/hsn-sac`, `/settings` (Business Profile, Backup, Diagnostics). Confirm exact paths against `App.tsx`; this list is from the navigation and the test names.

## 3. Key source files

| Concern                                               | File                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| API assembly, helmet, CORS, rate limit, log redaction | `apps/api/src/app.ts`                                                                           |
| Launch-secret check                                   | `apps/api/src/launch-secret.ts`                                                                 |
| Electron main, security policy, preload               | `apps/desktop/src/{main,security,preload}.ts`                                                   |
| Managed PostgreSQL runtime                            | `apps/desktop/src/runtime/`                                                                     |
| Renderer shell and navigation                         | `apps/web/src/{App.tsx,nav.ts,api.ts,messages.ts}`                                              |
| CSP                                                   | `apps/web/index.html`                                                                           |
| Schema                                                | `prisma/schema.prisma`; migrations in `prisma/migrations/` (14)                                 |
| Tax calculation                                       | `packages/tax-engine/src/calculate.ts`                                                          |
| Invoice posting                                       | `packages/invoicing/src/{facts,service,validate}.ts`                                            |
| Numbering                                             | `packages/numbering/src/validate.ts`                                                            |
| Stock                                                 | `packages/inventory-engine/src/`                                                                |
| Payments                                              | `packages/payments/src/validate.ts`                                                             |
| Orders                                                | `packages/sales-orders/src/`                                                                    |
| Invoice document                                      | `packages/document-engine/src/{model,html}.ts`                                                  |
| Backup/restore                                        | `packages/backup/src/`                                                                          |
| Seller/GST/PAN rules                                  | `packages/setup/src/seller-rules.ts`                                                            |
| Authentication                                        | `packages/auth/src/`                                                                            |
| Env validation                                        | `packages/validation/src/env.ts`                                                                |
| Gate scripts                                          | `scripts/verify-phase0.*`, `scripts/verify-release.*`                                           |
| Project truth                                         | `docs/PROJECT_STATE.md`, `docs/RISK_REGISTER.md`, `docs/REQUIREMENTS_MATRIX.md`, ADRs 0001-0031 |
| Packaging                                             | `scripts/package-win.*`, `tests/release/`                                                       |
