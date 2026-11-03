-- Administrative observation only. No native sales, import, financial, fiscal or stock effect.
-- Reuses020 authorization,052 exact ID bindings,076 bounded observations and078 price validation.
begin;
create function erp_cutover.sales_flags() returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('profile','origin-sales-readiness-v1','read_only',true,'can_import',false,
  'coverage_certified',false,'native_effects',false,'observed_at',statement_timestamp(),
  'pending_contracts',jsonb_build_array('SOURCE_STATUS_REVIEW','SOURCE_EFFECTS_NOT_PROVEN','COMMERCIAL_MATH_NOT_RECONCILED','PERMANENT_SALES_ORIGIN_NOT_IMPLEMENTED','HISTORICAL_EFFECT_GUARD_NOT_IMPLEMENTED'))
$$;
-- Preserve absent/null/invalid/explicit zero; never truncate or round a value.
create function erp_cutover.sales_capture(s origin_sync.raw_record) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare c jsonb:=s.price_capture;status text:='unbound';observed timestamptz;response_hash text;profile text;
begin
 if c is null then status:='absent';
 elsif c->>'profile' is distinct from 'origin-sales-price-json-v1' then status:='other_profile';
 else
  profile:='origin-sales-price-json-v1';
  if c->>'response_sha256'~'^[0-9a-f]{64}$' then response_hash:=c->>'response_sha256';end if;
  begin
   if jsonb_typeof(c->'observed_at')='string' then observed:=(c->>'observed_at')::timestamptz;end if;
   if not isfinite(observed) then observed:=null;end if;
  exception when others then observed:=null;end;
  if octet_length(c::text)<=131072 and octet_length(s.payload::text)<=524288 and c->>'source_hash'=s.version_hash and c->>'source_version'=s.version::text
   and c->>'capture_id'~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' and observed is not null and response_hash is not null then
   begin
    perform origin_sync.validate_sales_price_capture(s.payload,jsonb_build_object('profile',c->'profile','source',c->'source','response_sha256',c->'response_sha256','tokens',c->'tokens'));
    status:='bound';
   exception when sqlstate '22023' or numeric_value_out_of_range or invalid_text_representation then status:='unbound';end;
  end if;
 end if;
 return jsonb_build_object('state',status,'profile',profile,'observed_at',observed,'response_sha256',response_hash);
