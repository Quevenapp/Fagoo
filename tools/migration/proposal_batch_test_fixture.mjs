// Synthetic DTO fixtures only. The injected driver never opens a socket.
import * as f from '../../apps/erp/test/helpers/proposal-import-v2-fixtures.mjs';
import {createProposalBatchPort} from './proposal_batch_port.mjs';
export {f};
export const projectUrl='https://abcdefghijklmnopqrst.supabase.co';
export function jsonResponse(url,value,status=200){const r=new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;}
// 095 list rows: indicator fields the worker projection requires (no effects on synthetic proposals).
export const listFields={expected_date:null,next_contact:null,template:false,warehouse_id:null,warehouse_name:null,source_proposal_id:null,source_proposal_number:null,finance_active:false,stock_active:false,receipt_active:false,reservation_active:false,fiscal_draft:null,internal_notes:null};
export function proposalBatchFixture(count=2){
 const ids=Array.from({length:count},(_,i)=>String(9550000001+i)),previews=new Map(ids.map(id=>[id,f.preview(id)])),commands=new Map(),currents=new Map(),calls=[];
 const baseline={id:'10000000-0000-4000-8000-000000000001',kind:'sales_proposals',number:'1',version:3,status:'approved',created_at:f.time,updated_at:f.time,date:'2026-10-16',total:'26.71',contact_id:f.contact,contact_name:'Contato sintético',...listFields};
 const native=new Map([[baseline.id,structuredClone(baseline)]]);
 let hook=null;
 async function fetchImpl(url,init){
  const name=url.split('/').at(-1),a=JSON.parse(init.body);calls.push({name,args:structuredClone(a),signal:init.signal});
  if(hook){const intercepted=await hook({url,init,name,args:a});if(intercepted)return intercepted;}
  if(a.p_user_id!==f.actor)return jsonResponse(url,{code:'42501'},403);
  if(name==='erp_origin_proposal_import_sources_v2')return jsonResponse(url,f.page(ids.map(id=>({...f.row(id),document_id:currents.get(id)?.current_document.id??null})),a.p_after));
  if(name==='erp_origin_proposal_import_preview_v2')return jsonResponse(url,previews.get(a.p_source_id));
  if(name==='erp_document_list'){
   const rows=[...native.values()].sort((a,b)=>a.id.localeCompare(b.id)).filter(r=>a.p_after===null||r.id>a.p_after),items=rows.slice(0,25),has_more=rows.length>25;
   return jsonResponse(url,{data_mode:'erp_native',operational_effects:false,kind:'sales_proposals',items:items.map(row=>({...listFields,...row})),limit:25,page:null,order:'id',has_more,next_cursor:has_more?items.at(-1).id:null,total_count:rows.length,total_amount:'0.00'});
  }
  if(name==='erp_origin_proposal_import_command_v2')return commands.has(a.p_command_id)?jsonResponse(url,commands.get(a.p_command_id)):jsonResponse(url,{code:'P0002',message:'discarded server text'},404);
  if(name==='erp_origin_proposal_import_apply_v2'){
   const p=previews.get(a.p_source_id);if(!p?.can_apply||p.preview_hash!==a.p_preview_hash)return jsonResponse(url,{code:'40001'},409);
   if(commands.has(a.p_command_id))return jsonResponse(url,{...f.flags,dry_run:false,persisted:true,replayed:true,receipt:commands.get(a.p_command_id).receipt});
   const body={source_id:a.p_source_id,preview_hash:a.p_preview_hash,command_id:a.p_command_id,confirm_import:true,duplicate_reviewed:true},ack=f.ack(body,p);
   const id='c0000000-0000-4000-8000-'+String(ids.indexOf(a.p_source_id)+1).padStart(12,'0');ack.receipt.document.id=id;ack.receipt.document.number=String(native.size+1);
   const current=f.current(ack,p);commands.set(a.p_command_id,current);currents.set(a.p_source_id,current);native.set(id,ack.receipt.document);return jsonResponse(url,ack);
  }
  throw new Error('Unexpected synthetic operation');
 }
 const port=createProposalBatchPort({projectUrl,actor:f.actor,serviceKey:'synthetic-key-do-not-use',fetchImpl,allowApply:true});
 return{ids,previews,commands,currents,calls,native,baseline,port,fetchImpl,setHook(value){hook=value;}};
}
