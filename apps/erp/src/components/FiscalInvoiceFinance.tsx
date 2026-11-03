import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { financeDate, financeMoney } from '../lib/real-finance-model';
import { useFinanceCommand } from '../lib/finance-command';
import { INVOICE_FINANCE_BLOCKED, boletoTitleIds, invoiceFinance, invoiceLabel, invoicePreview, invoicePreviewPath, reverseBlocked, type InvoiceFinance, type InvoicePreview } from '../lib/fiscal-invoice-finance';
import { Modal } from './Modal';
import { invoiceOrderTitles, type InvoiceOrderTitles } from '../lib/invoice-order-titles';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const failureText = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'A nota, o pedido de origem ou as contas mudaram. Feche e abra novamente para conferir.'
  : error.status === 400 ? 'A operação não foi aceita. Confira as parcelas da nota (a soma precisa ser o total), a categoria e a conta financeira.'
  : error.status === 403 ? 'Seu perfil ou suas permissões não lançam contas pela nota (administrador e financeiro; Sistema › Usuários › Permissões).' : error.status === 404 ? 'A nota não foi encontrada.' : 'Não foi possível concluir a operação. Tente novamente.'
  : error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
type Option = { id: string; name: string };
type Snapshot = { phase?: string; membership?: { user_id?: string; role?: string } | null } | null | undefined;
const ownerOf = (snapshot: Snapshot) => snapshot?.phase === 'ready' && snapshot.membership?.user_id ? `${snapshot.membership.user_id}:${snapshot.membership.role ?? ''}` : '';
const FINANCE_ROLES = ['admin', 'financeiro'];
const situation = (item: InvoiceFinance['titles'][number]) => item.cancelled ? 'Cancelada' : item.balance_cents === '0' ? 'Paga' : item.settled_cents !== '0' ? 'Parcial' : 'Em aberto';

/**
 * ⋮ Lançar contas / Estornar contas / Emitir boletos da nota fiscal do Brufap (SQL 247): prévia com as parcelas, a Categoria e o
 * Destino (conta financeira), Lançar contas com um comando idempotente ("Conferir resultado"), as contas lançadas com Estornar contas
 * e Emitir boletos (o Incluir Remessa da cobrança Itaú com as contas a receber da nota; a operação bancária continua desligada).
 */
/** Leva H (SQL 375): the contas the note references, lançadas by its pedido (or by the faturamento agrupado); the note never lança others. */
function OrderTitles({ controller, invoiceId }: { controller: AccessController; invoiceId: string }) {
  const [orders, setOrders] = useState<InvoiceOrderTitles['orders'] | null>(null);
  useEffect(() => {
    const request = new AbortController();
    void controller.finance(`/v1/financeiro/notas/${invoiceId}/contas-pedido`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setOrders(invoiceOrderTitles(value, invoiceId).orders); })
      .catch(() => { if (!request.signal.aborted) setOrders(null); });
    return () => request.abort();
  }, [controller, invoiceId]);
  if (!orders?.length) return null;
  return <div className="table-scroll" tabIndex={0} aria-label="Contas do pedido referenciadas pela nota"><table className="data-table"><thead><tr><th>Pedido</th><th>Parcela</th><th>Vencimento</th><th className="numeric">Valor</th><th>Situação</th></tr></thead>
    <tbody>{orders.flatMap(order => order.effect.titles.map(title => <tr key={title.id}><td>{order.effect.owner === 'grouped' ? `Faturamento agrupado do pedido nº ${order.number}` : `Pedido nº ${order.number}`}</td><td>{title.position}</td>
      <td>{financeDate(title.due_on)}</td><td className="numeric">{financeMoney(title.amount_cents)}</td><td><Link to={`/financeiro-empresa?${new URLSearchParams({ area: 'receivable', titulo: title.id })}`}>{title.cancelled ? 'Cancelada' : title.settled_cents === title.amount_cents ? 'Paga' : title.settled_cents !== '0' ? 'Parcial' : 'Em aberto'}</Link></td></tr>))}</tbody></table></div>;
}

