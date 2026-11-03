import { useEffect, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { decimalMoney } from '../lib/real-access';
import type { DocumentKind, DocumentTotals } from '../../../../packages/erp-domain/src/index.mjs';
import { centsDecimal, COMMISSION_ADDITION_LABELS, COMMISSION_RULE_LABELS, commissionPath, itemCommissions, operationPath, readFrozenCommission, readSellerCommission, type FrozenCommission, type SellerCommission } from '../lib/document-commissions';
import './document-wave-g.css';
import './financeiro-h.css';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
const actorOf = (controller: Controller) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const percent = (value: string) => `${value.replace(/\.?0+$/, '').replace('.', ',') || '0'}%`;

/** The commission rule of the vendedor of the document (null while unknown, 'none' without a vendedor or when it cannot be read). */
export function useSellerCommission(controller: Controller, kind: DocumentKind, sellerId: string | null | undefined): SellerCommission | null | 'none' {
  const [rule, setRule] = useState<SellerCommission | null | 'none'>(null);
  useEffect(() => {
    if (!sellerId || (kind !== 'sales_orders' && kind !== 'service_orders')) { setRule('none'); return; }
    setRule(null);
    const request = new AbortController(), actor = actorOf(controller);
    void Promise.resolve().then(() => controller.documents(commissionPath(kind, sellerId), { signal: request.signal }))
      .then(value => { if (!request.signal.aborted && actorOf(controller) === actor) setRule(readSellerCommission(value, sellerId)); })
      .catch(() => { if (!request.signal.aborted) setRule('none'); });
    return () => request.abort();
  }, [controller, kind, sellerId]);
  return rule;
}

/** 370: the commission frozen on the operation of a saved pedido/OS (null while unknown, 'none' when it cannot be read). */
export function useFrozenCommission(controller: Controller, kind: DocumentKind, documentId: string | null | undefined): FrozenCommission | null | 'none' {
  const [frozen, setFrozen] = useState<FrozenCommission | null | 'none'>(null);
  useEffect(() => {
    if (!documentId || (kind !== 'sales_orders' && kind !== 'service_orders')) { setFrozen('none'); return; }
    setFrozen(null);
    const request = new AbortController(), actor = actorOf(controller);
    void Promise.resolve().then(() => controller.documents(operationPath(kind, documentId), { signal: request.signal }))
      .then(value => { if (!request.signal.aborted && actorOf(controller) === actor) setFrozen(readFrozenCommission(value, documentId)); })
      .catch(() => { if (!request.signal.aborted) setFrozen('none'); });
    return () => request.abort();
  }, [controller, kind, documentId]);
  return frozen;
}
const money = (cents: string) => decimalMoney(centsDecimal(cents));

/**
 * Origin aba "Comissões" of the items (pedido de venda; Peças and Serviços executados of the OS): Base, Adicionais da base, Alq (%) and
 * Valor comissão of each item, by the rule of the vendedor. Read-only. 370: once the document is confirmed (pedido Verificado, OS
 * Aprovada...), the regra, the base and the percentual frozen on the operation are shown, with the adjustments and the eligible amount.
 */
export default function DocumentItemCommissions({ controller, kind, rows, items, totals, sellerId, documentId }: {
  controller: Controller; kind: DocumentKind; sellerId: string | null | undefined; documentId?: string | null;
  /** The items of the grid: index in the document, position in the grid and description. */
  rows: readonly { index: number; position: number; description: string }[];
  items: readonly { discount_percent?: string }[]; totals: DocumentTotals | null;
}) {
  const rule = useSellerCommission(controller, kind, sellerId), frozen = useFrozenCommission(controller, kind, documentId);
  const operation = frozen && frozen !== 'none' ? frozen.operation : null;
  if (operation && frozen && frozen !== 'none') {
    const byPosition = new Map(frozen.items.map(item => [item.position, item]));
    return <div className="table-scroll" tabIndex={0} aria-label="Comissões dos itens"><table className="data-table document-item-commissions"><thead><tr><th>#</th><th>Descrição</th><th>Base</th><th>Alq (%)</th><th>Valor comissão</th></tr></thead>
      <tbody>{rows.map(row => { const line = byPosition.get(row.index + 1); return <tr key={row.index}><td>{row.position}</td><td>{row.description || '—'}</td>
        <td className="numeric">{line ? money(line.base_cents) : '—'}</td><td className="numeric">{percent(operation.rate)}</td><td className="numeric">{line ? money(line.commission_cents) : '—'}</td></tr>; })}</tbody>
      <tfoot><tr><th colSpan={4}>Total de comissões (estimada)</th><td className="numeric">{money(operation.estimated_cents)}</td></tr></tfoot></table>
      <dl className="document-commission-summary">
        <div><dt>Regra</dt><dd>{COMMISSION_RULE_LABELS[operation.rule]}</dd></div>
        <div><dt>Adicionais da base</dt><dd>{operation.policy.additions.length ? operation.policy.additions.map(item => COMMISSION_ADDITION_LABELS[item]).join(', ') : 'Nenhum'}</dd></div>
        <div><dt>Ajustes (devolução e cancelamento)</dt><dd>{money(operation.adjusted_cents)}</dd></div>
        <div><dt>Recebido das contas da venda</dt><dd>{money(operation.received_cents)} de {money(operation.total_cents)}</dd></div>
        <div><dt>Elegível</dt><dd>{money(operation.eligible_cents)}</dd></div>
      </dl>
      <p className="real-help">Comissão congelada na confirmação comercial em {operation.confirmed_on.split('-').reverse().join('/')}: a regra, a base e o percentual não mudam se o vendedor ou as preferências mudarem depois.</p></div>;
  }
  if (!sellerId) return <p className="real-help">Informe o vendedor do documento (Cadastros › Vendedores) para ver as comissões dos itens.</p>;
  if (rule === null) return <p role="status">Carregando a regra de comissão do vendedor…</p>;
  if (rule === 'none') return <p className="real-help">Não foi possível consultar a regra de comissão do vendedor.</p>;
  const all = itemCommissions(items, totals, rule), shown = rows.map(row => ({ row, line: all.find(line => line.index === row.index) }));
  return <div className="table-scroll" tabIndex={0} aria-label="Comissões dos itens"><table className="data-table document-item-commissions"><thead><tr><th>#</th><th>Descrição</th><th>Base</th><th>Adicionais da base</th><th>Alq (%)</th><th>Valor comissão</th></tr></thead>
    <tbody>{shown.map(({ row, line }) => <tr key={row.index}><td>{row.position}</td><td>{row.description || '—'}</td>
      <td className="numeric">{line ? decimalMoney(line.base) : '—'}</td><td className="numeric">{line ? decimalMoney(line.additions.replace('-', '')).replace(/^/, line.additions.startsWith('-') ? '− ' : '') : '—'}</td>
      <td className="numeric">{line ? percent(line.rate) : '—'}</td><td className="numeric">{line ? decimalMoney(line.value) : '—'}</td></tr>)}</tbody></table>
    <p className="real-help">{rule.mode === 'fixa' ? 'Comissão fixa do vendedor.' : 'Comissão pela faixa de desconto de cada item.'} Estimativa: a comissão é congelada na confirmação comercial do documento e lançada em Financeiro › Comissões com as contas.{rule.additions.includes('taxas_pagamento') ? ' As taxas de pagamento das parcelas entram na base congelada.' : ''}</p></div>;
}
