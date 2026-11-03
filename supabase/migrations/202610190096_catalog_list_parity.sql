-- Listagens de cadastros no padrão do Origin: página numerada com total, ordem "Últimos incluídos",
-- busca tolerante (sem acento, várias palavras, CPF/CNPJ e telefone com ou sem máscara), filtros,
-- estoque por produto pela mesma regra das posições (025) e avisos de duplicidade/documento com
-- confirmação explícita. Não altera dados, não remove contratos e não cria permissões novas.
-- Depende de 006/009/023/025/057. Sem extensões (unaccent/pg_trgm não são usadas no projeto).
begin;

-- Normalização da busca: minúsculas sem acentos, documento/telefone só com dígitos ou alfanuméricos.
create function erp_catalog.fold(p_value text) returns text
language sql immutable parallel safe set search_path=pg_catalog as $$
 select lower(translate(p_value,
  'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÇçÑñÝŸýÿ',
  'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuCcNnYYyy'))
$$;
create function erp_catalog.compact(p_value text) returns text
language sql immutable parallel safe set search_path=pg_catalog as $$
 select regexp_replace(erp_catalog.fold(coalesce(p_value,'')),'[^0-9a-z]','','g')
$$;
create function erp_catalog.digits(p_value text) returns text
language sql immutable parallel safe set search_path=pg_catalog as $$
 select regexp_replace(coalesce(p_value,''),'[^0-9]','','g')
$$;
create function erp_catalog.search_terms(p_query text) returns text[]
language sql immutable parallel safe set search_path=pg_catalog as $$
 select case when nullif(btrim(p_query),'') is null then null else
  array(select s.term from regexp_split_to_table(erp_catalog.fold(btrim(p_query)),'\s+') with ordinality s(term,n) where s.term<>'' order by s.n) end
$$;
-- Cada palavra precisa aparecer no texto. Palavras com dígitos também comparam o documento sem
-- pontuação e, quando só têm dígitos e máscara, os dígitos do documento e dos telefones.
create function erp_catalog.matches(p_terms text[],p_text text,p_compact text,p_digits text) returns boolean
language sql immutable parallel safe set search_path=pg_catalog as $$
 select not exists(select 1 from unnest(p_terms) t where not(
  strpos(coalesce(p_text,''),t)>0
  or(t~'[0-9]' and(
   (regexp_replace(t,'[^0-9a-z]','','g')<>'' and strpos(coalesce(p_compact,''),regexp_replace(t,'[^0-9a-z]','','g'))>0)
   or(t!~'[a-z]' and regexp_replace(t,'[^0-9]','','g')<>'' and strpos(coalesce(p_digits,''),regexp_replace(t,'[^0-9]','','g'))>0)))))
$$;

-- Dígitos verificadores. CNPJ aceita a base alfanumérica (ASCII-48), como erp_company.cnpj e packages/fiscal-core.
create function erp_catalog.valid_cpf(p_value text) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare v_sum integer; v_digit integer; n integer; i integer;
begin
 if p_value is null or p_value!~'^[0-9]{11}$' or p_value~'^([0-9])\1{10}$' then return false; end if;
 for n in 9..10 loop
  v_sum:=0;
  for i in 1..n loop v_sum:=v_sum+substr(p_value,i,1)::integer*(n+2-i); end loop;
  v_digit:=(v_sum*10)%11; if v_digit=10 then v_digit:=0; end if;
  if v_digit<>substr(p_value,n+1,1)::integer then return false; end if;
 end loop;
 return true;
end $$;
create function erp_catalog.valid_cnpj(p_value text) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare v_base text; v_sum integer; v_weight integer; v_rest integer; i integer; j integer;
begin
 if p_value is null or p_value!~'^[A-Z0-9]{12}[0-9]{2}$' or p_value~'^([0-9])\1{13}$' then return false; end if;
 v_base:=left(p_value,12);
 for j in 1..2 loop
  v_sum:=0; v_weight:=2;
  for i in reverse length(v_base)..1 loop
   v_sum:=v_sum+(ascii(substr(v_base,i,1))-48)*v_weight; v_weight:=case when v_weight=9 then 2 else v_weight+1 end;
  end loop;
  v_rest:=v_sum%11; v_base:=v_base||(case when v_rest<2 then 0 else 11-v_rest end)::text;
 end loop;
 return v_base=p_value;
