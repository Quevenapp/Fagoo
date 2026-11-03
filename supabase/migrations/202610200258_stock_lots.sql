-- 258: Controle de lotes no estoque, no padrão do Origin (onda E do estoque). Requer 105 (lançamento manual), 115 (Preferências),
-- 183 (transferência em lote), 191 (chave "Controle de lote" do produto) e 222 (composições). Nenhum movimento, saldo, cadastro ou
-- documento existente é reescrito; um produto sem controle de lote não muda em nada.
-- - Lote do produto (Estoque > Lotes e validades e a grade de lotes da aba Estoque do produto): Lote, Data de fabricação, Data de
--   validade e Obs.; o código não se repete no produto (sem diferença de maiúsculas) e não muda depois de gravado. "Excluir lote"
--   inativa o lote sem saldo (o histórico fica); o lote inativo não recebe lançamentos novos.
-- - Saldo por lote e depósito, sempre >= 0. O lote é opcional nos lançamentos (no Origin o campo Lote não tem asterisco e o Informar
--   lotes oferece "Sem lote"): a parte do saldo sem lote é o saldo do depósito menos a soma dos lotes, mostrada como "Sem lote".
-- - Novo Lançamento com Lote: Entrada (lote existente ou "Novo lote", criado no mesmo comando), Saída (lote com saldo no depósito),
--   Balanço (a quantidade informada é o novo saldo do lote no depósito; a diferença vai para o saldo do depósito) e Transferência entre
--   depósitos (o lote sai da origem e entra no destino). Mesmo motor (erp_stock_launch -> erp_stock.post): mutex, versões esperadas,
--   política de estoque negativo, reservas, comando idempotente e auditoria.
-- - Transferência dos produtos selecionados (183) aceita o Lote de cada produto.
-- - Estorno de qualquer lançamento (extrato, documento, composição): as linhas de lote do lançamento original voltam junto, pela própria
--   linha do estorno no razão (gatilho), e o lote nunca fica negativo.
-- - Preferências > Cadastros > Controle de lotes: "Tornar obrigatório data de validade" e "... data de fabricação" valem ao gravar um
--   lote (também o "Novo lote" do lançamento); "Número de dias antes da data de validade" marca os lotes com saldo que vencem até lá.
-- Os documentos (pedidos, OS, notas) continuam lançando sem lote ("Sem lote"): o "Informar lotes" dos documentos é das frentes de
-- documentos e notas.
begin;

