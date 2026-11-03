-- Ação explícita documento -> estoque, dependente de 008/009/011/017.
-- Locks: comando -> documento -> vínculo -> advisory global 009 -> catálogo -> saldos.
-- Nunca movimenta por situação, importação, nota fiscal ou execução agendada.
begin;
create table erp_stock.document_posting (
 id uuid primary key default gen_random_uuid(),document_id uuid not null references erp_documents.document(id),
 document_version integer not null check(document_version>0),movement_id uuid not null unique references erp_stock.movement(id),
 state text not null default 'active' check(state in('active','reversed')),version integer not null default 1 check(version>0),
 snapshot jsonb not null,preview_hash text not null check(preview_hash~'^[a-f0-9]{64}$'),
 actor uuid not null references auth.users(id),command_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(),reversal_movement_id uuid unique references erp_stock.movement(id),
 reversed_at timestamptz,reversed_by uuid references auth.users(id),reason text,
 check((state='active' and reversal_movement_id is null and reversed_at is null and reversed_by is null and reason is null)
  or(state='reversed' and reversal_movement_id is not null and reversed_at is not null and reversed_by is not null and length(reason) between 3 and 500))
);
create unique index erp_document_one_active_stock on erp_stock.document_posting(document_id) where state='active';
create index erp_document_stock_history on erp_stock.document_posting(document_id,id);
create table erp_stock.document_command (
 id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null,
 result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table erp_stock.document_audit (
 id bigint generated always as identity primary key,actor uuid not null references auth.users(id),command_id uuid not null,
 document_id uuid not null references erp_documents.document(id),posting_id uuid not null references erp_stock.document_posting(id),
 action text not null check(action in('post','reverse')),result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text;begin foreach t in array array['document_posting','document_command','document_audit'] loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end $$;
revoke all on all sequences in schema erp_stock from public,anon,authenticated,service_role;
create trigger immutable_document_stock_command before update or delete on erp_stock.document_command for each row execute function erp_stock.immutable_ledger();
create trigger immutable_document_stock_audit before update or delete on erp_stock.document_audit for each row execute function erp_stock.immutable_ledger();
create function erp_stock.guard_document_posting()
returns trigger language plpgsql set search_path=pg_catalog as $$ begin
 if tg_op='DELETE' then raise exception 'erp_document_stock_immutable' using errcode='40001';end if;
 if old.state<>'active' or new.state<>'reversed' or new.version<>old.version+1
  or (to_jsonb(new)-array['state','version','reversal_movement_id','reversed_at','reversed_by','reason'])
   is distinct from(to_jsonb(old)-array['state','version','reversal_movement_id','reversed_at','reversed_by','reason'])
  or not exists(select 1 from erp_stock.movement where id=new.reversal_movement_id and reverses_id=old.movement_id) then
  raise exception 'erp_document_stock_immutable' using errcode='40001';end if;return new;
end $$;
create trigger immutable_document_stock_posting before update or delete on erp_stock.document_posting for each row execute function erp_stock.guard_document_posting();
create function erp_stock.guard_posted_document()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ begin
 if exists(select 1 from erp_stock.document_posting where document_id=old.id and state='active') then
  if tg_op='DELETE' then raise exception 'erp_document_active_stock' using errcode='40001';end if;
  if(to_jsonb(new)-array['status','version','updated_at','updated_by']) is distinct from(to_jsonb(old)-array['status','version','updated_at','updated_by'])
   or not erp_documents.effects_transition_allowed(old.kind,old.status,new.status) then raise exception 'erp_document_active_stock' using errcode='40001';end if;
 end if;if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger protect_document_stock before update or delete on erp_documents.document for each row execute function erp_stock.guard_posted_document();
create function erp_stock.guard_posted_item()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ declare d uuid;begin
 d:=case when tg_op='INSERT' then new.document_id else old.document_id end;
 if exists(select 1 from erp_stock.document_posting where state='active' and(document_id=d or(tg_op='UPDATE' and document_id=new.document_id))) then
  raise exception 'erp_document_active_stock' using errcode='40001';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger protect_document_item_stock before insert or update or delete on erp_documents.item for each row execute function erp_stock.guard_posted_item();

create function erp_stock.document_eligible(p_kind text,p_status text)
returns boolean language sql immutable set search_path=pg_catalog as $$ select coalesce(case p_kind
 when 'sales_orders' then p_status in('verified','in_progress','partially_fulfilled','fulfilled')
 when 'purchase_orders' then p_status in('in_progress','partially_fulfilled','fulfilled')
 when 'service_orders' then p_status in('approved','in_progress','waiting_parts','service_done','finalized') else false end,false) $$;
create function erp_stock.document_access(p_actor uuid,p_kind text)
returns void language plpgsql stable set search_path=pg_catalog as $$ begin
 -- Narrow operational projection includes OS, without granting generic document/financial access.
 perform erp_stock.require_access(p_actor,true);
 if p_kind is null or p_kind not in('sales_orders','purchase_orders','service_orders') then raise exception 'erp_document_stock_invalid_kind' using errcode='22023';end if;
end $$;
create function erp_stock.document_lock(p_actor uuid,p_kind text,p_id uuid,p_version integer)
returns erp_documents.document language plpgsql set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 perform erp_stock.document_access(p_actor,p_kind);
 if p_id is null or p_version is null or p_version<1 then raise exception 'erp_document_stock_invalid_version' using errcode='22023';end if;
 select * into d from erp_documents.document where id=p_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002';end if;
 if d.version<>p_version or d.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001';end if;return d;
end $$;
create function erp_stock.document_summary(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'version',d.version,'status',d.status,
  'date',d.body->>'date','warehouse_id',d.warehouse_id,'eligible',erp_stock.document_eligible(d.kind,d.status),
  'active_posting_id',(select id from erp_stock.document_posting where document_id=d.id and state='active'))
 from erp_documents.document d where d.id=p_id;
$$;
create function erp_stock.document_posting_summary(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',id,'document_id',document_id,'source_document_version',document_version,'movement_id',movement_id,
  'state',state,'version',version,'created_at',created_at,'reversal_movement_id',reversal_movement_id,
  'reversed_at',reversed_at,'reason',reason,'occurred_on',snapshot->>'occurred_on',
  'direction',snapshot->>'direction','positions',jsonb_array_length(snapshot->'positions'),'ignored_items',jsonb_array_length(snapshot->'ignored'))
 from erp_stock.document_posting where id=p_id;
$$;
create function erp_stock.document_meta(p_day date,p_reason text)
returns void language plpgsql set search_path=pg_catalog as $$ begin
 if p_day is null or not isfinite(p_day) or p_day<date '1900-01-01' or p_day>(clock_timestamp() at time zone 'America/Sao_Paulo')::date
  or p_reason is null or length(btrim(p_reason)) not between 3 and 500 or p_reason~'[[:cntrl:]]' then
  raise exception 'erp_stock_invalid_command' using errcode='22023';end if;
end $$;
create function erp_stock.document_command_start(p_actor uuid,p_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$ declare c erp_stock.document_command;h text;begin
 perform erp_stock.require_access(p_actor,true);
 if p_id is null then raise exception 'erp_document_stock_command_required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852918,hashtext(p_id::text));
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
 select * into c from erp_stock.document_command where id=p_id;
 if found then if c.actor<>p_actor or c.request_hash<>h then raise exception 'erp_document_stock_command_conflict' using errcode='40001';end if;
  return c.result||'{"replayed":true}'::jsonb;end if;return null;
end $$;
create function erp_stock.document_command_finish(p_actor uuid,p_id uuid,p_action text,p_data jsonb,p_result jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$ declare r jsonb;begin
 r:=p_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
 insert into erp_stock.document_command(id,actor,request_hash,result) values(p_id,p_actor,
  encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'action',p_action,'data',p_data)::text,'UTF8')),'hex'),r);return r;
