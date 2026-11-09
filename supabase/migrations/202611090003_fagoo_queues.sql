-- Filas na nuvem: estado, recibo idempotente e efeitos confirmam na mesma transação.
-- A revisão pertence à unidade; nenhum aparelho conserva autoridade operacional.
begin;
do $$begin
 if to_regprocedure('fagoo.require_unit(uuid,uuid,uuid,text)') is null then
  raise exception 'queues_requires_fagoo_identity';
 end if;
end$$;

create table fagoo.queue_runtime(
 unit_id uuid primary key references fagoo.unit(id), revision bigint not null default 0 check(revision>=0)
);
create table fagoo.queue_config(
 unit_id uuid primary key references fagoo.unit(id),
 template text not null default 'sinal' check(template in('sinal','clinica','terminal','vitrine','sol')),
 functions text[] not null default array['emitir','chamada','pedidos'] check(cardinality(functions)>0 and functions <@ array['emitir','chamada','pedidos']),
 ratings_enabled boolean not null default true, media_enabled boolean not null default true,
 call_ttl_seconds integer not null default 300 check(call_ttl_seconds between 15 and 3600),
 title text not null default '' check(length(title)<=120), footer text not null default '' check(length(footer)<=240),
 version bigint not null default 1
);
create table fagoo.queue_line(
 id uuid primary key default gen_random_uuid(), unit_id uuid not null references fagoo.unit(id),
 name text not null check(length(btrim(name)) between 1 and 80), prefix text not null check(prefix~'^[A-Z]{1,4}$'),
 priority integer not null default 0 check(priority between -1000 and 1000),
 regulars_per_priority integer not null default 0 check(regulars_per_priority between 0 and 100),
 regulars_since_priority integer, active boolean not null default true, version bigint not null default 1,
 unique(unit_id,id)
);
create table fagoo.queue_counter(
 unit_id uuid not null, queue_id uuid not null, business_day date not null, last_number integer not null check(last_number>0),
 primary key(unit_id,queue_id,business_day), foreign key(unit_id,queue_id) references fagoo.queue_line(unit_id,id)
);
create table fagoo.queue_ticket(
 id uuid primary key default gen_random_uuid(), unit_id uuid not null references fagoo.unit(id),
 original_queue_id uuid not null, queue_id uuid not null, business_day date not null,
 number integer not null, display_number text not null, priority boolean not null default false,
 status text not null default 'aguardando' check(status in('aguardando','chamada','em_atendimento','concluida','ausente','cancelada')),
 public_token text not null unique default replace(gen_random_uuid()::text,'-',''),
 issued_at timestamptz not null default clock_timestamp(), called_at timestamptz, last_called_at timestamptz,
 closed_at timestamptz, reason text check(length(reason)<=240), desk text check(length(desk)<=40),
 reserved_desk text check(length(reserved_desk)<=40),
 issued_by_user uuid references auth.users(id), issued_by_device uuid references fagoo.device(id),
 operator_user_id uuid references auth.users(id), operator_device_id uuid references fagoo.device(id),
 phone text check(phone~'^[1-9][0-9]{9,14}$'), recalls integer not null default 0, transfers integer not null default 0,
 version bigint not null default 1,
 unique(unit_id,id), unique(unit_id,original_queue_id,business_day,number),
 foreign key(unit_id,original_queue_id) references fagoo.queue_line(unit_id,id),
 foreign key(unit_id,queue_id) references fagoo.queue_line(unit_id,id)
);
create index fagoo_ticket_waiting on fagoo.queue_ticket(unit_id,status,issued_at,id);
create table fagoo.queue_service(
 id uuid primary key default gen_random_uuid(), unit_id uuid not null, ticket_id uuid not null unique,
 desk text not null, user_id uuid references auth.users(id), device_id uuid references fagoo.device(id),
 started_at timestamptz not null, finished_at timestamptz, result text,
 foreign key(unit_id,ticket_id) references fagoo.queue_ticket(unit_id,id)
);
create table fagoo.queue_order(
 id uuid primary key default gen_random_uuid(), unit_id uuid not null references fagoo.unit(id),
 code text not null check(length(btrim(code)) between 1 and 40),
 status text not null default 'recebido' check(status in('recebido','em_preparo','pronto','retirado','cancelado')),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 version bigint not null default 1, unique(unit_id,id)
);
create table fagoo.queue_campaign(
 id uuid primary key default gen_random_uuid(), unit_id uuid not null references fagoo.unit(id),
 title text not null check(length(btrim(title)) between 1 and 120), media_url text not null check(length(media_url)<=2048 and media_url~'^https://[^/@?#[:space:]]+(/[^[:space:]]*)?$'),
 media_type text not null check(media_type in('image','video')), sha256 text check(sha256~'^[a-f0-9]{64}$'),
 starts_at timestamptz not null, expires_at timestamptz not null, duration_seconds integer not null default 10 check(duration_seconds between 3 and 300),
 priority integer not null default 0, surfaces text[] not null default array['emitir','chamada','pedidos'] check(cardinality(surfaces)>0 and surfaces <@ array['emitir','chamada','pedidos']),
 active boolean not null default true, version bigint not null default 1, check(expires_at>starts_at), unique(unit_id,id)
);
create table fagoo.queue_event(
 unit_id uuid not null references fagoo.unit(id), revision bigint not null,
 id uuid not null unique default gen_random_uuid(), type text not null, aggregate_id uuid,
 user_id uuid references auth.users(id), device_id uuid references fagoo.device(id),
 occurred_at timestamptz not null default clock_timestamp(), payload jsonb not null, public_payload jsonb not null,
 primary key(unit_id,revision)
);
create table fagoo.queue_receipt(
 unit_id uuid not null references fagoo.unit(id), command_id uuid not null,
 user_id uuid references auth.users(id), device_id uuid references fagoo.device(id),
 command_type text not null, input jsonb not null, expected_version bigint,
 response jsonb not null, created_at timestamptz not null default clock_timestamp(), primary key(unit_id,command_id)
);
create table fagoo.queue_effect(
 id uuid primary key default gen_random_uuid(), unit_id uuid not null references fagoo.unit(id),
 event_id uuid not null references fagoo.queue_event(id), device_id uuid not null references fagoo.device(id),
 kind text not null check(kind in('print','audio')), payload jsonb not null,
 status text not null default 'pending' check(status in('pending','claimed','done','failed','uncertain','expired')),
 expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp(),
 claim_id uuid, claimed_at timestamptz, acknowledged_at timestamptz, result text,
 unique(event_id,device_id,kind)
);
create index fagoo_effect_due on fagoo.queue_effect(unit_id,device_id,kind,status,created_at);
create table fagoo.queue_rating_invite(
 id uuid primary key default gen_random_uuid(), unit_id uuid not null, ticket_id uuid not null,
 service_id uuid references fagoo.queue_service(id), created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null, requested_by uuid references auth.users(id),
 foreign key(unit_id,ticket_id) references fagoo.queue_ticket(unit_id,id)
);
create table fagoo.queue_rating(
 id uuid primary key default gen_random_uuid(), invite_id uuid not null unique references fagoo.queue_rating_invite(id),
 stars integer not null check(stars between 1 and 5), comment text check(length(comment)<=500),
 received_at timestamptz not null default clock_timestamp()
);
-- Fila durável para o adaptador de comunicação. Nunca contém permissão para envio pago.
create table fagoo.queue_subscription(
 id uuid primary key default gen_random_uuid(),unit_id uuid not null references fagoo.unit(id),
 ticket_id uuid,public_token text not null check(public_token~'^[A-Za-z0-9_-]{22,128}$'),
 channel text not null check(channel in('whatsapp','push_fcm','push_apns')),
 destination text not null check(length(destination) between 8 and 4096),
 destination_hash text not null check(destination_hash~'^[a-f0-9]{64}$'),
 status text not null default 'active' check(status in('pending','active','revoked')),
 created_at timestamptz not null default clock_timestamp(),activated_at timestamptz,
 unique(unit_id,public_token,channel,destination_hash),foreign key(unit_id,ticket_id) references fagoo.queue_ticket(unit_id,id)
);
create function fagoo.queue_subscription_hash() returns trigger language plpgsql set search_path=pg_catalog as $$
begin new.destination_hash:=encode(sha256(convert_to(new.destination,'UTF8')),'hex');return new;end$$;
create trigger queue_subscription_hash before insert or update of destination on fagoo.queue_subscription for each row execute function fagoo.queue_subscription_hash();
create table fagoo.queue_notice(
 id uuid primary key default gen_random_uuid(), unit_id uuid not null, ticket_id uuid not null,
 event_id uuid not null references fagoo.queue_event(id), kind text not null check(kind in('confirmation','call','rating')),
 subscription_id uuid references fagoo.queue_subscription(id),channel text not null default 'whatsapp' check(channel in('whatsapp','push_fcm','push_apns')),
 destination text not null, expires_at timestamptz not null, free_only boolean not null default true check(free_only),
 status text not null default 'pending' check(status in('pending','claimed','sent','failed','unknown','expired')),
 delivery_id text, claim_id uuid,claimed_at timestamptz,acknowledged_at timestamptz,created_at timestamptz not null default clock_timestamp(),
 unique(event_id,kind,subscription_id), foreign key(unit_id,ticket_id) references fagoo.queue_ticket(unit_id,id)
);

