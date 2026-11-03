// Synthetic fixtures only. The caller owns an isolated PostgreSQL test cluster.
import { randomUUID } from 'node:crypto';

export const quote = value => value === null ? 'null' : typeof value === 'number' ? String(value)
  : "'" + (typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''") + "'";
export const bootstrap = `create role anon;create role authenticated;create role service_role bypassrls;
create schema auth;create table auth.users(id uuid primary key);create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;`;

export async function createFinancialImportFixture({ run, result, ok, rpc }) {
  const admin = randomUUID(), other = randomUUID(); let serial = 9390000000;
  ok(await run(`insert into auth.users values('${admin}'),('${other}');
    insert into erp_access.membership(user_id,role)values('${admin}','admin'),('${other}','admin');
    insert into origin_sync.resource_state(resource)values('financial_pg039_fixture');`));
  const today = result(await run("select jsonb_build_object('day',(clock_timestamp()at time zone'America/Sao_Paulo')::date::text);")).day;
  const rawSql = (entity,id,payload) => `insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,last_seen_at)
    values(${quote(entity)},'financial_pg039_fixture',${quote(id)},${quote(payload)}::jsonb,
    encode(sha256(convert_to(jsonb_build_object('payload',${quote(payload)}::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'),clock_timestamp()-interval'1 minute')`;
  async function source({ entity = 'receivables', category = false, description = 'Synthetic concurrent obligation' } = {}) {
    const id = String(++serial), contactSource = String(++serial), contact = randomUUID(), alternate = randomUUID(), categoryId = category ? randomUUID() : null;
    const payload = {id, situacao:1, valor:25.7, saldo:25.7, historico:description, dataEmissao:today, vencimento:today, contato:{id:contactSource}, ocorrencia:{tipo:1}};
    ok(await run(`${rawSql('contacts',contactSource,{id:contactSource,nome:'Synthetic contact'})};
      insert into erp_catalog.record(id,entity,name,human_edited)values('${contact}','contacts','Synthetic contact',false),('${alternate}','contacts','Alternate synthetic contact',false);
      insert into erp_catalog.contact(record_id)values('${contact}'),('${alternate}');
      insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)
      select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='contacts'and source_id='${contactSource}';
      insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)
      select entity,source_id,'${contact}',version_hash,version_hash,'synced'from origin_sync.raw_record where entity='contacts'and source_id='${contactSource}';
      ${category ? `insert into erp_finance.category(id,name,kind)values('${categoryId}','Synthetic category','both');` : ''}
      ${rawSql(entity,id,payload)};insert into origin_finance_refresh.origin(entity,source_id)values('${entity}','${id}');`));
    const item = result(await run(`select jsonb_build_object('source_id',source_id,'source_hash',version_hash,'source_version',version::text,
      'source_seen_at',last_seen_at,'category_id',${quote(categoryId)}::uuid,'category_version',${category ? '1' : 'null'})from origin_sync.raw_record where entity='${entity}'and source_id='${id}';`));
    const attempt = randomUUID();
    ok(await run(`insert into origin_finance_refresh.attempt(id,entity,source_id,owner,fence,source_hash,source_seen_at,source_status,state,started_at,finished_at,response_hash,response_status,result_hash,result_version)
      values('${attempt}','${entity}','${id}','${randomUUID()}','${randomUUID()}',${quote(item.source_hash)},${quote(item.source_seen_at)},'1','stored',
      ${quote(item.source_seen_at)}::timestamptz-interval'2 seconds',${quote(item.source_seen_at)}::timestamptz-interval'1 second',${quote(item.source_hash)},'1',${quote(item.source_hash)},1);
      update origin_finance_refresh.origin set current_attempt='${attempt}',last_attempt_at=${quote(item.source_seen_at)}::timestamptz-interval'2 seconds',
      last_success_at=${quote(item.source_seen_at)}::timestamptz-interval'1 second'where entity='${entity}'and source_id='${id}';`));
    return {id,entity,item,contactSource,contact,alternate,categoryId,attempt};
  }
  async function prepare(sources, actor = admin) {
    const entity=sources[0].entity, items=sources.map(s=>s.item);
    const preview=await rpc('erp_origin_financial_import_preview',{p_user_id:actor,p_entity:entity,p_items:items,p_duplicate_reviewed:true});
    if(!preview.can_apply)throw Error('SYNTHETIC_PREVIEW_NOT_ELIGIBLE:'+JSON.stringify(preview.items.map(i=>i.blockers)));
    return {p_user_id:actor,p_entity:entity,p_items:items,p_duplicate_reviewed:true,p_command_id:randomUUID(),p_preview_hash:preview.preview_hash,p_confirm_import:true};
  }
  const restoreActor=async()=>ok(await run(`update erp_access.membership set active=true,role='admin'where user_id='${admin}';`));
  return {admin,other,today,source,prepare,restoreActor};
}
