/** Business quantities and money never pass through binary floating-point arithmetic. */
export class BusinessError extends Error {
  constructor(status, code, details) { super(code); this.name = 'BusinessError'; this.status = status; this.code = code; this.details = details; }
}
export function assert(ok, code = 'INVALID_INPUT', status = 400, details) { if (!ok) throw new BusinessError(status, code, details); }
export function scaled(value, scale = 6, { signed = false, digits = 12 } = {}) {
  assert(typeof value === 'string' && new RegExp(`^${signed ? '-?' : ''}(0|[1-9][0-9]{0,${digits - 1}})(?:\\.[0-9]{1,${scale}})?$`).test(value), 'DECIMAL_STRING_REQUIRED');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
  return negative ? -result : result;
}
export function formatted(value, scale = 6) {
  const sign = value < 0n ? '-' : ''; const abs = value < 0n ? -value : value; const base = 10n ** BigInt(scale);
  return `${sign}${abs / base}.${String(abs % base).padStart(scale, '0')}`;
}
export function quantity(value, positive = false) { const n = scaled(value, 6); assert(!positive || n > 0n, 'QUANTITY_MUST_BE_POSITIVE'); return formatted(n, 6); }
export function price(value) { return formatted(scaled(value, 10, { digits: 14 }), 10); }
export function money(value, positive = false) { const n = scaled(value, 2, { digits: 14 }); assert(!positive || n > 0n, 'AMOUNT_MUST_BE_POSITIVE'); return formatted(n, 2); }
export function lineTotal(q, p) {
  const numerator = scaled(q, 6) * scaled(p, 10, { digits: 14 });
  const amount = (numerator + 50_000_000_000_000n) / 100_000_000_000_000n;
  assert(amount <= 99_999_999_999_999n, 'AMOUNT_TOO_LARGE'); return formatted(amount, 2);
}
export function baseQuantity(q, factor) {
  const product = scaled(q, 6) * scaled(factor, 6);
  assert(product % 1_000_000n === 0n, 'UNIT_CONVERSION_PRECISION');
  return quantity(formatted(product / 1_000_000n), true);
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function uuid(value) { assert(typeof value === 'string' && UUID.test(value), 'UUID_REQUIRED'); return value.toLowerCase(); }
export function text(value, max = 200, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  assert(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max && !/[\x00-\x1f\x7f]/.test(value), 'TEXT_INVALID');
  return value.trim();
}
export function date(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, 'DATE_INVALID'); return value;
}
export function version(value) { assert(Number.isSafeInteger(value) && value > 0 && value < 2147483647, 'VERSION_REQUIRED'); return value; }
export function object(value, allowed) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k)), 'INVALID_FIELDS'); return value;
}
