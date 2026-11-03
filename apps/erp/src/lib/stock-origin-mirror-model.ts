import { quantityText } from './stock-model.ts';

export type MirrorValueState = 'value' | 'absent' | 'null' | 'invalid';
export type StockMirrorFilter = '' | 'negative' | 'pending' | 'deleted';
export interface StockMirrorFilters { query: string; warehouse: string; state: StockMirrorFilter }
export interface StockMirrorPosition {
  id: number; product_source_id: string; product_id: string | null; product_name: string; product_code: string | null; unit: string | null;
  warehouse_source_id: string | null; warehouse_id: string | null; warehouse_name: string;
  physical: string | null; virtual: string | null; reserved: string | null; physical_state: MirrorValueState; virtual_state: MirrorValueState;
  issues: string[]; source_version: number; source_hash: string; source_deleted: boolean; observed_at: string; origin: 'origin'; read_only: true;
}
export interface StockMirrorPage {
  scope: 'stock_mirror'; data_mode: 'origin_mirror'; items: StockMirrorPosition[]; limit: number; next_after: number | null; has_more: boolean;
  coverage: { positions: number; products: number; raw_products: number; pending_products: number; partial: boolean };
  warehouses: { source_id: string; id: string | null; name: string }[];
  native: { positions: number; movements: number };
}
export const STOCK_MIRROR_LIMIT = 50;
export const EMPTY_MIRROR_FILTERS: StockMirrorFilters = { query: '', warehouse: '', state: '' };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sourceId = /^[1-9][0-9]{0,39}$/;
const decimal = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const states = new Set(['value', 'absent', 'null', 'invalid']);
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Resposta de estoque inválida.'); return value as Record<string, unknown>; };
const integer = (value: unknown, min = 0): number => { if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error('Contagem inválida.'); return value as number; };
const text = (value: unknown): string => { if (typeof value !== 'string') throw new Error('Texto inválido.'); return value; };
const nullable = (value: unknown): string | null => value === null ? null : text(value);
const identifier = (value: unknown, local = false): string => { const result = text(value); if (!(local ? uuid : sourceId).test(result)) throw new Error('Identidade inválida.'); return result; };
const optionalId = (value: unknown, local = false): string | null => value === null ? null : identifier(value, local);
const amount = (value: unknown): string | null => { const result = nullable(value); if (result !== null && (result.length > 100 || !decimal.test(result))) throw new Error('Quantidade inválida.'); return result; };

export function stockMirrorQuery(filters: StockMirrorFilters, productId: string | null, after: number | null = null): string {
  const query = filters.query.trim();
  if (query.length > 120 || filters.warehouse && !sourceId.test(filters.warehouse) || !['', 'negative', 'pending', 'deleted'].includes(filters.state)) throw new Error('Filtros inválidos.');
  if (productId !== null) identifier(productId, true);
  if (after !== null) integer(after, 1);
  const params = new URLSearchParams({ limit: String(STOCK_MIRROR_LIMIT) });
  if (query) params.set('q', query);
  if (filters.warehouse) params.set('warehouse_source_id', filters.warehouse);
  if (filters.state) params.set('state', filters.state);
  if (productId) params.set('product_id', productId);
  if (after !== null) params.set('after', String(after));
  return `/v1/estoque/espelho?${params}`;
}

