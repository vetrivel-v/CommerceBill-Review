# 08. Test and Quality Report

Only existing, non-destructive commands were run, on 2026-11-06 on the owner's Windows 11 machine, against the working tree at HEAD `eee6d75` plus the documentation-only changes of this review. Nothing was fixed or modified to make a result pass. Integration tests create and delete their own throwaway PostgreSQL clusters under the system temp folder; they do not touch the application's own data folder.

## 1. Commands and results

| #   | Command                                                         | Result                                                  | Counts                                              | Runtime                                                                                                                                |
| --- | --------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm run typecheck`                                             | **Passed** (every workspace plus root)                  | n/a                                                 | not timed (tens of seconds)                                                                                                            |
| 2   | `npm run format:check`                                          | **Passed**: "All matched files use Prettier code style" | n/a                                                 | few seconds                                                                                                                            |
| 3   | `npm run lint` (`eslint .`)                                     | **Passed**, no output                                   | n/a                                                 | not timed; the machine is memory-constrained and an earlier attempt in a different session had to be re-run per folder (environmental) |
| 4   | `npm test` (`vitest run --project unit`)                        | **Passed**                                              | 48 files, **639 tests passed**, 0 failed, 0 skipped | 21.2 s (log shows 29 s wall)                                                                                                           |
| 5   | `npm run test:integration` (`vitest run --project integration`) | **Passed**                                              | 53 files, **782 tests passed**, 0 failed, 0 skipped | 1,417 s (23.6 min)                                                                                                                     |
| 6   | `npm audit`                                                     | 17 vulnerabilities (16 moderate, 1 high)                | see `07_…` S-01                                     | seconds                                                                                                                                |
| 7   | `npm audit --omit=dev`                                          | 1 moderate (`fast-uri`)                                 | see `07_…`                                          | seconds                                                                                                                                |

Not run, deliberately: `npm run test:release` and `npm run verify:release` / `verify:phase0` (these build the Windows installer and write to the `release/` folder, which is a build side effect beyond a read-only review), the packaged-installer smoke tests, anything that starts the real application against the owner's data, and any database reset or seed. The release gate was last passed on the exact committed tree at the previous milestone (see `docs/PROJECT_STATE.md`).

Total automated tests executed in this review: **1,421 passed, 0 failed, 0 skipped** (639 + 782). The integration project includes the `tests/migration` suite, the Electron end-to-end journey and the real-API UI suites.

## 2. Test inventory

| Layer                         | Location                                        | Content                                                                                                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                          | beside source (`*.test.ts[x]`) and `tests/unit` | Tax engine (including property tests), numbering, money, validation, document model/HTML, payments validation, sales-order rules, UI components and forms, setup rules, auth primitives                                                                     |
| Integration (real PostgreSQL) | `tests/integration` (39 files)                  | Auth and users, setup, customers, products, inventory, invoices, payments, orders, tax configuration, business profile, backup/restore, runtime/upgrade/orphan recovery, PDF generation, Electron shell and a full billing journey in the real Electron app |
| Migration                     | `tests/migration` (12 files)                    | Schema invariants, triggers, constraints, numbering invariants, upgrade paths                                                                                                                                                                               |
| Security                      | `tests/security` (2)                            | Argon2id hashing behaviour (plain and inside Electron). Launch-secret and Electron policy tests live beside their source (`apps/api`, `apps/desktop`) and in `tests/integration/electron-shell`                                                             |
| Recovery                      | `tests/recovery` (1 test file plus spikes)      | Logical dump/restore round trip. Crash/kill/orphan recovery is in `tests/integration/runtime`                                                                                                                                                               |
| Release                       | `tests/release` (2)                             | Installer content and packaging checks (not run here)                                                                                                                                                                                                       |

## 3. Coverage assessment

| Area                                                 | Strength                                                  | Gaps                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| Tax arithmetic, rounding                             | Strong (property-based)                                   | Rates unreviewed; no cross-check against an independent GST calculator    |
| Invoice posting atomicity, idempotency, immutability | Strong                                                    | No concurrency stress with many simultaneous posters                      |
| Numbering gap-freeness                               | Strong                                                    | No test of invoice-number length (a missing rule, G-GST-02)               |
| Stock ledger, negative stock                         | Strong                                                    | Single warehouse only                                                     |
| Payments and receivables                             | Good                                                      | No overdue/ageing (not built)                                             |
| Backup, restore, upgrade                             | Very strong                                               | No external-media test, no power-loss test on real hardware               |
| Auth and permissions                                 | Good (53 user-admin tests)                                | No test enumerating every route against its permission key                |
| UI                                                   | Component tests plus real-API UI journeys                 | Visual/print output and native dialogs unverified; no accessibility audit |
| Performance/load                                     | **None**                                                  | Volume, memory and startup-time budgets absent                            |
| Security testing                                     | Policy tests only                                         | No fuzzing, no dependency-confusion or SAST tooling in CI, no pen test    |
| Coverage metrics                                     | **Not measured** (no coverage run configured in the gate) | Add `vitest --coverage` as a non-blocking report                          |

## 4. Quality observations

- Deterministic gates (typecheck, format, lint, unit, integration, release) exist and a documented rule says the gate must pass on the exact committed tree.
- Known environmental sensitivity: under memory pressure the suite can fail on unrelated tests (risk R-104). This run completed without failure; it still took 23.6 minutes, which is long for a developer loop.
- No CI configuration is present in the repository (no `.github` folder); the gate is a local script.
- Four packages contain only a README, and nine `integrations/*` and four `templates/*` folders are placeholders.

## 5. Residual manual verification

Install/uninstall/upgrade on the target laptop; native Save/Print dialogs and a physical printer; power-cut recovery; restore from an external drive; accountant review of printed invoices.
