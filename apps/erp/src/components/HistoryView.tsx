import { Link } from 'react-router-dom';
import { useEffect, useState, type FormEvent } from 'react';
import type { AccessController } from '../lib/real-access';
import { badgeClass } from '../lib/origin-list';
import BackupPreservation from './BackupPreservation';
import { AppliedChips, OriginPagination } from './OriginList';
import { Icon } from './Icon';
import NativeListLayout from './NativeListLayout';
import './history.css';

type Backup = { id: string; status: string; available: boolean; created_at: string; finished_at: string | null; xml_occurrences: number; issues: number };
type FiscalXml = { id: string; key: string | null; kind: 'invoice' | 'event'; model: '55' | '65' | null; environment: string | null;
  protocol: string | null; protocol_present: boolean; signature_present: boolean; occurrences: number; issues: string[]; event_type: string | null };
type Page = { items: FiscalXml[]; total: number; has_more: boolean; next_offset: number | null; limit: number; offset: number; backup_id: string; data_mode: string };
const sha = /^[0-9a-f]{64}$/;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const MAX_OFFSET = 100000;
// Origin list titles of the menu entries Vendas > "Notas fiscais de saída" (modelo 55) and "NFC-e" (modelo 65).
const TITLES: Record<string, string> = { '55': 'Notas Fiscais de Saída', '65': 'Nota fiscal de consumidor eletrônica (NFC-e)' };
const MODELS: Record<string, string> = { '55': 'NF-e', '65': 'NFC-e' };
const KINDS: Record<string, string> = { invoice: 'Notas e cupons', event: 'Eventos fiscais' };
// Number as Origin lists it (six digits with leading zeros, e.g. "042199") and the series, both read from the access key.
const noteNumber = (key: string) => key.slice(25, 34).replace(/^0+(?=\d)/, '').padStart(6, '0');
const noteSeries = (key: string) => key.slice(22, 25).replace(/^0+(?=\d)/, '');
function moment(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Em processamento';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value));
}
function backupsResponse(value: unknown): Backup[] {
  const body = value as { items: Backup[]; data_mode: string };
  if (!body || body.data_mode !== 'backup_readonly' || !Array.isArray(body.items) || body.items.length > 100
    || body.items.some(item => !item || !sha.test(item.id) || typeof item.available !== 'boolean')) throw new Error('invalid_history');
  return body.items;
}
function pageResponse(value: unknown, backup: string): Page {
  const body = value as Page;
  if (!body || body.data_mode !== 'backup_readonly' || body.backup_id !== backup || !Array.isArray(body.items) || body.items.length > 100
    || !Number.isSafeInteger(body.total) || body.total < 0 || body.items.some(item => !item || !sha.test(item.id) || !Array.isArray(item.issues))) throw new Error('invalid_history');
  return body;
}

