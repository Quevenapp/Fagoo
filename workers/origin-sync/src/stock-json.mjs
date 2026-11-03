/** Exact stock quantities from the existing bounded JSON grammar. */
import { parseSelectedPriceJson } from './price-json-parser.mjs';

export const STOCK_CAPTURE_PROFILE = 'origin-stock-json-v1';
const captured = new WeakMap();
const totals = new Set(['saldoFisicoTotal', 'saldoVirtualTotal']);
const quantities = new Set(['saldoFisico', 'saldoVirtual']);

export const stockCapture = value => captured.get(value) ?? null;

export async function parseStockJson(text, bytes) {
  const { result, tokens } = await parseSelectedPriceJson(text, bytes, path => {
    if (path[0] !== 'data' || typeof path[1] !== 'number') return null;
    if (path.length === 3 && totals.has(path[2])) return [path[1], `/${path[2]}`];
    if (path.length === 5 && path[2] === 'depositos' && typeof path[3] === 'number' && quantities.has(path[4])) {
      return [path[1], `/depositos/${path[3]}/${path[4]}`];
    }
    return null;
  });
  if (Array.isArray(result?.data)) result.data.forEach((item, index) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      // A response hash would make this product change when another row changes.
      // Keep evidence local to the product; raw_record already hashes its payload.
      captured.set(item, Object.freeze({ profile: STOCK_CAPTURE_PROFILE, tokens: Object.freeze(tokens.get(index) ?? []) }));
    }
  });
  return result;
}
