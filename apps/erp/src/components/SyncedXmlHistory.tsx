import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AccessError } from '../lib/real-access';
import { badgeClass } from '../lib/origin-list';
import { MAX_SYNCED_XML_BYTES, SYNCED_XML_BASE, syncedXmlFilename, syncedXmlPage, syncedXmlParams, verifySyncedXmlBlob,
  type SyncedXmlController, type SyncedXmlFilters, type SyncedXmlItem, type SyncedXmlPage } from '../lib/synced-xml-model';
import { AppliedChips } from './OriginList';
import { Icon } from './Icon';
import NativeListLayout from './NativeListLayout';
import './synced-xml.css';
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const failure = (error: unknown) => error instanceof AccessError && error.status === 403 ? 'Seu perfil não permite consultar estes XMLs.'
  : 'Não foi possível conferir os XMLs. Tente novamente.';
const moment = (value: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
const empty = (model: '' | '55' | '65' = ''): SyncedXmlFilters => ({ q: '', model, kind: '', include_history: false });
// Number as Origin lists it (six digits with leading zeros, e.g. "042199"), read from the access key.
const noteNumber = (key: string) => key.slice(25, 34).replace(/^0+(?=\d)/, '').padStart(6, '0');
/** This archive does not create fiscal drafts or represent a live SEFAZ consultation. */
export default function SyncedXmlHistory({ controller, initialModel = '' }: { controller: SyncedXmlController; initialModel?: '' | '55' | '65' }) {
  const [draft, setDraft] = useState<SyncedXmlFilters>(() => empty(initialModel)), [filters, setFilters] = useState<SyncedXmlFilters>(() => empty(initialModel));
  const [after, setAfter] = useState<string | null>(null), [previous, setPrevious] = useState<(string | null)[]>([]), [reload, setReload] = useState(0);
  const [page, setPage] = useState<SyncedXmlPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [downloading, setDownloading] = useState(''), [downloadError, setDownloadError] = useState(''); const download = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = new AbortController(); download.current?.abort(); download.current = null; setDownloading(''); setDownloadError(''); setPage(null); setLoading(true); setError('');
    void controller.syncedXml(`${SYNCED_XML_BASE}?${syncedXmlParams(filters, after)}`, { signal: request.signal }).then(value => {
      if (!request.signal.aborted) setPage(syncedXmlPage(value, filters, after));
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setError(failure(problem)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => { request.abort(); download.current?.abort(); };
  }, [controller, filters, after, reload]);
  const submit = (event: FormEvent) => { event.preventDefault(); try { syncedXmlParams(draft); setFilters({ ...draft, q: draft.q.trim() }); setAfter(null); setPrevious([]); } catch (problem) { setError((problem as Error).message); } };
  const clear = () => { setDraft(empty()); setFilters(empty()); setAfter(null); setPrevious([]); };
  const remove = (change: Partial<SyncedXmlFilters>) => { setDraft(value => ({ ...value, ...change })); setFilters(value => ({ ...value, ...change })); setAfter(null); setPrevious([]); };
  const chips = [
    ...(filters.q ? [{ label: `Chave de acesso: ${filters.q}`, onRemove: () => remove({ q: '' }) }] : []),
    ...(filters.model ? [{ label: `Modelo: ${filters.model === '55' ? 'NF-e' : 'NFC-e'}`, onRemove: () => remove({ model: '' }) }] : []),
    ...(filters.kind ? [{ label: `Documento: ${filters.kind === 'invoice' ? 'Nota / cupom' : 'Evento fiscal'}`, onRemove: () => remove({ kind: '' }) }] : []),
    ...(filters.include_history ? [{ label: 'Com revisões anteriores', onRemove: () => remove({ include_history: false }) }] : []),
  ];
  const getFile = async (item: SyncedXmlItem) => {
    if (download.current || loading) return; const request = new AbortController(); download.current = request; setDownloading(item.id); setDownloadError('');
    try {
      const value = await controller.syncedXmlDownload(`${SYNCED_XML_BASE}/${item.id}/download`, request.signal);
      if (request.signal.aborted || download.current !== request) return;
      const blob = await verifySyncedXmlBlob(value, item, request.signal);
      if (request.signal.aborted || download.current !== request) return;
      const address = URL.createObjectURL(blob), link = document.createElement('a');
      try { link.href = address; link.download = syncedXmlFilename(item); document.body.appendChild(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(address), 1000); }
    } catch (problem) { if (!request.signal.aborted && !aborted(problem)) setDownloadError('Não foi possível conferir e baixar o arquivo. Nenhum XML foi entregue. Tente novamente.'); }
    finally { if (download.current === request) { download.current = null; if (!request.signal.aborted) setDownloading(''); } }
  };
  return <>
    <header className="real-heading"><div><h1>XMLs sincronizados</h1><p>Arquivos coletados continuamente do Origin, separados do backup inicial. As listas de notas ficam em <a href="/historico-fiscal?modelo=55">NF-e de saída</a>, <a href="/historico-fiscal?modelo=65">NFC-e</a> e <a href="/notas-entrada">notas de compra</a>.</p></div><span className="real-mode">Somente consulta</span></header>
    <p className="real-notice">A situação informada pelo Origin e a presença de protocolo ou assinatura não confirmam autorização fiscal. Estes arquivos passaram por conferência de estrutura; assinatura, XSD e autorização na SEFAZ não foram validados aqui.</p>
    <form onSubmit={submit} aria-label="Filtros dos XMLs sincronizados"><NativeListLayout filters={<>
      <div className="form-field"><label htmlFor="synced-xml-model">Modelo</label><select id="synced-xml-model" value={draft.model} onChange={event => setDraft(value => ({ ...value, model: event.target.value as SyncedXmlFilters['model'] }))}><option value="">NF-e e NFC-e</option><option value="55">NF-e · modelo 55</option><option value="65">NFC-e · modelo 65</option></select></div>
      <div className="form-field"><label htmlFor="synced-xml-kind">Documento</label><select id="synced-xml-kind" value={draft.kind} onChange={event => setDraft(value => ({ ...value, kind: event.target.value as SyncedXmlFilters['kind'] }))}><option value="">Notas e eventos</option><option value="invoice">Nota / cupom</option><option value="event">Evento fiscal</option></select></div>
      <label className="synced-xml-check"><input id="synced-xml-history" type="checkbox" checked={draft.include_history} onChange={event => setDraft(value => ({ ...value, include_history: event.target.checked }))}/>Incluir revisões anteriores</label>
      <button className="primary-button" type="submit" disabled={loading}>Filtrar</button><button className="text-button" type="button" disabled={loading} onClick={clear}>Limpar filtros</button>
    </>} actions={<><button type="button" className="action-button" disabled={loading || Boolean(downloading)} onClick={() => setReload(value => value + 1)}><Icon name="rotate-right" size={15} />Atualizar consulta</button>
      <hr /><div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Arquivos nesta página</dt><dd>{page ? page.items.length.toLocaleString('pt-BR') : '—'}</dd></dl></div>
      <p className="real-help">{filters.include_history ? 'A lista inclui revisões antigas preservadas. Cada linha identifica sua revisão.' : 'A lista mostra o conjunto de arquivos da última revisão coletada de cada origem.'}</p>
      <p className="real-help">O download confere o tamanho e o hash do arquivo completo antes de entregá-lo. Limite por arquivo: {MAX_SYNCED_XML_BYTES / 1024 / 1024} MiB.</p>
    </>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="synced-xml-query">Pesquisar por chave de acesso</label><input id="synced-xml-query" type="search" maxLength={64} value={draft.q} onChange={event => setDraft(value => ({ ...value, q: event.target.value }))} placeholder="Pesquisar por chave de acesso (completa ou parte)"/></div><button className="secondary-button" type="submit" title="Pesquisar" aria-label="Pesquisar" disabled={loading}><Icon name="search" size={16} /></button></div>
      <AppliedChips chips={chips} onClear={clear} />
      {loading && <p role="status">Consultando XMLs…</p>}{error && <p className="real-alert" role="alert">{error} <button type="button" className="text-button" disabled={loading} onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
      {downloadError && <p className="real-alert" role="alert">{downloadError}</p>}
      {page && <><div className="table-scroll" role="region" tabIndex={0} aria-label="XMLs sincronizados do Origin"><table className="data-table synced-xml-table"><thead><tr><th>Número</th><th>Chave de acesso</th><th>Origem no Origin</th><th>Revisão / coleta</th><th>Estrutura</th><th>Arquivo</th></tr></thead><tbody>{page.items.map(item => <tr key={item.id}>
        <td><strong>{item.model === '55' ? 'NF-e' : 'NFC-e'} {noteNumber(item.key)}</strong><small>Série {item.key.slice(22, 25).replace(/^0+(?=\d)/, '')} · modelo {item.model}</small><small>{item.kind === 'event' ? `Evento ${item.event_type ?? 'não identificado'}` : 'Nota / cupom'}{item.event_sequence ? ` · sequência ${item.event_sequence}` : ''}</small>{item.environment === '2' && <small>Homologação · sem valor fiscal</small>}</td>
        <td className="synced-xml-key">{item.key}</td><td><small>{item.entity === 'nfe' ? 'NF-e' : 'NFC-e'} · ID {item.source_id}</small><span>Situação na coleta do Origin: {item.source_status ?? 'não informada'}</span></td>
        <td><strong>Revisão {item.revision}</strong><small>{moment(item.collected_at)}</small><small>Horário de São Paulo</small></td>
        <td><span className={badgeClass(item.issues.length ? 'Pendente' : 'Conferida')}>{item.issues.length ? 'Há pontos para revisão' : 'Conferida'}</span><small>Protocolo {item.protocol_present ? 'presente' : 'ausente'} · assinatura {item.signature_present ? 'presente' : 'ausente'}</small>{item.protocol && <small>Protocolo: {item.protocol}</small>}{item.issues.length > 0 && <details><summary>{item.issues.length} ponto(s)</summary><ul>{item.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}</td>
        <td><button type="button" className="text-button" disabled={Boolean(downloading) || loading} onClick={() => void getFile(item)} aria-label={`Baixar XML ${item.id}`}>{downloading === item.id ? 'Conferindo arquivo…' : 'Baixar XML'}</button><small>{item.size_bytes.toLocaleString('pt-BR')} bytes</small></td>
      </tr>)}</tbody></table></div>
      {!page.items.length && <div className="empty-state"><h2>Nenhum XML encontrado</h2><p>Ajuste os filtros ou aguarde a próxima coleta do Origin.</p></div>}
      <footer className="table-footer real-pagination"><span>{page.items.length} arquivo(s) nesta página · página {previous.length + 1}</span><div className="pagination"><button className="secondary-button" type="button" disabled={loading || !previous.length} onClick={() => { setAfter(previous.at(-1) ?? null); setPrevious(value => value.slice(0, -1)); }}>Anterior</button><button className="secondary-button" type="button" disabled={loading || !page.has_more} onClick={() => { setPrevious(value => [...value, after]); setAfter(page.next_cursor); }}>Próxima</button></div></footer></>}
    </NativeListLayout></form>
  </>;
}
