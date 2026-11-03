/** Optional bounded adapter over existing ports. No environment, default fetch or implicit apply. */
import {createCatalogAdoptionRpc} from './catalog_adoption_rpc.mjs';
import {checkedUpdatePlan,captureUpdate,requireUpdate as need} from './catalog_update_preservation.mjs';
import {proposalBatchOperation} from './proposal_batch_port.mjs';
import {catalogImportResponse} from '../../workers/erp-api/src/catalog-import.mjs';
export function createReviewedCatalogUpdatePorts({plan,planHash,projectUrl,secret,fetchImpl,mode='prepare',readPreservation,readReceipt}){
 const p=checkedUpdatePlan(plan,planHash);need(projectUrl===p.project_url&&typeof fetchImpl==='function'&&typeof readPreservation==='function'&&typeof readReceipt==='function','PORT_CONFIGURATION');
 const evidence=p.expected.flatMap(e=>e.witnesses.map(w=>({proposal_id:w.source_id})));
 const port=createCatalogAdoptionRpc({projectUrl,secret,mode,plan:{actor:p.actor,batches:[{entity:'products',command_id:p.command_id,preview_hash:p.preview_hash,items:p.items,evidence}]},fetchImpl:(url,init)=>fetchImpl(url,{...init,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers:{...init.headers,Accept:'application/json','Accept-Encoding':'identity'}})});
 return Object.freeze({ports:Object.freeze({
  receipt:(args,options)=>readReceipt(captureUpdate(args),options),
  preservation:(args,options)=>readPreservation(captureUpdate(args),options),
  proposal:async(id,options)=>{const operation=await proposalBatchOperation('preview',{source_id:id});return operation.project(await port.rpc(operation.rpc,operation.args,options));},
  catalog:async(items,options)=>{const args={p_entity:'products',p_items:captureUpdate(items)};return catalogImportResponse(await port.rpc('erp_catalog_import_preview',args,options),{entity:'products'},{type:'preview',args});},
  apply:async(args,options)=>catalogImportResponse(await port.rpc('erp_catalog_import_apply',args,options),{entity:'products'},{type:'apply',args})
 }),stats:port.stats,dispose:port.dispose});
}
