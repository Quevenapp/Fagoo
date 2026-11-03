// "Vinculação" of the pedidos de compra list (Origin badges Não vinculado, Vinculado, Parcial), from the entry notes of Brufap
// linked to each pedido (notas lane, migration 202610200176). Read only; a late answer, another page or another session is dropped.
import { useEffect, useState } from 'react';
import type { AccessController } from './real-access';

export type LinkState = 'none' | 'linked' | 'partial';
export const LINK_STATE_BADGES: Readonly<Record<LinkState, { label: string; tone: string; title: string }>> = Object.freeze({
  none: { label: 'Não vinculado', tone: 'status-waiting', title: 'Nenhuma nota fiscal de entrada vinculada a este pedido.' },
  linked: { label: 'Vinculado', tone: 'status-success', title: 'As notas fiscais de entrada vinculadas cobrem as quantidades do pedido.' },
  partial: { label: 'Parcial', tone: 'status-warning', title: 'As notas fiscais de entrada vinculadas cobrem só parte das quantidades do pedido.' },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Validates POST /v1/notas-fiscais/vinculos for the asked ids. */
export function linkStates(value: unknown, ids: readonly string[]): Record<string, LinkState> {
  const out: Record<string, LinkState> = {};
  const v = value as { items?: unknown; data_mode?: unknown } | null;
  if (!v || typeof v !== 'object' || v.data_mode !== 'erp_native' || !Array.isArray(v.items) || v.items.length > ids.length) throw new Error('link_states_invalid');
  for (const item of v.items as { document_id?: unknown; state?: unknown }[]) {
    if (!item || typeof item.document_id !== 'string' || !UUID.test(item.document_id) || !ids.includes(item.document_id) || Object.hasOwn(out, item.document_id)
      || !['none', 'linked', 'partial'].includes(String(item.state))) throw new Error('link_states_invalid');
    out[item.document_id] = item.state as LinkState;
  }
  return out;
}
export function useOrderLinkStates(controller: AccessController, kind: string, ids: readonly string[]): Record<string, LinkState> {
  const [states, setStates] = useState<Record<string, LinkState>>({});
  const key = kind === 'purchase_orders' ? ids.slice(0, 100).join(',') : '';
  useEffect(() => {
    setStates({});
    if (!key || typeof controller.fiscalInvoices !== 'function') return;
    const request = new AbortController(), asked = key.split(','), actor = controller.getSnapshot().membership?.user_id ?? null;
    void Promise.resolve().then(() => controller.fiscalInvoices('/v1/notas-fiscais/vinculos', { method: 'POST', body: { document_ids: asked }, signal: request.signal }))
      .then(value => { if (!request.signal.aborted && controller.getSnapshot().membership?.user_id === actor) setStates(linkStates(value, asked)); })
      // Without the answer (older database, profile without access), the column stays empty instead of guessing.
      .catch(() => { if (!request.signal.aborted) setStates({}); });
    return () => request.abort();
  }, [controller, key]);
  return states;
}
