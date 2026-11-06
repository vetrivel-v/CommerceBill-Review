# 12. Architecture and Data Diagrams

All diagrams are Mermaid. They show what **exists today**; planned items are marked dashed.

## 1. System context and runtime

```mermaid
flowchart LR
  User([Cashier / Owner]) --> Shell
  subgraph PC[Windows 11 laptop - single machine]
    subgraph Shell[Electron shell - apps/desktop]
      Main[Main process: window, security, supervisor, backup dialogs]
      Renderer[Sandboxed renderer - React app on app://commercebill]
      Preload[Preload bridge]
      Renderer <--> Preload <--> Main
    end
    Main -->|spawns, launch secret| API[Fastify API - 127.0.0.1 - apps/api]
    Renderer -->|HTTP + launch secret header| API
    Main -->|manages| PG[(Embedded PostgreSQL 18 beta)]
    API -->|Prisma 7 + adapter-pg| PG
    API --> Domain[Domain packages: invoicing, tax-engine, inventory-engine, payments, sales-orders, auth, backup, setup]
    Main --> DPAPI[Windows DPAPI via safeStorage]
    Main --> Files[(Encrypted .cbbackup files)]
  end
  Ext[E-invoice, e-way bill, marketplaces, gateways, email]:::planned -. not built .-> API
  classDef planned stroke-dasharray: 5 5;
```

## 2. Invoice posting sequence

```mermaid
sequenceDiagram
  participant UI as Billing screen
  participant API as POST /invoices
  participant Svc as invoicing service
  participant Tax as tax-engine
  participant DB as PostgreSQL
  UI->>API: preview request (lines, customer, place of supply)
  API->>Tax: calculate (pure, exact decimals)
  Tax-->>UI: totals and tax split
  UI->>API: post (operationId)
  API->>Svc: validate permission, production gate, facts
  Svc->>DB: BEGIN
  Svc->>DB: allocate number (gap-free, FY sequence)
  Svc->>DB: stock dispatch movements (advisory lock)
  Svc->>DB: insert invoice + lines + snapshots
  Svc->>DB: audit row
  Svc->>DB: COMMIT
  DB-->>UI: immutable invoice (trigger blocks later edits)
```

## 3. Core entity-relationship diagram

```mermaid
erDiagram
  organizations ||--o{ users : has
  organizations ||--o{ business_locations : has
  organizations ||--o{ financial_years : has
  organizations ||--o{ customers : has
  organizations ||--o{ products : has
  users ||--o{ user_roles : has
  roles ||--o{ user_roles : granted
  roles ||--o{ role_permissions : holds
  permissions ||--o{ role_permissions : in
  users ||--o{ sessions : opens
  customers ||--o{ sales_orders : places
  sales_orders ||--o{ sales_order_lines : contains
  sales_orders ||--o{ sales_order_events : history
  customers ||--o{ sales_invoices : billed
  sales_invoices ||--o{ sales_invoice_lines : contains
  products ||--o{ sales_invoice_lines : sold
  products ||--o{ stock_movements : ledger
  warehouses ||--o{ stock_movements : at
  warehouses ||--o{ stock_balances : holds
  products ||--o{ stock_balances : counted
  sales_invoices ||--o{ payment_allocations : settled_by
  payments ||--o{ payment_allocations : allocates
  customers ||--o{ payments : pays
  tax_categories ||--o{ tax_rates : priced
  tax_categories ||--o{ products : classifies
  hsn_sac_codes ||--o{ products : codes
  document_sequences ||--o{ document_number_allocations : issues
  sales_invoices }o--|| document_number_allocations : numbered
  organizations ||--o{ audit_logs : records
  organizations ||--o{ backup_records : logs
  backup_records ||--o{ backup_verifications : verified_by
```

## 4. Sales order status machine (DB-enforced)

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> CONFIRMED
  DRAFT --> CANCELLED
  CONFIRMED --> IN_PROGRESS
  CONFIRMED --> CANCELLED
  IN_PROGRESS --> READY
  READY --> CLOSED
  CANCELLED --> [*]
  CLOSED --> [*]
```

The exact transitions are enforced by a database trigger and mirrored in `packages/sales-orders`; consult that package for the authoritative list (the diagram is a summary).

## 5. Backup and restore flow

```mermaid
flowchart TD
  A[Create backup] --> B[Logical dump]
  B --> C[AES-256-GCM chunked archive, scrypt key from passphrase]
  C --> D[.cbbackup file + record]
  D --> E[Verify: restore into isolated DB, integrity checks]
  E -->|pass| F[Gate fact BACKUP_RESTORE_VERIFIED]
  G[Restore request] --> H[Inspect archive]
  H --> I[Maintenance mode]
  I --> J[Verified safety backup of current DB]
  J --> K[Swap databases, keep previous renamed]
```

## 6. Authentication and authorization

```mermaid
flowchart LR
  Login[POST /auth/login] --> Argon[Argon2id check + lockout]
  Argon --> Sess[Session: random token, hash stored]
  Sess --> Guard[auth-guard on each route]
  Guard --> Perm[Permission key per route]
  Perm --> Handler
```

## 7. Planned (not built) integration architecture

E-invoice/IRN, e-way bill, marketplace import and payment gateway would attach at the API boundary through `integration-core` (README only today). Card data must never enter the system; use hosted checkout and signed idempotent webhooks.
