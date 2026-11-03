// "Gerar PDF DANFE" (notas fiscais lane, wave E): the DANFE retrato A4 of one or more notes as a PDF file, drawn from the same XML
// data as the printed DANFE (lib/danfe.ts) with the minimal writer of lib/pdf-writer.ts. Nothing is transmitted or saved on a server.
import { code128 } from './barcodes.ts';
import { FREIGHT_LABEL, brMoney, brNumber, formatDocument, formatKey, formatPostal, fullAddress, itemCst, noteNumber, xmlDate, xmlTime, type DanfeData, type DanfeItem, type DanfeSettings } from './danfe.ts';
import { PdfPage, pdfDocument, textWidth, wrapText, type PdfFont } from './pdf-writer.ts';

export interface DanfePdfDocument { data: DanfeData; status: 'cancelled' | 'denied' | null }
const LEFT = 5, WIDTH = 200, RIGHT = LEFT + WIDTH, PAGE_BOTTOM = 292;
const LABEL = 4.6, VALUE = 7;
type Cell = { label: string; value: string; width: number; align?: 'left' | 'right'; font?: PdfFont; size?: number };
/** Fits a value on one line of `width` mm, cutting it with "…" when longer. */
function fit(text: string, width: number, size: number, font: PdfFont = 'regular'): string {
  const max = width * 72 / 25.4;
  if (textWidth(text, size, font) <= max) return text;
  let cut = text.length; while (cut > 0 && textWidth(`${text.slice(0, cut)}…`, size, font) > max) cut--;
  return `${text.slice(0, cut)}…`;
}
function box(page: PdfPage, x: number, y: number, w: number, h: number, label: string, value = '', { align = 'left', font = 'regular', size = VALUE }: { align?: 'left' | 'right'; font?: PdfFont; size?: number } = {}) {
  page.rect(x, y, w, h);
  page.text(x + 0.7, y + 2, fit(label, w - 1.4, LABEL, 'bold'), { size: LABEL, font: 'bold' });
  if (value) { const shown = fit(value, w - 1.4, size, font); page.text(align === 'right' ? x + w - 0.7 : x + 0.7, y + h - 1.4, shown, { size, font, align }); }
}
function row(page: PdfPage, y: number, h: number, cells: readonly Cell[]) {
  let x = LEFT;
  for (const cell of cells) { box(page, x, y, cell.width, h, cell.label, cell.value, { align: cell.align, font: cell.font, size: cell.size }); x += cell.width; }
  return y + h;
}
const section = (page: PdfPage, y: number, title: string) => { page.text(LEFT, y + 2.4, title, { size: 5.5, font: 'bold' }); return y + 3.2; };
const markOf = (doc: DanfePdfDocument) => doc.data.environment === '2' ? 'SEM VALOR FISCAL' : doc.status === 'cancelled' ? 'CANCELADA' : doc.status === 'denied' ? 'DENEGADA' : !doc.data.protocol ? 'SEM PROTOCOLO' : null;
const protocol = (d: DanfeData) => d.protocol ? `${d.protocol.number} - ${xmlDate(d.protocol.received_at)} ${xmlTime(d.protocol.received_at)}` : 'Sem protocolo de autorização no XML';