create function fagoo.queue_schedule_notice(p_unit uuid,p_ticket uuid,p_event uuid,p_kind text,p_expires timestamptz) returns void
language sql set search_path=pg_catalog as $$
 insert into fagoo.queue_notice(unit_id,ticket_id,event_id,subscription_id,channel,kind,destination,expires_at)
 select p_unit,p_ticket,p_event,s.id,s.channel,p_kind,s.destination,p_expires from fagoo.queue_subscription s
 where s.unit_id=p_unit and s.ticket_id=p_ticket and s.status='active' and(p_kind='call' or s.channel='whatsapp')
 on conflict(event_id,kind,subscription_id)do nothing;
$$;

create function fagoo.queue_ticket_dto(t fagoo.queue_ticket,p_public boolean default false)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',t.id,'queue_id',t.queue_id,'original_queue_id',t.original_queue_id,
 'number',t.number,'display_number',t.display_number,'business_day',t.business_day,'priority',t.priority,'status',t.status,
 'issued_at',t.issued_at,'called_at',t.called_at,'last_called_at',t.last_called_at,'closed_at',t.closed_at,
 'desk',t.desk,'recalls',t.recalls,'transfers',t.transfers,'version',t.version)
 ||case when p_public then '{}'::jsonb else jsonb_build_object('reserved_desk',t.reserved_desk,'operator_user_id',t.operator_user_id,
 'operator_device_id',t.operator_device_id,'public_token',t.public_token,'phone',t.phone,'reason',t.reason) end
$$;
create function fagoo.queue_event_add(p_unit uuid,p_type text,p_id uuid,p_user uuid,p_device uuid,p_payload jsonb,p_public jsonb)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare r bigint; eid uuid;
begin
 update fagoo.queue_runtime set revision=revision+1 where unit_id=p_unit returning revision into r;
 if r is null then raise exception 'queue_runtime_missing'; end if;
 insert into fagoo.queue_event(unit_id,revision,type,aggregate_id,user_id,device_id,payload,public_payload)
 values(p_unit,r,p_type,p_id,p_user,p_device,p_payload,p_public) returning id into eid;
 return eid;
end$$;
create function fagoo.queue_prepare(p_unit uuid) returns void language plpgsql set search_path=pg_catalog as $$
begin
 insert into fagoo.queue_runtime(unit_id) values(p_unit) on conflict do nothing;
 perform 1 from fagoo.queue_runtime where unit_id=p_unit for update;
 insert into fagoo.queue_config(unit_id) values(p_unit) on conflict do nothing;
 if not exists(select 1 from fagoo.queue_line where unit_id=p_unit) then
  insert into fagoo.queue_line(unit_id,name,prefix) values(p_unit,'Geral','A');
 end if;
end$$;
create function fagoo.queue_close_day(p_unit uuid) returns void language plpgsql set search_path=pg_catalog as $$
declare t fagoo.queue_ticket; today date;
begin
 select (clock_timestamp() at time zone timezone)::date into today from fagoo.unit where id=p_unit;
 for t in select * from fagoo.queue_ticket where unit_id=p_unit and business_day<today and status in('aguardando','chamada','em_atendimento') order by issued_at,id loop
  update fagoo.queue_ticket set status=case when status='em_atendimento' then 'concluida' else 'ausente' end,
   closed_at=clock_timestamp(),reason='fim do expediente',reserved_desk=null,version=version+1 where id=t.id returning * into t;
  update fagoo.queue_service set finished_at=clock_timestamp(),result='concluido' where ticket_id=t.id and finished_at is null;
  perform fagoo.queue_event_add(p_unit,'ticket.day_closed',t.id,null,null,jsonb_build_object('ticket',fagoo.queue_ticket_dto(t)),jsonb_build_object('ticket',fagoo.queue_ticket_dto(t,true)));
 end loop;
 update fagoo.queue_notice n set status='expired' where n.unit_id=p_unit and n.status='pending' and
  (n.expires_at<=clock_timestamp() or (n.kind='call' and not exists(select 1 from fagoo.queue_ticket qt where qt.id=n.ticket_id and qt.status='chamada')));
end$$;

