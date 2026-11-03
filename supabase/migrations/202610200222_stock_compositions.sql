-- 222: Composições (produto com formato "Com composição", Kit ou união de vários itens) no padrão do Origin, onda D do estoque.
-- Requer 105 (lançamento manual), 119 (formulário completo do produto), 155 (atualização de preços), 182 (motor e prévia dos
-- documentos) e 183 (comandos do estoque). Nenhum movimento, saldo, cadastro ou documento existente é reescrito.
-- - Estrutura (aba do formulário do produto): Tipo de estoque Físico | Virtual, Lançar estoque Produto | Componentes | Produto e
--   componente e os componentes com a quantidade por composição. Cada gravação é uma versão nova e imutável da estrutura, com
--   comando idempotente, versão esperada (CAS) e o autor; o produto e a estrutura são gravados no mesmo comando
--   (erp_catalog_product_save, do cadastro de produtos, mais a estrutura), tudo ou nada.
-- - Estoque como no Origin: a composição Físico tem saldo próprio; a Virtual não tem, e o saldo dela é o máximo de composições
--   completas que os componentes permitem. O lançamento de estoque do pedido de venda e da OS, a reserva (070) e o lançamento
--   manual da composição movimentam a composição e/ou os componentes conforme "Lançar estoque" (a Virtual só os componentes),
--   pelo mesmo motor (erp_stock.post): mutex, versões esperadas, política de estoque negativo (100/182) e reservas (070).
-- - Preferências > Cadastros > Configurações de produtos: "Atualizar preço de custo / peso / preço de venda das composições com
--   base nos componentes" passam a valer ao gravar a estrutura e ao gravar, pelo formulário, um produto que é componente.
-- As 28 composições espelhadas do Origin chegam sem estrutura (o espelho não traz os componentes): enquanto o dono não informar a
-- estrutura, os lançamentos delas continuam recusados, como antes.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 if to_regprocedure('public.erp_catalog_product_save(uuid,uuid,integer,uuid,jsonb,jsonb)')is null
  or to_regprocedure('public.erp_catalog_product_prices_update(uuid,uuid,uuid,jsonb)')is null
  or to_regprocedure('erp_stock.supply_part(uuid,text)')is null or to_regprocedure('erp_stock.sales_negative_allowed()')is null then
  raise exception 'stock_compositions_222_requires_155_182_183' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.post_physical_025(uuid,uuid,text,date,text,text,jsonb,uuid)','5095d10969a5284216a24276ef4012c26baf72190d8cd06515f2bf5639eb6c07'),
  ('erp_stock.document_preview_data(erp_documents.document,date,text)','8cc171fd8ca368c2ca89a77852102b5f72220e2efd9f292c95b35eedf641563f'),
  ('erp_stock.command_taken(uuid)','9e65ed4c91dc57ee450e56ceb854e38f529e05731aff06bcd12373ba79daa3c9'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_compositions_222_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regclass('erp_stock.composition')is not null then raise exception 'stock_compositions_222_already_applied' using errcode='55000';end if;
end$$;

-- 1. Estrutura. One immutable command row per accepted save; the composition row points to the command that wrote its version and
-- the items of every version stay (the current structure is the items of the current version).
create table erp_stock.composition_command(
 id uuid primary key,actor uuid not null references auth.users(id),
 -- save: product and structure; sync: product saved as a component (the compositions that use it follow the Preferências).
 action text not null check(action in('save','sync')),product_id uuid not null references erp_catalog.product(record_id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create index erp_stock_composition_command_product on erp_stock.composition_command(product_id,created_at);
create table erp_stock.composition(
 product_id uuid primary key references erp_catalog.product(record_id),
 stock_type text not null check(stock_type in('physical','virtual')),
 post_mode text not null check(post_mode in('product','components','both')),
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid not null references auth.users(id),
 -- The command row carries the whole receipt, so it is written last in the same transaction.
 command_id uuid not null unique references erp_stock.composition_command(id) deferrable initially deferred,
 -- Origin: a Virtual composition has no stock of its own, so its lançamentos always go to the components.
 check(stock_type='physical' or post_mode='components')
);
create table erp_stock.composition_item(
 product_id uuid not null references erp_stock.composition(product_id),
 version integer not null check(version between 1 and 2147483647),
 position integer not null check(position between 1 and 100),
 component_id uuid not null references erp_catalog.product(record_id),
 quantity numeric(18,6) not null check(quantity>0 and quantity<=999999999999.999999),
 primary key(product_id,version,position),unique(product_id,version,component_id),check(component_id<>product_id)
);
create index erp_stock_composition_item_component on erp_stock.composition_item(component_id,product_id,version);
create trigger immutable_stock_composition_command before update or delete on erp_stock.composition_command for each row execute function erp_stock.immutable_ledger();
create trigger immutable_stock_composition_item before update or delete on erp_stock.composition_item for each row execute function erp_stock.immutable_ledger();
-- Only the command marked in this transaction by erp_stock_product_compose writes a version (same pattern as the 182 mark).
create function erp_stock.guard_composition()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or(tg_op='INSERT' and new.version<>1)or(tg_op='UPDATE' and(new.product_id<>old.product_id or new.version<>old.version+1 or new.command_id=old.command_id))
  or coalesce(current_setting('erp_stock.composition_command',true),'')<>new.command_id::text
  or exists(select 1 from erp_stock.composition_command c where c.id=new.command_id)then
  raise exception 'erp_stock_composition_immutable' using errcode='40001';end if;
 return new;
end$$;
-- The command written at the end of the save must describe the version it wrote.
create function erp_stock.guard_composition_command()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if new.action='save' and not exists(select 1 from erp_stock.composition c where c.product_id=new.product_id and c.command_id=new.id and c.updated_by=new.actor)then
  raise exception 'erp_stock_composition_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_composition_command before insert on erp_stock.composition_command for each row execute function erp_stock.guard_composition_command();
create trigger guard_stock_composition before insert or update or delete on erp_stock.composition for each row execute function erp_stock.guard_composition();
create function erp_stock.guard_composition_item()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if not exists(select 1 from erp_stock.composition c where c.product_id=new.product_id and c.version=new.version
   and c.command_id::text=coalesce(current_setting('erp_stock.composition_command',true),''))then
  raise exception 'erp_stock_composition_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_composition_item before insert on erp_stock.composition_item for each row execute function erp_stock.guard_composition_item();
-- The current structure of every composition (read by the stock functions; other lanes may read it, e.g. a Componente filter).
create view erp_stock.composition_current as
 select i.product_id,i.position,i.component_id,i.quantity,c.stock_type,c.post_mode,c.version
 from erp_stock.composition c join erp_stock.composition_item i on i.product_id=c.product_id and i.version=c.version;
do $$declare t text;begin foreach t in array array['composition_command','composition','composition_item']loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on erp_stock.composition_current from public,anon,authenticated,service_role;

-- One UUID identifies one effect across every stock command family, now including the structure save.
create or replace function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
  or exists(select 1 from erp_stock.warehouse_command where id=p_id)or exists(select 1 from erp_stock.ledger_command where id=p_id)
  or exists(select 1 from erp_stock.count_command where id=p_id)or exists(select 1 from erp_stock.dashboard_command where id=p_id)
  or exists(select 1 from erp_stock.checkin_command where id=p_id)or exists(select 1 from erp_stock.supply_command where id=p_id)
  or exists(select 1 from erp_stock.composition_command where id=p_id)
$$;

-- 2. Helpers. A composition is usable when the product is a "Com composição" product with a structure row; a component is a
-- simple product (Tipo Produto, formato Simples), active, with a unit and not deleted.
create function erp_stock.composition_own_stock(p_product uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.composition c join erp_catalog.product p on p.record_id=c.product_id where c.product_id=p_product and p.format='E' and c.stock_type='physical')
$$;
create function erp_stock.component_problem(p_component uuid)returns text language sql stable set search_path=pg_catalog as $$
 select case when p.record_id is null then 'not_found' when p.kind is distinct from 'P' then 'not_product' when p.format is distinct from 'S' then 'not_simple'
  when exists(select 1 from erp_catalog.product_detail d where d.record_id=p.record_id and d.deleted_at is not null) then 'deleted'
  when not r.active then 'inactive' when p.unit is null then 'no_unit' end
 from(select p_component id)x left join erp_catalog.product p on p.record_id=x.id left join erp_catalog.record r on r.id=p.record_id
$$;
-- Quantity of each component for p_quantity compositions; never rounded (a product with more than 6 decimals is refused).
create function erp_stock.component_quantity(p_quantity numeric,p_per_kit numeric)returns numeric language plpgsql immutable set search_path=pg_catalog as $$
declare v numeric:=p_quantity*p_per_kit;begin
 if v<>round(v,6) or abs(v)>999999999999.999999 then raise exception 'erp_stock_composition_quantity_precision' using errcode='22023';end if;
 return round(v,6);
end$$;
-- Lines of p_quantity compositions (signed): the composition itself (Físico with Produto or Produto e componente) and/or each
-- component (Componentes, Produto e componente, and always for Virtual). Raises when the structure cannot be posted.
create function erp_stock.composition_lines(p_product uuid,p_quantity numeric)returns table(product_id uuid,quantity numeric,per_kit numeric,role text)
language plpgsql stable set search_path=pg_catalog as $$
declare c erp_stock.composition;v_problem text;begin
 select * into c from erp_stock.composition x where x.product_id=p_product;
 if c.product_id is null or not exists(select 1 from erp_catalog.product p where p.record_id=p_product and p.format='E')then
  raise exception 'erp_stock_composition_structure_missing' using errcode='22023';end if;
 if c.post_mode in('product','both')then return query select p_product,p_quantity,1::numeric,'composition'::text;end if;
 if c.post_mode in('components','both')then
  if not exists(select 1 from erp_stock.composition_current i where i.product_id=p_product)then raise exception 'erp_stock_composition_structure_missing' using errcode='22023';end if;
  select erp_stock.component_problem(i.component_id) into v_problem from erp_stock.composition_current i where i.product_id=p_product and erp_stock.component_problem(i.component_id) is not null limit 1;
  if v_problem is not null then raise exception 'erp_stock_composition_component_unavailable' using errcode='22023',detail=v_problem;end if;
  return query select i.component_id,erp_stock.component_quantity(p_quantity,i.quantity),i.quantity,'component'::text from erp_stock.composition_current i where i.product_id=p_product order by i.position;
 end if;
end$$;
-- Saldo virtual (Origin "máximo disponível a partir dos componentes"): whole compositions the components of one warehouse allow
-- (a composition is assembled from the components of the same warehouse); without a warehouse, the sum over the considered
-- warehouses (an ignored warehouse stays out, as in every total). Zero without component stock; null without a structure.
create function erp_stock.virtual_positions(p_product uuid)returns table(warehouse_id uuid,quantity numeric)language sql stable set search_path=pg_catalog as $$
 with ws as(select distinct b.warehouse_id from erp_stock.balance b join erp_stock.composition_current i on i.component_id=b.product_id where i.product_id=p_product)
 select w.warehouse_id,trunc(min(coalesce(b.quantity,0)/i.quantity)) from ws w cross join erp_stock.composition_current i
  left join erp_stock.balance b on b.product_id=i.component_id and b.warehouse_id=w.warehouse_id
 where i.product_id=p_product group by w.warehouse_id
$$;
create function erp_stock.virtual_quantity(p_product uuid,p_warehouse uuid default null)returns numeric language sql stable set search_path=pg_catalog as $$
 select case when exists(select 1 from erp_stock.composition_current where product_id=p_product)then coalesce((select sum(v.quantity) from erp_stock.virtual_positions(p_product) v
  where case when p_warehouse is null then not erp_stock.ignored_warehouse(v.warehouse_id) else v.warehouse_id=p_warehouse end),0)end
$$;
-- Values of the composition from its components (Preço Total de Venda / Preço Total de Custo of the Estrutura and the weights).
-- p_items, when given, is the structure about to be saved ([{component_id, quantity}]); otherwise the current one.
create function erp_stock.composition_totals(p_product uuid,p_items jsonb default null)returns jsonb language sql stable set search_path=pg_catalog as $$
 with items as(select x.component_id,x.quantity from erp_stock.composition_current x where p_items is null and x.product_id=p_product
   union all select(j->>'component_id')::uuid,(j->>'quantity')::numeric from jsonb_array_elements(coalesce(p_items,'[]'::jsonb))j where p_items is not null),
  v as(select i.quantity,p.price,p.net_weight,p.gross_weight,(select s.cost_price from erp_catalog.product_supplier s where s.record_id=i.component_id and s.is_default)cost
   from items i join erp_catalog.product p on p.record_id=i.component_id)
 select jsonb_build_object('items',(select count(*)from v)::integer,
  'sale',(select round(coalesce(sum(price*quantity),0),10)from v)::numeric(28,10)::text,'unpriced',(select count(*)from v where price is null)::integer,
  'cost',(select round(coalesce(sum(cost*quantity),0),10)from v)::numeric(28,10)::text,'uncosted',(select count(*)from v where cost is null)::integer,
  'net_weight',(select round(coalesce(sum(net_weight*quantity),0),6)from v)::numeric(18,6)::text,'gross_weight',(select round(coalesce(sum(gross_weight*quantity),0),6)from v)::numeric(18,6)::text,
  'weighted',(select count(*)from v where net_weight is not null or gross_weight is not null)::integer)
$$;
create function erp_stock.composition_settings()returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('update_cost',coalesce(erp_preferences.get('produtos.composicao_custo')='true'::jsonb,false),
  'update_weight',coalesce(erp_preferences.get('produtos.composicao_peso')='true'::jsonb,false),
  'update_price',coalesce(erp_preferences.get('produtos.composicao_preco')='true'::jsonb,false))
$$;
create function erp_stock.composition_dto(p_product uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select case when c.product_id is null then null else jsonb_build_object('stock_type',c.stock_type,'post_mode',c.post_mode,'version',c.version,'updated_at',c.updated_at,
  'items',coalesce((select jsonb_agg(jsonb_build_object('position',i.position,'component_id',i.component_id,'quantity',i.quantity::numeric(18,6)::text) order by i.position)
   from erp_stock.composition_current i where i.product_id=c.product_id),'[]'::jsonb))end
 from(select p_product id)x left join erp_stock.composition c on c.product_id=x.id
$$;

-- 3. Motor de estoque (182) com uma única mudança: a composição Físico com estrutura tem saldo próprio e recebe lançamentos como
-- um produto simples. Virtual, sem estrutura e variações continuam recusadas; o resto do corpo é o publicado.
create or replace function erp_stock.post_physical_025(p_user_id uuid,p_command_id uuid,p_kind text,p_occurred_on date,
  p_reason text,p_reference text,p_items jsonb,p_reverses_id uuid default null)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_hash text;v_command erp_stock.command%rowtype;v_line jsonb;v_product uuid;v_warehouse uuid;
  v_quantity numeric(18,6);v_unit text;v_kind text;v_format text;v_active boolean;v_warehouse_active boolean;
  v_balance erp_stock.balance%rowtype;v_version integer;v_id uuid;v_result jsonb;v_ordinal integer:=0;v_free boolean;
begin
  perform erp_stock.require_access(p_user_id,true);
  -- 182: a reversal, or the compensation adjustment that erp_stock_reverse marks for this very command, is not refused for an
  -- inactive product or warehouse nor for a product that became a composition after the original lançamento.
  v_free:=p_kind='reversal' or(p_kind='adjustment' and btrim(coalesce(p_reason,''))='Estorno anterior ao balanço: saldo atual mantido'
    and p_command_id is not null and coalesce(current_setting('erp_stock.reversal_compensation',true),'')=p_command_id::text);
  if p_command_id is null or p_kind is null or p_kind not in ('receipt','issue','adjustment','transfer','reversal')
    or p_occurred_on is null or not isfinite(p_occurred_on) or p_occurred_on<date '1900-01-01'
    or p_occurred_on>(clock_timestamp() at time zone 'America/Sao_Paulo')::date
    or p_reason is null or length(btrim(p_reason)) not between 3 and 500 or p_reason ~ '[[:cntrl:]]'
    or length(p_reference)>100 or p_reference ~ '[[:cntrl:]]'
    or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
    or octet_length(p_items::text)>65536 or ((p_kind='reversal')<>(p_reverses_id is not null)) then
    raise exception 'erp_stock_invalid_command' using errcode='22023';
  end if;
  for v_line in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_line)<>'object' or jsonb_typeof(v_line->'product_id') is distinct from 'string'
      or jsonb_typeof(v_line->'warehouse_id') is distinct from 'string'
      or coalesce(v_line->>'product_id','')!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or coalesce(v_line->>'warehouse_id','')!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or jsonb_typeof(v_line->'quantity') is distinct from 'string'
      or coalesce(v_line->>'quantity','')!~'^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$'
      or jsonb_typeof(v_line->'expected_version') is distinct from 'number'
      or coalesce(v_line->>'expected_version','')!~'^[0-9]{1,10}$'
      or exists(select 1 from jsonb_object_keys(v_line) k where k not in ('product_id','warehouse_id','quantity','expected_version')) then
      raise exception 'erp_stock_invalid_line' using errcode='22023';
    end if;
    if (v_line->>'quantity')::numeric=0 or (v_line->>'expected_version')::bigint>2147483647
      or (p_kind='receipt' and (v_line->>'quantity')::numeric<0)
      or (p_kind='issue' and (v_line->>'quantity')::numeric>0) then
      raise exception 'erp_stock_invalid_quantity' using errcode='22023';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_items) j group by (j->>'product_id')::uuid,(j->>'warehouse_id')::uuid having count(*)>1) then
    raise exception 'erp_stock_duplicate_position' using errcode='22023';
  end if;
  if p_kind='transfer' and (jsonb_array_length(p_items)<>2
    or (select count(distinct (j->>'product_id')::uuid) from jsonb_array_elements(p_items) j)<>1
    or (select sum((j->>'quantity')::numeric) from jsonb_array_elements(p_items) j)<>0) then
    raise exception 'erp_stock_invalid_transfer' using errcode='22023';
  end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'kind',p_kind,'occurred_on',p_occurred_on,
    'reason',p_reason,'reference',p_reference,'items',p_items,'reverses_id',p_reverses_id)::text,'UTF8')),'hex');
  -- Single-company serialization is deliberate; avoids opposite-transfer deadlocks.
  perform pg_advisory_xact_lock(174852909,0);
  select * into v_command from erp_stock.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_stock_command_conflict' using errcode='40001'; end if;
    return v_command.result||'{"replayed":true}'::jsonb;
  end if;
  if p_kind='reversal' then
    if not exists(select 1 from erp_stock.movement where id=p_reverses_id and kind<>'reversal') then
      raise exception 'erp_stock_movement_not_found' using errcode='P0002'; end if;
    if exists(select 1 from erp_stock.movement where reverses_id=p_reverses_id) then
      raise exception 'erp_stock_already_reversed' using errcode='40001'; end if;
    if p_occurred_on<(select occurred_on from erp_stock.movement where id=p_reverses_id) then
      raise exception 'erp_stock_reversal_date_invalid' using errcode='22023'; end if;
  end if;
  insert into erp_stock.movement(kind,occurred_on,reason,reference,actor,command_id,reverses_id)
    values(p_kind,p_occurred_on,btrim(p_reason),nullif(btrim(p_reference),''),p_user_id,p_command_id,p_reverses_id) returning id into v_id;
  for v_line in select value from jsonb_array_elements(p_items) order by (value->>'product_id')::uuid,(value->>'warehouse_id')::uuid loop
    v_product:=(v_line->>'product_id')::uuid;v_warehouse:=(v_line->>'warehouse_id')::uuid;
    v_quantity:=(v_line->>'quantity')::numeric(18,6);v_version:=(v_line->>'expected_version')::integer;
    select p.unit,p.kind,p.format,r.active into v_unit,v_kind,v_format,v_active from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where p.record_id=v_product for update of r,p;
    if not found or v_unit is null or v_kind is distinct from 'P' or (not v_active and not v_free) then
      raise exception 'erp_stock_product_unavailable' using errcode='22023'; end if;
    -- 222: only a Físico composition with a structure has a stock of its own.
    if not v_free and(v_format='V' or(v_format='E' and not erp_stock.composition_own_stock(v_product)))then raise exception 'erp_stock_composition_unsupported' using errcode='22023'; end if;
    select r.active into v_warehouse_active from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id where w.record_id=v_warehouse for update of r;
    if not found or (not v_warehouse_active and not v_free) then raise exception 'erp_stock_warehouse_unavailable' using errcode='22023'; end if;
    insert into erp_stock.balance(product_id,warehouse_id,unit) values(v_product,v_warehouse,v_unit) on conflict do nothing;
    select * into v_balance from erp_stock.balance where product_id=v_product and warehouse_id=v_warehouse for update;
    if v_balance.version<>v_version or v_balance.version=2147483647 then raise exception 'erp_stock_version_conflict' using errcode='40001'; end if;
    if v_balance.unit<>v_unit then raise exception 'erp_stock_unit_conflict' using errcode='40001'; end if;
    -- 100: only a decrease is refused for ending below zero, and only while the company policy forbids it.
    if v_balance.quantity+v_quantity>999999999999.999999 or v_balance.quantity+v_quantity<-999999999999.999999
      or (v_quantity<0 and v_balance.quantity+v_quantity<0 and not erp_stock.negative_allowed()) then
      raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023'; end if;
    update erp_stock.balance set quantity=quantity+v_quantity,version=version+1,updated_at=clock_timestamp() where product_id=v_product and warehouse_id=v_warehouse;
    v_ordinal:=v_ordinal+1;
    insert into erp_stock.entry(movement_id,ordinal,product_id,warehouse_id,quantity,unit,balance_after,balance_version)
      values(v_id,v_ordinal,v_product,v_warehouse,v_quantity,v_unit,v_balance.quantity+v_quantity,v_balance.version+1);
  end loop;
  v_result:=jsonb_build_object('movement',erp_stock.movement_dto(v_id),'replayed',false,'data_mode','erp_native');
  insert into erp_stock.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  return v_result;
