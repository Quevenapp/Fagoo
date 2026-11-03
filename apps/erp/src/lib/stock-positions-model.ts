export type PositionState = 'recorded' | 'no_movements' | 'review_required';
export type LimitState = 'below_min' | 'within' | 'above_max' | 'not_configured' | 'no_movements' | 'review_required';
export type WarehouseOption = { id: string; name: string; active: boolean };
export type PositionProduct = { id: string; version: number; name: string; code: string | null; active: boolean; unit: string | null;
  kind: 'P' | 'S' | 'N' | null; format: 'S' | 'V' | 'E' | null; gtin: string | null; brand: string | null; location: string | null; stock_min: string | null; stock_max: string | null };
export type StockPosition = { product: PositionProduct; global: { quantity: string | null; state: PositionState; recorded_warehouse_count: string; scope: 'all_recorded_warehouses' };
  selected_position: { warehouse_id: string; quantity: string | null; state: PositionState; version: number } | null; limit_state: LimitState };
export type PositionPage = { items: StockPosition[]; warehouse: WarehouseOption | null; limit: number; has_more: boolean; next_cursor: string | null; data_mode: 'erp_native'; scope: 'stock_positions' };
export type WarehousePage = { items: WarehouseOption[]; limit: number; has_more: boolean; next_cursor: string | null; data_mode: 'erp_native'; scope: 'stock_warehouse_options' };
export type PositionFilters = { q: string; active: '' | 'true' | 'false'; warehouse_id: string; brand: string; location: string; stock_state: '' | PositionState; limit_state: '' | LimitState };
export const POSITION_LABELS: Record<PositionState, string> = { recorded: 'Com lançamentos', no_movements: 'Sem lançamentos', review_required: 'Conferência necessária' };
export const LIMIT_LABELS: Record<LimitState, string> = { below_min: 'Abaixo do mínimo', within: 'Dentro dos limites', above_max: 'Acima do máximo', not_configured: 'Limites não informados', no_movements: 'Abertura a conferir', review_required: 'Conferência necessária' };
export const EMPTY_POSITION_FILTERS: PositionFilters = { q: '', active: '', warehouse_id: '', brand: '', location: '', stock_state: '', limit_state: '' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
// Recorded balances are signed since migration100 (company policy "Permitir estoque negativo"); limits stay non-negative.
const SIGNED = /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const TOTAL = /^-?(0|[1-9][0-9]{0,30})\.[0-9]{6}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown, max: number, min = 0): value is string => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647;
const decimal = (value: unknown, total = false): value is string => typeof value === 'string' && (total ? TOTAL : DECIMAL).test(value) && !/^-0\.0+$/.test(value);
const signed = (value: unknown): value is string => typeof value === 'string' && SIGNED.test(value) && !/^-0\.0+$/.test(value);
const magnitude = (value: bigint) => value < 0n ? -value : value;
const units = (value: string) => BigInt(value.replace('.', ''));
const state = (value: unknown): value is PositionState => typeof value === 'string' && Object.hasOwn(POSITION_LABELS, value);
const fail = (): never => { throw new Error('Não foi possível validar a consulta de estoque. Atualize e tente novamente.'); };
export function positionQuantity(value: string): string {
  if (!decimal(value, true)) return fail();
  const negative = value.startsWith('-'), [whole, fraction] = value.replace(/^-/, '').split('.');
  return `${negative ? '−' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction}`;
}
export function positionLimit(quantity: string | null, positionState: PositionState, min: string | null, max: string | null): LimitState {
  if (positionState !== 'recorded') return positionState;
  if (!quantity || !decimal(quantity, true) || (min !== null && !decimal(min)) || (max !== null && !decimal(max))) return fail();
  if (min === null && max === null) return 'not_configured';
  if (min !== null && units(quantity) < units(min)) return 'below_min';
  if (max !== null && units(quantity) > units(max)) return 'above_max';
  return 'within';
}
export function positionFilters(params: URLSearchParams): PositionFilters {
  const result = { ...EMPTY_POSITION_FILTERS };
  for (const key of Object.keys(result) as (keyof PositionFilters)[]) {
    const value = params.get(key) ?? '';
    if (params.getAll(key).length > 1 || !str(value, key === 'q' ? 120 : 100)) throw new Error('Os filtros da URL são inválidos. Limpe os filtros para continuar.');
    if ((key === 'active' && !['', 'true', 'false'].includes(value)) || (key === 'warehouse_id' && value !== '' && !uuid(value))
      || (key === 'stock_state' && value !== '' && !Object.hasOwn(POSITION_LABELS, value))
      || (key === 'limit_state' && value !== '' && !Object.hasOwn(LIMIT_LABELS, value))) throw new Error('Os filtros da URL são inválidos. Limpe os filtros para continuar.');
    Object.assign(result, { [key]: key === 'warehouse_id' ? value.toLowerCase() : value });
  }
  return result;
}
export function positionCursor(params: URLSearchParams): string | null {
  const value = params.get('after');
  if (params.getAll('after').length > 1 || (value !== null && !uuid(value))) throw new Error('A página da URL é inválida. Volte à primeira página.');
  return value?.toLowerCase() ?? null;
}
export function positionParams(filters: PositionFilters, after: string | null = null, forApi = true): URLSearchParams {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) result.set(key, value.trim());
  positionFilters(result);
  if (after) { if (!uuid(after)) return fail(); result.set('after', after.toLowerCase()); }
  if (forApi) result.set('limit', '25');
  return result;
}
function warehouse(value: unknown): WarehouseOption {
  if (!object(value) || !uuid(value.id) || !str(value.name, 200, 1) || typeof value.active !== 'boolean') return fail();
  return { id: value.id, name: value.name, active: value.active };
}
function product(value: unknown): PositionProduct {
  if (!object(value) || !uuid(value.id) || !integer(value.version) || value.version < 1 || !str(value.name, 200, 1)
    || typeof value.active !== 'boolean' || (value.kind !== null && !['P', 'S', 'N'].includes(String(value.kind)))
    || (value.format !== null && !['S', 'V', 'E'].includes(String(value.format)))) return fail();
  for (const [key, max] of [['code', 100], ['gtin', 14], ['unit', 16], ['brand', 100], ['location', 100]] as const) if (value[key] !== null && !str(value[key], max, 1)) return fail();
  for (const key of ['stock_min', 'stock_max']) if (value[key] !== null && !decimal(value[key])) return fail();
  if (value.stock_min !== null && value.stock_max !== null && units(value.stock_min as string) > units(value.stock_max as string)) return fail();
  return Object.fromEntries(['id', 'version', 'name', 'code', 'active', 'unit', 'kind', 'format', 'gtin', 'brand', 'location', 'stock_min', 'stock_max'].map(key => [key, value[key]])) as PositionProduct;
}
export function stockPositionPage(value: unknown, filters: PositionFilters): PositionPage {
  if (!object(value) || value.data_mode !== 'erp_native' || value.scope !== 'stock_positions' || value.limit !== 25 || !Array.isArray(value.items)
    || value.items.length > 25 || typeof value.has_more !== 'boolean' || (value.has_more ? !uuid(value.next_cursor) || value.items.length !== 25 : value.next_cursor !== null)) return fail();
  const selectedWarehouse = value.warehouse === null ? null : warehouse(value.warehouse);
  if ((selectedWarehouse?.id ?? '') !== filters.warehouse_id) return fail();
  const items = value.items.map((row): StockPosition => {
    if (!object(row) || !object(row.global)) return fail();
    const p = product(row.product), g = row.global;
    if (!state(g.state) || g.scope !== 'all_recorded_warehouses' || typeof g.recorded_warehouse_count !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(g.recorded_warehouse_count)) return fail();
    if (g.state === 'recorded' ? !decimal(g.quantity, true) || g.recorded_warehouse_count === '0' || p.unit === null || p.kind !== 'P'
      : g.quantity !== null || (g.state === 'no_movements' && g.recorded_warehouse_count !== '0')) return fail();
    if (g.state === 'recorded' && magnitude(units(g.quantity as string)) > BigInt(g.recorded_warehouse_count) * 999999999999999999n) return fail();
    let selected: StockPosition['selected_position'] = null;
    if (selectedWarehouse) {
      const s = row.selected_position;
      if (!object(s) || s.warehouse_id !== selectedWarehouse.id || !state(s.state) || !integer(s.version)) return fail();
      if (s.state === 'recorded' ? !signed(s.quantity) || s.version < 1 || g.state === 'no_movements'
        : s.quantity !== null || (s.state === 'no_movements' && s.version !== 0)) return fail();
      // A warehouse may hold more than the global sum when another warehouse is negative.
      if (s.state === 'review_required' && g.state !== 'review_required') return fail();
      selected = { warehouse_id: s.warehouse_id as string, quantity: s.quantity as string | null, state: s.state, version: s.version };
    } else if (row.selected_position !== null) return fail();
    const limit = positionLimit(g.quantity as string | null, g.state, p.stock_min, p.stock_max);
    if (row.limit_state !== limit || (filters.stock_state && filters.stock_state !== (selected?.state ?? g.state)) || (filters.limit_state && filters.limit_state !== limit)) return fail();
    return { product: p, global: { quantity: g.quantity as string | null, state: g.state, recorded_warehouse_count: g.recorded_warehouse_count, scope: 'all_recorded_warehouses' }, selected_position: selected, limit_state: limit };
  });
  if (items.some((row, i) => i > 0 && row.product.id <= items[i - 1].product.id) || (value.has_more && value.next_cursor !== items.at(-1)?.product.id)) return fail();
  return { items, warehouse: selectedWarehouse, limit: 25, has_more: value.has_more, next_cursor: value.next_cursor as string | null, data_mode: 'erp_native', scope: 'stock_positions' };
}
export function stockWarehousePage(value: unknown): WarehousePage {
  if (!object(value) || value.data_mode !== 'erp_native' || value.scope !== 'stock_warehouse_options' || value.limit !== 100 || !Array.isArray(value.items)
    || value.items.length > 100 || typeof value.has_more !== 'boolean' || (value.has_more ? !uuid(value.next_cursor) || value.items.length !== 100 : value.next_cursor !== null)) return fail();
  const items = value.items.map(warehouse);
  if (items.some((row, i) => i > 0 && row.id <= items[i - 1].id) || (value.has_more && value.next_cursor !== items.at(-1)?.id)) return fail();
  return { items, limit: 100, has_more: value.has_more, next_cursor: value.next_cursor as string | null, data_mode: 'erp_native', scope: 'stock_warehouse_options' };
}
