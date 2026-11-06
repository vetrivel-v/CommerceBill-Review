/**
 * Pure product validation. The server runs it on every create/update (the renderer is never trusted); the UI runs the
 * same function for early feedback. Problems carry only a field name and a stable rule code - never a submitted value.
 *
 * MONEY: amounts are handled as decimal STRINGS only. Nothing here converts a price through a JavaScript number, so no
 * value can lose precision. A third decimal place is refused, never silently rounded.
 */

export const PRODUCT_KINDS = ['GOODS', 'SERVICE'] as const;
/** Where an item may appear (ADR-0031). It decides NO tax treatment: that stays with `kind`, the tax category and HSN/SAC. */
export const ITEM_ROLES = ['SELLABLE', 'RAW_MATERIAL', 'COMPONENT', 'PACKAGING'] as const;
export type ItemRole = (typeof ITEM_ROLES)[number];
/** SELLABLE goods only: held as finished stock, or made after an order arrives (no finished stock). */
export const FULFILMENT_MODES = ['STOCKED', 'MADE_TO_ORDER'] as const;
export type FulfilmentMode = (typeof FULFILMENT_MODES)[number];

export interface Problem {
  field: string;
  rule: string;
}

/** The fields a client may send. `sku` is accepted on creation only; `kind` is fixed once the product exists. */
export const PRODUCT_FIELDS = [
  'sku',
  'name',
  'description',
  'kind',
  'itemRole',
  'fulfilmentMode',
  'hsnSacCodeId',
  'unitId',
  'taxCategoryId',
  'mrp',
  'sellingPrice',
  'priceIncludesTax',
  'trackInventory',
  'barcode',
] as const;
export type ProductField = (typeof PRODUCT_FIELDS)[number];

export interface NormalizedProduct {
  name: string;
  description: string | null;
  kind: 'GOODS' | 'SERVICE';
  itemRole: ItemRole;
  /** SELLABLE goods only; null for services and for materials, components and packaging. */
  fulfilmentMode: FulfilmentMode | null;
  hsnSacCodeId: string | null;
  unitId: string | null;
  taxCategoryId: string;
  /** Exact decimal string with two places, or null. */
  mrp: string | null;
  /** Exact decimal string with two places; null only for materials, components and packaging. */
  sellingPrice: string | null;
  priceIncludesTax: boolean;
  trackInventory: boolean;
  barcode: string | null;
}

/** Stored form of a SKU: trimmed, NFC, UPPER-CASE. It never changes after creation. */
export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,39}$/;
const BARCODE = /^[A-Za-z0-9._/-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;

const MAX = { name: 200, description: 2000 } as const;

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFC').trim();
  return t === '' ? null : t;
}

/**
 * Normalises an amount to a two-place decimal string without any floating-point arithmetic.
 * Returns the string, or a rule code: 'invalid_amount' (not a plain decimal, or more than two places),
 * 'negative_amount'. Numbers are accepted only through their exact shortest text (no exponent form).
 */
export function normalizeMoney(
  raw: unknown,
): { ok: true; value: string } | { ok: false; rule: string } {
  const s =
    typeof raw === 'number'
      ? Number.isFinite(raw)
        ? String(raw)
        : ''
      : typeof raw === 'string'
        ? raw.trim()
        : '';
  if (/^-\d+(\.\d+)?$/.test(s)) return { ok: false, rule: 'negative_amount' };
  if (!AMOUNT.test(s)) return { ok: false, rule: 'invalid_amount' };
  const [whole = '0', frac = ''] = s.split('.');
  const intPart = whole.replace(/^0+(?=\d)/, '');
  return { ok: true, value: `${intPart}.${frac.padEnd(2, '0')}` };
}

export type ValidationResult =
  { ok: true; value: NormalizedProduct; sku: string | null } | { ok: false; problems: Problem[] };

/**
 * Validates a COMPLETE product (for an update the caller merges the stored values first).
 * `allowSku` = creation, where a SKU may be supplied (blank = generated). Reference existence/ownership, active state
 * and HSN/SAC kind are checked by the service (they need the database) and again by database triggers.
 */
