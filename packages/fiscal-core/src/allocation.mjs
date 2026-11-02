/** Exact allocation arithmetic only. No tax policy, database, XML or transport. */
export const ALLOCATION_ALGORITHM = 'largest-remainder-uuid-v1';
export const ALLOCATION_MAX_ITEMS = 250;
export const ALLOCATION_MAX_CENTS = '999999999999999';
const MAX_CENTS = BigInt(ALLOCATION_MAX_CENTS);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TYPES = ['amount', 'quantity', 'manual', 'equal'];
const KINDS = ['discount', 'freight', 'other'];
const own = (value, field) => Object.hasOwn(value, field);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => own(value, key));

export class AllocationError extends Error {
  constructor(code, itemId = null) {
    super(code);
    this.name = 'AllocationError';
    this.code = code;
    // Only a validated line UUID may accompany an error, never input amounts/text.
    this.item_id = itemId;
  }
}
const reject = (code, itemId) => { throw new AllocationError(code, itemId); };
const cents = (value, code, id = null) => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,14})$/.test(value)) reject(code, id);
  const result = BigInt(value);
  if (result > MAX_CENTS) reject(code, id);
  return result;
};
const decimalWeight = (value, id) => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value)) {
    reject('ALLOCATION_INVALID_WEIGHT', id);
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
};
const validUnit = value => typeof value === 'string' && value.length >= 1 && value.length <= 16
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);

/**
 * Each call allocates one explicitly selected component independently. Input
 * weights are supplied by the caller, not inferred from commercial/tax fields.
 * Money and weights are string inputs; every arithmetic operation uses BigInt.
 */
export function allocateFiscalAmount(input) {
  if (!exactKeys(input, ['kind', 'total_cents', 'basis', 'items']) || !KINDS.includes(input.kind)) {
    reject('ALLOCATION_INVALID_INPUT');
  }
  const basis = input.basis;
  if (!object(basis) || !TYPES.includes(basis.type)
      || !exactKeys(basis, basis.type === 'quantity' ? ['type', 'unit'] : ['type'])) {
    reject('ALLOCATION_INVALID_BASIS');
  }
  if (basis.type === 'quantity' && !validUnit(basis.unit)) reject('ALLOCATION_INVALID_UNIT');
  const total = cents(input.total_cents, 'ALLOCATION_INVALID_TOTAL');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > ALLOCATION_MAX_ITEMS) {
    reject('ALLOCATION_INVALID_ITEMS');
  }
  const scale = ['quantity', 'manual'].includes(basis.type) ? 6 : 0;
  const discount = input.kind === 'discount';
  const fields = ['id', ...(basis.type === 'equal' ? [] : ['weight']),
    ...(basis.type === 'quantity' ? ['unit'] : []), ...(discount ? ['discount_capacity_cents'] : [])];
  const ids = new Set();
  const rows = Array.from(input.items, item => {
    if (!exactKeys(item, fields) || typeof item.id !== 'string' || !UUID.test(item.id)) {
      reject('ALLOCATION_INVALID_ITEM');
    }
    const id = item.id.toLowerCase();
    if (ids.has(id)) reject('ALLOCATION_DUPLICATE_ITEM', id);
    ids.add(id);
    if (basis.type === 'quantity' && (!validUnit(item.unit) || item.unit !== basis.unit)) {
      reject('ALLOCATION_UNIT_MISMATCH', id);
    }
    const weight = basis.type === 'equal' ? 1n : scale === 6 ? decimalWeight(item.weight, id)
      : cents(item.weight, 'ALLOCATION_INVALID_WEIGHT', id);
    const capacity = discount ? cents(item.discount_capacity_cents, 'ALLOCATION_INVALID_CAPACITY', id) : null;
    return { id, weight, capacity, floor: 0n, remainder: 0n, extra: 0n };
  });
  const weightTotal = rows.reduce((sum, row) => sum + row.weight, 0n);
  if (total > 0n && weightTotal === 0n) reject('ALLOCATION_ZERO_BASIS');
  // Zero-weight lines are not eligible for any part of this component.
  const eligible = rows.filter(row => row.weight > 0n);
  if (discount && total > eligible.reduce((sum, row) => sum + row.capacity, 0n)) {
    reject('ALLOCATION_DISCOUNT_TOTAL_EXCEEDS_CAPACITY');
  }
  if (weightTotal > 0n) {
    for (const row of rows) {
      const numerator = total * row.weight;
      row.floor = numerator / weightTotal;
      row.remainder = numerator % weightTotal;
    }
  }
  let remaining = total - rows.reduce((sum, row) => sum + row.floor, 0n);
  // Sort a separate array. Tie resolution is independent of input/display order.
  const ranked = [...eligible].sort((a, b) => a.remainder !== b.remainder
    ? a.remainder > b.remainder ? -1 : 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const row of ranked) {
    if (remaining === 0n) break;
    row.extra = 1n;
    remaining -= 1n;
  }
  if (remaining !== 0n) reject('ALLOCATION_ARITHMETIC_INVARIANT');
  for (const row of rows) {
    if (discount && row.floor + row.extra > row.capacity) {
      // Rebalancing after a cap would change the selected proportional rule.
      reject('ALLOCATION_DISCOUNT_ITEM_EXCEEDS_CAPACITY', row.id);
    }
  }
  const allocated = rows.reduce((sum, row) => sum + row.floor + row.extra, 0n);
  if (allocated !== total) reject('ALLOCATION_ARITHMETIC_INVARIANT');
  return {
    data_mode: 'mathematical_allocation', algorithm: ALLOCATION_ALGORITHM,
    tie_break: 'uuid_ascending', operational_effects: false, emission_enabled: false,
    can_emit: false, tax_rules_validated: false, xsd_validated: false,
    kind: input.kind,
    basis: { type: basis.type, ...(basis.type === 'quantity' ? { unit: basis.unit } : {}),
      weight_scale: scale, weight_total_units: weightTotal.toString() },
    total_cents: total.toString(), allocated_total_cents: allocated.toString(), undistributed_cents: '0',
    items: rows.map(row => ({ id: row.id, weight_units: row.weight.toString(),
      floor_cents: row.floor.toString(), remainder_numerator: row.remainder.toString(),
      rounding_cent: row.extra.toString(), allocated_cents: (row.floor + row.extra).toString(),
      ...(discount ? { discount_capacity_cents: row.capacity.toString() } : {}) })),
  };
}
