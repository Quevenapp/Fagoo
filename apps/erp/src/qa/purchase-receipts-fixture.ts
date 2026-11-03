import fixture from '../../../../packages/erp-domain/test/fixtures/purchase-receipts.json' with {type:'json'};
import type {AccessState} from '../lib/real-access';
import type {PurchaseReceiptsController} from '../components/PurchaseReceipts';
import {capturePurchaseReceiptsRequest,type PurchaseReceiptsRequestOptions} from '../lib/purchase-receipts-request.ts';
import type {PurchaseReceiptsPage,PurchaseReceiptPreview,PurchaseReceiptResult,PurchaseReceipt,PurchaseReceiptReversal} from '../../../../packages/erp-domain/src/purchase-receipts-dto.mjs';
// QA_SYNTHETIC_PURCHASE_RECEIPTS — pure fixtures. No fetch, credentials, or real business data.
const clone=<T,>(v:T):T=>structuredClone(v),cases=fixture.cases,base=clone(cases[0].value) as unknown as PurchaseReceiptsPage;
const ACTOR='a0000000-0000-4000-8000-000000000090',HASH='a'.repeat(64),instant='2026-10-17T12:00:00.000Z';
const units=(s:string)=>{const [i,f='']=s.split('.');return BigInt(i+f.padEnd(6,'0'));};
const decimal=(n:bigint)=>`${n<0n?'-':''}${(n<0n?-n:n)/1000000n}.${((n<0n?-n:n)%1000000n).toString().padStart(6,'0')}`;
export type PurchaseReceiptCall={path:string;method:string;body?:Record<string,unknown>;signal?:AbortSignal};
// 277: launchDay is the day the server picks for a receive preview sent without a date (Preferências › Suprimentos › Estoque).
export function createPurchaseReceiptsFixture(options:{lostAck?:boolean;legacy?:boolean;role?:string;launchDay?:string;before?:(call:PurchaseReceiptCall)=>unknown|Promise<unknown>;after?:(call:PurchaseReceiptCall,value:unknown)=>unknown|Promise<unknown>}={}){
 let snapshot={phase:'ready',membership:{user_id:ACTOR,role:options.role??'admin'}} as AccessState,serial=100;
 const listeners=new Set<()=>void>(),calls:PurchaseReceiptCall[]=[],current=clone(base.current),commands=new Map<string,PurchaseReceiptResult>(),receipts:PurchaseReceipt[]=[],reversals=new Map<string,PurchaseReceiptReversal>();let lost=false;
 if(options.legacy){current.document.mode='legacy_full';current.document.eligible=false;current.items=[];}
 const newId=()=>`90000000-0000-4000-8000-${String(++serial).padStart(12,'0')}`;
 const summary=(r:PurchaseReceipt|PurchaseReceiptReversal)=>{const {items,positions,...rest}=r;return rest;};
 const page=(params:URLSearchParams):PurchaseReceiptsPage=>{const after=params.get('after'),selected=params.get('receipt_id'),all=receipts.filter(r=>!after||r.id>after).sort((a,b)=>a.id.localeCompare(b.id)),items=all.slice(0,25).map(r=>({receipt:summary(r),reversal:reversals.has(r.id)?summary(reversals.get(r.id)!):null})),r=receipts.find(r=>r.id===selected);return{...clone(base),current:clone(current),items,has_more:all.length>25,next_cursor:all.length>25?items.at(-1)!.receipt.id:null,selected:r?{receipt:clone(r),reversal:clone(reversals.get(r.id)??null)}:null} as PurchaseReceiptsPage;};
 const preview=(body:Record<string,unknown>,receiptId:string|null):PurchaseReceiptPreview=>{
  const template=clone(cases[receiptId?3:1].value) as unknown as {preview:PurchaseReceiptPreview},p=template.preview,original=receipts.find(r=>r.id===receiptId),values=receiptId?original!.items:body.items as {item_id:string;quantity:string}[];
  p.document=clone(current.document);p.receipt_id=receiptId;p.occurred_on=body.occurred_on===null?options.launchDay??'2026-10-17':String(body.occurred_on);p.reason=String(body.reason);p.preview_hash=HASH;
  p.items=values.map(v=>{const i=current.items.find(i=>i.item_id===v.item_id)!,q=units(v.quantity)*(receiptId?-1n:1n),before=units(i.received_quantity),after=before+q;return{item_id:i.item_id,position:i.position,product_id:i.product_id!,unit:i.unit,ordered_quantity:i.ordered_quantity,quantity:decimal(q),received_before:decimal(before),received_after:decimal(after),remaining_after:decimal(units(i.ordered_quantity)-after)};});
  const q=p.items.reduce((n,i)=>n+units(i.quantity),0n),before=current.items.reduce((n,i)=>n+units(i.received_quantity),0n);p.positions=p.positions.slice(0,1).map(x=>({...x,quantity:decimal(q),physical_before:decimal(before),reserved_before:'0.000000',available_before:decimal(before),physical_after:decimal(before+q),available_after:decimal(before+q),physical_version:current.document.version-2}));return p;
 };
 const controller:PurchaseReceiptsController={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};},async purchaseReceipts(path:string,o:PurchaseReceiptsRequestOptions={}){
  const captured=capturePurchaseReceiptsRequest(path,o);o=captured.options;
  const call:PurchaseReceiptCall={path,method:o.method??'GET',...(o.body?{body:clone(o.body) as Record<string,unknown>}:{}),signal:o.signal};calls.push(call);const early=await options.before?.(call);if(early!==undefined)return clone(early);
  const u=new URL(path,'https://synthetic.invalid'),parts=u.pathname.split('/'),body=call.body!;let out:unknown;
  if(parts.includes('comandos')){const result=commands.get(parts.at(-1)!);if(!result)throw Object.assign(Error('NOT_FOUND'),{status:404});out={...clone(result),current:clone(current),replayed:true};}
  else if(call.method==='GET')out=page(u.searchParams);
  else if(parts.at(-1)!.endsWith('preview'))out={scope:'purchase_receipts',data_mode:'erp_native',preview:preview(body,parts.at(-1)==='reverse-preview'?parts.at(-2)!:null)};
  else{
   const prior=commands.get(String(body.command_id));if(prior)out={...clone(prior),current:clone(current),replayed:true};else{
    const reversing=parts.at(-1)==='reverse',receiptId=reversing?parts.at(-2)!:null,p=preview(body,receiptId),version=current.document.version+1;
    const written={id:newId(),document_id:current.document.id,source_document_version:version-1,document_version:version,command_id:String(body.command_id),movement_id:newId(),occurred_on:p.occurred_on,reason:p.reason,created_at:instant,warehouse_id:p.warehouse.id,item_count:p.items.length,position_count:p.positions.length,preview_hash:p.preview_hash,items:p.items,positions:p.positions};
    let receipt:PurchaseReceipt,reversal:PurchaseReceiptReversal|null=null;if(reversing){receipt=receipts.find(r=>r.id===receiptId)!;reversal={...written,receipt_id:receiptId!};reversals.set(receiptId!,reversal);}else{receipt=written;receipts.push(receipt);}
    for(const line of p.items){const item=current.items.find(i=>i.item_id===line.item_id)!;item.received_quantity=line.received_after;item.remaining_quantity=line.remaining_after;}
    Object.assign(current.document,{version,mode:'item_receipts',active_receipts:receipts.length-reversals.size,chain_hash:String(version%10).repeat(64)});
    const result:PurchaseReceiptResult={scope:'purchase_receipts',data_mode:'erp_native',receipt:{command_id:String(body.command_id),action:reversing?'reverse':'receive',document_id:current.document.id,document_version:version,receipt:clone(receipt),reversal:clone(reversal)},current:clone(current),replayed:false};commands.set(String(body.command_id),result);out=result;
   }
   if(options.lostAck&&!lost){lost=true;throw Object.assign(Error('ACK_LOST'),{status:503});}
  }
  const replacement=await options.after?.(call,clone(out));return clone(replacement===undefined?out:replacement);
 }};
 return{controller,calls,commands,current,record:{id:current.document.id,kind:'purchase_orders',version:current.document.version},setSession(role:string|null,actor=ACTOR,phase='ready'){snapshot={phase:role?phase:'signed_out',membership:role?{user_id:actor,role}:null} as AccessState;listeners.forEach(fn=>fn());}};
}
