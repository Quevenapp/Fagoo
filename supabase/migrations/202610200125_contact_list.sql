-- Listagem de Clientes e fornecedores no padrão do Origin (lane contatos, onda B): situação com Últimos incluídos, Todos,
-- Ativos, Excluídos, Inativos e Sem movimento; seletor de tipo de contato com todos os tipos; filtro Vendedor; períodos
-- Prox. Visita e Sem compras no período (com as situações de venda consideradas); colunas da listagem customizada;
-- exportação/impressão até 10.000 contatos; Aniversariantes; Comentários; "Últimos registros deste cliente"; e a
-- importação de planilha de contatos (validar e importar em lotes). Respeita "Contato acessível somente ao vendedor
-- vinculado" (erp_catalog.contact_scope, migração 124). erp_catalog_page (depósitos) não muda.
begin;

-- Situações nativas do pedido de venda (erp_documents, migração 008), na ordem do Origin.
create function erp_catalog.sale_statuses_valid(p_statuses text[]) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select p_statuses is null or(cardinality(p_statuses) between 1 and 7 and array_position(p_statuses,null) is null
  and p_statuses<@array['draft','open','verified','in_progress','partially_fulfilled','fulfilled','cancelled']::text[]
  and(select count(distinct s) from unnest(p_statuses) s)=cardinality(p_statuses))
$$;

-- Lean listing item: the columns of the default and of the custom listing (Origin CL-11 and CL-12).
create function erp_catalog.contact_list_item(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',r.id,'entity','contacts','active',r.active,'version',r.version,'name',r.name,'code',r.code,
   'created_at',r.created_at,'updated_at',r.updated_at,
   'situation',erp_catalog.contact_situation(r.active,coalesce(cp.situation,erp_catalog.contact_source_situation(r.id))),
   'source',(select jsonb_build_object('system','origin','source_id',o.source_id,'state',o.state) from erp_catalog.origin o where o.record_id=r.id),
   'trade_name',c.trade_name,'person_type',c.person_type,'document',c.document,'email',c.email,'phone',c.phone,'mobile',c.mobile,
   'city',c.city,'state',c.state,'roles',to_jsonb(c.roles),'types',to_jsonb(erp_catalog.contact_type_slugs(r.id)),'crt',cp.crt,
   'seller_id',cp.seller_id,'seller_name',(select sr.name from erp_catalog.seller s join erp_catalog.record sr on sr.id=s.contact_id where s.id=cp.seller_id),
   'next_visit',to_char(cp.next_visit,'YYYY-MM-DD'),'is_seller',exists(select 1 from erp_catalog.seller s where s.contact_id=r.id))
 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id left join erp_catalog.contact_profile cp on cp.record_id=r.id
 where r.id=p_id
$$;

-- Shared validation and the fixed WHERE fragment of the page, the export and Aniversariantes. Every user value is a
-- parameter ($n); only fixed fragments are concatenated.
create function erp_catalog.contact_filter_valid(p_situation text,p_type text,p_person_type text,p_state text,p_city text,p_phone text,p_email text,
 p_period text,p_from date,p_to date,p_sale_statuses text[]) returns boolean
language sql stable set search_path=pg_catalog as $$
 select coalesce(p_situation in('latest','all','A','I','S','E')
  and(p_type is null or p_type='none' or exists(select 1 from erp_catalog.contact_type t where t.slug=p_type and t.active))
  and(p_person_type is null or p_person_type in('F','J','E'))
  and(p_state is null or p_state~'^[A-Z]{2}$')
  and(p_city is null or(length(p_city)<=100 and p_city!~'[[:cntrl:]]'))
  and(p_phone is null or(length(p_phone)<=40 and p_phone!~'[[:cntrl:]]' and p_phone~'[0-9]'))
  and(p_email is null or(length(p_email)<=254 and p_email!~'[[:cntrl:]]'))
  and((p_period is null and p_from is null and p_to is null) or(p_period in('created','updated','next_visit','no_purchases') and num_nonnulls(p_from,p_to)>0))
  and(p_from is null or(isfinite(p_from) and p_from between date '1900-01-01' and date '2100-12-31'))
  and(p_to is null or(isfinite(p_to) and p_to between date '1900-01-01' and date '2100-12-31'))
  and(p_from is null or p_to is null or p_from<=p_to)
  and((p_sale_statuses is null) or p_period='no_purchases') and erp_catalog.sale_statuses_valid(p_sale_statuses),false)
