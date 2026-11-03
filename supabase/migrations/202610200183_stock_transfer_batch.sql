-- 183: Estoque no padrão do Origin, onda C — "Transferir estoque dos produtos selecionados" (Cadastros > Produtos > Mais ações >
-- Edição) e o "Saldo inicial" da inclusão do produto (Depósito, Quantidade, Preço de compra unitário, Custo de compra Un e
-- Observações do saldo inicial). Requer 105 (lançamento manual), 119 (formulário completo do produto) e 145/181.
-- Nenhum saldo, movimento ou cadastro existente é reescrito. Os dois comandos passam pelo mesmo motor (erp_stock_launch -> erp_stock.post):
-- mutex do estoque, versões esperadas (CAS) de cada posição, política "Permitir estoque negativo" (100), proteção das reservas (070),
-- recusa de produto inativo, sem unidade, de unidade divergente do saldo e de formato com composição ou variações.
-- - Transferência em lote: um comando (command_id) para até 50 produtos, numa única transação; cada produto vira uma transferência
--   do 009 com comando derivado do comando do lote, preço, custo e observação. O comprovante fica guardado e volta na repetição.
-- - Saldo inicial: um comando cria o produto (erp_catalog_product_save, do cadastro de produtos) e lança a entrada, na mesma
--   transação; se a entrada for recusada, o produto também não é criado.
begin;

do $$declare r record;begin
 if to_regprocedure('public.erp_catalog_product_save(uuid,uuid,integer,uuid,jsonb,jsonb)')is null
  or to_regprocedure('public.erp_stock_launch(uuid,uuid,text,uuid,uuid,text,integer,text,text,text,uuid,integer)')is null
  or to_regprocedure('erp_stock.default_supplier(uuid)')is null then raise exception 'stock_transfer_183_requires_105_119_181' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.command_taken(uuid)','663799187422632588bea10887cf00d1878d39ce744f300b09d962d1b303b06b'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_transfer_183_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- One immutable row per accepted command: the receipt returned again by "Conferir resultado" (same UUID and body) and the audit.
