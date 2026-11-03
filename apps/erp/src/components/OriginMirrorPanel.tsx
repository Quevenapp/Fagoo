import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { MIRROR_STATE_TEXT, dateTimeText, mirrorCarrierPath, mirrorRecordPath, mirrorRows, readOriginMirror, type OriginMirror, type MirrorEntity } from '../lib/origin-mirror-model';
import { Icon } from './Icon';
import './origin-mirror.css';

type Controller = Pick<AccessController, 'originMirror'>;
const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const failureText = (error: unknown) => error instanceof AccessError
  ? error.status === 403 ? 'Seu perfil não permite esta operação.' : error.status === 404 ? 'Cadastro não encontrado.' : error.status === 409 ? 'O cadastro mudou. Atualize e tente de novo.' : 'Não foi possível carregar os dados do Origin.'
  : 'Não foi possível carregar os dados do Origin.';

/**
 * Leva H (350): "Dados do Origin" of a contact or product (seção recolhível, somente leitura). During coexistence the Origin is the
 * master of these fields; what the Brufap keeps on its own (complementos) is listed apart. For a contact, "Transportador
 * (complemento do Brufap)" marks the contact for the Transportador search without changing the mirrored cadastro.
 */
export default function OriginMirrorPanel({ controller, entity, id, writable }: { controller: Controller; entity: MirrorEntity; id: string; writable: boolean }) {
  const [open, setOpen] = useState(false), [mirror, setMirror] = useState<OriginMirror | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [carrier, setCarrier] = useState<{ value: boolean; command: string } | null>(null), [notice, setNotice] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    const request = new AbortController(); setError('');
    void Promise.resolve().then(() => controller.originMirror(mirrorRecordPath(entity, id), { signal: request.signal }))
      .then(value => { if (!request.signal.aborted) setMirror(readOriginMirror(value, entity, id)); })
      .catch(failure => { if (!request.signal.aborted && !cancelled(failure)) setError(failureText(failure)); });
    return () => request.abort();
  }, [controller, entity, id, open]);
  const complement = mirror?.local_complements.includes('carrier_complement') ?? false;
  const toggleCarrier = async () => {
    // The same command is repeated until its result is confirmed ("Conferir resultado").
    const pending = carrier ?? { value: !complement, command: crypto.randomUUID() };
    setCarrier(pending); setBusy(true); setNotice(''); setError('');
    try {
      await controller.originMirror(mirrorCarrierPath(id), { method: 'POST', body: { command_id: pending.command, carrier: pending.value } });
      const value = readOriginMirror(await controller.originMirror(mirrorRecordPath(entity, id)), entity, id);
      if (!mounted.current) return;
      setMirror(value); setCarrier(null);
      setNotice(pending.value ? 'Contato marcado como transportador no FAGOO.' : 'Marcação de transportador removida.');
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof AccessError && [400, 403, 404].includes(failure.status)) setCarrier(null);
      setError(failure instanceof AccessError && failure.status >= 500 ? 'Não foi possível confirmar. Use Conferir resultado.' : failureText(failure));
    } finally { if (mounted.current) setBusy(false); }
  };
  const rows = mirror ? mirrorRows(mirror) : [];
  return <section className="contact-section origin-mirror-panel">
    <button type="button" className="contact-collapse" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} /><h3 className="catalog-group-title">Dados do Origin</h3></button>
    {open && <div className="origin-mirror-body">
      {error && <p className="real-alert" role="alert">{error}</p>}
      {!mirror && !error && <p role="status">Carregando dados do Origin…</p>}
      {mirror && !mirror.linked && <p className="real-help">Cadastro criado no FAGOO, sem vínculo com o Origin.</p>}
      {mirror?.linked && <>
        <p className="real-help">Origem: Origin, id {mirror.source_id} · {MIRROR_STATE_TEXT[mirror.state ?? ''] ?? mirror.state} · Sincronizado em {dateTimeText(mirror.synced_at)}
          {mirror.source_seen_at ? ` · Última leitura do Origin em ${dateTimeText(mirror.source_seen_at)}` : ''}</p>
        {mirror.pending && <p className="real-alert" role="status">Há uma alteração mais recente no Origin aguardando a importação revisada.</p>}
        <p className="real-help">Durante a convivência o Origin é o sistema principal destes campos; altere-os no Origin.</p>
        <dl className="origin-mirror-fields">{rows.map(row => <div key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
      </>}
      {mirror && mirror.local_complements.length > 0 && <p className="real-help">Complementos exclusivos do FAGOO preenchidos: {mirror.local_complements.length}.</p>}
      {mirror && entity === 'contacts' && <p>
        <label><input type="checkbox" checked={carrier ? carrier.value : complement} disabled={!writable || busy} onChange={() => void toggleCarrier()} /> Transportador (complemento do FAGOO)</label>
        {carrier && !busy && <button type="button" className="text-button" onClick={() => void toggleCarrier()}>Conferir resultado</button>}
      </p>}
      {notice && <p className="real-help" role="status">{notice}</p>}
    </div>}
  </section>;
}
