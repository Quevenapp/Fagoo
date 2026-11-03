import { useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { TRASH_REASONS } from '../lib/document-list-model';
import type { DocumentKind } from '../lib/real-documents-model';
import { Modal } from './Modal';

type Result = { id: string; ok: boolean; reason: string | null };
const NOUN: Record<DocumentKind, string> = { sales_proposals: 'propostas', sales_orders: 'pedidos de venda', purchase_orders: 'pedidos de compra', service_orders: 'ordens de serviço' };

/**
 * Leva H (VND-015, VND-166, 392): "Excluir selecionados" (para a lixeira, com motivo) e "Restaurar selecionados". Só documentos sem
 * efeitos vão para a lixeira; os demais voltam com o motivo (cancele e estorne em vez de excluir). Um resultado não confirmado é
 * reenviado com o mesmo comando.
 */
export default function DocumentTrashDialog({ controller, kind, action, rows, onClose }: { controller: AccessController; kind: DocumentKind; action: 'delete' | 'restore'; rows: readonly { id: string; number: string }[]; onClose: (changed: boolean) => void }) {
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [results, setResults] = useState<Result[] | null>(null);
  const command = useRef<string | null>(null), changed = useRef(false);
  const run = async () => {
    if (busy) return;
    if (action === 'delete' && reason.trim().length < 3) { setError('Informe o motivo da exclusão (ao menos 3 caracteres).'); return; }
    command.current ??= crypto.randomUUID(); setBusy(true); setError('');
    try {
      const value = await controller.documents(`/v1/documentos/${kind}/lixeira`, { method: 'POST', body: { command_id: command.current, action, ids: rows.map(r => r.id), reason: action === 'delete' ? reason.trim() : null } }) as { results: Result[] };
      command.current = null; setResults(value.results); if (value.results.some(r => r.ok)) changed.current = true;
    } catch (failure) {
      const uncertain = !(failure instanceof AccessError) || failure.status >= 500 || failure.status === 408;
      if (!uncertain) command.current = null;
      setError(failure instanceof AccessError && failure.status === 403 ? `Seu usuário não tem a permissão de exclusão de ${NOUN[kind]} (Sistema › Usuários › Permissões).`
        : uncertain ? 'Não foi possível confirmar o resultado. Clique de novo: o mesmo comando é reenviado.' : 'Nada foi alterado. Confira a seleção.');
    } finally { setBusy(false); }
  };
  const number = (id: string) => rows.find(r => r.id === id)?.number ?? id.slice(0, 8);
  return <Modal title={action === 'delete' ? `Excluir ${NOUN[kind]} selecionados` : `Restaurar ${NOUN[kind]} selecionados`} onClose={() => onClose(changed.current)}
    actions={results ? <button type="button" className="primary-button" onClick={() => onClose(changed.current)}>Fechar</button>
      : <><button type="button" className="secondary-button" disabled={busy} onClick={() => onClose(changed.current)}>Cancelar</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void run()}>{busy ? 'Confirmando…' : action === 'delete' ? 'Excluir' : 'Restaurar'}</button></>}>
    {!results && <>
      <p>{action === 'delete' ? `${rows.length} documento(s) vão para a lixeira (situação Excluídos). Só entram os que não têm efeitos; os demais continuam e o motivo aparece no resultado. Na lixeira nada muda, e Restaurar devolve o documento como estava.`
        : `${rows.length} documento(s) voltam da lixeira para a lista, como estavam.`}</p>
      {action === 'delete' && <div className="form-field"><label htmlFor="trash-reason">Motivo da exclusão *</label><input id="trash-reason" maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></div>}
    </>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {results && <ul className="real-help">{results.map(r => <li key={r.id}>Nº {number(r.id)}: {r.ok ? (action === 'delete' ? 'excluído' : 'restaurado') : `não ${action === 'delete' ? 'excluído' : 'restaurado'} — ${TRASH_REASONS[r.reason ?? ''] ?? 'recusado'}`}</li>)}</ul>}
  </Modal>;
}