create table erp_stock.supply_command(
 id uuid primary key,actor uuid not null references auth.users(id),
 action text not null check(action in('transfer_batch','initial_balance')),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_stock_supply_command before update or delete on erp_stock.supply_command for each row execute function erp_stock.immutable_ledger();
alter table erp_stock.supply_command enable row level security;
revoke all on erp_stock.supply_command from public,anon,authenticated,service_role;

-- One UUID identifies one effect across every stock command family, now including these two.
create or replace function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
  or exists(select 1 from erp_stock.warehouse_command where id=p_id)or exists(select 1 from erp_stock.ledger_command where id=p_id)
  or exists(select 1 from erp_stock.count_command where id=p_id)or exists(select 1 from erp_stock.dashboard_command where id=p_id)
  or exists(select 1 from erp_stock.checkin_command where id=p_id)or exists(select 1 from erp_stock.supply_command where id=p_id)
$$;
-- Commands of each part (one per product of the batch, the product and the entry of the saldo inicial), derived from the command.
create function erp_stock.supply_part(p_command uuid,p_part text)returns uuid language sql immutable set search_path=pg_catalog as $$
 select(substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
 from(select md5('stock-supply-183:'||p_part||':'||p_command::text)h)x
$$;

-- Preço sugerido de entrada e transferência (Preferências > Suprimentos > Estoque, 145/181): última compra ou preço de compra/custo do
-- fornecedor padrão; custo = custo médio, ou o custo da origem do preço.
create function erp_stock.entry_suggestions(p_products uuid[])returns table(product_id uuid,unit_price numeric,unit_cost numeric)
language plpgsql stable set search_path=pg_catalog as $$
declare s jsonb;v_type text;v_balances boolean;begin
 s:=erp_stock.settings_dto();v_type:=s->>'price_type';v_balances:=(s->>'consider_balances')::boolean;
 return query
 select x.id,case v_type when 'ultima_compra' then lp.unit_price when 'compra_fornecedor' then f.purchase_price else f.cost_price end,
  coalesce(a.average_cost,case when v_type='ultima_compra' then coalesce(lp.unit_cost,lp.unit_price) else coalesce(f.cost_price,f.purchase_price) end)
 from unnest(p_products)x(id)
 left join lateral(select l.unit_price,l.unit_cost from erp_stock.last_purchase(x.id,v_balances)l where v_type='ultima_compra')lp on true
 left join lateral(select d.purchase_price,d.cost_price from erp_stock.default_supplier(x.id)d)f on true
 left join erp_stock.average_costs(p_products)a on a.product_id=x.id;
end$$;

-- Grade do modal: Estoque e Estoque Reservado (070) no depósito de origem, o saldo no destino, as versões esperadas de cada posição,
-- a situação de cada produto e o preço sugerido. Só quem lança estoque consulta (administrador e estoque).
create function public.erp_stock_transfer_positions(p_user_id uuid,p_source_id uuid,p_destination_id uuid,p_product_ids jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_ids uuid[];v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_source_id is null or p_destination_id=p_source_id or p_product_ids is null or jsonb_typeof(p_product_ids)<>'array' or jsonb_array_length(p_product_ids) not between 1 and 50
  or exists(select 1 from jsonb_array_elements(p_product_ids)x where jsonb_typeof(x)<>'string' or(x#>>'{}')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  or(select count(distinct x)from jsonb_array_elements_text(p_product_ids)x)<>jsonb_array_length(p_product_ids)then
  raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 if not exists(select 1 from erp_catalog.warehouse where record_id=p_source_id)or(p_destination_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_destination_id))then
  raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 v_ids:=array(select x::uuid from jsonb_array_elements_text(p_product_ids)x);
 if(select count(*)from erp_catalog.product where record_id=any(v_ids))<>cardinality(v_ids)then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 with suggestion as materialized(select * from erp_stock.entry_suggestions(v_ids))
 select jsonb_build_object('scope','stock_transfer_positions','data_mode','erp_native',
  'source',(select jsonb_build_object('id',r.id,'name',r.name,'active',r.active,'ignore_balance',erp_stock.ignored_warehouse(r.id))from erp_catalog.record r where r.id=p_source_id),
  'destination',(select jsonb_build_object('id',r.id,'name',r.name,'active',r.active,'ignore_balance',erp_stock.ignored_warehouse(r.id))from erp_catalog.record r where r.id=p_destination_id),
  'show_unit_price',erp_stock.settings_dto()->'show_unit_price',
  'items',(select jsonb_agg(jsonb_build_object('product_id',r.id,'name',r.name,'code',r.code,'unit',p.unit,'kind',p.kind,'format',p.format,'active',r.active,
    'eligibility',case when p.kind is distinct from 'P' then 'not_product' when not r.active then 'inactive' when p.format in('E','V') then 'composition' when p.unit is null then 'no_unit'
     when b.unit is not null and b.unit<>p.unit then 'unit_mismatch' else 'eligible' end,
    'source',jsonb_build_object('quantity',coalesce(b.quantity,0)::numeric(18,6)::text,'version',coalesce(b.version,0),
     'reserved',erp_stock.reserved_quantity(r.id,p_source_id)::numeric(18,6)::text),
    'destination',case when p_destination_id is not null then jsonb_build_object('quantity',coalesce(d.quantity,0)::numeric(18,6)::text,'version',coalesce(d.version,0))end,
    'suggested_price',erp_stock.price_text(s.unit_price),'suggested_cost',erp_stock.price_text(s.unit_cost)) order by erp_catalog.fold(r.name),r.id)
   from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id left join erp_stock.balance b on b.product_id=r.id and b.warehouse_id=p_source_id
   left join erp_stock.balance d on d.product_id=r.id and d.warehouse_id=p_destination_id left join suggestion s on s.product_id=r.id where r.id=any(v_ids))) into v_result;
 return v_result;
end$$;

-- Transferência em lote: Depósito de origem, Depósito de destino, Observações e, por produto, Quantidade, Preço Un. e Custo Un.
create function public.erp_stock_transfer_batch(p_user_id uuid,p_command_id uuid,p_source_id uuid,p_destination_id uuid,p_note text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.supply_command;line jsonb;v_launch jsonb;v_lines jsonb:='[]'::jsonb;v_result jsonb;v_day date;v_note text;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_source_id is null or p_destination_id is null or p_source_id=p_destination_id or length(p_note)>500 or p_note~'[[:cntrl:]]'
  or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 50 or octet_length(p_items::text)>32768
  or exists(select 1 from jsonb_array_elements(p_items)j where jsonb_typeof(j)<>'object'
   or exists(select 1 from jsonb_object_keys(j)k where k not in('product_id','quantity','source_version','destination_version','unit_price','unit_cost'))
   or jsonb_typeof(j->'product_id') is distinct from 'string' or coalesce(j->>'product_id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or jsonb_typeof(j->'quantity') is distinct from 'string' or coalesce(j->>'quantity','')!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or(j->>'quantity')::numeric=0
   or jsonb_typeof(j->'source_version') is distinct from 'number' or coalesce(j->>'source_version','')!~'^[0-9]{1,10}$' or(j->>'source_version')::bigint>2147483646
   or jsonb_typeof(j->'destination_version') is distinct from 'number' or coalesce(j->>'destination_version','')!~'^[0-9]{1,10}$' or(j->>'destination_version')::bigint>2147483646
   or(j ? 'unit_price' and jsonb_typeof(j->'unit_price') not in('string','null'))or(j ? 'unit_cost' and jsonb_typeof(j->'unit_cost') not in('string','null')))
  or(select count(distinct j->>'product_id')from jsonb_array_elements(p_items)j)<>jsonb_array_length(p_items)then
  raise exception 'erp_stock_transfer_batch_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-transfer-batch-183','actor',p_user_id,'source',p_source_id,'destination',p_destination_id,'note',p_note,'items',p_items)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into c from erp_stock.supply_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'transfer_batch' or c.request_hash<>h then raise exception 'erp_stock_transfer_batch_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_transfer_batch_conflict' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 -- Products in UUID order: the same catalog lock order as every other stock writer.
 for line in select j from jsonb_array_elements(p_items)j order by(j->>'product_id')::uuid loop
  v_launch:=public.erp_stock_launch(p_user_id,erp_stock.supply_part(p_command_id,'transfer:'||(line->>'product_id')),'transfer',(line->>'product_id')::uuid,p_source_id,line->>'quantity',
   (line->>'source_version')::integer,line->>'unit_price',line->>'unit_cost',p_note,p_destination_id,(line->>'destination_version')::integer);
  v_day:=(v_launch->>'occurred_on')::date;v_note:=v_launch#>>'{detail,note}';
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',line->>'product_id','name',(select name from erp_catalog.record where id=(line->>'product_id')::uuid),
   'code',(select code from erp_catalog.record where id=(line->>'product_id')::uuid),'unit',(select unit from erp_catalog.product where record_id=(line->>'product_id')::uuid),
   'quantity',(line->>'quantity')::numeric(18,6)::text,'movement_id',v_launch#>'{movement,id}',
   'source_balance_after',(select e->'balance_after' from jsonb_array_elements(v_launch#>'{movement,items}')e where e->>'warehouse_id'=p_source_id::text),
   'destination_balance_after',(select e->'balance_after' from jsonb_array_elements(v_launch#>'{movement,items}')e where e->>'warehouse_id'=p_destination_id::text),
   'unit_price',v_launch#>'{detail,unit_price}','unit_cost',v_launch#>'{detail,unit_cost}'));
 end loop;
 v_result:=jsonb_build_object('scope','stock_transfer_batch','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'source',(select jsonb_build_object('id',id,'name',name)from erp_catalog.record where id=p_source_id),
  'destination',(select jsonb_build_object('id',id,'name',name)from erp_catalog.record where id=p_destination_id),
  'note',v_note,'occurred_on',v_day,'items',v_lines,'saved_at',clock_timestamp()));
 insert into erp_stock.supply_command(id,actor,action,request_hash,result)values(p_command_id,p_user_id,'transfer_batch',h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

-- Inclusão do produto com Saldo inicial: o produto (formulário completo, 119) e a entrada no depósito escolhido, no mesmo comando.
create function public.erp_stock_product_create(p_user_id uuid,p_command_id uuid,p_data jsonb,p_acknowledged jsonb,p_warehouse_id uuid,p_quantity text,
  p_unit_price text default null,p_unit_cost text default null,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.supply_command;v_product jsonb;v_launch jsonb;v_id uuid;v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_data is null or jsonb_typeof(p_data)<>'object' or p_warehouse_id is null or p_quantity is null
  or p_quantity!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or p_quantity::numeric=0 or length(p_note)>500 or p_note~'[[:cntrl:]]' then
  raise exception 'erp_stock_initial_balance_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-initial-balance-183','actor',p_user_id,'data',p_data,'acknowledged',p_acknowledged,'warehouse',p_warehouse_id,
  'quantity',p_quantity,'unit_price',p_unit_price,'unit_cost',p_unit_cost,'note',p_note)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into c from erp_stock.supply_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'initial_balance' or c.request_hash<>h then raise exception 'erp_stock_initial_balance_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)or exists(select 1 from erp_catalog.command where command_id=p_command_id)then
  raise exception 'erp_stock_initial_balance_conflict' using errcode='40001';end if;
 v_product:=public.erp_catalog_product_save(p_user_id,null,0,erp_stock.supply_part(p_command_id,'product'),p_data,p_acknowledged);
 if coalesce((v_product->>'replayed')::boolean,true)then raise exception 'erp_stock_initial_balance_conflict' using errcode='40001';end if;
 v_id:=(v_product#>>'{record,id}')::uuid;
 v_launch:=public.erp_stock_launch(p_user_id,erp_stock.supply_part(p_command_id,'balance'),'receipt',v_id,p_warehouse_id,p_quantity,0,p_unit_price,p_unit_cost,
  coalesce(nullif(btrim(p_note),''),'Saldo inicial'),null,null);
 v_result:=(v_product-'replayed')||jsonb_build_object('initial_balance',jsonb_build_object('command_id',p_command_id,'warehouse_id',p_warehouse_id,
  'warehouse_name',(select name from erp_catalog.record where id=p_warehouse_id),'quantity',p_quantity::numeric(18,6)::text,'movement_id',v_launch#>'{movement,id}',
  'occurred_on',v_launch->'occurred_on','unit_price',v_launch#>'{detail,unit_price}','unit_cost',v_launch#>'{detail,unit_cost}','note',v_launch#>'{detail,note}'));
 insert into erp_stock.supply_command(id,actor,action,request_hash,result)values(p_command_id,p_user_id,'initial_balance',h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_transfer_positions','erp_stock_transfer_batch','erp_stock_product_create')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
