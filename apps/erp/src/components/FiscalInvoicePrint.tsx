import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { decimalMoney } from '../lib/real-access';
import type { EventRecord, InvoiceRecord } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { brDay, invoiceNumber, sourceLabel, statusLabel, type ListRow } from '../lib/fiscal-invoice-list-model';
import { labelOf, CRT, PURPOSE, FREIGHT_BY } from '../../../../packages/fiscal-core/src/tax-tables.mjs';
import './fiscal-invoices.css';

/** A4 print portal: everything is React text; the rest of the page is hidden only while it is open. */
function PrintPortal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const [portal] = useState(() => typeof document === 'undefined' ? null : Object.assign(document.createElement('div'), { className: 'fiscal-print-root' }));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!portal) return;
    document.body.append(portal); document.body.classList.add('fiscal-print-open');
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.classList.remove('fiscal-print-open'); portal.remove(); };
  }, [portal]);
  const content = <div className="fiscal-print-dialog" role="dialog" aria-modal="true" aria-label={title}>
    <header className="fiscal-print-controls"><h2>{title}</h2><div><button type="button" className="secondary-button" onClick={onClose}>Fechar prévia</button>
      <button type="button" className="primary-button" onClick={() => { setFailed(false); try { globalThis.window?.print(); } catch { setFailed(true); } }}>Imprimir</button></div></header>
    {failed && <p className="real-alert" role="alert">O navegador não abriu a impressão. Tente novamente.</p>}
    <div className="fiscal-print-sheet">{children}</div></div>;
  return portal ? createPortal(content, portal) : content;
}

export function FiscalListPrint({ title, rows, total, amount, period, model, onClose }: { title: string; rows: ListRow[]; total: number; amount: string; period: string; model: '55' | '65'; onClose: () => void }) {
  return <PrintPortal title="Imprimir listagem de notas" onClose={onClose}>
    <h1>{title}</h1><p>Período: {period} · {total} nota(s) · Valor total {decimalMoney(amount)}{rows.length < total ? ` · impressas as primeiras ${rows.length}` : ''}</p>
    <p>Listagem de consulta. Os horários de observação do Origin são exibidos no horário de São Paulo.</p>
    <table><thead><tr><th>Número / origem</th><th>Série</th><th>Data emissão</th><th>Nome</th><th>CPF/CNPJ</th><th>UF</th><th>Situação</th><th className="numeric">Valor (R$)</th></tr></thead>
      <tbody>{rows.map(row => <tr key={`${row.origin}:${row.id}`}><td>{invoiceNumber(row)}<small className="fiscal-source-line">{sourceLabel(row)}{row.source_environment === '2' ? ' · sem valor fiscal' : ''}</small>{row.origin === 'origin' && <small className="fiscal-source-line">ID Origin {row.id}{row.observed_at && <> · Observada em <time dateTime={row.observed_at}>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(row.observed_at))}</time></>}</small>}</td><td>{row.series ?? '—'}</td><td>{brDay(row.issue_date)}</td><td>{row.name ?? '—'}</td><td>{row.document ?? '—'}</td>
        <td>{row.state ?? '—'}</td><td>{statusLabel(row, model)}</td><td className="numeric">{row.total_known ? decimalMoney(row.total) : '—'}</td></tr>)}</tbody></table>
  </PrintPortal>;
}

export function FiscalEventsPrint({ title, events, onClose }: { title: string; events: EventRecord[]; onClose: () => void }) {
  return <PrintPortal title="Imprimir lista de cartas de correção" onClose={onClose}>
    <h1>{title}</h1><p>Pedidos registrados em homologação, aguardando transmissão.</p>
    <table><thead><tr><th>Série</th><th>Número</th><th>Correção</th><th>Data</th></tr></thead>
      <tbody>{events.map(e => <tr key={e.id}><td>{e.series}</td><td>{String(e.number_from).padStart(6, '0')}</td><td>{e.text}</td><td>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(Date.parse(e.requested_at))}</td></tr>)}</tbody></table>
  </PrintPortal>;
}

