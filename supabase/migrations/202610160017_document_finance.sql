-- Ação explícita documento -> títulos. Sem baixa, caixa, banco, estoque ou emissão.
-- Locks: comando -> documento -> posting -> títulos UUID asc. Nunca título -> documento.
begin;
create table erp_finance.document_posting (
 id uuid primary key default gen_random_uuid(),document_id uuid not null references erp_documents.document(id),
 document_version integer not null check(document_version>0),group_id uuid not null unique,
 state text not null default 'active' check(state in('active','reversed')),version integer not null default 1 check(version>0),
 snapshot jsonb not null,preview_hash text not null check(preview_hash~'^[a-f0-9]{64}$'),
 actor uuid not null references auth.users(id),command_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),reversed_at timestamptz,reversed_by uuid references auth.users(id),reason text,
 check((state='active' and reversed_at is null and reversed_by is null and reason is null)
  or(state='reversed' and reversed_at is not null and reversed_by is not null and length(reason) between 3 and 1000))
);
create unique index erp_document_one_active_finance on erp_finance.document_posting(document_id) where state='active';
create index erp_document_finance_history on erp_finance.document_posting(document_id,id);
create table erp_finance.document_title (
 title_id uuid primary key references erp_finance.title(id),posting_id uuid not null references erp_finance.document_posting(id),
 position integer not null check(position between 1 and 120),unique(posting_id,position)
);
create table erp_finance.document_command (
 id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null,
 result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin foreach t in array array['document_posting','document_title','document_command'] loop
 execute format('alter table erp_finance.%I enable row level security',t);
 execute format('revoke all on erp_finance.%I from public,anon,authenticated,service_role',t);
end loop; end $$;

-- Shared with the independent stock bridge. Each bridge checks only its own active effect.
create function erp_documents.effects_transition_allowed(p_kind text,p_from text,p_to text)
returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_from=p_to or case p_kind
 when 'sales_orders' then (p_from='verified' and p_to='in_progress') or(p_from='in_progress' and p_to in('partially_fulfilled','fulfilled')) or(p_from='partially_fulfilled' and p_to='fulfilled')
 when 'purchase_orders' then (p_from='in_progress' and p_to in('partially_fulfilled','fulfilled')) or(p_from='partially_fulfilled' and p_to='fulfilled')
 when 'service_orders' then (p_from='approved' and p_to='in_progress') or(p_from='in_progress' and p_to in('waiting_parts','service_done')) or(p_from='waiting_parts' and p_to='in_progress') or(p_from='service_done' and p_to='finalized')
 else false end,false);
$$;
create function erp_finance.guard_posted_document()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ begin
 if exists(select 1 from erp_finance.document_posting where document_id=old.id and state='active') then
  if tg_op='DELETE' then raise exception 'erp_document_active_finance' using errcode='40001'; end if;
  if (to_jsonb(new)-array['status','version','updated_at','updated_by']) is distinct from (to_jsonb(old)-array['status','version','updated_at','updated_by'])
   or not erp_documents.effects_transition_allowed(old.kind,old.status,new.status) then raise exception 'erp_document_active_finance' using errcode='40001'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;return new;
end $$;
create trigger protect_document_finance before update or delete on erp_documents.document for each row execute function erp_finance.guard_posted_document();
create function erp_finance.guard_posted_item()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ declare d uuid; begin
 d:=case when tg_op='INSERT' then new.document_id else old.document_id end;
 if exists(select 1 from erp_finance.document_posting where state='active' and(document_id=d or(tg_op='UPDATE' and document_id=new.document_id))) then
  raise exception 'erp_document_active_finance' using errcode='40001'; end if;
 if tg_op='DELETE' then return old; end if;return new;
