import { useState } from 'react';
import { Icon } from './Icon';
import { CEP_MESSAGES, cepDigits, cepPath, parseCep, type CepAddress, type PlatformPort } from '../lib/platform-model';
import './help-center.css';

const statusOf = (e: unknown) => typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 0;

/** Leva H (NFE-103): "Buscar CEP" (the lupa of the Origin), a convenience over the public lookup through the API. It only fills the
 * empty fields the caller chooses to fill; when the lookup fails or the CEP does not exist, the address is typed by hand. */
export default function CepLookupButton({ controller, cep, disabled, onFound, id }: { controller: Partial<PlatformPort>; cep: string | null | undefined; disabled?: boolean; onFound: (address: CepAddress) => void; id: string }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  if (typeof controller.platform !== 'function') return null;
  const digits = cepDigits(cep);
  const lookup = async () => {
    if (busy || digits.length !== 8) { setMessage('Informe os 8 dígitos do CEP.'); return; }
    setBusy(true); setMessage('');
    try { const address = parseCep(await controller.platform!(cepPath(digits), { method: 'GET' }), digits); onFound(address); setMessage(`Endereço de ${address.city}/${address.state} preenchido pela consulta (ViaCEP). Confira antes de salvar.`); }
    catch (e) { setMessage(CEP_MESSAGES[statusOf(e)] ?? CEP_MESSAGES[503]!); }
    finally { setBusy(false); }
  };
  return <div className="platform-cep-lookup"><button type="button" id={id} className="secondary-button" disabled={disabled || busy} onClick={() => void lookup()} title="Buscar endereço pelo CEP" aria-label="Buscar CEP">
    <Icon name="magnifying-glass" size={13} />{busy ? 'Buscando…' : 'Buscar CEP'}</button>{message && <p className="platform-cep-message" role="status">{message}</p>}</div>;
}
