import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AccessController } from '../lib/real-access';
import { financeDate, financeMoney, todaySP } from '../lib/real-finance-model';
import { BORDERO_PAGE_SIZE, borderoApiPath, borderoPage, borderoPeriod, borderoTitle, type Bordero, type BorderoPage, type BorderoRoute } from '../lib/finance-bordero-route';
import { PRINT_PAGE_LIMIT } from '../lib/finance-print';
import type { CompanyEnvelope, CompanyRecord } from '../lib/company-model';
// 302: CPF for a company of Pessoa Física.
import { companyDocumentLabel } from '../lib/company-model';
import './document-print.css';
import './finance-print.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
type Read = { state: 'loading' | 'ready' | 'error'; items: Bordero[]; totals: BorderoPage['totals'] | null; message: string };

/**
 * "Imprimir" do painel de Gerenciar recebimentos / pagamentos: todos os borderôs do filtro aplicado (lidos página a
 * página, até 5.000), com a identificação da empresa e as Informações do filtro. Só leitura; nada é gravado.
 */
export default function FinanceBorderoPrint({ controller, route, onClose }: { controller: Pick<AccessController, 'finance' | 'company'>; route: BorderoRoute; onClose: () => void }) {
  const [company, setCompany] = useState<{ state: 'loading' | 'ready' | 'error'; record: CompanyRecord | null }>({ state: 'loading', record: null }), [companyRetry, setCompanyRetry] = useState(0);
  const [read, setRead] = useState<Read>({ state: 'loading', items: [], totals: null, message: '' }), [printError, setPrintError] = useState(false);
  const close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const [portal] = useState(() => { const node = globalThis.document?.createElement?.('div'); if (node) node.className = 'document-print-root'; return node ?? null; });
  const today = todaySP(), period = borderoPeriod(route, today), party = route.kind === 'receivable' ? 'Cliente' : 'Fornecedor';
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
    const request = new AbortController();
    void (async () => {
      const items: Bordero[] = []; let totals: BorderoPage['totals'] | null = null;
      for (let page = 1; page <= PRINT_PAGE_LIMIT; page++) {
        const value = borderoPage(await controller.finance(borderoApiPath({ ...route, page }, today), { signal: request.signal }), { ...route, page }, today);
        if (page === 1) { totals = value.totals; if (value.total > PRINT_PAGE_LIMIT * BORDERO_PAGE_SIZE) throw new Error(`O filtro tem ${value.total.toLocaleString('pt-BR')} borderôs. Ajuste os filtros para imprimir até ${(PRINT_PAGE_LIMIT * BORDERO_PAGE_SIZE).toLocaleString('pt-BR')} de cada vez.`); }
        items.push(...value.items);
        if (items.length >= value.total) break;
      }
      if (!request.signal.aborted) setRead({ state: 'ready', items, totals, message: '' });
    })().catch(failure => { if (!request.signal.aborted && !aborted(failure)) setRead({ state: 'error', items: [], totals: null, message: failure instanceof Error && failure.message.startsWith('O filtro') ? failure.message : 'Não foi possível ler todos os borderôs do filtro. Feche e tente imprimir novamente.' }); });
    return () => request.abort();
  }, [controller, route]);
  useEffect(() => {
    const body = globalThis.document?.body; if (!portal || !body) return;
    body.append(portal); body.classList.add('document-print-open'); close.current?.focus?.();
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); } };
    globalThis.document.addEventListener('keydown', keydown);
    return () => { globalThis.document.removeEventListener('keydown', keydown); body.classList.remove('document-print-open'); portal.remove(); };
  }, [portal]);
  const ready = company.state === 'ready' && read.state === 'ready', record = company.record;
  const content = <div className="document-print-dialog" role="dialog" aria-modal="true" aria-label="Prévia para impressão">
    <header className="document-print-controls"><div><h2>Prévia para impressão</h2><p>Borderôs do filtro aplicado na listagem, com as Informações do filtro.</p></div>
      <div><button type="button" className="secondary-button" ref={close} onClick={onClose}>Fechar prévia</button><button type="button" className="primary-button" disabled={!ready} onClick={() => { setPrintError(false); try { globalThis.window?.print(); } catch { setPrintError(true); } }}>Imprimir</button></div></header>
    {company.state === 'loading' && <p className="document-print-error" role="status">Consultando identificação da empresa…</p>}
    {company.state === 'error' && <p className="document-print-error" role="alert">Não foi possível conferir a identificação da empresa. <button type="button" onClick={() => setCompanyRetry(value => value + 1)}>Tentar novamente</button></p>}
    {read.state === 'loading' && <p className="document-print-error" role="status">Lendo os borderôs do filtro…</p>}
    {read.state === 'error' && <p className="document-print-error" role="alert">{read.message}</p>}
    {printError && <p className="document-print-error" role="alert">Não foi possível abrir a impressão. Confira as permissões do navegador e tente novamente.</p>}
    <div className="document-print-scroll" tabIndex={0} aria-label="Documento para impressão">{ready && <article className="commercial-sheet finance-listing" aria-label={borderoTitle(route.kind)}>
      <header className="commercial-heading"><div><h2>{borderoTitle(route.kind)}</h2>{period.from && <p>{financeDate(period.from)} a {financeDate(period.to)}</p>}</div><div className="commercial-identity"><span>{read.items.length} {read.items.length === 1 ? 'borderô' : 'borderôs'}</span></div></header>
      {record ? <section className="commercial-company"><strong>{record.data.legal_name}</strong><p>{companyDocumentLabel(record.data.cnpj)}: {record.data.cnpj}</p></section> : <p className="commercial-footnote">Identificação da empresa ainda não cadastrada.</p>}
      <table><thead><tr><th scope="col">Data</th><th scope="col">{party}</th><th scope="col">Histórico</th><th scope="col">Conta</th><th scope="col">Categoria</th><th scope="col" className="commercial-numeric">Valor</th></tr></thead>
        <tbody>{read.items.map(item => <tr key={item.id}><td>{financeDate(item.posted_on)}</td><td>{item.contact_name ?? `${item.contacts} ${route.kind === 'receivable' ? 'clientes' : 'fornecedores'}`}</td><td>{item.note ?? '—'}</td><td>{item.account_name}</td><td>{item.category_name ?? 'Sem categoria'}</td><td className="commercial-numeric">{financeMoney(item.totals.paid_cents)}</td></tr>)}</tbody></table>
      {read.totals && <dl className="finance-credit-party"><div><dt>Valor Total</dt><dd>{financeMoney(read.totals.paid_cents)}</dd></div><div><dt>Acréscimos</dt><dd>{financeMoney(read.totals.penalty_cents)}</dd></div>
        <div><dt>Descontos</dt><dd>{financeMoney(read.totals.discount_cents)}</dd></div><div><dt>Juros</dt><dd>{financeMoney(read.totals.interest_cents)}</dd></div><div><dt>Tarifas</dt><dd>{financeMoney(read.totals.fee_cents)}</dd></div></dl>}
    </article>}{read.state === 'ready' && !read.items.length && <p className="document-print-blocked">Nenhum borderô para imprimir.</p>}</div>
  </div>;
  return portal ? createPortal(content, portal) : content;
}
