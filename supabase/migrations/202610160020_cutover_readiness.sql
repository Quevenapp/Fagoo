-- Bancada de preparação da virada: somente leitura, sem importar ou formar saldos.
begin;
create schema erp_cutover;
revoke all on schema erp_cutover from public,anon,authenticated,service_role;

create function erp_cutover.require_admin(p_user_id uuid) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin') then
  raise exception 'erp_cutover_access_denied' using errcode='42501';
 end if;
end $$;
create function erp_cutover.text_value(v jsonb, max_length integer) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v) in ('string','number') then left(v#>>'{}',max_length) end
$$;
-- Identidades nunca usam a função de truncamento de textos de apresentação.
create function erp_cutover.exact_id(v jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v) in('string','number') and length(v#>>'{}') between 1 and 200
  and (v#>>'{}')!~'[[:cntrl:]]' then v#>>'{}' end
$$;
-- Formatos observados no backup: decimal vírgula, ponto somente como milhar.
-- Formato API: decimal ponto. Ausência/formato desconhecido não vira zero.
create function erp_cutover.decimal_value(v text, source_format text, scale integer) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare n numeric; normalized text;
begin
 if v is null or length(v)>40 or scale not in(2,6) then return null; end if;
 if source_format='csv' then
  if v !~ '^-?([0-9]+|[0-9]{1,3}(\.[0-9]{3})+)(,[0-9]+)?$' then return null; end if;
  normalized:=replace(replace(v,'.',''),',','.');
 elsif source_format='api' then
  if v !~ '^-?[0-9]+(\.[0-9]+)?$' then return null; end if;
  normalized:=v;
 else return null; end if;
 if length(split_part(normalized,'.',2))>scale or length(replace(split_part(normalized,'.',1),'-',''))>14 then return null; end if;
 n:=normalized::numeric;
 return round(n,scale)::text;
exception when numeric_value_out_of_range or invalid_text_representation then return null;
end $$;
create function erp_cutover.status_label(v text) returns text
language sql immutable set search_path=pg_catalog as $$
 select case v when '1' then 'Aberto' when '2' then 'Pago' when '3' then 'Parcial'
 when '4' then 'Devolvido' when '5' then 'Cancelado' when '6' then 'Devolvido parcial'
 when '7' then 'Confirmado' end
$$;

create function public.erp_cutover_summary(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare batches jsonb; sources jsonb; b_count bigint;
begin
 perform erp_cutover.require_admin(p_user_id);
 select count(*) into b_count from origin_backup.batch where status in('stored','stored_with_issues');
 select coalesce(jsonb_agg(jsonb_build_object('backup_sha',b.backup_sha,'status',b.status,'stored_at',b.finished_at,
  'counts',(select coalesce(jsonb_agg(jsonb_build_object('entity',e,
   'rows',(select count(*) from origin_backup.record r where r.backup_sha=b.backup_sha and r.kind='csv' and r.data->>'entity'=e),
   'distinct_ids',(select count(distinct nullif(case when e='stock_snapshot' then r.data#>>'{payload,ID Produto}' else r.data->>'source_id' end,'')) from origin_backup.record r where r.backup_sha=b.backup_sha and r.kind='csv' and r.data->>'entity'=e),
   'ids_seen_in_api',(select count(distinct a.source_id) from origin_backup.record r join origin_sync.raw_record a on a.entity=case when e='stock_snapshot' then 'products' else e end and a.source_id=case when e='stock_snapshot' then r.data#>>'{payload,ID Produto}' else r.data->>'source_id' end where r.backup_sha=b.backup_sha and r.kind='csv' and r.data->>'entity'=e),
   'missing_id_rows',(select count(*) from origin_backup.record r where r.backup_sha=b.backup_sha and r.kind='csv' and r.data->>'entity'=e and nullif(case when e='stock_snapshot' then r.data#>>'{payload,ID Produto}' else r.data->>'source_id' end,'') is null)) order by e),'[]'::jsonb)
   from unnest(array['contacts','products','receivables','payables','stock_snapshot','sales_orders','purchase_orders','cash_movements']) e),
  'issues',(select count(*) from origin_backup.record r where r.backup_sha=b.backup_sha and r.kind='issue')) order by b.finished_at desc,b.backup_sha),'[]'::jsonb)
 into batches from(select * from origin_backup.batch where status in('stored','stored_with_issues') order by finished_at desc,backup_sha limit 20)b;
 select jsonb_agg(jsonb_build_object('entity',e,
  'records',(select count(*) from origin_sync.raw_record r where r.entity=e),
  'oldest_observation',(select min(r.last_seen_at) from origin_sync.raw_record r where r.entity=e),
  'newest_observation',(select max(r.last_seen_at) from origin_sync.raw_record r where r.entity=e),
  'native_links',(select count(*) from erp_catalog.origin o where o.entity=e),
  'pending_candidates',(select count(*) from erp_catalog.origin o where o.entity=e and (o.candidate is not null or o.state<>'synced')),
  'statuses',case when e in('receivables','payables') then(select coalesce(jsonb_agg(jsonb_build_object('code',s.code,'label',erp_cutover.status_label(s.code),'count',s.n) order by s.code),'[]'::jsonb)
   from(select case when erp_cutover.text_value(r.payload->'situacao',40) in('1','2','3','4','5','6','7') then erp_cutover.text_value(r.payload->'situacao',40) end code,count(*) n from origin_sync.raw_record r where r.entity=e group by 1)s) else '[]'::jsonb end) order by e)
 into sources from unnest(array['contacts','products','receivables','payables'])e;
 return jsonb_build_object('data_mode','cutover_readonly','as_of',statement_timestamp(),'cutoff_at',null,'reconciled',false,
  'batches',batches,'batch_count',b_count,'batches_truncated',b_count>20,'api',sources,
  'limitations',jsonb_build_array('CUTOFF_NOT_DEFINED','API_COVERAGE_NOT_CERTIFIED','BACKUP_AND_API_DIFFERENT_TIMES',
   'NO_BANK_BALANCE_RECONSTRUCTION','WAREHOUSE_MAPPING_NOT_DEFINED','NO_OPERATIONAL_EFFECTS'));
end $$;

create function erp_cutover.row_data(p_entity text,p_key text,p_file_id text,p_record_no integer,p_backup jsonb,p_source_id text,p_api jsonb,p_seen timestamptz,p_hash text)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare b jsonb:=p_backup->'payload'; checks text[]:=array[]::text[]; native jsonb; contact_link uuid; api_dto jsonb; backup_dto jsonb; amount text; paid text; balance text; quantity text; code text;
begin
 if p_backup is null then checks:=array_append(checks,'ABSENT_FROM_SELECTED_BACKUP'); end if;
 if p_api is null then checks:=array_append(checks,'NOT_OBSERVED_IN_API'); end if;
 if p_source_id is null then checks:=array_append(checks,'MISSING_SOURCE_ID'); end if;
 if p_entity in('contacts','products','stock_snapshot') and p_source_id is not null then
  select jsonb_build_object('record_id',o.record_id,'version',r.version,'active',r.active,'state',o.state,
   'candidate_pending',o.candidate is not null or o.state<>'synced',
   'source_changed_since_apply',p_hash is not null and o.applied_hash is distinct from p_hash) into native from erp_catalog.origin o
   join erp_catalog.record r on r.id=o.record_id where o.entity=case when p_entity='stock_snapshot' then 'products' else p_entity end and o.source_id=p_source_id;
  if native is null then checks:=array_append(checks,'NO_NATIVE_CATALOG_LINK'); end if;
 end if;
 if b is not null then
  if p_entity in('receivables','payables') then
   amount:=erp_cutover.decimal_value(b->>'Valor documento','csv',2);
   paid:=erp_cutover.decimal_value(b->>case when p_entity='receivables' then 'Valor recebido' else 'Valor pago' end,'csv',2);
   if amount is null then checks:=array_append(checks,'CSV_AMOUNT_UNAVAILABLE'); end if;
   if paid is null then checks:=array_append(checks,'CSV_PAID_UNAVAILABLE'); end if;
   if nullif(btrim(b->>'Conta financeira'),'') is null then checks:=array_append(checks,'CSV_FINANCIAL_ACCOUNT_MISSING'); end if;
   checks:=array_append(checks,'CSV_HAS_NO_CONTACT_ID');
  elsif p_entity='stock_snapshot' then
   quantity:=erp_cutover.decimal_value(b->>'Movimentação de Estoque*','csv',6);
   if quantity is null then checks:=array_append(checks,'CSV_QUANTITY_UNAVAILABLE'); end if;
   checks:=checks||array['WAREHOUSE_MAPPING_NOT_DEFINED','STOCK_SEMANTICS_REQUIRE_REVIEW'];
  end if;
  backup_dto:=jsonb_build_object('file_id',p_file_id,'row',p_record_no,
   'name',case when p_entity='contacts' then left(b->>'Nome',200) when p_entity='products' then left(b->>'Descrição',200) when p_entity='stock_snapshot' then left(b->>'Nome do Produto',200) end,
   'code',case when p_entity in('contacts','products') then left(b->>'Código',100) when p_entity='stock_snapshot' then left(b->>'Código SKU*',100) end,
   'status',case when p_entity<>'stock_snapshot' then left(b->>'Situação',40) end,
   'unit',case when p_entity='products' then left(b->>'Unidade',16) end,
   'amount',amount,'paid',paid,'quantity',quantity,
   'due_date',case when p_entity in('receivables','payables') then left(b->>'Data vencimento',20) end,
   'depot_label',case when p_entity='stock_snapshot' then left(b->>'Depósito*',200) end,
   'stock_mode',case when p_entity='stock_snapshot' then left(b->>'Tipo de lançamento*',80) end,
   'financial_account_present',case when p_entity in('receivables','payables') then nullif(btrim(b->>'Conta financeira'),'') is not null end);
 end if;
 if p_api is not null then
  amount:=null;balance:=null;code:=null;
  if p_entity in('receivables','payables') then
   amount:=erp_cutover.decimal_value(erp_cutover.text_value(p_api->'valor',40),'api',2);
   balance:=erp_cutover.decimal_value(erp_cutover.text_value(p_api->'saldo',40),'api',2);
   code:=erp_cutover.text_value(p_api->'situacao',40);
   if amount is null then checks:=array_append(checks,'API_AMOUNT_UNAVAILABLE'); end if;
   if balance is null then checks:=array_append(checks,'API_BALANCE_UNAVAILABLE'); end if;
   if erp_cutover.status_label(code) is null then checks:=array_append(checks,'API_STATUS_UNRECOGNIZED'); end if;
   if code in('1','3') then checks:=array_append(checks,'SOURCE_OPEN_OR_PARTIAL_REQUIRES_REVIEW'); end if;
   select record_id into contact_link from erp_catalog.origin where entity='contacts' and source_id=erp_cutover.exact_id(p_api#>'{contato,id}');
   if contact_link is null then checks:=array_append(checks,'NO_NATIVE_CONTACT_LINK'); end if;
  end if;
  api_dto:=jsonb_build_object('observed_at',p_seen,'source_hash',p_hash,
   'name',case when p_entity in('contacts','products','stock_snapshot') then erp_cutover.text_value(p_api->'nome',200) end,
   'code',case when p_entity in('contacts','products','stock_snapshot') then erp_cutover.text_value(p_api->'codigo',100) end,
   'unit',case when p_entity in('products','stock_snapshot') then erp_cutover.text_value(p_api->'unidade',16) end,
   'product_kind',case when p_entity in('products','stock_snapshot') then erp_cutover.text_value(p_api->'tipo',1) end,
   'status_code',code,'status_label',erp_cutover.status_label(code),'amount',amount,'balance',balance,
   'due_date',case when p_entity in('receivables','payables') then erp_cutover.text_value(p_api->'vencimento',20) end,
   'contact_source_id',case when p_entity in('receivables','payables') then erp_cutover.exact_id(p_api#>'{contato,id}') end,
   'native_contact_id',contact_link);
 end if;
 return jsonb_build_object('key',p_key,'source_id',p_source_id,'backup',backup_dto,'api',api_dto,'native',native,'checks',to_jsonb(checks));
end $$;

create function public.erp_cutover_records(p_user_id uuid,p_backup_sha text,p_entity text,p_limit integer default 25,p_after text default null,p_query text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb; n integer; next_key text;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_backup_sha is null or p_backup_sha!~'^[0-9a-f]{64}$' or p_entity is null or p_entity not in('contacts','products','receivables','payables','stock_snapshot')
  or p_limit is null or p_limit not between 1 and 25 or(p_after is not null and (length(p_after)>300 or p_after!~'^[ab]:'))
  or(p_query is not null and (length(p_query)>120 or p_query~'[[:cntrl:]]')) then raise exception 'erp_cutover_invalid_query' using errcode='22023'; end if;
 if not exists(select 1 from origin_backup.batch where backup_sha=p_backup_sha and status in('stored','stored_with_issues')) then
  raise exception 'erp_cutover_backup_not_ready' using errcode='P0002'; end if;
 with backup_rows as (
  select r.file_id,r.record_no,r.data,case when p_entity='stock_snapshot' then nullif(r.data#>>'{payload,ID Produto}','') else nullif(r.data->>'source_id','') end source_id,
   'b:'||r.file_id||':'||lpad(r.record_no::text,7,'0') row_key
  from origin_backup.record r where r.backup_sha=p_backup_sha and r.kind='csv' and r.data->>'entity'=p_entity
 ), combined as(
  select b.*,a.payload,a.last_seen_at,a.version_hash from backup_rows b left join origin_sync.raw_record a on
   a.entity=case when p_entity='stock_snapshot' then 'products' else p_entity end and a.source_id=b.source_id
  union all
  select null,null,null,a.source_id,'a:'||a.source_id,a.payload,a.last_seen_at,a.version_hash from origin_sync.raw_record a
   where p_entity<>'stock_snapshot' and a.entity=p_entity and not exists(select 1 from backup_rows b where b.source_id=a.source_id)
 ), with_duplicates as(
  select c.*,case when c.data is not null and c.source_id is not null then count(*) filter(where c.data is not null) over(partition by c.source_id)>1 else false end duplicate_id from combined c
 ), page as(
  select * from with_duplicates c where (p_after is null or c.row_key collate "C">p_after collate "C")
   and(nullif(p_query,'') is null or strpos(coalesce(c.source_id,''),p_query)>0)
  order by c.row_key collate "C" limit p_limit+1
 ), projected as(
  select row_key,duplicate_id,erp_cutover.row_data(p_entity,row_key,file_id,record_no,data,source_id,payload,last_seen_at,version_hash) dto from page
 ) select coalesce(jsonb_agg(case when duplicate_id then jsonb_set(dto,'{checks}',(dto->'checks')||to_jsonb(case when p_entity='stock_snapshot' then 'STOCK_PRODUCT_MULTIPLE_ROWS' else 'DUPLICATE_BACKUP_SOURCE_ID' end)) else dto end order by row_key collate "C"),'[]'::jsonb),count(*) into rows,n from projected;
 if n>p_limit then rows:=rows-(n-1);next_key:=rows->(p_limit-1)->>'key'; end if;
 return jsonb_build_object('data_mode','cutover_readonly','as_of',statement_timestamp(),'backup_sha',p_backup_sha,'entity',p_entity,
  'items',rows,'limit',p_limit,'has_more',n>p_limit,'next_cursor',next_key,'reconciled',false,'cutoff_at',null);
end $$;

revoke all on all functions in schema erp_cutover from public,anon,authenticated,service_role;
revoke all on function public.erp_cutover_summary(uuid),public.erp_cutover_records(uuid,text,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.erp_cutover_summary(uuid),public.erp_cutover_records(uuid,text,text,integer,text,text) to service_role;
commit;