end $$;
create trigger protect_document_item_finance before insert or update or delete on erp_documents.item for each row execute function erp_finance.guard_posted_item();
create function erp_finance.guard_document_title()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ begin
 -- Do not acquire a document lock here: finance/CNAB take title locks first.
 if exists(select 1 from erp_finance.document_title where title_id=old.id) then
  if tg_op='DELETE' then raise exception 'erp_finance_source_locked' using errcode='40001'; end if;
  if new.id is distinct from old.id or new.group_id is distinct from old.group_id or new.installment is distinct from old.installment
   or new.installments is distinct from old.installments or new.kind is distinct from old.kind or new.contact_id is distinct from old.contact_id
   or new.issued_on is distinct from old.issued_on or new.amount_cents is distinct from old.amount_cents then
   raise exception 'erp_finance_source_locked' using errcode='40001'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;return new;
end $$;
create trigger protect_finance_document_source before update or delete on erp_finance.title for each row execute function erp_finance.guard_document_title();

create function erp_finance.document_lock(p_actor uuid,p_kind text,p_document uuid,p_version integer)
returns erp_documents.document language plpgsql set search_path=pg_catalog as $$ declare d erp_documents.document; begin
 perform erp_finance.require_access(p_actor,true);perform erp_documents.require_access(p_actor,p_kind,false);
 if p_document is null or p_version is null or p_version<1 then raise exception 'erp_document_finance_invalid_version' using errcode='22023'; end if;
 select * into d from erp_documents.document where id=p_document and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if d.version<>p_version or d.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;return d;
end $$;
create function erp_finance.document_command_start(p_actor uuid,p_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$ declare c erp_finance.document_command;h text;begin
 perform erp_finance.require_access(p_actor,true);
 if p_id is null then raise exception 'erp_document_finance_command_required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(174852917,hashtext(p_id::text));
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
 select * into c from erp_finance.document_command where id=p_id;
 if found then if c.actor<>p_actor or c.request_hash<>h then raise exception 'erp_document_finance_command_conflict' using errcode='40001'; end if;
  return c.result||jsonb_build_object('replayed',true);end if;return null;
end $$;
create function erp_finance.document_command_finish(p_actor uuid,p_id uuid,p_action text,p_data jsonb,p_result jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$ declare r jsonb;begin
 r:=p_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false,'cash_movement_performed',false);
 insert into erp_finance.document_command(id,actor,request_hash,result)values(p_id,p_actor,encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'action',p_action,'data',p_data)::text,'UTF8')),'hex'),r);return r;
end $$;
create function erp_finance.document_posting_summary(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',p.id,'document_id',p.document_id,'source_document_version',p.document_version,'group_id',p.group_id,'state',p.state,'version',p.version,
  'kind',p.snapshot->>'kind','number',p.snapshot->>'number','direction',p.snapshot->>'direction','total_cents',p.snapshot->>'total_cents',
  'installments',jsonb_array_length(p.snapshot->'installments'),'plan_source',p.snapshot->>'plan_source','created_at',p.created_at,'reversed_at',p.reversed_at,'reason',p.reason)
 from erp_finance.document_posting p where id=p_id;
$$;
create function erp_finance.document_title_rows(p_posting uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'position',l.position,'version',t.version,'due_on',t.due_on,'amount_cents',t.amount_cents::text,
  'settled_cents',t.settled_cents::text,'balance_cents',(t.amount_cents-t.settled_cents)::text,'cancelled',t.cancelled,
  'category_id',t.category_id,'description',t.description,'cnab_linked',exists(select 1 from erp_cnab.billing_title b where b.title_id=t.id)) order by l.position),'[]')
 from erp_finance.document_title l join erp_finance.title t on t.id=l.title_id where l.posting_id=p_posting;
