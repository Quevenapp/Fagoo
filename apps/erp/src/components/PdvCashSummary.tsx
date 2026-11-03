import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { dateTimeSP, money, pdvFailure, pdvSalesPage, pdvSummary, SALE_STATES, type PdvSaleSummary, type PdvSummary } from '../lib/pdv-model';
import { Modal } from './Modal';

// Financeiro › Controle de caixa (migração 173) com as vendas da Frente de caixa (202610200206): Total registrado por forma de
// pagamento, "Ver vendas" e Movimentos dos Grupos de Produtos. Só leitura; uma API sem a Frente de caixa mantém o registrado zerado.
type PosPort = { pos?: (path: string, options?: { signal?: AbortSignal }) => Promise<unknown> };
type Method = { payment_method_id: string; name: string; registered_cents: string; informed_cents: string; difference_cents: string };
const signed = (cents: bigint) => cents < 0n ? `- ${money(-cents)}` : money(cents);

export function usePdvCashSummary(controller: PosPort, sessionId: string) {
  const [state, setState] = useState<{ id: string; summary: PdvSummary | null; error: string } | null>(null);
  useEffect(() => {
    if (typeof controller.pos !== 'function') return; const request = new AbortController();
    void controller.pos(`/v1/frente-caixa/caixas/${sessionId}/resumo`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setState({ id: sessionId, summary: pdvSummary(value), error: '' }); })
      .catch(failure => { if (!request.signal.aborted) setState({ id: sessionId, summary: null, error: pdvFailure(failure) }); });
    return () => request.abort();
  }, [controller, sessionId]);
  return state?.id === sessionId ? state : null;
}

/** Tabela "Formas de pagamento" do caixa: Nome, Ver vendas, Total registrado (Frente de caixa), Total informado e Diferenças. */
export function PdvCashMethods({ controller, sessionId, informed, summary }: { controller: PosPort; sessionId: string; informed: readonly Method[]; summary: ReturnType<typeof usePdvCashSummary> }) {
  const [sales, setSales] = useState<{ id: string; name: string } | null>(null);
  const registered = summary?.summary?.methods ?? [];
  const rows = [...informed.map(item => ({ id: item.payment_method_id, name: item.name, informed: BigInt(item.informed_cents) })), ...registered.filter(item => !informed.some(row => row.payment_method_id === item.payment_method_id)).map(item => ({ id: item.payment_method_id, name: item.name, informed: 0n }))]
    .map(row => { const pdv = registered.find(item => item.payment_method_id === row.id); return { ...row, registered: BigInt(pdv?.registered_cents ?? '0'), sales: pdv?.sales ?? 0 }; })
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  const total = rows.reduce((sum, row) => ({ registered: sum.registered + row.registered, informed: sum.informed + row.informed }), { registered: 0n, informed: 0n });
  return <>
    {!rows.length ? <p className="real-help">Nenhuma forma informada nem registrada.</p> : <div className="table-scroll"><table className="data-table finance-table"><thead><tr><th>Nome</th><th><span className="real-sr-only">Vendas</span></th><th className="numeric">Total registrado</th><th className="numeric">Total informado</th><th className="numeric">Diferenças</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}><td>{row.name}</td><td><button type="button" className="text-button" disabled={!row.sales || typeof controller.pos !== 'function'} title={row.sales ? undefined : 'Nenhuma venda da Frente de caixa com esta forma neste caixa.'} onClick={() => setSales({ id: row.id, name: row.name })}>Ver vendas</button></td>
        <td className="numeric">{money(row.registered)}</td><td className="numeric">{money(row.informed)}</td><td className="numeric">{signed(row.informed - row.registered)}</td></tr>)}</tbody>
      <tfoot><tr><td colSpan={2}>Total</td><td className="numeric">{money(total.registered)}</td><td className="numeric">{money(total.informed)}</td><td className="numeric">{signed(total.informed - total.registered)}</td></tr></tfoot></table></div>}
    {summary?.error ? <p className="real-help" role="status">O total registrado pela Frente de caixa não pôde ser lido ({summary.error}); as diferenças consideram registrado zero.</p>
      : <p className="real-help">Total registrado: vendas finalizadas na Frente de caixa neste caixa, nas situações de Preferências › Vendas › Frente de caixa{summary?.summary?.returns_cents && summary.summary.returns_cents !== '0' ? `; devoluções em dinheiro: ${money(summary.summary.returns_cents)}` : ''}.</p>}
    {sales && <PdvCashSales controller={controller} sessionId={sessionId} method={sales} onClose={() => setSales(null)} />}
  </>;
}

/** "Movimentos dos Grupos de Produtos": quantidade, porcentagem do valor e valor vendidos por grupo de produtos. */
export function PdvCashGroups({ summary }: { summary: ReturnType<typeof usePdvCashSummary> }) {
  const groups = summary?.summary?.groups ?? [];
  return <section className="finance-commission-section" aria-label="Movimentos dos Grupos de Produtos"><h3>Movimentos dos Grupos de Produtos</h3>
    {!groups.length ? <p className="real-help">Nenhum produto vendido na Frente de caixa neste caixa.</p> : <div className="table-scroll"><table className="data-table finance-table"><thead><tr><th>Grupo</th><th className="numeric">Quantidade</th><th className="numeric">Porcentagem (%)</th><th className="numeric">Valor</th></tr></thead>
      <tbody>{groups.map(row => <tr key={row.group_id ?? 'none'}><td>{row.name}</td><td className="numeric">{row.quantity.replace(/\.?0+$/, '').replace('.', ',')}</td><td className="numeric">{row.percent.replace('.', ',')}</td><td className="numeric">{money(row.value.replace('.', ''))}</td></tr>)}</tbody></table></div>}
  </section>;
}

function PdvCashSales({ controller, sessionId, method, onClose }: { controller: PosPort; sessionId: string; method: { id: string; name: string }; onClose: () => void }) {
  const [state, setState] = useState<{ items: PdvSaleSummary[]; total: number } | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (typeof controller.pos !== 'function') return; const request = new AbortController();
    void controller.pos(`/v1/frente-caixa/vendas?${new URLSearchParams({ caixa: sessionId, method: method.id, limit: '50' })}`, { signal: request.signal })
      .then(value => { if (!request.signal.aborted) setState(pdvSalesPage(value)); }).catch(failure => { if (!request.signal.aborted) setError(pdvFailure(failure)); });
    return () => request.abort();
  }, [controller, sessionId, method.id]);
  return <Modal title={`Vendas · ${method.name}`} onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
    {error ? <p className="real-alert" role="alert">{error}</p> : !state ? <p role="status">Carregando vendas…</p> : !state.items.length ? <p className="real-help">Nenhuma venda.</p>
      : <><table className="data-table"><thead><tr><th>Número</th><th>Data</th><th>Cliente</th><th>Situação</th><th className="numeric">Total</th></tr></thead>
        <tbody>{state.items.map(row => <tr key={row.id}><td><Link to={`/documentos-empresa?${new URLSearchParams({ tipo: 'sales_orders', documento: row.document_id })}`}>{row.number}</Link></td><td>{dateTimeSP(row.finished_at ?? row.created_at)}</td><td>{row.contact_name}</td><td>{SALE_STATES[row.state]}</td><td className="numeric">{money(row.total_cents)}</td></tr>)}</tbody></table>
        {state.total > state.items.length && <p className="real-help">Mostrando as {state.items.length} vendas mais recentes de {state.total}.</p>}</>}
  </Modal>;
}
