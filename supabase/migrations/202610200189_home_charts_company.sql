-- 189: página inicial e Empresa no padrão do Origin.
-- * Gráficos da página inicial ("+" Incluir gráficos): cada usuário escolhe e ordena Valores por dia (o gráfico atual), Ticket
--   Médio, Valor Faturado, Quantidade de pedidos de venda e Top 5 SKU's mais vendidos; lista própria com versão (CAS), comando
--   idempotente (mesma tabela de comandos dos atalhos) e auditoria. erp_home_top_products devolve os 5 produtos mais vendidos
--   do período (quantidade, pedidos não cancelados), só para quem consulta pedidos de venda e produtos.
-- * Atalhos favoritos com Nome e Link: o link é uma tela do menu real (catálogo de 152/190) com filtros a mais na consulta
--   (ex.: /documentos-empresa?tipo=sales_orders&situacao=open); o nome é guardado junto. Quem não abre a tela base não vê o
--   atalho, como antes.
-- * Empresa › Dados do sócio(s): nome, CPF, participação (%), cargo, e-mail e telefone, só para o administrador, com versão,
--   comando idempotente e auditoria em erp_company.audit.
-- * Empresa › Dados da empresa: corrigir Nome, Nome Fantasia ou CNPJ já cadastrados exige um motivo, guardado na auditoria.
-- Substitui erp_home.visible_shortcuts, erp_home_shortcuts_get, erp_home_shortcuts_save (097) e erp_company_save_identity (016);
-- qualquer outra versão interrompe a migração.
begin;