create function public.fagoo_queue_command(p_user_id uuid,p_device_id uuid,p_unit_id uuid,p_command_id uuid,p_type text,p_payload jsonb,p_expected_version bigint default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare cap text; old fagoo.queue_receipt; q fagoo.queue_line; t fagoo.queue_ticket; o fagoo.queue_order;
 cfg fagoo.queue_config; camp fagoo.queue_campaign; target uuid; eid uuid; job uuid; sid uuid; inv uuid;
 payload jsonb; visible jsonb; result jsonb; response jsonb; v bigint; n integer; today date;
 v_desk text; destination_queue uuid; destination_desk text; next_status text; why text; phone text; chosen_reserved boolean:=false;
begin
 cap:=case when p_type in('queue.save','config.save','campaign.save','device.panel') then 'queue.configure'
  when p_type='ticket.issue' then 'ticket.issue' when p_type='print.reprint' then 'print.execute' else 'queue.operate' end;
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,cap);
 if p_command_id is null or p_type is null or jsonb_typeof(p_payload) is distinct from 'object' or length(p_payload::text)>16384 then raise exception 'queue_invalid_command' using errcode='22023'; end if;
 perform fagoo.queue_prepare(p_unit_id);
 -- Revalida depois da espera pelo bloqueio e antes de entregar recibos ou gravar estado.
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,cap);
 select * into old from fagoo.queue_receipt where unit_id=p_unit_id and command_id=p_command_id;
 if found then
  if old.command_type='_cancelled' and old.user_id is not distinct from p_user_id and old.device_id is not distinct from p_device_id then return old.response;end if;
  if old.user_id is distinct from p_user_id or old.device_id is distinct from p_device_id or old.command_type<>p_type or old.input<>p_payload or old.expected_version is distinct from p_expected_version then
   raise exception 'queue_command_reused' using errcode='22023';
  end if;
  return old.response;
 end if;
 perform fagoo.queue_close_day(p_unit_id);
 select * into cfg from fagoo.queue_config where unit_id=p_unit_id;
 select (clock_timestamp() at time zone timezone)::date into today from fagoo.unit where id=p_unit_id;
 begin
  if p_type='queue.save' then
   if p_payload->>'id' is not null then
    select * into q from fagoo.queue_line where unit_id=p_unit_id and id=(p_payload->>'id')::uuid;
    if not found then raise exception 'queue_not_found'; end if;
    if p_expected_version is not null and q.version<>p_expected_version then raise exception 'queue_version_conflict'; end if;
    update fagoo.queue_line set name=btrim(p_payload->>'name'),prefix=upper(btrim(p_payload->>'prefix')),
     priority=coalesce((p_payload->>'priority')::integer,0),regulars_per_priority=coalesce((p_payload->>'regulars_per_priority')::integer,0),
     active=coalesce((p_payload->>'active')::boolean,true),version=version+1 where id=q.id returning * into q;
   else
    insert into fagoo.queue_line(unit_id,name,prefix,priority,regulars_per_priority,active)
    values(p_unit_id,btrim(p_payload->>'name'),upper(btrim(p_payload->>'prefix')),coalesce((p_payload->>'priority')::integer,0),
     coalesce((p_payload->>'regulars_per_priority')::integer,0),coalesce((p_payload->>'active')::boolean,true)) returning * into q;
   end if;
   payload:=jsonb_build_object('queue',to_jsonb(q)-'unit_id'); visible:=payload;
   eid:=fagoo.queue_event_add(p_unit_id,p_type,q.id,p_user_id,p_device_id,payload,visible);
   result:=payload;
  elsif p_type='config.save' then
   if p_expected_version is not null and cfg.version<>p_expected_version then raise exception 'queue_version_conflict'; end if;
   update fagoo.queue_config set template=coalesce(p_payload->>'template',template),
    functions=case when p_payload?'functions' then array(select jsonb_array_elements_text(p_payload->'functions')) else functions end,
    ratings_enabled=coalesce((p_payload->>'ratings_enabled')::boolean,ratings_enabled),media_enabled=coalesce((p_payload->>'media_enabled')::boolean,media_enabled),
    call_ttl_seconds=coalesce((p_payload->>'call_ttl_seconds')::integer,call_ttl_seconds),title=coalesce(p_payload->>'title',title),footer=coalesce(p_payload->>'footer',footer),version=version+1
    where unit_id=p_unit_id returning * into cfg;
   payload:=jsonb_build_object('config',to_jsonb(cfg)-'unit_id'); result:=payload;
   eid:=fagoo.queue_event_add(p_unit_id,p_type,p_unit_id,p_user_id,p_device_id,payload,payload);
  elsif p_type='device.panel' then
   target:=(p_payload->>'device_id')::uuid;
   if not exists(select 1 from fagoo.device where id=target and unit_id=p_unit_id and active) then raise exception 'queue_device_not_found'; end if;
   if p_payload->>'template' not in('sinal','clinica','terminal','vitrine','sol') or p_payload->>'template' is null then raise exception 'queue_invalid_template'; end if;
   if p_payload?'volume' and ((p_payload->>'volume')::numeric<0 or (p_payload->>'volume')::numeric>1) then raise exception 'queue_invalid_volume'; end if;
   update fagoo.device set settings=settings||jsonb_build_object('panel',jsonb_build_object('template',p_payload->>'template','volume',coalesce((p_payload->>'volume')::numeric,1),'muted',coalesce((p_payload->>'muted')::boolean,false))) where id=target;
   result:=jsonb_build_object('device_id',target,'saved',true);
   eid:=fagoo.queue_event_add(p_unit_id,p_type,target,p_user_id,p_device_id,result,'{}');
  elsif p_type='campaign.save' then
   target:=coalesce((p_payload->>'id')::uuid,gen_random_uuid());
   select * into camp from fagoo.queue_campaign where id=target;
   if found and camp.unit_id<>p_unit_id then raise exception 'queue_not_found'; end if;
   if found and p_expected_version is not null and camp.version<>p_expected_version then raise exception 'queue_version_conflict'; end if;
   insert into fagoo.queue_campaign(id,unit_id,title,media_url,media_type,sha256,starts_at,expires_at,duration_seconds,priority,surfaces,active)
    values(target,p_unit_id,btrim(p_payload->>'title'),p_payload->>'media_url',coalesce(p_payload->>'media_type','image'),nullif(p_payload->>'sha256',''),
     (p_payload->>'starts_at')::timestamptz,(p_payload->>'expires_at')::timestamptz,coalesce((p_payload->>'duration_seconds')::integer,10),coalesce((p_payload->>'priority')::integer,0),
     case when p_payload?'surfaces' then array(select jsonb_array_elements_text(p_payload->'surfaces')) else array['emitir','chamada','pedidos'] end,coalesce((p_payload->>'active')::boolean,true))
    on conflict(id) do update set title=excluded.title,media_url=excluded.media_url,media_type=excluded.media_type,sha256=excluded.sha256,starts_at=excluded.starts_at,expires_at=excluded.expires_at,
     duration_seconds=excluded.duration_seconds,priority=excluded.priority,surfaces=excluded.surfaces,active=excluded.active,version=fagoo.queue_campaign.version+1 returning * into camp;
   result:=jsonb_build_object('campaign',to_jsonb(camp)-'unit_id');
   eid:=fagoo.queue_event_add(p_unit_id,p_type,target,p_user_id,p_device_id,result,result);
  elsif p_type='ticket.issue' then
   select * into q from fagoo.queue_line where unit_id=p_unit_id and id=(p_payload->>'queue_id')::uuid and active;
   if not found then raise exception 'queue_inactive'; end if;
   phone:=nullif(regexp_replace(coalesce(p_payload->>'phone',''),'[+() .-]','','g'),'');
   if phone is not null and phone!~'^[1-9][0-9]{9,14}$' then raise exception 'queue_invalid_phone'; end if;
   if coalesce((p_payload->>'print')::boolean,false) then
    target:=coalesce(p_device_id,(p_payload->>'print_device_id')::uuid);
    if target is null or not exists(select 1 from fagoo.device where id=target and unit_id=p_unit_id and active and 'print.execute'=any(capabilities)) then raise exception 'queue_printer_not_available'; end if;
   end if;
   insert into fagoo.queue_counter(unit_id,queue_id,business_day,last_number) values(p_unit_id,q.id,today,1)
    on conflict(unit_id,queue_id,business_day) do update set last_number=fagoo.queue_counter.last_number+1 returning last_number into n;
   insert into fagoo.queue_ticket(unit_id,original_queue_id,queue_id,business_day,number,display_number,priority,issued_by_user,issued_by_device,phone)
    values(p_unit_id,q.id,q.id,today,n,q.prefix||lpad(n::text,greatest(3,length(n::text)),'0'),coalesce((p_payload->>'priority')::boolean,false),p_user_id,p_device_id,phone) returning * into t;
   payload:=jsonb_build_object('ticket',fagoo.queue_ticket_dto(t)); visible:=jsonb_build_object('ticket',fagoo.queue_ticket_dto(t,true));
   eid:=fagoo.queue_event_add(p_unit_id,p_type,t.id,p_user_id,p_device_id,payload,visible);
   if target is not null then
    insert into fagoo.queue_effect(unit_id,event_id,device_id,kind,payload,expires_at)
     values(p_unit_id,eid,target,'print',jsonb_build_object('ticket_id',t.id,'display_number',t.display_number,'public_token',t.public_token,'queue',q.name,'unit',(select name from fagoo.unit where id=p_unit_id),'issued_at',t.issued_at,'footer',cfg.footer),clock_timestamp()+interval '10 minutes') returning id into job;
   end if;
   if phone is not null then
    insert into fagoo.queue_subscription(unit_id,ticket_id,public_token,channel,destination,activated_at)values(p_unit_id,t.id,t.public_token,'whatsapp',phone,clock_timestamp());
    perform fagoo.queue_schedule_notice(p_unit_id,t.id,eid,'confirmation',clock_timestamp()+interval '10 minutes');
   end if;
   result:=payload||jsonb_build_object('print_job_id',job);
  elsif p_type='ticket.call_next' then
   v_desk:=btrim(coalesce(p_payload->>'desk',''));
   if length(v_desk) not between 1 and 40 then raise exception 'queue_desk_required'; end if;
   select * into t from fagoo.queue_ticket where unit_id=p_unit_id and status='aguardando' and reserved_desk=v_desk order by issued_at,number,id limit 1;
   chosen_reserved:=found;
   if not chosen_reserved then
    select st.* into t from fagoo.queue_ticket st join fagoo.queue_line l on l.id=st.queue_id and l.unit_id=st.unit_id
     where st.unit_id=p_unit_id and st.status='aguardando' and st.reserved_desk is null
      and (not(p_payload?'queue_ids') or jsonb_array_length(p_payload->'queue_ids')=0 or st.queue_id::text in(select jsonb_array_elements_text(p_payload->'queue_ids')))
     order by case when not st.priority and l.regulars_per_priority>coalesce(l.regulars_since_priority,l.regulars_per_priority)
        and exists(select 1 from fagoo.queue_ticket normal where normal.unit_id=p_unit_id and normal.queue_id=l.id and normal.status='aguardando' and not normal.priority and normal.reserved_desk is null) then 2
       when st.priority then 1 else 0 end desc,l.priority desc,st.issued_at,st.number,st.id limit 1;
   end if;
   if t.id is null then raise exception 'queue_empty'; end if;
   update fagoo.queue_ticket set status='chamada',called_at=clock_timestamp(),last_called_at=clock_timestamp(),desk=v_desk,
    operator_user_id=p_user_id,operator_device_id=p_device_id,reserved_desk=null,version=version+1 where id=t.id returning * into t;
   if not chosen_reserved then update fagoo.queue_line set regulars_since_priority=case when t.priority then 0 else regulars_since_priority+1 end where id=t.queue_id; end if;
   payload:=jsonb_build_object('ticket',fagoo.queue_ticket_dto(t)); visible:=jsonb_build_object('ticket',fagoo.queue_ticket_dto(t,true)); result:=payload;
   eid:=fagoo.queue_event_add(p_unit_id,p_type,t.id,p_user_id,p_device_id,payload,visible);
  elsif p_type in('ticket.recall','ticket.start','ticket.complete','ticket.absent','ticket.cancel','ticket.transfer','rating.request','print.reprint') then
   select * into t from fagoo.queue_ticket where unit_id=p_unit_id and id=(p_payload->>'ticket_id')::uuid;
   if not found then raise exception 'queue_ticket_not_found'; end if;
   if p_expected_version is not null and t.version<>p_expected_version then raise exception 'queue_version_conflict'; end if;
   if p_type='ticket.transfer' then
    if t.status not in('aguardando','chamada','em_atendimento') then raise exception 'queue_invalid_transition'; end if;
    destination_queue:=(p_payload->>'queue_id')::uuid; destination_desk:=nullif(btrim(p_payload->>'desk'),'');
    if (destination_queue is null)=(destination_desk is null) or length(destination_desk)>40 then raise exception 'queue_transfer_destination'; end if;
    if destination_queue is not null and not exists(select 1 from fagoo.queue_line where id=destination_queue and unit_id=p_unit_id and active) then raise exception 'queue_inactive'; end if;
    if t.status='em_atendimento' then update fagoo.queue_service set finished_at=clock_timestamp(),result='transferido' where ticket_id=t.id; end if;
    update fagoo.queue_ticket set status='aguardando',queue_id=coalesce(destination_queue,queue_id),reserved_desk=destination_desk,
     desk=null,operator_user_id=null,operator_device_id=null,transfers=transfers+1,version=version+1 where id=t.id returning * into t;
   elsif p_type='ticket.recall' then
    if t.status<>'chamada' then raise exception 'queue_invalid_transition'; end if;
    update fagoo.queue_ticket set recalls=recalls+1,last_called_at=clock_timestamp(),version=version+1 where id=t.id returning * into t;
   elsif p_type='rating.request' then
    if not cfg.ratings_enabled or t.status not in('em_atendimento','concluida') then raise exception 'queue_rating_unavailable'; end if;
    select id into sid from fagoo.queue_service where ticket_id=t.id;
    update fagoo.queue_rating_invite set expires_at=least(expires_at,clock_timestamp())where ticket_id=t.id;
    insert into fagoo.queue_rating_invite(unit_id,ticket_id,service_id,expires_at,requested_by)
     values(p_unit_id,t.id,sid,clock_timestamp()+interval '6 hours',p_user_id) returning id into inv;
   elsif p_type='print.reprint' then
    if coalesce((p_payload->>'confirmed')::boolean,false) is not true then raise exception 'queue_reprint_confirmation'; end if;
    target:=coalesce(p_device_id,(p_payload->>'print_device_id')::uuid);
    if target is null or not exists(select 1 from fagoo.device where id=target and unit_id=p_unit_id and active and 'print.execute'=any(capabilities)) then raise exception 'queue_printer_not_available'; end if;
   else
    next_status:=case p_type when 'ticket.start' then 'em_atendimento' when 'ticket.complete' then 'concluida' when 'ticket.absent' then 'ausente' else 'cancelada' end;
    if (p_type='ticket.start' and t.status<>'chamada') or (p_type='ticket.complete' and t.status<>'em_atendimento') or
       (p_type in('ticket.absent','ticket.cancel') and t.status not in('aguardando','chamada')) then raise exception 'queue_invalid_transition'; end if;
    update fagoo.queue_ticket set status=next_status,version=version+1,reason=left(p_payload->>'reason',240),
      closed_at=case when next_status in('concluida','ausente','cancelada') then clock_timestamp() else null end where id=t.id returning * into t;
    if p_type='ticket.start' then
     insert into fagoo.queue_service(unit_id,ticket_id,desk,user_id,device_id,started_at) values(p_unit_id,t.id,t.desk,p_user_id,p_device_id,clock_timestamp())
      on conflict(ticket_id) do update set desk=excluded.desk,user_id=excluded.user_id,device_id=excluded.device_id,started_at=excluded.started_at,finished_at=null,result=null returning id into sid;
    elsif p_type='ticket.complete' then update fagoo.queue_service set finished_at=clock_timestamp(),result='concluido' where ticket_id=t.id; end if;
   end if;
   payload:=jsonb_build_object('ticket',fagoo.queue_ticket_dto(t),'service_id',sid,'rating_invite_id',inv);
   visible:=jsonb_build_object('ticket',fagoo.queue_ticket_dto(t,true));
   eid:=fagoo.queue_event_add(p_unit_id,p_type,t.id,p_user_id,p_device_id,payload,visible);
   if p_type='print.reprint' then
    insert into fagoo.queue_effect(unit_id,event_id,device_id,kind,payload,expires_at)
     values(p_unit_id,eid,target,'print',jsonb_build_object('ticket_id',t.id,'display_number',t.display_number,'public_token',t.public_token,'queue',(select name from fagoo.queue_line where id=t.original_queue_id),'unit',(select name from fagoo.unit where id=p_unit_id),'issued_at',t.issued_at,'footer',cfg.footer,'reprint',true),clock_timestamp()+interval '10 minutes') returning id into job;
   end if;
   if p_type='rating.request' then perform fagoo.queue_schedule_notice(p_unit_id,t.id,eid,'rating',clock_timestamp()+interval '6 hours');end if;
   result:=payload||jsonb_build_object('print_job_id',job);
  elsif p_type in('order.create','order.transition') then
   if p_type='order.create' then
    insert into fagoo.queue_order(unit_id,code) values(p_unit_id,btrim(p_payload->>'code')) returning * into o;
   else
    select * into o from fagoo.queue_order where id=(p_payload->>'order_id')::uuid and unit_id=p_unit_id;
    if not found then raise exception 'queue_order_not_found'; end if;
    if p_expected_version is not null and o.version<>p_expected_version then raise exception 'queue_version_conflict'; end if;
    next_status:=p_payload->>'status';
    if not ((o.status='recebido' and next_status='em_preparo') or (o.status='em_preparo' and next_status='pronto') or (o.status='pronto' and next_status='retirado') or (o.status not in('retirado','cancelado') and next_status='cancelado')) then raise exception 'queue_invalid_transition'; end if;
    update fagoo.queue_order set status=next_status,version=version+1,updated_at=clock_timestamp() where id=o.id returning * into o;
   end if;
   result:=jsonb_build_object('order',to_jsonb(o)-'unit_id');
   eid:=fagoo.queue_event_add(p_unit_id,p_type,o.id,p_user_id,p_device_id,result,result);
  else raise exception 'queue_unknown_command';
  end if;
  if p_type in('ticket.call_next','ticket.recall') then
   insert into fagoo.queue_effect(unit_id,event_id,device_id,kind,payload,expires_at)
    select p_unit_id,eid,d.id,'audio',jsonb_build_object('ticket_id',t.id,'display_number',t.display_number,'desk',t.desk,'recalls',t.recalls),clock_timestamp()+make_interval(secs=>cfg.call_ttl_seconds)
    from fagoo.device d where d.unit_id=p_unit_id and d.active and 'audio.execute'=any(d.capabilities);
   perform fagoo.queue_schedule_notice(p_unit_id,t.id,eid,'call',clock_timestamp()+make_interval(secs=>cfg.call_ttl_seconds));
  end if;
  select revision into v from fagoo.queue_runtime where unit_id=p_unit_id;
  if p_device_id is not null and result?'ticket' then
   result:=result||jsonb_build_object('ticket',fagoo.queue_ticket_dto(t,true)||case when p_type='ticket.issue' then jsonb_build_object('public_token',t.public_token) else '{}'::jsonb end);
  end if;
  response:=jsonb_build_object('ok',true,'command_id',p_command_id,'revision',v,'result',result);
 exception when raise_exception or invalid_text_representation or check_violation or not_null_violation or datetime_field_overflow or numeric_value_out_of_range then
  why:=case when sqlstate='P0001' and sqlerrm like 'queue_%' then sqlerrm else 'queue_invalid_input' end;
  response:=jsonb_build_object('ok',false,'command_id',p_command_id,'error',jsonb_build_object('code',why));
 end;
 insert into fagoo.queue_receipt(unit_id,command_id,user_id,device_id,command_type,input,expected_version,response)
  values(p_unit_id,p_command_id,p_user_id,p_device_id,p_type,p_payload,p_expected_version,response);
 return response;