function barcode(page: PdfPage, x: number, y: number, w: number, h: number, value: string) {
  const bits = code128(value); if (!bits) { page.text(x, y + h / 2, formatKey(value), { size: 6, font: 'mono' }); return; }
  const module = w / bits.length;
  let i = 0;
  while (i < bits.length) { if (bits[i] === '1') { const start = i; while (bits[i] === '1') i++; page.rect(x + start * module, y, (i - start) * module, h, { fill: true }); } else i++; }
}
function header(page: PdfPage, d: DanfeData, y: number, folha: string) {
  const a = d.issuer.address;
  page.rect(LEFT, y, 80, 32);
  page.text(LEFT + 0.7, y + 2, 'IDENTIFICAÇÃO DO EMITENTE', { size: LABEL, font: 'bold' });
  let line = y + 6.5;
  for (const text of wrapText(d.issuer.name ?? '', 78 * 72 / 25.4, 9, 'bold').slice(0, 2)) { page.text(LEFT + 40, line, text, { size: 9, font: 'bold', align: 'center' }); line += 3.6; }
  for (const text of [fullAddress(a), [a.district, formatPostal(a.postal_code)].filter(Boolean).join(' - '), [a.city, a.state].filter(Boolean).join(' - '), a.phone ? `Fone: ${a.phone}` : ''].filter(Boolean))
    { page.text(LEFT + 40, line, fit(text, 78, 6.5), { size: 6.5, align: 'center' }); line += 3; }
  page.rect(LEFT + 80, y, 40, 32);
  const cx = LEFT + 100;
  page.text(cx, y + 5.5, 'DANFE', { size: 12, font: 'bold', align: 'center' });
  page.text(cx, y + 8.6, 'Documento Auxiliar da', { size: 5.8, align: 'center' }); page.text(cx, y + 11, 'Nota Fiscal Eletrônica', { size: 5.8, align: 'center' });
  page.text(LEFT + 84, y + 15, '0 - ENTRADA', { size: 6 }); page.text(LEFT + 84, y + 17.8, '1 - SAÍDA', { size: 6 });
  page.rect(LEFT + 105, y + 13, 7, 6); page.text(LEFT + 108.5, y + 17.6, d.operation, { size: 10, font: 'bold', align: 'center' });
  page.text(cx, y + 23, `Nº ${noteNumber(d.number)}`, { size: 7.5, font: 'bold', align: 'center' });
  page.text(cx, y + 26.4, `SÉRIE ${d.series.padStart(3, '0')}`, { size: 7.5, font: 'bold', align: 'center' });
  page.text(cx, y + 29.8, `FOLHA ${folha}`, { size: 6.5, align: 'center' });
  page.rect(LEFT + 120, y, 80, 32);
  barcode(page, LEFT + 123, y + 1.5, 74, 11, d.key);
  box(page, LEFT + 120, y + 14, 80, 7, 'CHAVE DE ACESSO', formatKey(d.key), { font: 'mono', size: 6.6 });
  let note = y + 24;
  for (const text of wrapText('Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora', 78 * 72 / 25.4, 6)) { page.text(LEFT + 160, note, text, { size: 6, align: 'center' }); note += 2.6; }
  let next = row(page, y + 32, 7, [{ label: 'NATUREZA DA OPERAÇÃO', value: d.nature ?? '', width: 120 }, { label: 'PROTOCOLO DE AUTORIZAÇÃO DE USO', value: protocol(d), width: 80 }]);
  next = row(page, next, 7, [{ label: 'INSCRIÇÃO ESTADUAL', value: d.issuer.ie ?? '', width: 66.67 }, { label: 'INSCRIÇÃO ESTADUAL DO SUBST. TRIBUT.', value: d.issuer.ie_st ?? '', width: 66.67 },
    { label: 'CNPJ / CPF', value: formatDocument(d.issuer.document), width: 66.66 }]);
  return next;
}
// Columns of the item table (mm, summing 200).
const COLUMNS: { key: string; label: string; width: number; numeric?: boolean }[] = [
  { key: 'code', label: 'CÓDIGO', width: 14 }, { key: 'description', label: 'DESCRIÇÃO DO PRODUTO / SERVIÇO', width: 52 }, { key: 'ncm', label: 'NCM/SH', width: 11 }, { key: 'cst', label: 'O/CST', width: 8 },
  { key: 'cfop', label: 'CFOP', width: 7 }, { key: 'unit', label: 'UN', width: 7 }, { key: 'quantity', label: 'QUANT.', width: 12, numeric: true }, { key: 'unit_price', label: 'V. UNIT.', width: 14, numeric: true },
  { key: 'total', label: 'V. TOTAL', width: 13, numeric: true }, { key: 'discount', label: 'V. DESC.', width: 11, numeric: true }, { key: 'bc_icms', label: 'BC ICMS', width: 12, numeric: true },
  { key: 'icms', label: 'V. ICMS', width: 11, numeric: true }, { key: 'ipi', label: 'V. IPI', width: 10, numeric: true }, { key: 'icms_rate', label: 'ALÍQ. ICMS', width: 9, numeric: true }, { key: 'ipi_rate', label: 'ALÍQ. IPI', width: 9, numeric: true }];
