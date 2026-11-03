import { createItau109BarcodePreview, createItau109OperationalBarcodePreviewV2, BoletoError } from '../../boleto-core/src/index.mjs';
import { validateOperationalRemittanceV2 } from '../../cnab-core/src/operational-v2.mjs';
import { validDocument, dateField } from '../../cnab-core/src/primitives.mjs';

export class BoletoPreviewError extends Error {
  constructor(code) { super(code); this.name = 'BoletoPreviewError'; this.code = code; }
}
const fail = code => { throw new BoletoPreviewError(code); };
const requireValue = (ok, code = 'BOLETO_PREVIEW_INPUT_INVALID') => { if (!ok) fail(code); };
const PROFILE = ['bank', 'wallet', 'layout', 'accountId', 'agency', 'account', 'accountDigit', 'cnpj', 'companyName', 'contractVerified', 'agreementReference', 'simpleCollectionPolicyVerified'];
const ADDRESS = ['address', 'neighborhood', 'city', 'state', 'postalCode'];
const STATES = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));

// Every nested object is copied before hashing. Never invoke caller accessors.
function record(value, fields) {
  try {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
    requireValue([null, Object.prototype].includes(Object.getPrototypeOf(value)));
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors), result = {};
    requireValue(keys.length === fields.length && keys.every(k => typeof k === 'string' && fields.includes(k)));
    for (const key of fields) {
      const d = descriptors[key];
      requireValue(d && 'value' in d && d.enumerable);
      result[key] = d.value;
    }
    return result;
  } catch (error) { if (error instanceof BoletoPreviewError) throw error; fail('BOLETO_PREVIEW_INPUT_INVALID'); }
}
function literal(value, max) {
  requireValue(typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value
    && /^[A-Za-zÀ-ÖØ-öø-ÿ0-9 .,;:'"!?&@()/#%+_<>\-=]+$/.test(value), 'BOLETO_PREVIEW_TEXT_INVALID');
  return value;
}
function address(value) {
  const result = record(value, ADDRESS);
  literal(result.address, 60); literal(result.neighborhood, 20); literal(result.city, 40);
  requireValue(typeof result.state === 'string' && STATES.has(result.state), 'BOLETO_PREVIEW_ADDRESS_INVALID');
  requireValue(typeof result.postalCode === 'string' && /^[0-9]{8}$/.test(result.postalCode) && result.postalCode !== '00000000', 'BOLETO_PREVIEW_ADDRESS_INVALID');
  return result;
}
const escape = value => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const date = value => value.slice(8) + '/' + value.slice(5, 7) + '/' + value.slice(0, 4);
const money = value => { const cents = BigInt(value); return (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + (cents % 100n).toString().padStart(2, '0'); };
const documentText = (type, value) => type === '02'
  ? value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  : value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
const postal = value => value.slice(0, 5) + '-' + value.slice(5);
const cell = (label, value = '', className = '') => `<div class="cell ${className}"><span class="label">${label}</span><span class="value">${escape(value)}</span></div>`;
const line = value => `<span class="value">${escape(value)}</span>`;

// Fixed, local styles only. Each slip is 190 x 104 mm, including its footer.
const CSS = `@page{size:A4 portrait;margin:10mm}*{box-sizing:border-box}html,body{margin:0;padding:0;background:white;color:#000}body{font-family:Arial,Helvetica,sans-serif}.page{width:190mm;height:277mm;display:flex;flex-direction:column}.intro{height:25mm;flex:none}.intro h1{margin:0 0 2mm;font-size:6mm}.intro p{margin:1mm 0;font-size:3mm;line-height:4mm}.separator{flex:1;min-height:15mm;display:flex;flex-direction:column;justify-content:center;gap:3mm;font-size:2.6mm}.cut{border-top:.25mm dashed #000;text-align:right;padding-top:1mm}.slip{height:104mm;width:190mm;flex:none;break-inside:avoid;page-break-inside:avoid}.bank{height:9mm;display:grid;grid-template-columns:26mm 15mm 1fr;align-items:center;border-bottom:.35mm solid #000}.bank-name{font-size:5mm;font-weight:bold}.bank-name small{display:block;font-size:2.1mm}.bank-code{font-size:5mm;border-left:.3mm solid #000;border-right:.3mm solid #000;text-align:center;line-height:7mm}.digit-line{font-family:'Courier New',monospace;font-size:3.5mm;font-weight:bold;text-align:right;white-space:nowrap}.row{display:grid;border-bottom:.2mm solid #000}.two{grid-template-columns:145mm 45mm}.payment{height:7mm}.beneficiary{height:13mm}.document{height:8mm;grid-template-columns:27mm 38mm 18mm 13mm 29mm 65mm}.currency{height:7mm;grid-template-columns:50mm 22mm 18mm 26mm 29mm 45mm}.instructions{height:14mm}.payer{height:14mm}.guarantor{height:4mm;font-size:2.2mm;padding:.5mm 1mm;border-bottom:.2mm solid #000}.cell{min-width:0;border-right:.2mm solid #000;padding:.5mm 1mm}.cell:last-child{border-right:0}.label{display:block;font-size:1.9mm;line-height:2.3mm;white-space:nowrap}.value{display:block;font-family:'Courier New',monospace;font-size:2.5mm;line-height:3mm;white-space:nowrap}.strong .value{font-weight:bold;font-size:3mm}.beneficiary .value{font-size:2.4mm;line-height:2.9mm}.instructions .cell{padding:.6mm 1mm}.instructions strong{display:block;font-size:3.3mm;line-height:4mm}.instructions p{font-size:2.3mm;line-height:3mm;margin:0}.adjustments{display:grid;grid-template-rows:repeat(3,1fr)}.adjustments>div{padding:.4mm 1mm;border-bottom:.2mm solid #000;font-size:1.9mm}.adjustments>div:last-child{border-bottom:0}.payer .cell{padding:.5mm 1mm}.payer-heading{display:grid;grid-template-columns:125mm 61mm}.footer{height:28mm;position:relative}.footer svg{position:absolute;left:0;top:0;width:113mm;height:24mm}.authentication{position:absolute;left:120mm;right:0;top:4mm;text-align:right;font-size:2.3mm;line-height:4mm}.receipt-footer{padding:4mm 1mm;font-size:3.5mm;font-weight:bold}.receipt-footer small{display:block;font-size:2.5mm;font-weight:normal;margin-top:2mm}@media screen{body{padding:8mm;background:#eee}.page{background:white;margin:auto;box-shadow:0 0 2mm #aaa}}@media print{html,body{width:190mm}.page{margin:0}.intro,.slip,.separator{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;

function slip(data, candidate, compensation, encoding) {
  const { profile } = data.boleto, { payer, beneficiaryAddress: a, document: d } = data;
  const caption = compensation ? 'Ficha de compensação' : 'Recibo do pagador';
  const terms = encoding?.terms;
  const instructions = terms
    ? `<p>Juro/dia: R$ ${money(terms.dailyInterestCents)} · campo de mora: ${date(terms.interestDateField)}.</p><p>Multa: 2,00% · campo de data: ${date(terms.penaltyDateField)}. Efeito bancário a conferir.</p>`
    : '<p>Sem registro ou cobrança bancária. Encargos não calculados.</p><p>Homologação visual e instruções bancárias pendentes.</p>';
  const beneficiary = `<div class="cell"><span class="label">Beneficiário — CNPJ e endereço</span>${line(profile.companyName + ' — ' + documentText('02', profile.cnpj))}${line(a.address + ' — ' + a.neighborhood)}${line(a.city + ' / ' + a.state + ' — CEP ' + postal(a.postalCode))}</div>`;
  const payerBlock = `<div class="row payer"><div class="cell"><span class="label">Pagador — identificação declarada para esta prévia</span><div class="payer-heading">${line(payer.name)}${line((payer.type === '02' ? 'CNPJ ' : 'CPF ') + documentText(payer.type, payer.document))}</div>${line(payer.address + ' — ' + payer.neighborhood)}${line(payer.city + ' / ' + payer.state + ' — CEP ' + postal(payer.postalCode))}</div></div>`;
  return `<section class="slip" aria-label="${caption}"><div class="bank"><div class="bank-name">Itaú<small>NÃO PAGAR</small></div><div class="bank-code">341-7</div><div class="digit-line">${candidate.formattedLine}</div></div>
<div class="row two payment">${cell('Local de pagamento', 'PRÉVIA DE TESTE — SEM VALIDADE PARA PAGAMENTO')}${cell('Vencimento', date(candidate.dueOn), 'strong')}</div>
<div class="row two beneficiary">${beneficiary}${cell('Agência / conta do beneficiário', profile.agency + ' / ' + profile.account + '-' + profile.accountDigit)}</div>
<div class="row document">${cell('Data do documento', date(d.issuedOn))}${cell('Número do documento', d.number)}${cell('Espécie', 'DM')}${cell('Aceite', 'N')}${cell('Processamento', date(d.processedOn))}${cell('Nosso número', '109/' + candidate.ourNumberWithDigit.slice(0, 8) + '-' + candidate.ourNumberWithDigit.slice(8))}</div>
<div class="row currency">${cell('Uso do banco')}${cell('Carteira', '109')}${cell('Espécie moeda', 'R$')}${cell('Quantidade')}${cell('Valor')}${cell('(=) Valor do documento', money(candidate.amountCents), 'strong')}</div>
<div class="row two instructions"><div class="cell"><strong>PRÉVIA DE TESTE — NÃO PAGAR</strong>${instructions}</div><div class="adjustments"><div>(−) Desconto / abatimento</div><div>(+) Juros / multa</div><div>(=) Valor pago</div></div></div>
${payerBlock}<div class="guarantor">Beneficiário final / avalista: não aplicável neste perfil de teste.</div>
<div class="footer">${compensation ? candidate.svg + '<div class="authentication">Autenticação mecânica<br>Ficha de compensação<br><strong>NÃO PAGAR</strong></div>' : '<div class="receipt-footer">Recibo do pagador — NÃO PAGAR<small>Não comprova pagamento, registro ou reserva de nosso número.</small></div>'}</div></section>`;
}

/** Local printable specimen only. It does not allocate numbers, register or issue a charge. */
export async function createItau109PrintPreview(input) {
  return createPreview(input, null, null);
}

async function createPreview(input, precheckedCandidate, encoding) {
  const data = record(input, ['purpose', 'boleto', 'document', 'beneficiaryAddress', 'payer']);
  requireValue(data.purpose === 'offline-print-preview', 'BOLETO_PREVIEW_PURPOSE_UNSUPPORTED');
  data.boleto = record(data.boleto, ['purpose', 'profile', 'title', 'allocation']);
  data.boleto.profile = record(data.boleto.profile, PROFILE);
  data.boleto.title = record(data.boleto.title, ['amountCents', 'dueOn', 'referenceOn']);
  data.boleto.allocation = record(data.boleto.allocation, ['ourNumber', 'confirmed', 'reference']);
  for (const item of [data.boleto.profile, data.boleto.title, data.boleto.allocation]) {
    requireValue(Object.values(item).every(value => typeof value === 'string' || typeof value === 'boolean'));
  }
  requireValue(data.boleto.profile.bank === '341' && data.boleto.profile.wallet === '109', 'BOLETO_PREVIEW_PROFILE_UNSUPPORTED');
  data.document = record(data.document, ['number', 'issuedOn', 'processedOn']);
  requireValue(typeof data.document.number === 'string' && /^[A-Za-z0-9./-]{1,10}$/.test(data.document.number), 'BOLETO_PREVIEW_DOCUMENT_INVALID');
  try { dateField(data.document.issuedOn); dateField(data.document.processedOn); } catch { fail('BOLETO_PREVIEW_DATE_INVALID'); }
  requireValue(data.document.issuedOn <= data.document.processedOn && data.document.issuedOn <= data.boleto.title.dueOn
    && data.document.processedOn === data.boleto.title.referenceOn, 'BOLETO_PREVIEW_DATE_CONTEXT_INVALID');
  data.beneficiaryAddress = address(data.beneficiaryAddress);
  const payer = record(data.payer, ['type', 'document', 'name', ...ADDRESS]);
  requireValue(typeof payer.type === 'string' && typeof payer.document === 'string' && validDocument(payer.type, payer.document), 'BOLETO_PREVIEW_PAYER_INVALID');
  literal(payer.name, 60);
  data.payer = { type: payer.type, document: payer.document, name: payer.name, ...address(Object.fromEntries(ADDRESS.map(key => [key, payer[key]]))) };
  let candidate;
  try { candidate = precheckedCandidate ?? createItau109BarcodePreview(data.boleto); }
  catch (error) { if (error instanceof BoletoError) fail(error.code); fail('BOLETO_PREVIEW_INPUT_INVALID'); }
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>Prévia Itaú 109 — NÃO PAGAR</title><style>${CSS}</style></head><body><main class="page"><header class="intro"><h1>PRÉVIA DE TESTE — NÃO PAGAR</h1><p>Espécime local Itaú 109. Sem registro, emissão ou transmissão bancária.</p><p>${encoding?.terms?.dailyInterestCents === '0' ? 'Juro diário zerado por arredondamento; efeito bancário não confirmado.' : 'As declarações de contrato e numeração não constituem verificação bancária.'}</p></header>${slip(data, candidate, false, encoding)}<div class="separator"><div>Homologação visual pendente. Impressão em A4, escala 100%, sem cabeçalho ou rodapé do navegador.</div><div class="cut">Recorte aqui — espécime sem validade para pagamento</div></div>${slip(data, candidate, true, encoding)}</main></body></html>`;
  const bytes = new TextEncoder().encode(html);
  requireValue(bytes.byteLength <= 131072, 'BOLETO_PREVIEW_SIZE_EXCEEDED');
  // All output and binding values are detached from caller objects before the await.
  const binding = Object.freeze({ bank: '341', wallet: '109', barcode: candidate.barcode, digitableLine: candidate.digitableLine,
    amountCents: candidate.amountCents, dueOn: candidate.dueOn, referenceOn: candidate.referenceOn,
    ourNumberWithDigit: candidate.ourNumberWithDigit, documentNumber: data.document.number });
  const htmlHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  return Object.freeze({ purpose: 'offline-print-preview', renderProfile: encoding ? 'itau109-print-preview-v2' : 'itau109-print-preview-v1', ...(encoding ? {encoding} : {}), mimeType: 'text/html',
    html, htmlHash, sizeBytes: bytes.byteLength, binding, fullBoletoRendered: true, printedLayoutValidatedByBank: false,
    bankRegistered: false, bankAcceptanceVerified: false, homologationVerified: false, numberAllocationVerified: false,
    financialMutationPerformed: false, bankTransmissionPerformed: false, canIssue: false, canTransmit: false, canPay: false,
    pending: Object.freeze(['PERSISTED_NUMBER_ALLOCATION_NOT_CHECKED', 'BANK_REGISTRATION_NOT_CHECKED', 'BANK_HOMOLOGATION_NOT_CHECKED', 'PRINTED_LAYOUT_NOT_VALIDATED', 'PRINTED_INSTRUCTIONS_NOT_VALIDATED']),
    dimensions: Object.freeze({ paper: 'A4', slipWidthMm: 190, slipHeightMm: 104, barcodeWidthMm: 103, barcodeHeightMm: 13, quietZoneMm: 5, barcodeCenterFromBottomMm: 13.5 }) });
}

/** Read-only specimen from a complete v2 capture. Caller must verify persistence/ACL. */
export async function createItau109OperationalPrintPreviewV2(input) {
  const value = record(input, ['snapshot', 'billingTitleId', 'beneficiaryAddress']);
  let snapshot, candidate;
  try {
    snapshot = validateOperationalRemittanceV2(value.snapshot).snapshot;
    candidate = createItau109OperationalBarcodePreviewV2({snapshot,billingTitleId:value.billingTitleId});
  } catch { fail('BOLETO_PREVIEW_OPERATIONAL_CAPTURE_INVALID'); }
  const title = snapshot.titles.find(t => t.id === value.billingTitleId);
  requireValue(title, 'BOLETO_PREVIEW_OPERATIONAL_CAPTURE_INVALID');
  const authorization = snapshot.encoding_authorization;
  const encoding = Object.freeze({profile:snapshot.encoding_profile,policyHash:authorization.policy_hash,
    approvalVersion:authorization.approval_version,compatibilityConfirmed:authorization.compatibility_confirmed,
    permanentInstructionsAcknowledged:authorization.permanent_instructions_acknowledged,
    terms:title.encodingTerms ? Object.freeze({...title.encodingTerms}) : null});
  return createPreview({purpose:'offline-print-preview',
    boleto:{purpose:'offline-validation',profile:Object.fromEntries(PROFILE.map(k=>[k,snapshot.profile[k]])),
      title:{amountCents:title.amountCents,dueOn:title.dueOn,referenceOn:snapshot.generatedOn},
      allocation:{ourNumber:title.ourNumber,confirmed:true,reference:'VALIDATED V2 CAPTURE '+value.billingTitleId}},
    document:{number:title.documentNumber,issuedOn:title.issuedOn,processedOn:snapshot.generatedOn},
    beneficiaryAddress:value.beneficiaryAddress,payer:title.payer},candidate,encoding);
}