$$;
create function erp_catalog.contact_where(p_period text) returns text
language sql immutable set search_path=pg_catalog as $$
 select $q$ from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id left join erp_catalog.contact_profile cp on cp.record_id=r.id
  where r.entity='contacts'
   and($1::text='all' or case $1::text when 'latest' then erp_catalog.contact_situation(r.active,coalesce(cp.situation,erp_catalog.contact_source_situation(r.id)))<>'E'
    else erp_catalog.contact_situation(r.active,coalesce(cp.situation,erp_catalog.contact_source_situation(r.id)))=$1::text end)
   and($2::text[] is null or erp_catalog.matches($2,erp_catalog.fold(concat_ws(' ',r.name,r.code,c.trade_name,c.email,c.document,c.phone,c.mobile)),
    regexp_replace(lower(coalesce(c.document,'')),'[^0-9a-z]','','g'),regexp_replace(concat_ws('|',c.document,c.phone,c.mobile,cp.fax),'[^0-9|]','','g')))
   and($3::text is null or case $3::text when 'none' then cardinality(c.roles)=0 and not exists(select 1 from erp_catalog.contact_type_link l join erp_catalog.contact_type t on t.id=l.type_id where l.contact_id=r.id and t.active)
    when 'customer' then 'customer'=any(c.roles) when 'supplier' then 'supplier'=any(c.roles) when 'carrier' then 'carrier'=any(c.roles)
    else exists(select 1 from erp_catalog.contact_type_link l join erp_catalog.contact_type t on t.id=l.type_id where l.contact_id=r.id and t.slug=$3::text) end)
   and($4::text is null or c.person_type=$4::text)
   and($5::text is null or upper(btrim(c.state))=$5::text)
   and($6::text is null or strpos(erp_catalog.fold(coalesce(c.city,'')),erp_catalog.fold($6::text))>0)
   and($7::text is null or strpos(regexp_replace(concat_ws('|',c.phone,c.mobile,cp.fax),'[^0-9|]','','g'),$7::text)>0)
   and($8::text is null or strpos(erp_catalog.fold(coalesce(c.email,'')),erp_catalog.fold($8::text))>0)
   and($9::uuid is null or cp.seller_id=$9::uuid)
   and($10::uuid is null or cp.seller_id=$10::uuid)$q$||case p_period
  when 'created' then ' and($11::timestamptz is null or r.created_at>=$11::timestamptz) and($12::timestamptz is null or r.created_at<$12::timestamptz)'
  when 'updated' then ' and($11::timestamptz is null or r.updated_at>=$11::timestamptz) and($12::timestamptz is null or r.updated_at<$12::timestamptz)'
  when 'next_visit' then ' and cp.next_visit is not null and($13::date is null or cp.next_visit>=$13::date) and($14::date is null or cp.next_visit<=$14::date)'
  -- Sem compras no período: no native sales order of the contact dated in the period (body.date, São Paulo business date).
  when 'no_purchases' then ' and not exists(select 1 from erp_documents.document d where d.kind=''sales_orders'' and d.contact_id=r.id
   and($13::date is null or d.body->>''date''>=to_char($13::date,''YYYY-MM-DD'')) and($14::date is null or d.body->>''date''<=to_char($14::date,''YYYY-MM-DD''))
   and($15::text[] is null or d.status=any($15::text[])))'
  else '' end
$$;

