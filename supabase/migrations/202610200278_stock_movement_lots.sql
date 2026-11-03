-- 278: "Informar lotes de produtos" de um lançamento já gravado, no padrão do Origin (onda F do estoque). Requer 238, 258 e 259.
-- Nenhum movimento, saldo de depósito, documento ou nota é reescrito: o lote é uma divisão da linha do razão (258).
-- - Cada linha de Entrada ou Saída do razão (lançamento manual, pedido de venda, OS, pedido de compra inteiro ou recebimento, composição e
--   nota fiscal do Brufap) de um produto com "Controle de lote" pode receber lotes depois de gravada: "Informar lotes de produtos" com
--   Lote (existente ou, na entrada, "Novo lote" com Validade e Fabricação), Quantidade, "Dividir os lotes", "Adicionar novo lote" e
--   "Remover lote". O que não for informado continua "Sem lote". A soma nunca passa da quantidade da linha.
-- - Saída: tira do saldo do lote no depósito (o lote nunca fica negativo). Entrada: põe no lote, sem passar do "Sem lote" do depósito
--   (saldo do depósito menos a soma dos lotes), para que a soma dos lotes nunca passe do saldo.
-- - Um lançamento estornado, um estorno, uma transferência ou um balanço não recebem lotes por aqui (a transferência e o balanço já
--   recebem o Lote no próprio lançamento); o estorno de uma linha com lotes devolve os lotes (gatilho de 258).
-- - "Informações de lote lançado" de um item de pedido de venda, OS, pedido de compra ou nota fiscal: as linhas do estoque lançado pelo
--   documento (lançamento ativo e recebimentos não estornados) ou pela nota (lançamento ativo da nota, ou da referência quando foi o
--   documento ligado que lançou) para o produto do item, com os lotes de cada uma.
-- - Comando idempotente ("Conferir resultado"), versão esperada (número de linhas de lote da linha do razão), mutex do estoque, auditoria
--   pelo recibo imutável do comando (erp_stock.lot_command, ação "assign").
-- Funções novas; nenhuma função publicada é substituída. A única alteração de tabela é a lista de ações de erp_stock.lot_command.
begin;

do $$begin
 if to_regclass('erp_stock.lot_entry') is null or to_regclass('erp_stock.invoice_posting') is null
  or to_regprocedure('erp_documents.contact_usable(uuid,uuid)') is null or to_regprocedure('erp_stock.invoice_access(uuid,boolean)') is null then
  raise exception 'stock_movement_lots_278_requires_238_258_259' using errcode='55000';end if;
 if to_regprocedure('public.erp_stock_movement_lots(uuid,uuid,uuid,uuid)') is not null then
  raise exception 'stock_movement_lots_278_already_applied' using errcode='55000';end if;
end$$;

alter table erp_stock.lot_command drop constraint lot_command_action_check;
alter table erp_stock.lot_command add constraint lot_command_action_check check(action in('save','status','launch','assign'));

