import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AccessController } from '../lib/real-access';
import { financeDate, financeMoney, todaySP, type FinanceKind, type FinanceTitleRow } from '../lib/real-finance-model';
import { FINANCE_TITLE_PAGE_SIZE, financeTitlePage, financeTitlePageApiPath, type FinanceListRoute } from '../lib/finance-list-route';
import { titleSituation } from '../lib/finance-title-list';
import { CREDIT_LABEL, PRINT_NOTES_LIMIT, PRINT_PAGE_LIMIT, contactNotes, creditNumber, creditRows, dateInWords, listingGroups, moneyInWords, receiptGroups, receiptRows, receiptTitle, type CreditModel } from '../lib/finance-print';
import type { CompanyEnvelope, CompanyRecord } from '../lib/company-model';
// 302: CPF for a company of Pessoa Física.
import { companyDocumentLabel } from '../lib/company-model';
// 202610200262 (preferências lane): the logo of Empresa › Sua marca in the header of the recibo/comprovante.
import { companyLogoImage } from '../lib/company-logo-model';
import './document-print.css';
import './finance-print.css';

type Source = { kind: 'rows'; rows: readonly FinanceTitleRow[] } | { kind: 'route'; route: FinanceListRoute };
export type FinancePrint = { mode: 'receipts' | 'listing'; grouped?: boolean; /** Listagem: "Imprimir observação do contato". */ notes?: boolean; source: Source } | { mode: 'credit'; models: CreditModel[]; source: Source };
/** Sacado / emitente of a duplicata or nota promissória, read from the contact register. */
type Party = { name: string; document: string | null; address: string | null; place: string | null };
function party(value: unknown, id: string): Party {
  const v = value as { entity?: unknown; record?: Record<string, unknown> } | null, r = v?.record;
  if (v?.entity !== 'contacts' || !r || r.id !== id || typeof r.name !== 'string') throw new Error('PRINT_CONTACT_INVALID');
  const text = (key: string) => typeof r[key] === 'string' && (r[key] as string).trim() ? (r[key] as string).trim() : null;
  const street = [text('street'), text('number'), text('complement')].filter(Boolean).join(', ');
  return { name: r.name, document: text('document'), address: [street, text('district')].filter(Boolean).join(' · ') || null, place: [text('city'), text('state')].filter(Boolean).join(' / ') + (text('postal_code') ? ` · CEP ${text('postal_code')}` : '') || null };
}
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
function Company({ company, logo = null }: { company: CompanyRecord | null; logo?: string | null }) {
  if (!company) return <p className="commercial-footnote">Identificação da empresa ainda não cadastrada.</p>;
  const data = company.data;
  return <section className="commercial-company">{logo && <img className="finance-print-logo" src={logo} alt="Logo da empresa" />}<strong>{data.legal_name}</strong>{data.trade_name && <p>{data.trade_name}</p>}<p>{companyDocumentLabel(data.cnpj)}: {data.cnpj}</p><p>{[data.street, data.number, data.complement].filter(Boolean).join(', ')} · {data.district}</p><p>{data.city} / {data.state}</p></section>;
}

/**
 * Prévia de impressão do financeiro: recibos (receber) ou comprovantes de pagamento (pagar) agrupados por contato,
 * ou a listagem simples / agrupada por cliente ou fornecedor de todo o filtro. Só leitura; nada é gravado.
 */
