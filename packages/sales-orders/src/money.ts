/** Exact order arithmetic on decimal TEXT with BigInt (nothing here touches a JavaScript number). */

const QTY = /^\d+(\.\d{1,4})?$/;
const PRICE = /^\d+(\.\d{1,2})?$/;

const scaled = (text: string, places: number): bigint => {
  const [whole = '0', frac = ''] = text.split('.');
  return BigInt(whole + frac.padEnd(places, '0'));
};

const twoPlaces = (cents: bigint): string => {
  const digits = cents.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

/** quantity (up to 4 places) x unit price (up to 2 places), rounded half-up to whole paise. Returns exact text with two places. */
export function lineTotal(quantity: string, unitPrice: string): string {
  if (!QTY.test(quantity) || !PRICE.test(unitPrice)) throw new Error('not a plain decimal');
  const product = scaled(quantity, 4) * scaled(unitPrice, 2); // six places
  return twoPlaces((product + 5_000n) / 10_000n);
}

/** Exact sum of two-place amounts. */
export function sumAmounts(amounts: readonly string[]): string {
  let cents = 0n;
  for (const a of amounts) cents += scaled(a, 2);
  return twoPlaces(cents);
}