end $$;

create function erp_stock.document_preview_data(d erp_documents.document,p_day date,p_reason text)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare w erp_catalog.record;row record;ignored jsonb:='[]';positions jsonb;result jsonb;direction text;begin
 perform erp_stock.document_meta(p_day,p_reason);
 if not erp_stock.document_eligible(d.kind,d.status) then raise exception 'erp_document_stock_ineligible_state' using errcode='40001';end if;
 if exists(select 1 from erp_stock.document_posting where document_id=d.id and state='active') then raise exception 'erp_document_stock_already_posted' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);
 -- The 011 importer takes catalog rows in UUID order; never prelock catalog before the stock lock.
 perform 1 from erp_catalog.record where id=d.warehouse_id or id in(select product_id from erp_documents.item where document_id=d.id) order by id for update;
 perform 1 from erp_catalog.product where record_id in(select product_id from erp_documents.item where document_id=d.id) order by record_id for update;
 select r.* into w from erp_catalog.record r join erp_catalog.warehouse x on x.record_id=r.id where r.id=d.warehouse_id and r.active;
 if not found then raise exception 'erp_stock_warehouse_unavailable' using errcode='22023';end if;
 for row in select i.id,i.position,i.product_id,i.quantity,i.data,r.active,r.version,p.unit,p.kind,p.format
  from erp_documents.item i left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id
  where i.document_id=d.id order by i.position loop
  if row.product_id is null or row.kind='S' then
   ignored:=ignored||jsonb_build_array(jsonb_build_object('id',row.id,'position',row.position,'product_id',row.product_id,
    'description',row.data->>'description','quantity',row.quantity::text,'unit',row.data->>'unit','catalog_version',row.version,
    'reason',case when row.product_id is null then 'unlinked_item' else 'service' end));
  elsif row.kind is distinct from 'P' or not coalesce(row.active,false) or row.unit is null then
   raise exception 'erp_stock_product_unavailable' using errcode='22023';
  elsif row.format in('E','V') then raise exception 'erp_document_stock_composition_unsupported' using errcode='22023';
  elsif row.unit is distinct from row.data->>'unit' then raise exception 'erp_document_stock_unit_mismatch' using errcode='22023';end if;
 end loop;
 direction:=case when d.kind='purchase_orders' then 'receipt' else 'issue' end;
 with groups as(select i.product_id,sum(i.quantity) qty,jsonb_agg(jsonb_build_object('id',i.id,'position',i.position,'quantity',i.quantity::text) order by i.position) sources
  from erp_documents.item i join erp_catalog.product p on p.record_id=i.product_id where i.document_id=d.id and p.kind='P' group by i.product_id)
 select coalesce(jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',r.name,'catalog_version',r.version,
  'warehouse_id',w.id,'unit',p.unit,'quantity',(case when direction='issue' then -g.qty else g.qty end)::numeric(18,6)::text,
  'balance_before',coalesce(b.quantity,0)::numeric(18,6)::text,
  'balance_after',round(coalesce(b.quantity,0)+case when direction='issue' then -g.qty else g.qty end,6)::text,
  'expected_version',coalesce(b.version,0),'sources',g.sources) order by g.product_id),'[]') into positions
 from groups g join erp_catalog.record r on r.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id;
 if jsonb_array_length(positions) not between 1 and 100 then raise exception 'erp_document_stock_position_limit' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(positions) j where (j->>'balance_after')::numeric<0 or (j->>'balance_after')::numeric>999999999999.999999 or(j->>'expected_version')::integer=2147483647) then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 result:=jsonb_build_object('action','post','document',erp_stock.document_summary(d.id),'direction',direction,'occurred_on',p_day,'reason',p_reason,
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'positions',positions,'ignored',ignored);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;

