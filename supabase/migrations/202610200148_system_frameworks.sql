-- 148: frameworks de Sistema e Suprimentos no padrão do Origin, prontos para os outros módulos adotarem.
-- * Gerenciador de transições: situações personalizadas de Pedidos de Venda, Pedidos de Compra e Ordem de Serviço. Cada
--   situação personalizada é "baseada em" uma situação padrão (o status-base do documento, que continua regendo as
--   regras e os efeitos atuais). As transições padrão são as de erp_documents.transitions() entre as situações padrão e
--   só podem ser desativadas; uma transição personalizada só existe entre situações cujas bases a regra do documento
--   permite (ou de mesma base). Cada transição tem status (ativa ou inativa) e ações (Estornar estoque, Estornar contas,
--   Lançar estoque, Lançar contas).
-- * Esta migração só guarda a configuração: nenhum documento muda de comportamento. O módulo de documentos adota o
--   gerenciador registrando o tipo em erp_preferences.situation_adoption e lendo erp_preferences.situation_of e
--   erp_preferences.transition_rule na mesma transação da mudança de situação. Enquanto um tipo não foi adotado, as
--   ações ficam indisponíveis (o servidor recusa) e a tela avisa.
-- * Suprimentos > Gerenciar grupos de tags e Gerenciar tags: grupos e tags por tipo (Produtos ou Contatos). O vínculo com
--   produtos e contatos, os filtros por tag e a ação em lote "Incluir tags" ficam para os módulos de cadastro.
-- Tudo só para administrador, por comando idempotente (command_id), com versão (CAS) e auditoria. Essas auditorias entram no
-- Registro de atividades, que passa a abrir o detalhe (antes e depois) dos registros que o guardam.
begin;

-- One row per accepted command of these screens (and of 149); it is the receipt replayed by "Conferir resultado".
create table erp_preferences.framework_command(
 id uuid primary key,
 actor uuid not null references auth.users(id),
 area text not null check(area in('situations','tags','reports','labels')),
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),
 created_at timestamptz not null default clock_timestamp()
);
create table erp_preferences.framework_audit(
 id bigint generated always as identity primary key,
 created_at timestamptz not null default clock_timestamp(),
 actor uuid not null references auth.users(id),
 command_id uuid not null references erp_preferences.framework_command(id),
 area text not null check(area in('situations','tags','reports','labels')),
 action text not null check(action~'^[a-z_]{3,40}$'),
 target text not null check(char_length(target) between 1 and 120),
 before_data jsonb,
 after_data jsonb
);
create index erp_preferences_framework_audit_at on erp_preferences.framework_audit(created_at);
create trigger immutable_framework_command before update or delete on erp_preferences.framework_command for each row execute function erp_preferences.immutable_history();
create trigger immutable_framework_audit before update or delete on erp_preferences.framework_audit for each row execute function erp_preferences.immutable_history();

create table erp_preferences.situation(
 id uuid primary key,
 kind text not null check(kind in('sales_orders','purchase_orders','service_orders')),
 base_status text not null check(base_status~'^[a-z_]{2,40}$'),
 name text not null check(char_length(name) between 1 and 40 and name=btrim(name) and name!~'[[:cntrl:]]'),
 color text not null check(color~'^#[0-9a-f]{6}$'),
 active boolean not null,
 version integer not null check(version between 1 and 2147483647),
 created_at timestamptz not null,
 created_by uuid not null references auth.users(id),
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id),
 command_id uuid not null references erp_preferences.framework_command(id)
);
create unique index erp_preferences_situation_name on erp_preferences.situation(kind,lower(name));
-- Configured transitions: overrides of default pairs and every custom pair. Versions come from one sequence, so a pair
-- deleted and created again never repeats a version a stale screen still holds.
create sequence erp_preferences.transition_version as integer;
create table erp_preferences.transition(
 kind text not null check(kind in('sales_orders','purchase_orders','service_orders')),
 from_key text not null check(from_key~'^([a-z_]{2,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
 to_key text not null check(to_key~'^([a-z_]{2,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
 active boolean not null,
 actions text[] not null check(actions<@array['post_finance','post_stock','reverse_finance','reverse_stock']::text[] and array_position(actions,null) is null
  and not actions@>array['post_stock','reverse_stock'] and not actions@>array['post_finance','reverse_finance']),
 version integer not null check(version>0),
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id),
 command_id uuid not null references erp_preferences.framework_command(id),
 primary key(kind,from_key,to_key),
 check(from_key<>to_key)
);
-- Written by the documents lane when its change of situação reads this configuration (one row per kind).
create table erp_preferences.situation_adoption(
 kind text primary key check(kind in('sales_orders','purchase_orders','service_orders')),
 adopted_at timestamptz not null default clock_timestamp(),
 migration text not null check(migration~'^[0-9]{12}$')
);

create table erp_preferences.tag_group(
 id uuid primary key,
 type text not null check(type in('produtos','contatos')),
 name text not null check(char_length(name) between 1 and 60 and name=btrim(name) and name!~'[[:cntrl:]]'),
 version integer not null check(version between 1 and 2147483647),
 created_at timestamptz not null,
 created_by uuid not null references auth.users(id),
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id),
 command_id uuid not null references erp_preferences.framework_command(id),
 unique(id,type)
);
create unique index erp_preferences_tag_group_name on erp_preferences.tag_group(type,lower(name));
create table erp_preferences.tag(
 id uuid primary key,
 type text not null check(type in('produtos','contatos')),
 group_id uuid,
 name text not null check(char_length(name) between 1 and 60 and name=btrim(name) and name!~'[[:cntrl:]]'),
 color text not null check(color~'^#[0-9a-f]{6}$'),
 version integer not null check(version between 1 and 2147483647),
 created_at timestamptz not null,
 created_by uuid not null references auth.users(id),
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id),
 command_id uuid not null references erp_preferences.framework_command(id),
 foreign key(group_id,type) references erp_preferences.tag_group(id,type)
);
create unique index erp_preferences_tag_name on erp_preferences.tag(type,lower(name));
create index erp_preferences_tag_group on erp_preferences.tag(group_id);

