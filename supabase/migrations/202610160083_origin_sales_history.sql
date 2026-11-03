-- Immutable commercial observations, separate from every native document/effect ledger.
-- 081/078 observation helpers only. No source writes, native IDs, counters or commercial calculation.
begin;
create schema erp_sales_history;
revoke all on schema erp_sales_history from public,anon,authenticated,service_role;
alter default privileges in schema erp_sales_history revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_sales_history revoke all on functions from public,anon,authenticated,service_role;
create table erp_sales_history.snapshot (
 history_id text primary key default ('bsh_'||gen_random_uuid()::text) check(history_id~'^bsh_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 source_id text not null unique check(source_id~'^[1-9][0-9]{0,39}$'),
 command_id uuid not null unique,
 snapshot_hash text not null check(snapshot_hash~'^[a-f0-9]{64}$'),
 observation jsonb not null check(jsonb_typeof(observation)='object' and octet_length(observation::text)<=786432),
 captured_at timestamptz not null default clock_timestamp(),
 check(observation->>'profile'='origin-sales-history-observation-v1' and observation->>'source_id'=source_id
 and snapshot_hash=encode(sha256(convert_to(observation::text,'UTF8')),'hex'))
);
create table erp_sales_history.command (
 command_id uuid primary key,actor uuid not null references auth.users(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 history_id text not null unique references erp_sales_history.snapshot(history_id),
 receipt jsonb not null check(jsonb_typeof(receipt)='object'),created_at timestamptz not null default clock_timestamp()
);
alter table erp_sales_history.snapshot add constraint history_snapshot_command foreign key(command_id) references erp_sales_history.command(command_id) deferrable initially deferred;
alter table erp_sales_history.snapshot enable row level security;
alter table erp_sales_history.command enable row level security;
revoke all on all tables in schema erp_sales_history from public,anon,authenticated,service_role;
create function erp_sales_history.immutable() returns trigger language plpgsql set search_path=pg_catalog as $$begin
 raise exception 'sales_history_immutable' using errcode='55000';
end $$;
create trigger immutable_snapshot before update or delete on erp_sales_history.snapshot for each row execute function erp_sales_history.immutable();
create trigger immutable_command before update or delete on erp_sales_history.command for each row execute function erp_sales_history.immutable();
create function erp_sales_history.flags() returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('profile','origin-sales-history-v1','read_only',true,'can_convert',false,'native_effects',false,
 'commercial_math_reconciled',false,'coverage_certified',false,'observed_at',statement_timestamp())
$$;
-- Invalid scalar strings remain strings; objects/oversized scalars stay preserved privately, never repaired.
create function erp_sales_history.observed(v jsonb,numeric_expected boolean default false,max_chars integer default 200) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare k text:=jsonb_typeof(v);s text;status text;
begin
 if v is null then return jsonb_build_object('state','absent','kind',null,'value',null);end if;
 if k='null' then return jsonb_build_object('state','null','kind',null,'value',null);end if;
 if k in('string','number','boolean') then s:=v#>>'{}';end if;
 status:=case when (numeric_expected and k='number') or(not numeric_expected and k in('string','number')) then 'value' else 'invalid' end;
 if length(s)>max_chars or s~'[[:cntrl:]]' or s~U&'[\007F-\009F]' then s:=null;status:='invalid';end if;
 return jsonb_build_object('state',status,'kind',k,'value',s);
end $$;
create function erp_sales_history.source(v jsonb) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('namespace','origin_api','entity','sales_orders','source_id',v->'source_id','source_hash',v->'source_hash',
 'source_version',v->'source_version','last_seen_at',v->'last_seen_at','source_updated_at',v->'source_updated_at')
$$;
create function erp_sales_history.input(s origin_sync.raw_record) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v jsonb;
begin
 if s.entity is distinct from 'sales_orders' or s.source_id is null or s.source_id!~'^[1-9][0-9]{0,39}$'
  or erp_documents.origin_import_id(s.payload->'id') is distinct from s.source_id
  or s.version_hash is distinct from encode(sha256(convert_to(jsonb_build_object('payload',s.payload,'document_links',s.document_links)::text,'UTF8')),'hex')
  or not isfinite(s.last_seen_at) or (s.source_updated_at is not null and not isfinite(s.source_updated_at)) then
  raise exception 'sales_history_source_invalid' using errcode='22023';end if;
 if octet_length(s.payload::text)>524288 or octet_length(s.document_links::text)>65536 or coalesce(octet_length(s.price_capture::text),0)>131072
  or (jsonb_typeof(s.payload->'itens')='array' and jsonb_array_length(s.payload->'itens')>250) then
  raise exception 'sales_history_source_too_large' using errcode='22023';end if;
 v:=jsonb_build_object('profile','origin-sales-history-observation-v1','source_id',s.source_id,'source_hash',s.version_hash,'source_version',s.version::text,
 'last_seen_at',s.last_seen_at,'source_updated_at',s.source_updated_at,'payload',s.payload,'document_links',s.document_links,'price_capture_present',s.price_capture is not null,'price_capture',s.price_capture);
 v:=v||jsonb_build_object('price_capture_verification',erp_sales_history.capture(v));
 if octet_length(v::text)>786432 then raise exception 'sales_history_source_too_large' using errcode='22023';end if;
 return v;
end $$;
create function erp_sales_history.capture(v jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare s origin_sync.raw_record;c jsonb;state text;reason text;
begin
 s.payload:=v->'payload';s.version_hash:=v->>'source_hash';s.version:=(v->>'source_version')::bigint;
 s.price_capture:=case when v->'price_capture_present'='false'::jsonb then null else v->'price_capture' end;
 c:=erp_cutover.sales_capture(s);state:=c->>'state';
 reason:=case when state='other_profile' then 'OTHER_PROFILE' when state='unbound' then 'UNBOUND_OR_INVALID' end;
 return jsonb_build_object('state',case when state in('other_profile','unbound')then 'invalid' else state end,'reason',reason,
 'profile',c->'profile','observed_at',c->'observed_at','response_sha256',c->'response_sha256',
 'numeric_tokens',case when state='bound' then jsonb_array_length(s.price_capture->'tokens')end,'scope','numeric_itens_valor_only');
end $$;
create function erp_sales_history.summary(s erp_sales_history.snapshot) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('history_id',s.history_id,'source',erp_sales_history.source(s.observation),'snapshot_hash',s.snapshot_hash,'captured_at',s.captured_at,
 'number',erp_sales_history.observed(s.observation#>'{payload,numero}',false,80),'date',erp_sales_history.observed(s.observation#>'{payload,data}',false,40),
 'situation',jsonb_build_object('id',erp_sales_history.observed(s.observation#>'{payload,situacao,id}',true),'value',erp_sales_history.observed(s.observation#>'{payload,situacao,valor}',true)),
 'item_count',case when jsonb_typeof(s.observation#>'{payload,itens}')='array' then jsonb_array_length(s.observation#>'{payload,itens}')end,
 'capture',s.observation->'price_capture_verification')
$$;
create function erp_sales_history.binding(entity text,v jsonb) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('state',b->'state','source_id',b->'source_id','record_id',b->'record_id','record_version',b->'record_version','unit',b->'unit')
 from(select erp_cutover.purchase_binding(entity,v)b)x
$$;
create function erp_sales_history.detail(s erp_sales_history.snapshot) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare p jsonb:=s.observation->'payload';c jsonb:=s.observation->'price_capture_verification';item jsonb;rows jsonb:='[]';bindings jsonb:='[]';pos integer:=0;lex text;current_source jsonb;item_state text;
begin
 item_state:=case when not(p?'itens')then 'absent' when p->'itens'='null'::jsonb then 'null' when jsonb_typeof(p->'itens')='array' then 'array' else 'invalid'end;
 if item_state='array' then for item in select value from jsonb_array_elements(p->'itens')loop
  pos:=pos+1;lex:=null;
  if c->>'state'='bound' then select t->>'lexeme' into lex from jsonb_array_elements(s.observation#>'{price_capture,tokens}')t where t->>'path'='/itens/'||(pos-1)::text||'/valor';end if;
  rows:=rows||jsonb_build_array(jsonb_build_object('position',pos,'item_state',case when jsonb_typeof(item)='object'then 'object'else'invalid'end,
   'source_product_id',erp_sales_history.observed(item#>'{produto,id}',true),'code',erp_sales_history.observed(item->'codigo'),'description',erp_sales_history.observed(item->'descricao'),
   'unit',erp_sales_history.observed(item->'unidade',false,16),'quantity',erp_sales_history.observed(item->'quantidade',true,256),
   'unit_price',erp_sales_history.observed(item->'valor',true,256),'discount',erp_sales_history.observed(item->'desconto',true,256),
   'list_price',erp_sales_history.observed(item->'valorLista',true,256),'ipi',erp_sales_history.observed(item->'aliquotaIPI',true,256),'price_lexeme',lex));
  bindings:=bindings||jsonb_build_array(jsonb_build_object('position',pos,'binding',erp_sales_history.binding('products',item#>'{produto,id}')));
 end loop;end if;
 select jsonb_build_object('state',case when r.source_id is null then 'missing' when r.version_hash=s.observation->>'source_hash' and r.version::text=s.observation->>'source_version' then 'same'else'changed'end,
 'source_hash',r.version_hash,'source_version',r.version::text,'last_seen_at',r.last_seen_at)into current_source
 from(select 1)a left join origin_sync.raw_record r on r.entity='sales_orders' and r.source_id=s.source_id;
 return erp_sales_history.flags()||jsonb_build_object('snapshot',erp_sales_history.summary(s),
 'customer',jsonb_build_object('source_id',erp_sales_history.observed(p#>'{contato,id}',true),'name',erp_sales_history.observed(p#>'{contato,nome}')),
 'invoice_reference',jsonb_build_object('structure_present',p?'notaFiscal','source_id',erp_sales_history.observed(p#>'{notaFiscal,id}',true)),
 'items_state',item_state,'items',rows,'commercial',jsonb_build_object('total',erp_sales_history.observed(p->'total',true,256),'total_products',erp_sales_history.observed(p->'totalProdutos',true,256),
 'freight',erp_sales_history.observed(p#>'{transporte,frete}',true,256),'other_expenses',erp_sales_history.observed(p->'outrasDespesas',true,256),
 'discount_value',erp_sales_history.observed(p#>'{desconto,valor}',true,256),'discount_unit',erp_sales_history.observed(p#>'{desconto,unidade}',false,40),
 'installment_count',case when jsonb_typeof(p->'parcelas')='array'then jsonb_array_length(p->'parcelas')end),
 'current',jsonb_build_object('source',current_source,'customer',erp_sales_history.binding('contacts',p#>'{contato,id}'),'products',bindings));
end $$;
create function public.erp_origin_sales_history_preview(p_user_id uuid,p_source_id text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s origin_sync.raw_record;v jsonb;existing jsonb;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_source_id is null or p_source_id!~'^[1-9][0-9]{0,39}$'then raise exception 'sales_history_query_invalid' using errcode='22023';end if;
 select * into s from origin_sync.raw_record where entity='sales_orders'and source_id=p_source_id;
 if not found then raise exception 'sales_history_source_not_found'using errcode='P0002';end if;
 v:=erp_sales_history.input(s);
 select c.receipt into existing from erp_sales_history.snapshot h join erp_sales_history.command c using(history_id)where h.source_id=p_source_id;
 return erp_sales_history.flags()||jsonb_build_object('source',erp_sales_history.source(v),'snapshot_hash',encode(sha256(convert_to(v::text,'UTF8')),'hex'),'capture',v->'price_capture_verification','existing',existing);
end $$;
create function public.erp_origin_sales_history_capture(p_user_id uuid,p_source_id text,p_source_hash text,p_source_version text,p_snapshot_hash text,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare s origin_sync.raw_record;v jsonb;h text;cmd erp_sales_history.command;saved erp_sales_history.snapshot;receipt jsonb;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_source_id is null or p_source_id!~'^[1-9][0-9]{0,39}$'or p_source_hash is null or p_source_hash!~'^[a-f0-9]{64}$'
  or p_source_version is null or p_source_version!~'^[1-9][0-9]{0,18}$'or p_snapshot_hash is null or p_snapshot_hash!~'^[a-f0-9]{64}$'or p_command_id is null then
  raise exception 'sales_history_capture_invalid'using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','origin-sales-history-v1','actor',p_user_id,'source_id',p_source_id,'source_hash',p_source_hash,'source_version',p_source_version,'snapshot_hash',p_snapshot_hash)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174853083,hashtext(p_command_id::text));
 perform erp_cutover.require_admin(p_user_id);
 select * into cmd from erp_sales_history.command where command_id=p_command_id;
 if found then
  perform m.user_id from erp_access.membership m where m.user_id=p_user_id for share;
  perform erp_cutover.require_admin(p_user_id);
  if cmd.actor<>p_user_id or cmd.request_hash<>h then raise exception 'sales_history_command_conflict'using errcode='40001';end if;
  return erp_sales_history.flags()||jsonb_build_object('receipt',cmd.receipt);
 end if;
 perform pg_advisory_xact_lock(174853084,hashtext(p_source_id));
 perform erp_cutover.require_admin(p_user_id);
 if exists(select 1 from erp_sales_history.snapshot where source_id=p_source_id)then raise exception 'sales_history_already_captured'using errcode='40001';end if;
 select * into s from origin_sync.raw_record where entity='sales_orders'and source_id=p_source_id for share;
 perform erp_cutover.require_admin(p_user_id);
 if s.source_id is null then raise exception 'sales_history_source_not_found'using errcode='P0002';end if;
 v:=erp_sales_history.input(s);
 if s.version_hash<>p_source_hash or s.version::text<>p_source_version or encode(sha256(convert_to(v::text,'UTF8')),'hex')<>p_snapshot_hash then
  raise exception 'sales_history_snapshot_conflict'using errcode='40001';end if;
 perform m.user_id from erp_access.membership m where m.user_id=p_user_id for share;
 perform erp_cutover.require_admin(p_user_id);
 insert into erp_sales_history.snapshot(source_id,command_id,snapshot_hash,observation)values(p_source_id,p_command_id,p_snapshot_hash,v)returning * into saved;
 receipt:=jsonb_build_object('command_id',p_command_id,'history_id',saved.history_id,'source',erp_sales_history.source(v),'snapshot_hash',p_snapshot_hash,'captured_at',saved.captured_at);
 insert into erp_sales_history.command(command_id,actor,request_hash,history_id,receipt)values(p_command_id,p_user_id,h,saved.history_id,receipt);
 return erp_sales_history.flags()||jsonb_build_object('receipt',receipt);
end $$;
create function public.erp_origin_sales_history_command(p_user_id uuid,p_command_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare r jsonb;begin
 perform erp_cutover.require_admin(p_user_id);if p_command_id is null then raise exception 'sales_history_query_invalid'using errcode='22023';end if;
 select receipt into r from erp_sales_history.command where command_id=p_command_id;
 if not found then raise exception 'sales_history_command_not_found'using errcode='P0002';end if;
 return erp_sales_history.flags()||jsonb_build_object('receipt',r);
end $$;
create function public.erp_origin_sales_history_detail(p_user_id uuid,p_history_id text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s erp_sales_history.snapshot;begin
 perform erp_cutover.require_admin(p_user_id);
 if p_history_id is null or p_history_id!~'^bsh_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'then raise exception 'sales_history_query_invalid'using errcode='22023';end if;
 select * into s from erp_sales_history.snapshot where history_id=p_history_id;
 if not found then raise exception 'sales_history_not_found'using errcode='P0002';end if;
 return erp_sales_history.detail(s);
end $$;
create function public.erp_origin_sales_history_list(p_user_id uuid,p_limit integer default 25,p_after text default null,p_query text default null) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb;more boolean;begin
 perform erp_cutover.require_admin(p_user_id);
 if p_limit is null or p_limit not between 1 and 25 or(p_after is not null and p_after!~'^bsh_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
 or(p_query is not null and(length(p_query)>100 or p_query~'[[:cntrl:]]'or p_query~U&'[\007F-\009F]'))then raise exception 'sales_history_query_invalid'using errcode='22023';end if;
 with page as materialized(select s.* from erp_sales_history.snapshot s where(p_after is null or history_id collate "C">p_after collate "C")
 and(nullif(btrim(p_query),'')is null or strpos(source_id,btrim(p_query))>0 or strpos(lower(observation#>>'{payload,numero}'),lower(btrim(p_query)))>0)
 order by history_id collate "C" limit p_limit+1),visible as(select * from page order by history_id collate "C" limit p_limit)
 select coalesce((select jsonb_agg(erp_sales_history.summary(v::erp_sales_history.snapshot)order by v.history_id collate "C")from visible v),'[]'::jsonb),(select count(*)>p_limit from page)into rows,more;
 return erp_sales_history.flags()||jsonb_build_object('items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then rows->-1->>'history_id'end);
end $$;
revoke all on all functions in schema erp_sales_history from public,anon,authenticated,service_role;
revoke all on function public.erp_origin_sales_history_preview(uuid,text),public.erp_origin_sales_history_capture(uuid,text,text,text,text,uuid),public.erp_origin_sales_history_command(uuid,uuid),public.erp_origin_sales_history_detail(uuid,text),public.erp_origin_sales_history_list(uuid,integer,text,text)from public,anon,authenticated,service_role;
grant execute on function public.erp_origin_sales_history_preview(uuid,text),public.erp_origin_sales_history_capture(uuid,text,text,text,text,uuid),public.erp_origin_sales_history_command(uuid,uuid),public.erp_origin_sales_history_detail(uuid,text),public.erp_origin_sales_history_list(uuid,integer,text,text)to service_role;
commit;
