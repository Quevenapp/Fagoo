-- 168: Categoria e Transportador do cadastro nos documentos (onda C).
-- * Categoria (Cadastros › Categorias financeiras): category_id no corpo do pedido de venda e da OS (categoria de receita) e do
--   pedido de compra (categoria de despesa); a proposta não tem categoria. Conferida na gravação quando nova ou trocada (ativa,
--   não excluída, do tipo certo). O Lançar contas sem categoria escolhida na conferência usa a categoria do documento e, sem
--   ela (ou se ela não puder mais ser usada), a categoria padrão de 165; as ações das transições (163) também.
-- * Transportador (Clientes e fornecedores): carrier_id no corpo de pedidos de venda, propostas e pedidos de compra, conferido
--   na gravação quando novo ou trocado (contato ativo). A referência Origin do transportador continua como estava. A pendência
--   "O campo Transportador é obrigatório…" (164) aceita o transportador do cadastro, e o filtro Transportador da listagem de
--   pedidos de venda procura também pelo nome do transportador do cadastro (a coluna Transportador mostra esse nome).
-- * "Editar contato" (lápis do formulário): a gravação com refresh_contact=true leva os dados atuais do contato ao documento
--   (sem ele, o retrato do contato salvo continua o mesmo enquanto o contato não for trocado).
-- * Preferências › Serviços "Data base da garantia": o filtro Garantia da listagem de OS conta os dias de garantia a partir da data
--   escolhida (OS, prevista, conclusão ou saída); "Não utilizar" mantém a regra de 102 (data de saída, senão a da OS).
-- * A leitura do documento traz category_name e carrier_name; a clonagem mantém categoria e transportador que ainda podem ser
--   escolhidos. GET das categorias do tipo para o seletor (erp_document_categories), para quem lê o documento.
-- Nenhum lançamento é feito sozinho. Requer 163, 164 e 165.
begin;

create or replace function erp_documents.extension_keys() returns text[]
language sql immutable set search_path=pg_catalog as $$
 select array['ship_date','finish_date','start_time','end_time','customer_po_number','quote_requested','quoted','warranty_days',
  'warranty_months','warranty_info','reception_notes','template_name','delivery_address','order_reference','seller_id',
  'category_id','carrier_id']
