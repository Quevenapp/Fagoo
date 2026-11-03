// DANFE (NF-e modelo 55, DANFE Simplificado e DANFE NFC-e) a partir do XML autorizado de uma nota (onda E da frente de notas).
// O XML vem já conferido por tamanho e SHA-256 (acervo do Origin ou XML importado guardado no Brufap); aqui ele só é lido para a
// impressão: um leitor de XML próprio e limitado (sem DTD nem entidades externas), sem rede, sem biblioteca e sem gravar nada.
// Os valores são impressos como estão no XML (texto decimal, nunca número de ponto flutuante).
import * as T from '../../../../packages/fiscal-core/src/tax-tables.mjs';

export class DanfeError extends Error { code: string; constructor(code: string) { super(code); this.code = code; this.name = 'DanfeError'; } }
const fail = (code: string): never => { throw new DanfeError(code); };
export const DANFE_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, nodes: 200000, depth: 64, items: 990 });

// ---- XML reader (subset used by NF-e/NFC-e: elements, attributes, text, CDATA, comments; no DTD) ----
export interface XNode { name: string; attrs: Record<string, string>; children: XNode[]; text: string }
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g, (_, e: string) => {
    if (e[0] === '#') { const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); if (!(code > 0 && code <= 0x10ffff)) fail('XML_ENTITY_INVALID'); return String.fromCodePoint(code); }
    return ENTITIES[e] ?? fail('XML_ENTITY_INVALID');
  });
}
const local = (name: string) => name.slice(name.indexOf(':') + 1);
function tagEnd(text: string, from: number): number {
  let quote = '';
  for (let i = from; i < text.length; i++) { const c = text[i]; if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') return i; }
  return fail('XML_STRUCTURE_INVALID');
}
/** Parses the XML text into a tree of local names; refuses DOCTYPE/ENTITY declarations and unbalanced tags. */
export function parseXml(text: string): XNode {
  if (typeof text !== 'string' || !text.length || text.length > DANFE_LIMITS.bytes) fail('XML_SIZE_LIMIT');
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(text)) fail('XML_FORBIDDEN');
  const root: XNode = { name: '#document', attrs: {}, children: [], text: '' }, stack = [root];
  let i = 0, count = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i), top = stack[stack.length - 1]!;
    if (lt < 0) { if (text.slice(i).trim()) top.text += decode(text.slice(i)); break; }
    if (lt > i) top.text += decode(text.slice(i, lt));
    if (text.startsWith('<?', lt)) { const end = text.indexOf('?>', lt); if (end < 0) fail('XML_STRUCTURE_INVALID'); i = end + 2; continue; }
    if (text.startsWith('<!--', lt)) { const end = text.indexOf('-->', lt); if (end < 0) fail('XML_STRUCTURE_INVALID'); i = end + 3; continue; }
    if (text.startsWith('<![CDATA[', lt)) { const end = text.indexOf(']]>', lt); if (end < 0) fail('XML_STRUCTURE_INVALID'); top.text += text.slice(lt + 9, end); i = end + 3; continue; }
    const end = tagEnd(text, lt + 1);
    if (text[lt + 1] === '/') {
      const name = local(text.slice(lt + 2, end).trim()), node = stack.pop();
      if (!node || node === root || node.name !== name) fail('XML_STRUCTURE_INVALID');
      i = end + 1; continue;
    }
    const raw = text.slice(lt + 1, end), closed = raw.endsWith('/'), body = closed ? raw.slice(0, -1) : raw;
    const match = /^([A-Za-z_][\w.:-]*)/.exec(body); if (!match) fail('XML_STRUCTURE_INVALID');
    const attrs: Record<string, string> = {};
    for (const a of body.slice(match![1]!.length).matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[local(a[1]!)] = decode(a[3] ?? a[4] ?? '');
    const node: XNode = { name: local(match![1]!), attrs, children: [], text: '' };
    if (++count > DANFE_LIMITS.nodes || stack.length > DANFE_LIMITS.depth) fail('XML_COMPLEXITY_LIMIT');
    top.children.push(node); if (!closed) stack.push(node);
    i = end + 1;
  }
  if (stack.length !== 1 || root.children.length !== 1) fail('XML_STRUCTURE_INVALID');
  return root.children[0]!;
}
export const child = (node: XNode | null | undefined, name: string): XNode | null => node?.children.find(c => c.name === name) ?? null;
export const children = (node: XNode | null | undefined, name: string): XNode[] => node?.children.filter(c => c.name === name) ?? [];
/** Trimmed text of a leaf element (null when absent or empty). */
export const val = (node: XNode | null | undefined, name: string): string | null => { const c = child(node, name); const t = c?.text.trim(); return t ? t : null; };

