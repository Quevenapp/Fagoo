// Localização do produto nas telas de estoque (migração 260): Preferências › Cadastros › Configurações de produtos, "Exibir localização
// no controle de estoque" (extrato de Estoque › Lançamentos de estoque) e "Exibir localização nos relatórios de estoque" (relatórios de
// suprimentos com produto). A localização vem do cadastro do produto; a página só a mostra.
import { useEffect, useState } from 'react';
import { parsePreferencesPage } from '../../../../packages/erp-domain/src/preferences/dto.mjs';
import { preferencesPagePath } from './preferences-request.ts';
import type { AccessController } from './real-access.ts';
import type { ReportColumn } from './stock-reports-model.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface StockLocationSettings { ledger: boolean; reports: boolean }
export const NO_LOCATION_SETTINGS: StockLocationSettings = { ledger: false, reports: false };
/** A failed read keeps the location hidden (the Origin default is off). */
export async function loadStockLocationSettings(controller: Pick<AccessController, 'preferences'>, signal: AbortSignal): Promise<StockLocationSettings> {
  const raw = await controller.preferences(preferencesPagePath('cadastros-produtos'), { method: 'GET', signal });
  const page = parsePreferencesPage(raw, 'cadastros-produtos') as { items: { key: string; value: unknown }[] };
  const on = (key: string) => page.items.find(item => item.key === key)?.value === true;
  return { ledger: on('produtos.localizacao_controle_estoque'), reports: on('produtos.localizacao_relatorios_estoque') };
}
/** The two settings for this actor; off while unknown or when the read fails (the server keeps the location in the catalog either way). */
export function useStockLocationSettings(controller: AccessController): StockLocationSettings {
  const actor = controller.getSnapshot().membership?.user_id ?? '', [state, setState] = useState<{ actor: string; value: StockLocationSettings } | null>(null);
  useEffect(() => { const request = new AbortController(); if (typeof (controller as Partial<AccessController>).preferences !== 'function') return;
    void loadStockLocationSettings(controller, request.signal).then(value => { if (!request.signal.aborted) setState({ actor, value }); }).catch(() => {});
    return () => request.abort(); }, [controller, actor]);
  return state && state.actor === actor ? state.value : NO_LOCATION_SETTINGS;
}
/** Localização of one product (the extrato heading); null while unknown, unset or not wanted. */
export function useProductLocation(controller: AccessController, productId: string | null, on: boolean): string | null {
  const [state, setState] = useState<{ id: string; value: string | null } | null>(null);
  useEffect(() => { if (!on || !productId) return; const request = new AbortController();
    void loadLocations(controller, [{ product_id: productId }], request.signal).then(map => { if (!request.signal.aborted) setState({ id: productId, value: map.get(productId) ?? null }); }).catch(() => {});
    return () => request.abort(); }, [controller, productId, on]);
  return on && productId && state?.id === productId ? state.value : null;
}
export const LOCATION_COLUMN: ReportColumn = { key: 'location', label: 'Localização', kind: 'text' };
/** The report columns with Localização after Un, only in the reports with a product per row. */
export function withLocation(columns: readonly ReportColumn[], on: boolean): ReportColumn[] {
  const unit = columns.findIndex(column => column.key === 'unit');
  if (!on || unit < 0 || !columns.some(column => column.key === 'name')) return [...columns];
  return [...columns.slice(0, unit + 1), LOCATION_COLUMN, ...columns.slice(unit + 1)];
}
export const locationsPath = (ids: readonly string[]) => `/v1/estoque/produtos/localizacoes?${new URLSearchParams({ ids: ids.join(',') })}`;
export function parseLocations(value: unknown, ids: readonly string[]): Map<string, string | null> {
  const v = value as { scope?: unknown; data_mode?: unknown; items?: unknown } | null;
  if (!v || v.data_mode !== 'erp_native' || v.scope !== 'stock_product_locations' || !Array.isArray(v.items)) throw new Error('INVALID_LOCATIONS');
  const out = new Map<string, string | null>();
  for (const item of v.items as { product_id?: unknown; location?: unknown }[]) {
    if (typeof item?.product_id !== 'string' || !ids.includes(item.product_id) || out.has(item.product_id) || (item.location !== null && typeof item.location !== 'string')) throw new Error('INVALID_LOCATIONS');
    out.set(item.product_id, item.location as string | null);
  }
  return out;
}
/** Locations of the products of some rows, 100 per request (the report pages have up to 500 rows). */
export async function loadLocations(controller: Pick<AccessController, 'stock'>, rows: readonly Record<string, unknown>[], signal?: AbortSignal): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.map(row => row.product_id).filter((id): id is string => typeof id === 'string' && UUID.test(id)))], out = new Map<string, string | null>();
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100);
    for (const [id, location] of parseLocations(await controller.stock(locationsPath(chunk), { signal }), chunk)) out.set(id, location);
  }
  return out;
}
export const withLocations = (rows: readonly Record<string, unknown>[], locations: Map<string, string | null> | null) =>
  locations ? rows.map(row => typeof row.product_id === 'string' ? { ...row, location: locations.get(row.product_id) ?? null } : row) : [...rows];
