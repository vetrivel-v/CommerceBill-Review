# 01. Current State and Technology Stack

Review date: 2026-11-06. Branch `main`, commit `eee6d7500b258ea5642d8a263029319140319086` (the same as `origin/main`). Working tree before this review: clean. Uncommitted changes made during the review: `.gitignore` (strengthened) and the untracked files under `docs/` and the repository root listed in the manifest. No application code, migration, dependency or database was changed.

Status legend used throughout: **Verified** (implemented and proven by an automated test that was seen to pass), **Implemented, not verified**, **Partial**, **Placeholder** (folder or label only), **Planned/documented only**, **Missing**.

## 1. What the product is

CommerceBill is a **local-first Windows desktop billing application** for a small Indian business (INR, GST), built as an Electron shell around a local Fastify API and a private PostgreSQL database that the application starts and stops itself. It is designed for one business computer, offline, one user group, with no cloud, no Docker and no remote access (`docs/adr/0029-windows-packaging-and-local-runtime.md`, `COMMERCEBILL_MASTER_SPEC_V2.md` section 1-5). The business it serves is made-to-order custom manufacturing (3D printing, laser engraving), with orders from Amazon, Flipkart, Instagram and phone (`docs/PROJECT_STATE.md`, "Approved made-to-order roadmap").

Delivered milestones (from `git log`, `docs/PROJECT_STATE.md`): Phase 0 foundation, Phase 1 Tasks 1.0 to 1.18 (FIRST USABLE BILLING for **DEMO** billing), Windows packaging and installer, Business Profile and Settings UX, MTO-1 (item roles and manual sales orders). Production (real) billing is deliberately **off** until an independent professional review of the GST reference data (risk R-040) and other gates are satisfied.

## 2. Stack (evidence: `package.json`, `apps/*/package.json`, `prisma/schema.prisma`, `tsconfig.base.json`)

| Layer            | Technology (declared range)                                                                                                                  | Evidence                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Language         | TypeScript `~6.0`, ESM everywhere; Node `>=22.12` (runs on 24.x here)                                                                        | root `package.json` `engines`, `devDependencies`                               |
| Monorepo         | npm workspaces (`apps/*`, `packages/*`), 3 apps and 23 packages                                                                              | root `package.json` `workspaces`; ADR-0001                                     |
| Desktop shell    | Electron `^44.8.0`; `electron-builder ^26.15.3` (NSIS per-user installer); `tsup` bundles the main process                                   | `apps/desktop/package.json`, `scripts/package-win.ts`                          |
| Frontend         | React `^19.3.1`, React Router `^8.4.0`, TanStack Query `^5.104.3`, Tailwind CSS `^4.3.3`, Vite `^8.3.4`                                      | `apps/web/package.json`                                                        |
| Backend          | Fastify `^5.12.7` with `@fastify/helmet ^13`, `@fastify/cors ^11`, `@fastify/rate-limit ^11`; Zod `^4.6.7` for request envelopes             | `apps/api/package.json`, `apps/api/src/app.ts`                                 |
| Database         | PostgreSQL **18 (embedded-postgres `^18.4.0-beta.17`)**, started by the application; Prisma `^7.10.1` with `@prisma/adapter-pg` / `pg ^8.23` | `package.json`, `prisma/schema.prisma`, `apps/desktop/src/runtime/postgres.ts` |
| Money and maths  | `numeric` columns; exact decimal strings and BigInt in code (no floating point)                                                              | ADR-0004; `packages/tax-engine`, `packages/sales-orders/src/money.ts`          |
| Password hashing | Argon2id via `@node-rs/argon2` (default 64 MiB, time 4, parallelism 1)                                                                       | `packages/auth/src/config.ts`                                                  |
| PDF / printing   | Electron `webContents.printToPDF` and `webContents.print` rendering a server-built HTML invoice (`packages/document-engine`)                 | `apps/desktop/src/electron-document.ts`                                        |
| Tests            | Vitest `^5.0.5` (+ `@vitest/coverage-v8`), Testing Library, jsdom; real PostgreSQL clusters for integration tests                            | `vitest.config.ts`                                                             |
| Lint / format    | ESLint `^10`, typescript-eslint `^8`, Prettier `^3.9`                                                                                        | `eslint.config.js`, `.prettierrc.json`                                         |
| Packaging        | `scripts/package-win.ts` (staging outside the repo, esbuild-bundled API, VC++ DLLs, installer record)                                        | ADR-0029                                                                       |