const DESCRIPTION_SIZE = 6, INFO_SIZE = 5, LINE = 2.5;
function cellText(item: DanfeItem, key: string): string {
  switch (key) {
    case 'code': return item.code ?? ''; case 'ncm': return item.ncm ?? ''; case 'cst': return itemCst(item); case 'cfop': return item.cfop ?? ''; case 'unit': return item.unit ?? '';
    case 'quantity': return brNumber(item.quantity, 2, 4); case 'unit_price': return brNumber(item.unit_price, 2, 10); case 'total': return brMoney(item.total);
    case 'discount': return item.discount ? brMoney(item.discount) : ''; case 'bc_icms': return item.bc_icms ? brMoney(item.bc_icms) : ''; case 'icms': return item.icms ? brMoney(item.icms) : '';
    case 'ipi': return item.ipi ? brMoney(item.ipi) : ''; case 'icms_rate': return item.icms_rate ? brNumber(item.icms_rate, 2, 4) : ''; case 'ipi_rate': return item.ipi_rate ? brNumber(item.ipi_rate, 2, 4) : '';
    default: return '';
  }
}
const descriptionLines = (item: DanfeItem) => ({ text: wrapText(item.description, 51 * 72 / 25.4, DESCRIPTION_SIZE), info: item.info ? wrapText(item.info, 51 * 72 / 25.4, INFO_SIZE) : [] });
const itemHeight = (item: DanfeItem) => { const lines = descriptionLines(item); return (lines.text.length + lines.info.length) * LINE + 1.2; };
function itemsTable(page: PdfPage, y: number, items: readonly DanfeItem[], simples: boolean, bottom: number) {
  y = section(page, y, 'DADOS DOS PRODUTOS / SERVIÇOS');
  const top = y, head = 5;
  let x = LEFT;
  page.rect(LEFT, y, WIDTH, head);
  for (const column of COLUMNS) { page.text(x + column.width / 2, y + 3.3, column.key === 'cst' ? (simples ? 'O/CSOSN' : 'O/CST') : column.label, { size: 4.4, font: 'bold', align: 'center' }); x += column.width; }
  y += head;
  for (const item of items) {
    const lines = descriptionLines(item); let cx = LEFT, line = y + 2.4;
    for (const column of COLUMNS) {
      if (column.key === 'description') {
        let ly = line; for (const text of lines.text) { page.text(cx + 0.6, ly, text, { size: DESCRIPTION_SIZE }); ly += LINE; }
        for (const text of lines.info) { page.text(cx + 0.6, ly, text, { size: INFO_SIZE }); ly += LINE; }
      } else { const text = fit(cellText(item, column.key), column.width - 1, DESCRIPTION_SIZE); page.text(column.numeric ? cx + column.width - 0.6 : cx + 0.6, line, text, { size: DESCRIPTION_SIZE, align: column.numeric ? 'right' : 'left' }); }
      cx += column.width;
    }
    y += itemHeight(item);
    page.line(LEFT, y, RIGHT, y, { width: 0.1, dash: true });
  }
  page.rect(LEFT, top, WIDTH, bottom - top);
  x = LEFT; for (const column of COLUMNS.slice(0, -1)) { x += column.width; page.line(x, top, x, bottom, { width: 0.15 }); }
  return y;
}
/** Pages of items: the item count of the preferences when informed, else what fits in the height of each page. */
function paginate(items: readonly DanfeItem[], settings: Pick<DanfeSettings, 'firstPage' | 'otherPages'>, firstSpace: number, otherSpace: number): DanfeItem[][] {
  const pages: DanfeItem[][] = []; let page: DanfeItem[] = [], used = 0;
  for (const item of items) {
    const first = pages.length === 0, count = first ? settings.firstPage : settings.otherPages, space = first ? firstSpace : otherSpace, height = itemHeight(item);
    if (page.length && (count > 0 ? page.length >= count : used + height > space)) { pages.push(page); page = []; used = 0; }
    page.push(item); used += height;
  }
  pages.push(page);
  return pages;
}
function firstPageBlocks(page: PdfPage, d: DanfeData, y: number) {
  const r = d.recipient, t = d.totals, tr = d.transport, vol = tr.volumes, one = vol.length === 1 ? vol[0]! : null;
  y = section(page, y + 0.6, 'DESTINATÁRIO / REMETENTE');
  y = row(page, y, 7, [{ label: 'NOME / RAZÃO SOCIAL', value: r?.name ?? '', width: 120 }, { label: 'CNPJ / CPF', value: formatDocument(r?.document ?? null) || (r?.foreign_id ?? ''), width: 45 }, { label: 'DATA DA EMISSÃO', value: xmlDate(d.issued_at), width: 35 }]);
  y = row(page, y, 7, [{ label: 'ENDEREÇO', value: r ? fullAddress(r.address) : '', width: 90 }, { label: 'BAIRRO / DISTRITO', value: r?.address.district ?? '', width: 45 }, { label: 'CEP', value: formatPostal(r?.address.postal_code ?? null), width: 30 },
    { label: 'DATA DA SAÍDA/ENTRADA', value: xmlDate(d.departure_at), width: 35 }]);
  y = row(page, y, 7, [{ label: 'MUNICÍPIO', value: r?.address.city ?? '', width: 70 }, { label: 'UF', value: r?.address.state ?? '', width: 10 }, { label: 'FONE / FAX', value: r?.address.phone ?? '', width: 35 },
    { label: 'INSCRIÇÃO ESTADUAL', value: r?.ie ?? '', width: 50 }, { label: 'HORA DA SAÍDA/ENTRADA', value: xmlTime(d.departure_at), width: 35 }]);
  y = section(page, y + 0.6, 'FATURA / DUPLICATAS');
  const entries = d.billing.duplicates.length ? d.billing.duplicates.map((dup, n) => [`Nº ${dup.number ?? n + 1}`, `Venc. ${xmlDate(dup.due)}`, `R$ ${brMoney(dup.amount)}`])
    : d.payments.map(p => [p.indicator === '1' ? 'PAGAMENTO A PRAZO' : 'PAGAMENTO À VISTA', p.description ?? p.type ?? '', `R$ ${brMoney(p.amount)}`]);
  const perRow = 8, width = WIDTH / perRow;
  for (let start = 0; start < Math.max(entries.length, 1); start += perRow) {
    entries.slice(start, start + perRow).forEach((entry, i) => { const x = LEFT + i * width; page.rect(x, y, width, 9); entry.forEach((text, k) => page.text(x + 0.7, y + 2.6 + k * 2.8, fit(text, width - 1.4, 5.8), { size: 5.8, font: k === 0 ? 'bold' : 'regular' })); });
    if (!entries.length) page.rect(LEFT, y, WIDTH, 9);
    y += 9;
  }
  y = section(page, y + 0.6, 'CÁLCULO DO IMPOSTO');
  const money = (label: string, value: string | null | undefined): Cell => ({ label, value: brMoney(value), width: WIDTH / 9, align: 'right' });
  y = row(page, y, 7, [money('BASE DE CÁLC. DO ICMS', t.vBC), money('VALOR DO ICMS', t.vICMS), money('BASE DE CÁLC. ICMS S.T.', t.vBCST), money('VALOR DO ICMS SUBST.', t.vST), money('V. IMP. IMPORTAÇÃO', t.vII),
    money('V. ICMS UF REMET.', t.vICMSUFRemet), money('V. FCP UF DEST.', t.vFCPUFDest), money('V. PIS', t.vPIS), money('V. TOTAL PRODUTOS', t.vProd)]);
  y = row(page, y, 7, [money('VALOR DO FRETE', t.vFrete), money('VALOR DO SEGURO', t.vSeg), money('DESCONTO', t.vDesc), money('OUTRAS DESPESAS', t.vOutro), money('VALOR TOTAL IPI', t.vIPI),
    money('V. ICMS UF DEST.', t.vICMSUFDest), money('V. TOT. TRIB.', t.vTotTrib), money('V. COFINS', t.vCOFINS), { ...money('V. TOTAL DA NOTA', t.vNF), font: 'bold' }]);
  y = section(page, y + 0.6, 'TRANSPORTADOR / VOLUMES TRANSPORTADOS');
  y = row(page, y, 7, [{ label: 'NOME / RAZÃO SOCIAL', value: tr.carrier?.name ?? '', width: 70 }, { label: 'FRETE POR CONTA', value: FREIGHT_LABEL[tr.mode ?? ''] ?? tr.mode ?? '', width: 35 },
    { label: 'CÓDIGO ANTT', value: tr.vehicle?.rntc ?? '', width: 20 }, { label: 'PLACA DO VEÍCULO', value: tr.vehicle?.plate ?? '', width: 20 }, { label: 'UF', value: tr.vehicle?.state ?? '', width: 10 },
    { label: 'CNPJ / CPF', value: formatDocument(tr.carrier?.document ?? null), width: 45 }]);
  y = row(page, y, 7, [{ label: 'ENDEREÇO', value: tr.carrier?.address ?? '', width: 95 }, { label: 'MUNICÍPIO', value: tr.carrier?.city ?? '', width: 50 }, { label: 'UF', value: tr.carrier?.state ?? '', width: 10 },
    { label: 'INSCRIÇÃO ESTADUAL', value: tr.carrier?.ie ?? '', width: 45 }]);
  y = row(page, y, 7, [{ label: 'QUANTIDADE', value: one?.quantity ?? (vol.length ? String(vol.length) : ''), width: 20 }, { label: 'ESPÉCIE', value: vol[0]?.species ?? '', width: 35 },
    { label: 'MARCA', value: vol[0]?.brand ?? '', width: 35 }, { label: 'NUMERAÇÃO', value: vol[0]?.numbering ?? '', width: 35 },
    { label: 'PESO BRUTO', value: brNumber(one?.gross_weight, 3, 3), width: 37.5, align: 'right' }, { label: 'PESO LÍQUIDO', value: brNumber(one?.net_weight, 3, 3), width: 37.5, align: 'right' }]);
  return y;
}
const ADDITIONAL = 30;
function additional(page: PdfPage, d: DanfeData) {
  const top = PAGE_BOTTOM - ADDITIONAL;
  section(page, top - 3.4, 'DADOS ADICIONAIS');
  page.rect(LEFT, top, 140, ADDITIONAL); page.rect(LEFT + 140, top, 60, ADDITIONAL);
  page.text(LEFT + 0.7, top + 2, 'INFORMAÇÕES COMPLEMENTARES', { size: LABEL, font: 'bold' }); page.text(LEFT + 140.7, top + 2, 'RESERVADO AO FISCO', { size: LABEL, font: 'bold' });
  const texts = [d.additional.fiscal ? `Inf. fisco: ${d.additional.fiscal}` : '', d.additional.complementary ?? '',
    d.delivery ? `Local de entrega: ${[d.delivery.name, fullAddress(d.delivery), d.delivery.district, d.delivery.city, d.delivery.state].filter(Boolean).join(', ')}` : '',
    d.contingency ? `DANFE em contingência${d.contingency.at ? ` desde ${xmlDate(d.contingency.at)} ${xmlTime(d.contingency.at)}` : ''}${d.contingency.reason ? `: ${d.contingency.reason}` : ''}` : ''].filter(Boolean);
  let y = top + 4.6; const max = top + ADDITIONAL - 1;
  for (const line of texts.flatMap(text => wrapText(text, 138 * 72 / 25.4, 6))) { if (y > max) { page.text(LEFT + 0.7, max, '(continua no XML da nota)', { size: 5.5 }); break; } page.text(LEFT + 0.7, y, line, { size: 6 }); y += 2.5; }
}
function canhoto(page: PdfPage, d: DanfeData) {
  page.rect(LEFT, 5, 160, 16); page.rect(LEFT + 160, 5, 40, 16);
  const lines = wrapText(`RECEBEMOS DE ${(d.issuer.name ?? '').toUpperCase()} OS PRODUTOS/SERVIÇOS CONSTANTES DA NOTA FISCAL INDICADA AO LADO. EMISSÃO: ${xmlDate(d.issued_at)} · DEST/REM: ${d.recipient?.name ?? ''} · VALOR TOTAL: R$ ${brMoney(d.totals.vNF)}`, 158 * 72 / 25.4, 5.4).slice(0, 3);
  lines.forEach((text, i) => page.text(LEFT + 0.7, 7.2 + i * 2.2, text, { size: 5.4 }));
  box(page, LEFT, 13, 35, 8, 'DATA DE RECEBIMENTO'); box(page, LEFT + 35, 13, 125, 8, 'IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR');
  page.text(LEFT + 180, 10, 'NF-e', { size: 9, font: 'bold', align: 'center' }); page.text(LEFT + 180, 14, `Nº ${noteNumber(d.number)}`, { size: 7, font: 'bold', align: 'center' });
  page.text(LEFT + 180, 17.5, `SÉRIE ${d.series.padStart(3, '0')}`, { size: 7, font: 'bold', align: 'center' });
  page.line(LEFT, 23, RIGHT, 23, { width: 0.2, dash: true });
}
/** The PDF pages of one DANFE. */
export function danfePdfPages(doc: DanfePdfDocument, settings: Pick<DanfeSettings, 'firstPage' | 'otherPages'>): PdfPage[] {
  const d = doc.data, mark = markOf(doc), simples = ['1', '2', '4'].includes(d.issuer.crt ?? '');
  // Measure the first page once to know the room for items.
  const probe = new PdfPage(); canhoto(probe, d); const afterHeader = header(probe, d, 25, '1/1'), afterBlocks = firstPageBlocks(probe, d, afterHeader);
  const firstSpace = PAGE_BOTTOM - ADDITIONAL - 4 - (afterBlocks + 3.2 + 5), otherSpace = PAGE_BOTTOM - (header(new PdfPage(), d, 8, '1/1') + 3.2 + 5);
  const groups = paginate(d.items, settings, firstSpace, otherSpace);
  return groups.map((items, index) => {
    const page = new PdfPage(), folha = `${index + 1}/${groups.length}`;
    if (mark) page.rotated(45, 210, mark, 35, { size: mark.length > 12 ? 44 : 56 });
    if (d.environment === '2') page.text(105, 3.6, 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL', { size: 6.5, font: 'bold', align: 'center' });
    if (index === 0) {
      canhoto(page, d);
      const y = firstPageBlocks(page, d, header(page, d, 25, folha));
      itemsTable(page, y, items, simples, PAGE_BOTTOM - ADDITIONAL - 4);
      additional(page, d);
    } else itemsTable(page, header(page, d, 8, folha), items, simples, PAGE_BOTTOM);
    return page;
  });
}
/** "Gerar PDF DANFE": the PDF file with the DANFE of every note, in order. */
export function danfePdf(docs: readonly DanfePdfDocument[], settings: Pick<DanfeSettings, 'firstPage' | 'otherPages'>): Uint8Array {
  return pdfDocument(docs.flatMap(doc => danfePdfPages(doc, settings)), { title: docs.length === 1 ? `DANFE ${docs[0]!.data.number}` : `DANFE - ${docs.length} notas` });
}
export const danfePdfName = (docs: readonly DanfePdfDocument[]) => docs.length === 1 ? `DANFE-${docs[0]!.data.key}.pdf` : `DANFE-${docs.length}-notas.pdf`;