do $$declare t text;begin foreach t in array array['framework_command','framework_audit','situation','transition','situation_adoption','tag_group','tag'] loop
 execute format('alter table erp_preferences.%I enable row level security',t);
 execute format('revoke all on erp_preferences.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on all sequences in schema erp_preferences from public,anon,authenticated,service_role;

-- Situações padrão: the base statuses of each kind (keys of erp_documents.transitions()), with the Origin labels.
create function erp_preferences.situation_base_label(p_kind text,p_status text) returns text language sql immutable set search_path=pg_catalog as $$
 select coalesce('{"sales_orders":{"draft":"Em digitação","open":"Em aberto","verified":"Verificado","in_progress":"Em andamento","partially_fulfilled":"Atendido parcialmente","fulfilled":"Atendido","cancelled":"Cancelado"},
  "purchase_orders":{"open":"Em aberto","in_progress":"Em andamento","partially_fulfilled":"Atendido parcialmente","fulfilled":"Atendido","cancelled":"Cancelado"},
  "service_orders":{"open":"Em aberto","quoted":"Orçada","approved":"Aprovada","rejected":"Não aprovada","in_progress":"Em andamento","waiting_parts":"Aguardando componentes","service_done":"Serviço concluído","finalized":"Finalizada","no_repair":"Finalizada sem conserto","cancelled":"Cancelado"}}'::jsonb#>>array[p_kind,p_status],
  left(initcap(replace(p_status,'_',' ')),40))
$$;
create function erp_preferences.situation_base_color(p_status text) returns text language sql immutable set search_path=pg_catalog as $$
 select coalesce('{"draft":"#9e9e9e","open":"#e6a700","quoted":"#8d6e63","approved":"#43a047","rejected":"#e53935","verified":"#7e57c2","in_progress":"#1e88e5","waiting_parts":"#fb8c00",
  "partially_fulfilled":"#26a69a","service_done":"#00897b","fulfilled":"#2e7d32","finalized":"#2e7d32","no_repair":"#6d4c41","cancelled":"#d32f2f"}'::jsonb->>p_status,'#607d8b')
$$;
create function erp_preferences.situation_bases(p_kind text) returns table(status text,label text,color text,ordinal integer) language sql stable set search_path=pg_catalog as $$
 select k.status,erp_preferences.situation_base_label(p_kind,k.status),erp_preferences.situation_base_color(k.status),coalesce(o.ordinal,1000)::integer
 from jsonb_object_keys(case when p_kind in('sales_orders','purchase_orders','service_orders') then coalesce(erp_documents.transitions()->p_kind,'{}'::jsonb) else '{}'::jsonb end) k(status)
 left join unnest(array['draft','open','quoted','approved','rejected','verified','in_progress','waiting_parts','partially_fulfilled','service_done','fulfilled','finalized','no_repair','cancelled']) with ordinality o(status,ordinal) on o.status=k.status
 where k.status~'^[a-z_]{2,40}$'
$$;
-- Every situação of a kind: the defaults (key = base status, always active, version 0) and the custom ones (key = id).
create function erp_preferences.situation_list(p_kind text)
returns table(key text,base_status text,name text,color text,is_default boolean,active boolean,version integer,ordinal integer,created_at timestamptz)
language sql stable set search_path=pg_catalog as $$
 select b.status,b.status,b.label,b.color,true,true,0,b.ordinal,null::timestamptz from erp_preferences.situation_bases(p_kind) b
 union all
 select s.id::text,s.base_status,s.name,s.color,false,s.active,s.version,b.ordinal,s.created_at
 from erp_preferences.situation s join erp_preferences.situation_bases(p_kind) b on b.status=s.base_status where s.kind=p_kind