// ---- DANFE data ----
export interface DanfeAddress { street: string | null; number: string | null; complement: string | null; district: string | null; city: string | null; state: string | null; postal_code: string | null; phone: string | null; country: string | null }
export interface DanfeParty { name: string | null; trade_name: string | null; document: string | null; foreign_id: string | null; ie: string | null; ie_st: string | null; im: string | null; cnae: string | null; crt: string | null; ie_indicator: string | null; email: string | null; address: DanfeAddress }
export interface DanfeItem {
  position: number; code: string | null; gtin: string | null; description: string; ncm: string | null; cest: string | null; origin: string | null; cst: string | null; csosn: string | null; cfop: string | null;
  unit: string | null; quantity: string | null; unit_price: string | null; total: string | null; discount: string | null; bc_icms: string | null; icms: string | null; icms_rate: string | null;
  bc_st: string | null; st: string | null; ipi: string | null; ipi_rate: string | null; info: string | null;
}
export interface DanfeData {
  key: string; model: '55' | '65'; environment: '1' | '2'; emission_type: string; operation: '0' | '1'; number: string; series: string; issued_at: string | null; departure_at: string | null; nature: string | null;
  purpose: string | null; print_type: string | null; issuer: DanfeParty; recipient: DanfeParty | null; items: DanfeItem[]; totals: Record<string, string | null>;
  transport: { mode: string | null; carrier: { name: string | null; document: string | null; ie: string | null; address: string | null; city: string | null; state: string | null } | null;
    vehicle: { plate: string | null; state: string | null; rntc: string | null } | null; volumes: { quantity: string | null; species: string | null; brand: string | null; numbering: string | null; net_weight: string | null; gross_weight: string | null }[] };
  billing: { invoice: { number: string | null; original: string | null; discount: string | null; net: string | null } | null; duplicates: { number: string | null; due: string | null; amount: string | null }[] };
  payments: { indicator: string | null; type: string | null; description: string | null; amount: string | null }[]; change: string | null;
  additional: { fiscal: string | null; complementary: string | null }; delivery: DanfeAddress & { name: string | null; document: string | null } | null;
  protocol: { number: string; received_at: string | null; status: string | null; reason: string | null } | null; qr: string | null; consultation: string | null;
  contingency: { at: string | null; reason: string | null } | null; total_tax: string | null;
}
const address = (node: XNode | null): DanfeAddress => ({ street: val(node, 'xLgr'), number: val(node, 'nro'), complement: val(node, 'xCpl'), district: val(node, 'xBairro'), city: val(node, 'xMun'), state: val(node, 'UF'),
  postal_code: val(node, 'CEP'), phone: val(node, 'fone'), country: val(node, 'xPais') });
const party = (node: XNode | null, addressNode: string): DanfeParty | null => !node ? null : ({ name: val(node, 'xNome'), trade_name: val(node, 'xFant'), document: val(node, 'CNPJ') ?? val(node, 'CPF'), foreign_id: val(node, 'idEstrangeiro'),
  ie: val(node, 'IE'), ie_st: val(node, 'IEST'), im: val(node, 'IM'), cnae: val(node, 'CNAE'), crt: val(node, 'CRT'), ie_indicator: val(node, 'indIEDest'), email: val(node, 'email'), address: address(child(node, addressNode)) });
const TOTAL_KEYS = ['vBC', 'vICMS', 'vICMSDeson', 'vFCPUFDest', 'vICMSUFDest', 'vICMSUFRemet', 'vFCP', 'vBCST', 'vST', 'vFCPST', 'vFCPSTRet', 'vProd', 'vFrete', 'vSeg', 'vDesc', 'vII', 'vIPI', 'vIPIDevol', 'vPIS', 'vCOFINS', 'vOutro', 'vNF', 'vTotTrib'];
/**
 * Reads an NF-e/NFC-e 4.00 (nfeProc with protNFe, or NFe alone) into the fields the DANFE prints. Refuses another document, another
 * layout version or an access key that does not match its check digit.
 */