end$$;

create function public.fagoo_queue_snapshot(p_user_id uuid,p_device_id uuid,p_unit_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb; public_view boolean:=p_device_id is not null;
begin
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case when public_view then 'panel.read' else 'queue.read' end);
 perform fagoo.queue_prepare(p_unit_id);
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case when public_view then 'panel.read' else 'queue.read' end);
 perform fagoo.queue_close_day(p_unit_id);
 select jsonb_build_object('unit',jsonb_build_object('id',u.id,'name',u.name,'timezone',u.timezone),'revision',r.revision,'server_time',clock_timestamp(),
 'config',to_jsonb(c)-'unit_id','device_settings',case when public_view then (select settings->'panel' from fagoo.device where id=p_device_id) else null end,
 'queues',coalesce((select jsonb_agg(to_jsonb(q)-'unit_id' order by priority desc,name,id) from fagoo.queue_line q where q.unit_id=p_unit_id),'[]'::jsonb),
 'tickets',coalesce((select jsonb_agg(fagoo.queue_ticket_dto(t,public_view) order by issued_at,id) from fagoo.queue_ticket t where t.unit_id=p_unit_id and t.status in('aguardando','chamada','em_atendimento')),'[]'::jsonb),
 'recent_calls',coalesce((select jsonb_agg(fagoo.queue_ticket_dto(t,public_view)) from (select * from fagoo.queue_ticket where unit_id=p_unit_id and last_called_at is not null and business_day=(clock_timestamp() at time zone u.timezone)::date order by last_called_at desc,id limit 10)t),'[]'::jsonb),
 'orders',coalesce((select jsonb_agg(to_jsonb(o)-'unit_id' order by created_at,id) from fagoo.queue_order o where o.unit_id=p_unit_id and o.status not in('retirado','cancelado')),'[]'::jsonb),
 'campaigns',case when c.media_enabled then coalesce((select jsonb_agg(to_jsonb(m)-'unit_id' order by priority desc,id) from fagoo.queue_campaign m where m.unit_id=p_unit_id and m.active and m.starts_at<=clock_timestamp() and m.expires_at>clock_timestamp()),'[]'::jsonb) else '[]'::jsonb end,
 'managed_campaigns',case when public_view then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(m)-'unit_id' order by m.starts_at desc) from fagoo.queue_campaign m where m.unit_id=p_unit_id),'[]'::jsonb) end,
 'effects',case when public_view then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(j)-'unit_id'-'payload'-'claim_id') from(select * from fagoo.queue_effect where unit_id=p_unit_id order by created_at desc limit 100)j),'[]'::jsonb) end,
 'devices',case when public_view then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'capabilities',d.capabilities,'active',d.active,'panel',d.settings->'panel') order by d.name,d.id) from fagoo.device d where d.unit_id=p_unit_id),'[]'::jsonb) end)
 into result from fagoo.unit u join fagoo.queue_runtime r on r.unit_id=u.id join fagoo.queue_config c on c.unit_id=u.id where u.id=p_unit_id;
 return result;
