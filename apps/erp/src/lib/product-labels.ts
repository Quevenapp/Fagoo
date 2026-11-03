import { code128, ean13, upca } from './barcodes.ts';

// "Imprimir etiquetas" da listagem de produtos: o código de barras de cada etiqueta sai do GTIN do produto (EAN-13, UPC-A, EAN-8
// ou ITF-14, com o dígito verificador conferido) ou, sem GTIN válido, do código (SKU) em Code 128. Encoders locais, sem rede.
export type LabelBarcode = { format: 'EAN-13' | 'UPC-A' | 'EAN-8' | 'ITF-14' | 'Code 128'; value: string; bits: string };
const gtinCheck = (body: string) => { const sum = [...body].reverse().reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 3 : 1), 0); return String((10 - sum % 10) % 10); };
export const validGtin = (value: string) => /^(\d{8}|\d{12,14})$/.test(value) && value.at(-1) === gtinCheck(value.slice(0, -1));
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map(code => [...code].map(bit => bit === '1' ? '0' : '1').join(''));
/** EAN-8: 101 + 4 digits (L) + 01010 + 4 digits (R) + 101. */
export function ean8(value: string): string | null {
  if (!/^\d{8}$/.test(value) || !validGtin(value)) return null;
  return `101${[...value.slice(0, 4)].map(d => L[Number(d)]).join('')}01010${[...value.slice(4)].map(d => R[Number(d)]).join('')}101`;
}
// ITF (Interleaved 2 of 5): narrow = 1 module, wide = 3 modules; quiet zones are left to the label margins.
const ITF = ['00110', '10001', '01001', '11000', '00101', '10100', '01100', '00011', '10010', '01010'];
export function itf14(value: string): string | null {
  if (!/^\d{14}$/.test(value) || !validGtin(value)) return null;
  let bits = '1010';
  for (let i = 0; i < 14; i += 2) {
    const bars = ITF[Number(value[i])], spaces = ITF[Number(value[i + 1])];
    for (let k = 0; k < 5; k++) bits += (bars[k] === '1' ? '111' : '1') + (spaces[k] === '1' ? '000' : '0');
  }
  return `${bits}11101`;
}
/** The barcode of a product label, or null when it has neither a valid GTIN nor a code. */
export function productBarcode(gtin: string | null | undefined, code: string | null | undefined): LabelBarcode | null {
  const g = (gtin ?? '').trim();
  if (validGtin(g)) {
    const bits = g.length === 13 ? ean13(g) : g.length === 12 ? upca(g) : g.length === 8 ? ean8(g) : itf14(g);
    if (bits) return { format: g.length === 13 ? 'EAN-13' : g.length === 12 ? 'UPC-A' : g.length === 8 ? 'EAN-8' : 'ITF-14', value: g, bits };
  }
  const c = (code ?? '').trim(), bits = c ? code128(c) : null;
  return bits ? { format: 'Code 128', value: c, bits } : null;
}
export type LabelModel = { id: 'a4' | 'thermal'; label: string; columns: number; width: number; height: number; perPage: number };
// Pimaco A4356 (A4, 3 × 11, 63,5 × 25,4 mm) and a 1-column thermal roll (60 × 40 mm).
export const LABEL_MODELS: readonly LabelModel[] = [{ id: 'a4', label: 'A4 — Pimaco A4356 (3 colunas, 63,5 × 25,4 mm)', columns: 3, width: 63.5, height: 25.4, perPage: 33 },
  { id: 'thermal', label: 'Térmica — 1 coluna (60 × 40 mm)', columns: 1, width: 60, height: 40, perPage: 1 }];
/** Each product repeated by its quantity (1 to 999), in the order of the list; at most 2.000 labels per print. */
export function labelSheet<T extends { id: string }>(products: readonly T[], quantities: Record<string, string>): T[] {
  const out: T[] = [];
  for (const product of products) { const n = Number(quantities[product.id] ?? '1'); if (Number.isInteger(n) && n >= 1 && n <= 999) for (let i = 0; i < n && out.length < 2000; i++) out.push(product); }
  return out;
}
