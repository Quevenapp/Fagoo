import {moneyInput,postingDate,validFinanceDate,type FinanceAccount} from './real-finance-model.ts';

export const TRANSFERS_BASE='/v1/transferencias-internas';
export type TransferBody={command_id:string;from_account_id:string;to_account_id:string;expected_from_version:number;expected_to_version:number;amount_cents:string;posted_on:string;note:string;confirmed:true};
export type TransferSnapshot={id:string;name:string;kind:FinanceAccount['kind'];version_before:number;version_after:number;balance_before_cents:string;balance_after_cents:string;opening_on:string|null};
export type TransferLeg={id:string;account_id:string;kind:'transfer_out'|'transfer_in';delta_cents:string};
export type TransferReceipt={id:string;command_id:string;from_account:TransferSnapshot;to_account:TransferSnapshot;amount_cents:string;posted_on:string;note:string;created_at:string;movements:[TransferLeg,TransferLeg]};
export type TransferCurrent={from_account:FinanceAccount&{opening_on:string|null};to_account:FinanceAccount&{opening_on:string|null}};
export type TransferResult={receipt:TransferReceipt;current:TransferCurrent;read_only?:true;replayed?:boolean};
export type TransferPage={items:TransferResult[];limit:25;has_more:boolean;next_cursor:string|null};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&Array.from(v).length>0&&Array.from(v).length<=max&&!/[\x00-\x1f\x7f-\x9f]/.test(v);
// Account names follow the existing010 contract, which permits tab/newline/CR.
const name=(v:unknown):v is string=>typeof v==='string'&&Array.from(v).length>0&&Array.from(v).length<=200&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const version=(v:unknown):v is number=>Number.isInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const cents=(v:unknown):v is string=>typeof v==='string'&&/^(?:0|-?[1-9][0-9]{0,29})$/.test(v);
const positive=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,14}$/.test(v);
const kind=(v:unknown)=>typeof v==='string'&&['bank','cash','other'].includes(v);
const note=(v:unknown):v is string=>text(v,500)&&Array.from(v).length>=3&&v===v.replace(/^ +| +$/g,'')&&v.replace(/[\s\u200b\ufeff]/g,'').length>0;
function stamp(v:unknown):v is string {
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;
 const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;
 return(!m||Number(m[2])<=14&&Number(m[3])<=59&&(m[2]!=='14'||m[3]==='00'))&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
function bad():never{throw new Error('Não foi possível conferir os dados da transferência.');}
const day=(v:unknown)=>{if(typeof v!=='string')bad();try{validFinanceDate(v);}catch{bad();}return v;};
function flags(v:unknown):asserts v is Record<string,unknown>{if(!object(v)||v.scope!=='finance_internal_transfer'||v.data_mode!=='erp_native'||v.bank_operation_performed!==false||v.title_mutation_performed!==false||v.opening_mutation_performed!==false)bad();}
export function transferAccount(v:unknown):FinanceAccount{
 if(!object(v)||!id(v.id)||!name(v.name)||!kind(v.kind)||typeof v.active!=='boolean'||typeof v.opening_recorded!=='boolean'||!version(v.version)||!cents(v.balance_cents))bad();
 return{id:v.id,name:v.name,kind:v.kind as FinanceAccount['kind'],active:v.active,opening_recorded:v.opening_recorded,version:v.version,balance_cents:v.balance_cents};
}
export function transferAccountEnvelope(v:unknown,expectedId:string):FinanceAccount{if(!object(v)||v.entity!=='accounts'||v.data_mode!=='erp_native')bad();const account=transferAccount(v.record);if(account.id!==expectedId)bad();return account;}
export function transferAccountPage(v:unknown,after:string|null):{items:FinanceAccount[];has_more:boolean;next_cursor:string|null}{
 if(!object(v)||v.entity!=='accounts'||v.data_mode!=='erp_native'||v.limit!==25||!Array.isArray(v.items)||v.items.length>25||typeof v.has_more!=='boolean')bad();
 let previous=after??'';const items=v.items.map(value=>{const a=transferAccount(value);if(a.id<=previous)bad();previous=a.id;return a;});
 if(v.has_more?(items.length!==25||v.next_cursor!==previous):v.next_cursor!==null)bad();
 return{items,has_more:v.has_more,next_cursor:v.next_cursor as string|null};
}
export function transferBody(from:FinanceAccount,to:FinanceAccount,values:{amount:string;posted_on:string;note:string},commandId:string):TransferBody{
 if(!id(commandId)||!from.active||!to.active||from.id===to.id)throw new Error('Selecione duas contas financeiras ativas e diferentes.');
 const amount=moneyInput(values.amount);if(!positive(amount))throw new Error('Informe um valor maior que zero.');
 const description=values.note.trim();if(!note(description))throw new Error('Descreva a transferência em 3 a 500 caracteres.');
 postingDate(values.posted_on);
 return{command_id:commandId,from_account_id:from.id,to_account_id:to.id,expected_from_version:from.version,expected_to_version:to.version,amount_cents:amount,posted_on:values.posted_on,note:description,confirmed:true};
}
function snapshot(v:unknown):TransferSnapshot{
 if(!object(v)||!id(v.id)||!name(v.name)||!kind(v.kind)||!version(v.version_before)||!version(v.version_after)||v.version_after!==v.version_before+1||!cents(v.balance_before_cents)||!cents(v.balance_after_cents)||v.opening_on!==null&&typeof v.opening_on!=='string')bad();
 if(v.opening_on!==null)day(v.opening_on);
 return{id:v.id,name:v.name,kind:v.kind as FinanceAccount['kind'],version_before:v.version_before,version_after:v.version_after,balance_before_cents:v.balance_before_cents,balance_after_cents:v.balance_after_cents,opening_on:v.opening_on as string|null};
}
function receipt(v:unknown):TransferReceipt{
 if(!object(v)||!id(v.id)||!id(v.command_id)||!positive(v.amount_cents)||!note(v.note)||!stamp(v.created_at)||!Array.isArray(v.movements)||v.movements.length!==2)bad();
 const from=snapshot(v.from_account),to=snapshot(v.to_account),amount=BigInt(v.amount_cents),posted=day(v.posted_on);
 if(from.id===to.id||BigInt(from.balance_before_cents)-amount!==BigInt(from.balance_after_cents)||BigInt(to.balance_before_cents)+amount!==BigInt(to.balance_after_cents)||from.opening_on&&posted<from.opening_on||to.opening_on&&posted<to.opening_on)bad();
 const legs=v.movements.map((value,index)=>{const a=index?to:from,delta=(index?amount:-amount).toString(),type=index?'transfer_in':'transfer_out';if(!object(value)||!id(value.id)||value.account_id!==a.id||value.kind!==type||value.delta_cents!==delta)bad();return{id:value.id,account_id:a.id,kind:type,delta_cents:delta} as TransferLeg;}) as [TransferLeg,TransferLeg];
 if(legs[0].id===legs[1].id)bad();
 return{id:v.id,command_id:v.command_id,from_account:from,to_account:to,amount_cents:v.amount_cents,posted_on:posted,note:v.note,created_at:v.created_at,movements:legs};
}
function currentAccount(v:unknown,s:TransferSnapshot){
 const a=transferAccount(v);if(!object(v)||a.id!==s.id||a.version<s.version_after||v.opening_on!==null&&typeof v.opening_on!=='string'||a.opening_recorded!==(v.opening_on!==null)||s.opening_on!==null&&v.opening_on!==s.opening_on)bad();
 if(v.opening_on!==null)day(v.opening_on);
 if(a.version===s.version_after&&(a.name!==s.name||a.kind!==s.kind||!a.active||a.balance_cents!==s.balance_after_cents||v.opening_on!==s.opening_on))bad();
 return{...a,opening_on:v.opening_on as string|null};
}
function pair(v:unknown):TransferResult{if(!object(v)||!object(v.current))bad();const r=receipt(v.receipt);return{receipt:r,current:{from_account:currentAccount(v.current.from_account,r.from_account),to_account:currentAccount(v.current.to_account,r.to_account)}};}
/** A historical receipt is bound to the frozen confirmation; current balances may change later. */
export function transferResult(v:unknown,{body,ack,readOnly=false,transferId}:{body?:TransferBody;ack?:TransferReceipt|null;readOnly?:boolean;transferId?:string}={}):TransferResult{
 flags(v);if(readOnly?v.read_only!==true:typeof v.replayed!=='boolean')bad();const result=pair(v),r=result.receipt;
 if(transferId&&r.id!==transferId)bad();
 if(body&&(r.command_id!==body.command_id||r.from_account.id!==body.from_account_id||r.to_account.id!==body.to_account_id||r.from_account.version_before!==body.expected_from_version||r.to_account.version_before!==body.expected_to_version||r.amount_cents!==body.amount_cents||r.posted_on!==body.posted_on||r.note!==body.note))bad();
 if(ack&&JSON.stringify(ack)!==JSON.stringify(r))bad();
 return{...result,...(readOnly?{read_only:true as const}:{replayed:v.replayed as boolean})};
}
export function transferPage(v:unknown,after:string|null):TransferPage{
 flags(v);if(v.read_only!==true||v.limit!==25||!Array.isArray(v.items)||v.items.length>25||typeof v.has_more!=='boolean')bad();let previous=after??'';
 const items=v.items.map(value=>{const result=pair(value);if(result.receipt.id<=previous)bad();previous=result.receipt.id;return result;});
 if(v.has_more?(items.length!==25||v.next_cursor!==previous):v.next_cursor!==null)bad();return{items,limit:25,has_more:v.has_more,next_cursor:v.next_cursor as string|null};
}
