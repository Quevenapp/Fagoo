-- 106: Conferência de estoque no padrão do Origin (Estoque > Conferência de estoque).
-- Requer 105. Uma conferência aberta por usuário, salva no servidor a cada leitura; "Gerar balanço" grava, numa única
-- transação sob o mutex do estoque, um Balanço (ajuste009 + erp_stock.balance_count) por produto alterado e fecha a conferência.
-- Leituras nunca são apagadas: excluir e reiniciar só marcam, com ator, hora e comando.
-- Ordem de locks: comando 174852918 -> conferência 174852920 -> mutex 174852909 -> catálogo por UUID -> produto -> saldo -> acesso.
begin;

do $$declare r record;begin
 for r in select * from(values
  ('erp_stock.command_taken(uuid)','deea36c6c9d865f364ee2ee733e26ad6c775bcf3a8d957364c64cd3797dcf518'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_count_106_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

create table erp_stock.count_session(
 id uuid primary key default gen_random_uuid(),actor uuid not null references auth.users(id),
 warehouse_id uuid references erp_catalog.warehouse(record_id),
 state text not null default 'open' check(state in('open','restarted','closed')),
 version integer not null default 1 check(version between 1 and 2147483647),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 closed_at timestamptz,close_command_id uuid unique,balance_scope text check(balance_scope in('counted','all_active')),
 check((state='open' and closed_at is null and close_command_id is null and balance_scope is null)
  or(state='restarted' and closed_at is not null and close_command_id is not null and balance_scope is null)
  or(state='closed' and closed_at is not null and close_command_id is not null and balance_scope is not null and warehouse_id is not null))
);
create unique index erp_stock_one_open_count on erp_stock.count_session(actor) where state='open';
create table erp_stock.count_reading(
 id uuid primary key default gen_random_uuid(),session_id uuid not null references erp_stock.count_session(id),
 product_id uuid not null references erp_catalog.product(record_id),
 quantity numeric(18,6) not null check(quantity>0 and quantity<=999999999999.999999),
 code text not null check(length(code) between 1 and 100 and code!~'[[:cntrl:]]'),
 actor uuid not null references auth.users(id),command_id uuid not null unique,created_at timestamptz not null default clock_timestamp(),
 deleted_at timestamptz,deleted_by uuid references auth.users(id),delete_command_id uuid,
 check((deleted_at is null)=(deleted_by is null) and (deleted_at is null)=(delete_command_id is null))
);
create index erp_stock_count_reading_session on erp_stock.count_reading(session_id,product_id) where deleted_at is null;
create table erp_stock.count_command(
 id uuid primary key,actor uuid not null references auth.users(id),
 action text not null check(action in('read','delete','warehouse','restart','balance')),session_id uuid not null references erp_stock.count_session(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),result jsonb not null check(jsonb_typeof(result)='object'),
 created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_stock_count_command before update or delete on erp_stock.count_command for each row execute function erp_stock.immutable_ledger();
-- A reading changes only once, to deleted; a session only moves forward (warehouse and version while open, then closed).
create function erp_stock.guard_count_reading()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or old.deleted_at is not null or new.deleted_at is null
  or(to_jsonb(new)-array['deleted_at','deleted_by','delete_command_id'])is distinct from(to_jsonb(old)-array['deleted_at','deleted_by','delete_command_id'])then
  raise exception 'erp_stock_count_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_count_reading before update or delete on erp_stock.count_reading for each row execute function erp_stock.guard_count_reading();
create function erp_stock.guard_count_session()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or old.state<>'open' or new.id<>old.id or new.actor<>old.actor or new.created_at<>old.created_at or new.version<>old.version+1
  or(new.state='open' and(new.closed_at is not null))then
  raise exception 'erp_stock_count_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_count_session before update or delete on erp_stock.count_session for each row execute function erp_stock.guard_count_session();
do $$declare t text;begin foreach t in array array['count_session','count_reading','count_command']loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

create or replace function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
  or exists(select 1 from erp_stock.warehouse_command where id=p_id)or exists(select 1 from erp_stock.ledger_command where id=p_id)
  or exists(select 1 from erp_stock.count_command where id=p_id)
$$;

-- Estoque físico atual of a counted product: the selected warehouse, or the considered warehouses (105) for "Todos".
create function erp_stock.count_physical(p_product uuid,p_warehouse uuid)returns numeric language sql stable set search_path=pg_catalog as $$
 select coalesce(sum(b.quantity),0)from erp_stock.balance b
 where b.product_id=p_product and(b.warehouse_id=p_warehouse or(p_warehouse is null and not erp_stock.ignored_warehouse(b.warehouse_id)))
$$;
create function erp_stock.count_dto(p_session uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 with s as(select * from erp_stock.count_session where id=p_session),
 live as(select r.* from erp_stock.count_reading r where r.session_id=p_session and r.deleted_at is null),
 items as(select l.product_id,sum(l.quantity) counted,max(l.created_at) last_at from live l group by l.product_id),
 -- The page keeps the 1500 most recently read products (bounded response); the balanço always uses every reading.
 shown as(select * from items order by last_at desc,product_id limit 1500)
 select jsonb_build_object('session',jsonb_build_object('id',s.id,'state',s.state,'version',s.version,'warehouse_id',s.warehouse_id,
   'warehouse_name',(select name from erp_catalog.record where id=s.warehouse_id),'created_at',s.created_at,'balance_scope',s.balance_scope,'closed_at',s.closed_at),
  'total_read',(select coalesce(sum(quantity),0)from live)::numeric(38,6)::text,'readings',(select count(*)from live)::integer,'items_total',(select count(*)from items)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',i.product_id,'code',r.code,'name',r.name,'location',p.location,'unit',p.unit,
    'counted',i.counted::numeric(38,6)::text,'physical',erp_stock.count_physical(i.product_id,s.warehouse_id)::numeric(38,6)::text,
    'difference',(i.counted-erp_stock.count_physical(i.product_id,s.warehouse_id))::numeric(38,6)::text) order by i.last_at desc,i.product_id)
   from shown i join erp_catalog.record r on r.id=i.product_id join erp_catalog.product p on p.record_id=i.product_id),'[]'::jsonb),
  'log',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'code',x.code,'quantity',x.quantity::text,'product_id',x.product_id,'product_name',r.name,
    'recorded_at_local',to_char(x.created_at at time zone 'America/Sao_Paulo','YYYY-MM-DD"T"HH24:MI:SS'),'deleted',x.deleted_at is not null) order by x.created_at desc,x.id)
   from(select * from erp_stock.count_reading where session_id=p_session order by created_at desc,id limit 200)x join erp_catalog.record r on r.id=x.product_id),'[]'::jsonb))
 from s
