import { useEffect, useState } from 'react';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import { itemHistoryRecord, type ItemHistory } from '../../../../packages/erp-domain/src/fiscal-invoice-order.mjs';
import { FISCAL_BASE, brDay } from '../lib/fiscal-invoice-list-model';
import { Modal } from './Modal';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const quantity = (value: string | null) => value === null ? '—' : value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',') : value;

/**
 * Ícone "Histórico do produto para o cliente" (fornecedor, na nota de entrada) dos itens da nota (Origin): as últimas 20 notas do
 * mesmo contato com o mesmo produto, do Origin e do Brufap. Só leitura (migration 202610200218).
 */
export default function FiscalInvoiceItemHistory({ controller, contactId, contactName, productId, productName, direction, onClose }: {
  controller: AccessController; contactId: string; contactName: string; productId: string; productName: string; direction: '0' | '1'; onClose: () => void;
}) {
  const [history, setHistory] = useState<ItemHistory | null>(null), [error, setError] = useState('');
  useEffect(() => {
    const request = new AbortController();
    void controller.fiscalInvoices(`${FISCAL_BASE}/historico-item?${new URLSearchParams({ contact_id: contactId, product_id: productId, direction })}`, { signal: request.signal })
      .then(value => { if (!request.signal.aborted) setHistory(itemHistoryRecord(value, { contactId, productId, direction })); })
      .catch(problem => { if (request.signal.aborted || aborted(problem)) return; setError(problem instanceof AccessError && problem.status === 403 ? 'Seu perfil não consulta o histórico.' : 'Não foi possível consultar o histórico do produto.'); });
    return () => request.abort();
  }, [controller, contactId, productId, direction]);
  const title = direction === '1' ? 'Histórico do produto para o cliente' : 'Histórico do produto para o fornecedor';
  return <Modal title={title} onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
    <p className="real-help">{productName} · {contactName}. Últimas 20 notas, as mais recentes primeiro.</p>
    {error ? <p className="real-alert" role="alert">{error}</p> : !history ? <p role="status">Consultando…</p> : !history.items.length ? <p className="real-help">Nenhuma nota anterior deste produto para este contato.</p>
      : <div className="table-scroll" tabIndex={0}><table className="data-table"><thead><tr><th>Origem</th><th>Número</th><th>Data emissão</th><th className="numeric">Qtde</th><th className="numeric">Preço un</th><th className="numeric">Preço total</th></tr></thead>
        <tbody>{history.items.map((row, index) => <tr key={`${row.origin}:${row.id}:${index}`}><td>{row.origin === 'origin' ? 'Nota do Origin' : 'FAGOO (homologação ou registrada)'}</td>
          <td>{row.number === null ? '—' : String(row.number).padStart(6, '0')}</td><td>{brDay(row.issue_date)}</td><td className="numeric">{quantity(row.quantity)}</td>
          <td className="numeric">{row.unit_price === null ? '—' : quantity(row.unit_price)}</td><td className="numeric">{row.total === null ? '—' : decimalMoney(row.total)}</td></tr>)}</tbody></table></div>}
  </Modal>;
}