do $$declare r record;begin
 if to_regclass('erp_stock.composition')is null or to_regprocedure('erp_preferences.get(text,uuid)')is null
  or to_regprocedure('public.erp_stock_launch(uuid,uuid,text,uuid,uuid,text,integer,text,text,text,uuid,integer)')is null
  or not exists(select 1 from pg_attribute where attrelid='erp_catalog.product_detail'::regclass and attname='lot_control' and not attisdropped)then
  raise exception 'stock_lots_258_requires_105_115_183_191_222' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.command_taken(uuid)','1ea456f4d282a94c172fdc9e804ca2b9a54a7e4bfce3f76affb94a7bd771c52a'),
  ('public.erp_stock_transfer_positions(uuid,uuid,uuid,jsonb)','ed10560b24e3dda939ed43c89edcc80860a538b5c1e0981adee59439f0e414d8'),
  ('public.erp_stock_transfer_batch(uuid,uuid,uuid,uuid,text,jsonb)','4f51870573d7d8e8829503f971d6abcd5dd8f93820599da25fa5370b45bc90cf'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_lots_258_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regclass('erp_stock.lot')is not null then raise exception 'stock_lots_258_already_applied' using errcode='55000';end if;
end$$;

-- 1. Tables. One immutable command row per accepted lot command (the receipt of "Conferir resultado").
create table erp_stock.lot_command(
 id uuid primary key,actor uuid not null references auth.users(id),
 action text not null check(action in('save','status','launch')),
 product_id uuid not null references erp_catalog.product(record_id),lot_id uuid not null,
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create index erp_stock_lot_command_lot on erp_stock.lot_command(lot_id,created_at);
create table erp_stock.lot(
 id uuid primary key default gen_random_uuid(),
 product_id uuid not null references erp_catalog.product(record_id),
 code text not null check(length(code) between 1 and 60 and code=btrim(code) and code!~'[[:cntrl:]]'),
 manufactured_on date check(manufactured_on between date '1900-01-01' and date '2100-12-31'),
 expires_on date check(expires_on between date '1900-01-01' and date '2100-12-31'),
 note text check(note is null or(length(note) between 1 and 500 and note=btrim(note) and note!~'[[:cntrl:]]')),
 active boolean not null default true,
 version integer not null check(version between 1 and 2147483647),
 created_at timestamptz not null default clock_timestamp(),created_by uuid not null references auth.users(id),
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid not null references auth.users(id),
 -- The last command that wrote the lot (save, status or the launch that created it).
 command_id uuid not null,
 check(manufactured_on is null or expires_on is null or manufactured_on<=expires_on)
);
create unique index erp_stock_lot_code on erp_stock.lot(product_id,lower(code));
create table erp_stock.lot_balance(
 lot_id uuid not null references erp_stock.lot(id),warehouse_id uuid not null references erp_catalog.warehouse(record_id),
 quantity numeric(18,6) not null default 0 check(quantity>=0 and quantity<=999999999999.999999),
 version integer not null default 0 check(version between 0 and 2147483647),updated_at timestamptz not null default clock_timestamp(),
 primary key(lot_id,warehouse_id)
);
-- The lot split of a ledger line (009 entry): same movement, product and warehouse, same sign, never more than the line itself.
create table erp_stock.lot_entry(
 movement_id uuid not null references erp_stock.movement(id),
 product_id uuid not null references erp_catalog.product(record_id),
 warehouse_id uuid not null references erp_catalog.warehouse(record_id),
 lot_id uuid not null references erp_stock.lot(id),
 quantity numeric(18,6) not null check(quantity<>0),
 balance_after numeric(18,6) not null check(balance_after>=0),
 created_at timestamptz not null default clock_timestamp(),
 primary key(movement_id,product_id,warehouse_id,lot_id)
);
create index erp_stock_lot_entry_lot on erp_stock.lot_entry(lot_id,warehouse_id,movement_id);
create trigger immutable_stock_lot_command before update or delete on erp_stock.lot_command for each row execute function erp_stock.immutable_ledger();
-- A lot keeps its product, code and creation; every change is one version more, written by another command; it is never deleted.
create function erp_stock.guard_lot()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or(tg_op='INSERT' and new.version<>1)or(tg_op='UPDATE' and(new.id<>old.id or new.product_id<>old.product_id or new.code<>old.code
   or new.created_at<>old.created_at or new.created_by<>old.created_by or new.version<>old.version+1 or new.command_id=old.command_id))then
  raise exception 'erp_stock_lot_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_lot before insert or update or delete on erp_stock.lot for each row execute function erp_stock.guard_lot();
create function erp_stock.guard_lot_entry()returns trigger language plpgsql set search_path=pg_catalog as $$
declare v_line numeric;v_split numeric;begin
 if tg_op<>'INSERT' then raise exception 'erp_stock_immutable_ledger' using errcode='40001';end if;
 select e.quantity into v_line from erp_stock.entry e where e.movement_id=new.movement_id and e.product_id=new.product_id and e.warehouse_id=new.warehouse_id;
 select coalesce(sum(x.quantity),0)+new.quantity into v_split from erp_stock.lot_entry x where x.movement_id=new.movement_id and x.product_id=new.product_id and x.warehouse_id=new.warehouse_id;
 if v_line is null or sign(v_line)<>sign(new.quantity) or abs(v_split)>abs(v_line)
  or not exists(select 1 from erp_stock.lot l where l.id=new.lot_id and l.product_id=new.product_id)then
  raise exception 'erp_stock_lot_entry_invalid' using errcode='22023';end if;
 return new;
end$$;
create trigger guard_stock_lot_entry before insert or update or delete on erp_stock.lot_entry for each row execute function erp_stock.guard_lot_entry();
do $$declare t text;begin foreach t in array array['lot_command','lot','lot_balance','lot_entry']loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

-- One UUID identifies one effect across every stock command family, now including the lot commands.
create or replace function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
  or exists(select 1 from erp_stock.warehouse_command where id=p_id)or exists(select 1 from erp_stock.ledger_command where id=p_id)
  or exists(select 1 from erp_stock.count_command where id=p_id)or exists(select 1 from erp_stock.dashboard_command where id=p_id)
  or exists(select 1 from erp_stock.checkin_command where id=p_id)or exists(select 1 from erp_stock.supply_command where id=p_id)
  or exists(select 1 from erp_stock.composition_command where id=p_id)or exists(select 1 from erp_stock.lot_command where id=p_id)
$$;

-- 2. Helpers.
-- Preferências > Cadastros > Controle de lotes (115, page cadastros-lotes).
create function erp_stock.lot_settings()returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('require_expiry',coalesce(erp_preferences.get('lotes.validade_obrigatoria')='true'::jsonb,false),
  'require_manufacture',coalesce(erp_preferences.get('lotes.fabricacao_obrigatoria')='true'::jsonb,false),
  'warning_days',case when jsonb_typeof(d)='number' and(d#>>'{}')~'^[0-9]{1,4}$' then(d#>>'{}')::integer else 0 end)
 from(select erp_preferences.get('lotes.dias_aviso_validade') d)x
$$;
-- Quantity of a lot: one warehouse, or the considered warehouses (a warehouse with "Desconsiderar saldo" stays out, as every total).
create function erp_stock.lot_quantity(p_lot uuid,p_warehouse uuid default null)returns numeric language sql stable set search_path=pg_catalog as $$
 select coalesce(sum(b.quantity),0)from erp_stock.lot_balance b where b.lot_id=p_lot and(b.warehouse_id=p_warehouse or(p_warehouse is null and not erp_stock.ignored_warehouse(b.warehouse_id)))
$$;
-- "Vencido" / "Próximo ao vencimento": an active lot with stock whose Data de validade is before today or within the warning days.
create function erp_stock.lot_expiry_state(p_active boolean,p_expires date,p_quantity numeric,p_today date,p_days integer)returns text language sql immutable set search_path=pg_catalog as $$
 select case when not p_active or p_expires is null or p_quantity<=0 then null when p_expires<p_today then 'expired' when p_expires<=p_today+p_days then 'expiring' end
$$;
create function erp_stock.lot_dto(p_lot uuid,p_warehouse uuid default null)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',l.id,'product_id',l.product_id,'code',l.code,'manufactured_on',l.manufactured_on,'expires_on',l.expires_on,'note',l.note,'active',l.active,
  'version',l.version,'created_on',(l.created_at at time zone 'America/Sao_Paulo')::date,'quantity',q.qty::numeric(18,6)::text,
  'expiry_state',erp_stock.lot_expiry_state(l.active,l.expires_on,q.qty,(clock_timestamp() at time zone 'America/Sao_Paulo')::date,(erp_stock.lot_settings()->>'warning_days')::integer))
 from erp_stock.lot l cross join lateral(select erp_stock.lot_quantity(l.id,p_warehouse) qty)q where l.id=p_lot
$$;
-- A product that controls lots: Tipo Produto, formato Simples, "Controle de lote" on (191).
create function erp_stock.lot_product_problem(p_product uuid)returns text language sql stable set search_path=pg_catalog as $$
 select case when p.record_id is null then 'not_found' when p.kind is distinct from 'P' then 'not_product' when p.format is distinct from 'S' then 'not_simple'
  when not coalesce(d.lot_control,false) then 'lot_control_off' end
 from(select p_product id)x left join erp_catalog.product p on p.record_id=x.id left join erp_catalog.product_detail d on d.record_id=x.id
$$;
-- Lot fields of a save or of a "Novo lote": code, dates (fabricação <= validade) and the required dates of the Preferências.
create function erp_stock.lot_check(p_code text,p_manufactured date,p_expires date,p_note text)returns void language plpgsql stable set search_path=pg_catalog as $$
declare s jsonb:=erp_stock.lot_settings();begin
 if p_code is null or length(btrim(p_code)) not between 1 and 60 or p_code~'[[:cntrl:]]' or length(p_note)>500 or p_note~'[[:cntrl:]]'
  or p_manufactured not between date '1900-01-01' and date '2100-12-31' or p_expires not between date '1900-01-01' and date '2100-12-31' or p_manufactured>p_expires then
  raise exception 'erp_stock_lot_invalid' using errcode='22023';end if;
 if(s->>'require_expiry')::boolean and p_expires is null then raise exception 'erp_stock_lot_expiry_required' using errcode='22023';end if;
 if(s->>'require_manufacture')::boolean and p_manufactured is null then raise exception 'erp_stock_lot_manufacture_required' using errcode='22023';end if;
end$$;
-- Posts one lot line of a ledger movement: the lot balance of the warehouse, never below zero, and the lot entry.
create function erp_stock.lot_apply(p_movement uuid,p_product uuid,p_warehouse uuid,p_lot uuid,p_quantity numeric)returns jsonb language plpgsql set search_path=pg_catalog as $$
declare b erp_stock.lot_balance;begin
 insert into erp_stock.lot_balance(lot_id,warehouse_id)values(p_lot,p_warehouse)on conflict do nothing;
 select * into b from erp_stock.lot_balance where lot_id=p_lot and warehouse_id=p_warehouse for update;
 if b.quantity+p_quantity<0 then raise exception 'erp_stock_lot_insufficient' using errcode='22023';end if;
 if b.quantity+p_quantity>999999999999.999999 or b.version=2147483647 then raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 update erp_stock.lot_balance set quantity=quantity+p_quantity,version=version+1,updated_at=clock_timestamp() where lot_id=p_lot and warehouse_id=p_warehouse;
 insert into erp_stock.lot_entry(movement_id,product_id,warehouse_id,lot_id,quantity,balance_after)values(p_movement,p_product,p_warehouse,p_lot,p_quantity,b.quantity+p_quantity);
 return jsonb_build_object('warehouse_id',p_warehouse,'quantity',p_quantity::numeric(18,6)::text,'balance_after',(b.quantity+p_quantity)::numeric(18,6)::text);
end$$;
-- The reversal of a lançamento (any path: extrato, documento, composição) gives back its lot lines, line by line of the ledger.
create function erp_stock.reverse_lot_entries()returns trigger language plpgsql set search_path=pg_catalog as $$
declare v_origin uuid;l record;begin
 select m.reverses_id into v_origin from erp_stock.movement m where m.id=new.movement_id and m.kind='reversal';
 if v_origin is null then return null;end if;
 for l in select x.lot_id,x.quantity from erp_stock.lot_entry x where x.movement_id=v_origin and x.product_id=new.product_id and x.warehouse_id=new.warehouse_id order by x.lot_id loop
  perform erp_stock.lot_apply(new.movement_id,new.product_id,new.warehouse_id,l.lot_id,-l.quantity);
 end loop;
 return null;
end$$;
create trigger reverse_stock_lot_entries after insert on erp_stock.entry for each row execute function erp_stock.reverse_lot_entries();
-- Lots with stock (considered warehouses) of active products whose Data de validade falls in the window (for the "Lote próximo ao
-- vencimento" notification of the Central de Notificações, a function of the preferências lane).
create function erp_stock.lots_expiring(p_from date,p_until date)returns table(product_id uuid,lot_id uuid,code text,expires_on date,quantity numeric)language sql stable set search_path=pg_catalog as $$
 select l.product_id,l.id,l.code,l.expires_on,q.qty from erp_stock.lot l join erp_catalog.record r on r.id=l.product_id
  cross join lateral(select erp_stock.lot_quantity(l.id) qty)q
 where l.active and r.active and l.expires_on is not null and l.expires_on<=p_until and(p_from is null or l.expires_on>=p_from) and q.qty>0
  and not exists(select 1 from erp_catalog.product_detail d where d.record_id=l.product_id and d.deleted_at is not null)
$$;

-- 3. Leitura: Estoque > Lançamentos de estoque > aba "Lotes e validades" (e a grade de lotes do produto). Quem lê estoque.
create function public.erp_stock_lots(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null,p_status text default 'all',p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_product jsonb;v_today date;s jsonb;v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_product_id is null or p_status is null or p_status not in('all','active','inactive') or p_offset is null or p_offset not between 0 and 100000
  or p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 select jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'unit',p.unit,'kind',p.kind,'format',p.format,'active',r.active,'lot_control',coalesce(d.lot_control,false))
  into v_product from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id left join erp_catalog.product_detail d on d.record_id=r.id where r.id=p_product_id;
 if v_product is null then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id)then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 v_today:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;s:=erp_stock.lot_settings();
 with lots as materialized(select l.*,erp_stock.lot_quantity(l.id,p_warehouse_id) qty from erp_stock.lot l
   where l.product_id=p_product_id and(p_status='all' or l.active=(p_status='active'))),
  page as materialized(select * from lots order by active desc,expires_on nulls last,lower(code),id limit p_limit offset p_offset),
  positions as(select coalesce(sum(b.quantity),0) qty from erp_stock.balance b where b.product_id=p_product_id
   and(b.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(b.warehouse_id)))),
  assigned as(select coalesce(sum(erp_stock.lot_quantity(l.id,p_warehouse_id)),0) qty from erp_stock.lot l where l.product_id=p_product_id)
 select jsonb_build_object('scope','stock_lots','data_mode','erp_native','product',v_product,'warehouse_id',p_warehouse_id,'status',p_status,
  'offset',p_offset,'limit',p_limit,'total',(select count(*)from lots)::integer,'today',v_today,'settings',s,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'code',x.code,'manufactured_on',x.manufactured_on,'expires_on',x.expires_on,'note',x.note,'active',x.active,
    'version',x.version,'created_on',(x.created_at at time zone 'America/Sao_Paulo')::date,'quantity',x.qty::numeric(18,6)::text,
    'expiry_state',erp_stock.lot_expiry_state(x.active,x.expires_on,x.qty,v_today,(s->>'warning_days')::integer))
   order by x.active desc,x.expires_on nulls last,lower(x.code),x.id)from page x),'[]'::jsonb),
  'stock',(select qty from positions)::numeric(18,6)::text,'assigned',(select qty from assigned)::numeric(18,6)::text,
  'unassigned',((select qty from positions)-(select qty from assigned))::numeric(18,6)::text) into v_result;
 return v_result;
