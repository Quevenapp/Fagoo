-- Native CRM: canonical contacts, scoped ownership and atomic command receipts.
begin;
create table fagoo.crm_funnel(
 id uuid primary key default gen_random_uuid(),unit_id uuid not null references fagoo.unit(id),name text not null check(length(btrim(name)) between 1 and 120),
 stages jsonb not null check(jsonb_typeof(stages)='array'),active boolean not null default true,version integer not null default 1,unique(unit_id,id)
);
create table fagoo.crm_opportunity(
 id uuid primary key default gen_random_uuid(),unit_id uuid not null references fagoo.unit(id),funnel_id uuid not null,stage text not null,
 contact_id uuid not null references erp_catalog.contact(record_id),owner_id uuid not null references auth.users(id),title text not null check(length(btrim(title)) between 1 and 200),
 amount numeric(18,2) check(amount>=0),due_at timestamptz,notes text not null default '' check(length(notes)<=5000),
 document_id uuid references erp_documents.document(id),version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(unit_id,funnel_id) references fagoo.crm_funnel(unit_id,id),unique(unit_id,id)
);
create table fagoo.crm_task(
 id uuid primary key default gen_random_uuid(),unit_id uuid not null references fagoo.unit(id),opportunity_id uuid,
 contact_id uuid not null references erp_catalog.contact(record_id),owner_id uuid not null references auth.users(id),
 title text not null check(length(btrim(title)) between 1 and 200),due_at timestamptz not null,completed_at timestamptz,
 version integer not null default 1,created_at timestamptz not null default now(),foreign key(unit_id,opportunity_id) references fagoo.crm_opportunity(unit_id,id)
);
create table fagoo.crm_command(command_id uuid primary key,unit_id uuid not null references fagoo.unit(id),actor uuid not null references auth.users(id),request_hash text not null,result jsonb not null,created_at timestamptz not null default now());
create table fagoo.crm_event(id bigint generated always as identity primary key,unit_id uuid not null references fagoo.unit(id),contact_id uuid references erp_catalog.contact(record_id),opportunity_id uuid references fagoo.crm_opportunity(id),owner_id uuid references auth.users(id),actor uuid not null references auth.users(id),command_id uuid not null references fagoo.crm_command(command_id),kind text not null,title text not null,at timestamptz not null default now());
create index crm_opportunity_unit_owner on fagoo.crm_opportunity(unit_id,owner_id,updated_at desc);
create index crm_task_unit_owner on fagoo.crm_task(unit_id,owner_id,due_at);
create index crm_event_contact on fagoo.crm_event(unit_id,contact_id,at desc);
alter table fagoo.crm_funnel enable row level security;alter table fagoo.crm_opportunity enable row level security;alter table fagoo.crm_task enable row level security;alter table fagoo.crm_command enable row level security;alter table fagoo.crm_event enable row level security;

create function fagoo.crm_default_stages() returns jsonb language sql immutable set search_path=pg_catalog as $$
 select '[{"id":"new","name":"Novo","status":"open"},{"id":"contact","name":"Contato","status":"open"},{"id":"proposal","name":"Proposta","status":"open"},{"id":"negotiation","name":"Negociação","status":"open"},{"id":"won","name":"Ganho","status":"won"},{"id":"lost","name":"Perdido","status":"lost"}]'::jsonb
$$;
create function fagoo.crm_seed_unit() returns trigger language plpgsql set search_path=pg_catalog as $$begin insert into fagoo.crm_funnel(unit_id,name,stages) values(new.id,'Comercial',fagoo.crm_default_stages());return new;end $$;
create trigger crm_seed_unit after insert on fagoo.unit for each row execute function fagoo.crm_seed_unit();
insert into fagoo.crm_funnel(unit_id,name,stages) select id,'Comercial',fagoo.crm_default_stages() from fagoo.unit;