export function danfeData(xml: string): DanfeData {
  const doc = parseXml(xml);
  const nfe = doc.name === 'nfeProc' ? child(doc, 'NFe') : doc.name === 'NFe' ? doc : null;
  if (!nfe) fail('DANFE_DOCUMENT_UNSUPPORTED');
  const inf = child(nfe, 'infNFe'); if (!inf) fail('DANFE_DOCUMENT_UNSUPPORTED');
  const key = (inf!.attrs.Id ?? '').replace(/^NFe/, '');
  if (!/^\d{44}$/.test(key) || !validKey(key)) fail('DANFE_KEY_INVALID');
  if (inf!.attrs.versao !== '4.00') fail('DANFE_VERSION_UNSUPPORTED');
  const ide = child(inf, 'ide'), model = val(ide, 'mod');
  if (model !== '55' && model !== '65') fail('DANFE_DOCUMENT_UNSUPPORTED');
  const environment = val(ide, 'tpAmb'), operation = val(ide, 'tpNF');
  if ((environment !== '1' && environment !== '2') || (operation !== '0' && operation !== '1')) fail('DANFE_DOCUMENT_UNSUPPORTED');
  const det = children(inf, 'det'); if (!det.length || det.length > DANFE_LIMITS.items) fail('DANFE_ITEMS_LIMIT');
  const items = det.map((d, index): DanfeItem => {
    const prod = child(d, 'prod'), tax = child(d, 'imposto'), icmsGroup = child(tax, 'ICMS')?.children[0] ?? null, ipi = child(tax, 'IPI'), ipiTrib = child(ipi, 'IPITrib');
    return { position: Number(d.attrs.nItem) || index + 1, code: val(prod, 'cProd'), gtin: val(prod, 'cEAN'), description: val(prod, 'xProd') ?? '', ncm: val(prod, 'NCM'), cest: val(prod, 'CEST'),
      origin: val(icmsGroup, 'orig'), cst: val(icmsGroup, 'CST'), csosn: val(icmsGroup, 'CSOSN'), cfop: val(prod, 'CFOP'), unit: val(prod, 'uCom'), quantity: val(prod, 'qCom'), unit_price: val(prod, 'vUnCom'),
      total: val(prod, 'vProd'), discount: val(prod, 'vDesc'), bc_icms: val(icmsGroup, 'vBC'), icms: val(icmsGroup, 'vICMS'), icms_rate: val(icmsGroup, 'pICMS'), bc_st: val(icmsGroup, 'vBCST'), st: val(icmsGroup, 'vICMSST'),
      ipi: val(ipiTrib, 'vIPI'), ipi_rate: val(ipiTrib, 'pIPI'), info: val(d, 'infAdProd') };
  });
  const tot = child(child(inf, 'total'), 'ICMSTot');
  const transp = child(inf, 'transp'), carrier = child(transp, 'transporta'), vehicle = child(transp, 'veicTransp');
  const cobr = child(inf, 'cobr'), fat = child(cobr, 'fat'), pag = child(inf, 'pag'), extra = child(inf, 'infAdic'), entrega = child(inf, 'entrega');
  const supl = child(nfe, 'infNFeSupl'), prot = child(child(doc, 'protNFe'), 'infProt');
  const cont = val(ide, 'dhCont') || val(ide, 'xJust') ? { at: val(ide, 'dhCont'), reason: val(ide, 'xJust') } : null;
  const tpag = (code: string | null) => code ? (T.PAYMENT_METHOD as readonly (readonly [string, string])[]).find(([c]) => c === code)?.[1] ?? null : null;
  return {
    key, model: model as '55' | '65', environment: environment as '1' | '2', emission_type: val(ide, 'tpEmis') ?? '1', operation: operation as '0' | '1', number: val(ide, 'nNF') ?? '', series: val(ide, 'serie') ?? '', issued_at: val(ide, 'dhEmi'), departure_at: val(ide, 'dhSaiEnt'),
    nature: val(ide, 'natOp'), purpose: val(ide, 'finNFe'), print_type: val(ide, 'tpImp'), issuer: party(child(inf, 'emit'), 'enderEmit') ?? fail('DANFE_DOCUMENT_UNSUPPORTED'), recipient: party(child(inf, 'dest'), 'enderDest'), items,
    totals: Object.fromEntries(TOTAL_KEYS.map(k => [k, val(tot, k)])),
    transport: { mode: val(transp, 'modFrete'), carrier: carrier ? { name: val(carrier, 'xNome'), document: val(carrier, 'CNPJ') ?? val(carrier, 'CPF'), ie: val(carrier, 'IE'), address: val(carrier, 'xEnder'), city: val(carrier, 'xMun'), state: val(carrier, 'UF') } : null,
      vehicle: vehicle ? { plate: val(vehicle, 'placa'), state: val(vehicle, 'UF'), rntc: val(vehicle, 'RNTC') } : null,
      volumes: children(transp, 'vol').map(v => ({ quantity: val(v, 'qVol'), species: val(v, 'esp'), brand: val(v, 'marca'), numbering: val(v, 'nVol'), net_weight: val(v, 'pesoL'), gross_weight: val(v, 'pesoB') })) },
    billing: { invoice: fat ? { number: val(fat, 'nFat'), original: val(fat, 'vOrig'), discount: val(fat, 'vDesc'), net: val(fat, 'vLiq') } : null,
      duplicates: children(cobr, 'dup').map(d => ({ number: val(d, 'nDup'), due: val(d, 'dVenc'), amount: val(d, 'vDup') })) },
    payments: children(pag, 'detPag').map(p => ({ indicator: val(p, 'indPag'), type: val(p, 'tPag'), description: val(p, 'xPag') ?? tpag(val(p, 'tPag')), amount: val(p, 'vPag') })), change: val(pag, 'vTroco'),
    additional: { fiscal: val(extra, 'infAdFisco'), complementary: val(extra, 'infCpl') },
    delivery: entrega ? { ...address(entrega), name: val(entrega, 'xNome'), document: val(entrega, 'CNPJ') ?? val(entrega, 'CPF') } : null,
    protocol: prot && val(prot, 'nProt') ? { number: val(prot, 'nProt')!, received_at: val(prot, 'dhRecbto'), status: val(prot, 'cStat'), reason: val(prot, 'xMotivo') } : null,
    qr: val(supl, 'qrCode'), consultation: val(supl, 'urlChave'), contingency: cont, total_tax: val(tot, 'vTotTrib'),
  };
}
/** Access key check digit (módulo 11 with weights 2..9 from the right). */
export function validKey(key: string): boolean {
  if (!/^\d{44}$/.test(key)) return false;
  let sum = 0, weight = 2;
  for (let i = 42; i >= 0; i--) { sum += Number(key[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const rest = sum % 11, digit = rest < 2 ? 0 : 11 - rest;
  return digit === Number(key[43]);
}

// ---- Formatting (digit strings only) ----
/** "1234.5" → "1.234,50" with at least `min` decimals (trailing zeros beyond `min` are kept up to `max`). */
export function brNumber(value: string | null | undefined, min = 2, max = 10): string {
  if (!value || !/^-?\d+(\.\d+)?$/.test(value)) return '';
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace('-', '').split('.');
  let decimals = fraction.replace(/0+$/, ''); if (decimals.length < min) decimals = decimals.padEnd(min, '0'); if (decimals.length > max) decimals = decimals.slice(0, max);
  const grouped = whole!.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${grouped}${decimals ? `,${decimals}` : ''}`;
}
export const brMoney = (value: string | null | undefined) => brNumber(value, 2, 2) || '0,00';
export const formatKey = (key: string) => key.replace(/(\d{4})(?=\d)/g, '$1 ');
export function formatDocument(value: string | null): string {
  if (!value) return '';
  if (/^\d{14}$/.test(value)) return value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (/^\d{11}$/.test(value)) return value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return value;
}
export const formatPostal = (value: string | null) => value && /^\d{8}$/.test(value) ? value.replace(/^(\d{5})(\d{3})$/, '$1-$2') : value ?? '';
/** Date and time as written in the XML (its own offset, the São Paulo time of the emitter): "dd/mm/aaaa" and "hh:mm:ss". */
export const xmlDate = (value: string | null) => value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10).split('-').reverse().join('/') : '';
export const xmlTime = (value: string | null) => value && /T\d{2}:\d{2}:\d{2}/.test(value) ? value.slice(11, 19) : '';
export const noteNumber = (value: string) => /^\d{1,9}$/.test(value) ? value.padStart(9, '0').replace(/^(\d{3})(\d{3})(\d{3})$/, '$1.$2.$3') : value;
export const FREIGHT_LABEL: Record<string, string> = { '0': '0-Por conta do Emitente', '1': '1-Por conta do Destinatário', '2': '2-Por conta de Terceiros', '3': '3-Próprio por conta do Remetente',
  '4': '4-Próprio por conta do Destinatário', '9': '9-Sem Frete' };
export const fullAddress = (a: DanfeAddress) => [[a.street, a.number].filter(Boolean).join(', '), a.complement].filter(Boolean).join(' - ');
/** O/CST (regime normal) or O/CSOSN (Simples Nacional) of an item. */
export const itemCst = (item: DanfeItem) => `${item.origin ?? ''}${item.csosn ?? item.cst ?? ''}`;

// ---- Pagination of the A4 DANFE ----
export interface DanfeSettings { firstPage: number; otherPages: number; simplifiedProducts: boolean; simplifiedTotal: boolean }
export const DEFAULT_DANFE_SETTINGS: DanfeSettings = Object.freeze({ firstPage: 0, otherPages: 0, simplifiedProducts: false, simplifiedTotal: false });
/** Printed lines of an item (description and additional information wrap at about 48 characters in the Descrição column). */
const itemLines = (item: DanfeItem) => Math.max(1, Math.ceil([...item.description].length / 48)) + (item.info ? Math.ceil([...item.info].length / 60) : 0);
/**
 * Items of each page: "Nro de itens impressos na primeira página / nas demais páginas" (Preferências › Configurações de NF-e) when
 * informed; otherwise by printed lines (30 on the first page, with every block, and 70 on the next ones, with the header only).
 */
export function danfePages(items: readonly DanfeItem[], settings: Pick<DanfeSettings, 'firstPage' | 'otherPages'>): DanfeItem[][] {
  const pages: DanfeItem[][] = [];
  let page: DanfeItem[] = [], used = 0;
  const capacity = () => pages.length === 0 ? settings.firstPage || 30 : settings.otherPages || 70, byCount = () => pages.length === 0 ? settings.firstPage > 0 : settings.otherPages > 0;
  for (const item of items) {
    const cost = byCount() ? 1 : itemLines(item);
    if (page.length && used + cost > capacity()) { pages.push(page); page = []; used = 0; }
    page.push(item); used += byCount() ? 1 : itemLines(item);
  }
  pages.push(page);
  return pages;
}
/** Preferências › Notas Fiscais › Configurações de NF-e › Impressão, from the page items (defaults when absent or invalid). */
export function danfeSettings(items: readonly { key: string; value: unknown }[] | null | undefined): DanfeSettings {
  const get = (key: string) => items?.find(i => i.key === key)?.value;
  const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 999 ? value as number : 0;
  return { firstPage: count(get('nfe.itens_primeira_pagina')), otherPages: count(get('nfe.itens_demais_paginas')),
    simplifiedProducts: get('nfe.danfe_simplificado_produtos') === true, simplifiedTotal: get('nfe.danfe_simplificado_total') === true };
}
export const DANFE_ERRORS: Record<string, string> = {
  DANFE_DOCUMENT_UNSUPPORTED: 'O XML não é uma NF-e ou NFC-e que o DANFE do FAGOO lê.', DANFE_VERSION_UNSUPPORTED: 'O DANFE do FAGOO lê o leiaute 4.00 da NF-e.',
  DANFE_KEY_INVALID: 'A chave de acesso do XML não confere.', DANFE_ITEMS_LIMIT: 'A nota tem itens demais para o DANFE.',
};
export const danfeErrorText = (error: unknown) => error instanceof DanfeError ? DANFE_ERRORS[error.code] ?? 'O XML da nota não pôde ser lido para o DANFE.' : 'O XML da nota não pôde ser lido para o DANFE.';
