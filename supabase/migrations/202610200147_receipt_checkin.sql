-- 147: Check-in de Recebimentos (Origin /receipt-checkin): conferência física, item a item, das notas fiscais de entrada nativas
-- (112). Requer 105/107/112. A nota não é alterada: o check-in guarda a cópia dos itens da versão conferida da nota, as quantidades
-- recebidas, as pendências (faltando, danificado, incorreto ou recusado) e o histórico de ações, com comando idempotente (command_id),
-- versão esperada (CAS) e auditoria imutável (um comando por mudança aceita, mais o histórico por item).
-- Finalizar registra o check-in e não lança estoque, contas, crédito nem devolução: no Brufap a nota de entrada ainda não lança
-- estoque, e "Gerar crédito para o fornecedor" e "Gerar nota de devolução" não existem; a única ação é "Não aplicar nenhuma ação".
-- Quem lê: administrador, estoque e fiscal; quem confere: administrador e estoque. A consulta fica de fora, como nas notas nativas
-- do Brufap (112/113), que só administrador e fiscal veem; o estoque vê as notas de entrada só aqui, para conferir o recebimento.
-- Ordem de locks: comando 174852918 -> check-in da nota 174852922 -> nota (FOR SHARE) -> check-in -> itens -> acesso.
begin;

do $$declare r record;begin
 if to_regclass('erp_fiscal_invoices.invoice')is null or to_regclass('erp_fiscal_invoices.invoice_order')is null then
  raise exception 'receipt_checkin_147_requires_112' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.command_taken(uuid)','a37facdf437de94fc1d7155919765380c3aa5855074a251e1d225dfea4c1c147'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'receipt_checkin_147_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- One row per accepted command: the receipt returned again by "Conferir resultado" (same UUID and body) and the audit trail.
