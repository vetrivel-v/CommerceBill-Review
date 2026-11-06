/**
 * The sales order status model (ADR-0031). Pure and browser-safe; the SAME table of edges is enforced by a database trigger
 * (`sales_orders_guard`) and a test compares the two.
 *
 * IN_PRODUCTION and READY belong to the vocabulary but nothing can reach them until production exists (MTO-4), so MTO-1 does not pretend to.
 * INVOICED and PAID are never stored: they will be derived from invoice links and receivables (MTO-2).
 */
export const ORDER_STATUSES = [
  'DRAFT',
  'CONFIRMED',
  'NEEDS_INFO',
  'IN_PRODUCTION',
  'READY',
  'CANCELLED',
  'CLOSED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The channel is a label only: nothing is synchronised with any marketplace in MTO-1. */
export const ORDER_CHANNELS = [
  'MANUAL',
  'INSTAGRAM',
  'PHONE',
  'AMAZON',
  'FLIPKART',
  'OTHER',
] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

/** Allowed status changes in MTO-1. */
export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['NEEDS_INFO', 'CANCELLED', 'CLOSED'],
  NEEDS_INFO: ['CONFIRMED', 'CANCELLED'],
  IN_PRODUCTION: [],
  READY: [],
  CANCELLED: [],
  CLOSED: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** An order's header and lines may be edited while it is neither cancelled nor closed. */
export const isEditable = (status: OrderStatus): boolean =>
  status === 'DRAFT' || status === 'CONFIRMED' || status === 'NEEDS_INFO';

/** A reason is required for these changes (it is kept in the order's history, never in logs). */
export const needsReason = (from: OrderStatus, to: OrderStatus): boolean =>
  (to === 'CANCELLED' && from !== 'DRAFT') || to === 'CLOSED' || to === 'NEEDS_INFO';

export const STATUS_LABEL: Readonly<Record<OrderStatus, string>> = {
  DRAFT: 'Draft',
  CONFIRMED: 'Confirmed',
  NEEDS_INFO: 'Needs information',
  IN_PRODUCTION: 'In production',
  READY: 'Ready',
  CANCELLED: 'Cancelled',
  CLOSED: 'Closed',
};

export const CHANNEL_LABEL: Readonly<Record<OrderChannel, string>> = {
  MANUAL: 'Manual',
  INSTAGRAM: 'Instagram',
  PHONE: 'Phone',
  AMAZON: 'Amazon',
  FLIPKART: 'Flipkart',
  OTHER: 'Other',
};

/** Statuses that count as an open (unfinished) order for the dashboard. */
export const OPEN_STATUSES: readonly OrderStatus[] = [
  'DRAFT',
  'CONFIRMED',
  'NEEDS_INFO',
  'IN_PRODUCTION',
  'READY',
];