create function public.erp_catalog_contact_page(p_user_id uuid,p_page integer default 1,p_size integer default 100,p_sort text default 'created_desc',
 p_query text default null,p_situation text default 'latest',p_type text default null,p_person_type text default null,p_state text default null,
 p_city text default null,p_phone text default null,p_email text default null,p_seller_id uuid default null,p_period text default null,
 p_from date default null,p_to date default null,p_sale_statuses text[] default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_terms text[]; v_total bigint; v_ids uuid[]; v_items jsonb; v_scope uuid; v_sql text;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if not erp_catalog.page_valid(p_page,p_size,p_sort,p_query,null,null,null)
  or not erp_catalog.contact_filter_valid(p_situation,p_type,p_person_type,p_state,p_city,p_phone,p_email,p_period,p_from,p_to,p_sale_statuses) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_scope:=erp_catalog.contact_scope(p_user_id); v_terms:=erp_catalog.search_terms(p_query);
 v_sql:=erp_catalog.page_sql(erp_catalog.contact_where(p_period),p_sort,v_terms is not null,16);
 execute v_sql into v_total,v_ids using p_situation,v_terms,p_type,p_person_type,p_state,nullif(btrim(p_city),''),nullif(erp_catalog.digits(p_phone),''),
  nullif(btrim(p_email),''),p_seller_id,v_scope,
  case when p_from is not null then p_from::timestamp at time zone 'America/Sao_Paulo' end,case when p_to is not null then (p_to+1)::timestamp at time zone 'America/Sao_Paulo' end,
  p_from,p_to,p_sale_statuses,(p_page-1)*p_size,p_size;
 select coalesce(jsonb_agg(erp_catalog.contact_list_item(u.id) order by u.n),'[]'::jsonb) into v_items from unnest(v_ids) with ordinality u(id,n);
 return jsonb_build_object('entity','contacts','items',v_items,'page',p_page,'size',p_size,'total',v_total,'sort',p_sort,'situation',p_situation,
  'scoped',v_scope is not null,'data_mode','erp_native');
end $$;

-- Exportar para a planilha, Imprimir listagem e Aniversariantes: os filtros da listagem, sem a página da tela, em blocos
-- de até 100 contatos completos e no máximo 10.000 no total (o limite do Origin). O primeiro bloco fica na auditoria.
create function public.erp_catalog_contact_export(p_user_id uuid,p_kind text default 'contacts',p_offset integer default 0,p_limit integer default 100,
 p_sort text default 'created_desc',p_query text default null,p_situation text default 'latest',p_type text default null,p_person_type text default null,
 p_state text default null,p_city text default null,p_phone text default null,p_email text default null,p_seller_id uuid default null,p_period text default null,
 p_from date default null,p_to date default null,p_sale_statuses text[] default null,p_birth_from date default null,p_birth_to date default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_terms text[]; v_total bigint; v_ids uuid[]; v_items jsonb; v_scope uuid; v_where text; v_order text; v_days text;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_kind is null or p_kind not in('contacts','birthdays') or p_offset is null or p_offset not between 0 and 9999 or p_limit is null or p_limit not between 1 and 100
  or not erp_catalog.page_valid(1,1,p_sort,p_query,null,null,null)
  or not erp_catalog.contact_filter_valid(p_situation,p_type,p_person_type,p_state,p_city,p_phone,p_email,p_period,p_from,p_to,p_sale_statuses)
  or(p_kind='contacts' and num_nonnulls(p_birth_from,p_birth_to)>0)
  or(p_kind='birthdays' and(p_birth_from is null or p_birth_to is null or p_birth_from>p_birth_to or p_birth_to-p_birth_from>366
   or p_birth_from<date '1900-01-01' or p_birth_to>date '2100-12-31')) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_scope:=erp_catalog.contact_scope(p_user_id); v_terms:=erp_catalog.search_terms(p_query);
 v_where:=erp_catalog.contact_where(p_period);
 if p_kind='birthdays' then
  -- Month/day of the birth date inside the period (any year), like Origin's Aniversariantes; dates kept as MMDD text.
  v_where:=v_where||' and cp.birth_date is not null and(case when $16::text<=$17::text then to_char(cp.birth_date,''MMDD'') between $16::text and $17::text
   else to_char(cp.birth_date,''MMDD'')>=$16::text or to_char(cp.birth_date,''MMDD'')<=$17::text end)';
  v_order:='to_char(cp.birth_date,''MMDD''),erp_catalog.fold(r.name),r.id';
 else v_order:=erp_catalog.page_order(p_sort); end if;
 execute 'select (select count(*)'||v_where||'),array(select r.id'||v_where||' order by '||v_order||' offset $18 limit $19)' into v_total,v_ids
  using p_situation,v_terms,p_type,p_person_type,p_state,nullif(btrim(p_city),''),nullif(erp_catalog.digits(p_phone),''),nullif(btrim(p_email),''),p_seller_id,v_scope,
   case when p_from is not null then p_from::timestamp at time zone 'America/Sao_Paulo' end,case when p_to is not null then (p_to+1)::timestamp at time zone 'America/Sao_Paulo' end,
   p_from,p_to,p_sale_statuses,
   case when p_kind='birthdays' then to_char(p_birth_from,'MMDD') end,case when p_kind='birthdays' then to_char(p_birth_to,'MMDD') end,p_offset,p_limit;
 if p_kind='birthdays' and p_birth_to-p_birth_from>=365 then
  -- A whole year (or more) covers every day: the MMDD window above would wrap, so take all birth dates.
  execute 'select (select count(*)'||erp_catalog.contact_where(p_period)||' and cp.birth_date is not null),array(select r.id'||erp_catalog.contact_where(p_period)
   ||' and cp.birth_date is not null order by '||v_order||' offset $16 limit $17)' into v_total,v_ids
   using p_situation,v_terms,p_type,p_person_type,p_state,nullif(btrim(p_city),''),nullif(erp_catalog.digits(p_phone),''),nullif(btrim(p_email),''),p_seller_id,v_scope,
    case when p_from is not null then p_from::timestamp at time zone 'America/Sao_Paulo' end,case when p_to is not null then (p_to+1)::timestamp at time zone 'America/Sao_Paulo' end,
    p_from,p_to,p_sale_statuses,p_offset,p_limit;
 end if;
 if v_total>10000 then raise exception 'erp_catalog_export_too_large' using errcode='22023'; end if;
 select coalesce(jsonb_agg(erp_catalog.contact_dto(u.id)-'persons'-'source' order by u.n),'[]'::jsonb) into v_items from unnest(v_ids) with ordinality u(id,n);
 if p_offset=0 then
  insert into erp_catalog.auxiliary_audit(actor,subject,action,after_data)
   values(p_user_id,'contacts_export',p_kind,jsonb_build_object('total',v_total,'situation',p_situation,'type',p_type,'period',p_period,'query_present',p_query is not null));
 end if;
 return jsonb_build_object('scope','contacts_export','kind',p_kind,'items',v_items,'offset',p_offset,'limit',p_limit,'total',v_total,'data_mode','erp_native');
end $$;

-- ---- Comentários (menu ⋮ > Comentários > Adicionar Comentário) ----
create table erp_catalog.contact_comment(
 id uuid primary key default gen_random_uuid(),
 contact_id uuid not null references erp_catalog.contact(record_id),
 author uuid not null references auth.users(id),
 body text not null check(length(body) between 1 and 2000 and body=btrim(body) and translate(body,E'\n\r\t','')!~'[[:cntrl:]]'),
 command_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp()
);
create index erp_catalog_contact_comment_contact on erp_catalog.contact_comment(contact_id,created_at desc,id);
alter table erp_catalog.contact_comment enable row level security;
revoke all on erp_catalog.contact_comment from public,anon,authenticated,service_role;
create function erp_catalog.comment_dto(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',c.id,'body',c.body,'author_name',erp_activity.actor_label(c.author),'created_at',c.created_at) from erp_catalog.contact_comment c where c.id=p_id
$$;
create function public.erp_catalog_contact_comments(p_user_id uuid,p_contact_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text:=erp_catalog.require_access(p_user_id,'contacts',false);
begin
 if p_contact_id is null or not exists(select 1 from erp_catalog.record where id=p_contact_id and entity='contacts') then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);
 return jsonb_build_object('scope','contact_comments','data_mode','erp_native','contact_id',p_contact_id,'can_comment',erp_catalog.allowed(v_role,'contacts',true),
  'items',(select coalesce(jsonb_agg(erp_catalog.comment_dto(x.id) order by x.created_at desc,x.id),'[]'::jsonb)
   from(select id,created_at from erp_catalog.contact_comment where contact_id=p_contact_id order by created_at desc,id limit 200) x));
end $$;
create function public.erp_catalog_contact_comment_add(p_user_id uuid,p_command_id uuid,p_contact_id uuid,p_body text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_body text:=btrim(p_body); v_id uuid; v_result jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_command_id is null or p_contact_id is null or v_body is null or length(v_body) not between 1 and 2000 or translate(v_body,E'\n\r\t','')~'[[:cntrl:]]' then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-contact-comment-v1','actor',p_user_id,'contact',p_contact_id,'body',v_body)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 if not exists(select 1 from erp_catalog.record where id=p_contact_id and entity='contacts') then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);
 if (select count(*) from erp_catalog.contact_comment where contact_id=p_contact_id)>=1000 then raise exception 'erp_catalog_comment_limit' using errcode='22023'; end if;
 insert into erp_catalog.contact_comment(contact_id,author,body,command_id) values(p_contact_id,p_user_id,v_body,p_command_id) returning id into v_id;
 v_result:=jsonb_build_object('scope','contact_comment','data_mode','erp_native','replayed',false,'contact_id',p_contact_id,'item',erp_catalog.comment_dto(v_id));
 insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,after_data) values(p_user_id,p_command_id,'contact_comment',v_id,'create',jsonb_build_object('contact_id',p_contact_id));
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- ---- "Visualizar histórico do cliente": últimos pedidos de venda nativos do contato, para quem lê pedidos de venda ----
create function public.erp_catalog_contact_sales(p_user_id uuid,p_contact_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_visible boolean:=true;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_contact_id is null or not exists(select 1 from erp_catalog.record where id=p_contact_id and entity='contacts') then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);
 begin perform erp_documents.require_access(p_user_id,'sales_orders',false);
 exception when insufficient_privilege then v_visible:=false; end;
 return jsonb_build_object('scope','contact_sales','data_mode','erp_native','contact_id',p_contact_id,'visible',v_visible,
  'items',case when v_visible then(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'number',d.number::text,'date',d.body->>'date','status',d.status,'total',d.total::text)
    order by d.body->>'date' desc,d.number desc),'[]'::jsonb)
   from(select * from erp_documents.document where kind='sales_orders' and contact_id=p_contact_id order by body->>'date' desc,number desc limit 10) d) else '[]'::jsonb end);