## 3. Things the repository does **not** contain (verified by search)

No email sender (no SMTP/mail library), no SMS or WhatsApp sending (only an allow-listed `https://wa.me` link in `apps/desktop/src/security.ts`), **no payment-gateway code** (`integrations/*` hold README placeholders only), no marketplace client, no e-invoice or e-way bill client, no cloud storage, no background job runner or scheduler, no telemetry or monitoring service, no container image of the application. `docker-compose.yml` is an optional developer convenience that starts `postgres:17` bound to `127.0.0.1:54329` with throwaway credentials.

## 4. Environment variables (names only; values redacted)

Application configuration (`packages/validation/src/env.ts`, `.env.example`): `NODE_ENV`, `API_HOST`, `API_PORT`, `WEB_ORIGIN`, `LOG_LEVEL`, `DATABASE_URL` (secret-bearing, never printed), `LAUNCH_SECRET` (secret; required when `NODE_ENV=production`), `TEST_DATABASE_ADMIN_URL`.

Runtime and shell: `CONTROL_SECRET` (secret), `COMMERCEBILL_DATA_DIR`, `COMMERCEBILL_MANAGED_DB`, `COMMERCEBILL_PARENT_PID`, `MIGRATIONS_DIR`, `ELECTRON_RENDERER_URL`, `VITE_API_URL`, `LOCALAPPDATA`.

Signing (build time only): `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `CSC_LINK`, `CSC_KEY_PASSWORD` (names appear in `scripts/package-win.ts`; no certificate is in the repository).

Test and smoke modes only: `ELECTRON_E2E`, `ELECTRON_E2E_STAGE`, `ELECTRON_E2E_SCRIPT`, `ELECTRON_E2E_DIR`, `ELECTRON_E2E_ENV`, `ELECTRON_SMOKE`, `ELECTRON_SMOKE_USER`, `ELECTRON_SMOKE_PASSWORD`, `ELECTRON_SMOKE_BACKUP_DIR`, `ELECTRON_SMOKE_BACKUP_PASSPHRASE`, `ELECTRON_SMOKE_SAVE_DIR`, `ELECTRON_BACKUP_SMOKE`, `ELECTRON_DOC_SMOKE`, `ELECTRON_PDF_FIXTURE`, `ELECTRON_PDF_OUT`.

## 5. Entry points

| Entry          | File                                                                                                        | Role                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop main   | `apps/desktop/src/main.ts`                                                                                  | Single-instance lock, managed database start-up (`runtime/startup.ts`), local API child, window, IPC                                                                                                                                |
| Preload bridge | `apps/desktop/src/preload.ts`                                                                               | 10 methods exposed to the renderer (`getAppInfo`, `getApiAccess`, `saveInvoicePdf`, `printInvoice`, `chooseBackupDestination`, `chooseRestoreFile`, `getDiagnostics`, `exportDiagnostics`, `openLogFolder`, `showSafetyPassphrase`) |
| API            | `apps/api/src/main.ts` -> `buildApp` in `apps/api/src/app.ts`                                               | Fastify routes (about 70)                                                                                                                                                                                                           |
| Web UI         | `apps/web/src/main.tsx` -> `App.tsx`                                                                        | React single-page app served from `app://commercebill`                                                                                                                                                                              |
| Scripts        | `scripts/dev.ts`, `db-start.ts`, `db-migrate.ts`, `package-win.ts`, `verify-phase0.ts`, `verify-release.ts` | Developer and release tooling                                                                                                                                                                                                       |

