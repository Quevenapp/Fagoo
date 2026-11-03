// Origin "Totais" helpers of the document editor. Exact decimals only: quantities and prices never become a Number.
import { decimal, format } from '../../../../packages/erp-domain/src/index.mjs';
import { unitPriceScaled } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { compactDocumentDecimal, documentDecimalDisplay } from './document-decimals.ts';
import type { DocumentInput, DocumentItemInput } from './real-documents-model';

/** "Soma das quantidades": exact sum of the six-decimal quantities, or null while a line is being typed. */
export function quantitySum(items: readonly Pick<DocumentItemInput, 'quantity'>[]): string | null {
  try { let total = 0n; for (const item of items) total += decimal(item.quantity, 6, 9); return compactDocumentDecimal(format(total, 6)); }
  catch { return null; }
}

/** Origin single discount field ("Ex: 3,00 ou 10%"): the percent sign selects the percentual mode. */
export function discountText(input: Pick<DocumentInput, 'discount_mode' | 'discount_value'>): string {
  // Initial text of the field; while typing the editor keeps its own text so "2,0" never collapses to "2".
  const value = documentDecimalDisplay(input.discount_value ?? '0');
  return input.discount_mode === 'percent' ? `${value}%` : /^0(?:,0*)?$/.test(value) ? '' : value;
}
export function parseDiscountText(text: string): { discount_mode: 'amount' | 'percent'; discount_value: string } {
  const trimmed = text.trim();
  const percent = /%\s*$/.test(trimmed);
  const value = trimmed.replace(/%\s*$/, '').trim().replaceAll(',', '.');
  return { discount_mode: percent ? 'percent' : 'amount', discount_value: value || '0' };
}

/** Origin highlights a unit price below the list price; without a price list the catalog price is the reference. */
export function belowListPrice(unitPrice: string, listPrice: unknown): boolean {
  if (typeof listPrice !== 'string') return false;
  try { return unitPriceScaled(unitPrice, 10) < unitPriceScaled(listPrice, 14); } catch { return false; }
}
export const BELOW_LIST_TITLE = 'O preço unitário deste item está abaixo do preço de lista!';

/** "Cadastrada em: dd/mm/aaaa hh:mm:ss" in America/Sao_Paulo. */
export function registeredAt(instant: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}:${part('second')}`;
}
