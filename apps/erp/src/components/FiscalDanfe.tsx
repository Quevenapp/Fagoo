import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { barRuns, code128, qrMatrix } from '../lib/barcodes';
import {
  FREIGHT_LABEL, brMoney, brNumber, danfePages, formatDocument, formatKey, formatPostal, fullAddress, itemCst, noteNumber, xmlDate, xmlTime, type DanfeData, type DanfeItem, type DanfeSettings,
} from '../lib/danfe';
import { danfePdf, danfePdfName } from '../lib/danfe-pdf';
import { saveFile } from '../lib/fiscal-invoice-xml';
import './fiscal-danfe.css';

// DANFE impresso pelo Brufap a partir do XML autorizado (acervo do Origin ou XML importado), no leiaute do Manual de Orientação do
// Contribuinte: DANFE retrato A4, DANFE Simplificado (etiqueta) e DANFE NFC-e (bobina de 80 mm). Somente leitura: nada é transmitido
// nem gravado, e a situação da nota não muda. Notas de homologação saem com "SEM VALOR FISCAL".
export type DanfeLayout = 'a4' | 'simple' | 'nfce';
export interface DanfeDocument { data: DanfeData; status: 'cancelled' | 'denied' | null }

function Barcode({ value, height = 38 }: { value: string; height?: number }) {
  const bits = code128(value);
  if (!bits) return <p className="danfe-small">{formatKey(value)}</p>;
  return <svg className="danfe-barcode" viewBox={`0 0 ${bits.length} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Código de barras da chave ${value}`}>
    {barRuns(bits).map(([x, w]) => <rect key={x} x={x} y={0} width={w} height={height} />)}</svg>;
}
function QrCode({ value }: { value: string }) {
  const matrix = qrMatrix(value);
  if (!matrix) return <p className="danfe-small">Consulte pela chave de acesso.</p>;
  const size = matrix.length + 8;
  return <svg className="danfe-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR Code da NFC-e"><rect x={0} y={0} width={size} height={size} fill="#fff" />
    {matrix.flatMap((row, y) => row.map((dark, x) => dark ? <rect key={`${x}-${y}`} x={x + 4} y={y + 4} width={1} height={1} /> : null))}</svg>;
}
const Box = ({ label, children, className = '' }: { label: string; children?: ReactNode; className?: string }) =>
  <div className={`danfe-box ${className}`}><span className="danfe-label">{label}</span><span className="danfe-value">{children}</span></div>;
const stateMark = (doc: DanfeDocument) => doc.data.environment === '2' ? 'SEM VALOR FISCAL' : doc.status === 'cancelled' ? 'CANCELADA' : doc.status === 'denied' ? 'DENEGADA' : !doc.data.protocol ? 'SEM PROTOCOLO' : null;
const homologation = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL';
const issuerName = (d: DanfeData) => d.issuer.name ?? '';
const protocolText = (d: DanfeData) => d.protocol ? `${d.protocol.number} - ${xmlDate(d.protocol.received_at)} ${xmlTime(d.protocol.received_at)}` : 'Sem protocolo de autorização no XML';

