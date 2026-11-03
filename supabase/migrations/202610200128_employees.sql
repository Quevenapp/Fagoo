-- Cadastros > Funcionários no padrão do Origin (lane contatos, onda B): listagem com Situação (Todas, Ativos, Desligados)
-- e formulário com Dados cadastrais, Contato e Endereço/Observações. Dados pessoais e salário: somente administrador,
-- em leitura e gravação. Pagamento de salário, Pix recorrente e "Alteração de salário" com segundo fator ficam fora
-- (Origin Conta / decisão do dono); nenhuma conta a pagar é criada. Foto depende do armazenamento de anexos (outra área).
begin;

create function erp_catalog.valid_pis(p_value text) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare v_sum integer:=0; v_digit integer; i integer; v_weights integer[]:=array[3,2,9,8,7,6,5,4,3,2];
begin
 if p_value is null or p_value!~'^[0-9]{11}$' or p_value~'^([0-9])\1{10}$' then return false; end if;
 for i in 1..10 loop v_sum:=v_sum+substr(p_value,i,1)::integer*v_weights[i]; end loop;
 v_digit:=11-(v_sum%11); if v_digit>=10 then v_digit:=0; end if;
 return v_digit=substr(p_value,11,1)::integer;
end $$;

create table erp_catalog.employee(
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(name) between 1 and 200 and name=btrim(name) and name!~'[[:cntrl:]]'),
 cpf text not null check(cpf~'^[0-9]{11}$'),
 rg text, birth_date date, job_title text, admission_date date, pis text check(pis~'^[0-9]{11}$'), ctps text, code text,
 salary numeric(18,2) check(salary>=0),
 phone text, mobile text, email text, emergency_phone text,
 postal_code text, state text, city text, district text, street text, number text, complement text, notes text,
 situation text not null default 'ativo' check(situation in('ativo','desligado')),
 version integer not null default 1 check(version between 1 and 2147483647),
 created_by uuid not null references auth.users(id), updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create unique index erp_catalog_employee_cpf on erp_catalog.employee(cpf);
create index erp_catalog_employee_list on erp_catalog.employee(erp_catalog.fold(name),id);
alter table erp_catalog.employee enable row level security;
revoke all on erp_catalog.employee from public,anon,authenticated,service_role;

create function erp_catalog.employee_admin(p_user_id uuid) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin') then
  raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
end $$;
create function erp_catalog.employee_dto(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',e.id,'version',e.version,'name',e.name,'cpf',e.cpf,'rg',e.rg,'birth_date',to_char(e.birth_date,'YYYY-MM-DD'),'job_title',e.job_title,
  'admission_date',to_char(e.admission_date,'YYYY-MM-DD'),'pis',e.pis,'ctps',e.ctps,'code',e.code,'salary',e.salary::text,'phone',e.phone,'mobile',e.mobile,
  'email',e.email,'emergency_phone',e.emergency_phone,'postal_code',e.postal_code,'state',e.state,'city',e.city,'district',e.district,'street',e.street,
  'number',e.number,'complement',e.complement,'notes',e.notes,'situation',e.situation,'created_at',e.created_at,'updated_at',e.updated_at)
 from erp_catalog.employee e where e.id=p_id
$$;
create function erp_catalog.employee_input(p jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v_texts jsonb:='{"name":200,"cpf":14,"rg":20,"job_title":100,"pis":14,"ctps":30,"code":30,"phone":40,"mobile":40,"email":254,"emergency_phone":40,
 "postal_code":20,"state":2,"city":100,"district":100,"street":200,"number":30,"complement":200}'::jsonb; v_keys text[]; v jsonb:='{}'::jsonb; v_key text; v_text text;