end $$;

-- ---- Importar contatos (planilha): validar e importar em lotes de até 50 linhas por comando ----
-- Cada linha usa as mesmas regras da gravação do formulário (campos, preferências e CPF/CNPJ). A validação não grava;
-- a importação grava o lote inteiro ou nada, com um command_id por lote e auditoria por contato.
create function public.erp_catalog_contact_import(p_user_id uuid,p_command_id uuid,p_rows jsonb,p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row jsonb; v_full jsonb; v_results jsonb:='[]'::jsonb; v_id uuid; v_message text; v_field text;
 v_seen text[]:='{}'; v_doc text; v_allow boolean:=coalesce(erp_preferences.get('contatos.permite_documento_duplicado'),'true'::jsonb)='true'::jsonb; v_result jsonb; v_invalid integer:=0;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_dry_run is null or(not p_dry_run and p_command_id is null) or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50
  or octet_length(p_rows::text)>262144
  or exists(select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x)<>'object' or(select count(*) from jsonb_object_keys(x))<>2
   or jsonb_typeof(x->'row')<>'number' or(x->>'row')!~'^[1-9][0-9]{0,4}$' or jsonb_typeof(x->'data')<>'object')
  or(select count(distinct x->>'row') from jsonb_array_elements(p_rows) x)<>jsonb_array_length(p_rows) then
  raise exception 'erp_catalog_invalid_import' using errcode='22023'; end if;
 if not p_dry_run then
  v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-contact-import-v1','actor',p_user_id,'rows',p_rows)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
  select * into v_command from erp_catalog.command where command_id=p_command_id;
  if found then
   if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
   return v_command.result||'{"replayed":true}'::jsonb;
  end if;
 end if;
 for v_row in select x from jsonb_array_elements(p_rows) x order by (x->>'row')::integer loop
  v_message:=null; v_field:=null; v_id:=null;
  begin
   if v_row->'data'?'situation' and v_row#>>'{data,situation}'='E' then raise exception 'erp_catalog_contact_invalid:situation' using errcode='22023'; end if;
   v_full:=erp_catalog.contact_merge(p_user_id,null,v_row->'data','{}'::jsonb);
   if not p_dry_run and nullif(v_full->>'code','') is null and erp_preferences.get('contatos.codigo')='"sequencial"'::jsonb then
    v_full:=jsonb_set(v_full,'{code}',to_jsonb(erp_catalog.contact_take_code(p_user_id)));
   end if;
   perform erp_catalog.contact_check_full(null,v_full,'{}'::jsonb);
   if exists(select 1 from jsonb_array_elements(erp_catalog.contact_warnings(null,v_full,'{}'::jsonb)) w where (w->>'blocked')::boolean) then
    raise exception 'erp_catalog_duplicate_document' using errcode='23505'; end if;
   v_doc:=nullif(erp_catalog.compact(v_full->>'document'),'');
   if not v_allow and v_doc is not null and length(v_doc)>=5 and v_doc=any(v_seen) then raise exception 'erp_catalog_duplicate_document' using errcode='23505'; end if;
   if v_doc is not null then v_seen:=v_seen||v_doc; end if;
   if not p_dry_run then
    insert into erp_catalog.record(entity,name,code,active,created_by,updated_by,human_edited)
     values('contacts',v_full->>'name',v_full->>'code',v_full->>'situation' in('A','S'),p_user_id,p_user_id,true) returning id into v_id;
    perform erp_catalog.contact_write(v_id,v_full);
    insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
     values(p_user_id,p_command_id,'contacts',v_id,'import_create',null,erp_catalog.contact_dto(v_id));
   end if;
  exception when sqlstate '22023' or sqlstate '23505' or sqlstate '42501' then
   get stacked diagnostics v_message=message_text;
   v_field:=case when v_message like 'erp_catalog_contact_invalid:%' then substr(v_message,29) when v_message like 'erp_catalog_contact_required:%' then substr(v_message,30)
    when v_message='erp_catalog_duplicate_document' then 'document' when v_message='erp_catalog_name_required' then 'name' end;
   v_invalid:=v_invalid+1;
  end;
  v_results:=v_results||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('row',(v_row->>'row')::integer,
   'status',case when v_message is null then case when p_dry_run then 'valid' else 'created' end else 'invalid' end,
   'code',case when v_message like 'erp_catalog_contact_required:%' then 'required' when v_message='erp_catalog_duplicate_document' then 'duplicate_document'
    when v_message='erp_catalog_contact_not_visible' then 'not_visible' when v_message is not null then 'invalid' end,
   'field',v_field,'record_id',v_id)));
 end loop;
 -- Importing is all or nothing per batch: one invalid row refuses the batch (validate first, then import the valid rows).
 if not p_dry_run and v_invalid>0 then raise exception 'erp_catalog_import_invalid_rows' using errcode='22023'; end if;
 v_result:=jsonb_build_object('scope','contact_import','data_mode','erp_native','dry_run',p_dry_run,'replayed',false,'items',v_results);
 if not p_dry_run then
  insert into erp_catalog.auxiliary_audit(actor,command_id,subject,action,after_data)
   values(p_user_id,p_command_id,'contact_import','apply',jsonb_build_object('rows',jsonb_array_length(p_rows)));
  insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 end if;
 return v_result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_contact_page(uuid,integer,integer,text,text,text,text,text,text,text,text,text,uuid,text,date,date,text[])',
  'erp_catalog_contact_export(uuid,text,integer,integer,text,text,text,text,text,text,text,text,text,uuid,text,date,date,text[],date,date)',
  'erp_catalog_contact_comments(uuid,uuid)','erp_catalog_contact_comment_add(uuid,uuid,uuid,text)','erp_catalog_contact_sales(uuid,uuid)',
  'erp_catalog_contact_import(uuid,uuid,jsonb,boolean)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
