export type CustomFilterItem = { field_id: string; value?: string; from?: string; to?: string };
export const CUSTOM_FILTER_MAX: number;
export const CUSTOM_FILTER_TEXT: number;
export const CUSTOM_FILTER_PARAM: number;
export class CustomFilterError extends Error { constructor(); }
export function customFilterList(value: unknown): CustomFilterItem[];
export function customFilterParam(list: unknown): string;
export function parseCustomFilterParam(text: unknown): CustomFilterItem[];
