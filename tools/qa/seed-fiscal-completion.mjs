/** In-memory, synthetic examples. No number reservation, artifact, signature or fiscal transmission. */
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {emptyCompletion,completionEnvelope,completionHistory} from '../../apps/erp/src/lib/fiscal-completion-model.ts';
import {parseFiscalCompletionRoute,executeFiscalCompletionRoute} from '../../workers/erp-api/src/fiscal-completion.mjs';

export async function seedFiscalCompletion({db,uid}){
 if(!(db instanceof PGlite))throw new Error('QA_COMPLETION_PGLITE_REQUIRED');
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 const rpc=async(name,args)=>{const pairs=Object.entries(args);return scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));};
 const identity=(await rpc('erp_company_get',{p_user_id:uid,p_section:'identity'})).record,fiscal=(await rpc('erp_company_get',{p_user_id:uid,p_section:'fiscal'})).record;
 if(!identity||!['11222333000181','12345678000195'].includes(identity.data.cnpj)||identity.data.state!=='SP'||fiscal?.crt!=='1'||fiscal?.confirmed!==true)throw new Error('QA_COMPLETION_SYNTHETIC_COMPANY_REQUIRED');
 if(await scalar("select exists(select 1 from erp_documents.document where body->>'notes'like 'QA047-COMPLEMENTO-%')value"))throw new Error('QA_COMPLETION_ALREADY_SEEDED');
 const effects=()=>scalar('select jsonb_build_array((select count(*)from erp_fiscal_numbering.reservation),(select count(*)from erp_fiscal_numbering.series),(select count(*)from erp_finance.title),(select count(*)from erp_stock.movement),(select version from erp_company.identity where singleton),(select version from erp_company.fiscal where singleton))value');
 const before=await effects(),result=[];
 await db.exec('begin');
 try{
  const contact=(await rpc('erp_catalog_save',{p_user_id:uid,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Cliente fictício do complemento 047',code:'QA047-C01',person_type:'J',city:'Piracicaba',state:'SP',roles:['customer']}})).record;
  const product=(await rpc('erp_catalog_save',{p_user_id:uid,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Produto fictício do complemento 047',code:'QA047-P01',unit:'UN',kind:'P',format:'S',ncm:'82055900',origin:'0',gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}})).record;
  for(const spec of[{tag:'NF55-CREDITO-VAZIO',model:'55',branch:'101',count:2,versions:0},{tag:'NF65-RETENCAO-HISTORICO',model:'65',branch:'500',count:2,versions:27},{tag:'NF55-BASE-ALTERADA',model:'55',branch:'102',count:2,versions:1,stale:true},{tag:'NF55-250-ITENS',model:'55',branch:'500',count:250,versions:0}]){
   const document=(await rpc('erp_document_save',{p_user_id:uid,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:Array.from({length:spec.count},(_,n)=>({product_id:product.id,description:`Item fictício ${n+1} · ${spec.tag}`,unit:'UN',quantity:'1.230000',unit_price:'10.0000'})),notes:`QA047-COMPLEMENTO-${spec.tag}`,internal_notes:'QA047_PRIVATE_INTERNAL_NOTE_NOT_FOR_FISCAL'}})).document;
   const draft=await rpc('erp_fiscal_draft_execute',{p_user_id:uid,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:document.id,expected_source_version:document.version,model:spec.model,preparation:{operation_nature:'Venda fictícia interna para QA',notes:`QA047 ${spec.tag} — não transmitir`}}});
   const b={p_user_id:uid,p_draft_id:draft.record.id,p_expected_draft_version:draft.record.version,p_snapshot_hash:draft.record.snapshot_hash,p_expected_version:0};
   const item=await rpc('erp_fiscal_item_save',{...b,p_command_id:randomUUID(),p_decisions:draft.record.snapshot.items.map(i=>({item_id:i.id,fields:Object.fromEntries(Object.entries({ncm:'82055900',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}).map(([k,value])=>[k,{source:'manual',value}]))}))});
   const sn=spec.branch==='101'?{csosn:'101',credit_rate:null,credit_period:null,credit_evidence:null}:spec.branch==='500'?{csosn:'500',retention:{base:null,rate:null,substitute_icms:null,retained_icms:null},fcp:{base:null,rate:null,amount:null},effective:{reduction_rate:null,base:null,rate:null,amount:null}}:{csosn:'102'};
   const decisions=draft.record.snapshot.items.map(i=>({item_id:i.id,cfop:spec.branch==='500'?'5405':'5102',icms:structuredClone(sn),pis:null,cofins:null,review_note:'Escolhas exclusivamente sintéticas, sem validade fiscal'}));
   const tax=await rpc('erp_fiscal_tax_save',{...b,p_item_preparation_version:item.record.version,p_operation:'internal_normal_sale',p_decisions:decisions,p_command_id:randomUUID()});
   const completion=emptyCompletion(draft.record.snapshot.items.map(i=>i.id));
   if(spec.versions){completion.items[0].tributary={unit:'UN',quantity:'1.234500',unit_price:'10.0000000000'};completion.items[0].allocations.freight='0.00';completion.totals.vFrete='0.00';}
   for(let v=0;v<spec.versions;v++){
    completion.additional_information=`Captura ficticia ${v+1} para QA local`;
    const args={p_user_id:uid,p_draft_id:draft.record.id,p_expected_draft_version:draft.record.version,p_snapshot_hash:draft.record.snapshot_hash,p_item_preparation_version:item.record.version,p_tax_preparation_version:tax.record.version,p_expected_identity_version:identity.version,p_expected_fiscal_version:fiscal.version,p_expected_completion_version:v,p_completion:completion,p_command_id:randomUUID()};
    await rpc('erp_fiscal_completion_save',args);
   }
   if(spec.stale)await rpc('erp_fiscal_tax_save',{...b,p_expected_version:1,p_item_preparation_version:item.record.version,p_operation:'internal_normal_sale',p_decisions:decisions,p_command_id:randomUUID()});
   const route=await parseFiscalCompletionRoute(new Request(`https://synthetic.invalid/v1/complemento-fiscal/${draft.record.id}`)),body=(await executeFiscalCompletionRoute(route,{userId:uid,rpc})).body;
   const checked=completionEnvelope(body,draft.record.id);
   if(checked.current.completion_version!==spec.versions||checked.current.tax_preparation_version!==(spec.stale?2:1)||spec.stale&&checked.current.matches_current_tax_preparation!==false)throw new Error('QA_COMPLETION_BINDING_FAILED');
   if(spec.versions>25){
    const first=completionHistory(await rpc('erp_fiscal_completion_history',{p_user_id:uid,p_draft_id:draft.record.id,p_limit:25,p_before:null}),draft.record.id,null),second=completionHistory(await rpc('erp_fiscal_completion_history',{p_user_id:uid,p_draft_id:draft.record.id,p_limit:25,p_before:first.next_cursor}),draft.record.id,first.next_cursor);
    if(first.items.length!==25||second.items.length!==2||second.has_more)throw new Error('QA_COMPLETION_HISTORY_FAILED');
   }
   result.push({tag:spec.tag,draft_id:draft.record.id,order_number:document.number,model:spec.model,items:spec.count,completion_version:spec.versions,tax_version:spec.stale?2:1});
  }
  if(JSON.stringify(before)!==JSON.stringify(await effects()))throw new Error('QA_COMPLETION_EFFECTS_CHANGED');
  await db.exec('commit');return{fixtures:result,reserved_numbers:0,financial_effects:0,stock_effects:0};
 }catch(e){await db.exec('rollback');throw e;}
}