begin
 v_keys:=array(select jsonb_object_keys(v_texts))||array['birth_date','admission_date','salary','notes'];
 if p is null or jsonb_typeof(p)<>'object' or exists(select 1 from jsonb_object_keys(p) k where not k=any(v_keys)) or(select count(*) from jsonb_object_keys(p))<>cardinality(v_keys) then
  raise exception 'erp_catalog_employee_invalid' using errcode='22023'; end if;
 for v_key in select jsonb_object_keys(v_texts) loop
  v_text:=erp_catalog.contact_text(v_key,p->v_key,(v_texts->>v_key)::integer);
  if v_key in('cpf','pis') then v_text:=nullif(regexp_replace(coalesce(v_text,''),'[ ./-]','','g'),''); end if;
  if v_key='state' then v_text:=upper(v_text); end if;
  v:=v||jsonb_build_object(v_key,v_text);
 end loop;
 if v->>'name' is null then raise exception 'erp_catalog_employee_invalid:name' using errcode='22023'; end if;
 if v->>'cpf' is null or not erp_catalog.valid_cpf(v->>'cpf') then raise exception 'erp_catalog_employee_invalid:cpf' using errcode='22023'; end if;
 if v->>'pis' is not null and not erp_catalog.valid_pis(v->>'pis') then raise exception 'erp_catalog_employee_invalid:pis' using errcode='22023'; end if;
 if not erp_catalog.contact_email_list(v->>'email',254) then raise exception 'erp_catalog_employee_invalid:email' using errcode='22023'; end if;
 if not erp_catalog.contact_uf(v->>'state') then raise exception 'erp_catalog_employee_invalid:state' using errcode='22023'; end if;
 v:=v||jsonb_build_object('birth_date',to_char(erp_catalog.contact_date('birth_date',p->'birth_date'),'YYYY-MM-DD'),
  'admission_date',to_char(erp_catalog.contact_date('admission_date',p->'admission_date'),'YYYY-MM-DD'),'notes',erp_catalog.contact_text('notes',p->'notes',4000,true));
 if v->>'birth_date' is not null and(v->>'birth_date')::date>(clock_timestamp() at time zone 'America/Sao_Paulo')::date then raise exception 'erp_catalog_employee_invalid:birth_date' using errcode='22023'; end if;
 v_text:=erp_catalog.contact_text('salary',p->'salary',20);
 if v_text is not null and v_text!~'^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$' then raise exception 'erp_catalog_employee_invalid:salary' using errcode='22023'; end if;
 return v||jsonb_build_object('salary',v_text::numeric(18,2)::text);
end $$;

create function public.erp_catalog_employee_page(p_user_id uuid,p_page integer default 1,p_size integer default 100,p_query text default null,p_situation text default 'ativos')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_terms text[]; v_total bigint; v_ids uuid[];
begin
 perform erp_catalog.employee_admin(p_user_id);
 if p_page is null or p_page not between 1 and 100000 or p_size is null or p_size not between 1 and 100 or(p_query is not null and(length(p_query)>120 or p_query~'[[:cntrl:]]'))
  or p_situation is null or p_situation not in('todas','ativos','desligados') then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_terms:=erp_catalog.search_terms(p_query);
 with f as materialized(select e.id,e.name from erp_catalog.employee e where(p_situation='todas' or e.situation=case p_situation when 'ativos' then 'ativo' else 'desligado' end)
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',e.name,e.code,e.job_title,e.cpf)),e.cpf,e.cpf)))
 select(select count(*) from f),array(select id from f order by erp_catalog.fold(name),id offset (p_page-1)*p_size limit p_size) into v_total,v_ids;
 return jsonb_build_object('entity','employees','page',p_page,'size',p_size,'total',v_total,'situation',p_situation,'data_mode','erp_native',
  'items',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'version',e.version,'name',e.name,'cpf',e.cpf,'job_title',e.job_title,
   'admission_date',to_char(e.admission_date,'YYYY-MM-DD'),'situation',e.situation) order by u.n),'[]'::jsonb) from unnest(v_ids) with ordinality u(id,n) join erp_catalog.employee e on e.id=u.id));
