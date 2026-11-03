-- 164: regras dos documentos que vêm das Preferências e dos Vendedores (onda C).
-- * Vendedor nativo (Cadastros › Vendedores): seller_id no corpo de pedidos, propostas e OS, conferido na gravação; "Vendedor
--   obrigatório" (Vendas, Propostas exceto modelos, OS). Usuário vinculado a um vendedor: sem "Permite incluir produtos não
--   cadastrados nos pedidos de venda" o pedido recusa item livre; com "Limite de desconto" (maior que 0) pedidos, propostas e
--   OS recusam desconto de item ou desconto total acima do limite.
-- * Preferências › Empresa: casas decimais do preço nas saídas (pedidos, propostas e OS) e nas entradas (pedidos de compra).
-- * Conversões (Gerar venda, Gerar ordem de serviço da proposta e do pedido) seguem as mesmas regras do documento gerado:
--   "Permite venda de produtos não cadastrados", "Permitir itens repetidos", vendedor obrigatório e casas decimais.
-- * Editar número: um número já usado não recusa mais o documento novo; ele recebe o próximo número livre da numeração
--   automática e a tela avisa "O número do seu pedido foi modificado para: N" (na edição o número atual fica).
-- * Preferências › Cadastros › Produtos "Cadastrar automaticamente produtos a partir de compras/vendas/ordens de serviço":
--   ligada, o item livre (sem produto) vira um produto do cadastro na mesma gravação (código, descrição, unidade e, nas
--   saídas, o preço), pela gravação do cadastro (erp_catalog_save, com auditoria própria). Um código igual ao de um produto
--   ativo liga o item a ele. Só para perfis que cadastram produtos (administrador e estoque); para os demais o item fica livre.
-- * Clonar pedido de compra com "Data do pedido clonado" também mantém a data prevista; a cópia mantém o vendedor.
-- * Pendências cadastrais: Inscrição Estadual do contribuinte do ICMS, UF inválida e transportador no frete por conta do
--   destinatário ou de terceiros. Cross-Docking (Preferências › Estoque) entra na data prevista calculada ao gerar venda.
-- * erp_document_access informa as configurações que as telas de documentos aplicam e o vendedor do usuário.
-- Nenhum efeito de estoque, financeiro ou fiscal é criado. Requer 008, 054, 057, 102, 115, 124, 126, 129, 131, 132 e 163.
begin;

create or replace function erp_documents.extension_keys() returns text[]
language sql immutable set search_path=pg_catalog as $$
 select array['ship_date','finish_date','start_time','end_time','customer_po_number','quote_requested','quoted','warranty_days',
  'warranty_months','warranty_info','reception_notes','template_name','delivery_address','order_reference','seller_id']
$$;
-- 129 plus seller_id (an id; whether it exists is checked by the save, which reads the registry).
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
  elsif k='seller_id' then v:=to_jsonb(erp_documents.uuid_value(v));
  end if;
  v_result:=v_result||jsonb_build_object(k,coalesce(v,'null'::jsonb));
 end loop;
 return v_result;
end $$;

-- Decimal places of a canonical unit price ("10.5000" has one).
create function erp_documents.price_decimals(p_price text) returns integer language sql immutable set search_path=pg_catalog as $$
 select coalesce(length(rtrim(split_part(p_price,'.',2),'0')),0)
