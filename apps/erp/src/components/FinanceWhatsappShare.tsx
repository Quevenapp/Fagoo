import { useId, useState } from 'react';
import type { FinanceTitleRow } from '../lib/real-finance-model';
import { whatsappUrl } from '../lib/finance-title-list';
import { Modal } from './Modal';
import './financeiro-h.css';

export type WhatsappShare = { scope: string; title: FinanceTitleRow; phone: string; message: string };

/**
 * Leva H (FIN-044): "Enviar por whatsapp" of a conta a receber with an existing valid cobrança. The user reviews the celular and the
 * text, then the WhatsApp of the device opens with them (wa.me). Nothing is sent by the Brufap and no cobrança is created here.
 */
export default function FinanceWhatsappShare({ share, onClose }: { share: WhatsappShare; onClose: () => void }) {
  const [phone, setPhone] = useState(share.phone), [message, setMessage] = useState(share.message), phoneId = useId(), messageId = useId();
  const url = message.trim() ? whatsappUrl(phone, message.trim()) : null;
  const open = () => { if (!url) return; globalThis.window?.open(url, '_blank', 'noopener'); onClose(); };
  return <Modal title="Enviar por whatsapp" onClose={onClose} actions={<><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
    <button type="button" className="primary-button" disabled={!url} onClick={open}>Abrir o WhatsApp</button></>}>
    <div className="finance-share-review">
      <p className="real-help">Confira o destinatário e a mensagem de {share.title.contact_name}. O WhatsApp abre com este texto para você enviar; o FAGOO não envia mensagens.</p>
      <label htmlFor={phoneId}>Celular (com DDD)<input id={phoneId} inputMode="tel" maxLength={20} value={phone} onChange={event => setPhone(event.target.value)} /></label>
      {!whatsappUrl(phone, 'x') && <p className="real-alert" role="alert">{share.phone ? 'Informe um celular com DDD.' : `O contato ${share.title.contact_name} não tem celular válido no cadastro. Informe o número para esta mensagem.`}</p>}
      <label htmlFor={messageId}>Mensagem<textarea id={messageId} maxLength={1000} value={message} onChange={event => setMessage(event.target.value)} /></label>
    </div>
  </Modal>;
}