$$;
-- 164 plus category_id and carrier_id (ids; whether they can be used is checked by the save).
create or replace function erp_documents.extension_data(p_body jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v_result jsonb:='{}'; v jsonb; k text;
begin
 foreach k in array erp_documents.extension_keys() loop
  if not p_body?k then continue; end if;
  v:=p_body->k;
  if k in('ship_date','finish_date') then v:=to_jsonb(erp_documents.date_value(v));
  elsif k in('start_time','end_time') then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'erp_document_time_invalid' using errcode='22023'; end if;
  elsif k in('quote_requested','quoted') then
   if v<>'null'::jsonb and jsonb_typeof(v)<>'boolean' then raise exception 'erp_document_flag_invalid' using errcode='22023'; end if;
  elsif k='warranty_days' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^(0|[1-9][0-9]{0,3})$') then
    raise exception 'erp_document_warranty_invalid' using errcode='22023'; end if;
  elsif k='warranty_months' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^(0|[1-9][0-9]{0,2})$') then
    raise exception 'erp_document_warranty_invalid' using errcode='22023'; end if;
  elsif k='customer_po_number' then v:=to_jsonb(erp_documents.text_value(v,60));
  elsif k='template_name' then v:=to_jsonb(erp_documents.text_value(v,120));
  elsif k='order_reference' then v:=to_jsonb(erp_documents.text_value(v,100));
  elsif k in('warranty_info','reception_notes') then v:=to_jsonb(erp_documents.text_value(v,4000,false,true));
  elsif k='delivery_address' then v:=erp_documents.delivery_address(v);
  elsif k in('seller_id','category_id','carrier_id') then v:=to_jsonb(erp_documents.uuid_value(v));
  end if;
  v_result:=v_result||jsonb_build_object(k,coalesce(v,'null'::jsonb));
 end loop;
 return v_result;
end $$;

-- Whether a categoria can be chosen for the kind (receita for vendas and OS, despesa for compras; never in propostas).
create function erp_documents.category_usable(p_kind text,p_id text) returns boolean language sql stable set search_path=pg_catalog as $$
 select p_kind in('sales_orders','purchase_orders','service_orders') and p_id is not null
  and exists(select 1 from erp_finance.category c where c.id::text=p_id and c.active and c.deleted_at is null
   and c.kind=case when p_kind='purchase_orders' then 'payable' else 'receivable' end)
$$;
create function erp_documents.carrier_usable(p_id text) returns boolean language sql stable set search_path=pg_catalog as $$
 select p_id is not null and exists(select 1 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id::text=p_id and r.active)
$$;
-- Like the vendedor: a new or changed link must be usable; a link already saved that became inactive stays.
create function erp_documents.check_links(p_kind text,p_data jsonb,p_before jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_kind='sales_proposals' and p_data->>'category_id' is not null then raise exception 'erp_document_category_invalid' using errcode='22023'; end if;
 if p_data->>'category_id' is not null and (p_before is null or p_before->>'category_id' is distinct from p_data->>'category_id')
  and not erp_documents.category_usable(p_kind,p_data->>'category_id') then
  raise exception 'erp_document_category_unavailable' using errcode='22023'; end if;
 if p_data->>'carrier_id' is not null and (p_before is null or p_before->>'carrier_id' is distinct from p_data->>'carrier_id')
  and not erp_documents.carrier_usable(p_data->>'carrier_id') then
  raise exception 'erp_document_carrier_unavailable' using errcode='22023'; end if;
end $$;

-- 164 plus the categoria and the transportador.
create or replace function public.erp_document_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_data jsonb; v_row erp_documents.document%rowtype; v_id uuid;
 v_contact uuid; v_warehouse uuid; v_snapshot jsonb; v_before jsonb; v_result jsonb; v_body jsonb; v_number bigint; v_seller uuid; v_refresh boolean:=false;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_expected_version is null or (p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version<1) then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','save','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,'body',p_body)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 if p_body is null or jsonb_typeof(p_body)<>'object' then raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 v_body:=p_body;
 if p_body?'number' then
  if jsonb_typeof(p_body->'number')<>'string' or p_body->>'number'!~'^[1-9][0-9]{0,9}$' then raise exception 'erp_document_number_invalid' using errcode='22023'; end if;
  v_number:=(p_body->>'number')::bigint; v_body:=p_body-'number';
 end if;
 if v_body?'refresh_contact' then
  if v_body->'refresh_contact'<>'true'::jsonb then raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
  v_refresh:=true; v_body:=v_body-'refresh_contact';
 end if;
 v_data:=erp_documents.normalize(p_kind,v_body); v_contact:=(v_data->>'contact_id')::uuid; v_warehouse:=(v_data->>'warehouse_id')::uuid; v_seller:=(v_data->>'seller_id')::uuid;
 v_data:=jsonb_set(v_data,'{items}',erp_documents.auto_products(p_user_id,p_kind,p_command_id,v_data->'items'));
 perform erp_documents.check_preference_rules(p_kind,v_data);
 perform erp_documents.check_seller_rules(p_user_id,p_kind,v_data);
 if p_id is not null then
  select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
  if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  if not erp_documents.editable(v_row.status) then raise exception 'erp_document_state_locked' using errcode='40001'; end if;
  v_before:=erp_documents.dto(p_id);
  perform erp_documents.require_commercial_input(v_before,v_body);
  if v_number=v_row.number then v_number:=null; end if;
 end if;
 if v_seller is not null and (p_id is null or v_row.body->>'seller_id' is distinct from v_seller::text) then perform erp_documents.require_seller(v_seller); end if;
 perform erp_documents.check_links(p_kind,v_data,case when p_id is not null then v_row.body end);
 if v_number is not null then
  -- Same lock as erp_documents.next_number: a free number and the automatic sequence never collide.
  perform 1 from erp_documents.numbering where kind=p_kind for update;
  if not erp_documents.number_editable(p_kind) then raise exception 'erp_document_number_locked' using errcode='22023'; end if;
  if exists(select 1 from erp_documents.document where kind=p_kind and number=v_number) then
   -- Origin: a number already used becomes the next free number (new document) or stays the current one (edit).
   v_number:=null;
  else
   update erp_documents.numbering set last_number=greatest(last_number,v_number) where kind=p_kind;
  end if;
 end if;
 if p_id is not null and v_row.contact_id=v_contact and not v_refresh then v_snapshot:=v_row.contact_snapshot;
 else
  select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=v_contact and r.active;
  if not found then raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 end if;
 if v_warehouse is not null and (p_id is null or v_row.warehouse_id is distinct from v_warehouse)
  and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=v_warehouse and r.active) then
  raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 if p_id is null then
  insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
  values(p_kind,coalesce(v_number,erp_documents.next_number(p_kind)),erp_documents.initial_status(p_kind),
   v_contact,v_warehouse,v_snapshot,v_data-'items',(v_data#>>'{totals,total}')::numeric,p_user_id,p_user_id) returning id into v_id;
 else
  v_id:=p_id;
  update erp_documents.document set version=version+1,contact_id=v_contact,warehouse_id=v_warehouse,contact_snapshot=v_snapshot,number=coalesce(v_number,number),
   body=v_data-'items',total=(v_data#>>'{totals,total}')::numeric,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 end if;
 perform erp_documents.replace_items(v_id,v_data->'items');
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,v_id,case when p_id is null then 'create' else 'edit' end,v_before,erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 164 plus the categoria and the transportador.
create or replace function public.erp_document_copy(p_user_id uuid,p_kind text,p_source_id uuid,p_expected_source_version integer,p_command_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_source erp_documents.document%rowtype; v_hash text; v_replay jsonb; v_data jsonb; v_items jsonb;
 v_contact uuid; v_warehouse uuid; v_refs uuid[]; v_snapshot jsonb; v_id uuid; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_source_id is null or p_expected_source_version is null or p_expected_source_version<1 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','copy_document','actor',p_user_id,'kind',p_kind,'source',p_source_id,
  'source_version',p_expected_source_version,'body',p_body)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash);
 if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind for share;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_source_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_data:=erp_documents.normalize(p_kind,p_body);
 perform erp_documents.require_commercial_input(erp_documents.dto(p_source_id),p_body);
 perform erp_documents.check_preference_rules(p_kind,v_data);
 perform erp_documents.check_seller_rules(p_user_id,p_kind,v_data);
 perform erp_documents.require_seller((v_data->>'seller_id')::uuid);
 perform erp_documents.check_links(p_kind,v_data,null);
 v_contact:=(v_data->>'contact_id')::uuid;v_warehouse:=(v_data->>'warehouse_id')::uuid;
 select array_agg(distinct id) into v_refs from (
  select v_contact id union all select v_warehouse union all
  select (value->>'product_id')::uuid from jsonb_array_elements(v_data->'items')) refs where id is not null;
 perform r.id from erp_catalog.record r where r.id=any(v_refs) order by r.id for share;
 select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id
  where r.id=v_contact and r.active;
 if not found then raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 if v_warehouse is not null and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=v_warehouse and r.active) then
  raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(v_data->'items') i where i->>'product_id' is not null and not exists(
  select 1 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=(i->>'product_id')::uuid and r.active)) then
  raise exception 'erp_document_product_unavailable' using errcode='22023'; end if;
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
 values(p_kind,erp_documents.next_number(p_kind),erp_documents.initial_status(p_kind),
  v_contact,v_warehouse,v_snapshot,v_data-'items',(v_data#>>'{totals,total}')::numeric,p_user_id,p_user_id) returning id into v_id;
 select coalesce(jsonb_agg(value||'{"id":null}'::jsonb order by position),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_data->'items') with ordinality as lines(value,position);
 perform erp_documents.replace_items(v_id,v_items);
 insert into erp_documents.copy_source(destination_id,source_id,source_kind,source_number,source_version,actor,command_id)
  values(v_id,p_source_id,p_kind,v_source.number,p_expected_source_version,p_user_id,p_command_id);
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(v_id),'copy_source',erp_documents.copy_source_dto(v_id),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,v_id,'create_from_copy',jsonb_build_object('copy_source',erp_documents.copy_source_dto(v_id)),erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 164 keeping the categoria and the transportador.
create or replace function public.erp_document_copy_preview(p_user_id uuid,p_kind text,p_source_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_source erp_documents.document%rowtype; v_data jsonb; v_items jsonb; field text; v_keep_date boolean;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 v_keep_date:=p_kind='purchase_orders' and erp_documents.preference('compras.clonagem_data')='"data_original"'::jsonb;
 select coalesce(jsonb_agg(jsonb_build_object('id',null,'product_id',i.product_id,'description',i.data->'description',
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),
  'discount_percent',i.discount_percent::text)
  ||case when i.data?'detailed_description' then jsonb_build_object('detailed_description',i.data->'detailed_description') else '{}'::jsonb end order by i.position),'[]'::jsonb) into v_items
  from erp_documents.item i where i.document_id=p_source_id;
 v_data:=jsonb_build_object('date',case when v_keep_date then (v_source.body->>'date')::date else (clock_timestamp() at time zone 'America/Sao_Paulo')::date end,
  'contact_id',v_source.contact_id,'warehouse_id',v_source.warehouse_id,'expected_date',case when v_keep_date then (v_source.body->>'expected_date')::date end,'valid_until',null,
  'next_contact',null,'template',false,'items',v_items,'installments','[]'::jsonb,
  'equipment',null,'serial_number',null,'technician',null,'defect',null,'solution',null);
 foreach field in array array['discount_mode','discount_value','freight','other_expenses','payment_terms','delivery_terms','notes','internal_notes'] loop
  v_data:=v_data||jsonb_build_object(field,v_source.body->field);
 end loop;
 if p_kind<>'purchase_orders' and v_source.body->>'seller_id' is not null then v_data:=v_data||jsonb_build_object('seller_id',v_source.body->'seller_id'); end if;
 -- 168: the copy keeps the categoria and the transportador while they can still be chosen.
 if erp_documents.category_usable(p_kind,v_source.body->>'category_id') then v_data:=v_data||jsonb_build_object('category_id',v_source.body->'category_id'); end if;
 if erp_documents.carrier_usable(v_source.body->>'carrier_id') then v_data:=v_data||jsonb_build_object('carrier_id',v_source.body->'carrier_id'); end if;
 if erp_documents.has_commercial_data(erp_documents.dto(p_source_id)) then
  select coalesce(jsonb_agg(value||jsonb_build_object('detailed_description',value->'detailed_description') order by ordinality),'[]'::jsonb) into v_items
   from jsonb_array_elements(v_items) with ordinality;
  v_data:=v_data||jsonb_build_object('commercial',v_source.body->'commercial','items',v_items);
 elsif v_source.body?'commercial' then
  v_data:=v_data||jsonb_build_object('commercial',v_source.body->'commercial');
 end if;
 return jsonb_build_object('source',jsonb_build_object('id',v_source.id,'kind',v_source.kind,'number',v_source.number::text,'version',v_source.version),
  'data',v_data,'reset_fields',case when v_keep_date then jsonb_build_array('valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution')
   else jsonb_build_array('date','expected_date','valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution') end,
  'persisted',false,'data_mode','erp_native','operational_effects',false);
end $$;

-- 164: the transportador of the cadastro also satisfies "O campo Transportador é obrigatório…".
create or replace function erp_documents.pendencies(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 with d as (select * from erp_documents.document where id=p_id and kind='sales_orders'),
 c as (select k.*,cp.taxpayer,coalesce(cp.ie_exempt,false) ie_exempt from d join erp_catalog.contact k on k.record_id=d.contact_id left join erp_catalog.contact_profile cp on cp.record_id=k.record_id),
 checks as (
  select 1 o,'Cliente' section,'O campo CPF/CNPJ é obrigatório' message from c where coalesce(c.person_type,'')<>'E' and nullif(btrim(c.document),'') is null
  union all select 2,'Cliente','O CPF/CNPJ informado é inválido' from c where coalesce(c.person_type,'')<>'E' and nullif(btrim(c.document),'') is not null
   and not erp_catalog.valid_cpf(regexp_replace(c.document,'[^0-9]','','g')) and not erp_catalog.valid_cnpj(regexp_replace(c.document,'[^0-9]','','g'))
  union all select 3,'Cliente','O campo Inscrição Estadual é obrigatório para contribuinte do ICMS' from c where c.taxpayer='1' and nullif(btrim(coalesce(c.ie,'')),'') is null and not c.ie_exempt
  union all select 4,'Cliente','O campo Endereço é obrigatório' from c where nullif(btrim(c.street),'') is null
  union all select 5,'Cliente','O campo Número é obrigatório' from c where nullif(btrim(c.number),'') is null
  union all select 6,'Cliente','O campo Bairro é obrigatório' from c where nullif(btrim(c.district),'') is null
  union all select 7,'Cliente','O campo Cidade é obrigatório' from c where nullif(btrim(c.city),'') is null
  union all select 8,'Cliente','O campo UF é obrigatório' from c where nullif(btrim(c.state),'') is null
  union all select 9,'Cliente','A UF informada é inválida' from c where nullif(btrim(c.state),'') is not null
   and upper(btrim(c.state))!~'^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$'
  union all select 10,'Cliente','O campo CEP é obrigatório' from c where coalesce(c.person_type,'')<>'E' and regexp_replace(coalesce(c.postal_code,''),'[^0-9]','','g')!~'^[0-9]{8}$'
  union all select 50,'Transportador','O campo Transportador é obrigatório para o frete por conta do destinatário ou de terceiros' from d
   where d.body#>>'{commercial,transport,freight_mode}' in('1','2') and coalesce(d.body#>'{commercial,transport,carrier_reference}','null'::jsonb)='null'::jsonb
   and d.body->>'carrier_id' is null
  union all select 100+i.position,'Produto '||(i.data->>'description'),'O item não está vinculado a um produto cadastrado'
   from d join erp_documents.item i on i.document_id=d.id where i.product_id is null
  union all select 100+i.position,'Produto '||(i.data->>'description'),m.message
   from d join erp_documents.item i on i.document_id=d.id join erp_catalog.product p on p.record_id=i.product_id
   cross join lateral (values (p.ncm is null or p.ncm!~'^[0-9]{8}$','O campo NCM é obrigatório'),(p.origin is null,'O campo Origem é obrigatório'),
    (nullif(btrim(coalesce(i.data->>'unit','')),'') is null,'O campo Unidade é obrigatório')) m(missing,message) where m.missing
 )
 select coalesce(jsonb_agg(jsonb_build_object('section',section,'message',message) order by o,message),'[]'::jsonb) from checks
$$;

-- 163 plus the names of the categoria and of the transportador.
create or replace function erp_documents.document_view(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_documents.dto(p_id)||jsonb_build_object('situation',erp_documents.document_situation_json(p_id),
  'seller_name',(select left(r.name,200) from erp_documents.document d join erp_catalog.seller s on s.id::text=d.body->>'seller_id' join erp_catalog.record r on r.id=s.contact_id where d.id=p_id),
  'category_name',(select left(c.name,200) from erp_documents.document d join erp_finance.category c on c.id::text=d.body->>'category_id' where d.id=p_id),
  'carrier_name',(select left(r.name,200) from erp_documents.document d join erp_catalog.record r on r.id::text=d.body->>'carrier_id' where d.id=p_id))
$$;

-- The categoria of the contas: the chosen one, else the categoria of the document (while usable), else the padrão of 165.
create function erp_documents.document_finance_category(d erp_documents.document,p_category uuid) returns uuid language sql stable set search_path=pg_catalog as $$
 select coalesce(p_category,case when erp_documents.category_usable(d.kind,d.body->>'category_id') then (d.body->>'category_id')::uuid end,
  erp_documents.finance_category(d.kind,null))
$$;

-- 165 with the categoria of the document.
create or replace function public.erp_document_finance_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_category_id uuid default null,p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_finance.document_preview_data(d,erp_documents.document_finance_category(d,p_category_id),p_plan),'data_mode','erp_native','cash_movement_performed',false);
end $$;
create or replace function public.erp_document_finance_post(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,p_preview_hash text,p_category_id uuid default null,p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;pid uuid;gid uuid:=gen_random_uuid();tid uuid;part jsonb;label text;result jsonb;before_doc jsonb;v_category uuid;begin
 -- The command keeps the category as requested, so a replay of an older command still matches.
 data:=jsonb_build_object('kind',p_kind,'document_id',p_document_id,'version',p_expected_version,'preview_hash',p_preview_hash,'category_id',p_category_id,'plan',p_plan);
 replay:=erp_finance.document_command_start(p_user_id,p_command_id,'post',data);if replay is not null then return replay;end if;
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 v_category:=erp_documents.document_finance_category(d,p_category_id);
 preview:=erp_finance.document_preview_data(d,v_category,p_plan);
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_finance_preview_conflict' using errcode='40001';end if;
 before_doc:=erp_documents.dto(d.id);
 insert into erp_finance.document_posting(document_id,document_version,group_id,snapshot,preview_hash,actor,command_id)
 values(d.id,d.version,gid,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id) returning id into pid;
 label:=case d.kind when 'sales_orders' then 'Pedido de venda' when 'purchase_orders' then 'Pedido de compra' else 'Ordem de serviço' end||' nº '||d.number::text;
 for part in select value from jsonb_array_elements(preview->'installments') loop
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,amount_cents)
  values(gid,(part->>'position')::integer,jsonb_array_length(preview->'installments'),preview->>'direction',d.contact_id,v_category,label,
   (preview->>'issued_on')::date,(part->>'due_on')::date,(part->>'amount_cents')::bigint) returning id into tid;
  insert into erp_finance.document_title(title_id,posting_id,position)values(tid,pid,(part->>'position')::integer);
 end loop;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_finance.document_posting_summary(pid),'titles',erp_finance.document_title_rows(pid));
 insert into erp_finance.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'document_post',null,result);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)values(p_user_id,p_command_id,d.id,'finance_post',before_doc,result);
 return erp_finance.document_command_finish(p_user_id,p_command_id,'post',data,result);
