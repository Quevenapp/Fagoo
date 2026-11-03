-- Cadastros > Formas de pagamento no padrão do Origin (lane contatos, onda B): listagem com Método aplicável, Conta
-- financeira e Situação; formulário em página única com Informações gerais, Juros e multas (boleto), Informações de cartão,
-- Informações de PIX e Informações de taxas; menu ⋮ Forma padrão, Duplicar e Inativar; e a lixeira. Somente cadastro:
-- nenhuma parcela, título, baixa, taxa, NF-e (tPag) ou operação bancária passa a usar estes valores aqui; as áreas de
-- vendas, financeiro e notas passam a ler a forma de pagamento quando adotarem o cadastro. Não há integração de Pix,
-- POS ou TEF (fora do escopo: operação bancária real). Leitura: admin, consulta, financeiro e vendas. Gravação: admin e
-- financeiro. A conta financeira é lida de erp_finance.account sem alterá-la.
begin;

create table erp_catalog.payment_method(
 id uuid primary key default gen_random_uuid(),
 description text not null check(length(description) between 1 and 100 and description=btrim(description) and description!~'[[:cntrl:]]'),
 payment_type text not null check(payment_type in('01','02','03','04','05','10','11','12','13','14','15','16','17','18','19','20','21','22','90','91','99')),
 condition text check(length(condition)<=100),
 destination text not null check(destination in('contas','ficha','caixa')),
 account_id uuid references erp_finance.account(id),
 business_days boolean not null default false,
 applicable text not null check(applicable in('pagamentos','recebimentos','ambos')),
 interest_rate numeric(7,4) check(interest_rate between 0 and 100),
 fine_rate numeric(7,4) check(fine_rate between 0 and 100),
 card_brand text check(card_brand in('01','02','03','04','05','06','07','08','09','99')),
 card_integration text check(card_integration in('1','2')),
 card_cnpj text check(card_cnpj~'^[A-Z0-9]{12}[0-9]{2}$'),
 auto_settle boolean not null default false,
 pix_integration text check(pix_integration in('sem')),
 pix_cnpj text check(pix_cnpj~'^[A-Z0-9]{12}[0-9]{2}$'),
 fee_type text not null default 'aliquota' check(fee_type in('aliquota','fixa','aliquota_fixa')),
 fee_rate numeric(7,4) check(fee_rate between 0 and 100),
 fee_fixed numeric(18,2) check(fee_fixed>=0),
 settlement_days integer check(settlement_days between 0 and 365),
 active boolean not null default true,
 is_default boolean not null default false,
 version integer not null default 1 check(version between 1 and 2147483647),
 created_by uuid not null references auth.users(id), updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 deleted_by uuid references auth.users(id), deleted_at timestamptz,
 check(destination<>'ficha' or account_id is null),
 check(not is_default or(active and deleted_at is null))
);
create unique index erp_catalog_payment_method_default on erp_catalog.payment_method(is_default) where is_default;
create index erp_catalog_payment_method_list on erp_catalog.payment_method(created_at desc,id desc) where deleted_at is null;
alter table erp_catalog.payment_method enable row level security;
revoke all on erp_catalog.payment_method from public,anon,authenticated,service_role;

create function erp_catalog.payment_method_access(p_user_id uuid,p_write boolean) returns text
language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if v_role is null or not(case when p_write then v_role in('admin','financeiro') else v_role in('admin','consulta','financeiro','vendas') end) then
  raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
 return v_role;
end $$;
create function erp_catalog.payment_method_dto(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',m.id,'version',m.version,'description',m.description,'payment_type',m.payment_type,'condition',m.condition,'destination',m.destination,
  'account_id',m.account_id,'account_name',(select left(a.name,200) from erp_finance.account a where a.id=m.account_id),'business_days',m.business_days,
  'applicable',m.applicable,'interest_rate',m.interest_rate::text,'fine_rate',m.fine_rate::text,'card_brand',m.card_brand,'card_integration',m.card_integration,
  'card_cnpj',m.card_cnpj,'auto_settle',m.auto_settle,'pix_integration',m.pix_integration,'pix_cnpj',m.pix_cnpj,'fee_type',m.fee_type,'fee_rate',m.fee_rate::text,
  'fee_fixed',m.fee_fixed::text,'settlement_days',m.settlement_days,'active',m.active,'is_default',m.is_default,'created_at',m.created_at,'updated_at',m.updated_at)
 from erp_catalog.payment_method m where m.id=p_id and m.deleted_at is null
$$;
create function erp_catalog.payment_method_accounts() returns jsonb
language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',left(a.name,200),'active',a.active) order by lower(a.name),a.id),'[]'::jsonb)
 from(select id,name,active from erp_finance.account order by lower(name),id limit 500) a