$$;
create function erp_finance.document_preview_data(d erp_documents.document,p_category uuid,p_plan jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare direction text;c erp_catalog.record;g erp_finance.category;issued date;total bigint;amount bigint;due date;part jsonb;parts jsonb:='[]';n integer:=0;sum_cents numeric:=0;source text;r jsonb;begin
 if not(case d.kind when 'sales_orders' then d.status in('verified','in_progress','partially_fulfilled','fulfilled')
  when 'purchase_orders' then d.status in('in_progress','partially_fulfilled','fulfilled')
  when 'service_orders' then d.status in('approved','in_progress','waiting_parts','service_done','finalized') else false end) then
  raise exception 'erp_document_finance_ineligible_state' using errcode='40001';end if;
 if exists(select 1 from erp_finance.document_posting where document_id=d.id and state='active') then raise exception 'erp_document_finance_already_posted' using errcode='40001';end if;
 direction:=case when d.kind='purchase_orders' then 'payable' else 'receivable' end;
 select r.* into c from erp_catalog.record r join erp_catalog.contact x on x.record_id=r.id where r.id=d.contact_id and r.active for share of r,x;
 if not found then raise exception 'erp_finance_invalid_contact' using errcode='22023';end if;
 if p_category is not null then select * into g from erp_finance.category where id=p_category and active and kind in(direction,'both') for share;
  if not found then raise exception 'erp_finance_invalid_category' using errcode='22023';end if;end if;
 issued:=erp_finance.day(d.body->'date');total:=(d.total*100)::bigint;
 if total<=0 then raise exception 'erp_document_finance_zero_total' using errcode='22023';end if;
 if jsonb_array_length(d.body->'installments')>0 then
  if p_plan is not null then raise exception 'erp_document_finance_saved_plan_required' using errcode='22023';end if;source:='document';
 else source:='explicit';if p_plan is null or jsonb_typeof(p_plan)<>'array' or jsonb_array_length(p_plan) not between 1 and 120 or octet_length(p_plan::text)>32768 then
  raise exception 'erp_document_finance_plan_required' using errcode='22023';end if;end if;
 for part in select value from jsonb_array_elements(case when source='document' then d.body->'installments' else p_plan end) loop
  if source='explicit' then perform erp_finance.keys(part,array['amount_cents','due_on','method']);amount:=erp_finance.cents(part->'amount_cents',false);due:=erp_finance.day(part->'due_on');
  else amount:=(erp_documents.decimal_value(part->'amount',2,12)*100)::bigint;due:=erp_finance.day(part->'due_date');end if;
  if amount<=0 or due<issued then raise exception 'erp_document_finance_invalid_installment' using errcode='22023';end if;
  n:=n+1;sum_cents:=sum_cents+amount;
  parts:=parts||jsonb_build_array(jsonb_build_object('position',n,'amount_cents',amount::text,'due_on',due,'method',erp_finance.txt(part,'method',100)));
 end loop;
 if sum_cents<>total or n not between 1 and 120 then raise exception 'erp_finance_installment_total_mismatch' using errcode='22023';end if;
 r:=jsonb_build_object('document_id',d.id,'kind',d.kind,'number',d.number::text,'document_version',d.version,'status',d.status,
  'contact_id',d.contact_id,'contact_name',d.contact_snapshot->>'name','contact_version',c.version,'issued_on',issued,'direction',direction,'total_cents',total::text,
  'category_id',g.id,'category_name',g.name,'category_version',g.version,'plan_source',source,'installments',parts);
 return r||jsonb_build_object('preview_hash',encode(sha256(convert_to(r::text,'UTF8')),'hex'));
end $$;

create function public.erp_document_finance_list(p_user_id uuid,p_kind text,p_document_id uuid,p_limit integer default 25,p_after uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;rows jsonb;more boolean;cursor uuid;begin
 perform erp_finance.require_access(p_user_id,false);perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_document_finance_invalid_query' using errcode='22023';end if;
 select * into d from erp_documents.document where id=p_document_id and kind=p_kind;if not found then raise exception 'erp_document_not_found' using errcode='P0002';end if;
 with page as materialized(select id from erp_finance.document_posting where document_id=d.id and(p_after is null or id>p_after) order by id limit p_limit+1),
 shown as materialized(select id from page order by id limit p_limit)
 select coalesce((select jsonb_agg(erp_finance.document_posting_summary(id) order by id) from shown),'[]'),(select count(*)>p_limit from page),(select id from shown order by id desc limit 1) into rows,more,cursor;
 return jsonb_build_object('document_id',d.id,'kind',d.kind,'number',d.number::text,'document_version',d.version,
  'active_posting', (select erp_finance.document_posting_summary(id) from erp_finance.document_posting where document_id=d.id and state='active'),
  'items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then cursor else null end,'data_mode','erp_native');
end $$;
create function public.erp_document_finance_get(p_user_id uuid,p_kind text,p_document_id uuid,p_posting_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 perform erp_finance.require_access(p_user_id,false);perform erp_documents.require_access(p_user_id,p_kind,false);
 select * into d from erp_documents.document where id=p_document_id and kind=p_kind;
 if not found or not exists(select 1 from erp_finance.document_posting where id=p_posting_id and document_id=d.id) then raise exception 'erp_document_finance_not_found' using errcode='P0002';end if;
 return jsonb_build_object('document_id',d.id,'document_version',d.version,'posting',erp_finance.document_posting_summary(p_posting_id),
  'titles',erp_finance.document_title_rows(p_posting_id),'data_mode','erp_native');
end $$;
create function public.erp_document_finance_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_category_id uuid default null,p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_finance.document_preview_data(d,p_category_id,p_plan),'data_mode','erp_native','cash_movement_performed',false);
end $$;
create function public.erp_document_finance_post(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,p_preview_hash text,p_category_id uuid default null,p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;pid uuid;gid uuid:=gen_random_uuid();tid uuid;part jsonb;label text;result jsonb;before_doc jsonb;begin
 data:=jsonb_build_object('kind',p_kind,'document_id',p_document_id,'version',p_expected_version,'preview_hash',p_preview_hash,'category_id',p_category_id,'plan',p_plan);
 replay:=erp_finance.document_command_start(p_user_id,p_command_id,'post',data);if replay is not null then return replay;end if;
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);preview:=erp_finance.document_preview_data(d,p_category_id,p_plan);
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_finance_preview_conflict' using errcode='40001';end if;
 before_doc:=erp_documents.dto(d.id);
 insert into erp_finance.document_posting(document_id,document_version,group_id,snapshot,preview_hash,actor,command_id)
 values(d.id,d.version,gid,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id) returning id into pid;
 label:=case d.kind when 'sales_orders' then 'Pedido de venda' when 'purchase_orders' then 'Pedido de compra' else 'Ordem de serviço' end||' nº '||d.number::text;
 for part in select value from jsonb_array_elements(preview->'installments') loop
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,amount_cents)
  values(gid,(part->>'position')::integer,jsonb_array_length(preview->'installments'),preview->>'direction',d.contact_id,p_category_id,label,
   (preview->>'issued_on')::date,(part->>'due_on')::date,(part->>'amount_cents')::bigint) returning id into tid;
  insert into erp_finance.document_title(title_id,posting_id,position)values(tid,pid,(part->>'position')::integer);
 end loop;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_finance.document_posting_summary(pid),'titles',erp_finance.document_title_rows(pid));
 insert into erp_finance.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'document_post',null,result);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)values(p_user_id,p_command_id,d.id,'finance_post',before_doc,result);
 return erp_finance.document_command_finish(p_user_id,p_command_id,'post',data,result);
