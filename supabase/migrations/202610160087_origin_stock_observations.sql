-- Read-only current staging observations. No native stock, conversion or arithmetic.
begin;
create function erp_cutover.stock_observation_flags()returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('profile','origin-stock-observations-v1','read_only',true,'can_import_balance',false,'coverage_certified',false,'lexical_precision_certified',false,'reconciled',false,'native_effects',false,'numeric_representation','parsed_json_number','units_compared',false,'observed_at',statement_timestamp())
$$;
create function erp_cutover.stock_observation_id(v jsonb)returns text language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='string'and v#>>'{}'~'^[0-9]{1,40}$'and v#>>'{}'!~'^0+$'then v#>>'{}'
 when jsonb_typeof(v)='number'and v#>>'{}'~'^[1-9][0-9]{0,15}$'and(v#>>'{}')::numeric<=9007199254740991 then v#>>'{}'end
$$;
create function erp_cutover.stock_observation_warehouse(p_id text)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare b erp_warehouse_import.binding;c jsonb;s jsonb;r jsonb;begin
 if p_id is null or p_id!~'^[0-9]{1,40}$'or p_id~'^0+$'then raise exception 'stock_observation_query_invalid'using errcode='22023';end if;
 select * into b from erp_warehouse_import.binding where source_id=p_id;if not found then raise exception 'stock_observation_warehouse_not_found'using errcode='P0002';end if;
 c:=erp_warehouse_import.current(b);s:=c->'source';r:=c->'record';
 return jsonb_build_object('source_id',b.source_id,'record_id',b.warehouse_id,'imported_at',b.imported_at,'binding_source_hash',b.source_hash,'binding_source_version',b.source_version::text,'source_state',c->'source_state','record_state',c->'record_state',
 'source',case when s is null or s='null'::jsonb then null else jsonb_build_object('source_hash',s->'source_hash','source_version',s->'source_version','last_seen_at',s->'last_seen_at','name',s->'name','status',s->'status','is_default',s->'is_default','exclude_balance',s->'exclude_balance','valid',s->'valid')end,
 'record',jsonb_build_object('name',r->'name','active',r->'active','human_edited',r->'human_edited','version',r->'version'));
end$$;
create function erp_cutover.stock_observation_product(p_id text)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare s origin_sync.raw_record;b jsonb;valid_id boolean;begin
 select * into s from origin_sync.raw_record where entity='products'and source_id=p_id;b:=erp_documents.origin_import_binding('products',p_id);
 valid_id:=erp_cutover.stock_observation_id(s.payload->'id')=p_id;
 return jsonb_build_object('source_known',s.source_id is not null,'source_name',erp_cutover.purchase_observed(case when valid_id then s.payload->'nome'when s.source_id is not null then '{}'::jsonb end,false,200),'source_code',erp_cutover.purchase_observed(case when valid_id then s.payload->'codigo'when s.source_id is not null then '{}'::jsonb end,false,100),
 'record_id',b->'record_id','record_name',b->'name','record_unit',b->'unit','active',b->'active','human_edited',b->'human_edited',
 'binding_state',case when s.source_id is null then'missing_staging'when b->>'record_id'is null then'missing_native'when valid_id and b->'valid'='true'::jsonb then'current'else'needs_review'end);