end $$;

-- 4. Prévia do lançamento de estoque do documento (182): um pedido de venda ou uma OS com composição movimenta a composição e/ou os
-- componentes conforme "Lançar estoque". Cada posição diz de onde veio: o item (fonte simples) ou o item da composição, com a
-- quantidade do item, a quantidade do componente por composição e a quantidade resultante. Pedido de compra com composição continua
-- recusado (o recebimento de compras, 090, também não recebe composições). O resto do corpo é o publicado.
create or replace function erp_stock.document_preview_data(d erp_documents.document,p_day date,p_reason text)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare w erp_catalog.record;row record;ignored jsonb:='[]';positions jsonb;result jsonb;direction text;v_lines jsonb:='[]';l record;begin
 perform erp_stock.document_meta(p_day,p_reason);
 if not erp_stock.document_eligible(d.kind,d.status) then raise exception 'erp_document_stock_ineligible_state' using errcode='40001';end if;
 if exists(select 1 from erp_stock.document_posting where document_id=d.id and state='active') then raise exception 'erp_document_stock_already_posted' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);
 -- The 011 importer takes catalog rows in UUID order; never prelock catalog before the stock lock. 222: the components of the
 -- compositions of the document are locked in the same pass and order.
 perform 1 from erp_catalog.record where id=d.warehouse_id or id in(select product_id from erp_documents.item where document_id=d.id)
  or id in(select c.component_id from erp_documents.item i join erp_stock.composition_current c on c.product_id=i.product_id where i.document_id=d.id) order by id for update;
 perform 1 from erp_catalog.product where record_id in(select product_id from erp_documents.item where document_id=d.id)
  or record_id in(select c.component_id from erp_documents.item i join erp_stock.composition_current c on c.product_id=i.product_id where i.document_id=d.id) order by record_id for update;
 select r.* into w from erp_catalog.record r join erp_catalog.warehouse x on x.record_id=r.id where r.id=d.warehouse_id and r.active;
 if not found then raise exception 'erp_stock_warehouse_unavailable' using errcode='22023';end if;
 for row in select i.id,i.position,i.product_id,i.quantity,i.data,r.active,r.version,p.unit,p.kind,p.format
  from erp_documents.item i left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id
  where i.document_id=d.id order by i.position loop
  if row.product_id is null or row.kind='S' then
   ignored:=ignored||jsonb_build_array(jsonb_build_object('id',row.id,'position',row.position,'product_id',row.product_id,
    'description',row.data->>'description','quantity',row.quantity::text,'unit',row.data->>'unit','catalog_version',row.version,
    'reason',case when row.product_id is null then 'unlinked_item' else 'service' end));
  elsif row.kind is distinct from 'P' or not coalesce(row.active,false) or row.unit is null then
   raise exception 'erp_stock_product_unavailable' using errcode='22023';
  elsif row.format='V' or(row.format='E' and d.kind='purchase_orders') then raise exception 'erp_document_stock_composition_unsupported' using errcode='22023';
  elsif row.unit is distinct from row.data->>'unit' then raise exception 'erp_document_stock_unit_mismatch' using errcode='22023';
  elsif row.format='E' then
   for l in select * from erp_stock.composition_lines(row.product_id,row.quantity) loop
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',l.quantity::text,'source',case when l.role='composition'
     then jsonb_build_object('id',row.id,'position',row.position,'quantity',row.quantity::numeric(18,6)::text)
     else jsonb_build_object('id',row.id,'position',row.position,'quantity',l.quantity::numeric(18,6)::text,'kit_product_id',row.product_id,
      'kit_quantity',row.quantity::numeric(18,6)::text,'component_quantity',l.per_kit::numeric(18,6)::text)end));
   end loop;
  else
   v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',row.product_id,'quantity',row.quantity::text,
    'source',jsonb_build_object('id',row.id,'position',row.position,'quantity',row.quantity::text)));
  end if;
 end loop;
 direction:=case when d.kind='purchase_orders' then 'receipt' else 'issue' end;
 with lines as(select(j->>'product_id')::uuid product_id,(j->>'quantity')::numeric qty,j->'source' source from jsonb_array_elements(v_lines)j),
 groups as(select product_id,sum(qty) qty,jsonb_agg(source order by(source->>'position')::integer) sources from lines group by product_id)
 select coalesce(jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',r.name,'catalog_version',r.version,
  'warehouse_id',w.id,'unit',p.unit,'quantity',(case when direction='issue' then -g.qty else g.qty end)::numeric(18,6)::text,
  'balance_before',coalesce(b.quantity,0)::numeric(18,6)::text,
  'balance_after',round(coalesce(b.quantity,0)+case when direction='issue' then -g.qty else g.qty end,6)::text,
  'expected_version',coalesce(b.version,0),'sources',g.sources) order by g.product_id),'[]') into positions
 from groups g join erp_catalog.record r on r.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id;
 if jsonb_array_length(positions) not between 1 and 100 then raise exception 'erp_document_stock_position_limit' using errcode='22023';end if;
 -- 182: a sales order needs both the company policy and "Permite venda de produtos com estoque negativo".
 if exists(select 1 from jsonb_array_elements(positions) j where ((j->>'quantity')::numeric<0 and (j->>'balance_after')::numeric<0
   and not(erp_stock.negative_allowed() and(d.kind<>'sales_orders' or erp_stock.sales_negative_allowed())))
  or (j->>'balance_after')::numeric>999999999999.999999 or (j->>'balance_after')::numeric<-999999999999.999999 or(j->>'expected_version')::integer=2147483647) then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 result:=jsonb_build_object('action','post','document',erp_stock.document_summary(d.id),'direction',direction,'occurred_on',p_day,'reason',p_reason,
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'positions',positions,'ignored',ignored);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;

