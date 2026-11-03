/**
 * "Importar XML NF-e" (Origin Mais ações › Importar) and, from wave F (202610200274), "Importar XML" of the NFC-e (model 65, only as an exit
 * note of the company): reads an authorized NF-e / NFC-e 4.00 (nfeProc, model 55 or 65) and returns the two
 * candidate notes of the field contract (packages/erp-domain/src/fiscal-invoice-dto.mjs): one for when the company is the
 * emitter, one for when it is the recipient. The database picks the candidate by the company CNPJ.
 * Runs in the Worker (no Node built-ins): @xmldom/xmldom only, no DTD/entities, bounded size and tree, exact strings.
 * It never verifies the XML signature against ICP-Brasil; the note is registered as declared by the XML (situação Registrada).
 */
import { DOMParser } from '@xmldom/xmldom';

export const IMPORT_MAX_BYTES = 1024 * 1024;
const NS = 'http://www.portalfiscal.inf.br/nfe';
export class InvoiceImportError extends Error { constructor(reason, field = null) { super(reason); this.reason = reason; this.field = field; } }
const refuse = (reason, field = null) => { throw new InvoiceImportError(reason, field); };
const need = (condition, reason, field) => { if (!condition) refuse(reason, field); };

const kids = (node, name) => node ? Array.from(node.childNodes ?? []).filter(c => c.nodeType === 1 && c.localName === name && c.namespaceURI === NS) : [];
const one = (node, name) => { const found = kids(node, name); need(found.length <= 1, 'xml_invalid', name); return found[0] ?? null; };
const text = (node, name, max = 2000) => {
  const element = one(node, name); if (!element) return null;
  need(!Array.from(element.childNodes).some(c => c.nodeType === 1), 'xml_invalid', name);
  const value = element.textContent.replace(/\s+/g, ' ').trim();
  need(value.length <= max, 'xml_unsupported', name);
  return value === '' ? null : value;
};
const path = (node, ...names) => names.reduce((n, name) => one(n, name), node);
const firstChild = node => node ? Array.from(node.childNodes).find(c => c.nodeType === 1 && c.namespaceURI === NS) ?? null : null;
const digits = value => value === null ? null : value.replace(/\D/g, '');
const cut = (value, max) => value === null ? null : [...value].slice(0, max).join('');
/** "100.0000" - "pRedBC" as the "% Base" of the contract, with four decimals and no float. */
function complement(rate) {
  if (rate === null || !/^\d{1,3}(\.\d{1,4})?$/.test(rate)) return null;
  const [w, f = ''] = rate.split('.'), scaled = BigInt(w) * 10000n + BigInt((f + '0000').slice(0, 4)), left = 1000000n - scaled;
  return left < 0n ? null : `${left / 10000n}.${String(left % 10000n).padStart(4, '0')}`;
}
const clean = object => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined && v !== ''));
const SPECIES = { outro: 'outros', outros: 'outros', volume: 'volumes', volumes: 'volumes', unidade: 'unidades', unidades: 'unidades', un: 'unidades', caixa: 'caixas', caixas: 'caixas', cx: 'caixas',
  pacote: 'pacotes', pacotes: 'pacotes', envelope: 'envelopes', envelopes: 'envelopes', pallet: 'pallets', pallets: 'pallets', palete: 'pallets', saco: 'sacos', sacos: 'sacos' };
const PAYMENT = ['01', '02', '03', '04', '05', '10', '11', '12', '13', '15', '16', '17', '18', '19', '20', '90', '99'];

