-- Regras de Preferências › Vendas, Propostas, Serviços e Suprimentos aplicadas aos documentos, numeração ajustável,
-- situações do pedido de compra como no Origin, Ordem de compra, pedido novo "Em aberto" e remoção lógica de ocorrências.
-- * Lê erp_preferences.get (115) na mesma transação: Editar número (vendas, propostas, OS e compras), Permite venda de
--   produtos não cadastrados (vendas), Permitir itens repetidos (OS), próximo contato obrigatório (propostas) e Calcular
--   data prevista a partir do prazo de entrega ao gerar venda (propostas).
-- * erp_document_numbering_set: "Próximo número" auditado, só administrador, CAS pelo próximo número lido.
-- * Pedido de compra: Em aberto, Em andamento, Atendido e Cancelado vão de qualquer para qualquer (Atendido parcialmente
--   mantém 008); as travas de estoque, contas e recebimentos não mudam.
-- * Pedido de venda novo (incluído, duplicado ou gerado de proposta) nasce "Em aberto", como no Origin; o filtro padrão da
--   listagem de pedidos volta a ser só "Em aberto".
-- * Ocorrências: remoção lógica auditada (a linha imutável continua guardada) e o nome do usuário na listagem.
-- * "Exibir totais em listas" (vendas, propostas e OS; nos pedidos, também os usuários marcados): a listagem devolve
--   total_amount nulo para quem fica sem os totais.
-- Nenhum efeito de estoque, financeiro ou fiscal é criado. Requer 008, 032, 034, 054, 057, 095, 102, 103, 104, 115 e 117.
begin;

-- Company preferences read by the document rules (defaults of 115 when never saved).
create function erp_documents.preference(p_key text) returns jsonb
language sql stable set search_path=pg_catalog as $$ select erp_preferences.get(p_key) $$;
create function erp_documents.number_editable(p_kind text) returns boolean
language sql stable set search_path=pg_catalog as $$
 select coalesce(erp_documents.preference(case p_kind when 'sales_orders' then 'vendas.editar_numero' when 'sales_proposals' then 'propostas.editar_numero'
  when 'service_orders' then 'os.editar_numero' when 'purchase_orders' then 'compras.editar_numero' end)='true'::jsonb,false)
$$;

-- Preferências "Exibir totais em listas" (pedidos de venda also "Usuários que visualizam os totais", none marked = everyone):
-- the sum of the filtered list is omitted for the other users; the totals of the rows stay.
create function erp_documents.list_totals_visible(p_user_id uuid,p_kind text) returns boolean
language sql stable set search_path=pg_catalog as $$
 select case p_kind
  when 'sales_orders' then erp_documents.preference('vendas.exibir_totais') is distinct from 'false'::jsonb
   and (select case when jsonb_typeof(u)='array' and jsonb_array_length(u)>0 then u?p_user_id::text else true end from (select erp_documents.preference('vendas.exibir_totais_usuarios') u) users)
  when 'sales_proposals' then erp_documents.preference('propostas.exibir_totais') is distinct from 'false'::jsonb
  when 'service_orders' then erp_documents.preference('os.exibir_totais') is distinct from 'false'::jsonb
  else true end
$$;

