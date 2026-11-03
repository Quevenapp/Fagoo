export const UNIT_PRICE_INPUT_LIMIT: 80;
export class UnitPriceError extends Error { readonly code: string; constructor(code?: string); }
export function normalizeUnitPrice(value: unknown, integerDigits?: 10 | 14): string;
export function unitPriceScaled(value: unknown, integerDigits?: 10 | 14): bigint;
export function isCanonicalUnitPrice(value: unknown, integerDigits?: 10 | 14): boolean;
export function calculateUnitPriceLine(quantity: string, unitPrice: string, discountPercent?: string): {gross:string;discount:string;total:string};