export default function HistoryView({ controller, initialModel = '', canIssue = false }: { controller: AccessController; initialModel?: '' | '55' | '65'; canIssue?: boolean }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(true);
  const [backupId, setBackupId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState({ q: '', model: initialModel as string, kind: '', limit: 25, offset: 0 });
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [downloading, setDownloading] = useState('');
  useEffect(() => {
    const request = new AbortController(); let active = true;
    setLoadingBackups(true); setMessage('');
    void controller.history('/v1/history/backups', request.signal).then(value => {
      if (!active) return;
      const items = backupsResponse(value); setBackups(items);
      setBackupId(previous => items.some(item => item.id === previous && item.available) ? previous : items.find(item => item.available)?.id || '');
    }).catch(error => { if (active && !aborted(error)) setMessage('Não foi possível consultar os backups. Tente novamente.'); })
      .finally(() => { if (active) setLoadingBackups(false); });
    return () => { active = false; request.abort(); };
  }, [controller, refresh]);
  useEffect(() => {
    setPage(null);
    if (!backupId) { setLoading(false); return; }
    const request = new AbortController(); let active = true;
    const params = new URLSearchParams({ backup: backupId, limit: String(filter.limit), offset: String(filter.offset) });
    for (const name of ['q', 'model', 'kind'] as const) if (filter[name]) params.set(name, filter[name]);
    setLoading(true); setMessage('');
    void controller.history(`/v1/history/xml?${params}`, request.signal).then(value => {
      if (active) setPage(pageResponse(value, backupId));
    }).catch(error => { if (active && !aborted(error)) setMessage('Não foi possível consultar os documentos. Confira os filtros e tente novamente.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; request.abort(); };
  }, [controller, backupId, filter, refresh]);
  const [downloads] = useState(() => new Set<AbortController>());
  useEffect(() => () => { downloads.forEach(request => request.abort()); downloads.clear(); }, [downloads]);
  const download = async (item: FiscalXml) => {
    const request = new AbortController(); downloads.add(request); setDownloading(item.id); setMessage('');
    try {
      const blob = await controller.historyDownload(`/v1/history/xml/${item.id}/download?backup=${backupId}`, request.signal);
      if (request.signal.aborted) return;
      const address = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = address; link.download = `origin-${item.model || 'xml'}-${item.id.slice(0, 12)}.xml`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(address), 1000);
    } catch (error) { if (!request.signal.aborted && !aborted(error)) setMessage('Não foi possível baixar o XML. Tente novamente.'); }
    finally { downloads.delete(request); if (!request.signal.aborted) setDownloading(''); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); setFilter(value => ({ ...value, q: draft.trim(), offset: 0 })); };
  const clear = () => { setDraft(''); setFilter(value => ({ q: '', model: '', kind: '', limit: value.limit, offset: 0 })); };
  const selected = backups.find(item => item.id === backupId);
  const title = TITLES[filter.model] ?? 'Histórico fiscal do Origin';
  const count = filter.kind === 'invoice' ? filter.model === '65' ? 'Quantidade de notas fiscais' : 'Quantidade de notas' : 'Quantidade de arquivos XML';
  const current = Math.floor(filter.offset / filter.limit) + 1;
  const pages = page ? Math.min(Math.max(1, Math.ceil(page.total / filter.limit)), Math.floor(MAX_OFFSET / filter.limit) + 1) : 1;
  const chips = [
    ...(filter.q ? [{ label: `Pesquisa: ${filter.q}`, onRemove: () => { setDraft(''); setFilter(value => ({ ...value, q: '', offset: 0 })); } }] : []),
    ...(filter.model ? [{ label: `Modelo: ${MODELS[filter.model]}`, onRemove: () => setFilter(value => ({ ...value, model: '', offset: 0 })) }] : []),
    ...(filter.kind ? [{ label: `Documento: ${KINDS[filter.kind]}`, onRemove: () => setFilter(value => ({ ...value, kind: '', offset: 0 })) }] : []),
  ];
  return <>
    <header className="real-heading"><div><h1>{title}</h1><p>Consulte e baixe os XMLs preservados no backup da empresa. Este arquivo histórico fica separado das notas sincronizadas.</p></div><span className="history-heading-actions"><span className="real-mode">Somente consulta</span>{canIssue && <Link className="primary-button" to={`/emissor-fiscal?modelo=${filter.model === '65' ? '65' : '55'}`}><Icon name="plus" size={12} />Abrir emissor de homologação</Link>}</span></header>
    {canIssue && <p className="real-help">O emissor é uma área de testes, sem valor fiscal. Os documentos de homologação não fazem parte das listas operacionais.</p>}
    <div className="real-notice"><strong>Arquivos originais, preservados.</strong> A importação não emite notas nem altera o financeiro ou o estoque. A conferência de estrutura não substitui a validação fiscal ou da assinatura digital.</div>
    <section className="history-records" aria-label="Documentos fiscais do backup"><form onSubmit={submit} aria-label="Filtros do histórico fiscal"><NativeListLayout filters={<>
      <div className="form-field"><label htmlFor="history-model">Modelo</label><select id="history-model" value={filter.model} disabled={!backupId} onChange={event => setFilter(value => ({ ...value, model: event.target.value, offset: 0 }))}><option value="">Todos</option><option value="55">NF-e · modelo 55</option><option value="65">NFC-e · modelo 65</option></select></div>
      <div className="form-field"><label htmlFor="history-kind">Documento</label><select id="history-kind" value={filter.kind} disabled={!backupId} onChange={event => setFilter(value => ({ ...value, kind: event.target.value, offset: 0 }))}><option value="">Todos</option><option value="invoice">Notas e cupons</option><option value="event">Eventos fiscais</option></select></div>
      <button type="submit" className="primary-button" disabled={loading || !backupId}>Filtrar</button>
      <button type="button" className="text-button" onClick={clear}>Limpar filtros</button>
    </>} actions={<>
      <button type="button" className="action-button" disabled={loadingBackups || loading} onClick={() => setRefresh(value => value + 1)}><Icon name="rotate-right" size={15} />Atualizar listagem</button>
      <hr />
      <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>{count}</dt><dd>{page ? page.total.toLocaleString('pt-BR') : '—'}</dd></dl></div>
      <p className="real-help">Somente consulta: baixe o XML original pela coluna Arquivo.</p>
    </>}>
      <div className="native-list-type history-backup"><label htmlFor="history-backup">Backup</label><select id="history-backup" value={backupId} disabled={loadingBackups || !backups.some(item => item.available)} onChange={event => { setBackupId(event.target.value); setFilter(value => ({ ...value, offset: 0 })); }}>
        {!backupId && <option value="">{loadingBackups ? 'Consultando…' : 'Nenhum backup concluído'}</option>}
        {backups.filter(item => item.available).map(item => <option key={item.id} value={item.id}>Importado em {moment(item.finished_at)} · {item.xml_occurrences.toLocaleString('pt-BR')} ocorrências XML</option>)}
      </select></div>
      {selected && <p className="real-help history-backup-help">Concluído em {moment(selected.finished_at)} (São Paulo). Arquivos idênticos aparecem uma vez; cada ocorrência original permanece registrada.{selected.issues > 0 ? ` Há ${selected.issues} pendência(s) de estrutura para revisão.` : ''}</p>}
      {!backupId && !loadingBackups && <div className="empty-state"><h2>{backups.some(item => !item.available) ? 'Importação em andamento' : 'Nenhum histórico disponível'}</h2><p>{backups.some(item => !item.available) ? 'Os documentos aparecerão após a conferência de todos os arquivos do backup.' : 'O histórico será exibido após a importação do backup do Origin.'}</p></div>}
      {backupId && <>
        <div className="native-list-toolbar"><div className="form-field"><label htmlFor="history-query">Pesquisar por chave de acesso ou protocolo</label><input type="search" id="history-query" maxLength={64} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Pesquisar por chave de acesso ou protocolo" /></div><button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar" disabled={loading}><Icon name="search" size={16} /></button></div>
        <AppliedChips chips={chips} onClear={clear} />
        <div className="real-result-status" aria-live="polite">{loading ? 'Consultando documentos…' : page ? `${page.total.toLocaleString('pt-BR')} arquivo(s) distintos` : 'Consulta sem resultado.'}</div>
        <div className="table-scroll" role="region" aria-label="Tabela de documentos fiscais" tabIndex={0} aria-busy={loading}><table className="data-table history-table"><thead><tr><th>Número</th><th>Modelo</th><th>Documento</th><th>Chave de acesso</th><th>Protocolo</th><th>Conferência</th><th>Arquivo</th></tr></thead><tbody>
          {page?.items.map(item => <tr key={item.id}>
            <td>{item.key?.length === 44 ? <>{noteNumber(item.key)}<small className="history-sub">Série {noteSeries(item.key)}</small></> : '—'}</td>
            <td>{item.model === '55' ? 'NF-e' : item.model === '65' ? 'NFC-e' : '—'}{item.environment === '2' && <small className="history-sub">Homologação</small>}</td>
            <td>{item.kind === 'event' ? item.event_type === '110111' ? 'Cancelamento' : 'Evento fiscal' : 'Nota / cupom'}</td>
            <td className="history-key">{item.key || '—'}</td><td className="history-protocol">{item.protocol || 'Ausente'}</td>
            <td><span className={badgeClass(item.issues.length ? 'Pendente' : 'Conferido')}>{item.issues.length ? 'Revisar estrutura' : 'Importado'}</span>{item.occurrences > 1 && <small className="history-sub">{item.occurrences} ocorrências no backup</small>}</td>
            <td><button type="button" className="text-button" disabled={!!downloading} aria-label={`Baixar XML ${item.kind === 'event' ? 'do evento' : 'da nota'} ${item.key?.slice(25, 34) || item.id.slice(0, 12)}`} onClick={() => void download(item)}>{downloading === item.id ? 'Baixando…' : 'Baixar XML'}</button></td>
          </tr>)}
        </tbody></table></div>
        {!loading && page?.items.length === 0 && <div className="empty-state"><h2>Nenhum documento encontrado</h2><p>Ajuste o modelo, o tipo de documento ou a pesquisa.</p></div>}
        <footer className="table-footer real-pagination history-pagination">{page ? <OriginPagination page={current} pages={pages} size={filter.limit} total={page.total} onPage={target => setFilter(value => ({ ...value, offset: Math.min(MAX_OFFSET, (target - 1) * value.limit) }))} /> : <span>0 documentos nesta página</span>}<label className="page-size">Por página<select value={filter.limit} onChange={event => setFilter(value => ({ ...value, limit: Number(event.target.value), offset: 0 }))}>{[25, 50, 100].map(limit => <option key={limit}>{limit}</option>)}</select></label></footer>
      </>}
      {message && <p className="real-alert" role="alert">{message}</p>}
    </NativeListLayout></form></section>
    <BackupPreservation controller={controller} onComplete={() => setRefresh(value => value + 1)} />
  </>;
}