-- Origin rules of the Preferências pages, checked on every save and copy (the editor shows the same messages first).
create function erp_documents.check_preference_rules(p_kind text,p_data jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
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
end $$;

create function erp_documents.initial_status(p_kind text) returns text
language sql immutable set search_path=pg_catalog as $$ select case p_kind when 'sales_proposals' then 'draft' else 'open' end $$;

-- 202610200102 plus "Ordem de compra" (order_reference, pedido de compra; aceito em todos os tipos como os demais).
create or replace function erp_documents.extension_keys() returns text[]
language sql immutable set search_path=pg_catalog as $$
 select array['ship_date','finish_date','start_time','end_time','customer_po_number','quote_requested','quoted','warranty_days',
  'warranty_months','warranty_info','reception_notes','template_name','delivery_address','order_reference']
$$;
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
  end if;
  v_result:=v_result||jsonb_build_object(k,coalesce(v,'null'::jsonb));
 end loop;
 return v_result;
end $$;

-- Pedido de compra "todas para todas" (Atendido parcialmente keeps 008); the other kinds keep 103.
create or replace function erp_documents.transitions()
returns jsonb language sql immutable set search_path=pg_catalog as $$ select '{"sales_proposals":{"draft":["open","pending","waiting","approved","rejected","cancelled"],"open":["draft","pending","waiting","approved","rejected","cancelled"],"pending":["draft","open","waiting","approved","rejected","cancelled"],"waiting":["draft","open","pending","approved","rejected","cancelled"],"approved":["draft","open","pending","waiting","rejected","cancelled"],"rejected":["draft","open","pending","waiting","approved","cancelled"],"cancelled":["draft","open","pending","waiting","approved","rejected"],"completed":[]},"sales_orders":{"draft":["open","verified","in_progress","fulfilled","cancelled"],"open":["draft","verified","in_progress","fulfilled","cancelled"],"verified":["draft","open","in_progress","fulfilled","cancelled"],"in_progress":["draft","open","verified","partially_fulfilled","fulfilled","cancelled"],"partially_fulfilled":["in_progress","fulfilled","cancelled"],"fulfilled":["draft","open","verified","in_progress","cancelled"],"cancelled":["draft","open","verified","in_progress","fulfilled"]},"purchase_orders":{"open":["in_progress","fulfilled","cancelled"],"in_progress":["open","partially_fulfilled","fulfilled","cancelled"],"partially_fulfilled":["in_progress","fulfilled","cancelled"],"fulfilled":["open","in_progress","cancelled"],"cancelled":["open","in_progress","fulfilled"]},"service_orders":{"open":["quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"quoted":["open","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"approved":["open","quoted","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"rejected":["open","quoted","approved","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"in_progress":["open","quoted","approved","rejected","waiting_parts","service_done","finalized","no_repair","cancelled"],"waiting_parts":["open","quoted","approved","rejected","in_progress","service_done","finalized","no_repair","cancelled"],"service_done":["open","quoted","approved","rejected","in_progress","waiting_parts","finalized","no_repair","cancelled"],"finalized":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","no_repair","cancelled"],"no_repair":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","cancelled"],"cancelled":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair"]}}'::jsonb $$;

-- The new pedido is "Em aberto" (Origin): the default filter of the pedidos list is only "Em aberto" again.
create or replace function erp_documents.list_view_default_statuses(p_kind text) returns text[]
language sql immutable set search_path=pg_catalog as $$
 select case p_kind when 'sales_proposals' then array['draft','open','pending','waiting'] else array['open'] end
$$;

-- 054 with: optional "number" in the body (Editar número), the Preferências rules and the Origin initial situação.
-- The number is never stored in the body; a free number moves the automatic sequence past it.
create or replace function public.erp_document_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_data jsonb; v_row erp_documents.document%rowtype; v_id uuid;
 v_contact uuid; v_warehouse uuid; v_snapshot jsonb; v_before jsonb; v_result jsonb; v_body jsonb; v_number bigint;
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
 v_data:=erp_documents.normalize(p_kind,v_body); v_contact:=(v_data->>'contact_id')::uuid; v_warehouse:=(v_data->>'warehouse_id')::uuid;
 perform erp_documents.check_preference_rules(p_kind,v_data);
 if p_id is not null then
  select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
  if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  if not erp_documents.editable(v_row.status) then raise exception 'erp_document_state_locked' using errcode='40001'; end if;
  v_before:=erp_documents.dto(p_id);
  perform erp_documents.require_commercial_input(v_before,v_body);
  if v_number=v_row.number then v_number:=null; end if;
 end if;
 if v_number is not null then
  -- Same lock as erp_documents.next_number: a free number and the automatic sequence never collide.
  perform 1 from erp_documents.numbering where kind=p_kind for update;
  if not erp_documents.number_editable(p_kind) then raise exception 'erp_document_number_locked' using errcode='22023'; end if;
  if exists(select 1 from erp_documents.document where kind=p_kind and number=v_number) then raise exception 'erp_document_number_taken' using errcode='23505'; end if;
  update erp_documents.numbering set last_number=greatest(last_number,v_number) where kind=p_kind;
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

-- 054 with the same Preferências rules and the Origin initial situação.
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
 -- No source write; SHARE preserves the reviewed source revision through commit.
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind for share;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_source_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_data:=erp_documents.normalize(p_kind,p_body);
 perform erp_documents.require_commercial_input(erp_documents.dto(p_source_id),p_body);
 perform erp_documents.check_preference_rules(p_kind,v_data);
 v_contact:=(v_data->>'contact_id')::uuid;v_warehouse:=(v_data->>'warehouse_id')::uuid;
 select array_agg(distinct id) into v_refs from (
  select v_contact id union all select v_warehouse union all
  select (value->>'product_id')::uuid from jsonb_array_elements(v_data->'items')) refs where id is not null;
 -- Every current catalog snapshot is taken under the same deterministic record lock order.
 perform r.id from erp_catalog.record r where r.id=any(v_refs) order by r.id for share;
 select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id
  where r.id=v_contact and r.active;
 if not found then raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 if v_warehouse is not null and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=v_warehouse and r.active) then
  raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(v_data->'items') i where i->>'product_id' is not null and not exists(
  select 1 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=(i->>'product_id')::uuid and r.active)) then
  raise exception 'erp_document_product_unavailable' using errcode='22023'; end if;
 -- The submitted commercial values/dates are normalized, never reset after confirmation.
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
 values(p_kind,erp_documents.next_number(p_kind),erp_documents.initial_status(p_kind),
  v_contact,v_warehouse,v_snapshot,v_data-'items',(v_data#>>'{totals,total}')::numeric,p_user_id,p_user_id) returning id into v_id;
 -- Client line identities are local form keys, never reused across documents.
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

-- Sale generated from a proposal (008, now without requiring Aprovado as in Origin): the sale is "Em aberto"; with "Calcular data prevista a partir do prazo
-- de entrega ao gerar venda" the expected date is the sale date plus the prazo; the Concluído of the proposal is an occurrence.
create function erp_documents.sale_body_from_proposal(p_body jsonb) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select p_body||'{"template":false}'::jsonb||case when erp_documents.preference('propostas.data_prevista_prazo')='true'::jsonb
   and p_body#>>'{commercial,transport,delivery_days}'~'^(0|[1-9][0-9]{0,3})$'
   and (p_body->>'date')::date+(p_body#>>'{commercial,transport,delivery_days}')::integer<='2099-12-31'::date
  then jsonb_build_object('expected_date',((p_body->>'date')::date+(p_body#>>'{commercial,transport,delivery_days}')::integer)::text) else '{}'::jsonb end
$$;
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
 -- A different command may not bypass CAS after a completed conversion.
 if v_source.version<>p_expected_version or v_source.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 select * into v_sale from erp_documents.document where source_proposal_id=p_id;
 if found then raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 -- Origin "Gerar venda": any proposta not cancelled nor concluded, not a model and without a sale.
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
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

-- 032 with the Concluído of the proposal recorded as an occurrence, like every other change of situação.
create or replace function public.erp_proposal_convert_to_service(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype;
 v_id uuid; v_before jsonb; v_result jsonb;
begin
 -- Recheck current membership even for a historical idempotent replay.
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','convert_to_service','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 -- Same command namespace and parent row as sale conversion: command -> source -> numbering.
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash);
 if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_proposals' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version or v_source.version=2147483647 then
  raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from erp_documents.document where source_proposal_id=p_id) then
  raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 -- Origin "Gerar ordem de serviço": the same rule as Gerar venda.
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then
  raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 v_before:=erp_documents.dto(p_id);
 -- Copy the approved historical snapshots, without consulting mutable catalog prices.
 -- OS starts open for operational review; its approval/execution is not inferred.
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

-- Origin "Próximo número" (Preferências): read with the lowest number still free, set only by the administrador.
create table erp_documents.numbering_audit (
 id bigint generated always as identity primary key,
 kind text not null references erp_documents.numbering(kind),
 actor uuid not null references auth.users(id),
 command_id uuid not null unique,
 before_last bigint not null check(before_last between 0 and 9999999999),
 after_last bigint not null check(after_last between 0 and 9999999999),
 created_at timestamptz not null default clock_timestamp(),
 check(after_last<>before_last)
);
create function erp_documents.numbering_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_document_numbering_audit_immutable' using errcode='55000'; end $$;
create trigger numbering_audit_immutable before update or delete on erp_documents.numbering_audit for each row execute function erp_documents.numbering_audit_immutable();
alter table erp_documents.numbering_audit enable row level security;
revoke all on erp_documents.numbering_audit from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_documents from public,anon,authenticated,service_role;

create function erp_documents.numbering_dto(p_kind text) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('kind',n.kind,'next_number',case when n.last_number<9999999999 then (n.last_number+1)::text end,'reserved',false,
  'minimum_next_number',(select case when coalesce(max(d.number),0)<9999999999 then (coalesce(max(d.number),0)+1)::text end from erp_documents.document d where d.kind=n.kind),
  'data_mode','erp_native','operational_effects',false)
 from erp_documents.numbering n where n.kind=p_kind
$$;
create or replace function public.erp_document_next_number(p_user_id uuid,p_kind text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb; begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 v:=erp_documents.numbering_dto(p_kind);
 if v is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 return v;
end $$;

-- The next number may go up or down, but never to a number already used: it stays above the highest document number.
create function public.erp_document_numbering_set(p_user_id uuid,p_kind text,p_command_id uuid,p_expected_next_number text,p_next_number text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_last bigint; v_next bigint; v_max bigint; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin') then
  raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 if p_command_id is null or p_expected_next_number is null or p_expected_next_number!~'^[1-9][0-9]{0,9}$'
  or p_next_number is null or p_next_number!~'^[1-9][0-9]{0,9}$' then raise exception 'erp_document_numbering_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','numbering','actor',p_user_id,'kind',p_kind,'expected',p_expected_next_number,'next',p_next_number)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select last_number into v_last from erp_documents.numbering where kind=p_kind for update;
 if not found then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 if v_last+1<>p_expected_next_number::bigint then raise exception 'erp_document_numbering_conflict' using errcode='40001'; end if;
 v_next:=p_next_number::bigint;
 select coalesce(max(number),0) into v_max from erp_documents.document where kind=p_kind;
 if v_next<=v_max then raise exception 'erp_document_number_taken' using errcode='23505'; end if;
 if v_next=v_last+1 then raise exception 'erp_document_numbering_unchanged' using errcode='22023'; end if;
 update erp_documents.numbering set last_number=v_next-1 where kind=p_kind;
 insert into erp_documents.numbering_audit(kind,actor,command_id,before_last,after_last) values(p_kind,p_user_id,p_command_id,v_last,v_next-1);
 v_result:=erp_documents.numbering_dto(p_kind)||jsonb_build_object('replayed',false);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Ocorrências: Origin "Remover ocorrência" ("Confirma exclusão definitiva da ocorrência?"). The immutable row stays; a
-- removal row hides it from the modal, with who removed it and when.
create table erp_documents.occurrence_removal (
 occurrence_id uuid primary key references erp_documents.occurrence(id),
 document_id uuid not null references erp_documents.document(id),
 actor_id uuid not null references auth.users(id),
 actor_role text not null,
 command_id uuid not null unique,
 removed_at timestamptz not null default clock_timestamp()
);
create trigger occurrence_removal_immutable before update or delete on erp_documents.occurrence_removal for each row execute function erp_documents.occurrence_immutable();
alter table erp_documents.occurrence_removal enable row level security;
revoke all on erp_documents.occurrence_removal from public,anon,authenticated,service_role;

create function erp_documents.occurrence_list_json(o erp_documents.occurrence) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select erp_documents.occurrence_json(o)||jsonb_build_object('actor_name',(select left(p.name,120) from erp_access.profile p where p.user_id=o.actor_id))
$$;
create or replace function public.erp_document_occurrence_list(p_user_id uuid,p_kind text,p_document_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_row erp_documents.document%rowtype; v_role text; v_items jsonb; v_count bigint;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 select * into v_row from erp_documents.document where id=p_document_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 select coalesce(jsonb_agg(erp_documents.occurrence_list_json(o) order by o.sequence desc),'[]'::jsonb) into v_items
  from (select * from erp_documents.occurrence x where x.document_id=p_document_id
   and not exists(select 1 from erp_documents.occurrence_removal r where r.occurrence_id=x.id) order by x.sequence desc limit 500) o;
 select count(*) into v_count from erp_documents.occurrence x where x.document_id=p_document_id
  and not exists(select 1 from erp_documents.occurrence_removal r where r.occurrence_id=x.id);
 return jsonb_build_object('kind',p_kind,'document',jsonb_build_object('id',v_row.id,'kind',v_row.kind,'number',v_row.number::text,'status',v_row.status,'version',v_row.version),
  'items',v_items,'has_more',v_count>500,'can_write',erp_documents.allowed(v_role,p_kind,true),'data_mode','erp_native','operational_effects',false);
end $$;
create function public.erp_document_occurrence_remove(p_user_id uuid,p_kind text,p_document_id uuid,p_occurrence_id uuid,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_occurrence erp_documents.occurrence; v_role text; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_document_id is null or p_occurrence_id is null then raise exception 'erp_document_occurrence_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','occurrence_remove','actor',p_user_id,'kind',p_kind,'id',p_document_id,'occurrence',p_occurrence_id)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_documents.document where id=p_document_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 select * into v_occurrence from erp_documents.occurrence where id=p_occurrence_id and document_id=p_document_id;
 if not found or exists(select 1 from erp_documents.occurrence_removal where occurrence_id=p_occurrence_id) then
  raise exception 'erp_document_occurrence_not_found' using errcode='P0002'; end if;
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 insert into erp_documents.occurrence_removal(occurrence_id,document_id,actor_id,actor_role,command_id) values(p_occurrence_id,p_document_id,p_user_id,coalesce(v_role,'desconhecido'),p_command_id);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,p_document_id,'occurrence_remove',erp_documents.occurrence_json(v_occurrence),null);
 v_result:=jsonb_build_object('kind',p_kind,'document',jsonb_build_object('id',v_row.id,'kind',v_row.kind,'number',v_row.number::text,'status',v_row.status,'version',v_row.version),
  'removed_id',p_occurrence_id,'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 102 plus the Origin search of pedidos de compra: "Pesquisa por nome, número do pedido ou ordem de compra", and total_amount
-- null for a user that Preferências "Exibir totais em listas" leaves without the totals.
create or replace function public.erp_document_list(
 p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null,p_status text default null,
 p_query text default null,p_date_from text default null,p_date_to text default null,
 p_page integer default null,p_order text default 'id',p_statuses text[] default null,p_date_type text default 'date',
 p_warehouse_id uuid default null,p_product_id uuid default null,p_city text default null,p_state text default null,
 p_technician text default null,p_equipment text default null,p_serial_number text default null,p_internal_note text default null,
 p_postal_code text default null,p_district text default null,p_tracking_code text default null,p_customer_po_number text default null,
 p_carrier text default null,p_contact_email text default null,p_template boolean default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_fiscal boolean; v_stock boolean; v_statuses text[]; v_query text; v_digits text; v_from date; v_to date; v_offset bigint;
 v_cursor erp_documents.document%rowtype; v_cursor_day text; v_items jsonb; v_more boolean; v_last uuid; v_count bigint; v_amount numeric;
 v_city text; v_technician text; v_equipment text; v_serial text; v_note text;
 v_postal text; v_district text; v_tracking text; v_po text; v_carrier text; v_email text;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 v_fiscal:=v_role in ('admin','fiscal');
 -- Mesmos perfis de leitura de erp_stock.require_access (009).
 v_stock:=v_role in ('admin','consulta','estoque','vendas','fiscal');
 v_statuses:=case when p_statuses is not null then p_statuses when p_status is not null then array[p_status] end;
 if p_limit is null or p_limit not between 1 and 100
  or (p_status is not null and p_statuses is not null)
  or (v_statuses is not null and (coalesce(cardinality(v_statuses),0) not between 1 and 20 or array_position(v_statuses,null) is not null
   or exists(select 1 from unnest(v_statuses) s where not (erp_documents.transitions()->p_kind)?s)
   or (select count(distinct s) from unnest(v_statuses) s)<>cardinality(v_statuses)))
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
 -- CPF/CNPJ (e o CEP na OS) com ou sem máscara: compara só os dígitos quando a pesquisa é numérica com pelo menos 5 dígitos.
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
  where d.kind=p_kind
   and (v_statuses is null or d.status=any(v_statuses))
   and (v_from is null and v_to is null
    or p_date_type='date' and (v_from is null or d.body->>'date'>=p_date_from) and (v_to is null or d.body->>'date'<=p_date_to)
    or p_date_type='expected_date' and (v_from is null or d.body->>'expected_date'>=p_date_from) and (v_to is null or d.body->>'expected_date'<=p_date_to)
    or p_date_type='next_contact' and (v_from is null or d.body->>'next_contact'>=p_date_from) and (v_to is null or d.body->>'next_contact'<=p_date_to)
    or p_date_type='ship_date' and (v_from is null or d.body->>'ship_date'>=p_date_from) and (v_to is null or d.body->>'ship_date'<=p_date_to)
    or p_date_type='finish_date' and (v_from is null or d.body->>'finish_date'>=p_date_from) and (v_to is null or d.body->>'finish_date'<=p_date_to)
    -- Garantia: data de saída (ou da OS) mais os dias de garantia.
    or p_date_type='warranty_until' and d.body->>'warranty_days' is not null
     and (v_from is null or (coalesce(d.body->>'ship_date',d.body->>'date')::date+(d.body->>'warranty_days')::integer)>=v_from)
     and (v_to is null or (coalesce(d.body->>'ship_date',d.body->>'date')::date+(d.body->>'warranty_days')::integer)<=v_to))
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
   and (v_carrier is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,carrier_reference,label}','')),v_carrier)>0)
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

revoke all on function erp_documents.preference(text),erp_documents.number_editable(text),erp_documents.list_totals_visible(uuid,text),erp_documents.check_preference_rules(text,jsonb),
 erp_documents.initial_status(text),erp_documents.extension_keys(),erp_documents.extension_data(jsonb),erp_documents.transitions(),
 erp_documents.list_view_default_statuses(text),erp_documents.sale_body_from_proposal(jsonb),erp_documents.numbering_audit_immutable(),
 erp_documents.numbering_dto(text),erp_documents.occurrence_list_json(erp_documents.occurrence) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb),
 public.erp_proposal_convert(uuid,uuid,integer,uuid),public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid),
 public.erp_document_next_number(uuid,text),public.erp_document_numbering_set(uuid,text,uuid,text,text),
 public.erp_document_occurrence_list(uuid,text,uuid),public.erp_document_occurrence_remove(uuid,text,uuid,uuid,uuid),
 public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean)
 from public,anon,authenticated,service_role;
grant execute on function public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb),
 public.erp_proposal_convert(uuid,uuid,integer,uuid),public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid),
 public.erp_document_next_number(uuid,text),public.erp_document_numbering_set(uuid,text,uuid,text,text),
 public.erp_document_occurrence_list(uuid,text,uuid),public.erp_document_occurrence_remove(uuid,text,uuid,uuid,uuid),
 public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean)
 to service_role;
commit;