end $$;
-- null: sem aviso; 'cpf'/'cnpj': dígitos não conferem; 'document': sem tipo e sem formato de CPF/CNPJ.
create function erp_catalog.document_issue(p_person_type text,p_document text) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare v text:=upper(regexp_replace(btrim(coalesce(p_document,'')),'[ ./-]','','g'));
begin
 if v='' or p_person_type='E' then return null; end if;
 if p_person_type='F' or(p_person_type is null and v~'^[0-9]{11}$') then return case when erp_catalog.valid_cpf(v) then null else 'cpf' end; end if;
 if p_person_type='J' or(p_person_type is null and length(v)=14) then return case when erp_catalog.valid_cnpj(v) then null else 'cnpj' end; end if;
 return 'document';
end $$;

-- Ordenações e duplicidades. A busca por trecho continua sequencial no volume do cadastro (sem trigramas).
create index erp_catalog_record_entity_created on erp_catalog.record(entity,created_at desc,id desc);
create index erp_catalog_record_entity_updated on erp_catalog.record(entity,updated_at);
create index erp_catalog_record_entity_name_fold on erp_catalog.record(entity,erp_catalog.fold(name),id);
create index erp_catalog_record_entity_code_fold on erp_catalog.record(entity,erp_catalog.fold(code),id);
create index erp_catalog_product_gtin on erp_catalog.product(gtin) where gtin is not null and gtin<>'SEM GTIN';
create index erp_catalog_contact_document_key on erp_catalog.contact(erp_catalog.compact(document)) where document is not null;

-- Item enxuto da listagem; o formulário continua lendo o registro completo por erp_catalog_get.
create function erp_catalog.list_item(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',r.id,'entity',r.entity,'active',r.active,'version',r.version,'name',r.name,'code',r.code,
   'created_at',r.created_at,'updated_at',r.updated_at,
   'source',(select jsonb_build_object('system','origin','source_id',o.source_id,'state',o.state) from erp_catalog.origin o where o.record_id=r.id))
  ||case r.entity
   when 'contacts' then coalesce((select jsonb_build_object('trade_name',c.trade_name,'person_type',c.person_type,'document',c.document,
     'email',c.email,'phone',c.phone,'mobile',c.mobile,'city',c.city,'state',c.state,'roles',to_jsonb(c.roles))
     from erp_catalog.contact c where c.record_id=r.id),'{"roles":[]}'::jsonb)
   when 'products' then coalesce((select jsonb_build_object('unit',p.unit,'price',erp_catalog.unit_price_numeric(p.price,14),'kind',p.kind,
     'format',p.format,'gtin',p.gtin,'brand',p.brand,'ncm',p.ncm) from erp_catalog.product p where p.record_id=r.id),'{}'::jsonb)
   else '{}'::jsonb end
 from erp_catalog.record r where r.id=p_id
$$;

create function erp_catalog.page_valid(p_page integer,p_size integer,p_sort text,p_query text,p_period text,p_from date,p_to date) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_page between 1 and 100000 and p_size between 1 and 100
  and p_sort in('created_desc','name_asc','name_desc','code_asc','code_desc')
  and(p_query is null or(length(p_query)<=120 and p_query!~'[[:cntrl:]]'))
  and((p_period is null and p_from is null and p_to is null) or(p_period in('created','updated') and num_nonnulls(p_from,p_to)>0))
  and(p_from is null or(isfinite(p_from) and p_from between date '1900-01-01' and date '2100-12-31'))
  and(p_to is null or(isfinite(p_to) and p_to between date '1900-01-01' and date '2100-12-31'))
  and(p_from is null or p_to is null or p_from<=p_to),false)