function Header({ d, page, pages }: { d: DanfeData; page: number; pages: number }) {
  const a = d.issuer.address;
  return <section className="danfe-header">
    <div className="danfe-issuer"><span className="danfe-label">IDENTIFICAÇÃO DO EMITENTE</span><strong>{issuerName(d)}</strong>
      <span>{fullAddress(a)}</span><span>{[a.district, formatPostal(a.postal_code)].filter(Boolean).join(' - ')}</span><span>{[a.city, a.state].filter(Boolean).join(' - ')}{a.phone ? ` · Fone: ${a.phone}` : ''}</span></div>
    <div className="danfe-title"><strong className="danfe-big">DANFE</strong><span>Documento Auxiliar da Nota Fiscal Eletrônica</span>
      <span className="danfe-operation"><span>0 - ENTRADA<br />1 - SAÍDA</span><b>{d.operation}</b></span>
      <strong>Nº {noteNumber(d.number)}</strong><strong>SÉRIE {d.series.padStart(3, '0')}</strong><span>FOLHA {page}/{pages}</span></div>
    <div className="danfe-keybox"><Barcode value={d.key} /><Box label="CHAVE DE ACESSO"><span className="danfe-key">{formatKey(d.key)}</span></Box>
      <p className="danfe-small">Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora</p></div>
  </section>;
}
function ItemsTable({ items, simples }: { items: readonly DanfeItem[]; simples: boolean }) {
  return <table className="danfe-items"><thead><tr><th>CÓDIGO PRODUTO</th><th>DESCRIÇÃO DO PRODUTO / SERVIÇO</th><th>NCM/SH</th><th>{simples ? 'O/CSOSN' : 'O/CST'}</th><th>CFOP</th><th>UN</th>
    <th className="numeric">QUANT.</th><th className="numeric">VALOR UNIT.</th><th className="numeric">VALOR TOTAL</th><th className="numeric">VALOR DESC.</th><th className="numeric">B.CÁLC. ICMS</th><th className="numeric">VALOR ICMS</th>
    <th className="numeric">VALOR IPI</th><th className="numeric">ALÍQ. ICMS</th><th className="numeric">ALÍQ. IPI</th></tr></thead>
    <tbody>{items.map(item => <tr key={item.position}><td>{item.code}</td><td>{item.description}{item.info ? <span className="danfe-item-info">{item.info}</span> : null}</td><td>{item.ncm}</td><td>{itemCst(item)}</td>
      <td>{item.cfop}</td><td>{item.unit}</td><td className="numeric">{brNumber(item.quantity, 2, 4)}</td><td className="numeric">{brNumber(item.unit_price, 2, 10)}</td><td className="numeric">{brMoney(item.total)}</td>
      <td className="numeric">{item.discount ? brMoney(item.discount) : ''}</td><td className="numeric">{item.bc_icms ? brMoney(item.bc_icms) : ''}</td><td className="numeric">{item.icms ? brMoney(item.icms) : ''}</td>
      <td className="numeric">{item.ipi ? brMoney(item.ipi) : ''}</td><td className="numeric">{item.icms_rate ? brNumber(item.icms_rate, 2, 4) : ''}</td><td className="numeric">{item.ipi_rate ? brNumber(item.ipi_rate, 2, 4) : ''}</td></tr>)}</tbody></table>;
}
/** DANFE retrato A4 (MOC, Anexo II): canhoto, cabeçalho, destinatário, fatura, cálculo do imposto, transporte, produtos e dados adicionais. */
export function DanfeA4({ doc, settings }: { doc: DanfeDocument; settings: DanfeSettings }) {
  const d = doc.data, r = d.recipient, t = d.totals, pages = danfePages(d.items, settings), mark = stateMark(doc), simples = ['1', '2', '4'].includes(d.issuer.crt ?? '');
  const tr = d.transport, vol = tr.volumes, sum = (key: 'net_weight' | 'gross_weight') => vol.length === 1 ? vol[0]![key] : null;
  const extra = [d.additional.fiscal ? `Inf. fisco: ${d.additional.fiscal}` : null, d.additional.complementary, d.delivery ? `Local de entrega: ${[d.delivery.name, fullAddress(d.delivery), d.delivery.district, d.delivery.city, d.delivery.state].filter(Boolean).join(', ')}` : null,
    d.contingency ? `DANFE em contingência${d.contingency.at ? ` desde ${xmlDate(d.contingency.at)} ${xmlTime(d.contingency.at)}` : ''}${d.contingency.reason ? `: ${d.contingency.reason}` : ''}` : null].filter(Boolean) as string[];
  return <>{pages.map((items, index) => <article key={index} className="danfe-page" aria-label={`DANFE da nota ${d.number}, folha ${index + 1} de ${pages.length}`}>
    {mark && <div className="danfe-watermark" aria-hidden="true">{mark}</div>}
    {d.environment === '2' && <p className="danfe-homologation">{homologation}</p>}
    {index === 0 && <section className="danfe-canhoto">
      <div className="danfe-canhoto-text"><span className="danfe-label">RECEBEMOS DE {issuerName(d).toUpperCase()} OS PRODUTOS/SERVIÇOS CONSTANTES DA NOTA FISCAL INDICADA AO LADO. EMISSÃO: {xmlDate(d.issued_at)} · DEST/REM: {r?.name ?? ''} · VALOR TOTAL: R$ {brMoney(t.vNF)}</span>
        <div className="danfe-row"><Box label="DATA DE RECEBIMENTO" className="danfe-w25" /><Box label="IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR" className="danfe-grow" /></div></div>
      <div className="danfe-canhoto-number"><strong>NF-e</strong><span>Nº {noteNumber(d.number)}</span><span>SÉRIE {d.series.padStart(3, '0')}</span></div>
    </section>}
    <Header d={d} page={index + 1} pages={pages.length} />
    <div className="danfe-row"><Box label="NATUREZA DA OPERAÇÃO" className="danfe-grow">{d.nature}</Box><Box label="PROTOCOLO DE AUTORIZAÇÃO DE USO" className="danfe-w40">{protocolText(d)}</Box></div>
    <div className="danfe-row"><Box label="INSCRIÇÃO ESTADUAL" className="danfe-grow">{d.issuer.ie}</Box><Box label="INSCRIÇÃO ESTADUAL DO SUBST. TRIBUT." className="danfe-grow">{d.issuer.ie_st}</Box><Box label="CNPJ / CPF" className="danfe-grow">{formatDocument(d.issuer.document)}</Box></div>
    {index === 0 && <>
      <h3 className="danfe-section">DESTINATÁRIO / REMETENTE</h3>
      <div className="danfe-row"><Box label="NOME / RAZÃO SOCIAL" className="danfe-grow">{r?.name}</Box><Box label="CNPJ / CPF" className="danfe-w20">{formatDocument(r?.document ?? null) || r?.foreign_id}</Box><Box label="DATA DA EMISSÃO" className="danfe-w15">{xmlDate(d.issued_at)}</Box></div>
      <div className="danfe-row"><Box label="ENDEREÇO" className="danfe-grow">{r ? fullAddress(r.address) : ''}</Box><Box label="BAIRRO / DISTRITO" className="danfe-w20">{r?.address.district}</Box><Box label="CEP" className="danfe-w10">{formatPostal(r?.address.postal_code ?? null)}</Box>
        <Box label="DATA DA SAÍDA/ENTRADA" className="danfe-w15">{xmlDate(d.departure_at)}</Box></div>
      <div className="danfe-row"><Box label="MUNICÍPIO" className="danfe-grow">{r?.address.city}</Box><Box label="UF" className="danfe-w5">{r?.address.state}</Box><Box label="FONE / FAX" className="danfe-w15">{r?.address.phone}</Box>
        <Box label="INSCRIÇÃO ESTADUAL" className="danfe-w15">{r?.ie}</Box><Box label="HORA DA SAÍDA/ENTRADA" className="danfe-w15">{xmlTime(d.departure_at)}</Box></div>
      <h3 className="danfe-section">FATURA / DUPLICATAS</h3>
      <div className="danfe-row danfe-wrap">{d.billing.duplicates.length ? d.billing.duplicates.map((dup, n) => <Box key={n} label={`Nº ${dup.number ?? n + 1}`} className="danfe-w15"><span>Venc. {xmlDate(dup.due)}</span><span>R$ {brMoney(dup.amount)}</span></Box>)
        : d.payments.map((p, n) => <Box key={n} label={p.indicator === '1' ? 'PAGAMENTO A PRAZO' : 'PAGAMENTO À VISTA'} className="danfe-w25">{p.description ?? p.type} · R$ {brMoney(p.amount)}</Box>)}</div>
      <h3 className="danfe-section">CÁLCULO DO IMPOSTO</h3>
      <div className="danfe-row danfe-numbers">{([['BASE DE CÁLC. DO ICMS', t.vBC], ['VALOR DO ICMS', t.vICMS], ['BASE DE CÁLC. ICMS S.T.', t.vBCST], ['VALOR DO ICMS SUBST.', t.vST], ['V. IMP. IMPORTAÇÃO', t.vII],
        ['V. ICMS UF REMET.', t.vICMSUFRemet], ['V. FCP UF DEST.', t.vFCPUFDest], ['V. PIS', t.vPIS], ['V. TOTAL PRODUTOS', t.vProd]] as const).map(([label, value]) => <Box key={label} label={label} className="danfe-grow">{brMoney(value)}</Box>)}</div>
      <div className="danfe-row danfe-numbers">{([['VALOR DO FRETE', t.vFrete], ['VALOR DO SEGURO', t.vSeg], ['DESCONTO', t.vDesc], ['OUTRAS DESPESAS', t.vOutro], ['VALOR TOTAL IPI', t.vIPI], ['V. ICMS UF DEST.', t.vICMSUFDest],
        ['V. TOT. TRIB.', t.vTotTrib], ['V. COFINS', t.vCOFINS], ['V. TOTAL DA NOTA', t.vNF]] as const).map(([label, value]) => <Box key={label} label={label} className="danfe-grow">{brMoney(value)}</Box>)}</div>
      <h3 className="danfe-section">TRANSPORTADOR / VOLUMES TRANSPORTADOS</h3>
      <div className="danfe-row"><Box label="NOME / RAZÃO SOCIAL" className="danfe-grow">{tr.carrier?.name}</Box><Box label="FRETE POR CONTA" className="danfe-w20">{FREIGHT_LABEL[tr.mode ?? ''] ?? tr.mode}</Box><Box label="CÓDIGO ANTT" className="danfe-w10">{tr.vehicle?.rntc}</Box>
        <Box label="PLACA DO VEÍCULO" className="danfe-w10">{tr.vehicle?.plate}</Box><Box label="UF" className="danfe-w5">{tr.vehicle?.state}</Box><Box label="CNPJ / CPF" className="danfe-w15">{formatDocument(tr.carrier?.document ?? null)}</Box></div>
      <div className="danfe-row"><Box label="ENDEREÇO" className="danfe-grow">{tr.carrier?.address}</Box><Box label="MUNICÍPIO" className="danfe-w20">{tr.carrier?.city}</Box><Box label="UF" className="danfe-w5">{tr.carrier?.state}</Box><Box label="INSCRIÇÃO ESTADUAL" className="danfe-w15">{tr.carrier?.ie}</Box></div>
      <div className="danfe-row"><Box label="QUANTIDADE" className="danfe-w10">{vol.length === 1 ? vol[0]!.quantity : vol.length ? String(vol.length) : ''}</Box><Box label="ESPÉCIE" className="danfe-grow">{vol[0]?.species}</Box><Box label="MARCA" className="danfe-grow">{vol[0]?.brand}</Box>
        <Box label="NUMERAÇÃO" className="danfe-grow">{vol[0]?.numbering}</Box><Box label="PESO BRUTO" className="danfe-w15">{brNumber(sum('gross_weight'), 3, 3)}</Box><Box label="PESO LÍQUIDO" className="danfe-w15">{brNumber(sum('net_weight'), 3, 3)}</Box></div>
    </>}
    <h3 className="danfe-section">DADOS DOS PRODUTOS / SERVIÇOS</h3>
    <ItemsTable items={items} simples={simples} />
    {index === 0 && <><h3 className="danfe-section">DADOS ADICIONAIS</h3>
      <div className="danfe-row danfe-additional"><Box label="INFORMAÇÕES COMPLEMENTARES" className="danfe-grow">{extra.map((text, n) => <span key={n} className="danfe-paragraph">{text}</span>)}</Box><Box label="RESERVADO AO FISCO" className="danfe-w30" /></div></>}
  </article>)}</>;
}
/** DANFE Simplificado - Etiqueta: chave, protocolo, número, emitente e destinatário; valor total e produtos conforme as preferências. */
export function DanfeSimplified({ doc, settings }: { doc: DanfeDocument; settings: DanfeSettings }) {
  const d = doc.data, r = d.recipient, mark = stateMark(doc);
  return <article className="danfe-label-page" aria-label={`DANFE Simplificado da nota ${d.number}`}>
    {mark && <div className="danfe-watermark" aria-hidden="true">{mark}</div>}
    <h2 className="danfe-label-title">DANFE SIMPLIFICADO - ETIQUETA</h2>
    {d.environment === '2' && <p className="danfe-homologation">{homologation}</p>}
    <Barcode value={d.key} height={30} />
    <Box label="CHAVE DE ACESSO"><span className="danfe-key">{formatKey(d.key)}</span></Box>
    <Box label="PROTOCOLO DE AUTORIZAÇÃO">{protocolText(d)}</Box>
    <div className="danfe-row"><Box label="NÚMERO" className="danfe-grow">{noteNumber(d.number)}</Box><Box label="SÉRIE" className="danfe-grow">{d.series}</Box><Box label="EMISSÃO" className="danfe-grow">{xmlDate(d.issued_at)}</Box>
      <Box label="TIPO" className="danfe-grow">{d.operation === '0' ? '0 - Entrada' : '1 - Saída'}</Box></div>
    <Box label="EMITENTE"><strong>{d.issuer.name}</strong><span>CNPJ/CPF {formatDocument(d.issuer.document)} · IE {d.issuer.ie ?? ''} · UF {d.issuer.address.state ?? ''}</span></Box>
    <Box label="DESTINATÁRIO"><strong>{r?.name}</strong><span>CNPJ/CPF {formatDocument(r?.document ?? null) || r?.foreign_id || ''} · IE {r?.ie ?? ''} · UF {r?.address.state ?? ''}</span></Box>
    {settings.simplifiedTotal && <Box label="VALOR TOTAL DA NOTA">R$ {brMoney(d.totals.vNF)}</Box>}
    {settings.simplifiedProducts && <table className="danfe-items danfe-label-items"><thead><tr><th>CÓDIGO</th><th>DESCRIÇÃO</th><th className="numeric">QUANT.</th><th>UN</th><th className="numeric">VALOR</th></tr></thead>
      <tbody>{d.items.map(item => <tr key={item.position}><td>{item.code}</td><td>{item.description}</td><td className="numeric">{brNumber(item.quantity, 2, 4)}</td><td>{item.unit}</td><td className="numeric">{brMoney(item.total)}</td></tr>)}</tbody></table>}
  </article>;
}
const groups = (key: string) => key.match(/\d{4}/g)!.join(' ');
/** DANFE NFC-e (bobina de 80 mm): divisões I a IX do Manual de Especificações Técnicas do DANFE NFC-e e QR Code. */
export function DanfeNfce({ doc }: { doc: DanfeDocument }) {
  const d = doc.data, t = d.totals, a = d.issuer.address, r = d.recipient, mark = stateMark(doc);
  // Acréscimos in exact cents; a value outside the XML decimal pattern counts as zero instead of breaking the preview.
  const cents = (value: string | null | undefined) => value && /^\d{1,13}\.\d{2}$/.test(value) ? BigInt(value.replace('.', '')) : 0n;
  const extras = ['vFrete', 'vSeg', 'vOutro'].reduce((sum, k) => sum + cents(t[k]), 0n);
  const extraText = `${extras / 100n}.${String(extras % 100n).padStart(2, '0')}`;
  return <article className="danfe-nfce" aria-label={`DANFE NFC-e da nota ${d.number}`}>
    {mark && <p className="danfe-nfce-mark">{mark}</p>}
    <header className="danfe-nfce-center"><strong>{d.issuer.name}</strong><span>CNPJ: {formatDocument(d.issuer.document)}{d.issuer.ie ? ` · IE: ${d.issuer.ie}` : ''}</span>
      <span>{[fullAddress(a), a.district, a.city, a.state].filter(Boolean).join(', ')}</span><strong>Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</strong></header>
    <table className="danfe-nfce-items"><thead><tr><th>Código</th><th>Descrição</th><th className="numeric">Qtde</th><th>UN</th><th className="numeric">Vl Unit</th><th className="numeric">Vl Total</th></tr></thead>
      <tbody>{d.items.map(item => <tr key={item.position}><td>{item.code}</td><td>{item.description}</td><td className="numeric">{brNumber(item.quantity, 0, 4)}</td><td>{item.unit}</td><td className="numeric">{brNumber(item.unit_price, 2, 10)}</td><td className="numeric">{brMoney(item.total)}</td></tr>)}</tbody></table>
    <dl className="danfe-nfce-totals"><div><dt>Qtde. total de itens</dt><dd>{d.items.length}</dd></div><div><dt>Valor total R$</dt><dd>{brMoney(t.vProd)}</dd></div>
      {t.vDesc && t.vDesc !== '0.00' && <div><dt>Desconto R$</dt><dd>{brMoney(t.vDesc)}</dd></div>}{extras > 0n && <div><dt>Acréscimos R$</dt><dd>{brMoney(extraText)}</dd></div>}
      <div className="danfe-nfce-strong"><dt>Valor a Pagar R$</dt><dd>{brMoney(t.vNF)}</dd></div>
      <div className="danfe-nfce-head"><dt>FORMA PAGAMENTO</dt><dd>VALOR PAGO R$</dd></div>
      {d.payments.map((p, n) => <div key={n}><dt>{p.description ?? p.type}</dt><dd>{brMoney(p.amount)}</dd></div>)}
      {d.change && d.change !== '0.00' && <div><dt>Troco R$</dt><dd>{brMoney(d.change)}</dd></div>}</dl>
    {d.environment === '2' && <p className="danfe-nfce-center danfe-nfce-strong">EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL</p>}
    {d.emission_type === '9' && <p className="danfe-nfce-center danfe-nfce-strong">EMITIDA EM CONTINGÊNCIA<br />Pendente de autorização</p>}
    <p className="danfe-nfce-center">Consulte pela Chave de Acesso em<br />{d.consultation ?? 'o portal da SEFAZ autorizadora'}<br /><span className="danfe-key">{groups(d.key)}</span></p>
    <p className="danfe-nfce-center">{r?.document || r?.foreign_id ? <>CONSUMIDOR - {r.document ? (r.document.length === 11 ? 'CPF' : 'CNPJ') : 'ID ESTRANGEIRO'} {formatDocument(r.document) || r.foreign_id}{r.name ? ` - ${r.name}` : ''}{fullAddress(r.address) ? <><br />{[fullAddress(r.address), r.address.district, r.address.city, r.address.state].filter(Boolean).join(', ')}</> : null}</> : 'CONSUMIDOR NÃO IDENTIFICADO'}</p>
    <p className="danfe-nfce-center"><strong>NFC-e nº {d.number.padStart(9, '0')} Série {d.series.padStart(3, '0')} {xmlDate(d.issued_at)} {xmlTime(d.issued_at)}</strong>
      {d.protocol ? <><br />Protocolo de autorização: {d.protocol.number}<br />Data de autorização: {xmlDate(d.protocol.received_at)} {xmlTime(d.protocol.received_at)}</> : <><br />Sem protocolo de autorização no XML</>}</p>
    {d.qr ? <div className="danfe-nfce-center"><QrCode value={d.qr} /></div> : <p className="danfe-nfce-center">QR Code ausente no XML.</p>}
    {d.additional.complementary && <p className="danfe-nfce-info">{d.additional.complementary}</p>}
    {d.total_tax && <p className="danfe-nfce-info">Tributos Totais Incidentes (Lei Federal 12.741/2012): R$ {brMoney(d.total_tax)}</p>}
  </article>;
}

