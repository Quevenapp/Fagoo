-- 226: Composições na conferência de estoque e na reserva pelas situações de venda (onda D). Requer 106, 145 e 222. Nenhum movimento,
-- saldo, reserva ou documento existente é reescrito.
-- - Conferência de estoque (106), como no Origin ("formato inválido": só "Simples" ou "Com composição" com estoque físico): a composição
--   Físico (com estrutura) é lida e entra no balanço do estoque próprio dela; a Virtual e a composição sem estrutura continuam recusadas.
-- - "Considerar situações de vendas para obter o saldo atual" (145): o pedido de venda com composição reserva o que o lançamento do
--   pedido movimentaria (222): a própria composição Físico com "Produto" ou "Produto e componente" e os componentes com "Componentes",
--   "Produto e componente" ou estoque Virtual (quantidade do item × quantidade do componente). Composição sem estrutura não reserva.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_stock.composition_own_stock(uuid)')is null then raise exception 'stock_composition_count_226_requires_222' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.situation_reservations(uuid)','96a2313b5d0a7f76fc31f28e2a1155dcf1770ec44df7a3dbc87599d6f3133acb'),
  ('public.erp_stock_count_read(uuid,uuid,uuid,text,text,uuid)','bdae96ac109e1ce2d0734c316c2069e402392f4ef273a8f8426a5eb1bb062d24'),
  ('public.erp_stock_count_balance(uuid,uuid,uuid,integer,text,boolean)','8eb49d474db216e3e75c0a28d4c5109b32643f9f3c92a29ebc72e2128647951e'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_composition_count_226_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 1. Reserva pelas situações de venda (145) with the lines of each composition item. The rest of the body is the published one.
create or replace function erp_stock.situation_reservations(p_product uuid default null)
returns table(document_id uuid,document_number bigint,status text,contact_name text,product_id uuid,warehouse_id uuid,quantity numeric,unit text)
language sql stable set search_path=pg_catalog as $$
 with s as(select erp_stock.reserve_statuses() statuses,(erp_stock.settings_dto()->>'reserve_by_warehouse')::boolean by_warehouse,
   (select d.warehouse_id from erp_stock.warehouse_default d where d.singleton) standard),
 items as(select d.id,d.number,d.status,d.contact_snapshot,d.warehouse_id,i.product_id,i.quantity,p.unit,p.format
  from s cross join erp_documents.document d join erp_documents.item i on i.document_id=d.id join erp_catalog.product p on p.record_id=i.product_id
  where cardinality(s.statuses)>0 and d.kind='sales_orders' and d.status=any(s.statuses)
   -- One product (Saldos do produto): its own items and the composition items that have it as a component, as the 145 filter did.
   and(p_product is null or i.product_id=p_product or exists(select 1 from erp_stock.composition_current c where c.product_id=i.product_id and c.component_id=p_product))
   and p.kind='P' and p.unit is not null and i.data->>'unit' is not distinct from p.unit
   and not exists(select 1 from erp_stock.document_posting x where x.document_id=d.id and x.state='active')
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

-- 2. Conferência de estoque (106): leitura. The only change: a Físico composition with a structure is a valid format.
create or replace function public.erp_stock_count_read(p_user_id uuid,p_command_id uuid,p_session_id uuid,p_code text,p_quantity text,p_warehouse_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;s erp_stock.count_session;v_code text;v_rows integer;v_product uuid;v_kind text;v_format text;v_active boolean;v_name text;v_quantity numeric;result jsonb;rejected text;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_code is null or length(btrim(p_code))not between 1 and 100 or p_code~'[[:cntrl:]]' or p_quantity is null or length(p_quantity)>40 then
  raise exception 'erp_stock_count_invalid' using errcode='22023';end if;
 h:=erp_stock.count_hash('stock-count-read-106',p_user_id,jsonb_build_object('session_id',p_session_id,'code',p_code,'quantity',p_quantity,'warehouse_id',p_warehouse_id));
 replay:=erp_stock.count_replay(p_user_id,p_command_id,'read',h);if replay is not null then return replay;end if;
 v_code:=btrim(p_code);
 if p_quantity!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or p_quantity::numeric=0 then rejected:='invalid_quantity';
 else
  v_quantity:=p_quantity::numeric;
  select count(*)into v_rows from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id
   where p.gtin=v_code or p.gtin_tax=v_code or lower(r.code)=lower(v_code);
  if v_rows=0 then rejected:='not_found';elsif v_rows>1 then rejected:='ambiguous';
  else
   select p.record_id,p.kind,p.format,r.active,r.name into v_product,v_kind,v_format,v_active,v_name from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id
    where p.gtin=v_code or p.gtin_tax=v_code or lower(r.code)=lower(v_code);
   rejected:=case when v_kind is distinct from 'P' then 'invalid_kind'
    when v_format is distinct from 'S' and not(v_format='E' and erp_stock.composition_own_stock(v_product)) then 'invalid_format' when not v_active then 'inactive' end;
  end if;
 end if;
 if rejected is not null then
  return jsonb_build_object('scope','stock_count','data_mode','erp_native','outcome','rejected','reason',rejected,'code',v_code,'replayed',false,
   'count',(select erp_stock.count_dto(id) from erp_stock.count_session where actor=p_user_id and state='open'));
 end if;
 s:=erp_stock.count_open(p_user_id,p_session_id,true,p_warehouse_id);
 if(select count(*)from erp_stock.count_reading where session_id=s.id and deleted_at is null)>=20000 or
   (select coalesce(sum(quantity),0)from erp_stock.count_reading where session_id=s.id and product_id=v_product and deleted_at is null)+v_quantity>999999999999.999999 then
  raise exception 'erp_stock_count_limit' using errcode='22023';end if;
 insert into erp_stock.count_reading(session_id,product_id,quantity,code,actor,command_id)values(s.id,v_product,v_quantity,v_code,p_user_id,p_command_id);
 result:=jsonb_build_object('scope','stock_count','data_mode','erp_native','outcome','read','reason',null,'code',v_code,
  'reading',jsonb_build_object('product_id',v_product,'product_name',v_name,'quantity',v_quantity::numeric(18,6)::text),'session_id',s.id);
 insert into erp_stock.count_command(id,actor,action,session_id,request_hash,result)values(p_command_id,p_user_id,'read',s.id,h,result);
 perform erp_stock.reservation_write_access(p_user_id);
 return result||jsonb_build_object('count',erp_stock.count_dto(s.id),'replayed',false);
end$$;

-- 3. Conferência de estoque (106): "Gerar balanço". The only change: the Físico composition (own stock) is balanced like a product.
create or replace function public.erp_stock_count_balance(p_user_id uuid,p_command_id uuid,p_session_id uuid,p_expected_version integer,p_scope text,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;s erp_stock.count_session;row record;derived uuid;v_current numeric;v_version integer;v_post jsonb;v_movement uuid;v_day date;
 changed jsonb:='[]';skipped jsonb:='[]';unchanged integer:=0;result jsonb;at timestamptz;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_session_id is null or p_expected_version is null or p_scope is null or p_scope not in('counted','all_active')
  or(p_scope='all_active' and p_confirmed is distinct from true)then raise exception 'erp_stock_count_invalid' using errcode='22023';end if;
 h:=erp_stock.count_hash('stock-count-balance-106',p_user_id,jsonb_build_object('session_id',p_session_id,'expected_version',p_expected_version,'scope',p_scope,'confirmed',p_confirmed));
 replay:=erp_stock.count_replay(p_user_id,p_command_id,'balance',h);if replay is not null then return replay;end if;
 s:=erp_stock.count_open(p_user_id,p_session_id,false);
 if s.version<>p_expected_version or s.version=2147483647 then raise exception 'erp_stock_count_version_conflict' using errcode='40001';end if;
 if s.warehouse_id is null then raise exception 'erp_stock_count_single_warehouse' using errcode='22023';end if;
 if not exists(select 1 from erp_stock.count_reading where session_id=s.id and deleted_at is null)then raise exception 'erp_stock_count_no_reading' using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 if not exists(select 1 from erp_catalog.record where id=s.warehouse_id and active)then raise exception 'erp_stock_warehouse_unavailable' using errcode='22023';end if;
 v_day:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
 for row in
  with counted as(select product_id,sum(quantity) counted from erp_stock.count_reading where session_id=s.id and deleted_at is null group by product_id),
  scope as(select c.product_id,c.counted from counted c
   union all select p.record_id,0 from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id
    where p_scope='all_active' and r.active and p.kind='P' and not exists(select 1 from counted c where c.product_id=p.record_id))
  select x.product_id,x.counted,r.name,r.active,p.kind,p.format,p.unit from scope x join erp_catalog.record r on r.id=x.product_id join erp_catalog.product p on p.record_id=x.product_id
  order by x.product_id
 loop
  select quantity,version into v_current,v_version from erp_stock.balance where product_id=row.product_id and warehouse_id=s.warehouse_id;
  v_current:=coalesce(v_current,0);v_version:=coalesce(v_version,0);
  if row.counted=v_current then unchanged:=unchanged+1;continue;end if;
  -- 226: a Físico composition with a structure has its own stock and is balanced; Virtual, unstructured and variations are skipped.
  if not row.active or row.kind is distinct from 'P' or row.unit is null or row.format='V' or(row.format='E' and not erp_stock.composition_own_stock(row.product_id))then
   skipped:=skipped||jsonb_build_array(jsonb_build_object('product_id',row.product_id,'name',row.name,'reason',case when row.format in('E','V')then 'composition' else 'unavailable' end));continue;end if;
  if abs(row.counted-v_current)>999999999999.999999 then
   skipped:=skipped||jsonb_build_array(jsonb_build_object('product_id',row.product_id,'name',row.name,'reason','limit'));continue;end if;
  if erp_stock.reserved_quantity(row.product_id,s.warehouse_id)>row.counted then
   skipped:=skipped||jsonb_build_array(jsonb_build_object('product_id',row.product_id,'name',row.name,'reason','reserved'));continue;end if;
  derived:=md5(p_command_id::text||':count:'||row.product_id::text||':'||s.warehouse_id::text)::uuid;
  if erp_stock.command_taken(derived)then raise exception 'erp_stock_count_conflict' using errcode='40001';end if;
  v_post:=erp_stock.post(p_user_id,derived,'adjustment',v_day,'Balanço (conferência de estoque)',null,
   jsonb_build_array(jsonb_build_object('product_id',row.product_id,'warehouse_id',s.warehouse_id,'quantity',(row.counted-v_current)::numeric(18,6)::text,'expected_version',v_version)));
  v_movement:=(v_post#>>'{movement,id}')::uuid;
  insert into erp_stock.balance_count(movement_id,product_id,warehouse_id,counted,previous,source)values(v_movement,row.product_id,s.warehouse_id,row.counted,v_current,'count');
  changed:=changed||jsonb_build_array(jsonb_build_object('product_id',row.product_id,'name',row.name,'movement_id',v_movement,'counted',row.counted::numeric(18,6)::text,'previous',v_current::numeric(18,6)::text));
 end loop;
 at:=clock_timestamp();
 result:=jsonb_build_object('scope','stock_count','data_mode','erp_native','outcome','balanced','session_id',s.id,'warehouse_id',s.warehouse_id,'balance_scope',p_scope,
  'occurred_on',v_day,'changed',changed,'unchanged',unchanged,'skipped',skipped);
 insert into erp_stock.count_command(id,actor,action,session_id,request_hash,result)values(p_command_id,p_user_id,'balance',s.id,h,result);
 update erp_stock.count_session set state='closed',version=version+1,updated_at=at,closed_at=at,close_command_id=p_command_id,balance_scope=p_scope where id=s.id;
 perform erp_stock.reservation_write_access(p_user_id);
 return result||jsonb_build_object('replayed',false);
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in('erp_stock_count_read','erp_stock_count_balance')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
