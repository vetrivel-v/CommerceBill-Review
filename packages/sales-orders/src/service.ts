import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@commercebill/database';
import { parseQuantity } from '@commercebill/inventory-engine/browser';
import { NumberingError, type NumberingService } from '@commercebill/numbering';
import type {
  OrderAddress,
  SalesOrderChannel,
  SalesOrderDetail,
  SalesOrderListResponse,
  SalesOrderStatus,
  SalesOrderSummary,
} from '@commercebill/shared-types';
import { lineTotal, sumAmounts } from './money.js';
import {
  OPEN_STATUSES,
  canTransition,
  isEditable,
  needsReason,
  TRANSITIONS,
  type OrderStatus,
} from './states.js';
import {
  MAX_NOTE,
  confirmationProblems,
  validateOrder,
  type Address,
  type NormalizedOrder,
  type Problem,
} from './validate.js';

export type SalesOrderErrorCode =
  | 'not_found'
  | 'validation_failed'
  | 'duplicate_external_order'
  | 'operation_id_reused'
  | 'version_conflict'
  | 'transition_not_allowed'
  | 'not_editable';

export class SalesOrderError extends Error {
  constructor(
    readonly code: SalesOrderErrorCode,
    message: string,
    readonly problems: Problem[] = [],
  ) {
    super(message);
    this.name = 'SalesOrderError';
  }
}

/** The authenticated caller. The organization ALWAYS comes from the session, never from a request. */
export interface SalesOrderContext {
  userId: string;
  organizationId: string;
  correlationId?: string | null;
}

export interface SalesOrderServiceOptions {
  prisma: PrismaClient;
  numbering: NumberingService;
  appVersion?: string;
  clock?: () => Date;
}

type Db = PrismaClient | Prisma.TransactionClient;

const detailInclude = {
  lines: { orderBy: { lineNo: 'asc' } },
  events: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { actor: { select: { displayName: true } } },
  },
  customer: { select: { id: true, code: true, legalName: true, displayName: true } },
} as const satisfies Prisma.SalesOrderInclude;
type DetailRow = Prisma.SalesOrderGetPayload<{ include: typeof detailInclude }>;

const day = (d: Date): string => d.toISOString().slice(0, 10);
const money = (d: { toFixed(dp: number): string }) => d.toFixed(2);
/** Exact quantity text without trailing zeros (the column keeps four places). */
const quantityText = (d: { toFixed(dp: number): string }): string => {
  const t = d.toFixed(4);
  return t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t;
};

/** The business date in India (UTC+5:30), the same convention as invoices. */
const businessToday = (now: Date): string => day(new Date(now.getTime() + 330 * 60_000));

const addressOf = (
  r: DetailRow | Prisma.SalesOrderGetPayload<object>,
  kind: 'billing' | 'shipping',
): OrderAddress =>
  kind === 'billing'
    ? {
        line1: r.billingAddressLine1,
        line2: r.billingAddressLine2,
        city: r.billingCity,
        stateCode: r.billingStateCode,
        pinCode: r.billingPinCode,
      }
    : {
        line1: r.shippingAddressLine1,
        line2: r.shippingAddressLine2,
        city: r.shippingCity,
        stateCode: r.shippingStateCode,
        pinCode: r.shippingPinCode,
      };

const split = (s: string | null): string[] => (s ? s.split(',') : []);