$$;
-- Every key is sent; fields of hidden sections (by payment type) must be empty, as the single-page form clears them.
create function erp_catalog.payment_method_input(p jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v_keys text[]:=array['description','payment_type','condition','destination','account_id','business_days','applicable','interest_rate','fine_rate','card_brand',
 'card_integration','card_cnpj','auto_settle','pix_integration','pix_cnpj','fee_type','fee_rate','fee_fixed','settlement_days']; v_type text; v_text text; v_key text;
 v_card boolean; v_pix boolean; v_boleto boolean;
begin
 if p is null or jsonb_typeof(p)<>'object' or exists(select 1 from jsonb_object_keys(p) k where not k=any(v_keys)) or(select count(*) from jsonb_object_keys(p))<>cardinality(v_keys) then
  raise exception 'erp_catalog_payment_method_invalid' using errcode='22023'; end if;
 foreach v_key in array array['description','payment_type','condition','destination','account_id','applicable','interest_rate','fine_rate','card_brand','card_integration',
  'card_cnpj','pix_integration','pix_cnpj','fee_type','fee_rate','fee_fixed'] loop
  if p->v_key<>'null'::jsonb and jsonb_typeof(p->v_key)<>'string' then raise exception 'erp_catalog_payment_method_invalid:%',v_key using errcode='22023'; end if;
 end loop;
 foreach v_key in array array['business_days','auto_settle'] loop
  if jsonb_typeof(p->v_key)<>'boolean' then raise exception 'erp_catalog_payment_method_invalid:%',v_key using errcode='22023'; end if;
 end loop;
 v_text:=erp_catalog.contact_text('description',p->'description',100);
 if v_text is null then raise exception 'erp_catalog_payment_method_invalid:description' using errcode='22023'; end if;
 v_type:=p->>'payment_type';
 if v_type is null or v_type not in('01','02','03','04','05','10','11','12','13','14','15','16','17','18','19','20','21','22','90','91','99') then
  raise exception 'erp_catalog_payment_method_invalid:payment_type' using errcode='22023'; end if;
 v_card:=v_type in('03','04'); v_pix:=v_type in('17','20'); v_boleto:=v_type='15';
 if not erp_catalog.payment_condition_valid(p->>'condition') then raise exception 'erp_catalog_payment_method_invalid:condition' using errcode='22023'; end if;
 if p->>'destination' is null or p->>'destination' not in('contas','ficha','caixa') or p->>'applicable' is null or p->>'applicable' not in('pagamentos','recebimentos','ambos')
  or p->>'fee_type' is null or p->>'fee_type' not in('aliquota','fixa','aliquota_fixa') then raise exception 'erp_catalog_payment_method_invalid:choice' using errcode='22023'; end if;
 if p->>'account_id' is not null and(p->>'account_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or p->>'destination'='ficha') then
  raise exception 'erp_catalog_payment_method_invalid:account_id' using errcode='22023'; end if;
 foreach v_key in array array['interest_rate','fine_rate','fee_rate'] loop
  if not erp_catalog.percent_valid(p->v_key,true) then raise exception 'erp_catalog_payment_method_invalid:%',v_key using errcode='22023'; end if;
 end loop;
 if p->>'fee_fixed' is not null and(p->>'fee_fixed'!~'^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$') then raise exception 'erp_catalog_payment_method_invalid:fee_fixed' using errcode='22023'; end if;
 if p->'settlement_days'<>'null'::jsonb and(jsonb_typeof(p->'settlement_days')<>'number' or(p->'settlement_days')::text!~'^(0|[1-9][0-9]{0,2})$' or(p->>'settlement_days')::integer>365) then
  raise exception 'erp_catalog_payment_method_invalid:settlement_days' using errcode='22023'; end if;
 if(not v_boleto and num_nonnulls(p->>'interest_rate',p->>'fine_rate')>0)
  or(not v_card and(num_nonnulls(p->>'card_brand',p->>'card_integration',p->>'card_cnpj')>0 or(p->>'auto_settle')::boolean))
  or(not v_pix and num_nonnulls(p->>'pix_integration',p->>'pix_cnpj')>0) then raise exception 'erp_catalog_payment_method_invalid:section' using errcode='22023'; end if;
 if p->>'card_brand' is not null and p->>'card_brand' not in('01','02','03','04','05','06','07','08','09','99') or p->>'card_integration' is not null and p->>'card_integration' not in('1','2')
  or p->>'pix_integration' is not null and p->>'pix_integration'<>'sem' then raise exception 'erp_catalog_payment_method_invalid:choice' using errcode='22023'; end if;
 if p->>'card_cnpj' is not null and not erp_catalog.valid_cnpj(upper(regexp_replace(p->>'card_cnpj','[ ./-]','','g'))) then raise exception 'erp_catalog_payment_method_invalid:card_cnpj' using errcode='22023'; end if;
 if p->>'pix_cnpj' is not null and not erp_catalog.valid_cnpj(upper(regexp_replace(p->>'pix_cnpj','[ ./-]','','g'))) then raise exception 'erp_catalog_payment_method_invalid:pix_cnpj' using errcode='22023'; end if;
 if(p->>'fee_type'='aliquota' and p->>'fee_fixed' is not null) or(p->>'fee_type'='fixa' and p->>'fee_rate' is not null) then raise exception 'erp_catalog_payment_method_invalid:fee' using errcode='22023'; end if;
 return jsonb_build_object('description',v_text,'payment_type',v_type,'condition',nullif(btrim(regexp_replace(p->>'condition','\s+',' ','g')),''),
  'destination',p->>'destination','account_id',p->>'account_id','business_days',(p->>'business_days')::boolean,'applicable',p->>'applicable',
  'interest_rate',(p->>'interest_rate')::numeric(7,4)::text,'fine_rate',(p->>'fine_rate')::numeric(7,4)::text,'card_brand',p->>'card_brand','card_integration',p->>'card_integration',
  'card_cnpj',upper(regexp_replace(p->>'card_cnpj','[ ./-]','','g')),'auto_settle',(p->>'auto_settle')::boolean,'pix_integration',p->>'pix_integration',
  'pix_cnpj',upper(regexp_replace(p->>'pix_cnpj','[ ./-]','','g')),'fee_type',p->>'fee_type','fee_rate',(p->>'fee_rate')::numeric(7,4)::text,
  'fee_fixed',(p->>'fee_fixed')::numeric(18,2)::text,'settlement_days',(p->>'settlement_days')::integer);
end $$;

create function public.erp_catalog_payment_method_page(p_user_id uuid,p_page integer default 1,p_size integer default 100,p_query text default null,
 p_applicable text default null,p_account_id uuid default null,p_active boolean default true)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text:=erp_catalog.payment_method_access(p_user_id,false); v_terms text[]; v_total bigint; v_ids uuid[];
begin
 if p_page is null or p_page not between 1 and 100000 or p_size is null or p_size not between 1 and 100 or(p_query is not null and(length(p_query)>120 or p_query~'[[:cntrl:]]'))
  or(p_applicable is not null and p_applicable not in('pagamentos','recebimentos','ambos')) then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_terms:=erp_catalog.search_terms(p_query);
 with f as materialized(select m.id,m.created_at from erp_catalog.payment_method m where m.deleted_at is null and(p_active is null or m.active=p_active)
   and(p_account_id is null or m.account_id=p_account_id)
   and(p_applicable is null or case p_applicable when 'pagamentos' then m.applicable in('pagamentos','ambos') when 'recebimentos' then m.applicable in('recebimentos','ambos') else m.applicable='ambos' end)
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(m.description),'','')))
 select (select count(*) from f),array(select id from f order by created_at desc,id desc offset (p_page-1)*p_size limit p_size) into v_total,v_ids;
 return jsonb_build_object('entity','payment_methods','page',p_page,'size',p_size,'total',v_total,'can_write',v_role in('admin','financeiro'),'data_mode','erp_native',
  'accounts',erp_catalog.payment_method_accounts(),
  'items',(select coalesce(jsonb_agg(erp_catalog.payment_method_dto(u.id) order by u.n),'[]'::jsonb) from unnest(v_ids) with ordinality u(id,n)));
