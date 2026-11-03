import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccessError, type AccessController } from '../lib/real-access';
import type { ContactTypeItem } from '../lib/contact-list-model';
import { Modal } from './Modal';
import { aborted, errorText } from './catalog-shared';

// Modal "Cadastrar tipo de contato" (Origin TC-02 e CF-45): Marcador*, o aviso com o link para gerenciar os tipos,
// Cancelar e Salvar. O comando tem command_id; um resultado incerto oferece "Conferir resultado" com o mesmo comando.
export function ContactTypeModal({ controller, showManageLink = true, onClose, onCreated }: { controller: AccessController; showManageLink?: boolean; onClose: () => void; onCreated: (type: ContactTypeItem) => void }) {
  const [label, setLabel] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [command, setCommand] = useState<{ id: string; label: string; uncertain: boolean } | null>(null);
  const request = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  useEffect(() => () => request.current?.abort(), []);
  const send = async (current: { id: string; label: string; uncertain: boolean }) => {
    if (request.current) return;
    const pending = new AbortController(); request.current = pending; setBusy(true); setError(''); setCommand(current);
    try {
      const result = await controller.catalog('/v1/cadastros/tipos-contato', { method: 'POST', body: { command_id: current.id, label: current.label }, signal: pending.signal }) as { item?: ContactTypeItem };
      if (pending.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      if (!result.item || result.item.label !== current.label) throw new AccessError(502);
      setCommand(null); onCreated(result.item);
    } catch (failure) {
      if (pending.signal.aborted || aborted(failure)) return;
      if (!current.uncertain && failure instanceof AccessError && [400, 403, 409].includes(failure.status)) { setCommand(null); setError(failure.status === 409 ? 'Já existe um tipo de contato com esse marcador.' : errorText(failure)); }
      else { setCommand({ ...current, uncertain: true }); setError('Não foi possível confirmar se o tipo foi cadastrado. Use “Conferir resultado” para repetir o mesmo envio.'); }
    } finally { if (request.current === pending) { request.current = null; setBusy(false); } }
  };
  const save = () => { const value = label.trim(); if (!value) { setError('Informe o marcador.'); return; } void send({ id: crypto.randomUUID(), label: value, uncertain: false }); };
  return <Modal title="Cadastrar tipo de contato" onClose={() => { if (!busy && !command?.uncertain) onClose(); }} actions={<><button type="button" className="secondary-button" disabled={busy || Boolean(command?.uncertain)} onClick={onClose}>Cancelar</button>
    {command?.uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void send(command)}>{busy ? 'Conferindo…' : 'Conferir resultado'}</button>
      : <button type="button" className="primary-button" disabled={busy} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button>}</>}>
    <div className="contact-type-modal">
      {showManageLink && <p className="real-notice">Para gerenciar os tipos de contato <Link to="/tipos-contatos-empresa">clique aqui</Link>.</p>}
      <div className="form-field"><label htmlFor="contact-type-label">Marcador *</label><input id="contact-type-label" maxLength={60} value={label} disabled={busy || Boolean(command?.uncertain)} onChange={event => { setLabel(event.target.value); setError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); save(); } }} /></div>
      {error && <p className="real-alert" role="alert">{error}</p>}
    </div>
  </Modal>;
}
