# CommerceBill Review Manifest

Read-only architecture handover package. Nothing in the application, database, configuration, dependencies or tests was changed to produce it.

## Repository state reviewed

- Branch: `main`
- Reviewed baseline: `eee6d75` "MTO-1: item roles, fulfilment mode and manual sales orders"; this snapshot is taken from the later source commit `83a6742`, which differs only in synthetic test identifiers, `.gitignore` and documentation.

## Contents

| File                                               | Purpose                                              |
| -------------------------------------------------- | ---------------------------------------------------- |
| `docs/architecture-review/00_EXECUTIVE_SUMMARY.md` | One-page verdict and top findings                    |
| `01_CURRENT_STATE_AND_TECH_STACK.md`               | Stack, entry points, patterns, debt                  |
| `02_REPOSITORY_STRUCTURE.md`                       | Tree and module locations                            |
| `03_FEATURE_INVENTORY.md`                          | Implemented vs missing features, with classification |
| `04_WORKFLOW_ASSESSMENT.md`                        | 20 business workflows traced end to end              |
| `05_DATA_MODEL_AND_INTEGRITY.md`                   | Tables, integrity checks                             |
| `06_GST_AND_BILLING_GAP_ASSESSMENT.md`             | 40-item GST software capability matrix               |
| `07_SECURITY_AND_PRIVACY_REVIEW.md`                | ASVS-principle review, findings S-01..S-10           |
| `08_TEST_AND_QUALITY_REPORT.md`                    | Commands run and exact results                       |
| `09_UX_AND_OPERATIONAL_REVIEW.md`                  | Usability and operations                             |
| `10_GAP_REGISTER.md`                               | Gap records with severity, phase, acceptance         |
| `11_ENHANCEMENT_BACKLOG.md`                        | Phases 0-7 (proposal only)                           |
| `12_ARCHITECTURE_AND_DATA_DIAGRAMS.md`             | Mermaid diagrams                                     |
| `13_OPEN_QUESTIONS.md`                             | Questions for owner, accountant, maintainer          |
| `14_FILE_AND_ROUTE_INDEX.md`                       | API/UI routes and key files                          |

## Accounts

Demo/test usernames are created by the setup wizard on first run or by test fixtures; **passwords are never recorded here**. The installed application's administrator is whatever the owner chose during setup. Test fixtures use obviously synthetic usernames such as `owner` and example addresses under `.test` domains.

## Exclusions policy

Excluded from analysis and from any archive: `node_modules`, build outputs (`dist`, `release`, `coverage`), `.data` (development PostgreSQL), generated Prisma client, `.git`, `.env*` (except `.env.example`), backups, dumps, logs, installers, keys/certificates, and binary assets.

## Limitations

Static review plus the repository's own tests; no penetration test, no load test, no tax or legal review, no inspection of the target laptop, no physical printer test, and no assessment of third-party services (none are integrated).
