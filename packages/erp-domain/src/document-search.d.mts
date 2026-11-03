import type { DocumentKind } from './index.mjs';
export type SearchType = 'text' | 'number' | 'money' | 'date' | 'boolean' | 'option';
export type SearchOperator = 'contains' | 'not_contains' | 'eq' | 'ne' | 'starts_with' | 'gt' | 'ge' | 'lt' | 'le' | 'empty' | 'not_empty';
export interface SearchCondition { field: string; op: SearchOperator; value: string | null }
export const SEARCH_MAX: number; export const SEARCH_TEXT: number; export const SEARCH_PARAM: number; export const LOTS_MAX: number; export const LOT_CODE: number;
export class DocumentSearchError extends Error {}
export const SEARCH_FIELDS: Readonly<Record<DocumentKind, readonly (readonly [string, string, 'text' | 'number' | 'money' | 'date'])[]>>;
export const SEARCH_OPERATOR_LABELS: Readonly<Record<SearchOperator, string>>;
export const SEARCH_OPERATORS: Readonly<Record<SearchType, readonly SearchOperator[]>>;
export function searchFieldType(kind: DocumentKind, field: string, custom?: (id: string) => SearchType | null | undefined): SearchType | 'any' | null;
export function searchConditions(kind: DocumentKind, value: unknown, custom?: (id: string) => SearchType | null | undefined): SearchCondition[];
export function searchParam(kind: DocumentKind, list: unknown, custom?: (id: string) => SearchType | null | undefined): string;
export function parseSearchParam(kind: DocumentKind, text: string): SearchCondition[];
export function lotCodes(text: string): string[];
