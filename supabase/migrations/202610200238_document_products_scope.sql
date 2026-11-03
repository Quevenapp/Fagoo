-- 238: Documentos (onda E), parte 1: produtos automáticos para todo perfil que grava o documento, o escopo do vendedor nos
-- documentos e o filtro Componente dos pedidos de venda.
-- * Preferências › Cadastros › Produtos "Cadastrar automaticamente produtos a partir de vendas (saídas) / compras / ordens de
--   serviço": o item livre vira produto do cadastro (ou é ligado ao produto ativo de mesmo código) pela função interna da frente de
--   produtos erp_catalog.document_product (migração 191: Origem padrão, código Sequencial/EAN, comando derivado e auditoria), para
--   todo perfil que grava o documento (o perfil Vendas inclusive). O usuário vinculado a um vendedor sem "Permite incluir produtos
--   não cadastrados nos pedidos de venda" continua sem itens livres no pedido: o item fica livre e a gravação o recusa (164).
-- * Preferências › Cadastros › Clientes e fornecedores "Contato acessível somente ao vendedor vinculado" (erp_catalog.contact_scope,
--   124): a listagem, a leitura, a planilha e os históricos dos documentos mostram só os contatos do vendedor do usuário (a
--   gravação segue a mesma regra na migração 239).
-- * Pedidos de venda, filtro "Componente" (p_component_id): pedidos com um produto cuja estrutura atual (Estoque › composições,
--   222) tem o componente. A assinatura de erp_document_list ganha o parâmetro; a de 163 é removida.
-- Substitui funções das migrações 163, 164, 166, 168 e 169 (conferidas pelo hash; outra versão interrompe a migração).
-- Nenhum efeito de estoque, financeiro ou fiscal é criado.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_catalog.document_product(uuid,text,uuid,jsonb)') is null or to_regclass('erp_stock.composition_current') is null
  or to_regclass('erp_pos.settings') is null then
  raise exception 'document_products_scope_238_requires_191_204_222' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_documents.auto_products(uuid,text,uuid,jsonb)','feeda15240d324e2e177d6108de3cb6ddeb8ad6e5982722f6134d2488b3cd474'),
  ('public.erp_document_get(uuid,text,uuid)','fc94d90657d271f6e0329c006265c901c16fb256d02b8edc49e39431dd3ff89b'),
  ('public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid)','6f1e6d67444394d43d47cad3c71fa8329bc95fb65844901a5b3702d45d25d5e3'),
  ('public.erp_document_export(uuid,text,text,text,integer)','bd2ffd34bf692c9c3b70fd4326a5d3c939fee008fb6f500e28639f9a1c5cde89'),
  ('public.erp_document_history(uuid,text,uuid,uuid,text,integer)','3a406c499f0b5cca54651b5b2f3dab27dd29d08d17c1c3f4195f858f926dba48'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'document_products_scope_238_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- ---------------------------------------------------------------- Produtos automáticos
-- 164 called the catalog save (erp_catalog_save), which only the profiles that register products may run; the produtos lane
-- function (191) creates or links the product for whoever writes the document, and returns null with the preference off.
create or replace function erp_documents.auto_products(p_user_id uuid,p_kind text,p_command uuid,p_items jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare v_item jsonb; v_out jsonb:='[]'; v_id uuid;
begin
 if erp_documents.preference(erp_documents.auto_product_key(p_kind)) is distinct from 'true'::jsonb
  or not exists(select 1 from jsonb_array_elements(p_items) i where i->>'product_id' is null)
  -- The vendedor without "Permite incluir produtos não cadastrados" keeps the free item, which the save then refuses (164).
  or (p_kind='sales_orders' and exists(select 1 from erp_catalog.seller s where s.user_id=p_user_id and not s.allow_unregistered_products)) then
  return p_items; end if;
 for v_item in select value from jsonb_array_elements(p_items) loop
  if v_item->>'product_id' is null then
   v_id:=erp_catalog.document_product(p_user_id,p_kind,p_command,v_item);
   if v_id is not null then v_item:=jsonb_set(v_item,'{product_id}',to_jsonb(v_id::text)); end if;
  end if;
  v_out:=v_out||jsonb_build_array(v_item);
 end loop;
 return v_out;
end $$;

-- ---------------------------------------------------------------- Escopo do vendedor
-- Whether the user may use the contact in a document: no scope, a contact of the seller of the user, or the consumidor padrão
-- of the Frente de caixa (the sale without an identified customer).
create function erp_documents.contact_usable(p_user_id uuid,p_contact uuid) returns boolean language sql stable set search_path=pg_catalog as $$
 select erp_catalog.contact_visible_to(erp_catalog.contact_scope(p_user_id),p_contact)
  or exists(select 1 from erp_pos.settings s where s.singleton and s.consumer_contact_id=p_contact)
$$;

create or replace function public.erp_document_get(p_user_id uuid,p_kind text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if not exists(select 1 from erp_documents.document where id=p_id and kind=p_kind) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 238: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,(select contact_id from erp_documents.document where id=p_id)) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('kind',p_kind,'document',erp_documents.document_view(p_id),'data_mode','erp_native','operational_effects',false);
end $$;

drop function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid);
create function public.erp_document_list(
 p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null,p_status text default null,
 p_query text default null,p_date_from text default null,p_date_to text default null,
 p_page integer default null,p_order text default 'id',p_statuses text[] default null,p_date_type text default 'date',
 p_warehouse_id uuid default null,p_product_id uuid default null,p_city text default null,p_state text default null,
 p_technician text default null,p_equipment text default null,p_serial_number text default null,p_internal_note text default null,
 p_postal_code text default null,p_district text default null,p_tracking_code text default null,p_customer_po_number text default null,
 p_carrier text default null,p_contact_email text default null,p_template boolean default null,p_situations text[] default null,p_seller_id uuid default null,
 p_component_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_fiscal boolean; v_stock boolean; v_statuses text[]; v_query text; v_digits text; v_from date; v_to date; v_offset bigint;
 v_cursor erp_documents.document%rowtype; v_cursor_day text; v_items jsonb; v_more boolean; v_last uuid; v_count bigint; v_amount numeric;
 v_city text; v_technician text; v_equipment text; v_serial text; v_note text;
 v_postal text; v_district text; v_tracking text; v_po text; v_carrier text; v_email text;
 v_warranty text:=coalesce(erp_documents.preference('os.garantia_base')#>>'{}','nao_utilizar');
 v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 v_fiscal:=v_role in ('admin','fiscal');
 v_stock:=v_role in ('admin','consulta','estoque','vendas','fiscal');
 v_statuses:=case when p_statuses is not null then p_statuses when p_status is not null then array[p_status] end;
 if p_limit is null or p_limit not between 1 and 100
  or (p_status is not null and p_statuses is not null)
  or (v_statuses is not null and (coalesce(cardinality(v_statuses),0) not between 1 and 20 or array_position(v_statuses,null) is not null
   or exists(select 1 from unnest(v_statuses) s where not (erp_documents.transitions()->p_kind)?s)
   or (select count(distinct s) from unnest(v_statuses) s)<>cardinality(v_statuses)))
  or (p_situations is not null and (v_statuses is not null or not erp_documents.situation_adopted(p_kind) or coalesce(cardinality(p_situations),0) not between 1 and 50
   or array_position(p_situations,null) is not null or exists(select 1 from unnest(p_situations) s where not erp_documents.situation_key_valid(p_kind,s))
   or (select count(distinct s) from unnest(p_situations) s)<>cardinality(p_situations)))
  or length(p_query)>120 or p_query ~ '[[:cntrl:]]'
  or (p_date_from is not null and p_date_from !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_date_to is not null and p_date_to !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_page is not null and (p_page not between 1 and 100000 or p_after is not null))
  or p_order is null or p_order not in ('date_desc','date_asc','number_desc','number_asc','id')
  or p_date_type is null or p_date_type not in ('date','expected_date','next_contact','ship_date','finish_date','warranty_until')
  or (p_date_type='next_contact' and p_kind<>'sales_proposals')
  or (p_date_type='ship_date' and p_kind not in ('sales_orders','service_orders'))
  or (p_date_type in ('finish_date','warranty_until') and p_kind<>'service_orders')
  or ((p_city is not null or p_state is not null) and p_kind not in ('sales_orders','sales_proposals'))
  or ((p_technician is not null or p_equipment is not null or p_serial_number is not null) and p_kind<>'service_orders')
  or (p_internal_note is not null and p_kind<>'purchase_orders')
  or ((p_postal_code is not null or p_district is not null or p_tracking_code is not null or p_customer_po_number is not null or p_carrier is not null) and p_kind<>'sales_orders')
  or ((p_contact_email is not null or p_template is not null) and p_kind<>'sales_proposals')
  or (p_seller_id is not null and p_kind not in ('sales_orders','sales_proposals','service_orders'))
  or (p_component_id is not null and p_kind<>'sales_orders')
  or length(p_city)>100 or length(p_technician)>200 or length(p_equipment)>200 or length(p_serial_number)>100 or length(p_internal_note)>200
  or length(p_district)>100 or length(p_tracking_code)>200 or length(p_customer_po_number)>60 or length(p_carrier)>200 or length(p_contact_email)>254
  or (p_postal_code is not null and p_postal_code!~'^[0-9]{1,8}$')
  or concat(p_city,p_technician,p_equipment,p_serial_number,p_internal_note,p_district,p_tracking_code,p_customer_po_number,p_carrier,p_contact_email) ~ '[[:cntrl:]]'
  or (p_state is not null and p_state !~ '^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$') then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_city:=lower(nullif(btrim(p_city),''));v_technician:=lower(nullif(btrim(p_technician),''));v_equipment:=lower(nullif(btrim(p_equipment),''));
 v_serial:=lower(nullif(btrim(p_serial_number),''));v_note:=lower(nullif(btrim(p_internal_note),''));
 v_postal:=p_postal_code;v_district:=lower(nullif(btrim(p_district),''));v_tracking:=lower(nullif(btrim(p_tracking_code),''));
 v_po:=lower(nullif(btrim(p_customer_po_number),''));v_carrier:=lower(nullif(btrim(p_carrier),''));v_email:=lower(nullif(btrim(p_contact_email),''));
 if (p_city is not null and v_city is null) or (p_technician is not null and v_technician is null) or (p_equipment is not null and v_equipment is null)
  or (p_serial_number is not null and v_serial is null) or (p_internal_note is not null and v_note is null)
  or (p_district is not null and v_district is null) or (p_tracking_code is not null and v_tracking is null) or (p_customer_po_number is not null and v_po is null)
  or (p_carrier is not null and v_carrier is null) or (p_contact_email is not null and v_email is null) then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_from:=erp_documents.date_value(to_jsonb(p_date_from));
 v_to:=erp_documents.date_value(to_jsonb(p_date_to));
 if v_from>v_to then raise exception 'erp_document_period_invalid' using errcode='22023'; end if;
 v_query:=lower(nullif(btrim(p_query),''));
 v_digits:=case when v_query ~ '^[0-9./ -]+$' then regexp_replace(v_query,'[^0-9]','','g') end;
 if length(v_digits)<5 then v_digits:=null; end if;
 if p_after is not null and p_order<>'id' then
  select * into v_cursor from erp_documents.document where id=p_after and kind=p_kind;
  if not found then raise exception 'erp_document_cursor_invalid' using errcode='22023'; end if;
  v_cursor_day:=v_cursor.body->>'date';
 end if;
 v_offset:=case when p_page is null then 0 else (p_page-1)::bigint*p_limit end;
 with filtered as materialized(
  select d.id,d.number,d.body->>'date' as day,d.total from erp_documents.document d
  left join erp_documents.document_situation ds on ds.document_id=d.id
  where d.kind=p_kind
   and (v_statuses is null or d.status=any(v_statuses))
   and (p_situations is null or coalesce(ds.situation_id::text,d.status)=any(p_situations))
   and (p_seller_id is null or d.body->>'seller_id'=p_seller_id::text)
   -- 238: Preferências › Contatos "Contato acessível somente ao vendedor vinculado": the documents of the contacts of the seller.
   and (v_scope is null or exists(select 1 from erp_catalog.contact_profile cp where cp.record_id=d.contact_id and cp.seller_id=v_scope))
   -- 238: Origin "Componente": pedidos with a product whose current structure (Estoque › composições) has the component.
   and (p_component_id is null or exists(select 1 from erp_documents.item i join erp_stock.composition_current c on c.product_id=i.product_id
    where i.document_id=d.id and c.component_id=p_component_id))
   and (v_from is null and v_to is null
    or p_date_type='date' and (v_from is null or d.body->>'date'>=p_date_from) and (v_to is null or d.body->>'date'<=p_date_to)
    or p_date_type='expected_date' and (v_from is null or d.body->>'expected_date'>=p_date_from) and (v_to is null or d.body->>'expected_date'<=p_date_to)
    or p_date_type='next_contact' and (v_from is null or d.body->>'next_contact'>=p_date_from) and (v_to is null or d.body->>'next_contact'<=p_date_to)
    or p_date_type='ship_date' and (v_from is null or d.body->>'ship_date'>=p_date_from) and (v_to is null or d.body->>'ship_date'<=p_date_to)
    or p_date_type='finish_date' and (v_from is null or d.body->>'finish_date'>=p_date_from) and (v_to is null or d.body->>'finish_date'<=p_date_to)
    or p_date_type='warranty_until' and d.body->>'warranty_days' is not null
     and (v_from is null or erp_documents.warranty_until(d.body,v_warranty)>=v_from)
     and (v_to is null or erp_documents.warranty_until(d.body,v_warranty)<=v_to))
   and (p_warehouse_id is null or d.warehouse_id=p_warehouse_id)
   and (p_product_id is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=p_product_id))
   and (v_city is null or strpos(lower(coalesce(d.contact_snapshot->>'city','')),v_city)>0)
   and (p_state is null or upper(coalesce(d.contact_snapshot->>'state',''))=p_state)
   and (v_technician is null or strpos(lower(coalesce(d.body->>'technician','')),v_technician)>0)
   and (v_equipment is null or strpos(lower(coalesce(d.body->>'equipment','')),v_equipment)>0)
   and (v_serial is null or strpos(lower(coalesce(d.body->>'serial_number','')),v_serial)>0)
   and (v_note is null or strpos(lower(coalesce(d.body->>'internal_notes','')),v_note)>0)
   and (v_postal is null or strpos(regexp_replace(coalesce(d.contact_snapshot->>'postal_code',''),'[^0-9]','','g'),v_postal)=1
    or strpos(coalesce(d.body#>>'{delivery_address,postal_code}',''),v_postal)=1)
   and (v_district is null or strpos(lower(coalesce(d.contact_snapshot->>'district','')),v_district)>0
    or strpos(lower(coalesce(d.body#>>'{delivery_address,district}','')),v_district)>0)
   and (v_tracking is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,tracking_code}','')),v_tracking)>0)
   and (v_po is null or strpos(lower(coalesce(d.body->>'customer_po_number','')),v_po)>0)
   and (v_carrier is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,carrier_reference,label}','')),v_carrier)>0
    or exists(select 1 from erp_catalog.record r where r.id::text=d.body->>'carrier_id' and strpos(lower(r.name),v_carrier)>0))
   and (v_email is null or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_email)>0)
   and (p_template is null or coalesce(d.body->'template'='true'::jsonb,false)=p_template)
   and (v_query is null or strpos(d.number::text,v_query)>0 or d.id::text=v_query
    or strpos(lower(coalesce(d.contact_snapshot->>'name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'trade_name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'code','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_query)>0
    or (p_kind='purchase_orders' and strpos(lower(coalesce(d.body->>'order_reference','')),v_query)>0)
    or (v_digits is not null and strpos(regexp_replace(coalesce(d.contact_snapshot->>'document',''),'[^0-9]','','g'),v_digits)>0)
    or (v_digits is not null and p_kind='service_orders' and strpos(regexp_replace(coalesce(d.contact_snapshot->>'postal_code',''),'[^0-9]','','g'),v_digits)>0))
 ), ordered as materialized(
  select f.id,row_number() over(order by
    case when p_order='id' then f.id end,
    case when p_order='date_desc' then f.day end desc,
    case when p_order='date_asc' then f.day end,
    case when p_order in ('date_desc','number_desc') then f.number end desc,
    case when p_order in ('date_asc','number_asc') then f.number end) as position
  from filtered f
  where p_after is null
   or (p_order='id' and f.id>p_after)
   or (p_order='date_desc' and (f.day,f.number)<(v_cursor_day,v_cursor.number))
   or (p_order='date_asc' and (f.day,f.number)>(v_cursor_day,v_cursor.number))
   or (p_order='number_desc' and f.number<v_cursor.number)
   or (p_order='number_asc' and f.number>v_cursor.number)
 ), page as materialized(
  select id,position from ordered where position>v_offset and position<=v_offset+p_limit+1
 )
 select coalesce((select jsonb_agg(erp_documents.list_row(id,v_fiscal,v_stock) order by position) from page where position<=v_offset+p_limit),'[]'::jsonb),
  (select count(*) from page)>p_limit,
  (select id from page where position<=v_offset+p_limit order by position desc limit 1),
  (select count(*) from filtered),(select coalesce(sum(total),0) from filtered)
 into v_items,v_more,v_last,v_count,v_amount;
 return jsonb_build_object('kind',p_kind,'items',v_items,'limit',p_limit,'page',p_page,
  'order',p_order,'has_more',v_more,'next_cursor',case when v_more then v_last end,
  'total_count',v_count,'total_amount',case when erp_documents.list_totals_visible(p_user_id,p_kind) then v_amount::numeric(20,2)::text end,
  'data_mode','erp_native','operational_effects',false);
end $$;

create or replace function public.erp_document_export(p_user_id uuid,p_kind text,p_date_from text,p_date_to text,p_page integer)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_from date; v_to date; v_count bigint; v_items jsonb; v_size constant integer:=25; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_page is null or p_page not between 1 and 200 or p_date_from is null or p_date_to is null
  or p_date_from!~'^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' or p_date_to!~'^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
  raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 v_from:=erp_documents.date_value(to_jsonb(p_date_from),true); v_to:=erp_documents.date_value(to_jsonb(p_date_to),true);
 if v_from>v_to or v_to-v_from>366 then raise exception 'erp_document_period_invalid' using errcode='22023'; end if;
 select count(*) into v_count from erp_documents.document d where d.kind=p_kind and d.body->>'date' between p_date_from and p_date_to
  and erp_catalog.contact_visible_to(v_scope,d.contact_id);
 if v_count>5000 then raise exception 'erp_document_export_limit' using errcode='22023'; end if;
 with page as materialized(
  select d.*,row_number() over(order by d.body->>'date',d.number,d.id) n from erp_documents.document d
  where d.kind=p_kind and d.body->>'date' between p_date_from and p_date_to and erp_catalog.contact_visible_to(v_scope,d.contact_id)
  order by d.body->>'date',d.number,d.id offset (p_page-1)*v_size limit v_size)
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'number',p.number::text,'date',p.body->>'date','expected_date',p.body->>'expected_date','status',p.status,
   'situation_name',(erp_documents.situation_json(p.kind,p.status,(select s.situation_id from erp_documents.document_situation s where s.document_id=p.id)))->>'name',
   'contact_name',p.contact_snapshot->>'name','contact_document',nullif(p.contact_snapshot->>'document',''),
   'order_reference',case when p.kind='purchase_orders' then p.body->>'order_reference' end,'internal_notes',left(p.body->>'internal_notes',4000),
   'freight',(p.body->>'freight'),'discount',(p.body#>>'{totals,discount}'),'total',p.total::text,
   'items',(select coalesce(jsonb_agg(jsonb_build_object('position',i.position,'code',i.data->>'code','description',i.data->>'description','unit',i.data->>'unit',
     'quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),'discount_percent',i.discount_percent::text,'total',i.total::text) order by i.position),'[]'::jsonb)
    from erp_documents.item i where i.document_id=p.id)) order by p.n),'[]'::jsonb) into v_items from page p;
 return jsonb_build_object('kind',p_kind,'date_from',p_date_from,'date_to',p_date_to,'page',p_page,'size',v_size,'total_count',v_count,
  'has_more',p_page*v_size<v_count,'items',v_items,'data_mode','erp_native','operational_effects',false);
end $$;

create or replace function public.erp_document_history(p_user_id uuid,p_kind text,p_contact_id uuid,p_product_id uuid default null,
 p_query text default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_fiscal boolean; v_purchase boolean; v_query text; v_items jsonb; v_count integer; v_finance jsonb;
 v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 v_fiscal:=v_role in('admin','fiscal');
 v_purchase:=p_kind='purchase_orders';
 if p_limit is null or p_limit not between 1 and 50 or (not v_purchase and p_contact_id is null) or (v_purchase and p_product_id is null)
  or length(p_query)>120 or p_query~'[[:cntrl:]]' then
  raise exception 'erp_document_history_invalid' using errcode='22023'; end if;
 -- 238: the history of a contact the user does not see is refused; the purchases of a product keep only the visible fornecedores.
 if p_contact_id is not null and not erp_catalog.contact_visible_to(v_scope,p_contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 v_query:=lower(nullif(btrim(p_query),''));
 with lines as (
  select case when v_purchase then 'purchase' else 'sale' end as type,d.id as document_id,d.number::bigint as num,(d.body->>'date')::date as day,i.position,
   coalesce(i.data->>'description','') as description,nullif(i.data->>'code','') as code,i.product_id,coalesce(i.data->>'unit','') as unit,
   i.quantity::numeric(24,6) as quantity,i.unit_price
  from erp_documents.document d join erp_documents.item i on i.document_id=d.id
  where d.kind=case when v_purchase then 'purchase_orders' else 'sales_orders' end and d.status<>'cancelled'
   and (p_contact_id is null or d.contact_id=p_contact_id) and (p_product_id is null or i.product_id=p_product_id) and erp_catalog.contact_visible_to(v_scope,d.contact_id)
  union all
  select 'invoice',v.id,v.number::bigint,v.issue_date,t.position,coalesce(t.data->>'description',''),nullif(t.data->>'code',''),t.product_id,
   coalesce(t.data->>'unit',''),t.quantity::numeric(24,6),t.unit_price
  from erp_fiscal_invoices.invoice v join erp_fiscal_invoices.invoice_item t on t.invoice_id=v.id
  where v_fiscal and v.deleted_at is null and v.number is not null and v.direction=case when v_purchase then '0' else '1' end
   and v.status in(6,7,8) and (v_purchase or v.status in(6,7))
   and (p_contact_id is null or v.recipient->>'contact_id'=p_contact_id::text) and (p_product_id is null or t.product_id=p_product_id)
   and (v_scope is null or exists(select 1 from erp_catalog.contact_profile cp where cp.record_id::text=v.recipient->>'contact_id' and cp.seller_id=v_scope))
 ), found as (
  select * from lines l where v_query is null or strpos(lower(l.description),v_query)>0 or strpos(lower(coalesce(l.code,'')),v_query)>0
 ), page as (
  select * from found order by day desc,num desc,position limit p_limit+1
 )
 select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('type',type,'document_id',document_id,'number',num::text,'date',day::text,'position',position,
   'description',left(description,200),'code',left(code,100),'product_id',product_id,'unit',left(unit,16),'quantity',quantity::text,
   'unit_price',erp_catalog.unit_price_numeric(unit_price,14)) order by day desc,num desc,position) filter (where rn<=p_limit),'[]'::jsonb)
 into v_count,v_items
 from (select p.*,row_number() over(order by day desc,num desc,position) rn from page p) ranked;
 if not v_purchase and p_product_id is null then
  select jsonb_build_object('open_count',count(*),'open_amount',(coalesce(sum(t.amount_cents-t.settled_cents),0)/100.0)::numeric(18,2)::text,
   'overdue_amount',(coalesce(sum(t.amount_cents-t.settled_cents) filter (where t.due_on<v_today),0)/100.0)::numeric(18,2)::text,
   'titles',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'due_on',o.due_on::text,'description',left(o.description,200),
     'installment',o.installment,'installments',o.installments,'amount',(o.amount_cents/100.0)::numeric(18,2)::text,
     'open_amount',((o.amount_cents-o.settled_cents)/100.0)::numeric(18,2)::text) order by o.due_on,o.id)
    from (select * from erp_finance.title x where x.kind='receivable' and x.contact_id=p_contact_id and not x.cancelled and x.deleted_at is null
     and x.settled_cents<x.amount_cents order by x.due_on,x.id limit 20) o),'[]'::jsonb))
  into v_finance
  from erp_finance.title t where t.kind='receivable' and t.contact_id=p_contact_id and not t.cancelled and t.deleted_at is null and t.settled_cents<t.amount_cents;
 end if;
 return jsonb_build_object('kind',p_kind,'contact_id',p_contact_id,'product_id',p_product_id,'items',v_items,'has_more',v_count>p_limit,
  'invoices_included',v_fiscal,'finance',v_finance,'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function erp_documents.auto_products(uuid,text,uuid,jsonb),erp_documents.contact_usable(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_get(uuid,text,uuid),
 public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid),
 public.erp_document_export(uuid,text,text,text,integer),public.erp_document_history(uuid,text,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.erp_document_get(uuid,text,uuid),
 public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid),
 public.erp_document_export(uuid,text,text,text,integer),public.erp_document_history(uuid,text,uuid,uuid,text,integer) to service_role;
commit;
