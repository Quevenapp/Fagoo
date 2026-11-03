export class ProductDetailError extends Error { readonly field: string; readonly code: string; constructor(field: string, code?: string); }
export const PRODUCT_ITEM_TYPES: readonly (readonly [string, string])[];
export const PRODUCT_DETAIL_TEXTS: Readonly<Record<string, readonly [number, boolean]>>;
export const PRODUCT_DETAIL_DECIMALS: Readonly<Record<string, readonly [number, number, string?]>>;
export const PRODUCT_DETAIL_CODES: Readonly<Record<string, RegExp>>;
export const PRODUCT_DETAIL_LISTS: Readonly<Record<'dun_codes' | 'suppliers' | 'tag_ids' | 'images', number>>;
export const PRODUCT_CUSTOM_VALUES_MAX: number;
export const PRODUCT_DETAIL_KEYS: readonly string[];
export const SUPPLIER_KEYS: readonly string[];
export function isoDate(value: unknown): boolean;
export function decimalCompare(a: string, b: string): -1 | 0 | 1;
export function decimalValid(value: unknown, spec: readonly [number, number, string?], exact?: boolean): boolean;
export function checkProductDetail(key: string, value: unknown, options?: { response?: boolean }): void;
export function productDetailRequest(data: Record<string, unknown>): void;
export function productDetailResponse(value: Record<string, unknown>): Record<string, unknown>;
