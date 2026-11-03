/** Company identity validation. Structural checks do not prove registration or fiscal eligibility. */
export const STATE_CODES={RO:'11',AC:'12',AM:'13',RR:'14',PA:'15',AP:'16',TO:'17',MA:'21',PI:'22',CE:'23',RN:'24',PB:'25',PE:'26',AL:'27',SE:'28',BA:'29',MG:'31',ES:'32',RJ:'33',SP:'35',PR:'41',SC:'42',RS:'43',MS:'50',MT:'51',GO:'52',DF:'53'};
export const COMPANY_FIELDS={legal_name:200,trade_name:200,cnpj:18,ie:30,postal_code:9,street:200,number:30,complement:200,district:100,city:100,municipality_code:7,state:2,phone:40,email:254};
export const CRT_LABELS={'1':'Simples Nacional','2':'Simples Nacional — excesso de sublimite','3':'Regime Normal','4':'Simples Nacional — MEI'};
const fail=field=>{throw new Error(`COMPANY_INVALID_${field.toUpperCase()}`);};
export function normalizeCnpj(input){
 if(typeof input!=='string')fail('cnpj');const value=input.trim().toUpperCase();
 if(!/^(?:[A-Z0-9]{12}\d{2}|[A-Z0-9]{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}\/[A-Z0-9]{4}-\d{2})$/.test(value))fail('cnpj');
 const cnpj=value.replace(/[./-]/g,'');if(/^([0-9])\1{13}$/.test(cnpj))fail('cnpj');
 let base=cnpj.slice(0,12);
 for(let index=0;index<2;index++){
  let sum=0,weight=2;for(let position=base.length-1;position>=0;position--){sum+=(base.charCodeAt(position)-48)*weight;weight=weight===9?2:weight+1;}
  const remainder=sum%11;base+=String(remainder<2?0:11-remainder);
 }
 if(base!==cnpj)fail('cnpj');return cnpj;
}
/** 302: the CPF of a company with Tipo da Pessoa = Pessoa Física (produtor rural etc.): 11 digits or 000.000.000-00, both check digits. */
export function normalizeCompanyCpf(input){
 if(typeof input!=='string')fail('cnpj');const value=input.trim();
 if(!/^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/.test(value))fail('cnpj');
 const cpf=value.replace(/[.-]/g,'');if(/^(\d)\1{10}$/.test(cpf))fail('cnpj');
 for(const n of[9,10]){let sum=0;for(let i=1;i<=n;i++)sum+=Number(cpf[i-1])*(n+2-i);let digit=(sum*10)%11;if(digit===10)digit=0;if(digit!==Number(cpf[n]))fail('cnpj');}
 return cpf;
}
/** The document of the identity (kept in the field cnpj): 'cnpj' (Pessoa Jurídica, the default), 'cpf' (Pessoa Física) or 'any' (either,
 * for reading a stored identity whose Tipo da Pessoa is not known here). */
export function normalizeCompanyDocument(input,document='cnpj'){
 if(document==='cpf')return normalizeCompanyCpf(input);
 if(document==='any'&&typeof input==='string'&&/^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/.test(input.trim()))return normalizeCompanyCpf(input);
 return normalizeCnpj(input);
}
/** "CPF" for the 11 digits of a Pessoa Física, otherwise "CNPJ" (prints and screens). */
export const companyDocumentLabel=value=>typeof value==='string'&&/^\d{11}$/.test(value)?'CPF':'CNPJ';
export function normalizeCompany(input,{document='cnpj'}={}){
 if(!['cnpj','cpf','any'].includes(document))fail('fields');
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!Object.hasOwn(COMPANY_FIELDS,key)))fail('fields');
 const result={};
 for(const [key,max]of Object.entries(COMPANY_FIELDS)){
  const value=input[key];if(value!==null&&value!==undefined&&(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value)))fail(key);
  result[key]=typeof value==='string'?value.trim()||null:null;
 }
 for(const key of ['legal_name','cnpj','postal_code','street','number','district','city','municipality_code','state'])if(result[key]===null)fail(key);
 result.cnpj=normalizeCompanyDocument(result.cnpj,document);result.state=result.state.toUpperCase();
 if(!Object.hasOwn(STATE_CODES,result.state))fail('state');
 if(!/^\d{5}-?\d{3}$/.test(result.postal_code))fail('postal_code');result.postal_code=result.postal_code.replace('-','');if(result.postal_code==='00000000')fail('postal_code');
 if(!/^\d{7}$/.test(result.municipality_code)||!result.municipality_code.startsWith(STATE_CODES[result.state]))fail('municipality_code');
 if(result.email!==null&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email))fail('email');
 if(result.phone!==null){result.phone=result.phone.replace(/[ ()\-.]/g,'');if(!/^\+?[0-9]{8,15}$/.test(result.phone))fail('phone');}
 return result;
}