-- 5. Estrutura da composição (aba "Estrutura" do formulário do produto): a estrutura atual com os dados de cada componente, os totais,
-- o saldo virtual e as opções de Preferências. Lê quem consulta produtos; saldos só para quem consulta estoque.
create function public.erp_stock_composition_get(p_user_id uuid,p_product_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_stock boolean;v_product jsonb;c erp_stock.composition;v_virtual jsonb;begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_product_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 select jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'kind',p.kind,'format',p.format,'unit',p.unit,'active',r.active,'version',r.version,
  'price',erp_stock.price_text(p.price),'net_weight',p.net_weight::numeric(18,6)::text,'gross_weight',p.gross_weight::numeric(18,6)::text,
  'cost_price',(select erp_stock.price_text(s.cost_price) from erp_catalog.product_supplier s where s.record_id=r.id and s.is_default),
  'default_supplier',exists(select 1 from erp_catalog.product_supplier s where s.record_id=r.id and s.is_default)) into v_product
 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=p_product_id and r.entity='products';
 if v_product is null then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 v_stock:=erp_catalog.can_read_stock(p_user_id);
 select * into c from erp_stock.composition where product_id=p_product_id;
 if v_stock and c.stock_type='virtual' and v_product->>'format'='E' then
  v_virtual:=jsonb_build_object('quantity',erp_stock.virtual_quantity(p_product_id)::numeric(18,6)::text,
   'warehouses',coalesce((select jsonb_agg(jsonb_build_object('warehouse_id',w.record_id,'name',r.name,'active',r.active,'ignored',erp_stock.ignored_warehouse(w.record_id),
     'quantity',erp_stock.virtual_quantity(p_product_id,w.record_id)::numeric(18,6)::text) order by erp_catalog.fold(r.name),w.record_id)
    from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id where r.active or exists(select 1 from erp_stock.balance b join erp_stock.composition_current i on i.component_id=b.product_id
     where i.product_id=p_product_id and b.warehouse_id=w.record_id)),'[]'::jsonb));
 end if;
 return jsonb_build_object('scope','stock_composition','data_mode','erp_native','product',v_product,'stock_visible',v_stock,
  'composition',case when c.product_id is null then null else jsonb_build_object('stock_type',c.stock_type,'post_mode',c.post_mode,'version',c.version,'updated_at',c.updated_at)end,
  'items',coalesce((select jsonb_agg(jsonb_build_object('position',i.position,'component_id',i.component_id,'name',r.name,'code',r.code,'unit',p.unit,'kind',p.kind,'format',p.format,
     'active',r.active,'problem',erp_stock.component_problem(i.component_id),'quantity',i.quantity::numeric(18,6)::text,'price',erp_stock.price_text(p.price),
     'cost_price',(select erp_stock.price_text(s.cost_price) from erp_catalog.product_supplier s where s.record_id=i.component_id and s.is_default),
     'stock',case when v_stock then(select coalesce(sum(b.quantity),0) from erp_stock.balance b where b.product_id=i.component_id and not erp_stock.ignored_warehouse(b.warehouse_id))::numeric(18,6)::text end)
    order by i.position) from erp_stock.composition_current i join erp_catalog.record r on r.id=i.component_id join erp_catalog.product p on p.record_id=i.component_id
    where i.product_id=p_product_id),'[]'::jsonb),
  'totals',erp_stock.composition_totals(p_product_id),'virtual',v_virtual,
  'used_in',(select count(distinct i.product_id) from erp_stock.composition_current i join erp_catalog.product k on k.record_id=i.product_id where i.component_id=p_product_id and k.format='E')::integer,
  'settings',erp_stock.composition_settings());
