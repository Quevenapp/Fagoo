-- Administrative observations only. No bank identity, binding, numbering or financial effects.
-- Depends on038/039; independent of082/083. No redefinitions or new tables.
begin;
create function erp_cutover.itau_legacy_reference(v jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('state',case when v is null then 'absent' when v='null'::jsonb then 'null'
  when jsonb_typeof(v)<>'string' or (v#>>'{}')~'[[:cntrl:]]' or (v#>>'{}')~U&'[\007F-\009F]' then 'invalid'
  when length(v#>>'{}')>200 then 'too_long' when v#>>'{}'='' then 'empty' else 'complete' end,
  'value',case when jsonb_typeof(v)='string' and length(v#>>'{}')<=200 and (v#>>'{}')!~'[[:cntrl:]]'
    and (v#>>'{}')!~U&'[\007F-\009F]' then v#>>'{}' end)
$$;
create function erp_cutover.itau_legacy_row(r origin_sync.raw_record) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare f jsonb:=erp_cutover.financial_row(r,true);b jsonb:=erp_cutover.itau_legacy_reference(r.payload->'numeroBanco');
 d jsonb:=erp_cutover.itau_legacy_reference(r.payload->'numeroDocumento');o erp_finance.origin_import_origin;t erp_finance.title;native jsonb:=null;
begin
 select * into o from erp_finance.origin_import_origin where entity='receivables' and source_id=r.source_id;
 if found then
  select * into t from erp_finance.title where id=o.title_id;
  native:=jsonb_build_object('title_id',o.title_id,'title_version',t.version::text,'origin_command_id',o.command_id,
   'source_hash',o.evidence->>'source_hash','source_version',o.evidence->>'source_version',
   'source_matches_current',o.evidence->>'source_hash'=r.version_hash and o.evidence->>'source_version'=r.version::text,
   'current_status',case when t.cancelled then 'cancelled' when t.settled_cents=0 then 'open' when t.settled_cents=t.amount_cents then 'paid' else 'partial' end);
 end if;
 return jsonb_build_object('source',jsonb_build_object('id',r.source_id,'hash',r.version_hash,'version',r.version::text,'seen_at',r.last_seen_at,
  'status_code',f#>'{status,code}','status_scope',f#>'{status,scope}',
  'identity_matches',erp_cutover.exact_id(r.payload->'id') is not distinct from r.source_id,
  'comparison_supported',r.source_id~'^[0-9]{1,40}$' and r.source_id~'[1-9]' and erp_cutover.exact_id(r.payload->'id') is not distinct from r.source_id,
  'issued_on',f->'issued_on','due_on',f->'due_on',
  'amount',jsonb_build_object('state',f#>'{amount,state}','cents',f#>'{amount,cents}'),
  'balance',jsonb_build_object('state',f#>'{balance,state}','cents',f#>'{balance,cents}')),
 'references',jsonb_build_object('bank_number',b,'document_number',d,
  'bank_reference_format',case when b->>'state'<>'complete' then 'unavailable' when b->>'value'~'^109/[0-9]{8}-[0-9]$' then 'itau109_display' else 'other' end,
  'control',null,'account_scope',null),
 'contact_match',jsonb_build_object('scope','catalog_only','state',f#>'{contact,match}','record_id',f#>'{contact,record_id}',
  'record_version',f#>'{contact,record_version}','pending_review',f#>'{contact,pending_review}','human_edited',f#>'{contact,human_edited}'),
 'refresh',jsonb_build_object('state',f#>'{refresh,state}','last_finished_at',f#>'{refresh,last_finished_at}',
  'current_source_matches_result',f#>'{refresh,current_source_matches_result}'),
 'native_origin',native);
end $$;
create function public.erp_itau_legacy_readiness(p_user_id uuid,p_status text default 'open_partial',p_bank_reference text default 'all',
 p_limit integer default 25,p_after text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb;more boolean;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_status is null or p_status not in('open_partial','all') or p_bank_reference is null or p_bank_reference not in('all','present','missing')
  or p_limit is null or p_limit not between 1 and 25 or(p_after is not null and(length(p_after) not between 1 and 200
   or p_after~'[[:cntrl:]]' or p_after~U&'[\007F-\009F]')) then raise exception 'itau_legacy_query_invalid' using errcode='22023';end if;
 with page as materialized(select r.* from origin_sync.raw_record r where r.entity='receivables'
  and(p_after is null or r.source_id collate "C">p_after collate "C")
  and(p_status='all' or erp_cutover.financial_status(r.payload)->>'scope' in('open','partial'))
  and(p_bank_reference='all' or (erp_cutover.itau_legacy_reference(r.payload->'numeroBanco')->>'state' in('absent','null','empty'))=(p_bank_reference='missing'))
  order by r.source_id collate "C" limit p_limit+1),visible as(select * from page order by source_id collate "C" limit p_limit)
 select coalesce((select jsonb_agg(erp_cutover.itau_legacy_row(v::origin_sync.raw_record)order by v.source_id collate "C")from visible v),'[]'::jsonb),
  (select count(*)>p_limit from page)into rows,more;
 return jsonb_build_object('profile','itau109-legacy-readiness-v1','read_only',true,'persisted',false,'can_bind',false,'can_settle',false,
  'can_generate',false,'bridge_authenticated',false,'origin_authenticated',false,'financial_mutation_performed',false,'coverage_certified',false,
  'observed_at',statement_timestamp(),'scope','stored_receivables','filters',jsonb_build_object('status',p_status,'bank_reference',p_bank_reference,'limit',p_limit,'after',p_after),
  'items',rows,'has_more',more,'next_after',case when more then rows->-1#>>'{source,id}'end);
end $$;
revoke all on function erp_cutover.itau_legacy_reference(jsonb),erp_cutover.itau_legacy_row(origin_sync.raw_record),
 public.erp_itau_legacy_readiness(uuid,text,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_itau_legacy_readiness(uuid,text,text,integer,text) to service_role;
commit;
