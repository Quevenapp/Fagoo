-- Uma empresa; identidade comercial separada da confirmação fiscal. Não habilita emissão.
begin;
create schema erp_company;
revoke all on schema erp_company from public,anon,authenticated,service_role;
create table erp_company.identity (
 singleton boolean primary key default true check(singleton),version integer not null check(version>0),
 data jsonb not null check(jsonb_typeof(data)='object'),created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid not null references auth.users(id)
);
create table erp_company.fiscal (
 singleton boolean primary key references erp_company.identity(singleton),version integer not null check(version>0),
 crt text check(crt in('1','2','3','4')),confirmed_at timestamptz,confirmed_by uuid references auth.users(id),
 reason text,updated_at timestamptz not null default clock_timestamp(),
 check((crt is null and confirmed_at is null and confirmed_by is null)or(crt is not null and confirmed_at is not null and confirmed_by is not null))
);
create table erp_company.command(command_id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null,result jsonb not null,created_at timestamptz not null default clock_timestamp());
create table erp_company.audit(id bigint generated always as identity primary key,actor uuid not null references auth.users(id),command_id uuid not null,action text not null,before_data jsonb,after_data jsonb,created_at timestamptz not null default clock_timestamp());
alter table erp_company.identity enable row level security;
alter table erp_company.fiscal enable row level security;
alter table erp_company.command enable row level security;
alter table erp_company.audit enable row level security;
revoke all on all tables in schema erp_company from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_company from public,anon,authenticated,service_role;
alter default privileges in schema erp_company revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_company revoke all on functions from public,anon,authenticated,service_role;
create function erp_company.require_access(p_user uuid,p_operation text)returns text language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;begin
 select role into v_role from erp_access.membership where user_id=p_user and active;
 if not found or p_operation not in('read','identity','fiscal')or(p_operation='identity'and v_role<>'admin')or(p_operation='fiscal'and v_role not in('admin','fiscal'))then
  raise exception 'erp_company_forbidden' using errcode='42501';end if;return v_role;
end $$;
create function erp_company.cnpj(p_input text)returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text:=upper(btrim(p_input));v_base text;v_sum integer;v_weight integer;v_remainder integer;i integer;j integer;
begin
 if v is null or v !~ '^([A-Z0-9]{12}[0-9]{2}|[A-Z0-9]{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}/[A-Z0-9]{4}-[0-9]{2})$'then raise exception 'erp_company_cnpj_invalid'using errcode='22023';end if;
 v:=translate(v,'./-','');if v ~ '^([0-9])\1{13}$'then raise exception 'erp_company_cnpj_invalid'using errcode='22023';end if;
 v_base:=left(v,12);
 for j in 1..2 loop v_sum:=0;v_weight:=2;for i in reverse length(v_base)..1 loop
  v_sum:=v_sum+(ascii(substr(v_base,i,1))-48)*v_weight;v_weight:=case when v_weight=9 then 2 else v_weight+1 end;
 end loop;v_remainder:=v_sum%11;v_base:=v_base||(case when v_remainder<2 then 0 else 11-v_remainder end)::text;end loop;
 if v_base<>v then raise exception 'erp_company_cnpj_invalid'using errcode='22023';end if;return v;
end $$;
create function erp_company.normalize(p_data jsonb)returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_fields jsonb:='{"legal_name":200,"trade_name":200,"cnpj":18,"ie":30,"postal_code":9,"street":200,"number":30,"complement":200,"district":100,"city":100,"municipality_code":7,"state":2,"phone":40,"email":254}';
 v_states jsonb:='{"RO":"11","AC":"12","AM":"13","RR":"14","PA":"15","AP":"16","TO":"17","MA":"21","PI":"22","CE":"23","RN":"24","PB":"25","PE":"26","AL":"27","SE":"28","BA":"29","MG":"31","ES":"32","RJ":"33","SP":"35","PR":"41","SC":"42","RS":"43","MS":"50","MT":"51","GO":"52","DF":"53"}';
 v jsonb:='{}';k text;t text;v_state text;