create table erp_stock.checkin_command(
 id uuid primary key,actor uuid not null references auth.users(id),
 action text not null check(action in('save','issue','batch','restart','finish')),
 invoice_id uuid not null references erp_fiscal_invoices.invoice(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
-- One check-in per note. invoice_version is the version of the note whose items were copied; a later edit of the note makes the
-- check-in stale until "Reiniciar" copies the items again.
create table erp_stock.checkin(
 id uuid primary key default gen_random_uuid(),
 invoice_id uuid not null unique references erp_fiscal_invoices.invoice(id),
 invoice_version integer not null check(invoice_version>0),
 state text not null check(state in('in_progress','finished')),
 version integer not null check(version between 1 and 2147483647),
 started_by uuid not null references auth.users(id),started_at timestamptz not null,
 updated_by uuid not null references auth.users(id),updated_at timestamptz not null,
 finished_by uuid references auth.users(id),finished_at timestamptz,
 check((state='finished')=(finished_by is not null and finished_at is not null))
);
create table erp_stock.checkin_item(
 checkin_id uuid not null references erp_stock.checkin(id),position integer not null check(position between 1 and 990),
 product_id uuid references erp_catalog.record(id),description text not null,supplier_code text,gtin text,unit text,
 quantity numeric not null check(quantity>0 and quantity<100000000000 and quantity=trunc(quantity,4)),
 unit_price numeric not null check(unit_price>=0 and unit_price<100000000000 and unit_price=trunc(unit_price,10)),
 received numeric not null check(received>=0 and received<100000000000 and received=trunc(received,4)),
 issue text check(issue in('missing','damaged','incorrect','refused')),
 issue_quantity numeric check(issue_quantity is null or(issue_quantity>0 and issue_quantity<100000000000 and issue_quantity=trunc(issue_quantity,4))),
 issue_action text check(issue_action='none'),
 primary key(checkin_id,position),
 check((issue is null)=(issue_action is null)),check((issue in('missing','damaged','incorrect'))=(issue_quantity is not null)),
 check(issue_quantity is null or issue_quantity<=quantity)
);
-- Histórico de ações: immutable, one row per changed item (or per restart/finish).
create table erp_stock.checkin_event(
 id bigint generated always as identity primary key,checkin_id uuid not null references erp_stock.checkin(id),
 command_id uuid not null references erp_stock.checkin_command(id),actor uuid not null references auth.users(id),
 action text not null check(action in('received','batch','missing','damaged','incorrect','refused','restart','finish')),
 position integer,description text,quantity numeric,previous numeric,created_at timestamptz not null default clock_timestamp()
);
create index erp_stock_checkin_event_order on erp_stock.checkin_event(checkin_id,id);
create trigger immutable_stock_checkin_command before update or delete on erp_stock.checkin_command for each row execute function erp_stock.immutable_ledger();
create trigger immutable_stock_checkin_event before update or delete on erp_stock.checkin_event for each row execute function erp_stock.immutable_ledger();
-- The check-in moves forward one version at a time and is frozen once finished; it is never deleted.
create function erp_stock.guard_checkin()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or(tg_op='INSERT' and(new.version<>1 or new.state<>'in_progress'))or(tg_op='UPDATE' and(new.id<>old.id or new.invoice_id<>old.invoice_id
   or new.version<>old.version+1 or old.state='finished' or new.started_by<>old.started_by or new.started_at<>old.started_at))then
  raise exception 'erp_stock_checkin_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_checkin before insert or update or delete on erp_stock.checkin for each row execute function erp_stock.guard_checkin();
-- Copied note data never changes (Reiniciar deletes and copies again); a refused item is final; a finished check-in is frozen.
create function erp_stock.guard_checkin_item()returns trigger language plpgsql set search_path=pg_catalog as $$
declare v_state text;begin
 select state into v_state from erp_stock.checkin where id=case when tg_op='DELETE' then old.checkin_id else new.checkin_id end;
 if v_state is distinct from 'in_progress'
  or(tg_op='UPDATE' and((to_jsonb(new)-array['received','issue','issue_quantity','issue_action'])is distinct from(to_jsonb(old)-array['received','issue','issue_quantity','issue_action'])
   or(old.issue='refused' and(new.issue is distinct from old.issue or new.received<>old.received))))then
  raise exception 'erp_stock_checkin_immutable' using errcode='40001';end if;
 if tg_op='DELETE' then return old;end if;return new;
end$$;
create trigger guard_stock_checkin_item before insert or update or delete on erp_stock.checkin_item for each row execute function erp_stock.guard_checkin_item();
do $$declare t text;begin foreach t in array array['checkin_command','checkin','checkin_item','checkin_event']loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on all sequences in schema erp_stock from public,anon,authenticated,service_role;

-- One UUID identifies one effect across every stock command family, now including the check-in.
create or replace function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
  or exists(select 1 from erp_stock.warehouse_command where id=p_id)or exists(select 1 from erp_stock.ledger_command where id=p_id)
  or exists(select 1 from erp_stock.count_command where id=p_id)or exists(select 1 from erp_stock.dashboard_command where id=p_id)
  or exists(select 1 from erp_stock.checkin_command where id=p_id)
$$;

create function erp_stock.checkin_access(p_actor uuid,p_write boolean,p_lock boolean default false)returns text language plpgsql set search_path=pg_catalog as $$
declare v_role text;begin
 if p_lock then perform 1 from auth.users where id=p_actor for key share;perform 1 from erp_access.membership where user_id=p_actor for share;end if;
 select role into v_role from erp_access.membership where user_id=p_actor and active;
 if v_role is null or(p_write and v_role not in('admin','estoque'))or(not p_write and v_role not in('admin','estoque','fiscal'))then
  raise exception 'erp_stock_checkin_access_denied' using errcode='42501';end if;
 return v_role;
end$$;
-- Notes that can be checked in: native entry notes (112), not deleted, not cancelled (3) and not denied (10).
create function erp_stock.checkin_note_open(p_direction text,p_deleted timestamptz,p_status smallint)returns boolean language sql immutable set search_path=pg_catalog as $$
 select p_direction='0' and p_deleted is null and p_status not in(3,10)
$$;
-- "Solicitado" and "Preço diferente" come from the purchase orders linked to the note (112 invoice_order); null without a link.
create function erp_stock.checkin_requested(p_invoice uuid,p_product uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select case when p_product is null or not exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_documents.document d on d.id=o.document_id
   where o.invoice_id=p_invoice and d.kind='purchase_orders')then null
  else(select jsonb_build_object('quantity',coalesce(sum(i.quantity),0)::numeric(38,4)::text,
    'prices',coalesce(jsonb_agg(distinct i.unit_price::numeric(24,10)::text),'[]'::jsonb))
   from erp_fiscal_invoices.invoice_order o join erp_documents.document d on d.id=o.document_id and d.kind='purchase_orders'
   join erp_documents.item i on i.document_id=d.id and i.product_id=p_product where o.invoice_id=p_invoice)end
$$;
create function erp_stock.checkin_item_state(p_received numeric,p_quantity numeric,p_issue text)returns text language sql immutable set search_path=pg_catalog as $$
 select case when p_issue is not null then 'issue' when p_received=0 then 'pending' when p_received<p_quantity then 'in_progress' else 'complete' end
$$;
-- Items: the check-in copy when it exists, otherwise the current items of the note (nothing received yet).
create function erp_stock.checkin_items(p_invoice uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 with c as(select id from erp_stock.checkin where invoice_id=p_invoice),
 rows as(
  select i.position,i.product_id,i.description,i.supplier_code,i.gtin,i.unit,i.quantity,i.unit_price,i.received,i.issue,i.issue_quantity,i.issue_action
  from erp_stock.checkin_item i join c on c.id=i.checkin_id
  union all
  select i.position,i.product_id,coalesce(i.data->>'description',''),i.data->>'code',i.data->>'gtin',i.data->>'unit',i.quantity,i.unit_price,0,null,null,null
  from erp_fiscal_invoices.invoice_item i where i.invoice_id=p_invoice and not exists(select 1 from c))
 select coalesce(jsonb_agg(jsonb_build_object('position',r.position,'product_id',r.product_id,'product_code',p.code,'product_gtin',x.gtin,'description',r.description,
   'supplier_code',r.supplier_code,'gtin',r.gtin,'unit',r.unit,'quantity',r.quantity::numeric(24,4)::text,'unit_price',r.unit_price::numeric(24,10)::text,
   'received',r.received::numeric(24,4)::text,'issue',r.issue,'issue_quantity',r.issue_quantity::numeric(24,4)::text,'issue_action',r.issue_action,
   'state',erp_stock.checkin_item_state(r.received,r.quantity,r.issue),'requested',erp_stock.checkin_requested(p_invoice,r.product_id)) order by r.position),'[]'::jsonb)
 from rows r left join erp_catalog.record p on p.id=r.product_id left join erp_catalog.product x on x.record_id=r.product_id
$$;
create function erp_stock.checkin_note_dto(p_invoice uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('invoice_id',v.id,'invoice_version',v.version,'model',v.model,'issue_type',v.issue_type,'status',v.status,'series',v.series,'number',v.number,
  'access_key',v.access_key,'supplier',jsonb_build_object('name',v.recipient->>'name','document',v.recipient->>'document','person_type',v.recipient->>'person_type'),
  'issue_date',v.issue_date,'created_at',v.created_at,'items_count',(select count(*)from erp_fiscal_invoices.invoice_item i where i.invoice_id=v.id)::integer,
  'checkin_state',coalesce((select c.state from erp_stock.checkin c where c.invoice_id=v.id),'pending'),'open',erp_stock.checkin_note_open(v.direction,v.deleted_at,v.status))
 from erp_fiscal_invoices.invoice v where v.id=p_invoice
$$;
create function erp_stock.checkin_dto(p_invoice uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 with c as(select * from erp_stock.checkin where invoice_id=p_invoice),items as(select erp_stock.checkin_items(p_invoice) j)
 select jsonb_build_object('note',erp_stock.checkin_note_dto(p_invoice),
  'checkin',(select jsonb_build_object('id',c.id,'state',c.state,'version',c.version,'invoice_version',c.invoice_version,
    'stale',c.invoice_version<>(select version from erp_fiscal_invoices.invoice where id=p_invoice),'started_at',c.started_at,'updated_at',c.updated_at,'finished_at',c.finished_at)from c),
  'version',coalesce((select version from c),0),'items',(select j from items),
  'summary',(select jsonb_build_object('total',count(x)::integer,'complete',count(x)filter(where x->>'state'='complete')::integer,
    'issue',count(x)filter(where x->>'state'='issue' and x->>'issue'<>'refused')::integer,'refused',count(x)filter(where x->>'issue'='refused')::integer,
    'pending',count(x)filter(where x->>'state' in('pending','in_progress'))::integer)from items left join lateral jsonb_array_elements(items.j)x on true),
  'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'position',e.position,'description',e.description,'quantity',e.quantity::numeric(24,4)::text,
    'previous',e.previous::numeric(24,4)::text,'at',e.created_at) order by e.id)from(select * from erp_stock.checkin_event where checkin_id=(select id from c) order by id desc limit 500)e),'[]'::jsonb))
$$;

-- Coluna "Notas": notas de entrada, mais recentes primeiro; busca "Chave de acesso ou Número da nota".
create function public.erp_stock_checkin_notes(p_user_id uuid,p_query text default null,p_offset integer default 0,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare q text;v_role text;v_result jsonb;begin
 v_role:=erp_stock.checkin_access(p_user_id,false);
 if p_offset is null or p_offset not between 0 and 100000 or p_limit is null or p_limit not between 1 and 100 or length(p_query)>60 or p_query~'[[:cntrl:]]' then
  raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 q:=nullif(regexp_replace(coalesce(p_query,''),'[^0-9]','','g'),'');
 if nullif(btrim(p_query),'')is not null and(q is null or not(length(q)=44 or length(q)<=9))then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 with rows as materialized(select v.id,v.created_at from erp_fiscal_invoices.invoice v where erp_stock.checkin_note_open(v.direction,v.deleted_at,v.status)
   and(q is null or(length(q)=44 and v.access_key=q)or(length(q)<=9 and v.number=q::integer))),
  page as materialized(select * from rows order by created_at desc,id desc limit p_limit offset p_offset)
 select jsonb_build_object('scope','stock_checkin_notes','data_mode','erp_native','query',p_query,'offset',p_offset,'limit',p_limit,'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(erp_stock.checkin_note_dto(p.id) order by p.created_at desc,p.id desc)from page p),'[]'::jsonb),
  'can_manage',v_role in('admin','estoque')) into v_result;
 return v_result;
end$$;
create function public.erp_stock_checkin_get(p_user_id uuid,p_invoice_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v erp_fiscal_invoices.invoice;begin
 v_role:=erp_stock.checkin_access(p_user_id,false);
 if p_invoice_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 select * into v from erp_fiscal_invoices.invoice where id=p_invoice_id;
 -- A deleted or cancelled note keeps showing its check-in (read-only); it never starts a new one.
 if not found or v.direction<>'0' or(not erp_stock.checkin_note_open(v.direction,v.deleted_at,v.status) and not exists(select 1 from erp_stock.checkin where invoice_id=v.id))then
  raise exception 'erp_stock_checkin_note_not_found' using errcode='P0002';end if;
 return erp_stock.checkin_dto(v.id)||jsonb_build_object('scope','stock_checkin','data_mode','erp_native','can_manage',v_role in('admin','estoque'));
end$$;

-- Every write: command lock and replay, the note's check-in lock, the note read FOR SHARE, the CAS and the state checks.
create function erp_stock.checkin_begin(p_actor uuid,p_command uuid,p_action text,p_invoice uuid,p_expected integer,p_hash text,
  out replay jsonb,out note_version integer,out checkin_id uuid,out checkin_version integer,out copied_version integer)
language plpgsql set search_path=pg_catalog as $$
declare k erp_stock.checkin_command;v erp_fiscal_invoices.invoice;c erp_stock.checkin;begin
 perform pg_advisory_xact_lock(174852918,hashtext(p_command::text));perform erp_stock.checkin_access(p_actor,true);
 select * into k from erp_stock.checkin_command where id=p_command;
 if found then
  if k.actor<>p_actor or k.action<>p_action or k.invoice_id<>p_invoice or k.request_hash<>p_hash then raise exception 'erp_stock_checkin_command_conflict' using errcode='40001';end if;
  replay:=k.result||erp_stock.checkin_dto(k.invoice_id)||jsonb_build_object('replayed',true);return;
 end if;
 if erp_stock.command_taken(p_command)then raise exception 'erp_stock_checkin_command_conflict' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852922,hashtext(p_invoice::text));perform erp_stock.checkin_access(p_actor,true);
 select * into v from erp_fiscal_invoices.invoice where id=p_invoice for share;
 if not found or v.direction<>'0' then raise exception 'erp_stock_checkin_note_not_found' using errcode='P0002';end if;
 select * into c from erp_stock.checkin where invoice_id=p_invoice for update;
 if coalesce(c.version,0)<>p_expected or coalesce(c.version,0)=2147483647 then raise exception 'erp_stock_checkin_version_conflict' using errcode='40001';end if;
 if c.state='finished' then raise exception 'erp_stock_checkin_finished' using errcode='40001';end if;
 if not erp_stock.checkin_note_open(v.direction,v.deleted_at,v.status)then raise exception 'erp_stock_checkin_note_closed' using errcode='40001';end if;
 if p_action<>'restart' and c.id is not null and c.invoice_version<>v.version then raise exception 'erp_stock_checkin_note_changed' using errcode='40001';end if;
 if c.id is null and not exists(select 1 from erp_fiscal_invoices.invoice_item where invoice_id=p_invoice)then raise exception 'erp_stock_checkin_note_empty' using errcode='22023';end if;
 note_version:=v.version;checkin_id:=c.id;checkin_version:=coalesce(c.version,0);copied_version:=c.invoice_version;
end$$;
-- Records the receipt (before any change, so the command row is the first effect), creates or advances the check-in and copies
-- the note items when the check-in starts or restarts.
create function erp_stock.checkin_advance(p_actor uuid,p_command uuid,p_action text,p_invoice uuid,p_hash text,p_note_version integer,p_checkin uuid,p_from integer,p_copy boolean,p_detail jsonb)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare at timestamptz:=clock_timestamp();v_id uuid:=p_checkin;begin
 insert into erp_stock.checkin_command(id,actor,action,invoice_id,request_hash,result)values(p_command,p_actor,p_action,p_invoice,p_hash,
  jsonb_build_object('scope','stock_checkin','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command,'action',p_action,'invoice_id',p_invoice,
   'from_version',p_from,'to_version',p_from+case when p_action='finish' then 2 else 1 end,'detail',p_detail,'saved_at',at)));
 if v_id is null then
  insert into erp_stock.checkin(invoice_id,invoice_version,state,version,started_by,started_at,updated_by,updated_at)values(p_invoice,p_note_version,'in_progress',1,p_actor,at,p_actor,at)returning id into v_id;
 else
  update erp_stock.checkin set version=version+1,invoice_version=case when p_copy then p_note_version else invoice_version end,updated_by=p_actor,updated_at=at where id=v_id;
 end if;
 if p_checkin is null or p_copy then
  delete from erp_stock.checkin_item where checkin_id=v_id;
  insert into erp_stock.checkin_item(checkin_id,position,product_id,description,supplier_code,gtin,unit,quantity,unit_price,received)
   select v_id,i.position,i.product_id,coalesce(i.data->>'description',''),i.data->>'code',i.data->>'gtin',i.data->>'unit',i.quantity,i.unit_price,0
   from erp_fiscal_invoices.invoice_item i where i.invoice_id=p_invoice;
 end if;
 return v_id;
end$$;
create function erp_stock.checkin_result(p_actor uuid,p_command uuid,p_invoice uuid)returns jsonb language plpgsql set search_path=pg_catalog as $$begin
 perform erp_stock.checkin_access(p_actor,true,true);
 return(select result from erp_stock.checkin_command where id=p_command)||erp_stock.checkin_dto(p_invoice)||jsonb_build_object('replayed',false);
end$$;
-- Current item of the note (copy or not yet copied) for the changes computed before the command row is written.
create function erp_stock.checkin_current(p_checkin uuid,p_invoice uuid,p_position integer)returns table(received numeric,quantity numeric,issue text,description text)
language sql stable set search_path=pg_catalog as $$
 select i.received,i.quantity,i.issue,i.description from erp_stock.checkin_item i where p_checkin is not null and i.checkin_id=p_checkin and i.position=p_position
 union all select 0,i.quantity,null,coalesce(i.data->>'description','') from erp_fiscal_invoices.invoice_item i where p_checkin is null and i.invoice_id=p_invoice and i.position=p_position
$$;

-- Qtde Recebida ("Salvar alterações"): positions and their received quantity (up to 4 decimals). Unchanged positions are ignored.
create function public.erp_stock_checkin_save(p_user_id uuid,p_command_id uuid,p_invoice_id uuid,p_expected_version integer,p_items jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;b record;x jsonb;cur record;v numeric;changes jsonb:='[]';v_id uuid;begin
 perform erp_stock.checkin_access(p_user_id,true);
 if p_command_id is null or p_invoice_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or p_items is null or jsonb_typeof(p_items)<>'array'
  or jsonb_array_length(p_items) not between 1 and 990
  or exists(select 1 from jsonb_array_elements(p_items)e where jsonb_typeof(e)<>'object' or(select count(*)from jsonb_object_keys(e))<>2 or not(e?'position' and e?'received')
   or jsonb_typeof(e->'position')<>'number' or(e->>'position')!~'^[1-9][0-9]{0,2}$' or jsonb_typeof(e->'received')<>'string' or(e->>'received')!~'^(0|[1-9][0-9]{0,10})(\.[0-9]{1,4})?$')
  or(select count(distinct e->>'position')from jsonb_array_elements(p_items)e)<>jsonb_array_length(p_items)then
  raise exception 'erp_stock_checkin_input_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-checkin-save-147','actor',p_user_id,'invoice_id',p_invoice_id,'expected_version',p_expected_version,
  'items',(select jsonb_agg(jsonb_build_object('position',(e->>'position')::integer,'received',e->>'received') order by(e->>'position')::integer)from jsonb_array_elements(p_items)e))::text,'UTF8')),'hex');
 select * into b from erp_stock.checkin_begin(p_user_id,p_command_id,'save',p_invoice_id,p_expected_version,h);
 if b.replay is not null then return b.replay;end if;
 for x in select e from jsonb_array_elements(p_items)e order by(e->>'position')::integer loop
  select * into cur from erp_stock.checkin_current(b.checkin_id,p_invoice_id,(x->>'position')::integer);
  if not found then raise exception 'erp_stock_checkin_item_not_found' using errcode='P0002';end if;
  v:=(x->>'received')::numeric;
  if v<>cur.received then
   if cur.issue='refused' then raise exception 'erp_stock_checkin_item_refused' using errcode='22023';end if;
   changes:=changes||jsonb_build_array(jsonb_build_object('position',(x->>'position')::integer,'from',cur.received::numeric(24,4)::text,'to',v::numeric(24,4)::text,'description',cur.description));
  end if;
 end loop;
 if jsonb_array_length(changes)=0 then raise exception 'erp_stock_checkin_unchanged' using errcode='22023';end if;
 v_id:=erp_stock.checkin_advance(p_user_id,p_command_id,'save',p_invoice_id,h,b.note_version,b.checkin_id,b.checkin_version,false,jsonb_build_object('changes',changes));
 for x in select e from jsonb_array_elements(changes)e loop
  update erp_stock.checkin_item set received=(x->>'to')::numeric where checkin_id=v_id and position=(x->>'position')::integer;
  insert into erp_stock.checkin_event(checkin_id,command_id,actor,action,position,description,quantity,previous)
   values(v_id,p_command_id,p_user_id,'received',(x->>'position')::integer,x->>'description',(x->>'to')::numeric,(x->>'from')::numeric);
 end loop;
 return erp_stock.checkin_result(p_user_id,p_command_id,p_invoice_id);