end$$;
create function public.fagoo_queue_events(p_user_id uuid,p_device_id uuid,p_unit_id uuid,p_after bigint default 0) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare rev bigint; events jsonb; last_seen bigint;
begin
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case when p_device_id is not null then 'panel.read' else 'queue.read' end);
 if p_after is null or p_after<0 then raise exception 'queue_invalid_cursor' using errcode='22023'; end if;
 perform fagoo.queue_prepare(p_unit_id);
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case when p_device_id is not null then 'panel.read' else 'queue.read' end);
 perform fagoo.queue_close_day(p_unit_id);
 select revision into rev from fagoo.queue_runtime where unit_id=p_unit_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'revision',e.revision,'type',e.type,'aggregate_id',e.aggregate_id,'occurred_at',e.occurred_at,'payload',case when p_device_id is null then e.payload else e.public_payload end) order by e.revision),'[]'),max(e.revision)
 into events,last_seen from (select * from fagoo.queue_event where unit_id=p_unit_id and revision>p_after order by revision limit 200)e;
 return jsonb_build_object('events',events,'cursor',coalesce(last_seen,least(p_after,rev)),'revision',rev,'reset',p_after>rev,'server_time',clock_timestamp());
end$$;
create function public.fagoo_queue_receipt(p_user_id uuid,p_device_id uuid,p_unit_id uuid,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare r fagoo.queue_receipt;
begin
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case when p_device_id is null then 'queue.read' else 'panel.read' end);
 select * into r from fagoo.queue_receipt where unit_id=p_unit_id and command_id=p_command_id and user_id is not distinct from p_user_id and device_id is not distinct from p_device_id;
 if not found then return jsonb_build_object('status','not_found'); end if;
 return jsonb_build_object('status','confirmed','response',r.response);
