// Entirely synthetic data. Check digits only make it useful to test validation.
// These files are never bank evidence or suitable for uploading to a live bank.
import { cnpjCheckDigits } from '../../fiscal-core/identity.mjs';
import { LAYOUTS, itauOurNumberDigit } from '../index.mjs';

export const CNPJ = '990000000001' + cnpjCheckDigits('990000000001');
export const PROFILES = {
  itau: { bank:'341', layout:LAYOUTS['341'], agency:'0057', account:'12345', accountDigit:'7', wallet:'109', cnpj:CNPJ,
    accountId:'synthetic-itau', companyName:'EMPRESA FICTICIA TESTE', contractVerified:true, agreementReference:'SYNTHETIC-TEST-ONLY', simpleCollectionPolicyVerified:true },
  inter: { bank:'077', layout:LAYOUTS['077'], agency:'0001', account:'000123456', accountDigit:'7', wallet:'112', cnpj:CNPJ,
    accountId:'synthetic-inter', companyName:'EMPRESA FICTICIA TESTE', contractVerified:true, agreementReference:'SYNTHETIC-TEST-ONLY', simpleCollectionPolicyVerified:true },
};
export const title = (overrides = {}) => ({ id:'synthetic-title-1', control:'SYNTHETIC-0001', documentNumber:'TESTE0001', ourNumber:'00000001',
  amountCents:'12345', issuedOn:'2026-10-15', dueOn:'2026-10-30',
  payer:{ type:'01', document:'12345678909', name:'PAGADOR FICTICIO TESTE', address:'RUA FICTICIA 100', neighborhood:'TESTE', city:'PIRACICABA', state:'SP', postalCode:'13400000' }, ...overrides });
// Independent position writer; it intentionally does not use production layout definitions.
export function row(fields) {
  const chars = Array(400).fill(' ');
  for (const [position, value] of fields) [...value].forEach((character,index) => { chars[position - 1 + index] = character; });
  return chars.join('');
}
const n = (value,size) => String(value).padStart(size,'0');
const a = (value,size) => value.padEnd(size,' ');
export const toBytes = rows => new TextEncoder().encode(rows.join('\r\n') + '\r\n');
export function replaceField(bytes, line, position, value) {
  const rows = new TextDecoder().decode(bytes).trimEnd().split('\r\n');
  rows[line - 1] = rows[line - 1].slice(0, position - 1) + value + rows[line - 1].slice(position - 1 + value.length);
  return toBytes(rows);
}
export function returnFile({ bank = '341', events = [{}], generatedDate = '161026', fileSequence = '00001', profile = bank === '341' ? PROFILES.itau : PROFILES.inter } = {}) {
  const normalized = events.map((value,index) => ({ occurrence:'06', control:'SYNTHETIC-0001', documentNumber:'TESTE0001', ourNumber: bank === '341' ? '00000001' : '00000000001',
    amount:'12345', paid:'12345', occurrenceDate:'161026', creditDate:'191026', dueDate:'301026', fee:'0', operationNumber:'SYNTHETIC-OP-01', ...value, sequence:index + 2 }));
  const common = [[1,'02RETORNO01COBRANCA       '],[47,a(profile.companyName,30)],[77,bank],[80,a(bank === '341' ? 'BANCO ITAU SA' : 'INTER',15)],[95,generatedDate],[395,'000001']];
  const header = bank === '341' ? row([...common,[27,profile.agency],[31,'00'],[33,profile.account],[38,profile.accountDigit],[101,'01600BPI'],[109,fileSequence],[114,'191026']]) : row(common);
  const details = normalized.map(e => bank === '341' ? row([
    [1,'102'+profile.cnpj],[18,profile.agency],[22,'00'],[24,profile.account],[29,profile.accountDigit],[38,a(e.control,25)],
    [63,e.ourNumber],[83,profile.wallet],[86,e.ourNumber],[94,itauOurNumberDigit({...profile,ourNumber:e.ourNumber})],[108,'I'+e.occurrence],
    [111,e.occurrenceDate],[117,a(e.documentNumber,10)],[127,e.ourNumber],[147,e.dueDate],[153,n(e.amount,13)],[166,'34100010'],[174,'01'],
    [176,n(e.fee,13)],[215,n(0,13)],[228,n(0,13)],[241,n(0,13)],[254,n(e.paid,13)],[267,n(0,13)],[280,n(0,13)],
    [296,e.creditDate],[302,'0000'],[312,n(0,13)],[325,a('PAGADOR FICTICIO TESTE',30)],[395,n(e.sequence,6)],
  ]) : row([
    [1,'102'+profile.cnpj],[18,'000'],[21,profile.wallet],[24,'0001'],[28,profile.account+profile.accountDigit],[38,a(e.control,25)],
    [63,'00000000'],[71,e.ourNumber],[87,profile.wallet],[90,e.occurrence],[92,e.occurrenceDate],[98,a(e.documentNumber,10)],[108,e.ourNumber],
    [119,e.dueDate],[125,n(e.amount,13)],[138,'077000101'],[160,n(e.paid,13)],[173,e.creditDate],[182,a('PAGADOR FICTICIO TESTE',40)],
    [227,'00012345678909'],[381,a(e.operationNumber,14)],[395,n(e.sequence,6)],
  ]));
  const sum = (events,key) => events.reduce((total,event) => total + BigInt(event[key]),0n).toString();
  const registered = normalized.filter(e => e.occurrence === '02'), paid = normalized.filter(e => e.occurrence === '06');
  const trailer = bank === '341' ? row([[1,'9201341'],[18,n(999,8)],[26,n('999999',14)],[58,n(0,8)],[66,n(0,14)],[178,n(0,8)],[186,n(0,14)],
    [208,fileSequence],[213,n(normalized.length,8)],[221,n(sum(normalized,'amount'),14)],[395,n(normalized.length+2,6)]]) : row([
    [1,'9201077'],[18,n(40,8)],[58,n(registered.length,5)],[63,n(sum(registered,'amount'),12)],[87,n(normalized.filter(e => e.occurrence === '03').length,5)],
    [116,n(paid.length,5)],[121,n(sum(paid,'paid'),12)],[395,n(normalized.length+2,6)],
  ]);
  return toBytes([header,...details,trailer]);
}
