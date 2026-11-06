import {
  lineTotal,
  sumAmounts,
  validateOrder,
  type OrderChannel,
} from '@commercebill/sales-orders/browser';
import type {
  SalesOrderChannel,
  SalesOrderDetail,
  SalesOrderStatus,
} from '@commercebill/shared-types';

/** Form state: strings exactly as typed. Money and quantities stay TEXT end to end, never a JavaScript number. */
export interface AddressForm {
  line1: string;
  line2: string;
  city: string;
  stateCode: string;
  pinCode: string;
}

export interface LineForm {
  /** A stable key for React; not sent. */
  key: string;
  productId: string;
  sku: string;
  name: string;
  unitCode: string;
  /** The unit's accepted decimal places (shown as a hint; the server decides). */
  decimals: number;
  quantity: string;
  agreedUnitPrice: string;
  customization: string;
  externalLineId: string;
}

export interface OrderForm {
  channel: SalesOrderChannel;
  externalOrderId: string;
  customer: { id: string; code: string; name: string } | null;
  buyerName: string;
  buyerPhone: string;
  buyerEmail: string;
  billing: AddressForm;
  shipping: AddressForm;
  orderDate: string;
  dueDate: string;
  notes: string;
  lines: LineForm[];
}

const emptyAddress = (): AddressForm => ({
  line1: '',
  line2: '',
  city: '',
  stateCode: '',
  pinCode: '',
});

export const todayIso = (): string => {
  const d = new Date();
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function emptyOrderForm(): OrderForm {
  return {
    channel: 'MANUAL',
    externalOrderId: '',
    customer: null,
    buyerName: '',
    buyerPhone: '',
    buyerEmail: '',
    billing: emptyAddress(),
    shipping: emptyAddress(),
    orderDate: todayIso(),
    dueDate: '',
    notes: '',
    lines: [],
  };
}

let seq = 0;
export const newLineKey = (): string => `l${String((seq += 1))}`;

const addressForm = (a: SalesOrderDetail['billing']): AddressForm => ({
  line1: a.line1 ?? '',
  line2: a.line2 ?? '',
  city: a.city ?? '',
  stateCode: a.stateCode ?? '',
  pinCode: a.pinCode ?? '',
});

export function formFromOrder(o: SalesOrderDetail): OrderForm {
  return {
    channel: o.channel,
    externalOrderId: o.externalOrderId ?? '',
    customer: o.customer,
    buyerName: o.buyer.name,
    buyerPhone: o.buyer.phone ?? '',
    buyerEmail: o.buyer.email ?? '',
    billing: addressForm(o.billing),
    shipping: addressForm(o.shipping),
    orderDate: o.orderDate,
    dueDate: o.dueDate ?? '',
    notes: o.notes ?? '',
    lines: o.lines.map((l) => ({
      key: newLineKey(),
      productId: l.productId,
      sku: l.sku,
      name: l.productName,
      unitCode: l.unitCode,
      decimals: 4,
      quantity: l.quantity,
      agreedUnitPrice: l.agreedUnitPrice,
      customization: l.customization ?? '',
      externalLineId: l.externalLineId ?? '',
    })),
  };
}

const n = (v: string): string | null => (v.trim() === '' ? null : v.trim());
const addressBody = (a: AddressForm) => ({
  line1: n(a.line1),
  line2: n(a.line2),
  city: n(a.city),
  stateCode: n(a.stateCode),
  pinCode: n(a.pinCode),
});

/** The request body shared by create and update. The organization comes from the session, never from here. */
function commonBody(f: OrderForm) {
  return {
    customerId: f.customer?.id ?? null,
    buyer: { name: f.buyerName.trim(), phone: n(f.buyerPhone), email: n(f.buyerEmail) },
    billing: addressBody(f.billing),
    shipping: addressBody(f.shipping),
    orderDate: n(f.orderDate),
    dueDate: n(f.dueDate),
    notes: n(f.notes),
    lines: f.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity.trim(),
      agreedUnitPrice: l.agreedUnitPrice.trim(),
      customization: n(l.customization),
      externalLineId: n(l.externalLineId),
    })),
  };
}

export const toCreateBody = (f: OrderForm, operationId: string): Record<string, unknown> => ({
  operationId,
  channel: f.channel,
  externalOrderId: f.channel === 'MANUAL' ? null : n(f.externalOrderId),
  ...commonBody(f),
});

export const toUpdateBody = (f: OrderForm, expectedVersion: number): Record<string, unknown> => ({
  ...commonBody(f),
  expectedVersion,
});