end$$;
-- "Registrar pendência do produto": produto faltando, danificado ou incorreto (com quantidade) ou recusado; "Não aplicar nenhuma ação".
-- A refused item accepts no new pendência; a new pendência of another kind replaces the current one (the history keeps both).
create function public.erp_stock_checkin_issue(p_user_id uuid,p_command_id uuid,p_invoice_id uuid,p_expected_version integer,p_position integer,p_kind text,p_quantity text,p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;b record;cur record;q numeric;v_id uuid;begin
 perform erp_stock.checkin_access(p_user_id,true);
 if p_command_id is null or p_invoice_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or p_position is null or p_position not between 1 and 990
  or p_kind is null or p_kind not in('missing','damaged','incorrect','refused') or p_action is distinct from 'none'
  or(p_kind='refused')<>(p_quantity is null) or(p_quantity is not null and p_quantity!~'^(0|[1-9][0-9]{0,10})(\.[0-9]{1,4})?$')then
  raise exception 'erp_stock_checkin_input_invalid' using errcode='22023';end if;
 q:=p_quantity::numeric;
 if q=0 then raise exception 'erp_stock_checkin_input_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-checkin-issue-147','actor',p_user_id,'invoice_id',p_invoice_id,'expected_version',p_expected_version,
  'position',p_position,'kind',p_kind,'quantity',p_quantity,'action',p_action)::text,'UTF8')),'hex');
 select * into b from erp_stock.checkin_begin(p_user_id,p_command_id,'issue',p_invoice_id,p_expected_version,h);
 if b.replay is not null then return b.replay;end if;
 select * into cur from erp_stock.checkin_current(b.checkin_id,p_invoice_id,p_position);
 if not found then raise exception 'erp_stock_checkin_item_not_found' using errcode='P0002';end if;
 if cur.issue='refused' then raise exception 'erp_stock_checkin_item_refused' using errcode='22023';end if;
 if q>cur.quantity then raise exception 'erp_stock_checkin_issue_quantity_invalid' using errcode='22023';end if;
 v_id:=erp_stock.checkin_advance(p_user_id,p_command_id,'issue',p_invoice_id,h,b.note_version,b.checkin_id,b.checkin_version,false,
  jsonb_build_object('position',p_position,'kind',p_kind,'quantity',q::numeric(24,4)::text,'action',p_action,'previous',cur.issue));
 update erp_stock.checkin_item set issue=p_kind,issue_quantity=q,issue_action=p_action where checkin_id=v_id and position=p_position;
 insert into erp_stock.checkin_event(checkin_id,command_id,actor,action,position,description,quantity)values(v_id,p_command_id,p_user_id,p_kind,p_position,cur.description,q);
 return erp_stock.checkin_result(p_user_id,p_command_id,p_invoice_id);