export default function FiscalInvoiceFinance({ controller, invoiceId, onClose, onChanged }: { controller: AccessController; invoiceId: string; onClose: () => void; onChanged: () => void }) {
  const navigate = useNavigate();
  const owner = useRef(ownerOf(controller.getSnapshot?.() as Snapshot)), alive = () => ownerOf(controller.getSnapshot?.() as Snapshot) === owner.current;
  const role = (controller.getSnapshot?.() as Snapshot)?.membership?.role ?? '';
  const [reload, setReload] = useState(0), readKey = `${invoiceId}:${reload}`;
  const [read, setRead] = useState<{ key: string; value: InvoiceFinance | null; error: string }>({ key: '', value: null, error: '' }), finance = read.key === readKey ? read.value : null;
  const [options, setOptions] = useState<{ categories: Option[]; accounts: Option[] }>({ categories: [], accounts: [] });
  const [category, setCategory] = useState(''), [account, setAccount] = useState(''), [reason, setReason] = useState(''), [notice, setNotice] = useState('');
  const canPost = Boolean(finance && finance.writable && !finance.active_posting && !finance.blocked_reason && FINANCE_ROLES.includes(role));
  const previewKey = finance && canPost ? `${finance.invoice.id}:${finance.invoice.version}:${category}:${account}:${reload}` : '';
  const [preview, setPreview] = useState<{ key: string; value: InvoicePreview | null; error: string }>({ key: '', value: null, error: '' }), shown = preview.key === previewKey ? preview.value : null;
  const mayWrite = () => alive() && FINANCE_ROLES.includes((controller.getSnapshot?.() as Snapshot)?.membership?.role ?? '');
  const command = useFinanceCommand(next => controller.finance(next.path, { method: 'POST', body: { command_id: next.id, data: structuredClone(next.data) } } as never), mayWrite, failureText);
  const guard = useUnsavedChanges(Boolean(reason.trim()) || Boolean(category) || Boolean(account), command.busy || command.uncertain);
  useEffect(() => {
    const request = new AbortController();
    void controller.finance(`/v1/financeiro/notas/${invoiceId}/contas`, { signal: request.signal }).then(value => { if (!request.signal.aborted && alive()) setRead({ key: readKey, value: invoiceFinance(value, invoiceId), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure) && alive()) setRead({ key: readKey, value: null, error: failureText(failure) }); });
    return () => request.abort();
  }, [controller, readKey]);
  // Categoria (receitas or despesas of the kind of the note) and Destino (conta financeira), only when the contas may be lançadas.
  useEffect(() => {
    if (!finance || !canPost) return; const request = new AbortController(), kind = finance.invoice.kind;
    const page = (path: string) => controller.finance(path, { signal: request.signal }).then(value => {
      const items = (value as { items?: unknown }).items; return Array.isArray(items) ? items.filter((item): item is { id: string; name: string; active?: boolean; kind?: string } => typeof item?.id === 'string' && typeof item.name === 'string' && item.active !== false).map(item => ({ id: item.id, name: item.name })) : [];
    });
    void Promise.all([page(`/v1/financeiro/categories?limit=100&kind=${kind}`), page('/v1/financeiro/accounts?limit=100')]).then(([categories, accounts]) => { if (!request.signal.aborted && alive()) setOptions({ categories, accounts }); })
      .catch(() => { /* Without the lists the prévia keeps the padrão categoria and the conta of each forma. */ });
    return () => request.abort();
  }, [controller, finance?.invoice.id, canPost]);
  useEffect(() => {
    if (!previewKey || !finance) return; const request = new AbortController();
    void controller.finance(invoicePreviewPath(finance.invoice.id, finance.invoice.version, category, account), { signal: request.signal })
      .then(value => { if (!request.signal.aborted && alive()) setPreview({ key: previewKey, value: invoicePreview(value, finance.invoice.id, finance.invoice.version), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure) && alive()) setPreview({ key: previewKey, value: null, error: failureText(failure) }); });
    return () => request.abort();
  }, [controller, previewKey]);
  const done = (text: string) => () => { if (!alive()) return; setNotice(text); setReason(''); setCategory(''); setAccount(''); setReload(value => value + 1); onChanged(); };
  const postedText = finance?.invoice.kind === 'payable' ? 'Contas a pagar lançadas pela nota.' : 'Contas a receber lançadas pela nota.';
  const post = () => { if (!shown || !finance) return; const data = { invoice_id: finance.invoice.id, expected_version: finance.invoice.version, preview_hash: shown.preview_hash, category_id: category || null, account_id: account || null };
    void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/invoice_finance_post', data }), done(postedText)); };
  const reverse = () => { if (!finance?.active_posting) return; const text = reason.trim(); if (!command.uncertain && text.length < 3) { setNotice(''); return; }
    const data = { invoice_id: finance.invoice.id, posting_id: finance.active_posting.id, expected_version: finance.active_posting.version, titles: finance.titles.map(item => ({ id: item.id, version: item.version })), reason: text };
    void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/invoice_finance_reverse', data }), done('Contas da nota estornadas.')); };
  const close = () => { if (command.busy) return; guard.confirmLeave(onClose); };
  const boletos = finance ? boletoTitleIds(finance) : [], blockedReverse = finance ? reverseBlocked(finance) : null, writer = Boolean(finance?.writable) && FINANCE_ROLES.includes(role);
  const kindLabel = finance?.invoice.kind === 'payable' ? 'contas a pagar' : 'contas a receber';
  return <Modal title={finance ? `Contas da ${invoiceLabel(finance.invoice)}` : 'Contas da nota fiscal'} onClose={close} actions={<>
    {finance?.active_posting && writer && boletos.length > 0 && <button type="button" className="secondary-button" disabled={command.locked} onClick={() => guard.confirmLeave(() => navigate(`/cobranca-operacional?${new URLSearchParams({ titulos: boletos.join(',') })}`))}>Emitir boletos</button>}
    {finance?.active_posting && writer && <button type="button" className="danger-button" disabled={command.busy || Boolean(blockedReverse) || (!command.uncertain && reason.trim().length < 3)} onClick={reverse}>{command.uncertain ? 'Conferir resultado' : 'Estornar contas'}</button>}
    {canPost && <button type="button" className="primary-button" disabled={command.busy || (!shown && !command.uncertain)} onClick={() => command.uncertain ? void command.run(() => { throw new Error('Repita a operação.'); }, done(postedText)) : post()}>{command.busy ? 'Lançando…' : command.uncertain ? 'Conferir resultado' : 'Lançar contas'}</button>}
    <button type="button" className="secondary-button" disabled={command.busy} onClick={close}>Fechar</button></>}>
    {notice && <p className="real-success" role="status">{notice}</p>}{command.error && <p className="real-alert" role="alert">{command.error}</p>}
    {read.key === readKey && read.error ? <p className="real-alert" role="alert">{read.error} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>
      : !finance ? <p role="status">Conferindo as contas da nota…</p> : finance.active_posting ? <>
        <p>{finance.active_posting.direction === 'receivable' ? 'Contas a receber' : 'Contas a pagar'} lançadas pela nota em {financeDate(finance.active_posting.created_at.slice(0, 10))}{finance.active_posting.origin === 'automatic' ? ' (automação de Preferências › Notas Fiscais)' : ''}. Total {financeMoney(finance.active_posting.total_cents)}.</p>
        <table className="data-table finance-table"><thead><tr><th>Parcela</th><th>Vencimento</th><th className="numeric">Valor</th><th className="numeric">Saldo</th><th>Situação</th><th>Boleto</th></tr></thead>
          <tbody>{finance.titles.map(item => <tr key={item.id}><td><Link to={`/financeiro-empresa?${new URLSearchParams({ area: finance.invoice.kind, titulo: item.id })}`}>{item.position}/{finance.titles.length}</Link></td><td>{financeDate(item.due_on)}</td>
            <td className="numeric">{financeMoney(item.amount_cents)}</td><td className="numeric">{financeMoney(item.balance_cents)}</td><td>{situation(item)}</td><td>{item.cnab_linked ? 'Em remessa' : '—'}</td></tr>)}</tbody></table>
        {finance.invoice.status === 3 || finance.invoice.status === 10 ? <p className="real-alert" role="status">A nota foi cancelada ou denegada depois do lançamento: estorne as {kindLabel} da nota.</p> : null}
        {writer ? <>{blockedReverse && <p className="real-help">{blockedReverse}</p>}
          <div className="form-field"><label htmlFor="invoice-finance-reason">Motivo do estorno</label><textarea id="invoice-finance-reason" rows={2} maxLength={1000} disabled={command.locked || Boolean(blockedReverse)} value={reason} onChange={event => setReason(event.target.value)} /></div>
          {finance.invoice.kind === 'receivable' && <p className="real-help">Emitir boletos abre o Incluir Remessa da cobrança Itaú com as contas em aberto da nota (até 30). A remessa é gerada só com a aprovação da cobrança; nada é enviado ao banco pelo FAGOO.</p>}</>
          : <p className="real-help">Somente administrador e financeiro estornam as contas da nota.</p>}
      </> : finance.blocked_reason ? <><p className="real-alert" role="status">{INVOICE_FINANCE_BLOCKED[finance.blocked_reason] ?? 'Esta nota não lança contas agora.'}</p>
        {finance.orders_posted.length > 0 && <p className="real-help">Pedidos com contas: {finance.orders_posted.map(order => `nº ${order.number}`).join(', ')}.</p>}
        {finance.blocked_reason === 'erp_finance_invoice_order_posted' && <OrderTitles controller={controller} invoiceId={invoiceId} />}</>
      : !writer ? <p className="real-help">Somente administrador e financeiro lançam as contas pela nota. A nota tem {financeMoney(finance.invoice.total_cents)} a lançar.</p> : <>
        <p className="real-help">As {kindLabel} seguem as parcelas da nota (sem parcelas, uma à vista na emissão). Nada é baixado, enviado ao banco ou alterado na nota.</p>
        <div className="form-field"><label htmlFor="invoice-finance-category">Categoria</label><select id="invoice-finance-category" value={category} disabled={command.locked} onChange={event => setCategory(event.target.value)}>
          <option value="">{finance.invoice.kind === 'receivable' ? 'Categoria padrão de vendas' : 'Categoria padrão de compras'}</option>{options.categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        <div className="form-field"><label htmlFor="invoice-finance-account">Destino</label><select id="invoice-finance-account" value={account} disabled={command.locked} onChange={event => setAccount(event.target.value)}>
          <option value="">{finance.invoice.kind === 'receivable' ? 'Contas a Receber (conta da forma de pagamento)' : 'Contas a Pagar (conta da forma de pagamento)'}</option>{options.accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        {preview.key === previewKey && preview.error ? <p className="real-alert" role="alert">{preview.error}</p> : !shown ? <p role="status">Conferindo a prévia das contas…</p> : <>
          <table className="data-table finance-table"><thead><tr><th>Parcela</th><th>Vencimento</th><th className="numeric">Valor</th><th>Forma de pagamento</th><th>Conta financeira</th></tr></thead>
            <tbody>{shown.installments.map(item => <tr key={item.position}><td>{item.position}/{shown.installments.length}</td><td>{financeDate(item.due_on)}</td><td className="numeric">{financeMoney(item.amount_cents)}</td><td>{item.payment_method_name ?? '—'}</td><td>{item.account_name ?? '—'}</td></tr>)}</tbody></table>
          <p className="real-help">Total {financeMoney(shown.total_cents)} · Categoria: {shown.category_name ?? 'Sem categoria'}</p></>}
      </>}
  </Modal>;
}