end$$;

create function public.fagoo_queue_effect_claim(p_user_id uuid,p_device_id uuid,p_unit_id uuid,p_kind text,p_claim_id uuid,p_after_revision bigint default 0) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare e fagoo.queue_effect; jobs jsonb:='[]';
begin
 if p_device_id is null or p_kind is null or p_kind not in('print','audio') or p_claim_id is null then raise exception 'queue_device_required' using errcode='42501'; end if;
 if p_after_revision is null or p_after_revision<0 then raise exception 'queue_invalid_cursor' using errcode='22023'; end if;
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case p_kind when 'print' then 'print.execute' else 'audio.execute' end);
 perform fagoo.queue_prepare(p_unit_id);
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case p_kind when 'print' then 'print.execute' else 'audio.execute' end);
 -- Uma impressão reservada pode já ter saído: perder o ACK nunca a torna pendente de novo.
 update fagoo.queue_effect set status=case when kind='print' then 'uncertain' else 'expired' end
  where unit_id=p_unit_id and device_id=p_device_id and status='claimed' and claimed_at<clock_timestamp()-interval '60 seconds';
 update fagoo.queue_effect set status='expired' where unit_id=p_unit_id and device_id=p_device_id and status='pending' and expires_at<=clock_timestamp();
 -- O cursor informado pelo aparelho descarta áudio da abertura/reconexão.
 update fagoo.queue_effect qe set status='expired' from fagoo.queue_event ev
  where qe.event_id=ev.id and qe.unit_id=p_unit_id and qe.device_id=p_device_id and qe.kind='audio' and qe.status='pending' and ev.revision<=p_after_revision;
 update fagoo.queue_effect qe set status='expired' where qe.unit_id=p_unit_id and qe.device_id=p_device_id and qe.kind='audio' and qe.status='pending'
  and not exists(select 1 from fagoo.queue_ticket t where t.id=(qe.payload->>'ticket_id')::uuid and t.status='chamada' and t.recalls=(qe.payload->>'recalls')::integer and t.desk=qe.payload->>'desk');
 for e in select * from fagoo.queue_effect where unit_id=p_unit_id and device_id=p_device_id and kind=p_kind
   and (status='pending' or (status='claimed' and claim_id=p_claim_id)) and expires_at>clock_timestamp() order by created_at,id limit 20 for update loop
  if e.status='pending' then update fagoo.queue_effect set status='claimed',claim_id=p_claim_id,claimed_at=clock_timestamp() where id=e.id returning * into e; end if;
  jobs:=jobs||jsonb_build_array(jsonb_build_object('id',e.id,'event_id',e.event_id,'kind',e.kind,'payload',e.payload,'claim_id',e.claim_id,'expires_at',e.expires_at));
 end loop;
 return jsonb_build_object('jobs',jobs,'server_time',clock_timestamp());
end$$;
create function public.fagoo_queue_cancel_unconfirmed(p_user_id uuid,p_device_id uuid,p_unit_id uuid,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare r fagoo.queue_receipt;result jsonb;
begin
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case when p_device_id is null then 'queue.read' else 'panel.read' end);
 if p_command_id is null then raise exception 'queue_invalid_command' using errcode='22023';end if;
 perform fagoo.queue_prepare(p_unit_id);
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case when p_device_id is null then 'queue.read' else 'panel.read' end);
 select * into r from fagoo.queue_receipt where unit_id=p_unit_id and command_id=p_command_id;
 if found then
  if r.user_id is distinct from p_user_id or r.device_id is distinct from p_device_id then raise exception 'queue_command_reused' using errcode='42501';end if;
  return r.response;
 end if;
 result:=jsonb_build_object('ok',false,'command_id',p_command_id,'error',jsonb_build_object('code','queue_command_cancelled'));
 insert into fagoo.queue_receipt(unit_id,command_id,user_id,device_id,command_type,input,response)values(p_unit_id,p_command_id,p_user_id,p_device_id,'_cancelled','{}',result);
 return result;
end$$;
create function public.fagoo_queue_effect_ack(p_user_id uuid,p_device_id uuid,p_unit_id uuid,p_job_id uuid,p_claim_id uuid,p_result text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare e fagoo.queue_effect; state text;
begin
 if p_device_id is null then raise exception 'queue_device_required' using errcode='42501'; end if;
 if p_claim_id is null or p_result is null then raise exception 'queue_invalid_effect_result' using errcode='22023'; end if;
 select * into e from fagoo.queue_effect where id=p_job_id and unit_id=p_unit_id and device_id=p_device_id;
 if not found then raise exception 'queue_effect_not_found' using errcode='22023'; end if;
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case e.kind when 'print' then 'print.execute' else 'audio.execute' end);
 perform fagoo.queue_prepare(p_unit_id);
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,case e.kind when 'print' then 'print.execute' else 'audio.execute' end);
 select * into e from fagoo.queue_effect where id=p_job_id for update;
 state:=case p_result when 'impresso' then 'done' when 'played' then 'done' when 'falhou' then 'failed' when 'incerto' then 'uncertain' when 'skipped' then 'expired' end;
 if state is null or (e.kind='print' and p_result not in('impresso','falhou','incerto')) or (e.kind='audio' and p_result not in('played','falhou','skipped')) then raise exception 'queue_invalid_effect_result' using errcode='22023'; end if;
 if e.claim_id is distinct from p_claim_id then raise exception 'queue_claim_mismatch' using errcode='42501'; end if;
 if e.acknowledged_at is not null then
  if e.result<>p_result then raise exception 'queue_effect_already_acknowledged' using errcode='22023'; end if;
 else
  if e.status not in('claimed','uncertain','expired') then raise exception 'queue_effect_not_claimed' using errcode='22023'; end if;
  update fagoo.queue_effect set status=state,result=p_result,acknowledged_at=clock_timestamp() where id=e.id returning * into e;
  perform fagoo.queue_event_add(p_unit_id,'effect.ack',e.id,null,p_device_id,jsonb_build_object('effect_id',e.id,'kind',e.kind,'status',e.status),'{}');
 end if;
 return jsonb_build_object('id',e.id,'status',e.status,'result',e.result);
end$$;
create function public.fagoo_queue_public(p_token text) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare t fagoo.queue_ticket; inv fagoo.queue_rating_invite;
begin
 if p_token is null or p_token!~'^[A-Za-z0-9_-]{22,128}$' then return null; end if;
 select qt.* into t from fagoo.queue_ticket qt join fagoo.unit u on u.id=qt.unit_id and u.active where qt.public_token=p_token and qt.issued_at>clock_timestamp()-interval '24 hours' and(qt.closed_at is null or qt.closed_at>clock_timestamp()-interval '12 hours');
 if not found then return null; end if;
 perform fagoo.queue_prepare(t.unit_id); perform fagoo.queue_close_day(t.unit_id);
 select * into t from fagoo.queue_ticket where id=t.id;
 select i.* into inv from fagoo.queue_rating_invite i where i.ticket_id=t.id order by i.created_at desc,i.id limit 1;
 return jsonb_build_object('ticket',jsonb_build_object('display_number',t.display_number,'status',t.status,'desk',case when t.status in('chamada','em_atendimento')then t.desk else null end,'called_at',case when t.status in('chamada','em_atendimento','ausente')then t.called_at else null end,'closed_at',t.closed_at),'unit',(select name from fagoo.unit where id=t.unit_id),'queue',(select name from fagoo.queue_line where id=t.queue_id),
  'rating',case when inv.id is not null and inv.expires_at>clock_timestamp() and not exists(select 1 from fagoo.queue_rating where invite_id=inv.id) then jsonb_build_object('invite_id',inv.id,'expires_at',inv.expires_at) else null end,'server_time',clock_timestamp());
