import { stockCell, type CatalogStock } from './product-model.ts';

// Saldo observado no Origin na lista de produtos (migração 202610220008). Fica ao lado do estoque nativo do Brufap, nunca
// somado nem misturado com ele. Ausência, valor nulo ou inválido nunca viram zero; o virtual nunca é chamado de físico.
export type OriginStockState = 'observed' | 'multiple_warehouses' | 'not_observed' | 'source_deleted' | 'unlinked' | 'warehouse_unlinked';
export type OriginValueState = 'value' | 'absent' | 'null' | 'invalid';
export interface ProductOriginStock {
  origin: 'origin'; state: OriginStockState; product_source_id: string | null; warehouse_source_id: string | null; warehouse_name: string | null;
  physical: string | null; virtual: string | null; physical_state: OriginValueState | null; virtual_state: OriginValueState | null;
  observed_at: string | null; source_version: number | null; positions: number; issues: string[];
}
export interface ProductOriginStockPage { origin: 'origin'; status: 'ok' | 'forbidden' | 'unavailable'; warehouse: { id: string; source_id: string | null; linked: boolean } | null }
export type OriginCellState = OriginStockState | 'forbidden' | 'unavailable' | 'unread';
export interface OriginStockCell { text: string; detail: string; state: OriginCellState; title: string; quantity: string | null }

