/** Administrative read-only proof for one fixed product update batch. No SQL execution. */
import {adoptionDigest} from './execute_proposal_product_adoption.mjs';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
export const requireUpdate=(ok,code)=>{if(!ok)throw new Error(code);};
export function captureUpdate(value,depth=0){
 requireUpdate(depth<40,'INPUT_DEPTH');
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 requireUpdate(value&&typeof value==='object'&&(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),'INPUT_SHAPE');
 const out=Array.isArray(value)?[]:{};for(const key of Reflect.ownKeys(value)){
  if(Array.isArray(value)&&key==='length')continue;
  const d=Object.getOwnPropertyDescriptor(value,key);requireUpdate(typeof key==='string'&&d.enumerable&&'value'in d&&key!=='__proto__','INPUT_DESCRIPTOR');out[key]=captureUpdate(d.value,depth+1);
 }return out;
}
export function checkedUpdatePlan(value,hash){
 const p=captureUpdate(value);requireUpdate(Buffer.byteLength(JSON.stringify(p))<=2*1024*1024&&HASH.test(hash)&&adoptionDigest(p)===hash,'PLAN_HASH_MISMATCH');
 requireUpdate(p.profile==='reviewed-catalog-updates-v1'&&p.read_only===true&&p.apply_enabled===false&&p.requires_root_review===true&&p.entity==='products'&&UUID.test(p.actor)&&UUID.test(p.plan_id)&&UUID.test(p.command_id)&&p.command_id!==p.plan_id&&HASH.test(p.preview_hash),'PLAN_SCOPE');
 requireUpdate(Array.isArray(p.items)&&p.items.length>0&&p.items.length<=50&&p.expected?.length===p.items.length&&new Set(p.items.map(x=>x.source_id)).size===p.items.length&&new Set(p.expected.map(x=>x.record_id)).size===p.items.length,'PLAN_ITEMS');
 for(const [i,e] of p.expected.entries()){
  requireUpdate(/^[1-9][0-9]{0,39}$/.test(e.source_id)&&e.source_id===p.items[i].source_id&&HASH.test(e.source_hash)&&e.source_hash===p.items[i].source_hash&&/^[1-9][0-9]{0,18}$/.test(e.source_version)&&UUID.test(e.record_id)&&Number.isInteger(e.record_version)&&e.record_version>0&&e.record_version<2147483647&&e.expected_record_version===e.record_version+1,'PLAN_BINDING');
  requireUpdate(e.kind==='origin_only'&&e.allowed_changes.length===0||e.kind==='price_change'&&e.allowed_changes.length===1&&e.allowed_changes[0].field==='price'&&e.allowed_changes[0].redacted===false&&typeof e.allowed_changes[0].before==='string'&&typeof e.allowed_changes[0].after==='string','PLAN_DELTA');
  requireUpdate(Array.isArray(e.witnesses)&&e.witnesses.length>0&&e.witnesses.every(w=>/^[1-9][0-9]{0,39}$/.test(w.source_id)&&HASH.test(w.source_hash)&&/^[1-9][0-9]{0,18}$/.test(w.source_version)),'PLAN_WITNESS');
 }
 return p;
}
export const updateArgs=p=>({p_user_id:p.actor,p_entity:'products',p_items:captureUpdate(p.items),p_command_id:p.command_id,p_preview_hash:p.preview_hash});
const q=s=>"'"+s.replaceAll("'","''")+"'";
const digestSql=v=>`encode(sha256(convert_to((${v})::text,'UTF8')),'hex')`;
/** Full before/expected data is private. All unselected ERP rows and historical evidence are hashed. */
export function catalogUpdatePreservationSql(plan,planHash){
 const p=checkedUpdatePlan(plan,planHash),json=q(JSON.stringify(p.expected)),ids=p.expected.map(e=>q(e.record_id)).join(','),sources=p.expected.map(e=>q(e.source_id)).join(',');
 const filters={record:`id not in(${ids})`,product:`record_id not in(${ids})`,origin:`not(entity='products' and source_id in(${sources}))`,source_snapshot:`not(entity='products' and (source_id,source_hash) in(${p.expected.map(e=>`(${q(e.source_id)},${q(e.source_hash)})`).join(',')}))`,command:`command_id<>${q(p.command_id)}::uuid`,import_review_command:`command_id<>${q(p.command_id)}::uuid`,audit:`command_id<>${q(p.command_id)}::uuid`};
 const cases=Object.entries(filters).map(([t,v])=>`when c.relname=${q(t)} then ${q(v)}`).join('\n');
 return `-- Private fixed-plan proof only. No apply, locks, credentials or source payload export.
begin transaction isolation level repeatable read read only;
set local statement_timeout='30s';
set local lock_timeout='5s';
with expected as materialized(select value e from jsonb_array_elements(${json}::jsonb)),
selected as materialized(
 select e,r.id,r.version,r.active,r.human_edited,r.updated_by,r.updated_at,
  ${digestSql("to_jsonb(r)-array['version','updated_by','updated_at','name','code','active']")} stable_record_hash,
  erp_catalog.data(r.id) before_data,erp_catalog.data(r.id)||erp_catalog.map_origin('products',s.payload) expected_data,
  ${digestSql('erp_catalog.dto(r.id)')} dto_hash,
  o.applied_hash,o.latest_hash,o.state origin_state,o.candidate is not null candidate_retained,
  s.version_hash source_hash,s.version::text source_version,s.last_seen_at source_seen_at,
  s.payload->>'situacao' in('A','S') expected_active,s.payload->>'tipo'='P' and s.payload->>'formato'='S' source_simple_product,
  s.price_capture-'tokens' capture,jsonb_typeof(s.payload->'preco')='number' and exists(select 1 from jsonb_array_elements(coalesce(s.price_capture->'tokens','[]')) t where t->>'path'='/preco') numeric_price,
  exists(select 1 from erp_stock.entry x where x.product_id=r.id) stock_locked,
  (select count(distinct i.document_id) from erp_documents.item i where i.product_id=r.id) native_document_usage,
  ${digestSql("jsonb_build_object('entity','products','source_id',s.source_id,'source_hash',s.version_hash,'source_version',s.version,'payload',s.payload,'document_links',s.document_links)")} expected_snapshot_hash,
  case when sn.source_id is null then null else ${digestSql('to_jsonb(sn)')} end target_snapshot_hash,
  case when sn.source_id is null then null else ${digestSql("to_jsonb(sn)-'captured_at'")} end target_snapshot_semantic_hash
 from expected x join erp_catalog.record r on r.id=(e->>'record_id')::uuid
 join erp_catalog.origin o on o.record_id=r.id and o.entity='products' and o.source_id=e->>'source_id'
 join origin_sync.raw_record s on s.entity='products' and s.source_id=e->>'source_id'
 left join erp_catalog.source_snapshot sn on sn.entity='products' and sn.source_id=e->>'source_id' and sn.source_hash=e->>'source_hash'
), witnesses as(
 select jsonb_build_object('product_id',e->>'source_id','proposal_id',w->>'source_id','source_hash',s.version_hash,'source_version',s.version::text,
 'open_status',coalesce(s.payload->>'situacao' in('Rascunho','Pendente','Aguardando'),false),'already_imported',o.document_id is not null,
 'exact_product_reference',exists(select 1 from jsonb_array_elements(case when jsonb_typeof(s.payload->'itens')='array' then s.payload->'itens' else '[]' end) i where erp_documents.origin_import_id(i->'produto'->'id')=e->>'source_id')) value
 from expected cross join lateral jsonb_array_elements(e->'witnesses') w
 left join origin_sync.raw_record s on s.entity='sales_proposals' and s.source_id=w->>'source_id'
 left join erp_documents.origin_import_origin o on o.entity='sales_proposals' and o.source_id=w->>'source_id'
), relations as materialized(
 select n.nspname,c.relname,${digestSql("jsonb_build_object('acl',c.relacl,'owner',c.relowner,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'policies',(select jsonb_agg(to_jsonb(po) order by polname) from pg_policy po where po.polrelid=c.oid))")} access_hash,case when n.nspname='erp_catalog' then case ${cases} else 'true' end else 'true' end predicate
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in('r','p') and n.nspname like 'erp\\_%' escape '\\'
), relation_xml as materialized(
 select nspname,relname,access_hash,query_to_xml(format($proof$select count(*)::text n,encode(sha256(convert_to(coalesce(string_agg(h,\'\' order by h),\'\'),\'UTF8\')),\'hex\') h from (select encode(sha256(convert_to(to_jsonb(t)::text,\'UTF8\')),\'hex\') h from %I.%I t where %s) rows$proof$,nspname,relname,predicate),false,false,'') x from relations
), functions as(
 select p.oid::regprocedure::text signature,${digestSql('pg_get_functiondef(p.oid)')} definition_hash,
 ${digestSql("jsonb_build_object('acl',p.proacl,'owner',p.proowner,'definer',p.prosecdef,'config',p.proconfig)")} access_hash
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='erp_catalog' or n.nspname='public' and p.proname like 'erp_catalog_%'
)
select jsonb_build_object('profile','catalog-update-preservation-v1','read_only',true,'exported_at',clock_timestamp(),'plan_hash',${q(planHash)},'actor',${q(p.actor)},'command_id',${q(p.command_id)},
 'catalog_count',(select count(*) from erp_catalog.record),
 'native_proposals',jsonb_build_object('count',(select count(*) from erp_documents.document where kind='sales_proposals'),'draft_version_1',(select count(*) from erp_documents.document where kind='sales_proposals' and status='draft' and version=1)),
 'selected',(select jsonb_agg((to_jsonb(s)-'e')||jsonb_build_object('source_id',e->>'source_id','data_hash',${digestSql('before_data')},'expected_data_hash',${digestSql('expected_data')},'changed_fields',(select coalesce(jsonb_agg(k order by k),'[]') from(select jsonb_object_keys(before_data) k union select jsonb_object_keys(expected_data)) keys where before_data->k is distinct from expected_data->k)) order by e->>'source_id' collate "C") from selected s),
 'witnesses',(select jsonb_agg(value order by value->>'product_id' collate "C",value->>'proposal_id' collate "C") from witnesses),
 'preserved_relations',(select jsonb_agg(jsonb_build_object('schema',nspname,'table',relname,'access_hash',access_hash,'count',((xpath('/table/row/n/text()',x))[1]::text)::bigint,'hash',(xpath('/table/row/h/text()',x))[1]::text) order by nspname,relname) from relation_xml),
 'functions',(select jsonb_agg(to_jsonb(f) order by signature) from functions f),
 'command_rows',jsonb_build_object('inner',(select count(*) from erp_catalog.command where command_id=${q(p.command_id)}::uuid),'review',(select count(*) from erp_catalog.import_review_command where command_id=${q(p.command_id)}::uuid)),
 'audit',(select coalesce(jsonb_agg(jsonb_build_object('actor',actor,'record_id',record_id,'entity',entity,'action',action,'before_hash',${digestSql('before_data')},'after_hash',${digestSql('after_data')}) order by record_id),'[]') from erp_catalog.audit where command_id=${q(p.command_id)}::uuid)) preservation;
commit;
`;
}