## 6. Architectural patterns and boundaries

- **Domain packages behind services.** Each business area is a package with a pure validation/engine part and a Prisma-backed service (`customers`, `products`, `inventory-engine`, `tax-engine`, `tax-config`, `invoicing`, `payments`, `numbering`, `document-engine`, `sales-orders`, `backup`, `setup`, `auth`). Routes in `apps/api/src/*-routes.ts` only check the request envelope, authenticate, authorize by permission key and call the service.
- **Browser-safe subsets.** Several packages export `./browser` so the UI runs the same validation as the server for early feedback (the server is authoritative).
- **Database as the last line of defence.** About 52 triggers and 216 constraints in 14 migrations enforce immutability, status machines, organization consistency and sellable-only rules for any writer (`prisma/migrations/*`).
- **Immutable documents.** Posted invoices are fully immutable (trigger); payments and allocations are append-only; the receivable balance is derived (ADR-0024, ADR-0026).
- **Security boundaries.** Renderer is sandboxed and isolated; API reachable only on `127.0.0.1` with a per-launch secret header; DPAPI protects stored credentials (ADR-0006, 0010, 0013, 0029).

## 7. Technical debt and coupling observed

1. **Single-organization assumption.** Login resolves the organization only when exactly one active organization exists (`packages/auth/src/service.ts` `resolveOrganizationId`), although all data is `organization_id` scoped. Multi-business use needs explicit organization selection.
2. **Spec drift.** `COMMERCEBILL_MASTER_SPEC_V2.md` describes a much larger product (purchases, accounting, marketplaces, returns). `docs/REQUIREMENTS_MATRIX.md` tracks this, but the spec's later phases are entirely unbuilt.
3. **Empty scaffolding packages.** `packages/accounting-engine`, `packages/reporting`, `packages/integration-core`, `packages/domain` contain only a README (no source).
4. **Dev/prod PostgreSQL version mismatch.** `docker-compose.yml` uses `postgres:17`; the shipped engine is embedded PostgreSQL **18 beta** (risk R-030/R-116).
5. **Direct posting model.** There are no invoice drafts: an invoice is calculated, previewed and posted in one step (`packages/invoicing`), so there is nowhere to save work in progress.
6. **Large review documents.** `docs/RISK_REGISTER.md` (354 KB) and `docs/REQUIREMENTS_MATRIX.md` use very wide Markdown tables that are hard to review; they are the working record.
7. **Pinned very recent majors.** React 19, Router 8, Vite 8, TypeScript 6, ESLint 10, Electron 44, Prisma 7: current, but with a short track record; upgrades are frequent. `npm audit` on 2026-11-06 reports 17 findings (1 high: Electron 44.0 to 44.9 certificate-store advisory; 16 moderate including `fast-uri` in the production chain). See `07_SECURITY_AND_PRIVACY_REVIEW.md`.

## 8. Logging and monitoring

Fastify/pino JSON logs with redaction of authorization, cookies, passwords, tokens and the launch secret, and query strings removed from logged URLs (`apps/api/src/app.ts` `LOG_REDACT_PATHS`). The desktop shell writes size-capped rotated `app.log`, `postgres.log`, `api.log` under `%LOCALAPPDATA%\CommerceBill\logs` with secret redaction (`apps/desktop/src/runtime/logger.ts`), and offers a diagnostics export (Settings, About & Diagnostics). There is no remote monitoring, alerting or metrics.

## 9. File, image and document storage

There is **no file-upload or attachment feature** (attachments are Deferred, R-102/R-123). Generated invoice PDFs are written only where a person chooses via the native save dialog. Backups are encrypted `.cbbackup` files in a chosen folder; safety backups go to `%LOCALAPPDATA%\CommerceBill\backups\pre-upgrade`. Database files live under `%LOCALAPPDATA%\CommerceBill\data\pg`.
