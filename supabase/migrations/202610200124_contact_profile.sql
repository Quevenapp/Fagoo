-- Clientes e fornecedores no padrão do Origin (lane contatos, onda B): formulário completo, tipos de contato, situação
-- Ativo / Inativo / Sem movimento / Excluído, pessoas de contato, vendedor do contato, código sequencial e as preferências
-- de Cadastros > Configurações de clientes e fornecedores aplicadas na gravação (CPF/CNPJ duplicado, código do contato,
-- campos obrigatórios e contato acessível somente ao vendedor vinculado).
--
-- Só tabelas e funções de contato. erp_catalog.contact mantém as colunas e a coluna roles continua a projeção
-- compatível de Cliente, Fornecedor e Transportador (documentos, financeiro, CNAB e NF-e a leem). As funções genéricas
-- de cadastro (validate_data, write_fields, mutate, erp_catalog_save, erp_catalog_save_checked, erp_catalog_page) não
-- mudam: o Worker passa a gravar e ler contatos pelas RPCs erp_catalog_contact_* desta migração. "active" continua
-- situation in (A,S), então seletores de documentos e do financeiro deixam de oferecer contato Inativo ou Excluído.
-- Depende das migrações publicadas até 202610200118 (finanças 010, naturezas 111, preferências 115, usuários 117/118).
begin;

-- ---- Tipos de contato (Origin: Preferências > Cadastros > Gerenciar tipos de contatos) ----
-- Cliente, Fornecedor e Transportador ficam em erp_catalog.contact.roles (role_backed); os demais em contact_type_link.
create table erp_catalog.contact_type(
 id uuid primary key default gen_random_uuid(),
 slug text not null unique check(slug~'^[a-z][a-z0-9_]{1,39}$'),
 label text not null check(length(label) between 1 and 60 and label=btrim(label) and label!~'[[:cntrl:]]'),
 system boolean not null,
 deletable boolean not null,
 role_backed boolean not null,
 position integer not null check(position between 1 and 100000),
 active boolean not null default true,
 created_by uuid references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 deleted_by uuid references auth.users(id),
 deleted_at timestamptz,
 check(not(system and deletable)),
 check(not role_backed or slug in('customer','supplier','carrier')),
 check(active=(deleted_at is null))
);
create unique index erp_catalog_contact_type_label on erp_catalog.contact_type(erp_catalog.fold(label)) where active;
insert into erp_catalog.contact_type(slug,label,system,deletable,role_backed,position) values
 ('customer','Cliente',true,false,true,1),('developer','Desenvolvedor',true,false,false,2),('supplier','Fornecedor',true,false,true,3),
 ('default','Padrao',true,false,false,4),('technician','Técnico',true,false,false,5),('carrier','Transportador',true,false,true,6),
 ('seller','Vendedor',true,false,false,7),('accountant','Contador',false,true,false,8),('verified_supplier','Fornecedor verificado',false,true,false,9);
create table erp_catalog.contact_type_link(
 contact_id uuid not null references erp_catalog.contact(record_id),
 type_id uuid not null references erp_catalog.contact_type(id),
 primary key(contact_id,type_id)
);
create index erp_catalog_contact_type_link_type on erp_catalog.contact_type_link(type_id,contact_id);

-- ---- Vendedor (Cadastros > Vendedores): o vendedor é um contato com as configurações próprias abaixo ----
-- As RPCs do vendedor ficam na migração 126; a tabela nasce aqui porque o contato referencia o vendedor.
create table erp_catalog.seller(
 id uuid primary key default gen_random_uuid(),
 contact_id uuid not null unique references erp_catalog.contact(record_id),
 user_id uuid unique references auth.users(id),
 allow_unregistered_products boolean not null default false,
 view_stock boolean not null default false,
 access_hours_enabled boolean not null default false,
 access_windows jsonb not null default '[]' check(jsonb_typeof(access_windows)='array'),
 modules jsonb not null default '{}' check(jsonb_typeof(modules)='object'),
 commission_rule text not null default 'parcial' check(commission_rule in('parcial','faturamento','primeira_parcela','ultima_parcela')),
 commission_mode text not null default 'fixa' check(commission_mode in('fixa','descontos')),
 commission_rate numeric(7,4) check(commission_rate between 0 and 100),
 commission_bands jsonb not null default '[]' check(jsonb_typeof(commission_bands)='array'),
 discount_limit numeric(7,4) not null default 0 check(discount_limit between 0 and 100),
 notes text check(length(notes)<=4000),
 version integer not null default 1 check(version between 1 and 2147483647),
 created_by uuid not null references auth.users(id), updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);

-- ---- Campos do formulário do Origin que não existem em erp_catalog.contact ----
create table erp_catalog.contact_profile(
 record_id uuid primary key references erp_catalog.contact(record_id),
 situation text check(situation in('A','I','S','E')),
 crt text check(crt in('1','2','3','4')),
 client_since date,
 taxpayer text check(taxpayer in('1','2','9')),
 ie_exempt boolean not null default false,
 municipal_registration text, rg text, rg_issuer text, country text, foreign_state text,
 contact_info text, fax text,
 carrier_operator text check(carrier_operator in('claro','oi','tim','vivo','nextel','porto_seguro')),
 public_agency text check(public_agency in('municipal','estadual','federal')),
 nfe_email text, website text, skype text, next_visit date,
 avg_tax_load numeric(5,2) check(avg_tax_load between 0 and 100),
 marital_status text check(marital_status in('casado','solteiro','viuvo','separado','desquitado')),
 profession text, gender text check(gender in('feminino','masculino')), birth_date date, birthplace text,
 father_name text, father_cpf text, mother_name text, mother_cpf text,
 suframa text check(suframa~'^[0-9]{8,9}$'),
 credit_limit_mode text not null default 'unlimited' check(credit_limit_mode in('unlimited','zero','value')),
 credit_limit numeric(18,2) check(credit_limit>0),
 payment_condition text,
 finance_category_id uuid references erp_finance.category(id),
 operation_nature_id uuid references erp_fiscal_invoices.nature(id),
 seller_id uuid references erp_catalog.seller(id),
 notes text,
 billing_postal_code text, billing_state text, billing_city text, billing_district text, billing_street text,
 billing_number text, billing_complement text, billing_foreign_state text,
 check((credit_limit_mode='value')=(credit_limit is not null))
);
create index erp_catalog_contact_profile_next_visit on erp_catalog.contact_profile(next_visit,record_id) where next_visit is not null;
create index erp_catalog_contact_profile_seller on erp_catalog.contact_profile(seller_id,record_id) where seller_id is not null;
create index erp_catalog_contact_profile_situation on erp_catalog.contact_profile(situation,record_id) where situation is not null;

-- Pessoas de contato: outros contatos vinculados (Origin: Contato > Pessoas de contato).
create table erp_catalog.contact_person(
 contact_id uuid not null references erp_catalog.contact(record_id),
 person_id uuid not null references erp_catalog.contact(record_id),
 position integer not null check(position between 1 and 20),
 primary key(contact_id,person_id),
 unique(contact_id,position),
 check(contact_id<>person_id)
);
create index erp_catalog_contact_person_person on erp_catalog.contact_person(person_id);