$$;
create function erp_stock.count_hash(p_profile text,p_actor uuid,p_data jsonb)returns text language sql immutable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(jsonb_build_object('profile',p_profile,'actor',p_actor,'data',p_data)::text,'UTF8')),'hex')
$$;
-- Replay or conflict of one count command; nothing is written when the UUID was already used elsewhere.
create function erp_stock.count_replay(p_actor uuid,p_command uuid,p_action text,p_hash text)returns jsonb language plpgsql set search_path=pg_catalog as $$
declare c erp_stock.count_command;begin
 perform pg_advisory_xact_lock(174852918,hashtext(p_command::text));perform erp_stock.require_access(p_actor,true);
 select * into c from erp_stock.count_command where id=p_command;
 if found then
  if c.actor<>p_actor or c.action<>p_action or c.request_hash<>p_hash then raise exception 'erp_stock_count_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command)or exists(select 1 from erp_stock.count_reading where command_id=p_command or delete_command_id=p_command)then
  raise exception 'erp_stock_count_conflict' using errcode='40001';end if;
 return null;
end$$;
-- The actor's open session (locked), created on demand by a reading.
create function erp_stock.count_open(p_actor uuid,p_session uuid,p_create boolean,p_warehouse uuid default null)returns erp_stock.count_session language plpgsql set search_path=pg_catalog as $$
declare s erp_stock.count_session;begin
 select * into s from erp_stock.count_session where actor=p_actor and state='open';
 if found then
  perform pg_advisory_xact_lock(174852920,hashtext(s.id::text));
  select * into s from erp_stock.count_session where id=s.id;
  if s.state<>'open' or(p_session is not null and s.id<>p_session)then raise exception 'erp_stock_count_session_changed' using errcode='40001';end if;
  return s;
 end if;
 if p_session is not null then raise exception 'erp_stock_count_session_changed' using errcode='40001';end if;
 if not p_create then raise exception 'erp_stock_count_not_found' using errcode='P0002';end if;
 if p_warehouse is not null and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=p_warehouse and r.active)then
  raise exception 'erp_stock_warehouse_unavailable' using errcode='22023';end if;
 insert into erp_stock.count_session(actor,warehouse_id)values(p_actor,p_warehouse) returning * into s;
 perform pg_advisory_xact_lock(174852920,hashtext(s.id::text));
 return s;
