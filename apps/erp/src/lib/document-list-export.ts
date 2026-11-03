// "Imprimir listagem" and "Exportar dados para planilha" over the whole filtered set (not only the visible page).
// Pages are read one by one with the same filter and order; totals come from the server in exact cents.
import { STATES, type DocumentKind } from './real-documents-model.ts';
import { DOCUMENT_LIST_PAGE_SIZE, brDay, type DocumentListPage, type DocumentListRow } from './document-list-model.ts';
import { documentObservedAt, documentOriginLabel, isDocumentMirror, mirrorDecimal, type DocumentOriginTotals } from './document-mirror-model.ts';

/** Safety limit: 50 pages of 100. Larger sets must be narrowed by the filters first. */
export const LIST_READ_MAX_ROWS = 5000;
export const LIST_READ_MAX_PAGES = Math.ceil(LIST_READ_MAX_ROWS / DOCUMENT_LIST_PAGE_SIZE);

// Origin labels (capture of 19/10/2026). OS has no spreadsheet export in Origin; purchase orders are outside this lane.
export const LIST_PRINT_LABEL: Partial<Record<DocumentKind, string>> = { sales_orders: 'Imprimir listagem de vendas', sales_proposals: 'Imprimir listagem de propostas comerciais', service_orders: 'Imprimir listagem de ordens de serviço', purchase_orders: 'Imprimir listagem de pedidos de compra' };
export const LIST_EXPORT_LABEL: Partial<Record<DocumentKind, string>> = { sales_orders: 'Dados para planilha', sales_proposals: 'Exportar para a planilha' };
export const LIST_TITLES: Record<DocumentKind, string> = { sales_orders: 'Pedidos de venda', sales_proposals: 'Propostas comerciais', service_orders: 'Ordens de serviço', purchase_orders: 'Pedidos de compra' };
const COUNT: Record<DocumentKind, string> = { sales_orders: 'Quantidade de Vendas', sales_proposals: 'Quantidade de propostas', service_orders: 'Quantidade de serviços', purchase_orders: 'Quantidade de pedidos' };
export const listCountLabel = (kind: DocumentKind) => COUNT[kind];

export class ListReadError extends Error {}
export const tooLarge = (total: number) => new ListReadError(`A listagem filtrada tem ${total.toLocaleString('pt-BR')} registros. Refine os filtros para até ${LIST_READ_MAX_ROWS.toLocaleString('pt-BR')} registros antes de imprimir ou exportar.`);

/** `total_amount` null: Preferências "Exibir totais em listas" hides the sum for this user, so the print and the CSV omit it too. */
export interface ListSnapshot { kind: DocumentKind; rows: DocumentListRow[]; total_count: number; total_amount: string | null; origin_totals?: DocumentOriginTotals }
/** Every page must describe the same filtered set (same total and amount), in order, without repeated rows. */
export function mergeListPages(kind: DocumentKind, pages: readonly DocumentListPage[]): ListSnapshot {
  if (!pages.length) throw new ListReadError('Nenhuma página foi lida.');
  const [first] = pages as [DocumentListPage, ...DocumentListPage[]];
  if (first.total_count > LIST_READ_MAX_ROWS) throw tooLarge(first.total_count);
  const seen = new Set<string>(), rows: DocumentListRow[] = [];
  pages.forEach((page, index) => {
    if (page.kind !== kind || page.page !== index + 1 || page.total_count !== first.total_count || page.total_amount !== first.total_amount || page.order !== first.order || JSON.stringify(page.origin_totals) !== JSON.stringify(first.origin_totals))
      throw new ListReadError('A listagem mudou durante a leitura. Tente novamente.');
    for (const row of page.items) { if (seen.has(row.id)) throw new ListReadError('A listagem mudou durante a leitura. Tente novamente.'); seen.add(row.id); rows.push(row); }
  });
  if (rows.length !== first.total_count) throw new ListReadError('A listagem mudou durante a leitura. Tente novamente.');
  return { kind, rows, total_count: first.total_count, total_amount: first.total_amount, ...(first.origin_totals ? { origin_totals: first.origin_totals } : {}) };
}