/** Strict, bounded parse; DTD and entity declarations are refused before the parser runs. */
export function parseInvoiceXml(xml) {
  need(typeof xml === 'string' && xml.length > 0, 'xml_invalid');
  const bytes = new TextEncoder().encode(xml).byteLength;
  need(bytes <= IMPORT_MAX_BYTES, 'xml_too_large');
  const body = xml.replace(/^﻿/, '');
  need(!/<!(DOCTYPE|ENTITY|ELEMENT|ATTLIST)/i.test(body), 'xml_invalid');
  need((body.match(/</g) ?? []).length <= 60000, 'xml_too_large');
  let doc;
  try { doc = new DOMParser({ onError: () => { throw new Error('parse'); } }).parseFromString(body, 'application/xml'); } catch { refuse('xml_invalid'); }
  need(doc?.documentElement && !doc.doctype, 'xml_invalid');
  let count = 0; const stack = [[doc.documentElement, 0]];
  while (stack.length) { const [node, depth] = stack.pop(); need(depth <= 64 && ++count <= 60000, 'xml_too_large'); for (const child of Array.from(node.childNodes ?? [])) if (child.nodeType === 1) stack.push([child, depth + 1]); }
  const root = doc.documentElement;
  need(root.namespaceURI === NS && ['nfeProc', 'NFe'].includes(root.localName), 'xml_invalid');
  const nfe = root.localName === 'NFe' ? root : one(root, 'NFe');
  need(nfe, 'xml_invalid', 'NFe');
  const inf = one(nfe, 'infNFe');
  need(inf && inf.getAttribute('versao') === '4.00', 'xml_unsupported', 'versao');
  const id = inf.getAttribute('Id') ?? '';
  need(/^NFe\d{44}$/.test(id), 'xml_invalid', 'Id');
  const key = id.slice(3), prot = root.localName === 'nfeProc' ? path(root, 'protNFe', 'infProt') : null;
  return { xml, bytes, key, inf, prot, signed: kids(nfe, 'Signature').length > 0 || Array.from(nfe.childNodes).some(c => c.nodeType === 1 && c.localName === 'Signature') };
}

