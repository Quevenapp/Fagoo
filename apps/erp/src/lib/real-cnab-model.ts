export interface CnabAccess { read: true; write: boolean; configure: boolean; purpose: 'homologation'; productionReady: false; financialMutationPerformed: false }
export interface CnabProfile { id: string; account_id: string; account_name: string; bank: '341' | '077'; wallet: '109' | '110' | '112'; account_mask: string; company_name: string; version: number; contract_verified: boolean; policy_verified: boolean; next_sequence: string }
export interface CnabFile { id: string; profile_id: string; kind: 'remittance' | 'return'; state: 'reserved' | 'ready'; sequence: string | null; generated_on: string; created_at: string; file_hash: string | null; byte_size: number | null; titles: number; filename: string }
export interface CnabPage<T> { items: T[]; has_more: boolean; next_cursor: string | null; limit: number }
export interface CnabEvent { line: number; event_id: string; event_hash: string; duplicate: boolean; billing_title_id: string | null; action: string; reason: string; control: string; document_number: string; our_number: string | null; occurrence: string; kind: string; amount_cents: string; paid_cents: string; occurrence_date: string | null; credit_date: string | null; canSettle: false }
export interface CnabReview { id: string; file_hash: string; items: CnabEvent[]; warnings: string[]; has_more: boolean; next_cursor: number | null; canSettle: false }
export interface CnabPreview { preview: true; profile_id: string; sequence: string; total_cents: string; titles: number; warnings: string[]; productionReady: false }
export const CNAB_MAX_FILE = 4_020_000;
export const bankName = (bank: string) => bank === '341' ? 'Itaú' : bank === '077' ? 'Inter' : bank;
export function cnabDocument(value: string) { const text=value.trim(); if (!/^[A-Z0-9 .&/-]{1,10}$/.test(text)) throw new Error('O número do documento deve ter até 10 caracteres: letras maiúsculas, números, espaço, ponto, &, / ou hífen.'); return text; }
export function cnabDays(value: string) { if(!/^[1-9]\d?$/.test(value)||BigInt(value)>60n)throw new Error('Informe o limite de pagamento Inter entre 1 e 60 dias.'); return Number(value); }
export function cnabProfileData(values: Record<string,string>, checks: Record<string,boolean>) {
  const bank=values.bank,wallet=values.wallet;
  if(!values.account_id)throw new Error('Selecione uma conta financeira do tipo banco.');
  if(!(bank==='341'&&wallet==='109'||bank==='077'&&['110','112'].includes(wallet)))throw new Error('Selecione a carteira correspondente ao contrato do banco.');
  const digits=(name:string,length:number)=>{if(!(new RegExp(`^\\d{${length}}$`)).test(values[name]||''))throw new Error(`Confira ${name==='cnpj'?'o CNPJ numérico':name==='agency'?'a agência':name==='account'?'a conta':name==='accountDigit'?'o dígito':name==='rangeStart'?'o início da faixa':'o fim da faixa'}: são ${length} dígitos.`);return values[name];};
  const agency=digits('agency',4),account=digits('account',bank==='341'?5:9),accountDigit=digits('accountDigit',1),cnpj=digits('cnpj',14);
  if(bank==='077'&&agency!=='0001')throw new Error('A agência Inter deste leiaute deve ser 0001; confirme no contrato.');
  if(!/^[A-Z0-9 .&/-]{1,30}$/.test(values.companyName||''))throw new Error('O nome no arquivo deve ter até 30 caracteres maiúsculos sem acentos.');
  if(!values.agreementReference?.trim()||values.agreementReference.length>120)throw new Error('Informe a referência da conferência do contrato.');
  if(!/^[1-9]\d{0,6}$/.test(values.remittanceSequenceStart||''))throw new Error(bank==='341'?'Informe a sequência interna inicial FAGOO, de 1 a 9999999.':'Informe a próxima sequência confirmada, de 1 a 9999999.');
  const ourNumberStart=wallet==='112'?null:values.ourNumberStart;
  if(ourNumberStart!==null&&(!(new RegExp(`^\\d{${bank==='341'?8:10}}$`)).test(ourNumberStart||'')||BigInt(ourNumberStart)===0n))throw new Error('Confira o próximo nosso número, com todos os zeros à esquerda e sem dígito verificador.');
  let reservedRange;
  if(bank==='077'&&wallet==='110') { const start=digits('rangeStart',10),end=digits('rangeEnd',10);if(BigInt(start)>BigInt(end)||BigInt(ourNumberStart!)<BigInt(start)||BigInt(ourNumberStart!)>BigInt(end))throw new Error('O próximo nosso número deve estar na faixa reservada confirmada.');reservedRange={start,end,verified:checks.range===true}; }
  return{account_id:values.account_id,bank,layout:bank==='341'?'itau-cnab400-2017-01':'inter-cnab400-v2.2-2024-08-26',agency,account,accountDigit,wallet,cnpj,companyName:values.companyName,
    agreementReference:values.agreementReference.trim(),contractVerified:checks.contract===true,simpleCollectionPolicyVerified:checks.policy===true,ourNumberStart,remittanceSequenceStart:values.remittanceSequenceStart,...(reservedRange?{reservedRange}:{})};
}
export function eligibleCnabTitle(title: { kind: string; cancelled: boolean; settled_cents: string; amount_cents: string; issued_on: string; due_on: string }, bank: string, generatedOn: string) {
  return title.kind==='receivable'&&!title.cancelled&&title.settled_cents==='0'&&/^\d+$/.test(title.amount_cents)&&BigInt(title.amount_cents)>=(bank==='077'?250n:1n)&&BigInt(title.amount_cents)<=9999999999999n&&title.issued_on<=generatedOn&&title.due_on>=generatedOn;
}
export function sumCnabTitles(titles: {amount_cents:string}[]) {return titles.reduce((sum,title)=>{if(!/^\d{1,13}$/.test(title.amount_cents))throw new Error('Valor do título inválido.');return sum+BigInt(title.amount_cents);},0n).toString();}
export async function cnabFileBytes(file: Blob) {if(file.size<1||file.size>CNAB_MAX_FILE)throw new Error('O retorno deve ter entre 1 byte e 4.020.000 bytes.');const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length!==file.size)throw new Error('Não foi possível ler o retorno completo.');return bytes;}
export function cnabBase64(bytes:Uint8Array){if(bytes.length<1||bytes.length>CNAB_MAX_FILE)throw new Error('Arquivo fora do limite permitido.');let binary='';for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192));return btoa(binary);}
export async function cnabHash(bytes:Uint8Array){const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes));return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');}
export const CNAB_ACTION_LABELS:Record<string,string>={PROPOSE_SETTLEMENT_REVIEW:'Conferir possível liquidação',PROPOSE_BANK_NUMBER_BINDING_REVIEW:'Conferir nosso número do banco',REVIEW:'Conferência necessária',DUPLICATE:'Evento repetido',IGNORE:'Sem ação financeira',RECORD_STATUS:'Registrar situação em revisão'};
export const CNAB_REASON_LABELS:Record<string,string>={FINANCIAL_STATE_CHANGED:'O título financeiro mudou desde a análise.',EXACT_MATCH:'Vínculo exato encontrado.',FILE_ALREADY_IMPORTED:'Arquivo já analisado.',EVENT_ALREADY_IMPORTED:'Evento já analisado.',NO_EXACT_MATCH:'Não foi encontrado um vínculo exato.',EVIDENCE_REQUIRED:'A procedência precisa ser conferida.'};
