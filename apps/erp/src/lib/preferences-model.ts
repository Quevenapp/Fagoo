import type {AccessState,NativeRequestOptions} from './real-access';
import {parsePreferencesPage,parsePreferencesResult,type PreferencesPageView,type PreferencesResult,type PreferencesSaveInput,type PreferenceChange} from '../../../../packages/erp-domain/src/preferences/dto.mjs';
import {preferenceValueValid,preferenceValueEqual,preferenceClone,storedFields,NOT_APPLIED,type PreferenceField,type PreferenceInfo,type PreferencePageSchema,type PreferenceValue,type PreferenceDocument,type PreferenceKeymapOptions} from '../../../../packages/erp-domain/src/preferences/core.mjs';
export {parsePreferencesPage,parsePreferencesResult,NOT_APPLIED};
export type {PreferencesPageView,PreferencesResult,PreferencesSaveInput,PreferenceField,PreferenceInfo,PreferencePageSchema,PreferenceValue,PreferenceDocument,PreferenceKeymapOptions};
export interface PreferencesController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;preferences:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;stockOpening?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;
 /** Controle de numeração of the NF-e/NFC-e pages (fiscal lane). */fiscalNumbering?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}

/** The browser keeps what the user typed; values are normalized only when the change is built. */
export type Draft=Record<string,PreferenceValue|string>;
export const fieldId=(key:string,suffix?:string)=>`pref-${key.replaceAll('.','-')}${suffix?`-${suffix}`:''}`;
export function draftOf(view:PreferencesPageView):Draft{return Object.fromEntries(view.items.map(item=>[item.key,preferenceClone(item.value)]));}

