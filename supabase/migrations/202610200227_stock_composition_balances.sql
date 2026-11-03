-- 227: Saldo virtual da composição nos "Saldos do produto" (onda D). Requer 145 e 222. Somente leitura.
-- A composição Virtual (com estrutura) não tem saldo próprio: os Saldos por depósito do extrato e o "Todos os depósitos" dos itens do
-- pedido passam a mostrar, em cada depósito, o saldo virtual (composições completas com os componentes daquele depósito), marcado
-- "virtual" e com versão 0 (não há posição própria para lançar). Para os demais produtos a resposta é exatamente a publicada.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_stock.virtual_quantity(uuid,uuid)')is null then raise exception 'stock_composition_balances_227_requires_222' using errcode='55000';end if;
 for r in select * from(values
  ('public.erp_stock_balances(uuid,uuid,uuid)','1864d40e2ec3984fa1b429c9f98336fd2df8c526183cc60bf410bf6c3fd5a185'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_composition_balances_227_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- Saldos do produto (145) with the saldo virtual of a Virtual composition. The rest of the body is the published one.
create or replace function public.erp_stock_balances(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;s jsonb;v_virtual boolean;
begin
  perform erp_stock.require_access(p_user_id,false);
  if p_product_id is null or not exists(select 1 from erp_catalog.product where record_id=p_product_id) then
    raise exception 'erp_stock_product_not_found' using errcode='P0002'; end if;
  s:=erp_stock.settings_dto();
  -- 227: a Virtual composition with a structure (222) has no stock of its own.
  v_virtual:=exists(select 1 from erp_catalog.product p join erp_stock.composition c on c.product_id=p.record_id where p.record_id=p_product_id and p.format='E' and c.stock_type='virtual')
   and exists(select 1 from erp_stock.composition_current where product_id=p_product_id);
  with situation as materialized(select x.warehouse_id,x.quantity from erp_stock.situation_reservations(p_product_id)x)
  select jsonb_build_object('product_id',p_product_id,'items',coalesce(jsonb_agg(jsonb_build_object(
    'warehouse_id',w.record_id,'warehouse_name',r.name,'warehouse_active',r.active,
    'quantity',(case when v_virtual then coalesce(erp_stock.virtual_quantity(p_product_id,w.record_id),0) else coalesce(b.quantity,0) end)::numeric(18,6)::text,
    'version',case when v_virtual then 0 else coalesce(b.version,0) end,'unit',p.unit,'warehouse_default',coalesce(d.warehouse_id=w.record_id,false),
    'warehouse_ignored',erp_stock.ignored_warehouse(w.record_id),
    'reserved_quantity',(erp_stock.reserved_quantity(p_product_id,w.record_id)+coalesce((select sum(x.quantity)from situation x where x.warehouse_id=w.record_id),0))::numeric(18,6)::text,
    'situation_reserved_quantity',coalesce((select sum(x.quantity)from situation x where x.warehouse_id=w.record_id),0)::numeric(18,6)::text)
    ||case when v_virtual then '{"virtual":true}'::jsonb else '{}'::jsonb end order by w.record_id),'[]'::jsonb),
   'reservation',jsonb_build_object('by_situation',s->'reserve_by_situation','by_warehouse',s->'reserve_by_warehouse','statuses',s->'reserve_statuses',
    'unassigned_quantity',(select coalesce(sum(x.quantity),0)from situation x where x.warehouse_id is null)::numeric(18,6)::text),
   'data_mode','erp_native') into v_result
  from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id
  join erp_catalog.product p on p.record_id=p_product_id
  cross join erp_stock.warehouse_default d
  left join erp_stock.balance b on b.product_id=p_product_id and b.warehouse_id=w.record_id
  where p_warehouse_id is null or w.record_id=p_warehouse_id;
  return v_result;
end $$;

revoke all on function public.erp_stock_balances(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_stock_balances(uuid,uuid,uuid) to service_role;
commit;
