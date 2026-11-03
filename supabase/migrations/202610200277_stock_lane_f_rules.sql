-- 277: Estoque no padrão do Origin (onda F), regras: posições, data do recebimento, casas decimais das entradas, reserva por situação
-- personalizada e a importação de lotes. Requer 025, 105, 145, 163, 181, 258, 259 e 260. Nenhum movimento, saldo, documento ou cadastro
-- existente é reescrito; nada aqui escreve no Origin, emite nota ou movimenta banco.
-- - Posições de estoque (025, seletor de itens dos documentos): o saldo global deixa de fora o depósito com "Desconsiderar saldo deste
--   depósito", como a listagem de produtos (234), o extrato e os relatórios. O depósito escolhido no filtro continua com o próprio saldo;
--   uma posição em revisão em qualquer depósito continua deixando o total em revisão.
-- - Recebimento do pedido de compra (090/184): a data segue "Ao lançar estoque utilizar data atual ou data entrada/saída" (Preferências ›
--   Suprimentos › Estoque), como os demais lançamentos de documento: hoje, ou a Data prevista (senão a data) do pedido, nunca no futuro.
--   A prévia sem data usa esse dia; outra data é recusada. O estorno do recebimento continua com a data informada.
-- - Estoque › Lançar estoque: "Número de casas decimais no preço nas entradas" (Preferências › Empresa › Geral, 0 a 10) vale para o Preço de
--   Compra e o Preço de Custo da Entrada e do Balanço (também com Lote) e para a alteração do preço de uma entrada no extrato. A tela recebe
--   o limite no contexto do lançamento.
-- - Reserva de estoque pelas situações de venda (145): "estoque.reserva_situacoes" passa a aceitar também o id (UUID em texto) de uma
--   situação personalizada de pedido de venda (163); o pedido nessa situação reserva como os das situações-base marcadas. A lista de opções
--   da preferência é da frente de preferências; sem ids personalizados, nada muda.
-- - Importação de lotes: erp_stock_lot_import grava um lote por linha (inclui pelo código do lote no produto ou atualiza as datas e a Obs.),
--   com as regras de "+ Adicionar lote" (258). O tipo de importação "Lotes" das Importações de Dados é da frente de preferências.
-- Funções substituídas (o corpo publicado é conferido pelo hash, sem CR; outra versão interrompe a migração).
begin;

