--039 financial adoption keeps its contract, data and receipt shape. No import is performed here.
--Only the existing apply RPC is replaced. CREATE OR REPLACE preserves its owner and ACL.
begin;
do $$begin
 if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex')from pg_proc
     where oid=to_regprocedure('public.erp_origin_financial_import_apply(uuid,text,jsonb,boolean,uuid,text,boolean)'))
   is distinct from 'ff6f113a861d56e65fdfbec4a2aa957452c7a5dc21587cef06899868036247a5'
 then raise exception 'financial_import_088_previous_definition_changed' using errcode='55000';end if;
end$$;

create or replace function public.erp_origin_financial_import_apply(p_user_id uuid,p_entity text,p_items jsonb,p_duplicate_reviewed boolean,
 p_command_id uuid,p_preview_hash text,p_confirm_import boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;command erp_finance.command%rowtype;plan jsonb;row jsonb;p jsonb;receipt jsonb;result jsonb;items jsonb:='[]';evidences jsonb:='[]';item jsonb;
 contact_ids uuid[];contact_sources text[];title uuid;created timestamptz;source_id text;attempt_id uuid;contact_source origin_sync.raw_record%rowtype;
begin
 perform erp_cutover.require_admin(p_user_id);perform erp_finance.origin_import_validate(p_entity,p_items,p_duplicate_reviewed);
 if p_command_id is null or p_preview_hash is null or p_preview_hash!~'^[0-9a-f]{64}$' or p_confirm_import is distinct from true
  then raise exception 'erp_origin_import_confirmation_required' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','origin_import_batch','entity',p_entity,'items',p_items,
  'duplicate_reviewed',p_duplicate_reviewed,'preview_hash',p_preview_hash,'confirm_import',p_confirm_import)::text,'UTF8')),'hex');
 -- Shared with 010: one global finance command identity, not one command per title.
 perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
 perform erp_cutover.require_admin(p_user_id);
 select * into command from erp_finance.command where id=p_command_id;
 if found then
  -- Acquire the Auth FK parent before membership, never the inverse. Both
  -- locks remain until transaction end, including waits in command/audit FKs.
  perform id from auth.users where id=p_user_id for key share;
  if not found then raise exception 'erp_cutover_access_denied' using errcode='42501';end if;
  perform erp_cutover.require_admin(p_user_id);
  perform user_id from erp_access.membership where user_id=p_user_id for share;
  perform erp_cutover.require_admin(p_user_id);
  if command.actor<>p_user_id or command.request_hash<>h or command.result->>'action' is distinct from 'origin_import_batch'
   then raise exception 'erp_finance_command_conflict' using errcode='40001';end if;
  return (command.result-'action')||jsonb_build_object('replayed',true);
 end if;
 perform pg_advisory_xact_lock(174852939,hashtext(p_entity));
 perform erp_cutover.require_admin(p_user_id);
 -- Capture parents first, matching catalog013's parent -> source ordering. A later
 -- changed mapping is a conflict, never an out-of-order late parent lock.
 select array_agg(distinct o.record_id),array_agg(distinct erp_cutover.exact_id(r.payload#>'{contato,id}')) into contact_ids,contact_sources
 from origin_sync.raw_record r join jsonb_array_elements(p_items)i on i->>'source_id'=r.source_id
 left join erp_catalog.origin o on o.entity='contacts' and o.source_id=erp_cutover.exact_id(r.payload#>'{contato,id}') where r.entity=p_entity;
 perform id from erp_catalog.record where id=any(contact_ids) order by id for share;
 perform erp_cutover.require_admin(p_user_id);
 perform record_id from erp_catalog.contact where record_id=any(contact_ids) order by record_id for share;
 perform erp_cutover.require_admin(p_user_id);
 perform id from erp_finance.category where id in(select (i->>'category_id')::uuid from jsonb_array_elements(p_items)i where i->'category_id'<>'null'::jsonb) order by id for share;
 perform erp_cutover.require_admin(p_user_id);
 perform r.source_id from origin_sync.raw_record r
  where (r.entity=p_entity and r.source_id in(select i->>'source_id' from jsonb_array_elements(p_items)i))
   or(r.entity='contacts' and r.source_id=any(contact_sources))
  order by r.entity collate "C",r.source_id collate "C" for share;
 perform erp_cutover.require_admin(p_user_id);
 if exists(select 1 from origin_sync.raw_record r join jsonb_array_elements(p_items)i on i->>'source_id'=r.source_id
   left join erp_catalog.origin o on o.entity='contacts' and o.source_id=erp_cutover.exact_id(r.payload#>'{contato,id}')
   where r.entity=p_entity and (o.record_id is not null and not coalesce(o.record_id=any(contact_ids),false)
    or erp_cutover.exact_id(r.payload#>'{contato,id}') is not null and not coalesce(erp_cutover.exact_id(r.payload#>'{contato,id}')=any(contact_sources),false)))
  then raise exception 'erp_origin_import_contact_changed' using errcode='40001';end if;
 perform o.source_id from origin_finance_refresh.origin o where o.entity=p_entity and o.source_id in(select i->>'source_id' from jsonb_array_elements(p_items)i)
  order by o.source_id collate "C" for share;
 perform erp_cutover.require_admin(p_user_id);
 -- No attempt lock: finalized attempts are immutable. 030 finish takes attempt
 -- before raw, so taking an attempt lock here would introduce an inverse order.
  -- Acquire the Auth FK parent before membership, never the inverse. Both
  -- locks remain until transaction end, including waits in command/audit FKs.
  perform id from auth.users where id=p_user_id for key share;
  if not found then raise exception 'erp_cutover_access_denied' using errcode='42501';end if;
  perform erp_cutover.require_admin(p_user_id);
  perform user_id from erp_access.membership where user_id=p_user_id for share;
  perform erp_cutover.require_admin(p_user_id);
 plan:=erp_finance.origin_import_plan(p_user_id,p_entity,p_items,p_duplicate_reviewed);
 if plan->>'preview_hash'<>p_preview_hash or plan->'can_apply'<>'true'::jsonb then raise exception 'erp_origin_import_preview_conflict' using errcode='40001';end if;
 created:=clock_timestamp();
 for row in select value from jsonb_array_elements(plan->'items') loop
  p:=row->'proposed';source_id:=row->>'source_id';
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents)
   values(gen_random_uuid(),1,1,p->>'kind',(p->>'contact_id')::uuid,(p->>'category_id')::uuid,p->>'description',p->>'source_reference',
    (p->>'issued_on')::date,(p->>'due_on')::date,(p->>'amount_cents')::bigint) returning id into title;
  item:=jsonb_build_object('source_id',source_id,'title_id',title,'source_hash',row->>'source_hash','source_version',row->>'source_version','source_seen_at',row->>'source_seen_at',
   'refresh_finished_at',row#>>'{evidence,refresh_finished_at}','contact_id',p->'contact_id','contact_version',p->'contact_version',
   'category_id',p->'category_id','category_version',p->'category_version','kind',p->>'kind','description',p->>'description',
   'source_reference',p->>'source_reference','issued_on',p->>'issued_on','due_on',p->>'due_on','amount_cents',p->>'amount_cents');
  items:=items||jsonb_build_array(item);
  select current_attempt into attempt_id from origin_finance_refresh.origin o where o.entity=p_entity and o.source_id=row->>'source_id';
  select * into contact_source from origin_sync.raw_record where entity='contacts' and origin_sync.raw_record.source_id=row#>>'{evidence,contact_source_id}';
  evidences:=evidences||jsonb_build_array(item||(row->'evidence')||jsonb_build_object('refresh_attempt_id',attempt_id,
   'contact_name',p->>'contact_name','category_name',p->>'category_name','contact_source_hash',contact_source.version_hash,
   'contact_source_version',contact_source.version::text,'policy','origin-open-unique-v1','duplicate_reviewed',true));
 end loop;
 receipt:=jsonb_build_object('id',p_command_id,'entity',p_entity,'created_at',created,'preview_hash',p_preview_hash,'duplicate_reviewed',true,
  'items',items,'total_cents',plan#>>'{summary,total_cents}');
 result:=jsonb_build_object('data_mode','financial_import_review','policy','origin-open-unique-v1','cutoff_at',null,'coverage_certified',false,
  'creates_titles',true,'settles_titles',false,'changes_cash_balance',false,'bank_actions',false,'dry_run',false,'persisted',true,'replayed',false,'batch',receipt);
 insert into erp_finance.command(id,actor,request_hash,result)values(p_command_id,p_user_id,h,result||jsonb_build_object('action','origin_import_batch'));
 for item in select value from jsonb_array_elements(evidences) loop
  insert into erp_finance.origin_import_origin(entity,source_id,title_id,command_id,evidence,created_at)
   values(p_entity,item->>'source_id',(item->>'title_id')::uuid,p_command_id,item,created);
 end loop;
 insert into erp_finance.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'origin_import_batch',null,result);
 if (plan->>'valid_until')::timestamptz<=clock_timestamp() then raise exception 'erp_origin_import_preview_expired' using errcode='40001';end if;
 return result;
end $$;

commit;
