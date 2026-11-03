import { Link } from 'react-router-dom';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeDate, financeMoney, type FinanceKind } from '../lib/real-finance-model';
import { openTitles, type OpenTitles } from '../lib/finance-open-titles';
import './real-finance.css';

const noSubscription = () => () => {}, noSnapshot = () => null;
// Contas a receber (ou a pagar) em aberto do contato no pedido (SQL 172): Preferências > Vendas "Permite a visualização das
// contas a receber em aberto nos pedidos/notas fiscais" e Suprimentos "... a pagar ...". Somente leitura; o servidor decide
// quem lê (o financeiro sempre, os perfis do pedido só com a preferência ligada). Uma resposta de outro contato é ignorada, e
// a troca de sessão ou de perfil esconde o que foi lido antes e lê de novo.
export default function FinanceContactOpenTitles({ controller, contactId, kind }: { controller: AccessController; contactId: string; kind: FinanceKind }) {
  const session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const key = `${contactId}:${kind}:${session?.membership?.user_id ?? ''}:${session?.membership?.role ?? ''}:${session?.phase ?? ''}`;
  const [state, setState] = useState<{ key: string; value: OpenTitles | null; error: string; hidden: boolean }>({ key: '', value: null, error: '', hidden: false });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(contactId)) return; const request = new AbortController();
    void controller.finance(`/v1/financeiro/contato-em-aberto?${new URLSearchParams({ contact: contactId, kind })}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setState({ key, value: openTitles(value, contactId, kind), error: '', hidden: false }); })
      .catch(failure => { if (request.signal.aborted || (failure instanceof DOMException && failure.name === 'AbortError')) return; setState({ key, value: null, error: failure instanceof AccessError && failure.status === 403 ? '' : 'Não foi possível consultar as contas em aberto do contato.', hidden: failure instanceof AccessError && [403, 404].includes(failure.status) }); });
    return () => request.abort();
  }, [controller, key]);
  const current = state.key === key ? state : null;
  if (!current || current.hidden) return null;
  const receivable = kind === 'receivable', role = session?.membership?.role ?? '', finance = ['admin', 'financeiro', 'consulta'].includes(role);
  const label = receivable ? 'Contas a receber em aberto do cliente' : 'Contas a pagar em aberto do fornecedor';
  if (current.error) return <section className="document-section finance-open-titles" aria-label={label}><p className="real-alert" role="alert">{current.error}</p></section>;
  const value = current.value!;
  return <section className="document-section finance-open-titles" aria-label={label}>
    <h3>{label}</h3>
    {!value.total ? <p className="real-help">Nenhuma conta em aberto.</p> : <>
      <p>{value.total === 1 ? '1 conta' : `${value.total} contas`} em aberto · {financeMoney(value.balance_cents)}{value.overdue ? <strong className="finance-negative"> · {value.overdue === 1 ? '1 atrasada' : `${value.overdue} atrasadas`} ({financeMoney(value.overdue_cents)})</strong> : null}
        {' '}<button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(previous => !previous)}>{open ? 'Ocultar' : 'Ver contas'}</button></p>
      {open && <div className="table-scroll"><table className="data-table finance-table"><thead><tr><th>Vencimento</th><th>Histórico</th><th className="numeric">Saldo</th></tr></thead>
        <tbody>{value.items.map(item => <tr key={item.id}><td className={item.overdue ? 'finance-negative' : undefined}>{financeDate(item.due_on)}</td><td>{finance ? <Link to={`/financeiro-empresa?area=${kind}&titulo=${item.id}`}>{item.description}</Link> : item.description}</td><td className="numeric">{financeMoney(item.balance_cents)}</td></tr>)}</tbody></table>
        {value.total > value.items.length && <p className="real-help">Mostrando as {value.items.length} primeiras pelo vencimento; o total considera todas.</p>}</div>}
    </>}
  </section>;
}
