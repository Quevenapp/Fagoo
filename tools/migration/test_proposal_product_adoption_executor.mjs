import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planProposalProductAdoption} from './plan_proposal_product_adoption.mjs';
import {adoptionDigest,adoptionReceiptExportSql,prepareAdoptionReview,executeReviewedAdoption} from './execute_proposal_product_adoption.mjs';
const H='a'.repeat(64),PH='b'.repeat(64),PREVIEW='c'.repeat(64),T=Date.parse('2026-10-16T15:00:00Z');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'brufap-adoption-executor-')),actor=randomUUID(),record=randomUUID(),calls=[];
 const evidence={profile:'proposal-product-adoption-evidence-v1',read_only:true,exported_at:new Date(T).toISOString(),has_more:false,items:[{source_id:'1',source_hash:H,source_version:'1',source_seen_at:new Date(T-1000).toISOString(),proposal_id:'99',proposal_hash:PH,proposal_version:'2',source_active:true,source_simple_product:true,capture:{profile:'origin-price-json-v1',source:'detail',response_sha256:'d'.repeat(64),capture_id:randomUUID(),observed_at:new Date(T-2000).toISOString(),source_hash:H,source_version:'1',numeric_price:true}}]};
 let imported=false,ledgerReceipt=null;
 function preview(){return{entity:'products',data_mode:'erp_native',operational_effects:false,dry_run:true,preview_hash:PREVIEW,items:[{source_id:'1',source_hash:H,source_version:'1',last_seen_at:evidence.items[0].source_seen_at,name:'Synthetic product',code:null,source_status:'A',record_id:imported?record:null,record_version:imported?1:null,local_name:imported?'Synthetic product':null,origin_state:imported?'synced':null,error:null,human_edited:false,stock_locked:false,candidate_retained:false,action:imported?'unchanged':'create',operation_action:imported?'unchanged':'create',changes:imported?[]:[{field:'name',before:null,after:'Synthetic product',redacted:false},{field:'active',before:null,after:true,redacted:false},{field:'kind',before:null,after:'P',redacted:false},{field:'format',before:null,after:'S',redacted:false},{field:'price',before:null,after:'12.1234567891',redacted:false}]}]};}
 const ack=()=>({entity:'products',data_mode:'erp_native',operational_effects:false,dry_run:false,replayed:false,preview_hash:PREVIEW,items:[{source_id:'1',source_hash:H,source_version:'1',record_id:record,action:'create',error:null}]});
 const proposal=()=>({dry_run:true,persisted:false,source_id:'99',source_hash:PH,source_version:'2',source_status:'Rascunho',existing:null,bindings:[{entity:'products',source_id:'1',source_hash:H,source_version:'1',record_id:imported?record:null,origin_state:imported?'synced':null}]});
 const readers={proposal:async()=>proposal(),catalog:async()=>preview()},plan=await planProposalProductAdoption({evidence,readers,actor,now:()=>new Date(T)}),planHash=hash(plan),command=plan.batches[0].command_id;
 const exported=args=>({profile:'catalog-import-receipt-export-v1',read_only:true,exported_at:new Date(T).toISOString(),actor,command_id:command,body_hash:adoptionDigest(args),found:ledgerReceipt!==null,request_matches:ledgerReceipt!==null,namespace_conflict:false,receipt:ledgerReceipt});
 const ports={evidence:async()=>{calls.push('evidence');return evidence;},receipt:async args=>{calls.push('receipt');return exported(args);},proposal:async()=>{calls.push('proposal');return proposal();},catalog:async()=>{calls.push('catalog');return preview();},apply:async()=>{calls.push('apply');imported=true;ledgerReceipt=ack();return ack();}};
 const review=await prepareAdoptionReview({plan,planHash,ports,now:()=>T});calls.length=0;
 const input={plan,planHash,review,approvedReviewHash:adoptionDigest(review),directory,ports,now:()=>T};
 return{directory,plan,planHash,review,command,calls,ports,input,evidence,preview,ack,exported,imported:()=>{imported=true;ledgerReceipt=ack();},forgetReceipt:()=>{ledgerReceipt=null;},state:async()=>JSON.parse(await readFile(join(directory,`proposal-product-adoption-${command}.json`),'utf8')),close:()=>rm(directory,{recursive:true,force:true})};
}
test('one batch: receipt first, pending durable before POST, ACK durable before readback, exact price preserved',async()=>{
 const f=await fixture();try{const apply=f.ports.apply,catalog=f.ports.catalog;let accepted=false;
 f.ports.apply=async args=>{const pending=await f.state();assert.equal(pending.state,'pending');assert.equal(pending.body_hash,adoptionDigest(args));assert.equal(pending.command_id,args.p_command_id);accepted=true;return apply(args);};
 f.ports.catalog=async(...args)=>{if(accepted)assert.equal((await f.state()).state,'acknowledged');return catalog(...args);};
 const result=await executeReviewedAdoption(f.input);assert.equal(result.outcome,'verified');assert.equal(f.calls[0],'receipt');assert.equal(f.calls.filter(x=>x==='apply').length,1);assert.equal((await f.state()).receipt.items[0].source_hash,H);assert.equal((await stat(join(f.directory,`proposal-product-adoption-${f.command}.json`))).mode&511,384);assert.equal(f.review.preview.items[0].changes.at(-1).after,'12.1234567891');
 }finally{await f.close();}
});
test('lost ACK never resends, including absent ledger; matching manual export recovers same UUID',async()=>{
 const f=await fixture();try{f.ports.apply=async()=>{f.calls.push('apply');f.imported();throw new Error('lost');};assert.equal((await executeReviewedAdoption(f.input)).outcome,'uncertain');f.forgetReceipt();f.calls.length=0;
 assert.deepEqual(await executeReviewedAdoption(f.input),{outcome:'uncertain',requires_ledger_export:true,dispatched:false});assert.deepEqual(f.calls,['receipt']);
 f.imported();f.calls.length=0;assert.equal((await executeReviewedAdoption(f.input)).outcome,'verified');assert.deepEqual(f.calls,['receipt','catalog']);assert.equal((await f.state()).command_id,f.command);
 }finally{await f.close();}
});
test('known ACK with failed GET is retained; later execution performs only current read',async()=>{
 const f=await fixture();try{const catalog=f.ports.catalog;let accepted=false;const apply=f.ports.apply;f.ports.apply=async a=>{const r=await apply(a);accepted=true;return r;};f.ports.catalog=(...a)=>accepted?Promise.reject(new Error('GET failed')):catalog(...a);
 const r=await executeReviewedAdoption(f.input);assert.equal(r.outcome,'acknowledged');assert.equal(r.readback_pending,true);assert.equal((await f.state()).state,'acknowledged');
 f.ports.catalog=catalog;f.calls.length=0;assert.equal((await executeReviewedAdoption(f.input)).outcome,'verified');assert.deepEqual(f.calls,['catalog']);
 }finally{await f.close();}
});
test('full mapper preview is bound beyond its SQL fingerprint, including name/unit changes',async()=>{
 const f=await fixture();try{f.ports.catalog=async()=>{const p=f.preview();p.items[0].changes[0].after='Changed mapper output';return p;};await assert.rejects(executeReviewedAdoption(f.input),/FULL_PREVIEW_CHANGED/);assert.equal(f.calls.includes('apply'),false);assert.deepEqual(await readdir(f.directory),[]);}finally{await f.close();}
});
test('fresh capture evidence, complete set, same product/proposal CAS and no native link are required',async()=>{
 const changes=[e=>e.has_more=true,e=>e.exported_at=new Date(T-300001).toISOString(),e=>e.items[0].capture.observed_at=new Date(T+10000).toISOString(),e=>e.items=[],e=>e.items[0].proposal_version='3',e=>{e.items[0].source_version='2';e.items[0].capture.source_version='2';},e=>e.items[0].capture.source='list_fallback'];
 for(const change of changes){const f=await fixture();try{change(f.evidence);await assert.rejects(executeReviewedAdoption(f.input));assert.equal(f.calls.includes('apply'),false);}finally{await f.close();}}
 for(const kind of ['imported','linked']){const f=await fixture();try{if(kind==='imported')f.ports.proposal=async()=>({dry_run:true,persisted:false,source_id:'99',source_hash:PH,source_version:'2',source_status:'Rascunho',existing:{},bindings:[]});else{f.imported();f.forgetReceipt();}await assert.rejects(executeReviewedAdoption(f.input));assert.equal(f.calls.includes('apply'),false);}finally{await f.close();}}
});
test('invalid ACK remains pending and never authorizes a second apply',async()=>{
 for(const change of [r=>r.items[0].source_hash=PH,r=>r.items[0].source_version='2',r=>r.items[0].action='update',r=>r.operational_effects=true]){const f=await fixture();try{f.ports.apply=async()=>{f.calls.push('apply');const r=f.ack();change(r);return r;};assert.equal((await executeReviewedAdoption(f.input)).outcome,'uncertain');assert.equal((await f.state()).state,'pending');assert.equal((await executeReviewedAdoption(f.input)).outcome,'uncertain');assert.equal(f.calls.filter(x=>x==='apply').length,1);}finally{await f.close();}}
});
test('changed current document does not overwrite historical receipt or restart application',async()=>{
 const f=await fixture();try{await executeReviewedAdoption(f.input);const ack=(await f.state()).receipt;f.ports.catalog=async()=>{const p=f.preview();p.items[0].record_version=2;p.items[0].human_edited=true;p.items[0].origin_state='local_modified';return p;};f.calls.length=0;assert.equal((await executeReviewedAdoption(f.input)).outcome,'current_changed');assert.deepEqual((await f.state()).receipt,ack);assert.equal(f.calls.includes('apply'),false);}finally{await f.close();}
});
test('durable lock blocks simultaneous execution, stale locks are never removed automatically',async()=>{
 const f=await fixture();try{const path=join(f.directory,'proposal-product-adoption.lock');await writeFile(path,'synthetic owner',{mode:0o600});await assert.rejects(executeReviewedAdoption(f.input),{code:'EEXIST'});assert.equal(await readFile(path,'utf8'),'synthetic owner');assert.equal(f.calls.length,0);}finally{await f.close();}
});
test('approved review and immutable plan digests cannot be swapped; state symlinks are refused',async()=>{
 const f=await fixture();try{await assert.rejects(executeReviewedAdoption({...f.input,approvedReviewHash:H}),/REVIEW_NOT_APPROVED/);const changed=structuredClone(f.plan);changed.batches[0].command_id=randomUUID();await assert.rejects(executeReviewedAdoption({...f.input,plan:changed}),/PLAN_HASH_MISMATCH/);
 const victim=join(f.directory,'untouched');await writeFile(victim,'unchanged');await symlink(victim,join(f.directory,`proposal-product-adoption-${f.command}.json`));await assert.rejects(executeReviewedAdoption(f.input));assert.equal(await readFile(victim,'utf8'),'unchanged');assert.equal(f.calls.length,0);
 }finally{await f.close();}
});
test('abort during apply leaves durable pending, and late response cannot turn it into ACK',async()=>{
 const f=await fixture();try{const abort=new AbortController();let resolve;f.ports.apply=async()=>{f.calls.push('apply');queueMicrotask(()=>abort.abort());return new Promise(r=>{resolve=r;});};const result=await executeReviewedAdoption({...f.input,signal:abort.signal});assert.equal(result.outcome,'uncertain');assert.equal((await f.state()).state,'pending');resolve(f.ack());await new Promise(r=>setImmediate(r));assert.equal((await f.state()).state,'pending');assert.equal(f.calls.filter(x=>x==='apply').length,1);}finally{await f.close();}
});
test('arguments and ports are captured before awaits; foreign receipt cannot authorize recovery',async()=>{
 const f=await fixture();try{const original=f.ports.receipt;f.ports.receipt=async a=>{const r=await original(a);f.plan.batches[0].items[0].source_hash=PH;f.ports.apply=()=>{throw new Error('late replacement');};return r;};assert.equal((await executeReviewedAdoption(f.input)).outcome,'verified');assert.equal(f.calls.filter(x=>x==='apply').length,1);}finally{await f.close();}
 const f2=await fixture();try{f2.ports.receipt=async a=>({...f2.exported(a),actor:randomUUID()});await assert.rejects(executeReviewedAdoption(f2.input),/LEDGER_EXPORT_INVALID/);assert.equal(f2.calls.includes('apply'),false);}finally{await f2.close();}
});
test('manual receipt export is read-only SQL and verifies actor, request hash and shared namespace',async()=>{
 const f=await fixture();try{const sql=adoptionReceiptExportSql(f.plan,f.planHash);assert.match(sql,/^begin read only;/);assert.match(sql,/import_review_command/);assert.match(sql,/f\.request_hash=e\.h/);assert.match(sql,/erp_catalog\.command/);assert.doesNotMatch(sql,/erp_catalog_import_apply|insert into|update |delete /i);}finally{await f.close();}
});