do $$declare r record;begin
 if to_regclass('erp_stock.lot') is null or to_regprocedure('erp_stock.invoice_posted_for_document(uuid)') is null
  or to_regprocedure('erp_documents.stock_launch_date(uuid)') is null or to_regclass('erp_documents.document_situation') is null then
  raise exception 'stock_lane_f_rules_277_requires_163_258_259' using errcode='55000';end if;
 for r in select * from(values
  ('public.erp_stock_positions(uuid,integer,uuid,text,boolean,uuid,text,text,text,text)','de5d8e8b0bad6e23d9df2c6f3be070655395ac1840fd4da19046a23c99f2e3d2'),
  ('erp_purchase_receipts.preview(uuid,erp_documents.document,text,date,text,jsonb,uuid)','03944777bea55990aa77065371d7bc68f779adc9c5b936bbf0068226ecdfc380'),
  ('public.erp_stock_launch(uuid,uuid,text,uuid,uuid,text,integer,text,text,text,uuid,integer)','002f408462ea2479151a6af312ef88b2622f9d1ee3cabdac21e219143d34d533'),
  ('public.erp_stock_movement_amend(uuid,uuid,uuid,uuid,integer,text,text,text)','63184bbc1efd37aa64e581e5b65d1e35deecdd7222411b08327ff53ea60394d4'),
  ('public.erp_stock_launch_context(uuid,uuid)','bda442e1089cfede879c9cc7a4f593c436de0a8bde0064285d9572b50c44cda8'),
  ('erp_stock.situation_reservations(uuid)','38c5882b1ff85d69b10aecd178196ec535eba6485eef9d16570f0153d89d72d5'),
  ('public.erp_stock_product_reservations(uuid,uuid,uuid)','af2dfe9ce6c839b6b5400625774ed6efdc9fe0406ea5da9b9307faffc035c99d'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_lane_f_rules_277_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regprocedure('erp_stock.entry_decimals()') is not null then raise exception 'stock_lane_f_rules_277_already_applied' using errcode='55000';end if;
end$$;

-- 1. Helpers.
-- "Número de casas decimais no preço nas entradas" (115, empresa-geral): 0 a 10, padrão 10.
create function erp_stock.entry_decimals()returns integer language sql stable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='number' and(v#>>'{}')~'^([0-9]|10)$' then(v#>>'{}')::integer else 10 end from(select erp_preferences.get('empresa.decimais_preco_entrada') v)x
$$;
-- A typed price of an entry with more significant decimals than allowed is refused (trailing zeros do not count).
create function erp_stock.entry_price_check(p text)returns void language plpgsql stable set search_path=pg_catalog as $$
declare n integer:=erp_stock.entry_decimals();begin
 if p is not null and p~'^(0|[1-9][0-9]{0,13})(\.[0-9]{1,10})?$' and p::numeric<>round(p::numeric,n) then
  raise exception 'erp_stock_price_decimals_exceeded' using errcode='22023',detail=n::text;end if;
end$$;
-- Custom situations (situações personalizadas de pedido de venda, 148/163) chosen in "estoque.reserva_situacoes" with "Reserva de estoque
-- pelas situações de venda" on: the UUID texts of the list that are sales-order situations.
create function erp_stock.reserve_situation_ids()returns uuid[] language sql stable set search_path=pg_catalog as $$
 select case when coalesce(erp_preferences.get('estoque.reserva_por_situacao')='true'::jsonb,false) then coalesce(array(
   select x.id from erp_preferences.situation x join jsonb_array_elements_text(case when jsonb_typeof(erp_preferences.get('estoque.reserva_situacoes'))='array'
     then erp_preferences.get('estoque.reserva_situacoes') else '[]'::jsonb end)v on x.id=case when v~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v::uuid end
   where x.kind='sales_orders' order by x.id),'{}'::uuid[]) else '{}'::uuid[] end
$$;

-- 2. Posições de estoque (025): the global total over the considered warehouses.
create or replace function public.erp_stock_positions(p_user_id uuid,p_limit integer default 25,p_after uuid default null,
 p_query text default null,p_active boolean default null,p_warehouse_id uuid default null,p_brand text default null,
 p_location text default null,p_stock_state text default null,p_limit_state text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb; warehouse jsonb;
begin
 perform erp_stock.require_access(p_user_id,false);
 if p_limit is null or p_limit not between 1 and 100
  or length(p_query)>120 or p_query ~ '[[:cntrl:]]' or length(p_brand)>100 or p_brand ~ '[[:cntrl:]]'
  or length(p_location)>100 or p_location ~ '[[:cntrl:]]'
  or (p_stock_state is not null and p_stock_state not in('recorded','no_movements','review_required'))
  or (p_limit_state is not null and p_limit_state not in('below_min','within','above_max','not_configured','no_movements','review_required')) then
  raise exception 'erp_stock_invalid_query' using errcode='22023'; end if;
 if p_warehouse_id is not null then
  select jsonb_build_object('id',r.id,'name',r.name,'active',r.active) into warehouse
   from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id where w.record_id=p_warehouse_id;
  if not found then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 end if;
 with candidates as materialized (
  select r.id,r.version,r.name,r.code,r.active,p.unit,p.kind,p.format,p.gtin,p.brand,p.location,p.stock_min,p.stock_max
   from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id
   where (p.kind='P' or exists(select 1 from erp_stock.balance b where b.product_id=r.id) or exists(select 1 from erp_stock.entry e where e.product_id=r.id))
    and (p_after is null or r.id>p_after) and (p_active is null or r.active=p_active)
    and (nullif(btrim(p_query),'') is null or strpos(lower(r.name),lower(btrim(p_query)))>0 or strpos(lower(coalesce(r.code,'')),lower(btrim(p_query)))>0 or strpos(lower(coalesce(p.gtin,'')),lower(btrim(p_query)))>0)
    and (nullif(btrim(p_brand),'') is null or strpos(lower(coalesce(p.brand,'')),lower(btrim(p_brand)))>0)
    and (nullif(btrim(p_location),'') is null or strpos(lower(coalesce(p.location,'')),lower(btrim(p_location)))>0)
 ), ledger as materialized (
  select e.product_id,e.warehouse_id,count(*) as entry_count,sum(e.quantity) as ledger_quantity,
   max(e.balance_version) as last_version,bool_and(e.unit is not distinct from p.unit) as units_match
   from erp_stock.entry e join candidates p on p.id=e.product_id group by e.product_id,e.warehouse_id
 ), balances as materialized(select b.* from erp_stock.balance b join candidates p on p.id=b.product_id),
 positions as materialized (
  select coalesce(b.product_id,l.product_id) as product_id,coalesce(b.warehouse_id,l.warehouse_id) as warehouse_id,
   b.quantity,b.version,coalesce(l.entry_count,0) as entry_count,
   case when b.product_id is null or l.product_id is null or p.unit is null or p.kind is distinct from 'P'
     or b.unit is distinct from p.unit or not coalesce(l.units_match,false)
     or b.version<>l.entry_count or b.version<>l.last_version or b.quantity<>l.ledger_quantity
    then 'review_required' else 'recorded' end as state
   from balances b full join ledger l using(product_id,warehouse_id)
   join candidates p on p.id=coalesce(b.product_id,l.product_id)
 ), totals as materialized (
  select p.id,count(s.warehouse_id) as position_count,count(s.warehouse_id) filter(where s.entry_count>0) as recorded_count,
   bool_or(s.state='review_required') as needs_review,
   -- 277: a warehouse with "Desconsiderar saldo deste depósito" stays out of the total, as in the product list (234), the extrato and
   -- the reports; a position in review in any warehouse still leaves the total in review. The chosen warehouse keeps its own balance.
   coalesce(sum(s.quantity) filter(where not erp_stock.ignored_warehouse(s.warehouse_id)),0) as quantity
   from candidates p left join positions s on s.product_id=p.id group by p.id
 ), states as materialized (
  select p.*,t.recorded_count,
   case when t.needs_review then 'review_required' when t.position_count=0 then 'no_movements' else 'recorded' end as global_state,
   case when not coalesce(t.needs_review,false) and t.position_count>0 then round(t.quantity,6)::text end as global_quantity,
   case when s.state is null then 'no_movements' else s.state end as selected_state,
   case when s.state='recorded' then s.quantity::text end as selected_quantity,
   coalesce(s.version,0) as selected_version
   from candidates p join totals t on t.id=p.id
   left join positions s on s.product_id=p.id and s.warehouse_id=p_warehouse_id
 ), classified as materialized (
  select s.*,case when global_state<>'recorded' then global_state
   when stock_min is null and stock_max is null then 'not_configured'
   when stock_min is not null and global_quantity::numeric<stock_min then 'below_min'
   when stock_max is not null and global_quantity::numeric>stock_max then 'above_max' else 'within' end as limit_state
   from states s
 ), ids as materialized (
  select * from classified where (p_stock_state is null or case when p_warehouse_id is null then global_state else selected_state end=p_stock_state)
   and (p_limit_state is null or limit_state=p_limit_state) order by id limit p_limit+1
 ), page as materialized(select * from ids order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
   'product',jsonb_build_object('id',id,'version',version,'name',name,'code',code,'active',active,'unit',unit,'kind',kind,'format',format,'gtin',gtin,'brand',brand,'location',location,'stock_min',stock_min::text,'stock_max',stock_max::text),
   'global',jsonb_build_object('state',global_state,'quantity',global_quantity,'recorded_warehouse_count',recorded_count::text,'scope','all_recorded_warehouses'),
   'selected_position',case when p_warehouse_id is not null then jsonb_build_object('warehouse_id',p_warehouse_id,'state',selected_state,'quantity',selected_quantity,'version',selected_version) end,
   'limit_state',limit_state) order by id) from page),'[]'::jsonb),
  'warehouse',warehouse,'limit',p_limit,'has_more',(select count(*)>p_limit from ids),
  'next_cursor',case when (select count(*)>p_limit from ids) then(select id from page order by id desc limit 1) end,
  'data_mode','erp_native','scope','stock_positions') into result;
 return result;