end$$;

-- Componentes para o autocomplete da Estrutura: produtos simples ativos, por nome, código ou GTIN, com preço, custo e estoque.
create function public.erp_stock_composition_components(p_user_id uuid,p_query text,p_exclude uuid default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare q text;v_stock boolean;v_result jsonb;begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_query is null or length(btrim(p_query)) not between 1 and 120 or p_query~'[[:cntrl:]]' then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 q:=erp_catalog.fold(btrim(p_query));v_stock:=erp_catalog.can_read_stock(p_user_id);
 with rows as materialized(select r.id,r.name,r.code,p.unit,p.price,p.gtin from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id
   where r.entity='products' and r.active and p.kind='P' and p.format='S' and p.unit is not null and(p_exclude is null or r.id<>p_exclude)
    and not exists(select 1 from erp_catalog.product_detail d where d.record_id=r.id and d.deleted_at is not null)
    and(strpos(erp_catalog.fold(r.name),q)>0 or strpos(erp_catalog.fold(coalesce(r.code,'')),q)>0 or coalesce(p.gtin,'')=btrim(p_query))),
  page as materialized(select * from rows order by erp_catalog.fold(name),id limit 20)
 select jsonb_build_object('scope','stock_composition_components','data_mode','erp_native','query',p_query,'stock_visible',v_stock,'total',(select count(*) from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'code',x.code,'unit',x.unit,'price',erp_stock.price_text(x.price),
    'cost_price',(select erp_stock.price_text(s.cost_price) from erp_catalog.product_supplier s where s.record_id=x.id and s.is_default),
    'stock',case when v_stock then(select coalesce(sum(b.quantity),0) from erp_stock.balance b where b.product_id=x.id and not erp_stock.ignored_warehouse(b.warehouse_id))::numeric(18,6)::text end)
   order by erp_catalog.fold(x.name),x.id) from page x),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