function party(node, kind) {
  if (!node) return null;
  const address = one(node, kind === 'emit' ? 'enderEmit' : 'enderDest');
  const cnpj = text(node, 'CNPJ', 14), cpf = text(node, 'CPF', 11), foreign = text(node, 'idEstrangeiro', 20);
  const ie = text(node, 'IE', 14), indicator = kind === 'emit' ? (ie ? '1' : '9') : text(node, 'indIEDest', 1);
  const phone = digits(text(address, 'fone', 20));
  return { document: cnpj ?? cpf ?? null, recipient: clean({ name: cut(text(node, 'xNome', 200), 60), person_type: cnpj ? 'J' : cpf ? 'F' : foreign !== null || one(node, 'idEstrangeiro') ? 'E' : null,
    document: cnpj ?? cpf, foreign_id: cnpj || cpf ? null : foreign, ie: ie && /^([0-9]{2,14}|ISENTO)$/.test(ie) ? ie : null, ie_indicator: ['1', '2', '9'].includes(indicator) ? indicator : null,
    email: kind === 'emit' ? null : cut(text(node, 'email', 200), 60), phone: phone && phone.length >= 6 && phone.length <= 14 ? phone : null, postal_code: text(address, 'CEP', 8),
    street: cut(text(address, 'xLgr', 200), 60), number: cut(text(address, 'nro', 200), 60), complement: cut(text(address, 'xCpl', 200), 60), district: cut(text(address, 'xBairro', 200), 60),
    city: cut(text(address, 'xMun', 200), 60), municipality_code: text(address, 'cMun', 7), state: text(address, 'UF', 2), country: cut(text(address, 'xPais', 200), 60) }) };
}
function icmsOf(imposto) {
  const holder = one(imposto, 'ICMS'), group = firstChild(holder);
  if (!group) return {};
  const g = name => text(group, name, 40);
  const reduction = g('pRedBC');
  return clean({ origin: g('orig'), situation: g('CST') ?? g('CSOSN'), bc_mode: g('modBC'), base_rate: reduction !== null ? complement(reduction) : null, base: g('vBC'), rate: g('pICMS'), value: g('vICMS'),
    fcp_rate: g('pFCP'), fcp_value: g('vFCP'), deferral_rate: g('pDif'), credit_rate: g('pCredSN'), credit_value: g('vCredICMSSN'), deson_value: g('vICMSDeson'), deson_reason: g('motDesICMS'),
    deson_deduct: g('vICMSDeson') ? g('indDeduzDeson') !== '0' : null, st_bc_mode: g('modBCST'), st_mva: g('pMVAST'), st_base_rate: g('pRedBCST') !== null ? complement(g('pRedBCST')) : null,
    st_base: g('vBCST'), st_rate: g('pICMSST'), st_value: g('vICMSST'), st_fcp_value: g('vFCPST'), ret_base: g('vBCSTRet'), ret_rate: g('pST'), ret_value: g('vICMSSTRet'),
    ret_substitute_value: g('vICMSSubstituto'), mono_qty: g('qBCMono'), mono_value: g('vICMSMono') });
}
function rated(imposto, tax) {
  const holder = one(imposto, tax), group = firstChild(holder);
  if (!group) return {};
  const g = name => text(group, name, 40), p = tax === 'PIS' ? 'PIS' : 'COFINS';
  return clean({ situation: g('CST'), base: g('vBC'), rate: g(`p${p}`), value: g(`v${p}`), unit_value: g(`vAliqProd`) });
}
function ipiOf(imposto) {
  const holder = one(imposto, 'IPI'); if (!holder) return {};
  const group = one(holder, 'IPITrib') ?? one(holder, 'IPINT'), g = name => text(group, name, 40);
  return clean({ situation: g('CST'), base: g('vBC'), rate: g('pIPI'), value: g('vIPI'), unit_value: g('vUnid'), framing_code: text(holder, 'cEnq', 3) });
}
function itemOf(det) {
  const prod = one(det, 'prod'), imposto = one(det, 'imposto');
  need(prod && imposto, 'xml_invalid', 'det');
  const p = (name, max = 200) => text(prod, name, max);
  const gtin = value => value === null ? null : value === 'SEM GTIN' || /^(\d{8}|\d{12,14})$/.test(value) ? value : null;
  const ii = one(imposto, 'II'), ipiDevol = path(det, 'impostoDevol', 'IPI');
  const item = clean({ code: cut(p('cProd', 60), 60), description: cut(p('xProd', 200), 120), kind: 'P', unit: cut(p('uCom', 6), 6), quantity: p('qCom', 20), unit_price: p('vUnCom', 30), ncm: p('NCM', 8),
    cest: p('CEST', 7), cfop: p('CFOP', 4), gtin: gtin(p('cEAN', 14)), gtin_tax: gtin(p('cEANTrib', 14)), invoiced: p('indTot', 1) === '0' ? false : null, info: cut(text(det, 'infAdProd', 600), 500) });
  const icms = icmsOf(imposto), ipi = ipiOf(imposto), pis = rated(imposto, 'PIS'), cofins = rated(imposto, 'COFINS'), benefit = p('cBenef', 10);
  if (benefit && /^[A-Z0-9]{8}([A-Z0-9]{2})?$/.test(benefit)) icms.benefit_code = benefit;
  if (Object.keys(icms).length) item.icms = icms;
  if (Object.keys(ipi).length || ipiDevol) item.ipi = clean({ ...ipi, devol_value: text(ipiDevol, 'vIPIDevol', 30) });
  if (Object.keys(pis).length) item.pis = pis;
  if (Object.keys(cofins).length) item.cofins = cofins;
  if (ii) item.ii = clean({ situation: 'T', base: text(ii, 'vBC', 30), value: text(ii, 'vII', 30), customs_expense: text(ii, 'vDespAdu', 30) });
  const others = clean({ purchase_order: cut(p('xPed', 15), 15), purchase_order_item: p('nItemPed', 6), fci: p('nFCI', 36), approx_taxes: text(imposto, 'vTotTrib', 30) });
  if (Object.keys(others).length) item.others = others;
  return { item, money: { freight: p('vFrete', 30), insurance: p('vSeg', 30), discount: p('vDesc', 30), other: p('vOutro', 30) } };
}
// The supplier's exit IPI situations (50-55, 99) are the entry ones of the buyer (00-05, 49), as the field contract requires for entry notes.
const ENTRY_IPI = { '50': '00', '51': '01', '52': '02', '53': '03', '54': '04', '55': '05', '99': '49' };
const entryItem = item => item.ipi?.situation && ENTRY_IPI[item.ipi.situation] ? { ...item, ipi: { ...item.ipi, situation: ENTRY_IPI[item.ipi.situation] } } : item;
const sumCents = values => values.reduce((total, v) => { if (v === null) return total; need(/^\d{1,13}(\.\d{1,2})?$/.test(v), 'xml_unsupported', 'valor'); const [w, f = ''] = v.split('.'); return total + BigInt(w) * 100n + BigInt((f + '00').slice(0, 2)); }, 0n);
const money = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;

/**
 * Candidate notes of the contract (issue type T for validation; the database stores S or X) plus what the database checks.
 * Refusals: xml_invalid, xml_too_large, xml_unsupported, xml_not_authorized, xml_homologation.
 */
