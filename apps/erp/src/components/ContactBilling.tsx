import { useEffect, useId, useState } from 'react';
import { AccessError, type NativeRequestOptions } from '../lib/real-access';
import { billingAddressText, contactBilling, contactBillingPath, type ContactBillingItem } from '../lib/contact-billing-model';
import { Icon } from './Icon';
import './financeiro-h.css';

type Controller = { catalog: (path: string, options?: NativeRequestOptions) => Promise<unknown> };

/**
 * Leva H (SQL 373: CTT-050, PRF-299): Cobrança of the contact. "Usar o endereço geral para cobrança" (explicit), the e-mail de cobrança
 * and the endereço de cobrança that the financeiro uses. The "E-mail verificado" badge only appears for an address confirmed by an
 * explicit flow; the confirmation by e-mail is not available yet, so no address is shown as verified.
 */
export default function ContactBilling({ controller, contactId, writable }: { controller: Controller; contactId: string; writable: boolean }) {
  const [item, setItem] = useState<ContactBillingItem | null>(null), [draft, setDraft] = useState({ same: false, email: '' }), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), sameId = useId(), emailId = useId();
  useEffect(() => {
    const request = new AbortController(); setItem(null); setError('');
    void controller.catalog(contactBillingPath(contactId), { signal: request.signal }).then(value => { if (request.signal.aborted) return; const next = contactBilling(value, contactId); setItem(next); setDraft({ same: next.same_as_general, email: next.billing_email ?? '' }); })
      .catch(() => { if (!request.signal.aborted) setError('Não foi possível carregar os dados de cobrança.'); });
    return () => request.abort();
  }, [controller, contactId]);
  if (!item) return <p className="real-help" role="status">{error || 'Carregando os dados de cobrança…'}</p>;
  const dirty = draft.same !== item.same_as_general || draft.email.trim() !== (item.billing_email ?? '');
  const save = async () => {
    if (!writable || busy || !dirty) return; setBusy(true); setError(''); setNotice('');
    try {
      const value = await controller.catalog(contactBillingPath(contactId), { method: 'POST', body: { command_id: crypto.randomUUID(), expected_version: item.version, data: { same_as_general: draft.same, billing_email: draft.email.trim() || null } } });
      const next = contactBilling(value, contactId); setItem(next); setDraft({ same: next.same_as_general, email: next.billing_email ?? '' }); setNotice('Dados de cobrança salvos.');
    } catch (failure) { setError(failure instanceof AccessError && failure.status === 409 ? 'Os dados de cobrança mudaram. Recarregue o contato.' : failure instanceof AccessError && failure.status === 400 ? 'Confira o e-mail de cobrança.' : 'Não foi possível salvar os dados de cobrança.'); }
    finally { setBusy(false); }
  };
  return <div className="contact-billing real-field-wide">
    <label className="operational-check" htmlFor={sameId}><input id={sameId} type="checkbox" checked={draft.same} disabled={!writable || busy} onChange={event => setDraft({ ...draft, same: event.target.checked })} />Usar o endereço geral para cobrança</label>
    <div className="form-field"><label htmlFor={emailId}>E-mail de cobrança{item.billing_email_verified && <span className="contact-verified" title="E-mail verificado" role="img" aria-label="E-mail verificado"><Icon name="check" size={10} /></span>}</label>
      <input id={emailId} type="email" maxLength={254} value={draft.email} disabled={!writable || busy} placeholder="financeiro@cliente.example" onChange={event => setDraft({ ...draft, email: event.target.value })} /></div>
    <p className="real-help">Endereço usado na cobrança: {billingAddressText(item.address)}{item.address.source === 'geral' ? ' (endereço geral)' : ' (endereço de cobrança)'}.</p>
    {!item.verification_available && <p className="real-help">A verificação de e-mail ainda não está disponível: nenhum endereço aparece como verificado, e o login do usuário não confirma o e-mail do contato.</p>}
    {writable && <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Salvando…' : 'Salvar dados de cobrança'}</button>}
    {notice && <p className="real-notice" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
  </div>;
}
