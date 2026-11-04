-- Browser observations stay outside the native ledger. No stock/outbox/applying functions are called.
begin;
create table erp_sync.browser_job(
 id uuid primary key default gen_random_uuid(), job_key text not null unique, kind text not null check(kind in('indicators','stock_history')),
 task jsonb not null, due_at timestamptz not null default now(), state text not null default 'pending' check(state in('pending','running','done','failed')),
 claim_token uuid, claimed_by uuid, claimed_at timestamptz, attempts integer not null default 0,
 last_completed_at timestamptz, error text, receipt jsonb
);
create index browser_job_due on erp_sync.browser_job(state,due_at);
create table erp_sync.stock_history_snapshot(
 id uuid primary key default gen_random_uuid(), job_id uuid not null references erp_sync.browser_job, claim_token uuid not null,
 product_source_id text not null, warehouse_source_id text not null, product_code text not null, warehouse_name text not null,
 observed_at timestamptz not null, items jsonb not null check(jsonb_typeof(items)='array' and jsonb_array_length(items)<=5000),
 evidence_hash text not null, recorded_at timestamptz not null default now(), unique(job_id,claim_token)
);
create index stock_history_latest on erp_sync.stock_history_snapshot(product_source_id,warehouse_source_id,observed_at desc);
create trigger stock_history_immutable before update or delete on erp_sync.stock_history_snapshot for each row execute function erp_sync.indicator_observation_immutable();
alter table erp_sync.browser_job enable row level security;
alter table erp_sync.stock_history_snapshot enable row level security;
revoke all on erp_sync.browser_job,erp_sync.stock_history_snapshot from public,anon,authenticated,service_role;

