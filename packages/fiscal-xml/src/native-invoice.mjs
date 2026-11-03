/**
 * Native NF-e / NFC-e 4.00 XML of a note of the Brufap (notas fiscais lane, wave F): "Validar" and "Gerar XML (suporte)".
 * The XML is built from the saved note (the record of erp_fiscal_invoice_get), the company identity, its extra data (Tipo da Pessoa,
 * Isento, IM, CNAE, Suframa, IE dos substitutos tributários) and the next number of the homologation series, which is only predicted:
 * nothing is reserved, signed, transmitted or stored, and tpAmb is always 2 (homologação, sem valor fiscal). The element order comes from
 * the official layout (schema-check.mjs), and the same module checks the result against it.
 * Runs in the Worker (no Node built-ins). Money, rates and quantities are the exact decimal strings of the note; only BigInt is used.
 * The offline rules below are a subset of the SEFAZ validations (a proposal to be confirmed in homologation), never an authorization.
 */
import { checkNfeSchema, schemaErrorText, schemaXml, SCHEMA_PROFILE } from './schema-check.mjs';
import { accessKeyCheckDigit, isValidCnpj } from '../../fiscal-core/src/identity.mjs';
import { NFCE_SP_HOMOLOGATION_QR_V3 } from '../../fiscal-core/src/nfce-qr-profile.mjs';

