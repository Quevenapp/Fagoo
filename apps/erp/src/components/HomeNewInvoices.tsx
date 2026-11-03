import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { NEW_INVOICES_PATH, NEW_INVOICES_SEEN_PATH, parseNewInvoices, moment, type NewInvoices, type PlatformPort } from '../lib/platform-model';

const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Leva H (PRF-252): card Notas Fiscais, "● N Novas NF-es": real notes synced from Origin (authorized or with DANFE) or received
 * from SEFAZ since this user's last view. Brufap drafts and homologation notes are never counted. */
export default function HomeNewInvoices({ controller }: { controller: Partial<PlatformPort> }) {
  const [value, setValue] = useState<NewInvoices | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    if (typeof controller.platform !== 'function') return;
    const request = new AbortController(); setError('');
    void controller.platform(NEW_INVOICES_PATH, { method: 'GET', signal: request.signal }).then(raw => { if (!request.signal.aborted) setValue(parseNewInvoices(raw)); })
      .catch(e => { if (!request.signal.aborted && !aborted(e)) setError('Não foi possível contar as novas NF-es.'); });
    return () => request.abort();
  }, [controller, reload]);
  if (typeof controller.platform !== 'function') return null;
  const seen = async () => {
    if (busy) return; setBusy(true); setError('');
    try { const raw = await controller.platform!(NEW_INVOICES_SEEN_PATH, { method: 'POST', body: { command_id: crypto.randomUUID() } }) as { view?: unknown }; setValue(parseNewInvoices(raw.view)); }
    catch (e) { if (!aborted(e)) setError('Não foi possível marcar as notas como vistas. Tente de novo.'); setReload(n => n + 1); }
    finally { setBusy(false); }
  };
  return <article className="home-card"><header><h3><Link className="home-card-title" to="/historico-fiscal?modelo=55">Notas Fiscais<Icon name="right" size={11} /></Link></h3></header>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {value ? <>
      <ul className="home-dots home-sales"><li><span className="home-dot home-dot-success" aria-hidden="true" /><strong>{value.total}</strong><span>{value.total === 1 ? 'Nova NF-e' : 'Novas NF-es'}</span></li></ul>
      <p className="home-card-note">{value.synced > 0 && <>{plural(value.synced, 'do histórico importado', 'do histórico importado')} (autorizadas ou com DANFE) e </>}{plural(value.received, 'recebida da SEFAZ', 'recebidas da SEFAZ')} desde {value.seen_before ? `a sua última visualização (${moment(value.since)})` : 'os últimos 7 dias'}. Rascunhos e homologação não entram.</p>
      {value.total > 0 && <p><button type="button" className="text-button" onClick={() => void seen()} disabled={busy}>Marcar como vistas</button></p>}
    </> : !error && <p className="real-result-status" role="status">Contando novas NF-es…</p>}
  </article>;
}