$$;
-- Fragmentos fixos de ORDER BY; o id é o desempate estável de todas as ordens.
create function erp_catalog.page_order(p_sort text) returns text
language sql immutable set search_path=pg_catalog as $$
 select case p_sort when 'created_desc' then 'r.created_at desc,r.id desc'
  when 'name_asc' then 'erp_catalog.fold(r.name),r.id' when 'name_desc' then 'erp_catalog.fold(r.name) desc,r.id desc'
  when 'code_asc' then 'erp_catalog.fold(r.code) nulls last,r.id' when 'code_desc' then 'erp_catalog.fold(r.code) desc nulls last,r.id desc' end
$$;
-- Sem busca, total e página usam os índices de ordenação; com busca, o filtro roda uma única vez.
create function erp_catalog.page_sql(p_from_where text,p_sort text,p_single_pass boolean,p_offset_param integer) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when p_single_pass then
  'with f as materialized(select r.id,r.created_at,r.name,r.code'||p_from_where||') select (select count(*) from f),array(select r.id from f r order by '
   ||erp_catalog.page_order(p_sort)||' offset $'||p_offset_param||' limit $'||(p_offset_param+1)||')'
 else 'select (select count(*)'||p_from_where||'),array(select r.id'||p_from_where||' order by '||erp_catalog.page_order(p_sort)
   ||' offset $'||p_offset_param||' limit $'||(p_offset_param+1)||')' end
$$;

-- Mesma regra de posição de 202610160025: saldo e razão precisam conferir; sem posição é "sem lançamentos".
create function erp_catalog.stock_summary(p_ids uuid[],p_warehouse_id uuid)
returns table(product_id uuid,state text,quantity numeric,warehouse_state text,warehouse_quantity numeric)
language sql stable set search_path=pg_catalog as $$
 with candidates as materialized(
  select p.record_id as id,p.unit,p.kind from erp_catalog.product p where p_ids is null or p.record_id=any(p_ids)
 ),ledger as materialized(
  select e.product_id,e.warehouse_id,count(*) as entry_count,sum(e.quantity) as ledger_quantity,max(e.balance_version) as last_version,
   bool_and(e.unit is not distinct from c.unit) as units_match
   from erp_stock.entry e join candidates c on c.id=e.product_id group by e.product_id,e.warehouse_id
 ),balances as materialized(select b.* from erp_stock.balance b join candidates c on c.id=b.product_id),
 positions as materialized(
  select coalesce(b.product_id,l.product_id) as product_id,coalesce(b.warehouse_id,l.warehouse_id) as warehouse_id,b.quantity,
   case when b.product_id is null or l.product_id is null or c.unit is null or c.kind is distinct from 'P'
     or b.unit is distinct from c.unit or not coalesce(l.units_match,false)
     or b.version<>l.entry_count or b.version<>l.last_version or b.quantity<>l.ledger_quantity
    then 'review_required' else 'recorded' end as state
   from balances b full join ledger l on l.product_id=b.product_id and l.warehouse_id=b.warehouse_id
   join candidates c on c.id=coalesce(b.product_id,l.product_id)
 )
 select c.id,
  case when bool_or(s.state='review_required') then 'review_required' when count(s.warehouse_id)=0 then 'no_movements' else 'recorded' end,
  case when coalesce(bool_or(s.state='review_required'),false) or count(s.warehouse_id)=0 then null else sum(s.quantity) end,
  case when p_warehouse_id is null then null else coalesce(max(s.state) filter(where s.warehouse_id=p_warehouse_id),'no_movements') end,
  case when p_warehouse_id is null then null else max(s.quantity) filter(where s.warehouse_id=p_warehouse_id and s.state='recorded') end
 from candidates c left join positions s on s.product_id=c.id group by c.id
$$;
create function erp_catalog.can_read_stock(p_user_id uuid) returns boolean
language plpgsql stable set search_path=pg_catalog as $$
begin
 perform erp_stock.require_access(p_user_id,false);
 return true;
exception when insufficient_privilege then return false;
end $$;