/**
 * Prévia de impressão de um ou mais DANFEs (Imprimir DANFE, Imprimir NF-es selecionadas, DANFE Simplificado em lote, Gerar PDF DANFE).
 * O resto da página fica escondido só enquanto a prévia está aberta; "Imprimir" abre a impressão do navegador (que também salva em PDF).
 */
export default function FiscalDanfePrint({ title, layout, documents, settings, progress, problems = [], pdf = false, onClose }: {
  title: string; layout: DanfeLayout; documents: readonly DanfeDocument[]; settings: DanfeSettings; progress?: string; problems?: readonly string[]; pdf?: boolean; onClose: () => void;
}) {
  const [portal] = useState(() => typeof document === 'undefined' ? null : Object.assign(document.createElement('div'), { className: `fiscal-print-root danfe-root danfe-root-${layout}` }));
  const [failed, setFailed] = useState(false), [pdfError, setPdfError] = useState(''), [saved, setSaved] = useState(''), closeRef = useRef(onClose);
  // "Gerar PDF DANFE": the PDF file of the DANFE retrato A4 of every note read, built in the browser.
  const downloadPdf = () => {
    setPdfError(''); setSaved('');
    try { saveFile(danfePdfName(documents), danfePdf(documents, settings) as Uint8Array<ArrayBuffer>, 'application/pdf'); setSaved(`PDF gerado com ${documents.length} DANFE(s).`); }
    catch { setPdfError('Não foi possível gerar o PDF do DANFE.'); }
  };
  closeRef.current = onClose;
  useEffect(() => {
    if (!portal) return;
    document.body.append(portal); document.body.classList.add('fiscal-print-open', `danfe-print-${layout}`);
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.classList.remove('fiscal-print-open', `danfe-print-${layout}`); portal.remove(); };
  }, [portal, layout]);
  const content = <div className="fiscal-print-dialog danfe-dialog" role="dialog" aria-modal="true" aria-label={title}>
    <header className="fiscal-print-controls"><div><h2>{title}</h2>{progress && <p role="status">{progress}</p>}
      {pdf && <p className="real-help">O PDF do DANFE é gerado no navegador a partir do XML autorizado de cada nota.</p>}{saved && <p className="real-success" role="status">{saved}</p>}</div>
      <div><button type="button" className="secondary-button" onClick={onClose}>Fechar prévia</button>
        {pdf && layout === 'a4' && <button type="button" className="primary-button" disabled={!documents.length || Boolean(progress)} onClick={downloadPdf}>Baixar PDF</button>}
        <button type="button" className={pdf ? 'secondary-button' : 'primary-button'} disabled={!documents.length || Boolean(progress)} onClick={() => { setFailed(false); try { globalThis.window?.print(); } catch { setFailed(true); } }}>Imprimir</button></div></header>
    {pdfError && <p className="real-alert" role="alert">{pdfError}</p>}
    {failed && <p className="real-alert" role="alert">O navegador não abriu a impressão. Tente novamente.</p>}
    {problems.length > 0 && <div className="real-alert" role="alert"><p>Fora da impressão:</p><ul>{problems.map((p, n) => <li key={n}>{p}</li>)}</ul></div>}
    <div className={`danfe-sheets danfe-sheets-${layout}`}>{documents.map(doc => layout === 'a4' ? <DanfeA4 key={doc.data.key} doc={doc} settings={settings} />
      : layout === 'simple' ? <DanfeSimplified key={doc.data.key} doc={doc} settings={settings} /> : <DanfeNfce key={doc.data.key} doc={doc} />)}</div>
  </div>;
  return portal ? createPortal(content, portal) : content;
}