end $$;

create function erp_finance.document_reverse_preview_data(d erp_documents.document,p_posting uuid,p_version integer)
returns jsonb language plpgsql set search_path=pg_catalog as $$ declare p erp_finance.document_posting;t jsonb;r jsonb;begin
 select * into p from erp_finance.document_posting where id=p_posting and document_id=d.id for update;
 if not found then raise exception 'erp_document_finance_not_found' using errcode='P0002';end if;
 if p_version is null or p_version<1 then raise exception 'erp_document_finance_invalid_version' using errcode='22023';end if;
 if p.version<>p_version or p.state<>'active' or p.version=2147483647 then raise exception 'erp_document_finance_version_conflict' using errcode='40001';end if;
 perform 1 from erp_finance.title t join erp_finance.document_title l on l.title_id=t.id where l.posting_id=p.id order by t.id for update of t;
 -- Recheck after acquiring every title lock. CNAB reserve and settlements use these same rows.
 if exists(select 1 from erp_finance.title t join erp_finance.document_title l on l.title_id=t.id where l.posting_id=p.id and(t.settled_cents<>0 or t.version=2147483647))
  or exists(select 1 from erp_cnab.billing_title b join erp_finance.document_title l on l.title_id=b.title_id where l.posting_id=p.id) then
  raise exception 'erp_document_finance_reverse_blocked' using errcode='40001';end if;
 t:=erp_finance.document_title_rows(p.id);
 if jsonb_array_length(t)<>jsonb_array_length(p.snapshot->'installments') then raise exception 'erp_document_finance_group_incomplete' using errcode='40001';end if;
 r:=jsonb_build_object('document_id',d.id,'document_version',d.version,'posting',erp_finance.document_posting_summary(p.id),'titles',t);
 return r||jsonb_build_object('preview_hash',encode(sha256(convert_to(r::text,'UTF8')),'hex'));
