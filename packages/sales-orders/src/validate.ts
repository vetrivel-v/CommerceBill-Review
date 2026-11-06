import { isRealDate, parseQuantity } from '@commercebill/inventory-engine/browser';
import { normalizeMoney } from '@commercebill/products/browser';
import { INDIA_STATE_CODES, isValidPinCode } from '@commercebill/setup/browser';
import { ORDER_CHANNELS, type OrderChannel } from './states.js';

export interface Problem {
  field: string;
  rule: string;
}

export interface Address {
  line1: string | null;
  line2: string | null;
  city: string | null;
  stateCode: string | null;
  pinCode: string | null;
}

export interface OrderLineInput {
  productId: string;
  /** Canonical quantity text (the unit's own precision is checked by the service, which knows the unit). */
  quantity: string;
  /** Two-place decimal text. */
  agreedUnitPrice: string;
  customization: string | null;
  externalLineId: string | null;
}

export interface NormalizedOrder {
  /** Present on creation only. */
  operationId: string | null;
  channel: OrderChannel | null;
  externalOrderId: string | null;
  customerId: string | null;
  buyer: { name: string; phone: string | null; email: string | null };
  billing: Address;
  shipping: Address;
  /** YYYY-MM-DD */
  orderDate: string;
  dueDate: string | null;
  notes: string | null;
  lines: OrderLineInput[];
  /** Present on update only. */
  expectedVersion: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+()\- ]{5,30}$/;
export const MAX_LINES = 100;
const MAX = {
  name: 200,
  line: 200,
  city: 100,
  notes: 2000,
  custom: 2000,
  ext: 100,
  email: 254,
} as const;

const KEYS_CREATE = [
  'operationId',
  'channel',
  'externalOrderId',
  'customerId',
  'buyer',
  'billing',
  'shipping',
  'orderDate',
  'dueDate',
  'notes',
  'lines',
];
const KEYS_UPDATE = [
  'customerId',
  'buyer',
  'billing',
  'shipping',
  'orderDate',
  'dueDate',
  'notes',
  'lines',
  'expectedVersion',
];
const ADDRESS_KEYS = ['line1', 'line2', 'city', 'stateCode', 'pinCode'];
const BUYER_KEYS = ['name', 'phone', 'email'];
const LINE_KEYS = ['productId', 'quantity', 'agreedUnitPrice', 'customization', 'externalLineId'];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Pure validation of a sales order create or update request (the server runs it on every request; the renderer runs the same function
 * for early feedback). Problems carry only a field path and a stable rule code, never a submitted value. Rules that need the database
 * (does the item exist, is it sellable, is the quantity right for its unit) belong to the service.
 */
