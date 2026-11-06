// MTO-1 (ADR-0031): the upgrade of a populated pre-MTO database, and recovery of MTO-era data. Real PostgreSQL, fictional data.
//   A. A database at the previous schema, with products, stock, a customer and a posted invoice, is protected by a verified safety backup
//      and then migrated: every product stays valid with the approved role and mode, history is byte-for-byte unchanged, units and the
//      order sequence appear. (The normal Restore screen refuses a backup of another schema by design: backup-restore.int.test.ts.)
//   B. A backup of a database that holds item roles, orders, lines, events and sequence state is verified (restored into an isolated
//      database, content identical), and the restore-time integrity checks catch a corrupted order.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyMigrations,
  applyPendingMigrations,
  createDatabase,
  createPreUpgradeBackup,
  dropDatabase,
  readMigrations,
  runIntegrityChecks,
  verifyPreUpgradeBackup,
  withDatabaseName,
  type BackupManifest,
} from '@commercebill/backup';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  call,
  createFixture,
  createRoleUsers,
  type ApiJson,
  type Fixture,
} from './auth-fixture.js';
import { setupBillingWorld, type BillingWorld } from './invoice-fixture.js';

const migrationsDir = resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
const MTO = '_mto_1_items_and_sales_orders';
const PASS = 'a long safety passphrase for tests';

type Row = Record<string, unknown>;
const q = async (url: string, sql: string, params: unknown[] = []): Promise<Row[]> => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as Row[];
  } finally {
    await c.end();
  }
};

