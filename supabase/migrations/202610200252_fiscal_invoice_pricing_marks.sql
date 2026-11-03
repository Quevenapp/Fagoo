-- 252: letra P vermelha "Preços atualizados" das Notas fiscais de entrada (Origin), onda E da frente de notas.
-- "Atualizar preços" da Formação de preços grava o preço de venda e o custo no cadastro de produtos (produtos, 155) com o comando
-- do cadastro. Depois de confirmado, a nota de entrada registra esse comando (erp_fiscal_invoice_pricing_record): o banco confere
-- que o comando existe, é do mesmo usuário, é uma atualização de preços do cadastro e só alterou produtos dos itens da nota. O
-- registro é idempotente pelo par nota + comando (repetir devolve o mesmo registro) e imutável (fica como histórico).
-- A lista lê as marcas da página (erp_fiscal_invoice_pricing_states, até 100 notas). Nada é emitido, lançado ou transmitido.
begin;

do $$begin
 if to_regprocedure('public.erp_catalog_product_prices_update(uuid,uuid,uuid,jsonb)') is null or to_regclass('erp_fiscal_invoices.invoice_item') is null then
  raise exception 'fiscal_pricing_252_requires_112_155' using errcode='55000'; end if;
end$$;

create table erp_fiscal_invoices.invoice_pricing(
 invoice_id uuid not null references erp_fiscal_invoices.invoice(id),
 catalog_command_id uuid not null,
 products integer not null check(products between 1 and 100),
 recorded_by uuid not null references auth.users(id),
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(invoice_id,catalog_command_id)
);
alter table erp_fiscal_invoices.invoice_pricing enable row level security;
revoke all on erp_fiscal_invoices.invoice_pricing from public,anon,authenticated,service_role;
create trigger immutable_invoice_pricing before update or delete on erp_fiscal_invoices.invoice_pricing for each row execute function erp_fiscal_invoices.immutable_history();

create function public.erp_fiscal_invoice_pricing_record(p_user_id uuid,p_invoice_id uuid,p_catalog_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice%rowtype;c erp_catalog.command%rowtype;r erp_fiscal_invoices.invoice_pricing%rowtype;v_products uuid[];v_replayed boolean:=true;
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_invoice_id is null or p_catalog_command_id is null then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(174852941,hashtext(p_invoice_id::text||':'||p_catalog_command_id::text));
 select * into v from erp_fiscal_invoices.invoice where id=p_invoice_id;
 if not found or v.deleted_at is not null or v.direction<>'0' then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 select * into r from erp_fiscal_invoices.invoice_pricing where invoice_id=p_invoice_id and catalog_command_id=p_catalog_command_id;
 if not found then
  -- The "Atualizar preços" command of the cadastro (155) made by this user, over products of this note only.
  select * into c from erp_catalog.command where command_id=p_catalog_command_id;
  if not found or c.actor<>p_user_id or c.result->>'entity' is distinct from 'products' or not(c.result?'supplier_id') or jsonb_typeof(c.result->'items') is distinct from 'array' then
   raise exception 'erp_fiscal_invoice_pricing_unmatched' using errcode='22023'; end if;
  v_products:=array(select distinct (x->>'product_id')::uuid from jsonb_array_elements(c.result->'items') x where x->>'product_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  if cardinality(v_products) not between 1 and 100 or cardinality(v_products)<>jsonb_array_length(c.result->'items')
   or exists(select 1 from unnest(v_products) p where not exists(select 1 from erp_fiscal_invoices.invoice_item i where i.invoice_id=p_invoice_id and i.product_id=p)) then
   raise exception 'erp_fiscal_invoice_pricing_unmatched' using errcode='22023'; end if;
  insert into erp_fiscal_invoices.invoice_pricing(invoice_id,catalog_command_id,products,recorded_by) values(p_invoice_id,p_catalog_command_id,cardinality(v_products),p_user_id) returning * into r;
  v_replayed:=false;
 elsif r.recorded_by<>p_user_id then raise exception 'erp_fiscal_invoice_pricing_conflict' using errcode='40001';
 end if;
 return jsonb_build_object('invoice_id',r.invoice_id,'catalog_command_id',r.catalog_command_id,'products',r.products,'recorded_at',r.recorded_at,'replayed',v_replayed,'data_mode','erp_native');
end $$;

-- "P" of the list: the latest price formation of each note of the page (reading profiles of the notes).
create function public.erp_fiscal_invoice_pricing_states(p_user_id uuid,p_invoice_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb;
begin
 perform erp_fiscal_invoices.require_read(p_user_id);
 if p_invoice_ids is null or cardinality(p_invoice_ids) not between 1 and 100 or array_position(p_invoice_ids,null) is not null then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('invoice_id',x.invoice_id,'recorded_at',x.recorded_at,'products',x.products,'count',x.n) order by x.invoice_id),'[]'::jsonb) into v_items
 from(select distinct on(p.invoice_id) p.invoice_id,p.recorded_at,p.products,count(*) over(partition by p.invoice_id) n
  from erp_fiscal_invoices.invoice_pricing p join erp_fiscal_invoices.invoice v on v.id=p.invoice_id and v.deleted_at is null
  where p.invoice_id=any(p_invoice_ids) order by p.invoice_id,p.recorded_at desc,p.catalog_command_id)x;
 return jsonb_build_object('items',v_items,'data_mode','erp_native');
end $$;

revoke all on function public.erp_fiscal_invoice_pricing_record(uuid,uuid,uuid),public.erp_fiscal_invoice_pricing_states(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_pricing_record(uuid,uuid,uuid),public.erp_fiscal_invoice_pricing_states(uuid,uuid[]) to service_role;
commit;