end $$;
create function public.erp_catalog_employee_get(p_user_id uuid,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.employee_admin(p_user_id);
 if p_id is null or not exists(select 1 from erp_catalog.employee where id=p_id) then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('entity','employees','data_mode','erp_native','item',erp_catalog.employee_dto(p_id));
end $$;
create function public.erp_catalog_employee_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb,p_situation text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.employee%rowtype; v jsonb; v_id uuid; v_before jsonb; v_result jsonb; v_situation text;
begin
 perform erp_catalog.employee_admin(p_user_id);
 if p_command_id is null or p_expected_version is null or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647)
  or(p_situation is not null and p_situation not in('ativo','desligado')) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-employee-save-v1','actor',p_user_id,'id',p_id,'version',p_expected_version,'data',p_data,'situation',p_situation)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 if p_id is not null then
  select * into v_row from erp_catalog.employee where id=p_id for update;
  if v_row.id is null then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
 end if;
 -- p_data null only changes the situation (Desligar / Reativar); otherwise the whole form is sent.
 v:=case when p_data is null and p_id is not null then erp_catalog.employee_dto(p_id)-'id'-'version'-'situation'-'created_at'-'updated_at' else erp_catalog.employee_input(p_data) end;
 v_situation:=coalesce(p_situation,v_row.situation,'ativo');
 if exists(select 1 from erp_catalog.employee where cpf=v->>'cpf' and id is distinct from p_id) then raise exception 'erp_catalog_employee_cpf_exists' using errcode='23505'; end if;
 if p_id is null then
  insert into erp_catalog.employee(name,cpf,rg,birth_date,job_title,admission_date,pis,ctps,code,salary,phone,mobile,email,emergency_phone,postal_code,state,city,district,street,number,
   complement,notes,situation,created_by,updated_by)
  values(v->>'name',v->>'cpf',v->>'rg',(v->>'birth_date')::date,v->>'job_title',(v->>'admission_date')::date,v->>'pis',v->>'ctps',v->>'code',(v->>'salary')::numeric,v->>'phone',
   v->>'mobile',v->>'email',v->>'emergency_phone',v->>'postal_code',v->>'state',v->>'city',v->>'district',v->>'street',v->>'number',v->>'complement',v->>'notes',v_situation,p_user_id,p_user_id)
  returning id into v_id;
  insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,after_data) values(p_user_id,p_command_id,'employee',v_id,'create',jsonb_build_object('name',v->>'name'));
 else
  v_id:=p_id; v_before:=erp_catalog.employee_dto(p_id);
  if (v_before-'id'-'version'-'situation'-'created_at'-'updated_at') is distinct from v or v_situation<>v_row.situation then
   update erp_catalog.employee set name=v->>'name',cpf=v->>'cpf',rg=v->>'rg',birth_date=(v->>'birth_date')::date,job_title=v->>'job_title',admission_date=(v->>'admission_date')::date,
    pis=v->>'pis',ctps=v->>'ctps',code=v->>'code',salary=(v->>'salary')::numeric,phone=v->>'phone',mobile=v->>'mobile',email=v->>'email',emergency_phone=v->>'emergency_phone',
    postal_code=v->>'postal_code',state=v->>'state',city=v->>'city',district=v->>'district',street=v->>'street',number=v->>'number',complement=v->>'complement',notes=v->>'notes',
    situation=v_situation,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
   -- Personal data and salary stay out of the audit trail; only the fact and the situation are kept.
   insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,before_data,after_data)
    values(p_user_id,p_command_id,'employee',v_id,case when v_situation<>v_row.situation then 'transition' else 'update' end,
     jsonb_build_object('situation',v_row.situation),jsonb_build_object('situation',v_situation));
  end if;
 end if;
 -- Only the id and version are returned and kept with the command, never the personal data: the form reads the employee again.
 v_result:=jsonb_build_object('entity','employees','data_mode','erp_native','replayed',false,'item',jsonb_build_object('id',v_id,'version',(select version from erp_catalog.employee where id=v_id)));
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_employee_page(uuid,integer,integer,text,text)','erp_catalog_employee_get(uuid,uuid)','erp_catalog_employee_save(uuid,uuid,integer,uuid,jsonb,text)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