describe('A. upgrading a populated pre-MTO database', () => {
  let adminUrl: string;
  let name: string;
  let url: string;
  let dir: string;
  let previous: string;
  let orgId: string;
  const ids: Record<string, string> = {};
  /** A fingerprint of every row of the tables the migration must not touch (the text of each whole row, in a fixed order). */
  const IMMUTABLE = [
    'customers',
    'sales_invoices',
    'sales_invoice_lines',
    'stock_movements',
    'stock_balances',
    'document_number_allocations',
    'financial_years',
    'users',
    'warehouses',
    'business_locations',
  ];
  const fingerprints = async () => {
    const out: Record<string, string> = {};
    for (const t of IMMUTABLE)
      out[t] = String(
        (
          await q(
            url,
            `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
          )
        )[0]!.h,
      );
    return out;
  };

  beforeAll(async () => {
    adminUrl = withDatabaseName(inject('pgAdminUrl'), 'postgres');
    name = `cb_mto_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await createDatabase(adminUrl, name);
    url = withDatabaseName(adminUrl, name);
    dir = mkdtempSync(join(tmpdir(), 'cb-mto-'));
    const all = (await readMigrations(migrationsDir)).map((m) => m.name);
    const at = all.findIndex((n) => n.endsWith(MTO));
    expect(at).toBeGreaterThan(0);
    previous = all[at - 1]!;
    await applyMigrations(url, migrationsDir, { upTo: previous });

    // a populated database at the PREVIOUS structure (plain SQL: the application code of that time is gone)
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const one = async (sql: string, p: unknown[] = []) =>
      (await c.query(sql, p)).rows[0]!.id as string;
    orgId = await one(
      `INSERT INTO organizations (legal_name, updated_at) VALUES ('Old Co (fictional)', now()) RETURNING id`,
    );
    for (const [code, nm, dp] of [
      ['PCS', 'Pieces', 0],
      ['KG', 'Kilogram', 3],
      ['G', 'Gram', 0],
    ] as const)
      ids[code] = await one(
        `INSERT INTO units (organization_id, code, name, decimal_places, updated_at) VALUES ($1,$2,$3,$4, now()) RETURNING id`,
        [orgId, code, nm, dp],
      );
    ids.tax = await one(
      `INSERT INTO tax_categories (organization_id, code, name, classification, updated_at) VALUES ($1,'GST_0_NIL','Nil rated','NIL_RATED', now()) RETURNING id`,
      [orgId],
    );
    ids.rate = await one(
      `INSERT INTO tax_rates (organization_id, category_id, rate_percent, effective_from, updated_at) VALUES ($1,$2,0,'2017-07-01', now()) RETURNING id`,
      [orgId, ids.tax],
    );
    ids.fy = await one(
      `INSERT INTO financial_years (organization_id, label, start_date, end_date, updated_at) VALUES ($1,'2026-27','2026-04-01','2027-03-31', now()) RETURNING id`,
      [orgId],
    );
    ids.loc = await one(
      `INSERT INTO business_locations (organization_id, name, address_line1, state_code, gstin, is_primary, updated_at) VALUES ($1,'Head Office','1 Old Road','27','27TESTP1234X1ZM', true, now()) RETURNING id`,
      [orgId],
    );
    ids.wh = await one(
      `INSERT INTO warehouses (organization_id, location_id, code, name, is_primary, updated_at) VALUES ($1,$2,'MAIN','Main', true, now()) RETURNING id`,
      [orgId, ids.loc],
    );
    ids.user = await one(
      `INSERT INTO users (organization_id, username, display_name, password_hash, updated_at) VALUES ($1,'old.user','Old User','x', now()) RETURNING id`,
      [orgId],
    );
    await c.query(
      `INSERT INTO document_sequences (organization_id, financial_year_id, document_type, prefix, suffix, numeric_length, start_number, reset_policy, is_active, last_number, updated_at)
       VALUES ($1,$2,'INVOICE','INV/{FY}/','',8,1,'FINANCIAL_YEAR',true,3, now())`,
      [orgId, ids.fy],
    );
    const product = (
      sku: string,
      kind: string,
      unit: string | null,
      track: boolean,
      price: string,
    ) =>
      one(
        `INSERT INTO products (organization_id, sku, name, kind, unit_id, tax_category_id, selling_price, track_inventory, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) RETURNING id`,
        [orgId, sku, `Item ${sku}`, kind, unit, ids.tax, price, track],
      );
    ids.tracked = await product('OLD-TRACKED', 'GOODS', ids.PCS!, true, '100.00');
    ids.untracked = await product('OLD-UNTRACKED', 'GOODS', ids.PCS!, false, '250.00');
    ids.service = await product('OLD-SERVICE', 'SERVICE', null, false, '999.00');
    await c.query(
      `INSERT INTO stock_movements (organization_id, warehouse_id, product_id, movement_type, quantity_delta, business_date, source_type, source_ref, created_by)
       VALUES ($1,$2,$3,'OPENING_STOCK', 10, '2026-10-01', 'MANUAL', 'op-1', $4)`,
      [orgId, ids.wh, ids.tracked, ids.user],
    );
    ids.cust = await one(
      `INSERT INTO customers (organization_id, code, customer_kind, legal_name, billing_address_line1, billing_state_code, place_of_supply_state_code, updated_at)
       VALUES ($1,'C-1','INDIVIDUAL','Old Buyer','2 Old Lane','27','27', now()) RETURNING id`,
      [orgId],
    );
    // a posted (demo) invoice with one line: written with replication triggers off, exactly as a past version stored it
    await c.query('SET session_replication_role = replica');
    const h = 'a'.repeat(64);
    ids.inv = await one(
      `INSERT INTO sales_invoices (organization_id, status, post_operation_id, request_fingerprint, document_type, document_number, is_demo, invoice_date, financial_year_id, financial_year_label,
         currency, location_id, warehouse_id, warehouse_name, seller_legal_name, seller_gstin, seller_gst_status, seller_state_code, seller_address_line1, customer_id, customer_code, customer_name,
         customer_gst_status, billing_address_line1, billing_state_code, shipping_address_line1, shipping_state_code, recipient_class, pos_state_code, pos_source, pos_confirmed_by, pos_confirmed_at,
         price_basis, engine_version, ruleset_version, rounding_policy_id, tax_input_hash, tax_configuration_fingerprint, tax_calculation,
         gross_subtotal, line_discount_total, taxable_subtotal, cgst_total, sgst_total, utgst_total, igst_total, rounding_adjustment_total, round_off, grand_total, created_by)
       VALUES ($1,'POSTED',$2,$3,'DEMO_INVOICE','DEMO/2026-27/00000001',true,'2026-10-02',$4,'2026-27','INR',$5,$6,'Main','Old Co (fictional)','27TESTP1234X1ZM','REGISTERED','27','1 Old Road',$7,'C-1','Old Buyer',
         'UNREGISTERED','2 Old Lane','27','2 Old Lane','27','B2C','27','USER_CONFIRMED',$8, now(),'EXCLUSIVE','1.0.0','FUB-GST-1','HALF_UP_PAISE_V1',$3,$3,'{}'::jsonb,
         500,0,500,0,0,0,0,0,0,500,$8) RETURNING id`,
      [orgId, randomUUID(), h, ids.fy, ids.loc, ids.wh, ids.cust, ids.user],
    );
    await c.query(
      `INSERT INTO sales_invoice_lines (invoice_id, organization_id, line_no, product_id, sku, product_name, item_kind, unit_code, unit_name, tax_category_id, tax_category_code, tax_category_name,
         classification, tax_rate_id, rate_percent, rate_effective_from, quantity, unit_price, price_basis, gross_amount, discount_type, discount_amount, taxable_value, line_total, stock_effect)
       VALUES ($1,$2,1,$3,'OLD-UNTRACKED','Item OLD-UNTRACKED','GOODS','PCS','Pieces',$4,'GST_0_NIL','Nil rated','NIL_RATED',$5,0,'2017-07-01',2,250,'EXCLUSIVE',500,'NONE',0,500,500,'NONE')`,
      [ids.inv, orgId, ids.untracked, ids.tax, ids.rate],
    );
    await c.end();
  }, 120_000);

  afterAll(async () => {
    await dropDatabase(adminUrl, name).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a verified safety backup of the old structure is made first, and the migration then applies', async () => {
    const backup = await createPreUpgradeBackup({
      databaseUrl: url,
      destDir: join(dir, 'safety'),
      passphrase: PASS,
      appVersion: '0.1.0',
    });
    const file = join(
      dir,
      'safety',
      readdirSync(join(dir, 'safety')).find((f) => f.endsWith('.cbbackup'))!,
    );
    expect(backup).toBeTruthy();
    const verified = await verifyPreUpgradeBackup({
      file,
      passphrase: PASS,
      databaseUrl: url,
      migrationsDir,
    });
    expect(verified.ok, JSON.stringify(verified.checks)).toBe(true);
    expect(verified.manifest!.schemaVersion).toBe(previous);
    // the normal restore refuses another schema (tested in backup-restore); the supported path is the migration below
    const before = await fingerprints();
    const applied = await applyPendingMigrations(url, migrationsDir);
    expect(applied.some((n) => n.endsWith(MTO))).toBe(true);
    // nothing historical was rewritten, byte for byte
    expect(await fingerprints()).toEqual(before);
    expect(await applyPendingMigrations(url, migrationsDir)).toEqual([]); // running it again changes nothing
  }, 180_000);

  it('every existing item is valid: SELLABLE, tracked goods STOCKED, untracked goods MADE_TO_ORDER, the service has no mode', async () => {
    const rows = await q(
      url,
      `SELECT sku, item_role, fulfilment_mode, track_inventory, selling_price::text AS price, version FROM products ORDER BY sku`,
    );
    expect(rows).toEqual([
      {
        sku: 'OLD-SERVICE',
        item_role: 'SELLABLE',
        fulfilment_mode: null,
        track_inventory: false,
        price: '999.00',
        version: 1,
      },
      {
        sku: 'OLD-TRACKED',
        item_role: 'SELLABLE',
        fulfilment_mode: 'STOCKED',
        track_inventory: true,
        price: '100.00',
        version: 1,
      },
      {
        sku: 'OLD-UNTRACKED',
        item_role: 'SELLABLE',
        fulfilment_mode: 'MADE_TO_ORDER',
        track_inventory: false,
        price: '250.00',
        version: 1,
      },
    ]);
  });

  it('history keeps its meaning: stock, the invoice and the customer are intact, and the invoice is still immutable', async () => {
    expect(await q(url, `SELECT quantity_on_hand::text AS q FROM stock_balances`)).toEqual([
      { q: '10.0000' },
    ]);
    expect(
      (
        await q(
          url,
          `SELECT count(*)::int AS n FROM sales_invoices WHERE document_number = 'DEMO/2026-27/00000001'`,
        )
      )[0]!.n,
    ).toBe(1);
    await expect(q(url, `UPDATE sales_invoices SET status = 'POSTED'`)).rejects.toThrow(
      /immutable/,
    );
    await expect(q(url, `DELETE FROM sales_invoice_lines`)).rejects.toThrow(/immutable/);
    // the item guard is live: a non-sellable item cannot be invoiced, even by direct SQL
    const mat = (
      await q(
        url,
        `INSERT INTO products (organization_id, sku, name, kind, item_role, unit_id, tax_category_id, track_inventory, updated_at) VALUES ($1,'MAT-1','Filament','GOODS','RAW_MATERIAL',$2,$3,true, now()) RETURNING id`,
        [orgId, ids.PCS, ids.tax],
      )
    )[0]!.id as string;
    await expect(
      q(
        url,
        `INSERT INTO sales_invoice_lines (invoice_id, organization_id, line_no, product_id, sku, product_name, item_kind, unit_code, unit_name, tax_category_id, tax_category_code, tax_category_name, classification, tax_rate_id, rate_percent, rate_effective_from, quantity, unit_price, price_basis, gross_amount, discount_type, discount_amount, taxable_value, line_total, stock_effect)
              VALUES ($1,$2,2,$3,'MAT-1','Filament','GOODS','PCS','Pieces',$4,'GST_0_NIL','Nil rated','NIL_RATED',$5,0,'2017-07-01',1,1,'EXCLUSIVE',1,'NONE',0,1,1,'NONE')`,
        [ids.inv, orgId, mat, ids.tax, ids.rate],
      ),
    ).rejects.toThrow();
  });

  it('units and numbering: grams accept one decimal, sheet and spool exist, the order sequence appears beside the untouched invoice sequence', async () => {
    expect(
      await q(
        url,
        `SELECT code, decimal_places FROM units WHERE code IN ('G','SHEET','SPOOL') ORDER BY code`,
      ),
    ).toEqual([
      { code: 'G', decimal_places: 1 },
      { code: 'SHEET', decimal_places: 0 },
      { code: 'SPOOL', decimal_places: 0 },
    ]);
    const seq = await q(
      url,
      `SELECT document_type, prefix, numeric_length, start_number::text AS start, last_number::text AS last FROM document_sequences ORDER BY document_type`,
    );
    expect(seq).toEqual([
      { document_type: 'INVOICE', prefix: 'INV/{FY}/', numeric_length: 8, start: '1', last: '3' }, // unchanged
      {
        document_type: 'SALES_ORDER',
        prefix: 'SO/{FY}/',
        numeric_length: 8,
        start: '1',
        last: '0',
      }, // same width, nothing consumed
    ]);
  });

  it('the migration only adds: it never updates, deletes from or alters an immutable history table', () => {
    const sql = readFileSync(
      join(
        migrationsDir,
        `${readdirSync(migrationsDir).find((n) => n.endsWith(MTO))!}`,
        'migration.sql',
      ),
      'utf8',
    ).replace(/--[^\n]*/g, '');
    for (const t of [
      'sales_invoices',
      'sales_invoice_lines',
      'payments',
      'payment_allocations',
      'stock_movements',
      'stock_balances',
      'customers',
      'document_number_allocations',
    ]) {
      expect(sql, t).not.toMatch(new RegExp(`UPDATE\\s+"?${t}"?\\b`, 'i'));
      expect(sql, t).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+"?${t}"?\\b`, 'i'));
      expect(sql, t).not.toMatch(new RegExp(`ALTER\\s+TABLE\\s+"?${t}"?\\b`, 'i'));
      expect(sql, t).not.toMatch(new RegExp(`DROP\\s+TABLE\\s+"?${t}"?\\b`, 'i'));
    }
  });
});

describe('B. recovering a database that holds item roles, sales orders, lines, events and sequence state', () => {
  let fx: Fixture;
  let app: FastifyInstance;
  let world: BillingWorld;
  let tokens: Record<string, string>;
  let dir: string;
  let orderId: string;
  const j = (r: { json: ApiJson }) => r.json as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    fx = await createFixture(inject('pgAdminUrl'));
    app = await fx.makeApp({
      env: { LOG_LEVEL: 'silent' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    });
    tokens = await createRoleUsers(app, fx.orgId);
    world = await setupBillingWorld(fx);
    dir = mkdtempSync(join(tmpdir(), 'cb-mto-b-'));
    await fx.prisma.product.create({
      data: {
        organizationId: fx.orgId,
        sku: 'MAT-B',
        name: 'Filament',
        kind: 'GOODS',
        itemRole: 'RAW_MATERIAL',
        unitId: world.unit.pcs,
        taxCategoryId: world.taxId.GST_18,
        sellingPrice: null,
        trackInventory: true,
      } as never,
    });
    const r = await call(app, 'POST', '/orders', {
      token: tokens['Administrator']!,
      body: {
        operationId: randomUUID(),
        channel: 'AMAZON',
        externalOrderId: 'EXT-B-1',
        buyer: { name: 'Recovery Buyer (fictional)' },
        shipping: { line1: '1 Recovery Road', stateCode: '27' },
        lines: [
          {
            productId: world.products.untracked,
            quantity: '2',
            agreedUnitPrice: '250.00',
            customization: 'Name: Rita',
          },
        ],
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    orderId = j(r).order.id as string;
    await call(app, 'POST', `/orders/${orderId}/status`, {
      token: tokens['Administrator']!,
      body: { toStatus: 'CONFIRMED', expectedVersion: 1 },
    });
  }, 180_000);
  afterAll(async () => {
    await fx?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a backup carries the new tables and verifies: restored into an isolated database with identical content', async () => {
    const b = await createPreUpgradeBackup({
      databaseUrl: fx.db.url,
      destDir: dir,
      passphrase: PASS,
      appVersion: '0.1.0',
    });
    expect(b).toBeTruthy();
    const file = join(
      dir,
      readdirSync(dir).find((f) => f.endsWith('.cbbackup'))!,
    );
    const v = await verifyPreUpgradeBackup({
      file,
      passphrase: PASS,
      databaseUrl: fx.db.url,
      migrationsDir,
    });
    expect(v.ok, JSON.stringify(v.checks)).toBe(true);
    const m = v.manifest as BackupManifest;
    const rows = Object.fromEntries(m.tables.map((t) => [t.name, t.rows]));
    expect(rows['sales_orders']).toBe(1);
    expect(rows['sales_order_lines']).toBe(1);
    expect(rows['sales_order_events']).toBe(2); // created, confirmed
    expect(rows['products']).toBeGreaterThan(5);
    expect(rows['document_sequences']).toBeGreaterThan(4);
    const seq = await fx.prisma.documentSequence.findFirstOrThrow({
      where: { documentType: 'SALES_ORDER' },
    });
    expect(seq.lastNumber).toBe(1n); // the sequence state is part of what was backed up
  }, 180_000);

  const integrity = async () => {
    const all = await readMigrations(migrationsDir);
    const manifest = {
      organization: { id: fx.orgId },
      schemaVersion: all.at(-1)!.name,
      tables: [],
    } as unknown as BackupManifest;
    return runIntegrityChecks(fx.db.url, {
      manifest,
      expectedSchemaVersion: all.at(-1)!.name,
      migrationSql: all.map((x) => x.sql),
    });
  };

  it('the restore-time integrity checks cover item roles, orders, lines, order numbers and the guarding triggers, and pass on good data', async () => {
    const results = await integrity();
    const by = Object.fromEntries(results.map((r) => [r.name, r.ok]));
    for (const n of [
      'item_roles_consistent',
      'invoice_lines_reference_sellable_items',
      'sales_orders_consistent',
      'sales_order_numbers_issued_by_ledger',
      'protective_triggers_present',
    ])
      expect(by[n], n).toBe(true);
  });

  it('and they CATCH damage: a changed total, an order with no lines, a non-sellable item on an order, an unissued number', async () => {
    const run = async (sql: string, check: string) => {
      const c = new pg.Client({ connectionString: fx.db.url });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica'); // as a load does: triggers off
        await c.query(sql);
        // the checks open their own connection, so commit the damage, look, then restore the row
        await c.query('COMMIT');
        const res = await integrity();
        return res.find((r) => r.name === check)!.ok;
      } finally {
        await c.end();
      }
    };
    const undo = async (sql: string) => {
      const c = new pg.Client({ connectionString: fx.db.url });
      await c.connect();
      await c.query('SET session_replication_role = replica');
      await c.query(sql);
      await c.end();
    };
    expect(
      await run(`UPDATE sales_orders SET total_amount = 1.00`, 'sales_orders_consistent'),
    ).toBe(false);
    await undo(`UPDATE sales_orders SET total_amount = 500.00`);
    expect(
      await run(
        `UPDATE sales_orders SET order_number = 'SO/FORGED/000001'`,
        'sales_order_numbers_issued_by_ledger',
      ),
    ).toBe(false);
    const num = (
      await fx.prisma.documentNumberAllocation.findFirstOrThrow({
        where: { documentType: 'SALES_ORDER' },
      })
    ).formattedNumber;
    await undo(`UPDATE sales_orders SET order_number = '${num}'`);
    // an order line pointing at a non-sellable item (the line trigger is off during a load, so the check must catch it)
    expect(
      await run(
        `UPDATE sales_order_lines SET product_id = (SELECT id FROM products WHERE sku = 'MAT-B')`,
        'sales_orders_consistent',
      ),
    ).toBe(false);
    await undo(`UPDATE sales_order_lines SET product_id = '${world.products.untracked}'`);
    expect(await run(`DELETE FROM sales_order_lines`, 'sales_orders_consistent')).toBe(false);
    expect((await integrity()).find((r) => r.name === 'sales_orders_consistent')!.ok).toBe(false); // still damaged: proves the check is not stuck on
  }, 120_000);
});
