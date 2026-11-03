import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { documentPrintModel, printDecimal, type DocumentPrintModel, type PrintOptions } from '../lib/document-print-model';
import type { DocumentRecord } from '../lib/real-documents-model';
import type {CompanyController,CompanyRecord,CompanyEnvelope} from '../lib/company-model';
// 302 (mixed lane): CPF for a company of Pessoa Física.
import {companyDocumentLabel} from '../lib/company-model';
import './document-print.css';
// Produtos lane (wave D): "Código no fornecedor" of the purchase order print.
import { useSupplierCodes } from '../hooks/useSupplierCodes';
// 202610200240: structures for the Relatório de Produção, Code 128 bars and the persons of the contact of the OS.
import { useDocumentStructures } from '../hooks/useDocumentStructures';
import { barRuns } from '../lib/barcodes';
import { contactSummary } from '../lib/contact-picker-model';
// 202610200270: texto rico of the proposta and the Cabeçalho personalizado.
import { RichTextView } from './RichTextView';
import { usePrintHeader } from '../hooks/usePrintHeader';
import { usePrintExtras } from '../hooks/usePrintExtras';

function PublicText({ title, text }: { title: string; text: string | null }) {
  return text ? <section className="commercial-text"><h3>{title}</h3><p>{text}</p></section> : null;
}
/** Code 128 bars (local encoder, no library): one rect per bar run of the module string. */
export function PrintBars({ bits, label }: { bits: string | null; label: string }) {
  if (!bits) return null;
  return <svg className="commercial-bars" viewBox={`0 0 ${bits.length} 24`} preserveAspectRatio="none" role="img" aria-label={`Código de barras ${label}`}>{barRuns(bits).map(([x, w]) => <rect key={x} x={x} y={0} width={w} height={24} />)}</svg>;
}
type ItemHeads = { description: string; quantity: string; price: string; unit: boolean };
const GENERIC_HEADS: ItemHeads = { description: 'Descrição / código', quantity: 'Quantidade', price: 'Preço unitário', unit: true };
/** All content is React text. No HTML templates, private URLs, or injected markup. */
export function DocumentPrintSheet({ model }: { model: DocumentPrintModel }) {
  const itemsTable = (rows: DocumentPrintModel['items'], heads: ItemHeads) => <table><colgroup>{model.columns.position && <col className="commercial-col-number" />}<col className="commercial-col-item" />{heads.unit && <col className="commercial-col-unit" />}{model.columns.quantity && <col className="commercial-col-quantity" />}{model.columns.listPrice && <col className="commercial-col-price" />}{model.columns.values && <><col className="commercial-col-price" /><col className="commercial-col-discount" /><col className="commercial-col-total" /></>}{model.ipiColumns && <><col className="commercial-col-discount" /><col className="commercial-col-total" /></>}</colgroup><thead><tr>{model.columns.position && <th scope="col">Item</th>}<th scope="col">{heads.description}</th>{heads.unit && <th scope="col">Un.</th>}{model.columns.quantity && <th scope="col" className="commercial-numeric">{heads.quantity}</th>}{model.columns.listPrice && <th scope="col" className="commercial-numeric">Preço lista</th>}{model.columns.values && <><th scope="col" className="commercial-numeric">{heads.price}</th><th scope="col" className="commercial-numeric">Desc. %</th><th scope="col" className="commercial-numeric">Total</th></>}{model.ipiColumns && <><th scope="col" className="commercial-numeric">IPI %</th><th scope="col" className="commercial-numeric">Valor IPI</th></>}</tr></thead><tbody>{rows.map(item => <tr key={item.position}>{model.columns.position && <td>{item.position}</td>}<td>{item.image && <img className="commercial-item-image" src={item.image} alt={`Imagem de ${item.description}`} />}{item.description}{item.detailedDescription&&<p className="commercial-line-detail">{item.detailedDescription}</p>}{item.supplierDescription && <small>Descrição no fornecedor: {item.supplierDescription}</small>}{item.warranty && <small>Garantia: {item.warranty}</small>}{(item.code || model.detailed) && <small>{model.detailed && item.detailedCode ? <>GTIN: {item.detailedCode}</> : <>Código: {item.code ?? '—'}</>}</small>}{item.secondaryCode && <small>{item.secondaryLabel}: {item.secondaryCode}</small>}{model.columns.ncm && item.ncm && <small>NCM: {item.ncm}</small>}{model.columns.brand && item.brand && <small>Marca: {item.brand}</small>}{model.columns.location && item.location && <small>Localização: {item.location}</small>}{item.bars && <PrintBars bits={item.bars} label={item.code ?? ''} />}{item.explode && item.components.length > 0 && <ul className="commercial-components" aria-label={`Estrutura de ${item.description}`}>{item.components.map((c, i) => <li key={i}>{c.description}{c.code ? ` · ${c.code}` : ''} — {c.quantity} {c.unit ?? ''}</li>)}</ul>}</td>{heads.unit && <td>{item.unit}</td>}{model.columns.quantity && <td className="commercial-numeric">{item.quantity}</td>}{model.columns.listPrice && <td className="commercial-numeric">{item.listPrice ?? '—'}</td>}{model.columns.values && <><td className="commercial-numeric">{item.price}</td><td className="commercial-numeric">{item.discount}</td><td className="commercial-numeric">{item.total}</td></>}{model.ipiColumns && <><td className="commercial-numeric">{item.ipiRate ?? '—'}</td><td className="commercial-numeric">{item.ipiValue ?? '—'}</td></>}</tr>)}</tbody></table>;
  // 202610200268 OS: Peças and Serviços executados in their own tables, with the labels of Preferências › Serviços › Rótulos.
  const groupSection = (group: 'part' | 'service') => {
    const rows = model.items.filter(item => item.group === group), labels = model.serviceLabels;
    const heads: ItemHeads = group === 'part' ? { description: labels.partDescription, quantity: 'Quantidade', price: 'Preço unitário', unit: true }
      : { description: labels.serviceDescription, quantity: labels.serviceQuantity, price: labels.servicePrice, unit: false };
    return <section className="commercial-items" key={group}><h3>{group === 'part' ? 'Peças' : 'Serviços'}</h3>{rows.length ? itemsTable(rows, heads) : <p>{group === 'part' ? 'Nenhuma peça informada.' : 'Nenhum serviço informado.'}</p>}
      {group === 'service' && model.hiddenThirdParty > 0 && <p className="commercial-footnote">{model.hiddenThirdParty} item(ns) produzido(s) por terceiros não impresso(s).</p>}
      {group === 'service' && model.quantitySum && <p className="commercial-footnote">Soma das quantidades: {printDecimal(model.quantitySum)}</p>}</section>;
  };
  return <article className="commercial-sheet" aria-label={`${model.title} ${model.number}`}>
    <header className="commercial-heading"><div><p className="commercial-brand">FAGOO · Documento comercial</p><h2>{model.title}{model.titleNumber ? ` nº ${model.number}` : ''}</h2>{model.titleBars && <PrintBars bits={model.titleBars} label={model.number} />}{model.auxiliary && <p className="commercial-auxiliary">{model.auxiliary}</p>}<p className="commercial-fiscal-notice">Documento comercial sem validade fiscal</p></div><div className="commercial-identity"><strong>Nº {model.number}</strong><span>Data: {model.date}</span><span>Versão {model.version} · {model.status}</span></div></header>
    {model.customHeader?<section className="commercial-company commercial-custom-header" aria-label="Cabeçalho"><RichTextView value={model.customHeader} /></section>:model.company?<section className="commercial-company">
      <h3>Empresa</h3><strong>{model.company.legalName}</strong>{model.company.tradeName&&<p>{model.company.tradeName}</p>}
      <p>{companyDocumentLabel(model.company.cnpj)}: {model.company.cnpj}{model.company.ie?` · IE: ${model.company.ie}`:''}</p><p>{model.company.address} · {model.company.district}</p><p>{model.company.city} · CEP {model.company.postalCode}</p>
      {(model.company.email||model.company.phone)&&<p>{[model.company.email,model.company.phone].filter(Boolean).join(' · ')}</p>}
      <small>Identificação comercial atual · cadastro versão {model.company.version}</small>
    </section>:<p className="commercial-footnote">Identificação da empresa ainda não cadastrada.</p>}
    {(model.cancelled || model.template) && <p className="commercial-status">{model.cancelled ? 'DOCUMENTO CANCELADO' : 'MODELO DE PROPOSTA'}</p>}
    {model.showContact && <section className="commercial-contact"><h3>{model.contactLabel}</h3><strong>{model.contact.name}</strong>{model.contactCode && <p>Código: {model.contactCode}</p>}{model.contact.tradeName && model.contact.tradeName !== model.contact.name && <p>{model.contact.tradeName}</p>}{model.contact.document && <p>CPF / CNPJ: {model.contact.document}</p>}{model.contact.address && <p>{model.contact.address}</p>}{(model.contact.district || model.contact.city || model.contact.postalCode) && <p>{[model.contact.district, model.contact.city, model.contact.postalCode ? `CEP ${model.contact.postalCode}` : null].filter(Boolean).join(' · ')}</p>}{model.contact.email && <p>{model.contact.email}</p>}{model.contact.phones && <p>{model.contact.phones}</p>}</section>}
    {(model.expectedDate || model.validUntil || model.details.length > 0) && <dl className="commercial-dates">{model.expectedDate && <div><dt>Data prevista</dt><dd>{model.expectedDate}</dd></div>}{model.validUntil && <div><dt>Validade da proposta</dt><dd>{model.validUntil}</dd></div>}{model.details.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>}
    {model.deliveryAddress && <section className="commercial-contact"><h3>Endereço de entrega</h3>{model.deliveryAddress.name && <strong>{model.deliveryAddress.name}</strong>}<p>{model.deliveryAddress.address}</p>{(model.deliveryAddress.district || model.deliveryAddress.city || model.deliveryAddress.postalCode) && <p>{[model.deliveryAddress.district, model.deliveryAddress.city, model.deliveryAddress.postalCode ? `CEP ${model.deliveryAddress.postalCode}` : null].filter(Boolean).join(' · ')}</p>}{model.deliveryAddress.country && <p>{model.deliveryAddress.country}</p>}</section>}
    {model.commercial&&<><PublicText title="Introdução" text={model.commercial.introduction}/><PublicText title="Aos cuidados de" text={model.commercial.attentionTo}/>{model.commercial.references.length>0&&<section className="commercial-text"><h3>Referências comerciais declaradas</h3><dl className="commercial-dates">{model.commercial.references.map(row=><div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl><p className="commercial-footnote">Referências comerciais declaradas de origem Origin; não representam vínculo com usuários ou cadastros do FAGOO.</p></section>}</>}
    {model.service && <section className="commercial-service"><h3>Atendimento</h3><dl className="commercial-dates">{([[model.serviceLabels.equipment, model.service.equipment], [model.serviceLabels.serialNumber, model.service.serialNumber], ['Técnico', model.service.technician]] as const).filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><PublicText title={model.serviceLabels.defect} text={model.service.defect} /><PublicText title={model.serviceLabels.receptionNotes} text={model.receptionNotes} /><PublicText title="Informações técnico" text={model.service.solution} /><PublicText title="Informações de garantia" text={model.warrantyInfo} /></section>}
    {model.serviceGroups ? <>{groupSection('part')}{groupSection('service')}</> : <section className="commercial-items"><h3>Itens</h3>{model.items.length ? itemsTable(model.items, GENERIC_HEADS) : <p>Sem itens registrados.</p>}{model.hiddenThirdParty > 0 && <p className="commercial-footnote">{model.hiddenThirdParty} item(ns) produzido(s) por terceiros não impresso(s).</p>}{model.quantitySum && <p className="commercial-footnote">Soma das quantidades: {printDecimal(model.quantitySum)}</p>}</section>}
    {model.customFields.length > 0 && <section className="commercial-text commercial-custom-fields"><h3>Campos customizados</h3><dl className="commercial-dates">{model.customFields.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></section>}
    {model.otherItems && <section className="commercial-text commercial-other-items"><h3>Outros itens ou serviços</h3><RichTextView value={model.otherItems.content} /><p className="commercial-footnote">Total outros itens: {model.otherItems.total}</p></section>}
    {model.showTotals && <section className="commercial-totals" aria-label="Totais do documento"><dl>{model.totals.map((row, index) => <div key={row.label} className={index === model.totals.length - 1 ? 'commercial-grand-total' : undefined}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></section>}
    <PublicText title="Condições de pagamento" text={model.paymentTerms} />
    {model.conditionsText && <section className="commercial-text"><h3>Condições comerciais</h3><RichTextView value={model.conditionsText} /></section>}
    {model.installments.length > 0 && model.columns.values && <section className="commercial-installments"><h3>Parcelas planejadas</h3><table><thead><tr><th scope="col">Parcela</th>{model.showDueDates && <th scope="col">{model.dueLabel}</th>}<th scope="col">Forma prevista</th><th scope="col" className="commercial-numeric">Valor</th></tr></thead><tbody>{model.installments.map(row => <tr key={row.position}><td>{row.position}</td>{model.showDueDates && <td>{row.dueDate}</td>}<td>{row.method || 'Não informada'}{row.paymentReference&&<small>{row.paymentReference}</small>}{row.note&&<p className="commercial-line-detail">{row.note}</p>}</td><td className="commercial-numeric">{row.amount}</td></tr>)}</tbody></table><p className="commercial-footnote">Condição comercial prevista. Não constitui boleto, recibo de pagamento ou comprovação de quitação.</p></section>}
    {model.commercial?.transport&&<section className="commercial-text"><h3>Transporte declarado</h3><dl className="commercial-dates">{([['Frete por conta',model.commercial.transport.freightMode],['Quantidade de volumes',model.commercial.transport.volumeCount],['Peso bruto declarado',model.commercial.transport.grossWeight],['Prazo de transporte (dias)',model.commercial.transport.deliveryDays],['Transportador',model.commercial.transport.carrier],['Serviço de transporte',model.commercial.transport.service],['Código de rastreamento',model.commercial.transport.trackingCode]] as const).filter(([,value])=>value!==null&&value!=='').map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>}
    <PublicText title="Entrega / prazo" text={model.deliveryTerms} /><PublicText title={model.serviceGroups ? model.serviceLabels.serviceNotes : 'Observações'} text={model.notes} />
    {model.contactPersons && model.contactPersons.length > 0 && <section className="commercial-text"><h3>Pessoas de contato</h3><ul>{model.contactPersons.map((person, i) => <li key={i}>{[person.name, person.email, person.phone, person.mobile].filter(Boolean).join(' · ')}</li>)}</ul></section>}
    {model.approvalFields && <section className="commercial-text commercial-approval" aria-label="Aprovação do cliente"><p>Data da aprovação: ____/____/________</p><p className="commercial-receipt-sign">Assinatura do cliente: ______________________________</p></section>}
    {model.signature && <p className="commercial-receipt-sign">{model.signature}: ______________________________</p>}
    {model.userSignature && <section className="commercial-user-signature" aria-label="Assinatura">{model.userSignature.greeting && <p>{model.userSignature.greeting}</p>}{model.userSignature.name && <p><strong>{model.userSignature.name}</strong></p>}{model.userSignature.department && <p>{model.userSignature.department}</p>}</section>}
    {model.footer && <p className="commercial-company-footer">{model.footer}</p>}
    <footer className="commercial-footer">{model.title} nº {model.number} · versão {model.version} · Documento comercial sem validade fiscal.</footer>
  </article>;
}

export type PrintVariant = 'normal' | 'receipt' | 'carne' | 'production';
export const PRINT_TITLES: Record<PrintVariant, string> = { normal: 'Prévia para impressão', receipt: 'Comprovante de venda', carne: 'Carnê', production: 'Relatório de produção' };
export type CarrierAddress = { name: string; address: string; city: string; postalCode: string | null } | null;
export type ProductionOptions = { itemNumber: boolean; carrierAddress: boolean; structure: boolean; clientData: boolean; detailedDescription: boolean; location?: boolean };
/**
 * Origin "Relatório de produção" of the pedido de venda (202610200240): the items to separate or produce, with the options of
 * Preferências › Vendas › Configuração de Impressão do Relatório de Produção (número do item, endereço da transportadora, estrutura
 * de itens, dados do cliente, descrição complementar). No values are printed.
 */
export function DocumentProductionSheet({ model, options, carrier }: { model: DocumentPrintModel; options: ProductionOptions; carrier: CarrierAddress }) {
  return <article className="commercial-sheet commercial-production" aria-label={`Relatório de produção ${model.number}`}>
    <header className="commercial-heading"><div><p className="commercial-brand">FAGOO · Relatório de produção</p><h2>Pedido de venda nº {model.number}</h2></div><div className="commercial-identity"><strong>Nº {model.number}</strong><span>Data: {model.date}</span>{model.expectedDate && <span>Data prevista: {model.expectedDate}</span>}</div></header>
    {options.clientData && <section className="commercial-contact"><h3>Cliente</h3><strong>{model.contact.name}</strong>{model.contact.document && <p>CPF / CNPJ: {model.contact.document}</p>}{model.contact.address && <p>{model.contact.address}</p>}{(model.contact.district || model.contact.city) && <p>{[model.contact.district, model.contact.city, model.contact.postalCode ? `CEP ${model.contact.postalCode}` : null].filter(Boolean).join(' · ')}</p>}{model.contact.phones && <p>{model.contact.phones}</p>}</section>}
    {options.carrierAddress && <section className="commercial-contact"><h3>Transportadora</h3>{carrier ? <><strong>{carrier.name}</strong>{carrier.address && <p>{carrier.address}</p>}{carrier.city && <p>{carrier.city}{carrier.postalCode ? ` · CEP ${carrier.postalCode}` : ''}</p>}</> : <p>{model.commercial?.transport?.carrier ?? 'Sem transportadora do cadastro no pedido.'}</p>}</section>}
    <section className="commercial-items"><h3>Itens</h3><table><thead><tr>{options.itemNumber && <th scope="col">Item</th>}<th scope="col">Código</th><th scope="col">Descrição</th><th scope="col">Un.</th><th scope="col" className="commercial-numeric">Quantidade</th>{options.location && <th scope="col">Localização</th>}<th scope="col">Conferido</th></tr></thead>
      <tbody>{model.items.map(item => <tr key={item.position}>{options.itemNumber && <td>{item.position}</td>}<td>{item.code ?? '—'}</td><td>{item.description}{options.detailedDescription && item.detailedDescription && <p className="commercial-line-detail">{item.detailedDescription}</p>}
        {options.structure && item.components.length > 0 && <ul className="commercial-components" aria-label={`Estrutura de ${item.description}`}>{item.components.map((c, i) => <li key={i}>{c.description}{c.code ? ` · ${c.code}` : ''} — {c.quantity} {c.unit ?? ''} ({c.perUnit} por unidade)</li>)}</ul>}</td>
        <td>{item.unit}</td><td className="commercial-numeric">{item.quantity}</td>{options.location && <td>{item.location ?? '—'}</td>}<td>☐</td></tr>)}</tbody></table>
      {model.hiddenThirdParty > 0 && <p className="commercial-footnote">{model.hiddenThirdParty} item(ns) produzido(s) por terceiros não impresso(s).</p>}</section>
    <PublicText title="Observações" text={model.notes} />
    <footer className="commercial-footer">Relatório de produção do pedido nº {model.number} · versão {model.version}. Documento interno, sem valores.</footer>
  </article>;
}

/** Origin "Imprimir comprovante": non-fiscal receipt of the saved version, in A4 or 80 mm. */
export function DocumentReceiptSheet({ model, format }: { model: DocumentPrintModel; format: 'a4' | '80mm' }) {
  const total = model.totals[model.totals.length - 1];
  const receipt = model.receipt, description = (text: string) => receipt.limitDescription && Array.from(text).length > 25 ? Array.from(text).slice(0, 25).join('') : text;
  return <article className={`commercial-sheet commercial-receipt${format === '80mm' ? ' commercial-receipt-80' : ''}`} style={{ fontSize: `${receipt.fontSize}px` }} aria-label={`Comprovante ${model.number}`}>
    <header className="commercial-receipt-head"><strong>{model.company?.tradeName || model.company?.legalName || 'Empresa'}</strong>{model.company && <span>{companyDocumentLabel(model.company.cnpj)}: {model.company.cnpj}</span>}<h2>Comprovante de venda</h2><p className="commercial-fiscal-notice">Não é documento fiscal</p></header>
    <p>{model.title} nº {model.number} · {model.date}</p>
    <p>Cliente: {model.contact.name}{model.contact.document ? ` · ${model.contact.document}` : ''}</p>
    <table className="commercial-receipt-items"><thead><tr><th scope="col">Item</th><th scope="col" className="commercial-numeric">Qtde × Preço</th><th scope="col" className="commercial-numeric">Total</th></tr></thead>
      <tbody>{model.items.map(item => <tr key={item.position}><td>{description(item.description)}{receipt.code && item.code && <small>{item.code}</small>}{receipt.comments && item.detailedDescription && <small>{item.detailedDescription}</small>}{receipt.discount && item.discount !== '0%' && <small>Desconto: {item.discount}</small>}{receipt.location && item.location && <small>Localização: {item.location}</small>}</td><td className="commercial-numeric">{item.quantity} {item.unit} × {item.price}</td><td className="commercial-numeric">{item.total}</td></tr>)}</tbody></table>
    <dl className="commercial-receipt-totals">{model.totals.filter(row => row.value !== 'R$ 0,00' || row === total).map(row => <div key={row.label} className={row === total ? 'commercial-grand-total' : undefined}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    {model.installments.length > 0 && <section><h3>Parcelas</h3><ul className="commercial-receipt-installments">{model.installments.map(row => <li key={row.position}>{row.position}. {row.dueDate} · {row.amount}{row.method ? ` · ${row.method}` : ''}</li>)}</ul></section>}
    {receipt.notes && model.notes && <p>{Array.from(model.notes).slice(0, 100).join('')}</p>}
    <p className="commercial-receipt-sign">Assinatura do cliente: ______________________________</p>
    {receipt.footer && <p className="commercial-footnote">{receipt.footer}</p>}
    <footer className="commercial-footer">Comprovante sem valor fiscal · versão {model.version}.</footer>
  </article>;
}

/** Origin "Imprimir carnê": one slip per planned installment of the saved version. No boleto is generated. */
export function DocumentCarneSheet({ model }: { model: DocumentPrintModel }) {
  if (!model.installments.length) return <article className="commercial-sheet"><p className="document-print-blocked">Este documento não tem parcelas. Gere as parcelas no documento antes de imprimir o carnê.</p></article>;
  return <article className="commercial-sheet commercial-carne" aria-label={`Carnê ${model.number}`}>{model.installments.map(row => <section key={row.position} className="commercial-carne-slip">
    <div className="commercial-carne-stub"><strong>{model.company?.tradeName || model.company?.legalName || 'Empresa'}</strong><span>Parcela {row.position}/{model.installments.length}</span><span>Vencimento: {row.dueDate}</span><span>Valor: {row.amount}</span><span>{model.title} nº {model.number}</span></div>
    <div className="commercial-carne-body"><h3>Carnê de pagamento</h3><p>Pagador: {model.contact.name}{model.contact.document ? ` · ${model.contact.document}` : ''}</p>
      <dl className="commercial-dates"><div><dt>Parcela</dt><dd>{row.position}/{model.installments.length}</dd></div><div><dt>Vencimento</dt><dd>{row.dueDate}</dd></div><div><dt>Valor</dt><dd>{row.amount}</dd></div>{row.method && <div><dt>Forma</dt><dd>{row.method}</dd></div>}</dl>
      <p className="commercial-footnote">Documento de controle de parcelas, sem código de barras e sem valor de boleto. Recebido em ____/____/______ por ______________________</p></div>
  </section>)}</article>;
}

export default function DocumentPrintPreview({ record, controller, onClose, variant = 'normal', options = {} }: { record: DocumentRecord; controller:CompanyController; onClose: () => void; variant?: PrintVariant; options?: PrintOptions }) {
  const [format, setFormat] = useState<'a4' | '80mm'>('a4');
  const dialog = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose);
  const [printError, setPrintError] = useState(false);
  const [company,setCompany]=useState<CompanyRecord|null>(null);const [companyState,setCompanyState]=useState<'loading'|'ready'|'error'>('loading');const [companyReload,setCompanyReload]=useState(0);
  onCloseRef.current = onClose;
  const [portal] = useState(() => { const node = document.createElement('div'); node.className = 'document-print-root'; return node; });
  const lookup = useSupplierCodes(controller, [record], options.prefs), codes = lookup.codes[record.id];
  const production: ProductionOptions | null = variant === 'production' ? options.prefs?.production ?? { itemNumber: false, carrierAddress: false, structure: false, clientData: false, detailedDescription: false } : null;
  const structures = useDocumentStructures(controller, [record], Boolean(production?.structure || options.explode || options.hideThirdParty));
  const [persons, setPersons] = useState<{ name: string; email: string | null; phone: string | null; mobile: string | null }[] | null>(null);
  // The carrier read of the Relatório de produção, by carrier id (null value: not found or not readable); the print waits for it.
  const [carrierRead, setCarrierRead] = useState<{ id: string; value: CarrierAddress } | null>(null);
  const wantsPersons = record.kind === 'service_orders' && Boolean(options.prefs?.contactPersons) && variant === 'normal';
  const catalogPort = controller as unknown as { catalog?: (path: string, options?: { signal?: AbortSignal }) => Promise<unknown> };
  useEffect(() => {
    if (!wantsPersons || typeof catalogPort.catalog !== 'function') return; const request = new AbortController(), id = record.contact_id;
    void catalogPort.catalog(`/v1/cadastros/contatos/${id}/resumo`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return; const summary = contactSummary(value, id);
      setPersons(summary ? summary.persons.filter(person => person.visible).map(person => ({ name: person.name, email: person.email, phone: person.phone, mobile: person.mobile })) : []);
    }).catch(() => { if (!request.signal.aborted) setPersons([]); });
    return () => request.abort();
  }, [controller, record.contact_id, wantsPersons]);
  const carrierId = typeof record.carrier_id === 'string' ? record.carrier_id : null;
  useEffect(() => {
    if (!production?.carrierAddress || !carrierId || typeof catalogPort.catalog !== 'function') return; const request = new AbortController();
    // A failed read keeps the name saved with the pedido (no address).
    const nameOnly: CarrierAddress = record.carrier_name ? { name: record.carrier_name, address: '', city: '', postalCode: null } : null;
    void catalogPort.catalog(`/v1/cadastros/contatos/${carrierId}`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return; const c = (value as { record?: Record<string, unknown> } | null)?.record;
      if (!c || c.id !== carrierId) { setCarrierRead({ id: carrierId, value: nameOnly }); return; }
      const t = (key: string) => typeof c[key] === 'string' && (c[key] as string).trim() ? c[key] as string : null;
      setCarrierRead({ id: carrierId, value: { name: t('name') ?? record.carrier_name ?? 'Transportadora', address: [t('street'), t('number'), t('complement'), t('district')].filter(Boolean).join(', '), city: [t('city'), t('state')].filter(Boolean).join(' / '), postalCode: t('postal_code') } });
    }).catch(() => { if (!request.signal.aborted) setCarrierRead({ id: carrierId, value: nameOnly }); });
    return () => request.abort();
  }, [controller, carrierId, production?.carrierAddress]);
  const structureRows = structures.structures[record.id] ?? null;
  // 202610200270 "Exibir tipo de cabeçalho: Personalizado" (the normal print; the comprovante, carnê and produção keep their layout).
  const header = usePrintHeader(controller, record.kind, options.prefs?.headerType === 'personalizado' && variant === 'normal');
  // 202610200294: the images of the products (detailed sales print, proposals) and the descriptions at the supplier.
  const extras = usePrintExtras(controller, record, { images: variant === 'normal' && Boolean(options.prefs?.images) && (record.kind === 'sales_proposals' || options.detailed === true),
    descriptions: variant === 'normal' && Boolean(options.prefs?.supplierDescription) });
  const model = useMemo(() => { try { return documentPrintModel(record,company,{ ...options, ...(codes ? { supplierCodes: codes } : {}), structures: structureRows, contactPersons: persons, customHeader: header.header, images: extras.images, supplierDescriptions: extras.descriptions }); } catch { return null; } }, [record,company,options.detailed,options.order,options.prefs,options.labels,options.technician,options.userSignature,options.explode,options.hideThirdParty,options.customFields,codes,structureRows,persons,header.header,extras.images,extras.descriptions]);
  const carrierWanted = Boolean(production?.carrierAddress && carrierId && typeof catalogPort.catalog === 'function');
  const carrier = carrierWanted && carrierRead?.id === carrierId ? carrierRead.value : null;
  const waiting = lookup.loading || structures.loading || header.loading || extras.loading || (wantsPersons && persons === null && typeof catalogPort.catalog === 'function') || (carrierWanted && carrierRead?.id !== carrierId);
  useEffect(()=>{const request=new AbortController();setCompanyState('loading');setCompany(null);void controller.company('/v1/empresa/identidade',{signal:request.signal}).then(value=>{
    const response=value as CompanyEnvelope<CompanyRecord>;
    if(!response||response.section!=='identity'||response.data_mode!=='erp_native'||response.emission_enabled!==false||response.record===undefined)throw new Error('PRINT_COMPANY_RESPONSE_INVALID');
    if(response.record!==null&&(!response.record||typeof response.record!=='object'||!Number.isInteger(response.record.version)||!response.record.data))throw new Error('PRINT_COMPANY_RESPONSE_INVALID');
    if(!request.signal.aborted){setCompany(response.record);setCompanyState('ready');}
  }).catch(()=>{if(!request.signal.aborted)setCompanyState('error');});return()=>request.abort();},[controller,companyReload]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow, siorigins = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== portal).map(element => ({ element, inert: element.inert }));
    document.body.append(portal); document.body.style.overflow = 'hidden'; document.body.classList.add('document-print-open');
    for (const { element } of siorigins) element.inert = true;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const fields = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),[tabindex="0"]') || []), first = fields[0], last = fields.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); for (const { element, inert } of siorigins) element.inert = inert; document.body.style.overflow = overflow; document.body.classList.remove('document-print-open'); portal.remove(); if (previous?.isConnected) previous.focus(); };
  }, [portal]);
  return createPortal(<div className="document-print-dialog" role="dialog" aria-modal="true" aria-labelledby="document-print-title" ref={dialog}>
    <header className="document-print-controls"><div><h2 id="document-print-title">{PRINT_TITLES[variant]}</h2><p>Versão salva do documento com a identificação atual da empresa. Observações internas, regime fiscal e anexos não são impressos.</p></div><div>{variant === 'receipt' && <span className="document-print-format" role="group" aria-label="Formato do comprovante">{(['a4', '80mm'] as const).map(value => <button type="button" key={value} className="secondary-button" aria-pressed={format === value} onClick={() => setFormat(value)}>{value === 'a4' ? 'A4' : '80 mm'}</button>)}</span>}<button type="button" className="secondary-button" ref={close} onClick={onClose}>Fechar prévia</button><button type="button" className="primary-button" disabled={!model||companyState!=='ready'||waiting} onClick={() => { setPrintError(false); try { window.print(); } catch { setPrintError(true); } }}>Imprimir documento</button></div></header>
    {companyState==='loading'&&<p className="document-print-error" role="status">Consultando identificação da empresa…</p>}{companyState==='error'&&<p className="document-print-error" role="alert">Não foi possível conferir a identificação da empresa. <button type="button" onClick={()=>setCompanyReload(value=>value+1)}>Tentar novamente</button></p>}
    {lookup.loading && <p className="document-print-error" role="status">Consultando os códigos no fornecedor…</p>}
    {structures.loading && <p className="document-print-error" role="status">Consultando a estrutura dos produtos…</p>}
    {header.loading && <p className="document-print-error" role="status">Consultando o cabeçalho personalizado…</p>}{header.failed && <p className="document-print-error" role="status">Não foi possível consultar o cabeçalho personalizado; o documento sai com o cabeçalho padrão.</p>}
    {carrierWanted && carrierRead?.id !== carrierId && <p className="document-print-error" role="status">Consultando o endereço da transportadora…</p>}
    {structures.failed > 0 && <p className="document-print-error" role="status">Não foi possível consultar a estrutura dos produtos; o documento sai sem ela.</p>}
    {printError && <p className="document-print-error" role="alert">Não foi possível abrir a impressão. Confira as permissões do navegador e tente novamente.</p>}
    <div className="document-print-scroll" tabIndex={0} aria-label="Documento para impressão">{companyState!=='ready'?<p className="document-print-blocked">Documento indisponível para impressão: a identificação da empresa ainda não foi conferida.</p>:model ? variant === 'receipt' ? <DocumentReceiptSheet model={model} format={format} /> : variant === 'carne' ? <DocumentCarneSheet model={model} /> : variant === 'production' && production ? <DocumentProductionSheet model={model} options={production} carrier={carrier} /> : <DocumentPrintSheet model={model} /> : <p className="document-print-blocked" role="alert">Não foi possível conferir os valores desta versão. Feche a prévia e reabra o documento antes de imprimir.</p>}</div>
  </div>, portal);
}
