/**
 * Reader of OFX bank statements (SGML 1.x and XML 2.x) for the Origin "Conciliação bancária". Only the statement
 * transactions are read: FITID, DTPOSTED, TRNAMT, MEMO/NAME and TRNTYPE, plus the period. Amounts become exact integer
 * cents from the decimal text (never floating point). Nothing is sent anywhere: the file is uploaded by the user.
 */
export const OFX_MAX_CHARS = 2 * 1024 * 1024, OFX_MAX_TRANSACTIONS = 5000;
export class OfxError extends Error {}
const fail = message => { throw new OfxError(message); };
const decode = value => value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, code) => code[0] === '#' ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[code.toLowerCase()]);
/** Value of a leaf element in a block: "<TAG>value" (SGML, closing tag optional) or "<TAG>value</TAG>" (XML). */
function leaf(block, tag) {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  if (!match) return null;
  const value = decode(match[1]).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return value || null;
}
function ofxDate(value, field) {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value ?? '');
  if (!match) fail(`Data inválida em ${field}.`);
  const date = `${match[1]}-${match[2]}-${match[3]}`, time = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date || date < '1900-01-01' || date > '2100-12-31') fail(`Data inválida em ${field}.`);
  return date;
}
/** "-1234.56", "1234,5" or "+12" → signed cents as text. More than two decimals are accepted only when zero. */
export function ofxCents(value) {
  const match = /^([+-]?)(\d{1,15})(?:[.,](\d+))?$/.exec((value ?? '').trim());
  if (!match) fail('Valor inválido em TRNAMT.');
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) fail('Valor com mais de duas casas decimais em TRNAMT.');
  const cents = BigInt(whole) * 100n + BigInt((fraction.slice(0, 2) || '0').padEnd(2, '0'));
  if (cents > 999999999999999n) fail('Valor excede o limite em TRNAMT.');
  return (sign === '-' && cents !== 0n ? '-' : '') + cents.toString();
}
export function parseOfx(text) {
  if (typeof text !== 'string' || !text.length || text.length > OFX_MAX_CHARS) fail('Arquivo OFX vazio ou grande demais.');
  const body = /<OFX>/i.exec(text); if (!body) fail('O arquivo não é um extrato OFX.');
  const ofx = text.slice(body.index);
  const blocks = [...ofx.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)].map(match => match[1]);
  if (blocks.length > OFX_MAX_TRANSACTIONS) fail(`O extrato tem mais de ${OFX_MAX_TRANSACTIONS} lançamentos.`);
  const seen = new Map(), lines = blocks.map((block, index) => {
    const posted_on = ofxDate(leaf(block, 'DTPOSTED'), `DTPOSTED (lançamento ${index + 1})`), amount_cents = ofxCents(leaf(block, 'TRNAMT'));
    const memo = (leaf(block, 'MEMO') ?? leaf(block, 'NAME'))?.slice(0, 255) ?? null, trntype = leaf(block, 'TRNTYPE')?.toUpperCase() ?? null;
    let fitid = leaf(block, 'FITID');
    // Without FITID the identity is the date, the value and the memo, numbered in the file: a re-import finds the same ids.
    if (!fitid) { const key = `${posted_on}|${amount_cents}|${memo ?? ''}`, count = (seen.get(key) ?? 0) + 1; seen.set(key, count); fitid = `sem-fitid:${key}|${count}`; }
    if (fitid.length > 255) fail('FITID com mais de 255 caracteres.');
    return { fitid, posted_on, amount_cents, memo, trntype: trntype && /^[A-Z]{1,20}$/.test(trntype) ? trntype : null };
  }).filter(line => line.amount_cents !== '0');
  const ids = new Set(); for (const line of lines) { if (ids.has(line.fitid)) fail(`FITID repetido no arquivo: ${line.fitid}.`); ids.add(line.fitid); }
  const start = leaf(ofx, 'DTSTART'), end = leaf(ofx, 'DTEND'), days = lines.map(line => line.posted_on).sort();
  const period_from = start ? ofxDate(start, 'DTSTART') : days[0], period_to = end ? ofxDate(end, 'DTEND') : days.at(-1);
  if (!period_from || !period_to) fail('O extrato não tem período nem lançamentos.');
  return { period_from: period_from <= period_to ? period_from : period_to, period_to: period_from <= period_to ? period_to : period_from, bank: leaf(ofx, 'BANKID'), account: leaf(ofx, 'ACCTID'), lines };
}
