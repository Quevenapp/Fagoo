// 202610200169: históricos of the document forms (`/v1/documentos/{tipo}/historico`), read-only.
import type { DocumentKind } from './real-documents-model';
import { compactDocumentDecimal, documentDecimalDisplay } from './document-decimals.ts';
import { decimalMoney } from './real-access.ts';

export type HistoryRequest = { mode: 'client' } | { mode: 'item' | 'purchase'; productId: string; label: string };
export type HistoryLine = { type: 'sale' | 'invoice' | 'purchase' | 'stock'; document_id: string; number: string | null; date: string; position: number; description: string; code: string | null;
  product_id: string | null; unit: string; quantity: string; unit_price: string };
export type HistoryTitle = { id: string; due_on: string; description: string; installment: number; installments: number; amount: string; open_amount: string };
export type HistoryPage = { items: HistoryLine[]; has_more: boolean; invoices_included: boolean;
  finance: { open_count: number; open_amount: string; overdue_amount: string; titles: HistoryTitle[] } | null;
  /** 202610200239: the OS without "Histórico financeiro" (Sistema › Usuários) gets no Financeiro tab data. */
  finance_hidden?: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/, MONEY = /^\d{1,12}\.\d{2}$/;
function fail(): never { throw new Error('HISTORY_INVALID'); }
export const HISTORY_TYPES: Record<HistoryLine['type'], string> = { sale: 'Venda', invoice: 'Nota Fiscal', purchase: 'Pedido de compra', stock: 'Lançamento de estoque' };
export const HISTORY_TITLES = { client: 'Últimos registros deste cliente', item: 'Últimas vendas deste item para este cliente', purchase: 'Últimas compras' } as const;
/** Only 10 records for one product (Origin: "* São exibidos apenas os 10 últimos registros."), 50 for the cliente. */
export const historyLimit = (request: HistoryRequest) => request.mode === 'client' ? 50 : 10;

export function historyPath(kind: DocumentKind, request: HistoryRequest, contactId: string | null, query = ''): string {
  const params = new URLSearchParams();
  if (contactId) params.set('contact_id', contactId);
  if (request.mode !== 'client') params.set('product_id', request.productId);
  if (request.mode === 'client' && query.trim()) params.set('q', query.trim().slice(0, 120));
  params.set('limit', String(historyLimit(request)));
  return `/v1/documentos/${kind}/historico?${params}`;
}

export function readHistory(value: unknown, request: HistoryRequest): HistoryPage {
  const page = value as Partial<HistoryPage> | null;
  if (!page || !Array.isArray(page.items) || page.items.length > historyLimit(request) || typeof page.has_more !== 'boolean' || typeof page.invoices_included !== 'boolean') fail();
  const items = page.items!.map(item => {
    if (!item || !['sale', 'invoice', 'purchase', 'stock'].includes(item.type) || !UUID.test(item.document_id) || (item.type === 'stock' ? item.number !== null || request.mode !== 'purchase' : typeof item.number !== 'string') || !DAY.test(item.date)
      || typeof item.description !== 'string' || typeof item.unit !== 'string' || !/^\d+\.\d{6}$/.test(item.quantity) || !/^\d+\.\d{4}(\d{6})?$/.test(item.unit_price)
      || (request.mode !== 'client' && item.product_id !== request.productId)) fail();
    return { ...item };
  });
  const finance = page.finance ?? null, hidden = page.finance_hidden === true;
  if (page.finance_hidden !== undefined && (!hidden || request.mode !== 'client' || finance !== null)) fail();
  if (request.mode === 'client' && !hidden) {
    if (!finance || !Number.isInteger(finance.open_count) || !MONEY.test(finance.open_amount) || !MONEY.test(finance.overdue_amount) || !Array.isArray(finance.titles)
      || finance.titles.some(t => !t || !UUID.test(t.id) || !DAY.test(t.due_on) || !MONEY.test(t.amount) || !MONEY.test(t.open_amount))) fail();
  } else if (finance !== null) fail();
  return { items, has_more: page.has_more!, invoices_included: page.invoices_included!, finance: finance ? { ...finance, titles: finance.titles.map(t => ({ ...t })) } : null, ...(hidden ? { finance_hidden: true } : {}) };
}

export const historyDay = (value: string) => value.split('-').reverse().join('/');
export const historyPrice = (value: string) => decimalMoney(compactDocumentDecimal(value));
export const historyQuantity = (value: string) => documentDecimalDisplay(compactDocumentDecimal(value));
