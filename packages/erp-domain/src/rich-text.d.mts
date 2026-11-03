export type RichAlign = 'left' | 'center' | 'right' | 'justify';
export interface RichRun { text: string; bold: boolean; italic: boolean; underline: boolean; color: string | null; background: string | null; size: number | null }
export interface RichBlock { align: RichAlign; indent: number; code: boolean; runs: RichRun[] }
export interface RichText { version: 1; blocks: RichBlock[] }
export const RICH_ALIGNS: readonly RichAlign[];
export const RICH_SIZES: readonly number[];
export const RICH_LIMITS: Readonly<{ blocks: number; runs: number; characters: number; indent: number }>;
export const RICH_BLOCK_KEYS: readonly string[];
export const RICH_RUN_KEYS: readonly string[];
export class RichTextError extends Error { code: 'DOCUMENT_RICH_TEXT_INVALID' }
export function normalizeRichText(value: unknown): RichText | null;
export function richTextPlain(doc: RichText | null | undefined): string;
export function richTextEmpty(doc: RichText | null | undefined): boolean;