export function createSalesOrderService(options: SalesOrderServiceOptions) {
  const { prisma, numbering } = options;
  const appVersion = options.appVersion ?? '0.0.0';
  const clock = options.clock ?? (() => new Date());

  function summaryOf(
    r: Prisma.SalesOrderGetPayload<object> & { _count?: { lines: number } },
    lineCount: number,
  ): SalesOrderSummary {
    return {
      id: r.id,
      orderNumber: r.orderNumber,
      orderDate: day(r.orderDate),
      channel: r.channel as SalesOrderChannel,
      externalOrderId: r.externalOrderId,
      buyerName: r.buyerName,
      customerId: r.customerId,
      dueDate: r.dueDate ? day(r.dueDate) : null,
      status: r.status as SalesOrderStatus,
      totalAmount: money(r.totalAmount),
      lineCount,
      version: r.version,
    };
  }

  function detailOf(r: DetailRow): SalesOrderDetail {
    const status = r.status as OrderStatus;
    return {
      ...summaryOf(r, r.lines.length),
      buyer: { name: r.buyerName, phone: r.buyerPhone, email: r.buyerEmail },
      billing: addressOf(r, 'billing'),
      shipping: addressOf(r, 'shipping'),
      notes: r.notes,
      customer: r.customer
        ? {
            id: r.customer.id,
            code: r.customer.code,
            name: r.customer.displayName ?? r.customer.legalName,
          }
        : null,
      lines: r.lines.map((l) => ({
        lineNo: l.lineNo,
        productId: l.productId,
        sku: l.sku,
        productName: l.productName,
        unitCode: l.unitCode,
        unitName: l.unitName,
        quantity: quantityText(l.quantity),
        agreedUnitPrice: money(l.agreedUnitPrice),
        lineTotal: money(l.lineTotal),
        customization: l.customization,
        externalLineId: l.externalLineId,
      })),
      events: r.events.map((e) => ({
        id: e.id,
        eventType: e.eventType as 'CREATED' | 'EDITED' | 'STATUS_CHANGED',
        fromStatus: e.fromStatus as SalesOrderStatus | null,
        toStatus: e.toStatus as SalesOrderStatus | null,
        note: e.note,
        changedFields: split(e.changedFields),
        actorName: e.actor.displayName,
        createdAt: e.createdAt.toISOString(),
      })),
      allowedTransitions: [...TRANSITIONS[status]],
      editable: isEditable(status),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async function audit(
    tx: Prisma.TransactionClient,
    ctx: SalesOrderContext,
    action: string,
    entityId: string,
    values: { before?: Prisma.InputJsonObject; after?: Prisma.InputJsonObject },
  ): Promise<void> {
    // Audit rows carry facts about the order (number, channel, statuses, field NAMES), never the buyer, an address or free text.
    await tx.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        category: 'business',
        action,
        entityType: 'sales_order',
        entityId,
        ...(values.before ? { beforeValues: values.before } : {}),
        ...(values.after ? { afterValues: values.after } : {}),
        appVersion,
        correlationId: ctx.correlationId ?? null,
        occurredAt: clock(),
      },
    });
  }

  async function loadDetail(db: Db, organizationId: string, id: string): Promise<DetailRow> {
    const row = await db.salesOrder.findFirst({
      where: { id, organizationId },
      include: detailInclude,
    });
    if (!row) throw new SalesOrderError('not_found', 'Order not found.');
    return row;
  }

  // ------------------------------------------------------------------------------------------------------ reading

  async function list(
    organizationId: string,
    o: {
      status?: OrderStatus | undefined;
      channel?: SalesOrderChannel | undefined;
      search?: string | undefined;
      open?: boolean | undefined;
      dueOnOrBefore?: string | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<SalesOrderListResponse> {
    // LIKE wildcards in the typed text are literal characters.
    const term = o.search?.trim().replace(/[\\%_]/g, (ch) => '\\' + ch);
    const where: Prisma.SalesOrderWhereInput = {
      organizationId,
      ...(o.status ? { status: o.status } : {}),
      ...(o.open ? { status: { in: [...OPEN_STATUSES] } } : {}),
      ...(o.channel ? { channel: o.channel } : {}),
      ...(o.dueOnOrBefore ? { dueDate: { lte: new Date(`${o.dueOnOrBefore}T00:00:00Z`) } } : {}),
      ...(term
        ? {
            OR: [
              { orderNumber: { contains: term, mode: 'insensitive' } },
              { buyerName: { contains: term, mode: 'insensitive' } },
              { externalOrderId: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.salesOrder.findMany({
        where,
        include: { _count: { select: { lines: true } } },
        orderBy: [{ orderDate: 'desc' }, { orderNumber: 'desc' }],
        take: o.limit,
        skip: o.offset,
      }),
      prisma.salesOrder.count({ where }),
    ]);
    return {
      orders: rows.map((r) => summaryOf(r, r._count.lines)),
      total,
      limit: o.limit,
      offset: o.offset,
    };
  }

  async function get(organizationId: string, id: string): Promise<SalesOrderDetail> {
    return detailOf(await loadDetail(prisma, organizationId, id));
  }

  /** Open orders, orders due within a week and overdue ones: three indexed counts, nothing derived in memory. */
  async function dashboardCounts(
    organizationId: string,
    today: string,
  ): Promise<{ open: number; dueSoon: number; overdue: number }> {
    const from = new Date(`${today}T00:00:00Z`);
    const soon = new Date(from.getTime() + 7 * 86_400_000);
    const open = { organizationId, status: { in: [...OPEN_STATUSES] } };
    const [o, dueSoon, overdue] = await Promise.all([
      prisma.salesOrder.count({ where: open }),
      prisma.salesOrder.count({ where: { ...open, dueDate: { gte: from, lte: soon } } }),
      prisma.salesOrder.count({ where: { ...open, dueDate: { lt: from } } }),
    ]);
    return { open: o, dueSoon, overdue };
  }

  // ------------------------------------------------------------------------------------------------------ writing

  /** Resolves every line against the database: a real, SELLABLE item of this organization, a quantity valid for ITS unit, exact totals. */
  async function resolveLines(
    tx: Db,
    organizationId: string,
    lines: NormalizedOrder['lines'],
    alreadyOrdered: ReadonlySet<string>,
  ) {
    const ids = [...new Set(lines.map((l) => l.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: ids }, organizationId },
      include: { unit: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const problems: Problem[] = [];
    const resolved = lines.map((l, i) => {
      const path = `lines[${String(i)}]`;
      const p = byId.get(l.productId);
      if (!p) {
        problems.push({ field: `${path}.productId`, rule: 'unknown_reference' });
        return null;
      }
      if (p.itemRole !== 'SELLABLE')
        problems.push({ field: `${path}.productId`, rule: 'item_not_sellable' });
      // An item retired since it was ordered may stay on an existing order; it cannot be newly added.
      else if (!p.isActive && !alreadyOrdered.has(p.id))
        problems.push({ field: `${path}.productId`, rule: 'inactive_reference' });
      const q = parseQuantity(l.quantity, p.unit?.decimalPlaces ?? 0);
      if (!q.ok) {
        problems.push({ field: `${path}.quantity`, rule: q.rule });
        return null;
      }
      return {
        lineNo: i + 1,
        productId: p.id,
        sku: p.sku,
        productName: p.name,
        unitCode: p.unit?.code ?? '',
        unitName: p.unit?.name ?? '',
        quantity: q.value,
        agreedUnitPrice: l.agreedUnitPrice,
        lineTotal: lineTotal(q.value, l.agreedUnitPrice),
        customization: l.customization,
        externalLineId: l.externalLineId,
      };
    });
    if (problems.length > 0)
      throw new SalesOrderError('validation_failed', 'Some details need correcting.', problems);
    const rows = resolved.filter((r): r is NonNullable<typeof r> => r !== null);
    return { rows, total: sumAmounts(rows.map((r) => r.lineTotal)) };
  }

  const fill = <T>(given: T | null, fallback: T | null): T | null =>
    given === null ? fallback : given;

  /** A linked customer completes the snapshot where the request left a field empty; afterwards the order never reads the customer again. */
  async function applyCustomer(
    tx: Db,
    organizationId: string,
    v: NormalizedOrder,
  ): Promise<NormalizedOrder> {
    if (!v.customerId) return v;
    const c = await tx.customer.findFirst({ where: { id: v.customerId, organizationId } });
    if (!c)
      throw new SalesOrderError('validation_failed', 'Some details need correcting.', [
        { field: 'customerId', rule: 'unknown_reference' },
      ]);
    if (!c.isActive)
      throw new SalesOrderError('validation_failed', 'Some details need correcting.', [
        { field: 'customerId', rule: 'inactive_reference' },
      ]);
    const bill: Address = {
      line1: fill(v.billing.line1, c.billingAddressLine1),
      line2: fill(v.billing.line2, c.billingAddressLine2),
      city: fill(v.billing.city, c.billingCity),
      stateCode: fill(v.billing.stateCode, c.billingStateCode),
      pinCode: fill(v.billing.pinCode, c.billingPinCode),
    };
    const ship: Address = c.shippingSameAsBilling
      ? {
          line1: fill(v.shipping.line1, c.billingAddressLine1),
          line2: fill(v.shipping.line2, c.billingAddressLine2),
          city: fill(v.shipping.city, c.billingCity),
          stateCode: fill(v.shipping.stateCode, c.billingStateCode),
          pinCode: fill(v.shipping.pinCode, c.billingPinCode),
        }
      : {
          line1: fill(v.shipping.line1, c.shippingAddressLine1),
          line2: fill(v.shipping.line2, c.shippingAddressLine2),
          city: fill(v.shipping.city, c.shippingCity),
          stateCode: fill(v.shipping.stateCode, c.shippingStateCode),
          pinCode: fill(v.shipping.pinCode, c.shippingPinCode),
        };
    return {
      ...v,
      buyer: {
        name: v.buyer.name,
        phone: fill(v.buyer.phone, c.phone),
        email: fill(v.buyer.email, c.email),
      },
      billing: bill,
      shipping: ship,
    };
  }

  const headerData = (v: NormalizedOrder) => ({
    customerId: v.customerId,
    buyerName: v.buyer.name,
    buyerPhone: v.buyer.phone,
    buyerEmail: v.buyer.email,
    billingAddressLine1: v.billing.line1,
    billingAddressLine2: v.billing.line2,
    billingCity: v.billing.city,
    billingStateCode: v.billing.stateCode,
    billingPinCode: v.billing.pinCode,
    shippingAddressLine1: v.shipping.line1,
    shippingAddressLine2: v.shipping.line2,
    shippingCity: v.shipping.city,
    shippingStateCode: v.shipping.stateCode,
    shippingPinCode: v.shipping.pinCode,
    orderDate: new Date(`${v.orderDate}T00:00:00Z`),
    dueDate: v.dueDate ? new Date(`${v.dueDate}T00:00:00Z`) : null,
    notes: v.notes,
  });

  const fingerprintOf = (v: NormalizedOrder): string =>
    createHash('sha256')
      .update(
        JSON.stringify({
          channel: v.channel,
          externalOrderId: v.externalOrderId,
          customerId: v.customerId,
          buyer: v.buyer,
          billing: v.billing,
          shipping: v.shipping,
          orderDate: v.orderDate,
          dueDate: v.dueDate,
          notes: v.notes,
          lines: v.lines,
        }),
      )
      .digest('hex');

  function validated(raw: unknown, mode: 'create' | 'update'): NormalizedOrder {
    const r = validateOrder(raw, mode, businessToday(clock()));
    if (!r.ok)
      throw new SalesOrderError('validation_failed', 'Some details need correcting.', r.problems);
    return r.value;
  }

  async function create(
    ctx: SalesOrderContext,
    raw: unknown,
  ): Promise<{ order: SalesOrderDetail; replayed: boolean }> {
    const input = validated(raw, 'create');
    const fingerprint = fingerprintOf(input);

    const replay = async (): Promise<{ order: SalesOrderDetail; replayed: boolean } | null> => {
      const existing = await prisma.salesOrder.findFirst({
        where: { organizationId: ctx.organizationId, operationId: input.operationId! },
        select: { id: true, requestFingerprint: true },
      });
      if (!existing) return null;
      if (existing.requestFingerprint !== fingerprint)
        throw new SalesOrderError(
          'operation_id_reused',
          'This operation id was already used for a different order.',
        );
      return { order: await get(ctx.organizationId, existing.id), replayed: true };
    };
    const before = await replay();
    if (before) return before;

    try {
      const id = randomUUID();
      await prisma.$transaction(async (tx) => {
        const v = await applyCustomer(tx, ctx.organizationId, input);
        const { rows, total } = await resolveLines(tx, ctx.organizationId, v.lines, new Set());

        const fy = await tx.financialYear.findFirst({
          where: {
            organizationId: ctx.organizationId,
            startDate: { lte: new Date(`${v.orderDate}T00:00:00Z`) },
            endDate: { gte: new Date(`${v.orderDate}T00:00:00Z`) },
            isLocked: false,
          },
        });
        if (!fy)
          throw new SalesOrderError('validation_failed', 'Some details need correcting.', [
            { field: 'orderDate', rule: 'no_open_financial_year' },
          ]);
        const setting = await tx.organizationSetting.findUnique({
          where: { organizationId_key: { organizationId: ctx.organizationId, key: 'numbering' } },
        });
        const byLocation =
          (setting?.value as { scopeByLocation?: boolean } | null)?.scopeByLocation === true;
        const location = byLocation
          ? await tx.businessLocation.findFirst({
              where: { organizationId: ctx.organizationId, isPrimary: true, isActive: true },
              select: { id: true },
            })
          : null;
        let orderNumber: string;
        try {
          orderNumber = (
            await numbering.allocate(
              tx,
              {
                organizationId: ctx.organizationId,
                documentType: 'SALES_ORDER',
                financialYearId: fy.id,
                ...(location ? { locationId: location.id } : {}),
              },
              { documentRef: id, correlationId: ctx.correlationId ?? null },
            )
          ).number;
        } catch (err) {
          if (err instanceof NumberingError && err.code === 'sequence_not_found')
            throw new SalesOrderError(
              'validation_failed',
              'No numbering sequence is set up for orders.',
              [{ field: 'orderNumber', rule: 'sequence_missing' }],
            );
          throw err;
        }

        await tx.salesOrder.create({
          data: {
            id,
            organizationId: ctx.organizationId,
            orderNumber,
            operationId: v.operationId!,
            requestFingerprint: fingerprint,
            channel: v.channel!,
            externalOrderId: v.externalOrderId,
            ...headerData(v),
            status: 'DRAFT',
            totalAmount: total,
            financialYearId: fy.id,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
            correlationId: ctx.correlationId ?? null,
          },
        });
        await tx.salesOrderLine.createMany({
          data: rows.map((r) => ({ ...r, orderId: id, organizationId: ctx.organizationId })),
        });
        await tx.salesOrderEvent.create({
          data: {
            orderId: id,
            organizationId: ctx.organizationId,
            eventType: 'CREATED',
            actorId: ctx.userId,
            correlationId: ctx.correlationId ?? null,
          },
        });
        await audit(tx, ctx, 'sales_order.create', id, {
          after: {
            orderNumber,
            channel: v.channel!,
            status: 'DRAFT',
            lineCount: rows.length,
            linkedCustomer: v.customerId !== null,
          },
        });
        return id;
      });
      return { order: await get(ctx.organizationId, id), replayed: false };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === 'P2002') {
        const msg = String(e.message ?? '');
        if (/external_order_id/i.test(msg))
          throw new SalesOrderError(
            'duplicate_external_order',
            'An order with this external order id already exists for this channel.',
            [{ field: 'externalOrderId', rule: 'duplicate' }],
          );
        if (/operation_id/i.test(msg)) {
          const again = await replay();
          if (again) return again;
        }
      }
      throw err;
    }
  }

  async function update(
    ctx: SalesOrderContext,
    id: string,
    raw: unknown,
  ): Promise<SalesOrderDetail> {
    const input = validated(raw, 'update');
    await prisma.$transaction(async (tx) => {
      const current = await loadDetail(tx, ctx.organizationId, id);
      if (current.version !== input.expectedVersion)
        throw new SalesOrderError('version_conflict', 'The order was changed by someone else.');
      if (!isEditable(current.status as OrderStatus))
        throw new SalesOrderError('not_editable', 'This order can no longer be changed.');

      const v = await applyCustomer(tx, ctx.organizationId, input);
      const ordered = new Set(current.lines.map((l) => l.productId));
      const { rows, total } = await resolveLines(tx, ctx.organizationId, v.lines, ordered);

      const next = headerData(v);
      const cur = current as unknown as Record<string, unknown>;
      const nxt = next as unknown as Record<string, unknown>;
      // Field NAMES that changed (these, never the values, go to the history and the audit trail).
      const changed: string[] = [];
      for (const [name, field] of [
        ['customer', 'customerId'],
        ['buyerName', 'buyerName'],
        ['buyerPhone', 'buyerPhone'],
        ['buyerEmail', 'buyerEmail'],
        ['billingAddress', 'billingAddressLine1'],
        ['billingAddress2', 'billingAddressLine2'],
        ['billingCity', 'billingCity'],
        ['billingState', 'billingStateCode'],
        ['billingPin', 'billingPinCode'],
        ['shippingAddress', 'shippingAddressLine1'],
        ['shippingAddress2', 'shippingAddressLine2'],
        ['shippingCity', 'shippingCity'],
        ['shippingState', 'shippingStateCode'],
        ['shippingPin', 'shippingPinCode'],
        ['notes', 'notes'],
      ] as const) {
        if ((cur[field] ?? null) !== (nxt[field] ?? null)) changed.push(name);
      }
      if (day(current.orderDate) !== v.orderDate) changed.push('orderDate');
      if ((current.dueDate ? day(current.dueDate) : null) !== v.dueDate) changed.push('dueDate');
      const sameLines =
        current.lines.length === rows.length &&
        current.lines.every((l, i) => {
          const r = rows[i]!;
          return (
            l.productId === r.productId &&
            quantityText(l.quantity) === r.quantity &&
            money(l.agreedUnitPrice) === r.agreedUnitPrice &&
            (l.customization ?? null) === (r.customization ?? null) &&
            (l.externalLineId ?? null) === (r.externalLineId ?? null)
          );
        });
      if (!sameLines) changed.push('lines');
      const names = changed;
      if (names.length === 0) return; // nothing to save: no version bump, no history, no audit

      const done = await tx.salesOrder.updateMany({
        where: { id, organizationId: ctx.organizationId, version: current.version },
        data: {
          ...next,
          totalAmount: total,
          updatedBy: ctx.userId,
          version: { increment: 1 },
        },
      });
      if (done.count !== 1)
        throw new SalesOrderError('version_conflict', 'The order was changed by someone else.');
      if (!sameLines) {
        await tx.salesOrderLine.deleteMany({ where: { orderId: id } });
        await tx.salesOrderLine.createMany({
          data: rows.map((r) => ({ ...r, orderId: id, organizationId: ctx.organizationId })),
        });
      }
      await tx.salesOrderEvent.create({
        data: {
          orderId: id,
          organizationId: ctx.organizationId,
          eventType: 'EDITED',
          changedFields: names.join(','),
          actorId: ctx.userId,
          correlationId: ctx.correlationId ?? null,
        },
      });
      await audit(tx, ctx, 'sales_order.update', id, {
        after: {
          orderNumber: current.orderNumber,
          changedFields: names,
          version: current.version + 1,
        },
      });
    });
    return get(ctx.organizationId, id);
  }

  async function transition(
    ctx: SalesOrderContext,
    id: string,
    body: unknown,
  ): Promise<SalesOrderDetail> {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const problems: Problem[] = [];
    for (const k of Object.keys(b))
      if (!['toStatus', 'note', 'expectedVersion'].includes(k))
        problems.push({ field: k, rule: 'unknown_field' });
    const to = b.toStatus as OrderStatus;
    if (typeof b.toStatus !== 'string' || !(b.toStatus in TRANSITIONS))
      problems.push({ field: 'toStatus', rule: 'invalid_value' });
    if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 1)
      problems.push({ field: 'expectedVersion', rule: 'required' });
    let note: string | null = null;
    if (b.note !== undefined && b.note !== null) {
      if (typeof b.note !== 'string') problems.push({ field: 'note', rule: 'invalid_type' });
      else {
        const t = b.note.normalize('NFC').trim();
        if ([...t].length > MAX_NOTE) problems.push({ field: 'note', rule: 'too_long' });
        else note = t === '' ? null : t;
      }
    }
    if (problems.length > 0)
      throw new SalesOrderError('validation_failed', 'Some details need correcting.', problems);

    await prisma.$transaction(async (tx) => {
      const current = await loadDetail(tx, ctx.organizationId, id);
      if (current.version !== b.expectedVersion)
        throw new SalesOrderError('version_conflict', 'The order was changed by someone else.');
      const from = current.status as OrderStatus;
      if (!canTransition(from, to))
        throw new SalesOrderError('transition_not_allowed', 'That status change is not allowed.', [
          { field: 'toStatus', rule: 'not_allowed' },
        ]);
      if (needsReason(from, to) && !note)
        throw new SalesOrderError('validation_failed', 'Some details need correcting.', [
          { field: 'note', rule: 'reason_required' },
        ]);
      if (to === 'CONFIRMED') {
        const missing = confirmationProblems({
          shipping: {
            line1: current.shippingAddressLine1,
            line2: current.shippingAddressLine2,
            city: current.shippingCity,
            stateCode: current.shippingStateCode,
            pinCode: current.shippingPinCode,
          },
          lines: current.lines,
        });
        if (missing.length > 0)
          throw new SalesOrderError(
            'validation_failed',
            'The order is not complete enough to confirm.',
            missing,
          );
      }
      const done = await tx.salesOrder.updateMany({
        where: { id, organizationId: ctx.organizationId, version: current.version },
        data: { status: to, updatedBy: ctx.userId, version: { increment: 1 } },
      });
      if (done.count !== 1)
        throw new SalesOrderError('version_conflict', 'The order was changed by someone else.');
      await tx.salesOrderEvent.create({
        data: {
          orderId: id,
          organizationId: ctx.organizationId,
          eventType: 'STATUS_CHANGED',
          fromStatus: from,
          toStatus: to,
          note,
          actorId: ctx.userId,
          correlationId: ctx.correlationId ?? null,
        },
      });
      await audit(tx, ctx, to === 'CANCELLED' ? 'sales_order.cancel' : 'sales_order.status', id, {
        before: { status: from },
        after: { orderNumber: current.orderNumber, status: to, version: current.version + 1 },
      });
    });
    return get(ctx.organizationId, id);
  }

  return {
    list,
    get,
    create,
    update,
    transition,
    dashboardCounts,
    today: () => businessToday(clock()),
  };
}

export type SalesOrderService = ReturnType<typeof createSalesOrderService>;