end$$;

-- "Detalhes de lotes": the lot, its balance per warehouse and its lançamentos (newest first, Data | Entrada | Saída | Origem).
create function public.erp_stock_lot_get(p_user_id uuid,p_lot_id uuid,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare l erp_stock.lot;v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_lot_id is null or p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 select * into l from erp_stock.lot where id=p_lot_id;
 if l.id is null then raise exception 'erp_stock_lot_not_found' using errcode='P0002';end if;
 with moves as materialized(select x.movement_id,x.warehouse_id,x.quantity,x.balance_after,m.kind,m.occurred_on,m.created_at,m.reason from erp_stock.lot_entry x
   join erp_stock.movement m on m.id=x.movement_id where x.lot_id=l.id),
  page as materialized(select * from moves order by occurred_on desc,created_at desc,movement_id desc,warehouse_id limit p_limit)
 select jsonb_build_object('scope','stock_lot','data_mode','erp_native','lot',erp_stock.lot_dto(l.id),'settings',erp_stock.lot_settings(),
  'product',(select jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'unit',p.unit,'lot_control',coalesce(d.lot_control,false))
   from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id left join erp_catalog.product_detail d on d.record_id=r.id where r.id=l.product_id),
  'warehouses',coalesce((select jsonb_agg(jsonb_build_object('warehouse_id',b.warehouse_id,'name',r.name,'active',r.active,'ignored',erp_stock.ignored_warehouse(b.warehouse_id),
    'quantity',b.quantity::numeric(18,6)::text,'version',b.version) order by erp_catalog.fold(r.name),b.warehouse_id)
   from erp_stock.lot_balance b join erp_catalog.record r on r.id=b.warehouse_id where b.lot_id=l.id),'[]'::jsonb),
  'movements',jsonb_build_object('total',(select count(*)from moves)::integer,'limit',p_limit,
   'items',coalesce((select jsonb_agg(jsonb_build_object('movement_id',x.movement_id,'warehouse_id',x.warehouse_id,'quantity',x.quantity::numeric(18,6)::text,
     'balance_after',x.balance_after::numeric(18,6)::text,'kind',x.kind,'occurred_on',x.occurred_on,'created_at',x.created_at,
     'recorded_at_local',to_char(x.created_at at time zone 'America/Sao_Paulo','YYYY-MM-DD"T"HH24:MI:SS'),'reason',x.reason,'origin',erp_stock.ledger_origin(x.movement_id))
    order by x.occurred_on desc,x.created_at desc,x.movement_id desc,x.warehouse_id)from page x),'[]'::jsonb))) into v_result;
 return v_result;
