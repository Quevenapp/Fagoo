import { useEffect, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { CompanyRecord } from '../lib/company-model';
// 302 (mixed lane): CPF for a company of Pessoa Física.
import { companyDocumentLabel } from '../lib/company-model';
import { dateBR, dateTimeSP, money, quantityText, receiptItems, decimalText, type PdvReceiptSettings, type PdvSale } from '../lib/pdv-model';
import { qrEncode, qrPath } from '../lib/qr-code';
import { Icon } from './Icon';

/** What the 80 mm sheet prints: a sale (comprovante não fiscal), a sangria/suprimento or the QR code fixo of the Pix key. */
export type PdvPrintJob =
  | { kind: 'sale'; sale: PdvSale; pix?: { payload: string; amount_cents: string } | null }
  | { kind: 'move'; move: 'withdrawal' | 'supply'; store: string; operator: string; amount_cents: string; note: string | null; at: string }
  | { kind: 'pix'; payload: string; amount_cents: string | null; label: string };
type Company = { name: string; cnpj: string } | null;
type Controller = Pick<AccessController, 'company'>;

export function PdvQr({ payload, label }: { payload: string; label: string }) {
  let matrix; try { matrix = qrEncode(payload); } catch { return <p className="real-alert" role="alert">Não foi possível montar o QR Code deste Pix.</p>; }
  const edge = matrix.size + 8;
  return <figure className="pdv-qr"><svg role="img" aria-label={label} viewBox={`0 0 ${edge} ${edge}`} width="40mm" height="40mm" shapeRendering="crispEdges"><rect width={edge} height={edge} fill="#fff" /><path d={qrPath(matrix)} fill="#000" /></svg>
    <figcaption><small>Pix Copia e Cola</small><code>{payload}</code></figcaption></figure>;
}

/** Origin "Imprimir" / "Reimprimir última operação" da Frente de caixa: comprovante de 80 mm (não fiscal), com as opções de
 * Preferências › Vendas › Configuração de Impressão do Comprovante e a ordem dos itens da Frente de caixa. */
export function PdvReceiptSheet({ job, receipt, order, company }: { job: PdvPrintJob; receipt: PdvReceiptSettings; order: 'alfabetica' | 'insercao'; company: Company }) {
  const head = <header className="pdv-print-head"><strong>{company?.name ?? 'Empresa'}</strong>{company?.cnpj && <span>{companyDocumentLabel(company.cnpj)}: {company.cnpj}</span>}</header>;
  if (job.kind === 'pix') return <article className="pdv-print-sheet" style={{ fontSize: `${receipt.font_size}px` }} aria-label="QR code Pix">{head}<h2>{job.label}</h2>
    {job.amount_cents && <p className="pdv-print-total">Valor: <strong>{money(job.amount_cents)}</strong></p>}<PdvQr payload={job.payload} label="QR Code Pix" />
    <p className="pdv-print-note">Pague com o aplicativo do seu banco. O recebimento é conferido pelo caixa.</p></article>;
  if (job.kind === 'move') return <article className="pdv-print-sheet" style={{ fontSize: `${receipt.font_size}px` }} aria-label="Comprovante de caixa">{head}
    <h2>{job.move === 'supply' ? 'Suprimento de caixa' : 'Sangria de caixa'}</h2><dl className="pdv-print-dl"><dt>Loja</dt><dd>{job.store}</dd><dt>Operador</dt><dd>{job.operator}</dd><dt>Data</dt><dd>{dateTimeSP(job.at)}</dd>
      <dt>Valor</dt><dd><strong>{money(job.amount_cents)}</strong></dd>{job.note && <><dt>Observação</dt><dd>{job.note}</dd></>}</dl>
    <p className="pdv-print-sign">Assinatura: ______________________</p><footer className="pdv-print-foot">Comprovante sem valor fiscal.</footer></article>;
  const sale = job.sale, description = (text: string) => receipt.limit_description && Array.from(text).length > 25 ? Array.from(text).slice(0, 25).join('') : text;
  const cash = sale.cash_received_cents !== null;
  return <article className="pdv-print-sheet" style={{ fontSize: `${receipt.font_size}px` }} aria-label={`Comprovante da venda ${sale.number}`}>{head}
    <h2>Comprovante de venda</h2><p className="pdv-print-fiscal">Não é documento fiscal</p>
    <dl className="pdv-print-dl"><dt>Venda</dt><dd>nº {sale.number}{sale.kind === 'mesa' ? ` · Mesa ${sale.table_number}` : ''}</dd><dt>Data</dt><dd>{dateTimeSP(sale.finished_at ?? sale.created_at)}</dd>
      <dt>Cliente</dt><dd>{sale.customer_identified ? sale.contact_name : 'Consumidor não identificado'}{sale.customer_identified && sale.contact_document ? ` · ${sale.contact_document}` : ''}</dd><dt>Operador</dt><dd>{sale.operator_name}</dd></dl>
    <table className="pdv-print-items"><thead><tr><th scope="col">Item</th><th scope="col">Qtde × Valor</th><th scope="col">Total</th></tr></thead>
      <tbody>{receiptItems(sale, order).map(item => <tr key={item.id}><td>{description(item.description)}{receipt.code && item.code && <small>{item.code}</small>}{receipt.comments && item.comment && <small>{item.comment}</small>}
        {receipt.discount && item.discount !== '0.00' && <small>Desconto: {money(item.discount.replace('.', ''))}</small>}</td><td>{quantityText(item.quantity)} {item.unit} × {decimalText(item.unit_price.replace(/(\.\d{2}\d*?)0+$/, '$1'))}</td><td>{money(item.total.replace('.', ''))}</td></tr>)}</tbody></table>
    <dl className="pdv-print-totals"><dt>Sub total</dt><dd>{money(sale.totals.subtotal.replace('.', ''))}</dd>
      {sale.totals.discount !== '0.00' && <><dt>Desconto</dt><dd>{money(sale.totals.discount.replace('.', ''))}</dd></>}
      {sale.totals.other_expenses !== '0.00' && <><dt>Outras despesas</dt><dd>{money(sale.totals.other_expenses.replace('.', ''))}</dd></>}
      {sale.totals.freight !== '0.00' && <><dt>Frete</dt><dd>{money(sale.totals.freight.replace('.', ''))}</dd></>}
      <dt className="pdv-print-grand">Total da venda</dt><dd className="pdv-print-grand">{money(sale.total_cents)}</dd></dl>
    <section><h3>Pagamento</h3><ul className="pdv-print-payments">{sale.payments.map(row => <li key={row.position}>{row.method_name}{row.days ? ` · ${dateBR(row.due_on)}` : ''} <strong>{money(row.amount_cents)}</strong></li>)}</ul>
      {cash && <dl className="pdv-print-dl"><dt>Total recebido em dinheiro</dt><dd>{money(sale.cash_received_cents!)}</dd><dt>Troco em dinheiro</dt><dd>{money(sale.change_cents)}</dd></dl>}</section>
    {job.pix && <PdvQr payload={job.pix.payload} label={`QR Code Pix de ${money(job.pix.amount_cents)}`} />}
    {receipt.notes && sale.notes && <p>{Array.from(sale.notes).slice(0, 100).join('')}</p>}
    {receipt.footer && <p className="pdv-print-note">{receipt.footer}</p>}
    <footer className="pdv-print-foot">Comprovante sem valor fiscal.</footer></article>;
}

export default function PdvReceiptPrint({ controller, job, receipt, order, onClose }: { controller: Controller; job: PdvPrintJob; receipt: PdvReceiptSettings; order: 'alfabetica' | 'insercao'; onClose: () => void }) {
  const [company, setCompany] = useState<Company>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    void controller.company('/v1/empresa/identidade', { signal: request.signal }).then(value => {
      const record = (value as { record?: CompanyRecord | null })?.record;
      if (!request.signal.aborted) setCompany(record && record.data ? { name: record.data.trade_name || record.data.legal_name, cnpj: record.data.cnpj } : null);
    }).catch(() => { if (!request.signal.aborted) setFailed(true); });
    return () => request.abort();
  }, [controller]);
  return <div className="pdv-print-dialog" role="dialog" aria-modal="true" aria-labelledby="pdv-print-title">
    <header className="pdv-print-controls"><h2 id="pdv-print-title">Imprimir</h2>{failed && <span className="real-help">A identificação da empresa não foi lida; o comprovante sai sem ela.</span>}
      <button type="button" className="secondary-button" onClick={onClose}>Fechar</button>
      <button type="button" className="primary-button" onClick={() => { try { globalThis.window?.print(); } catch { /* The sheet stays on screen. */ } }}><Icon name="print" size={13} />Imprimir</button></header>
    <div className="pdv-print-scroll"><PdvReceiptSheet job={job} receipt={receipt} order={order} company={company} /></div>
  </div>;
}