end $$;
create function public.erp_catalog_payment_method_get(p_user_id uuid,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text:=erp_catalog.payment_method_access(p_user_id,false);
begin
 if p_id is null or not exists(select 1 from erp_catalog.payment_method where id=p_id and deleted_at is null) then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('entity','payment_methods','data_mode','erp_native','can_write',v_role in('admin','financeiro'),'item',erp_catalog.payment_method_dto(p_id),'accounts',erp_catalog.payment_method_accounts());
end $$;
create function public.erp_catalog_payment_method_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.payment_method%rowtype; v jsonb; v_id uuid; v_before jsonb; v_result jsonb;
begin
 perform erp_catalog.payment_method_access(p_user_id,true);
 if p_command_id is null or p_expected_version is null or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647) then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-payment-method-save-v1','actor',p_user_id,'id',p_id,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 v:=erp_catalog.payment_method_input(p_data);
 if p_id is not null then
  select * into v_row from erp_catalog.payment_method where id=p_id and deleted_at is null for update;
  if v_row.id is null then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
 end if;
 if v->>'account_id' is not null and(v->>'account_id')::uuid is distinct from v_row.account_id
  and not exists(select 1 from erp_finance.account where id=(v->>'account_id')::uuid and active) then raise exception 'erp_catalog_payment_method_invalid:account_id' using errcode='22023'; end if;
 if p_id is null then
  insert into erp_catalog.payment_method(description,payment_type,condition,destination,account_id,business_days,applicable,interest_rate,fine_rate,card_brand,card_integration,
   card_cnpj,auto_settle,pix_integration,pix_cnpj,fee_type,fee_rate,fee_fixed,settlement_days,created_by,updated_by)
  values(v->>'description',v->>'payment_type',v->>'condition',v->>'destination',(v->>'account_id')::uuid,(v->>'business_days')::boolean,v->>'applicable',(v->>'interest_rate')::numeric,
   (v->>'fine_rate')::numeric,v->>'card_brand',v->>'card_integration',v->>'card_cnpj',(v->>'auto_settle')::boolean,v->>'pix_integration',v->>'pix_cnpj',v->>'fee_type',
   (v->>'fee_rate')::numeric,(v->>'fee_fixed')::numeric,(v->>'settlement_days')::integer,p_user_id,p_user_id) returning id into v_id;
  insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,after_data) values(p_user_id,p_command_id,'payment_method',v_id,'create',erp_catalog.payment_method_dto(v_id));
 else
  v_id:=p_id; v_before:=erp_catalog.payment_method_dto(p_id);
  if (v_before-'id'-'version'-'account_name'-'active'-'is_default'-'created_at'-'updated_at') is distinct from v then
   update erp_catalog.payment_method set description=v->>'description',payment_type=v->>'payment_type',condition=v->>'condition',destination=v->>'destination',
    account_id=(v->>'account_id')::uuid,business_days=(v->>'business_days')::boolean,applicable=v->>'applicable',interest_rate=(v->>'interest_rate')::numeric,
    fine_rate=(v->>'fine_rate')::numeric,card_brand=v->>'card_brand',card_integration=v->>'card_integration',card_cnpj=v->>'card_cnpj',auto_settle=(v->>'auto_settle')::boolean,
    pix_integration=v->>'pix_integration',pix_cnpj=v->>'pix_cnpj',fee_type=v->>'fee_type',fee_rate=(v->>'fee_rate')::numeric,fee_fixed=(v->>'fee_fixed')::numeric,
    settlement_days=(v->>'settlement_days')::integer,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
   insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,before_data,after_data) values(p_user_id,p_command_id,'payment_method',v_id,'update',v_before,erp_catalog.payment_method_dto(v_id));
  end if;
 end if;
 v_result:=jsonb_build_object('entity','payment_methods','data_mode','erp_native','replayed',false,'item',erp_catalog.payment_method_dto(v_id));
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;
-- Menu ⋮ e lixeira: Forma padrão (troca atômica, só uma), Ativar, Inativar e Excluir (a forma some das listagens; o
-- registro fica para a auditoria, porque nenhum documento referencia formas de pagamento ainda).
create function public.erp_catalog_payment_method_action(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_action text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.payment_method%rowtype; v_before jsonb; v_result jsonb; v_previous uuid;
begin
 perform erp_catalog.payment_method_access(p_user_id,true);
 if p_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483647 or p_action is null
  or p_action not in('default','activate','inactivate','delete') then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-payment-method-action-v1','actor',p_user_id,'id',p_id,'version',p_expected_version,'action',p_action)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 perform pg_advisory_xact_lock(174852908,3);
 select * into v_row from erp_catalog.payment_method where id=p_id and deleted_at is null for update;
 if v_row.id is null then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
 v_before:=erp_catalog.payment_method_dto(p_id);
 if p_action='default' then
  if not v_row.active then raise exception 'erp_catalog_payment_method_inactive' using errcode='22023'; end if;
  if not v_row.is_default then
   select id into v_previous from erp_catalog.payment_method where is_default for update;
   update erp_catalog.payment_method set is_default=false,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where is_default;
   update erp_catalog.payment_method set is_default=true,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
  end if;
 elsif p_action='activate' then
  if not v_row.active then update erp_catalog.payment_method set active=true,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id; end if;
 elsif p_action='inactivate' then
  if v_row.active then update erp_catalog.payment_method set active=false,is_default=false,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id; end if;
 else
  update erp_catalog.payment_method set is_default=false,deleted_by=p_user_id,deleted_at=clock_timestamp(),version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 end if;
 v_result:=jsonb_build_object('entity','payment_methods','data_mode','erp_native','replayed',false,'id',p_id,'action',p_action,'item',erp_catalog.payment_method_dto(p_id),'previous_default',v_previous);
 insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,before_data,after_data)
  values(p_user_id,p_command_id,'payment_method',p_id,case p_action when 'delete' then 'archive' when 'default' then 'default' else p_action end,v_before,v_result->'item');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_payment_method_page(uuid,integer,integer,text,text,uuid,boolean)','erp_catalog_payment_method_get(uuid,uuid)',
  'erp_catalog_payment_method_save(uuid,uuid,integer,uuid,jsonb)','erp_catalog_payment_method_action(uuid,uuid,integer,uuid,text)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