-- Avisos só para valores novos ou alterados, como validate_product_identifiers: cadastros antigos com
-- duplicidade continuam editáveis sem confirmação enquanto o campo não muda.
create function erp_catalog.warnings(p_entity text,p_id uuid,p_data jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v_previous jsonb:=case when p_id is null then '{}'::jsonb else coalesce(erp_catalog.data(p_id),'{}'::jsonb) end;
 v_result jsonb:='[]'::jsonb; v_value text; v_type text; v_issue text; v_matches jsonb; v_total integer;
begin
 if p_entity='products' then
  v_value:=p_data->>'code';
  if v_value is not null and v_value is distinct from v_previous->>'code' then
   select count(*)::integer,coalesce(jsonb_agg(m.item order by m.n) filter(where m.n<=5),'[]'::jsonb) into v_total,v_matches
    from(select jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'active',r.active) as item,row_number() over(order by r.created_at desc,r.id) as n
     from erp_catalog.record r where r.entity='products' and erp_catalog.fold(r.code)=erp_catalog.fold(v_value) and r.id is distinct from p_id) m;
   if v_total>0 then v_result:=v_result||jsonb_build_array(jsonb_build_object('code','duplicate_code','field','code','total',v_total,'matches',v_matches)); end if;
  end if;
  v_value:=p_data->>'gtin';
  if v_value is not null and v_value<>'SEM GTIN' and v_value is distinct from v_previous->>'gtin' then
   select count(*)::integer,coalesce(jsonb_agg(m.item order by m.n) filter(where m.n<=5),'[]'::jsonb) into v_total,v_matches
    from(select jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'active',r.active) as item,row_number() over(order by r.created_at desc,r.id) as n
     from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id
     where p.gtin=v_value and p.gtin<>'SEM GTIN' and r.id is distinct from p_id) m;
   if v_total>0 then v_result:=v_result||jsonb_build_array(jsonb_build_object('code','duplicate_gtin','field','gtin','total',v_total,'matches',v_matches)); end if;
  end if;
 elsif p_entity='contacts' then
  v_value:=case when p_data?'document' then p_data->>'document' else v_previous->>'document' end;
  v_type:=case when p_data?'person_type' then p_data->>'person_type' else v_previous->>'person_type' end;
  if v_value is not null and(v_value is distinct from v_previous->>'document' or v_type is distinct from v_previous->>'person_type') then
   v_issue:=erp_catalog.document_issue(v_type,v_value);
   if v_issue is not null then v_result:=v_result||jsonb_build_array(jsonb_build_object('code','invalid_document','field','document','expected',v_issue)); end if;
  end if;
  if v_value is not null and length(erp_catalog.compact(v_value))>=5 and erp_catalog.compact(v_value) is distinct from erp_catalog.compact(v_previous->>'document') then
   select count(*)::integer,coalesce(jsonb_agg(m.item order by m.n) filter(where m.n<=5),'[]'::jsonb) into v_total,v_matches
    from(select jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'active',r.active) as item,row_number() over(order by r.created_at desc,r.id) as n
     from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id
     where c.document is not null and erp_catalog.compact(c.document)=erp_catalog.compact(v_value) and r.id is distinct from p_id) m;
   if v_total>0 then v_result:=v_result||jsonb_build_array(jsonb_build_object('code','duplicate_document','field','document','total',v_total,'matches',v_matches)); end if;
  end if;
 end if;
 return v_result;
end $$;

