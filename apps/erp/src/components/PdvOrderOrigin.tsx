import { useEffect, useState } from 'react';

// Pedido de venda — Detalhes da venda: "Nº da mesa" (venda mesa do PDV) do pedido gerado pela Frente de caixa (202610200206).
// Só leitura; sem a Frente de caixa (perfil sem acesso, API anterior) nada aparece.
type PosPort = { pos?: (path: string, options?: { signal?: AbortSignal }) => Promise<unknown>; getSnapshot?: () => { membership?: { user_id?: string } | null } | null };
type Origin = { kind: 'balcao' | 'mesa'; table_number: number | null; account_name: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PdvOrderOrigin({ controller, documentId }: { controller: PosPort; documentId: string }) {
  const [origin, setOrigin] = useState<{ id: string; value: Origin | null } | null>(null);
  useEffect(() => {
    if (typeof controller.pos !== 'function' || !UUID.test(documentId)) return;
    const request = new AbortController(), actor = controller.getSnapshot?.()?.membership?.user_id;
    void controller.pos(`/v1/frente-caixa/pedidos/${documentId}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted || controller.getSnapshot?.()?.membership?.user_id !== actor) return;
      const record = (value as { entity?: string; document_id?: string; record?: Origin | null } | null);
      if (record?.entity !== 'pos_order' || record.document_id !== documentId.toLowerCase()) return;
      setOrigin({ id: documentId, value: record.record ?? null });
    }).catch(() => { /* Without access to the Frente de caixa the pedido shows nothing more. */ });
    return () => request.abort();
  }, [controller, documentId]);
  const value = origin?.id === documentId ? origin.value : null;
  if (!value) return null;
  return <>{value.kind === 'mesa' && <div className="form-field document-pdv-table"><label htmlFor="doc-pdv-table">Nº da mesa</label><input id="doc-pdv-table" readOnly value={String(value.table_number)} /></div>}
    <p className="real-help document-pdv-origin">Venda registrada na Frente de caixa{value.account_name ? ` (${value.account_name})` : ''}.</p></>;
}