end$$;

-- 4. Gravação do lote ("+ Adicionar lote" da grade do produto e o Salvar dos "Detalhes de lotes"). Grava quem lança estoque.
-- p_lot_id null cria (versão esperada 0); senão edita fabricação, validade e Obs. (o código não muda).
create function public.erp_stock_lot_save(p_user_id uuid,p_command_id uuid,p_product_id uuid,p_lot_id uuid,p_expected_version integer,p_code text,
  p_manufactured_on date default null,p_expires_on date default null,p_note text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.lot_command;l erp_stock.lot;v_id uuid;v_note text;v_problem text;v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_product_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646
  or(p_lot_id is null)<>(p_expected_version=0)then raise exception 'erp_stock_lot_invalid' using errcode='22023';end if;
 v_note:=nullif(btrim(p_note),'');
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-lot-save-258','actor',p_user_id,'product_id',p_product_id,'lot_id',p_lot_id,'expected_version',p_expected_version,
  'code',p_code,'manufactured_on',p_manufactured_on,'expires_on',p_expires_on,'note',p_note)::text,'UTF8')),'hex');
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
 -- A new lot needs "Controle de lote" on; the lots that already exist stay editable after the switch is turned off.
 if v_problem is not null and p_lot_id is null then raise exception 'erp_stock_lot_control_off' using errcode='22023',detail=v_problem;end if;
 perform erp_stock.lot_check(p_code,p_manufactured_on,p_expires_on,v_note);
 if p_lot_id is null then
  if exists(select 1 from erp_stock.lot where product_id=p_product_id and lower(code)=lower(btrim(p_code)))then raise exception 'erp_stock_lot_code_taken' using errcode='22023';end if;
  insert into erp_stock.lot(product_id,code,manufactured_on,expires_on,note,version,created_by,updated_by,command_id)
   values(p_product_id,btrim(p_code),p_manufactured_on,p_expires_on,v_note,1,p_user_id,p_user_id,p_command_id) returning id into v_id;
 else
  select * into l from erp_stock.lot where id=p_lot_id and product_id=p_product_id for update;
  if l.id is null then raise exception 'erp_stock_lot_not_found' using errcode='P0002';end if;
  if l.version<>p_expected_version then raise exception 'erp_stock_lot_version_conflict' using errcode='40001';end if;
  if l.code<>btrim(p_code)then raise exception 'erp_stock_lot_code_immutable' using errcode='22023';end if;
  if l.manufactured_on is not distinct from p_manufactured_on and l.expires_on is not distinct from p_expires_on and l.note is not distinct from v_note then
   raise exception 'erp_stock_lot_unchanged' using errcode='22023';end if;
  update erp_stock.lot set manufactured_on=p_manufactured_on,expires_on=p_expires_on,note=v_note,version=version+1,updated_at=clock_timestamp(),updated_by=p_user_id,command_id=p_command_id
   where id=l.id;
  v_id:=l.id;
 end if;
 v_result:=jsonb_build_object('scope','stock_lot_save','data_mode','erp_native','created',p_lot_id is null,'lot',erp_stock.lot_dto(v_id),'settings',erp_stock.lot_settings());
 insert into erp_stock.lot_command(id,actor,action,product_id,lot_id,request_hash,result)values(p_command_id,p_user_id,'save',p_product_id,v_id,h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

-- "Excluir lote": o lote sem saldo em nenhum depósito fica inativo (o histórico fica); "Reativar lote" volta a aceitar lançamentos.
create function public.erp_stock_lot_status(p_user_id uuid,p_command_id uuid,p_lot_id uuid,p_expected_version integer,p_active boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.lot_command;l erp_stock.lot;v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_lot_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483646 or p_active is null then
  raise exception 'erp_stock_lot_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-lot-status-258','actor',p_user_id,'lot_id',p_lot_id,'expected_version',p_expected_version,'active',p_active)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into c from erp_stock.lot_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'status' or c.request_hash<>h then raise exception 'erp_stock_lot_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_lot_conflict' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 select * into l from erp_stock.lot where id=p_lot_id;
 if l.id is null then raise exception 'erp_stock_lot_not_found' using errcode='P0002';end if;
 perform 1 from erp_catalog.record where id=l.product_id for update;
 select * into l from erp_stock.lot where id=p_lot_id for update;
 if l.version<>p_expected_version then raise exception 'erp_stock_lot_version_conflict' using errcode='40001';end if;
 if l.active=p_active then raise exception 'erp_stock_lot_unchanged' using errcode='22023';end if;
 if not p_active and exists(select 1 from erp_stock.lot_balance b where b.lot_id=l.id and b.quantity<>0)then raise exception 'erp_stock_lot_has_stock' using errcode='22023';end if;
 update erp_stock.lot set active=p_active,version=version+1,updated_at=clock_timestamp(),updated_by=p_user_id,command_id=p_command_id where id=l.id;
 v_result:=jsonb_build_object('scope','stock_lot_status','data_mode','erp_native','lot',erp_stock.lot_dto(l.id));
 insert into erp_stock.lot_command(id,actor,action,product_id,lot_id,request_hash,result)values(p_command_id,p_user_id,'status',l.product_id,l.id,h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

-- 5. Novo Lançamento e Transferência entre depósitos com Lote. p_lot: {"lot_id": uuid} (lote existente) ou, na Entrada e no Balanço,
-- {"code": "...", "manufactured_on": "aaaa-mm-dd"|null, "expires_on": "aaaa-mm-dd"|null} ("Novo lote", gravado no mesmo comando).
-- No Balanço a quantidade é o novo saldo do lote no depósito; o saldo do depósito muda pela mesma diferença (o Balanço do 105 grava a
-- contagem da posição: anterior e novo saldo do depósito).
create function public.erp_stock_lot_launch(p_user_id uuid,p_command_id uuid,p_kind text,p_product_id uuid,p_warehouse_id uuid,p_quantity text,p_expected_version integer,
  p_unit_price text,p_unit_cost text,p_note text,p_destination_id uuid,p_destination_version integer,p_lot jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.lot_command;l erp_stock.lot;v_new boolean:=false;v_problem text;v_current numeric;v_counted numeric;v_delta numeric;b erp_stock.balance;
  v_target text;v_launch jsonb;v_movement uuid;v_entries jsonb:='[]'::jsonb;v_result jsonb;v_code text;v_made date;v_expires date;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_kind is null or p_kind not in('receipt','issue','balance','transfer') or p_product_id is null or p_warehouse_id is null
  -- A lot is never negative: the Balanço of a lot is its new quantity (zero or more), the other kinds move a positive quantity.
  or p_quantity is null or p_quantity!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or(p_kind<>'balance' and p_quantity::numeric=0) or p_expected_version is null or p_expected_version not between 0 and 2147483646
  or p_lot is null or jsonb_typeof(p_lot)<>'object' or exists(select 1 from jsonb_object_keys(p_lot)k where k not in('lot_id','code','manufactured_on','expires_on'))
  or(p_lot ? 'lot_id')=(p_lot ? 'code')
  or(p_lot ? 'lot_id' and(jsonb_typeof(p_lot->'lot_id')<>'string' or p_lot->>'lot_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or p_lot ?| array['manufactured_on','expires_on']))
  or(p_lot ? 'code' and(p_kind not in('receipt','balance') or jsonb_typeof(p_lot->'code')<>'string'
   or exists(select 1 from jsonb_each(p_lot-'code')x where jsonb_typeof(x.value)<>'null' and(jsonb_typeof(x.value)<>'string' or x.value#>>'{}'!~'^\d{4}-\d{2}-\d{2}$'))))then
  raise exception 'erp_stock_lot_launch_invalid' using errcode='22023';end if;
 if p_lot ? 'code' then
  begin v_made:=(p_lot->>'manufactured_on')::date;v_expires:=(p_lot->>'expires_on')::date;
  exception when others then raise exception 'erp_stock_lot_launch_invalid' using errcode='22023';end;
  v_code:=p_lot->>'code';
 end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-lot-launch-258','actor',p_user_id,'kind',p_kind,'product_id',p_product_id,'warehouse_id',p_warehouse_id,
  'quantity',p_quantity,'expected_version',p_expected_version,'unit_price',p_unit_price,'unit_cost',p_unit_cost,'note',p_note,'destination_id',p_destination_id,
  'destination_version',p_destination_version,'lot',p_lot)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into c from erp_stock.lot_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'launch' or c.request_hash<>h then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 -- The product and the warehouses in UUID order (the catalog lock order of every stock writer), then the lot.
 perform 1 from erp_catalog.record where id in(p_product_id,p_warehouse_id,p_destination_id) order by id for update;
 v_problem:=erp_stock.lot_product_problem(p_product_id);
 if v_problem='not_found' then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 if v_problem is not null then raise exception 'erp_stock_lot_control_off' using errcode='22023',detail=v_problem;end if;
 if p_lot ? 'lot_id' then
  select * into l from erp_stock.lot where id=(p_lot->>'lot_id')::uuid for update;
  if l.id is null or l.product_id<>p_product_id then raise exception 'erp_stock_lot_not_found' using errcode='P0002';end if;
  if not l.active then raise exception 'erp_stock_lot_inactive' using errcode='22023';end if;
 else
  perform erp_stock.lot_check(v_code,v_made,v_expires,null);
  if exists(select 1 from erp_stock.lot where product_id=p_product_id and lower(code)=lower(btrim(v_code)))then raise exception 'erp_stock_lot_code_taken' using errcode='22023';end if;
  insert into erp_stock.lot(product_id,code,manufactured_on,expires_on,version,created_by,updated_by,command_id)
   values(p_product_id,btrim(v_code),v_made,v_expires,1,p_user_id,p_user_id,p_command_id) returning * into l;
  v_new:=true;
 end if;
 v_current:=coalesce((select quantity from erp_stock.lot_balance where lot_id=l.id and warehouse_id=p_warehouse_id),0);
 if p_kind='balance' then
  v_counted:=p_quantity::numeric;v_delta:=v_counted-v_current;
  if v_delta=0 then raise exception 'erp_stock_balance_unchanged' using errcode='22023';end if;
  select * into b from erp_stock.balance where product_id=p_product_id and warehouse_id=p_warehouse_id;
  if coalesce(b.version,0)<>p_expected_version then raise exception 'erp_stock_version_conflict' using errcode='40001';end if;
  if abs(coalesce(b.quantity,0)+v_delta)>999999999999.999999 then raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
  v_target:=(coalesce(b.quantity,0)+v_delta)::numeric(18,6)::text;
 else
  if p_kind in('issue','transfer') and v_current<p_quantity::numeric then raise exception 'erp_stock_lot_insufficient' using errcode='22023';end if;
  v_target:=p_quantity;
 end if;
 v_launch:=public.erp_stock_launch(p_user_id,p_command_id,p_kind,p_product_id,p_warehouse_id,v_target,p_expected_version,p_unit_price,p_unit_cost,p_note,p_destination_id,p_destination_version);
 if coalesce((v_launch->>'replayed')::boolean,true)then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
 v_movement:=(v_launch#>>'{movement,id}')::uuid;
 v_entries:=jsonb_build_array(erp_stock.lot_apply(v_movement,p_product_id,p_warehouse_id,l.id,case p_kind when 'receipt' then p_quantity::numeric when 'balance' then v_delta else -p_quantity::numeric end));
 if p_kind='transfer' then v_entries:=v_entries||jsonb_build_array(erp_stock.lot_apply(v_movement,p_product_id,p_destination_id,l.id,p_quantity::numeric));end if;
 v_result:=(v_launch-'replayed')||jsonb_build_object('lot',jsonb_build_object('id',l.id,'code',l.code,'manufactured_on',l.manufactured_on,'expires_on',l.expires_on,'created',v_new,
  'entries',v_entries,'balance',case when p_kind='balance' then jsonb_build_object('counted',v_counted::numeric(18,6)::text,'previous',v_current::numeric(18,6)::text)end));
 insert into erp_stock.lot_command(id,actor,action,product_id,lot_id,request_hash,result)values(p_command_id,p_user_id,'launch',p_product_id,l.id,h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

-- 6. Transferência dos produtos selecionados (183) com o Lote de cada produto. A grade traz, para o produto com controle de lote,
-- os lotes ativos com saldo no depósito de origem. O resto é o publicado (sem lote, o pedido e o comprovante são os mesmos).
create or replace function public.erp_stock_transfer_positions(p_user_id uuid,p_source_id uuid,p_destination_id uuid,p_product_ids jsonb)
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
    'suggested_price',erp_stock.price_text(s.unit_price),'suggested_cost',erp_stock.price_text(s.unit_cost),
    -- 258: Lote of the row (optional): the active lots with stock in the source warehouse, first to expire first.
    'lot_control',erp_stock.lot_product_problem(r.id) is null,
    'lots',case when erp_stock.lot_product_problem(r.id) is null then coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'code',x.code,'expires_on',x.expires_on,'quantity',x.quantity::numeric(18,6)::text)
      order by x.expires_on nulls last,lower(x.code),x.id) from(select l.id,l.code,l.expires_on,lb.quantity from erp_stock.lot l join erp_stock.lot_balance lb on lb.lot_id=l.id and lb.warehouse_id=p_source_id
      where l.product_id=r.id and l.active and lb.quantity>0 order by l.expires_on nulls last,lower(l.code),l.id limit 50)x),'[]'::jsonb) else '[]'::jsonb end) order by erp_catalog.fold(r.name),r.id)
   from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id left join erp_stock.balance b on b.product_id=r.id and b.warehouse_id=p_source_id
   left join erp_stock.balance d on d.product_id=r.id and d.warehouse_id=p_destination_id left join suggestion s on s.product_id=r.id where r.id=any(v_ids))) into v_result;
 return v_result;
end$$;

create or replace function public.erp_stock_transfer_batch(p_user_id uuid,p_command_id uuid,p_source_id uuid,p_destination_id uuid,p_note text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.supply_command;line jsonb;v_launch jsonb;v_lines jsonb:='[]'::jsonb;v_result jsonb;v_day date;v_note text;l erp_stock.lot;v_movement uuid;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_source_id is null or p_destination_id is null or p_source_id=p_destination_id or length(p_note)>500 or p_note~'[[:cntrl:]]'
  or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 50 or octet_length(p_items::text)>32768
  or exists(select 1 from jsonb_array_elements(p_items)j where jsonb_typeof(j)<>'object'
   or exists(select 1 from jsonb_object_keys(j)k where k not in('product_id','quantity','source_version','destination_version','unit_price','unit_cost','lot_id'))
   or jsonb_typeof(j->'product_id') is distinct from 'string' or coalesce(j->>'product_id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or jsonb_typeof(j->'quantity') is distinct from 'string' or coalesce(j->>'quantity','')!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or(j->>'quantity')::numeric=0
   or jsonb_typeof(j->'source_version') is distinct from 'number' or coalesce(j->>'source_version','')!~'^[0-9]{1,10}$' or(j->>'source_version')::bigint>2147483646
   or jsonb_typeof(j->'destination_version') is distinct from 'number' or coalesce(j->>'destination_version','')!~'^[0-9]{1,10}$' or(j->>'destination_version')::bigint>2147483646
   or(j ? 'unit_price' and jsonb_typeof(j->'unit_price') not in('string','null'))or(j ? 'unit_cost' and jsonb_typeof(j->'unit_cost') not in('string','null'))
   -- 258: Lote of the row.
   or(j ? 'lot_id' and(jsonb_typeof(j->'lot_id')<>'string' or j->>'lot_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
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
  l:=null;
  if line ? 'lot_id' then
   perform 1 from erp_catalog.record where id=(line->>'product_id')::uuid for update;
   if erp_stock.lot_product_problem((line->>'product_id')::uuid) is not null then raise exception 'erp_stock_lot_control_off' using errcode='22023';end if;
   select * into l from erp_stock.lot where id=(line->>'lot_id')::uuid for update;
   if l.id is null or l.product_id<>(line->>'product_id')::uuid then raise exception 'erp_stock_lot_not_found' using errcode='P0002';end if;
   if not l.active then raise exception 'erp_stock_lot_inactive' using errcode='22023';end if;
   if coalesce((select quantity from erp_stock.lot_balance where lot_id=l.id and warehouse_id=p_source_id),0)<(line->>'quantity')::numeric then
    raise exception 'erp_stock_lot_insufficient' using errcode='22023';end if;
  end if;
  v_launch:=public.erp_stock_launch(p_user_id,erp_stock.supply_part(p_command_id,'transfer:'||(line->>'product_id')),'transfer',(line->>'product_id')::uuid,p_source_id,line->>'quantity',
   (line->>'source_version')::integer,line->>'unit_price',line->>'unit_cost',p_note,p_destination_id,(line->>'destination_version')::integer);
  v_day:=(v_launch->>'occurred_on')::date;v_note:=v_launch#>>'{detail,note}';v_movement:=(v_launch#>>'{movement,id}')::uuid;
  if l.id is not null then
   perform erp_stock.lot_apply(v_movement,l.product_id,p_source_id,l.id,-(line->>'quantity')::numeric);
   perform erp_stock.lot_apply(v_movement,l.product_id,p_destination_id,l.id,(line->>'quantity')::numeric);
  end if;
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',line->>'product_id','name',(select name from erp_catalog.record where id=(line->>'product_id')::uuid),
   'code',(select code from erp_catalog.record where id=(line->>'product_id')::uuid),'unit',(select unit from erp_catalog.product where record_id=(line->>'product_id')::uuid),
   'quantity',(line->>'quantity')::numeric(18,6)::text,'movement_id',v_launch#>'{movement,id}',
   'source_balance_after',(select e->'balance_after' from jsonb_array_elements(v_launch#>'{movement,items}')e where e->>'warehouse_id'=p_source_id::text),
   'destination_balance_after',(select e->'balance_after' from jsonb_array_elements(v_launch#>'{movement,items}')e where e->>'warehouse_id'=p_destination_id::text),
   'unit_price',v_launch#>'{detail,unit_price}','unit_cost',v_launch#>'{detail,unit_cost}')
   ||case when l.id is not null then jsonb_build_object('lot_id',l.id,'lot_code',l.code)else '{}'::jsonb end);
 end loop;
 v_result:=jsonb_build_object('scope','stock_transfer_batch','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'source',(select jsonb_build_object('id',id,'name',name)from erp_catalog.record where id=p_source_id),
  'destination',(select jsonb_build_object('id',id,'name',name)from erp_catalog.record where id=p_destination_id),
  'note',v_note,'occurred_on',v_day,'items',v_lines,'saved_at',clock_timestamp()));
 insert into erp_stock.supply_command(id,actor,action,request_hash,result)values(p_command_id,p_user_id,'transfer_batch',h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_lots','erp_stock_lot_get','erp_stock_lot_save','erp_stock_lot_status','erp_stock_lot_launch','erp_stock_transfer_positions','erp_stock_transfer_batch')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