// ------------------------------------------------------------------------------------------------ messages

const RULE_TEXT: Record<string, string> = {
  required: 'This field is required.',
  too_long: 'This is too long.',
  invalid_type: 'This value is not acceptable.',
  invalid_value: 'Choose one of the listed options.',
  invalid_email: 'Enter a valid email address.',
  invalid_phone: 'Enter a phone number using digits, spaces, + ( ) or -.',
  invalid_date: 'Enter a valid date.',
  date_out_of_range: 'Choose a year between 2000 and 2100.',
  due_before_order: 'The due date cannot be before the order date.',
  unknown_state_code: 'Choose a state from the list.',
  invalid_pin_code: 'PIN code must be 6 digits and must not start with 0.',
  invalid_reference: 'Choose a value from the list.',
  unknown_reference: 'This could not be found. Remove it and choose it again.',
  inactive_reference: 'This is no longer active. Choose another.',
  item_not_sellable: 'Only sellable items can be ordered.',
  invalid_quantity: 'Enter a quantity such as 2 or 42.6.',
  quantity_must_be_positive: 'The quantity must be more than zero.',
  too_many_decimals: 'This unit does not allow that many decimal places.',
  unsupported_precision: 'At most four decimal places.',
  quantity_too_large: 'This quantity is too large.',
  invalid_amount: 'Enter an amount such as 250 or 250.50 (at most two decimal places).',
  negative_amount: 'The amount cannot be negative.',
  too_many_lines: 'An order can have at most 100 lines.',
  not_for_manual_orders: 'A manual order has no external order id.',
  duplicate: 'This is already used.',
  required_to_confirm: 'Needed before the order can be confirmed.',
  reason_required: 'Please give a short reason.',
  no_open_financial_year: 'There is no open financial year for this date.',
  sequence_missing: 'Order numbering is not set up.',
  unknown_field: 'This value is not accepted.',
};
export const ruleText = (rule: string): string =>
  RULE_TEXT[rule] ?? 'This value is not acceptable.';

export type FieldErrors = Record<string, string>;

/** Early feedback with the SAME validation as the server (which still validates everything). */
export function validateForm(f: OrderForm, mode: 'create' | 'update'): FieldErrors {
  const body =
    mode === 'create'
      ? toCreateBody(f, '00000000-0000-4000-8000-000000000000')
      : toUpdateBody(f, 1);
  const r = validateOrder(body, mode, todayIso());
  if (r.ok) return {};
  return errorsFromProblems(r.problems);
}

export function errorsFromProblems(problems: { field: string; rule: string }[]): FieldErrors {
  const e: FieldErrors = {};
  for (const p of problems) e[p.field] ??= ruleText(p.rule);
  return e;
}

// ------------------------------------------------------------------------------------------------ display

export const STATUS_TONE: Record<SalesOrderStatus, 'neutral' | 'brand' | 'success' | 'warning'> = {
  DRAFT: 'neutral',
  CONFIRMED: 'brand',
  NEEDS_INFO: 'warning',
  IN_PRODUCTION: 'brand',
  READY: 'success',
  CANCELLED: 'neutral',
  CLOSED: 'success',
};

/** The action wording for each status change offered by the server. */
export const TRANSITION_LABEL: Partial<Record<SalesOrderStatus, string>> = {
  CONFIRMED: 'Confirm order',
  NEEDS_INFO: 'Needs information',
  CANCELLED: 'Cancel order',
  CLOSED: 'Close order',
};

export const TRANSITION_HELP: Partial<Record<SalesOrderStatus, string>> = {
  CONFIRMED: 'The order is accepted. A delivery address and at least one item are needed.',
  NEEDS_INFO: 'Something is missing from the customer, such as the spelling of a name.',
  CANCELLED: 'The order will not be made. A cancelled order cannot be changed again.',
  CLOSED:
    'Finish the order without an invoice from here, for example because it was completed outside CommerceBill. A closed order cannot be changed again.',
};

export const lineAmount = (l: Pick<LineForm, 'quantity' | 'agreedUnitPrice'>): string | null => {
  try {
    return lineTotal(l.quantity.trim(), l.agreedUnitPrice.trim());
  } catch {
    return null;
  }
};

/** Display total only (the server recomputes the real one). */
export const formTotal = (lines: readonly LineForm[]): string =>
  sumAmounts(lines.map((l) => lineAmount(l) ?? '0.00'));

export const asChannel = (v: string): OrderChannel => v as OrderChannel;
