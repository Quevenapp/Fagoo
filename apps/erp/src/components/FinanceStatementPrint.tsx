import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AccessController } from '../lib/real-access';
import { financeDate } from '../lib/real-finance-model';
import { STATEMENT_PRINT_PAGES, lineHistory, signedMoney, statementApiPath, statementPage, statementPrintPage, statementRows, type StatementPage, type StatementRoute } from '../lib/finance-statement-model';
import type { CompanyEnvelope, CompanyRecord } from '../lib/company-model';
// 302: CPF for a company of Pessoa Física.
import { companyDocumentLabel } from '../lib/company-model';
import './document-print.css';
import './finance-print.css';

const PAGE = 100;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const TAB_LABEL = { movimentacoes: 'Movimentações', entradas: 'Entradas', saidas: 'Saídas' } as const;

/**
 * Imprimir saldos de Caixas e bancos (Origin): todo o período do filtro aplicado, com o Saldo anterior, o saldo de cada dia
 * e o resumo (Saldo inicial, Entradas, Saídas e Saldo final). Só leitura; nada é gravado.
 */
export default function FinanceStatementPrint({ controller, route, accountName, onClose }: {
  controller: Pick<AccessController, 'finance' | 'company'>; route: StatementRoute; accountName: string; onClose: () => void;
}) {
  const [company, setCompany] = useState<{ state: 'loading' | 'ready' | 'error'; record: CompanyRecord | null }>({ state: 'loading', record: null }), [companyRetry, setCompanyRetry] = useState(0);
  const [statement, setStatement] = useState<{ state: 'loading' | 'ready' | 'error'; page: StatementPage | null; message: string }>({ state: 'loading', page: null, message: '' }), [retry, setRetry] = useState(0);
  const [printError, setPrintError] = useState(false), close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  // The parent rebuilds the route on each render: the reading restarts only when the filter (its API path) changes.
  const routeRef = useRef(route); routeRef.current = route; const filterKey = statementApiPath(route, PAGE, 1);
  const [portal] = useState(() => { const node = globalThis.document?.createElement?.('div'); if (node) node.className = 'document-print-root'; return node ?? null; });
  useEffect(() => {
    const request = new AbortController(); setCompany({ state: 'loading', record: null });
    void controller.company('/v1/empresa/identidade', { signal: request.signal }).then(value => {
      const response = value as CompanyEnvelope<CompanyRecord>;
      if (!response || response.section !== 'identity' || response.data_mode !== 'erp_native' || response.record === undefined || (response.record !== null && (!Number.isInteger(response.record.version) || !response.record.data))) throw new Error('PRINT_COMPANY_RESPONSE_INVALID');
      if (!request.signal.aborted) setCompany({ state: 'ready', record: response.record });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setCompany({ state: 'error', record: null }); });
    return () => request.abort();
  }, [controller, companyRetry]);
  useEffect(() => {
    const request = new AbortController(), route = routeRef.current; setStatement({ state: 'loading', page: null, message: '' });
    void (async () => {
      const pages: StatementPage[] = [];
      for (let number = 1; number <= STATEMENT_PRINT_PAGES; number++) {
        const value = statementPage(await controller.finance(statementApiPath(route, PAGE, number), { signal: request.signal }), route, number, PAGE);
        if (number === 1 && value.total > STATEMENT_PRINT_PAGES * PAGE) throw new Error(`O extrato tem ${value.total.toLocaleString('pt-BR')} lançamentos no período. Ajuste o período ou os filtros para imprimir até ${(STATEMENT_PRINT_PAGES * PAGE).toLocaleString('pt-BR')} de cada vez.`);
        pages.push(value);
        if (pages.reduce((sum, page) => sum + page.items.length, 0) >= value.total || !value.items.length) break;
      }
      const merged = statementPrintPage(pages);
      if (!request.signal.aborted) setStatement({ state: 'ready', page: merged, message: '' });
    })().catch(failure => { if (!request.signal.aborted && !aborted(failure)) setStatement({ state: 'error', page: null, message: failure instanceof Error && /^O extrato (tem|mudou)/.test(failure.message) ? failure.message : 'Não foi possível ler todo o extrato do período.' }); });
    return () => request.abort();
  }, [controller, filterKey, retry]);
  useEffect(() => {
    const body = globalThis.document?.body; if (!portal || !body) return;
    body.append(portal); body.classList.add('document-print-open'); close.current?.focus?.();
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); } };
    globalThis.document.addEventListener('keydown', keydown);
    return () => { globalThis.document.removeEventListener('keydown', keydown); body.classList.remove('document-print-open'); portal.remove(); };
  }, [portal]);
  const page = statement.page, deleted = route.situacao === 'excluidos', ready = company.state === 'ready' && statement.state === 'ready' && page !== null;
  const record = company.record, rows = page ? statementRows(page, route, 1) : [];
  const sheet = ready && page ? <article className="commercial-sheet finance-listing" aria-label="Extrato para impressão">
    <header className="commercial-heading"><div><h2>Extrato · {accountName}</h2><p>Período: {financeDate(route.from)} a {financeDate(route.to)} · {TAB_LABEL[route.aba]}{deleted ? ' · Excluídos' : ''}</p></div><div className="commercial-identity"><span>{page.total} {page.total === 1 ? 'lançamento' : 'lançamentos'}</span></div></header>
    {record ? <section className="commercial-company"><strong>{record.data.legal_name}</strong><p>{companyDocumentLabel(record.data.cnpj)}: {record.data.cnpj}</p></section> : <p className="commercial-footnote">Identificação da empresa ainda não cadastrada.</p>}
    {!deleted && <dl className="finance-credit-party">{([['Saldo inicial', page.summary.previous_cents], ['Entradas', page.summary.in_cents], ['Saídas', page.summary.out_cents === '0' ? '0' : `-${page.summary.out_cents}`], ['Saldo final', page.summary.closing_cents]] as const).map(([label, cents]) => <div key={label}><dt>{label}</dt><dd>{signedMoney(cents)}</dd></div>)}</dl>}
    <table><thead><tr><th scope="col">Data</th>{!route.conta && <th scope="col">Conta financeira</th>}<th scope="col">Categoria</th><th scope="col">Histórico</th><th scope="col">Cliente/Fornecedor</th><th scope="col" className="commercial-numeric">Valor</th></tr></thead>
      <tbody>{rows.map(row => row.type === 'balance' ? <tr key={row.key} className="finance-listing-subtotal"><th scope="row" colSpan={route.conta ? 4 : 5}>{row.label}</th><td className="commercial-numeric">{signedMoney(row.cents)}</td></tr>
        : <tr key={row.line.line_id}><td>{financeDate(row.line.posted_on)}</td>{!route.conta && <td>{row.line.account_name}</td>}<td>{row.line.category_name ?? (row.line.line_kind === 'opening' ? '—' : 'Sem categoria')}</td><td>{lineHistory(row.line)}</td><td>{row.line.contact_name ?? '—'}</td><td className="commercial-numeric">{signedMoney(row.line.amount_cents)}</td></tr>)}</tbody></table>
    {!deleted && <p className="finance-listing-total"><strong>Saldo atual {route.conta ? 'da conta' : 'de todas as contas'}: {signedMoney(page.summary.current_cents)}</strong></p>}
  </article> : null;
  const content = <div className="document-print-dialog" role="dialog" aria-modal="true" aria-label="Prévia para impressão">
    <header className="document-print-controls"><div><h2>Prévia para impressão</h2><p>Extrato de todo o período do filtro aplicado, com os saldos de cada dia.</p></div>
      <div><button type="button" className="secondary-button" ref={close} onClick={onClose}>Fechar prévia</button><button type="button" className="primary-button" disabled={!ready} onClick={() => { setPrintError(false); try { globalThis.window?.print(); } catch { setPrintError(true); } }}>Imprimir</button></div></header>
    {company.state === 'loading' && <p className="document-print-error" role="status">Consultando identificação da empresa…</p>}
    {company.state === 'error' && <p className="document-print-error" role="alert">Não foi possível conferir a identificação da empresa. <button type="button" onClick={() => setCompanyRetry(value => value + 1)}>Tentar novamente</button></p>}
    {statement.state === 'loading' && <p className="document-print-error" role="status">Lendo o extrato do período…</p>}
    {statement.state === 'error' && <p className="document-print-error" role="alert">{statement.message} <button type="button" onClick={() => setRetry(value => value + 1)}>Tentar novamente</button></p>}
    {printError && <p className="document-print-error" role="alert">Não foi possível abrir a impressão. Confira as permissões do navegador e tente novamente.</p>}
    <div className="document-print-scroll" tabIndex={0} aria-label="Documento para impressão">{sheet}</div>
  </div>;
  return portal ? createPortal(content, portal) : content;
}
