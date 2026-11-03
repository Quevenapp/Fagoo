// Origin "Configurações por usuário" of the document lists (202610200104): "Tornar padrão" and "Listagem customizada".
import { STATES, type DocumentKind } from './real-documents-model.ts';
import { brDay, type DocumentListRow } from './document-list-model.ts';

export type ListViewKind = 'sales_orders' | 'sales_proposals' | 'service_orders';
export const LIST_VIEW_KINDS: readonly DocumentKind[] = ['sales_orders', 'sales_proposals', 'service_orders'];
export interface ListView { kind: ListViewKind; custom_view: boolean; columns: string[]; default_statuses: string[]; statuses_saved: boolean; available_columns: string[]; column_limit: number; version: number }

// Origin labels of the "Informações visíveis" drawer (Número and Situação are fixed).
export const COLUMN_LABELS: Record<string, string> = {
  date: 'Data', contact: 'Cliente', total: 'Total (R$)', customer_po_number: 'Número pedido de compra', address: 'Endereço', ship_date: 'Data saída',
  contact_email: 'E-mail', contact_phone: 'Telefone', contact_document: 'CPF/CNPJ', carrier_name: 'Transportador',
};
export const COLUMN_HELP: Record<string, string> = { address: 'O endereço de entrega tem prioridade; sem ele, vale o endereço do contato.' };
export const DEFAULT_SAVED_NOTICE = 'A seleção de status padrão foi atualizada com sucesso';

export function readListView(value: unknown, kind: DocumentKind): ListView {
  const view = value as ListView;
  const strings = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === 'string');
  if (!view || view.kind !== kind || typeof view.custom_view !== 'boolean' || !strings(view.columns) || !strings(view.default_statuses) || !strings(view.available_columns)
    || view.columns.some(column => !view.available_columns.includes(column)) || view.default_statuses.some(status => !Object.hasOwn(STATES[kind], status))
    || typeof view.statuses_saved !== 'boolean' || !Number.isInteger(view.column_limit) || !Number.isInteger(view.version) || view.version < 0) throw new Error('LIST_VIEW_INVALID');
  return { kind: view.kind, custom_view: view.custom_view, columns: [...view.columns], default_statuses: [...view.default_statuses], statuses_saved: view.statuses_saved, available_columns: [...view.available_columns], column_limit: view.column_limit, version: view.version };
}
export function listViewBody(view: ListView, change: Partial<Pick<ListView, 'custom_view' | 'columns' | 'default_statuses'>>) {
  return { expected_version: view.version, custom_view: change.custom_view ?? view.custom_view, columns: [...(change.columns ?? view.columns)], default_statuses: [...(change.default_statuses ?? view.default_statuses)] };
}
export function moveColumn(columns: readonly string[], from: number, to: number): string[] {
  const next = [...columns];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [moved] = next.splice(from, 1); next.splice(to, 0, moved!);
  return next;
}
/** Text of an optional column; money is formatted by the caller. */
export function columnText(column: string, row: DocumentListRow): string {
  switch (column) {
    case 'date': return brDay(row.date);
    case 'contact': return row.contact_name ?? 'Não informado';
    case 'ship_date': return brDay(row.ship_date ?? null);
    case 'customer_po_number': return row.customer_po_number ?? '';
    case 'address': return row.address ?? '';
    case 'contact_email': return row.contact_email ?? '';
    case 'contact_phone': return row.contact_phone ?? '';
    case 'contact_document': return row.contact_document ?? '';
    case 'carrier_name': return row.carrier_name ?? '';
    default: return '';
  }
}