end $$;
create function erp_cutover.sales_source(s origin_sync.raw_record) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('source_id',s.source_id,'source_hash',s.version_hash,'source_version',s.version::text,'last_seen_at',s.last_seen_at,
  'number',erp_cutover.purchase_observed(s.payload->'numero',false,80),'date',erp_cutover.purchase_observed(s.payload->'data',false,40),
  'situation',jsonb_build_object('id',erp_documents.origin_import_id(s.payload#>'{situacao,id}'),'value',erp_cutover.purchase_observed(s.payload#>'{situacao,valor}',true)),
  'item_count',case when jsonb_typeof(s.payload->'itens')='array' then jsonb_array_length(s.payload->'itens') end,
  'capture',erp_cutover.sales_capture(s))
$$;
create function erp_cutover.sales_detail(p_source_id text) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare s origin_sync.raw_record%rowtype;p jsonb;source jsonb;customer jsonb;item jsonb;b jsonb;rows jsonb:='[]';issues jsonb:='[]';history jsonb;pos integer:=0;price text;qty text;invoice jsonb;unit jsonb;field text;v jsonb;
begin
 if p_source_id is null or p_source_id!~'^[1-9][0-9]{0,39}$' then raise exception 'sales_source_invalid' using errcode='22023';end if;
 select * into s from origin_sync.raw_record where entity='sales_orders' and source_id=p_source_id;
 if not found then raise exception 'sales_source_not_found' using errcode='P0002';end if;
 p:=s.payload;source:=erp_cutover.sales_source(s);
 if octet_length(p::text)>524288 then p:='{}';issues:=issues||erp_documents.origin_import_issue('SOURCE_TOO_LARGE');end if;
 if erp_documents.origin_import_id(p->'id') is distinct from s.source_id then issues:=issues||erp_documents.origin_import_issue('SOURCE_ID_MISMATCH','id');end if;
 if source#>>'{capture,state}'<>'bound' then issues:=issues||erp_documents.origin_import_issue('PRICE_CAPTURE_CURRENT_MISSING','itens.valor');end if;
 if source#>>'{situation,id}' is null or source#>>'{situation,value,state}'<>'value' then issues:=issues||erp_documents.origin_import_issue('SOURCE_STATUS_UNREVIEWED','situacao');end if;
 begin perform erp_documents.date_value(p->'data',true);exception when sqlstate '22023' then issues:=issues||erp_documents.origin_import_issue('SOURCE_DATE_INVALID','data');end;
 customer:=erp_cutover.purchase_binding('contacts',p#>'{contato,id}');
 if customer->'valid'<>'true'::jsonb then issues:=issues||erp_documents.origin_import_issue('CUSTOMER_BINDING_UNAVAILABLE','contato.id');end if;
 if coalesce((source->>'item_count')::integer,0) not between 1 and 250 then issues:=issues||erp_documents.origin_import_issue('ITEM_COUNT_OUTSIDE_LIMIT','itens');
 elsif octet_length(s.payload::text)<=524288 then
  for item in select value from jsonb_array_elements(p->'itens') loop
   pos:=pos+1;b:=erp_cutover.purchase_binding('products',item#>'{produto,id}');
   price:=erp_documents.origin_import_number(item->'valor',10,10);qty:=erp_documents.origin_import_number(item->'quantidade',6,9);
   if qty is not null and qty::numeric<=0 then qty:=null;end if;
   unit:=erp_cutover.purchase_observed(item->'unidade',false,16);
   if jsonb_typeof(item) is distinct from 'object' then issues:=issues||erp_documents.origin_import_issue('ITEM_INVALID','itens',pos);end if;
   if b->'valid'<>'true'::jsonb then issues:=issues||erp_documents.origin_import_issue('PRODUCT_BINDING_UNAVAILABLE','itens.produto.id',pos);end if;
   if price is null then issues:=issues||erp_documents.origin_import_issue('PRICE_OUTSIDE_NATIVE_LIMIT','itens.valor',pos);end if;
   if qty is null then issues:=issues||erp_documents.origin_import_issue('QUANTITY_OUTSIDE_NATIVE_LIMIT','itens.quantidade',pos);end if;
   if jsonb_typeof(item->'unidade') is distinct from 'string' or unit->>'state'<>'value' or coalesce(unit->>'value','')='' then issues:=issues||erp_documents.origin_import_issue('UNIT_INVALID','itens.unidade',pos);
   elsif b->>'record_id' is not null and b->>'unit' is distinct from unit->>'value' then issues:=issues||erp_documents.origin_import_issue('UNIT_DIFFERS_FROM_LINK','itens.unidade',pos);end if;
   if erp_cutover.purchase_observed(item->'codigo')->>'state'='invalid' then issues:=issues||erp_documents.origin_import_issue('TEXT_OUTSIDE_DISPLAY_LIMIT','itens.codigo',pos);end if;
   if erp_cutover.purchase_observed(item->'descricao')->>'state'='invalid' then issues:=issues||erp_documents.origin_import_issue('TEXT_OUTSIDE_DISPLAY_LIMIT','itens.descricao',pos);end if;
   rows:=rows||jsonb_build_array(jsonb_build_object('position',pos,'code',erp_cutover.purchase_observed(item->'codigo'),'description',erp_cutover.purchase_observed(item->'descricao'),
    'unit',unit,'quantity',erp_cutover.purchase_observed(item->'quantidade',true),'unit_price',erp_cutover.purchase_observed(item->'valor',true),
    'quantity_supported',qty is not null,'unit_price_supported',price is not null,'product',b,'ipi',erp_cutover.purchase_observed(item->'aliquotaIPI',true),
    'discount',erp_cutover.purchase_observed(item->'desconto',true),'list_price',erp_cutover.purchase_observed(item->'valorLista',true)));
  end loop;
 end if;
 invoice:=erp_cutover.purchase_invoice(p->'notaFiscal');
 if invoice->>'state' in('declared','invalid') then issues:=issues||erp_documents.origin_import_issue('INVOICE_REFERENCE_UNVERIFIED','notaFiscal');end if;
 foreach field in array array['total','totalProdutos'] loop
  v:=erp_cutover.purchase_observed(p->field,true);
  if v->>'state'<>'value' then issues:=issues||erp_documents.origin_import_issue('COMMERCIAL_VALUE_UNAVAILABLE',field);end if;
 end loop;
 -- No join by number, SKU or name. An exceptional explicit ID is counted, not interpreted.
 select jsonb_build_object('comparison','not_available','reason','SALES_BACKUP_NOT_COMPARED','backup_rows',count(*)::text,
  'backup_batches',count(distinct r.backup_sha)::text,'backup_rows_without_source_id',count(*) filter(where nullif(r.data->>'source_id','') is null)::text,
  'exact_id_rows_uncompared',count(*) filter(where r.data->>'source_id'=p_source_id)::text,'last_backup_stored_at',max(b.finished_at),'current_capture_is_history',false)
 into history from origin_backup.record r join origin_backup.batch b on b.backup_sha=r.backup_sha
 where r.kind='csv' and r.data->>'entity'='sales_orders' and b.status in('stored','stored_with_issues');
 return erp_cutover.sales_flags()||jsonb_build_object('source',source,'customer',customer,'invoice_reference',invoice,'items',rows,'issues',issues,'history',history,
  'commercial',jsonb_build_object('total',erp_cutover.purchase_observed(p->'total',true),'total_products',erp_cutover.purchase_observed(p->'totalProdutos',true),'other_expenses',erp_cutover.purchase_observed(p->'outrasDespesas',true),
   'freight',erp_cutover.purchase_observed(case when p->'transporte'='null'::jsonb then 'null'::jsonb when p?'transporte' and jsonb_typeof(p->'transporte')<>'object' then '[]'::jsonb else p#>'{transporte,frete}' end,true),'discount_value',erp_cutover.purchase_observed(case when p->'desconto'='null'::jsonb then 'null'::jsonb when p?'desconto' and jsonb_typeof(p->'desconto')<>'object' then '[]'::jsonb else p#>'{desconto,valor}' end,true),
   'discount_unit',erp_cutover.purchase_observed(case when p->'desconto'='null'::jsonb then 'null'::jsonb when p?'desconto' and jsonb_typeof(p->'desconto')<>'object' then '[]'::jsonb else p#>'{desconto,unidade}' end,false,40),
   'installment_count',case when jsonb_typeof(p->'parcelas')='array' then jsonb_array_length(p->'parcelas') end,'taxation_present',coalesce(jsonb_typeof(p->'tributacao')='object',false)));
end $$;
create function public.erp_origin_sales_readiness_sources(p_user_id uuid,p_limit integer default 25,p_after text default null,p_query text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb;more boolean;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_limit is null or p_limit not between 1 and 25 or (p_after is not null and p_after!~'^[1-9][0-9]{0,39}$')
  or (p_query is not null and (length(p_query)>100 or p_query~'[[:cntrl:]]' or p_query~U&'[\007F-\009F]')) then raise exception 'sales_query_invalid' using errcode='22023';end if;
 with selected as materialized(select r.* from origin_sync.raw_record r where entity='sales_orders' and source_id~'^[1-9][0-9]{0,39}$'
  and(p_after is null or source_id collate "C">p_after collate "C")
  and(nullif(btrim(p_query),'') is null or strpos(lower(source_id),lower(btrim(p_query)))>0 or strpos(lower(payload->>'numero'),lower(btrim(p_query)))>0)
  order by source_id collate "C" limit p_limit+1),page as(select * from selected order by source_id collate "C" limit p_limit)
 select coalesce((select jsonb_agg(erp_cutover.sales_source(p::origin_sync.raw_record) order by p.source_id collate "C")from page p),'[]'::jsonb),(select count(*)>p_limit from selected) into rows,more;
 return erp_cutover.sales_flags()||jsonb_build_object('items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then rows->-1->>'source_id' end);
end $$;
create function public.erp_origin_sales_readiness_detail(p_user_id uuid,p_source_id text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin perform erp_cutover.require_admin(p_user_id);return erp_cutover.sales_detail(p_source_id);end $$;
revoke all on function erp_cutover.sales_flags(),erp_cutover.sales_capture(origin_sync.raw_record),erp_cutover.sales_source(origin_sync.raw_record),erp_cutover.sales_detail(text) from public,anon,authenticated,service_role;
revoke all on function public.erp_origin_sales_readiness_sources(uuid,integer,text,text),public.erp_origin_sales_readiness_detail(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_origin_sales_readiness_sources(uuid,integer,text,text),public.erp_origin_sales_readiness_detail(uuid,text) to service_role;
commit;