end$$;
create function erp_cutover.stock_observation_row(p_id text,p_warehouse text)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare s origin_sync.raw_record;p jsonb;stamp jsonb;state text:='missing';ws text:='unavailable';d jsonb;selected jsonb;id text;ids text[]:=array[]::text[];issues jsonb:='[]';invalid_list boolean:=false;v jsonb;field text;begin
 select * into s from origin_sync.raw_record where entity='stock_balances'and source_id=p_id;
 if s.source_id is not null then
  stamp:=jsonb_build_object('source_hash',s.version_hash,'source_version',s.version::text,'last_seen_at',s.last_seen_at);p:=s.payload;state:='available';
  if octet_length(p::text)>131072 then state:='invalid';issues:=issues||'"STOCK_SOURCE_TOO_LARGE"'::jsonb;end if;
  if erp_cutover.stock_observation_id(p#>'{produto,id}')is distinct from p_id or jsonb_typeof(p)<>'object'or not isfinite(s.last_seen_at)or s.version<1
   or s.version_hash is distinct from encode(sha256(convert_to(jsonb_build_object('payload',s.payload,'document_links',s.document_links)::text,'UTF8')),'hex')then state:='invalid';issues:=issues||'"STOCK_SOURCE_INVALID"'::jsonb;end if;
  if state='invalid'then p:=null;ws:='invalid';
  elsif p?'depositos'then
   if jsonb_typeof(p->'depositos')is distinct from'array'then invalid_list:=true;issues:=issues||'"WAREHOUSE_LIST_INVALID"'::jsonb;
   elsif jsonb_array_length(p->'depositos')>1000 then invalid_list:=true;issues:=issues||'"WAREHOUSE_LIST_INVALID"'::jsonb;
   else
    for d in select value from jsonb_array_elements(p->'depositos')loop
     id:=erp_cutover.stock_observation_id(d->'id');
     if id is null then invalid_list:=true;if not issues?'WAREHOUSE_ID_INVALID'then issues:=issues||'"WAREHOUSE_ID_INVALID"'::jsonb;end if;
     elsif id=any(ids)then invalid_list:=true;if not issues?'WAREHOUSE_DUPLICATE'then issues:=issues||'"WAREHOUSE_DUPLICATE"'::jsonb;end if;
     else ids:=array_append(ids,id);if id=p_warehouse then selected:=d;end if;end if;
    end loop;
   end if;
   if invalid_list then ws:='invalid';selected:=null;else ws:=case when selected is null then'absent'else'present'end;end if;
  end if;
 end if;
 foreach field in array array['saldoFisicoTotal','saldoVirtualTotal']loop if erp_cutover.purchase_observed(p->field,true)->>'state'='invalid'then if not issues?'OBSERVED_NUMBER_INVALID'then issues:=issues||'"OBSERVED_NUMBER_INVALID"'::jsonb;end if;end if;end loop;
 foreach field in array array['saldoFisico','saldoVirtual']loop if erp_cutover.purchase_observed(selected->field,true)->>'state'='invalid'then if not issues?'OBSERVED_NUMBER_INVALID'then issues:=issues||'"OBSERVED_NUMBER_INVALID"'::jsonb;end if;end if;end loop;
 return jsonb_build_object('product_source_id',p_id,'product',erp_cutover.stock_observation_product(p_id),'observation',jsonb_build_object('state',state,'source',stamp,'product_code',erp_cutover.purchase_observed(p#>'{produto,codigo}',false,100),'physical_total',erp_cutover.purchase_observed(p->'saldoFisicoTotal',true),'virtual_total',erp_cutover.purchase_observed(p->'saldoVirtualTotal',true),'warehouse',jsonb_build_object('state',ws,'physical',erp_cutover.purchase_observed(selected->'saldoFisico',true),'virtual',erp_cutover.purchase_observed(selected->'saldoVirtual',true)),'issues',issues));
end$$;
create function erp_cutover.stock_observation_counts()returns jsonb language sql stable set search_path=pg_catalog as $$
 with s as materialized(select entity,source_id,source_id~'^[0-9]{1,40}$'and source_id!~'^0+$'valid from origin_sync.raw_record where entity in('products','stock_balances')),
 ids as(select source_id,bool_or(entity='products')product,bool_or(entity='stock_balances')stock from s where valid group by source_id)
 select jsonb_build_object('scope','exact_staging_product_ids','product_ids',(select count(*)::text from ids),'known_product_ids',(select count(*)::text from ids where product),'stock_observation_ids',(select count(*)::text from ids where stock),'known_without_observation',(select count(*)::text from ids where product and not stock),'observation_without_product',(select count(*)::text from ids where stock and not product),'invalid_product_ids',(select count(*)::text from s where not valid and entity='products'),'invalid_stock_ids',(select count(*)::text from s where not valid and entity='stock_balances'))
$$;
create function public.erp_origin_stock_observations(p_user_id uuid,p_warehouse_source_id text,p_limit integer default 25,p_after text default null,p_query text default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare warehouse jsonb;rows jsonb;more boolean;begin
 perform erp_cutover.require_admin(p_user_id);warehouse:=erp_cutover.stock_observation_warehouse(p_warehouse_source_id);
 if p_limit is null or p_limit not between 1 and 25 or(p_after is not null and(p_after!~'^[0-9]{1,40}$'or p_after~'^0+$'))or(p_query is not null and(length(p_query)>100 or p_query~'[[:cntrl:]]'or p_query~U&'[\007F-\009F]'))then raise exception 'stock_observation_query_invalid'using errcode='22023';end if;
 with ids as(select distinct source_id from origin_sync.raw_record where entity in('products','stock_balances')and source_id~'^[0-9]{1,40}$'and source_id!~'^0+$'),
 selected as materialized(select i.source_id from ids i left join origin_sync.raw_record p on p.entity='products'and p.source_id=i.source_id
 where(p_after is null or i.source_id collate"C">p_after collate"C")and(nullif(btrim(p_query),'')is null or strpos(i.source_id,btrim(p_query))>0 or(erp_cutover.stock_observation_id(p.payload->'id')=i.source_id and(strpos(lower(left(p.payload->>'nome',200)),lower(btrim(p_query)))>0 or strpos(lower(left(p.payload->>'codigo',100)),lower(btrim(p_query)))>0)))order by i.source_id collate"C"limit p_limit+1),
 visible as(select source_id from selected order by source_id collate"C"limit p_limit)
 select coalesce((select jsonb_agg(erp_cutover.stock_observation_row(source_id,p_warehouse_source_id)order by source_id collate"C")from visible),'[]'::jsonb),(select count(*)>p_limit from selected)into rows,more;
 return erp_cutover.stock_observation_flags()||jsonb_build_object('warehouse',warehouse,'counts',erp_cutover.stock_observation_counts(),'items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then rows->-1->>'product_source_id'end);
end$$;
create function public.erp_origin_stock_observation_detail(p_user_id uuid,p_warehouse_source_id text,p_product_source_id text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare warehouse jsonb;begin
 perform erp_cutover.require_admin(p_user_id);warehouse:=erp_cutover.stock_observation_warehouse(p_warehouse_source_id);
 if p_product_source_id is null or p_product_source_id!~'^[0-9]{1,40}$'or p_product_source_id~'^0+$'then raise exception 'stock_observation_query_invalid'using errcode='22023';end if;
 if not exists(select 1 from origin_sync.raw_record where entity in('products','stock_balances')and source_id=p_product_source_id)then raise exception 'stock_observation_not_found'using errcode='P0002';end if;
 return erp_cutover.stock_observation_flags()||jsonb_build_object('warehouse',warehouse,'item',erp_cutover.stock_observation_row(p_product_source_id,p_warehouse_source_id));
end$$;
revoke all on function erp_cutover.stock_observation_flags(),erp_cutover.stock_observation_id(jsonb),erp_cutover.stock_observation_warehouse(text),erp_cutover.stock_observation_product(text),erp_cutover.stock_observation_row(text,text),erp_cutover.stock_observation_counts()from public,anon,authenticated,service_role;
revoke all on function public.erp_origin_stock_observations(uuid,text,integer,text,text),public.erp_origin_stock_observation_detail(uuid,text,text)from public,anon,authenticated,service_role;
grant execute on function public.erp_origin_stock_observations(uuid,text,integer,text,text),public.erp_origin_stock_observation_detail(uuid,text,text)to service_role;
commit;
