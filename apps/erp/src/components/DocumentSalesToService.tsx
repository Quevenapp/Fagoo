import { useEffect, useRef, useState } from 'react';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import type { DocumentRecord } from '../lib/real-documents-model';
import { IndicatorLetter } from './OriginList';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;
export const SALES_TO_SERVICE_REFUSED: Record<number, string> = {
  400: 'A ordem de serviço não foi gerada: o pedido tem nota fiscal vinculada, está cancelado ou não segue as Preferências da OS (itens repetidos, vendedor obrigatório).',
  409: 'A ordem de serviço não foi gerada: o pedido já gerou uma ordem de serviço ou mudou. Reabra o pedido e confira.',
  403: 'Seu perfil não permite gerar a ordem de serviço.',
};

/**
 * Origin "Gerar ordem serviço" in the pedido de venda form (202610200131 in the list; the form button closes VND-052): reviewed
 * first, one command with "Conferir resultado", then the new OS opens. The server refuses a pedido with nota fiscal, cancelled
 * or already converted, and checks the Preferências of the OS.
 */
export default function DocumentSalesToService({ controller, record, blocked, canWrite, onCreated }: {
  controller: Controller; record: Pick<DocumentRecord, 'id' | 'kind' | 'number' | 'version' | 'status' | 'contact_snapshot' | 'totals'>; blocked: boolean; canWrite: boolean;
  onCreated: (serviceOrder: { id: string; number: string }) => void;
}) {
  const [review, setReview] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
  const command = useRef<{ id: string; actor: string | null; version: number; uncertain: boolean } | null>(null), pending = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  const reason = !canWrite ? 'Seu perfil não inclui ordens de serviço.' : record.status === 'cancelled' ? 'Pedido cancelado.' : blocked ? 'Salve ou descarte as alterações do pedido antes de gerar a ordem de serviço.' : '';
  const execute = async () => {
    const op = command.current; if (!op || pending.current) return;
    if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setError('A sessão mudou. Reabra o pedido antes de repetir.'); return; }
    const request = new AbortController(); pending.current = request; setBusy(true); setError('');
    try {
      const value = await controller.documents(`/v1/documentos/sales_orders/${record.id}/gerar-os`, { method: 'POST', body: { command_id: op.id, expected_version: op.version }, signal: request.signal }) as { sale?: { id?: string }; service_order?: { id?: string; kind?: string; number?: string } } | null;
      if (request.signal.aborted || !mounted.current) return;
      const os = value?.service_order;
      if (value?.sale?.id !== record.id || !os || os.kind !== 'service_orders' || typeof os.id !== 'string' || typeof os.number !== 'string') throw new AccessError(502);
      if (actorOf(controller) !== op.actor) { command.current = null; setUncertain(false); setError('A sessão mudou durante a operação. Confira a ordem de serviço na listagem.'); return; }
      command.current = null; setUncertain(false); setReview(false); onCreated({ id: os.id, number: os.number });
    } catch (failure) {
      if (request.signal.aborted || aborted(failure) || !mounted.current) return;
      const known = !op.uncertain && failure instanceof AccessError && Object.hasOwn(SALES_TO_SERVICE_REFUSED, failure.status);
      if (known) { command.current = null; setUncertain(false); setError(SALES_TO_SERVICE_REFUSED[(failure as AccessError).status]!); }
      else { op.uncertain = true; setUncertain(true); setError('Não foi possível confirmar a ordem de serviço. Use “Conferir resultado” para repetir a mesma operação sem gerar outra OS.'); }
    } finally { if (pending.current === request) pending.current = null; if (mounted.current && !request.signal.aborted) setBusy(false); }
  };
  const confirm = () => { if (reason || busy || uncertain || command.current) return; command.current = { id: crypto.randomUUID(), actor: actorOf(controller), version: record.version, uncertain: false }; void execute(); };
  return <div className="document-sales-to-service">
    <button type="button" className="secondary-button" disabled={Boolean(reason) || busy || uncertain || review} title={reason || 'Abre a conferência da ordem de serviço antes de criar.'} onClick={() => { if (!reason) { setError(''); setReview(true); } }}>
      <IndicatorLetter text="O" color="midgreen" title="Gerar ordem serviço" /> Gerar ordem serviço</button>
    {review && <section className="document-section" aria-label="Conferir criação da ordem de serviço"><h3>Conferir criação da ordem de serviço</h3>
      <p>Pedido {record.number} · versão {record.version} · {record.contact_snapshot.name} · Total {decimalMoney(record.totals.total)}</p>
      <p>A ordem de serviço será criada em Em aberto com o cliente, os itens, os valores e as condições deste pedido. O pedido continua na situação atual e registra a ocorrência.</p>
      <p className="real-help">Cada pedido gera uma única ordem de serviço, e só enquanto não tem nota fiscal. Esta ação não lança estoque, contas ou nota fiscal.</p>
      <div className="real-editor-actions">{uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void execute()}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
        : <button type="button" className="primary-button" disabled={busy || Boolean(reason)} onClick={confirm}>{busy ? 'Gerando…' : 'Confirmar criação da OS'}</button>}
        <button type="button" className="secondary-button" disabled={busy || uncertain} onClick={() => { setReview(false); setError(''); }}>Voltar ao pedido</button></div></section>}
    {error && <p className="real-alert" role="alert">{error}</p>}
  </div>;
}
