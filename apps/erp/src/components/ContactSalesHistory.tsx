import {nativeReportCoverageText,readNativeReportCoverage,type NativeReportCoverage} from '../lib/document-reports-model';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccessError, type AccessController } from '../lib/real-access';
import { brDate } from '../lib/origin-list';
import { SALE_STATUS_OPTIONS } from '../lib/contact-list-model';
import { STATES } from '../lib/real-documents-model';
import { Icon } from './Icon';
import { aborted, errorText } from './catalog-shared';

// Ícone "Visualizar histórico do cliente" no campo Nome (Origin CF-01): popover "Últimos registros deste cliente" com os
// últimos pedidos de venda nativos do Brufap; vazio, o texto do Origin. O histórico de vendas do Origin não entra aqui.
type Sale = { id: string; number: string; date: string | null; status: string; total: string };
const money = (value: string) => { const [integer, cents] = value.split('.'); return `R$ ${integer!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`; };

export function ContactSalesHistory({ controller, contactId }: { controller: AccessController; contactId: string }) {
  const [open, setOpen] = useState(false), [sales, setSales] = useState<Sale[] | null>(null), [visible, setVisible] = useState(true), [error, setError] = useState('');
  const [coverage,setCoverage]=useState<NativeReportCoverage|null>(null);
  useEffect(() => {
    if (!open) return;
    const request = new AbortController(); setSales(null); setError(''); setCoverage(null);
    void controller.catalog(`/v1/cadastros/contatos/${contactId}/historico`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return; const result = value as { contact_id?: string; visible?: boolean; items?: Sale[] };
      if (result.contact_id !== contactId || !Array.isArray(result.items)) throw new AccessError(502);
      setVisible(result.visible !== false); setSales(result.items); setCoverage(readNativeReportCoverage(result));
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(errorText(failure)); });
    return () => request.abort();
  }, [controller, contactId, open]);
  return <span className="contact-history">
    <button type="button" className="icon-button" title="Visualizar histórico do cliente" aria-label="Visualizar histórico do cliente" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="clock-rotate-left" size={13} /></button>
    {open && <><button type="button" className="origin-click-catcher" tabIndex={-1} aria-label="Fechar histórico" onClick={() => setOpen(false)} />
      <div className="contact-history-popover" role="dialog" aria-label="Últimos registros deste cliente"><h3>Últimos registros deste cliente</h3>
        {visible&&nativeReportCoverageText(coverage)&&<p className="real-notice" role="note">{nativeReportCoverageText(coverage)}</p>}
        {error ? <p className="real-alert" role="alert">{error}</p> : sales === null ? <p role="status">Carregando…</p> : !visible ? <p className="real-help">Seu perfil não consulta pedidos de venda.</p>
          : !sales.length ? <p>Não existem vendas para este cliente.</p>
            : <table className="data-table"><thead><tr><th scope="col">Pedido</th><th scope="col">Data</th><th scope="col">Situação</th><th scope="col">Total</th></tr></thead>
              <tbody>{sales.map(sale => <tr key={sale.id}><td><Link to={`/documentos-empresa?tipo=sales_orders&documento=${sale.id}`}>{sale.number}</Link></td><td>{sale.date ? brDate(sale.date) : '—'}</td>
                <td>{SALE_STATUS_OPTIONS.find(option => option.value === sale.status)?.label ?? STATES.sales_orders[sale.status] ?? sale.status}</td><td className="numeric">{money(sale.total)}</td></tr>)}</tbody></table>}
      </div></>}
  </span>;
}
