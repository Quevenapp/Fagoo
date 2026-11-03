/**
 * Unsigned XML of the fiscal events queued in Brufap (migration 202610200114): cancelamento (110111), carta de correção (110110)
 * and inutilização de numeração (inutNFe 4.00). Homologation only: any other environment is refused, so these builders can never
 * produce a production request. They do not sign, transmit or store anything; the screen shows the XML for support.
 * Pure JavaScript (no Node built-ins), usable in the browser and in the Worker.
 */
const NS = 'http://www.portalfiscal.inf.br/nfe';
export class FiscalEventXmlError extends Error { constructor(code) { super(code); this.code = code; } }
const need = (condition, code) => { if (!condition) throw new FiscalEventXmlError(code); };
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CNPJ = /^\d{14}$/, KEY = /^\d{44}$/;
/** Official condition text of the CC-e (NT 2011/003), without accents as published. */
export const CORRECTION_CONDITION = 'A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.';
/** São Paulo local time with the fixed -03:00 offset used by the SEFAZ layouts. */
export function saoPauloMoment(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-03:00`;
}
const homologation = environment => need(environment === '2', 'EVENT_PRODUCTION_LOCKED');
function eventXml({ type, description, key, cnpj, sequence, at, detail, environment }) {
  homologation(environment);
  need(KEY.test(key ?? '') && CNPJ.test(cnpj ?? '') && Number.isInteger(sequence) && sequence >= 1 && sequence <= 20 && at instanceof Date && Number.isFinite(at.getTime()), 'EVENT_INPUT_INVALID');
  const seq = String(sequence).padStart(2, '0');
  return `<?xml version="1.0" encoding="UTF-8"?><envEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><evento versao="1.00"><infEvento Id="ID${type}${key}${seq}">`
    + `<cOrgao>${key.slice(0, 2)}</cOrgao><tpAmb>2</tpAmb><CNPJ>${cnpj}</CNPJ><chNFe>${key}</chNFe><dhEvento>${saoPauloMoment(at)}</dhEvento><tpEvento>${type}</tpEvento><nSeqEvento>${sequence}</nSeqEvento>`
    + `<verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>${description}</descEvento>${detail}</detEvento></infEvento></evento></envEvento>`;
}
const textOf = (value, min, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); need([...text].length >= min && [...text].length <= max, 'EVENT_TEXT_INVALID'); return text; };
export function cancelEventXml({ key, cnpj, protocol, justification, at = new Date(), environment }) {
  need(/^\d{15}$/.test(protocol ?? ''), 'EVENT_PROTOCOL_REQUIRED');
  return eventXml({ type: '110111', description: 'Cancelamento', key, cnpj, sequence: 1, at, environment, detail: `<nProt>${protocol}</nProt><xJust>${escape(textOf(justification, 15, 255))}</xJust>` });
}
export function correctionEventXml({ key, cnpj, text, sequence, at = new Date(), environment }) {
  return eventXml({ type: '110110', description: 'Carta de Correcao', key, cnpj, sequence, at, environment, detail: `<xCorrecao>${escape(textOf(text, 15, 1000))}</xCorrecao><xCondUso>${CORRECTION_CONDITION}</xCondUso>` });
}
export function inutilizationXml({ cnpj, model, series, from, to, justification, year, cuf = '35', environment }) {
  homologation(environment);
  need(CNPJ.test(cnpj ?? '') && ['55', '65'].includes(model) && Number.isInteger(series) && series >= 0 && series <= 999 && Number.isInteger(from) && Number.isInteger(to) && from >= 1 && from <= to && to <= 999999999
    && to - from < 10000 && /^\d{2}$/.test(year ?? '') && /^\d{2}$/.test(cuf), 'EVENT_INPUT_INVALID');
  const id = `ID${cuf}${year}${cnpj}${model}${String(series).padStart(3, '0')}${String(from).padStart(9, '0')}${String(to).padStart(9, '0')}`;
  return `<?xml version="1.0" encoding="UTF-8"?><inutNFe xmlns="${NS}" versao="4.00"><infInut Id="${id}"><tpAmb>2</tpAmb><xServ>INUTILIZAR</xServ><cUF>${cuf}</cUF><ano>${year}</ano><CNPJ>${cnpj}</CNPJ>`
    + `<mod>${model}</mod><serie>${series}</serie><nNFIni>${from}</nNFIni><nNFFin>${to}</nNFFin><xJust>${escape(textOf(justification, 15, 255))}</xJust></infInut></inutNFe>`;
}