-- Código sequencial (Preferências: Código do Contato = Sequencial; Próximo número com o lápis do Origin).
create table erp_catalog.contact_code_counter(
 id boolean primary key default true check(id),
 next_number bigint not null check(next_number between 1 and 999999999999999),
 version integer not null check(version between 1 and 2147483647),
 updated_by uuid not null references auth.users(id),
 updated_at timestamptz not null
);

-- Auditoria dos cadastros auxiliares da lane (tipos, próximo número, comentários, exportações, vendedores, formas de
-- pagamento e funcionários). Mudanças de contato continuam em erp_catalog.audit (Registro de atividades).
create table erp_catalog.auxiliary_audit(
 id bigint generated always as identity primary key,
 actor uuid not null references auth.users(id),
 command_id uuid,
 subject text not null check(subject in('contact_type','contact_code','contact_comment','contacts_export','contact_import','seller','payment_method','employee')),
 subject_id uuid,
 action text not null check(length(action) between 1 and 40),
 before_data jsonb,
 after_data jsonb,
 created_at timestamptz not null default clock_timestamp()
);
create index erp_catalog_auxiliary_audit_subject on erp_catalog.auxiliary_audit(subject,subject_id,created_at);

do $$ declare t text; begin
 foreach t in array array['contact_type','contact_type_link','seller','contact_profile','contact_person','contact_code_counter','auxiliary_audit'] loop
  execute format('alter table erp_catalog.%I enable row level security',t);
  execute format('revoke all on erp_catalog.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
revoke all on all sequences in schema erp_catalog from public,anon,authenticated,service_role;

-- ---- Situação: A Ativo, I Inativo, S Sem movimento, E Excluído. active = situation in (A,S) ----
-- Sem linha em contact_profile (cadastro antigo ou espelhado do Origin), a situação do Origin aplicada no espelho completa
-- o detalhe; "active" continua decidindo entre os dois grupos, para nunca contradizer o que os seletores já usam.
create function erp_catalog.contact_situation(p_active boolean,p_detail text) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when p_active then case when p_detail='S' then 'S' else 'A' end else case when p_detail='E' then 'E' else 'I' end end
$$;
create function erp_catalog.contact_source_situation(p_id uuid) returns text
language sql stable set search_path=pg_catalog as $$
 select s.payload->>'situacao' from erp_catalog.origin o
  join erp_catalog.source_snapshot s on s.entity=o.entity and s.source_id=o.source_id and s.source_hash=o.applied_hash
 where o.record_id=p_id and o.entity='contacts'
$$;
create function erp_catalog.contact_situation_of(p_id uuid) returns text
language sql stable set search_path=pg_catalog as $$
 select erp_catalog.contact_situation(r.active,coalesce(cp.situation,erp_catalog.contact_source_situation(r.id)))
 from erp_catalog.record r left join erp_catalog.contact_profile cp on cp.record_id=r.id where r.id=p_id and r.entity='contacts'
$$;

create function erp_catalog.contact_type_slugs(p_id uuid) returns text[]
language sql stable set search_path=pg_catalog as $$
 select coalesce(array_agg(t.slug order by t.position,t.slug),'{}'::text[]) from erp_catalog.contact_type t
 where t.active and((t.role_backed and t.slug=any(coalesce((select c.roles from erp_catalog.contact c where c.record_id=p_id),'{}'::text[])))
  or(not t.role_backed and exists(select 1 from erp_catalog.contact_type_link l where l.contact_id=p_id and l.type_id=t.id)))
$$;

-- Editable values of a contact, flat, in the shape the form sends (dates YYYY-MM-DD, decimals as exact strings).
create function erp_catalog.contact_data(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('name',r.name,'code',r.code,'trade_name',c.trade_name,'person_type',c.person_type,'document',c.document,'ie',c.ie,
   'email',c.email,'phone',c.phone,'mobile',c.mobile,'postal_code',c.postal_code,'street',c.street,'number',c.number,'complement',c.complement,
   'district',c.district,'city',c.city,'state',c.state,
   'situation',erp_catalog.contact_situation(r.active,coalesce(cp.situation,erp_catalog.contact_source_situation(r.id))),
   'types',to_jsonb(erp_catalog.contact_type_slugs(r.id)))
  ||jsonb_build_object('crt',cp.crt,'client_since',to_char(cp.client_since,'YYYY-MM-DD'),'taxpayer',cp.taxpayer,'ie_exempt',coalesce(cp.ie_exempt,false),
   'municipal_registration',cp.municipal_registration,'rg',cp.rg,'rg_issuer',cp.rg_issuer,'country',cp.country,'foreign_state',cp.foreign_state,
   'contact_info',cp.contact_info,'fax',cp.fax,'carrier_operator',cp.carrier_operator,'public_agency',cp.public_agency,'nfe_email',cp.nfe_email,
   'website',cp.website,'skype',cp.skype,'next_visit',to_char(cp.next_visit,'YYYY-MM-DD'),'avg_tax_load',cp.avg_tax_load::text,
   'marital_status',cp.marital_status,'profession',cp.profession,'gender',cp.gender,'birth_date',to_char(cp.birth_date,'YYYY-MM-DD'),
   'birthplace',cp.birthplace,'father_name',cp.father_name,'father_cpf',cp.father_cpf,'mother_name',cp.mother_name,'mother_cpf',cp.mother_cpf,
   'suframa',cp.suframa)
  ||jsonb_build_object('credit_limit_mode',coalesce(cp.credit_limit_mode,'unlimited'),'credit_limit',cp.credit_limit::text,
   'payment_condition',cp.payment_condition,'finance_category_id',cp.finance_category_id,'operation_nature_id',cp.operation_nature_id,
   'seller_id',cp.seller_id,'notes',cp.notes,
   'billing_postal_code',cp.billing_postal_code,'billing_state',cp.billing_state,'billing_city',cp.billing_city,'billing_district',cp.billing_district,
   'billing_street',cp.billing_street,'billing_number',cp.billing_number,'billing_complement',cp.billing_complement,'billing_foreign_state',cp.billing_foreign_state,
   'persons',(select coalesce(jsonb_agg(p.person_id order by p.position),'[]'::jsonb) from erp_catalog.contact_person p where p.contact_id=r.id))
 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id left join erp_catalog.contact_profile cp on cp.record_id=r.id
 where r.id=p_id and r.entity='contacts'
$$;
create function erp_catalog.contact_dto(p_id uuid) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v jsonb; v_record erp_catalog.record%rowtype; v_profile erp_catalog.contact_profile%rowtype;
begin
 select * into v_record from erp_catalog.record where id=p_id and entity='contacts';
 if v_record.id is null then return null; end if;
 select * into v_profile from erp_catalog.contact_profile where record_id=p_id;
 v:=erp_catalog.contact_data(p_id);
 return v||jsonb_build_object('id',v_record.id,'entity','contacts','active',v_record.active,'version',v_record.version,
  'created_at',v_record.created_at,'updated_at',v_record.updated_at,
  'roles',(select to_jsonb(c.roles) from erp_catalog.contact c where c.record_id=p_id),
  'source',(select jsonb_build_object('system','origin','source_id',o.source_id,'state',o.state,'applied_hash',o.applied_hash,'latest_hash',o.latest_hash)
   from erp_catalog.origin o where o.record_id=p_id),
  'finance_category_name',(select left(c.name,200) from erp_finance.category c where c.id=v_profile.finance_category_id),
  'operation_nature_name',(select n.description from erp_fiscal_invoices.nature n where n.id=v_profile.operation_nature_id),
  'seller_name',(select r.name from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id=v_profile.seller_id),
  'seller_record_id',(select s.id from erp_catalog.seller s where s.contact_id=p_id),
  'persons',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'situation',erp_catalog.contact_situation_of(r.id)) order by p.position),'[]'::jsonb)
   from erp_catalog.contact_person p join erp_catalog.record r on r.id=p.person_id where p.contact_id=p_id),
  'updated_by_name',case when v_record.updated_by is null then null else erp_activity.actor_label(v_record.updated_by) end);
