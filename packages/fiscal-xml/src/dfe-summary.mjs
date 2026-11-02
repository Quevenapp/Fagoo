/**
 * Leva H, lane espelho (NFE-212): Data emissão, Valor, Fornecedor, CNPJ/CPF and situação of a received NF-e document already kept
 * (resNFe summary or nfeProc), read from its checked bytes. Pure and offline: no network, no signature trust, no Node built-ins (it runs
 * in the Worker). Bounded: at most 8 MiB, no DTD or entity, at most 200000 nodes and depth 80.
 */
import { DOMParser } from '@xmldom/xmldom';

const NS = 'http://www.portalfiscal.inf.br/nfe';
export const DFE_SUMMARY_MAX_BYTES = 8 * 1024 * 1024;
export class DfeSummaryError extends Error { constructor(code) { super(code); this.name = 'DfeSummaryError'; this.code = code; } }
const need = (value, code) => { if (!value) throw new DfeSummaryError(code); };
const elements = node => Array.from(node?.childNodes ?? []).filter(n => n.nodeType === 1);
const child = (node, name) => { const found = elements(node).filter(n => n.localName === name && n.namespaceURI === NS); need(found.length <= 1, 'DFE_SUMMARY_AMBIGUOUS'); return found[0] ?? null; };
const text = (node, name) => { const n = child(node, name); if (!n) return null; need(elements(n).length === 0, 'DFE_SUMMARY_STRUCTURE'); return n.textContent; };

function parse(bytes) {
  need(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= DFE_SUMMARY_MAX_BYTES, 'DFE_SUMMARY_SIZE');
  let xml;
  try { xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new DfeSummaryError('DFE_SUMMARY_UTF8'); }
  need(!/<!/.test(xml) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml), 'DFE_SUMMARY_UNSUPPORTED');
  need((xml.match(/</g) ?? []).length <= 200000, 'DFE_SUMMARY_LIMIT');
  let doc;
  try { doc = new DOMParser({ onError: () => { throw new Error('parse'); } }).parseFromString(xml, 'application/xml'); } catch { throw new DfeSummaryError('DFE_SUMMARY_MALFORMED'); }
  need(doc?.documentElement && !doc.doctype, 'DFE_SUMMARY_MALFORMED');
  const stack = [[doc.documentElement, 0]];
  while (stack.length) { const [node, depth] = stack.pop(); need(depth <= 80, 'DFE_SUMMARY_LIMIT'); for (const n of elements(node)) stack.push([n, depth + 1]); }
  return doc.documentElement;
}
const clean = value => { if (value === null) return null; const v = value.replace(/\s+/g, ' ').trim(); return v && [...v].length <= 200 && !/[\u0000-\u001f\u007f]/.test(v) ? v : null; };
function issueDate(value) {
  if (value === null) return null;
  const m = /^(20\d{2})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2})?)?$/.exec(value.trim());
  need(m, 'DFE_SUMMARY_DATE');
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  need(new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day, 'DFE_SUMMARY_DATE');
  return day;
}
function money(value) {
  if (value === null) return null;
  const m = /^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  need(m, 'DFE_SUMMARY_TOTAL');
  return `${m[1]}.${(m[2] ?? '').padEnd(2, '0')}`;
}
function party(node, key) {
  const cnpj = text(node, 'CNPJ'), cpf = text(node, 'CPF');
  need(!(cnpj !== null && cpf !== null), 'DFE_SUMMARY_AMBIGUOUS');
  const document = cnpj ?? cpf;
  if (document === null) return null;
  need(/^(\d{14}|\d{11})$/.test(document) && (cnpj !== null ? document.length === 14 : document.length === 11), 'DFE_SUMMARY_DOCUMENT');
  // The emitter of the document is the one inside the access key (CNPJ, or CPF padded with 000).
  need(document.padStart(14, '0') === key.slice(6, 20), 'DFE_SUMMARY_DOCUMENT');
  return document;
}

/**
 * The reading of one received document. `expected` is the stored document row (kind and access_key): the XML must be that kind and that key.
 * Returns { access_key, issue_date, total, supplier_name, supplier_document, situation } (absent fields are null).
 */
export function readReceivedSummary(bytes, expected) {
  need(expected && /^\d{44}$/.test(expected.access_key ?? '') && ['invoice_summary', 'invoice'].includes(expected.kind), 'DFE_SUMMARY_KIND');
  const root = parse(bytes), key = expected.access_key;
  if (expected.kind === 'invoice_summary') {
    need(root.localName === 'resNFe' && root.namespaceURI === NS, 'DFE_SUMMARY_KIND');
    need(text(root, 'chNFe') === key, 'DFE_SUMMARY_KEY');
    const situation = text(root, 'cSitNFe');
    need(situation === null || ['1', '2', '3'].includes(situation), 'DFE_SUMMARY_SITUATION');
    return { access_key: key, issue_date: issueDate(text(root, 'dhEmi')), total: money(text(root, 'vNF')), supplier_name: clean(text(root, 'xNome')),
      supplier_document: party(root, key), situation };
  }
  need(root.localName === 'nfeProc' && root.namespaceURI === NS, 'DFE_SUMMARY_KIND');
  const inf = child(child(root, 'NFe'), 'infNFe');
  need(inf && inf.getAttribute('Id') === `NFe${key}`, 'DFE_SUMMARY_KEY');
  const ide = child(inf, 'ide'), emit = child(inf, 'emit'), totals = child(child(inf, 'total'), 'ICMSTot');
  need(ide && emit, 'DFE_SUMMARY_STRUCTURE');
  return { access_key: key, issue_date: issueDate(text(ide, 'dhEmi') ?? text(ide, 'dEmi')), total: totals ? money(text(totals, 'vNF')) : null,
    supplier_name: clean(text(emit, 'xNome')), supplier_document: party(emit, key), situation: null };
}
