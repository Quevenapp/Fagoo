/** Small explicit file wrapper. Caller supplies secret/fetch and reviewed private paths; no CLI or defaults. */
import fs from 'node:fs/promises';import {constants} from 'node:fs';import {resolve} from 'node:path';
import {adoptionDigest} from './execute_proposal_product_adoption.mjs';
import {savePrivateAdoptionPlan} from './plan_proposal_product_adoption.mjs';
import {prepareCatalogUpdateReview,executeReviewedCatalogUpdates,recoverReviewedCatalogUpdates} from './execute_catalog_reviewed_updates.mjs';
import {createReviewedCatalogUpdatePorts} from './catalog_reviewed_update_ports.mjs';
import {requireUpdate as need} from './catalog_update_preservation.mjs';
async function readPrivate(path){
 let file;try{file=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await file.stat();need(s.isFile()&&(s.mode&0o077)===0&&s.size<=2*1024*1024,'PRIVATE_FILE_INVALID');const bytes=await file.readFile();need(bytes.length<=2*1024*1024,'PRIVATE_FILE_INVALID');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch(e){throw new Error(e.code==='ENOENT'?'PRIVATE_FILE_MISSING':'PRIVATE_FILE_INVALID');}finally{await file?.close();}
}
export async function runCatalogUpdateFileStep({mode,planPath,planHash,reviewPath,approvedReviewHash,directory,beforePath,postPath,ledgerPath,projectUrl,secret,fetchImpl,signal,deadline}){
 need(['prepare','apply-reviewed','recover-readonly'].includes(mode),'FILE_STEP_MODE');
 const paths=[planPath,reviewPath,beforePath,ledgerPath,...(postPath?[postPath]:[])];need(paths.every(x=>typeof x==='string'&&x.startsWith('/'))&&new Set(paths.map(x=>resolve(x))).size===paths.length,'FILE_PATH_SCOPE');
 need(mode!=='recover-readonly'||typeof postPath==='string','POST_EXPORT_REQUIRED');
 const plan=await readPrivate(planPath),adapter=createReviewedCatalogUpdatePorts({plan,planHash,projectUrl,secret,fetchImpl,mode,readReceipt:()=>readPrivate(ledgerPath),readPreservation:()=>readPrivate(mode==='recover-readonly'?postPath:beforePath)});
 try{
  if(mode==='prepare'){
   const review=await prepareCatalogUpdateReview({plan,planHash,ports:adapter.ports,signal,deadline});await savePrivateAdoptionPlan(reviewPath,review);
   return{outcome:'prepared',review_hash:adoptionDigest(review),selected:plan.items.length,...adapter.stats(),operational_effects:false};
  }
  const review=await readPrivate(reviewPath),run=mode==='recover-readonly'?recoverReviewedCatalogUpdates:executeReviewedCatalogUpdates;
  const result=await run({plan,planHash,review,approvedReviewHash,directory,ports:adapter.ports,signal,deadline});
  // No IDs, prices, records, receipt bodies or private paths are emitted by this wrapper.
  return{outcome:result.outcome,code:result.code??null,readback_pending:result.readback_pending===true,preservation_export_required:result.preservation_export_required===true,requires_ledger_export:result.requires_ledger_export===true,...adapter.stats(),operational_effects:false};
 }finally{adapter.dispose();}
}