end $$;

-- 3. Recebimento do pedido de compra (090/184/224/259) dated by the preference.
create or replace function erp_purchase_receipts.preview(p_actor uuid,d erp_documents.document,p_action text,p_day date,p_reason text,p_items jsonb,p_receipt uuid default null)
returns jsonb language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare r erp_purchase_receipts.receipt;selection jsonb;lines jsonb:='[]';positions jsonb;w erp_catalog.record;row record;qty numeric;net numeric;result jsonb;begin
 -- 277: Preferências › Suprimentos › Estoque "Ao lançar estoque utilizar data atual ou data entrada/saída": a recebimento is dated by the
 -- preference, as the lançamento of the other documents (erp_documents.stock_launch_date: today, or the Data prevista / data of the pedido,
 -- never ahead). A preview without a date receives that day; a different day is refused.
 if p_action='receive' then
  p_day:=coalesce(p_day,erp_documents.stock_launch_date(d.id));
  if p_day is distinct from erp_documents.stock_launch_date(d.id) then raise exception 'purchase_receipt_launch_date_mismatch' using errcode='22023';end if;
 end if;
 perform erp_stock.document_meta(p_day,p_reason);
 if p_action not in('receive','reverse')or p_action is null then raise exception 'purchase_receipt_input_invalid'using errcode='22023';end if;
 if exists(select 1 from erp_stock.document_posting where document_id=d.id)then raise exception 'purchase_receipt_legacy_mode'using errcode='40001';end if;
 if p_action='receive'then
  if not erp_stock.document_eligible(d.kind,d.status)then raise exception 'purchase_receipt_ineligible_state'using errcode='40001';end if;
  if p_items is null or jsonb_typeof(p_items)<>'array'or jsonb_array_length(p_items)not between 1 and 250 or octet_length(p_items::text)>131072 then raise exception 'purchase_receipt_items_invalid'using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(p_items)j where jsonb_typeof(j)<>'object'or jsonb_typeof(j->'item_id')is distinct from'string'
   or coalesce(j->>'item_id','')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'or jsonb_typeof(j->'quantity')is distinct from'string'
   or coalesce(j->>'quantity','')!~'^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$'or exists(select 1 from jsonb_object_keys(j)k where k not in('item_id','quantity')))then raise exception 'purchase_receipt_items_invalid'using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(p_items)j where(j->>'quantity')::numeric<=0)
   or exists(select 1 from jsonb_array_elements(p_items)j group by j->>'item_id'having count(*)>1)
   or exists(select 1 from jsonb_array_elements(p_items)j where not exists(select 1 from erp_documents.item where id=(j->>'item_id')::uuid and document_id=d.id))then raise exception 'purchase_receipt_items_invalid'using errcode='22023';end if;
  selection:=p_items;
 else
  select * into r from erp_purchase_receipts.receipt where id=p_receipt and document_id=d.id;
  if r.id is null then raise exception 'purchase_receipt_not_found'using errcode='P0002';end if;
  if exists(select 1 from erp_purchase_receipts.reversal where receipt_id=r.id)then raise exception 'purchase_receipt_already_reversed'using errcode='40001';end if;
  if p_day<(r.snapshot->>'occurred_on')::date then raise exception 'purchase_receipt_reversal_date_invalid'using errcode='22023';end if;
  select jsonb_agg(jsonb_build_object('item_id',j->'item_id','quantity',j->'quantity'))into selection from jsonb_array_elements(r.snapshot->'items')j;
 end if;
 -- Same business-lock order as018/070. All sources are reread after the mutex/catalog waits.
 perform pg_advisory_xact_lock(174852909,0);perform erp_purchase_receipts.access(p_actor);
 -- 259: a pedido de compra whose entry note posted the stock ("S" of the note) is not received again.
 if p_action='receive' and erp_stock.invoice_posted_for_document(d.id) then raise exception 'purchase_receipt_posted_by_invoice' using errcode='40001';end if;
 perform 1 from erp_catalog.record where id=d.warehouse_id or id in(select i.product_id from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid where i.document_id=d.id)order by id for update;
 perform erp_purchase_receipts.access(p_actor);
 perform 1 from erp_catalog.product where record_id in(select i.product_id from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid where i.document_id=d.id)order by record_id for update;
 perform erp_purchase_receipts.access(p_actor);
 perform 1 from erp_stock.balance where warehouse_id=d.warehouse_id and product_id in(select i.product_id from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid where i.document_id=d.id)order by product_id,warehouse_id for update;
 perform erp_purchase_receipts.access(p_actor,true);
 select c.* into w from erp_catalog.record c join erp_catalog.warehouse x on x.record_id=c.id where c.id=d.warehouse_id;
 if w.id is null or(p_action='receive'and not w.active)then raise exception 'purchase_receipt_warehouse_unavailable'using errcode='22023';end if;
 for row in select i.*,c.active,c.version catalog_version,p.unit product_unit,p.kind product_kind,p.format,j->>'quantity' requested
  from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid
  left join erp_catalog.record c on c.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id where i.document_id=d.id order by i.position loop
  if row.product_id is null or row.product_kind is distinct from'P'or row.product_unit is null or(p_action='receive'and(not coalesce(row.active,false)or row.format in('E','V')))then raise exception 'purchase_receipt_product_unavailable'using errcode='22023';end if;
  if row.product_unit is distinct from row.data->>'unit'then raise exception 'purchase_receipt_unit_mismatch'using errcode='22023';end if;
  qty:=row.requested::numeric*case when p_action='receive'then 1 else -1 end;net:=erp_purchase_receipts.received(d.id,row.id);
  if net+qty<0 or net+qty>row.quantity then raise exception 'purchase_receipt_quantity_exceeded'using errcode='40001';end if;
  lines:=lines||jsonb_build_array(jsonb_build_object('item_id',row.id,'position',row.position,'product_id',row.product_id,'unit',row.product_unit,'ordered_quantity',row.quantity::text,
   'quantity',qty::numeric(18,6)::text,'received_before',net::numeric(18,6)::text,'received_after',(net+qty)::numeric(18,6)::text,'remaining_after',(row.quantity-net-qty)::numeric(18,6)::text));
 end loop;
 if jsonb_array_length(lines)<>jsonb_array_length(selection)then raise exception 'purchase_receipt_items_changed'using errcode='40001';end if;
 -- Check numeric range before formatting numeric(18,6); a full position must
 -- produce the same closed business conflict, never an intermediate cast overflow.
 -- 224: a reversed position that keeps its balance (Balanço after the receipt, option off) is not refused for its balance.
 if exists(select 1 from(select(j->>'product_id')::uuid product_id,sum((j->>'quantity')::numeric)qty from jsonb_array_elements(lines)j group by j->>'product_id')g
  left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id
  where((g.qty<0 and coalesce(b.quantity,0)+g.qty<0 and not erp_stock.negative_allowed())
  or coalesce(b.quantity,0)+g.qty>999999999999.999999 or coalesce(b.quantity,0)+g.qty<-999999999999.999999
  or(g.qty<0 and erp_stock.reserved_quantity(g.product_id,w.id)>0 and coalesce(b.quantity,0)+g.qty-erp_stock.reserved_quantity(g.product_id,w.id)<0))
  and not(p_action='reverse' and erp_stock.balance_kept(r.movement_id,g.product_id,w.id))or b.version=2147483647)then
  raise exception 'purchase_receipt_balance_unavailable'using errcode='40001';end if;
 with groups as(select(j->>'product_id')::uuid product_id,sum((j->>'quantity')::numeric)qty from jsonb_array_elements(lines)j group by j->>'product_id')
 select jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',c.name,'warehouse_id',w.id,'unit',p.unit,'quantity',g.qty::numeric(18,6)::text,
  'catalog_version',c.version,'physical_version',coalesce(b.version,0),'reservation_hash',erp_stock.reservation_position_hash(g.product_id,w.id),
  'physical_before',coalesce(b.quantity,0)::numeric(18,6)::text,'reserved_before',q.qty::numeric(18,6)::text,'available_before',(coalesce(b.quantity,0)-q.qty)::numeric(18,6)::text,
  'physical_after',(coalesce(b.quantity,0)+g.qty)::numeric(18,6)::text,'available_after',(coalesce(b.quantity,0)+g.qty-q.qty)::numeric(18,6)::text)
  -- 224: the conferência of the reversal says which positions keep their balance (the compensation is posted with the reversal).
  ||case when p_action='reverse' and erp_stock.balance_kept(r.movement_id,g.product_id,w.id) then '{"balance_kept":true}'::jsonb else '{}'::jsonb end order by g.product_id)into positions
 from groups g join erp_catalog.record c on c.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id cross join lateral(select erp_stock.reserved_quantity(g.product_id,w.id)qty)q;
 if positions is null or jsonb_array_length(positions)not between 1 and 100 then raise exception 'purchase_receipt_position_limit'using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(positions)j where(((j->>'quantity')::numeric<0 and(j->>'physical_after')::numeric<0 and not erp_stock.negative_allowed())
  or(j->>'physical_after')::numeric>999999999999.999999 or(j->>'physical_after')::numeric<-999999999999.999999
  or((j->>'quantity')::numeric<0 and(j->>'reserved_before')::numeric>0 and(j->>'available_after')::numeric<0))
  and not(p_action='reverse' and erp_stock.balance_kept(r.movement_id,(j->>'product_id')::uuid,w.id))or(j->>'physical_version')::integer=2147483647)then raise exception 'purchase_receipt_balance_unavailable'using errcode='40001';end if;
 result:=jsonb_build_object('action',p_action,'document',erp_purchase_receipts.document(d.id),'receipt_id',p_receipt,'occurred_on',p_day,'reason',btrim(p_reason),
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'items',lines,'positions',positions);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end$$;