create function erp_sync.indicator_products(p_entity text,p_source text)returns table(source_id text,code text)
language sql stable set search_path=pg_catalog as $$
 select distinct p.source_id,p.payload->>'codigo'
 from origin_sync.raw_record r cross join lateral jsonb_array_elements(coalesce(r.payload->'itens','[]'))i
 join origin_sync.raw_record p on p.entity='products' and
  (p.source_id=coalesce(nullif(i#>>'{produto,id}','0'),nullif(i->>'idProduto','0'))
   or(coalesce(nullif(i#>>'{produto,id}','0'),nullif(i->>'idProduto','0'))is null and p.payload->>'codigo'=i->>'codigo'
    and (select count(*)from origin_sync.raw_record p2 where p2.entity='products' and p2.payload->>'codigo'=i->>'codigo')=1))
 where r.entity=p_entity and r.source_id=p_source and nullif(p.payload->>'codigo','')is not null
$$;

create function erp_sync.browser_enqueue()returns void language plpgsql set search_path=pg_catalog as $$
begin
 -- Bounded discovery. Older records remain discoverable as earlier jobs are consumed.
 insert into erp_sync.browser_job(job_key,kind,task)
 select 'I:'||r.entity||':'||r.source_id,'indicators',jsonb_build_object('entity',r.entity,'source_id',r.source_id,'number',r.payload->>'numero',
  'date',left(coalesce(nullif(r.payload->>'data',''),nullif(r.payload->>'dataEmissao',''),nullif(r.payload->>'dataEntrada','')),10),
  'direction',case when r.entity='nfe' and r.payload->>'tipo'='0' then 'in' else 'out' end)
 from origin_sync.raw_record r where r.entity in('sales_orders','purchase_orders','service_orders','nfe','nfce')
 and r.payload->>'numero'~'^[0-9]{1,20}$'
 and not exists(select 1 from erp_sync.browser_job j where j.job_key='I:'||r.entity||':'||r.source_id)
 order by r.last_seen_at desc,r.entity,r.source_id limit 100 on conflict do nothing;
 insert into erp_sync.browser_job(job_key,kind,task)
 select distinct 'H:'||p.source_id||':'||w.source_id,'stock_history',jsonb_build_object('product_source_id',p.source_id,'product_code',p.code,'warehouse_source_id',w.source_id)
 from(select distinct on(entity,source_id) * from erp_sync.indicator_observation order by entity,source_id,observed_at desc)o
 cross join lateral erp_sync.indicator_products(o.entity,o.source_id)p
 join origin_sync.raw_record w on w.entity='warehouses' and coalesce(w.payload->>'descricao',w.payload->>'nome')=substring(o.stock_label from 'Depósito: (.+)$')
 where o.stock_flag is not null and not exists(select 1 from erp_sync.browser_job j where j.job_key='H:'||p.source_id||':'||w.source_id)
 limit 100 on conflict do nothing;
end$$;

create function erp_sync.browser_status()returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('pending',count(*)filter(where state='pending' or state='done' and due_at<=now() or state='running' and claimed_at<now()-interval '5 minutes'),
 'running',count(*)filter(where state='running' and claimed_at>=now()-interval '5 minutes'),
 'failed',count(*)filter(where state='failed'),'last_completed_at',max(last_completed_at),
 'indicator_records',(select count(*)from(select distinct entity,source_id from erp_sync.indicator_observation)o),
 'history_products',(select count(distinct(product_source_id,warehouse_source_id))from erp_sync.stock_history_snapshot),
 'last_error',(select error from erp_sync.browser_job where error is not null order by claimed_at desc limit 1),
 'operational_effects',false)from erp_sync.browser_job
$$;
create function public.erp_sync_browser(p_user_id uuid,p_action text,p_job_id uuid default null,p_claim_token uuid default null,p_observation jsonb default null,p_error text default null)returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare j erp_sync.browser_job; o jsonb:=p_observation; x jsonb; h text; result jsonb; n integer; stamp timestamptz;
begin
 perform erp_sync.require_member(p_user_id,false);
 if not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin')then raise exception 'browser_admin_required'using errcode='42501';end if;
 if p_action='status' then return erp_sync.browser_status();end if;
 if p_action in('enqueue','claim')then
  perform pg_advisory_xact_lock(hashtext('erp_sync.browser_enqueue'));
  perform erp_sync.browser_enqueue();
  if p_action='enqueue'then
   update erp_sync.browser_job set state='pending',due_at=now(),attempts=0,error=null where state='failed';
   return erp_sync.browser_status();
  end if;
  if exists(select 1 from erp_sync.browser_job where state='running'and claimed_by=p_user_id and claimed_at>=now()-interval '5 minutes')then return jsonb_build_object('job',null);end if;
  select * into j from erp_sync.browser_job where (state='pending' and due_at<=now())or(state='running' and claimed_at<now()-interval '5 minutes')or(state='done' and due_at<=now())
   order by case kind when 'stock_history'then 0 else 1 end,due_at,id limit 1 for update skip locked;
  if not found then return jsonb_build_object('job',null);end if;
  update erp_sync.browser_job set state='running',claim_token=gen_random_uuid(),claimed_by=p_user_id,claimed_at=now(),attempts=attempts+1,error=null where id=j.id returning * into j;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'token',j.claim_token,'kind',j.kind,'task',j.task));
 end if;
 if p_action not in('finish','fail')or p_action is null then raise exception 'browser_action_invalid'using errcode='22023';end if;
 select * into j from erp_sync.browser_job where id=p_job_id for update;
 if not found or j.claim_token is distinct from p_claim_token or j.claimed_by is distinct from p_user_id then raise exception 'browser_lease_conflict'using errcode='40001';end if;
 if p_action='fail'then
  if j.state='done' then return j.receipt;end if;
  if p_error is null or p_error!~'^BROWSER_[A-Z_]{1,65}$'then raise exception 'browser_error_invalid'using errcode='22023';end if;
  update erp_sync.browser_job set state=case when attempts>=3 then'failed'else'pending'end,due_at=now()+interval '15 minutes',error=p_error where id=j.id;
  return jsonb_build_object('accepted',true,'operational_effects',false);
 end if;
 if jsonb_typeof(o)<>'object' or o->>'profile'<>'origin-browser-observation-v1' or o->>'kind'<>j.kind or octet_length(o::text)>2000000
  or jsonb_typeof(o->'items')is distinct from'array' or jsonb_array_length(o->'items')>5000 then raise exception 'browser_observation_invalid'using errcode='22023';end if;
 stamp:=(o->>'observed_at')::timestamptz;
 if stamp is null or stamp>now()+interval '5 minutes' or stamp<j.claimed_at-interval '1 minute' then raise exception 'browser_observation_time_invalid'using errcode='22023';end if;
 h:=encode(sha256(convert_to(o::text,'UTF8')),'hex');
 if j.state='done'then
  if j.receipt->>'hash'<>h then raise exception 'browser_receipt_conflict'using errcode='40001';end if;
  return j.receipt;
 end if;
 if j.state<>'running' or j.claimed_at<now()-interval '5 minutes'then raise exception 'browser_lease_expired'using errcode='40001';end if;
 if j.kind='indicators'then
  if o->>'entity'<>j.task->>'entity' or jsonb_array_length(o->'items')<>1 or o#>>'{items,0,source_id}'<>j.task->>'source_id'
   or ltrim(o#>>'{items,0,number}','0')<>ltrim(j.task->>'number','0') then raise exception 'browser_identity_mismatch'using errcode='22023';end if;
  result:=public.erp_sync_indicator_observe(o->>'entity',stamp,o->'items');
 else
  if o->>'product_source_id'<>j.task->>'product_source_id' or o->>'warehouse_source_id'<>j.task->>'warehouse_source_id' or o->>'product_code'<>j.task->>'product_code'
   or not exists(select 1 from origin_sync.raw_record r where r.entity='products'and r.source_id=o->>'product_source_id'and r.payload->>'codigo'=o->>'product_code')
   or not exists(select 1 from origin_sync.raw_record r where r.entity='warehouses'and r.source_id=o->>'warehouse_source_id' and coalesce(r.payload->>'descricao',r.payload->>'nome')=o->>'warehouse_name')then raise exception 'browser_identity_mismatch'using errcode='22023';end if;
  for x in select value from jsonb_array_elements(o->'items')loop
   if not(x ?& array['occurred_at','operation','quantity','sale_price','purchase_price','cost_price','note','origin_label','origin_entity','origin_source_id','origin_number'])
    or coalesce(x->>'occurred_at','')!~'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$' or coalesce(x->>'operation','')not in('E','S','B')
    or ((x->>'origin_entity'is null)<>(x->>'origin_source_id'is null))
    or(x->>'origin_entity'is not null and x->>'origin_entity'not in('sales_orders','purchase_orders','service_orders','nfe','nfce'))
    or(x->>'origin_source_id'is not null and x->>'origin_source_id'!~'^[1-9][0-9]{0,39}$')
    or length(x->>'note')>2000 or length(x->>'origin_label')>300 then raise exception 'browser_history_invalid'using errcode='22023';end if;
   perform (x->>'occurred_at')::timestamp;
   foreach h in array array['quantity','sale_price','purchase_price','cost_price']loop
    if x->>h is not null and x->>h!~'^-?[0-9]{1,18}(\.[0-9]{1,12})?$'then raise exception 'browser_history_invalid'using errcode='22023';end if;
   end loop;
   if x->>'operation'<>'B'and(coalesce((x->>'quantity')::numeric,0)<=0)then raise exception 'browser_history_invalid'using errcode='22023';end if;
   if exists(select 1 from origin_sync.raw_record r where r.entity=x->>'origin_entity'and r.source_id=x->>'origin_source_id'and ltrim(r.payload->>'numero','0')is distinct from ltrim(x->>'origin_number','0'))then raise exception 'browser_origin_mismatch'using errcode='22023';end if;
  end loop;
  h:=encode(sha256(convert_to(o::text,'UTF8')),'hex');
  insert into erp_sync.stock_history_snapshot(job_id,claim_token,product_source_id,warehouse_source_id,product_code,warehouse_name,observed_at,items,evidence_hash)
   values(j.id,j.claim_token,o->>'product_source_id',o->>'warehouse_source_id',o->>'product_code',o->>'warehouse_name',stamp,o->'items',h);
  result:=jsonb_build_object('processed',jsonb_array_length(o->'items'),'operational_effects',false);
 end if;
 result:=result||jsonb_build_object('hash',h);
 update erp_sync.browser_job set state='done',last_completed_at=now(),due_at=now()+interval '24 hours',attempts=0,error=null,receipt=result where id=j.id;
 return result;
end$$;

create function erp_sync.indicator_history(p_entity text,p_source text,p_note text)returns jsonb language sql stable set search_path=pg_catalog as $$
 with products as materialized(select *from erp_sync.indicator_products(p_entity,p_source)),latest as materialized(
  select distinct on(s.product_source_id,s.warehouse_source_id)s.*from erp_sync.stock_history_snapshot s join products p on p.source_id=s.product_source_id
  order by s.product_source_id,s.warehouse_source_id,s.observed_at desc
 ),found as(
 select s.product_code,s.warehouse_name,s.observed_at,x,ordinal from latest s cross join lateral jsonb_array_elements(s.items)with ordinality as e(x,ordinal)
 where (x->>'origin_entity'=p_entity and x->>'origin_source_id'=p_source)or(p_note is not null and x->>'origin_entity'='nfe'and x->>'origin_source_id'=p_note)
 ),counts as(select(select count(*)from products)expected_products,(select count(distinct product_source_id)from latest)imported_products,(select count(*)from found)records)
 select jsonb_build_object('expected_products',expected_products,'imported_products',imported_products,'has_more',records>200,
 'items',coalesce((select jsonb_agg(jsonb_build_object('product_code',product_code,'warehouse',warehouse_name,'observed_at',observed_at,'occurred_at',x->>'occurred_at',
  'operation',x->>'operation','quantity',x->>'quantity','sale_price',x->>'sale_price','purchase_price',x->>'purchase_price','cost_price',x->>'cost_price',
  'note',x->>'note','origin_label',x->>'origin_label')order by x->>'occurred_at'desc,product_code,ordinal)from(select *from found order by x->>'occurred_at'desc,product_code,ordinal limit 200)f),'[]'::jsonb))from counts
$$;

-- Preserve every existing visibility, destination access and finance-origin rule.
alter function public.erp_synced_effect_indicators(uuid,text,jsonb,text)rename to erp_synced_effect_indicators_without_history;
create function public.erp_synced_effect_indicators(p_user_id uuid,p_entity text,p_ids jsonb,p_detail text default null)returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb; item jsonb; source text; note text;
begin
 result:=public.erp_synced_effect_indicators_without_history(p_user_id,p_entity,p_ids,p_detail);
 if p_detail='E'then
  select value into item from jsonb_array_elements(result->'items')limit 1;
  if item is not null then
   if p_entity in('nfe','nfce')then source:=item->>'id';else
    select origin_id into source from erp_sync.link where entity=p_entity and record_id=(item->>'id')::uuid;
    select coalesce(nullif(payload#>>'{notaFiscal,id}','0'),nullif(payload->>'idNotaFiscal','0'))into note from origin_sync.raw_record where entity=p_entity and source_id=source;
   end if;
   result:=jsonb_set(result,'{items}',jsonb_build_array(item||jsonb_build_object('history',erp_sync.indicator_history(p_entity,source,note))));
  end if;
 end if;
 return result;
end$$;
-- Implemented stages now have their own executable queue/status, not implementation gaps.
create or replace function erp_sync.indicator_integration_gaps()returns jsonb language sql stable set search_path=pg_catalog as $$select '[]'::jsonb$$;
alter function erp_sync.status_dto()rename to status_dto_without_browser;
create function erp_sync.status_dto()returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select erp_sync.status_dto_without_browser()||jsonb_build_object('browser_observer',erp_sync.browser_status())
$$;
alter function public.erp_sync_request(uuid)rename to erp_sync_request_without_browser;
create function public.erp_sync_request(p_user_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;begin result:=public.erp_sync_request_without_browser(p_user_id);perform erp_sync.browser_enqueue();return erp_sync.status_dto()||jsonb_build_object('requested_run',result->'requested_run');end$$;
revoke all on function erp_sync.indicator_products(text,text),erp_sync.browser_enqueue(),erp_sync.browser_status(),erp_sync.indicator_history(text,text,text),
 public.erp_sync_browser(uuid,text,uuid,uuid,jsonb,text),public.erp_synced_effect_indicators(uuid,text,jsonb,text),public.erp_synced_effect_indicators_without_history(uuid,text,jsonb,text),
 erp_sync.status_dto_without_browser(),erp_sync.status_dto(),public.erp_sync_request_without_browser(uuid),public.erp_sync_request(uuid) from public,anon,authenticated,service_role;
grant execute on function public.erp_sync_browser(uuid,text,uuid,uuid,jsonb,text),public.erp_synced_effect_indicators(uuid,text,jsonb,text),public.erp_sync_request(uuid)to service_role;
commit;
