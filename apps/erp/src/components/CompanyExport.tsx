import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EXPORTS_PATH, EXPORT_STATUS_TEXT, exportLinkPath, fmtBytes, moment, parseExportLink, parseExports, type CompanyExport as Export, type PlatformPort } from '../lib/platform-model';
import type { AccessState } from '../lib/real-access';

const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const statusOf = (e: unknown) => typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 0;
const fieldOf = (e: unknown) => typeof (e as { field?: unknown })?.field === 'string' ? (e as { field: string }).field : null;
type Controller = Partial<PlatformPort> & { getSnapshot?: () => AccessState };

/** Leva H (PRF-029): Backup e Exportação › Backup. The administrador asks for the package; the server builds it in the background
 * (Consultar gestão de ações shows the task); "Baixar" asks for a new 2-minute link each time. */
export default function CompanyExport({ controller }: { controller: Controller }) {
  const admin = controller.getSnapshot?.()?.membership?.role === 'admin';
  const [items, setItems] = useState<Export[] | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!admin || typeof controller.platform !== 'function') return;
    const request = new AbortController(); setError('');
    void controller.platform(EXPORTS_PATH, { method: 'GET', signal: request.signal }).then(raw => { if (!request.signal.aborted) setItems(parseExports(raw).items); })
      .catch(e => { if (!request.signal.aborted && !aborted(e)) setError(statusOf(e) === 403 ? 'Somente o administrador exporta os dados da empresa.' : 'Não foi possível carregar as exportações.'); });
    return () => request.abort();
  }, [controller, admin, reload]);
  // While a package is being built, look again every 15 seconds.
  useEffect(() => { if (!items?.some(e => e.status === 'queued' || e.status === 'running')) return; const t = setTimeout(() => setReload(n => n + 1), 15000); return () => clearTimeout(t); }, [items]);
  if (!admin) return <section className="real-state-panel"><h1>Backup não liberado</h1><p>Somente o administrador exporta os dados da empresa.</p></section>;
  const ask = async () => {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { const raw = await controller.platform!(EXPORTS_PATH, { method: 'POST', body: { command_id: crypto.randomUUID() } }) as { view?: unknown }; setItems(parseExports(raw.view).items); setNotice('Exportação pedida. O pacote é gerado em segundo plano.'); }
    catch (e) { setError(fieldOf(e) === 'export_in_progress' ? 'Já existe uma exportação em andamento. Aguarde a conclusão.' : 'Não foi possível pedir a exportação.'); }
    finally { setBusy(false); }
  };
  const download = async (item: Export) => {
    setError('');
    try {
      const link = parseExportLink(await controller.platform!(exportLinkPath(item.id), { method: 'POST', body: {} }), controller.storageOrigin);
      const a = document.createElement('a'); a.href = link.url; a.download = link.filename; a.rel = 'noreferrer'; document.body.appendChild(a); a.click(); a.remove();
      setReload(n => n + 1);
    } catch (e) { setError(fieldOf(e) === 'export_unavailable' ? 'Esta exportação não está mais disponível. Peça uma nova.' : 'Não foi possível gerar o link de download.'); }
  };
  const running = items?.some(e => e.status === 'queued' || e.status === 'running');
  return <div className="company-export">
    <nav className="preferences-breadcrumb preferences-screen-trail" aria-label="Localização"><Link to="/acesso">Home</Link> › <Link to="/preferencias">Preferências</Link> › <Link to="/preferencias/backup">Backup e Exportação de Dados</Link> › <span aria-current="page">Backup</span></nav>
    <header className="real-heading"><div><h1>Backup</h1><p>Um pacote ZIP com os dados e os arquivos anexados da empresa. Fica 7 dias numa área privada; cada download usa um link novo de 2 minutos.</p></div>
      <button type="button" className="primary-button" onClick={() => void ask()} disabled={busy || running}>Gerar exportação</button></header>
    {notice && <p className="real-notice" role="status">{notice} Acompanhe em <Link to="/preferencias/sistema/gestao-acoes">Consultar gestão de ações</Link>.</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    <p className="real-help">Ficam de fora credenciais, tokens, o cofre do certificado A1 e os usuários do login. O manifesto.json do pacote lista o escopo e a data. O backup da plataforma (banco e Storage) é feito à parte pela equipe. <Link to="/ajuda/exportacao">Saiba mais</Link></p>
    {!items && !error && <p role="status">Carregando…</p>}
    {items && (items.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">Pedida em</th><th scope="col">Situação</th><th scope="col">Conteúdo</th><th scope="col">Tamanho</th><th scope="col">Disponível até</th><th scope="col"><span className="sr-only">Ações</span></th></tr></thead>
      <tbody>{items.map(item => <tr key={item.id}><td>{moment(item.created_at)}{item.requested_by_name ? ` · ${item.requested_by_name}` : ''}</td><td>{EXPORT_STATUS_TEXT[item.status]}{item.status === 'failed' && item.error_code ? ` (${item.error_code})` : ''}</td>
        <td>{item.summary ? `${item.summary.rows ?? 0} registros em ${item.summary.datasets ?? 0} tabelas, ${item.summary.files ?? 0} arquivos${item.summary.files_skipped ? ` (${item.summary.files_skipped} fora do pacote)` : ''}` : '—'}</td>
        <td>{fmtBytes(item.size_bytes)}</td><td>{item.expires_at ? moment(item.expires_at) : '—'}</td>
        <td>{item.status === 'ready' && <button type="button" className="secondary-button" onClick={() => void download(item)}>Baixar</button>}</td></tr>)}</tbody></table></div>
      : <p className="empty-state">Nenhuma exportação pedida.</p>)}
  </div>;
}