begin
 if p_data is null or jsonb_typeof(p_data)<>'object'or octet_length(p_data::text)>16384 or exists(select 1 from jsonb_object_keys(p_data)x where not v_fields?x)then raise exception 'erp_company_data_invalid'using errcode='22023';end if;
 for k in select jsonb_object_keys(v_fields)loop
  if p_data?k and p_data->k<>'null'::jsonb then
   if jsonb_typeof(p_data->k)<>'string'then raise exception 'erp_company_field_invalid'using errcode='22023';end if;
   t:=p_data->>k;if length(t)>(v_fields->>k)::integer or t ~ '[[:cntrl:]]'then raise exception 'erp_company_field_invalid'using errcode='22023';end if;t:=nullif(btrim(t),'');
  else t:=null;end if;
  if k=any(array['legal_name','cnpj','postal_code','street','number','district','city','municipality_code','state'])and t is null then raise exception 'erp_company_field_required'using errcode='22023';end if;
  v:=v||jsonb_build_object(k,t);
 end loop;
 v:=v||jsonb_build_object('cnpj',erp_company.cnpj(v->>'cnpj'));v_state:=upper(v->>'state');
 if not v_states?v_state then raise exception 'erp_company_state_invalid'using errcode='22023';end if;
 t:=v->>'postal_code';if t !~ '^[0-9]{5}-?[0-9]{3}$'or replace(t,'-','')='00000000'then raise exception 'erp_company_address_invalid'using errcode='22023';end if;
 v:=v||jsonb_build_object('state',v_state,'postal_code',replace(t,'-',''));
 if v->>'municipality_code'!~'^[0-9]{7}$'or left(v->>'municipality_code',2)<>v_states->>v_state then raise exception 'erp_company_address_invalid'using errcode='22023';end if;
 if v->>'email'is not null and v->>'email'!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'then raise exception 'erp_company_email_invalid'using errcode='22023';end if;
 if v->>'phone'is not null then t:=translate(v->>'phone',' ()-.','');if t!~'^\+?[0-9]{8,15}$'then raise exception 'erp_company_phone_invalid'using errcode='22023';end if;v:=v||jsonb_build_object('phone',t);end if;
 return v;
end $$;
create function erp_company.identity_dto()returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('version',version,'data',data,'created_at',created_at,'updated_at',updated_at)from erp_company.identity where singleton;
$$;
create function erp_company.fiscal_dto()returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('version',f.version,'identity_version',i.version,'crt',f.crt,'confirmed',f.crt is not null,'confirmed_at',f.confirmed_at,'reason',f.reason,'updated_at',f.updated_at)
 from erp_company.fiscal f join erp_company.identity i using(singleton)where f.singleton;