-- 4. Novo Lançamento (105/260) and the amendment of an entry in the extrato (105) with the decimals of the entries.
create or replace function public.erp_stock_launch(p_user_id uuid,p_command_id uuid,p_kind text,p_product_id uuid,p_warehouse_id uuid,p_quantity text,
  p_expected_version integer,p_unit_price text default null,p_unit_cost text default null,p_note text default null,
  p_destination_id uuid default null,p_destination_version integer default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.ledger_command;v_note text;v_reason text;v_default text;v_quantity numeric;v_price numeric;v_cost numeric;v_day date;
  b erp_stock.balance;v_current numeric:=0;v_delta numeric;v_items jsonb;v_post jsonb;v_movement uuid;v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_kind is null or p_kind not in('receipt','issue','balance','transfer') or p_product_id is null or p_warehouse_id is null
  or p_expected_version is null or p_expected_version not between 0 and 2147483646 or p_quantity is null
  or p_quantity!~(case when p_kind='balance' then '^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' else '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' end)
  or p_quantity~'^-0(\.0+)?$' or(p_kind<>'balance' and p_quantity::numeric=0)
  or(p_kind='transfer')<>(p_destination_id is not null)or(p_destination_id is null)<>(p_destination_version is null)
  or p_destination_version not between 0 and 2147483646 or p_destination_id=p_warehouse_id
  or(p_kind='issue' and p_unit_cost is not null)or length(p_note)>500 or p_note~'[[:cntrl:]]' then
  raise exception 'erp_stock_launch_invalid' using errcode='22023';end if;
 v_price:=erp_stock.price_105(p_unit_price);v_cost:=erp_stock.price_105(p_unit_cost);v_quantity:=p_quantity::numeric;
 v_default:=case when p_kind='transfer' then 'Transferência' else 'Lançamento manual' end;
 v_note:=coalesce(nullif(btrim(p_note),''),v_default);v_reason:=case when length(v_note)>=3 then v_note else v_default end;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-launch-105','actor',p_user_id,'kind',p_kind,'product_id',p_product_id,
  'warehouse_id',p_warehouse_id,'quantity',p_quantity,'expected_version',p_expected_version,'unit_price',p_unit_price,'unit_cost',p_unit_cost,
  'note',p_note,'destination_id',p_destination_id,'destination_version',p_destination_version)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into c from erp_stock.ledger_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'launch' or c.request_hash<>h then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
 -- 277: Preferências › Empresa › Geral "Número de casas decimais no preço nas entradas": the Preço de Compra and the Preço de Custo of an
 -- Entrada or a Balanço (also with Lote) never carry more decimals than configured; the stored precision stays 10.
 if p_kind in('receipt','balance') then perform erp_stock.entry_price_check(p_unit_price);perform erp_stock.entry_price_check(p_unit_cost);end if;
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 -- 260: a Físico composition whose "Lançar estoque" is Componentes or Produto e componente is launched by the Novo Lançamento of the
 -- composition (222), which also moves the components: a direct Entrada or Saída of its own stock is refused. Balanço and
 -- transferência keep moving its own stock.
 if p_kind in('receipt','issue') and exists(select 1 from erp_stock.composition k join erp_catalog.product x on x.record_id=k.product_id
   where k.product_id=p_product_id and x.format='E' and k.post_mode in('components','both'))then
  raise exception 'erp_stock_composition_launch_required' using errcode='22023';end if;
 v_day:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
 if p_kind='balance' then
  -- Every balance writer holds mutex009, so the balance read here is the one the 009 post will update.
  select * into b from erp_stock.balance where product_id=p_product_id and warehouse_id=p_warehouse_id;
  v_current:=coalesce(b.quantity,0);
  if coalesce(b.version,0)<>p_expected_version then raise exception 'erp_stock_version_conflict' using errcode='40001';end if;
  v_delta:=v_quantity-v_current;
  if v_delta=0 then raise exception 'erp_stock_balance_unchanged' using errcode='22023';end if;
  if abs(v_delta)>999999999999.999999 then raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
  v_items:=jsonb_build_array(jsonb_build_object('product_id',p_product_id,'warehouse_id',p_warehouse_id,'quantity',v_delta::numeric(18,6)::text,'expected_version',p_expected_version));
 elsif p_kind='transfer' then
  v_items:=jsonb_build_array(jsonb_build_object('product_id',p_product_id,'warehouse_id',p_warehouse_id,'quantity','-'||p_quantity,'expected_version',p_expected_version),
   jsonb_build_object('product_id',p_product_id,'warehouse_id',p_destination_id,'quantity',p_quantity,'expected_version',p_destination_version));
 else
  v_items:=jsonb_build_array(jsonb_build_object('product_id',p_product_id,'warehouse_id',p_warehouse_id,'quantity',case when p_kind='issue' then '-'||p_quantity else p_quantity end,'expected_version',p_expected_version));
 end if;
 v_post:=erp_stock.post(p_user_id,p_command_id,case when p_kind='balance' then 'adjustment' else p_kind end,v_day,v_reason,null,v_items);
 if coalesce((v_post->>'replayed')::boolean,true)then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
 v_movement:=(v_post#>>'{movement,id}')::uuid;
 v_result:=jsonb_build_object('scope','stock_launch','data_mode','erp_native','kind',p_kind,'occurred_on',v_day,'movement',v_post->'movement',
  'detail',jsonb_build_object('revision',1,'unit_price',erp_stock.price_text(v_price),'unit_cost',erp_stock.price_text(v_cost),'note',v_note),
  'balance',case when p_kind='balance' then jsonb_build_object('counted',v_quantity::numeric(18,6)::text,'previous',v_current::numeric(18,6)::text,'warehouse_id',p_warehouse_id,'source','launch')end);
 insert into erp_stock.ledger_command(id,actor,action,movement_id,request_hash,result)values(p_command_id,p_user_id,'launch',v_movement,h,v_result);
 insert into erp_stock.movement_detail(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id)values(v_movement,p_product_id,1,v_price,v_cost,v_note,p_user_id,p_command_id);
 if p_kind='balance' then
  insert into erp_stock.balance_count(movement_id,product_id,warehouse_id,counted,previous,source)values(v_movement,p_product_id,p_warehouse_id,v_quantity,v_current,'launch');
 end if;
 perform erp_stock.reservation_write_access(p_user_id);
 return v_result||jsonb_build_object('replayed',false);
end$$;

create or replace function public.erp_stock_movement_amend(p_user_id uuid,p_command_id uuid,p_movement_id uuid,p_product_id uuid,p_expected_revision integer,
  p_unit_price text,p_unit_cost text,p_note text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.ledger_command;d erp_stock.movement_detail;v_price numeric;v_cost numeric;v_note text;v_was_price numeric;v_was_note text;v_kind text;v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_movement_id is null or p_product_id is null or p_expected_revision is null or p_expected_revision not between 0 and 2147483646
  or p_note is null or length(p_note)>500 or p_note~'[[:cntrl:]]' then raise exception 'erp_stock_amend_invalid' using errcode='22023';end if;
 v_price:=erp_stock.price_105(p_unit_price);v_cost:=erp_stock.price_105(p_unit_cost);v_note:=btrim(p_note);
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-amend-105','actor',p_user_id,'movement_id',p_movement_id,'product_id',p_product_id,'expected_revision',p_expected_revision,
  'unit_price',p_unit_price,'unit_cost',p_unit_cost,'note',p_note)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into c from erp_stock.ledger_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'amend' or c.request_hash<>h then raise exception 'erp_stock_amend_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_amend_conflict' using errcode='40001';end if;
 if not exists(select 1 from erp_stock.entry where movement_id=p_movement_id and product_id=p_product_id)then raise exception 'erp_stock_movement_not_found' using errcode='P0002';end if;
 -- The prices of a document lançamento belong to that document: only a reader of its kind (008) may change them.
 v_kind:=erp_stock.ledger_origin(p_movement_id)->>'document_kind';
 if v_kind is not null and not erp_documents.allowed((select role from erp_access.membership where user_id=p_user_id and active),v_kind,false)then
  raise exception 'erp_stock_amend_access_denied' using errcode='42501';end if;
 -- One amendment at a time per lançamento; the ledger rows themselves are never locked or rewritten.
 perform pg_advisory_xact_lock(174852919,hashtext(p_movement_id::text||p_product_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into d from erp_stock.movement_detail where movement_id=p_movement_id and product_id=p_product_id order by revision desc limit 1;
 if coalesce(d.revision,0)<>p_expected_revision or coalesce(d.revision,0)=2147483647 then raise exception 'erp_stock_amend_version_conflict' using errcode='40001';end if;
 if d.movement_id is not null then v_was_price:=d.unit_price;v_was_note:=d.note;
 else select reason into v_was_note from erp_stock.movement where id=p_movement_id;
  v_was_price:=erp_stock.ledger_document_price(p_movement_id,p_product_id);end if;
 if v_price is not distinct from v_was_price and v_cost is not distinct from d.unit_cost and v_note=v_was_note then
  raise exception 'erp_stock_amend_unchanged' using errcode='22023';end if;
 -- 277: the entry of an Entrada or a Balanço keeps "Número de casas decimais no preço nas entradas" for a changed price or cost.
 if exists(select 1 from erp_stock.entry e join erp_stock.movement m on m.id=e.movement_id where e.movement_id=p_movement_id and e.product_id=p_product_id
   and e.quantity>0 and m.kind in('receipt','adjustment'))then
  if v_price is distinct from v_was_price then perform erp_stock.entry_price_check(p_unit_price);end if;
  if v_cost is distinct from d.unit_cost then perform erp_stock.entry_price_check(p_unit_cost);end if;
 end if;
 v_result:=jsonb_build_object('scope','stock_amend','data_mode','erp_native','movement_id',p_movement_id,'product_id',p_product_id,
  'from',jsonb_build_object('revision',coalesce(d.revision,0),'unit_price',erp_stock.price_text(v_was_price),'unit_cost',erp_stock.price_text(d.unit_cost),'note',v_was_note),
  'detail',jsonb_build_object('revision',coalesce(d.revision,0)+1,'unit_price',erp_stock.price_text(v_price),'unit_cost',erp_stock.price_text(v_cost),'note',v_note),
  'amended_at',clock_timestamp());
 insert into erp_stock.ledger_command(id,actor,action,movement_id,request_hash,result)values(p_command_id,p_user_id,'amend',p_movement_id,h,v_result);
 insert into erp_stock.movement_detail(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id)values(p_movement_id,p_product_id,coalesce(d.revision,0)+1,v_price,v_cost,v_note,p_user_id,p_command_id);
 perform erp_stock.reservation_write_access(p_user_id);
 return v_result||jsonb_build_object('replayed',false);
end$$;

create or replace function public.erp_stock_launch_context(p_user_id uuid,p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s jsonb;p erp_catalog.product;v_price numeric;v_cost numeric;v_on date;v_movement uuid;v_source text;v_avg numeric;v_type text;f record;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_product_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 select * into p from erp_catalog.product where record_id=p_product_id;
 if not found then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 s:=erp_stock.settings_dto();v_type:=s->>'price_type';
 if v_type='ultima_compra' then
  select x.unit_price,x.unit_cost,x.occurred_on,x.movement_id,x.source into v_price,v_cost,v_on,v_movement,v_source from erp_stock.last_purchase(p_product_id,(s->>'consider_balances')::boolean)x;
 end if;
 select c.average_cost into v_avg from erp_stock.average_costs(array[p_product_id])c;
 select * into f from erp_stock.default_supplier(p_product_id);
 return jsonb_build_object('scope','stock_launch_context','data_mode','erp_native','product_id',p_product_id,
  'settings',jsonb_build_object('show_unit_price',s->'show_unit_price','price_type',v_type,'consider_balances',s->'consider_balances','average_cost_base',s->'average_cost_base'),
  'last_purchase',case when v_price is not null then jsonb_build_object('unit_price',erp_stock.price_text(v_price),'unit_cost',erp_stock.price_text(v_cost),
   'occurred_on',v_on,'movement_id',v_movement,'source',v_source)end,
  'average_cost',erp_stock.price_text(v_avg),'sale_price',erp_stock.price_text(p.price),
  -- 277: decimals allowed in the Preço de Compra / Preço de Custo of an Entrada or a Balanço (Preferências › Empresa › Geral).
  'price_decimals',jsonb_build_object('entry',erp_stock.entry_decimals()),
  'default_supplier',case when f.supplier_id is not null then jsonb_build_object('supplier_id',f.supplier_id,'supplier_name',f.supplier_name,'code',f.code,
   'purchase_price',erp_stock.price_text(f.purchase_price),'cost_price',erp_stock.price_text(f.cost_price))end);
end$$;

-- 5. Reserva pelas situações de venda (145/222/226/259) with custom situations.
create or replace function erp_stock.situation_reservations(p_product uuid default null)
returns table(document_id uuid,document_number bigint,status text,contact_name text,product_id uuid,warehouse_id uuid,quantity numeric,unit text)
language sql stable set search_path=pg_catalog as $$
 with s as(select erp_stock.reserve_statuses() statuses,erp_stock.reserve_situation_ids() situation_ids,(erp_stock.settings_dto()->>'reserve_by_warehouse')::boolean by_warehouse,
   (select d.warehouse_id from erp_stock.warehouse_default d where d.singleton) standard),
 items as(select d.id,d.number,d.status,d.contact_snapshot,d.warehouse_id,i.product_id,i.quantity,p.unit,p.format
  from s cross join erp_documents.document d join erp_documents.item i on i.document_id=d.id join erp_catalog.product p on p.record_id=i.product_id
  -- 277: also a pedido in a custom situation (situação personalizada, 163) chosen in "Reserva de estoque pelas situações de venda".
  where(cardinality(s.statuses)>0 or cardinality(s.situation_ids)>0) and d.kind='sales_orders'
   and(d.status=any(s.statuses) or exists(select 1 from erp_documents.document_situation ds where ds.document_id=d.id and ds.situation_id=any(s.situation_ids)))
   -- One product (Saldos do produto): its own items and the composition items that have it as a component, as the 145 filter did.
   and(p_product is null or i.product_id=p_product or exists(select 1 from erp_stock.composition_current c where c.product_id=i.product_id and c.component_id=p_product))
   and p.kind='P' and p.unit is not null and i.data->>'unit' is not distinct from p.unit
   and not exists(select 1 from erp_stock.document_posting x where x.document_id=d.id and x.state='active')
   -- 259: a pedido whose note posted the stock has no reservation left.
   and not erp_stock.invoice_posted_for_document(d.id)
   and not exists(select 1 from erp_stock.reservation r where r.document_id=d.id and r.state='active')),
 -- 222: a composition item reserves what its lançamento would move; a composition without a structure reserves nothing.
 lines as(select x.id,x.number,x.status,x.contact_snapshot,x.warehouse_id,x.product_id target,x.quantity qty,x.unit target_unit from items x where x.format is distinct from 'E'
  union all
  select x.id,x.number,x.status,x.contact_snapshot,x.warehouse_id,x.product_id,x.quantity,x.unit from items x join erp_stock.composition c on c.product_id=x.product_id
   where x.format='E' and c.post_mode in('product','both')
  union all
  select x.id,x.number,x.status,x.contact_snapshot,x.warehouse_id,ci.component_id,x.quantity*ci.quantity,cp.unit from items x join erp_stock.composition_current ci on ci.product_id=x.product_id
   join erp_catalog.product cp on cp.record_id=ci.component_id
   where x.format='E' and ci.post_mode in('components','both') and cp.kind='P' and cp.unit is not null)
 select l.id,l.number,l.status,l.contact_snapshot->>'name',l.target,case when s.by_warehouse then coalesce(l.warehouse_id,s.standard)end,sum(l.qty),l.target_unit
 from s cross join lines l where p_product is null or l.target=p_product
 group by l.id,l.number,l.status,l.contact_snapshot,l.target,l.target_unit,s.by_warehouse,s.standard,l.warehouse_id
$$;

create or replace function public.erp_stock_product_reservations(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_product_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 if not exists(select 1 from erp_catalog.product where record_id=p_product_id)then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id)then
  raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 with rows as materialized(
   select r.id,'reservation'::text source,d.id document_id,d.number,d.status,d.contact_snapshot->>'name' contact_name,i.warehouse_id,i.quantity,i.unit,r.created_at
   from erp_stock.reservation r join erp_stock.reservation_item i on i.reservation_id=r.id join erp_documents.document d on d.id=r.document_id
   where r.state='active' and i.product_id=p_product_id and(p_warehouse_id is null or i.warehouse_id=p_warehouse_id)
   union all
   select null,'situation',x.document_id,x.document_number,x.status,x.contact_name,x.warehouse_id,x.quantity,x.unit,null
   from erp_stock.situation_reservations(p_product_id)x where p_warehouse_id is null or x.warehouse_id=p_warehouse_id or x.warehouse_id is null),
  page as materialized(select * from rows order by number desc,source,id limit 100)
 select jsonb_build_object('product_id',p_product_id,'warehouse_id',p_warehouse_id,
  'items',coalesce((select jsonb_agg(jsonb_build_object('reservation_id',id,'source',source,'document_id',document_id,'document_number',number::text,'status',status,
    'contact_name',contact_name,'warehouse_id',warehouse_id,'warehouse_ignored',case when warehouse_id is not null then erp_stock.ignored_warehouse(warehouse_id) else false end,
    'quantity',quantity::numeric(18,6)::text,'unit',unit,'reserved_at',created_at)
    -- 277: the custom situation of a pedido reserved by its situation (null: the situação padrão of its status).
    ||coalesce(case when source='situation' then(select jsonb_build_object('situation_id',x.id,'situation_name',x.name) from erp_documents.document_situation ds
      join erp_preferences.situation x on x.id=ds.situation_id where ds.document_id=page.document_id)end,'{"situation_id":null,"situation_name":null}'::jsonb) order by number desc,source,id)from page),'[]'::jsonb),
  'total',(select count(*)from rows)::integer,'quantity',(select coalesce(sum(quantity),0)from rows)::numeric(38,6)::text,
  'reservation',(select jsonb_build_object('by_situation',s->'reserve_by_situation','by_warehouse',s->'reserve_by_warehouse','statuses',s->'reserve_statuses',
   'situation_ids',to_jsonb(erp_stock.reserve_situation_ids()))from(select erp_stock.settings_dto() s)x),
  'scope','stock_product_reservations','data_mode','erp_native') into v_result;
 return v_result;
end$$;

-- 6. Importação de lotes: one lot per line, created by its code in the product or updated (dates and Obs.). A null field keeps the value
-- of an existing lot. Same rules as "+ Adicionar lote" (258): Controle de lote on (for a new lot), unique code, dates in order and the
-- required dates of Preferências › Cadastros › Controle de lotes. Unchanged lines answer "unchanged". Grava quem lança estoque.
create function public.erp_stock_lot_import(p_user_id uuid,p_command_id uuid,p_product_id uuid,p_code text,p_manufactured_on date default null,
  p_expires_on date default null,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.lot_command;l erp_stock.lot;v_id uuid;v_note text;v_problem text;v_outcome text;v_made date;v_expires date;v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_product_id is null or p_code is null or length(btrim(p_code)) not between 1 and 60 or p_code~'[[:cntrl:]]'
  or length(p_note)>500 or p_note~'[[:cntrl:]]' then raise exception 'erp_stock_lot_invalid' using errcode='22023';end if;
 v_note:=nullif(btrim(p_note),'');
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-lot-import-277','actor',p_user_id,'product_id',p_product_id,'code',p_code,
  'manufactured_on',p_manufactured_on,'expires_on',p_expires_on,'note',p_note)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into c from erp_stock.lot_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'save' or c.request_hash<>h then raise exception 'erp_stock_lot_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_lot_conflict' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 perform 1 from erp_catalog.record where id=p_product_id for update;
 v_problem:=erp_stock.lot_product_problem(p_product_id);
 if v_problem='not_found' then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 select * into l from erp_stock.lot where product_id=p_product_id and lower(code)=lower(btrim(p_code)) for update;
 if l.id is null then
  if v_problem is not null then raise exception 'erp_stock_lot_control_off' using errcode='22023',detail=v_problem;end if;
  perform erp_stock.lot_check(p_code,p_manufactured_on,p_expires_on,v_note);
  insert into erp_stock.lot(product_id,code,manufactured_on,expires_on,note,version,created_by,updated_by,command_id)
   values(p_product_id,btrim(p_code),p_manufactured_on,p_expires_on,v_note,1,p_user_id,p_user_id,p_command_id) returning id into v_id;
  v_outcome:='created';
 else
  v_made:=coalesce(p_manufactured_on,l.manufactured_on);v_expires:=coalesce(p_expires_on,l.expires_on);v_note:=coalesce(v_note,l.note);v_id:=l.id;
  if l.manufactured_on is not distinct from v_made and l.expires_on is not distinct from v_expires and l.note is not distinct from v_note then v_outcome:='unchanged';
  else
   perform erp_stock.lot_check(l.code,v_made,v_expires,v_note);
   update erp_stock.lot set manufactured_on=v_made,expires_on=v_expires,note=v_note,version=version+1,updated_at=clock_timestamp(),updated_by=p_user_id,command_id=p_command_id
    where id=l.id;
   v_outcome:='updated';
  end if;
 end if;
 v_result:=jsonb_build_object('scope','stock_lot_import','data_mode','erp_native','outcome',v_outcome,'lot',erp_stock.lot_dto(v_id));
 insert into erp_stock.lot_command(id,actor,action,product_id,lot_id,request_hash,result)values(p_command_id,p_user_id,'save',p_product_id,v_id,h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_purchase_receipts from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_positions','erp_stock_launch','erp_stock_movement_amend','erp_stock_launch_context','erp_stock_product_reservations','erp_stock_lot_import')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
