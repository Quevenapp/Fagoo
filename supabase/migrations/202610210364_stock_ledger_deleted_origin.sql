-- 364 (leva H, lane espelho, EST-072): Tipo de Origem "Origem excluída" no extrato de estoque, ao lado de Notas Fiscais (259),
-- Vendas, Compras, Serviços, Transferências e Sem origem.
-- Um lançamento cuja nota ou cujo documento de origem foi excluído (exclusão lógica: deleted_at da nota fiscal, ou do documento
-- quando a exclusão lógica de documentos existir) continua no extrato e no saldo, com a identificação histórica da origem
-- (tipo do documento, número e id); só o Tipo de Origem passa a ser "deleted". Nenhum movimento é criado, alterado ou retirado:
-- os saldos, o custo médio, os lotes e o "Preço da última compra" continuam lendo erp_stock.ledger_origin, que não muda.
-- Requires 105 and 259 (the ledger of today is hash-checked before it is replaced).
begin;

do $$declare r record;begin
 for r in select * from(values
  ('erp_stock.ledger_row_105(uuid,uuid,text)','57bb29b515c5f227b02f9dcf877f80bf6b2ee654700cbfa52f79c698ebf6a139'),
  ('public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer,text)','b39e1b227aaa8b838b40f3e1c1489fbe481b5d0b98bace391d64fbda1ab4af7f'),
  ('erp_stock.ledger_origin(uuid)','eb3c524c7501acad7df675e89d57148d686a104bcb7a43350fc74b4967e6340b'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_ledger_364_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- The origin document (or note) of a lançamento no longer exists for the screens: a note with deleted_at, or a document whose row
-- carries a deleted_at (read through to_jsonb, so the check keeps working when documents gain the logical deletion).
create function erp_stock.ledger_origin_deleted(p_origin jsonb) returns boolean language sql stable set search_path=pg_catalog as $$
 select case when p_origin->>'document_id' is null then false
  when p_origin->>'type'='invoices' then exists(select 1 from erp_fiscal_invoices.invoice v where v.id=(p_origin->>'document_id')::uuid and v.deleted_at is not null)
  when p_origin->>'type' in('sales','purchases','services') then exists(select 1 from erp_documents.document d where d.id=(p_origin->>'document_id')::uuid and to_jsonb(d)->>'deleted_at' is not null)
  else false end
$$;
-- The Tipo de Origem of the extrato filter: the type of ledger_origin, or 'deleted' when its document was deleted.
create function erp_stock.ledger_origin_type(p_movement_id uuid) returns text language sql stable set search_path=pg_catalog as $$
 select case when erp_stock.ledger_origin_deleted(o) then 'deleted' else o->>'type' end from(select erp_stock.ledger_origin(p_movement_id) o) x
$$;

create or replace function erp_stock.ledger_row_105(p_movement_id uuid,p_product_id uuid,p_role text)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d erp_stock.movement_detail;c erp_stock.balance_count;price numeric;cost numeric;source text;v_row jsonb;v_kind text;v_hidden boolean;begin
 v_row:=erp_stock.ledger_row(p_movement_id,p_product_id);v_kind:=v_row#>>'{origin,document_kind}';
 -- 364: Origem excluída keeps the document of the lançamento (kind, number, id) and only changes the type.
 if erp_stock.ledger_origin_deleted(v_row->'origin') then v_row:=jsonb_set(v_row,'{origin,type}','"deleted"'); end if;
 -- 259: the price of a note is data of the note, read by administrador and fiscal (113).
 v_hidden:=v_kind is not null and case when v_kind in('nfe_saida','nfe_entrada','nfce') then p_role is distinct from 'admin' and p_role is distinct from 'fiscal'
  else not erp_documents.allowed(p_role,v_kind,false) end;
 select * into d from erp_stock.movement_detail where movement_id=p_movement_id and product_id=p_product_id order by revision desc limit 1;
 if d.movement_id is not null then source:='detail';if not v_hidden then price:=d.unit_price;cost:=d.unit_cost;end if;
 elsif not v_hidden then price:=erp_stock.ledger_document_price(p_movement_id,p_product_id);source:=case when price is not null then 'document' end;end if;
 select * into c from erp_stock.balance_count where movement_id=p_movement_id and product_id=p_product_id;
 return v_row||jsonb_build_object('revision',coalesce(d.revision,0),'note',d.note,
  'unit_price',erp_stock.price_text(price),'unit_cost',erp_stock.price_text(cost),'price_source',source,
  'balance',case when c.movement_id is not null then jsonb_build_object('counted',c.counted::text,'previous',c.previous::text,'warehouse_id',c.warehouse_id,'source',c.source)end);
end$$;
create or replace function public.erp_stock_ledger(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null,p_kind text default null,
  p_origin text default null,p_date_from date default null,p_date_to date default null,p_limit integer default 100,p_offset integer default 0,p_direction text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_unit text;v_role text;v_result jsonb;
begin
  perform erp_stock.require_access(p_user_id,false);
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if p_product_id is null or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
    or (p_kind is not null and p_kind not in('receipt','issue','adjustment','transfer','reversal'))
    or (p_origin is not null and p_origin not in('sales','purchases','services','transfers','none','invoices','deleted'))
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
    select m.id,m.occurred_on,m.created_at,case when p_origin is null then null else erp_stock.ledger_origin_type(m.id) end origin,
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

revoke all on function erp_stock.ledger_origin_deleted(jsonb),erp_stock.ledger_origin_type(uuid),erp_stock.ledger_row_105(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer,text) from public,anon,authenticated;
grant execute on function public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer,text) to service_role;
commit;
