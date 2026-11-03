// Importação de registros financeiros do Origin (SQL 138): planilha CSV conforme a "tabela modelo", lida no navegador,
// conferida linha a linha pelo servidor (prévia) e importada só com as linhas novas. Nada é atualizado: uma linha já
// importada continua como está.
import { moneyInput } from './real-finance-model.ts';
import { sheetRecords } from './finance-sheet-import.ts';
import { toCsv, textCell, zipStore } from './spreadsheet-export.ts';

export type ImportKind = 'receivable' | 'payable' | 'cash';
export const IMPORT_KINDS: readonly { id: ImportKind; label: string }[] = [{ id: 'receivable', label: 'Conta a Receber' }, { id: 'payable', label: 'Conta a Pagar' }, { id: 'cash', label: 'Registros de caixa' }];
export const IMPORT_MAX_ROWS = 1000;
/** Columns of each model sheet, in order. Headers are matched without accents or case. */
export const IMPORT_HEADERS: Readonly<Record<ImportKind, readonly string[]>> = {
  receivable: ['Data de emissão', 'Vencimento', 'Competência', 'Valor', 'Histórico', 'Cliente', 'CPF/CNPJ', 'Categoria', 'Conta financeira', 'Nº documento'],
  payable: ['Data de emissão', 'Vencimento', 'Competência', 'Valor', 'Histórico', 'Fornecedor', 'CPF/CNPJ', 'Categoria', 'Conta financeira', 'Nº documento'],
  cash: ['Data', 'Competência', 'Tipo', 'Valor', 'Histórico', 'Contato', 'CPF/CNPJ', 'Categoria', 'Conta financeira'],
};
const TEMPLATE_FILES: Readonly<Record<ImportKind, string>> = { receivable: 'contas-a-receber.csv', payable: 'contas-a-pagar.csv', cash: 'registros-de-caixa.csv' };
export const TEMPLATE_ZIP = 'tabela-modelo-registros-financeiros.zip';
/** The "tabela modelo": one CSV per Tipo de registro, only the header line (nothing to import by mistake). */
export function importTemplates(): Uint8Array {
  const encoder = new TextEncoder();
  return zipStore(IMPORT_KINDS.map(kind => ({ name: TEMPLATE_FILES[kind.id], data: encoder.encode(toCsv([IMPORT_HEADERS[kind.id].map(textCell)])) })));
}

export interface ImportRow { line: number; issued_on: string; due_on?: string; competence_on?: string | null; amount_cents: string; side?: string | null; description: string;
  contact_name?: string | null; contact_document?: string | null; category?: string | null; account?: string | null; document?: string | null }