-- 6. Gravação: o produto (formulário completo, 119) e a estrutura no mesmo comando, tudo ou nada. Sem estrutura no pedido
-- (p_composition null), grava só o produto e atualiza as composições que o usam como componente, conforme as Preferências.
-- p_composition: {"expected_version": versão atual da estrutura (0 sem estrutura), "stock_type", "post_mode", "items": [{"component_id","quantity"}]}.
-- Updates of a composition from its components (price, weights and the cost of its default supplier), through the product registry
-- functions (versão, comando derivado e auditoria do cadastro). Returns what was applied.
create function erp_stock.composition_apply_values(p_user_id uuid,p_command_id uuid,p_product uuid,p_skip_base boolean default false)returns jsonb language plpgsql set search_path=pg_catalog as $$
declare s jsonb:=erp_stock.composition_settings();t jsonb;v_patch jsonb:='{}'::jsonb;p erp_catalog.product;v_version integer;v_supplier uuid;v_cost numeric;v_out jsonb:='{}'::jsonb;begin
 if not((s->>'update_cost')::boolean or(s->>'update_weight')::boolean or(s->>'update_price')::boolean)then return v_out;end if;
 select * into p from erp_catalog.product where record_id=p_product;
 if p.format is distinct from 'E' or not exists(select 1 from erp_stock.composition_current where product_id=p_product)
  or exists(select 1 from erp_catalog.product_detail d where d.record_id=p_product and d.deleted_at is not null)then return jsonb_build_object('skipped','not_applicable');end if;
 t:=erp_stock.composition_totals(p_product);
 if not p_skip_base then
  if(s->>'update_price')::boolean and p.price is distinct from(t->>'sale')::numeric then v_patch:=v_patch||jsonb_build_object('price',t->>'sale');end if;
  if(s->>'update_weight')::boolean and(t->>'weighted')::integer>0 then
   if p.net_weight is distinct from(t->>'net_weight')::numeric then v_patch:=v_patch||jsonb_build_object('net_weight',t->>'net_weight');end if;
   if p.gross_weight is distinct from(t->>'gross_weight')::numeric then v_patch:=v_patch||jsonb_build_object('gross_weight',t->>'gross_weight');end if;
  end if;
  if v_patch<>'{}'::jsonb then
   select version into v_version from erp_catalog.record where id=p_product;
   perform public.erp_catalog_product_save(p_user_id,p_product,v_version,erp_stock.supply_part(p_command_id,'composition-values:'||p_product),v_patch,null);
   v_out:=v_out||v_patch;
  end if;
 end if;
 if(s->>'update_cost')::boolean then
  select supplier_id,cost_price into v_supplier,v_cost from erp_catalog.product_supplier where record_id=p_product and is_default;
  if v_supplier is null then v_out:=v_out||jsonb_build_object('cost_skipped','no_default_supplier');
  elsif v_cost is distinct from(t->>'cost')::numeric then
   select version into v_version from erp_catalog.record where id=p_product;
   perform public.erp_catalog_product_prices_update(p_user_id,erp_stock.supply_part(p_command_id,'composition-cost:'||p_product),v_supplier,
    jsonb_build_array(jsonb_build_object('product_id',p_product,'expected_version',v_version,'cost_price',t->>'cost')));
   v_out:=v_out||jsonb_build_object('cost_price',t->>'cost');
  end if;
 end if;
 return v_out;
