# 07. Security and Privacy Review

Method: static review of source, configuration and tests against OWASP ASVS 5.0 Level 2 _principles_ (authentication, session, access control, validation, cryptography, error/logging, data protection, configuration). This is **not** a penetration test, not an ASVS certification, and makes **no PCI DSS claim**. No secret values appear in this document; only names are shown.

## 1. Cardholder and payment data

- **No storage of PAN, CVV, PIN, or track data was found.** Payments record method, amount, date, and a free-text reference only. The reference validator actively **rejects** values that look like card numbers (`looksLikeCardNumber`, `packages/payments/src/validate.ts:73`, reason `looks_like_card_number`).
- No payment gateway integration exists (`integrations/payment-gateways` is a README). When one is added, use hosted/tokenized checkout so card data never reaches this system; store only gateway reference, status and last-four if needed.

## 2. Findings

Severity: Critical / High / Medium / Low / Info. Critical and High items carry full detail.

### S-01 (High) Known high-severity dependency advisory in the desktop shell

- **Evidence:** `npm audit` reports 17 vulnerabilities (16 moderate, 1 high). The high advisory is on Electron, which is declared as a development dependency but is the runtime packaged inside the installer, so it matters for shipped builds. `npm audit --omit=dev` reports 1 moderate (`fast-uri`, several advisories, reachable through Fastify's JSON/AJV libraries). Both appeared after the 2026-10-29 baseline.
- **Exploit scenario:** A renderer or protocol flaw in the pinned Electron build is chained with a content-injection bug to escape the sandbox. Exposure is reduced because the renderer is sandboxed, loads only `app://commercebill`, and no remote content is shown, but the shell is the outermost trust boundary.
- **Business effect:** Local compromise of the billing machine and its data.
- **Remediation:** Review the advisory, upgrade Electron to the first patched release in the supported line, re-run the full gate and the packaged E2E.
- **Verification test:** `npm audit --omit=dev` clean for high/critical; `verify:release` and `fub-electron.int` pass.
- **Break risk:** Medium (Electron major/minor changes can affect the preload bridge, the `app://` protocol and PDF printing).
- **Rollback:** Revert the lockfile and rebuild the installer; data is unaffected.

### S-02 (High) Backup passphrase is unrecoverable and there is no automated off-computer copy

- **Evidence:** ADR-0027 and risks R-098/R-099: the passphrase is never stored; no scheduling; previous database kept renamed after restore.
- **Exploit/failure scenario:** Disk failure or theft with only on-machine backups, or a forgotten passphrase, makes every backup unreadable.
- **Business effect:** Total loss of accounting records.
- **Remediation:** A guided "copy to external drive" step with a verification receipt, a printed recovery sheet process, and (later) scheduled backups.
- **Verification test:** Restore-from-external-media scenario in `backup-restore.int`.
- **Break risk:** Low. **Rollback:** disable the new step.

### S-03 (High, conditional) Installer is unsigned

- **Evidence:** NSIS per-user installer, no code signing (user decision: signing later).
- **Exploit scenario:** A tampered installer is distributed or SmartScreen warnings train users to ignore prompts.
- **Remediation:** Obtain a code-signing certificate, sign installer and executables, publish SHA-256 alongside releases.
- **Verification:** `Get-AuthenticodeSignature` valid; installer hash published.
- **Break risk:** Low. **Rollback:** ship the previous build.

### S-04 (Medium) Single-organization login assumption

- `packages/auth` resolves the organization from the single installed business; adding multi-tenant hosting later needs an explicit tenant selector at login. No cross-tenant risk exists today (one organization per installation).

### S-05 (Medium) No row-level security

- Tenant isolation depends on application filtering by `organization_id` plus cross-organization triggers. Acceptable for one organization per database; revisit before any hosted multi-tenant model.

### S-06 (Medium) No audit read or export path

- `audit_logs` is append-only but cannot be reviewed in the product (R-063). Detective control is therefore weak for a reviewer or auditor.

### S-07 (Medium) CSP allows inline styles

- `apps/web/index.html` sets `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:5173`. Scripts are strictly self-hosted (good). `unsafe-inline` styles and the development websocket origin are broader than needed in the packaged build; the web socket origin should not ship in production.

### S-08 (Low) Developer database credential default

- `scripts/lib/env.ts` carries a local developer PostgreSQL credential for the throwaway dev cluster on loopback only (classified as a dev default, not a production secret; value intentionally not repeated here). `docker-compose.yml` binds to loopback.

### S-09 (Low) Large dependency-major pins

- TypeScript 6, Vite 8, Vitest 5, Prisma 7, React 19, Electron 44 and PostgreSQL 18 (beta) are very new; ecosystem fixes may lag. Embedded PostgreSQL 18 beta in production is itself a risk.

### S-10 (Info) Positive controls observed

- Argon2id password hashing, lockout counters, hashed session tokens, last-administrator protection.
- Fastify with helmet, restricted CORS, rate limiting, per-launch secret header, 127.0.0.1 binding, log redaction (`apps/api/src/app.ts`, `launch-secret.ts`).
- Electron: sandbox, context isolation, preload bridge, custom `app://` protocol, navigation/permission restrictions (`apps/desktop/src/security.ts`).
- Credentials protected by Windows DPAPI (`safeStorage`); backups AES-256-GCM with scrypt-derived key.
- Immutable posted invoices and append-only ledgers (trigger-enforced).
- Input validation at API boundaries; exact decimal handling; permission keys on every route.

## 3. ASVS 5.0 L2 principle map (summary)

| Area                       | Status                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| Authentication             | Strong local controls; no MFA, no password-reset by email (not applicable offline)            |
| Session management         | Hashed tokens, expiry, revocation; local only                                                 |
| Access control             | Role/permission per route; users/roles screens are API-only                                   |
| Validation / encoding      | Schema validation at boundaries; React escaping; HTML invoice generated from escaped snapshot |
| Cryptography               | Standard algorithms (Argon2id, AES-256-GCM, scrypt, SHA-256); key handling through DPAPI      |
| Error handling and logging | Redacted logs; no audit viewer                                                                |
| Data protection            | Local only; backups encrypted; no PII classification or retention policy                      |
| Configuration              | Env names validated; secrets not in repo                                                      |
| Business logic             | Strong immutability and idempotency; corrections missing                                      |

## 4. Privacy notes

Customer names, addresses, GSTINs and phone/email are stored in plain database columns (the database is local and protected by OS file permissions only). No retention, consent or deletion workflow exists; customers are never deleted. If the product is ever hosted, add data-protection obligations review (India DPDP Act) and encryption at rest.
