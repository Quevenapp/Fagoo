-- 105: Controle de estoque e Depósitos no padrão do Origin (Estoque > Lançamentos de estoque; Preferências > Suprimentos > Depósitos).
-- Requer 009/018/025/070/090/096/098/100. Nenhum movimento, saldo, preço ou cadastro existente é reescrito.
-- O razão009 continua imutável. Preço, custo e observação de um lançamento ficam em revisões imutáveis
-- (erp_stock.movement_detail); o Balanço é um ajuste009 com a contagem registrada ao lado (erp_stock.balance_count),
-- gravado sob o mesmo mutex e com a mesma política de estoque negativo (100).
-- Ordem de locks: comando 174852918 -> mutex 174852909 -> catálogo por UUID -> produto -> saldo -> acesso.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 for r in select * from(values
  ('public.erp_stock_balances(uuid,uuid,uuid)','6165ffdbc6a7499da2b4ccfff961f497791bd5b2e2647b256a9e74948e328587'),
  ('public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer)','54e27f340d634b5972632c4059d63a3241b08456674b36bfb2fbfac9ef23b3f3'),
  ('erp_stock.command_taken(uuid)','c20872fcd976947263fb5eede97f3c5f67eb2d4781fe6c4c6e0a6d8f99109493'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_ledger_105_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 1. Depósito padrão e "Desconsiderar saldo deste depósito". One immutable command row per accepted change is the audit trail.
create table erp_stock.warehouse_command(
 id uuid primary key,actor uuid not null references auth.users(id),
 action text not null check(action in('save','default')),
 warehouse_id uuid not null references erp_catalog.warehouse(record_id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create table erp_stock.warehouse_setting(
 warehouse_id uuid primary key references erp_catalog.warehouse(record_id),
 ignore_balance boolean not null,
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null,updated_by uuid not null references auth.users(id),
 command_id uuid not null unique references erp_stock.warehouse_command(id)
);
create table erp_stock.warehouse_default(
 singleton boolean primary key default true check(singleton),
 warehouse_id uuid references erp_catalog.warehouse(record_id),
 version integer not null default 0 check(version between 0 and 2147483647),
 updated_at timestamptz,updated_by uuid references auth.users(id),command_id uuid unique references erp_stock.warehouse_command(id),
 check((version=0 and warehouse_id is null and updated_at is null and updated_by is null and command_id is null)
  or(version>0 and warehouse_id is not null and updated_at is not null and updated_by is not null and command_id is not null))
);
insert into erp_stock.warehouse_default default values;
create trigger immutable_stock_warehouse_command before update or delete on erp_stock.warehouse_command for each row execute function erp_stock.immutable_ledger();
-- Settings change only through their command (same pattern as the 100 policy row).
create function erp_stock.guard_warehouse_setting()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or(tg_op='INSERT' and new.version<>1)or(tg_op='UPDATE' and(new.warehouse_id<>old.warehouse_id or new.version<>old.version+1 or new.command_id=old.command_id))
  or not exists(select 1 from erp_stock.warehouse_command c where c.id=new.command_id and c.action='save' and c.warehouse_id=new.warehouse_id and c.actor=new.updated_by)then
  raise exception 'erp_stock_warehouse_setting_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_warehouse_setting before insert or update or delete on erp_stock.warehouse_setting for each row execute function erp_stock.guard_warehouse_setting();
create function erp_stock.guard_warehouse_default()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op<>'UPDATE' or new.singleton is distinct from old.singleton or new.version<>old.version+1 or new.command_id is not distinct from old.command_id
  or not exists(select 1 from erp_stock.warehouse_command c where c.id=new.command_id and c.action='default' and c.warehouse_id=new.warehouse_id and c.actor=new.updated_by)then
  raise exception 'erp_stock_warehouse_default_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_warehouse_default before insert or update or delete on erp_stock.warehouse_default for each row execute function erp_stock.guard_warehouse_default();
-- Inactivating the default warehouse is refused for every writer (Origin: choose another default first). VOLATILE on
-- purpose: after waiting for the record row it reads the committed default.
create function erp_stock.protect_default_warehouse()returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if old.entity='warehouses' and old.active and not new.active and exists(select 1 from erp_stock.warehouse_default where warehouse_id=old.id)then
  raise exception 'erp_stock_default_warehouse_inactive' using errcode='22023';end if;
 return new;
end$$;
create trigger protect_stock_default_warehouse before update of active on erp_catalog.record for each row execute function erp_stock.protect_default_warehouse();

-- Readers and writers of Depósitos are the catalog's (006): read admin/consulta/estoque, write admin/estoque.
create function erp_stock.warehouse_access(p_actor uuid,p_write boolean,p_lock boolean default false)returns text language plpgsql set search_path=pg_catalog as $$
declare v_role text;begin
 if p_lock then
  perform 1 from auth.users where id=p_actor for key share;
  perform 1 from erp_access.membership where user_id=p_actor for share;
 end if;
 select role into v_role from erp_access.membership where user_id=p_actor and active;
 if not found or not erp_catalog.allowed(v_role,'warehouses',p_write)then raise exception 'erp_stock_warehouse_access_denied' using errcode='42501';end if;
 return v_role;
end$$;
create function erp_stock.warehouse_dto(p_id uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',r.id,'name',r.name,'active',r.active,'version',r.version,
  'is_default',coalesce(d.warehouse_id=r.id,false),'ignore_balance',coalesce(s.ignore_balance,false),'setting_version',coalesce(s.version,0))
 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id cross join erp_stock.warehouse_default d
 left join erp_stock.warehouse_setting s on s.warehouse_id=r.id where r.id=p_id and r.entity='warehouses'
$$;
create function erp_stock.ignored_warehouse(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce((select ignore_balance from erp_stock.warehouse_setting where warehouse_id=p_id),false)
$$;

-- 2. Ledger additions. A launch or an amendment is one immutable command row; both point to the movement.
create table erp_stock.ledger_command(
 id uuid primary key,actor uuid not null references auth.users(id),action text not null check(action in('launch','amend')),
 movement_id uuid not null references erp_stock.movement(id),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
-- Preço de Compra/Venda, Preço de Custo and Observação of a lançamento (one product of a movement, as Origin shows one
-- lançamento per product). The newest revision is the one shown.
create table erp_stock.movement_detail(
 movement_id uuid not null references erp_stock.movement(id),product_id uuid not null references erp_catalog.product(record_id),
 revision integer not null check(revision between 1 and 2147483647),
 unit_price numeric check(unit_price is null or(unit_price>=0 and unit_price<100000000000000 and unit_price=trunc(unit_price,10))),
 unit_cost numeric check(unit_cost is null or(unit_cost>=0 and unit_cost<100000000000000 and unit_cost=trunc(unit_cost,10))),
 note text not null check(length(note)<=500 and note=btrim(note) and note!~'[[:cntrl:]]'),
 actor uuid not null references auth.users(id),command_id uuid not null unique references erp_stock.ledger_command(id),
 created_at timestamptz not null default clock_timestamp(),primary key(movement_id,product_id,revision)
);
-- Balanço: the informed balance and the balance it replaced. The movement is the 009 adjustment of exactly the difference.
create table erp_stock.balance_count(
 movement_id uuid primary key references erp_stock.movement(id),
 product_id uuid not null references erp_catalog.product(record_id),warehouse_id uuid not null references erp_catalog.warehouse(record_id),
 counted numeric(18,6) not null check(counted between -999999999999.999999 and 999999999999.999999),
 previous numeric(18,6) not null check(previous between -999999999999.999999 and 999999999999.999999),
 source text not null check(source in('launch','count')),created_at timestamptz not null default clock_timestamp(),
 check(counted<>previous)
);
create index erp_stock_balance_count_position on erp_stock.balance_count(product_id,warehouse_id,movement_id);
create trigger immutable_stock_ledger_command before update or delete on erp_stock.ledger_command for each row execute function erp_stock.immutable_ledger();
create trigger immutable_stock_movement_detail before update or delete on erp_stock.movement_detail for each row execute function erp_stock.immutable_ledger();
create trigger immutable_stock_balance_count before update or delete on erp_stock.balance_count for each row execute function erp_stock.immutable_ledger();
-- A balance row must describe its movement exactly: one adjustment entry of counted - previous at that position.
create function erp_stock.guard_balance_count()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if not exists(select 1 from erp_stock.movement m where m.id=new.movement_id and m.kind='adjustment')
  or(select count(*)from erp_stock.entry e where e.movement_id=new.movement_id)<>1
  or not exists(select 1 from erp_stock.entry e where e.movement_id=new.movement_id and e.product_id=new.product_id and e.warehouse_id=new.warehouse_id
   and e.quantity=new.counted-new.previous and e.balance_after=new.counted)then
  raise exception 'erp_stock_balance_count_invalid' using errcode='22023';end if;
 return new;
end$$;
create trigger guard_stock_balance_count before insert on erp_stock.balance_count for each row execute function erp_stock.guard_balance_count();
do $$declare t text;begin foreach t in array array['warehouse_command','warehouse_setting','warehouse_default','ledger_command','movement_detail','balance_count']loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

-- One UUID identifies one effect across every stock command family (100), now including Depósitos and lançamentos.
create or replace function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
  or exists(select 1 from erp_stock.warehouse_command where id=p_id)or exists(select 1 from erp_stock.ledger_command where id=p_id)
$$;

-- Exact unit price/cost: up to 14 integer digits and 10 decimals, as a string; never rounded.
create function erp_stock.price_105(p text)returns numeric language plpgsql immutable set search_path=pg_catalog as $$begin
 if p is null then return null;end if;
 if p!~'^(0|[1-9][0-9]{0,13})(\.[0-9]{1,10})?$' then raise exception 'erp_stock_price_invalid' using errcode='22023';end if;
 return p::numeric;
end$$;
create function erp_stock.price_text(p numeric)returns text language sql immutable set search_path=pg_catalog as $$
 select case when p is null then null else p::numeric(24,10)::text end
$$;
-- Document lançamentos (018 and 090) show the item price of that document when it is unambiguous for the product.
create function erp_stock.ledger_document_price(p_movement uuid,p_product uuid)returns numeric language sql stable set search_path=pg_catalog as $$
 with doc as(select coalesce(
   (select document_id from erp_stock.document_posting where movement_id=p_movement or reversal_movement_id=p_movement limit 1),
   (select document_id from erp_purchase_receipts.receipt where movement_id=p_movement),
   (select document_id from erp_purchase_receipts.reversal where movement_id=p_movement))id),
 prices as(select distinct i.unit_price from erp_documents.item i join doc on i.document_id=doc.id where i.product_id=p_product)
 select case when(select count(*)from prices)=1 then(select unit_price from prices)end
$$;
-- Prices of a document lançamento are document data: only a reader of that document kind (008) sees them, so vendas never
-- sees purchase prices and estoque/fiscal never see service order prices. The observação and quantities stay visible.
create function erp_stock.ledger_row_105(p_movement_id uuid,p_product_id uuid,p_role text)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d erp_stock.movement_detail;c erp_stock.balance_count;price numeric;cost numeric;source text;v_row jsonb;v_kind text;v_hidden boolean;begin
 v_row:=erp_stock.ledger_row(p_movement_id,p_product_id);v_kind:=v_row#>>'{origin,document_kind}';
 v_hidden:=v_kind is not null and not erp_documents.allowed(p_role,v_kind,false);
 select * into d from erp_stock.movement_detail where movement_id=p_movement_id and product_id=p_product_id order by revision desc limit 1;
 if d.movement_id is not null then source:='detail';if not v_hidden then price:=d.unit_price;cost:=d.unit_cost;end if;
 elsif not v_hidden then price:=erp_stock.ledger_document_price(p_movement_id,p_product_id);source:=case when price is not null then 'document' end;end if;
 select * into c from erp_stock.balance_count where movement_id=p_movement_id and product_id=p_product_id;
 return v_row||jsonb_build_object('revision',coalesce(d.revision,0),'note',d.note,
  'unit_price',erp_stock.price_text(price),'unit_cost',erp_stock.price_text(cost),'price_source',source,
  'balance',case when c.movement_id is not null then jsonb_build_object('counted',c.counted::text,'previous',c.previous::text,'warehouse_id',c.warehouse_id,'source',c.source)end);
end$$;

-- 3. Saldos do produto (009) com depósito padrão, saldo desconsiderado e reservado de cada depósito.
create or replace function public.erp_stock_balances(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;
begin
  perform erp_stock.require_access(p_user_id,false);
  if p_product_id is null or not exists(select 1 from erp_catalog.product where record_id=p_product_id) then
    raise exception 'erp_stock_product_not_found' using errcode='P0002'; end if;
  select jsonb_build_object('product_id',p_product_id,'items',coalesce(jsonb_agg(jsonb_build_object(
    'warehouse_id',w.record_id,'warehouse_name',r.name,'warehouse_active',r.active,'quantity',coalesce(b.quantity,0)::numeric(18,6)::text,
    'version',coalesce(b.version,0),'unit',p.unit,'warehouse_default',coalesce(d.warehouse_id=w.record_id,false),
    'warehouse_ignored',erp_stock.ignored_warehouse(w.record_id),
    'reserved_quantity',erp_stock.reserved_quantity(p_product_id,w.record_id)::numeric(18,6)::text) order by w.record_id),'[]'::jsonb),'data_mode','erp_native') into v_result
  from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id
  join erp_catalog.product p on p.record_id=p_product_id
  cross join erp_stock.warehouse_default d
  left join erp_stock.balance b on b.product_id=p_product_id and b.warehouse_id=w.record_id
  where p_warehouse_id is null or w.record_id=p_warehouse_id;
  return v_result;
end $$;

-- 4. Extrato (098) com Tipo Entrada/Saída/Balanço, preços e o saldo atual sem os depósitos desconsiderados.
-- direction: entry = linha positiva que não é balanço; exit = linha negativa que não é balanço; balance = Balanço.
-- Entradas e Saídas do totalizador não somam Balanços. Saldo atual sem depósito filtrado ignora os depósitos desconsiderados.
drop function public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer);
create function public.erp_stock_ledger(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null,p_kind text default null,
  p_origin text default null,p_date_from date default null,p_date_to date default null,p_limit integer default 100,p_offset integer default 0,p_direction text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_unit text;v_role text;v_result jsonb;
begin
  perform erp_stock.require_access(p_user_id,false);
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if p_product_id is null or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
    or (p_kind is not null and p_kind not in('receipt','issue','adjustment','transfer','reversal'))
    or (p_origin is not null and p_origin not in('sales','purchases','services','transfers','none'))
    or (p_direction is not null and p_direction not in('entry','exit','balance'))
    or (p_date_from is not null and (not isfinite(p_date_from) or p_date_from not between date '1900-01-01' and date '2100-12-31'))
    or (p_date_to is not null and (not isfinite(p_date_to) or p_date_to not between date '1900-01-01' and date '2100-12-31'))
    or p_date_from>p_date_to then
    raise exception 'erp_stock_invalid_query' using errcode='22023';
  end if;
  select p.unit into v_unit from erp_catalog.product p where p.record_id=p_product_id;
  if not found then raise exception 'erp_stock_product_not_found' using errcode='P0002'; end if;
  if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id) then
    raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';
  end if;
  with scoped as materialized(
    select m.id,m.occurred_on,m.created_at,case when p_origin is null then null else erp_stock.ledger_origin(m.id)->>'type' end origin,
      exists(select 1 from erp_stock.balance_count c where c.movement_id=m.id) is_balance
    from (select distinct e.movement_id from erp_stock.entry e
      where e.product_id=p_product_id and (p_warehouse_id is null or e.warehouse_id=p_warehouse_id)) x
    join erp_stock.movement m on m.id=x.movement_id
    where (p_kind is null or m.kind=p_kind) and (p_date_from is null or m.occurred_on>=p_date_from) and (p_date_to is null or m.occurred_on<=p_date_to)),
  filtered as materialized(select s.id,s.occurred_on,s.created_at,s.is_balance from scoped s where (p_origin is null or s.origin=p_origin)
    and (p_direction is null or (p_direction='balance' and s.is_balance) or (p_direction in('entry','exit') and not s.is_balance and exists(
      select 1 from erp_stock.entry e where e.movement_id=s.id and e.product_id=p_product_id and (p_warehouse_id is null or e.warehouse_id=p_warehouse_id)
       and case when p_direction='entry' then e.quantity>0 else e.quantity<0 end)))),
  page as materialized(select id,occurred_on,created_at from filtered order by occurred_on desc,created_at desc,id desc limit p_limit offset p_offset),
  counted as (select count(*)::integer total from filtered),
  sums as (select coalesce(sum(e.quantity) filter(where e.quantity>0),0) entries,coalesce(sum(-e.quantity) filter(where e.quantity<0),0) exits
    from erp_stock.entry e join filtered f on f.id=e.movement_id
    where not f.is_balance and e.product_id=p_product_id and (p_warehouse_id is null or e.warehouse_id=p_warehouse_id))
  select jsonb_build_object('product_id',p_product_id,
    'items',coalesce((select jsonb_agg(erp_stock.ledger_row_105(p.id,p_product_id,v_role) order by p.occurred_on desc,p.created_at desc,p.id desc) from page p),'[]'::jsonb),
    'limit',p_limit,'offset',p_offset,'total',c.total,'has_more',c.total>p_offset+p_limit,
    'next_offset',case when c.total>p_offset+p_limit then p_offset+p_limit end,
    'filters',jsonb_build_object('warehouse_id',p_warehouse_id,'kind',p_kind,'origin',p_origin,'date_from',p_date_from,'date_to',p_date_to,'direction',p_direction),
    'totals',jsonb_build_object('entries',s.entries::numeric(38,6)::text,'exits',s.exits::numeric(38,6)::text,
      'current_balance',(select coalesce(sum(b.quantity),0) from erp_stock.balance b
        where b.product_id=p_product_id and (b.warehouse_id=p_warehouse_id or (p_warehouse_id is null and not erp_stock.ignored_warehouse(b.warehouse_id))))::numeric(38,6)::text,'unit',v_unit),
    'data_mode','erp_native') into v_result
  from counted c cross join sums s;
  return v_result;
end $$;

-- 5. Lançamento manual do Origin: Entrada, Saída, Balanço ou Transferência, no depósito do cabeçalho, com a data de hoje
-- (America/Sao_Paulo), preço, custo e observação. A gravação física é a do 009/025/070/100 (erp_stock.post), com o mesmo
-- comando, a mesma versão esperada e a mesma política de estoque negativo; o Balanço calcula a diferença sob o mutex.
create function public.erp_stock_launch(p_user_id uuid,p_command_id uuid,p_kind text,p_product_id uuid,p_warehouse_id uuid,p_quantity text,
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
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
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

-- 6. Edição do lançamento (painel "Lançamento de estoque"): só Preço de Compra/Venda, Preço de Custo e Observação mudam.
-- Quantidade, data, depósito e tipo nunca mudam; cada edição é uma nova revisão imutável, com ator, hora e comando.
create function public.erp_stock_movement_amend(p_user_id uuid,p_command_id uuid,p_movement_id uuid,p_product_id uuid,p_expected_revision integer,
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
 v_result:=jsonb_build_object('scope','stock_amend','data_mode','erp_native','movement_id',p_movement_id,'product_id',p_product_id,
  'from',jsonb_build_object('revision',coalesce(d.revision,0),'unit_price',erp_stock.price_text(v_was_price),'unit_cost',erp_stock.price_text(d.unit_cost),'note',v_was_note),
  'detail',jsonb_build_object('revision',coalesce(d.revision,0)+1,'unit_price',erp_stock.price_text(v_price),'unit_cost',erp_stock.price_text(v_cost),'note',v_note),
  'amended_at',clock_timestamp());
 insert into erp_stock.ledger_command(id,actor,action,movement_id,request_hash,result)values(p_command_id,p_user_id,'amend',p_movement_id,h,v_result);
 insert into erp_stock.movement_detail(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id)values(p_movement_id,p_product_id,coalesce(d.revision,0)+1,v_price,v_cost,v_note,p_user_id,p_command_id);
 perform erp_stock.reservation_write_access(p_user_id);
 return v_result||jsonb_build_object('replayed',false);
end$$;

-- 7. Reservado do produto: pedidos com reserva ativa (070). Quem lê estoque também lê pedidos de venda (008).
create function public.erp_stock_product_reservations(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_product_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 if not exists(select 1 from erp_catalog.product where record_id=p_product_id)then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id)then
  raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 with rows as materialized(select r.id,d.id document_id,d.number,d.status,d.contact_snapshot->>'name' contact_name,i.warehouse_id,i.quantity,i.unit,r.created_at
   from erp_stock.reservation r join erp_stock.reservation_item i on i.reservation_id=r.id join erp_documents.document d on d.id=r.document_id
   where r.state='active' and i.product_id=p_product_id and(p_warehouse_id is null or i.warehouse_id=p_warehouse_id)),
  page as materialized(select * from rows order by number desc,id limit 100)
 select jsonb_build_object('product_id',p_product_id,'warehouse_id',p_warehouse_id,
  'items',coalesce((select jsonb_agg(jsonb_build_object('reservation_id',id,'document_id',document_id,'document_number',number::text,'status',status,
    'contact_name',contact_name,'warehouse_id',warehouse_id,'quantity',quantity::numeric(18,6)::text,'unit',unit,'reserved_at',created_at) order by number desc,id)from page),'[]'::jsonb),
  'total',(select count(*)from rows)::integer,'quantity',(select coalesce(sum(quantity),0)from rows)::numeric(38,6)::text,
  'scope','stock_product_reservations','data_mode','erp_native') into v_result;
 return v_result;
end$$;

-- 8. Totalizador sem produto: Quantidade de Itens em Estoque e Valor de Venda do Estoque (quantidade × preço de venda),
-- sem os depósitos desconsiderados quando nenhum depósito é filtrado. Não há preço de custo no cadastro do produto.
-- Também devolve as opções do seletor de depósito do extrato, com o depósito padrão.
create function public.erp_stock_totals(p_user_id uuid,p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id)then
  raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 with scoped as materialized(select b.product_id,b.quantity,p.price from erp_stock.balance b join erp_catalog.product p on p.record_id=b.product_id
   where b.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(b.warehouse_id)))
 select jsonb_build_object('warehouse_id',p_warehouse_id,'quantity',(select coalesce(sum(quantity),0)from scoped)::numeric(38,6)::text,
  'sale_value',(select coalesce(round(sum(quantity*price),2),0)from scoped where price is not null)::numeric(38,2)::text,
  'unpriced_products',(select count(distinct product_id)from scoped where price is null and quantity<>0)::integer,
  'ignored_warehouses',(select count(*)from erp_stock.warehouse_setting where ignore_balance)::integer,
  -- Selector of the extrato for every stock reader: names were already visible in the 009 balances.
  'warehouses',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'active',r.active,'is_default',coalesce(d.warehouse_id=r.id,false),
    'ignore_balance',erp_stock.ignored_warehouse(r.id))order by erp_catalog.fold(r.name),r.id),'[]'::jsonb)
   from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id cross join erp_stock.warehouse_default d),
  'scope','stock_totals','data_mode','erp_native') into v_result;
 return v_result;
end$$;

-- 9. Depósitos: lista "Pesquisar por descrição", Situação, depósito padrão e saldo desconsiderado.
create function public.erp_stock_warehouses(p_user_id uuid,p_query text default null,p_active boolean default null,p_page integer default 1,p_size integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_result jsonb;begin
 v_role:=erp_stock.warehouse_access(p_user_id,false);
 if p_page is null or p_page not between 1 and 100000 or p_size is null or p_size not between 1 and 100
  or length(p_query)>120 or p_query~'[[:cntrl:]]' then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 with filtered as materialized(select r.id,erp_catalog.fold(r.name) folded from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id
   where(p_active is null or r.active=p_active)and(nullif(btrim(p_query),'')is null or strpos(erp_catalog.fold(r.name),erp_catalog.fold(btrim(p_query)))>0)),
  page as materialized(select id,folded from filtered order by folded,id limit p_size offset(p_page-1)*p_size)
 select jsonb_build_object('items',coalesce((select jsonb_agg(erp_stock.warehouse_dto(id) order by folded,id)from page),'[]'::jsonb),
  'page',p_page,'size',p_size,'total',(select count(*)from filtered)::integer,
  'default',(select jsonb_build_object('warehouse_id',warehouse_id,'version',version)from erp_stock.warehouse_default),
  'can_manage',erp_catalog.allowed(v_role,'warehouses',true),'scope','stock_warehouses','data_mode','erp_native') into v_result;
 return v_result;
end$$;
-- Incluir/Editar depósito: Descrição (o nome do cadastro006, código e descrição longa preservados) e o toggle de saldo,
-- numa única transação: o cadastro passa pelo comando auditado do 006 com o mesmo UUID.
create function public.erp_stock_warehouse_save(p_user_id uuid,p_command_id uuid,p_warehouse_id uuid,p_expected_version integer,
  p_expected_setting_version integer,p_name text,p_ignore_balance boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.warehouse_command;s erp_stock.warehouse_setting;v_catalog jsonb;v_id uuid;v_changed boolean;v_result jsonb;at timestamptz;begin
 perform erp_stock.warehouse_access(p_user_id,true);
 if p_command_id is null or p_expected_version is null or p_expected_setting_version is null or p_ignore_balance is null
  or p_expected_version not between 0 and 2147483646 or p_expected_setting_version not between 0 and 2147483646
  or(p_warehouse_id is null)<>(p_expected_version=0)or(p_warehouse_id is null and p_expected_setting_version<>0)
  or p_name is null or p_name<>btrim(p_name)or length(p_name)not between 1 and 200 or p_name~'[[:cntrl:]]' then
  raise exception 'erp_stock_warehouse_input_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-warehouse-save-105','actor',p_user_id,'warehouse_id',p_warehouse_id,'expected_version',p_expected_version,
  'expected_setting_version',p_expected_setting_version,'name',p_name,'ignore_balance',p_ignore_balance)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.warehouse_access(p_user_id,true);
 select * into c from erp_stock.warehouse_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'save' or c.request_hash<>h then raise exception 'erp_stock_warehouse_command_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('warehouse',erp_stock.warehouse_dto(c.warehouse_id),'replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)or exists(select 1 from erp_catalog.command where command_id=p_command_id)then
  raise exception 'erp_stock_warehouse_command_conflict' using errcode='40001';end if;
 v_catalog:=erp_catalog.mutate(p_user_id,'warehouses',p_warehouse_id,p_expected_version,p_command_id,jsonb_build_object('name',p_name),false,null);
 v_id:=(v_catalog#>>'{record,id}')::uuid;
 select * into s from erp_stock.warehouse_setting where warehouse_id=v_id for update;
 if coalesce(s.version,0)<>p_expected_setting_version or coalesce(s.version,0)=2147483647 then
  raise exception 'erp_stock_warehouse_version_conflict' using errcode='40001';end if;
 v_changed:=coalesce(s.ignore_balance,false)<>p_ignore_balance;at:=clock_timestamp();
 v_result:=jsonb_build_object('scope','stock_warehouse','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'action','save',
  'created',p_warehouse_id is null,'catalog_changed',p_warehouse_id is null or(v_catalog#>>'{record,version}')::integer<>p_expected_version,
  'setting_changed',v_changed,'from',jsonb_build_object('ignore_balance',coalesce(s.ignore_balance,false)),'to',jsonb_build_object('ignore_balance',p_ignore_balance),'saved_at',at));
 insert into erp_stock.warehouse_command(id,actor,action,warehouse_id,request_hash,result)values(p_command_id,p_user_id,'save',v_id,h,v_result);
 if v_changed then
  if s.warehouse_id is null then
   insert into erp_stock.warehouse_setting(warehouse_id,ignore_balance,version,updated_at,updated_by,command_id)values(v_id,p_ignore_balance,1,at,p_user_id,p_command_id);
  else update erp_stock.warehouse_setting set ignore_balance=p_ignore_balance,version=version+1,updated_at=at,updated_by=p_user_id,command_id=p_command_id where warehouse_id=v_id;end if;
 end if;
 perform erp_stock.warehouse_access(p_user_id,true,true);
 return v_result||jsonb_build_object('warehouse',erp_stock.warehouse_dto(v_id),'replayed',false);
end$$;
-- "Tornar depósito padrão": somente um depósito ativo; o anterior deixa de ser o padrão na mesma troca.
create function public.erp_stock_warehouse_set_default(p_user_id uuid,p_command_id uuid,p_warehouse_id uuid,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.warehouse_command;d erp_stock.warehouse_default;r erp_catalog.record;v_result jsonb;at timestamptz;begin
 perform erp_stock.warehouse_access(p_user_id,true);
 if p_command_id is null or p_warehouse_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 then
  raise exception 'erp_stock_warehouse_input_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-warehouse-default-105','actor',p_user_id,'warehouse_id',p_warehouse_id,'expected_version',p_expected_version)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.warehouse_access(p_user_id,true);
 select * into c from erp_stock.warehouse_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'default' or c.request_hash<>h then raise exception 'erp_stock_warehouse_command_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('warehouse',erp_stock.warehouse_dto(c.warehouse_id),'replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)or exists(select 1 from erp_catalog.command where command_id=p_command_id)then
  raise exception 'erp_stock_warehouse_command_conflict' using errcode='40001';end if;
 -- FOR SHARE serializes with an inactivation of the same record (protect_default_warehouse).
 select x.* into r from erp_catalog.record x join erp_catalog.warehouse w on w.record_id=x.id where x.id=p_warehouse_id and x.entity='warehouses' for share of x;
 if not found then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 if not r.active then raise exception 'erp_stock_default_warehouse_inactive' using errcode='22023';end if;
 select * into d from erp_stock.warehouse_default where singleton for update;
 if d.version<>p_expected_version or d.version=2147483647 then raise exception 'erp_stock_warehouse_version_conflict' using errcode='40001';end if;
 if d.warehouse_id is not distinct from p_warehouse_id then raise exception 'erp_stock_warehouse_default_unchanged' using errcode='22023';end if;
 at:=clock_timestamp();
 v_result:=jsonb_build_object('scope','stock_warehouse','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'action','default',
  'from',jsonb_build_object('warehouse_id',d.warehouse_id,'version',d.version),'to',jsonb_build_object('warehouse_id',p_warehouse_id,'version',d.version+1),'saved_at',at));
 insert into erp_stock.warehouse_command(id,actor,action,warehouse_id,request_hash,result)values(p_command_id,p_user_id,'default',p_warehouse_id,h,v_result);
 update erp_stock.warehouse_default set warehouse_id=p_warehouse_id,version=version+1,updated_at=at,updated_by=p_user_id,command_id=p_command_id where singleton;
 perform erp_stock.warehouse_access(p_user_id,true,true);
 return v_result||jsonb_build_object('warehouse',erp_stock.warehouse_dto(p_warehouse_id),'replayed',false);
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_balances','erp_stock_ledger','erp_stock_launch','erp_stock_movement_amend','erp_stock_product_reservations','erp_stock_totals',
 'erp_stock_warehouses','erp_stock_warehouse_save','erp_stock_warehouse_set_default')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