end$$;

create function public.erp_stock_product_compose(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb,p_acknowledged jsonb,
  p_composition jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.composition_command;v_product jsonb;v_id uuid;cur erp_stock.composition;v_items jsonb;v_data jsonb:=p_data;v_settings jsonb;v_totals jsonb;
  v_applied jsonb:='{}'::jsonb;v_sync jsonb:='[]'::jsonb;v_kit uuid;v_result jsonb;v_version integer;v_problem text;v_command uuid;v_stock_type text;v_post_mode text;begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 if p_command_id is null or p_data is null or jsonb_typeof(p_data)<>'object' or p_expected_version is null
  or(p_composition is not null and(jsonb_typeof(p_composition)<>'object'
   or exists(select 1 from jsonb_object_keys(p_composition)k where k not in('expected_version','stock_type','post_mode','items'))
   or jsonb_typeof(p_composition->'expected_version') is distinct from 'number' or coalesce(p_composition->>'expected_version','')!~'^[0-9]{1,10}$'
   or(p_composition->>'expected_version')::bigint>2147483646 or coalesce(p_composition->>'stock_type','') not in('physical','virtual')
   or coalesce(p_composition->>'post_mode','') not in('product','components','both')
   or(p_composition->>'stock_type'='virtual' and p_composition->>'post_mode'<>'components')
   or jsonb_typeof(p_composition->'items') is distinct from 'array' or jsonb_array_length(p_composition->'items')>100
   or exists(select 1 from jsonb_array_elements(p_composition->'items')j where jsonb_typeof(j)<>'object'
    or exists(select 1 from jsonb_object_keys(j)k where k not in('component_id','quantity'))
    or jsonb_typeof(j->'component_id') is distinct from 'string' or coalesce(j->>'component_id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(j->'quantity') is distinct from 'string' or coalesce(j->>'quantity','')!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or(j->>'quantity')::numeric=0)
   or(select count(distinct j->>'component_id') from jsonb_array_elements(p_composition->'items')j)<>jsonb_array_length(p_composition->'items')))then
  raise exception 'erp_stock_composition_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-composition-222','actor',p_user_id,'id',p_id,'version',p_expected_version,'data',p_data,
  'acknowledged',p_acknowledged,'composition',p_composition)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_catalog.require_access(p_user_id,'products',true);
 select * into c from erp_stock.composition_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>h then raise exception 'erp_stock_composition_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 -- A command without a structure (the save of a component) keeps its row in the same family, keyed by the saved product.
 if erp_stock.command_taken(p_command_id) or exists(select 1 from erp_catalog.command where command_id=p_command_id)then
  raise exception 'erp_stock_composition_conflict' using errcode='40001';end if;
 -- Lock order of every stock writer (182): stock mutex before any catalog row. The catalog rows below are prelocked, and the product
 -- save takes this mutex itself for a new product with a sequential code, so taking it only there would invert the order.
 perform pg_advisory_xact_lock(174852909,0);perform erp_catalog.require_access(p_user_id,'products',true);
 v_settings:=erp_stock.composition_settings();
 if p_composition is not null then
  v_items:=(select coalesce(jsonb_agg(jsonb_build_object('component_id',j->>'component_id','quantity',(j->>'quantity')::numeric(18,6)::text) order by o),'[]'::jsonb)
   from jsonb_array_elements(p_composition->'items') with ordinality x(j,o));
  if p_id is not null and exists(select 1 from jsonb_array_elements(v_items)j where(j->>'component_id')::uuid=p_id)then raise exception 'erp_stock_composition_invalid' using errcode='22023';end if;
  -- The product and its components in UUID order (the catalog lock order of every stock writer, 018/105) before the product save;
  -- components are simple products, active, with a unit and not deleted.
  perform 1 from erp_catalog.record where id=p_id or id in(select(j->>'component_id')::uuid from jsonb_array_elements(v_items)j) order by id for update;
  select erp_stock.component_problem((j->>'component_id')::uuid) into v_problem from jsonb_array_elements(v_items)j where erp_stock.component_problem((j->>'component_id')::uuid) is not null limit 1;
  if v_problem is not null then raise exception 'erp_stock_composition_component_unavailable' using errcode='22023',detail=v_problem;end if;
  -- "Atualizar preço de venda / peso das composições com base nos componentes": the values go with the product save itself.
  v_totals:=erp_stock.composition_totals(null,v_items);
  if jsonb_array_length(v_items)>0 then
   if(v_settings->>'update_price')::boolean then v_data:=v_data||jsonb_build_object('price',v_totals->>'sale');v_applied:=v_applied||jsonb_build_object('price',v_totals->>'sale');end if;
   if(v_settings->>'update_weight')::boolean and(v_totals->>'weighted')::integer>0 then
    v_data:=v_data||jsonb_build_object('net_weight',v_totals->>'net_weight','gross_weight',v_totals->>'gross_weight');
    v_applied:=v_applied||jsonb_build_object('net_weight',v_totals->>'net_weight','gross_weight',v_totals->>'gross_weight');end if;
  end if;
 elsif p_id is not null then
  -- The product is a component: it and the compositions that use it are locked in UUID order before any of them is saved.
  perform 1 from erp_catalog.record where id=p_id or id in(select i.product_id from erp_stock.composition_current i where i.component_id=p_id) order by id for update;
 end if;
 v_product:=public.erp_catalog_product_save(p_user_id,p_id,p_expected_version,erp_stock.supply_part(p_command_id,'product'),v_data,p_acknowledged);
 if coalesce((v_product->>'replayed')::boolean,true)then raise exception 'erp_stock_composition_conflict' using errcode='40001';end if;
 v_id:=(v_product#>>'{record,id}')::uuid;
 if p_composition is not null then
  if not exists(select 1 from erp_catalog.product where record_id=v_id and format='E' and kind='P')then raise exception 'erp_stock_composition_format_required' using errcode='22023';end if;
  select * into cur from erp_stock.composition where product_id=v_id for update;
  if coalesce(cur.version,0)<>(p_composition->>'expected_version')::integer then raise exception 'erp_stock_composition_version_conflict' using errcode='40001';end if;
  v_stock_type:=p_composition->>'stock_type';v_post_mode:=p_composition->>'post_mode';
  -- A Físico composition that already has a stock of its own cannot become Virtual: Origin hides that balance; here it would be lost.
  if v_stock_type='virtual' and exists(select 1 from erp_stock.balance where product_id=v_id and quantity<>0)then raise exception 'erp_stock_composition_has_stock' using errcode='22023';end if;
  perform set_config('erp_stock.composition_command',p_command_id::text,true);
  if cur.product_id is null then
   insert into erp_stock.composition(product_id,stock_type,post_mode,version,updated_by,command_id)values(v_id,v_stock_type,v_post_mode,1,p_user_id,p_command_id);
  else
   update erp_stock.composition set stock_type=v_stock_type,post_mode=v_post_mode,version=version+1,updated_at=clock_timestamp(),updated_by=p_user_id,command_id=p_command_id where product_id=v_id;
  end if;
  select version into v_version from erp_stock.composition where product_id=v_id;
  insert into erp_stock.composition_item(product_id,version,position,component_id,quantity)
   select v_id,v_version,o::integer,(j->>'component_id')::uuid,(j->>'quantity')::numeric from jsonb_array_elements(v_items) with ordinality x(j,o);
  perform set_config('erp_stock.composition_command','',true);
  -- "Atualizar preço de custo": the cost of the composition's default supplier (only after the product save wrote the suppliers).
  if jsonb_array_length(v_items)>0 then v_applied:=v_applied||erp_stock.composition_apply_values(p_user_id,p_command_id,v_id,true);end if;
 else
  -- The product is a component: every composition that uses it follows the Preferências (in UUID order, each with its version).
  for v_kit in select distinct i.product_id from erp_stock.composition_current i join erp_catalog.product k on k.record_id=i.product_id
    where i.component_id=v_id and k.format='E' order by 1 loop
   v_sync:=v_sync||jsonb_build_array(jsonb_build_object('product_id',v_kit,'applied',erp_stock.composition_apply_values(p_user_id,p_command_id,v_kit)));
  end loop;
 end if;
 v_result:=jsonb_build_object('entity','products','record',erp_catalog.product_full(v_id),'data_mode','erp_native','command_id',p_command_id,
  'composition',erp_stock.composition_dto(v_id),'applied',v_applied,'synced',v_sync,'settings',v_settings);
 -- The structure row points to this command (deferred foreign key); the row is the receipt returned by "Conferir resultado".
 insert into erp_stock.composition_command(id,actor,action,product_id,request_hash,result)
  values(p_command_id,p_user_id,case when p_composition is null then 'sync' else 'save' end,v_id,h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

-- 7. "Novo Lançamento" (Entrada ou Saída) de uma composição no extrato: a composição e/ou os componentes conforme "Lançar estoque", no
-- depósito do cabeçalho, com a data de hoje (America/Sao_Paulo), num único movimento do 009 (tudo ou nada). A versão esperada é a da
-- posição da própria composição (Físico); as posições dos componentes são lidas sob o mutex do estoque. Preço e custo só valem para a
-- linha da própria composição. Balanço e transferência da composição Físico continuam pelo lançamento comum (105).
create function public.erp_stock_composition_launch(p_user_id uuid,p_command_id uuid,p_kind text,p_product_id uuid,p_warehouse_id uuid,p_quantity text,
  p_expected_version integer,p_note text default null,p_unit_price text default null,p_unit_cost text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.ledger_command;k erp_stock.composition;v_note text;v_reason text;v_day date;v_quantity numeric;v_price numeric;v_cost numeric;
  v_items jsonb:='[]'::jsonb;v_lines jsonb:='[]'::jsonb;l record;v_own boolean:=false;v_post jsonb;v_movement uuid;v_result jsonb;v_label text;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_kind is null or p_kind not in('receipt','issue') or p_product_id is null or p_warehouse_id is null or p_quantity is null
  or p_quantity!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or p_quantity::numeric=0 or p_expected_version not between 0 and 2147483646
  or(p_kind='issue' and p_unit_cost is not null)or length(p_note)>500 or p_note~'[[:cntrl:]]' then
  raise exception 'erp_stock_launch_invalid' using errcode='22023';end if;
 v_price:=erp_stock.price_105(p_unit_price);v_cost:=erp_stock.price_105(p_unit_cost);v_quantity:=p_quantity::numeric;
 v_note:=coalesce(nullif(btrim(p_note),''),'Lançamento manual');v_reason:=case when length(v_note)>=3 then v_note else 'Lançamento manual' end;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-composition-launch-222','actor',p_user_id,'kind',p_kind,'product_id',p_product_id,
  'warehouse_id',p_warehouse_id,'quantity',p_quantity,'expected_version',p_expected_version,'unit_price',p_unit_price,'unit_cost',p_unit_cost,'note',p_note)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into c from erp_stock.ledger_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'launch' or c.request_hash<>h then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 -- The composition, its components and the warehouse in UUID order (catalog lock order), then the structure is read.
 perform 1 from erp_catalog.record where id in(p_product_id,p_warehouse_id) or id in(select component_id from erp_stock.composition_current where product_id=p_product_id) order by id for update;
 select * into k from erp_stock.composition where product_id=p_product_id;
 if not exists(select 1 from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where p.record_id=p_product_id and p.kind='P' and p.format='E' and r.active and p.unit is not null)then
  raise exception 'erp_stock_product_unavailable' using errcode='22023';end if;
 v_day:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
 for l in select * from erp_stock.composition_lines(p_product_id,v_quantity) loop
  if l.role='composition' then v_own:=true;end if;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('product_id',l.product_id,'warehouse_id',p_warehouse_id,
   'quantity',case when p_kind='issue' then '-' else '' end||l.quantity::numeric(18,6)::text,
   'expected_version',case when l.role='composition' then p_expected_version else coalesce((select b.version from erp_stock.balance b where b.product_id=l.product_id and b.warehouse_id=p_warehouse_id),0)end));
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',l.product_id,'role',l.role,'per_kit',l.per_kit::numeric(18,6)::text,
   'quantity',case when p_kind='issue' then '-' else '' end||l.quantity::numeric(18,6)::text));
 end loop;
 -- Prices belong to the lançamento of the composition itself; components are posted without price, as a document would.
 if not v_own and(v_price is not null or v_cost is not null)then raise exception 'erp_stock_launch_invalid' using errcode='22023';end if;
 select left('Composição '||coalesce(nullif(r.code,''),r.name),100) into v_label from erp_catalog.record r where r.id=p_product_id;
 v_post:=erp_stock.post(p_user_id,p_command_id,p_kind,v_day,v_reason,v_label,v_items);
 if coalesce((v_post->>'replayed')::boolean,true)then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
 v_movement:=(v_post#>>'{movement,id}')::uuid;
 v_result:=jsonb_build_object('scope','stock_composition_launch','data_mode','erp_native','kind',p_kind,'occurred_on',v_day,'movement',v_post->'movement',
  'composition',jsonb_build_object('product_id',p_product_id,'stock_type',k.stock_type,'post_mode',k.post_mode,'version',k.version),'lines',v_lines,
  'detail',case when v_own then jsonb_build_object('revision',1,'unit_price',erp_stock.price_text(v_price),'unit_cost',erp_stock.price_text(v_cost),'note',v_note)end);
 insert into erp_stock.ledger_command(id,actor,action,movement_id,request_hash,result)values(p_command_id,p_user_id,'launch',v_movement,h,v_result);
 if v_own then
  insert into erp_stock.movement_detail(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id)values(v_movement,p_product_id,1,v_price,v_cost,v_note,p_user_id,p_command_id);
 end if;
 perform erp_stock.reservation_write_access(p_user_id);
 return v_result||jsonb_build_object('replayed',false);
end$$;

-- Lançamentos da composição (os mais recentes primeiro), com as posições e as versões atuais de cada uma: o extrato da composição
-- Virtual não tem linhas próprias, e o estorno de um lançamento com componentes é conjunto (erp_stock_reverse, 009/145/182).
create function public.erp_stock_composition_launches(p_user_id uuid,p_product_id uuid,p_limit integer default 10)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_product_id is null or p_limit is null or p_limit not between 1 and 20 then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 if not exists(select 1 from erp_catalog.product where record_id=p_product_id)then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 with launches as materialized(select c.movement_id,m.kind,m.occurred_on,m.created_at,m.reason,(select r.id from erp_stock.movement r where r.reverses_id=m.id) reversed_by
   from erp_stock.ledger_command c join erp_stock.movement m on m.id=c.movement_id
   where c.action='launch' and c.result->>'scope'='stock_composition_launch' and c.result#>>'{composition,product_id}'=p_product_id::text),
  page as materialized(select * from launches order by created_at desc,movement_id desc limit p_limit)
 select jsonb_build_object('scope','stock_composition_launches','data_mode','erp_native','product_id',p_product_id,'limit',p_limit,'total',(select count(*) from launches)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('movement_id',x.movement_id,'kind',x.kind,'occurred_on',x.occurred_on,'created_at',x.created_at,'note',x.reason,'reversed_by',x.reversed_by,
    'lines',(select jsonb_agg(jsonb_build_object('product_id',e.product_id,'name',r.name,'code',r.code,'warehouse_id',e.warehouse_id,'quantity',e.quantity::text,
      'expected_version',coalesce((select b.version from erp_stock.balance b where b.product_id=e.product_id and b.warehouse_id=e.warehouse_id),0)) order by e.ordinal)
     from erp_stock.entry e join erp_catalog.record r on r.id=e.product_id where e.movement_id=x.movement_id)) order by x.created_at desc,x.movement_id desc) from page x),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

-- 8. "Exportar dados de estrutura para planilha": uma linha por componente das estruturas atuais, em lotes de até 500, com
-- "Incluir produtos marcados como excluídos". Lê quem consulta produtos.
create function public.erp_stock_composition_export(p_user_id uuid,p_offset integer default 0,p_limit integer default 500,p_include_deleted boolean default false)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_offset is null or p_offset not between 0 and 10000000 or p_limit is null or p_limit not between 1 and 500 or p_include_deleted is null then
  raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 with rows as materialized(select i.product_id,i.position,i.component_id,i.quantity,i.stock_type,i.post_mode,k.name kit_name,k.code kit_code,
    (d.deleted_at is not null) kit_deleted,x.name component_name,x.code component_code,p.unit component_unit
   from erp_stock.composition_current i join erp_catalog.product kp on kp.record_id=i.product_id and kp.format='E'
   join erp_catalog.record k on k.id=i.product_id left join erp_catalog.product_detail d on d.record_id=i.product_id
   join erp_catalog.record x on x.id=i.component_id join erp_catalog.product p on p.record_id=i.component_id
   where p_include_deleted or d.deleted_at is null),
  page as materialized(select * from rows order by erp_catalog.fold(kit_name),product_id,position limit p_limit offset p_offset)
 select jsonb_build_object('scope','stock_composition_export','data_mode','erp_native','offset',p_offset,'limit',p_limit,'include_deleted',p_include_deleted,
  'total',(select count(*) from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',product_id,'product_code',kit_code,'product_name',kit_name,'product_deleted',kit_deleted,
    'stock_type',stock_type,'post_mode',post_mode,'position',position,'component_id',component_id,'component_code',component_code,'component_name',component_name,
    'component_unit',component_unit,'quantity',quantity::numeric(18,6)::text) order by erp_catalog.fold(kit_name),product_id,position) from page),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_composition_get','erp_stock_composition_components','erp_stock_product_compose','erp_stock_composition_launch','erp_stock_composition_launches','erp_stock_composition_export')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
