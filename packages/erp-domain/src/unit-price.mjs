/** Exact unit prices. Isolated until the native API/UI integration adopts this contract. */
export const UNIT_PRICE_INPUT_LIMIT = 80;
export class UnitPriceError extends Error {
  constructor(code = 'UNIT_PRICE_INVALID') { super(code); this.name = 'UnitPriceError'; this.code = code; }
}
const need = (test, code) => { if (!test) throw new UnitPriceError(code); };
const PRICE_SCALE = 10_000_000_000n;
const MAX_CENTS = 99_999_999_999_999n;
export function normalizeUnitPrice(value, integerDigits = 10) {
  need(integerDigits === 10 || integerDigits === 14);
  need(typeof value === 'string' && value.length <= UNIT_PRICE_INPUT_LIMIT);
  need(new RegExp(`^(0|[1-9][0-9]{0,${integerDigits - 1}})(?:\\.[0-9]+)?$`).test(value));
  const [whole, raw = ''] = value.split('.');
  const fraction = raw.replace(/0+$/, '');
  need(fraction.length <= 10);
  return `${whole}.${fraction.padEnd(fraction.length <= 4 ? 4 : 10, '0')}`;
}
export function unitPriceScaled(value, integerDigits = 10) {
  const [whole, fraction] = normalizeUnitPrice(value, integerDigits).split('.');
  return BigInt(whole) * PRICE_SCALE + BigInt(fraction.padEnd(10, '0'));
}
export function isCanonicalUnitPrice(value, integerDigits = 10) {
  try { return typeof value === 'string' && normalizeUnitPrice(value, integerDigits) === value; }
  catch { return false; }
}
function decimal(value, precision, integers, code) {
  need(typeof value === 'string' && new RegExp(`^(0|[1-9][0-9]{0,${integers - 1}})(?:\\.[0-9]{1,${precision}})?$`).test(value), code);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0'));
}
const rounded = (numerator, denominator) => (numerator + denominator / 2n) / denominator;
const cents = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
/** Existing line-rounding order: quantity × exact price -> cents, then line discount -> cents. */
export function calculateUnitPriceLine(quantity, unitPrice, discountPercent = '0') {
  const q = decimal(quantity, 6, 9, 'DOCUMENT_DECIMAL_INVALID');
  need(q > 0n, 'DOCUMENT_QUANTITY_INVALID');
  const p = unitPriceScaled(unitPrice, 10);
  const rate = decimal(discountPercent, 4, 3, 'DOCUMENT_DECIMAL_INVALID');
  need(rate <= 1_000_000n, 'DOCUMENT_PERCENT_INVALID');
  const gross = rounded(q * p, 100_000_000_000_000n); // quantity6 + price10 -> cents2
  need(gross <= MAX_CENTS, 'DOCUMENT_TOTAL_LIMIT');
  const discount = rounded(gross * rate, 1_000_000n);
  return {gross:cents(gross),discount:cents(discount),total:cents(gross - discount)};
}