$$;
create function erp_preferences.transition_allowed(p_kind text,p_from_base text,p_to_base text) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce(p_from_base=p_to_base or(erp_documents.transitions()#>array[p_kind,p_from_base])?p_to_base,false)
$$;
-- Default pairs (both situações padrão, allowed by the document rule) always appear; custom pairs only when configured.
create function erp_preferences.transition_list(p_kind text)
returns table(from_key text,to_key text,is_default boolean,active boolean,actions text[],version integer,from_ord text,to_ord text)
language sql stable set search_path=pg_catalog as $$
 with s as(select l.*,lpad(l.ordinal::text,4,'0')||case when l.is_default then '0' else '1'||to_char(l.created_at at time zone 'UTC','YYYYMMDDHH24MISSUS')||l.key end ord from erp_preferences.situation_list(p_kind) l)
 select a.key,b.key,a.is_default and b.is_default,coalesce(t.active,true),coalesce(t.actions,'{}'::text[]),coalesce(t.version,0),a.ord,b.ord
 from s a join s b on a.key<>b.key and erp_preferences.transition_allowed(p_kind,a.base_status,b.base_status)
 left join erp_preferences.transition t on t.kind=p_kind and t.from_key=a.key and t.to_key=b.key
 where(a.is_default and b.is_default) or t.kind is not null
$$;

-- Adoption API for the documents lane (internal; no grants). situation_of: one situação or null.
create function erp_preferences.situation_of(p_kind text,p_key text) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('key',s.key,'base_status',s.base_status,'name',s.name,'color',s.color,'default',s.is_default,'active',s.active)
 from erp_preferences.situation_list(p_kind) s where s.key=p_key
$$;
-- transition_rule: null when the document rule does not allow the pair; otherwise whether the change is active (the
-- transition and both situações) and the actions to run in the same transaction.
create function erp_preferences.transition_rule(p_kind text,p_from text,p_to text) returns jsonb language sql stable set search_path=pg_catalog as $$
 with s as(select * from erp_preferences.situation_list(p_kind))
 select jsonb_build_object('default',a.is_default and b.is_default,'configured',t.kind is not null or(a.is_default and b.is_default),
  'active',(t.kind is not null or(a.is_default and b.is_default)) and coalesce(t.active,true) and a.active and b.active,
  'actions',to_jsonb(coalesce(t.actions,'{}'::text[])),'from_base',a.base_status,'to_base',b.base_status)
 from s a join s b on b.key=p_to and a.key<>b.key and erp_preferences.transition_allowed(p_kind,a.base_status,b.base_status)
 left join erp_preferences.transition t on t.kind=p_kind and t.from_key=a.key and t.to_key=b.key
 where a.key=p_from
$$;

create function erp_preferences.situations_page(p_kind text) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('scope','situations_page','data_mode','erp_native','kind',p_kind,
  'adopted',exists(select 1 from erp_preferences.situation_adoption a where a.kind=p_kind),
  'situations',(select coalesce(jsonb_agg(jsonb_build_object('key',s.key,'base_status',s.base_status,'name',s.name,'color',s.color,'default',s.is_default,'active',s.active,'version',s.version)
    order by s.ordinal,s.is_default desc,s.created_at,s.key),'[]'::jsonb) from erp_preferences.situation_list(p_kind) s),
  'rules',(select coalesce(jsonb_object_agg(b.status,(select coalesce(jsonb_agg(o.status order by o.ordinal,o.status),'[]'::jsonb) from erp_preferences.situation_bases(p_kind) o
    where o.status<>b.status and coalesce((erp_documents.transitions()#>array[p_kind,b.status])?o.status,false))),'{}'::jsonb) from erp_preferences.situation_bases(p_kind) b),
  'transitions',(select coalesce(jsonb_agg(jsonb_build_object('from',t.from_key,'to',t.to_key,'default',t.is_default,'active',t.active,'actions',to_jsonb(t.actions),'version',t.version)
    order by t.from_ord,t.to_ord),'[]'::jsonb) from erp_preferences.transition_list(p_kind) t))
$$;
create function erp_preferences.framework_hash(p jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(p::text,'UTF8')),'hex')
$$;
-- A replayed command must come from the same actor with the same request; otherwise the id is refused.
create function erp_preferences.framework_replay(p_command uuid,p_actor uuid,p_area text,p_hash text) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare c erp_preferences.framework_command;
begin
 perform pg_advisory_xact_lock(hashtext('erp_preferences_framework_command'),hashtext(p_command::text));
 select * into c from erp_preferences.framework_command where id=p_command;
 if c.id is null then return null; end if;
 if c.actor<>p_actor or c.area<>p_area or c.request_hash<>p_hash then raise exception 'erp_preferences_framework_command_conflict' using errcode='40001'; end if;
 return c.result||jsonb_build_object('replayed',true);
end $$;
create function erp_preferences.framework_text(p jsonb,p_max integer) returns text language plpgsql immutable set search_path=pg_catalog as $$
begin
 if jsonb_typeof(p)<>'string' or p#>>'{}'<>btrim(p#>>'{}') or char_length(p#>>'{}') not between 1 and p_max or p#>>'{}'~'[[:cntrl:]]' then
  raise exception 'erp_preferences_framework_text_invalid' using errcode='22023'; end if;
 return p#>>'{}';
end $$;
create function erp_preferences.framework_keys(p jsonb,p_keys text[]) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p is null or jsonb_typeof(p)<>'object' then return false; end if;
 return(select coalesce(array_agg(k order by k),'{}') from jsonb_object_keys(p) k)=(select array_agg(k order by k) from unnest(p_keys) k);
end $$;
-- A positive integer version inside a JSON item, or null.
create function erp_preferences.framework_version(p jsonb) returns integer language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p is null or jsonb_typeof(p)<>'number' then return null; end if;
 if p#>>'{}'!~'^[1-9][0-9]{0,9}$' then return null; end if;
 if(p#>>'{}')::bigint>2147483647 then return null; end if;
 return(p#>>'{}')::integer;
end $$;
create function erp_preferences.situation_dto(s erp_preferences.situation) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('key',s.id,'base_status',s.base_status,'name',s.name,'color',s.color,'active',s.active,'version',s.version)
$$;

create function public.erp_preferences_situations(p_user_id uuid,p_kind text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_access.read_admin(p_user_id);
 if p_kind is null or p_kind not in('sales_orders','purchase_orders','service_orders') then raise exception 'erp_preferences_situation_kind_invalid' using errcode='22023'; end if;
 return erp_preferences.situations_page(p_kind);
end $$;
-- "⊕ CRIAR NOVA SITUAÇÃO" (p_situation null, expected 0) or editing a custom situação (Nome, Cor, ativa); "Baseada em" is fixed.
create function public.erp_preferences_situation_save(p_user_id uuid,p_command_id uuid,p_kind text,p_situation uuid,p_expected_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_replay jsonb;v_row erp_preferences.situation;v_name text;v_color text;v_base text;v_active boolean;v_at timestamptz:=clock_timestamp();v_id uuid;v_result jsonb;v_before jsonb;
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null or p_kind is null or p_kind not in('sales_orders','purchase_orders','service_orders') or p_expected_version is null or p_expected_version not between 0 and 2147483646
  or(p_situation is null)<>(p_expected_version=0) or not erp_preferences.framework_keys(p_data,array['active','base_status','color','name'])
  or jsonb_typeof(p_data->'active')<>'boolean' or jsonb_typeof(p_data->'base_status')<>'string' or jsonb_typeof(p_data->'color')<>'string' then
  raise exception 'erp_preferences_situation_input_invalid' using errcode='22023'; end if;
 v_name:=erp_preferences.framework_text(p_data->'name',40);v_color:=p_data->>'color';v_base:=p_data->>'base_status';v_active:=(p_data->>'active')::boolean;
 if v_color!~'^#[0-9a-f]{6}$' or not exists(select 1 from erp_preferences.situation_bases(p_kind) b where b.status=v_base) or(p_situation is null and not v_active) then
  raise exception 'erp_preferences_situation_input_invalid' using errcode='22023'; end if;
 v_hash:=erp_preferences.framework_hash(jsonb_build_object('op','situation_save','actor',p_user_id,'kind',p_kind,'id',p_situation,'version',p_expected_version,'data',p_data));
 v_replay:=erp_preferences.framework_replay(p_command_id,p_user_id,'situations',v_hash);if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(hashtext('erp_preferences_situations'),hashtext(p_kind));
 if exists(select 1 from erp_preferences.situation s where s.kind=p_kind and lower(s.name)=lower(v_name) and s.id is distinct from p_situation)
  or exists(select 1 from erp_preferences.situation_bases(p_kind) b where lower(b.label)=lower(v_name)) then
  raise exception 'erp_preferences_situation_name_taken' using errcode='23505'; end if;
 if p_situation is null then
  if(select count(*) from erp_preferences.situation s where s.kind=p_kind)>=30 then raise exception 'erp_preferences_situation_limit' using errcode='22023'; end if;
  v_id:=gen_random_uuid();
 else
  select * into v_row from erp_preferences.situation s where s.id=p_situation and s.kind=p_kind for update;
  if v_row.id is null then raise exception 'erp_preferences_situation_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_preferences_situation_version_conflict' using errcode='40001'; end if;
  if v_row.base_status<>v_base then raise exception 'erp_preferences_situation_base_fixed' using errcode='22023'; end if;
  if v_row.name=v_name and v_row.color=v_color and v_row.active=v_active then raise exception 'erp_preferences_situation_unchanged' using errcode='22023'; end if;
  v_id:=p_situation;v_before:=erp_preferences.situation_dto(v_row);
 end if;
 v_result:=jsonb_build_object('scope','situations_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'action',case when p_situation is null then 'situation_create' else 'situation_update' end,'kind',p_kind,'target',v_id::text,'count',1,'changed_at',v_at));
 insert into erp_preferences.framework_command(id,actor,area,request_hash,result,created_at) values(p_command_id,p_user_id,'situations',v_hash,v_result,v_at);
 if p_situation is null then
  insert into erp_preferences.situation(id,kind,base_status,name,color,active,version,created_at,created_by,updated_at,updated_by,command_id)
   values(v_id,p_kind,v_base,v_name,v_color,true,1,v_at,p_user_id,v_at,p_user_id,p_command_id) returning * into v_row;
 else
  update erp_preferences.situation set name=v_name,color=v_color,active=v_active,version=version+1,updated_at=v_at,updated_by=p_user_id,command_id=p_command_id
   where id=v_id returning * into v_row;
 end if;
 insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
  values(v_at,p_user_id,p_command_id,'situations',v_result#>>'{receipt,action}',p_kind||':'||v_id,v_before,erp_preferences.situation_dto(v_row));
 return v_result||jsonb_build_object('replayed',false);
end $$;
-- Modal Editar/Criar transição: Status da transição and the actions. A default pair is configured by overriding it.
create function public.erp_preferences_transition_save(p_user_id uuid,p_command_id uuid,p_kind text,p_from text,p_to text,p_expected_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_replay jsonb;v_actions text[];v_active boolean;v_at timestamptz:=clock_timestamp();v_result jsonb;v_from jsonb;v_to jsonb;v_default boolean;
 v_row erp_preferences.transition;v_before jsonb;v_version integer;
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null or p_kind is null or p_kind not in('sales_orders','purchase_orders','service_orders') or p_from is null or p_to is null or p_from=p_to
  or p_expected_version is null or p_expected_version not between 0 and 2147483647 or not erp_preferences.framework_keys(p_data,array['actions','active'])
  or jsonb_typeof(p_data->'active')<>'boolean' or jsonb_typeof(p_data->'actions')<>'array' or jsonb_array_length(p_data->'actions')>2
  or exists(select 1 from jsonb_array_elements(p_data->'actions') a where jsonb_typeof(a)<>'string' or a#>>'{}' not in('post_finance','post_stock','reverse_finance','reverse_stock')) then
  raise exception 'erp_preferences_transition_input_invalid' using errcode='22023'; end if;
 v_actions:=array(select distinct a from jsonb_array_elements_text(p_data->'actions') a order by a);v_active:=(p_data->>'active')::boolean;
 if cardinality(v_actions)<>jsonb_array_length(p_data->'actions') or v_actions@>array['post_stock','reverse_stock'] or v_actions@>array['post_finance','reverse_finance'] then
  raise exception 'erp_preferences_transition_input_invalid' using errcode='22023'; end if;
 v_hash:=erp_preferences.framework_hash(jsonb_build_object('op','transition_save','actor',p_user_id,'kind',p_kind,'from',p_from,'to',p_to,'version',p_expected_version,'data',p_data));
 v_replay:=erp_preferences.framework_replay(p_command_id,p_user_id,'situations',v_hash);if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(hashtext('erp_preferences_situations'),hashtext(p_kind));
 if cardinality(v_actions)>0 and not exists(select 1 from erp_preferences.situation_adoption a where a.kind=p_kind) then
  raise exception 'erp_preferences_transition_actions_unavailable' using errcode='22023'; end if;
 v_from:=erp_preferences.situation_of(p_kind,p_from);v_to:=erp_preferences.situation_of(p_kind,p_to);
 if v_from is null or v_to is null then raise exception 'erp_preferences_situation_not_found' using errcode='P0002'; end if;
 if not erp_preferences.transition_allowed(p_kind,v_from->>'base_status',v_to->>'base_status') then raise exception 'erp_preferences_transition_not_allowed' using errcode='22023'; end if;
 v_default:=(v_from->>'default')::boolean and(v_to->>'default')::boolean;
 select * into v_row from erp_preferences.transition t where t.kind=p_kind and t.from_key=p_from and t.to_key=p_to for update;
 if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_preferences_transition_version_conflict' using errcode='40001'; end if;
 if(v_row.kind is not null or v_default) and coalesce(v_row.active,true)=v_active and coalesce(v_row.actions,'{}'::text[])=v_actions then
  raise exception 'erp_preferences_transition_unchanged' using errcode='22023'; end if;
 if v_row.kind is null and not v_default and(select count(*) from erp_preferences.transition t where t.kind=p_kind)>=400 then
  raise exception 'erp_preferences_transition_limit' using errcode='22023'; end if;
 v_before:=case when v_row.kind is not null then jsonb_build_object('active',v_row.active,'actions',to_jsonb(v_row.actions),'version',v_row.version)
  when v_default then jsonb_build_object('active',true,'actions','[]'::jsonb,'version',0) end;
 v_version:=nextval('erp_preferences.transition_version');
 v_result:=jsonb_build_object('scope','situations_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'action','transition_save','kind',p_kind,'target',p_from||'>'||p_to,'count',1,'changed_at',v_at));
 insert into erp_preferences.framework_command(id,actor,area,request_hash,result,created_at) values(p_command_id,p_user_id,'situations',v_hash,v_result,v_at);
 insert into erp_preferences.transition as t(kind,from_key,to_key,active,actions,version,updated_at,updated_by,command_id)
  values(p_kind,p_from,p_to,v_active,v_actions,v_version,v_at,p_user_id,p_command_id)
  on conflict(kind,from_key,to_key) do update set active=excluded.active,actions=excluded.actions,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by,command_id=excluded.command_id;
 insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
  values(v_at,p_user_id,p_command_id,'situations','transition_save',p_kind||':'||p_from||'>'||p_to,v_before,jsonb_build_object('active',v_active,'actions',to_jsonb(v_actions),'version',v_version));
 return v_result||jsonb_build_object('replayed',false);
end $$;
-- "Excluir selecionados": custom transitions only (default ones can only be deactivated); all or nothing, each by version.
create function public.erp_preferences_transitions_delete(p_user_id uuid,p_command_id uuid,p_kind text,p_items jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_replay jsonb;v_at timestamptz:=clock_timestamp();v_result jsonb;i jsonb;v_row erp_preferences.transition;v_from jsonb;v_to jsonb;v_count integer;
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null or p_kind is null or p_kind not in('sales_orders','purchase_orders','service_orders') or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
  or exists(select 1 from jsonb_array_elements(p_items) x where not erp_preferences.framework_keys(x,array['expected_version','from','to']) or jsonb_typeof(x->'from')<>'string' or jsonb_typeof(x->'to')<>'string'
   or erp_preferences.framework_version(x->'expected_version') is null)
  or(select count(distinct(x->>'from',x->>'to')) from jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) then
  raise exception 'erp_preferences_transition_input_invalid' using errcode='22023'; end if;
 v_hash:=erp_preferences.framework_hash(jsonb_build_object('op','transitions_delete','actor',p_user_id,'kind',p_kind,'items',p_items));
 v_replay:=erp_preferences.framework_replay(p_command_id,p_user_id,'situations',v_hash);if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(hashtext('erp_preferences_situations'),hashtext(p_kind));
 v_count:=jsonb_array_length(p_items);
 v_result:=jsonb_build_object('scope','situations_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'action','transitions_delete','kind',p_kind,'target',null,'count',v_count,'changed_at',v_at));
 insert into erp_preferences.framework_command(id,actor,area,request_hash,result,created_at) values(p_command_id,p_user_id,'situations',v_hash,v_result,v_at);
 for i in select x from jsonb_array_elements(p_items) x order by x->>'from',x->>'to' loop
  v_from:=erp_preferences.situation_of(p_kind,i->>'from');v_to:=erp_preferences.situation_of(p_kind,i->>'to');
  if coalesce((v_from->>'default')::boolean and(v_to->>'default')::boolean,false) then raise exception 'erp_preferences_transition_default' using errcode='22023'; end if;
  select * into v_row from erp_preferences.transition t where t.kind=p_kind and t.from_key=i->>'from' and t.to_key=i->>'to' for update;
  if v_row.kind is null then raise exception 'erp_preferences_transition_not_found' using errcode='P0002'; end if;
  if v_row.version<>(i->>'expected_version')::integer then raise exception 'erp_preferences_transition_version_conflict' using errcode='40001'; end if;
  delete from erp_preferences.transition t where t.kind=p_kind and t.from_key=v_row.from_key and t.to_key=v_row.to_key;
  insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
   values(v_at,p_user_id,p_command_id,'situations','transition_delete',p_kind||':'||v_row.from_key||'>'||v_row.to_key,
    jsonb_build_object('active',v_row.active,'actions',to_jsonb(v_row.actions),'version',v_row.version),null);
 end loop;
 return v_result||jsonb_build_object('replayed',false);
end $$;

-- Grupos de tags e tags.
create function erp_preferences.tag_query(p_query text) returns text language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_query is not null and(char_length(p_query) not between 1 and 60 or p_query~'[[:cntrl:]]' or p_query<>btrim(p_query)) then
  raise exception 'erp_preferences_tag_query_invalid' using errcode='22023'; end if;
 return case when p_query is null then null else '%'||replace(replace(replace(lower(p_query),'\','\\'),'%','\%'),'_','\_')||'%' end;
end $$;
create function erp_preferences.tag_group_dto(g erp_preferences.tag_group) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('id',g.id,'type',g.type,'name',g.name,'version',g.version)
$$;
create function erp_preferences.tag_dto(t erp_preferences.tag) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('id',t.id,'type',t.type,'group_id',t.group_id,'name',t.name,'color',t.color,'version',t.version)
$$;
create function public.erp_preferences_tag_groups(p_user_id uuid,p_type text,p_query text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_like text;
begin
 perform erp_access.read_admin(p_user_id);
 if p_type is not null and p_type not in('produtos','contatos') then raise exception 'erp_preferences_tag_type_invalid' using errcode='22023'; end if;
 v_like:=erp_preferences.tag_query(p_query);
 return(select jsonb_build_object('scope','tag_groups','data_mode','erp_native',
  'items',coalesce(jsonb_agg(jsonb_build_object('id',g.id,'type',g.type,'name',g.name,'tags',(select count(*) from erp_preferences.tag t where t.group_id=g.id),'version',g.version,'updated_at',g.updated_at)
   order by lower(g.name),g.id),'[]'::jsonb),'total',count(*))
  from erp_preferences.tag_group g where(p_type is null or g.type=p_type) and(v_like is null or lower(g.name) like v_like));
end $$;
create function public.erp_preferences_tags(p_user_id uuid,p_type text,p_group uuid,p_query text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_like text;
begin
 perform erp_access.read_admin(p_user_id);
 if p_type is not null and p_type not in('produtos','contatos') then raise exception 'erp_preferences_tag_type_invalid' using errcode='22023'; end if;
 v_like:=erp_preferences.tag_query(p_query);
 return jsonb_build_object('scope','tags','data_mode','erp_native',
  'groups',(select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'type',g.type,'name',g.name) order by lower(g.name),g.id),'[]'::jsonb) from erp_preferences.tag_group g),
  'items',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'type',t.type,'group_id',t.group_id,'name',t.name,'color',t.color,'version',t.version,'updated_at',t.updated_at)
    order by lower(t.name),t.id),'[]'::jsonb) from erp_preferences.tag t where(p_type is null or t.type=p_type) and(p_group is null or t.group_id=p_group) and(v_like is null or lower(t.name) like v_like)),
  'total',(select count(*) from erp_preferences.tag t where(p_type is null or t.type=p_type) and(p_group is null or t.group_id=p_group) and(v_like is null or lower(t.name) like v_like)));
end $$;
-- Modal "Inclusão de grupo tag" (Nome; Tipo fixed after creation) and editing a group.
create function public.erp_preferences_tag_group_save(p_user_id uuid,p_command_id uuid,p_group uuid,p_expected_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_replay jsonb;v_row erp_preferences.tag_group;v_name text;v_type text;v_at timestamptz:=clock_timestamp();v_id uuid;v_result jsonb;v_before jsonb;
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or(p_group is null)<>(p_expected_version=0)
  or not erp_preferences.framework_keys(p_data,array['name','type']) or jsonb_typeof(p_data->'type')<>'string' or p_data->>'type' not in('produtos','contatos') then
  raise exception 'erp_preferences_tag_input_invalid' using errcode='22023'; end if;
 v_name:=erp_preferences.framework_text(p_data->'name',60);v_type:=p_data->>'type';
 v_hash:=erp_preferences.framework_hash(jsonb_build_object('op','tag_group_save','actor',p_user_id,'id',p_group,'version',p_expected_version,'data',p_data));
 v_replay:=erp_preferences.framework_replay(p_command_id,p_user_id,'tags',v_hash);if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(hashtext('erp_preferences_tags'),0);
 if exists(select 1 from erp_preferences.tag_group g where g.type=v_type and lower(g.name)=lower(v_name) and g.id is distinct from p_group) then
  raise exception 'erp_preferences_tag_group_name_taken' using errcode='23505'; end if;
 if p_group is null then
  if(select count(*) from erp_preferences.tag_group)>=200 then raise exception 'erp_preferences_tag_group_limit' using errcode='22023'; end if;
  v_id:=gen_random_uuid();
 else
  select * into v_row from erp_preferences.tag_group g where g.id=p_group for update;
  if v_row.id is null then raise exception 'erp_preferences_tag_group_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_preferences_tag_group_version_conflict' using errcode='40001'; end if;
  if v_row.type<>v_type then raise exception 'erp_preferences_tag_type_fixed' using errcode='22023'; end if;
  if v_row.name=v_name then raise exception 'erp_preferences_tag_group_unchanged' using errcode='22023'; end if;
  v_id:=p_group;v_before:=erp_preferences.tag_group_dto(v_row);
 end if;
 v_result:=jsonb_build_object('scope','tags_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'action',case when p_group is null then 'tag_group_create' else 'tag_group_update' end,'target',v_id::text,'count',1,'changed_at',v_at));
 insert into erp_preferences.framework_command(id,actor,area,request_hash,result,created_at) values(p_command_id,p_user_id,'tags',v_hash,v_result,v_at);
 if p_group is null then
  insert into erp_preferences.tag_group(id,type,name,version,created_at,created_by,updated_at,updated_by,command_id) values(v_id,v_type,v_name,1,v_at,p_user_id,v_at,p_user_id,p_command_id) returning * into v_row;
 else
  update erp_preferences.tag_group set name=v_name,version=version+1,updated_at=v_at,updated_by=p_user_id,command_id=p_command_id where id=v_id returning * into v_row;
 end if;
 insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
  values(v_at,p_user_id,p_command_id,'tags',v_result#>>'{receipt,action}',v_id::text,v_before,erp_preferences.tag_group_dto(v_row));
 return v_result||jsonb_build_object('replayed',false);
end $$;
create function public.erp_preferences_tag_save(p_user_id uuid,p_command_id uuid,p_tag uuid,p_expected_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_replay jsonb;v_row erp_preferences.tag;v_name text;v_type text;v_color text;v_group uuid;v_at timestamptz:=clock_timestamp();v_id uuid;v_result jsonb;v_before jsonb;
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or(p_tag is null)<>(p_expected_version=0)
  or not erp_preferences.framework_keys(p_data,array['color','group_id','name','type']) or jsonb_typeof(p_data->'type')<>'string' or p_data->>'type' not in('produtos','contatos')
  or jsonb_typeof(p_data->'color')<>'string' or p_data->>'color'!~'^#[0-9a-f]{6}$'
  or not(jsonb_typeof(p_data->'group_id')='null' or jsonb_typeof(p_data->'group_id')='string' and p_data->>'group_id'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'erp_preferences_tag_input_invalid' using errcode='22023'; end if;
 v_name:=erp_preferences.framework_text(p_data->'name',60);v_type:=p_data->>'type';v_color:=p_data->>'color';v_group:=(p_data->>'group_id')::uuid;
 v_hash:=erp_preferences.framework_hash(jsonb_build_object('op','tag_save','actor',p_user_id,'id',p_tag,'version',p_expected_version,'data',p_data));
 v_replay:=erp_preferences.framework_replay(p_command_id,p_user_id,'tags',v_hash);if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(hashtext('erp_preferences_tags'),0);
 if v_group is not null and not exists(select 1 from erp_preferences.tag_group g where g.id=v_group and g.type=v_type) then
  raise exception 'erp_preferences_tag_group_not_found' using errcode='P0002'; end if;
 if exists(select 1 from erp_preferences.tag t where t.type=v_type and lower(t.name)=lower(v_name) and t.id is distinct from p_tag) then
  raise exception 'erp_preferences_tag_name_taken' using errcode='23505'; end if;
 if p_tag is null then
  if(select count(*) from erp_preferences.tag)>=1000 then raise exception 'erp_preferences_tag_limit' using errcode='22023'; end if;
  v_id:=gen_random_uuid();
 else
  select * into v_row from erp_preferences.tag t where t.id=p_tag for update;
  if v_row.id is null then raise exception 'erp_preferences_tag_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_preferences_tag_version_conflict' using errcode='40001'; end if;
  if v_row.type<>v_type then raise exception 'erp_preferences_tag_type_fixed' using errcode='22023'; end if;
  if v_row.name=v_name and v_row.color=v_color and v_row.group_id is not distinct from v_group then raise exception 'erp_preferences_tag_unchanged' using errcode='22023'; end if;
  v_id:=p_tag;v_before:=erp_preferences.tag_dto(v_row);
 end if;
 v_result:=jsonb_build_object('scope','tags_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'action',case when p_tag is null then 'tag_create' else 'tag_update' end,'target',v_id::text,'count',1,'changed_at',v_at));
 insert into erp_preferences.framework_command(id,actor,area,request_hash,result,created_at) values(p_command_id,p_user_id,'tags',v_hash,v_result,v_at);
 if p_tag is null then
  insert into erp_preferences.tag(id,type,group_id,name,color,version,created_at,created_by,updated_at,updated_by,command_id)
   values(v_id,v_type,v_group,v_name,v_color,1,v_at,p_user_id,v_at,p_user_id,p_command_id) returning * into v_row;
 else
  update erp_preferences.tag set group_id=v_group,name=v_name,color=v_color,version=version+1,updated_at=v_at,updated_by=p_user_id,command_id=p_command_id where id=v_id returning * into v_row;
 end if;
 insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
  values(v_at,p_user_id,p_command_id,'tags',v_result#>>'{receipt,action}',v_id::text,v_before,erp_preferences.tag_dto(v_row));
 return v_result||jsonb_build_object('replayed',false);
end $$;
-- "Excluir" of the lists: all or nothing, each by version. Deleting a group keeps its tags, without group.
create function public.erp_preferences_tags_delete(p_user_id uuid,p_command_id uuid,p_target text,p_items jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_replay jsonb;v_at timestamptz:=clock_timestamp();v_result jsonb;i jsonb;v_group erp_preferences.tag_group;v_tag erp_preferences.tag;v_count integer;v_moved integer;
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null or p_target is null or p_target not in('groups','tags') or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
  or exists(select 1 from jsonb_array_elements(p_items) x where not erp_preferences.framework_keys(x,array['expected_version','id']) or jsonb_typeof(x->'id')<>'string'
   or x->>'id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or erp_preferences.framework_version(x->'expected_version') is null)
  or(select count(distinct x->>'id') from jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) then
  raise exception 'erp_preferences_tag_input_invalid' using errcode='22023'; end if;
 v_hash:=erp_preferences.framework_hash(jsonb_build_object('op','tags_delete','actor',p_user_id,'target',p_target,'items',p_items));
 v_replay:=erp_preferences.framework_replay(p_command_id,p_user_id,'tags',v_hash);if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(hashtext('erp_preferences_tags'),0);
 v_count:=jsonb_array_length(p_items);
 v_result:=jsonb_build_object('scope','tags_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'action',case p_target when 'groups' then 'tag_groups_delete' else 'tags_delete' end,'target',null,'count',v_count,'changed_at',v_at));
 insert into erp_preferences.framework_command(id,actor,area,request_hash,result,created_at) values(p_command_id,p_user_id,'tags',v_hash,v_result,v_at);
 for i in select x from jsonb_array_elements(p_items) x order by x->>'id' loop
  if p_target='groups' then
   select * into v_group from erp_preferences.tag_group g where g.id=(i->>'id')::uuid for update;
   if v_group.id is null then raise exception 'erp_preferences_tag_group_not_found' using errcode='P0002'; end if;
   if v_group.version<>(i->>'expected_version')::integer then raise exception 'erp_preferences_tag_group_version_conflict' using errcode='40001'; end if;
   update erp_preferences.tag set group_id=null,version=version+1,updated_at=v_at,updated_by=p_user_id,command_id=p_command_id where group_id=v_group.id;
   get diagnostics v_moved=row_count;
   delete from erp_preferences.tag_group g where g.id=v_group.id;
   insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
    values(v_at,p_user_id,p_command_id,'tags','tag_group_delete',v_group.id::text,erp_preferences.tag_group_dto(v_group),jsonb_build_object('tags_without_group',v_moved));
  else
   select * into v_tag from erp_preferences.tag t where t.id=(i->>'id')::uuid for update;
   if v_tag.id is null then raise exception 'erp_preferences_tag_not_found' using errcode='P0002'; end if;
   if v_tag.version<>(i->>'expected_version')::integer then raise exception 'erp_preferences_tag_version_conflict' using errcode='40001'; end if;
   delete from erp_preferences.tag t where t.id=v_tag.id;
   insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
    values(v_at,p_user_id,p_command_id,'tags','tag_delete',v_tag.id::text,erp_preferences.tag_dto(v_tag),null);
  end if;
 end loop;
 return v_result||jsonb_build_object('replayed',false);
end $$;


-- Registro de atividades: as alterações destas telas entram no registro (módulo Preferências) e cada registro com antes e
-- depois guardados na auditoria do módulo abre o detalhe (Origin: "Detalhes do registro"). A versão substituída de
-- erp_activity.entries é a de 118; qualquer outra interrompe a migração.
do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure('erp_activity.entries(timestamptz,timestamptz)')) is distinct from '22602761cd8ccbb00820ebb37aa9a3903191f89dbdd15c546e3a22052cdc1055' then
  raise exception 'activity_entries_148_previous_definition_changed' using errcode='55000';end if;
end$$;
create or replace function erp_activity.entries(p_from timestamptz,p_to timestamptz)
returns table(source text,entry_id text,created_at timestamptz,actor uuid,module text,operation text,code text,description text)
language sql stable set search_path=pg_catalog as $$
 select 'catalog',a.id::text,a.created_at,a.actor,case a.entity when 'contacts' then 'clientes_fornecedores' when 'products' then 'produtos' else 'depositos' end,
  erp_activity.operation(a.action),r.code,left(r.name,200)
 from erp_catalog.audit a join erp_catalog.record r on r.id=a.record_id where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'documents',a.id::text,a.created_at,a.actor,erp_activity.kind_module(d.kind),erp_activity.operation(a.action),d.number::text,
  left(erp_activity.kind_label(d.kind)||' nº '||d.number||coalesce(' · '||nullif(btrim(a.reason),''),''),200)
 from erp_documents.audit a join erp_documents.document d on d.id=a.document_id where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'finance',a.id::text,a.created_at,a.actor,'financas',erp_activity.operation(a.action),null,
  case a.action when 'account_save' then 'Conta financeira' when 'category_save' then 'Categoria financeira' when 'title_create_group' then 'Contas incluídas'
   when 'title_update' then 'Conta alterada' when 'title_cancel' then 'Conta cancelada' when 'settle' then 'Baixa de conta' when 'reverse' then 'Estorno de baixa'
   when 'opening' then 'Saldo inicial de conta financeira' when 'document_post' then 'Contas lançadas pelo documento' when 'document_reverse' then 'Contas estornadas do documento'
   else 'Operação financeira' end
 from erp_finance.audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'stock',m.id::text,m.created_at,m.actor,'estoque',case m.kind when 'transfer' then 'transferencia' when 'reversal' then 'estorno' else 'lancamento' end,m.reference,left(m.reason,200)
 from erp_stock.movement m where m.created_at>=p_from and m.created_at<p_to
 union all
 select 'cnab',a.id::text,a.created_at,a.actor,'cobranca','lancamento',null,'Cobrança bancária'
 from erp_cnab.audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'fiscal_drafts',a.id::text,a.created_at,a.actor,'notas_fiscais',erp_activity.operation(a.action),null,
  'Rascunho de '||case d.model when '65' then 'NFC-e' else 'NF-e' end||' (homologação)'
 from erp_fiscal_drafts.audit a join erp_fiscal_drafts.draft d on d.id=a.draft_id where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'company',a.id::text,a.created_at,a.actor,'empresa','atualizacao',null,'Dados da empresa'
 from erp_company.audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'attachments',a.id::text,a.created_at,a.actor,'anexos',erp_activity.operation(a.action),null,left('Anexo '||t.filename,200)
 from erp_attachments.audit a join erp_attachments.attachment t on t.id=a.attachment_id where a.action in('finalize','abort') and a.created_at>=p_from and a.created_at<p_to
 union all
 select 'preferences',a.id::text,a.created_at,a.actor,'preferencias','atualizacao',a.key,'Preferência alterada'
 from erp_preferences.audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'list_preferences',a.id::text,a.created_at,a.actor,'preferencias','atualizacao',a.list_id,'Listagem customizada'
 from erp_list_preferences.audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'home',a.id::text,a.created_at,a.actor,'pagina_inicial','atualizacao',null,'Atalhos favoritos'
 from erp_home.shortcut_audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'users',a.id::text,a.created_at,a.actor,'usuarios',
  case when(a.before_data->>'active')::boolean and not(a.after_data->>'active')::boolean then 'exclusao'
   when a.before_data->>'role' is null and(a.after_data->>'active')::boolean then 'criacao' else 'atualizacao' end,
  null,left('Usuário '||erp_activity.actor_label(a.target),200)
 from erp_access.user_audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 148-149: Gerenciador de transições, grupos de tags e tags, Relatórios customizados e Etiquetas customizadas (Preferências).
 select 'frameworks',a.id::text,a.created_at,a.actor,'preferencias',
  case when a.action like '%create' then 'criacao' when a.action like '%delete' then 'exclusao' else 'atualizacao' end,left(a.target,120),
  case a.area when 'situations' then case when a.action like 'transition%' then 'Transição de situação' else 'Situação personalizada' end
   when 'tags' then case when a.action like 'tag_group%' then 'Grupo de tags' else 'Tag' end when 'reports' then 'Relatório customizado' else 'Etiqueta customizada' end
 from erp_preferences.framework_audit a where a.created_at>=p_from and a.created_at<p_to
$$;
revoke all on function erp_activity.entries(timestamptz,timestamptz) from public,anon,authenticated,service_role;
-- Antes e depois de um registro (administrador). Origens sem esse dado na auditoria (estoque, cobrança, rascunhos fiscais e
-- anexos) respondem available=false; um detalhe acima de 200 mil bytes (o limite de resposta da rota é de 256 KiB, em bytes,
-- e um texto acentuado ocupa mais bytes que caracteres) responde truncated=true sem os dados.
create function public.erp_activity_detail(p_user_id uuid,p_source text,p_entry_id text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_id bigint;v_before jsonb;v_after jsonb;v_found boolean:=false;v_size integer;
begin
 perform erp_activity.require_admin(p_user_id);
 if p_source is null or p_source not in('catalog','documents','finance','stock','cnab','fiscal_drafts','company','attachments','preferences','list_preferences','home','users','frameworks') or p_entry_id is null or p_entry_id!~'^[0-9a-f-]{1,40}$' then
  raise exception 'erp_activity_input_invalid' using errcode='22023'; end if;
 if p_source in('stock','cnab','fiscal_drafts','attachments') then
  return jsonb_build_object('scope','activity_detail','data_mode','erp_native','source',p_source,'id',p_entry_id,'available',false,'truncated',false,'before',null,'after',null);
 end if;
 if p_entry_id!~'^[1-9][0-9]{0,17}$' then raise exception 'erp_activity_input_invalid' using errcode='22023'; end if;
 v_id:=p_entry_id::bigint;
 case p_source
  when 'catalog' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_catalog.audit a where a.id=v_id;
  when 'documents' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_documents.audit a where a.id=v_id;
  when 'finance' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_finance.audit a where a.id=v_id;
  when 'company' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_company.audit a where a.id=v_id;
  when 'preferences' then select true,jsonb_build_object(a.key,a.before_value),jsonb_build_object(a.key,a.after_value) into v_found,v_before,v_after from erp_preferences.audit a where a.id=v_id;
  when 'list_preferences' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_list_preferences.audit a where a.id=v_id;
  when 'home' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_home.shortcut_audit a where a.id=v_id;
  when 'users' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_access.user_audit a where a.id=v_id;
  else select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_preferences.framework_audit a where a.id=v_id;
 end case;
 if not coalesce(v_found,false) then raise exception 'erp_activity_entry_not_found' using errcode='P0002'; end if;
 v_size:=coalesce(octet_length(v_before::text),0)+coalesce(octet_length(v_after::text),0);
 return jsonb_build_object('scope','activity_detail','data_mode','erp_native','source',p_source,'id',p_entry_id,'available',true,'truncated',v_size>200000,
  'before',case when v_size>200000 then null else v_before end,'after',case when v_size>200000 then null else v_after end);
end $$;
revoke all on function public.erp_activity_detail(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_activity_detail(uuid,text,text) to service_role;

revoke all on all functions in schema erp_preferences from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_preferences_situations','erp_preferences_situation_save','erp_preferences_transition_save','erp_preferences_transitions_delete',
 'erp_preferences_tag_groups','erp_preferences_tags','erp_preferences_tag_group_save','erp_preferences_tag_save','erp_preferences_tags_delete')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