end $$;

-- 163: "Lançar contas" of a transition uses the categoria of the document before the padrão.
create or replace function erp_documents.transition_action(p_user_id uuid,p_kind text,p_id uuid,p_command uuid,p_action text,p_label text) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare v_posting record; v_preview jsonb; v_day date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_reason text; v_category uuid; v_result jsonb; v_titles jsonb;
begin
 v_reason:=left(case when p_action like 'reverse_%' then 'Estorno pela mudança de situação para ' else 'Lançamento pela mudança de situação para ' end||p_label,500);
 if p_action='reverse_stock' then
  select id,version into v_posting from erp_stock.document_posting where document_id=p_id and state='active';
  if v_posting.id is null then return jsonb_build_object('action',p_action,'outcome','skipped'); end if;
  v_preview:=public.erp_document_stock_reverse_preview(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_posting.id,v_posting.version,v_day,v_reason)->'preview';
  v_result:=public.erp_document_stock_reverse(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_posting.id,v_posting.version,erp_documents.transition_command(p_command,p_action),
   v_preview->>'preview_hash',v_day,v_reason);
  return jsonb_build_object('action',p_action,'outcome','done','posting_id',v_posting.id);
 elsif p_action='reverse_finance' then
  select id,version into v_posting from erp_finance.document_posting where document_id=p_id and state='active';
  if v_posting.id is null then return jsonb_build_object('action',p_action,'outcome','skipped'); end if;
  v_preview:=public.erp_document_finance_reverse_preview(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_posting.id,v_posting.version)->'preview';
  select coalesce(jsonb_agg(jsonb_build_object('id',t->>'id','version',(t->>'version')::integer)),'[]'::jsonb) into v_titles from jsonb_array_elements(v_preview->'titles') t;
  v_result:=public.erp_document_finance_reverse(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_posting.id,v_posting.version,erp_documents.transition_command(p_command,p_action),
   v_preview->>'preview_hash',v_titles,v_reason);
  return jsonb_build_object('action',p_action,'outcome','done','posting_id',v_posting.id);
 elsif p_action='post_stock' then
  if exists(select 1 from erp_stock.document_posting where document_id=p_id and state='active') then return jsonb_build_object('action',p_action,'outcome','skipped'); end if;
  v_day:=erp_documents.stock_launch_date(p_id);
  v_preview:=public.erp_document_stock_preview(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_day,v_reason)->'preview';
  v_result:=public.erp_document_stock_post(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),erp_documents.transition_command(p_command,p_action),
   v_preview->>'preview_hash',v_day,v_reason,coalesce((select jsonb_agg(i->'id') from jsonb_array_elements(v_preview->'ignored') i),'[]'::jsonb));
  return jsonb_build_object('action',p_action,'outcome','done','posting_id',v_result#>>'{posting,id}');
 elsif p_action='post_finance' then
  if exists(select 1 from erp_finance.document_posting where document_id=p_id and state='active') then return jsonb_build_object('action',p_action,'outcome','skipped'); end if;
  select erp_documents.document_finance_category(d,null) into v_category from erp_documents.document d where d.id=p_id;
  if v_category is null then raise exception 'erp_document_transition_category_required' using errcode='22023'; end if;
  v_preview:=public.erp_document_finance_preview(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_category,null)->'preview';
  v_result:=public.erp_document_finance_post(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),erp_documents.transition_command(p_command,p_action),v_preview->>'preview_hash',v_category,null);
  return jsonb_build_object('action',p_action,'outcome','done','posting_id',v_result#>>'{posting,id}');
 end if;
 raise exception 'erp_document_transition_action_invalid' using errcode='22023';
end $$;

-- Preferências › Serviços "Data base da garantia": the date the garantia (dias) counts from; "Não utilizar" keeps the rule of 102
-- (data de saída, else the date of the OS).
create function erp_documents.warranty_until(p_body jsonb,p_base text) returns date language sql immutable set search_path=pg_catalog as $$
 select case when p_body->>'warranty_days' is null then null else (case p_base when 'data_os' then p_body->>'date'
   when 'data_prevista' then coalesce(p_body->>'expected_date',p_body->>'date') when 'data_conclusao' then coalesce(p_body->>'finish_date',p_body->>'date')
   else coalesce(p_body->>'ship_date',p_body->>'date') end)::date+(p_body->>'warranty_days')::integer end
$$;

-- 163: the Transportador column shows the transportador of the cadastro, else the Origin reference.
create or replace function erp_documents.list_row(p_id uuid,p_fiscal boolean,p_stock boolean)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'date',d.body->>'date','expected_date',d.body->>'expected_date','next_contact',d.body->>'next_contact',
  'template',coalesce(d.body->'template'='true'::jsonb,false),
  'total',d.total::text,'contact_id',d.contact_id,'contact_name',d.contact_snapshot->>'name',
  'warehouse_id',d.warehouse_id,'warehouse_name',case when p_stock then w.name end,
  'source_proposal_id',d.source_proposal_id,'source_proposal_number',p.number::text,
  'finance_active',exists(select 1 from erp_finance.document_posting f where f.document_id=d.id and f.state='active'),
  'stock_active',exists(select 1 from erp_stock.document_posting s where s.document_id=d.id and s.state='active'),
  'receipt_active',d.kind='purchase_orders' and erp_purchase_receipts.active(d.id),
  'reservation_active',case when p_stock then d.kind='sales_orders' and exists(select 1 from erp_stock.reservation r where r.document_id=d.id and r.state='active') end,
  'fiscal_draft',case when p_fiscal and d.kind='sales_orders' then exists(select 1 from erp_fiscal_drafts.draft x where x.source_document_id=d.id and x.status='draft') end,
  'internal_notes',left(d.body->>'internal_notes',280),
  'created_at',d.created_at,'updated_at',d.updated_at,
  'customer_po_number',d.body->>'customer_po_number','ship_date',d.body->>'ship_date',
  'contact_email',nullif(d.contact_snapshot->>'email',''),'contact_phone',coalesce(nullif(d.contact_snapshot->>'phone',''),nullif(d.contact_snapshot->>'mobile','')),
  'contact_document',nullif(d.contact_snapshot->>'document',''),
  'address',left(coalesce(erp_documents.address_text(nullif(d.body->'delivery_address','null'::jsonb)),erp_documents.address_text(d.contact_snapshot)),500),
  'carrier_name',coalesce((select left(r.name,200) from erp_catalog.record r where r.id::text=d.body->>'carrier_id'),left(nullif(d.body#>>'{commercial,transport,carrier_reference,label}',''),200)),
  'first_sale',d.kind='sales_orders' and d.status<>'cancelled' and not exists(select 1 from erp_documents.document o
    where o.kind='sales_orders' and o.contact_id=d.contact_id and o.status<>'cancelled' and o.id<>d.id
     and (o.body->>'date',o.number)<(d.body->>'date',d.number)),
  'invoice',case when p_fiscal and d.kind='sales_orders' then erp_documents.order_invoice(d.id) end,
  'pendencies',d.kind='sales_orders' and d.status<>'cancelled' and jsonb_array_length(erp_documents.pendencies(d.id))>0,
  'service_order_number',(select s.number::text from erp_documents.sales_service_link l join erp_documents.document s on s.id=l.service_order_id where l.sales_order_id=d.id),
  'template_name',case when d.kind='sales_proposals' then d.body->>'template_name' end,
  -- 163: situação of the Gerenciador de transições and whether a nota is linked (the menu rules of every profile).
  'situation',erp_documents.situation_json(d.kind,d.status,ds.situation_id),
  'invoice_linked',d.kind='sales_orders' and erp_documents.order_invoice(d.id) is not null,
  -- 164: native vendedor (Cadastros › Vendedores) of the document.
  'seller_id',case when d.body->>'seller_id'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then d.body->>'seller_id' end,
  'seller_name',(select left(r.name,200) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id::text=d.body->>'seller_id'))
 from erp_documents.document d
 left join erp_catalog.record w on w.id=d.warehouse_id
 left join erp_documents.document p on p.id=d.source_proposal_id
 left join erp_documents.document_situation ds on ds.document_id=d.id
 where d.id=p_id;
$$;

-- 163: the Transportador filter also finds the transportador of the cadastro by name (same signature).
create or replace function public.erp_document_list(
 p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null,p_status text default null,
 p_query text default null,p_date_from text default null,p_date_to text default null,
 p_page integer default null,p_order text default 'id',p_statuses text[] default null,p_date_type text default 'date',
 p_warehouse_id uuid default null,p_product_id uuid default null,p_city text default null,p_state text default null,
 p_technician text default null,p_equipment text default null,p_serial_number text default null,p_internal_note text default null,
 p_postal_code text default null,p_district text default null,p_tracking_code text default null,p_customer_po_number text default null,
 p_carrier text default null,p_contact_email text default null,p_template boolean default null,p_situations text[] default null,p_seller_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_fiscal boolean; v_stock boolean; v_statuses text[]; v_query text; v_digits text; v_from date; v_to date; v_offset bigint;
 v_cursor erp_documents.document%rowtype; v_cursor_day text; v_items jsonb; v_more boolean; v_last uuid; v_count bigint; v_amount numeric;
 v_city text; v_technician text; v_equipment text; v_serial text; v_note text;
 v_postal text; v_district text; v_tracking text; v_po text; v_carrier text; v_email text;
 v_warranty text:=coalesce(erp_documents.preference('os.garantia_base')#>>'{}','nao_utilizar');
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

-- Categorias for the seletor of the document (receita for vendas and OS, despesa for compras), in tree order, at most 500.
create function public.erp_document_categories(p_user_id uuid,p_kind text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_kind text; v_items jsonb; v_total integer; v_default jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_kind not in('sales_orders','purchase_orders','service_orders') then raise exception 'erp_document_category_invalid' using errcode='22023'; end if;
 v_kind:=case when p_kind='purchase_orders' then 'payable' else 'receivable' end;
 with recursive tree as (
  select c.id,c.parent_id,c.name,array[lower(c.name),c.id::text] path,1 depth,c.active and c.deleted_at is null visible
   from erp_finance.category c where c.parent_id is null and c.kind=v_kind
  union all
  select c.id,c.parent_id,c.name,t.path||array[lower(c.name),c.id::text],t.depth+1,c.active and c.deleted_at is null
   from erp_finance.category c join tree t on c.parent_id=t.id where c.kind=v_kind and t.depth<5
 ), shown as (select * from tree where visible)
 select (select count(*)::integer from shown),
  (select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',left(s.name,200),'parent_id',s.parent_id,'depth',s.depth) order by s.path),'[]'::jsonb)
    from (select * from shown order by path limit 500) s)
 into v_total,v_items;
 select jsonb_build_object('id',c.id,'name',left(c.name,200)) into v_default from erp_finance.category_default d join erp_finance.category c on c.id=d.category_id
  where d.key=case p_kind when 'sales_orders' then 'sale' when 'service_orders' then 'service' else 'purchase' end and c.active and c.deleted_at is null and c.kind=v_kind;
 return jsonb_build_object('kind',p_kind,'category_kind',v_kind,'items',v_items,'total_count',v_total,'default',v_default,'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function erp_documents.extension_keys(),erp_documents.extension_data(jsonb),erp_documents.category_usable(text,text),erp_documents.carrier_usable(text),
 erp_documents.check_links(text,jsonb,jsonb),erp_documents.warranty_until(jsonb,text),erp_documents.pendencies(uuid),erp_documents.document_view(uuid),erp_documents.list_row(uuid,boolean,boolean),
 erp_documents.document_finance_category(erp_documents.document,uuid),erp_documents.transition_action(uuid,text,uuid,uuid,text,text)
 from public,anon,authenticated,service_role;
revoke all on function public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb),
 public.erp_document_copy_preview(uuid,text,uuid),public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb),
 public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb),public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid),
 public.erp_document_categories(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb),
 public.erp_document_copy_preview(uuid,text,uuid),public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb),
 public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb),public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid),
 public.erp_document_categories(uuid,text) to service_role;
commit;
