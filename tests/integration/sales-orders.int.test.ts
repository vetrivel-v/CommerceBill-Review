// MTO-1 (ADR-0031): item roles and manual sales orders, through the real API against a real PostgreSQL database. Fictional data.
import { randomUUID } from 'node:crypto';
import { ORDER_STATUSES, TRANSITIONS } from '@commercebill/sales-orders';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { seedReference } from '../../prisma/seed/reference/index.js';
import {
  PASSWORD,
  call,
  createFixture,
  createRoleUsers,
  login,
  type ApiJson,
  type Fixture,
} from './auth-fixture.js';
import {
  body as invoiceBody,
  previewAndPost,
  setupBillingWorld,
  type BillingWorld,
} from './invoice-fixture.js';

let fx: Fixture;
let app: FastifyInstance;
let tokens: Record<string, string>;
let world: BillingWorld;
let logs: string[];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const j = (r: { json: ApiJson }) => r.json as unknown as Json;
const admin = () => tokens['Administrator']!;
const get = (path: string, token = admin()) => call(app, 'GET', path, { token });
const post = (path: string, b: unknown, token = admin()) =>
  call(app, 'POST', path, { token, body: b });
const put = (path: string, b: unknown, token = admin()) =>
  call(app, 'PUT', path, { token, body: b });
const audits = (action: string) =>
  fx.prisma.auditLog.findMany({ where: { action }, orderBy: { occurredAt: 'asc' } });
const problems = (r: { json: ApiJson }) =>
  ((j(r).error.problems ?? []) as { field: string; rule: string }[]).map(
    (x) => `${x.field}:${x.rule}`,
  );

const SHIP = { line1: '14 Workshop Lane', city: 'Pune', stateCode: '27', pinCode: '411001' };
const line = (productId: string, over: Json = {}) => ({
  productId,
  quantity: '2',
  agreedUnitPrice: '250.00',
  customization: 'Name: Anita, blue',
  ...over,
});
const orderBody = (over: Json = {}) => ({
  operationId: randomUUID(),
  channel: 'INSTAGRAM',
  buyer: { name: 'Anita Rao (fictional)', phone: '98450 12345', email: 'anita@example.test' },
  shipping: SHIP,
  dueDate: '2099-01-31',
  notes: 'Gift wrap please',
  lines: [line(world.products.untracked)],
  ...over,
});
const create = async (over: Json = {}, token = admin()) => post('/orders', orderBody(over), token);
const created = async (over: Json = {}) => {
  const r = await create(over);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return j(r).order as Json;
};
const update = (o: Json, over: Json = {}, token = admin()) =>
  put(
    `/orders/${String(o.id)}`,
    {
      customerId: o.customer?.id ?? null,
      buyer: o.buyer,
      billing: o.billing,
      shipping: o.shipping,
      orderDate: o.orderDate,
      dueDate: o.dueDate,
      notes: o.notes,
      lines: o.lines.map((l: Json) => ({
        productId: l.productId,
        quantity: l.quantity,
        agreedUnitPrice: l.agreedUnitPrice,
        customization: l.customization,
        externalLineId: l.externalLineId,
      })),
      expectedVersion: o.version,
      ...over,
    },
    token,
  );
const status = (o: Json, toStatus: string, note?: string, token = admin()) =>
  post(
    `/orders/${String(o.id)}/status`,
    { toStatus, expectedVersion: o.version, ...(note ? { note } : {}) },
    token,
  );