/** Exact money text with comma decimal and no thousands separator (spreadsheet friendly); never a Number. */
export function csvMoney(value: string): string {
  if (!/^(0|[1-9]\d*)\.\d{2}$/.test(value)) throw new ListReadError('Valor inválido na listagem.');
  return value.replace('.', ',');
}
export function printMoneyText(value: string): string {
  if (!/^(0|[1-9]\d*)\.\d{2}$/.test(value)) throw new ListReadError('Valor inválido na listagem.');
  return mirrorDecimal(value, true);
}
// Leading =, +, -, @ (after spaces or controls) become text, so a contact name never runs as a spreadsheet formula.
export const csvCell = (value: string) => `"${(/^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/u.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;

export interface ListColumn { key: string; label: string; value: (row: DocumentListRow) => string; numeric?: boolean }
const statusText = (kind: DocumentKind, row: DocumentListRow) => `${STATES[kind][row.status] ?? row.status}${row.template ? ' (modelo)' : ''}`;
/** Columns of the standard Origin list for each document. */
export function listColumns(kind: DocumentKind, money: (value: string) => string, sourceMoney: (value: string) => string = value => mirrorDecimal(value, true)): ListColumn[] {
  const columns: ListColumn[] = [{ key: 'number', label: 'Número', value: row => row.number ?? 'Não informado' }, { key: 'date', label: 'Data', value: row => brDay(row.date) || 'Não informado' }];
  if (kind === 'sales_orders') columns.push({ key: 'expected_date', label: 'Data prevista', value: row => brDay(row.expected_date) });
  if (kind === 'sales_proposals') columns.push({ key: 'next_contact', label: 'Próx. Contato', value: row => brDay(row.next_contact) });
  if (kind === 'service_orders') columns.push({ key: 'expected_date', label: 'Data prevista', value: row => brDay(row.expected_date) });
  columns.push({ key: 'contact', label: kind === 'purchase_orders' ? 'Fornecedor' : 'Cliente', value: row => row.contact_name ?? 'Não informado' },
    { key: 'total', label: kind === 'sales_proposals' ? 'Valor' : 'Total (R$)', value: row => row.total === null ? 'Não informado' : isDocumentMirror(row) ? sourceMoney(row.total) : money(row.total), numeric: true },
    { key: 'status', label: 'Situação', value: row => isDocumentMirror(row) ? row.mirror?.source_status_label ?? row.mirror?.source_status ?? 'Não informada' : statusText(kind, row) },
    { key: 'origin', label: 'Origem', value: documentOriginLabel },
    { key: 'source_id', label: 'ID Origin', value: row => row.mirror?.source_id ?? '' },
    { key: 'observed_at', label: 'Observado em', value: row => isDocumentMirror(row) ? documentObservedAt(row.mirror?.observed_at) : '' },
    { key: 'coverage', label: 'Cobertura', value: row => isDocumentMirror(row) ? row.mirror?.partial ? 'Parcial' : 'Dados observados' : '' });
  return columns;
}

/** Semicolon CSV with BOM, CRLF and the totals line, like the other Brufap exports. */
export function documentListCsv(snapshot: ListSnapshot): string {
  const columns = listColumns(snapshot.kind, csvMoney, value => value.replace('.', ','));
  const lines = [columns.map(column => column.label), ...snapshot.rows.map(row => columns.map(column => column.value(row))),
    [listCountLabel(snapshot.kind), String(snapshot.total_count), ...(snapshot.total_amount === null || snapshot.origin_totals ? [] : ['Valor total', csvMoney(snapshot.total_amount)])],
    ...Object.entries(snapshot.origin_totals ?? {}).map(([origin, totals]) => [`Origem ${origin === 'origin' ? 'Origin' : 'FAGOO'}`, String(totals.count), 'Total informado', totals.total === null ? 'Não informado' : totals.total.replace('.', ','), `${totals.known_total_count} de ${totals.count} com valor informado`])];
  return '﻿' + lines.map(line => line.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
export const listFileName = (kind: DocumentKind, today: string) => `${({ sales_orders: 'pedidos-de-venda', sales_proposals: 'propostas-comerciais', service_orders: 'ordens-de-servico', purchase_orders: 'pedidos-de-compra' } as const)[kind]}-${today}.csv`;

// "Exportar › Endereços selecionados" and "Imprimir › Etiquetas selecionadas" (pedidos de venda).
export interface AddressLabel { name: string; address: string | null; reference: string }
const NOUN: Record<DocumentKind, string> = { sales_orders: 'Pedido', sales_proposals: 'Proposta', service_orders: 'OS', purchase_orders: 'Compra' };
export function addressLabels(kind: DocumentKind, rows: readonly DocumentListRow[]): AddressLabel[] {
  return rows.map(row => ({ name: row.contact_name ?? 'Não informado', address: row.address ?? null, reference: `${NOUN[kind]} ${row.number ?? 'Não informado'}` }));
}
/** Origin "Imprimir etiqueta" of the OS: identification of the equipment received (cliente, equipamento, número de série, entrada). */
export function serviceLabels(records: readonly { number: string; date: string; contact_snapshot: { name: string }; equipment?: string | null; serial_number?: string | null }[]): AddressLabel[] {
  return records.map(record => ({ name: record.contact_snapshot.name,
    address: [record.equipment ? `Equipamento: ${record.equipment}` : 'Equipamento não informado', record.serial_number ? `Nº de série: ${record.serial_number}` : ''].filter(Boolean).join(' · '),
    reference: `Ordem de serviço ${record.number} · Entrada ${brDay(record.date)}` }));
}
export function addressesCsv(kind: DocumentKind, rows: readonly DocumentListRow[]): string {
  const lines = [['Número', 'Cliente', 'Endereço', 'E-mail', 'Telefone'], ...rows.map(row => [row.number ?? 'Não informado', row.contact_name ?? 'Não informado', row.address ?? '', row.contact_email ?? '', row.contact_phone ?? ''])];
  void kind;
  return '\ufeff' + lines.map(line => line.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
export const addressesFileName = (today: string) => `enderecos-pedidos-${today}.csv`;
export const LABEL_GRIDS = { '2x5': { label: '2 colunas × 5 linhas', columns: 2, rows: 5 }, '2x7': { label: '2 colunas × 7 linhas', columns: 2, rows: 7 }, '3x7': { label: '3 colunas × 7 linhas', columns: 3, rows: 7 }, '3x10': { label: '3 colunas × 10 linhas', columns: 3, rows: 10 } } as const;
/** Splits the labels into A4 sheets of the chosen grid; the last sheet is filled with empty cells. */
export function labelSheets(labels: readonly AddressLabel[], grid: keyof typeof LABEL_GRIDS): (AddressLabel | null)[][] {
  const size = LABEL_GRIDS[grid].columns * LABEL_GRIDS[grid].rows, sheets: (AddressLabel | null)[][] = [];
  for (let start = 0; start < labels.length; start += size) { const sheet: (AddressLabel | null)[] = labels.slice(start, start + size); while (sheet.length < size) sheet.push(null); sheets.push(sheet); }
  return sheets;
}

// ---- 202610200166 "Exportar para a planilha" of the pedidos de compra: XLSX with the columns of the pedido and of the items ----
export interface ExportLine { position: number; code: string | null; description: string; unit: string; quantity: string; unit_price: string; discount_percent: string; total: string }
export interface ExportDocument { id: string; number: string; date: string; expected_date: string | null; status: string; situation_name: string | null; contact_name: string; contact_document: string | null;
  order_reference: string | null; internal_notes: string | null; freight: string; discount: string; total: string; items: ExportLine[] }
export interface ExportPage { kind: DocumentKind; date_from: string; date_to: string; page: number; size: number; total_count: number; has_more: boolean; items: ExportDocument[] }
/** The worker checks every field; this guards the pairing with the requested month and page. */
export function readExportPage(value: unknown, kind: DocumentKind, from: string, to: string, page: number): ExportPage {
  const result = value as ExportPage;
  if (!result || result.kind !== kind || result.date_from !== from || result.date_to !== to || result.page !== page || !Array.isArray(result.items) || typeof result.has_more !== 'boolean'
    || !Number.isSafeInteger(result.total_count) || result.total_count > LIST_READ_MAX_ROWS) throw new ListReadError('A planilha mudou durante a leitura. Tente novamente.');
  return result;
}
export const EXPORT_HEADER = ['Número', 'Data', 'Data prevista', 'Fornecedor', 'CPF/CNPJ', 'Situação', 'Ordem de compra', 'Observação interna', 'Frete', 'Desconto', 'Total do pedido',
  'Item', 'Código', 'Descrição', 'Unidade', 'Quantidade', 'Valor unitário', 'Desconto (%)', 'Total do item'] as const;
/** One row per item (the columns of the pedido repeat); a pedido without items keeps one row. Decimals stay exact text. */
export function exportRows(kind: DocumentKind, documents: readonly ExportDocument[]): string[][] {
  const head = (doc: ExportDocument) => [doc.number, brDay(doc.date), brDay(doc.expected_date), doc.contact_name, doc.contact_document ?? '', doc.situation_name ?? STATES[kind][doc.status] ?? doc.status,
    doc.order_reference ?? '', doc.internal_notes ?? '', doc.freight, doc.discount, doc.total];
  const trim = (value: string) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return documents.flatMap(doc => doc.items.length ? doc.items.map(line => [...head(doc), String(line.position), line.code ?? '', line.description, line.unit, trim(line.quantity), trim(line.unit_price), trim(line.discount_percent), line.total])
    : [[...head(doc), '', '', '', '', '', '', '', '']]);
}
export const exportFileName = (kind: DocumentKind, month: string) => `${LIST_TITLES[kind].toLowerCase().replace(/\s+/g, '-')}-${month}.xlsx`;
/** Columns 0-10 of the pedido and 11-18 of the item; the numeric ones become number cells. */
export const EXPORT_NUMERIC = new Set([8, 9, 10, 15, 16, 17, 18]);