create function public.erp_document_stock_list(p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null,p_query text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare result jsonb;begin
 perform erp_stock.document_access(p_user_id,p_kind);
 if p_limit is null or p_limit not between 1 and 100 or length(p_query)>100 or p_query~'[[:cntrl:]]' then raise exception 'erp_document_stock_invalid_query' using errcode='22023';end if;
 with page as materialized(select d.id from erp_documents.document d where d.kind=p_kind and(p_after is null or d.id>p_after)
  and(erp_stock.document_eligible(d.kind,d.status) or exists(select 1 from erp_stock.document_posting where document_id=d.id))
  and(p_query is null or strpos(d.number::text,btrim(p_query))>0) order by d.id limit p_limit+1),
 shown as materialized(select id from page order by id limit p_limit)
 select jsonb_build_object('kind',p_kind,'items',coalesce((select jsonb_agg(erp_stock.document_summary(id) order by id) from shown),'[]'),
  'limit',p_limit,'has_more',(select count(*)>p_limit from page),'next_cursor',case when(select count(*)>p_limit from page) then(select id from shown order by id desc limit 1) end,'data_mode','erp_native') into result;return result;
end $$;
create function public.erp_document_stock_get(p_user_id uuid,p_kind text,p_document_id uuid,p_limit integer default 25,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare rows jsonb;more boolean;cursor uuid;begin
 perform erp_stock.document_access(p_user_id,p_kind);
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_document_stock_invalid_query' using errcode='22023';end if;
 if not exists(select 1 from erp_documents.document where id=p_document_id and kind=p_kind) then raise exception 'erp_document_not_found' using errcode='P0002';end if;
 with page as materialized(select id from erp_stock.document_posting where document_id=p_document_id and(p_after is null or id>p_after) order by id limit p_limit+1),
 shown as materialized(select id from page order by id limit p_limit)
 select coalesce((select jsonb_agg(erp_stock.document_posting_summary(id) order by id) from shown),'[]'),(select count(*)>p_limit from page),(select id from shown order by id desc limit 1) into rows,more,cursor;
 return jsonb_build_object('document',erp_stock.document_summary(p_document_id),
  'items',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'position',position,'product_id',product_id,'description',data->>'description','code',data->>'code','unit',data->>'unit','quantity',quantity::text) order by position),'[]') from erp_documents.item where document_id=p_document_id),
  'active_posting',(select erp_stock.document_posting_summary(id) from erp_stock.document_posting where document_id=p_document_id and state='active'),
  'postings',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then cursor end,'data_mode','erp_native');
