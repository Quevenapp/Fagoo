import { useEffect, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import type { DocumentEnvelope, DocumentKind } from '../lib/real-documents-model';

type Controller = Pick<AccessController, 'catalog' | 'documents' | 'getSnapshot'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorOf = (controller: Controller) => controller.getSnapshot().membership?.user_id ?? null;

/**
 * Origin warnings when an existing document is opened: the contact name saved in the document differs from the
 * current cadastro, or the cadastro is inactive or missing. Read-only; the document is never changed here.
 */
export function DocumentContactCheck({ controller, kind, contactId, savedName }: { controller: Controller; kind: DocumentKind; contactId: string; savedName: string }) {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!UUID.test(contactId)) return;
    const request = new AbortController(), actor = actorOf(controller), noun = kind === 'purchase_orders' ? 'fornecedor' : 'cliente';
    setNotice('');
    void Promise.resolve().then(() => controller.catalog(`/v1/cadastros/contacts/${contactId}`, { signal: request.signal })).then(value => {
      if (request.signal.aborted || actorOf(controller) !== actor) return;
      const record = (value as { record?: { id?: unknown; name?: unknown; active?: unknown } } | null)?.record;
      if (!record || typeof record.id !== 'string' || record.id.toLowerCase() !== contactId.toLowerCase() || typeof record.name !== 'string' || typeof record.active !== 'boolean') return;
      const messages = [];
      if (record.name.trim() !== savedName.trim()) messages.push(`O nome desse ${noun} foi alterado nessa ${kind === 'sales_orders' ? 'venda' : 'versão do documento'}: no cadastro ele é “${record.name}”.`);
      if (!record.active) messages.push(`O ${noun} está inativo no cadastro.`);
      setNotice(messages.join(' '));
    }).catch(failure => {
      if (request.signal.aborted || actorOf(controller) !== actor) return;
      if (failure instanceof AccessError && failure.status === 404) setNotice(`${noun === 'cliente' ? 'Cliente' : 'Fornecedor'} não encontrado no cadastro. O documento mantém os dados salvos.`);
      // Other failures (profile without access, network) show nothing: the document keeps its own snapshot.
    });
    return () => request.abort();
  }, [controller, kind, contactId, savedName]);
  return notice ? <p className="real-notice document-contact-check" role="status">{notice}</p> : null;
}

/** "Nº da Proposta" (read only) for a pedido or OS generated from a proposal, with the link to open it. */
export function DocumentProposalNumber({ controller, proposalId, disabled, onOpen }: { controller: Controller; proposalId: string; disabled?: boolean; onOpen: () => void }) {
  const [number, setNumber] = useState<string | null>(null), [state, setState] = useState<'loading' | 'ready' | 'hidden'>('loading');
  useEffect(() => {
    const request = new AbortController(), actor = actorOf(controller); setState('loading'); setNumber(null);
    void Promise.resolve().then(() => controller.documents(`/v1/documentos/sales_proposals/${proposalId}`, { signal: request.signal })).then(value => {
      if (request.signal.aborted || actorOf(controller) !== actor) return;
      const document = (value as DocumentEnvelope | null)?.document;
      if (!document || document.id !== proposalId || document.kind !== 'sales_proposals' || !/^[1-9]\d{0,9}$/.test(document.number)) { setState('hidden'); return; }
      setNumber(document.number); setState('ready');
    }).catch(() => { if (!request.signal.aborted) setState('hidden'); });
    return () => request.abort();
  }, [controller, proposalId]);
  return <div className="form-field document-proposal-number"><label htmlFor="doc-proposal-number">Nº da Proposta</label>
    <input id="doc-proposal-number" readOnly value={state === 'ready' ? number ?? '' : state === 'loading' ? 'Consultando…' : 'Proposta de origem'} />
    {state === 'ready' && <button type="button" className="text-button" disabled={disabled} onClick={onOpen}>Abrir proposta {number}</button>}
    {state === 'hidden' && <small>O número da proposta não está disponível para o seu perfil.</small>}
  </div>;
}