export function validateOrder(
  raw: unknown,
  mode: 'create' | 'update',
  today: string,
): { ok: true; value: NormalizedOrder } | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });
  if (!isObject(raw)) return { ok: false, problems: [{ field: 'body', rule: 'invalid_type' }] };
  const allowed = mode === 'create' ? KEYS_CREATE : KEYS_UPDATE;
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) add(k, 'unknown_field');

  const text = (v: unknown, path: string, max: number, required = false): string | null => {
    if (v === undefined || v === null) {
      if (required) add(path, 'required');
      return null;
    }
    if (typeof v !== 'string') {
      add(path, 'invalid_type');
      return null;
    }
    const t = v.normalize('NFC').trim();
    if (t === '') {
      if (required) add(path, 'required');
      return null;
    }
    if ([...t].length > max) {
      add(path, 'too_long');
      return null;
    }
    return t;
  };
  const uuid = (v: unknown, path: string, required: boolean): string | null => {
    if (v === undefined || v === null || v === '') {
      if (required) add(path, 'required');
      return null;
    }
    if (typeof v !== 'string' || !UUID.test(v)) {
      add(path, 'invalid_reference');
      return null;
    }
    return v.toLowerCase();
  };

  let operationId: string | null = null;
  let channel: OrderChannel | null = null;
  let externalOrderId: string | null = null;
  if (mode === 'create') {
    operationId = uuid(raw.operationId, 'operationId', true);
    if (!(ORDER_CHANNELS as readonly unknown[]).includes(raw.channel))
      add('channel', 'invalid_value');
    else channel = raw.channel as OrderChannel;
    externalOrderId = text(raw.externalOrderId, 'externalOrderId', MAX.ext);
    if (externalOrderId && channel === 'MANUAL') add('externalOrderId', 'not_for_manual_orders');
  }
  let expectedVersion: number | null = null;
  if (mode === 'update') {
    if (!Number.isInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1)
      add('expectedVersion', 'required');
    else expectedVersion = raw.expectedVersion as number;
  }
  const customerId = uuid(raw.customerId, 'customerId', false);

  // Buyer
  let buyer: NormalizedOrder['buyer'] = { name: '', phone: null, email: null };
  if (!isObject(raw.buyer)) add('buyer', 'required');
  else {
    for (const k of Object.keys(raw.buyer))
      if (!BUYER_KEYS.includes(k)) add(`buyer.${k}`, 'unknown_field');
    const name = text(raw.buyer.name, 'buyer.name', MAX.name, true);
    const phone = text(raw.buyer.phone, 'buyer.phone', 30);
    if (phone && !PHONE.test(phone)) add('buyer.phone', 'invalid_phone');
    const email = text(raw.buyer.email, 'buyer.email', MAX.email);
    if (email && !EMAIL.test(email)) add('buyer.email', 'invalid_email');
    buyer = { name: name ?? '', phone, email };
  }

  const address = (v: unknown, path: string): Address => {
    const empty: Address = { line1: null, line2: null, city: null, stateCode: null, pinCode: null };
    if (v === undefined || v === null) return empty;
    if (!isObject(v)) {
      add(path, 'invalid_type');
      return empty;
    }
    for (const k of Object.keys(v))
      if (!ADDRESS_KEYS.includes(k)) add(`${path}.${k}`, 'unknown_field');
    const stateCode = text(v.stateCode, `${path}.stateCode`, 2);
    if (stateCode && !INDIA_STATE_CODES[stateCode]) add(`${path}.stateCode`, 'unknown_state_code');
    const pinCode = text(v.pinCode, `${path}.pinCode`, 6);
    if (pinCode && !isValidPinCode(pinCode)) add(`${path}.pinCode`, 'invalid_pin_code');
    return {
      line1: text(v.line1, `${path}.line1`, MAX.line),
      line2: text(v.line2, `${path}.line2`, MAX.line),
      city: text(v.city, `${path}.city`, MAX.city),
      stateCode,
      pinCode,
    };
  };
  const billing = address(raw.billing, 'billing');
  const shipping = address(raw.shipping, 'shipping');

  // Dates
  const date = (v: unknown, path: string): string | null => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !isRealDate(v.trim())) {
      add(path, 'invalid_date');
      return null;
    }
    const d = v.trim();
    if (Number(d.slice(0, 4)) < 2000 || Number(d.slice(0, 4)) > 2100) {
      add(path, 'date_out_of_range');
      return null;
    }
    return d;
  };
  const orderDate = date(raw.orderDate, 'orderDate') ?? today;
  const dueDate = date(raw.dueDate, 'dueDate');
  if (dueDate && dueDate < orderDate) add('dueDate', 'due_before_order');
  const notes = text(raw.notes, 'notes', MAX.notes);

  // Lines
  const lines: OrderLineInput[] = [];
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) add('lines', 'required');
  else if (raw.lines.length > MAX_LINES) add('lines', 'too_many_lines');
  else {
    const seenExternal = new Set<string>();
    raw.lines.forEach((l: unknown, i: number) => {
      const path = `lines[${String(i)}]`;
      if (!isObject(l)) {
        add(path, 'invalid_type');
        return;
      }
      for (const k of Object.keys(l))
        if (!LINE_KEYS.includes(k)) add(`${path}.${k}`, 'unknown_field');
      const productId = uuid(l.productId, `${path}.productId`, true);
      const q = parseQuantity(l.quantity);
      if (!q.ok) add(`${path}.quantity`, q.rule);
      let price: string | null = null;
      if (l.agreedUnitPrice === undefined || l.agreedUnitPrice === null || l.agreedUnitPrice === '')
        add(`${path}.agreedUnitPrice`, 'required');
      else {
        const m = normalizeMoney(l.agreedUnitPrice);
        if (m.ok) price = m.value;
        else add(`${path}.agreedUnitPrice`, m.rule);
      }
      const customization = text(l.customization, `${path}.customization`, MAX.custom);
      const externalLineId = text(l.externalLineId, `${path}.externalLineId`, MAX.ext);
      if (externalLineId) {
        if (seenExternal.has(externalLineId)) add(`${path}.externalLineId`, 'duplicate');
        seenExternal.add(externalLineId);
      }
      if (productId && q.ok && price !== null)
        lines.push({
          productId,
          quantity: q.value,
          agreedUnitPrice: price,
          customization,
          externalLineId,
        });
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      operationId,
      channel,
      externalOrderId,
      customerId,
      buyer,
      billing,
      shipping,
      orderDate,
      dueDate,
      notes,
      lines,
      expectedVersion,
    },
  };
}

/** What an order must have before it may be CONFIRMED: a delivery address and at least one line (the buyer name is always required). */
export function confirmationProblems(o: {
  shipping: Address;
  lines: readonly unknown[];
}): Problem[] {
  const out: Problem[] = [];
  if (!o.shipping.line1) out.push({ field: 'shipping.line1', rule: 'required_to_confirm' });
  if (!o.shipping.stateCode) out.push({ field: 'shipping.stateCode', rule: 'required_to_confirm' });
  if (o.lines.length === 0) out.push({ field: 'lines', rule: 'required_to_confirm' });
  return out;
}

export const MAX_NOTE = 500;
