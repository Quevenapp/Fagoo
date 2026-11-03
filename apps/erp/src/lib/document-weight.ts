// Preferências "Somar peso bruto dos produtos nos pedidos": Σ (peso bruto do produto × quantidade), in exact decimals.
// The result keeps 6 decimal places (the precision of the transport gross weight), rounded half up; never a float.
const SCALE = 1_000_000n;
const parse = (value: unknown, integers: number): bigint | null => {
  if (typeof value !== 'string' || !new RegExp(String.raw`^(0|[1-9]\d{0,${integers - 1}})(\.\d{1,6})?$`).test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(6, '0'));
};
export function formatWeight(value: bigint): string {
  const whole = value / SCALE, fraction = String(value % SCALE).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
/**
 * Sum of the lines linked to a product with a known gross weight. `null` when no line has one (the field stays empty)
 * or when a quantity cannot be read yet (the user is still typing).
 */
export function grossWeightSum(items: readonly { id?: string | null; product_id?: string | null; quantity: string }[], weightOf: (item: { id?: string | null; product_id?: string | null }) => unknown): string | null {
  let total = 0n, any = false;
  for (const item of items) {
    if (!item.product_id) continue;
    const weight = parse(weightOf(item), 12);
    if (weight === null) continue;
    const quantity = parse(item.quantity, 9);
    if (quantity === null) return null;
    total += (weight * quantity + SCALE / 2n) / SCALE; any = true;
  }
  if (!any || total > 999_999_999_999_999_999n) return null;
  return formatWeight(total);
}