/** The mirror never accepts native balances or guesses missing amounts. IDs remain separate from labels. */
export function parseStockMirrorPage(raw: unknown, productId: string | null, after: number | null = null): StockMirrorPage {
  const value = object(raw), coverage = object(value.coverage), native = object(value.native);
  if (value.scope !== 'stock_mirror' || value.data_mode !== 'origin_mirror' || !Array.isArray(value.items) || !Array.isArray(value.warehouses)
    || value.limit !== STOCK_MIRROR_LIMIT || typeof value.has_more !== 'boolean' || typeof coverage.partial !== 'boolean') throw new Error('Espelho inválido.');
  const seen = new Set<number>(); let lastId = after ?? 0;
  const items = value.items.map(rawRow => {
    const row = object(rawRow), id = integer(row.id, 1);
    if (seen.has(id) || id <= lastId || row.origin !== 'origin' || row.read_only !== true || !states.has(text(row.physical_state)) || !states.has(text(row.virtual_state))
      || typeof row.source_deleted !== 'boolean' || !Array.isArray(row.issues) || row.issues.some(issue => typeof issue !== 'string')) throw new Error('Posição inválida.');
    seen.add(id); lastId = id;
    const localProduct = optionalId(row.product_id, true), physical = amount(row.physical), virtual = amount(row.virtual), observedAt = text(row.observed_at);
    if (productId && localProduct !== productId || (row.physical_state === 'value') !== (physical !== null) || (row.virtual_state === 'value') !== (virtual !== null)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) throw new Error('Observação inválida.');
    return { id, product_source_id: identifier(row.product_source_id), product_id: localProduct, product_name: text(row.product_name), product_code: nullable(row.product_code), unit: nullable(row.unit),
      warehouse_source_id: optionalId(row.warehouse_source_id), warehouse_id: optionalId(row.warehouse_id, true), warehouse_name: text(row.warehouse_name), physical, virtual,
      reserved: amount(row.reserved), physical_state: row.physical_state as MirrorValueState, virtual_state: row.virtual_state as MirrorValueState, issues: row.issues as string[],
      source_version: integer(row.source_version, 1), source_hash: text(row.source_hash), source_deleted: row.source_deleted, observed_at: observedAt, origin: 'origin' as const, read_only: true as const };
  });
  const next = value.next_after === null ? null : integer(value.next_after, 1);
  if (items.length > STOCK_MIRROR_LIMIT || value.has_more !== (next !== null) || next !== null && (!items.length || next !== lastId)) throw new Error('Paginação inválida.');
  const warehouseIds = new Set<string>();
  const warehouses = value.warehouses.map(rawWarehouse => { const warehouse = object(rawWarehouse), source_id = identifier(warehouse.source_id); if (warehouseIds.has(source_id)) throw new Error('Depósito duplicado.'); warehouseIds.add(source_id); return { source_id, id: optionalId(warehouse.id, true), name: text(warehouse.name) }; });
  return { scope: 'stock_mirror', data_mode: 'origin_mirror', items, limit: STOCK_MIRROR_LIMIT, next_after: next, has_more: value.has_more,
    coverage: { positions: integer(coverage.positions), products: integer(coverage.products), raw_products: integer(coverage.raw_products), pending_products: integer(coverage.pending_products), partial: coverage.partial },
    warehouses, native: { positions: integer(native.positions), movements: integer(native.movements) } };
}

export const stockMirrorNegative = (value: string | null) => value !== null && value.startsWith('-') && /[1-9]/.test(value);
export function stockMirrorQuantity(value: string | null, state: MirrorValueState = 'absent'): string {
  if (value !== null) return quantityText(value);
  return state === 'invalid' ? 'Valor inválido na fonte' : state === 'null' ? 'Não informado (nulo)' : 'Não observado';
}
const issueLabels: Record<string, string> = {
  PRODUCT_ID_INVALID: 'Identidade do produto inválida', WAREHOUSE_LIST_INVALID: 'Lista de depósitos inválida', SOURCE_DELETED: 'Produto excluído no Origin', BALANCE_INCOMPLETE: 'Saldo incompleto na fonte',
  PRODUCT_STRUCTURE_REVIEW: 'Estrutura do produto a conferir', UNIT_UNCONFIRMED: 'Unidade a conferir',
  PRODUCT_UNLINKED: 'Produto sem vínculo', PRODUCT_NOT_LINKED: 'Produto sem vínculo', WAREHOUSE_UNLINKED: 'Depósito sem vínculo', WAREHOUSE_NOT_LINKED: 'Depósito sem vínculo',
  PRODUCT_INACTIVE: 'Produto inativo', PRODUCT_DELETED: 'Produto excluído no Origin', PRODUCT_KIT: 'Produto composto', PRODUCT_SERVICE: 'Produto de serviço',
  UNIT_MISSING: 'Unidade a conferir', UNIT_MISMATCH: 'Unidade a conferir', PHYSICAL_ABSENT: 'Saldo físico ausente', PHYSICAL_NULL: 'Saldo físico nulo', PHYSICAL_INVALID: 'Saldo físico inválido',
  VIRTUAL_ABSENT: 'Saldo virtual ausente', VIRTUAL_NULL: 'Saldo virtual nulo', VIRTUAL_INVALID: 'Saldo virtual inválido', WAREHOUSE_ABSENT: 'Depósito não informado',
};
export const stockMirrorIssue = (code: string) => issueLabels[code.toUpperCase()] ?? `Pendência: ${code}`;
