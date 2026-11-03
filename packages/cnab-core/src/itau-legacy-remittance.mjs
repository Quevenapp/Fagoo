// Read-only subset of Itaú341/109 CNAB400, independent of operational generation.
import {CnabError,readRecords,parseLayout,cnabDate,mod10,validDocument,sha256} from './primitives.mjs';
import {validateProfile,itauOurNumberDigit,accountScope} from './profiles.mjs';
const handles=new WeakSet(),MAX=4020000;
export const ITAU_LEGACY_FILE_LIMITS=Object.freeze({files:40,totalBytes:8388608,fileBytes:MAX,recordsPerFile:10000});
const flags=Object.freeze({read_only:true,persisted:false,can_bind:false,can_settle:false,can_generate:false,origin_authenticated:false,bridge_authenticated:false,financial_mutation_performed:false});
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const need=(v,code='CNAB_LEGACY_REMITTANCE_INVALID')=>{if(!v)throw new CnabError(code);};
const captureObject=(v,allowed)=>{need(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));const d=Object.getOwnPropertyDescriptors(v);need(Reflect.ownKeys(d).every(k=>typeof k==='string'&&allowed.includes(k)&&d[k].enumerable&&Object.hasOwn(d[k],'value')));return Object.fromEntries(Object.keys(d).map(k=>[k,d[k].value]));};
const typed=Object.getOwnPropertyDescriptors(Object.getPrototypeOf(Uint8Array.prototype));
function captureBytes(value){try{const p=Object.getPrototypeOf(value);need(ArrayBuffer.isView(value)&&value instanceof Uint8Array&&(p===Uint8Array.prototype||typeof Buffer!=='undefined'&&Buffer.isBuffer(value)&&p===Buffer.prototype));need(['buffer','byteOffset','byteLength','length'].every(k=>!Object.hasOwn(value,k)));const buffer=typed.buffer.get.call(value),offset=typed.byteOffset.get.call(value),n=typed.byteLength.get.call(value);need(buffer instanceof ArrayBuffer&&n>0&&n<=MAX,'CNAB_FILE_SIZE_INVALID');return new Uint8Array(new Uint8Array(buffer,offset,n));}catch(e){if(e instanceof CnabError)throw e;throw new CnabError('CNAB_FILE_SIZE_INVALID');}}
const headerLayout=[['record',1,1,'N','0'],['operation',2,2,'N','1'],['remittance',3,9,'A','REMESSA'],['service',10,11,'N','01'],['serviceName',12,26,'A','COBRANCA'],['agency',27,30,'N'],['zero',31,32,'N','00'],['account',33,37,'N'],['accountDigit',38,38,'N'],['blank',39,46,'B'],['companyName',47,76,'A'],['bank',77,79,'N','341'],['bankName',80,94,'A'],['generatedOn',95,100,'N'],['reserved',101,394,'B'],['sequence',395,400,'N']];
const detailLayout=[['record',1,1,'N','1'],['issuerType',2,3,'N','02'],['issuerDocument',4,17,'N'],['agency',18,21,'N'],['zero1',22,23,'N','00'],['account',24,28,'N'],['accountDigit',29,29,'N'],['blank1',30,33,'B'],['zero2',34,37,'N','0000'],['control',38,62,'A'],['ourNumber',63,70,'N'],['currency',71,83,'N','0000000000000'],['wallet',84,86,'N','109'],['blank2',87,107,'B'],['portfolio',108,108,'A','I'],['occurrence',109,110,'N','01'],['documentNumber',111,120,'A'],['dueOn',121,126,'N'],['amountCents',127,139,'N'],['bank',140,142,'N','341'],['collectingAgency',143,147,'N','00000'],['species',148,149,'N','01'],['acceptance',150,150,'A','N'],['issuedOn',151,156,'N'],['instructions',157,160,'N'],['dailyInterest',161,173,'N'],['discountOn',174,179,'N','000000'],['discount',180,192,'N','0000000000000'],['iof',193,205,'N','0000000000000'],['abatement',206,218,'N','0000000000000'],['payerType',219,220,'N'],['payerDocument',221,234,'N'],['payerName',235,264,'A'],['blank3',265,274,'B'],['address',275,314,'A'],['neighborhood',315,326,'A'],['postalCode',327,334,'N'],['city',335,349,'A'],['state',350,351,'A'],['blank4',352,385,'B'],['interestOn',386,391,'N'],['protestDays',392,393,'N','00'],['blank5',394,394,'B'],['sequence',395,400,'N']];
const penaltyLayout=[['record',1,1,'N','2'],['code',2,2,'N','2'],['date',3,10,'N'],['percent',11,23,'N'],['reserved',24,394,'B'],['sequence',395,400,'N']];
const trailerLayout=[['record',1,1,'N','9'],['reserved',2,394,'B'],['sequence',395,400,'N']];
const states=new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR RJ RN RO RR RS SC SE SP TO'.split(' '));
/** Captures bytes before any await. No account/profile contract is declared or stored. */
export async function parseItau109LegacyRemittance(input,options={}){
 let bytes;
 try{
  const opts=captureObject(options,['century','signal','deadline']),century=opts.century??2000,signal=opts.signal,deadline=opts.deadline??Date.now()+15000;
  need(Number.isInteger(century)&&[1900,2000,2100].includes(century)&&(!signal||signal instanceof AbortSignal)&&Number.isFinite(deadline));
  const check=()=>need(!signal?.aborted&&Date.now()<deadline,'CNAB_LEGACY_READ_ABORTED');check();bytes=captureBytes(input);
  const rows=readRecords(bytes);need(rows.length>=3);const h=parseLayout(rows[0],headerLayout,1);need(['BANCO ITAU SA','BANCO ITAU S.A.'].includes(h.bankName));
  parseLayout(rows.at(-1),trailerLayout,rows.length);const generatedOn=cnabDate(h.generatedOn,{century});
  const first=parseLayout(rows[1],detailLayout,2),profile=Object.freeze({bank:'341',layout:'itau-cnab400-2017-01',agency:h.agency,account:h.account,accountDigit:h.accountDigit,wallet:'109',cnpj:first.issuerDocument,accountId:'readonly-sample'});
  validateProfile(profile);need(mod10(profile.agency+profile.account)===profile.accountDigit,'CNAB_ACCOUNT_DIGIT_INVALID');const scope=accountScope(profile),records=[];let priorDetail=false;
  for(let i=1;i<rows.length-1;i++){
   check();const raw=rows[i],line=i+1;
   if(raw[0]==='2'){
    need(priorDetail,'CNAB_LEGACY_PENALTY_POSITION_INVALID');const p=parseLayout(raw,penaltyLayout,line);const day=p.date.slice(4)+'-'+p.date.slice(2,4)+'-'+p.date.slice(0,2);
    need(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day&&BigInt(p.percent)>0n&&BigInt(p.percent)<=10000n);
    records.at(-1).penalty={line,line_hash:await sha256(raw),starts_on:day,percent_hundredths:BigInt(p.percent).toString()};priorDetail=false;continue;
   }
   need(raw[0]==='1','CNAB_RECORD_TYPE_UNSUPPORTED');const f=parseLayout(raw,detailLayout,line);
   need(f.agency===profile.agency&&f.account===profile.account&&f.accountDigit===profile.accountDigit&&f.issuerDocument===profile.cnpj,'CNAB_ACCOUNT_MISMATCH');
   need(!/^0+$/.test(f.ourNumber)&&BigInt(f.amountCents)>0n&&f.control.length>0&&f.documentNumber.length>0);
   need(['0000','1047','1044'].includes(f.instructions),'CNAB_LEGACY_INSTRUCTIONS_UNSUPPORTED');
   need(f.payerType==='01'?f.payerDocument.startsWith('000')&&validDocument('01',f.payerDocument.slice(3)):validDocument(f.payerType,f.payerDocument),'CNAB_PAYER_DOCUMENT_INVALID');
   need(f.payerName.length>0&&f.address.length>0&&f.city.length>0&&states.has(f.state)&&!/^0+$/.test(f.postalCode),'CNAB_PAYER_ADDRESS_INVALID');
   const due=cnabDate(f.dueOn,{century}),issued=cnabDate(f.issuedOn,{century});cnabDate(f.interestOn,{century,optional:true});
   const digit=itauOurNumberDigit({...profile,ourNumber:f.ourNumber});
   records.push({line,line_hash:await sha256(raw),bank_number:`109/${f.ourNumber}-${digit}`,our_number_digit:'computed_from_observed_account',document_number:f.documentNumber,control:f.control,amount_cents:BigInt(f.amountCents).toString(),due_on:due,issued_on:issued,penalty:null});priorDetail=true;
  }
  check();const fileHash=await sha256(bytes);check();const result=freeze({...flags,profile:'itau109-legacy-remittance-inspection-v1',evidence_kind:'remittance',file_hash:fileHash,file_size:bytes.byteLength,record_count:rows.length,generated_on:generatedOn,observed_account:{bank:'341',wallet:'109',agency:profile.agency,account:profile.account,account_digit:profile.accountDigit,beneficiary_cnpj:profile.cnpj,scope},records,warnings:['LOCAL_FILE_ORIGIN_UNAUTHENTICATED','OUR_NUMBER_DIGIT_COMPUTED_NOT_CARRIED_BY_REMITTANCE','ACCOUNT_SCOPE_NOT_ESTABLISHED_FOR_SOURCE','NO_BANK_STATE_OR_NUMBER_AVAILABILITY_PROOF']});handles.add(result);return result;
 }catch(e){const d=e&&typeof e==='object'?Object.getOwnPropertyDescriptor(e,'code'):null;const code=d&&Object.hasOwn(d,'value')&&['CNAB_FILE_SIZE_INVALID','CNAB_LEGACY_READ_ABORTED'].includes(d.value)?d.value:'CNAB_LEGACY_REMITTANCE_INVALID';throw new CnabError(code);}finally{bytes?.fill(0);}
}
export const isInspectedItau109LegacyRemittance=value=>handles.has(value);
