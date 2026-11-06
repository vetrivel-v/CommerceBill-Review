# 02. Repository Structure

Tracked files: 512 (253 TypeScript, 67 TSX, 106 Markdown, 49 JSON, 14 SQL migrations). Excluded from functional analysis (generated, vendor, build or local runtime; all git-ignored and never committed): `node_modules/`, `dist/` (per app), `coverage/`, `release/` (installer output), `.data/` (development PostgreSQL data), `packages/database/src/generated/` (Prisma client), `tsconfig.tsbuildinfo`.

```text
.
├── apps/
│   ├── api/            Fastify local API (23 files): app.ts, *-routes.ts, auth-guard.ts, launch-secret.ts, errors.ts
│   ├── desktop/        Electron shell (30 files): main.ts, preload.ts, api-supervisor.ts, runtime/ (managed PostgreSQL), electron-document.ts, security.ts
│   └── web/            React renderer (78 files): App.tsx, nav.ts, api.ts, per-module folders
│                        (backup, customers, dashboard, inventory, invoices, orders, payments, products, settings, setup, tax)
├── packages/           23 workspace packages
│   ├── auth            sessions, Argon2id, lockout, password policy, user administration
│   ├── backup          encrypted archive, logical dump/restore, verification, pre-upgrade safety backup, integrity checks
│   ├── customers, products, sales-orders, inventory-engine, payments
│   ├── invoicing, tax-engine, tax-config, document-engine, numbering
│   ├── setup           first-run setup, business profile, GST/PAN/PIN rules
│   ├── reference-data  permission catalogue, role templates, units, tax categories
│   ├── shared-types, validation (env), database (Prisma client wrapper), ui (component kit), test-utilities
│   └── accounting-engine, reporting, integration-core, domain   README only (no code)
├── prisma/             schema.prisma, 14 hand-extended SQL migrations, seed/reference
├── tests/              integration (42), migration (12), e2e (3 helpers), unit (2), security (2), recovery (2), release (3)
├── scripts/            dev, db-start, db-migrate, package-win, make-icon, verify-phase0, verify-release
├── docs/               ADRs 0001-0031, completion reports, PROJECT_STATE, REQUIREMENTS_MATRIX, RISK_REGISTER, guides
├── integrations/       amazon, csv, einvoice, ewaybill, flipkart, meesho, payment-gateways, shopify, woocommerce: README placeholders only
├── templates/          invoices, packing-slips, receipts, shipping-labels: README placeholders only (invoice HTML is generated in code)
├── sample-data/, sample-imports/   empty (.gitkeep)
├── docker-compose.yml  optional developer PostgreSQL 17 (loopback only)
├── COMMERCEBILL_MASTER_SPEC_V2.md  3,316-line product specification
└── package.json, tsconfig*.json, vitest.config.ts, eslint.config.js, prisma.config.ts
```

## Module sizes and where the business logic lives

| Area            | Primary location                                                               | Notes                                                            |
| --------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Tax calculation | `packages/tax-engine/src/calculate.ts`, `configuration.ts`, `jurisdictions.ts` | Pure, versioned ruleset `FUB-GST-1`, rounding `HALF_UP_PAISE_V1` |
| Invoice posting | `packages/invoicing/src/{facts,service,validate}.ts`                           | One transaction: numbering, stock, snapshots                     |
| Stock ledger    | `packages/inventory-engine/src/{engine,service,quantity}.ts`                   | Append-only movements, trigger-maintained balances               |
| Documents       | `packages/document-engine/src/{model,html,money,schema}.ts`                    | HTML invoice from the immutable snapshot                         |
| Backup          | `packages/backup/src/*.ts`                                                     | AES-256-GCM chunked archive, scrypt, verification restore        |
| Orders (MTO-1)  | `packages/sales-orders/src/*.ts`                                               | State machine, exact money, service                              |
| UI kit          | `packages/ui/src/*`                                                            | Shell, Card/CardGrid, fields, badges                             |

## Dependency direction (enforced by convention, not tooling)

`apps/*` -> domain packages -> `database` / `shared-types`; web imports only `./browser` subsets of domain packages; `shared-types` is a leaf. No dependency-boundary lint rule was found (risk: a package could import across layers unnoticed).