$$;
create function public.erp_company_access(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare r text;begin r:=erp_company.require_access(p_user_id,'read');return jsonb_build_object('read_identity',true,'write_identity',r='admin','read_fiscal',r in('admin','fiscal'),'write_fiscal',r in('admin','fiscal'),'data_mode','erp_native','emission_enabled',false);end $$;
create function public.erp_company_get(p_user_id uuid,p_section text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if p_section not in('identity','fiscal')or p_section is null then raise exception 'erp_company_section_invalid'using errcode='22023';end if;
 perform erp_company.require_access(p_user_id,case when p_section='fiscal'then'fiscal'else'read'end);
 return jsonb_build_object('section',p_section,'record',case when p_section='identity'then erp_company.identity_dto()else erp_company.fiscal_dto()end,'data_mode','erp_native','emission_enabled',false);
end $$;
create function public.erp_company_save_identity(p_user_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_command erp_company.command%rowtype;v_row erp_company.identity%rowtype;v_data jsonb;v_before jsonb;v_result jsonb;v_fiscal jsonb;
begin
 perform erp_company.require_access(p_user_id,'identity');
 if p_expected_version is null or p_expected_version<0 or p_command_id is null then raise exception 'erp_company_command_invalid'using errcode='22023';end if;
 v_data:=erp_company.normalize(p_data);v_hash:=encode(sha256(convert_to(jsonb_build_object('op','identity','actor',p_user_id,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852920,1);
 select * into v_command from erp_company.command where command_id=p_command_id;
 if found then if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_company_command_conflict'using errcode='40001';end if;return v_command.result||'{"replayed":true}'::jsonb;end if;
 select * into v_row from erp_company.identity where singleton for update;
 if coalesce(v_row.version,0)<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_company_version_conflict'using errcode='40001';end if;
 v_before:=erp_company.identity_dto();
 if v_row.version is null then
  insert into erp_company.identity(singleton,version,data,updated_by)values(true,1,v_data,p_user_id);
  insert into erp_company.fiscal(singleton,version)values(true,1);
 elsif v_row.data is distinct from v_data then
  v_fiscal:=erp_company.fiscal_dto();
  update erp_company.identity set data=v_data,version=version+1,updated_at=clock_timestamp(),updated_by=p_user_id where singleton;
  if v_row.data->>'cnpj'<>v_data->>'cnpj'then
   if(v_fiscal->>'version')::integer=2147483647 then raise exception 'erp_company_version_conflict'using errcode='40001';end if;
   update erp_company.fiscal set crt=null,confirmed_at=null,confirmed_by=null,reason=null,version=version+1,updated_at=clock_timestamp()where singleton;
   insert into erp_company.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'fiscal_reset_identity_changed',v_fiscal,erp_company.fiscal_dto());
  end if;
 end if;
 v_result:=jsonb_build_object('section','identity','record',erp_company.identity_dto(),'replayed',false,'data_mode','erp_native','emission_enabled',false);
 if v_before is distinct from v_result->'record'then insert into erp_company.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'save_identity',v_before,v_result->'record');end if;
 insert into erp_company.command values(p_command_id,p_user_id,v_hash,v_result,clock_timestamp());return v_result;
end $$;
create function public.erp_company_confirm_fiscal(p_user_id uuid,p_expected_version integer,p_expected_identity_version integer,p_command_id uuid,p_crt text,p_confirmed boolean,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_command erp_company.command%rowtype;v_row erp_company.fiscal%rowtype;v_identity integer;v_before jsonb;v_result jsonb;v_reason text:=nullif(btrim(p_reason),'');
begin
 perform erp_company.require_access(p_user_id,'fiscal');
 if p_command_id is null or p_expected_version is null or p_expected_version<1 or p_expected_identity_version is null or p_expected_identity_version<1
  or p_confirmed is null or(p_crt is null and p_confirmed)or(p_crt is not null and(not p_confirmed or p_crt not in('1','2','3','4')))
  or v_reason is null or length(v_reason)<3 or length(p_reason)>1000 or p_reason ~ '[[:cntrl:]]'then raise exception 'erp_company_confirmation_invalid'using errcode='22023';end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','fiscal','actor',p_user_id,'version',p_expected_version,'identity_version',p_expected_identity_version,'crt',p_crt,'confirmed',p_confirmed,'reason',p_reason)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852920,1);select * into v_command from erp_company.command where command_id=p_command_id;
 if found then if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_company_command_conflict'using errcode='40001';end if;return v_command.result||'{"replayed":true}'::jsonb;end if;
 select version into v_identity from erp_company.identity where singleton for update;select * into v_row from erp_company.fiscal where singleton for update;
 if v_identity is distinct from p_expected_identity_version or v_row.version is distinct from p_expected_version or v_row.version=2147483647 then raise exception 'erp_company_version_conflict'using errcode='40001';end if;
 v_before:=erp_company.fiscal_dto();
 update erp_company.fiscal set crt=p_crt,confirmed_at=case when p_confirmed then clock_timestamp()end,confirmed_by=case when p_confirmed then p_user_id end,
  reason=v_reason,version=version+1,updated_at=clock_timestamp()where singleton;
 v_result:=jsonb_build_object('section','fiscal','record',erp_company.fiscal_dto(),'replayed',false,'data_mode','erp_native','emission_enabled',false);
 insert into erp_company.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,case when p_crt is null then'clear_fiscal_confirmation'else'confirm_fiscal'end,v_before,v_result->'record');
 insert into erp_company.command values(p_command_id,p_user_id,v_hash,v_result,clock_timestamp());return v_result;
end $$;
revoke all on all functions in schema erp_company from public,anon,authenticated,service_role;
revoke all on function public.erp_company_access(uuid),public.erp_company_get(uuid,text),public.erp_company_save_identity(uuid,integer,uuid,jsonb),public.erp_company_confirm_fiscal(uuid,integer,integer,uuid,text,boolean,text)from public,anon,authenticated,service_role;
grant execute on function public.erp_company_access(uuid),public.erp_company_get(uuid,text),public.erp_company_save_identity(uuid,integer,uuid,jsonb),public.erp_company_confirm_fiscal(uuid,integer,integer,uuid,text,boolean,text)to service_role;
commit;