export function validateProduct(raw: Record<string, unknown>, allowSku: boolean): ValidationResult {
  const problems: Problem[] = [];
  const add = (field: string, rule: string) => problems.push({ field, rule });

  for (const key of Object.keys(raw)) {
    if (!(PRODUCT_FIELDS as readonly string[]).includes(key) || (key === 'sku' && !allowSku)) {
      add(key, 'unknown_field');
    }
  }

  const str = (field: string, max: number, required = false): string | null => {
    const v = raw[field];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      add(field, 'invalid_type');
      return null;
    }
    const t = text(v);
    if (t === null) {
      if (required) add(field, 'required');
      return null;
    }
    if ([...t].length > max) {
      add(field, 'too_long');
      return null;
    }
    return t;
  };
  const id = (field: string, required: boolean): string | null => {
    const v = raw[field];
    if (v === undefined || v === null || v === '') {
      if (required) add(field, 'required');
      return null;
    }
    if (typeof v !== 'string' || !UUID.test(v)) {
      add(field, 'invalid_reference');
      return null;
    }
    return v.toLowerCase();
  };
  const flag = (field: string, fallback: boolean): boolean => {
    const v = raw[field];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') {
      add(field, 'invalid_type');
      return fallback;
    }
    return v;
  };

  const kind = raw.kind;
  if (kind !== 'GOODS' && kind !== 'SERVICE') add('kind', 'invalid_value');
  // An absent role is a SELLABLE item (every item created before roles existed, and every client that does not send one).
  const roleRaw = raw.itemRole === undefined || raw.itemRole === null ? 'SELLABLE' : raw.itemRole;
  const itemRole = (ITEM_ROLES as readonly unknown[]).includes(roleRaw)
    ? (roleRaw as ItemRole)
    : null;
  if (!itemRole) add('itemRole', 'invalid_value');
  const sellable = itemRole === 'SELLABLE';
  if (itemRole && !sellable && kind === 'SERVICE') add('itemRole', 'role_requires_goods');

  const name = str('name', MAX.name, true);
  const description = str('description', MAX.description);
  const hsnSacCodeId = id('hsnSacCodeId', false);
  const unitId = id('unitId', kind === 'GOODS');
  const taxCategoryId = id('taxCategoryId', true);

  const present = (v: unknown) => v !== undefined && v !== null && v !== '';
  let sellingPrice: string | null = null;
  let mrp: string | null = null;
  if (sellable) {
    if (!present(raw.sellingPrice)) add('sellingPrice', 'required');
    else {
      const m = normalizeMoney(raw.sellingPrice);
      if (m.ok) sellingPrice = m.value;
      else add('sellingPrice', m.rule);
    }
    if (present(raw.mrp)) {
      const m = normalizeMoney(raw.mrp);
      if (m.ok) mrp = m.value;
      else add('mrp', m.rule);
    }
  } else {
    // Materials, components and packaging are never sold: no price at all, so they cannot be mistaken for something to invoice.
    if (present(raw.sellingPrice)) add('sellingPrice', 'not_for_sale');
    if (present(raw.mrp)) add('mrp', 'not_for_sale');
  }

  const priceIncludesTax = sellable ? flag('priceIncludesTax', false) : false;
  if (!sellable && raw.priceIncludesTax === true) add('priceIncludesTax', 'not_for_sale');

  // Fulfilment mode and inventory tracking are two views of one fact for sellable goods: STOCKED tracks, MADE_TO_ORDER does not.
  const modeRaw = raw.fulfilmentMode;
  let fulfilmentMode: FulfilmentMode | null = null;
  let trackInventory = flag('trackInventory', !sellable);
  if (present(modeRaw) && !(FULFILMENT_MODES as readonly unknown[]).includes(modeRaw)) {
    add('fulfilmentMode', 'invalid_value');
  } else if (sellable && kind === 'GOODS') {
    if (present(modeRaw)) {
      fulfilmentMode = modeRaw as FulfilmentMode;
      const mustTrack = fulfilmentMode === 'STOCKED';
      if (
        raw.trackInventory !== undefined &&
        raw.trackInventory !== null &&
        raw.trackInventory !== mustTrack
      )
        add('trackInventory', 'tracking_must_match_mode');
      trackInventory = mustTrack;
    } else {
      fulfilmentMode = trackInventory ? 'STOCKED' : 'MADE_TO_ORDER';
    }
  } else if (present(modeRaw)) {
    add('fulfilmentMode', 'not_applicable');
  }
  if (kind === 'SERVICE' && trackInventory) add('trackInventory', 'service_cannot_track_inventory');

  const barcode = str('barcode', 64);
  if (barcode && !BARCODE.test(barcode)) add('barcode', 'invalid_barcode');

  let sku: string | null = null;
  if (allowSku) {
    const c = str('sku', 40);
    if (c) {
      sku = c.toUpperCase();
      if (!SKU_PATTERN.test(sku)) add('sku', 'invalid_sku');
    }
  }

  if (
    problems.length > 0 ||
    !name ||
    !taxCategoryId ||
    !itemRole ||
    (sellable && sellingPrice === null) ||
    (kind !== 'GOODS' && kind !== 'SERVICE')
  ) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    sku,
    value: {
      name,
      description,
      kind,
      itemRole,
      fulfilmentMode,
      hsnSacCodeId,
      unitId,
      taxCategoryId,
      mrp,
      sellingPrice,
      priceIncludesTax,
      trackInventory: kind === 'GOODS' ? trackInventory : false,
      barcode,
    },
  };
}