end $$;
create function public.erp_document_stock_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_occurred_on date,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 d:=erp_stock.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_stock.document_preview_data(d,p_occurred_on,p_reason),'data_mode','erp_native');
end $$;
create function public.erp_document_stock_post(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,p_preview_hash text,p_occurred_on date,p_reason text,p_ignored_item_ids jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;pid uuid;result jsonb;ack jsonb;wanted jsonb;begin
 data:=jsonb_build_object('kind',p_kind,'id',p_document_id,'version',p_expected_version,'hash',p_preview_hash,'date',p_occurred_on,'reason',p_reason,'ignored',p_ignored_item_ids);
 replay:=erp_stock.document_command_start(p_user_id,p_command_id,'post',data);if replay is not null then return replay;end if;
 d:=erp_stock.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);preview:=erp_stock.document_preview_data(d,p_occurred_on,p_reason);
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_stock_preview_conflict' using errcode='40001';end if;
 if p_ignored_item_ids is null or jsonb_typeof(p_ignored_item_ids)<>'array' or jsonb_array_length(p_ignored_item_ids)>250
  or exists(select 1 from jsonb_array_elements(p_ignored_item_ids) j where jsonb_typeof(j)<>'string' or(j#>>'{}')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then raise exception 'erp_document_stock_ignored_ack_required' using errcode='22023';end if;
 select coalesce(jsonb_agg(value order by value),'[]') into ack from jsonb_array_elements(p_ignored_item_ids);
 select coalesce(jsonb_agg(value->'id' order by value->'id'),'[]') into wanted from jsonb_array_elements(preview->'ignored');
 if ack<>wanted then raise exception 'erp_document_stock_ignored_ack_required' using errcode='22023';end if;
 if exists(select 1 from erp_stock.command where id=p_command_id) then raise exception 'erp_document_stock_command_conflict' using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('product_id',j->'product_id','warehouse_id',j->'warehouse_id','quantity',j->'quantity','expected_version',j->'expected_version') order by j->>'product_id') into items from jsonb_array_elements(preview->'positions') j;
 movement:=erp_stock.post(p_user_id,p_command_id,preview->>'direction',p_occurred_on,p_reason,'Documento '||d.kind||' '||d.number::text,items);
 insert into erp_stock.document_posting(document_id,document_version,movement_id,snapshot,preview_hash,actor,command_id)
  values(d.id,d.version,(movement#>>'{movement,id}')::uuid,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id) returning id into pid;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_stock.document_posting_summary(pid),'movement',movement->'movement');
 insert into erp_stock.document_audit(actor,command_id,document_id,posting_id,action,result) values(p_user_id,p_command_id,d.id,pid,'post',result);
 insert into erp_documents.audit(actor,command_id,document_id,action,after_data) values(p_user_id,p_command_id,d.id,'stock_post',result);
 return erp_stock.document_command_finish(p_user_id,p_command_id,'post',data,result);
end $$;

create function erp_stock.document_reverse_preview_data(d erp_documents.document,p_id uuid,p_version integer,p_day date,p_reason text)
returns jsonb language plpgsql set search_path=pg_catalog as $$ declare p erp_stock.document_posting;positions jsonb;result jsonb;begin
 perform erp_stock.document_meta(p_day,p_reason);
 select * into p from erp_stock.document_posting where id=p_id and document_id=d.id for update;
 if not found then raise exception 'erp_document_stock_not_found' using errcode='P0002';end if;
 if p_version is null or p_version<1 then raise exception 'erp_document_stock_invalid_version' using errcode='22023';end if;
 if p.version<>p_version or p.state<>'active' or p.version=2147483647 then raise exception 'erp_document_stock_version_conflict' using errcode='40001';end if;
 if p_day<(select occurred_on from erp_stock.movement where id=p.movement_id) then raise exception 'erp_stock_reversal_date_invalid' using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852909,0);
 perform 1 from erp_catalog.record where id in(select product_id from erp_stock.entry where movement_id=p.movement_id union select warehouse_id from erp_stock.entry where movement_id=p.movement_id) order by id for update;
 perform 1 from erp_catalog.product where record_id in(select product_id from erp_stock.entry where movement_id=p.movement_id) order by record_id for update;
 perform 1 from erp_stock.balance b join erp_stock.entry e on e.product_id=b.product_id and e.warehouse_id=b.warehouse_id where e.movement_id=p.movement_id order by b.product_id,b.warehouse_id for update of b;
 select jsonb_agg(jsonb_build_object('product_id',e.product_id,'product_name',r.name,'catalog_version',r.version,'warehouse_id',e.warehouse_id,
  'unit',e.unit,'quantity',(-e.quantity)::text,'balance_before',b.quantity::text,'balance_after',round(b.quantity-e.quantity,6)::text,
  'expected_version',b.version,'sources','[]'::jsonb) order by e.product_id,e.warehouse_id) into positions
 from erp_stock.entry e join erp_stock.balance b on b.product_id=e.product_id and b.warehouse_id=e.warehouse_id join erp_catalog.record r on r.id=e.product_id where e.movement_id=p.movement_id;
 if positions is null or jsonb_array_length(positions) not between 1 and 100 or exists(select 1 from jsonb_array_elements(positions) j where(j->>'balance_after')::numeric<0 or(j->>'balance_after')::numeric>999999999999.999999 or(j->>'expected_version')::integer=2147483647) then raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 result:=jsonb_build_object('action','reverse','document',erp_stock.document_summary(d.id),'posting',erp_stock.document_posting_summary(p.id),
  'direction','reversal','occurred_on',p_day,'reason',p_reason,'warehouse',p.snapshot->'warehouse','positions',positions,'ignored','[]'::jsonb);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;
create function public.erp_document_stock_reverse_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_posting_id uuid,p_posting_version integer,p_occurred_on date,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 d:=erp_stock.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_stock.document_reverse_preview_data(d,p_posting_id,p_posting_version,p_occurred_on,p_reason),'data_mode','erp_native');
end $$;
create function public.erp_document_stock_reverse(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_posting_id uuid,p_posting_version integer,p_command_id uuid,p_preview_hash text,p_occurred_on date,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;result jsonb;begin
 data:=jsonb_build_object('kind',p_kind,'id',p_document_id,'version',p_expected_version,'posting',p_posting_id,'posting_version',p_posting_version,'hash',p_preview_hash,'date',p_occurred_on,'reason',p_reason);
 replay:=erp_stock.document_command_start(p_user_id,p_command_id,'reverse',data);if replay is not null then return replay;end if;
 d:=erp_stock.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 preview:=erp_stock.document_reverse_preview_data(d,p_posting_id,p_posting_version,p_occurred_on,p_reason);
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_stock_preview_conflict' using errcode='40001';end if;
 if exists(select 1 from erp_stock.command where id=p_command_id) then raise exception 'erp_document_stock_command_conflict' using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('product_id',j->'product_id','warehouse_id',j->'warehouse_id','quantity',j->'quantity','expected_version',j->'expected_version') order by j->>'product_id') into items from jsonb_array_elements(preview->'positions') j;
 movement:=erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,'Estorno documento '||d.kind||' '||d.number::text,items,(preview#>>'{posting,movement_id}')::uuid);
 update erp_stock.document_posting set state='reversed',version=version+1,reversal_movement_id=(movement#>>'{movement,id}')::uuid,reversed_at=clock_timestamp(),reversed_by=p_user_id,reason=btrim(p_reason) where id=p_posting_id;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_stock.document_posting_summary(p_posting_id),'movement',movement->'movement');
 insert into erp_stock.document_audit(actor,command_id,document_id,posting_id,action,result) values(p_user_id,p_command_id,d.id,p_posting_id,'reverse',result);
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,after_data) values(p_user_id,p_command_id,d.id,'stock_reverse',btrim(p_reason),result);
 return erp_stock.document_command_finish(p_user_id,p_command_id,'reverse',data,result);
end $$;

-- Existing public reversal cannot detach a document effect. Global stock lock must
-- precede this check, including a race with an uncommitted document posting.
create or replace function public.erp_stock_reverse(p_user_id uuid,p_movement_id uuid,p_command_id uuid,p_occurred_on date,p_reason text,p_versions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare v_items jsonb;v_count integer;begin
 perform erp_stock.require_access(p_user_id,true);
 perform pg_advisory_xact_lock(174852909,0);
 if exists(select 1 from erp_stock.document_posting where movement_id=p_movement_id or reversal_movement_id=p_movement_id) then raise exception 'erp_stock_reverse_via_document' using errcode='40001';end if;
 if p_versions is null or jsonb_typeof(p_versions)<>'array' or jsonb_array_length(p_versions) not between 1 and 100
  or exists(select 1 from jsonb_array_elements(p_versions) j where jsonb_typeof(j)<>'object' or exists(select 1 from jsonb_object_keys(j) k where k not in('product_id','warehouse_id','expected_version'))) then raise exception 'erp_stock_invalid_versions' using errcode='22023';end if;
 select count(*) into v_count from erp_stock.entry where movement_id=p_movement_id;
 if v_count=0 then raise exception 'erp_stock_movement_not_found' using errcode='P0002';end if;
 select jsonb_agg(jsonb_build_object('product_id',e.product_id,'warehouse_id',e.warehouse_id,'quantity',(-e.quantity)::text,'expected_version',v->'expected_version') order by e.ordinal) into v_items
 from erp_stock.entry e join jsonb_array_elements(p_versions) v on v->>'product_id'=e.product_id::text and v->>'warehouse_id'=e.warehouse_id::text where e.movement_id=p_movement_id;
 if jsonb_array_length(p_versions)<>v_count or coalesce(jsonb_array_length(v_items),0)<>v_count then raise exception 'erp_stock_invalid_versions' using errcode='22023';end if;
 return erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,null,v_items,p_movement_id);
end $$;
revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$ declare f record;begin for f in select oid::regprocedure sig from pg_proc where pronamespace='public'::regnamespace and proname like 'erp_document_stock_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.sig);
 execute format('grant execute on function %s to service_role',f.sig);
end loop;end $$;
commit;