-- Cursor legado (seletores de documentos e financeiro): mesma assinatura, ordem por UUID e validação;
-- só a comparação da busca passa a ser tolerante.
create or replace function public.erp_catalog_list(p_user_id uuid,p_entity text,p_limit integer default 25,
  p_after uuid default null,p_query text default null,p_active boolean default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_more boolean; v_last uuid; v_terms text[];
begin
  perform erp_catalog.require_access(p_user_id,p_entity,false);
  if p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 then
    raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
  v_terms:=erp_catalog.search_terms(p_query);
  with page as materialized (
    select r.id from erp_catalog.record r left join erp_catalog.contact c on c.record_id=r.id left join erp_catalog.product p on p.record_id=r.id
    where r.entity=p_entity and (p_after is null or r.id>p_after) and (p_active is null or r.active=p_active)
      and (v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code,c.trade_name,c.email,c.document,c.phone,c.mobile,p.gtin)),
        regexp_replace(lower(coalesce(c.document,'')),'[^0-9a-z]','','g'),regexp_replace(concat_ws('|',c.document,c.phone,c.mobile),'[^0-9|]','','g')))
    order by r.id limit p_limit+1
  ), visible as materialized (select id from page order by id limit p_limit)
  select coalesce((select jsonb_agg(erp_catalog.dto(id) order by id) from visible),'[]'::jsonb),
    (select count(*)>p_limit from page),(select id from visible order by id desc limit 1)
  into v_items,v_more,v_last;
  return jsonb_build_object('entity',p_entity,'items',v_items,'has_more',v_more,
    'next_cursor',case when v_more then v_last end,'limit',p_limit,'data_mode','erp_native');
end $$;

create or replace function public.erp_catalog_product_list(p_user_id uuid,p_limit integer default 25,p_after uuid default null,
 p_query text default null,p_active boolean default null,p_kind text default null,p_format text default null,
 p_ncm_presence text default null,p_brand text default null)returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb;v_more boolean;v_last uuid;v_terms text[];
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]'
  or length(p_brand)>100 or p_brand~'[[:cntrl:]]'or(p_kind is not null and p_kind not in('P','S','N'))
  or(p_format is not null and p_format not in('S','V','E'))or(p_ncm_presence is not null and p_ncm_presence not in('present','missing'))then
  raise exception 'erp_catalog_invalid_query' using errcode='22023';end if;
 v_terms:=erp_catalog.search_terms(p_query);
 with page as materialized(
  select r.id from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.entity='products'
   and(p_after is null or r.id>p_after)and(p_active is null or r.active=p_active)
   and(p_kind is null or p.kind=p_kind)and(p_format is null or p.format=p_format)
   and(p_ncm_presence is null or case p_ncm_presence when 'present'then nullif(btrim(p.ncm),'')is not null else nullif(btrim(p.ncm),'')is null end)
   and(nullif(btrim(p_brand),'')is null or strpos(lower(coalesce(p.brand,'')),lower(btrim(p_brand)))>0)
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code,p.gtin)),regexp_replace(lower(coalesce(p.gtin,'')),'[^0-9a-z]','','g'),regexp_replace(coalesce(p.gtin,''),'[^0-9]','','g')))
  order by r.id limit p_limit+1
 ),visible as materialized(select id from page order by id limit p_limit)
 select coalesce((select jsonb_agg(erp_catalog.dto(id)order by id)from visible),'[]'::jsonb),
  (select count(*)>p_limit from page),(select id from visible order by id desc limit 1)into v_items,v_more,v_last;
 return jsonb_build_object('entity','products','items',v_items,'has_more',v_more,'next_cursor',case when v_more then v_last end,'limit',p_limit,'data_mode','erp_native');
end $$;