end $$;
create function public.erp_document_finance_reverse_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_posting_id uuid,p_posting_version integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_finance.document_reverse_preview_data(d,p_posting_id,p_posting_version),'data_mode','erp_native','cash_movement_performed',false);
end $$;
create function public.erp_document_finance_reverse(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_posting_id uuid,p_posting_version integer,p_command_id uuid,p_preview_hash text,p_title_versions jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;expected jsonb;actual jsonb;part jsonb;note text;result jsonb;before_doc jsonb;begin
 data:=jsonb_build_object('kind',p_kind,'document_id',p_document_id,'version',p_expected_version,'posting_id',p_posting_id,'posting_version',p_posting_version,
  'preview_hash',p_preview_hash,'title_versions',p_title_versions,'reason',p_reason);
 replay:=erp_finance.document_command_start(p_user_id,p_command_id,'reverse',data);if replay is not null then return replay;end if;
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 preview:=erp_finance.document_reverse_preview_data(d,p_posting_id,p_posting_version);
 note:=erp_documents.text_value(to_jsonb(p_reason),1000,true);
 if length(note)<3 then raise exception 'erp_document_finance_reason_required' using errcode='22023';end if;
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_finance_preview_conflict' using errcode='40001';end if;
 if p_title_versions is null or jsonb_typeof(p_title_versions)<>'array' or jsonb_array_length(p_title_versions) not between 1 and 120 or octet_length(p_title_versions::text)>32768 then
  raise exception 'erp_document_finance_titles_required' using errcode='22023';end if;
 for part in select value from jsonb_array_elements(p_title_versions) loop
  perform erp_finance.keys(part,array['id','version']);perform erp_finance.uuid_value(part->'id');perform erp_finance.expected(part->'version');end loop;
 select jsonb_agg(jsonb_build_object('id',value->>'id','version',(value->>'version')::integer) order by value->>'id') into expected from jsonb_array_elements(p_title_versions);
 select jsonb_agg(jsonb_build_object('id',value->>'id','version',(value->>'version')::integer) order by value->>'id') into actual from jsonb_array_elements(preview->'titles');
 if expected is distinct from actual then raise exception 'erp_document_finance_title_version_conflict' using errcode='40001';end if;
 before_doc:=erp_documents.dto(d.id);
 update erp_finance.title t set cancelled=true,version=version+1,updated_at=clock_timestamp() from erp_finance.document_title l
  where l.title_id=t.id and l.posting_id=p_posting_id and not t.cancelled;
 update erp_finance.document_posting set state='reversed',version=version+1,reversed_at=clock_timestamp(),reversed_by=p_user_id,reason=note where id=p_posting_id;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_finance.document_posting_summary(p_posting_id),'titles',erp_finance.document_title_rows(p_posting_id));
 insert into erp_finance.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'document_reverse',preview-'preview_hash',result);
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)values(p_user_id,p_command_id,d.id,'finance_reverse',note,before_doc,result);
 return erp_finance.document_command_finish(p_user_id,p_command_id,'reverse',data,result);
end $$;

revoke all on function erp_documents.effects_transition_allowed(text,text,text) from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_finance from public,anon,authenticated,service_role;
do $$ declare f record;begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'erp_document_finance_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
end loop;end $$;
commit;