end$$;
-- "Check-in em lote": the selected items are verified, with the quantity of the note received.
create function public.erp_stock_checkin_batch(p_user_id uuid,p_command_id uuid,p_invoice_id uuid,p_expected_version integer,p_positions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;b record;cur record;p integer;changes jsonb:='[]';v_id uuid;x jsonb;begin
 perform erp_stock.checkin_access(p_user_id,true);
 if p_command_id is null or p_invoice_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or p_positions is null or jsonb_typeof(p_positions)<>'array'
  or jsonb_array_length(p_positions) not between 1 and 990 or exists(select 1 from jsonb_array_elements(p_positions)e where jsonb_typeof(e)<>'number' or e::text!~'^[1-9][0-9]{0,2}$')
  or(select count(distinct e::text)from jsonb_array_elements(p_positions)e)<>jsonb_array_length(p_positions)then
  raise exception 'erp_stock_checkin_input_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-checkin-batch-147','actor',p_user_id,'invoice_id',p_invoice_id,'expected_version',p_expected_version,
  'positions',(select jsonb_agg(e::text::integer order by e::text::integer)from jsonb_array_elements(p_positions)e))::text,'UTF8')),'hex');
 select * into b from erp_stock.checkin_begin(p_user_id,p_command_id,'batch',p_invoice_id,p_expected_version,h);
 if b.replay is not null then return b.replay;end if;
 for p in select e::text::integer from jsonb_array_elements(p_positions)e order by 1 loop
  select * into cur from erp_stock.checkin_current(b.checkin_id,p_invoice_id,p);
  if not found then raise exception 'erp_stock_checkin_item_not_found' using errcode='P0002';end if;
  if cur.issue='refused' then raise exception 'erp_stock_checkin_item_refused' using errcode='22023';end if;
  changes:=changes||jsonb_build_array(jsonb_build_object('position',p,'from',cur.received::numeric(24,4)::text,'to',cur.quantity::numeric(24,4)::text,'description',cur.description));
 end loop;
 v_id:=erp_stock.checkin_advance(p_user_id,p_command_id,'batch',p_invoice_id,h,b.note_version,b.checkin_id,b.checkin_version,false,jsonb_build_object('changes',changes));
 for x in select e from jsonb_array_elements(changes)e loop
  update erp_stock.checkin_item set received=quantity where checkin_id=v_id and position=(x->>'position')::integer and received<>quantity;
  insert into erp_stock.checkin_event(checkin_id,command_id,actor,action,position,description,quantity,previous)
   values(v_id,p_command_id,p_user_id,'batch',(x->>'position')::integer,x->>'description',(x->>'to')::numeric,(x->>'from')::numeric);
 end loop;
 return erp_stock.checkin_result(p_user_id,p_command_id,p_invoice_id);