export const NATIVE_XML_PROFILE = 'brufap-native-invoice-v1';
export const HOMOLOGATION_RECIPIENT = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
export const HOMOLOGATION_PRODUCT = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
export const STATE_CODES = Object.freeze({ RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53' });
export class NativeInvoiceError extends Error { constructor(code) { super(code); this.code = code; } }
const SP_QR = Object.freeze({ id: NFCE_SP_HOMOLOGATION_QR_V3, qr: 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode', key: 'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta' });

// ---------------- exact decimals ----------------
const scaled = (value, scale) => { const [w, f = ''] = String(value).split('.'); return BigInt(w) * 10n ** BigInt(scale) + BigInt((f + '0'.repeat(scale)).slice(0, scale)); };
const fixed = (n, scale) => { const neg = n < 0n, a = neg ? -n : n, d = 10n ** BigInt(scale); return `${neg ? '-' : ''}${a / d}${scale ? `.${String(a % d).padStart(scale, '0')}` : ''}`; };
const cents = value => value === null || value === undefined ? 0n : scaled(value, 2);
const money = n => fixed(n, 2);
const positive = value => value !== null && value !== undefined && cents(value) > 0n;
/** Rate of the note (4 decimals) as the layout writes it (2 to 4 decimals). */
const rate = value => fixed(scaled(value ?? '0', 4), 4);
const complement = value => fixed(1000000n - scaled(value ?? '100', 4), 4);
/** Quantity (4 decimals) or unit value (10 decimals) without the trailing zeros the layout does not need. */
const quantity = value => fixed(scaled(value, 4), 4);
const unitValue = value => fixed(scaled(value, 10), 10);
const weight = value => fixed(scaled(value, 3), 3);

// ---------------- texts ----------------
// The layout accepts only the Latin-1 range without control characters; common typography becomes its plain form and line breaks a space.
const TYPOGRAPHY = { '\u2013': '-', '\u2014': '-', '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2026': '...', '\u00a0': ' ', '\u2022': '-', '\u00b7': '.' };
export function layoutText(value, max = null) {
  if (value === null || value === undefined) return null;
  let text = String(value).replace(/[\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u00a0\u2022\u00b7]/g, c => TYPOGRAPHY[c]).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (max !== null) text = [...text].slice(0, max).join('').trim();
  return text || null;
}
const digits = value => value === null || value === undefined ? '' : String(value).replace(/\D/g, '');

// ---------------- rules ----------------
const rule = (rules, severity, code, message, field = null) => { if (rules.length < 200) rules.push({ severity, code, message, field }); };
function cpfValid(v) {
  if (!/^\d{11}$/.test(v) || /^(\d)\1{10}$/.test(v)) return false;
  for (let n = 9; n < 11; n++) { let s = 0; for (let p = 0; p < n; p++) s += Number(v[p]) * (n + 1 - p); const d = (s * 10) % 11; if (Number(v[n]) !== (d === 10 ? 0 : d)) return false; }
  return true;
}
function gtinValid(v) {
  if (!/^(\d{8}|\d{12,14})$/.test(v)) return false;
  const body = v.slice(0, -1).split('').reverse().map(Number);
  const sum = body.reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(v.at(-1));
}

// ---------------- groups ----------------
function emitterGroup(e, invoice, rules) {
  const a = e.address ?? {}, document = digits(e.document);
  const group = {};
  if (e.person_type === 'fisica') {
    // Tipo da Pessoa: Pessoa Física (produtor rural etc.) writes the CPF of the emitter.
    if (cpfValid(document)) group.CPF = document;
    else rule(rules, 'error', 'emitter_cpf', 'Tipo da Pessoa da empresa é Pessoa Física, mas a identidade da empresa não traz um CPF válido (Empresa › Alterar dados da empresa).', 'emit.CPF');
  } else if (isValidCnpj(document)) group.CNPJ = document;
  else rule(rules, 'error', 'emitter_cnpj', 'Informe o CNPJ da empresa em Empresa › Alterar dados da empresa.', 'emit.CNPJ');
  Object.assign(group, { xNome: layoutText(e.legal_name, 60), xFant: layoutText(e.trade_name, 60),
    enderEmit: { xLgr: layoutText(a.street, 60), nro: layoutText(a.number, 60), xCpl: layoutText(a.complement, 60), xBairro: layoutText(a.district, 60), cMun: a.municipality_code ?? null,
      xMun: layoutText(a.city, 60), UF: a.state ?? null, CEP: digits(a.postal_code) || null, cPais: '1058', xPais: 'Brasil', fone: digits(a.phone).length >= 6 ? digits(a.phone).slice(0, 14) : null } });
  if (!e.legal_name) rule(rules, 'error', 'emitter_name', 'Informe a razão social da empresa.', 'emit.xNome');
  if (!a.municipality_code || !a.state || !STATE_CODES[a.state] || !String(a.municipality_code).startsWith(STATE_CODES[a.state])) rule(rules, 'error', 'emitter_municipality', 'O código do município da empresa não confere com a UF.', 'emit.enderEmit.cMun');
  // Inscrição Estadual: "Isento" writes ISENTO; otherwise the digits of the IE.
  const ie = digits(e.ie);
  if (e.ie_exempt) group.IE = 'ISENTO';
  else if (ie) group.IE = ie;
  else rule(rules, 'error', 'emitter_ie', 'Informe a Inscrição Estadual da empresa ou marque Isento.', 'emit.IE');
  // IEST: the IE of the substituto tributário in the UF of the recipient, when the note retains ICMS ST for that UF.
  const destState = invoice.recipient?.state ?? null;
  const substitute = (e.substitute_ies ?? []).find(s => s.uf === destState && destState !== a.state);
  if (substitute && cents(invoice.totals?.st) > 0n) group.IEST = digits(substitute.ie);
  if (cents(invoice.totals?.st) > 0n && destState && destState !== 'EX' && destState !== a.state && !substitute)
    rule(rules, 'warning', 'emitter_iest', `A nota tem ICMS ST para ${destState}, mas a empresa não tem Inscrição Estadual de substituto tributário nessa UF: a IEST não vai no XML.`, 'emit.IEST');
  // Inscrição Municipal and CNAE (the CNAE only goes with the IM, as the layout requires).
  const im = layoutText(e.municipal_registration, 15), cnae = digits(e.cnae);
  if (im) { group.IM = im; if (cnae.length === 7) group.CNAE = cnae; }
  else if (cnae) rule(rules, 'warning', 'emitter_cnae', 'O CNAE da empresa só vai no XML junto da Inscrição Municipal, que não está informada.', 'emit.CNAE');
  group.CRT = invoice.crt;
  if (e.crt && e.crt !== invoice.crt) rule(rules, 'error', 'emitter_crt', `O Código do regime tributário da nota (${invoice.crt}) é diferente do regime da empresa (${e.crt}).`, 'emit.CRT');
  // Inscrição Suframa of the emitter (ISUFEmit, 8 or 9 digits in the layout).
  const suframa = digits(e.suframa);
  if (suframa) { if (/^\d{8,9}$/.test(suframa)) group.ISUFEmit = suframa; else rule(rules, 'warning', 'emitter_suframa', 'A Inscrição Suframa da empresa tem mais de 9 dígitos e não cabe no leiaute: ela não vai no XML.', 'emit.ISUFEmit'); }
  return group;
}

function recipientGroup(invoice, rules) {
  const r = invoice.recipient ?? {}, model = invoice.model;
  if (model === '65' && !r.document && !r.name) return null;
  const group = {};
  const doc = digits(r.document);
  if (r.person_type === 'E' || r.state === 'EX') group.idEstrangeiro = layoutText(r.foreign_id, 20) ?? '';
  else if (doc.length === 14) { group.CNPJ = doc; if (!isValidCnpj(doc)) rule(rules, 'error', 'recipient_document', 'O CNPJ do destinatário é inválido.', 'dest.CNPJ'); }
  else if (doc.length === 11) { group.CPF = doc; if (!cpfValid(doc)) rule(rules, 'error', 'recipient_document', 'O CPF do destinatário é inválido.', 'dest.CPF'); }
  else rule(rules, 'error', 'recipient_document', 'Informe o CPF ou o CNPJ do destinatário.', 'dest');
  // Homologation: SEFAZ requires this name for the recipient of a test note.
  group.xNome = HOMOLOGATION_RECIPIENT;
  const foreign = r.person_type === 'E' || r.state === 'EX';
  const address = { xLgr: layoutText(r.street, 60), nro: layoutText(r.number, 60), xCpl: layoutText(r.complement, 60), xBairro: layoutText(r.district, 60),
    cMun: foreign ? '9999999' : r.municipality_code ?? null, xMun: foreign ? 'EXTERIOR' : layoutText(r.city, 60), UF: foreign ? 'EX' : r.state ?? null,
    CEP: foreign ? null : digits(r.postal_code) || null, cPais: foreign ? null : '1058', xPais: foreign ? layoutText(r.country, 60) : 'Brasil', fone: digits(r.phone).length >= 6 ? digits(r.phone) : null };
  const hasAddress = Boolean(r.street || r.number || r.district || r.city || r.municipality_code);
  if (model === '55' || hasAddress) {
    group.enderDest = address;
    if (!r.street || !r.number || !r.district || (!foreign && (!r.city || !r.municipality_code || !r.state))) rule(rules, 'error', 'recipient_address', 'Complete o endereço do destinatário (logradouro, número, bairro, município com o código e UF).', 'dest.enderDest');
    if (!foreign && r.municipality_code && r.state && STATE_CODES[r.state] && !String(r.municipality_code).startsWith(STATE_CODES[r.state])) rule(rules, 'error', 'recipient_municipality', 'O código do município do destinatário não confere com a UF.', 'dest.enderDest.cMun');
    if (foreign) rule(rules, 'error', 'recipient_country', 'Informe o código do país do destinatário estrangeiro (tabela do Banco Central): o cadastro guarda só o nome do país.', 'dest.enderDest.cPais');
  }
  const indicator = model === '65' ? '9' : foreign ? '9' : r.ie_indicator ?? (r.ie && r.ie !== 'ISENTO' ? '1' : r.ie === 'ISENTO' ? '2' : '9');
  group.indIEDest = indicator;
  if (indicator === '1') { if (r.ie && r.ie !== 'ISENTO') group.IE = digits(r.ie); else rule(rules, 'error', 'recipient_ie', 'Destinatário contribuinte do ICMS precisa da Inscrição Estadual.', 'dest.IE'); }
  if (indicator === '2' && r.ie && r.ie !== 'ISENTO') rule(rules, 'warning', 'recipient_ie', 'Destinatário contribuinte isento não leva Inscrição Estadual no XML.', 'dest.IE');
  if (r.email) group.email = layoutText(r.email, 60);
  return group;
}

function referenceGroups(invoice) {
  return (invoice.references ?? []).map(ref => {
    if (ref.type === 'nfe') return { refNFe: ref.key };
    if (ref.type === 'cte') return { refCTe: ref.key };
    if (ref.type === 'ecf') return { refECF: { mod: '2D', nECF: '1', nCOO: ref.number.slice(-6) } };
    if (ref.type === 'nf01' || ref.type === 'nf02') return { refNF: { cUF: STATE_CODES[invoice.recipient?.state] ?? '35', AAMM: ref.year_month, CNPJ: digits(invoice.recipient?.document).padStart(14, '0'), mod: ref.type === 'nf01' ? '01' : '02', serie: String(Number(ref.series)), nNF: String(Number(ref.number)) } };
    return { refNFP: { cUF: STATE_CODES[invoice.recipient?.state] ?? '35', AAMM: ref.year_month, ...(digits(invoice.recipient?.document).length === 11 ? { CPF: digits(invoice.recipient.document) } : { CNPJ: digits(invoice.recipient?.document) }),
      IE: digits(invoice.recipient?.ie) || 'ISENTO', mod: ref.type === 'nfp01' ? '01' : '04', serie: String(Number(ref.series)), nNF: String(Number(ref.number)) } };
  });
}

/** ICMS group of one item, from the situation (CST of the regime normal or CSOSN of the Simples). */
function icmsGroup(item, rules, n) {
  const i = item.icms ?? {}, s = i.situation, orig = i.origin ?? '0';
  if (!s) { rule(rules, 'error', 'item_icms', `Item ${n}: informe a situação tributária do ICMS.`, `det[${n}].imposto.ICMS`); return null; }
  const own = () => ({ modBC: i.bc_mode ?? '3', vBC: money(cents(i.base)), pICMS: rate(i.rate), vICMS: money(cents(i.value)) });
  const fcp = (withBase = true) => positive(i.fcp_value) ? { ...(withBase ? { vBCFCP: money(cents(i.base)) } : {}), pFCP: rate(i.fcp_rate), vFCP: money(cents(i.fcp_value)) } : {};
  const st = () => ({ modBCST: i.st_bc_mode ?? '4', ...(i.st_mva && scaled(i.st_mva, 4) > 0n ? { pMVAST: rate(i.st_mva) } : {}),
    ...(i.st_base_rate && scaled(i.st_base_rate, 4) < 1000000n ? { pRedBCST: complement(i.st_base_rate) } : {}), vBCST: money(cents(i.st_base)), pICMSST: rate(i.st_rate), vICMSST: money(cents(i.st_value)),
    ...(positive(i.st_fcp_value) ? { vBCFCPST: money(cents(i.st_base)), pFCPST: rate(i.fcp_rate ?? '0'), vFCPST: money(cents(i.st_fcp_value)) } : {}) });
  const deson = (reasons) => positive(i.deson_value) ? { vICMSDeson: money(cents(i.deson_value)), motDesICMS: reasons.includes(i.deson_reason) ? i.deson_reason : reasons[0], ...(i.deson_deduct !== undefined ? { indDeduzDeson: i.deson_deduct ? '1' : '0' } : {}) } : {};
  const reduced = () => ({ pRedBC: complement(i.base_rate ?? '100') });
  const retained = () => positive(i.ret_value) || positive(i.ret_base) ? { vBCSTRet: money(cents(i.ret_base)), pST: rate(i.ret_rate), ...(positive(i.ret_substitute_value) ? { vICMSSubstituto: money(cents(i.ret_substitute_value)) } : {}), vICMSSTRet: money(cents(i.ret_value)) } : {};
  const mono = () => ({ ...(i.mono_qty ? { qBCMono: quantity(i.mono_qty) } : {}), adRemICMS: rate(i.mono_rate), vICMSMono: money(cents(i.mono_value)) });
  switch (s) {
    case '00': return { ICMS00: { orig, CST: s, ...own(), ...fcp(false) } };
    case '02': return { ICMS02: { orig, CST: s, ...mono() } };
    case '10': return { ICMS10: { orig, CST: s, ...own(), ...fcp(), ...st() } };
    case '15': return { ICMS15: { orig, CST: s, ...mono(), adRemICMSReten: '0.00', vICMSMonoReten: '0.00' } };
    case '20': return { ICMS20: { orig, CST: s, modBC: i.bc_mode ?? '3', ...reduced(), vBC: money(cents(i.base)), pICMS: rate(i.rate), vICMS: money(cents(i.value)), ...fcp(), ...deson(['3', '9', '12']) } };
    case '30': return { ICMS30: { orig, CST: s, ...st(), ...deson(['6', '7', '9']) } };
    case '40': case '41': case '50': return { ICMS40: { orig, CST: s, ...deson(['1', '3', '4', '5', '6', '7', '8', '9', '10', '11', '16', '90']) } };
    case '51': {
      const op = positive(i.base) ? { modBC: i.bc_mode ?? '3', ...(i.base_rate && scaled(i.base_rate, 4) < 1000000n ? reduced() : {}), ...(i.rbc_benefit_code ? { cBenefRBC: i.rbc_benefit_code } : {}), vBC: money(cents(i.base)), pICMS: rate(i.rate) } : {};
      const operation = positive(i.base) ? cents(i.base) * scaled(i.rate ?? '0', 4) : 0n, icmsOp = (operation + 500000n) / 1000000n;
      const deferred = i.deferral_rate ? (icmsOp * scaled(i.deferral_rate, 4) + 500000n) / 1000000n : 0n;
      return { ICMS51: { orig, CST: s, ...op, ...(positive(i.base) ? { vICMSOp: money(icmsOp), pDif: rate(i.deferral_rate ?? '0'), vICMSDif: money(deferred), vICMS: money(cents(i.value)) } : {}), ...fcp(),
        ...(positive(i.fcp_deferral_value) ? { pFCPDif: rate(i.fcp_deferral_rate ?? '0'), vFCPDif: money(cents(i.fcp_deferral_value)), ...(positive(i.fcp_effective_value) ? { vFCPEfet: money(cents(i.fcp_effective_value)) } : {}) } : {}) } };
    }
    case '53': return { ICMS53: { orig, CST: s, ...(i.mono_qty ? { qBCMono: quantity(i.mono_qty) } : {}), ...(i.mono_rate ? { adRemICMS: rate(i.mono_rate) } : {}), ...(positive(i.mono_icms_value) ? { vICMSMonoOp: money(cents(i.mono_icms_value)) } : {}),
      ...(i.deferral_rate ? { pDif: rate(i.deferral_rate) } : {}), ...(positive(i.mono_deferred_value) ? { vICMSMonoDif: money(cents(i.mono_deferred_value)) } : {}), ...(positive(i.mono_value) ? { vICMSMono: money(cents(i.mono_value)) } : {}) } };
    case '60': return { ICMS60: { orig, CST: s, ...retained() } };
    case '61': return { ICMS61: { orig, CST: s, ...(i.mono_qty ? { qBCMonoRet: quantity(i.mono_qty) } : {}), adRemICMSRet: rate(i.mono_rate), vICMSMonoRet: money(cents(i.mono_value)) } };
    case '70': return { ICMS70: { orig, CST: s, modBC: i.bc_mode ?? '3', ...reduced(), vBC: money(cents(i.base)), pICMS: rate(i.rate), vICMS: money(cents(i.value)), ...fcp(), ...st(), ...deson(['3', '9', '12']) } };
    case '90': return { ICMS90: { orig, CST: s, ...(positive(i.base) ? { modBC: i.bc_mode ?? '3', vBC: money(cents(i.base)), ...(i.base_rate && scaled(i.base_rate, 4) < 1000000n ? reduced() : {}), pICMS: rate(i.rate), vICMS: money(cents(i.value)), ...fcp() } : {}),
      ...(positive(i.st_base) ? st() : {}), ...deson(['3', '9', '12']) } };
    case '101': return { ICMSSN101: { orig, CSOSN: s, pCredSN: rate(i.credit_rate), vCredICMSSN: money(cents(i.credit_value)) } };
    case '102': case '103': case '300': case '400': return { ICMSSN102: { orig, CSOSN: s } };
    case '201': return { ICMSSN201: { orig, CSOSN: s, ...st(), pCredSN: rate(i.credit_rate), vCredICMSSN: money(cents(i.credit_value)) } };
    case '202': case '203': return { ICMSSN202: { orig, CSOSN: s, ...st() } };
    case '500': return { ICMSSN500: { orig, CSOSN: s, ...retained() } };
    case '900': return { ICMSSN900: { orig, CSOSN: s, ...(positive(i.base) ? { modBC: i.bc_mode ?? '3', vBC: money(cents(i.base)), ...(i.base_rate && scaled(i.base_rate, 4) < 1000000n ? reduced() : {}), pICMS: rate(i.rate), vICMS: money(cents(i.value)) } : {}),
      ...(positive(i.st_base) ? st() : {}), ...(positive(i.credit_value) ? { pCredSN: rate(i.credit_rate), vCredICMSSN: money(cents(i.credit_value)) } : {}) } };
    default: rule(rules, 'error', 'item_icms', `Item ${n}: a situação ${s} do ICMS não é gerada pelo Brufap.`, `det[${n}].imposto.ICMS`); return null;
  }
}
const TAXED_IPI = ['00', '49', '50', '99'];
function ipiGroup(item) {
  const i = item.ipi;
  if (!i?.situation) return null;
  const head = { ...(i.seal_code ? { cSelo: layoutText(i.seal_code, 60) } : {}), cEnq: i.framing_code ?? '999' };
  if (!TAXED_IPI.includes(i.situation)) return { ...head, IPINT: { CST: i.situation } };
  const perUnit = i.unit_value && !positive(i.base);
  return { ...head, IPITrib: { CST: i.situation, ...(perUnit ? { qUnid: quantity(item.quantity), vUnid: fixed(scaled(i.unit_value, 4), 4) } : { vBC: money(cents(i.base)), pIPI: rate(i.rate) }), vIPI: money(cents(i.value)) } };
}
const PIS_ALIQ = ['01', '02'], PIS_NT = ['04', '05', '06', '07', '08', '09'];
function pisGroup(item, name, rules, n) {
  const g = item[name.toLowerCase()], upper = name;
  if (!g?.situation) { rule(rules, 'error', `item_${name.toLowerCase()}`, `Item ${n}: informe a situação tributária do ${name}.`, `det[${n}].imposto.${name}`); return null; }
  const s = g.situation, value = money(cents(g.value));
  if (PIS_ALIQ.includes(s)) return { [`${upper}Aliq`]: { CST: s, vBC: money(cents(g.base)), [`p${upper}`]: rate(g.rate), [`v${upper}`]: value } };
  if (s === '03') return { [`${upper}Qtde`]: { CST: s, qBCProd: quantity(item.quantity), vAliqProd: fixed(scaled(g.unit_value ?? '0', 4), 4), [`v${upper}`]: value } };
  if (PIS_NT.includes(s)) return { [`${upper}NT`]: { CST: s } };
  return { [`${upper}Outr`]: { CST: s, ...(g.unit_value && !positive(g.base) ? { qBCProd: quantity(item.quantity), vAliqProd: fixed(scaled(g.unit_value, 4), 4) } : { vBC: money(cents(g.base)), [`p${upper}`]: rate(g.rate) }), [`v${upper}`]: value } };
}
function productGroup(item, invoice, rules, n, homologationName) {
  const allocated = item.allocated ?? {}, gtin = item.gtin ?? 'SEM GTIN', gtinTax = item.gtin_tax ?? item.gtin ?? 'SEM GTIN';
  if (gtin !== 'SEM GTIN' && !gtinValid(gtin)) rule(rules, 'error', 'item_gtin', `Item ${n}: o GTIN/EAN ${gtin} tem dígito verificador inválido.`, `det[${n}].prod.cEAN`);
  const cfop = item.cfop ?? invoice.cfop;
  if (!cfop) rule(rules, 'error', 'item_cfop', `Item ${n}: informe o CFOP (no item ou no cabeçalho da nota).`, `det[${n}].prod.CFOP`);
  else checkCfop(cfop, invoice, rules, n);
  const ncm = item.ncm ?? null;
  if (!ncm) rule(rules, 'error', 'item_ncm', `Item ${n}: informe o NCM (8 dígitos).`, `det[${n}].prod.NCM`);
  else if (ncm === '00' && item.kind !== 'S') rule(rules, 'warning', 'item_ncm', `Item ${n}: NCM 00 é usado só para serviços.`, `det[${n}].prod.NCM`);
  const taxUnit = item.others?.tax_unit ?? item.unit, taxQty = item.others?.tax_quantity ?? item.quantity;
  const line = cents(item.total);
  const unitTax = scaled(taxQty, 4) > 0n ? (line * 10n ** 12n / scaled(taxQty, 4) + 0n) : 0n; // 10 decimals of vProd / qTrib
  const group = { cProd: layoutText(item.code, 60) ?? String(n), cEAN: gtin, ...(item.barcode ? { cBarra: layoutText(item.barcode, 30) } : {}),
    xProd: homologationName ?? layoutText(item.description, 120), NCM: ncm, ...(item.cest ? { CEST: item.cest, ...(item.stock?.scale ? { indEscala: item.stock.scale } : {}), ...(item.stock?.manufacturer_cnpj ? { CNPJFab: item.stock.manufacturer_cnpj } : {}) } : {}),
    ...(item.icms?.benefit_code ? { cBenef: item.icms.benefit_code } : {}), ...(item.ipi?.tipi_exception ? { EXTIPI: item.ipi.tipi_exception.padStart(2, '0') } : {}),
    CFOP: cfop ?? null, uCom: layoutText(item.unit, 6) ?? 'UN', qCom: quantity(item.quantity), vUnCom: unitValue(item.unit_price), vProd: money(line),
    cEANTrib: gtinTax, ...(item.barcode_tax ? { cBarraTrib: layoutText(item.barcode_tax, 30) } : {}), uTrib: layoutText(taxUnit, 6) ?? 'UN', qTrib: quantity(taxQty),
    vUnTrib: taxUnit === item.unit && taxQty === item.quantity ? unitValue(item.unit_price) : fixed(unitTax, 10),
    ...(positive(allocated.freight) ? { vFrete: allocated.freight } : {}), ...(positive(allocated.insurance) ? { vSeg: allocated.insurance } : {}),
    ...(positive(allocated.discount) ? { vDesc: allocated.discount } : {}), ...(positive(allocated.other_expenses) ? { vOutro: allocated.other_expenses } : {}),
    indTot: item.invoiced === false ? '0' : '1' };
  if (invoice.issue_type === 'I' && invoice.import_declaration) {
    const d = invoice.import_declaration;
    group.DI = [{ nDI: layoutText(d.number, 15), dDI: d.registration_date ?? null, xLocDesemb: layoutText(d.clearance_place, 60), UFDesemb: d.clearance_state ?? null, dDesemb: d.clearance_date ?? null,
      tpViaTransp: d.transport_route ?? null, ...(positive(d.afrmm_value) ? { vAFRMM: d.afrmm_value } : {}), tpIntermedio: d.intermediation ?? null,
      ...(d.acquirer_cnpj ? { CNPJ: d.acquirer_cnpj } : {}), ...(d.acquirer_state ? { UFTerceiro: d.acquirer_state } : {}), cExportador: layoutText(d.exporter_code, 60),
      adi: (d.additions?.length ? d.additions : [{}]).filter(a => !item.ii?.addition || !a.number || a.number === item.ii.addition).slice(0, 1).map(a => ({ ...(a.number ? { nAdicao: a.number } : {}), nSeqAdic: a.sequence ?? String(n),
        cFabricante: layoutText(a.manufacturer, 60) ?? layoutText(d.exporter_code, 60), ...(positive(a.discount) ? { vDescDI: a.discount } : {}), ...(a.drawback ? { nDraw: a.drawback } : {}) })) }];
  }
  if (item.export && (item.export.drawback || item.export.key)) group.detExport = [{ ...(item.export.drawback ? { nDraw: item.export.drawback } : {}),
    ...(item.export.key ? { exportInd: { nRE: item.export.registry ?? '', chNFe: item.export.key, qExport: quantity(item.quantity) } } : {}) }];
  if (item.others?.purchase_order) group.xPed = layoutText(item.others.purchase_order, 15);
  if (item.others?.purchase_order_item) group.nItemPed = item.others.purchase_order_item;
  if (item.others?.fci) group.nFCI = item.others.fci.toUpperCase();
  if (item.vehicle) { const v = item.vehicle; group.veicProd = { tpOp: v.operation, chassi: v.chassis, cCor: v.color_code, xCor: v.color, pot: v.power, cilin: v.displacement, pesoL: v.net_weight, pesoB: v.gross_weight,
    nSerie: v.serial, tpComb: v.fuel_type, nMotor: v.engine_number, CMT: v.cmt, dist: v.wheelbase, anoMod: v.model_year, anoFab: v.manufacture_year, tpPint: v.paint_type, tpVeic: v.vehicle_type,
    espVeic: v.species, VIN: v.vin_condition, condVeic: v.vehicle_condition, cMod: v.brand_model_code, cCorDENATRAN: v.denatran_color, lota: v.capacity, tpRest: v.restriction }; }
  else if (item.medicine) group.med = { cProdANVISA: item.medicine.anvisa_code, ...(item.medicine.exemption_reason ? { xMotivoIsencao: layoutText(item.medicine.exemption_reason, 255) } : {}), vPMC: item.medicine.max_price ?? '0.00' };
  else if (item.weapon) group.arma = [{ tpArma: item.weapon.type, nSerie: layoutText(item.weapon.serial, 15), nCano: layoutText(item.weapon.barrel, 15), descr: layoutText(item.weapon.description, 256) }];
  else if (item.fuel?.anp_code) { const f = item.fuel; group.comb = { cProdANP: f.anp_code, descANP: layoutText(f.anp_description, 95), ...(f.glp_rate ? { pGLP: rate(f.glp_rate) } : {}), ...(f.glgnn_rate ? { pGNn: rate(f.glgnn_rate) } : {}),
    ...(f.glgni_rate ? { pGNi: rate(f.glgni_rate) } : {}), ...(positive(f.start_value) ? { vPart: f.start_value } : {}), ...(f.codif ? { CODIF: f.codif } : {}), ...(f.ambient_qty ? { qTemp: quantity(f.ambient_qty) } : {}), UFCons: f.consumption_state ?? invoice.recipient?.state ?? null,
    ...(f.cide_base ? { CIDE: { qBCProd: quantity(f.cide_base), vAliqProd: fixed(scaled(f.cide_rate ?? '0', 4), 4), vCIDE: f.cide_value ?? '0.00' } } : {}), ...(f.biodiesel_rate ? { pBio: rate(f.biodiesel_rate) } : {}) }; }
  return group;
}
/** CFOP: 1/2/3 on entries and 5/6/7 on exits, by the destination of the operation (interna, interestadual, exterior). */
function checkCfop(cfop, invoice, rules, n) {
  const destination = operationDestination(invoice).idDest, first = cfop[0];
  const expected = invoice.direction === '1' ? { 1: '5', 2: '6', 3: '7' }[destination] : { 1: '1', 2: '2', 3: '3' }[destination];
  if (first !== expected) rule(rules, 'error', 'item_cfop', `Item ${n}: o CFOP ${cfop} não combina com uma operação ${invoice.direction === '1' ? 'de saída' : 'de entrada'} ${destination === '1' ? 'interna' : destination === '2' ? 'interestadual' : 'com o exterior'} (use ${expected}xxx).`, `det[${n}].prod.CFOP`);
}
function operationDestination(invoice, emitterState = invoice.__emitter_state) {
  if (invoice.model === '65') return { idDest: '1' };
  if (invoice.operation_destination) return { idDest: invoice.operation_destination };
  const r = invoice.recipient ?? {};
  if (r.person_type === 'E' || r.state === 'EX') return { idDest: '3' };
  return { idDest: !r.state || !emitterState || r.state === emitterState ? '1' : '2' };
}
function difalGroup(item) {
  const i = item.icms ?? {};
  if (!positive(i.difal_base) && !positive(i.difal_dest_value)) return null;
  return { vBCUFDest: money(cents(i.difal_base)), ...(positive(i.difal_fcp_value) ? { vBCFCPUFDest: money(cents(i.difal_base)), pFCPUFDest: rate(i.difal_fcp_rate ?? '0') } : {}),
    pICMSUFDest: rate(i.difal_internal_rate), pICMSInter: (i.difal_interstate_rate ?? '12.0000').replace(/(\.\d{2})00$/, '$1'), pICMSInterPart: rate(i.difal_share_rate ?? '100'),
    ...(positive(i.difal_fcp_value) ? { vFCPUFDest: money(cents(i.difal_fcp_value)) } : {}), vICMSUFDest: money(cents(i.difal_dest_value)), vICMSUFRemet: money(cents(i.difal_origin_value)) };
}

function paymentGroups(invoice, rules) {
  const total = cents(invoice.totals?.total), installments = invoice.payment?.installments ?? [];
  const adjustment = ['3', '4'].includes(invoice.purpose);
  if (adjustment) return { detPag: [{ tPag: '90', vPag: '0.00' }] };
  if (!installments.length) {
    if (invoice.model === '65') rule(rules, 'error', 'payment_missing', 'A NFC-e precisa das formas de pagamento (aba Pagamento) somando o total.', 'pag');
    return { detPag: [{ tPag: invoice.model === '65' ? '01' : '90', vPag: invoice.model === '65' ? money(total) : '0.00' }] };
  }
  const sum = installments.reduce((s, p) => s + cents(p.amount), 0n);
  if (sum !== total) rule(rules, invoice.model === '65' ? 'error' : 'warning', 'payment_total', `As parcelas somam R$ ${money(sum)} e o total da nota é R$ ${money(total)}.`, 'pag');
  const deferred = installments.length > 1 || installments.some(p => p.date && invoice.issue_date && p.date > invoice.issue_date);
  return { detPag: installments.slice(0, 100).map(p => {
    const type = p.method ?? '99';
    const card = p.card && Object.keys(p.card).length && ['03', '04', '17'].includes(type) ? { tpIntegra: p.card.integration ?? '2', ...(p.card.cnpj ? { CNPJ: p.card.cnpj } : {}), ...(p.card.brand ? { tBand: p.card.brand } : {}), ...(p.card.authorization ? { cAut: layoutText(p.card.authorization, 128) } : {}) } : null;
    return { indPag: invoice.payment?.indicator ?? (deferred ? '1' : '0'), tPag: type, ...(type === '99' ? { xPag: layoutText(p.note, 60) ?? 'Outros' } : {}), vPag: p.amount, ...(card ? { card } : {}) };
  }) };
}
function billingGroup(invoice) {
  const installments = invoice.payment?.installments ?? [];
  if (invoice.model !== '55' || !installments.length || ['3', '4'].includes(invoice.purpose)) return null;
  const total = cents(invoice.totals?.total), sum = installments.reduce((s, p) => s + cents(p.amount), 0n);
  return { fat: { nFat: String(invoice.__number), vOrig: money(sum), vDesc: '0.00', vLiq: money(sum) },
    dup: installments.slice(0, 120).filter(p => positive(p.amount)).map((p, i) => ({ nDup: String(i + 1).padStart(3, '0'), dVenc: p.date, vDup: p.amount })), __total: total };
}
function transportGroup(invoice, rules) {
  const t = invoice.transport ?? {}, c = t.carrier ?? {}, v = t.vehicle ?? {}, vol = t.volumes ?? {};
  const group = { modFrete: t.freight_by ?? '9' };
  if (invoice.model === '65' && group.modFrete !== '9' && invoice.presence !== '4') rule(rules, 'error', 'nfce_transport', 'A NFC-e só leva transporte na entrega a domicílio (Indicador de presença 4); use 9 - Sem Ocorrência de Transporte.', 'transp.modFrete');
  if (t.mode === 'manual' && (c.name || c.document)) group.transporta = { ...(digits(c.document).length === 14 ? { CNPJ: digits(c.document) } : digits(c.document).length === 11 ? { CPF: digits(c.document) } : {}),
    xNome: layoutText(c.name, 60), ...(c.ie ? { IE: c.ie } : {}), xEnder: layoutText(c.address, 60), xMun: layoutText(c.city, 60), UF: c.state ?? null };
  if (t.mode === 'manual' && v.plate) group.veicTransp = { placa: v.plate, ...(v.state ? { UF: v.state } : {}), ...(v.rntc ? { RNTC: layoutText(v.rntc, 20) } : {}) };
  if (Object.keys(vol).length) group.vol = [{ ...(vol.quantity ? { qVol: vol.quantity } : {}), ...(vol.species ? { esp: vol.species.toUpperCase() } : {}), ...(vol.brand ? { marca: layoutText(vol.brand, 60) } : {}),
    ...(vol.numbering ? { nVol: layoutText(vol.numbering, 60) } : {}), ...(vol.net_weight ? { pesoL: weight(vol.net_weight) } : {}), ...(vol.gross_weight ? { pesoB: weight(vol.gross_weight) } : {}) }];
  return group;
}
function totalsGroup(invoice) {
  const t = invoice.totals ?? {}, items = invoice.items ?? [];
  const sum = (group, field) => items.reduce((s, item) => s + cents(item[group]?.[field]), 0n);
  const mono = items.filter(i => ['02', '15', '53'].includes(i.icms?.situation)), monoRet = items.filter(i => i.icms?.situation === '61');
  const icmsTot = { vBC: t.icms_base ?? '0.00', vICMS: t.icms ?? '0.00', vICMSDeson: t.deson ?? '0.00',
    ...(positive(t.difal_dest) || positive(t.difal_fcp) || positive(t.difal_origin) ? { vFCPUFDest: t.difal_fcp ?? '0.00', vICMSUFDest: t.difal_dest ?? '0.00', vICMSUFRemet: t.difal_origin ?? '0.00' } : {}),
    vFCP: t.fcp ?? '0.00', vBCST: t.st_base ?? '0.00', vST: t.st ?? '0.00', vFCPST: t.fcp_st ?? '0.00', vFCPSTRet: '0.00',
    // qBCMono of the totals has two decimals in the layout (the quantity of each item keeps its four).
    ...(mono.length ? { qBCMono: money(mono.reduce((s, i) => s + scaled(i.icms.mono_qty ?? '0', 2), 0n)), vICMSMono: money(mono.reduce((s, i) => s + cents(i.icms.mono_value), 0n)) } : {}),
    ...(monoRet.length ? { qBCMonoRet: money(monoRet.reduce((s, i) => s + scaled(i.icms.mono_qty ?? '0', 2), 0n)), vICMSMonoRet: money(monoRet.reduce((s, i) => s + cents(i.icms.mono_value), 0n)) } : {}),
    vProd: t.products ?? '0.00', vFrete: t.freight ?? '0.00', vSeg: t.insurance ?? '0.00', vDesc: t.discount ?? '0.00', vII: t.ii ?? '0.00', vIPI: t.ipi ?? '0.00', vIPIDevol: t.ipi_devol ?? '0.00',
    vPIS: t.pis ?? '0.00', vCOFINS: t.cofins ?? '0.00', vOutro: t.other_expenses ?? '0.00', vNF: t.total ?? '0.00', ...(positive(t.approx_taxes) ? { vTotTrib: t.approx_taxes } : {}) };
  const retentions = { ...(positive(t.ret_pis) ? { vRetPIS: t.ret_pis } : {}), ...(positive(t.ret_cofins) ? { vRetCOFINS: t.ret_cofins } : {}), ...(positive(t.ret_csll) ? { vRetCSLL: t.ret_csll } : {}),
    ...(positive(t.ret_base) ? { vBCIRRF: t.ret_base } : {}), ...(positive(t.ret_ir) ? { vIRRF: t.ret_ir } : {}) };
  return { ICMSTot: icmsTot, ...(Object.keys(retentions).length ? { retTrib: retentions } : {}) };
}
function additionalGroup(invoice) {
  const complementary = [invoice.nature_additional_info, invoice.additional_info].map(v => layoutText(v)).filter(Boolean).join(' ');
  const fiscal = layoutText(invoice.nature_fiscal_info, 2000);
  const group = { ...(fiscal ? { infAdFisco: fiscal } : {}), ...(complementary ? { infCpl: [...complementary].slice(0, 5000).join('') } : {}) };
  return Object.keys(group).length ? group : null;
}

// ---------------- the document ----------------
/** cNF of the support XML: 8 digits derived from the note id (never the number itself, as the layout requires). */
function numericCode(id, number) {
  const hex = String(id ?? '').replace(/[^0-9a-f]/gi, '').slice(-12) || '0';
  let code = String(BigInt(`0x${hex}`) % 100000000n).padStart(8, '0');
  if (code === String(number).padStart(8, '0').slice(-8)) code = String((Number(code) + 1) % 100000000).padStart(8, '0');
  return code;
}
/**
 * The XML of a note of the Brufap and the offline rules. source: { invoice, emitter, numbering: { next_number }, now: { date, time, offset } }.
 * Returns { xml, access_key, number, cnf, issued_at, rules } (rules: [{ severity: 'error'|'warning', code, message, field }]).
 */
export function nativeInvoiceXml({ invoice, emitter, numbering, now }) {
  if (!invoice || !emitter || !now || !/^\d{4}-\d{2}-\d{2}$/.test(now.date ?? '') || !/^\d{2}:\d{2}:\d{2}$/.test(now.time ?? '') || !/^[+-]\d{2}:\d{2}$/.test(now.offset ?? '')) throw new NativeInvoiceError('NATIVE_SOURCE_INVALID');
  if (['T', 'S', 'X'].includes(invoice.issue_type)) throw new NativeInvoiceError('NATIVE_NOT_OWN_NOTE');
  const rules = [];
  const state = emitter.address?.state ?? null, cUF = STATE_CODES[state] ?? '35';
  const note = { ...invoice, __emitter_state: state };
  const number = Number.isInteger(numbering?.next_number) && numbering.next_number > 0 ? numbering.next_number : 1;
  if (!Number.isInteger(numbering?.next_number)) rule(rules, 'warning', 'numbering_missing', `A série ${invoice.series} de homologação do modelo ${invoice.model} não tem próximo número em Séries fiscais: o XML usa o número 1.`, 'ide.nNF');
  else if (numbering.enabled === false) rule(rules, 'warning', 'numbering_disabled', `A série ${invoice.series} de homologação está desabilitada em Séries fiscais.`, 'ide.serie');
  note.__number = number;
  const issuedAt = `${invoice.issue_date}T${now.time}${now.offset}`;
  // dhEmi: SEFAZ refuses a note issued more than 30 days before the transmission or in the future.
  const days = Math.round((Date.parse(`${now.date}T00:00:00Z`) - Date.parse(`${invoice.issue_date}T00:00:00Z`)) / 86400000);
  if (days < 0) rule(rules, 'error', 'issue_date_future', 'A data de emissão está no futuro.', 'ide.dhEmi');
  else if (days > 30) rule(rules, 'warning', 'issue_date_old', 'A data de emissão tem mais de 30 dias: a SEFAZ recusa a autorização (Rejeição 228).', 'ide.dhEmi');
  const document = digits(emitter.document), keyDocument = emitter.person_type === 'fisica' && document.length === 11 ? `000${document}` : document.padStart(14, '0').slice(-14);
  const cnf = numericCode(invoice.id, number);
  const base = `${cUF}${invoice.issue_date.slice(2, 4)}${invoice.issue_date.slice(5, 7)}${keyDocument}${invoice.model}${String(invoice.series).padStart(3, '0')}${String(number).padStart(9, '0')}1${cnf}`;
  let key;
  try { key = base + accessKeyCheckDigit(base); } catch { key = `${base}0`; rule(rules, 'error', 'access_key', 'Não foi possível montar a chave de acesso: confira o CNPJ/CPF da empresa e a UF.', 'infNFe.Id'); }
  const destination = operationDestination(note);
  const intermediated = ['2', '3', '4', '9'].includes(invoice.presence);
  const ide = { cUF, cNF: cnf, natOp: layoutText(invoice.nature_description, 60), mod: invoice.model, serie: String(invoice.series), nNF: String(number), dhEmi: issuedAt,
    ...(invoice.model === '55' && invoice.exit_date ? { dhSaiEnt: `${invoice.exit_date}T${invoice.exit_time ? `${invoice.exit_time}:00` : now.time}${now.offset}` } : {}),
    tpNF: invoice.direction, idDest: destination.idDest, cMunFG: emitter.address?.municipality_code ?? null, tpImp: invoice.model === '65' ? '4' : '1', tpEmis: '1', cDV: key.at(-1), tpAmb: '2',
    finNFe: invoice.purpose, ...(invoice.purpose === '5' && invoice.credit_debit_type ? { tpNFDebito: invoice.credit_debit_type } : {}), ...(invoice.purpose === '6' && invoice.credit_debit_type ? { tpNFCredito: invoice.credit_debit_type } : {}),
    indFinal: invoice.final_consumer ? '1' : '0', indPres: invoice.presence, ...(intermediated ? { indIntermed: invoice.intermediary?.present ? '1' : '0' } : {}), procEmi: '0', verProc: 'BRUFAP-NATIVO-1',
    NFref: referenceGroups(invoice) };
  if (['2', '4'].includes(invoice.purpose) && !(invoice.references ?? []).length) rule(rules, 'error', 'reference_missing', 'A nota complementar ou de devolução precisa do documento referenciado (aba Documento referenciado).', 'ide.NFref');
  if (invoice.model === '65' && invoice.direction !== '1') rule(rules, 'error', 'nfce_direction', 'A NFC-e é sempre de saída.', 'ide.tpNF');
  const homologationProduct = invoice.model === '65';
  const det = (invoice.items ?? []).map((item, index) => {
    const n = index + 1;
    if (item.kind === 'S') rule(rules, 'error', 'item_service', `Item ${n}: serviço (ISSQN) não é gerado no XML da NF-e pelo Brufap.`, `det[${n}]`);
    const tax = { ...(positive(item.others?.approx_taxes) ? { vTotTrib: item.others.approx_taxes } : {}), ICMS: icmsGroup(item, rules, n), IPI: ipiGroup(item),
      ...(item.ii?.situation === 'T' || positive(item.ii?.value) ? { II: { vBC: money(cents(item.ii.base)), vDespAdu: money(cents(item.ii.customs_expense)), vII: money(cents(item.ii.value)), vIOF: '0.00' } } : {}),
      PIS: pisGroup(item, 'PIS', rules, n), COFINS: pisGroup(item, 'COFINS', rules, n), ICMSUFDest: difalGroup(item) };
    const info = layoutText([item.info, item.complementary_info].filter(Boolean).join(' '), 500);
    return { '@nItem': String(n), prod: productGroup(item, note, rules, n, homologationProduct && index === 0 ? HOMOLOGATION_PRODUCT : null), imposto: tax,
      ...(positive(item.ipi?.devol_value) ? { impostoDevol: { pDevol: fixed(scaled(item.ipi.devol_rate ?? '0', 2), 2), IPI: { vIPIDevol: item.ipi.devol_value } } } : {}), ...(info ? { infAdProd: info } : {}) };
  });
  if (det.length > 990) rule(rules, 'error', 'items_limit', 'A nota pode ter até 990 itens.', 'det');
  const billing = billingGroup(note);
  const inf = { '@versao': '4.00', '@Id': `NFe${key}`, ide, emit: emitterGroup(emitter, invoice, rules), dest: recipientGroup(invoice, rules),
    autXML: (invoice.authorized_xml ?? []).map(a => digits(a.document).length === 11 ? { CPF: digits(a.document) } : { CNPJ: digits(a.document) }),
    det, total: totalsGroup(invoice), transp: transportGroup(invoice, rules), ...(billing ? { cobr: { fat: billing.fat, dup: billing.dup } } : {}), pag: paymentGroups(invoice, rules),
    ...(invoice.intermediary?.present ? { infIntermed: { CNPJ: invoice.intermediary.cnpj, idCadIntTran: layoutText(invoice.intermediary.identification, 60) } } : {}),
    infAdic: additionalGroup(invoice),
    ...(invoice.issue_type === 'E' && invoice.export ? { exporta: { UFSaidaPais: invoice.export.exit_state ?? null, xLocExporta: layoutText(invoice.export.exit_place, 60), ...(invoice.export.dispatch_place ? { xLocDespacho: layoutText(invoice.export.dispatch_place, 60) } : {}) } } : {}) };
  if (invoice.model === '55' && !inf.dest) rule(rules, 'error', 'recipient_missing', 'A NF-e precisa do destinatário.', 'dest');
  // NFC-e: the supplement of the QR Code v3 online of SP homologation (NT 2025.001, without CSC); other UFs are not built.
  const supplement = invoice.model === '65' ? (state === 'SP' ? { qrCode: `${SP_QR.qr}?p=${key}|3|2`, urlChave: SP_QR.key } : (rule(rules, 'error', 'nfce_qr', 'O QR Code da NFC-e é gerado só para SP (homologação).', 'infNFeSupl'), null)) : null;
  // Rule of the layout: the total of the note equals the sum the totals of the note already keep (checked by the contract of the note).
  const clean = value => Array.isArray(value) ? value.map(clean).filter(v => v !== null && v !== undefined) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith('__')).map(([k, v]) => [k, clean(v)]).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length))) : value;
  const xml = schemaXml(clean({ infNFe: inf, ...(supplement ? { infNFeSupl: supplement } : {}) }));
  return { xml, access_key: key, number, cnf, issued_at: issuedAt, rules };
}

/** Validar: the XML, the schema check of PL 010f and the offline rules, in one answer for the screen. */
export function validateNativeInvoice(source) {
  const built = nativeInvoiceXml(source);
  const schema = checkNfeSchema(built.xml, { signature: 'optional' });
  return { ...built, schema: { profile: SCHEMA_PROFILE, valid: schema.valid, truncated: schema.truncated, errors: schema.errors.map(e => ({ ...e, message: schemaErrorText(e) })) },
    valid: schema.valid && !built.rules.some(r => r.severity === 'error') };
}