const STATES = new Set<OriginStockState>(['observed', 'multiple_warehouses', 'not_observed', 'source_deleted', 'unlinked', 'warehouse_unlinked']);
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
/** "1234.5" → "1.234,5"; the exact digits of the text, never a float. */
export function originQuantity(value: string) {
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const decimals = fraction.replace(/0+$/, ''), zero = /^0+$/.test(whole) && !decimals;
  return `${negative && !zero ? '−' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${decimals ? `,${decimals}` : ''}`;
}
export const originMoment = (value: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const missing = (state: OriginValueState | null) => state === 'invalid' ? 'Valor inválido na fonte' : 'Saldo não informado';
const usable = (stock: ProductOriginStock | null | undefined): stock is ProductOriginStock => Boolean(stock) && stock!.origin === 'origin' && STATES.has(stock!.state);

/** Estoque column, Origin line: físico observado, virtual and the moment of the observation in São Paulo. */
export function originStockCell(stock: ProductOriginStock | null | undefined, page: ProductOriginStockPage | null | undefined): OriginStockCell {
  const none = (state: OriginCellState, text: string, title = text, detail = ''): OriginStockCell => ({ text, detail, state, title, quantity: null });
  if (!page || page.status === 'forbidden') return none('forbidden', 'Acesso não permitido', 'Seu perfil não permite consultar o estoque observado no Origin.');
  if (page.status === 'unavailable') return none('unavailable', 'Estoque Origin não consultado', 'Não foi possível consultar o estoque observado no Origin agora. A ausência não significa saldo zero.');
  if (!usable(stock)) return none('unread', '—', 'Estoque observado no Origin não informado nesta resposta.');
  switch (stock.state) {
    case 'unlinked': return none('unlinked', 'Produto sem vínculo', 'Produto sem vínculo comprovado com um produto do Origin (o vínculo nunca é feito por nome ou código).');
    case 'warehouse_unlinked': return none('warehouse_unlinked', 'Depósito sem correspondência', 'O depósito escolhido não tem vínculo comprovado com um depósito do Origin; o saldo Origin não é mostrado para ele.');
    case 'not_observed': return none('not_observed', 'Posição não observada', 'Ainda não há posição deste produto observada no Origin. A ausência não significa saldo zero.');
    case 'source_deleted': return none('source_deleted', 'Excluído no Origin', 'A posição deste produto foi excluída na fonte e fica fora da consulta padrão.');
    case 'multiple_warehouses': return none('multiple_warehouses', `${stock.positions} depósitos no Origin`, 'Há posições em mais de um depósito do Origin. Os saldos não são somados: escolha um depósito no filtro Estoque.', 'Escolha um depósito');
  }
  const moment = stock.observed_at && Number.isFinite(Date.parse(stock.observed_at)) ? originMoment(stock.observed_at) : null;
  const physical = stock.physical !== null && DECIMAL.test(stock.physical) ? stock.physical : null, virtual = stock.virtual !== null && DECIMAL.test(stock.virtual) ? stock.virtual : null;
  const virtualText = virtual !== null ? `Virtual ${originQuantity(virtual)}` : `Virtual: ${missing(stock.virtual_state).toLowerCase()}`;
  const where = stock.warehouse_name ? ` · ${stock.warehouse_name}` : '';
  const detail = `${virtualText}${moment ? ` · obs. ${moment}` : ''}`;
  const title = `Estoque observado no Origin${where}. Físico: ${physical !== null ? originQuantity(physical) : missing(stock.physical_state).toLowerCase()}. ${virtualText}.${moment ? ` Observado em ${moment} (São Paulo).` : ''} Não é disponibilidade no FAGOO; confira no Origin antes de decidir.`;
  if (physical === null) return { text: missing(stock.physical_state), detail, state: 'observed', title, quantity: null };
  return { text: originQuantity(physical), detail, state: 'observed', title, quantity: physical };
}

/** Estoque column, Brufap line: the native ledger (096/234), unchanged and always labelled with its origin. */
export function nativeStockLine(stock: CatalogStock | null | undefined, byWarehouse: boolean) {
  const cell = stockCell(stock, byWarehouse);
  return { ...cell, text: cell.state === 'no_movements' ? 'Estoque nativo sem lançamentos' : cell.text };
}

/** One text for print and the price report: both origins, side by side, never added. */
export function productStockText(stock: CatalogStock | null | undefined, origin: ProductOriginStock | null | undefined, page: ProductOriginStockPage | null | undefined, byWarehouse: boolean) {
  const b = originStockCell(origin, page), n = nativeStockLine(stock, byWarehouse);
  return `Origin (físico): ${b.text}${b.detail ? ` (${b.detail})` : ''} | FAGOO: ${n.text}`;
}

/** Marcadores (cubo): the balance the cell shows first. Origin físico when observed; otherwise the native ledger; otherwise the reason. */
export function cubeStock(stock: CatalogStock | null | undefined, origin: ProductOriginStock | null | undefined, page: ProductOriginStockPage | null | undefined, byWarehouse: boolean) {
  const b = originStockCell(origin, page);
  if (b.quantity !== null) return { quantity: b.quantity, origin: 'origin' as const, reason: '' };
  const native = byWarehouse ? stock?.warehouse : stock;
  if (native?.state === 'recorded' && native.quantity !== null && DECIMAL.test(native.quantity)) return { quantity: native.quantity, origin: 'brufap' as const, reason: '' };
  const linked = !['unlinked', 'forbidden', 'unread'].includes(b.state);
  return { quantity: null, origin: null, reason: linked ? `Estoque Origin: ${b.text.toLowerCase()}` : native?.state === 'review_required' ? 'Estoque nativo em conferência' : 'Estoque nativo sem lançamentos' };
}

export const ORIGIN_STOCK_FILTERS = [
  { value: 'origin_positive', label: 'Maior que zero' }, { value: 'origin_zero', label: 'Igual à zero' }, { value: 'origin_negative', label: 'Menor que zero' },
  { value: 'origin_not_observed', label: 'Posição não observada' }, { value: 'origin_unlinked', label: 'Produto sem vínculo' },
] as const;
export const isOriginStockFilter = (value: string) => value.startsWith('origin_');

// ---- Exportação: colunas próprias, depois do "Estoque" nativo da planilha do Origin ----
type Row = Record<string, unknown>;
const exportOrigin = (row: Row) => (row.origin_stock ?? null) as ProductOriginStock | null;
const EXPORT_STATE: Record<OriginStockState, string> = { observed: 'Observado', multiple_warehouses: 'Vários depósitos (não somados)', not_observed: 'Posição não observada',
  source_deleted: 'Excluído no Origin', unlinked: 'Produto sem vínculo', warehouse_unlinked: 'Depósito padrão sem correspondência no Origin' };
// Físico and virtual stay exact numbers (empty when not observed); the reason is in the situação column, never a zero.
const exportValue = (value: string | null) => value !== null && DECIMAL.test(value) ? value.replace('.', ',') : '';
function exportState(row: Row) {
  const b = exportOrigin(row), status = row.origin_stock_status;
  if (!b) return status === 'forbidden' ? 'Acesso não permitido' : status === 'unavailable' ? 'Não consultado' : '';
  if (!STATES.has(b.state)) return '';
  if (b.state !== 'observed') return EXPORT_STATE[b.state];
  const gaps = [b.physical_state !== 'value' ? `físico: ${missing(b.physical_state).toLowerCase()}` : '', b.virtual_state !== 'value' ? `virtual: ${missing(b.virtual_state).toLowerCase()}` : ''].filter(Boolean);
  return gaps.length ? `Observado (${gaps.join(', ')})` : 'Observado';
}
export const ORIGIN_EXPORT_COLUMNS: [string, (row: Row) => string, boolean?][] = [
  ['Estoque Origin físico (observado)', row => { const b = exportOrigin(row); return b?.state === 'observed' ? exportValue(b.physical) : ''; }, true],
  ['Estoque Origin virtual (observado)', row => { const b = exportOrigin(row); return b?.state === 'observed' ? exportValue(b.virtual) : ''; }, true],
  ['Estoque Origin observado em', row => { const b = exportOrigin(row); return b?.state === 'observed' && b.observed_at && Number.isFinite(Date.parse(b.observed_at)) ? originMoment(b.observed_at) : ''; }],
  ['Estoque Origin situação', exportState],
];