-- 1. A line of the razão (movement, product, warehouse) with its lots: what is informed, what stays "Sem lote" and whether it can receive
-- lots ("kind": not an Entrada or a Saída; "reversed": the lançamento was reversed; "lot_control_off"; "assigned": nothing left).
create function erp_stock.movement_lot_line(p_movement uuid,p_product uuid,p_warehouse uuid)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare e erp_stock.entry;m erp_stock.movement;v_assigned numeric;v_count integer;v_reason text;begin
 select * into e from erp_stock.entry where movement_id=p_movement and product_id=p_product and warehouse_id=p_warehouse;
 if e.movement_id is null then return null;end if;
 select * into m from erp_stock.movement where id=p_movement;
 select coalesce(sum(abs(x.quantity)),0),count(*)::integer into v_assigned,v_count from erp_stock.lot_entry x
  where x.movement_id=p_movement and x.product_id=p_product and x.warehouse_id=p_warehouse;
 v_reason:=case when m.kind not in('receipt','issue') then 'kind'
  when exists(select 1 from erp_stock.movement r where r.reverses_id=m.id) then 'reversed'
  when erp_stock.lot_product_problem(p_product) is not null then 'lot_control_off'
  when abs(e.quantity)-v_assigned<=0 then 'assigned' end;
 return jsonb_build_object('movement_id',m.id,'product_id',p_product,'warehouse_id',p_warehouse,
  'warehouse_name',(select name from erp_catalog.record where id=p_warehouse),'kind',m.kind,'direction',case when e.quantity>0 then 'receipt' else 'issue' end,
  'occurred_on',m.occurred_on,'reason',m.reason,'quantity',abs(e.quantity)::numeric(18,6)::text,'assigned',v_assigned::numeric(18,6)::text,
  'unassigned',(abs(e.quantity)-v_assigned)::numeric(18,6)::text,'lots_version',v_count,'assignable',v_reason is null,'reason_code',v_reason,
  'origin',erp_stock.ledger_origin(m.id),
  'lots',coalesce((select jsonb_agg(jsonb_build_object('lot_id',l.id,'code',l.code,'manufactured_on',l.manufactured_on,'expires_on',l.expires_on,
    'quantity',abs(x.quantity)::numeric(18,6)::text) order by l.expires_on nulls last,lower(l.code),l.id)
   from erp_stock.lot_entry x join erp_stock.lot l on l.id=x.lot_id where x.movement_id=p_movement and x.product_id=p_product and x.warehouse_id=p_warehouse),'[]'::jsonb));
end$$;
-- The prices and lots of a document lançamento belong to that document: only a reader of its kind (008) sees or informs them (as 105).
create function erp_stock.lot_origin_access(p_user uuid,p_origin jsonb)returns void language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;begin
 select role into v_role from erp_access.membership where user_id=p_user and active;
 if p_origin->>'type' in('sales','purchases','services') and not erp_documents.allowed(v_role,p_origin->>'document_kind',false) then
  raise exception 'erp_stock_lot_origin_denied' using errcode='42501';end if;
end$$;
-- "Sem lote" of a product in a warehouse: the balance minus the lots (258).
create function erp_stock.unassigned_quantity(p_product uuid,p_warehouse uuid)returns numeric language sql stable set search_path=pg_catalog as $$
 select coalesce((select quantity from erp_stock.balance where product_id=p_product and warehouse_id=p_warehouse),0)
  -coalesce((select sum(b.quantity) from erp_stock.lot_balance b join erp_stock.lot l on l.id=b.lot_id where l.product_id=p_product and b.warehouse_id=p_warehouse),0)
$$;
-- The lots offered for a line: Saída, the active lots with stock in the warehouse; Entrada, every active lot (and "Novo lote").
create function erp_stock.movement_lot_candidates(p_product uuid,p_warehouse uuid,p_direction text)returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'code',x.code,'manufactured_on',x.manufactured_on,'expires_on',x.expires_on,'quantity',x.qty::numeric(18,6)::text)
  order by x.expires_on nulls last,lower(x.code),x.id),'[]'::jsonb)
 from(select l.id,l.code,l.manufactured_on,l.expires_on,coalesce(b.quantity,0) qty from erp_stock.lot l
   left join erp_stock.lot_balance b on b.lot_id=l.id and b.warehouse_id=p_warehouse
  where l.product_id=p_product and l.active and(p_direction='receipt' or coalesce(b.quantity,0)>0)
  order by l.expires_on nulls last,lower(l.code),l.id limit 100)x
