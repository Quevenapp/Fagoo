/** Read-only administrative before/after proof for an already reviewed 055 plan. No SQL execution. */
import {proposalBatchDigest as digest} from './proposal_batch_port.mjs';
import {captureUpdate as capture} from './catalog_update_preservation.mjs';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const need=(v,c)=>{if(!v)throw Error(c);},q=s=>"'"+s.replaceAll("'","''")+"'",h=v=>`encode(sha256(convert_to((${v})::text,'UTF8')),'hex')`;
function checked(plan,hash){const p=capture(plan);need(HASH.test(hash)&&digest(p)===hash&&p.profile==='reviewed-proposals-055-v1'&&UUID.test(p.actor)&&UUID.test(p.plan_id)&&p.duplicate_reviewed===true&&p.coverage_certified===false,'PLAN_INVALID');need(Array.isArray(p.items)&&p.items.length>=1&&p.items.length<=50&&new Set(p.items.map(x=>x.source_id)).size===p.items.length&&new Set([p.plan_id,...p.items.map(x=>x.command_id)]).size===p.items.length+1,'PLAN_ITEMS_INVALID');for(const i of p.items)need(/^[1-9][0-9]{0,39}$/.test(i.source_id)&&UUID.test(i.command_id)&&i.preview?.source_id===i.source_id&&HASH.test(i.preview.source_hash)&&HASH.test(i.preview.preview_hash)&&i.preview.can_apply===true&&i.preview.existing===null&&i.preview.policy==='origin-open-proposal-v2','PLAN_ITEM_INVALID');return p;}
export function proposalBatchPreservationSql(plan,planHash){
 const p=checked(plan,planHash),commands=p.items.map(i=>q(i.command_id)+'::uuid').join(','),pairs=p.items.map(i=>`(${q(i.source_id)},${q(i.command_id)}::uuid)`).join(','),origin=`o.entity='sales_proposals' and (o.source_id,o.command_id) in(${pairs})`,docSub=`select o.document_id from erp_documents.origin_import_origin o where ${origin}`;
 const expected=p.items.map(i=>({source_id:i.source_id,command_id:i.command_id,source_hash:i.preview.source_hash,source_version:i.preview.source_version,preview_hash:i.preview.preview_hash,body:i.preview.proposed,source_evidence:i.preview.source_evidence,transformations:i.preview.transformations}));
 const filters={numbering:"kind<>'sales_proposals'",document:`id not in(${docSub})`,item:`document_id not in(${docSub})`,command:`command_id not in(${commands})`,audit:`command_id not in(${commands})`,origin_import_origin:`not(entity='sales_proposals' and (source_id,command_id) in(${pairs}))`};
 const cases=Object.entries(filters).map(([name,predicate])=>`when c.relname=${q(name)} then ${q(predicate)}`).join('\n');
 return `-- Private plan-bound 055 preservation. READ ONLY; no import, counter update or locks.
begin transaction isolation level repeatable read read only;
set local statement_timeout='30s';
set local lock_timeout='5s';
with expected as materialized(select value e from jsonb_array_elements(${q(JSON.stringify(expected))}::jsonb)),
selected as materialized(
 select e,o.document_id,o.command_id,o.entity,o.source_id,d.version,d.status,d.kind,d.created_by,d.updated_by,d.number::text number,
 (o.evidence->>'policy'='origin-open-proposal-v2') policy_matches,
 o.evidence#>>'{receipt,source_hash}' receipt_source_hash,o.evidence#>>'{receipt,source_version}' receipt_source_version,o.evidence#>>'{receipt,preview_hash}' receipt_preview_hash,
 o.evidence->'normalized_body'=e->'body' normalized_body_matches,o.evidence->'source_evidence'=e->'source_evidence' source_evidence_matches,o.evidence->'transformations'=e->'transformations' transformations_match,
 c.actor command_actor,c.result->'receipt'=o.evidence->'receipt' command_receipt_matches,
 ${h("jsonb_build_object('op','origin_import_proposal_v2','actor',"+q(p.actor)+"::uuid,'source_id',e->>'source_id','preview_hash',e->>'preview_hash','confirm_import',true,'duplicate_reviewed',true)")}=c.request_hash command_request_matches,
 ${h('erp_documents.dto(d.id)')} document_hash,${h('o.evidence')} evidence_hash,
 erp_documents.effect_flags(d.id) effect_flags,
 (select count(*) from erp_documents.item i where i.document_id=d.id) item_count,
 (select count(*) from jsonb_array_elements(d.body->'installments')) installment_count,
 (select count(*) from erp_documents.audit a where a.command_id=(e->>'command_id')::uuid) audit_count,
 (select bool_and(a.actor=${q(p.actor)}::uuid and a.document_id=d.id and a.action='origin_import_proposal_v2' and a.before_data is null and a.after_data=erp_documents.dto(d.id)) from erp_documents.audit a where a.command_id=(e->>'command_id')::uuid) audit_matches
 from expected x left join erp_documents.origin_import_origin o on o.entity='sales_proposals' and o.source_id=e->>'source_id' and o.command_id=(e->>'command_id')::uuid
 left join erp_documents.document d on d.id=o.document_id left join erp_documents.command c on c.command_id=(e->>'command_id')::uuid
), relations as materialized(
 select n.nspname,c.relname,${h("jsonb_build_object('acl',c.relacl,'owner',c.relowner,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'policies',(select jsonb_agg(to_jsonb(po) order by polname) from pg_policy po where po.polrelid=c.oid))")} access_hash,
 case when n.nspname='erp_documents' then case ${cases} else 'true' end else 'true' end predicate
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in('r','p') and(n.nspname like 'erp\\_%' escape '\\' or n.nspname='auth' and c.relname='users' or n.nspname='storage' and c.relname in('buckets','objects'))
), relation_xml as materialized(
 select nspname,relname,access_hash,query_to_xml(format($proof$select count(*)::text n,encode(sha256(convert_to(coalesce(string_agg(h,'' order by h),''),'UTF8')),'hex') h from(select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h from %I.%I t where %s)rows$proof$,nspname,relname,predicate),false,false,'') x from relations
), functions as(
 select p.oid::regprocedure::text signature,${h('pg_get_functiondef(p.oid)')} definition_hash,${h("jsonb_build_object('acl',p.proacl,'owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig)")} access_hash
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prokind='f' and(n.nspname like 'erp\\_%' escape '\\' or n.nspname='public' and p.proname like 'erp\\_%' escape '\\')
), sequences as(
 select s.schemaname,s.sequencename,s.sequenceowner,s.data_type,s.start_value,s.min_value,s.max_value,s.increment_by,s.cycle,s.cache_size,
 case when s.schemaname='erp_documents' and s.sequencename='audit_id_seq' then null else s.last_value::text end last_value,
 ${h("jsonb_build_object('acl',c.relacl,'owner',c.relowner)")} access_hash
 from pg_sequences s join pg_namespace n on n.nspname=s.schemaname join pg_class c on c.relnamespace=n.oid and c.relname=s.sequencename
 where s.schemaname like 'erp\\_%' escape '\\'
), schemas as(
 select n.nspname,${h("jsonb_build_object('owner',n.nspowner,'acl',n.nspacl,'defaults',(select jsonb_agg(to_jsonb(d) order by d.oid) from pg_default_acl d where d.defaclnamespace=n.oid))")} access_hash from pg_namespace n where n.nspname like 'erp\\_%' escape '\\'
)
select jsonb_build_object('profile','proposal-batch-preservation-v1','read_only',true,'exported_at',clock_timestamp(),'plan_hash',${q(planHash)},'actor',${q(p.actor)},
 'subset068_present',to_regclass('erp_fiscal_subset_review.review') is not null,
 'catalog_count',(select count(*) from erp_catalog.record),'proposal_count',(select count(*) from erp_documents.document where kind='sales_proposals'),
 'numbering',(select last_number::text from erp_documents.numbering where kind='sales_proposals'),
 'audit_sequence',(select last_value::text from pg_sequences where schemaname='erp_documents' and sequencename='audit_id_seq'),
 'selected',(select jsonb_agg((to_jsonb(s)-'e')||jsonb_build_object('expected_source_id',e->>'source_id','expected_command_id',e->>'command_id') order by e->>'source_id' collate "C") from selected s),
 'command_count',(select count(*) from erp_documents.command where command_id in(${commands})),
 'origin_count',(select count(*) from erp_documents.origin_import_origin o where ${origin}),
 'audit_count',(select count(*) from erp_documents.audit where command_id in(${commands})),
 'source_cas',(select jsonb_agg(jsonb_build_object('source_id',e->>'source_id','hash',r.version_hash,'version',r.version::text,'expected_hash',e->>'source_hash','expected_version',e->>'source_version') order by e->>'source_id' collate "C") from expected left join origin_sync.raw_record r on r.entity='sales_proposals' and r.source_id=e->>'source_id'),
 'preserved_relations',(select jsonb_agg(jsonb_build_object('schema',nspname,'table',relname,'access_hash',access_hash,'count',((xpath('/table/row/n/text()',x))[1]::text)::bigint,'hash',(xpath('/table/row/h/text()',x))[1]::text) order by nspname,relname) from relation_xml),
 'functions',(select jsonb_agg(to_jsonb(f) order by signature) from functions f),'sequences',(select jsonb_agg(to_jsonb(s) order by schemaname,sequencename) from sequences s),'schemas',(select jsonb_agg(to_jsonb(s) order by nspname) from schemas s)) preservation;
commit;
`;
}
/** Compare a fresh before proof with a completed after proof. Partial execution never passes. */
export function verifyProposalBatchPreservation({plan,planHash,before,after,requireSubset068=true}){
 const p=checked(plan,planHash),b=capture(before),a=capture(after);need(typeof requireSubset068==='boolean','PROOF_OPTIONS');
 for(const x of [b,a])need(x?.profile==='proposal-batch-preservation-v1'&&x.read_only===true&&x.plan_hash===planHash&&x.actor===p.actor&&(!requireSubset068||x.subset068_present===true)&&Array.isArray(x.selected)&&x.selected.length===p.items.length,'PROOF_BINDING');
 need(b.command_count===0&&b.origin_count===0&&b.audit_count===0&&b.selected.every(x=>x.document_id===null),'BEFORE_ALREADY_APPLIED');
 need(b.catalog_count===a.catalog_count&&b.proposal_count===p.native_baseline.length&&a.proposal_count===b.proposal_count+p.items.length,'COUNTS_CHANGED');
 for(const k of ['preserved_relations','functions','sequences','schemas'])need(Array.isArray(b[k])&&b[k].length>0&&digest(b[k])===digest(a[k]),'COLLATERAL_'+k.toUpperCase());
 need(BigInt(a.numbering)===BigInt(b.numbering)+BigInt(p.items.length),'NUMBERING_CHANGED');need(BigInt(a.audit_sequence??'0')===BigInt(b.audit_sequence??'0')+BigInt(p.items.length),'AUDIT_SEQUENCE_CHANGED');
 need(a.command_count===p.items.length&&a.origin_count===p.items.length&&a.audit_count===p.items.length,'COMMAND_COUNTS');
 need(new Set(a.selected.map(x=>x.document_id)).size===p.items.length,'DOCUMENT_DUPLICATE');
 for(const item of p.items){const r=a.selected.find(x=>x.expected_source_id===item.source_id),d=item.preview.proposed;need(r&&r.expected_command_id===item.command_id&&r.command_id===item.command_id&&r.source_id===item.source_id&&UUID.test(r.document_id)&&!p.native_baseline.some(x=>x.id===r.document_id),'SELECTED_BINDING');
  need(r.kind==='sales_proposals'&&r.status==='draft'&&r.version===1&&r.created_by===p.actor&&r.updated_by===p.actor&&r.command_actor===p.actor&&r.policy_matches===true&&r.receipt_source_hash===item.preview.source_hash&&r.receipt_source_version===item.preview.source_version&&r.receipt_preview_hash===item.preview.preview_hash,'SELECTED_METADATA');
  need(['normalized_body_matches','source_evidence_matches','transformations_match','command_receipt_matches','command_request_matches','audit_matches'].every(k=>r[k]===true)&&r.audit_count===1&&r.item_count===d.items.length&&r.installment_count===d.installments.length&&r.effect_flags?.finance_active===false&&r.effect_flags?.stock_active===false,'SELECTED_CONTENT');
 }
 for(const x of [b,a])need(Array.isArray(x.source_cas)&&x.source_cas.length===p.items.length&&p.items.every(i=>{const r=x.source_cas.find(r=>r.source_id===i.source_id);return r&&r.hash===i.preview.source_hash&&r.version===i.preview.source_version&&r.expected_hash===i.preview.source_hash&&r.expected_version===i.preview.source_version;}),'SOURCE_CHANGED');
 return{outcome:'verified',before_proposals:b.proposal_count,after_proposals:a.proposal_count,catalog_preserved:a.catalog_count,created:p.items.length,relations:a.preserved_relations.length,functions:a.functions.length,operational_effects:false};
}
/** The existing executor's success discriminator is complete, never verified. */
export function finalizeProposalBatchPreservation({outcome,plan,planHash,before,after=null}){
 const p=checked(plan,planHash),r=capture(outcome);
 if(r.outcome!=='complete'){need(['prepared','current_changed','baseline_changed','source_changed','acknowledged','unresolved'].includes(r.outcome),'EXECUTOR_OUTCOME_INVALID');return{outcome:r.outcome,preservation:null};}
 need(r.draft_version_1_verified===true&&r.total===p.items.length&&r.verified===p.items.length&&r.pending===0&&r.inventory?.missing===0&&r.inventory?.changed===0&&r.inventory?.unexpected===0&&r.stock_effects===false&&r.financial_effects===false&&r.fiscal_effects===false,'EXECUTOR_COMPLETION_INVALID');
 if(after===null)return{outcome:'preservation_pending',preservation:null};
 return{outcome:'verified',preservation:verifyProposalBatchPreservation({plan:p,planHash,before,after})};
}