create function fagoo.crm_admin(p_user_id uuid) returns boolean language sql stable set search_path=pg_catalog as $$select exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin')$$;
create function fagoo.crm_visible(p_user_id uuid,p_unit_id uuid,p_owner_id uuid) returns boolean language sql stable set search_path=pg_catalog as $$
 select p_owner_id=p_user_id or fagoo.crm_admin(p_user_id) or exists(select 1 from fagoo.unit where id=p_unit_id and settings#>'{crm,shared_read}'='true'::jsonb)
$$;
create function fagoo.crm_owner(p_user_id uuid,p_unit_id uuid,p_owner_id uuid) returns void language plpgsql stable set search_path=pg_catalog as $$begin
 if p_owner_id is null or (p_owner_id<>p_user_id and not fagoo.crm_admin(p_user_id)) then raise exception 'crm_owner_denied' using errcode='42501';end if;
 perform fagoo.require_unit(p_owner_id,null,p_unit_id,'crm.write');perform fagoo.require_unit(p_owner_id,null,p_unit_id,'crm.read');
end $$;
create function fagoo.crm_document_visible(p_user_id uuid,p_document_id uuid) returns boolean language plpgsql stable set search_path=pg_catalog as $$declare v_kind text;begin
 if p_document_id is null then return false;end if;select kind into v_kind from erp_documents.document where id=p_document_id;if not found then return false;end if;
 perform erp_documents.require_access(p_user_id,v_kind,false);return true;
 exception when insufficient_privilege then return false;
end $$;

create function public.fagoo_crm_read(p_user_id uuid,p_unit_id uuid,p_section text default 'snapshot',p_query text default '',p_contact_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$declare v_contacts jsonb;v_scope uuid;begin
 perform fagoo.require_unit(p_user_id,null,p_unit_id,'crm.read');
 if p_section not in('snapshot','contacts') or length(p_query)>160 then raise exception 'crm_invalid_query' using errcode='22023';end if;
 v_scope:=erp_catalog.contact_scope(p_user_id);
 if p_contact_id is not null then perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);end if;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into v_contacts from(select r.id,r.name,r.active,c.email,c.phone,c.mobile from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id
 where r.active and erp_catalog.contact_visible_to(v_scope,r.id) and(p_contact_id is null or r.id=p_contact_id) and(p_query='' or strpos(lower(r.name),lower(p_query))>0 or strpos(coalesce(c.mobile,c.phone,''),p_query)>0) order by r.name,r.id limit 100)c;
 if p_section='contacts' then return jsonb_build_object('contacts',v_contacts);end if;
 return jsonb_build_object('unit_id',p_unit_id,'contacts',v_contacts,'can_configure',fagoo.crm_admin(p_user_id),
 'members',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'name',coalesce((select name from erp_access.profile where user_id=m.user_id),u.email,m.user_id::text)) order by u.email) from erp_access.membership m join auth.users u on u.id=m.user_id where m.active and(m.role='admin' or exists(select 1 from fagoo.unit_member um where um.unit_id=p_unit_id and um.user_id=m.user_id and um.capabilities@>array['crm.read','crm.write']))),'[]'),
 'funnels',coalesce((select jsonb_agg(to_jsonb(f) order by f.name) from fagoo.crm_funnel f where f.unit_id=p_unit_id),'[]'),
 'opportunities',coalesce((select jsonb_agg(to_jsonb(o)-'document_id'||jsonb_build_object('document_id',case when fagoo.crm_document_visible(p_user_id,o.document_id) then o.document_id else null end,'can_write',o.owner_id=p_user_id or fagoo.crm_admin(p_user_id)) order by o.updated_at desc) from fagoo.crm_opportunity o where o.unit_id=p_unit_id and fagoo.crm_visible(p_user_id,p_unit_id,o.owner_id) and erp_catalog.contact_visible_to(v_scope,o.contact_id) and(p_contact_id is null or o.contact_id=p_contact_id)),'[]'),
 'tasks',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('can_write',t.owner_id=p_user_id or fagoo.crm_admin(p_user_id)) order by t.due_at) from fagoo.crm_task t where t.unit_id=p_unit_id and fagoo.crm_visible(p_user_id,p_unit_id,t.owner_id) and erp_catalog.contact_visible_to(v_scope,t.contact_id) and(p_contact_id is null or t.contact_id=p_contact_id)),'[]'),
 'timeline',coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc,e.id desc) from(select e.id,e.contact_id,e.opportunity_id,e.kind,e.title,e.at from fagoo.crm_event e where e.unit_id=p_unit_id and fagoo.crm_visible(p_user_id,p_unit_id,e.owner_id) and erp_catalog.contact_visible_to(v_scope,e.contact_id) and(p_contact_id is null or e.contact_id=p_contact_id) order by e.at desc,e.id desc limit 200)e),'[]'));