do $$declare v record;begin
 for v in select * from(values('erp_home.visible_shortcuts(text,text[])','cdc915090dc0e0ee0335e4ece62b7d57c4fcb51734b96f5c327c5314e8859338'),
  ('public.erp_home_shortcuts_get(uuid)','3b43f80b257de171870b7c495215c843db67d1841c8c3864c4730bd17a03df63'),
  ('public.erp_home_shortcuts_save(uuid,uuid,integer,jsonb)','82941acf40a5dcae5fcc27a1b54a7b2c2f738bb7108549e38e6b93ba64e2ba6a'),
  ('public.erp_company_save_identity(uuid,integer,uuid,jsonb)','9a3de528b968812c2a06b43498bf8815219aea6954e4d04cedf8c4197c720eee')) x(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'home_company_189_previous_definition_changed %',v.sig using errcode='55000';end if;
 end loop;
end$$;

-- ------------------------------------------------------------------------------------------------------------------------
-- Gráficos da página inicial.
create table erp_home.chart_preference(
 user_id uuid primary key references auth.users(id) on delete cascade,
 charts text[] not null check(cardinality(charts)<=5 and array_position(charts,null) is null
  and charts<@array['resumo','ticket_medio','valor_faturado','quantidade_pedidos','top_skus']::text[]),
 version integer not null check(version>0),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
alter table erp_home.chart_preference enable row level security;
revoke all on erp_home.chart_preference from public,anon,authenticated,service_role;
create function erp_home.chart_keys() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['resumo','ticket_medio','valor_faturado','quantidade_pedidos','top_skus']
$$;
-- Top 5 SKU's reads product names and sales: only roles that read sales orders and products.
create function erp_home.top_products_allowed(p_role text) returns boolean language sql stable set search_path=pg_catalog as $$
 select erp_documents.allowed(p_role,'sales_orders',false) and erp_catalog.allowed(p_role,'products',false)
$$;
create function erp_home.available_charts(p_role text) returns text[] language sql stable set search_path=pg_catalog as $$
 select array(select k from unnest(erp_home.chart_keys()) with ordinality u(k,o) where k<>'top_skus' or erp_home.top_products_allowed(p_role) order by o)
$$;
create function erp_home.charts_view(p_user uuid,p_role text) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('scope','home_charts','data_mode','erp_native','role',p_role,'version',coalesce(c.version,0),'customized',c.user_id is not null,
  'charts',coalesce((select jsonb_agg(k order by o) from unnest(coalesce(c.charts,erp_home.chart_keys())) with ordinality u(k,o) where k=any(erp_home.available_charts(p_role))),'[]'::jsonb),
  'available',to_jsonb(erp_home.available_charts(p_role)))
 from(select 1) one left join erp_home.chart_preference c on c.user_id=p_user
$$;
create function public.erp_home_charts_get(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin return erp_home.charts_view(p_user_id,erp_home.require_member(p_user_id)); end $$;
-- Replaces the whole list (incluir, ocultar, reordenar). CAS by version, idempotent command_id, audit.
create function public.erp_home_charts_save(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_charts jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text;v_hash text;v_command erp_home.shortcut_command;v_row erp_home.chart_preference;v_list text[];v_version integer;v_result jsonb;
begin
 v_role:=erp_home.require_member(p_user_id);
 if p_command_id is null or p_expected_version is null or p_expected_version<0 or p_expected_version>=2147483647 or p_charts is null or jsonb_typeof(p_charts)<>'array'
  or jsonb_array_length(p_charts)>5 or exists(select 1 from jsonb_array_elements(p_charts) e where jsonb_typeof(e)<>'string' or not(e#>>'{}')=any(erp_home.chart_keys())) then
  raise exception 'erp_home_charts_invalid' using errcode='22023'; end if;
 select coalesce(array_agg(e order by o),'{}'::text[]) into v_list from jsonb_array_elements_text(p_charts) with ordinality x(e,o);
 if cardinality(v_list)<>(select count(distinct e) from unnest(v_list) e) then raise exception 'erp_home_charts_invalid' using errcode='22023'; end if;
 if exists(select 1 from unnest(v_list) e where not e=any(erp_home.available_charts(v_role))) then raise exception 'erp_home_chart_forbidden' using errcode='42501'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','charts','actor',p_user_id,'version',p_expected_version,'charts',p_charts)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtext('erp_home_charts'),hashtext(p_user_id::text));
 select * into v_command from erp_home.shortcut_command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_home_command_conflict' using errcode='40001'; end if;
  return erp_home.charts_view(p_user_id,v_role)||jsonb_build_object('receipt',v_command.result,'replayed',true);
 end if;
 select * into v_row from erp_home.chart_preference where user_id=p_user_id for update;
 if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_home_charts_version_conflict' using errcode='40001'; end if;
 v_version:=p_expected_version+1;
 if v_row.user_id is null then insert into erp_home.chart_preference(user_id,charts,version) values(p_user_id,v_list,v_version);
 else update erp_home.chart_preference set charts=v_list,version=v_version,updated_at=clock_timestamp() where user_id=p_user_id; end if;
 v_result:=jsonb_build_object('command_id',p_command_id,'version',v_version,'charts',to_jsonb(v_list),'changed_at',clock_timestamp());
 insert into erp_home.shortcut_command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 insert into erp_home.shortcut_audit(actor,command_id,before_data,after_data) values(p_user_id,p_command_id,
  case when v_row.user_id is null then null else jsonb_build_object('version',v_row.version,'charts',to_jsonb(v_row.charts)) end,jsonb_build_object('version',v_version,'charts',to_jsonb(v_list)));
 return erp_home.charts_view(p_user_id,v_role)||jsonb_build_object('receipt',v_result,'replayed',false);
end $$;
-- Top 5 SKU's mais vendidos of a home period (Hoje, 7D, 30D, 3M, 6M, 12M or Customizado, as erp_home_overview): quantity of
-- the sales orders not cancelled, by order date; ties by value and name. Values as exact text (quantity 6, cents).
create function public.erp_home_top_products(p_user_id uuid,p_period text,p_from text default null,p_to text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_today date;v_from date;v_to date;v_items jsonb;
begin
 v_role:=erp_home.require_member(p_user_id);
 if not erp_home.top_products_allowed(v_role) then raise exception 'erp_home_access_denied' using errcode='42501'; end if;
 v_today:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
 if p_period is null or p_period not in('hoje','7d','30d','3m','6m','12m','customizado') or(p_period<>'customizado' and(p_from is not null or p_to is not null)) then
  raise exception 'erp_home_period_invalid' using errcode='22023'; end if;
 if p_period='hoje' then v_from:=v_today;v_to:=v_today;
 elsif p_period='7d' then v_from:=v_today-6;v_to:=v_today;
 elsif p_period='30d' then v_from:=v_today-29;v_to:=v_today;
 elsif p_period='3m' then v_from:=(date_trunc('month',v_today::timestamp)-interval '2 months')::date;v_to:=v_today;
 elsif p_period='6m' then v_from:=(date_trunc('month',v_today::timestamp)-interval '5 months')::date;v_to:=v_today;
 elsif p_period='12m' then v_from:=(date_trunc('month',v_today::timestamp)-interval '11 months')::date;v_to:=v_today;
 else
  if p_from is null or p_to is null or p_from!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_to!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_from<'1900-01-01' or p_to>'2100-12-31' then
   raise exception 'erp_home_period_invalid' using errcode='22023'; end if;
  begin v_from:=p_from::date;v_to:=p_to::date;
  exception when invalid_datetime_format or datetime_field_overflow then raise exception 'erp_home_period_invalid' using errcode='22023'; end;
  if to_char(v_from,'YYYY-MM-DD')<>p_from or to_char(v_to,'YYYY-MM-DD')<>p_to then raise exception 'erp_home_period_invalid' using errcode='22023'; end if;
 end if;
 if v_to<v_from or v_to-v_from>365 then raise exception 'erp_home_period_invalid' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('product_id',x.product_id,'code',x.code,'name',x.name,'units',round(x.units,6)::numeric(38,6)::text,'total_cents',(round(x.total,2)*100)::bigint::text)
   order by x.units desc,x.total desc,x.name,x.product_id),'[]'::jsonb) into v_items
 from(select i.product_id,left(max(r.code),60) code,left(regexp_replace(max(r.name),'[[:cntrl:]]',' ','g'),200) name,sum(i.quantity) units,sum(i.total) total
  from erp_documents.document d join erp_documents.item i on i.document_id=d.id join erp_catalog.record r on r.id=i.product_id
  where d.kind='sales_orders' and d.status<>'cancelled' and d.body->>'date'>=to_char(v_from,'YYYY-MM-DD') and d.body->>'date'<=to_char(v_to,'YYYY-MM-DD')
  group by i.product_id order by sum(i.quantity) desc,sum(i.total) desc,max(r.name),i.product_id limit 5) x;
 return jsonb_build_object('scope','home_top_products','data_mode','erp_native','key',p_period,'from',to_char(v_from,'YYYY-MM-DD'),'to',to_char(v_to,'YYYY-MM-DD'),'items',v_items);
end $$;

-- ------------------------------------------------------------------------------------------------------------------------
-- Atalhos favoritos com Nome e Link.
alter table erp_home.shortcut_preference add column labels jsonb not null default '{}'::jsonb check(jsonb_typeof(labels)='object');
-- The catalog screen a link opens: the screen itself, or the screen with more filters (new keys only, safe characters).
create function erp_home.shortcut_base(p_link text) returns text language plpgsql stable set search_path=pg_catalog as $$
declare c record;v_extra text;v_keys text[];v_base_keys text[];
begin
 if p_link is null or length(p_link)>200 then return null; end if;
 for c in select s.path from erp_home.shortcut_catalog() s order by length(s.path) desc loop
  if p_link=c.path then return c.path; end if;
  if starts_with(p_link,c.path||case when position('?' in c.path)>0 then '&' else '?' end) then
   v_extra:=substr(p_link,length(c.path)+2);
   if v_extra!~'^[a-z_]{1,30}=[A-Za-z0-9_.:,-]{1,60}(&[a-z_]{1,30}=[A-Za-z0-9_.:,-]{1,60}){0,7}$' then continue; end if;
   v_keys:=array(select split_part(p,'=',1) from unnest(string_to_array(v_extra,'&')) p);
   v_base_keys:=case when position('?' in c.path)>0 then array(select split_part(p,'=',1) from unnest(string_to_array(split_part(c.path,'?',2),'&')) p) else '{}'::text[] end;
   if cardinality(v_keys)=(select count(distinct k) from unnest(v_keys) k) and not v_keys&&v_base_keys then return c.path; end if;
  end if;
 end loop;
 return null;
end $$;
-- A permission removed after saving hides the shortcut (catalog screen or link with filters), without erasing the saved list.
create or replace function erp_home.visible_shortcuts(p_role text,p_shortcuts text[]) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(s order by o),'[]'::jsonb) from unnest(p_shortcuts) with ordinality u(s,o) where erp_home.shortcut_allowed(p_role,erp_home.shortcut_base(s))
$$;
create function erp_home.visible_labels(p_role text,p_shortcuts text[],p_labels jsonb) returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_object_agg(s,p_labels->s),'{}'::jsonb) from unnest(p_shortcuts) s
 where p_labels?s and erp_home.shortcut_allowed(p_role,erp_home.shortcut_base(s))
$$;
create or replace function public.erp_home_shortcuts_get(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_row erp_home.shortcut_preference;
begin
 v_role:=erp_home.require_member(p_user_id);
 select * into v_row from erp_home.shortcut_preference where user_id=p_user_id;
 return jsonb_build_object('scope','home_shortcuts','data_mode','erp_native','role',v_role,
  'version',coalesce(v_row.version,0),'customized',v_row.user_id is not null,
  'shortcuts',erp_home.visible_shortcuts(v_role,coalesce(v_row.shortcuts,erp_home.default_shortcuts())),
  'labels',erp_home.visible_labels(v_role,coalesce(v_row.shortcuts,erp_home.default_shortcuts()),coalesce(v_row.labels,'{}'::jsonb)),
  'available',erp_home.available_shortcuts(v_role));
end $$;
-- Substitui a lista inteira (adicionar, remover) e os nomes. CAS por versão, command_id idempotente, auditoria. Sem nomes, o
-- comando é o mesmo de 097 (mesmo hash), então "Conferir resultado" de um comando antigo continua igual.
drop function public.erp_home_shortcuts_save(uuid,uuid,integer,jsonb);
create function public.erp_home_shortcuts_save(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_shortcuts jsonb,p_labels jsonb default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text; v_hash text; v_command erp_home.shortcut_command; v_row erp_home.shortcut_preference;
 v_list text[]; v_labels jsonb:='{}'::jsonb; v_version integer; v_result jsonb; k text; v text;
begin
 v_role:=erp_home.require_member(p_user_id);
 if p_command_id is null or p_expected_version is null or p_expected_version<0 or p_expected_version>=2147483647
  or p_shortcuts is null or jsonb_typeof(p_shortcuts)<>'array' or jsonb_array_length(p_shortcuts)>20
  or exists(select 1 from jsonb_array_elements(p_shortcuts) e where jsonb_typeof(e)<>'string')
  or p_labels is not null and(jsonb_typeof(p_labels)<>'object' or(select count(*) from jsonb_object_keys(p_labels))>20) then
  raise exception 'erp_home_shortcuts_invalid' using errcode='22023';
 end if;
 select coalesce(array_agg(e order by o),'{}'::text[]) into v_list from jsonb_array_elements_text(p_shortcuts) with ordinality x(e,o);
 if cardinality(v_list)<>(select count(distinct e) from unnest(v_list) e) or exists(select 1 from unnest(v_list) e where erp_home.shortcut_base(e) is null) then
  raise exception 'erp_home_shortcuts_invalid' using errcode='22023';
 end if;
 for k,v in select key,value#>>'{}' from jsonb_each(coalesce(p_labels,'{}'::jsonb)) loop
  if not k=any(v_list) or jsonb_typeof(p_labels->k)<>'string' or length(v) not between 1 and 60 or v<>btrim(v) or v~'[[:cntrl:]]' then
   raise exception 'erp_home_shortcuts_invalid' using errcode='22023'; end if;
  v_labels:=v_labels||jsonb_build_object(k,v);
 end loop;
 if exists(select 1 from unnest(v_list) e where not erp_home.shortcut_allowed(v_role,erp_home.shortcut_base(e))) then
  raise exception 'erp_home_shortcut_forbidden' using errcode='42501';
 end if;
 v_hash:=encode(sha256(convert_to((jsonb_build_object('op','shortcuts','actor',p_user_id,'version',p_expected_version,'shortcuts',p_shortcuts)
  ||case when v_labels='{}'::jsonb then '{}'::jsonb else jsonb_build_object('labels',v_labels) end)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtext('erp_home_shortcuts'),hashtext(p_user_id::text));
 select * into v_command from erp_home.shortcut_command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_home_command_conflict' using errcode='40001'; end if;
  return v_command.result||jsonb_build_object('scope','home_shortcuts','data_mode','erp_native','role',v_role,'labels',coalesce(v_command.result->'labels','{}'::jsonb),
   'available',erp_home.available_shortcuts(v_role),'replayed',true);
 end if;
 select * into v_row from erp_home.shortcut_preference where user_id=p_user_id for update;
 if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_home_shortcuts_version_conflict' using errcode='40001'; end if;
 v_version:=p_expected_version+1;
 if v_row.user_id is null then
  insert into erp_home.shortcut_preference(user_id,shortcuts,labels,version) values(p_user_id,v_list,v_labels,v_version);
 else
  update erp_home.shortcut_preference set shortcuts=v_list,labels=v_labels,version=v_version,updated_at=clock_timestamp() where user_id=p_user_id;
 end if;
 v_result:=jsonb_build_object('version',v_version,'customized',true,'shortcuts',to_jsonb(v_list),'labels',v_labels);
 insert into erp_home.shortcut_command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 insert into erp_home.shortcut_audit(actor,command_id,before_data,after_data) values(p_user_id,p_command_id,
  case when v_row.user_id is null then null else jsonb_build_object('version',v_row.version,'shortcuts',to_jsonb(v_row.shortcuts),'labels',v_row.labels) end,
  jsonb_build_object('version',v_version,'shortcuts',to_jsonb(v_list),'labels',v_labels));
 return v_result||jsonb_build_object('scope','home_shortcuts','data_mode','erp_native','role',v_role,
  'available',erp_home.available_shortcuts(v_role),'replayed',false);
end $$;

-- ------------------------------------------------------------------------------------------------------------------------
-- Empresa › Dados do sócio(s).
create table erp_company.partners(
 singleton boolean primary key default true check(singleton),
 version integer not null check(version between 1 and 2147483647),
 data jsonb not null check(jsonb_typeof(data)='array'),
 updated_at timestamptz not null,updated_by uuid not null references auth.users(id),command_id uuid not null
);
alter table erp_company.partners enable row level security;
revoke all on erp_company.partners from public,anon,authenticated,service_role;
create function erp_company.cpf_valid(p text) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare n integer;s integer;d integer;i integer;
begin
 if p is null or p!~'^[0-9]{11}$' or p~'^([0-9])\1{10}$' then return false; end if;
 foreach n in array array[9,10] loop
  s:=0;for i in 1..n loop s:=s+substr(p,i,1)::integer*(n+2-i); end loop;
  d:=(s*10)%11;if d=10 then d:=0; end if;
  if d<>substr(p,n+1,1)::integer then return false; end if;
 end loop;
 return true;
end $$;
-- Same rules as normalizeCompanyPartners (packages/erp-domain/src/system-profile.mjs); at most 20 partners, participations up to
-- 100,00% in total, each CPF once.
create function erp_company.partners_normalize(p jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare e jsonb;v_out jsonb:='[]'::jsonb;v_cpfs text[]:='{}';v_cpf text;v_total numeric:=0;v_share text;
begin
 if p is null or jsonb_typeof(p)<>'array' or jsonb_array_length(p)>20 or octet_length(p::text)>16384 then raise exception 'erp_company_partners_invalid' using errcode='22023'; end if;
 for e in select x from jsonb_array_elements(p) x loop
  if jsonb_typeof(e)<>'object' or(select array_agg(k order by k) from jsonb_object_keys(e) k)<>array['cpf','email','name','phone','role','share'] then
   raise exception 'erp_company_partners_invalid' using errcode='22023'; end if;
  v_cpf:=translate(coalesce(e->>'cpf',''),'.-','');
  if jsonb_typeof(e->'cpf')<>'string' or not erp_company.cpf_valid(v_cpf) or v_cpf=any(v_cpfs) then raise exception 'erp_company_partners_invalid' using errcode='22023'; end if;
  v_share:=erp_company.extra_text(e->'share',6,'^(0|[1-9][0-9]?|100)(\.[0-9]{1,2})?$');
  if v_share is not null and v_share::numeric>100 then raise exception 'erp_company_partners_invalid' using errcode='22023'; end if;
  v_total:=v_total+coalesce(v_share::numeric,0);v_cpfs:=v_cpfs||v_cpf;
  v_out:=v_out||jsonb_build_array(jsonb_build_object('name',erp_company.extra_text(e->'name',120),'cpf',v_cpf,
   'share',case when v_share is null then null else round(v_share::numeric,2)::numeric(5,2)::text end,'role',erp_company.extra_text(e->'role',60),
   'email',lower(erp_company.extra_text(e->'email',254,'^[^@ ]+@[^@ ]+\.[^@ ]+$')),'phone',erp_company.extra_text(e->'phone',20,'^\+?[0-9() -]{8,20}$')));
  if v_out->-1->>'name' is null then raise exception 'erp_company_partners_invalid' using errcode='22023'; end if;
 end loop;
 if v_total>100 then raise exception 'erp_company_partners_invalid' using errcode='22023'; end if;
 return v_out;
end $$;
create function erp_company.partners_dto() returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('version',version,'partners',data,'updated_at',updated_at) from erp_company.partners where singleton
$$;
-- Partner data (CPF included) is personal: only the administrador reads and changes it.
create function public.erp_company_partners_get(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_company.require_access(p_user_id,'identity');
 return jsonb_build_object('scope','company_partners','data_mode','erp_native','record',erp_company.partners_dto());
end $$;
create function public.erp_company_partners_save(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_partners jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_command erp_company.command%rowtype;v_row erp_company.partners%rowtype;v_data jsonb;v_before jsonb;v_result jsonb;v_at timestamptz;
begin
 perform erp_company.require_access(p_user_id,'identity');
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 then raise exception 'erp_company_command_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','partners','actor',p_user_id,'version',p_expected_version,'partners',p_partners)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852920,1);
 select * into v_command from erp_company.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_company_command_conflict' using errcode='40001'; end if;
  return v_command.result||jsonb_build_object('record',erp_company.partners_dto(),'replayed',true);
 end if;
 v_data:=erp_company.partners_normalize(p_partners);
 select * into v_row from erp_company.partners where singleton for update;
 if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_company_version_conflict' using errcode='40001'; end if;
 if v_row.data=v_data or v_row.version is null and v_data='[]'::jsonb then raise exception 'erp_company_partners_unchanged' using errcode='22023'; end if;
 v_before:=erp_company.partners_dto();v_at:=clock_timestamp();
 if v_row.version is null then insert into erp_company.partners(singleton,version,data,updated_at,updated_by,command_id) values(true,1,v_data,v_at,p_user_id,p_command_id);
 else update erp_company.partners set data=v_data,version=version+1,updated_at=v_at,updated_by=p_user_id,command_id=p_command_id where singleton and version=p_expected_version; end if;
 v_result:=jsonb_build_object('scope','company_partners_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'from_version',p_expected_version,'to_version',p_expected_version+1,'changed_at',v_at));
 insert into erp_company.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,'save_partners',v_before,erp_company.partners_dto());
 insert into erp_company.command values(p_command_id,p_user_id,v_hash,v_result,v_at);
 return v_result||jsonb_build_object('record',erp_company.partners_dto(),'replayed',false);
end $$;

-- ------------------------------------------------------------------------------------------------------------------------
-- Dados da empresa: Nome, Nome Fantasia e CNPJ são bloqueados como no Origin; corrigi-los exige motivo (3 a 1000 caracteres),
-- guardado na auditoria ("motivo") e mostrado no Registro de atividades. Sem correção desses campos o comando é o de 016.
drop function public.erp_company_save_identity(uuid,integer,uuid,jsonb);
create function public.erp_company_save_identity(p_user_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_command erp_company.command%rowtype;v_row erp_company.identity%rowtype;v_data jsonb;v_before jsonb;v_result jsonb;v_fiscal jsonb;v_reason text;v_locked boolean;
begin
 perform erp_company.require_access(p_user_id,'identity');
 if p_expected_version is null or p_expected_version<0 or p_command_id is null then raise exception 'erp_company_command_invalid'using errcode='22023';end if;
 if p_reason is not null and(length(btrim(p_reason)) not between 3 and 1000 or p_reason~'[[:cntrl:]]') then raise exception 'erp_company_reason_invalid' using errcode='22023'; end if;
 v_reason:=nullif(btrim(p_reason),'');
 v_data:=erp_company.normalize(p_data);
 v_hash:=encode(sha256(convert_to((jsonb_build_object('op','identity','actor',p_user_id,'version',p_expected_version,'data',p_data)
  ||case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason',v_reason) end)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852920,1);
 select * into v_command from erp_company.command where command_id=p_command_id;
 if found then if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_company_command_conflict'using errcode='40001';end if;return v_command.result||'{"replayed":true}'::jsonb;end if;
 select * into v_row from erp_company.identity where singleton for update;
 if coalesce(v_row.version,0)<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_company_version_conflict'using errcode='40001';end if;
 v_locked:=v_row.version is not null and(v_row.data->>'legal_name' is distinct from v_data->>'legal_name' or v_row.data->>'trade_name' is distinct from v_data->>'trade_name'
  or v_row.data->>'cnpj' is distinct from v_data->>'cnpj');
 if v_locked and v_reason is null then raise exception 'erp_company_reason_required' using errcode='22023'; end if;
 if not v_locked then v_reason:=null; end if;
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
 if v_before is distinct from v_result->'record'then insert into erp_company.audit(actor,command_id,action,before_data,after_data)
  values(p_user_id,p_command_id,'save_identity',v_before,(v_result->'record')||case when v_reason is null then '{}'::jsonb else jsonb_build_object('motivo',v_reason) end);end if;
 insert into erp_company.command values(p_command_id,p_user_id,v_hash,v_result,clock_timestamp());return v_result;
end $$;

revoke all on all functions in schema erp_home from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_company from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_home_charts_get','erp_home_charts_save','erp_home_top_products','erp_home_shortcuts_get','erp_home_shortcuts_save','erp_company_partners_get','erp_company_partners_save','erp_company_save_identity')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