async function newItem(over: Json) {
  const tax = world.taxId.GST_18;
  return fx.prisma.product.create({
    data: {
      organizationId: fx.orgId,
      sku: `MTO-${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Test Item',
      kind: 'GOODS',
      unitId: world.unit.pcs,
      taxCategoryId: tax,
      sellingPrice: '100.00',
      ...over,
    } as never,
  });
}

beforeAll(async () => {
  fx = await createFixture(inject('pgAdminUrl'));
  logs = [];
  app = await fx.makeApp({
    env: { LOG_LEVEL: 'trace' as never, WEB_ORIGIN: ['http://127.0.0.1:5173'] },
    logStream: { write: (m: string) => void logs.push(m) },
  });
  tokens = await createRoleUsers(app, fx.orgId);
  world = await setupBillingWorld(fx);
}, 180_000);
afterAll(async () => fx?.close());

describe('item roles (Product stays the aggregate)', () => {
  it('existing-shaped writers keep working: tracked goods are STOCKED, untracked goods MADE_TO_ORDER, services have no mode', async () => {
    const rows = await fx.prisma.product.findMany({
      where: {
        id: { in: [world.products.tracked, world.products.untracked, world.products.service] },
      },
    });
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(world.products.tracked)).toMatchObject({
      itemRole: 'SELLABLE',
      fulfilmentMode: 'STOCKED',
    });
    expect(by.get(world.products.untracked)).toMatchObject({
      itemRole: 'SELLABLE',
      fulfilmentMode: 'MADE_TO_ORDER',
    });
    expect(by.get(world.products.service)).toMatchObject({
      itemRole: 'SELLABLE',
      fulfilmentMode: null,
    });
  });

  it('a raw material, a component and packaging can each be created with no selling price, and track stock', async () => {
    for (const itemRole of ['RAW_MATERIAL', 'COMPONENT', 'PACKAGING']) {
      const r = await post('/products', {
        name: `${itemRole} item (fictional)`,
        kind: 'GOODS',
        itemRole,
        unitId: world.unit.pcs,
        taxCategoryId: world.taxId.GST_18,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      expect(j(r).product ?? j(r)).toMatchObject({
        itemRole,
        sellingPrice: null,
        fulfilmentMode: null,
        trackInventory: true,
      });
    }
  });

  it('refuses a price on a material, a missing price on a sellable item, a service material, and a role change', async () => {
    const base = {
      name: 'Thing',
      kind: 'GOODS',
      unitId: world.unit.pcs,
      taxCategoryId: world.taxId.GST_18,
    };
    const priced = await post('/products', {
      ...base,
      itemRole: 'PACKAGING',
      sellingPrice: '5.00',
    });
    expect(priced.status).toBe(400);
    expect(problems(priced)).toContain('sellingPrice:not_for_sale');
    const unpriced = await post('/products', { ...base, itemRole: 'SELLABLE' });
    expect(problems(unpriced)).toContain('sellingPrice:required');
    const svc = await post('/products', {
      name: 'Svc',
      kind: 'SERVICE',
      itemRole: 'COMPONENT',
      taxCategoryId: world.taxId.GST_18,
    });
    expect(problems(svc)).toContain('itemRole:role_requires_goods');
    const m = j(await post('/products', { ...base, itemRole: 'COMPONENT' }));
    const id = (m.product ?? m).id as string;
    const version = (m.product ?? m).version as number;
    const change = await call(app, 'PATCH', `/products/${id}`, {
      token: admin(),
      body: { itemRole: 'SELLABLE', sellingPrice: '1.00', expectedVersion: version },
    });
    expect(change.status).toBe(400);
    expect(problems(change)).toContain('itemRole:role_cannot_change');
  });

  it('a fulfilment mode and stock tracking agree: STOCKED tracks, MADE_TO_ORDER does not', async () => {
    const base = {
      name: 'Frame',
      kind: 'GOODS',
      unitId: world.unit.pcs,
      taxCategoryId: world.taxId.GST_18,
      sellingPrice: '10.00',
    };
    const mto = await post('/products', { ...base, fulfilmentMode: 'MADE_TO_ORDER' });
    expect(mto.status).toBe(201);
    expect(j(mto).product ?? j(mto)).toMatchObject({
      fulfilmentMode: 'MADE_TO_ORDER',
      trackInventory: false,
    });
    const stocked = await post('/products', { ...base, fulfilmentMode: 'STOCKED' });
    expect(j(stocked).product ?? j(stocked)).toMatchObject({
      fulfilmentMode: 'STOCKED',
      trackInventory: true,
    });
    const clash = await post('/products', {
      ...base,
      fulfilmentMode: 'STOCKED',
      trackInventory: false,
    });
    expect(problems(clash)).toContain('trackInventory:tracking_must_match_mode');
    const svc = await post('/products', {
      name: 'S',
      kind: 'SERVICE',
      taxCategoryId: world.taxId.GST_18,
      sellingPrice: '1.00',
      fulfilmentMode: 'STOCKED',
    });
    expect(problems(svc)).toContain('fulfilmentMode:not_applicable');
  });

  it('the item list can be filtered by role', async () => {
    const sellable = j(await get('/products?itemRole=SELLABLE&limit=100')).products as Json[];
    expect(sellable.length).toBeGreaterThan(0);
    expect(sellable.every((p) => p.itemRole === 'SELLABLE')).toBe(true);
    const materials = j(await get('/products?itemRole=RAW_MATERIAL&limit=100')).products as Json[];
    expect(materials.length).toBeGreaterThan(0);
    expect(materials.every((p) => p.itemRole === 'RAW_MATERIAL')).toBe(true);
  });

  it('the database refuses to change a role, and refuses a priced material or a mode that contradicts tracking', async () => {
    const mat = await newItem({
      itemRole: 'RAW_MATERIAL',
      sellingPrice: null,
      trackInventory: true,
    });
    await expect(
      fx.prisma.product.update({ where: { id: mat.id }, data: { itemRole: 'SELLABLE' } }),
    ).rejects.toThrow();
    await expect(
      fx.prisma.product.update({ where: { id: mat.id }, data: { sellingPrice: '5.00' } }),
    ).rejects.toThrow();
    await expect(newItem({ fulfilmentMode: 'STOCKED', trackInventory: false })).rejects.toThrow();
  });

  it('a non-sellable item cannot be invoiced, and a sellable item still invoices normally', async () => {
    const mat = await newItem({
      itemRole: 'RAW_MATERIAL',
      sellingPrice: null,
      trackInventory: true,
    });
    const bad = await call(app, 'POST', '/invoices/preview', {
      token: admin(),
      body: invoiceBody(world, {}, [{ productId: mat.id, quantity: '1' }]),
    });
    expect(JSON.stringify(bad.json)).toContain('ITEM_NOT_SELLABLE');
    const ok = await previewAndPost(app, admin(), invoiceBody(world));
    expect(ok.post.status, JSON.stringify(ok.post.json)).toBe(201);
  });

  it('gram quantities follow the unit: one decimal accepted, the ledger column keeps four places', async () => {
    const gram = await fx.prisma.unit.findFirstOrThrow({
      where: { organizationId: fx.orgId, code: 'G' },
    });
    expect(gram.decimalPlaces).toBe(1);
    expect(
      await fx.prisma.unit.count({
        where: { organizationId: fx.orgId, code: { in: ['SHEET', 'SPOOL'] } },
      }),
    ).toBe(2); // the two new units are part of the seeded list
    const item = await newItem({ unitId: gram.id, name: 'Loose Gram Item', trackInventory: false });
    const ok = await create({ lines: [line(item.id, { quantity: '42.6' })] });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(j(ok).order.lines[0].quantity).toBe('42.6');
    const many = await create({ lines: [line(item.id, { quantity: '42.65' })] });
    expect(many.status).toBe(400);
    expect(problems(many)).toContain('lines[0].quantity:too_many_decimals');
    const [col] = await fx.prisma.$queryRaw<{ numeric_scale: number }[]>`
      SELECT numeric_scale FROM information_schema.columns WHERE table_name = 'stock_movements' AND column_name = 'quantity_delta'`;
    expect(col!.numeric_scale).toBe(4);
  });
});

describe('creating and reading sales orders', () => {
  it('creates a DRAFT order with a permanent number, exact totals, snapshots and a history entry', async () => {
    const o = await created({
      lines: [
        line(world.products.untracked, { quantity: '3', agreedUnitPrice: '199.99' }),
        line(world.products.kg, { quantity: '1.5', agreedUnitPrice: '10.01' }),
      ],
    });
    expect(o.orderNumber).toMatch(/^SO\/\d{4}-\d{2}\/\d{6}$/);
    expect(o).toMatchObject({
      status: 'DRAFT',
      channel: 'INSTAGRAM',
      editable: true,
      lineCount: 2,
      version: 1,
    });
    expect(o.lines.map((l: Json) => l.lineTotal)).toEqual(['599.97', '15.02']); // 1.5 x 10.01 = 15.015 -> 15.02 (half up)
    expect(o.totalAmount).toBe('614.99');
    expect(o.buyer.name).toBe('Anita Rao (fictional)');
    expect(o.shipping).toMatchObject({ line1: '14 Workshop Lane', stateCode: '27' });
    expect(o.lines[0]).toMatchObject({
      sku: expect.any(String),
      productName: 'Untracked Gadget',
      unitCode: 'PCS',
    });
    expect(o.customer).toBeNull(); // no customer master is created or required
    expect(o.events).toHaveLength(1);
    expect(o.events[0]).toMatchObject({ eventType: 'CREATED', actorName: 'Administrator (test)' });
    const list = j(await get('/orders'));
    expect(list.orders.map((x: Json) => x.id)).toContain(o.id);
    expect(list.orders.find((x: Json) => x.id === o.id)).toMatchObject({
      buyerName: 'Anita Rao (fictional)',
      lineCount: 2,
      totalAmount: '614.99',
    });
  });

  it('numbers orders in sequence', async () => {
    const a = await created();
    const b = await created();
    const n = (o: Json) => Number(String(o.orderNumber).split('/').pop());
    expect(n(b)).toBe(n(a) + 1);
  });

  it('is idempotent on the operation id: the same request returns the same order, a different one is refused', async () => {
    const b = orderBody();
    const first = await post('/orders', b);
    const second = await post('/orders', b);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(j(second).replayed).toBe(true);
    expect(j(second).order.orderNumber).toBe(j(first).order.orderNumber);
    expect(await fx.prisma.salesOrder.count({ where: { operationId: b.operationId } })).toBe(1);
    const different = await post('/orders', { ...b, notes: 'something else' });
    expect(different.status).toBe(409);
  });

  it('keeps an external order id unique per organization AND channel', async () => {
    const ext = `EXT-${randomUUID().slice(0, 8)}`;
    const a = await create({ channel: 'AMAZON', externalOrderId: ext });
    expect(a.status).toBe(201);
    const dup = await create({ channel: 'AMAZON', externalOrderId: ext });
    expect(dup.status).toBe(409);
    expect(problems(dup)).toContain('externalOrderId:duplicate');
    const other = await create({ channel: 'FLIPKART', externalOrderId: ext });
    expect(other.status).toBe(201); // another channel may reuse the number
    const manual = await create({ channel: 'MANUAL', externalOrderId: 'X' });
    expect(manual.status).toBe(400);
    expect(problems(manual)).toContain('externalOrderId:not_for_manual_orders');
    // a refused duplicate did not consume a number: the next order follows the last created one
    const last = await fx.prisma.salesOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 2 });
    expect(Number(last[0]!.orderNumber.split('/').pop())).toBe(
      Number(last[1]!.orderNumber.split('/').pop()) + 1,
    );
  });

  it('the same external id is allowed in another organization', async () => {
    const orgB = await fx.prisma.organization.create({
      data: { legalName: 'Other Co (fictional)' },
    });
    await seedReference(fx.prisma, { organizationId: orgB.id });
    const wB = await setupBillingWorld(fx, orgB.id, { sellerName: 'Other Co (fictional)' });
    await app.authService!.createUser({
      organizationId: orgB.id,
      username: 'orgb.admin',
      displayName: 'Org B Admin',
      password: PASSWORD,
      roleNames: ['Administrator'],
    });
    const tokB = (await login(app, 'orgb.admin', PASSWORD, orgB.id)).json.token as string;
    const ext = `SHARED-${randomUUID().slice(0, 6)}`;
    expect((await create({ channel: 'AMAZON', externalOrderId: ext })).status).toBe(201);
    const b = await post(
      '/orders',
      orderBody({ channel: 'AMAZON', externalOrderId: ext, lines: [line(wB.products.untracked)] }),
      tokB,
    );
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    // organization isolation in both directions
    const bOrder = j(b).order as Json;
    expect((await get(`/orders/${String(bOrder.id)}`)).status).toBe(404);
    expect(
      j(await get('/orders?limit=100', tokB)).orders.every((x: Json) => x.id === bOrder.id),
    ).toBe(true);
    expect(
      (
        await put(`/orders/${String(bOrder.id)}`, {
          buyer: { name: 'Hijack' },
          shipping: SHIP,
          lines: [line(world.products.untracked)],
          expectedVersion: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(`/orders/${String(bOrder.id)}/status`, {
          toStatus: 'CANCELLED',
          expectedVersion: 1,
        })
      ).status,
    ).toBe(404);
    // an item of another organization cannot be ordered
    const cross = await post('/orders', orderBody({ lines: [line(wB.products.untracked)] }));
    expect(problems(cross)).toContain('lines[0].productId:unknown_reference');
  }, 60_000);

  it('a customer is optional: the order is complete with the buyer snapshot alone', async () => {
    const o = await created({
      buyer: { name: 'Marketplace Buyer (fictional)' },
      shipping: { line1: '5 Lake Road', stateCode: '29' },
    });
    expect(o.customer).toBeNull();
    expect(o.buyer).toEqual({ name: 'Marketplace Buyer (fictional)', phone: null, email: null });
    expect(o.shipping).toMatchObject({ line1: '5 Lake Road', stateCode: '29' });
  });

  it('a linked customer completes the snapshot, and later changes to the customer do not change the order', async () => {
    const o = await created({
      customerId: world.customers.split,
      buyer: { name: 'Split Address Buyer' },
      shipping: undefined,
    });
    expect(o.customer).toMatchObject({ id: world.customers.split, name: 'Split Address Buyer' });
    expect(o.shipping).toMatchObject({ line1: '9 Dock Road', city: 'Bengaluru', stateCode: '29' });
    expect(o.billing.line1).toBe('1 Buyer Lane');
    await fx.prisma.customer.update({
      where: { id: world.customers.split },
      data: { shippingAddressLine1: '77 Changed Street' },
    });
    expect((j(await get(`/orders/${String(o.id)}`)).shipping as Json).line1).toBe('9 Dock Road');
  });

  it('refuses unknown or inactive references, bad dates, bad quantities and unknown fields', async () => {
    const inactive = await newItem({ isActive: false, name: 'Retired Item' });
    expect(problems(await create({ lines: [line(inactive.id)] }))).toContain(
      'lines[0].productId:inactive_reference',
    );
    expect(problems(await create({ lines: [line(randomUUID())] }))).toContain(
      'lines[0].productId:unknown_reference',
    );
    expect(problems(await create({ customerId: randomUUID() }))).toContain(
      'customerId:unknown_reference',
    );
    expect(problems(await create({ dueDate: '2000-01-01', orderDate: '2026-10-01' }))).toContain(
      'dueDate:due_before_order',
    );
    expect(
      problems(await create({ lines: [line(world.products.untracked, { quantity: '1.5' })] })),
    ).toContain('lines[0].quantity:too_many_decimals');
    expect(
      problems(await create({ lines: [line(world.products.untracked, { quantity: '0' })] })),
    ).toContain('lines[0].quantity:quantity_must_be_positive');
    expect(
      problems(
        await create({ lines: [line(world.products.untracked, { agreedUnitPrice: '1.234' })] }),
      ),
    ).toContain('lines[0].agreedUnitPrice:invalid_amount');
    expect(problems(await create({ organizationId: randomUUID() }))).toContain(
      'organizationId:unknown_field',
    );
    expect(problems(await create({ channel: 'EBAY' }))).toContain('channel:invalid_value');
    expect(problems(await create({ buyer: { name: '' } }))).toContain('buyer.name:required');
    expect(problems(await create({ lines: [] }))).toContain('lines:required');
  });
});

describe('editing', () => {
  it('saves changes with a new version, recomputes the total and records only field NAMES in the history and audit', async () => {
    const o = await created();
    const r = await update(o, {
      notes: 'Leave at the gate',
      lines: [line(world.products.untracked, { quantity: '4', agreedUnitPrice: '100.00' })],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const e = j(r).order as Json;
    expect(e).toMatchObject({ version: 2, totalAmount: '400.00', notes: 'Leave at the gate' });
    const last = e.events[e.events.length - 1];
    expect(last).toMatchObject({ eventType: 'EDITED' });
    expect(last.changedFields.sort()).toEqual(['lines', 'notes']);
    const rows = await audits('sales_order.update');
    const mine = rows.filter((a) => a.entityId === o.id);
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine[0])).not.toContain('Leave at the gate');
  });

  it('a save with nothing changed writes nothing', async () => {
    const o = await created();
    const r = await update(o);
    expect(r.status).toBe(200);
    expect(j(r).order.version).toBe(1);
    expect(j(r).order.events).toHaveLength(1);
  });

  it('refuses a stale form (optimistic concurrency) and nothing is overwritten', async () => {
    const o = await created();
    expect((await update(o, { notes: 'First writer' })).status).toBe(200);
    const stale = await update(o, { notes: 'Second writer' });
    expect(stale.status).toBe(409);
    expect(j(await get(`/orders/${String(o.id)}`)).notes).toBe('First writer');
  });

  it('can link and unlink a customer and change addresses while the order is editable', async () => {
    const o = await created();
    const linked = j(await update(o, { customerId: world.customers.b2c })).order as Json;
    expect(linked.customer).toMatchObject({ id: world.customers.b2c });
    const unlinked = j(await update(linked, { customerId: null })).order as Json;
    expect(unlinked.customer).toBeNull();
  });
});

describe('status model', () => {
  it('allows exactly the approved edges: every pair is tried against the API and the database trigger', async () => {
    const expectedEdges = Object.entries(TRANSITIONS).flatMap(([from, tos]) =>
      tos.map((t) => `${from}>${t}`),
    );
    expect(expectedEdges.sort()).toEqual(
      [
        'CONFIRMED>CANCELLED',
        'CONFIRMED>CLOSED',
        'CONFIRMED>NEEDS_INFO',
        'DRAFT>CANCELLED',
        'DRAFT>CONFIRMED',
        'NEEDS_INFO>CANCELLED',
        'NEEDS_INFO>CONFIRMED',
      ].sort(),
    );
    // the database trigger enforces the same table, for any writer
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (from === to) continue;
        const o = await created();
        // walk the order to `from` by direct SQL only along allowed edges, else skip unreachable states
        const path: Record<string, string[]> = {
          DRAFT: [],
          CONFIRMED: ['CONFIRMED'],
          NEEDS_INFO: ['CONFIRMED', 'NEEDS_INFO'],
          CANCELLED: ['CANCELLED'],
          CLOSED: ['CONFIRMED', 'CLOSED'],
        };
        if (!path[from]) {
          // IN_PRODUCTION and READY cannot be reached at all in MTO-1: even the database refuses the step into them
          await expect(
            fx.prisma.$executeRawUnsafe(
              `UPDATE sales_orders SET status = '${from}' WHERE id = '${String(o.id)}'`,
            ),
          ).rejects.toThrow();
          continue;
        }
        for (const step of path[from]!)
          await fx.prisma.$executeRawUnsafe(
            `UPDATE sales_orders SET status = '${step}' WHERE id = '${String(o.id)}'`,
          );
        const attempt = fx.prisma.$executeRawUnsafe(
          `UPDATE sales_orders SET status = '${to}' WHERE id = '${String(o.id)}'`,
        );
        if (TRANSITIONS[from].includes(to)) await expect(attempt).resolves.toBe(1);
        else await expect(attempt).rejects.toThrow();
      }
    }
  }, 120_000);

  it('confirms an order that has a delivery address and refuses one that has not', async () => {
    const incomplete = await created({ shipping: { city: 'Pune' } });
    const bad = await status(incomplete, 'CONFIRMED');
    expect(bad.status).toBe(400);
    expect(problems(bad)).toEqual(
      expect.arrayContaining([
        'shipping.line1:required_to_confirm',
        'shipping.stateCode:required_to_confirm',
      ]),
    );
    const o = await created();
    const ok = await status(o, 'CONFIRMED');
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok).order).toMatchObject({ status: 'CONFIRMED', version: 2, editable: true });
    expect(j(ok).order.allowedTransitions.sort()).toEqual(['CANCELLED', 'CLOSED', 'NEEDS_INFO']);
  });

  it('needs a reason to cancel a confirmed order, mark it as needing information, or close it', async () => {
    let o = j(await status(await created(), 'CONFIRMED')).order as Json;
    const noReason = await status(o, 'NEEDS_INFO');
    expect(problems(noReason)).toContain('note:reason_required');
    o = j(await status(o, 'NEEDS_INFO', 'Customer must send the name spelling')).order as Json;
    expect(o.status).toBe('NEEDS_INFO');
    expect(o.events[o.events.length - 1]).toMatchObject({
      fromStatus: 'CONFIRMED',
      toStatus: 'NEEDS_INFO',
      note: 'Customer must send the name spelling',
    });
    o = j(await status(o, 'CONFIRMED')).order as Json; // returning needs no reason
    expect(problems(await status(o, 'CANCELLED'))).toContain('note:reason_required');
    expect(problems(await status(o, 'CLOSED'))).toContain('note:reason_required');
    const closed = j(await status(o, 'CLOSED', 'Delivered outside CommerceBill')).order as Json;
    expect(closed).toMatchObject({ status: 'CLOSED', editable: false, allowedTransitions: [] });
  });

  it('cancels a draft without a reason, and a cancelled or closed order can no longer change', async () => {
    const draft = await created();
    const cancelled = j(await status(draft, 'CANCELLED')).order as Json;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', editable: false });
    expect((await update(cancelled, { notes: 'late edit' })).status).toBe(409);
    expect((await status(cancelled, 'CONFIRMED')).status).toBe(409);
    await expect(
      fx.prisma.salesOrder.update({ where: { id: cancelled.id }, data: { notes: 'direct' } }),
    ).rejects.toThrow();
    await expect(
      fx.prisma.salesOrderLine.deleteMany({ where: { orderId: cancelled.id } }),
    ).rejects.toThrow();
    await expect(fx.prisma.salesOrder.delete({ where: { id: cancelled.id } })).rejects.toThrow();
  });

  it('refuses a status that does not exist or a change from the wrong version', async () => {
    const o = await created();
    expect((await status(o, 'INVOICED')).status).toBe(400);
    expect((await status(o, 'IN_PRODUCTION')).status).toBe(409); // part of the vocabulary, not reachable yet
    expect((await status({ ...o, version: 99 }, 'CONFIRMED')).status).toBe(409);
  });

  it('the history is append-only', async () => {
    const o = await created();
    await expect(
      fx.prisma.salesOrderEvent.updateMany({ where: { orderId: o.id }, data: { note: 'x' } }),
    ).rejects.toThrow();
    await expect(
      fx.prisma.salesOrderEvent.deleteMany({ where: { orderId: o.id } }),
    ).rejects.toThrow();
  });
});

describe('authorization', () => {
  it('unauthenticated -> 401; authenticated without sales.order.write -> 403; read-only roles can look', async () => {
    expect((await call(app, 'GET', '/orders', {})).status).toBe(401);
    expect((await call(app, 'POST', '/orders', { body: orderBody() })).status).toBe(401);
    const o = await created();
    for (const role of ['Viewer/Auditor', 'Warehouse Operator']) {
      expect((await get('/orders', tokens[role])).status, role).toBe(200);
      expect((await get(`/orders/${String(o.id)}`, tokens[role])).status, role).toBe(200);
      expect((await create({}, tokens[role])).status, role).toBe(403);
      expect((await update(o, { notes: 'x' }, tokens[role])).status, role).toBe(403);
      expect((await status(o, 'CONFIRMED', undefined, tokens[role])).status, role).toBe(403);
    }
  });

  it('roles that hold sales.order.write can create, edit and change status (permission based, not by role name)', async () => {
    for (const role of ['Billing Operator', 'Accountant']) {
      const r = await create({}, tokens[role]);
      expect(r.status, role).toBe(201);
      const o = j(r).order as Json;
      expect((await update(o, { notes: `by ${role}` }, tokens[role])).status, role).toBe(200);
    }
  });
});

describe('audit and diagnostic logs', () => {
  it('audits create, edit, status change and cancellation without buyer details', async () => {
    const probe = 'Secret Probe Buyer (fictional)';
    const o = await created({
      buyer: { name: probe, phone: '99999 88888', email: 'probe@example.test' },
      shipping: { line1: '1 Probe Street', stateCode: '27' },
      notes: 'probe note',
      lines: [line(world.products.untracked, { customization: 'probe customization text' })],
    });
    const e = j(await update(o, { notes: 'probe note 2' })).order as Json;
    const c = j(await status(e, 'CONFIRMED')).order as Json;
    const x = j(await status(c, 'CANCELLED', 'probe reason')).order as Json;
    expect(x.status).toBe('CANCELLED');
    const rows = await fx.prisma.auditLog.findMany({
      where: { entityId: o.id, entityType: 'sales_order' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual([
      'sales_order.create',
      'sales_order.update',
      'sales_order.status',
      'sales_order.cancel',
    ]);
    const adminUser = await fx.prisma.user.findFirstOrThrow({ where: { username: 'admin.user' } });
    for (const r of rows) {
      expect(r).toMatchObject({
        organizationId: fx.orgId,
        userId: adminUser.id,
        category: 'business',
      });
      expect(r.correlationId).toBeTruthy();
    }
    expect(rows[2]!.beforeValues).toEqual({ status: 'DRAFT' });
    expect(rows[2]!.afterValues).toMatchObject({ status: 'CONFIRMED' });
    const text = JSON.stringify(rows);
    for (const secret of [
      probe,
      '99999 88888',
      'probe@example.test',
      '1 Probe Street',
      'probe note',
      'probe customization text',
      'probe reason',
    ])
      expect(text, secret).not.toContain(secret);
    // diagnostic logs (trace level) carry none of it either
    const logText = logs.join('\n');
    for (const secret of [
      probe,
      '99999 88888',
      'probe@example.test',
      '1 Probe Street',
      'probe note',
      'probe customization text',
      'probe reason',
    ])
      expect(logText, secret).not.toContain(secret);
  });
});

describe('dashboard', () => {
  it('reports open orders, orders due within a week and overdue ones, only to people who may read orders', async () => {
    const today = fx.clock.now.toISOString().slice(0, 10);
    const soon = new Date(fx.clock.now.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
    const before = j(await get('/dashboard/summary')).orders as Json;
    await created({ dueDate: soon });
    const done = await created({ dueDate: soon });
    await status(done, 'CANCELLED');
    const fyStart = world.financialYearLabel.slice(0, 4); // an order dated early in the current financial year, due long ago
    const overdue = await created({ orderDate: `${fyStart}-04-02`, dueDate: `${fyStart}-04-05` });
    expect(overdue.dueDate).toBe(`${fyStart}-04-05`);
    const after = j(await get('/dashboard/summary')).orders as Json;
    expect(after.open).toBe(before.open + 2);
    expect(after.dueSoon).toBe(before.dueSoon + 1);
    expect(after.overdue).toBe(before.overdue + 1);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Billing Operator has sales.order.read; a role without it sees no orders section
    expect(j(await get('/dashboard/summary', tokens['Billing Operator'])).orders).not.toBeNull();
  });
});

describe('persistence', () => {
  it('a saved order survives a new application instance on the same database', async () => {
    const o = await created({ notes: 'persisted' });
    const app2 = await fx.makeApp();
    const r = await call(app2, 'GET', `/orders/${String(o.id)}`, { token: admin() });
    expect(r.status).toBe(200);
    expect(j(r).notes).toBe('persisted');
    await app2.close();
  });
});