$$;
-- 129 plus Vendedor obrigatório and the casas decimais of Preferências › Empresa.
create or replace function erp_documents.check_preference_rules(p_kind text,p_data jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare v_decimals integer;
begin
 if p_kind='sales_orders' and erp_documents.preference('vendas.produtos_nao_cadastrados')='false'::jsonb
  and exists(select 1 from jsonb_array_elements(p_data->'items') i where i->>'product_id' is null) then
  raise exception 'erp_document_product_required' using errcode='22023'; end if;
 if p_kind='service_orders' and erp_documents.preference('os.itens_repetidos')='false'::jsonb
  and exists(select 1 from jsonb_array_elements(p_data->'items') i where i->>'product_id' is not null group by i->>'product_id' having count(*)>1) then
  raise exception 'erp_document_item_repeated' using errcode='22023'; end if;
 if p_kind='sales_proposals' and erp_documents.preference('propostas.proximo_contato_obrigatorio')='true'::jsonb
  and not coalesce((p_data->>'template')::boolean,false) and p_data->>'next_contact' is null then
  raise exception 'erp_document_next_contact_required' using errcode='22023'; end if;
 if p_kind='purchase_orders' and p_data->>'seller_id' is not null then raise exception 'erp_document_seller_invalid' using errcode='22023'; end if;
 if p_data->>'seller_id' is null and ((p_kind='sales_orders' and erp_documents.preference('vendas.vendedor_obrigatorio')='true'::jsonb)
  or (p_kind='sales_proposals' and erp_documents.preference('propostas.vendedor_obrigatorio')='true'::jsonb and not coalesce((p_data->>'template')::boolean,false))
  or (p_kind='service_orders' and erp_documents.preference('os.vendedor_obrigatorio')='true'::jsonb)) then
  raise exception 'erp_document_seller_required' using errcode='22023'; end if;
 v_decimals:=coalesce((erp_documents.preference(case when p_kind='purchase_orders' then 'empresa.decimais_preco_entrada' else 'empresa.decimais_preco_saida' end)#>>'{}')::integer,10);
 if exists(select 1 from jsonb_array_elements(p_data->'items') i where erp_documents.price_decimals(i->>'unit_price')>v_decimals) then
  raise exception 'erp_document_price_decimals' using errcode='22023'; end if;
end $$;
-- The vendedor linked to the user (Cadastros › Vendedores › Usuário do sistema): unregistered products and the discount limit.
create function erp_documents.check_seller_rules(p_user_id uuid,p_kind text,p_data jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare s erp_catalog.seller%rowtype; v_gross numeric; v_discount numeric;
begin
 if p_kind not in('sales_orders','sales_proposals','service_orders') then return; end if;
 select * into s from erp_catalog.seller where user_id=p_user_id;
 if not found then return; end if;
 if p_kind='sales_orders' and not s.allow_unregistered_products and exists(select 1 from jsonb_array_elements(p_data->'items') i where i->>'product_id' is null) then
  raise exception 'erp_document_seller_product_required' using errcode='22023'; end if;
 if s.discount_limit>0 then
  v_gross:=(p_data#>>'{totals,gross}')::numeric; v_discount:=(p_data#>>'{totals,line_discount}')::numeric+(p_data#>>'{totals,discount}')::numeric;
  if exists(select 1 from jsonb_array_elements(p_data->'items') i where (i->>'discount_percent')::numeric>s.discount_limit)
   or (v_gross>0 and v_discount*100>s.discount_limit*v_gross) then
   raise exception 'erp_document_seller_discount_limit' using errcode='22023'; end if;
 end if;
end $$;
-- A vendedor chosen (or changed) in the document must exist with an active contact.
create function erp_documents.require_seller(p_seller uuid) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_seller is not null and not exists(select 1 from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id=p_seller and r.active) then
  raise exception 'erp_document_seller_unavailable' using errcode='22023'; end if;
end $$;
-- What the rules read from a saved document (conversions copy it as it is).
create function erp_documents.stored_rules_data(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',i.product_id,'unit_price',i.data->>'unit_price','discount_percent',i.data->>'discount_percent') order by i.position),'[]'::jsonb)
   from erp_documents.item i where i.document_id=d.id),'seller_id',d.body->>'seller_id','template',false,'next_contact',d.body->>'next_contact')
 from erp_documents.document d where d.id=p_id
$$;

-- Preferências › Cadastros › Produtos "Cadastrar automaticamente produtos a partir de …": each free item becomes (or is
-- linked to) a product through the catalog save, with a command derived from the document command.
create function erp_documents.auto_product_key(p_kind text) returns text language sql immutable set search_path=pg_catalog as $$
 select case p_kind when 'purchase_orders' then 'produtos.cadastro_auto_compras' when 'service_orders' then 'produtos.cadastro_auto_os' else 'produtos.cadastro_auto_vendas' end
$$;
create function erp_documents.auto_products(p_user_id uuid,p_kind text,p_command uuid,p_items jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare v_role text; v_item jsonb; v_out jsonb:='[]'; v_id uuid; v_saved jsonb;
begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if erp_documents.preference(erp_documents.auto_product_key(p_kind)) is distinct from 'true'::jsonb or not erp_catalog.allowed(v_role,'products',true)
  or not exists(select 1 from jsonb_array_elements(p_items) i where i->>'product_id' is null) then return p_items; end if;
 for v_item in select value from jsonb_array_elements(p_items) loop
  if v_item->>'product_id' is null then
   v_id:=null;
   if nullif(btrim(coalesce(v_item->>'code','')),'') is not null then
    select r.id into v_id from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id
     where r.entity='products' and r.active and lower(r.code)=lower(btrim(v_item->>'code')) order by r.created_at,r.id limit 1;
   end if;
   if v_id is null then
    v_saved:=public.erp_catalog_save(p_user_id,'products',null,0,md5('document-auto-product:'||p_command::text||':'||(v_item->>'position'))::uuid,
     jsonb_build_object('name',v_item->>'description','code',nullif(btrim(coalesce(v_item->>'code','')),''),'unit',v_item->>'unit','kind','P','format','S',
      'price',case when p_kind='purchase_orders' then null else v_item->>'unit_price' end));
    v_id:=(v_saved#>>'{record,id}')::uuid;
   end if;
   v_item:=jsonb_set(v_item,'{product_id}',to_jsonb(v_id::text));
  end if;
  v_out:=v_out||jsonb_build_array(v_item);
 end loop;
 return v_out;
end $$;

-- 129 plus: the vendedor (exists, rules of the vendedor linked to the user), the next free number when the requested
-- one is taken, and the automatic products of Preferências › Cadastros › Produtos.
create or replace function public.erp_document_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_data jsonb; v_row erp_documents.document%rowtype; v_id uuid;
 v_contact uuid; v_warehouse uuid; v_snapshot jsonb; v_before jsonb; v_result jsonb; v_body jsonb; v_number bigint; v_seller uuid;
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
 if p_id is not null and v_row.contact_id=v_contact then v_snapshot:=v_row.contact_snapshot;
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

-- 129 with the vendedor and its rules.
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

-- 132 plus: "Data do pedido clonado" also keeps the data prevista, and the copy keeps the vendedor (Origin clones keep it).
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

-- 129 plus Cross-Docking (Preferências › Estoque): days added to the prazo de entrega in the data prevista of the sale.
create or replace function erp_documents.sale_body_from_proposal(p_body jsonb) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select p_body||'{"template":false}'::jsonb||case when erp_documents.preference('propostas.data_prevista_prazo')='true'::jsonb
   and p_body#>>'{commercial,transport,delivery_days}'~'^(0|[1-9][0-9]{0,3})$'
   and (p_body->>'date')::date+(p_body#>>'{commercial,transport,delivery_days}')::integer+coalesce((erp_documents.preference('estoque.cross_docking_dias')#>>'{}')::integer,0)<='2099-12-31'::date
  then jsonb_build_object('expected_date',((p_body->>'date')::date+(p_body#>>'{commercial,transport,delivery_days}')::integer
   +coalesce((erp_documents.preference('estoque.cross_docking_dias')#>>'{}')::integer,0))::text) else '{}'::jsonb end
$$;

-- 129 plus the Preferências rules of the pedido generated (produtos não cadastrados, vendedor obrigatório, casas decimais).
create or replace function public.erp_proposal_convert(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype; v_sale erp_documents.document%rowtype;
 v_id uuid; v_before jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','convert','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_proposals' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version or v_source.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 select * into v_sale from erp_documents.document where source_proposal_id=p_id;
 if found then raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 perform erp_documents.check_preference_rules('sales_orders',erp_documents.stored_rules_data(p_id));
 v_before:=erp_documents.dto(p_id);
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)
 values('sales_orders',erp_documents.next_number('sales_orders'),erp_documents.initial_status('sales_orders'),v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  erp_documents.sale_body_from_proposal(v_source.body),v_source.total,p_id,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,
   i.data||jsonb_build_object('id',n.new_id)
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null)n where i.document_id=p_id;
 update erp_documents.document set status='completed',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_source.version+1,v_source.status,'completed',null);
 v_result:=jsonb_build_object('proposal',erp_documents.dto(p_id),'sale',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,p_id,'convert_to_sale',v_before,erp_documents.dto(p_id)),
  (p_user_id,p_command_id,v_id,'create_from_proposal',null,erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 129 plus the Preferências rules of the OS generated (itens repetidos, vendedor obrigatório, casas decimais).
create or replace function public.erp_proposal_convert_to_service(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype;
 v_id uuid; v_before jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','convert_to_service','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash);
 if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_proposals' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version or v_source.version=2147483647 then
  raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from erp_documents.document where source_proposal_id=p_id) then
  raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then
  raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 perform erp_documents.check_preference_rules('service_orders',erp_documents.stored_rules_data(p_id));
 v_before:=erp_documents.dto(p_id);
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)
 values('service_orders',erp_documents.next_number('service_orders'),'open',v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  v_source.body||'{"template":false}'::jsonb,v_source.total,p_id,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,
  i.data||jsonb_build_object('id',n.new_id)
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null)n where i.document_id=p_id;
 update erp_documents.document set status='completed',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_source.version+1,v_source.status,'completed',null);
 v_result:=jsonb_build_object('proposal',erp_documents.dto(p_id),'service_order',erp_documents.dto(v_id),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,p_id,'convert_to_service',v_before,erp_documents.dto(p_id)),
  (p_user_id,p_command_id,v_id,'create_from_proposal',null,erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 131 plus the Preferências rules of the OS generated from the pedido.
create or replace function public.erp_sales_order_convert_to_service(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype; v_id uuid; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','sales_to_service','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_orders' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from erp_documents.sales_service_link where sales_order_id=p_id) then raise exception 'erp_sales_order_already_converted' using errcode='40001'; end if;
 if v_source.status='cancelled' or erp_documents.order_invoice(p_id) is not null then raise exception 'erp_sales_order_not_convertible' using errcode='22023'; end if;
 perform erp_documents.check_preference_rules('service_orders',erp_documents.stored_rules_data(p_id));
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
 values('service_orders',erp_documents.next_number('service_orders'),'open',v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  v_source.body-array['ship_date','customer_po_number','delivery_address']||'{"template":false}'::jsonb,v_source.total,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,i.data||jsonb_build_object('id',n.new_id)
 -- Correlated lateral: one new id per item (131 drew a single id for every line, so a pedido with two items failed).
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null) n where i.document_id=p_id;
 insert into erp_documents.sales_service_link(sales_order_id,service_order_id,actor,command_id) values(p_id,v_id,p_user_id,p_command_id);
 perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_source.version,v_source.status,null,
  'Ordem de serviço '||(select number::text from erp_documents.document where id=v_id)||' gerada a partir deste pedido');
 v_result:=jsonb_build_object('sale',erp_documents.dto(p_id),'service_order',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,v_id,'create_from_sales_order',jsonb_build_object('sales_order_id',p_id,'sales_order_number',v_source.number::text),erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 131 plus the Inscrição Estadual of the contribuinte do ICMS, an invalid UF and the transportador of the frete por conta
-- do destinatário (1) or de terceiros (2).
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
  union all select 100+i.position,'Produto '||(i.data->>'description'),'O item não está vinculado a um produto cadastrado'
   from d join erp_documents.item i on i.document_id=d.id where i.product_id is null
  union all select 100+i.position,'Produto '||(i.data->>'description'),m.message
   from d join erp_documents.item i on i.document_id=d.id join erp_catalog.product p on p.record_id=i.product_id
   cross join lateral (values (p.ncm is null or p.ncm!~'^[0-9]{8}$','O campo NCM é obrigatório'),(p.origin is null,'O campo Origem é obrigatório'),
    (nullif(btrim(coalesce(i.data->>'unit','')),'') is null,'O campo Unidade é obrigatório')) m(missing,message) where m.missing
 )
 select coalesce(jsonb_agg(jsonb_build_object('section',section,'message',message) order by o,message),'[]'::jsonb) from checks
$$;

-- 008 plus the settings the document screens apply (Preferências) and the vendedor linked to the user.
create or replace function public.erp_document_access(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if not found then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 return jsonb_build_object('read',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.allowed(v_role,k,false)),
  'write',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.allowed(v_role,k,true)),
  'settings',jsonb_build_object(
   'price_decimals_out',coalesce((erp_documents.preference('empresa.decimais_preco_saida')#>>'{}')::integer,10),
   'price_decimals_in',coalesce((erp_documents.preference('empresa.decimais_preco_entrada')#>>'{}')::integer,10),
   'cross_docking_days',coalesce((erp_documents.preference('estoque.cross_docking_dias')#>>'{}')::integer,0),
   'occurrence_date_editable',erp_documents.preference('empresa.editar_data_ocorrencia')='true'::jsonb,
   'stock_launch_date',case when erp_documents.preference('estoque.data_lancamento')='"data_documento"'::jsonb then 'data_documento' else 'data_atual' end,
   'auto_products',jsonb_build_object('sales',erp_documents.preference('produtos.cadastro_auto_vendas')='true'::jsonb,
    'purchases',erp_documents.preference('produtos.cadastro_auto_compras')='true'::jsonb,'services',erp_documents.preference('produtos.cadastro_auto_os')='true'::jsonb),
   'default_warehouse',(select jsonb_build_object('id',r.id,'name',left(r.name,200)) from erp_stock.warehouse_default x join erp_catalog.record r on r.id=x.warehouse_id where r.active)),
  'seller',(select jsonb_build_object('id',s.id,'name',left(r.name,200),'allow_unregistered_products',s.allow_unregistered_products,'view_stock',s.view_stock,
    'discount_limit',s.discount_limit::numeric(7,4)::text) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.user_id=p_user_id),
  'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function erp_documents.price_decimals(text),erp_documents.check_seller_rules(uuid,text,jsonb),erp_documents.require_seller(uuid),
 erp_documents.stored_rules_data(uuid),erp_documents.auto_product_key(text),erp_documents.auto_products(uuid,text,uuid,jsonb),
 erp_documents.extension_keys(),erp_documents.extension_data(jsonb),erp_documents.check_preference_rules(text,jsonb),erp_documents.sale_body_from_proposal(jsonb),
 erp_documents.pendencies(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb),
 public.erp_document_copy_preview(uuid,text,uuid),public.erp_proposal_convert(uuid,uuid,integer,uuid),public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid),
 public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid),public.erp_document_access(uuid) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb),
 public.erp_document_copy_preview(uuid,text,uuid),public.erp_proposal_convert(uuid,uuid,integer,uuid),public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid),
 public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid),public.erp_document_access(uuid) to service_role;
commit;