/** dd/mm/aaaa (or aaaa-mm-dd) to the ISO date; anything else goes as typed and the server reports the column. */
export function sheetDate(value: string): string {
  const text = value.trim(), br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  return br ? `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}` : text;
}
/** "1.234,56" / "1234,56" / "1234.56" to cents; a negative value in Registros de caixa is a saída. */
export function sheetCents(value: string): { cents: string; negative: boolean } {
  const text = value.trim().replace(/^R\$\s*/i, ''), negative = /^-/.test(text), unsigned = text.replace(/^-\s*/, '');
  const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(unsigned) ? unsigned.replaceAll('.', '') : /^\d+\.\d{1,2}$/.test(unsigned) ? unsigned.replace('.', ',') : unsigned;
  try { return { cents: moneyInput(normalized), negative }; } catch { return { cents: text, negative }; }
}
/** Entrada/Crédito → in, Saída/Débito → out; empty follows the sign of the Valor; anything else is left for the server to report. */
export function sheetSide(value: string, negative: boolean): 'in' | 'out' | null {
  const text = value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  if (['entrada', 'credito', 'c', 'e', 'receita'].includes(text)) return 'in';
  if (['saida', 'debito', 'd', 's', 'despesa'].includes(text)) return 'out';
  return text ? null : negative ? 'out' : 'in';
}
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const optional = (value: string) => value.trim() || null;
/** The sheet lines as the rows of records_import_preview / records_import (at most 1.000 lines). */
export function importRows(kind: ImportKind, rows: readonly (readonly string[])[]): ImportRow[] {
  const headers = IMPORT_HEADERS[kind], records = sheetRecords(rows, headers);
  if (!records.length) throw new Error('A planilha não tem registros.');
  if (records.length > IMPORT_MAX_ROWS) throw new Error(`Importe até ${IMPORT_MAX_ROWS.toLocaleString('pt-BR')} registros por arquivo.`);
  return records.map(({ line, values: raw }) => {
    const values = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value.replace(CONTROL, ' ')]));
    if (Object.values(values).some(value => value.length > 2000)) throw new Error(`A linha ${line} tem uma coluna com mais de 2.000 caracteres.`);
    const amount = sheetCents(values['Valor']);
    const common = { line, amount_cents: amount.cents, description: values['Histórico'].trim(), contact_document: optional(values['CPF/CNPJ']), category: optional(values['Categoria']), account: optional(values['Conta financeira']) };
    if (kind === 'cash') {
      return { ...common, issued_on: sheetDate(values['Data']), competence_on: values['Competência'].trim() ? sheetDate(values['Competência']) : null, contact_name: optional(values['Contato']), side: sheetSide(values['Tipo'], amount.negative) };
    }
    return { ...common, issued_on: sheetDate(values['Data de emissão']), due_on: sheetDate(values['Vencimento']), competence_on: values['Competência'].trim() ? sheetDate(values['Competência']) : null,
      contact_name: optional(values[kind === 'receivable' ? 'Cliente' : 'Fornecedor']), document: optional(values['Nº documento']) };
  }).map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as unknown as ImportRow);
}

export type PreviewStatus = 'new' | 'duplicate' | 'error';
export interface PreviewRow { line: number; status: PreviewStatus; errors: string[] }
export const IMPORT_ERROR_LABEL: Readonly<Record<string, string>> = {
  data: 'Data', vencimento: 'Vencimento', competencia: 'Competência', valor: 'Valor', tipo: 'Tipo (Entrada ou Saída)', historico: 'Histórico',
  contato: 'Contato não encontrado ou repetido', categoria: 'Categoria não encontrada', conta: 'Conta financeira não encontrada', documento: 'Nº documento',
};
export const PREVIEW_LABEL: Readonly<Record<PreviewStatus, string>> = { new: 'Novo', duplicate: 'Já importado', error: 'Com erro' };
const fail = (): never => { throw new Error('Não foi possível conferir a prévia da importação. Envie o arquivo novamente.'); };
export function importPreview(value: unknown, kind: ImportKind, rows: readonly ImportRow[]): PreviewRow[] {
  const v = value as { entity?: unknown; kind?: unknown; rows?: unknown; data_mode?: unknown } | null;
  if (!v || v.entity !== 'financial_import' || v.kind !== kind || v.data_mode !== 'erp_native' || !Array.isArray(v.rows) || v.rows.length !== rows.length) fail();
  return (v!.rows as unknown[]).map((item, index) => {
    const row = item as { line?: unknown; status?: unknown; errors?: unknown } | null;
    if (!row || row.line !== rows[index].line || !['new', 'duplicate', 'error'].includes(String(row.status)) || !Array.isArray(row.errors) || row.errors.some(error => typeof error !== 'string') || (row.status === 'error') !== (row.errors.length > 0)) fail();
    return { line: rows[index].line, status: row!.status as PreviewStatus, errors: [...row!.errors as string[]] };
  });
}
export function importResult(value: unknown, kind: ImportKind, sent: number): { created: number; skipped: number; replayed: boolean } {
  const v = value as { action?: unknown; entity?: unknown; kind?: unknown; created?: unknown; skipped?: unknown; replayed?: unknown } | null;
  if (!v || v.action !== 'records_import' || v.entity !== 'financial_import' || v.kind !== kind || !Number.isSafeInteger(v.created) || !Number.isSafeInteger(v.skipped) || typeof v.replayed !== 'boolean'
    || (v.created as number) + (v.skipped as number) !== sent) fail();
  return { created: v!.created as number, skipped: v!.skipped as number, replayed: v!.replayed as boolean };
}