-- Página numerada de contatos e depósitos, com total e ordenação. Todos os valores do usuário seguem
-- como parâmetros; só a ordem e a coluna de período vêm de fragmentos fixos acima.
create function public.erp_catalog_page(p_user_id uuid,p_entity text,p_page integer default 1,p_size integer default 100,
 p_sort text default 'created_desc',p_query text default null,p_active boolean default null,p_role text default null,
 p_person_type text default null,p_state text default null,p_city text default null,p_phone text default null,p_email text default null,
 p_period text default null,p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_terms text[]; v_from timestamptz; v_to timestamptz; v_total bigint; v_ids uuid[]; v_items jsonb; v_where text;
 v_city text:=nullif(btrim(p_city),''); v_phone text:=nullif(erp_catalog.digits(p_phone),''); v_email text:=nullif(btrim(p_email),'');
begin
 perform erp_catalog.require_access(p_user_id,p_entity,false);
 if p_entity not in('contacts','warehouses') or not erp_catalog.page_valid(p_page,p_size,p_sort,p_query,p_period,p_from,p_to)
  or(p_entity<>'contacts' and num_nonnulls(p_role,p_person_type,p_state,p_city,p_phone,p_email)>0)
  or(p_role is not null and p_role not in('customer','supplier','carrier','none'))
  or(p_person_type is not null and p_person_type not in('F','J','E'))
  or(p_state is not null and p_state!~'^[A-Z]{2}$')
  or(p_city is not null and(length(p_city)>100 or p_city~'[[:cntrl:]]'))
  or(p_phone is not null and(length(p_phone)>40 or p_phone~'[[:cntrl:]]' or p_phone!~'[0-9]'))
  or(p_email is not null and(length(p_email)>254 or p_email~'[[:cntrl:]]')) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_terms:=erp_catalog.search_terms(p_query);
 v_from:=case when p_from is not null then p_from::timestamp at time zone 'America/Sao_Paulo' end;
 v_to:=case when p_to is not null then (p_to+1)::timestamp at time zone 'America/Sao_Paulo' end;
 v_where:=format($q$ from erp_catalog.record r left join erp_catalog.contact c on c.record_id=r.id
  where r.entity=$1 and($2::boolean is null or r.active=$2)
   and($3::text[] is null or erp_catalog.matches($3,erp_catalog.fold(concat_ws(' ',r.name,r.code,c.trade_name,c.email,c.document,c.phone,c.mobile)),
    regexp_replace(lower(coalesce(c.document,'')),'[^0-9a-z]','','g'),regexp_replace(concat_ws('|',c.document,c.phone,c.mobile),'[^0-9|]','','g')))
   and($4::text is null or case $4 when 'none' then cardinality(c.roles)=0 else $4=any(c.roles) end)
   and($5::text is null or c.person_type=$5)
   and($6::text is null or upper(btrim(c.state))=$6)
   and($7::text is null or strpos(erp_catalog.fold(coalesce(c.city,'')),erp_catalog.fold($7))>0)
   and($8::text is null or strpos(regexp_replace(concat_ws('|',c.phone,c.mobile),'[^0-9|]','','g'),$8)>0)
   and($9::text is null or strpos(erp_catalog.fold(coalesce(c.email,'')),erp_catalog.fold($9))>0)
   and($10::timestamptz is null or %1$s>=$10) and($11::timestamptz is null or %1$s<$11)$q$,
  case p_period when 'updated' then 'r.updated_at' else 'r.created_at' end);
 execute erp_catalog.page_sql(v_where,p_sort,v_terms is not null,12) into v_total,v_ids
  using p_entity,p_active,v_terms,p_role,p_person_type,p_state,v_city,v_phone,v_email,v_from,v_to,(p_page-1)*p_size,p_size;
 select coalesce(jsonb_agg(erp_catalog.list_item(u.id) order by u.n),'[]'::jsonb) into v_items from unnest(v_ids) with ordinality u(id,n);
 return jsonb_build_object('entity',p_entity,'items',v_items,'page',p_page,'size',p_size,'total',v_total,'sort',p_sort,'data_mode','erp_native');
end $$;

-- Página numerada de produtos, com estoque somado entre depósitos para quem pode consultar estoque.
create function public.erp_catalog_product_page(p_user_id uuid,p_page integer default 1,p_size integer default 100,
 p_sort text default 'created_desc',p_query text default null,p_active boolean default null,p_kind text default null,
 p_format text default null,p_ncm_presence text default null,p_ncm text default null,p_brand text default null,
 p_stock text default null,p_warehouse_id uuid default null,p_period text default null,p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_stock boolean; v_terms text[]; v_filter uuid[]; v_ids uuid[]; v_from timestamptz; v_to timestamptz; v_total bigint;
 v_items jsonb; v_where text; v_brand text:=nullif(btrim(p_brand),'');
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if not erp_catalog.page_valid(p_page,p_size,p_sort,p_query,p_period,p_from,p_to)
  or(p_kind is not null and p_kind not in('P','S','N')) or(p_format is not null and p_format not in('S','V','E'))
  or(p_ncm_presence is not null and p_ncm_presence not in('present','missing'))
  or(p_ncm is not null and(p_ncm!~'^[0-9]{2,8}$' or p_ncm_presence='missing'))
  or(p_brand is not null and(length(p_brand)>100 or p_brand~'[[:cntrl:]]'))
  or(p_stock is not null and p_stock not in('zero','negative','positive','no_movements')) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_stock:=erp_catalog.can_read_stock(p_user_id);
 if(p_stock is not null or p_warehouse_id is not null) and not v_stock then
  raise exception 'erp_catalog_stock_access_denied' using errcode='42501'; end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id) then
  raise exception 'erp_catalog_warehouse_not_found' using errcode='P0002'; end if;
 if p_stock is not null then
  select coalesce(array_agg(s.product_id),'{}'::uuid[]) into v_filter
   from(select product_id,case when p_warehouse_id is null then state else warehouse_state end as state,
     case when p_warehouse_id is null then quantity else warehouse_quantity end as quantity
    from erp_catalog.stock_summary(null,p_warehouse_id)) s
   where case p_stock when 'no_movements' then s.state='no_movements'
    else s.state='recorded' and case p_stock when 'zero' then s.quantity=0 when 'positive' then s.quantity>0 else s.quantity<0 end end;
 end if;
 v_terms:=erp_catalog.search_terms(p_query);
 v_from:=case when p_from is not null then p_from::timestamp at time zone 'America/Sao_Paulo' end;
 v_to:=case when p_to is not null then (p_to+1)::timestamp at time zone 'America/Sao_Paulo' end;
 v_where:=format($q$ from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id
  where r.entity='products' and($1::boolean is null or r.active=$1)
   and($2::text[] is null or erp_catalog.matches($2,erp_catalog.fold(concat_ws(' ',r.name,r.code,p.gtin)),regexp_replace(lower(coalesce(p.gtin,'')),'[^0-9a-z]','','g'),regexp_replace(coalesce(p.gtin,''),'[^0-9]','','g')))
   and($3::text is null or p.kind=$3) and($4::text is null or p.format=$4)
   and($5::text is null or case $5 when 'present' then nullif(btrim(p.ncm),'') is not null else nullif(btrim(p.ncm),'') is null end)
   and($6::text is null or left(coalesce(p.ncm,''),length($6))=$6)
   and($7::text is null or strpos(erp_catalog.fold(coalesce(p.brand,'')),erp_catalog.fold($7))>0)
   and($8::uuid[] is null or r.id=any($8))
   and($9::timestamptz is null or %1$s>=$9) and($10::timestamptz is null or %1$s<$10)$q$,
  case p_period when 'updated' then 'r.updated_at' else 'r.created_at' end);
 execute erp_catalog.page_sql(v_where,p_sort,v_terms is not null,11) into v_total,v_ids
  using p_active,v_terms,p_kind,p_format,p_ncm_presence,p_ncm,v_brand,v_filter,v_from,v_to,(p_page-1)*p_size,p_size;
 select coalesce(jsonb_agg(erp_catalog.list_item(u.id)||jsonb_build_object('stock',case when v_stock then jsonb_build_object(
    'state',s.state,'quantity',case when s.state='recorded' then round(s.quantity,6)::text end,
    'warehouse',case when p_warehouse_id is not null then jsonb_build_object('id',p_warehouse_id,'state',s.warehouse_state,
     'quantity',case when s.warehouse_state='recorded' then round(s.warehouse_quantity,6)::text end) end) end) order by u.n),'[]'::jsonb)
  into v_items from unnest(v_ids) with ordinality u(id,n)
  left join erp_catalog.stock_summary(case when v_stock then v_ids else '{}'::uuid[] end,p_warehouse_id) s on s.product_id=u.id;
 return jsonb_build_object('entity','products','items',v_items,'page',p_page,'size',p_size,'total',v_total,'sort',p_sort,
  'stock_visible',v_stock,'data_mode','erp_native');
end $$;

-- Conferência antes de salvar: somente leitura, exige o mesmo perfil que a gravação.
create function public.erp_catalog_check(p_user_id uuid,p_entity text,p_id uuid,p_data jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_data jsonb;
begin
 perform erp_catalog.require_access(p_user_id,p_entity,false);
 perform erp_catalog.require_access(p_user_id,p_entity,true);
 if p_entity not in('contacts','products') then raise exception 'erp_catalog_invalid_check' using errcode='22023'; end if;
 v_data:=erp_catalog.validate_data(p_entity,p_data,false);
 if p_id is not null and not exists(select 1 from erp_catalog.record where id=p_id and entity=p_entity) then
  raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('entity',p_entity,'warnings',erp_catalog.warnings(p_entity,p_id,v_data),'data_mode','erp_native');
end $$;

-- Gravação com avisos confirmados: recalcula os avisos sob o mesmo lock do comando e do registro,
-- recusa aviso novo não confirmado e registra a confirmação na auditoria. O replay devolve o resultado original.
create function public.erp_catalog_save_checked(p_user_id uuid,p_entity text,p_id uuid,p_expected_version integer,
 p_command_id uuid,p_data jsonb,p_acknowledged jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_codes jsonb; v_result jsonb;
begin
 perform erp_catalog.require_access(p_user_id,p_entity,true);
 if p_entity not in('contacts','products') or p_command_id is null or p_acknowledged is null or jsonb_typeof(p_acknowledged)<>'array'
  or jsonb_array_length(p_acknowledged)>4
  or exists(select 1 from jsonb_array_elements(p_acknowledged) a where jsonb_typeof(a)<>'string'
   or a#>>'{}' not in('duplicate_code','duplicate_gtin','invalid_document','duplicate_document'))
  or(select count(distinct a#>>'{}') from jsonb_array_elements(p_acknowledged) a)<>jsonb_array_length(p_acknowledged) then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 if exists(select 1 from erp_catalog.command where command_id=p_command_id)
  or(p_id is not null and not exists(select 1 from erp_catalog.record where id=p_id and entity=p_entity)) then
  return erp_catalog.mutate(p_user_id,p_entity,p_id,p_expected_version,p_command_id,p_data,false,null);
 end if;
 if p_id is not null then perform 1 from erp_catalog.record where id=p_id and entity=p_entity for update; end if;
 select coalesce(jsonb_agg(w->'code'),'[]'::jsonb) into v_codes
  from jsonb_array_elements(erp_catalog.warnings(p_entity,p_id,erp_catalog.validate_data(p_entity,p_data,false))) w;
 if exists(select 1 from jsonb_array_elements_text(v_codes) c where not p_acknowledged?c) then
  raise exception 'erp_catalog_warning_unacknowledged' using errcode='40001'; end if;
 v_result:=erp_catalog.mutate(p_user_id,p_entity,p_id,p_expected_version,p_command_id,p_data,false,null);
 if jsonb_array_length(v_codes)>0 then
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
   values(p_user_id,p_command_id,p_entity,(v_result#>>'{record,id}')::uuid,'warnings_acknowledged',null,jsonb_build_object('warnings',v_codes));
 end if;
 return v_result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
revoke all on function public.erp_catalog_page(uuid,text,integer,integer,text,text,boolean,text,text,text,text,text,text,text,date,date) from public,anon,authenticated;
revoke all on function public.erp_catalog_product_page(uuid,integer,integer,text,text,boolean,text,text,text,text,text,text,uuid,text,date,date) from public,anon,authenticated;
revoke all on function public.erp_catalog_check(uuid,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.erp_catalog_save_checked(uuid,text,uuid,integer,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.erp_catalog_page(uuid,text,integer,integer,text,text,boolean,text,text,text,text,text,text,text,date,date) to service_role;
grant execute on function public.erp_catalog_product_page(uuid,integer,integer,text,text,boolean,text,text,text,text,text,text,uuid,text,date,date) to service_role;
grant execute on function public.erp_catalog_check(uuid,text,uuid,jsonb) to service_role;
grant execute on function public.erp_catalog_save_checked(uuid,text,uuid,integer,uuid,jsonb,jsonb) to service_role;
commit;