/** Canonical value of a draft entry, or undefined while the entry cannot be sent. */
export function normalizedValue(field:PreferenceField,raw:unknown):PreferenceValue|undefined{
 let value:unknown=raw;
 if(field.kind==='integer'&&typeof raw==='string')value=/^(0|[1-9][0-9]{0,8})$/.test(raw.trim())?Number(raw.trim()):raw;
 else if(field.kind==='decimal'&&typeof raw==='string'){const text=raw.trim().replace(',','.');value=/^\d+\.$/.test(text)?text.slice(0,-1):text;}
 else if(field.kind==='text'&&typeof raw==='string')value=raw.replace(/^ +| +$/g,'');
 else if(field.kind==='textarea'&&typeof raw==='string')value=raw.replace(/\r\n?/g,'\n').replace(/^[ \n]+|[ \n]+$/g,'');
 else if(field.kind==='documents'&&Array.isArray(raw))value=(raw as PreferenceDocument[]).map(row=>({document:row.document.replace(/[.\-/\s]/g,'').toUpperCase(),name:row.name.replace(/^ +| +$/g,'')}));
 else if(field.kind==='keymap'&&raw&&typeof raw==='object'&&!Array.isArray(raw))value=Object.fromEntries(Object.entries(raw as Record<string,string>).map(([k,v])=>[k,String(v).toUpperCase()]));
 return preferenceValueValid(field,value)?value as PreferenceValue:undefined;
}
export type DraftState={changes:PreferenceChange[];invalid:string[];dirty:boolean};
export function draftState(page:PreferencePageSchema,view:PreferencesPageView,draft:Draft):DraftState{
 const changes:PreferenceChange[]=[],invalid:string[]=[];
 for(const field of storedFields(page)){
  const item=view.items.find(i=>i.key===field.key)!,raw=draft[field.key];
  if(preferenceValueEqual(raw,item.value))continue;
  const value=normalizedValue(field,raw);
  if(value===undefined){invalid.push(field.key);continue;}
  if(!preferenceValueEqual(value,item.value))changes.push({key:field.key,expected_version:item.version,value});
 }
 return {changes,invalid,dirty:changes.length>0||invalid.length>0};
}
export function visible(entry:PreferenceField|PreferenceInfo,draft:Draft){
 if(entry.info||!entry.showIf)return true;
 return preferenceValueEqual(draft[entry.showIf.key],entry.showIf.equals);
}
export const sectionEntries=(page:PreferencePageSchema,section:string)=>page.fields.filter(entry=>entry.section===section);
export function choiceOptions(field:PreferenceField){return(field.options??[]) as readonly(readonly[string,string])[];}
export function integerOptions(field:PreferenceField){const out:string[]=[];for(let n=field.min!;n<=field.max!;n++)out.push(String(n));return out;}
export function invalidText(field:PreferenceField){
 switch(field.kind){
  case'integer':return `Informe um número inteiro entre ${field.min} e ${field.max}.`;
  case'decimal':return `Informe um número entre ${field.min} e ${field.max}, com até ${field.scale} casas decimais.`;
  case'text':return field.format==='email'?'Informe um e-mail válido.':field.format==='email_list'?`Informe até ${field.maxItems} e-mails separados por vírgula.`
   :field.format==='digits'?`Use só números, de ${field.minLength??1} a ${field.maxLength} dígitos.`:`Use até ${field.maxLength} caracteres, sem quebras de linha.`;
  case'textarea':return `Use até ${field.maxLength} caracteres.`;
  case'keymap':return 'Cada ação precisa de uma tecla diferente (letra, vírgula ou ponto).';
  case'documents':return `Informe CPF ou CNPJ válidos, sem repetir, até ${field.maxItems} pessoas.`;
  default:return 'Confira o valor informado.';
 }
}
/** status: HTTP status of an AccessError, or null for any other failure (network, contract, timeout). */
export function readError(status:number|null){
 // 264: a page may also follow a permission of Sistema › Usuários (Espaço Meu Contador, Central de Notificações).
 if(status===403)return 'Seu perfil ou as permissões do seu usuário (Sistema › Usuários) não permitem consultar estas preferências.';
 if(status===404)return 'Esta página de preferências não está disponível.';
 return 'Não foi possível carregar as preferências. Tente novamente.';
}
export type SaveFailure={definitive:boolean;message:string};
/** Only an authoritative refusal releases the command; anything else keeps it for "Conferir resultado". */
export function saveFailure(status:number|null,ownScope:boolean):SaveFailure{
 {
  if(status===409)return {definitive:true,message:'As preferências mudaram desde a consulta. Nada foi salvo. Recarregue para conferir os valores atuais; suas alterações continuam no formulário.'};
  if(status===400)return {definitive:true,message:'Nada foi salvo. Confira os valores informados.'};
  if(status===403)return {definitive:true,message:ownScope?'Nada foi salvo. Seu acesso precisa ser confirmado.':'Nada foi salvo. Somente administradores alteram estas preferências.'};
  if(status===404)return {definitive:true,message:'Nada foi salvo. Esta página de preferências não está disponível.'};
 }
 return {definitive:false,message:'Não foi possível confirmar se as preferências foram salvas. Confira o resultado do mesmo comando antes de tentar de novo.'};
}
export const saveNotice=(result:PreferencesResult)=>`${result.receipt.changes.length===1?'1 preferência salva':`${result.receipt.changes.length} preferências salvas`}${result.replayed?' (comando já registrado)':''}.`;
export const moment=(value:string)=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'});
export const keymapOptions=(field:PreferenceField)=>field.options as PreferenceKeymapOptions;
export function formatDocument(value:string){
 const v=value.replace(/[.\-/\s]/g,'');
 if(/^\d{11}$/.test(v))return `${v.slice(0,3)}.${v.slice(3,6)}.${v.slice(6,9)}-${v.slice(9)}`;
 if(/^[A-Z0-9]{12}\d{2}$/i.test(v))return `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8,12)}-${v.slice(12)}`;
 return value;
}
export const ROLE_NAMES:Record<PreferencesPageView['role'],string>={admin:'Administrador',consulta:'Consulta',vendas:'Vendas',financeiro:'Financeiro',estoque:'Estoque',fiscal:'Fiscal',operacao:'Atendimento e operação'};
export const policyText=(allow:boolean)=>allow?'Ativado — os lançamentos podem deixar o saldo negativo.':'Desativado — os lançamentos não podem deixar o saldo negativo.';