end$$;
create function public.fagoo_queue_public_rating(p_token text,p_invite_id uuid,p_stars integer,p_comment text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare t fagoo.queue_ticket; inv fagoo.queue_rating_invite; rid uuid;
begin
 if p_token is null or p_token!~'^[A-Za-z0-9_-]{22,128}$' or p_stars not between 1 and 5 or p_stars is null or length(p_comment)>500 then raise exception 'queue_invalid_rating' using errcode='22023'; end if;
 select qt.* into t from fagoo.queue_ticket qt join fagoo.unit u on u.id=qt.unit_id and u.active where qt.public_token=p_token and qt.issued_at>clock_timestamp()-interval '24 hours' and(qt.closed_at is null or qt.closed_at>clock_timestamp()-interval '12 hours');
 if not found then raise exception 'queue_public_not_found' using errcode='22023'; end if;
 perform fagoo.queue_prepare(t.unit_id);
 select * into inv from fagoo.queue_rating_invite where id=p_invite_id and ticket_id=t.id and expires_at>clock_timestamp();
 if not found then raise exception 'queue_rating_expired' using errcode='22023'; end if;
 if exists(select 1 from fagoo.queue_rating where invite_id=inv.id) then raise exception 'queue_rating_already_answered' using errcode='22023'; end if;
 insert into fagoo.queue_rating(invite_id,stars,comment) values(inv.id,p_stars,nullif(btrim(p_comment),'')) returning id into rid;
 perform fagoo.queue_event_add(t.unit_id,'rating.received',rid,null,null,jsonb_build_object('rating_id',rid,'invite_id',inv.id,'ticket_id',t.id,'stars',p_stars,'comment',p_comment),'{}');
 return jsonb_build_object('id',rid,'saved',true);
end$$;

create function fagoo.queue_subscribe(p_token text,p_channel text,p_destination text,p_unit uuid default null) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare t fagoo.queue_ticket;s fagoo.queue_subscription;ev fagoo.queue_event;ttl integer;
begin
 if p_token is null or p_token!~'^[A-Za-z0-9_-]{22,128}$' or p_channel is null or p_channel not in('whatsapp','push_fcm','push_apns') or p_destination is null or length(p_destination) not between 8 and 4096 or p_destination~'[[:cntrl:]]' then raise exception 'queue_invalid_subscription' using errcode='22023';end if;
 if p_channel='whatsapp' and p_destination!~'^[1-9][0-9]{9,14}$' then raise exception 'queue_invalid_subscription' using errcode='22023';end if;
 if p_channel='push_apns' and p_destination!~'^[A-Fa-f0-9]{64,200}$' then raise exception 'queue_invalid_subscription' using errcode='22023';end if;
 select qt.* into t from fagoo.queue_ticket qt join fagoo.unit u on u.id=qt.unit_id and u.active where qt.public_token=p_token and qt.issued_at>clock_timestamp()-interval '24 hours' and(qt.closed_at is null or qt.closed_at>clock_timestamp()-interval '12 hours')and(p_unit is null or qt.unit_id=p_unit);
 if not found then raise exception 'queue_public_not_found' using errcode='22023';end if;
 perform fagoo.queue_prepare(t.unit_id);perform fagoo.queue_close_day(t.unit_id);
 select * into t from fagoo.queue_ticket where id=t.id;
 if t.status in('concluida','cancelada','ausente') then return jsonb_build_object('status','unnecessary');end if;
 select * into s from fagoo.queue_subscription where unit_id=t.unit_id and public_token=p_token and channel=p_channel and destination_hash=encode(sha256(convert_to(p_destination,'UTF8')),'hex');
 if not found then
  if(select count(*) from fagoo.queue_subscription where unit_id=t.unit_id and public_token=p_token)>=10 then raise exception 'queue_subscription_limit' using errcode='22023';end if;
  insert into fagoo.queue_subscription(unit_id,ticket_id,public_token,channel,destination,status,activated_at)values(t.unit_id,t.id,p_token,p_channel,p_destination,'active',clock_timestamp())returning * into s;
 else update fagoo.queue_subscription set status='active',ticket_id=t.id,activated_at=coalesce(activated_at,clock_timestamp())where id=s.id returning * into s;end if;
 if t.status='chamada' then
  select * into ev from fagoo.queue_event where unit_id=t.unit_id and aggregate_id=t.id and type in('ticket.call_next','ticket.recall')order by revision desc limit 1;
  select call_ttl_seconds into ttl from fagoo.queue_config where unit_id=t.unit_id;
  if ev.id is not null and t.last_called_at+make_interval(secs=>ttl)>clock_timestamp() then perform fagoo.queue_schedule_notice(t.unit_id,t.id,ev.id,'call',t.last_called_at+make_interval(secs=>ttl));end if;
 end if;
 return jsonb_build_object('status','active','subscription_id',s.id);
end$$;
create function public.fagoo_queue_push_subscribe(p_token text,p_platform text,p_push_token text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_platform is null or p_platform not in('fcm','apns')then raise exception 'queue_invalid_subscription' using errcode='22023';end if;
 return fagoo.queue_subscribe(p_token,'push_'||p_platform,p_push_token);
end$$;
-- Somente webhook verificado pelo adaptador de comunicação; telefone nunca vem de rota pública.
create function public.fagoo_queue_whatsapp_subscribe(p_unit_id uuid,p_token text,p_phone text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_unit_id is null then raise exception 'queue_invalid_subscription' using errcode='22023';end if;
 return fagoo.queue_subscribe(p_token,'whatsapp',p_phone,p_unit_id);
end$$;

create function public.fagoo_queue_history(p_user_id uuid,p_device_id uuid,p_unit_id uuid,p_before uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare items jsonb;next_before uuid;cursor_at timestamptz;
begin
 if p_device_id is not null then raise exception 'queue_staff_required' using errcode='42501';end if;
 perform fagoo.require_unit(p_user_id,p_device_id,p_unit_id,'queue.read');
 if p_before is not null then select issued_at into cursor_at from fagoo.queue_ticket where id=p_before and unit_id=p_unit_id;
  if not found then raise exception 'queue_invalid_cursor' using errcode='22023';end if;end if;
 select coalesce(jsonb_agg(fagoo.queue_ticket_dto(t)||jsonb_build_object('ratings',coalesce((select jsonb_agg(jsonb_build_object('stars',r.stars,'comment',r.comment,'received_at',r.received_at)) from fagoo.queue_rating r join fagoo.queue_rating_invite i on i.id=r.invite_id where i.ticket_id=t.id),'[]')) order by t.issued_at desc,t.id),'[]'),min(t.issued_at)
 into items,cursor_at from(select * from fagoo.queue_ticket where unit_id=p_unit_id and (p_before is null or issued_at<cursor_at or(issued_at=cursor_at and id>p_before)) order by issued_at desc,id limit 100)t;
 next_before:=(items->-1->>'id')::uuid;
 return jsonb_build_object('tickets',items,'before',next_before);
end$$;

-- Apenas o dispatcher interno usa estas funções; não há rota HTTP de claim de avisos.
create function public.fagoo_queue_notice_revalidate(p_notice_id uuid,p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare n fagoo.queue_notice;t fagoo.queue_ticket;valid boolean;message text;ev fagoo.queue_event;
begin
 select * into n from fagoo.queue_notice where id=p_notice_id;
 if not found or p_claim_id is null or n.claim_id is distinct from p_claim_id or n.status<>'claimed' then return null;end if;
 perform fagoo.queue_prepare(n.unit_id);perform fagoo.queue_close_day(n.unit_id);
 select * into n from fagoo.queue_notice where id=p_notice_id;
 select * into t from fagoo.queue_ticket where id=n.ticket_id;
 select * into ev from fagoo.queue_event where id=n.event_id;
 valid:=n.status='claimed' and n.claim_id=p_claim_id and n.expires_at>clock_timestamp() and exists(select 1 from fagoo.unit where id=n.unit_id and active)
  and exists(select 1 from fagoo.queue_subscription where id=n.subscription_id and status='active');
 if n.kind='call' then valid:=valid and t.status='chamada' and t.last_called_at=(ev.payload->'ticket'->>'last_called_at')::timestamptz;
 elsif n.kind='confirmation' then valid:=valid and t.status='aguardando';
 else valid:=valid and exists(select 1 from fagoo.queue_rating_invite i where i.id=(ev.payload->>'rating_invite_id')::uuid and i.expires_at>clock_timestamp() and not exists(select 1 from fagoo.queue_rating r where r.invite_id=i.id));end if;
 if valid is not true then update fagoo.queue_notice set status='expired' where id=n.id;return null;end if;
 message:=case n.kind when 'confirmation' then 'Sua senha é '||t.display_number||'.'
  when 'call' then 'Senha '||t.display_number||', dirija-se ao guichê '||t.desk||'.' else 'Como foi seu atendimento da senha '||t.display_number||'? Avalie de 1 a 5.' end;
 return jsonb_build_object('notice_id',n.id,'unit_id',n.unit_id,'phone',case when n.channel='whatsapp' then n.destination else null end,'channel',n.channel,'destination',n.destination,'text',message,'public_token',t.public_token,'kind',n.kind,'expires_at',n.expires_at,'free_only',true,'claim_id',n.claim_id);
end$$;
create function public.fagoo_queue_notice_claim(p_claim_id uuid,p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare n fagoo.queue_notice;item jsonb;items jsonb:='[]';u uuid;
begin
 if p_claim_id is null or p_limit is null or p_limit not between 1 and 50 then raise exception 'queue_invalid_claim' using errcode='22023';end if;
 -- Ordem fixa de unidades evita deadlock entre varreduras simultâneas.
 for u in select distinct unit_id from fagoo.queue_notice where status in('pending','claimed') order by unit_id loop
  perform fagoo.queue_prepare(u);perform fagoo.queue_close_day(u);
  update fagoo.queue_notice set status='unknown' where unit_id=u and status='claimed' and claimed_at<clock_timestamp()-interval '60 seconds';
  for n in select * from fagoo.queue_notice where unit_id=u and (status='pending' or(status='claimed' and claim_id=p_claim_id)) order by created_at,id limit p_limit for update loop
   if n.status='pending' then update fagoo.queue_notice set status='claimed',claim_id=p_claim_id,claimed_at=clock_timestamp() where id=n.id;end if;
   item:=public.fagoo_queue_notice_revalidate(n.id,p_claim_id);
   if item is not null then items:=items||jsonb_build_array(item);end if;
   if jsonb_array_length(items)>=p_limit then return jsonb_build_object('notices',items);end if;
  end loop;
 end loop;
 return jsonb_build_object('notices',items);
end$$;
create function public.fagoo_queue_notice_ack(p_notice_id uuid,p_claim_id uuid,p_status text,p_delivery_id text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare n fagoo.queue_notice;
begin
 if p_claim_id is null or p_status is null or p_status not in('sent','failed','unknown','expired') or length(p_delivery_id)>200 then raise exception 'queue_invalid_notice_result' using errcode='22023';end if;
 select * into n from fagoo.queue_notice where id=p_notice_id;
 if not found then raise exception 'queue_notice_not_found' using errcode='22023';end if;
 perform fagoo.queue_prepare(n.unit_id);
 select * into n from fagoo.queue_notice where id=p_notice_id for update;
 if n.claim_id is distinct from p_claim_id then raise exception 'queue_claim_mismatch' using errcode='42501';end if;
 if n.acknowledged_at is not null then
  if n.status='unknown' and n.delivery_id is not null and n.delivery_id=p_delivery_id and p_status in('sent','failed','expired') then
   update fagoo.queue_notice set status=p_status,acknowledged_at=clock_timestamp() where id=n.id returning * into n;
  elsif n.status<>p_status or n.delivery_id is distinct from p_delivery_id then raise exception 'queue_notice_already_acknowledged' using errcode='22023';end if;
 else
  if n.status not in('claimed','unknown','expired') then raise exception 'queue_notice_not_claimed' using errcode='22023';end if;
  update fagoo.queue_notice set status=p_status,delivery_id=p_delivery_id,acknowledged_at=clock_timestamp() where id=n.id returning * into n;
 end if;
 return jsonb_build_object('notice_id',n.id,'status',n.status,'delivery_id',n.delivery_id);
end$$;

create function public.fagoo_queue_notice_pending_deliveries() returns jsonb
language sql security definer set search_path=pg_catalog as $$
 select jsonb_build_object('notices',coalesce(jsonb_agg(jsonb_build_object('notice_id',n.id,'claim_id',n.claim_id,'unit_id',n.unit_id,'delivery_id',n.delivery_id,'expires_at',n.expires_at)),'[]'))
 from(select * from fagoo.queue_notice where status='unknown' and channel='whatsapp' and delivery_id is not null order by created_at,id limit 100)n;
$$;

create function public.fagoo_queue_notice_delivery_allowed(p_notice_id uuid,p_claim_id uuid,p_delivery_id text) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare n fagoo.queue_notice;t fagoo.queue_ticket;ev fagoo.queue_event;valid boolean;
begin
 select * into n from fagoo.queue_notice where id=p_notice_id;
 if not found then return false;end if;
 perform fagoo.queue_prepare(n.unit_id);perform fagoo.queue_close_day(n.unit_id);
 select * into n from fagoo.queue_notice where id=p_notice_id;
 if p_claim_id is null or n.claim_id is distinct from p_claim_id or n.status not in('claimed','unknown') or
  (n.delivery_id is not null and n.delivery_id is distinct from p_delivery_id) or (n.status='unknown' and n.delivery_id is null) then return false;end if;
 select * into t from fagoo.queue_ticket where id=n.ticket_id;
 select * into ev from fagoo.queue_event where id=n.event_id;
 valid:=n.expires_at>clock_timestamp() and exists(select 1 from fagoo.unit where id=n.unit_id and active)
  and exists(select 1 from fagoo.queue_subscription where id=n.subscription_id and status='active');
 if n.kind='call' then valid:=valid and t.status='chamada' and t.last_called_at=(ev.payload->'ticket'->>'last_called_at')::timestamptz;
 elsif n.kind='confirmation' then valid:=valid and t.status='aguardando';
 else valid:=valid and exists(select 1 from fagoo.queue_rating_invite i where i.id=(ev.payload->>'rating_invite_id')::uuid and i.expires_at>clock_timestamp() and not exists(select 1 from fagoo.queue_rating r where r.invite_id=i.id));end if;
 return coalesce(valid,false);
end$$;

-- RLS e acesso somente por funções; até service_role não consulta tabelas diretamente.
do $$declare n text; f record;begin
 foreach n in array array['queue_runtime','queue_config','queue_line','queue_counter','queue_ticket','queue_service','queue_order','queue_campaign','queue_event','queue_receipt','queue_effect','queue_rating_invite','queue_rating','queue_subscription','queue_notice'] loop
  execute format('alter table fagoo.%I enable row level security',n);
  execute format('revoke all on fagoo.%I from public,anon,authenticated,service_role',n);
 end loop;
 for f in select p.oid::regprocedure signature,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='fagoo' and p.proname like 'queue_%') or (n.nspname='public' and p.proname like 'fagoo_queue_%') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  if f.nspname='public' then execute format('grant execute on function %s to service_role',f.signature); end if;
 end loop;
end$$;
commit;
