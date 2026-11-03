import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fixture as stockFixture} from './stock-reservation-fixture.mjs';
export const PURCHASE_RECEIPTS_MIGRATION=new URL('../../../supabase/migrations/202610160090_purchase_receipts.sql',import.meta.url);
export async function purchaseReceiptsFixture({apply=true}={}){
 const f=await stockFixture();
 await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160019_document_effect_flags.sql',import.meta.url),'utf8'));
 const migrate=async()=>f.db.exec(await readFile(PURCHASE_RECEIPTS_MIGRATION,'utf8'));
 if(apply)await migrate();
 const get=async(d,extra={})=>f.rpc('erp_purchase_receipts_get',{p_user_id:f.users.estoque,p_document_id:d.id,...extra});
 const purchase=async(options={})=>f.order({kind:'purchase_orders',...options});
 const selection=async(d,quantity='1')=>(await f.db.query('select id from erp_documents.item where document_id=$1 order by position',[d.id])).rows.map(x=>({item_id:x.id,quantity}));
 const input=(d,items,extra={})=>({p_user_id:f.users.estoque,p_document_id:d.id,p_expected_version:d.version,p_occurred_on:'2026-10-15',p_reason:'Conferência sintética090',p_items:items,...extra});
 const preview=async(d,items,extra={})=>(await f.rpc('erp_purchase_receipts_preview',input(d,items,extra))).preview;
 const receive=async(d,items,{prior,command=randomUUID(),patch={}}={})=>{
  const p=prior??await preview(d,items),args={...input(d,items),p_command_id:command,p_preview_hash:p.preview_hash,p_confirm:true,...patch};
  const out=await f.rpc('erp_purchase_receipts_receive',args);d.version=out.current.document.version;return{...out,args,preview:p};
 };
 const reverseInput=(d,receipt,extra={})=>({p_user_id:f.users.estoque,p_document_id:d.id,p_expected_version:d.version,p_receipt_id:receipt.id,p_occurred_on:'2026-10-15',p_reason:'Estorno sintético090',...extra});
 const reversePreview=async(d,receipt,extra={})=>(await f.rpc('erp_purchase_receipts_reverse_preview',reverseInput(d,receipt,extra))).preview;
 const reverse=async(d,receipt,{prior,command=randomUUID(),patch={}}={})=>{
  const p=prior??await reversePreview(d,receipt),args={...reverseInput(d,receipt),p_command_id:command,p_preview_hash:p.preview_hash,p_confirm:true,...patch};
  const out=await f.rpc('erp_purchase_receipts_reverse',args);d.version=out.current.document.version;return{...out,args,preview:p};
 };
 const legacyPreview=async d=>(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'purchase_orders',p_document_id:d.id,p_expected_version:d.version,p_occurred_on:'2026-10-15',p_reason:'Integral sintético018'})).preview;
 const legacyPost=async(d,{prior,command=randomUUID()}={})=>{const p=prior??await legacyPreview(d);const out=await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'purchase_orders',p_document_id:d.id,p_expected_version:d.version,p_command_id:command,p_preview_hash:p.preview_hash,p_occurred_on:'2026-10-15',p_reason:'Integral sintético018',p_ignored_item_ids:p.ignored.map(x=>x.id)});d.version=out.document_version;return out;};
 return{...f,purchase,selection,get,input,preview,receive,reverseInput,reversePreview,reverse,legacyPreview,legacyPost,migrate};
}
