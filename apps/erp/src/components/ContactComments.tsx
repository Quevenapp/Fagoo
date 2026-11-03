import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { aborted, errorText } from './catalog-shared';
import { contactRefusalText } from './contact-errors';

// Menu ⋮ > Comentários (Origin CL-16): "Adicionar Comentário" com "Digite aqui um comentário" e enviar, a lista dos
// comentários (autor e data/hora em São Paulo, vindos do servidor) e Cancelar. Cada envio é um comando: um resultado
// incerto mantém o texto e oferece "Conferir resultado", que repete o mesmo comando sem duplicar o comentário.
type Comment = { id: string; body: string; author_name: string | null; created_at: string };
const when = (value: string) => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(',', '');

export function ContactComments({ controller, contact, onClose }: { controller: AccessController; contact: { id: string; name: string }; onClose: () => void }) {
  const [items, setItems] = useState<Comment[] | null>(null), [canComment, setCanComment] = useState(false), [loadError, setLoadError] = useState('');
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState<{ id: string; body: string; uncertain: boolean } | null>(null);
  const request = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  const guard = useUnsavedForm(text.trim(), busy || Boolean(pending?.uncertain));
  const path = `/v1/cadastros/contatos/${contact.id}/comentarios`;
  useEffect(() => {
    const current = new AbortController();
    void controller.catalog(path, { signal: current.signal }).then(value => {
      if (current.signal.aborted) return; const result = value as { items?: Comment[]; can_comment?: boolean; contact_id?: string };
      if (result.contact_id !== contact.id || !Array.isArray(result.items)) throw new AccessError(502);
      setItems(result.items); setCanComment(Boolean(result.can_comment));
    }).catch(failure => { if (!current.signal.aborted && !aborted(failure)) setLoadError(errorText(failure)); });
    return () => { current.abort(); request.current?.abort(); };
  }, [controller, contact.id]);
  const send = async (command: { id: string; body: string; uncertain: boolean }) => {
    if (request.current) return;
    const current = new AbortController(); request.current = current; setBusy(true); setError(''); setPending(command);
    try {
      const result = await controller.catalog(path, { method: 'POST', body: { command_id: command.id, body: command.body }, signal: current.signal }) as { item?: Comment; contact_id?: string };
      if (current.signal.aborted) return;
      // A different user signed in meanwhile: the answer belongs to the previous session and is not shown.
      if (controller.getSnapshot().membership?.user_id !== actor.current) return;
      if (result.contact_id !== contact.id || !result.item) throw new AccessError(502);
      const added = result.item;
      setItems(previous => [added, ...(previous ?? []).filter(item => item.id !== added.id)]); setText(''); setPending(null);
    } catch (failure) {
      if (current.signal.aborted || aborted(failure)) return;
      if (!command.uncertain && failure instanceof AccessError && [400, 403, 404].includes(failure.status)) { setPending(null); setError(contactRefusalText(failure) ?? errorText(failure)); }
      else { setPending({ ...command, uncertain: true }); setError('Não foi possível confirmar se o comentário foi registrado. Use “Conferir resultado” para repetir o mesmo envio sem duplicar.'); }
    } finally { if (request.current === current) { request.current = null; setBusy(false); } }
  };
  const submit = () => { const body = text.trim(); if (!body || busy || pending?.uncertain) return; void send({ id: crypto.randomUUID(), body, uncertain: false }); };
  return <Modal title="Adicionar Comentário" onClose={() => guard.confirmLeave(onClose)} actions={<button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button>}>
    <div className="contact-comments">
      <p className="real-help">{contact.name}</p>
      {canComment && <div className="contact-comment-input"><label htmlFor="contact-comment" className="real-sr-only">Comentário</label>
        <textarea id="contact-comment" rows={3} maxLength={2000} placeholder="Digite aqui um comentário" value={text} disabled={busy || Boolean(pending?.uncertain)} onChange={event => setText(event.target.value)} />
        {pending?.uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void send(pending)}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
          : <button type="button" className="icon-button contact-comment-send" title="Enviar comentário" aria-label="Enviar comentário" disabled={busy || !text.trim()} onClick={submit}><Icon name="paper-plane" size={14} /></button>}</div>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      {loadError && <p className="real-alert" role="alert">{loadError}</p>}
      {items === null && !loadError ? <p role="status">Carregando comentários…</p>
        : items && !items.length ? <p className="real-help">Nenhum comentário registrado.</p>
          : <ol className="contact-comment-list">{items?.map(item => <li key={item.id}><p>{item.body}</p><small>{item.author_name ?? 'Usuário'} · {when(item.created_at)}</small></li>)}</ol>}
    </div>
  </Modal>;
}