end $$;

create function public.fagoo_crm_receipt(p_user_id uuid,p_unit_id uuid,p_command_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare v fagoo.crm_command;begin
 perform fagoo.require_unit(p_user_id,null,p_unit_id,'crm.read');select * into v from fagoo.crm_command where command_id=p_command_id and unit_id=p_unit_id and actor=p_user_id;
 return case when found then v.result||'{"replayed":true}'::jsonb else jsonb_build_object('status','not_found') end;
end $$;

create function public.fagoo_crm_command(p_user_id uuid,p_unit_id uuid,p_command_id uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_receipt fagoo.crm_command;v_result jsonb;v_id uuid;v_owner uuid;v_contact uuid;v_op uuid;v_title text;v_funnel fagoo.crm_funnel;v_old fagoo.crm_opportunity;v_task fagoo.crm_task;v_stage text;v_document uuid;v_keys text[];
begin
 perform fagoo.require_unit(p_user_id,null,p_unit_id,'crm.write');perform fagoo.require_unit(p_user_id,null,p_unit_id,'crm.read');
 if p_command_id is null or p_action is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>30000 then raise exception 'crm_invalid_command' using errcode='22023';end if;
 v_hash:=md5(jsonb_build_object('unit',p_unit_id,'action',p_action,'payload',p_payload)::text);
 perform pg_advisory_xact_lock(hashtextextended('crm-command:'||p_command_id::text,0));
 select * into v_receipt from fagoo.crm_command where command_id=p_command_id;
 if found then if v_receipt.actor<>p_user_id or v_receipt.unit_id<>p_unit_id or v_receipt.request_hash<>v_hash then raise exception 'crm_command_conflict' using errcode='23505';end if;return v_receipt.result||'{"replayed":true}'::jsonb;end if;
 -- One writer per unit gives stage edits and opportunity movement a consistent view.
 perform 1 from fagoo.unit where id=p_unit_id for update;
 v_keys:=case p_action when 'funnel.save' then array['id','name','stages','active','expected_version'] when 'opportunity.save' then array['id','title','contact_id','owner_id','funnel_id','stage','amount','due_at','notes','document_id','expected_version'] when 'opportunity.move' then array['id','stage','expected_version'] when 'task.save' then array['id','title','contact_id','owner_id','opportunity_id','due_at','expected_version'] when 'task.complete' then array['id','expected_version'] when 'note.add' then array['contact_id','opportunity_id','title'] else null end;
 if v_keys is null or exists(select 1 from jsonb_object_keys(p_payload) k where not k=any(v_keys)) then raise exception 'crm_invalid_command' using errcode='22023';end if;
 v_id:=coalesce((p_payload->>'id')::uuid,gen_random_uuid());v_owner:=coalesce((p_payload->>'owner_id')::uuid,p_user_id);v_contact:=(p_payload->>'contact_id')::uuid;v_op:=(p_payload->>'opportunity_id')::uuid;v_title:=btrim(p_payload->>'title');
 if p_action='funnel.save' then
  if not fagoo.crm_admin(p_user_id) then raise exception 'crm_configure_denied' using errcode='42501';end if;
  if length(btrim(p_payload->>'name')) not between 1 and 120 or jsonb_typeof(p_payload->'stages') is distinct from 'array' or jsonb_array_length(p_payload->'stages') not between 2 and 30
   or exists(select 1 from jsonb_array_elements(p_payload->'stages') s where jsonb_typeof(s)<>'object' or coalesce(s->>'id','')!~'^[a-z0-9_-]{1,40}$' or length(coalesce(btrim(s->>'name'),'')) not between 1 and 80 or coalesce(s->>'status','') not in('open','won','lost'))
   or (select count(*)<>count(distinct s->>'id') from jsonb_array_elements(p_payload->'stages') s) then raise exception 'crm_invalid_stages' using errcode='22023';end if;
  select * into v_funnel from fagoo.crm_funnel where id=v_id;
  if found then if v_funnel.unit_id<>p_unit_id then raise exception 'crm_access_denied' using errcode='42501';end if;
   if v_funnel.version is distinct from (p_payload->>'expected_version')::integer then raise exception 'crm_version_conflict' using errcode='40001';end if;
   if exists(select 1 from fagoo.crm_opportunity o where o.funnel_id=v_id and not exists(select 1 from jsonb_array_elements(p_payload->'stages') s where s->>'id'=o.stage)) then raise exception 'crm_stage_in_use' using errcode='23505';end if;
   update fagoo.crm_funnel set name=btrim(p_payload->>'name'),stages=p_payload->'stages',active=coalesce((p_payload->>'active')::boolean,true),version=version+1 where id=v_id;
  else insert into fagoo.crm_funnel(id,unit_id,name,stages) values(v_id,p_unit_id,btrim(p_payload->>'name'),p_payload->'stages');end if;
  v_title:='Funil atualizado';
 elsif p_action in('opportunity.save','opportunity.move') then
  select * into v_old from fagoo.crm_opportunity where id=v_id;
  if found then
   if v_old.unit_id<>p_unit_id or(v_old.owner_id<>p_user_id and not fagoo.crm_admin(p_user_id)) then raise exception 'crm_access_denied' using errcode='42501';end if;
   if v_old.version is distinct from (p_payload->>'expected_version')::integer then raise exception 'crm_version_conflict' using errcode='40001';end if;
   perform erp_catalog.contact_require_visible(p_user_id,v_old.contact_id);
  elsif p_action='opportunity.move' then raise exception 'crm_not_found' using errcode='P0002';end if;
  if p_action='opportunity.move' then v_owner:=v_old.owner_id;v_contact:=v_old.contact_id;v_title:=v_old.title;end if;
  perform fagoo.crm_owner(p_user_id,p_unit_id,v_owner);perform erp_catalog.contact_require_visible(p_user_id,v_contact);
  if not exists(select 1 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=v_contact and r.active) then raise exception 'crm_invalid_contact' using errcode='22023';end if;
  select * into v_funnel from fagoo.crm_funnel where id=case when p_action='opportunity.move' then v_old.funnel_id else (p_payload->>'funnel_id')::uuid end and unit_id=p_unit_id and active;
  v_stage:=p_payload->>'stage';if v_funnel.id is null or not exists(select 1 from jsonb_array_elements(v_funnel.stages) s where s->>'id'=v_stage) then raise exception 'crm_invalid_stage' using errcode='22023';end if;
  if p_action='opportunity.move' then update fagoo.crm_opportunity set stage=v_stage,version=version+1,updated_at=now() where id=v_id;
  else
   v_document:=(p_payload->>'document_id')::uuid;
   if v_document is not null and (not fagoo.crm_document_visible(p_user_id,v_document) or not exists(select 1 from erp_documents.document where id=v_document and contact_id=v_contact)) then raise exception 'crm_document_denied' using errcode='42501';end if;
   insert into fagoo.crm_opportunity(id,unit_id,funnel_id,stage,contact_id,owner_id,title,amount,due_at,notes,document_id)
   values(v_id,p_unit_id,v_funnel.id,v_stage,v_contact,v_owner,v_title,nullif(p_payload->>'amount','')::numeric,nullif(p_payload->>'due_at','')::timestamptz,coalesce(p_payload->>'notes',''),v_document)
   on conflict(id) do update set funnel_id=excluded.funnel_id,stage=excluded.stage,contact_id=excluded.contact_id,owner_id=excluded.owner_id,title=excluded.title,amount=excluded.amount,due_at=excluded.due_at,notes=excluded.notes,document_id=excluded.document_id,version=fagoo.crm_opportunity.version+1,updated_at=now();
  end if;v_op:=v_id;v_title:=case p_action when 'opportunity.move' then 'Etapa alterada: ' else 'Oportunidade salva: ' end||v_title;
 elsif p_action in('task.save','task.complete') then
  select * into v_task from fagoo.crm_task where id=v_id;
  if found then
   if v_task.unit_id<>p_unit_id or(v_task.owner_id<>p_user_id and not fagoo.crm_admin(p_user_id)) then raise exception 'crm_access_denied' using errcode='42501';end if;
   if v_task.version is distinct from(p_payload->>'expected_version')::integer then raise exception 'crm_version_conflict' using errcode='40001';end if;
   perform erp_catalog.contact_require_visible(p_user_id,v_task.contact_id);
  elsif p_action='task.complete' then raise exception 'crm_not_found' using errcode='P0002';end if;
  if p_action='task.complete' then v_owner:=v_task.owner_id;v_contact:=v_task.contact_id;v_op:=v_task.opportunity_id;v_title:=v_task.title;update fagoo.crm_task set completed_at=coalesce(completed_at,now()),version=version+1 where id=v_id;
  else
   perform fagoo.crm_owner(p_user_id,p_unit_id,v_owner);perform erp_catalog.contact_require_visible(p_user_id,v_contact);
   if not exists(select 1 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=v_contact and r.active) then raise exception 'crm_invalid_contact' using errcode='22023';end if;
   if v_op is not null and not exists(select 1 from fagoo.crm_opportunity where id=v_op and unit_id=p_unit_id and contact_id=v_contact and(owner_id=p_user_id or fagoo.crm_admin(p_user_id))) then raise exception 'crm_opportunity_denied' using errcode='42501';end if;
   insert into fagoo.crm_task(id,unit_id,opportunity_id,contact_id,owner_id,title,due_at) values(v_id,p_unit_id,v_op,v_contact,v_owner,v_title,(p_payload->>'due_at')::timestamptz)
   on conflict(id) do update set opportunity_id=excluded.opportunity_id,contact_id=excluded.contact_id,owner_id=excluded.owner_id,title=excluded.title,due_at=excluded.due_at,version=fagoo.crm_task.version+1;
  end if;v_title:=case p_action when 'task.complete' then 'Tarefa concluída: ' else 'Tarefa salva: ' end||v_title;
 elsif p_action='note.add' then
  perform erp_catalog.contact_require_visible(p_user_id,v_contact);
  if length(v_title) not between 1 and 2000 or not exists(select 1 from erp_catalog.contact where record_id=v_contact) then raise exception 'crm_invalid_note' using errcode='22023';end if;
  if v_op is not null and not exists(select 1 from fagoo.crm_opportunity where id=v_op and unit_id=p_unit_id and contact_id=v_contact and(owner_id=p_user_id or fagoo.crm_admin(p_user_id))) then raise exception 'crm_opportunity_denied' using errcode='42501';end if;
 end if;
 v_result:=jsonb_build_object('status','succeeded','id',v_id,'command_id',p_command_id,'action',p_action,'replayed',false);
 insert into fagoo.crm_command(command_id,unit_id,actor,request_hash,result) values(p_command_id,p_unit_id,p_user_id,v_hash,v_result);
 insert into fagoo.crm_event(unit_id,contact_id,opportunity_id,owner_id,actor,command_id,kind,title) values(p_unit_id,v_contact,v_op,v_owner,p_user_id,p_command_id,p_action,v_title);
 return v_result;
end $$;
revoke all on all tables in schema fagoo from public,anon,authenticated,service_role;
revoke all on all sequences in schema fagoo from public,anon,authenticated,service_role;
revoke all on function public.fagoo_crm_read(uuid,uuid,text,text,uuid),public.fagoo_crm_command(uuid,uuid,uuid,text,jsonb),public.fagoo_crm_receipt(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fagoo_crm_read(uuid,uuid,text,text,uuid),public.fagoo_crm_command(uuid,uuid,uuid,text,jsonb),public.fagoo_crm_receipt(uuid,uuid,uuid) to service_role;
commit;
