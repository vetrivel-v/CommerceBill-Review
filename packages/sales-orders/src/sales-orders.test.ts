import { describe, expect, it } from 'vitest';
import {
  ORDER_STATUSES,
  TRANSITIONS,
  canTransition,
  confirmationProblems,
  isEditable,
  lineTotal,
  needsReason,
  sumAmounts,
  validateOrder,
} from './index.js';

const U = '3a7b446f-e665-4c9d-b86f-93b2cb47afe9';
const good = () => ({
  operationId: U,
  channel: 'INSTAGRAM',
  buyer: { name: ' Anita ' },
  shipping: { line1: '1 Lane', stateCode: '27', pinCode: '411001' },
  lines: [{ productId: U, quantity: '2', agreedUnitPrice: '250' }],
});

describe('status model', () => {
  it('has the approved vocabulary and edges, and nothing reaches production states yet', () => {
    expect([...ORDER_STATUSES]).toEqual([
      'DRAFT',
      'CONFIRMED',
      'NEEDS_INFO',
      'IN_PRODUCTION',
      'READY',
      'CANCELLED',
      'CLOSED',
    ]);
    expect(Object.values(TRANSITIONS).flat()).not.toContain('IN_PRODUCTION');
    expect(Object.values(TRANSITIONS).flat()).not.toContain('READY');
    expect(canTransition('DRAFT', 'CONFIRMED')).toBe(true);
    expect(canTransition('DRAFT', 'CLOSED')).toBe(false);
    expect(canTransition('CANCELLED', 'DRAFT')).toBe(false);
    expect(canTransition('CLOSED', 'CONFIRMED')).toBe(false);
  });
  it('terminal orders are not editable and some changes need a reason', () => {
    expect(isEditable('DRAFT') && isEditable('CONFIRMED') && isEditable('NEEDS_INFO')).toBe(true);
    expect(isEditable('CANCELLED') || isEditable('CLOSED')).toBe(false);
    expect(needsReason('DRAFT', 'CANCELLED')).toBe(false);
    expect(needsReason('CONFIRMED', 'CANCELLED')).toBe(true);
    expect(needsReason('CONFIRMED', 'CLOSED')).toBe(true);
    expect(needsReason('NEEDS_INFO', 'CONFIRMED')).toBe(false);
  });
});

describe('exact order arithmetic', () => {
  it('multiplies a quantity of up to four places by a price, rounding half up to the paisa', () => {
    expect(lineTotal('2', '250.00')).toBe('500.00');
    expect(lineTotal('1.5', '10.01')).toBe('15.02'); // 15.015
    expect(lineTotal('42.6', '3.33')).toBe('141.86'); // 141.858
    expect(lineTotal('0.0001', '0.01')).toBe('0.00');
    expect(() => lineTotal('1e3', '1')).toThrow();
  });
  it('sums amounts exactly', () => {
    expect(sumAmounts(['0.10', '0.20'])).toBe('0.30');
    expect(sumAmounts([])).toBe('0.00');
  });
});

describe('order validation (pure)', () => {
  it('accepts a minimal order and normalises it', () => {
    const r = validateOrder(good(), 'create', '2026-10-23');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.buyer.name).toBe('Anita');
      expect(r.value.orderDate).toBe('2026-10-23');
      expect(r.value.lines[0]).toMatchObject({ quantity: '2', agreedUnitPrice: '250.00' });
    }
  });
  it('reports value-free problems for everything wrong', () => {
    const r = validateOrder(
      {
        ...good(),
        channel: 'EBAY',
        buyer: { name: '', email: 'x' },
        shipping: { stateCode: '00', pinCode: '12' },
        dueDate: 'soon',
        lines: [],
        extra: 1,
      },
      'create',
      '2026-10-23',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const rules = r.problems.map((p) => `${p.field}:${p.rule}`);
      expect(rules).toEqual(
        expect.arrayContaining([
          'channel:invalid_value',
          'buyer.name:required',
          'buyer.email:invalid_email',
          'shipping.stateCode:unknown_state_code',
          'shipping.pinCode:invalid_pin_code',
          'dueDate:invalid_date',
          'lines:required',
          'extra:unknown_field',
        ]),
      );
      expect(JSON.stringify(r.problems)).not.toContain('EBAY');
    }
  });
  it('update needs the version and refuses creation-only keys', () => {
    const rest: Record<string, unknown> = { ...good() };
    delete rest.operationId;
    delete rest.channel;
    expect(validateOrder(rest, 'update', '2026-10-23').ok).toBe(false);
    expect(validateOrder({ ...rest, expectedVersion: 3 }, 'update', '2026-10-23').ok).toBe(true);
    expect(validateOrder({ ...good(), expectedVersion: 3 }, 'update', '2026-10-23').ok).toBe(false);
  });
  it('a delivery address and a line are needed to confirm', () => {
    expect(
      confirmationProblems({
        shipping: { line1: null, line2: null, city: null, stateCode: null, pinCode: null },
        lines: [],
      }).length,
    ).toBe(3);
    expect(
      confirmationProblems({
        shipping: { line1: 'a', line2: null, city: null, stateCode: '27', pinCode: null },
        lines: [1],
      }),
    ).toEqual([]);
  });
});
