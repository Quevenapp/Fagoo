-- Naturezas de operação com regras por imposto, padrões de sugestão e configurações globais de impostos.
-- Somente cadastro: não emite, não gera XML, não transmite, não lança estoque nem financeiro.
-- Leitura: admin, consulta e fiscal. Escrita: admin e fiscal. Descritores de campo iguais a
-- packages/erp-domain/src/fiscal-invoice-dto.mjs (comparados em teste).
begin;
create schema erp_fiscal_invoices;
revoke all on schema erp_fiscal_invoices from public,anon,authenticated,service_role;

create table erp_fiscal_invoices.nature(
 id uuid primary key default gen_random_uuid(),
 description text not null check(length(description) between 1 and 60 and description=btrim(description)),
 series integer check(series between 0 and 999),
 direction text not null check(direction in('0','1')),
 crt text not null check(crt in('1','2','3','4')),
 presence text not null check(presence in('0','1','2','3','4','5','9')),
 invoiced boolean not null,final_consumer boolean not null,return_operation boolean not null,
 update_last_purchase_price boolean not null,include_freight_ipi_base boolean not null,
 others jsonb not null check(jsonb_typeof(others)='object'),retentions jsonb not null check(jsonb_typeof(retentions)='object'),
 additional_info text check(length(additional_info)<=5000),fiscal_info text check(length(fiscal_info)<=2000),
 active boolean not null default true,version integer not null default 1 check(version>0),
 created_by uuid not null references auth.users(id),updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 check(direction='0' or not update_last_purchase_price)
);
create index erp_fiscal_nature_active on erp_fiscal_invoices.nature(active,direction,lower(description),id);
create table erp_fiscal_invoices.nature_rule(
 nature_id uuid not null references erp_fiscal_invoices.nature(id),
 tax text not null check(tax in('icms','ipi','pis','cofins','ii')),position integer not null check(position between 1 and 50),
 destinations text[] not null,product_scope text not null check(product_scope in('any','ncm','products')),
 ncms text[] not null default '{}',product_ids uuid[] not null default '{}',
 data jsonb not null check(jsonb_typeof(data)='object' and data?'situation'),
 additional_info text check(length(additional_info)<=2000),fiscal_info text check(length(fiscal_info)<=2000),
 primary key(nature_id,tax,position),
 check(cardinality(destinations)<=28),
 check((product_scope='any' and cardinality(ncms)=0 and cardinality(product_ids)=0)
  or(product_scope='ncm' and cardinality(ncms) between 1 and 10 and cardinality(product_ids)=0)
  or(product_scope='products' and cardinality(product_ids) between 1 and 10 and cardinality(ncms)=0))
);
-- One nature per Origin "Padrão ..." code; the invoice form suggests it.
create table erp_fiscal_invoices.nature_default(
 code text primary key check(code in('S','E','VF','VJ','CF','CJ','C','DE','DS')),
 nature_id uuid not null references erp_fiscal_invoices.nature(id),updated_at timestamptz not null default clock_timestamp()
);
create table erp_fiscal_invoices.tax_settings(
 singleton boolean primary key default true check(singleton),settings jsonb not null check(jsonb_typeof(settings)='object'),
 difal_by_state jsonb not null check(jsonb_typeof(difal_by_state)='object'),version integer not null check(version>0),
 updated_by uuid not null references auth.users(id),updated_at timestamptz not null default clock_timestamp()
);
create table erp_fiscal_invoices.nature_revision(
 nature_id uuid not null references erp_fiscal_invoices.nature(id),version integer not null check(version>0),
 record jsonb not null check(jsonb_typeof(record)='object'),primary key(nature_id,version)
);
create table erp_fiscal_invoices.command(
 command_id uuid primary key,actor uuid not null references auth.users(id),scope text not null check(scope in('nature','tax_settings','invoice','event')),
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table erp_fiscal_invoices.audit(
 id bigint generated always as identity primary key,actor uuid not null references auth.users(id),
 command_id uuid not null references erp_fiscal_invoices.command(command_id) deferrable initially deferred,
 scope text not null,entity_id uuid,version integer,action text not null,reason text,created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin foreach t in array array['nature','nature_rule','nature_default','tax_settings','nature_revision','command','audit'] loop
 execute format('alter table erp_fiscal_invoices.%I enable row level security',t); end loop; end $$;
revoke all on all tables in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_invoices revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_invoices revoke all on functions from public,anon,authenticated,service_role;

create function erp_fiscal_invoices.immutable_history() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_fiscal_invoice_history_immutable' using errcode='42501'; end $$;
create trigger immutable_nature_revision before update or delete on erp_fiscal_invoices.nature_revision for each row execute function erp_fiscal_invoices.immutable_history();
create trigger immutable_command before update or delete on erp_fiscal_invoices.command for each row execute function erp_fiscal_invoices.immutable_history();
create trigger immutable_audit before update or delete on erp_fiscal_invoices.audit for each row execute function erp_fiscal_invoices.immutable_history();
create function erp_fiscal_invoices.guard_nature() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'erp_fiscal_nature_no_delete' using errcode='42501'; end if;
 if new.id<>old.id or new.direction<>old.direction or new.created_at<>old.created_at or new.created_by<>old.created_by
  or old.version=2147483647 or new.version<>old.version+1 then raise exception 'erp_fiscal_nature_immutable_identity' using errcode='40001'; end if;
 return new;
end $$;
create trigger guard_nature before update or delete on erp_fiscal_invoices.nature for each row execute function erp_fiscal_invoices.guard_nature();

-- ---- Access ----
create function erp_fiscal_invoices.role_of(p_user_id uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare r text;
begin
 select role into r from erp_access.membership where user_id=p_user_id and active;
 if r is null then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 return r;
end $$;
create function erp_fiscal_invoices.require_read(p_user_id uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare r text:=erp_fiscal_invoices.role_of(p_user_id);
begin
 if r not in('admin','consulta','fiscal') then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 return r;
end $$;
create function erp_fiscal_invoices.require_write(p_user_id uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare r text:=erp_fiscal_invoices.role_of(p_user_id);
begin
 if r not in('admin','fiscal') then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 return r;
end $$;

-- ---- Field descriptors (see the JavaScript module for the syntax) ----
create function erp_fiscal_invoices.check_value(p_value jsonb,p_desc text) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare k text:=split_part(p_desc,':',1);a text:=substr(p_desc,length(split_part(p_desc,':',1))+2);v text;s integer;i integer;d date;
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 if k='b' then
  if jsonb_typeof(p_value)<>'boolean' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  return p_value;
 end if;
 if jsonb_typeof(p_value)<>'string' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
 v:=p_value#>>'{}';
 if k in('t','m') then
  v:=btrim(v,E' \t\n\r');
  if v='' then return null; end if;
  if length(v)>a::integer or (case when k='m' then translate(v,E'\n\r\t','') else v end) ~ '[[:cntrl:]]' then
   raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  return to_jsonb(v);
 elsif k='e' then
  if not v=any(string_to_array(a,'|')) then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  return p_value;
 elsif k='x' then
  if v !~ a then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  return p_value;
 elsif k='u' then
  if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  return to_jsonb(lower(v));
 elsif k='a' then
  if v !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  begin d:=v::date; exception when others then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end;
  if to_char(d,'YYYY-MM-DD')<>v then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  return p_value;
 elsif k='d' then
  s:=split_part(a,':',1)::integer;i:=split_part(a,':',2)::integer;
  if v !~ ('^(0|[1-9][0-9]{0,'||(i-1)||'})(\.[0-9]{1,'||s||'})?$') then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  return to_jsonb(split_part(v,'.',1)||'.'||rpad(split_part(v,'.',2),s,'0'));
 end if;
 raise exception 'erp_fiscal_spec_invalid' using errcode='22023';
end $$;
create function erp_fiscal_invoices.spec_object(p_value jsonb,p_spec jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare e record;n jsonb;result jsonb:='{}';
begin
 if p_value is null or p_value='null'::jsonb then return '{}'::jsonb; end if;
 if jsonb_typeof(p_value)<>'object' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
 for e in select key,value from jsonb_each(p_value) loop
  if not p_spec?e.key then raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
  n:=erp_fiscal_invoices.check_value(e.value,p_spec->>e.key);
  if n is not null then result:=result||jsonb_build_object(e.key,n); end if;
 end loop;
 return result;
end $$;
create function erp_fiscal_invoices.text_input(p_value jsonb,p_max integer,p_required boolean default false,p_multiline boolean default false) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare v text:=erp_fiscal_invoices.check_value(p_value,case when p_multiline then 'm:' else 't:' end||p_max)#>>'{}';
begin
 if p_required and v is null then raise exception 'erp_fiscal_value_required' using errcode='22023'; end if;
 return v;
end $$;
create function erp_fiscal_invoices.bool_input(p_value jsonb,p_default boolean) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_value is null or p_value='null'::jsonb then return p_default; end if;
 if jsonb_typeof(p_value)<>'boolean' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
 return p_value::text::boolean;
end $$;
create function erp_fiscal_invoices.version_input(p_value jsonb) returns integer language plpgsql immutable set search_path=pg_catalog as $$
begin
 if jsonb_typeof(p_value) is distinct from 'number' or p_value::text!~'^[1-9][0-9]{0,9}$' or p_value::text::numeric>2147483647 then
  raise exception 'erp_fiscal_version_invalid' using errcode='22023'; end if;
 return p_value::text::integer;
end $$;
create function erp_fiscal_invoices.uuid_input(p_value jsonb,p_required boolean default true) returns uuid language plpgsql immutable set search_path=pg_catalog as $$
declare v jsonb:=erp_fiscal_invoices.check_value(p_value,'u');
begin
 if v is null and p_required then raise exception 'erp_fiscal_value_required' using errcode='22023'; end if;
 return (v#>>'{}')::uuid;
end $$;
create function erp_fiscal_invoices.nature_specs() returns jsonb language sql immutable set search_path=pg_catalog as $spec$
 select '{"rules":{"icms_sn":{"situation":"e:101|102|103|201|202|203|300|400|500|900|02|15|53|61","cfop":"x:^[1-7][0-9]{3}$","bc_mode":"e:0|1|2|3","rate":"d:4:3","base_rate":"d:4:3","deferral_rate":"d:4:3","reduction_reason":"e:1|9","taxation":"e:T|I|O","credit_rate":"d:4:3","fcp_rate":"d:4:3","benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","presumed_credit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","rbc_benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","pauta_value":"d:4:11","st_bc_mode":"e:0|1|2|3|4|5|6","st_pauta_value":"d:4:11","st_rate":"d:4:3","st_base_rate":"d:4:3","st_mva":"d:4:3","retained_base_rate":"d:4:3","retained_rate":"d:4:3","difal_type":"e:N|I","difal_base_rate":"d:4:3","difal_internal_rate":"d:4:3","difal_fcp_rate":"d:4:3"},"icms_normal":{"situation":"e:00|02|10|15|20|30|40|41|50|51|53|60|61|70|90","cfop":"x:^[1-7][0-9]{3}$","rate":"d:4:3","base_rate":"d:4:3","deferral_rate":"d:4:3","presumed_rate":"d:4:3","taxation":"e:T|I|O","fcp_rate":"d:4:3","bc_mode":"e:0|1|2|3","pauta_value":"d:4:11","benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","presumed_credit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","rbc_benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","deson_reason":"e:1|3|4|5|6|7|8|9|10|11|90","deson_deduct":"b","st_bc_mode":"e:0|1|2|3|4|5|6","st_pauta_value":"d:4:11","st_rate":"d:4:3","st_base_rate":"d:4:3","st_mva":"d:4:3","st_pis_rate":"d:4:3","st_cofins_rate":"d:4:3","retained_rate":"d:4:3","difal_type":"e:N|I","difal_base_rate":"d:4:3","difal_internal_rate":"d:4:3","difal_fcp_rate":"d:4:3"},"ipi":{"situation":"e:00|01|02|03|04|05|49|50|51|52|53|54|55|99","rate":"d:4:3","base_rate":"d:4:3","framing_code":"x:^[0-9]{3}$","taxation":"e:T|I|O"},"pis":{"situation":"e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99","rate":"d:4:3","base_rate":"d:4:3","taxation":"e:T|I|O"},"cofins":{"situation":"e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99","rate":"d:4:3","base_rate":"d:4:3","taxation":"e:T|I|O"},"ii":{"situation":"e:T|N","rate":"d:4:3","base_rate":"d:4:3","taxation":"e:T|I|O"}},"others":{"presumed_pis_cofins":"b","add_icms":"b","add_other_expenses":"b","funrural_rate":"d:4:3","rural_producer_purchase":"b","deduct_funrural":"b","approx_tax_type":"e:table|fixed|product","approx_tax_rate":"d:4:3","discount_type":"e:C|I","simples_credit_rate":"d:4:3"},"retentions":{"csrf":"b","csrf_rate":"d:4:3","ir":"b","ir_rate":"d:4:3"},"tax_settings":{"exclude_icms_pis_cofins":"b","exclude_icms_st_pis_cofins":"b","st_contributor_differentiated":"b","st_retained_from_sale":"b","difal_default":"e:inside|goods|none|validated","ipi_in_icms_import":"b"}}'::jsonb
$spec$;
create function erp_fiscal_invoices.ufs() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']
$$;
-- IPI situations depend on the direction (NFE-146): entry 00-05/49, exit 50-55/99.
create function erp_fiscal_invoices.ipi_situation_allowed(p_direction text,p_situation text) returns boolean language sql immutable set search_path=pg_catalog as $$
 select p_situation is null or case p_direction when '0' then p_situation in('00','01','02','03','04','05','49') else p_situation in('50','51','52','53','54','55','99') end
$$;

-- ---- Natures ----
create function erp_fiscal_invoices.nature_rule_input(p_rule jsonb,p_crt text,p_direction text) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare tax text;spec jsonb;data jsonb;dest text[];scope text;ncms text[];products uuid[];v text;
begin
 if p_rule is null or jsonb_typeof(p_rule)<>'object' or exists(select 1 from jsonb_object_keys(p_rule) k
  where k not in('tax','destinations','product_scope','ncms','product_ids','data','additional_info','fiscal_info')) then
  raise exception 'erp_fiscal_rule_invalid' using errcode='22023'; end if;
 tax:=p_rule->>'tax';
 if jsonb_typeof(p_rule->'tax') is distinct from 'string' or tax not in('icms','ipi','pis','cofins','ii') then raise exception 'erp_fiscal_rule_invalid' using errcode='22023'; end if;
 spec:=erp_fiscal_invoices.nature_specs()->'rules'->(case when tax='icms' then case when p_crt='3' then 'icms_normal' else 'icms_sn' end else tax end);
 data:=erp_fiscal_invoices.spec_object(p_rule->'data',spec);
 if not data?'situation' then raise exception 'erp_fiscal_rule_situation_required' using errcode='22023'; end if;
 if tax='ipi' and not erp_fiscal_invoices.ipi_situation_allowed(p_direction,data->>'situation') then raise exception 'erp_fiscal_rule_situation_invalid' using errcode='22023'; end if;
 if jsonb_typeof(coalesce(p_rule->'destinations','[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_rule->'destinations','[]'::jsonb))>28 then raise exception 'erp_fiscal_rule_invalid' using errcode='22023'; end if;
 select coalesce(array_agg(x order by x),'{}') into dest from jsonb_array_elements_text(coalesce(p_rule->'destinations','[]'::jsonb)) x;
 if exists(select 1 from jsonb_array_elements(coalesce(p_rule->'destinations','[]'::jsonb)) x where jsonb_typeof(x)<>'string')
  or exists(select 1 from unnest(dest) d where not d=any(erp_fiscal_invoices.ufs()||array['EX']))
  or cardinality(dest)<>(select count(distinct d) from unnest(dest) d) then raise exception 'erp_fiscal_rule_destination_invalid' using errcode='22023'; end if;
 scope:=coalesce(p_rule->>'product_scope','any');
 if scope not in('any','ncm','products') then raise exception 'erp_fiscal_rule_invalid' using errcode='22023'; end if;
 if jsonb_typeof(coalesce(p_rule->'ncms','[]'::jsonb))<>'array' or jsonb_typeof(coalesce(p_rule->'product_ids','[]'::jsonb))<>'array'
  or jsonb_array_length(coalesce(p_rule->'ncms','[]'::jsonb))>10 or jsonb_array_length(coalesce(p_rule->'product_ids','[]'::jsonb))>10 then
  raise exception 'erp_fiscal_rule_product_invalid' using errcode='22023'; end if;
 select coalesce(array_agg(x order by x),'{}') into ncms from jsonb_array_elements_text(coalesce(p_rule->'ncms','[]'::jsonb)) x;
 if exists(select 1 from unnest(ncms) n where n !~ '^[0-9]{2}([0-9]{2}){0,3}$') or cardinality(ncms)<>(select count(distinct n) from unnest(ncms) n) then
  raise exception 'erp_fiscal_rule_product_invalid' using errcode='22023'; end if;
 select coalesce(array_agg(erp_fiscal_invoices.uuid_input(x) order by x::text),'{}') into products from jsonb_array_elements(coalesce(p_rule->'product_ids','[]'::jsonb)) x;
 if cardinality(products)<>(select count(distinct p) from unnest(products) p)
  or exists(select 1 from unnest(products) p where not exists(select 1 from erp_catalog.record r where r.id=p and r.entity='products')) then
  raise exception 'erp_fiscal_rule_product_invalid' using errcode='22023'; end if;
 if (scope='any' and (cardinality(ncms)>0 or cardinality(products)>0)) or (scope='ncm' and (cardinality(ncms)=0 or cardinality(products)>0))
  or (scope='products' and (cardinality(products)=0 or cardinality(ncms)>0)) then raise exception 'erp_fiscal_rule_product_invalid' using errcode='22023'; end if;
 return jsonb_build_object('tax',tax,'destinations',to_jsonb(dest),'product_scope',scope,'ncms',to_jsonb(ncms),'product_ids',to_jsonb(products),'data',data,
  'additional_info',erp_fiscal_invoices.text_input(p_rule->'additional_info',2000,false,true),'fiscal_info',erp_fiscal_invoices.text_input(p_rule->'fiscal_info',2000,false,true));
end $$;
create function erp_fiscal_invoices.nature_input(p_data jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare direction text;crt text;presence text;series integer;rules jsonb:='[]';r jsonb;n jsonb;
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or exists(select 1 from jsonb_object_keys(p_data) k where k not in('description','series','direction','crt','presence',
  'invoiced','final_consumer','return_operation','update_last_purchase_price','include_freight_ipi_base','others','retentions','additional_info','fiscal_info','rules')) then
  raise exception 'erp_fiscal_nature_invalid' using errcode='22023'; end if;
 direction:=p_data->>'direction';crt:=p_data->>'crt';presence:=coalesce(p_data->>'presence','9');
 if jsonb_typeof(p_data->'direction') is distinct from 'string' or direction not in('0','1') or jsonb_typeof(p_data->'crt') is distinct from 'string' or crt not in('1','2','3','4')
  or presence not in('0','1','2','3','4','5','9') or (p_data?'presence' and jsonb_typeof(p_data->'presence')<>'string') then raise exception 'erp_fiscal_nature_invalid' using errcode='22023'; end if;
 if p_data->'series' is not null and p_data->'series'<>'null'::jsonb then
  if jsonb_typeof(p_data->'series')<>'string' or p_data->>'series' !~ '^(0|[1-9][0-9]{0,2})$' then raise exception 'erp_fiscal_nature_invalid' using errcode='22023'; end if;
  series:=(p_data->>'series')::integer;
 end if;
 if jsonb_typeof(coalesce(p_data->'rules','[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_data->'rules','[]'::jsonb))>250 then raise exception 'erp_fiscal_nature_invalid' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(coalesce(p_data->'rules','[]'::jsonb)) loop
  n:=erp_fiscal_invoices.nature_rule_input(r,crt,direction);
  if (select count(*) from jsonb_array_elements(rules) x where x->>'tax'=n->>'tax')>=50 then raise exception 'erp_fiscal_nature_invalid' using errcode='22023'; end if;
  rules:=rules||jsonb_build_array(n);
 end loop;
 if direction='1' and erp_fiscal_invoices.bool_input(p_data->'update_last_purchase_price',false) then raise exception 'erp_fiscal_nature_invalid' using errcode='22023'; end if;
 return jsonb_build_object('description',erp_fiscal_invoices.text_input(p_data->'description',60,true),'series',series,'direction',direction,'crt',crt,'presence',presence,
  'invoiced',erp_fiscal_invoices.bool_input(p_data->'invoiced',true),'final_consumer',erp_fiscal_invoices.bool_input(p_data->'final_consumer',false),
  'return_operation',erp_fiscal_invoices.bool_input(p_data->'return_operation',false),'update_last_purchase_price',erp_fiscal_invoices.bool_input(p_data->'update_last_purchase_price',false),
  'include_freight_ipi_base',erp_fiscal_invoices.bool_input(p_data->'include_freight_ipi_base',false),
  'others',erp_fiscal_invoices.spec_object(p_data->'others',erp_fiscal_invoices.nature_specs()->'others'),
  'retentions',erp_fiscal_invoices.spec_object(p_data->'retentions',erp_fiscal_invoices.nature_specs()->'retentions'),
  'additional_info',erp_fiscal_invoices.text_input(p_data->'additional_info',5000,false,true),'fiscal_info',erp_fiscal_invoices.text_input(p_data->'fiscal_info',2000,false,true),'rules',rules);
end $$;
create function erp_fiscal_invoices.nature_record(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',n.id,'description',n.description,'series',n.series,'direction',n.direction,'crt',n.crt,'presence',n.presence,'invoiced',n.invoiced,
  'final_consumer',n.final_consumer,'return_operation',n.return_operation,'update_last_purchase_price',n.update_last_purchase_price,'include_freight_ipi_base',n.include_freight_ipi_base,
  'others',n.others,'retentions',n.retentions,'additional_info',n.additional_info,'fiscal_info',n.fiscal_info,'active',n.active,'version',n.version,
  'created_at',n.created_at,'updated_at',n.updated_at,
  'rules',coalesce((select jsonb_agg(jsonb_build_object('tax',r.tax,'position',r.position,'destinations',to_jsonb(r.destinations),'product_scope',r.product_scope,
    'ncms',to_jsonb(r.ncms),'product_ids',to_jsonb(r.product_ids),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'code',c.code) order by c.name,c.id) from erp_catalog.record c where c.id=any(r.product_ids)),'[]'::jsonb),
    'data',r.data,'additional_info',r.additional_info,'fiscal_info',r.fiscal_info) order by array_position(array['icms','ipi','pis','cofins','ii'],r.tax),r.position)
   from erp_fiscal_invoices.nature_rule r where r.nature_id=n.id),'[]'::jsonb),
  'defaults',coalesce((select jsonb_agg(d.code order by d.code) from erp_fiscal_invoices.nature_default d where d.nature_id=n.id),'[]'::jsonb))
 from erp_fiscal_invoices.nature n where n.id=p_id
$$;
create function erp_fiscal_invoices.replace_rules(p_id uuid,p_rules jsonb) returns void language plpgsql set search_path=pg_catalog as $$
declare r jsonb;pos integer;
begin
 delete from erp_fiscal_invoices.nature_rule where nature_id=p_id;
 for r in select value from jsonb_array_elements(p_rules) loop
  select coalesce(max(position),0)+1 into pos from erp_fiscal_invoices.nature_rule where nature_id=p_id and tax=r->>'tax';
  insert into erp_fiscal_invoices.nature_rule(nature_id,tax,position,destinations,product_scope,ncms,product_ids,data,additional_info,fiscal_info)
  values(p_id,r->>'tax',pos,array(select jsonb_array_elements_text(r->'destinations')),r->>'product_scope',array(select jsonb_array_elements_text(r->'ncms')),
   array(select jsonb_array_elements_text(r->'product_ids')::uuid),r->'data',r->>'additional_info',r->>'fiscal_info');
 end loop;
end $$;
create function erp_fiscal_invoices.command_hash(p_actor uuid,p_scope text,p_action text,p_data jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'scope',p_scope,'action',p_action,'data',p_data)::text,'UTF8')),'hex')
$$;
-- Returns the stored result when the same actor repeats the same command; a different request with the same id conflicts.
create function erp_fiscal_invoices.command_replay(p_command_id uuid,p_actor uuid,p_scope text,p_hash text) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare c erp_fiscal_invoices.command%rowtype;
begin
 perform pg_advisory_xact_lock(174852941,hashtext(p_command_id::text));
 select * into c from erp_fiscal_invoices.command where command_id=p_command_id;
 if not found then return null; end if;
 if c.actor<>p_actor or c.scope<>p_scope or c.request_hash<>p_hash then raise exception 'erp_fiscal_command_conflict' using errcode='40001'; end if;
 return c.result||jsonb_build_object('replayed',true);
end $$;

create function public.erp_fiscal_nature_list(p_user_id uuid,p_active boolean default true,p_query text default null,p_direction text default null,
 p_crt text default null,p_page integer default 1,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text;q text:=nullif(btrim(p_query),'');result jsonb;
begin
 role:=erp_fiscal_invoices.require_read(p_user_id);
 if p_active is null or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query ~ '[[:cntrl:]]'
  or (p_direction is not null and p_direction not in('0','1')) or (p_crt is not null and p_crt not in('1','2','3','4')) then
  raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 with rows as materialized(
  select n.id,n.description from erp_fiscal_invoices.nature n
  where n.active=p_active and(p_direction is null or n.direction=p_direction) and(p_crt is null or n.crt=p_crt)
   and(q is null or strpos(lower(n.description),lower(q))>0)
 ),page as(select id,description from rows order by lower(description),id offset (p_page-1)*p_limit limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'description',n.description,'series',n.series,'direction',n.direction,
   'crt',n.crt,'presence',n.presence,'invoiced',n.invoiced,'final_consumer',n.final_consumer,'return_operation',n.return_operation,'active',n.active,'version',n.version,
   'defaults',coalesce((select jsonb_agg(d.code order by d.code) from erp_fiscal_invoices.nature_default d where d.nature_id=n.id),'[]'::jsonb),
   'rule_count',(select count(*)::integer from erp_fiscal_invoices.nature_rule r where r.nature_id=n.id)) order by lower(p.description),p.id)
   from page p join erp_fiscal_invoices.nature n on n.id=p.id),'[]'::jsonb),
  'page',p_page,'limit',p_limit,'total_count',(select count(*)::integer from rows),'writable',role in('admin','fiscal'),'data_mode','erp_native') into result;
 return result;
end $$;
create function public.erp_fiscal_nature_get(p_user_id uuid,p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text;r jsonb;
begin
 role:=erp_fiscal_invoices.require_read(p_user_id);
 if p_id is null then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 r:=erp_fiscal_invoices.nature_record(p_id);
 if r is null then raise exception 'erp_fiscal_nature_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('nature',r,'writable',role in('admin','fiscal'),'data_mode','erp_native');
end $$;
create function public.erp_fiscal_nature_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;keys text[];v_id uuid;expected integer;n erp_fiscal_invoices.nature%rowtype;input jsonb;rec jsonb;result jsonb;v_code text;bumped boolean:=true;
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_action is null or p_action not in('create','update','clone','set_active','set_default') or p_data is null
  or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>262144 then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 keys:=case p_action when 'create' then array['nature'] when 'update' then array['id','expected_version','nature'] when 'clone' then array['id','expected_version']
  when 'set_active' then array['id','expected_version','active'] else array['id','expected_version','code'] end;
 if exists(select 1 from jsonb_object_keys(p_data) k where not k=any(keys)) or exists(select 1 from unnest(keys) k where not p_data?k) then
  raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 if p_action='create' or p_action='update' then input:=erp_fiscal_invoices.nature_input(p_data->'nature'); end if;
 if p_action<>'create' then v_id:=erp_fiscal_invoices.uuid_input(p_data->'id');expected:=erp_fiscal_invoices.version_input(p_data->'expected_version'); end if;
 if p_action='set_active' and jsonb_typeof(p_data->'active') is distinct from 'boolean' then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 if p_action='set_default' then
  v_code:=p_data->>'code';
  if jsonb_typeof(p_data->'code') is distinct from 'string' or v_code not in('S','E','VF','VJ','CF','CJ','C','DE','DS') then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 end if;
 h:=erp_fiscal_invoices.command_hash(p_user_id,'nature',p_action,p_data);
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'nature',h);
 if replay is not null then return replay; end if;
 if p_action<>'create' then
  select * into n from erp_fiscal_invoices.nature where id=v_id for update;
  if not found then raise exception 'erp_fiscal_nature_not_found' using errcode='P0002'; end if;
  if n.version<>expected or n.version=2147483647 then raise exception 'erp_fiscal_nature_version_conflict' using errcode='40001'; end if;
 end if;
 if p_action='update' and input->>'direction'<>n.direction then raise exception 'erp_fiscal_nature_direction_immutable' using errcode='22023'; end if;
 if p_action='create' then
  insert into erp_fiscal_invoices.nature(description,series,direction,crt,presence,invoiced,final_consumer,return_operation,update_last_purchase_price,include_freight_ipi_base,
   others,retentions,additional_info,fiscal_info,created_by,updated_by)
  values(input->>'description',(input->>'series')::integer,input->>'direction',input->>'crt',input->>'presence',(input->>'invoiced')::boolean,(input->>'final_consumer')::boolean,
   (input->>'return_operation')::boolean,(input->>'update_last_purchase_price')::boolean,(input->>'include_freight_ipi_base')::boolean,input->'others',input->'retentions',
   input->>'additional_info',input->>'fiscal_info',p_user_id,p_user_id) returning id into v_id;
  perform erp_fiscal_invoices.replace_rules(v_id,input->'rules');
 elsif p_action='update' then
  update erp_fiscal_invoices.nature set description=input->>'description',series=(input->>'series')::integer,crt=input->>'crt',presence=input->>'presence',
   invoiced=(input->>'invoiced')::boolean,final_consumer=(input->>'final_consumer')::boolean,return_operation=(input->>'return_operation')::boolean,
   update_last_purchase_price=(input->>'update_last_purchase_price')::boolean,include_freight_ipi_base=(input->>'include_freight_ipi_base')::boolean,
   others=input->'others',retentions=input->'retentions',additional_info=input->>'additional_info',fiscal_info=input->>'fiscal_info',
   version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  perform erp_fiscal_invoices.replace_rules(v_id,input->'rules');
 elsif p_action='clone' then
  insert into erp_fiscal_invoices.nature(description,series,direction,crt,presence,invoiced,final_consumer,return_operation,update_last_purchase_price,include_freight_ipi_base,
   others,retentions,additional_info,fiscal_info,created_by,updated_by)
  values(left('Cópia de '||n.description,60),n.series,n.direction,n.crt,n.presence,n.invoiced,n.final_consumer,n.return_operation,n.update_last_purchase_price,
   n.include_freight_ipi_base,n.others,n.retentions,n.additional_info,n.fiscal_info,p_user_id,p_user_id) returning id into v_id;
  insert into erp_fiscal_invoices.nature_rule(nature_id,tax,position,destinations,product_scope,ncms,product_ids,data,additional_info,fiscal_info)
  select v_id,tax,position,destinations,product_scope,ncms,product_ids,data,additional_info,fiscal_info from erp_fiscal_invoices.nature_rule where nature_id=n.id;
 elsif p_action='set_active' then
  if n.active=(p_data->>'active')::boolean then raise exception 'erp_fiscal_nature_state_conflict' using errcode='40001'; end if;
  update erp_fiscal_invoices.nature set active=(p_data->>'active')::boolean,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  if not (p_data->>'active')::boolean then delete from erp_fiscal_invoices.nature_default where nature_id=v_id; end if;
 else
  if not n.active then raise exception 'erp_fiscal_nature_inactive' using errcode='40001'; end if;
  if (case when v_code in('S','VF','VJ','C','DS') then '1' else '0' end)<>n.direction then raise exception 'erp_fiscal_nature_default_direction' using errcode='22023'; end if;
  if exists(select 1 from erp_fiscal_invoices.nature_default where code=p_data->>'code' and nature_id=v_id) then raise exception 'erp_fiscal_nature_state_conflict' using errcode='40001'; end if;
  insert into erp_fiscal_invoices.nature_default(code,nature_id) values(v_code,v_id) on conflict(code) do update set nature_id=excluded.nature_id,updated_at=clock_timestamp();
  bumped:=false;
 end if;
 rec:=erp_fiscal_invoices.nature_record(v_id);
 if bumped then insert into erp_fiscal_invoices.nature_revision(nature_id,version,record) values(v_id,(rec->>'version')::integer,rec); end if;
 result:=jsonb_build_object('nature',rec,'action',p_action,'replayed',false,'data_mode','erp_native');
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'nature',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'nature',v_id,(rec->>'version')::integer,p_action,v_code);
 return result;
end $$;

-- ---- Configurações globais de impostos ----
create function erp_fiscal_invoices.tax_settings_input(p_settings jsonb,p_states jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare s jsonb;e record;states jsonb:='{}';allowed jsonb:='{"inside":null,"goods":null,"none":null,"validated":null,"double_base":["MT","PA","PB"],"single_base":["PB"]}';
begin
 s:=erp_fiscal_invoices.spec_object(p_settings,erp_fiscal_invoices.nature_specs()->'tax_settings');
 s:=jsonb_build_object('exclude_icms_pis_cofins',false,'exclude_icms_st_pis_cofins',false,'st_contributor_differentiated',false,'st_retained_from_sale',false,
  'difal_default','inside','ipi_in_icms_import',false)||s;
 if p_states is null or jsonb_typeof(p_states)<>'object' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
 for e in select key,value from jsonb_each(p_states) loop
  if not e.key=any(erp_fiscal_invoices.ufs()) or jsonb_typeof(e.value)<>'string' or not(e.value#>>'{}'='default' or allowed?(e.value#>>'{}'))
   or (allowed->(e.value#>>'{}')<>'null'::jsonb and not allowed->(e.value#>>'{}')?e.key) then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  if e.value#>>'{}'<>'default' then states:=states||jsonb_build_object(e.key,e.value); end if;
 end loop;
 return jsonb_build_object('settings',s,'difal_by_state',states);
end $$;
create function public.erp_fiscal_tax_settings_get(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text;t erp_fiscal_invoices.tax_settings%rowtype;d jsonb:=erp_fiscal_invoices.tax_settings_input('{}','{}');
begin
 role:=erp_fiscal_invoices.require_read(p_user_id);
 select * into t from erp_fiscal_invoices.tax_settings where singleton;
 return jsonb_build_object('settings',coalesce(t.settings,d->'settings'),'difal_by_state',coalesce(t.difal_by_state,'{}'::jsonb),'version',coalesce(t.version,0),
  'updated_at',t.updated_at,'writable',role in('admin','fiscal'),'data_mode','erp_native');
end $$;
create function public.erp_fiscal_tax_settings_save(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_settings jsonb,p_difal_by_state jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;input jsonb;t erp_fiscal_invoices.tax_settings%rowtype;result jsonb;v_version integer;
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 input:=erp_fiscal_invoices.tax_settings_input(p_settings,p_difal_by_state);
 h:=erp_fiscal_invoices.command_hash(p_user_id,'tax_settings','save',jsonb_build_object('expected_version',p_expected_version,'settings',p_settings,'difal_by_state',p_difal_by_state));
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'tax_settings',h);
 if replay is not null then return replay; end if;
 perform pg_advisory_xact_lock(174852941,1);
 select * into t from erp_fiscal_invoices.tax_settings where singleton for update;
 if coalesce(t.version,0)<>p_expected_version then raise exception 'erp_fiscal_tax_settings_version_conflict' using errcode='40001'; end if;
 insert into erp_fiscal_invoices.tax_settings(singleton,settings,difal_by_state,version,updated_by) values(true,input->'settings',input->'difal_by_state',1,p_user_id)
 on conflict(singleton) do update set settings=excluded.settings,difal_by_state=excluded.difal_by_state,version=tax_settings.version+1,updated_by=excluded.updated_by,updated_at=clock_timestamp()
 returning tax_settings.version into v_version;
 result:=jsonb_build_object('settings',input->'settings','difal_by_state',input->'difal_by_state','version',v_version,'updated_at',clock_timestamp(),'writable',true,
  'replayed',false,'data_mode','erp_native');
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'tax_settings',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action) values(p_user_id,p_command_id,'tax_settings',null,v_version,'save');
 return result;
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_nature_list(uuid,boolean,text,text,text,integer,integer),public.erp_fiscal_nature_get(uuid,uuid),
 public.erp_fiscal_nature_execute(uuid,uuid,text,jsonb),public.erp_fiscal_tax_settings_get(uuid),public.erp_fiscal_tax_settings_save(uuid,uuid,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.erp_fiscal_nature_list(uuid,boolean,text,text,text,integer,integer),public.erp_fiscal_nature_get(uuid,uuid),
 public.erp_fiscal_nature_execute(uuid,uuid,text,jsonb),public.erp_fiscal_tax_settings_get(uuid),public.erp_fiscal_tax_settings_save(uuid,uuid,integer,jsonb,jsonb) to service_role;
commit;