end$$;

create function public.erp_stock_count_get(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s uuid;begin
 perform erp_stock.require_access(p_user_id,true);
 select id into s from erp_stock.count_session where actor=p_user_id and state='open';
 return jsonb_build_object('scope','stock_count','data_mode','erp_native','count',case when s is null then null else erp_stock.count_dto(s) end);
end$$;

-- Leitura: GTIN, GTIN tributário ou código (SKU) exatos; "Quantidade a ser lida" multiplica a leitura. Recusas do Origin
-- ("Produto Inexistente.", tipo e formato inválidos, "Quantidade inválida!") são respostas, sem nada gravado.
create function public.erp_stock_count_read(p_user_id uuid,p_command_id uuid,p_session_id uuid,p_code text,p_quantity text,p_warehouse_id uuid default null)
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
   rejected:=case when v_kind is distinct from 'P' then 'invalid_kind' when v_format is distinct from 'S' then 'invalid_format' when not v_active then 'inactive' end;
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

-- "Excluir leitura" of a product: all its live readings are marked deleted.
create function public.erp_stock_count_delete(p_user_id uuid,p_command_id uuid,p_session_id uuid,p_product_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;s erp_stock.count_session;n integer;result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_session_id is null or p_product_id is null then raise exception 'erp_stock_count_invalid' using errcode='22023';end if;
 h:=erp_stock.count_hash('stock-count-delete-106',p_user_id,jsonb_build_object('session_id',p_session_id,'product_id',p_product_id));
 replay:=erp_stock.count_replay(p_user_id,p_command_id,'delete',h);if replay is not null then return replay;end if;
 s:=erp_stock.count_open(p_user_id,p_session_id,false);
 update erp_stock.count_reading set deleted_at=clock_timestamp(),deleted_by=p_user_id,delete_command_id=p_command_id
  where session_id=s.id and product_id=p_product_id and deleted_at is null;
 get diagnostics n=row_count;
 if n=0 then raise exception 'erp_stock_count_reading_not_found' using errcode='P0002';end if;
 result:=jsonb_build_object('scope','stock_count','data_mode','erp_native','outcome','deleted','product_id',p_product_id,'deleted_readings',n,'session_id',s.id);
 insert into erp_stock.count_command(id,actor,action,session_id,request_hash,result)values(p_command_id,p_user_id,'delete',s.id,h,result);
 perform erp_stock.reservation_write_access(p_user_id);
 return result||jsonb_build_object('count',erp_stock.count_dto(s.id),'replayed',false);
end$$;

-- Depósito da conferência ("Todos" ou um depósito ativo); trocar recalcula o estoque físico dos itens lidos.
create function public.erp_stock_count_warehouse(p_user_id uuid,p_command_id uuid,p_session_id uuid,p_expected_version integer,p_warehouse_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;s erp_stock.count_session;result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_session_id is null or p_expected_version is null then raise exception 'erp_stock_count_invalid' using errcode='22023';end if;
 h:=erp_stock.count_hash('stock-count-warehouse-106',p_user_id,jsonb_build_object('session_id',p_session_id,'expected_version',p_expected_version,'warehouse_id',p_warehouse_id));
 replay:=erp_stock.count_replay(p_user_id,p_command_id,'warehouse',h);if replay is not null then return replay;end if;
 s:=erp_stock.count_open(p_user_id,p_session_id,false);
 if s.version<>p_expected_version or s.version=2147483647 then raise exception 'erp_stock_count_version_conflict' using errcode='40001';end if;
 if s.warehouse_id is not distinct from p_warehouse_id then raise exception 'erp_stock_count_unchanged' using errcode='22023';end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=p_warehouse_id and r.active)then
  raise exception 'erp_stock_warehouse_unavailable' using errcode='22023';end if;
 update erp_stock.count_session set warehouse_id=p_warehouse_id,version=version+1,updated_at=clock_timestamp() where id=s.id;
 result:=jsonb_build_object('scope','stock_count','data_mode','erp_native','outcome','warehouse','session_id',s.id,
  'from',jsonb_build_object('warehouse_id',s.warehouse_id,'version',s.version),'to',jsonb_build_object('warehouse_id',p_warehouse_id,'version',s.version+1));
 insert into erp_stock.count_command(id,actor,action,session_id,request_hash,result)values(p_command_id,p_user_id,'warehouse',s.id,h,result);
 perform erp_stock.reservation_write_access(p_user_id);
 return result||jsonb_build_object('count',erp_stock.count_dto(s.id),'replayed',false);
end$$;

-- "Reiniciar": the session is kept as restarted (history) and a new empty one starts in the same warehouse.
create function public.erp_stock_count_restart(p_user_id uuid,p_command_id uuid,p_session_id uuid,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;s erp_stock.count_session;fresh uuid;result jsonb;at timestamptz;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_session_id is null or p_expected_version is null then raise exception 'erp_stock_count_invalid' using errcode='22023';end if;
 h:=erp_stock.count_hash('stock-count-restart-106',p_user_id,jsonb_build_object('session_id',p_session_id,'expected_version',p_expected_version));
 replay:=erp_stock.count_replay(p_user_id,p_command_id,'restart',h);if replay is not null then return replay;end if;
 s:=erp_stock.count_open(p_user_id,p_session_id,false);
 if s.version<>p_expected_version or s.version=2147483647 then raise exception 'erp_stock_count_version_conflict' using errcode='40001';end if;
 at:=clock_timestamp();
 -- The command row exists before the session references it as its close command.
 result:=jsonb_build_object('scope','stock_count','data_mode','erp_native','outcome','restarted','session_id',s.id,
  'discarded_readings',(select count(*)from erp_stock.count_reading where session_id=s.id and deleted_at is null)::integer);
 insert into erp_stock.count_command(id,actor,action,session_id,request_hash,result)values(p_command_id,p_user_id,'restart',s.id,h,result);
 update erp_stock.count_session set state='restarted',version=version+1,updated_at=at,closed_at=at,close_command_id=p_command_id where id=s.id;
 insert into erp_stock.count_session(actor,warehouse_id)values(p_user_id,case when exists(select 1 from erp_catalog.record where id=s.warehouse_id and active)then s.warehouse_id end)returning id into fresh;
 perform erp_stock.reservation_write_access(p_user_id);
 return result||jsonb_build_object('count',erp_stock.count_dto(fresh),'replayed',false);
end$$;

-- "Gerar balanço para": Apenas produtos conferidos | Todos os produtos ativos cadastrados (os não conferidos ficam zerados).
-- Exige um único depósito e ao menos uma leitura; "Todos" exige a confirmação "Estou ciente…". Um Balanço por produto
-- alterado, com o comando derivado deste; posições iguais à contagem não geram movimento; reserva ativa maior que a
-- contagem é ignorada com o motivo (a reserva nunca fica descoberta). Tudo ou nada, na mesma transação.
create function public.erp_stock_count_balance(p_user_id uuid,p_command_id uuid,p_session_id uuid,p_expected_version integer,p_scope text,p_confirmed boolean)
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
  if not row.active or row.kind is distinct from 'P' or row.unit is null or row.format in('E','V')then
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
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_count_get','erp_stock_count_read','erp_stock_count_delete','erp_stock_count_warehouse','erp_stock_count_restart','erp_stock_count_balance')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