/** "Imprimir espelho NF": saved data of a Brufap note, before number and XML, marked without fiscal value. */
export function FiscalMirrorPrint({ record, onClose }: { record: InvoiceRecord; onClose: () => void }) {
  const r = record.recipient as Record<string, string | undefined>;
  return <PrintPortal title="Espelho da nota fiscal" onClose={onClose}>
    <p className="fiscal-mirror-mark">ESPELHO · SEM VALOR FISCAL{record.environment === '2' ? ' · HOMOLOGAÇÃO' : ''}</p>
    <h1>Nota fiscal {record.number ? String(record.number).padStart(6, '0') : '(número definido no envio)'} · Série {record.series}</h1>
    <p>{record.direction === '1' ? 'Saída' : 'Entrada'} · Modelo {record.model} · Natureza: {record.nature_description}{record.cfop ? ` · CFOP ${record.cfop}` : ''} · Emissão {brDay(record.issue_date)} · {labelOf(CRT, record.crt)} · {labelOf(PURPOSE, record.purpose)}</p>
    <h2>{record.direction === '1' ? 'Destinatário' : 'Remetente'}</h2>
    <p>{r.name ?? '—'}{r.document ? ` · CPF/CNPJ ${r.document}` : ''}{r.ie ? ` · IE ${r.ie}` : ''}</p>
    <p>{[r.street, r.number, r.complement, r.district, r.city, r.state, r.postal_code].filter(Boolean).join(', ')}</p>
    <h2>Itens</h2>
    <table><thead><tr><th>#</th><th>Descrição</th><th>Código</th><th>NCM</th><th>CFOP</th><th>UN</th><th className="numeric">Qtde</th><th className="numeric">Preço un</th><th className="numeric">Total</th></tr></thead>
      <tbody>{record.items.map(item => <tr key={item.position}><td>{item.position}</td><td>{String(item.description)}</td><td>{String(item.code ?? '')}</td><td>{String(item.ncm ?? '')}</td><td>{String(item.cfop ?? '')}</td>
        <td>{String(item.unit ?? '')}</td><td className="numeric">{item.quantity}</td><td className="numeric">{item.unit_price}</td><td className="numeric">{decimalMoney(item.total)}</td></tr>)}</tbody></table>
    <h2>Cálculo de imposto</h2>
    <dl className="fiscal-mirror-totals">{([['Base ICMS', 'icms_base'], ['Valor ICMS', 'icms'], ['Base ICMS ST', 'st_base'], ['Valor ICMS ST', 'st'], ['Valor IPI', 'ipi'], ['Total dos Produtos (R$)', 'products'],
      ['Valor do Frete (R$)', 'freight'], ['Valor do Seguro (R$)', 'insurance'], ['Outras Despesas (R$)', 'other_expenses'], ['Desconto (R$)', 'discount'], ['Total da Nota (R$)', 'total']] as const)
      .map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{decimalMoney(record.totals[key])}</dd></div>)}</dl>
    <p>Transporte: {labelOf(FREIGHT_BY, record.transport.freight_by)}{record.transport.carrier.name ? ` · ${String(record.transport.carrier.name)}` : ''}</p>
    {record.payment.installments.length > 0 && <><h2>Parcelas</h2><table><thead><tr><th>Data</th><th className="numeric">Valor</th></tr></thead><tbody>{record.payment.installments.map((i, n) => <tr key={n}><td>{brDay(i.date)}</td><td className="numeric">{decimalMoney(i.amount)}</td></tr>)}</tbody></table></>}
    {(record.additional_info || record.nature_additional_info) && <><h2>Informações adicionais</h2><p className="fiscal-pre">{[record.additional_info, record.nature_additional_info].filter(Boolean).join('\n')}</p></>}
  </PrintPortal>;
}