end$$;
-- "Reiniciar": every received quantity and pendência is cleared and the items are copied again from the current note.
create function public.erp_stock_checkin_restart(p_user_id uuid,p_command_id uuid,p_invoice_id uuid,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;b record;v_id uuid;begin
 perform erp_stock.checkin_access(p_user_id,true);
 if p_command_id is null or p_invoice_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483646 then
  raise exception 'erp_stock_checkin_input_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-checkin-restart-147','actor',p_user_id,'invoice_id',p_invoice_id,'expected_version',p_expected_version)::text,'UTF8')),'hex');
 select * into b from erp_stock.checkin_begin(p_user_id,p_command_id,'restart',p_invoice_id,p_expected_version,h);
 if b.replay is not null then return b.replay;end if;
 v_id:=erp_stock.checkin_advance(p_user_id,p_command_id,'restart',p_invoice_id,h,b.note_version,b.checkin_id,b.checkin_version,true,
  jsonb_build_object('from_invoice_version',b.copied_version,'to_invoice_version',b.note_version));
 insert into erp_stock.checkin_event(checkin_id,command_id,actor,action)values(v_id,p_command_id,p_user_id,'restart');
 return erp_stock.checkin_result(p_user_id,p_command_id,p_invoice_id);
end$$;
-- "Finalizar": "O check-in foi finalizado e registrado no sistema." Nothing is posted to stock, finance or the note.
create function public.erp_stock_checkin_finish(p_user_id uuid,p_command_id uuid,p_invoice_id uuid,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;b record;v_id uuid;begin
 perform erp_stock.checkin_access(p_user_id,true);
 if p_command_id is null or p_invoice_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483645 then
  raise exception 'erp_stock_checkin_input_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-checkin-finish-147','actor',p_user_id,'invoice_id',p_invoice_id,'expected_version',p_expected_version)::text,'UTF8')),'hex');
 select * into b from erp_stock.checkin_begin(p_user_id,p_command_id,'finish',p_invoice_id,p_expected_version,h);
 if b.replay is not null then return b.replay;end if;
 v_id:=erp_stock.checkin_advance(p_user_id,p_command_id,'finish',p_invoice_id,h,b.note_version,b.checkin_id,b.checkin_version,false,'{}'::jsonb);
 insert into erp_stock.checkin_event(checkin_id,command_id,actor,action)values(v_id,p_command_id,p_user_id,'finish');
 update erp_stock.checkin set state='finished',version=version+1,finished_by=p_user_id,finished_at=clock_timestamp(),updated_at=clock_timestamp(),updated_by=p_user_id where id=v_id;
 return erp_stock.checkin_result(p_user_id,p_command_id,p_invoice_id);
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_checkin_notes','erp_stock_checkin_get','erp_stock_checkin_save','erp_stock_checkin_issue','erp_stock_checkin_batch','erp_stock_checkin_restart','erp_stock_checkin_finish')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
