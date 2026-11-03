import { useEffect, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { eventRecord, type EventRecord } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { FISCAL_BASE } from '../lib/fiscal-invoice-list-model';
import { AppliedChips, OriginListHeader, OriginPagination, PeriodPicker, RowMenu, ToolButton } from './OriginList';
import { FiscalEventsPrint } from './FiscalInvoicePrint';
import { Modal } from './Modal';
import { correctionEventXml, inutilizationXml } from '../../../../packages/fiscal-xml/src/events.mjs';
import { numberingCompany } from '../lib/fiscal-numbering-model';
import { saveFile } from '../lib/fiscal-invoice-xml';
import { Icon } from './Icon';
import './fiscal-invoices.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const when = (value: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(Date.parse(value));
const TITLES = { inutilization: 'Consulta de inutilizações de NF-es', correction: 'Consulta de correções de NF-es' } as const;
const saoPauloYear = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: '2-digit' }).format(at);

/** Consultas de inutilizações e de cartas de correção registradas no Brufap (homologação, aguardando transmissão). */
export default function FiscalEventList({ controller, kind }: { controller: AccessController; kind: 'inutilization' | 'correction' }) {
  const [query, setQuery] = useState(''), [applied, setApplied] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState(''), [page, setPage] = useState(1), [reload, setReload] = useState(0);
  const [items, setItems] = useState<EventRecord[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState(''), [menu, setMenu] = useState<string | null>(null), [printing, setPrinting] = useState(false);
  const [xml, setXml] = useState<{ title: string; name: string; text: string } | null>(null), [xmlError, setXmlError] = useState('');
  // "Gerar XML (suporte)": the unsigned homologation XML of the request, built in the browser; nothing is signed or transmitted.
  const showXml = async (event: EventRecord) => {
    setMenu(null); setXmlError('');
    try {
      const company = numberingCompany(await controller.company('/v1/empresa/identidade', {}));
      if (!company) { setXmlError('Informe o CNPJ da empresa em Dados da empresa para gerar o XML.'); return; }
      const at = new Date(event.requested_at), year = saoPauloYear(at);
      const text = event.kind === 'inutilization'
        ? inutilizationXml({ cnpj: company.cnpj, model: event.model, series: event.series, from: event.number_from, to: event.number_to, justification: event.text, year, environment: event.environment })
        : correctionEventXml({ key: event.access_key ?? '', cnpj: company.cnpj, text: event.text, sequence: event.sequence ?? 1, at, environment: event.environment });
      setXml({ title: event.kind === 'inutilization' ? 'XML do pedido de inutilização' : `XML da carta de correção ${event.sequence}`, name: `${event.kind === 'inutilization' ? 'inutNFe' : 'envEvento-110110'}-${event.id}.xml`, text });
    } catch { setXmlError('Não foi possível gerar o XML deste pedido.'); }
  };
  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError('');
    const params = new URLSearchParams({ kind, page: String(page) });
    if (applied) params.set('q', applied); if (from) params.set('date_from', from); if (to) params.set('date_to', to);
    void Promise.resolve().then(() => controller.fiscalInvoices(`${FISCAL_BASE}/eventos?${params}`, { signal: request.signal })).then(value => {
      if (request.signal.aborted) return;
      const v = value as { items: unknown[]; total_count: number; page: number; kind: string };
      if (!Array.isArray(v?.items) || v.kind !== kind || v.page !== page || !Number.isInteger(v.total_count)) throw new AccessError(502);
      const list = v.items.map(eventRecord); if (list.some(e => e.kind !== kind)) throw new AccessError(502);
      setItems(list); setTotal(v.total_count); setLoading(false);
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setLoading(false); setError(problem instanceof AccessError && problem.status === 403 ? 'Somente administrador e fiscal consultam os eventos fiscais do FAGOO.' : 'Não foi possível carregar a consulta.'); } });
    return () => request.abort();
  }, [controller, kind, applied, from, to, page, reload]);
  const chips = [...(applied ? [{ label: `Pesquisa: ${applied}`, onRemove: () => { setApplied(''); setQuery(''); } }] : []), ...(from || to ? [{ label: 'Período: Período customizado', onRemove: () => { setFrom(''); setTo(''); } }] : [])];
  return <section className="fiscal-events">
    <OriginListHeader title={TITLES[kind]} />
    <p className="real-notice">Pedidos registrados no FAGOO em homologação. A transmissão à SEFAZ ainda não está disponível; por isso não há número de protocolo. As inutilizações e correções feitas no Origin continuam consultáveis no Origin.</p>
    <form className="native-list-toolbar" onSubmit={event => { event.preventDefault(); setApplied(query.trim()); setPage(1); }}>
      <div className="form-field"><label htmlFor="events-search" className="sr-only">Pesquisar</label><input id="events-search" type="search" maxLength={120} placeholder="Pesquisar" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <button type="submit" className="secondary-button" aria-label="Pesquisar"><Icon name="search" size={16} /></button>
      <PeriodPicker from={from} to={to} today={today()} onApply={range => { setFrom(range.from); setTo(range.to); setPage(1); }} />
      {kind === 'correction' && <ToolButton icon="print" title="Imprimir lista de cartas de correção" disabled={!items.length} onClick={() => setPrinting(true)} />}
    </form>
    <AppliedChips chips={chips} onClear={() => { setApplied(''); setQuery(''); setFrom(''); setTo(''); setPage(1); }} />
    <div className="origin-list-controls"><button type="button" className="origin-refresh" title="Recarregar" aria-label="Recarregar" onClick={() => setReload(n => n + 1)}><Icon name="rotate-right" size={12} /></button></div>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {xmlError && <p className="real-alert" role="alert">{xmlError}</p>}
    <div className="real-result-status" role="status">{loading ? 'Carregando…' : `${total} registro(s)`}</div>
    {items.length > 0 && (kind === 'inutilization'
      ? <table className="data-table origin-table"><thead><tr><th>Data/Hora</th><th>Número do protocolo</th><th>Modelo</th><th>Série</th><th>Número inicial</th><th>Número final</th><th>Justificativa</th><th>Situação</th><th className="row-actions"><span className="sr-only">Ações</span></th></tr></thead>
        <tbody>{items.map(e => <tr key={e.id}><td>{when(e.requested_at)}</td><td>—</td><td>{e.model}</td><td>{e.series}</td><td>{e.number_from}</td><td>{e.number_to}</td><td>{e.text}</td><td><span className="status-badge status-waiting">Aguardando transmissão</span></td>
          <td className="row-actions"><RowMenu label={`inutilização ${e.number_from}`} items={[{ label: 'Gerar XML (suporte)', onClick: () => void showXml(e) }]} open={menu === e.id} onToggle={() => setMenu(v => v === e.id ? null : e.id)} /></td></tr>)}</tbody></table>
      : <table className="data-table origin-table"><thead><tr><th>Série</th><th>Número</th><th>Correção</th><th>Data</th><th>Situação</th><th className="row-actions"><span className="sr-only">Ações</span></th></tr></thead>
        <tbody>{items.map(e => <tr key={e.id}><td>{e.series}</td><td>{String(e.number_from).padStart(6, '0')}</td><td className="fiscal-pre">{e.text}</td><td>{when(e.requested_at)}</td><td><span className="status-badge status-waiting">Aguardando transmissão</span> · sequência {e.sequence}</td>
          <td className="row-actions"><RowMenu label={`carta ${e.sequence}`} items={[{ label: 'Atualizar protocolo', disabled: true, title: 'O protocolo existe só depois da transmissão, que ainda não está disponível no FAGOO.' }, { label: 'Gerar XML (suporte)', onClick: () => void showXml(e) }]} open={menu === e.id} onToggle={() => setMenu(v => v === e.id ? null : e.id)} /></td></tr>)}</tbody></table>)}
    {!loading && !items.length && !error && <div className="empty-state"><h2>Nenhum registro encontrado</h2></div>}
    {total > 100 && <OriginPagination page={page} pages={Math.ceil(total / 100)} size={100} total={total} onPage={setPage} />}
    {printing && <FiscalEventsPrint title={TITLES[kind]} events={items} onClose={() => setPrinting(false)} />}
    {xml && <Modal title={xml.title} onClose={() => setXml(null)} actions={<><button type="button" className="secondary-button" onClick={() => saveFile(xml.name, xml.text, 'application/xml')}>Baixar XML</button>
      <button type="button" className="secondary-button" onClick={() => setXml(null)}>Fechar</button></>}>
      <p className="real-notice">XML de homologação, sem assinatura e não transmitido: serve para conferência e suporte.</p><pre className="fiscal-xml-view" tabIndex={0}>{xml.text}</pre></Modal>}
  </section>;
}
