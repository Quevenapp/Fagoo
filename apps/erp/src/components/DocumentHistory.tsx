import { useEffect, useRef, useState } from 'react';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import type { DocumentKind } from '../lib/real-documents-model';
import { HISTORY_TITLES, HISTORY_TYPES, historyDay, historyPath, historyPrice, historyQuantity, readHistory, type HistoryPage, type HistoryRequest } from '../lib/document-history-model';
import { Modal } from './Modal';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;

/**
 * Origin histories of the document forms (202610200169), read-only: "Últimos registros deste cliente" (abas Produtos e
 * Financeiro), "Últimas vendas deste item para este cliente" and, in the pedido de compra, "Últimas compras" of the product.
 */
export default function DocumentHistory({ controller, kind, contactId, request, onClose }: {
  controller: Controller; kind: DocumentKind; contactId: string | null; request: HistoryRequest; onClose: () => void;
}) {
  const [page, setPage] = useState<HistoryPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [tab, setTab] = useState<'products' | 'finance'>('products'), [draft, setDraft] = useState(''), [query, setQuery] = useState('');
  const [supplierOnly, setSupplierOnly] = useState(true);
  const actor = useRef(actorOf(controller));
  const contact = request.mode === 'purchase' ? (supplierOnly ? contactId : null) : contactId;
  useEffect(() => {
    const signal = new AbortController();
    setLoading(true); setError('');
    void Promise.resolve().then(() => controller.documents(historyPath(kind, request, contact, query), { signal: signal.signal })).then(value => {
      if (signal.signal.aborted) return;
      if (actorOf(controller) !== actor.current) { setPage(null); setError('A sessão mudou. Feche e abra o histórico novamente.'); setLoading(false); return; }
      setPage(readHistory(value, request)); setLoading(false);
    }).catch(failure => {
      if (signal.signal.aborted || aborted(failure)) return;
      setPage(null); setLoading(false);
      setError(failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não permite consultar este histórico.' : 'Não foi possível consultar o histórico. Tente novamente.');
    });
    return () => signal.abort();
  }, [controller, kind, request, contact, query]);
  const title = request.mode === 'client' ? HISTORY_TITLES.client : request.mode === 'item' ? HISTORY_TITLES.item : HISTORY_TITLES.purchase;
  const rows = page?.items ?? [];
  const products = request.mode === 'client'
    ? <table className="data-table"><thead><tr><th>Descrição</th><th>Valor unitário</th><th>Quantidade</th><th>Tipo</th><th>Número</th><th>Data</th></tr></thead>
      <tbody>{rows.map(row => <tr key={`${row.type}:${row.document_id}:${row.position}`}><td>{row.description}{row.code ? ` · ${row.code}` : ''}</td><td className="numeric">{historyPrice(row.unit_price)}</td>
        <td className="numeric">{historyQuantity(row.quantity)} {row.unit}</td><td>{HISTORY_TYPES[row.type]}</td><td>{row.number}</td><td>{historyDay(row.date)}</td></tr>)}</tbody></table>
    : request.mode === 'item'
      ? <table className="data-table"><thead><tr><th>Valor unitário</th><th>Quantidade</th><th>Data</th><th>Tipo</th><th>Número</th></tr></thead>
        <tbody>{rows.map(row => <tr key={`${row.type}:${row.document_id}:${row.position}`}><td className="numeric">{historyPrice(row.unit_price)}</td><td className="numeric">{historyQuantity(row.quantity)} {row.unit}</td>
          <td>{historyDay(row.date)}</td><td>{HISTORY_TYPES[row.type]}</td><td>{row.number}</td></tr>)}</tbody></table>
      : <table className="data-table"><thead><tr><th>Data</th><th>Número</th><th>Quantidade</th><th>Tipo</th><th>Valor unitário</th></tr></thead>
        <tbody>{rows.map(row => <tr key={`${row.type}:${row.document_id}:${row.position}`}><td>{historyDay(row.date)}</td><td>{row.number ?? '—'}</td><td className="numeric">{historyQuantity(row.quantity)} {row.unit}</td>
          <td>{HISTORY_TYPES[row.type]}</td><td className="numeric">{historyPrice(row.unit_price)}</td></tr>)}</tbody></table>;
  const finance = page?.finance;
  return <Modal title={title} onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
    {request.mode !== 'client' && <p className="real-help">{request.label}</p>}
    {request.mode === 'client' && <nav className="origin-list-tabs" role="tablist" aria-label="Histórico do cliente">
      <button type="button" role="tab" aria-selected={tab === 'products'} onClick={() => setTab('products')}>Produtos</button>
      <button type="button" role="tab" aria-selected={tab === 'finance'} onClick={() => setTab('finance')}>Financeiro</button></nav>}
    {request.mode === 'client' && tab === 'products' && <form className="document-history-search" onSubmit={event => { event.preventDefault(); setQuery(draft); }}>
      <label htmlFor="document-history-query">Pesquisa avançada</label><input id="document-history-query" type="search" maxLength={120} placeholder="Descrição ou código" value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="submit" className="secondary-button" disabled={loading}>Pesquisar</button></form>}
    {request.mode === 'purchase' && contactId && <label className="document-check"><input id="document-history-supplier" type="checkbox" checked={supplierOnly} onChange={event => setSupplierOnly(event.target.checked)} />Somente do fornecedor do pedido</label>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {loading && <p role="status">Consultando…</p>}
    {!loading && page && (tab === 'products' || request.mode !== 'client') && <>
      {rows.length ? products : <p className="real-help">Nenhum registro encontrado.</p>}
      {request.mode === 'client' ? page.has_more && <small className="real-help">Mostrando os 50 registros mais recentes. Use a pesquisa para encontrar outros.</small>
        : <small className="real-help">* São exibidos apenas os 10 últimos registros.</small>}
      {!page.invoices_included && <small className="real-help">As notas fiscais aparecem para os perfis administrador e fiscal.</small>}</>}
    {!loading && page && request.mode === 'client' && tab === 'finance' && finance && <>
      <dl className="document-total-summary"><div><dt>Contas a receber em aberto</dt><dd>{finance.open_count}</dd></div><div><dt>Saldo em aberto</dt><dd>{decimalMoney(finance.open_amount)}</dd></div>
        <div><dt>Vencido</dt><dd>{decimalMoney(finance.overdue_amount)}</dd></div></dl>
      {finance.titles.length ? <table className="data-table"><thead><tr><th>Vencimento</th><th>Descrição</th><th>Parcela</th><th>Valor</th><th>Em aberto</th></tr></thead>
        <tbody>{finance.titles.map(row => <tr key={row.id}><td>{historyDay(row.due_on)}</td><td>{row.description}</td><td>{row.installment}/{row.installments}</td><td className="numeric">{decimalMoney(row.amount)}</td><td className="numeric">{decimalMoney(row.open_amount)}</td></tr>)}</tbody></table>
        : <p className="real-help">Nenhuma conta a receber em aberto.</p>}
      {finance.open_count > finance.titles.length && <small className="real-help">Mostrando as 20 contas com vencimento mais próximo.</small>}</>}
    {/* 202610200239: Sistema › Usuários › Serviços › Ordem de Serviço "Histórico financeiro". */}
    {!loading && page && request.mode === 'client' && tab === 'finance' && page.finance_hidden && <p className="real-help">Seu usuário não tem a permissão “Histórico financeiro” das ordens de serviço (Sistema › Usuários › Permissões).</p>}
  </Modal>;
}