end $$;

-- ---- Validação dos valores enviados (mesmos limites da API) ----
create function erp_catalog.contact_text(p_key text,p_value jsonb,p_max integer,p_multiline boolean default false) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 if jsonb_typeof(p_value)<>'string' then raise exception 'erp_catalog_contact_invalid:%',p_key using errcode='22023'; end if;
 v:=nullif(btrim(p_value#>>'{}'),'');
 if length(v)>p_max or(case when p_multiline then translate(v,E'\n\r\t','') else v end)~'[[:cntrl:]]' then
  raise exception 'erp_catalog_contact_invalid:%',p_key using errcode='22023'; end if;
 return v;
end $$;
create function erp_catalog.contact_email_list(p_value text,p_max integer) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select p_value is null or(length(p_value)<=p_max and not exists(
  select 1 from regexp_split_to_table(p_value,'\s*[;,]\s*') e where e!~'^[^@\s;,]+@[^@\s;,]+\.[^@\s;,]+$'))
$$;
-- Origin "Condição de pagamento": 30 | 30 60 90 (também , ; /) | 3x | 15 +2x (mesma gramática dos documentos).
create function erp_catalog.payment_condition_valid(p_value text) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare v text:=regexp_replace(lower(btrim(coalesce(p_value,''))),'\s+',' ','g'); v_days integer[]; i integer;
begin
 if v='' then return true; end if;
 if length(v)>100 then return false; end if;
 if v~'^[0-9]{1,4} ?\+ ?[0-9]{1,3} ?x$' then return substring(v from '([0-9]{1,3}) ?x$')::integer between 1 and 119
   and substring(v from '^([0-9]{1,4})')::integer<=3650; end if;
 if v~'^[0-9]{1,3} ?x$' then return substring(v from '^([0-9]{1,3})')::integer between 1 and 120; end if;
 if v!~'^[0-9]{1,4}(( ?[,;/] ?| )[0-9]{1,4})*$' then return false; end if;
 v_days:=regexp_split_to_array(v,' ?[,;/] ?| ')::integer[];
 if cardinality(v_days)>120 then return false; end if;
 for i in 1..cardinality(v_days) loop
  if v_days[i]>3650 or(i>1 and v_days[i]<v_days[i-1]) then return false; end if;
 end loop;
 return true;
end $$;
create function erp_catalog.contact_uf(p_value text) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select p_value is null or p_value in('AC','AL','AM','AP','BA','CE','DF','ES','EX','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO')
$$;
create function erp_catalog.contact_date(p_key text,p_value jsonb) returns date
language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 v:=case when jsonb_typeof(p_value)='string' then nullif(btrim(p_value#>>'{}'),'') end;
 if jsonb_typeof(p_value)<>'string' then raise exception 'erp_catalog_contact_invalid:%',p_key using errcode='22023'; end if;
 if v is null then return null; end if;
 if v!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char(to_date(v,'YYYY-MM-DD'),'YYYY-MM-DD')<>v or v<'1900-01-01' or v>'2100-12-31' then
  raise exception 'erp_catalog_contact_invalid:%',p_key using errcode='22023'; end if;
 return v::date;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'erp_catalog_contact_invalid:%',p_key using errcode='22023';
end $$;

-- Patch normalizado: só as chaves enviadas; texto vazio vira null. Regras que dependem de outros campos ficam em
-- contact_check_full. p_before decide o que é "novo ou alterado" para regras que o legado não precisa cumprir.
create function erp_catalog.contact_input(p_data jsonb,p_before jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v_pair record; v_result jsonb:='{}'::jsonb; v_text text; v_texts jsonb:='{"name":200,"code":100,"trade_name":200,"document":30,"ie":30,
 "email":254,"phone":40,"mobile":40,"postal_code":20,"street":200,"number":30,"complement":200,"district":100,"city":100,
 "municipal_registration":30,"rg":20,"rg_issuer":20,"country":60,"foreign_state":60,"fax":40,"nfe_email":60,"website":200,"skype":100,
 "profession":100,"birthplace":100,"father_name":200,"father_cpf":20,"mother_name":200,"mother_cpf":20,"payment_condition":100,
 "billing_postal_code":20,"billing_city":100,"billing_district":100,"billing_street":200,"billing_number":30,"billing_complement":200,
 "billing_foreign_state":60,"suframa":9}'::jsonb;
 v_enums jsonb:='{"person_type":["F","J","E"],"situation":["A","I","S"],"crt":["1","2","3","4"],"taxpayer":["1","2","9"],
 "carrier_operator":["claro","oi","tim","vivo","nextel","porto_seguro"],"public_agency":["municipal","estadual","federal"],
 "marital_status":["casado","solteiro","viuvo","separado","desquitado"],"gender":["feminino","masculino"],
 "credit_limit_mode":["unlimited","zero","value"]}'::jsonb;
 v_changed boolean;
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>32768 then
  raise exception 'erp_catalog_contact_invalid_data' using errcode='22023'; end if;
 for v_pair in select key,value from jsonb_each(p_data) loop
  if v_texts?v_pair.key then
   v_text:=erp_catalog.contact_text(v_pair.key,v_pair.value,(v_texts->>v_pair.key)::integer);
   v_changed:=v_text is distinct from p_before->>v_pair.key;
   if v_pair.key='name' and v_text is null then raise exception 'erp_catalog_name_required' using errcode='22023'; end if;
   if v_changed and v_pair.key in('email') and not erp_catalog.contact_email_list(v_text,254) then raise exception 'erp_catalog_contact_invalid:email' using errcode='22023'; end if;
   if v_pair.key='nfe_email' and not erp_catalog.contact_email_list(v_text,60) then raise exception 'erp_catalog_contact_invalid:nfe_email' using errcode='22023'; end if;
   if v_pair.key='website' and v_text!~'^(https?://)?[^\s/?#]+\.[^\s]+$' then raise exception 'erp_catalog_contact_invalid:website' using errcode='22023'; end if;
   if v_pair.key='payment_condition' and not erp_catalog.payment_condition_valid(v_text) then raise exception 'erp_catalog_contact_invalid:payment_condition' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_text);
  elsif v_pair.key in('state','billing_state') then
   v_text:=upper(erp_catalog.contact_text(v_pair.key,v_pair.value,2));
   -- Legacy UFs copied from Origin stay as they are until the field changes.
   if v_text is distinct from upper(p_before->>v_pair.key) and not erp_catalog.contact_uf(v_text) then raise exception 'erp_catalog_contact_invalid:%',v_pair.key using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,case when v_text is not distinct from upper(p_before->>v_pair.key) then p_before->>v_pair.key else v_text end);
  elsif v_pair.key in('notes','contact_info') then
   v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.contact_text(v_pair.key,v_pair.value,case when v_pair.key='notes' then 4000 else 400 end,true));
  elsif v_enums?v_pair.key then
   v_text:=erp_catalog.contact_text(v_pair.key,v_pair.value,20);
   if v_text is not null and not(v_enums->v_pair.key)?v_text then raise exception 'erp_catalog_contact_invalid:%',v_pair.key using errcode='22023'; end if;
   if v_pair.key='credit_limit_mode' and v_text is null then raise exception 'erp_catalog_contact_invalid:credit_limit_mode' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_text);
  elsif v_pair.key='ie_exempt' then
   if jsonb_typeof(v_pair.value)<>'boolean' then raise exception 'erp_catalog_contact_invalid:ie_exempt' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object('ie_exempt',v_pair.value);
  elsif v_pair.key in('client_since','next_visit','birth_date') then
   v_result:=v_result||jsonb_build_object(v_pair.key,to_char(erp_catalog.contact_date(v_pair.key,v_pair.value),'YYYY-MM-DD'));
  elsif v_pair.key in('avg_tax_load','credit_limit') then
   v_text:=erp_catalog.contact_text(v_pair.key,v_pair.value,20);
   if v_text is not null and(v_text!~case when v_pair.key='avg_tax_load' then '^(0|[1-9][0-9]?|100)(\.[0-9]{1,2})?$' else '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$' end
    or(v_pair.key='avg_tax_load' and v_text::numeric>100) or(v_pair.key='credit_limit' and v_text::numeric<=0)) then
    raise exception 'erp_catalog_contact_invalid:%',v_pair.key using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,case when v_text is null then null when v_pair.key='avg_tax_load' then v_text::numeric(5,2)::text else v_text::numeric(18,2)::text end);
  elsif v_pair.key in('finance_category_id','operation_nature_id','seller_id') then
   v_text:=erp_catalog.contact_text(v_pair.key,v_pair.value,36);
   if v_text is not null and v_text!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'erp_catalog_contact_invalid:%',v_pair.key using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_text);
  elsif v_pair.key='roles' then
   if jsonb_typeof(v_pair.value)<>'array' or jsonb_array_length(v_pair.value)>3
    or exists(select 1 from jsonb_array_elements(v_pair.value) a where jsonb_typeof(a)<>'string' or a#>>'{}' not in('customer','supplier','carrier'))
    or(select count(distinct a#>>'{}') from jsonb_array_elements(v_pair.value) a)<>jsonb_array_length(v_pair.value) then
    raise exception 'erp_catalog_invalid_roles' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object('roles',v_pair.value);
  elsif v_pair.key='types' then
   if jsonb_typeof(v_pair.value)<>'array' or jsonb_array_length(v_pair.value)>40
    or exists(select 1 from jsonb_array_elements(v_pair.value) a where jsonb_typeof(a)<>'string'
     or not exists(select 1 from erp_catalog.contact_type t where t.slug=a#>>'{}' and t.active))
    or(select count(distinct a#>>'{}') from jsonb_array_elements(v_pair.value) a)<>jsonb_array_length(v_pair.value) then
    raise exception 'erp_catalog_contact_invalid:types' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object('types',(select coalesce(jsonb_agg(t.slug order by t.position,t.slug),'[]'::jsonb)
    from erp_catalog.contact_type t where t.slug in(select jsonb_array_elements_text(v_pair.value))));
  elsif v_pair.key='persons' then
   if jsonb_typeof(v_pair.value)<>'array' or jsonb_array_length(v_pair.value)>20
    or exists(select 1 from jsonb_array_elements(v_pair.value) a where jsonb_typeof(a)<>'string' or a#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or(select count(distinct a#>>'{}') from jsonb_array_elements(v_pair.value) a)<>jsonb_array_length(v_pair.value) then
    raise exception 'erp_catalog_contact_invalid:persons' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object('persons',v_pair.value);
  else
   raise exception 'erp_catalog_unknown_field' using errcode='22023';
  end if;
 end loop;
 return v_result;
end $$;

-- Preferência "Campos obrigatórios para clientes e fornecedores": option id -> campo do contato e tipo de pessoa em que
-- o campo existe no formulário (o Origin só exige o que mostra).
create function erp_catalog.contact_required_field(p_option text) returns text
language sql immutable set search_path=pg_catalog as $$
 select case p_option when 'carga_media' then 'avg_tax_load' when 'bairro' then 'district' when 'bairro_cobranca' then 'billing_district'
  when 'celular' then 'mobile' when 'cep' then 'postal_code' when 'cep_cobranca' then 'billing_postal_code' when 'cidade' then 'city'
  when 'cidade_cobranca' then 'billing_city' when 'cliente_desde' then 'client_since' when 'cnpj' then 'document' when 'complemento' then 'complement'
  when 'complemento_cobranca' then 'billing_complement' when 'condicao_pagamento' then 'payment_condition' when 'informacoes_contato' then 'contact_info'
  when 'cpf_mae' then 'mother_cpf' when 'cpf_pai' then 'father_cpf' when 'data_nascimento' then 'birth_date' when 'email' then 'email'
  when 'email_nfe' then 'nfe_email' when 'endereco' then 'street' when 'endereco_cobranca' then 'billing_street' when 'numero' then 'number'
  when 'numero_cobranca' then 'billing_number' when 'fantasia' then 'trade_name' when 'fax' then 'fax' when 'fone' then 'phone'
  when 'natureza_operacao' then 'operation_nature_id' when 'inscricao_estadual' then 'ie' when 'inscricao_municipal' then 'municipal_registration'
  when 'inscricao_suframa' then 'suframa' when 'limite_credito' then 'credit_limit_mode' when 'naturalidade' then 'birthplace'
  when 'nome_mae' then 'mother_name' when 'nome_pai' then 'father_name' when 'pais' then 'country' when 'observacoes' then 'notes'
  when 'orgao_emissor' then 'rg_issuer' when 'profissao' then 'profession' when 'proxima_visita' then 'next_visit' when 'rg' then 'rg'
  when 'website' then 'website' when 'skype' then 'skype' when 'uf_exterior_cobranca' then 'billing_foreign_state' when 'uf_exterior' then 'foreign_state' end
$$;
-- Campos que só existem para um tipo de pessoa (o formulário do Origin esconde os demais).
create function erp_catalog.contact_field_person_type(p_field text) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when p_field in('rg','rg_issuer','avg_tax_load','marital_status','profession','gender','birth_date','birthplace','father_name','father_cpf','mother_name','mother_cpf') then 'F'
  when p_field in('crt','municipal_registration','public_agency','suframa','ie_exempt') then 'J'
  when p_field in('country','foreign_state','billing_foreign_state') then 'E' end
$$;
-- First missing required field (or null). "Limite de crédito" obrigatório pede Limite zero ou um valor. p_fields limits
-- the check to the fields a screen shows (Vendedores shows part of the form; batch actions show none); null = all.
create function erp_catalog.contact_required_missing(p jsonb,p_fields text[] default null) returns text
language plpgsql stable set search_path=pg_catalog as $$
declare v_option text; v_field text; v_only text;
begin
 for v_option in select jsonb_array_elements_text(coalesce(erp_preferences.get('contatos.campos_obrigatorios'),'[]'::jsonb)) loop
  v_field:=erp_catalog.contact_required_field(v_option);
  if v_field is null or(p_fields is not null and not v_field=any(p_fields)) then continue; end if;
  v_only:=erp_catalog.contact_field_person_type(v_field);
  if v_only is not null and v_only is distinct from p->>'person_type' then continue; end if;
  if v_field='ie' and coalesce((p->>'ie_exempt')::boolean,false) then continue; end if;
  if (case when v_field='credit_limit_mode' then coalesce(p->>v_field,'unlimited')='unlimited' else nullif(p->>v_field,'') is null end) then return v_field; end if;
 end loop;
 return null;
end $$;

-- Seller visibility (Preferência "Contato acessível somente ao vendedor vinculado"): the seller of a user who is not an
-- administrator, when the preference is on and the user is linked to a seller; otherwise null. The seller's own situation
-- does not matter: inactivating or excluding a seller must never widen what its user sees (a new contact then needs an
-- active seller, so that user cannot include contacts until the seller is active again).
create function erp_catalog.contact_scope(p_user_id uuid) returns uuid
language plpgsql stable set search_path=pg_catalog as $$
declare v_role text; v_seller uuid;
begin
 if coalesce(erp_preferences.get('contatos.acesso_vendedor'),'false'::jsonb)<>'true'::jsonb then return null; end if;
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if v_role is null or v_role='admin' then return null; end if;
 select s.id into v_seller from erp_catalog.seller s where s.user_id=p_user_id;
 return v_seller;
end $$;
create function erp_catalog.contact_require_visible(p_user_id uuid,p_id uuid) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 if v_scope is not null and not exists(select 1 from erp_catalog.contact_profile where record_id=p_id and seller_id=v_scope) then
  raise exception 'erp_catalog_contact_not_visible' using errcode='42501'; end if;
end $$;

-- Warnings before saving: invalid/duplicate CPF/CNPJ (096 rules, only for new or changed values), parents' CPF digits.
-- duplicate_document carries blocked=true when Preferências forbid a duplicate among contacts that are not Excluído.
create function erp_catalog.contact_warnings(p_id uuid,p_full jsonb,p_before jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v jsonb:=erp_catalog.warnings('contacts',p_id,jsonb_build_object('document',p_full->'document','person_type',p_full->'person_type'));
 v_allow boolean:=coalesce(erp_preferences.get('contatos.permite_documento_duplicado'),'true'::jsonb)='true'::jsonb; v_blocked boolean:=false; v_key text;
begin
 if not v_allow and exists(select 1 from jsonb_array_elements(v) w where w->>'code'='duplicate_document') then
  select exists(select 1 from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id
   where c.document is not null and erp_catalog.compact(c.document)=erp_catalog.compact(p_full->>'document') and r.id is distinct from p_id
    and erp_catalog.contact_situation_of(r.id)<>'E') into v_blocked;
  select coalesce(jsonb_agg(case when w->>'code'='duplicate_document' then w||jsonb_build_object('blocked',v_blocked) else w end),'[]'::jsonb) into v from jsonb_array_elements(v) w;
 end if;
 foreach v_key in array array['father_cpf','mother_cpf'] loop
  if nullif(p_full->>v_key,'') is not null and p_full->>v_key is distinct from p_before->>v_key
   and not erp_catalog.valid_cpf(regexp_replace(p_full->>v_key,'[ ./-]','','g')) then
   v:=v||jsonb_build_array(jsonb_build_object('code','invalid_'||v_key,'field',v_key,'expected','cpf'));
  end if;
 end loop;
 return v;
end $$;

-- Cross-field rules of the complete record (defaults applied). p_before is '{}' on creation. p_required: see
-- contact_required_missing.
create function erp_catalog.contact_check_full(p_id uuid,p jsonb,p_before jsonb,p_required text[] default null) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare v_key text; v_only text; v_missing text;
begin
 if nullif(p->>'name','') is null then raise exception 'erp_catalog_name_required' using errcode='22023'; end if;
 for v_key in select k from jsonb_object_keys(p) k loop
  v_only:=erp_catalog.contact_field_person_type(v_key);
  if v_only is not null and v_only is distinct from p->>'person_type'
   and(case when v_key='ie_exempt' then coalesce((p->>v_key)::boolean,false) else nullif(p->>v_key,'') is not null end) then
   raise exception 'erp_catalog_contact_invalid:%',v_key using errcode='22023'; end if;
 end loop;
 if coalesce((p->>'ie_exempt')::boolean,false) and nullif(p->>'ie','') is not null then raise exception 'erp_catalog_contact_invalid:ie' using errcode='22023'; end if;
 if (p->>'credit_limit_mode'='value')<>(p->>'credit_limit' is not null) then raise exception 'erp_catalog_contact_invalid:credit_limit' using errcode='22023'; end if;
 if p->>'suframa' is not null and p->>'suframa'!~'^[0-9]{8,9}$' then raise exception 'erp_catalog_contact_invalid:suframa' using errcode='22023'; end if;
 if p->>'birth_date' is not null and p->>'birth_date' is distinct from p_before->>'birth_date'
  and(p->>'birth_date')::date>(clock_timestamp() at time zone 'America/Sao_Paulo')::date then raise exception 'erp_catalog_contact_invalid:birth_date' using errcode='22023'; end if;
 if p->>'finance_category_id' is distinct from p_before->>'finance_category_id' and p->>'finance_category_id' is not null
  and not exists(select 1 from erp_finance.category where id=(p->>'finance_category_id')::uuid and active) then raise exception 'erp_catalog_contact_invalid:finance_category_id' using errcode='22023'; end if;
 if p->>'operation_nature_id' is distinct from p_before->>'operation_nature_id' and p->>'operation_nature_id' is not null
  and not exists(select 1 from erp_fiscal_invoices.nature where id=(p->>'operation_nature_id')::uuid and active) then raise exception 'erp_catalog_contact_invalid:operation_nature_id' using errcode='22023'; end if;
 if p->>'seller_id' is distinct from p_before->>'seller_id' and p->>'seller_id' is not null
  and not exists(select 1 from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id=(p->>'seller_id')::uuid and r.active) then
  raise exception 'erp_catalog_contact_invalid:seller_id' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements_text(coalesce(p->'persons','[]'::jsonb)) x where x::uuid=p_id
   or(not coalesce(p_before->'persons','[]'::jsonb)?x and not exists(select 1 from erp_catalog.record r where r.id=x::uuid and r.entity='contacts'))) then
  raise exception 'erp_catalog_contact_invalid:persons' using errcode='22023'; end if;
 v_missing:=erp_catalog.contact_required_missing(p,p_required);
 if v_missing is not null then raise exception 'erp_catalog_contact_required:%',v_missing using errcode='22023'; end if;
end $$;

-- Writes the complete record (contact + profile + types + persons). roles is the projection of the role-backed types.
create function erp_catalog.contact_write(p_id uuid,p jsonb) returns void
language plpgsql set search_path=pg_catalog as $$
declare v_roles text[]:=array(select t.slug from erp_catalog.contact_type t where t.role_backed and t.slug in(select jsonb_array_elements_text(p->'types')) order by t.slug);
begin
 insert into erp_catalog.contact(record_id,trade_name,person_type,document,ie,email,phone,mobile,postal_code,street,number,complement,district,city,state,roles)
 values(p_id,p->>'trade_name',p->>'person_type',p->>'document',p->>'ie',p->>'email',p->>'phone',p->>'mobile',p->>'postal_code',p->>'street',p->>'number',
  p->>'complement',p->>'district',p->>'city',p->>'state',v_roles)
 on conflict(record_id) do update set trade_name=excluded.trade_name,person_type=excluded.person_type,document=excluded.document,ie=excluded.ie,
  email=excluded.email,phone=excluded.phone,mobile=excluded.mobile,postal_code=excluded.postal_code,street=excluded.street,number=excluded.number,
  complement=excluded.complement,district=excluded.district,city=excluded.city,state=excluded.state,roles=excluded.roles;
 insert into erp_catalog.contact_profile(record_id,situation,crt,client_since,taxpayer,ie_exempt,municipal_registration,rg,rg_issuer,country,foreign_state,
  contact_info,fax,carrier_operator,public_agency,nfe_email,website,skype,next_visit,avg_tax_load,marital_status,profession,gender,birth_date,birthplace,
  father_name,father_cpf,mother_name,mother_cpf,suframa,credit_limit_mode,credit_limit,payment_condition,finance_category_id,operation_nature_id,seller_id,notes,
  billing_postal_code,billing_state,billing_city,billing_district,billing_street,billing_number,billing_complement,billing_foreign_state)
 values(p_id,p->>'situation',p->>'crt',(p->>'client_since')::date,p->>'taxpayer',coalesce((p->>'ie_exempt')::boolean,false),p->>'municipal_registration',p->>'rg',
  p->>'rg_issuer',p->>'country',p->>'foreign_state',p->>'contact_info',p->>'fax',p->>'carrier_operator',p->>'public_agency',p->>'nfe_email',p->>'website',p->>'skype',
  (p->>'next_visit')::date,(p->>'avg_tax_load')::numeric,p->>'marital_status',p->>'profession',p->>'gender',(p->>'birth_date')::date,p->>'birthplace',
  p->>'father_name',p->>'father_cpf',p->>'mother_name',p->>'mother_cpf',p->>'suframa',coalesce(p->>'credit_limit_mode','unlimited'),(p->>'credit_limit')::numeric,
  p->>'payment_condition',(p->>'finance_category_id')::uuid,(p->>'operation_nature_id')::uuid,(p->>'seller_id')::uuid,p->>'notes',
  p->>'billing_postal_code',p->>'billing_state',p->>'billing_city',p->>'billing_district',p->>'billing_street',p->>'billing_number',p->>'billing_complement',p->>'billing_foreign_state')
 on conflict(record_id) do update set situation=excluded.situation,crt=excluded.crt,client_since=excluded.client_since,taxpayer=excluded.taxpayer,
  ie_exempt=excluded.ie_exempt,municipal_registration=excluded.municipal_registration,rg=excluded.rg,rg_issuer=excluded.rg_issuer,country=excluded.country,
  foreign_state=excluded.foreign_state,contact_info=excluded.contact_info,fax=excluded.fax,carrier_operator=excluded.carrier_operator,
  public_agency=excluded.public_agency,nfe_email=excluded.nfe_email,website=excluded.website,skype=excluded.skype,next_visit=excluded.next_visit,
  avg_tax_load=excluded.avg_tax_load,marital_status=excluded.marital_status,profession=excluded.profession,gender=excluded.gender,birth_date=excluded.birth_date,
  birthplace=excluded.birthplace,father_name=excluded.father_name,father_cpf=excluded.father_cpf,mother_name=excluded.mother_name,mother_cpf=excluded.mother_cpf,
  suframa=excluded.suframa,credit_limit_mode=excluded.credit_limit_mode,credit_limit=excluded.credit_limit,payment_condition=excluded.payment_condition,
  finance_category_id=excluded.finance_category_id,operation_nature_id=excluded.operation_nature_id,seller_id=excluded.seller_id,notes=excluded.notes,
  billing_postal_code=excluded.billing_postal_code,billing_state=excluded.billing_state,billing_city=excluded.billing_city,billing_district=excluded.billing_district,
  billing_street=excluded.billing_street,billing_number=excluded.billing_number,billing_complement=excluded.billing_complement,billing_foreign_state=excluded.billing_foreign_state;
 delete from erp_catalog.contact_type_link l using erp_catalog.contact_type t
  where l.contact_id=p_id and t.id=l.type_id and not t.slug in(select jsonb_array_elements_text(p->'types'));
 insert into erp_catalog.contact_type_link(contact_id,type_id)
  select p_id,t.id from erp_catalog.contact_type t where not t.role_backed and t.active and t.slug in(select jsonb_array_elements_text(p->'types'))
  on conflict do nothing;
 delete from erp_catalog.contact_person where contact_id=p_id;
 insert into erp_catalog.contact_person(contact_id,person_id,position)
  select p_id,x.value::uuid,x.n from jsonb_array_elements_text(coalesce(p->'persons','[]'::jsonb)) with ordinality x(value,n);
end $$;

-- Next sequential code: the counter row is locked; numbers already used as a contact code are skipped.
create function erp_catalog.contact_take_code(p_user_id uuid) returns text
language plpgsql set search_path=pg_catalog as $$
declare v_next bigint;
begin
 perform pg_advisory_xact_lock(174852908,1);
 select next_number into v_next from erp_catalog.contact_code_counter where id for update;
 if v_next is null then
  select coalesce(max(code::numeric),0)+1 into v_next from erp_catalog.record where entity='contacts' and code~'^[0-9]{1,15}$';
 end if;
 -- CASE keeps the cast behind the pattern test (the planner may evaluate AND operands in any order).
 while exists(select 1 from erp_catalog.record where entity='contacts' and case when code~'^[0-9]{1,15}$' then code::numeric end=v_next) loop v_next:=v_next+1; end loop;
 if v_next>=999999999999999 then raise exception 'erp_catalog_contact_code_exhausted' using errcode='22023'; end if;
 insert into erp_catalog.contact_code_counter(id,next_number,version,updated_by,updated_at) values(true,v_next+1,1,p_user_id,clock_timestamp())
 on conflict(id) do update set next_number=excluded.next_number,version=erp_catalog.contact_code_counter.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
 return v_next::text;
end $$;

-- ---- Leitura ----
create function public.erp_catalog_contact_get(p_user_id uuid,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_id is null or not exists(select 1 from erp_catalog.record where id=p_id and entity='contacts') then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_id);
 return jsonb_build_object('entity','contacts','record',erp_catalog.contact_dto(p_id),'data_mode','erp_native');
end $$;

-- Merge of the stored record with the sent patch, as the save will compute it (also used by the read-only check).
create function erp_catalog.contact_merge(p_user_id uuid,p_id uuid,p_data jsonb,p_before jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v_patch jsonb:=erp_catalog.contact_input(p_data,p_before); v jsonb; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 v:=case when p_id is null then jsonb_build_object('situation','A','types','[]'::jsonb,'persons','[]'::jsonb,'ie_exempt',false,'credit_limit_mode','unlimited',
   'taxpayer','9','client_since',to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD'),'seller_id',v_scope)
  else p_before end||(v_patch-'roles');
 -- A seller's new contact is linked to that seller even when the form sends Vendedor empty (the form always sends it).
 if p_id is null and v_scope is not null and v->>'seller_id' is null then v:=v||jsonb_build_object('seller_id',v_scope); end if;
 -- Old clients send roles only: the three role-backed types follow them and the other types are kept.
 if v_patch?'roles' and not v_patch?'types' then
  v:=jsonb_set(v,'{types}',(select coalesce(jsonb_agg(t.slug order by t.position,t.slug),'[]'::jsonb) from erp_catalog.contact_type t
   where t.active and((t.role_backed and v_patch->'roles'?t.slug) or(not t.role_backed and coalesce(v->'types','[]'::jsonb)?t.slug))));
 end if;
 if v_scope is not null and v->>'seller_id' is distinct from v_scope::text then raise exception 'erp_catalog_contact_not_visible' using errcode='42501'; end if;
 return v;
end $$;

create function public.erp_catalog_contact_check(p_user_id uuid,p_id uuid,p_data jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_before jsonb:='{}'::jsonb; v_full jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_id is not null then
  if not exists(select 1 from erp_catalog.record where id=p_id and entity='contacts') then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  perform erp_catalog.contact_require_visible(p_user_id,p_id);
  v_before:=erp_catalog.contact_data(p_id);
 end if;
 v_full:=erp_catalog.contact_merge(p_user_id,p_id,p_data,v_before);
 return jsonb_build_object('entity','contacts','warnings',erp_catalog.contact_warnings(p_id,v_full,v_before),'data_mode','erp_native');
end $$;

-- ---- Gravação: inclusão e alteração com command_id, expected_version, avisos confirmados e auditoria ----
-- contact_apply validates and writes one contact for a caller that already holds the command lock (the contact save,
-- the vendedor save and "Vincular a vendedor"); it returns the stored DTO. p_audit names the audit action of an update.
-- p_required limits "Campos obrigatórios" to the fields the calling screen shows (null = the whole contact form).
create function erp_catalog.contact_apply(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb,p_acknowledged jsonb,p_audit text default 'update',
 p_required text[] default null)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_row erp_catalog.record%rowtype; v_id uuid; v_before jsonb:='{}'::jsonb; v_before_dto jsonb; v_full jsonb; v_warnings jsonb; v_codes jsonb; v_dto jsonb; v_changed boolean;
begin
 if p_id is not null then
  select * into v_row from erp_catalog.record where id=p_id and entity='contacts' for update;
  if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  perform erp_catalog.contact_require_visible(p_user_id,p_id);
  if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  v_before:=erp_catalog.contact_data(p_id); v_before_dto:=erp_catalog.contact_dto(p_id);
  -- Excluído is read-only: restore it (Restaurar selecionados) before editing.
  if v_before->>'situation'='E' then raise exception 'erp_catalog_contact_deleted' using errcode='22023'; end if;
 end if;
 v_full:=erp_catalog.contact_merge(p_user_id,p_id,p_data,v_before);
 if p_id is null and nullif(v_full->>'code','') is null and erp_preferences.get('contatos.codigo')='"sequencial"'::jsonb then
  v_full:=jsonb_set(v_full,'{code}',to_jsonb(erp_catalog.contact_take_code(p_user_id)));
 end if;
 perform erp_catalog.contact_check_full(p_id,v_full,v_before,p_required);
 v_warnings:=erp_catalog.contact_warnings(p_id,v_full,v_before);
 if exists(select 1 from jsonb_array_elements(v_warnings) w where (w->>'blocked')::boolean) then
  raise exception 'erp_catalog_duplicate_document' using errcode='23505'; end if;
 select coalesce(jsonb_agg(w->'code'),'[]'::jsonb) into v_codes from jsonb_array_elements(v_warnings) w;
 if p_acknowledged is not null and exists(select 1 from jsonb_array_elements_text(v_codes) c where not p_acknowledged?c) then
  raise exception 'erp_catalog_warning_unacknowledged' using errcode='40001'; end if;
 if p_id is null then
  insert into erp_catalog.record(entity,name,code,active,created_by,updated_by,human_edited)
   values('contacts',v_full->>'name',v_full->>'code',v_full->>'situation' in('A','S'),p_user_id,p_user_id,true) returning id into v_id;
  perform erp_catalog.contact_write(v_id,v_full);
  v_changed:=true;
 else
  v_id:=p_id; v_changed:=v_full is distinct from v_before;
  if v_changed then
   if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
   update erp_catalog.record set name=v_full->>'name',code=v_full->>'code',active=v_full->>'situation' in('A','S'),version=version+1,human_edited=true,
    updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
   perform erp_catalog.contact_write(v_id,v_full);
   update erp_catalog.origin set state=case when state in('source_changed','source_deleted') then state else 'local_modified' end where record_id=v_id;
  end if;
 end if;
 v_dto:=erp_catalog.contact_dto(v_id);
 if v_changed then
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
   values(p_user_id,p_command_id,'contacts',v_id,case when p_id is null then 'create' else p_audit end,v_before_dto,v_dto);
  if p_acknowledged is not null and jsonb_array_length(v_codes)>0 then
   insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
    values(p_user_id,p_command_id,'contacts',v_id,'warnings_acknowledged',null,jsonb_build_object('warnings',v_codes));
  end if;
 end if;
 return v_dto;
end $$;
create function erp_catalog.acknowledged_valid(p_acknowledged jsonb) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select p_acknowledged is null or(jsonb_typeof(p_acknowledged)='array' and jsonb_array_length(p_acknowledged)<=6
  and not exists(select 1 from jsonb_array_elements(p_acknowledged) a where jsonb_typeof(a)<>'string'
   or a#>>'{}' not in('invalid_document','duplicate_document','invalid_father_cpf','invalid_mother_cpf'))
  and(select count(distinct a#>>'{}') from jsonb_array_elements(p_acknowledged) a)=jsonb_array_length(p_acknowledged))
$$;
create function public.erp_catalog_contact_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb,p_acknowledged jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_result jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_command_id is null or p_expected_version is null or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647)
  or p_data is null or jsonb_typeof(p_data)<>'object' or p_data='{}'::jsonb or not erp_catalog.acknowledged_valid(p_acknowledged) then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-contact-save-v1','actor',p_user_id,'id',p_id,'version',p_expected_version,
  'data',p_data,'acknowledged',p_acknowledged)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 v_result:=jsonb_build_object('entity','contacts','record',erp_catalog.contact_apply(p_user_id,p_id,p_expected_version,p_command_id,p_data,p_acknowledged),
  'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Situação pela listagem (Excluir / Restaurar selecionados, Ativar / Inativar): um contato por comando.
create function public.erp_catalog_contact_set_situation(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_situation text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.record%rowtype; v_before jsonb; v_from text; v_result jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483647 or p_situation is null or p_situation not in('A','I','S','E') then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-contact-situation-v1','actor',p_user_id,'id',p_id,'version',p_expected_version,'situation',p_situation)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 select * into v_row from erp_catalog.record where id=p_id and entity='contacts' for update;
 if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_id);
 if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 v_from:=erp_catalog.contact_situation_of(p_id);
 if v_from<>p_situation then
  if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
  v_before:=erp_catalog.contact_dto(p_id);
  update erp_catalog.record set active=p_situation in('A','S'),version=version+1,human_edited=true,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
  insert into erp_catalog.contact_profile(record_id,situation) values(p_id,p_situation) on conflict(record_id) do update set situation=excluded.situation;
  update erp_catalog.origin set state=case when state in('source_changed','source_deleted') then state else 'local_modified' end where record_id=p_id;
 end if;
 v_result:=jsonb_build_object('entity','contacts','record',erp_catalog.contact_dto(p_id),'replayed',false,'data_mode','erp_native');
 if v_from<>p_situation then
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
   values(p_user_id,p_command_id,'contacts',p_id,case when p_situation='E' then 'archive' else 'transition' end,v_before,v_result->'record');
 end if;
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- ---- Tipos de contato: listagem, inclusão (Marcador*) e exclusão dos tipos que o Origin permite excluir ----
create function public.erp_catalog_contact_types(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text:=erp_catalog.require_access(p_user_id,'contacts',false);
begin
 return jsonb_build_object('scope','contact_types','data_mode','erp_native','can_create',erp_catalog.allowed(v_role,'contacts',true),'can_delete',v_role='admin',
  'items',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'slug',t.slug,'label',t.label,'system',t.system,'deletable',t.deletable,'position',t.position,
   'contacts',case when t.role_backed then (select count(*) from erp_catalog.contact c where t.slug=any(c.roles))
    else (select count(*) from erp_catalog.contact_type_link l where l.type_id=t.id) end) order by t.position,t.slug),'[]'::jsonb)
   from erp_catalog.contact_type t where t.active));
end $$;
create function public.erp_catalog_contact_type_create(p_user_id uuid,p_command_id uuid,p_label text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_label text:=btrim(p_label); v_id uuid; v_result jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_command_id is null or v_label is null or length(v_label) not between 1 and 60 or v_label~'[[:cntrl:]]' then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-contact-type-create-v1','actor',p_user_id,'label',v_label)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 perform pg_advisory_xact_lock(174852908,2);
 if exists(select 1 from erp_catalog.contact_type where active and erp_catalog.fold(label)=erp_catalog.fold(v_label)) then
  raise exception 'erp_catalog_contact_type_exists' using errcode='23505'; end if;
 if (select count(*) from erp_catalog.contact_type where active)>=100 then raise exception 'erp_catalog_contact_type_limit' using errcode='22023'; end if;
 v_id:=gen_random_uuid();
 insert into erp_catalog.contact_type(id,slug,label,system,deletable,role_backed,position,created_by)
  values(v_id,'t'||replace(v_id::text,'-',''),v_label,false,true,false,(select coalesce(max(position),0)+1 from erp_catalog.contact_type),p_user_id);
 v_result:=jsonb_build_object('scope','contact_type','data_mode','erp_native','replayed',false,
  'item',(select jsonb_build_object('id',t.id,'slug',t.slug,'label',t.label,'system',t.system,'deletable',t.deletable,'position',t.position,'contacts',0) from erp_catalog.contact_type t where t.id=v_id));
 insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,after_data) values(p_user_id,p_command_id,'contact_type',v_id,'create',v_result->'item');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;
-- Excluir (lixeira de Tipos de contatos): só administrador e só tipos excluíveis; os vínculos saem com o tipo.
create function public.erp_catalog_contact_type_delete(p_user_id uuid,p_command_id uuid,p_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text; v_hash text; v_command erp_catalog.command%rowtype; v_type erp_catalog.contact_type%rowtype; v_links jsonb; v_result jsonb;
begin
 v_role:=erp_catalog.require_access(p_user_id,'contacts',false);
 if v_role<>'admin' then raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
 if p_command_id is null or p_id is null then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-contact-type-delete-v1','actor',p_user_id,'id',p_id)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 select * into v_type from erp_catalog.contact_type where id=p_id for update;
 if v_type.id is null or not v_type.active then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 if not v_type.deletable then raise exception 'erp_catalog_contact_type_protected' using errcode='42501'; end if;
 select coalesce(jsonb_agg(contact_id order by contact_id),'[]'::jsonb) into v_links from erp_catalog.contact_type_link where type_id=p_id;
 delete from erp_catalog.contact_type_link where type_id=p_id;
 update erp_catalog.contact_type set active=false,deleted_by=p_user_id,deleted_at=clock_timestamp() where id=p_id;
 v_result:=jsonb_build_object('scope','contact_type_delete','data_mode','erp_native','replayed',false,'id',p_id,'unlinked',jsonb_array_length(v_links));
 insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,before_data,after_data)
  values(p_user_id,p_command_id,'contact_type',p_id,'archive',to_jsonb(v_type),jsonb_build_object('unlinked_contacts',v_links));
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- ---- Próximo número do código sequencial (lápis "Editar próximo número" do Origin) ----
create function public.erp_catalog_contact_code(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text:=erp_catalog.require_access(p_user_id,'contacts',false); v_counter erp_catalog.contact_code_counter%rowtype; v_max numeric;
begin
 select * into v_counter from erp_catalog.contact_code_counter where id;
 select coalesce(max(code::numeric),0) into v_max from erp_catalog.record where entity='contacts' and code~'^[0-9]{1,15}$';
 return jsonb_build_object('scope','contact_code','data_mode','erp_native','mode',coalesce(erp_preferences.get('contatos.codigo')#>>'{}','manual'),
  'next_number',coalesce(v_counter.next_number,v_max+1)::text,'version',coalesce(v_counter.version,0),'highest_used',v_max::text,'can_edit',v_role='admin');
end $$;
create function public.erp_catalog_contact_code_set(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_next_number text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text; v_hash text; v_command erp_catalog.command%rowtype; v_counter erp_catalog.contact_code_counter%rowtype; v_max numeric; v_result jsonb;
begin
 v_role:=erp_catalog.require_access(p_user_id,'contacts',false);
 if v_role<>'admin' then raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or p_next_number is null or p_next_number!~'^[1-9][0-9]{0,14}$' then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-contact-code-v1','actor',p_user_id,'version',p_expected_version,'next',p_next_number)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 perform pg_advisory_xact_lock(174852908,1);
 select * into v_counter from erp_catalog.contact_code_counter where id for update;
 if coalesce(v_counter.version,0)<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 select coalesce(max(code::numeric),0) into v_max from erp_catalog.record where entity='contacts' and code~'^[0-9]{1,15}$';
 -- The next number never goes back to a code already used.
 if p_next_number::bigint<=v_max then raise exception 'erp_catalog_contact_code_used' using errcode='22023'; end if;
 insert into erp_catalog.contact_code_counter(id,next_number,version,updated_by,updated_at) values(true,p_next_number::bigint,1,p_user_id,clock_timestamp())
 on conflict(id) do update set next_number=excluded.next_number,version=erp_catalog.contact_code_counter.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
 v_result:=public.erp_catalog_contact_code(p_user_id)||jsonb_build_object('replayed',false);
 insert into erp_catalog.auxiliary_audit(actor,command_id,subject,action,before_data,after_data)
  values(p_user_id,p_command_id,'contact_code','next_number',jsonb_build_object('next_number',v_counter.next_number),jsonb_build_object('next_number',p_next_number));
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_contact_get(uuid,uuid)','erp_catalog_contact_check(uuid,uuid,jsonb)','erp_catalog_contact_save(uuid,uuid,integer,uuid,jsonb,jsonb)',
  'erp_catalog_contact_set_situation(uuid,uuid,integer,uuid,text)','erp_catalog_contact_types(uuid)','erp_catalog_contact_type_create(uuid,uuid,text)',
  'erp_catalog_contact_type_delete(uuid,uuid,uuid)','erp_catalog_contact_code(uuid)','erp_catalog_contact_code_set(uuid,uuid,integer,text)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