$$;
create function erp_stock.movement_lots_dto(p_user uuid,p_line jsonb)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('line',p_line,
  'product',(select jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'unit',p.unit,'lot_control',erp_stock.lot_product_problem(r.id) is null)
   from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=(p_line->>'product_id')::uuid),
  -- What may still be informed now: the rest of the line; in an Entrada, never more than the "Sem lote" of the warehouse.
  'room',case when not(p_line->>'assignable')::boolean then '0.000000'
   when p_line->>'direction'='receipt' then greatest(least((p_line->>'unassigned')::numeric,erp_stock.unassigned_quantity((p_line->>'product_id')::uuid,(p_line->>'warehouse_id')::uuid)),0)::numeric(18,6)::text
   else(p_line->>'unassigned')::numeric(18,6)::text end,
  'candidates',case when(p_line->>'assignable')::boolean then erp_stock.movement_lot_candidates((p_line->>'product_id')::uuid,(p_line->>'warehouse_id')::uuid,p_line->>'direction') else '[]'::jsonb end,
  'settings',erp_stock.lot_settings(),
  'can_write',exists(select 1 from erp_access.membership where user_id=p_user and active and role in('admin','estoque')))
$$;

-- 2. Leitura de uma linha ("Informar lotes de produtos" do extrato). Quem lê estoque (e o tipo do documento, se for de um documento).
create function public.erp_stock_movement_lots(p_user_id uuid,p_movement_id uuid,p_product_id uuid,p_warehouse_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_line jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_movement_id is null or p_product_id is null or p_warehouse_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 v_line:=erp_stock.movement_lot_line(p_movement_id,p_product_id,p_warehouse_id);
 if v_line is null then raise exception 'erp_stock_movement_not_found' using errcode='P0002';end if;
 perform erp_stock.lot_origin_access(p_user_id,v_line->'origin');
 return jsonb_build_object('scope','stock_movement_lots','data_mode','erp_native')||erp_stock.movement_lots_dto(p_user_id,v_line);
end$$;

-- 3. Gravação: os lotes informados de uma linha. p_lots: [{"lot_id": uuid, "quantity": "1.5"} | {"code": "L1", "manufactured_on": "aaaa-mm-dd"|null,
-- "expires_on": "aaaa-mm-dd"|null, "quantity": "2"}] (o "Novo lote" só na entrada); p_expected_lots é o número de linhas de lote já
-- informadas na linha (versão esperada). Grava quem lança estoque.
create function public.erp_stock_movement_lots_assign(p_user_id uuid,p_command_id uuid,p_movement_id uuid,p_product_id uuid,p_warehouse_id uuid,
  p_expected_lots integer,p_lots jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.lot_command;v_line jsonb;r jsonb;l erp_stock.lot;v_sum numeric:=0;v_sign numeric;v_entries jsonb:='[]'::jsonb;v_result jsonb;
  v_made date;v_expires date;v_first uuid;v_entry jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_movement_id is null or p_product_id is null or p_warehouse_id is null or p_expected_lots is null or p_expected_lots not between 0 and 100000
  or p_lots is null or jsonb_typeof(p_lots)<>'array' or jsonb_array_length(p_lots) not between 1 and 50 or octet_length(p_lots::text)>32768
  or exists(select 1 from jsonb_array_elements(p_lots)j where jsonb_typeof(j)<>'object'
   or exists(select 1 from jsonb_object_keys(j)k where k not in('lot_id','code','manufactured_on','expires_on','quantity'))
   or(j ? 'lot_id')=(j ? 'code')
   or jsonb_typeof(j->'quantity') is distinct from 'string' or coalesce(j->>'quantity','')!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or(j->>'quantity')::numeric=0
   or(j ? 'lot_id' and(jsonb_typeof(j->'lot_id')<>'string' or j->>'lot_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or j ?| array['manufactured_on','expires_on']))
   or(j ? 'code' and(jsonb_typeof(j->'code')<>'string'
    or exists(select 1 from jsonb_each(j-'code'-'quantity')x where jsonb_typeof(x.value)<>'null' and(jsonb_typeof(x.value)<>'string' or x.value#>>'{}'!~'^\d{4}-\d{2}-\d{2}$')))))
  or(select count(distinct j->>'lot_id')from jsonb_array_elements(p_lots)j where j ? 'lot_id')<>(select count(*)from jsonb_array_elements(p_lots)j where j ? 'lot_id')
  or(select count(distinct lower(btrim(j->>'code')))from jsonb_array_elements(p_lots)j where j ? 'code')<>(select count(*)from jsonb_array_elements(p_lots)j where j ? 'code')then
  raise exception 'erp_stock_lot_assign_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-movement-lots-278','actor',p_user_id,'movement_id',p_movement_id,'product_id',p_product_id,
  'warehouse_id',p_warehouse_id,'expected_lots',p_expected_lots,'lots',p_lots)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into c from erp_stock.lot_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'assign' or c.request_hash<>h then raise exception 'erp_stock_lot_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_lot_conflict' using errcode='40001';end if;
 -- Lock order of every stock writer: command, stock mutex, catalog, then the lots and their balances.
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 perform 1 from erp_catalog.record where id=p_product_id for update;
 v_line:=erp_stock.movement_lot_line(p_movement_id,p_product_id,p_warehouse_id);
 if v_line is null then raise exception 'erp_stock_movement_not_found' using errcode='P0002';end if;
 perform erp_stock.lot_origin_access(p_user_id,v_line->'origin');
 if(v_line->>'lots_version')::integer<>p_expected_lots then raise exception 'erp_stock_lot_version_conflict' using errcode='40001';end if;
 if not(v_line->>'assignable')::boolean then raise exception 'erp_stock_lot_assign_unavailable' using errcode='22023',detail=v_line->>'reason_code';end if;
 select sum((j->>'quantity')::numeric) into v_sum from jsonb_array_elements(p_lots)j;
 if v_sum>(v_line->>'unassigned')::numeric then raise exception 'erp_stock_lot_assign_exceeded' using errcode='22023';end if;
 if v_line->>'direction'='issue' and exists(select 1 from jsonb_array_elements(p_lots)j where j ? 'code') then raise exception 'erp_stock_lot_assign_invalid' using errcode='22023';end if;
 v_sign:=case when v_line->>'direction'='receipt' then 1 else -1 end;
 -- Existing lots in UUID order, then the new ones by code.
 for r in select j from jsonb_array_elements(p_lots)j order by(j ? 'code'),j->>'lot_id',lower(btrim(j->>'code')) loop
  if r ? 'code' then
   begin v_made:=(r->>'manufactured_on')::date;v_expires:=(r->>'expires_on')::date;
   exception when others then raise exception 'erp_stock_lot_assign_invalid' using errcode='22023';end;
   perform erp_stock.lot_check(r->>'code',v_made,v_expires,null);
   if exists(select 1 from erp_stock.lot where product_id=p_product_id and lower(code)=lower(btrim(r->>'code')))then raise exception 'erp_stock_lot_code_taken' using errcode='22023';end if;
   insert into erp_stock.lot(product_id,code,manufactured_on,expires_on,version,created_by,updated_by,command_id)
    values(p_product_id,btrim(r->>'code'),v_made,v_expires,1,p_user_id,p_user_id,p_command_id) returning * into l;
  else
   select * into l from erp_stock.lot where id=(r->>'lot_id')::uuid for update;
   if l.id is null or l.product_id<>p_product_id then raise exception 'erp_stock_lot_not_found' using errcode='P0002';end if;
   if not l.active then raise exception 'erp_stock_lot_inactive' using errcode='22023';end if;
   if exists(select 1 from erp_stock.lot_entry where movement_id=p_movement_id and product_id=p_product_id and warehouse_id=p_warehouse_id and lot_id=l.id)then
    raise exception 'erp_stock_lot_assign_duplicate' using errcode='22023';end if;
  end if;
  v_first:=coalesce(v_first,l.id);
  v_entry:=erp_stock.lot_apply(p_movement_id,p_product_id,p_warehouse_id,l.id,v_sign*(r->>'quantity')::numeric);
  v_entries:=v_entries||jsonb_build_array(v_entry||jsonb_build_object('lot_id',l.id,'code',l.code,'created',r ? 'code'));
 end loop;
 -- An Entrada puts "Sem lote" units into lots: the lots of the warehouse never pass its balance.
 if v_sign>0 and erp_stock.unassigned_quantity(p_product_id,p_warehouse_id)<0 then raise exception 'erp_stock_lot_exceeds_unassigned' using errcode='22023';end if;
 v_result:=jsonb_build_object('scope','stock_movement_lots_assign','data_mode','erp_native','entries',v_entries)
  ||erp_stock.movement_lots_dto(p_user_id,erp_stock.movement_lot_line(p_movement_id,p_product_id,p_warehouse_id));
 insert into erp_stock.lot_command(id,actor,action,product_id,lot_id,request_hash,result)values(p_command_id,p_user_id,'assign',p_product_id,v_first,h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

-- 4. "Informações de lote lançado" de um item: as linhas do estoque lançado pelo documento ou pela nota, para o produto do item.
-- p_source 'document' (pedido de venda, OS, pedido de compra): lançamento ativo (018/184) e recebimentos não estornados (090);
-- 'invoice' (nota fiscal do Brufap): lançamento ativo da nota (259) ou, quando foi o documento ligado que lançou, o desse documento.
create function public.erp_stock_source_lots(p_user_id uuid,p_source text,p_source_id uuid,p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare d erp_documents.document;v_role text;v_movements uuid[];v_reference jsonb;v_doc uuid;v_flag text;v_lines jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_source is null or p_source not in('document','invoice') or p_source_id is null or p_product_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 if not exists(select 1 from erp_catalog.product where record_id=p_product_id)then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if p_source='document' then
  select * into d from erp_documents.document where id=p_source_id and kind in('sales_orders','purchase_orders','service_orders');
  if d.id is null then raise exception 'erp_document_not_found' using errcode='P0002';end if;
  if not erp_documents.allowed(v_role,d.kind,false) then raise exception 'erp_stock_lot_origin_denied' using errcode='42501';end if;
  -- 238: a document of a contact the user does not see is not found.
  if not erp_documents.contact_usable(p_user_id,d.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002';end if;
  v_doc:=d.id;
 else
  perform erp_stock.invoice_access(p_user_id,false);
  if not exists(select 1 from erp_fiscal_invoices.invoice where id=p_source_id)then raise exception 'erp_invoice_not_found' using errcode='P0002';end if;
  v_flag:=erp_stock.invoice_flag(p_source_id)->>'flag';
  if v_flag='R' then v_reference:=erp_stock.invoice_reference(p_source_id)-'warehouse';v_doc:=(v_reference->>'document_id')::uuid;end if;
 end if;
 v_movements:=array(select x.id from(
   select p.movement_id id,p.created_at from erp_stock.document_posting p where v_doc is not null and p.document_id=v_doc and p.state='active'
   union all
   select r.movement_id,r.created_at from erp_purchase_receipts.receipt r where v_doc is not null and r.document_id=v_doc
    and not exists(select 1 from erp_purchase_receipts.reversal x where x.receipt_id=r.id)
   union all
   select p.movement_id,p.created_at from erp_stock.invoice_posting p where p_source='invoice' and v_flag='S' and p.invoice_id=p_source_id and p.state='active')x
  order by x.created_at,x.id limit 50);
 select coalesce(jsonb_agg(erp_stock.movement_lot_line(e.movement_id,e.product_id,e.warehouse_id) order by array_position(v_movements,e.movement_id),e.warehouse_id),'[]'::jsonb) into v_lines
  from erp_stock.entry e where e.movement_id=any(v_movements) and e.product_id=p_product_id;
 return jsonb_build_object('scope','stock_source_lots','data_mode','erp_native','source',p_source,'source_id',p_source_id,
  'posted',cardinality(v_movements)>0,'reference',v_reference,
  'product',(select jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'unit',p.unit,'lot_control',erp_stock.lot_product_problem(r.id) is null)
   from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=p_product_id),
  'lines',v_lines,'settings',erp_stock.lot_settings(),'can_write',coalesce(v_role in('admin','estoque'),false));
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_movement_lots','erp_stock_movement_lots_assign','erp_stock_source_lots')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
