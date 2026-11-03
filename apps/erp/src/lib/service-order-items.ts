// 202610200268 Origin ordem de serviço: Peças and Serviços executados in separate grids, with Total peças and Total serviços.
// An item saved before 268 has no group: a product of type Serviço (S) is a serviço, everything else a peça (the rule the
// Relatório de Ordem de Serviço already used). Sums are exact (cents as BigInt), never floating point.
import type { DocumentItemInput, DocumentKind, DocumentTotals, ServiceItemGroup } from '../../../../packages/erp-domain/src/index.mjs';
import type { OsLabel } from './document-preferences';

export type { ServiceItemGroup };
/** Origin column labels of the two grids; Preferências › Serviços › Rótulos replaces them when filled. */
export const SERVICE_ITEM_DEFAULTS = {
  peca_descricao: 'Descrição', servico_descricao: 'Descrição', servico_codigo: 'Código', servico_quantidade: 'Horas', servico_valor: 'Preço',
  servico_orcar: 'Orçar', servico_observacoes: 'Observações do Serviço',
} as const satisfies Partial<Record<OsLabel, string>>;
export type ServiceItemLabel = keyof typeof SERVICE_ITEM_DEFAULTS;
export const serviceItemLabel = (labels: Partial<Record<OsLabel, string>>, key: ServiceItemLabel) => labels[key] ?? SERVICE_ITEM_DEFAULTS[key];

/** The group of an item: the saved one, else by the type of the product (snapshot or catalog). */
export function itemGroup(item: { group?: ServiceItemGroup | null }, productKind?: unknown): ServiceItemGroup {
  return item.group === 'part' || item.group === 'service' ? item.group : productKind === 'S' ? 'service' : 'part';
}
/** The OS items with group, Orçar and OK always present (the server refuses an OS with groups saved without them). */
export function groupedItems<T extends DocumentItemInput>(kind: DocumentKind, items: readonly T[], productKind: (item: T) => unknown = () => undefined): T[] {
  if (kind !== 'service_orders') return [...items];
  return items.map(item => { const group = itemGroup(item, productKind(item)); return { ...item, group, quote: group === 'service' && item.quote === true, done: group === 'service' && item.done === true }; });
}
const cents = (value: string | undefined) => { if (!value || !/^\d+\.\d{2}$/.test(value)) return 0n; const [whole, fraction] = value.split('.'); return BigInt(whole!) * 100n + BigInt(fraction!); };
const money = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
/** Total peças and Total serviços: the sum of the line totals of each group (null while the form does not calculate). */
export function groupTotals(items: readonly DocumentItemInput[], totals: Pick<DocumentTotals, 'items'> | null): { part: string; service: string } | null {
  if (!totals || totals.items.length !== items.length) return null;
  let part = 0n, service = 0n;
  items.forEach((item, index) => { const value = cents(totals.items[index]?.total); if (itemGroup(item) === 'service') service += value; else part += value; });
  return { part: money(part), service: money(service) };
}