export function invoiceImportCandidates(xml) {
  const { key, inf, prot, signed, bytes } = parseInvoiceXml(xml);
  const ide = one(inf, 'ide'), emit = one(inf, 'emit'), dest = one(inf, 'dest');
  need(ide && emit, 'xml_invalid', 'ide');
  const i = (name, max = 60) => text(ide, name, max);
  // Wave F (202610200274): the NFC-e (model 65) is imported too, as an exit note of the company (Importação de XML de saída).
  const model = i('mod', 2);
  need(model === '55' || model === '65', 'xml_unsupported', 'mod');
  need(i('tpAmb', 1) === '1', 'xml_homologation', 'tpAmb');
  need(prot && text(prot, 'chNFe', 44) === key && ['100', '150'].includes(text(prot, 'cStat', 3)) && /^\d{15}$/.test(text(prot, 'nProt', 20) ?? '') && text(prot, 'tpAmb', 1) === '1', 'xml_not_authorized', 'protNFe');
  const dets = kids(inf, 'det');
  need(dets.length >= 1 && dets.length <= 990, 'xml_unsupported', 'det');
  const rows = dets.map(itemOf);
  const total = path(inf, 'total', 'ICMSTot'), t = name => text(total, name, 30);
  need(total, 'xml_invalid', 'ICMSTot');
  const issuedAt = i('dhEmi', 40) ?? '', exitAt = i('dhSaiEnt', 40);
  need(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2})$/.test(issuedAt), 'xml_invalid', 'dhEmi');
  const receivedAt = text(prot, 'dhRecbto', 40);
  need(receivedAt && Number.isFinite(Date.parse(receivedAt)), 'xml_not_authorized', 'dhRecbto');
  // Header amounts: the contract spreads them over the items again; the XML totals are the reference.
  const freight = money(sumCents(rows.map(r => r.money.freight))), insurance = money(sumCents(rows.map(r => r.money.insurance))), discount = money(sumCents(rows.map(r => r.money.discount))), other = money(sumCents(rows.map(r => r.money.other)));
  const transp = one(inf, 'transp'), carrierNode = one(transp, 'transporta'), vehicleNode = one(transp, 'veicTransp'), volume = kids(transp, 'vol')[0] ?? null;
  const carrier = carrierNode ? clean({ name: cut(text(carrierNode, 'xNome', 200), 60), document: text(carrierNode, 'CNPJ', 14) ?? text(carrierNode, 'CPF', 11), ie: (v => v && /^([0-9]{2,14}|ISENTO)$/.test(v) ? v : null)(text(carrierNode, 'IE', 14)),
    state: text(carrierNode, 'UF', 2), city: cut(text(carrierNode, 'xMun', 200), 60), address: cut(text(carrierNode, 'xEnder', 200), 60) }) : {};
  const vehicle = vehicleNode ? clean({ plate: (v => v && /^[A-Z0-9]{7}$/.test(v) ? v : null)(text(vehicleNode, 'placa', 8)), state: text(vehicleNode, 'UF', 2), rntc: cut(text(vehicleNode, 'RNTC', 20), 20) }) : {};
  const species = volume ? SPECIES[(text(volume, 'esp', 60) ?? '').toLowerCase().replace(/\(s\)$/, '').replace(/[^a-z]/g, '')] ?? null : null;
  const volumes = volume ? clean({ quantity: text(volume, 'qVol', 15), species, brand: cut(text(volume, 'marca', 60), 60), numbering: cut(text(volume, 'nVol', 60), 60), gross_weight: text(volume, 'pesoB', 20), net_weight: text(volume, 'pesoL', 20) }) : {};
  const freightBy = text(transp, 'modFrete', 1) ?? '9';
  const transport = { mode: Object.keys(carrier).length || Object.keys(vehicle).length ? 'manual' : 'none', freight_by: freightBy, carrier, vehicle, volumes, delivery: null };
  const cobr = one(inf, 'cobr'), dups = kids(cobr, 'dup'), pays = kids(one(inf, 'pag'), 'detPag');
  const method = pays.length === 1 ? (m => PAYMENT.includes(m) ? m : '99')(text(pays[0], 'tPag', 2)) : null;
  let installments = (dups.length ? dups.map(d => clean({ date: text(d, 'dVenc', 10), amount: text(d, 'vDup', 30), note: (n => n ? `Duplicata ${n}` : null)(cut(text(d, 'nDup', 60), 60)), method }))
    : pays.filter(p => text(p, 'tPag', 2) !== '90').map(p => clean({ date: issuedAt.slice(0, 10), amount: text(p, 'vPag', 30), method: (m => PAYMENT.includes(m) ? m : '99')(text(p, 'tPag', 2)) }))).map(x => ({ ...x, card: null }));
  // vTroco (the change given back, usual in the NFC-e paid in cash): the parcels keep what stayed with the company, taken from the last
  // payment in cash (01) or else the last payment that covers it, so they add up to the total like the note.
  const change = text(one(inf, 'pag'), 'vTroco', 30);
  if (!dups.length && change && sumCents([change]) > 0n) {
    const back = sumCents([change]);
    const at = [...installments.keys()].reverse().find(k => installments[k].method === '01' && sumCents([installments[k].amount]) >= back)
      ?? [...installments.keys()].reverse().find(k => sumCents([installments[k].amount]) >= back);
    need(at !== undefined, 'xml_unsupported', 'vTroco');
    const left = sumCents([installments[at].amount]) - back;
    installments = left > 0n ? installments.map((x, k) => k === at ? { ...x, amount: money(left) } : x) : installments.filter((x, k) => k !== at);
  }
  const references = kids(ide, 'NFref').map(ref => {
    const nfe = text(ref, 'refNFe', 44), cte = text(ref, 'refCTe', 44), nf = one(ref, 'refNF'), nfp = one(ref, 'refNFP'), ecf = one(ref, 'refECF');
    if (nfe) return { type: 'nfe', key: nfe }; if (cte) return { type: 'cte', key: cte };
    if (nf) return { type: 'nf01', year_month: text(nf, 'AAMM', 4), number: text(nf, 'nNF', 9), series: text(nf, 'serie', 3) };
    if (nfp) return { type: text(nfp, 'mod', 2) === '04' ? 'nfp04' : 'nfp01', year_month: text(nfp, 'AAMM', 4), number: text(nfp, 'nNF', 9), series: text(nfp, 'serie', 3) };
    if (ecf) return { type: 'ecf', number: text(ecf, 'nCOO', 9) };
    return refuse('xml_unsupported', 'NFref');
  });
  const authorized = kids(inf, 'autXML').map(a => ({ document: text(a, 'CNPJ', 14) ?? text(a, 'CPF', 11) })).filter(a => a.document).slice(0, 10);
  const intermed = one(inf, 'infIntermed'), additional = one(inf, 'infAdic');
  const emitter = party(emit, 'emit'), recipient = party(dest, 'dest');
  const base = { model, issue_type: 'T', series: String(Number(i('serie', 3))), number: String(Number(i('nNF', 9))), access_key: key, nature_description: cut(i('natOp', 200), 60),
    cfop: rows.find(r => r.item.cfop)?.item.cfop ?? null, issue_date: issuedAt.slice(0, 10), exit_date: exitAt ? exitAt.slice(0, 10) : null, exit_time: exitAt && /T\d{2}:\d{2}/.test(exitAt) ? exitAt.slice(11, 16) : null,
    crt: text(emit, 'CRT', 1), purpose: i('finNFe', 1), presence: i('indPres', 1) ?? '9', final_consumer: i('indFinal', 1) === '1', references, items: rows.map(r => r.item), auto_tax: false,
    freight, insurance, other_expenses: other, discount, transport, payment: { condition: null, installments }, authorized_xml: [...new Map(authorized.map(a => [a.document, a])).values()],
    intermediary: intermed ? clean({ present: true, cnpj: text(intermed, 'CNPJ', 14), identification: cut(text(intermed, 'idCadIntTran', 60), 60) }) : {},
    additional_info: cut(text(additional, 'infCpl', 6000), 5000), nature_additional_info: null, nature_fiscal_info: cut(text(additional, 'infAdFisco', 3000), 2000), export: null, import_declaration: null };
  const tpNF = i('tpNF', 1);
  need(['0', '1'].includes(tpNF), 'xml_invalid', 'tpNF');
  return {
    key, bytes, signed, emitter_document: emitter.document, recipient_document: recipient?.document ?? null, total: t('vNF'),
    protocol: { number: text(prot, 'nProt', 15), received_at: receivedAt, status: text(prot, 'cStat', 3) },
    // Company as emitter: the note keeps its own direction; the counterpart is the recipient of the XML.
    as_emitter: { ...base, direction: tpNF, recipient: recipient?.recipient ?? {} },
    // Company as recipient: the supplier's note is an entry, with the emitter as Remetente. An NFC-e is never an entry note of the
    // company (the consumer note is not a purchase document), so it has no such candidate.
    as_recipient: model === '65' ? null : { ...base, direction: '0', recipient: emitter.recipient, final_consumer: false, items: base.items.map(entryItem) },
    model,
  };
}