export default function FinancePrintPreview({ controller, kind, print, receiptHeader = true, onClose }: {
  controller: Pick<AccessController, 'finance' | 'company'> & Partial<Pick<AccessController, 'catalog' | 'attachments'>>; kind: FinanceKind; print: FinancePrint;
  /** Preferências > Finanças "Exibir cabeçalho com logo e informações da empresa ao imprimir recibo". */
  receiptHeader?: boolean; onClose: () => void;
}) {
  const [company, setCompany] = useState<{ state: 'loading' | 'ready' | 'error'; record: CompanyRecord | null }>({ state: 'loading', record: null }), [companyRetry, setCompanyRetry] = useState(0);
  const [rows, setRows] = useState<{ state: 'loading' | 'ready' | 'error'; items: FinanceTitleRow[]; message: string }>(print.source.kind === 'rows' ? { state: 'ready', items: [...print.source.rows], message: '' } : { state: 'loading', items: [], message: '' });
  const [printError, setPrintError] = useState(false), close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const withNotes = print.mode === 'listing' && Boolean(print.notes);
  const [notes, setNotes] = useState<{ state: 'idle' | 'loading' | 'ready' | 'error'; items: Map<string, string>; message: string }>({ state: withNotes ? 'loading' : 'idle', items: new Map(), message: '' }), [notesRetry, setNotesRetry] = useState(0);
  const [parties, setParties] = useState<{ state: 'idle' | 'loading' | 'ready' | 'error'; items: Map<string, Party> }>({ state: print.mode === 'credit' ? 'loading' : 'idle', items: new Map() }), [partiesRetry, setPartiesRetry] = useState(0);
  // The logo goes with the company header of the recibos (the preference "Exibir cabeçalho com logo e informações da empresa").
  const withLogo = print.mode === 'receipts' && receiptHeader && typeof controller.attachments === 'function';
  const [logo, setLogo] = useState<{ state: 'idle' | 'loading' | 'ready' | 'error'; url: string | null }>({ state: withLogo ? 'loading' : 'idle', url: null }), [logoRetry, setLogoRetry] = useState(0);
  useEffect(() => {
    if (!withLogo || !controller.attachments) return; const request = new AbortController(); setLogo({ state: 'loading', url: null });
    void companyLogoImage(controller.attachments, request.signal).then(image => { if (!request.signal.aborted) setLogo({ state: 'ready', url: image?.url ?? null }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setLogo({ state: 'error', url: null }); });
    return () => request.abort();
  }, [controller, withLogo, logoRetry]);
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
    if (print.source.kind !== 'route') return; const route = print.source.route, request = new AbortController(), today = todaySP();
    void (async () => {
      const items: FinanceTitleRow[] = [];
      for (let page = 1; page <= PRINT_PAGE_LIMIT; page++) {
        const value = financeTitlePage(await controller.finance(financeTitlePageApiPath({ ...route, page }, today), { signal: request.signal }), { ...route, page }, today);
        items.push(...value.items);
        if (page === 1 && value.total > PRINT_PAGE_LIMIT * FINANCE_TITLE_PAGE_SIZE) throw new Error(`A listagem tem ${value.total.toLocaleString('pt-BR')} contas. Ajuste os filtros para imprimir até ${(PRINT_PAGE_LIMIT * FINANCE_TITLE_PAGE_SIZE).toLocaleString('pt-BR')} de cada vez.`);
        if (items.length >= value.total) break;
      }
      if (!request.signal.aborted) setRows({ state: 'ready', items, message: '' });
    })().catch(failure => { if (!request.signal.aborted && !aborted(failure)) setRows({ state: 'error', items: [], message: failure instanceof Error && failure.message.startsWith('A listagem') ? failure.message : 'Não foi possível ler todas as contas do filtro. Feche e tente imprimir novamente.' }); });
    return () => request.abort();
  }, [controller, print]);
  // Duplicata / nota promissória: the sacado (emitente of the promissória) comes from the contact register.
  const creditList = print.mode === 'credit' && rows.state === 'ready' ? creditRows(rows.items) : null;
  const contactKey = creditList ? [...new Set(creditList.rows.map(row => row.contact_id))].join(',') : '';
  useEffect(() => {
    if (print.mode !== 'credit' || !creditList) return;
    const request = new AbortController(), ids = contactKey ? contactKey.split(',') : []; setParties({ state: 'loading', items: new Map() });
    void (async () => {
      if (typeof controller.catalog !== 'function') throw new Error('PRINT_CONTACT_UNAVAILABLE');
      const items = new Map<string, Party>();
      for (const contact of ids) items.set(contact, party(await controller.catalog(`/v1/cadastros/contacts/${contact}`, { signal: request.signal }), contact));
      if (!request.signal.aborted) setParties({ state: 'ready', items });
    })().catch(failure => { if (!request.signal.aborted && !aborted(failure)) setParties({ state: 'error', items: new Map() }); });
    return () => request.abort();
  }, [controller, contactKey, rows.state, partiesRetry]);
  // Imprimir observação do contato: the Observações of each contato of the listagem, read from the contact register.
  const notesKey = withNotes && rows.state === 'ready' ? [...new Set(rows.items.map(row => row.contact_id))].join(',') : '';
  useEffect(() => {
    if (!withNotes || rows.state !== 'ready') return;
    const request = new AbortController(), ids = notesKey ? notesKey.split(',') : []; setNotes({ state: 'loading', items: new Map(), message: '' });
    void (async () => {
      if (ids.length > PRINT_NOTES_LIMIT) throw new Error(`A listagem tem ${ids.length.toLocaleString('pt-BR')} contatos. Para imprimir as observações, ajuste os filtros até ${PRINT_NOTES_LIMIT} contatos.`);
      if (typeof controller.catalog !== 'function') throw new Error('PRINT_CONTACT_UNAVAILABLE');
      const items = new Map<string, string>();
      for (const contact of ids) items.set(contact, contactNotes(await controller.catalog(`/v1/cadastros/contacts/${contact}`, { signal: request.signal }), contact));
      if (!request.signal.aborted) setNotes({ state: 'ready', items, message: '' });
    })().catch(failure => { if (!request.signal.aborted && !aborted(failure)) setNotes({ state: 'error', items: new Map(), message: failure instanceof Error && failure.message.startsWith('A listagem') ? failure.message : 'Não foi possível ler as observações dos contatos.' }); });
    return () => request.abort();
  }, [controller, notesKey, rows.state, notesRetry]);
  useEffect(() => {
    const body = globalThis.document?.body; if (!portal || !body) return;
    body.append(portal); body.classList.add('document-print-open'); close.current?.focus?.();
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); } };
    globalThis.document.addEventListener('keydown', keydown);
    return () => { globalThis.document.removeEventListener('keydown', keydown); body.classList.remove('document-print-open'); portal.remove(); };
  }, [portal]);
  // A recibo/comprovante never covers a cancelled conta, nor an unpaid conta a pagar.
  const receipts = print.mode === 'receipts' ? receiptRows(kind, rows.items) : null, printable = receipts ? receipts.rows : creditList ? creditList.rows : rows.items;
  const ready = company.state === 'ready' && rows.state === 'ready' && printable.length > 0 && (print.mode !== 'credit' || parties.state === 'ready') && (!withNotes || notes.state === 'ready') && (!withLogo || logo.state === 'ready');
  const noteOf = (contact: string) => withNotes ? notes.items.get(contact) ?? '' : '';
  const partyLabel = kind === 'receivable' ? 'Cliente' : 'Fornecedor', record = company.record, today = todaySP();
  const leftOut = receipts && receipts.skipped > 0 && rows.state === 'ready' ? `${receipts.skipped === 1 ? '1 conta ficou' : `${receipts.skipped} contas ficaram`} de fora: ${kind === 'receivable' ? 'contas canceladas não recebem recibo' : 'o comprovante é só de contas pagas e não canceladas'}.`
    : creditList && creditList.skipped > 0 ? `${creditList.skipped === 1 ? '1 conta ficou' : `${creditList.skipped} contas ficaram`} de fora: contas canceladas não têm duplicata nem nota promissória.` : '';
  const partyLines = (item: Party | undefined, name: string) => <dl className="finance-credit-party"><div><dt>Nome</dt><dd>{item?.name ?? name}</dd></div><div><dt>CPF/CNPJ</dt><dd>{item?.document ?? '______________________'}</dd></div>
    <div><dt>Endereço</dt><dd>{item?.address ?? '______________________________________'}</dd></div><div><dt>Município</dt><dd>{item?.place ?? '______________________'}</dd></div></dl>;
  const credit = print.mode === 'credit' && creditList ? creditList.rows.flatMap(row => print.models.map(model => {
    const sacado = parties.items.get(row.contact_id), number = creditNumber(row), legal = record?.data.legal_name ?? '';
    return model === 'duplicata' ? <article key={`${row.id}:${model}`} className="commercial-sheet finance-receipt finance-credit" aria-label={`Duplicata ${number} de ${row.contact_name}`}>
      <header className="commercial-heading"><div><h2>DUPLICATA</h2></div><div className="commercial-identity"><span>Data de emissão: {financeDate(row.issued_on)}</span></div></header>
      <Company company={record} />
      <table><thead><tr><th scope="col">Fatura nº</th><th scope="col" className="commercial-numeric">Valor da fatura</th><th scope="col">Duplicata nº</th><th scope="col" className="commercial-numeric">Valor</th><th scope="col">Vencimento</th></tr></thead>
        <tbody><tr><td>{row.source_reference || '—'}</td><td className="commercial-numeric">{financeMoney(row.amount_cents)}</td><td>{number}</td><td className="commercial-numeric">{financeMoney(row.amount_cents)}</td><td>{financeDate(row.due_on)}</td></tr></tbody></table>
      <h3 className="finance-credit-label">Sacado</h3>{partyLines(sacado, row.contact_name)}
      <p className="finance-receipt-text">Valor por extenso: <strong>{moneyInWords(row.amount_cents)}</strong>.</p>
      <p className="finance-receipt-text">Reconheço(emos) a exatidão desta DUPLICATA, na importância acima, que pagarei(emos) a <strong>{legal}</strong>, ou à sua ordem, na praça e no vencimento indicados.</p>
      <p className="finance-receipt-place">Em ____/____/________ (data do aceite)</p>
      <p className="finance-receipt-sign">______________________________________<br />Assinatura do sacado</p>
    </article> : <article key={`${row.id}:${model}`} className="commercial-sheet finance-receipt finance-credit" aria-label={`Nota promissória ${number} de ${row.contact_name}`}>
      <header className="commercial-heading"><div><h2>NOTA PROMISSÓRIA</h2><p>Nº {number}</p></div><div className="commercial-identity"><strong>{financeMoney(row.amount_cents)}</strong><span>Vencimento: {financeDate(row.due_on)}</span></div></header>
      <p className="finance-receipt-text">Ao(s) <strong>{dateInWords(row.due_on)}</strong> pagarei(emos) por esta única via de NOTA PROMISSÓRIA a <strong>{legal}</strong>{record?.data.cnpj ? `, ${companyDocumentLabel(record.data.cnpj)} ${record.data.cnpj}` : ''}, ou à sua ordem, a quantia de <strong>{moneyInWords(row.amount_cents)}</strong> em moeda corrente deste país.</p>
      <p className="finance-receipt-text">Pagável em {record?.data.city ? `${record.data.city} / ${record.data.state}` : '______________________'}.</p>
      <h3 className="finance-credit-label">Emitente</h3>{partyLines(sacado, row.contact_name)}
      <p className="finance-receipt-place">{record?.data.city ? `${record.data.city}, ` : ''}{financeDate(row.issued_on)}</p>
      <p className="finance-receipt-sign">______________________________________<br />Assinatura do emitente</p>
    </article>;
  })) : null;
  const sheets = credit ? credit : receipts ? receiptGroups(receipts.rows).map(group => <article key={group.contact_id} className="commercial-sheet finance-receipt" aria-label={`${receiptTitle(kind)} de ${group.contact_name}`}>
    <header className="commercial-heading"><div><h2>{receiptTitle(kind).toUpperCase()}</h2></div><div className="commercial-identity"><strong>{financeMoney(group.total_cents)}</strong></div></header>
    {receiptHeader && <Company company={record} logo={logo.url} />}
    <p className="finance-receipt-text">{kind === 'receivable' ? <>Recebemos de <strong>{group.contact_name}</strong></> : <>Pagamos a <strong>{group.contact_name}</strong></>} a importância de <strong>{financeMoney(group.total_cents)}</strong> ({moneyInWords(group.total_cents)}), referente a:</p>
    <table><thead><tr><th scope="col">Histórico</th><th scope="col">Parcela</th><th scope="col">Vencimento</th><th scope="col" className="commercial-numeric">Valor</th></tr></thead><tbody>{group.lines.map(line => <tr key={line.id}><td>{line.description}</td><td>{line.installment}</td><td>{financeDate(line.due_on)}</td><td className="commercial-numeric">{financeMoney(line.value_cents)}</td></tr>)}</tbody></table>
    {kind === 'payable' && group.settled_on && <p>Data do pagamento: {financeDate(group.settled_on)}</p>}
    <p className="finance-receipt-place">{record?.data.city ? `${record.data.city}, ` : ''}{financeDate(group.settled_on ?? today)}</p>
    <p className="finance-receipt-sign">______________________________________<br />{kind === 'receivable' ? record?.data.legal_name ?? 'Assinatura' : group.contact_name}</p>
  </article>) : (() => {
    const listing = listingGroups(rows.items, print.mode === 'listing' && Boolean(print.grouped)), grouped = print.mode === 'listing' && Boolean(print.grouped);
    return [<article key="listing" className="commercial-sheet finance-listing" aria-label="Listagem de contas">
      <header className="commercial-heading"><div><h2>{kind === 'receivable' ? 'Contas a receber' : 'Contas a pagar'}{grouped ? ` agrupadas por ${partyLabel.toLowerCase()}` : ''}</h2></div><div className="commercial-identity"><span>{listing.count} {listing.count === 1 ? 'conta' : 'contas'}</span></div></header>
      <Company company={record} />
      {listing.groups.map((item, index) => <section key={item.name ?? index}>
        {item.name && <h3>{partyLabel}: {item.name}</h3>}
        {item.name && noteOf(item.rows[0]!.contact_id) && <p className="finance-listing-note">Observações: {noteOf(item.rows[0]!.contact_id)}</p>}
        <table><thead><tr>{!grouped && <th scope="col">{partyLabel}</th>}<th scope="col">Histórico</th><th scope="col">Vencimento</th><th scope="col" className="commercial-numeric">Valor</th><th scope="col" className="commercial-numeric">Saldo</th><th scope="col">Situação</th></tr></thead>
          <tbody>{item.rows.flatMap(row => [<tr key={row.id}>{!grouped && <td>{row.contact_name}</td>}<td>{row.installments > 1 ? `${row.description} ${row.installment}/${row.installments}` : row.description}</td><td>{financeDate(row.due_on)}</td><td className="commercial-numeric">{financeMoney(row.amount_cents)}</td><td className="commercial-numeric">{financeMoney(row.cancelled ? '0' : row.balance_cents)}</td><td>{titleSituation(row, today).label}</td></tr>,
            ...(!grouped && noteOf(row.contact_id) ? [<tr key={`${row.id}:note`} className="finance-listing-note"><td colSpan={6}>Observações: {noteOf(row.contact_id)}</td></tr>] : [])])}
            {grouped && <tr className="finance-listing-subtotal"><th scope="row" colSpan={2}>Subtotal</th><td className="commercial-numeric">{financeMoney(item.amount_cents)}</td><td className="commercial-numeric">{financeMoney(item.balance_cents)}</td><td /></tr>}</tbody></table>
      </section>)}
      <p className="finance-listing-total"><strong>Total: {financeMoney(listing.amount_cents)} · Saldo em aberto: {financeMoney(listing.balance_cents)}</strong></p>
    </article>];
  })();
  const content = <div className="document-print-dialog" role="dialog" aria-modal="true" aria-label="Prévia para impressão">
    <header className="document-print-controls"><div><h2>Prévia para impressão</h2><p>{print.mode === 'receipts' ? `${receiptTitle(kind)}s agrupados por contato${receiptHeader ? ', com a identificação atual da empresa' : ''}.` : print.mode === 'credit' ? `${print.models.map(model => CREDIT_LABEL[model]).join(' e ')} das contas escolhidas, com a identificação atual da empresa e o cadastro do contato.` : `Contas do filtro aplicado na listagem${withNotes ? ', com as observações dos contatos' : ''}.`}</p></div>
      <div><button type="button" className="secondary-button" ref={close} onClick={onClose}>Fechar prévia</button><button type="button" className="primary-button" disabled={!ready} onClick={() => { setPrintError(false); try { globalThis.window?.print(); } catch { setPrintError(true); } }}>Imprimir</button></div></header>
    {company.state === 'loading' && <p className="document-print-error" role="status">Consultando identificação da empresa…</p>}
    {company.state === 'error' && <p className="document-print-error" role="alert">Não foi possível conferir a identificação da empresa. <button type="button" onClick={() => setCompanyRetry(value => value + 1)}>Tentar novamente</button></p>}
    {withLogo && logo.state === 'loading' && <p className="document-print-error" role="status">Carregando o logo da empresa…</p>}
    {withLogo && logo.state === 'error' && <p className="document-print-error" role="alert">Não foi possível carregar o logo da empresa. <button type="button" onClick={() => setLogoRetry(value => value + 1)}>Tentar novamente</button> <button type="button" onClick={() => setLogo({ state: 'ready', url: null })}>Imprimir sem o logo</button></p>}
    {rows.state === 'loading' && <p className="document-print-error" role="status">Lendo as contas do filtro…</p>}
    {withNotes && notes.state === 'loading' && rows.state === 'ready' && <p className="document-print-error" role="status">Lendo as observações dos contatos…</p>}
    {withNotes && notes.state === 'error' && <p className="document-print-error" role="alert">{notes.message} <button type="button" onClick={() => setNotesRetry(value => value + 1)}>Tentar novamente</button></p>}
    {print.mode === 'credit' && parties.state === 'loading' && rows.state === 'ready' && <p className="document-print-error" role="status">Consultando o cadastro dos contatos…</p>}
    {print.mode === 'credit' && parties.state === 'error' && <p className="document-print-error" role="alert">Não foi possível ler o cadastro dos contatos. <button type="button" onClick={() => setPartiesRetry(value => value + 1)}>Tentar novamente</button></p>}
    {rows.state === 'error' && <p className="document-print-error" role="alert">{rows.message}</p>}
    {printError && <p className="document-print-error" role="alert">Não foi possível abrir a impressão. Confira as permissões do navegador e tente novamente.</p>}
    {leftOut && <p className="document-print-error" role="status">{leftOut}</p>}
    <div className="document-print-scroll" tabIndex={0} aria-label="Documento para impressão">{ready ? sheets : rows.state === 'ready' && !printable.length ? <p className="document-print-blocked">Nenhuma conta para imprimir.</p> : null}</div>
  </div>;
  return portal ? createPortal(content, portal) : content;
}
