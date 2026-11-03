-- Extrato de estoque no padrão do Origin (Estoque > Lançamentos de estoque), dependente de 009/018/090.
-- Somente leitura: não cria, altera nem estorna movimentos; erp_stock_movements (cursor UUID) permanece intacta.
-- Ordem cronológica: data do lançamento, momento do registro e UUID como desempate estável.
begin;
create index erp_stock_movement_ledger_order on erp_stock.movement(occurred_on desc,created_at desc,id desc);

-- Origem derivada dos vínculos reais (018 lançamento/estorno do documento, 090 recebimento/estorno da compra).
-- O texto livre "reference" nunca é interpretado. Documentos não são excluídos fisicamente, então não há
-- "Origem excluída"; notas fiscais não movimentam estoque no Brufap.
create function erp_stock.ledger_origin(p_movement_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  with linked as (
    select d.id,d.kind,d.number,'document_stock'::text via,1 rank from erp_stock.document_posting p
      join erp_documents.document d on d.id=p.document_id where p.movement_id=p_movement_id
    union all
    select d.id,d.kind,d.number,'document_stock',1 from erp_stock.document_posting p
      join erp_documents.document d on d.id=p.document_id where p.reversal_movement_id=p_movement_id
    union all
    select d.id,d.kind,d.number,'purchase_receipt',2 from erp_purchase_receipts.receipt r
      join erp_documents.document d on d.id=r.document_id where r.movement_id=p_movement_id
    union all
    select d.id,d.kind,d.number,'purchase_receipt',2 from erp_purchase_receipts.reversal r
      join erp_documents.document d on d.id=r.document_id where r.movement_id=p_movement_id
  ), document as (select * from linked where kind in('sales_orders','purchase_orders','service_orders') order by rank limit 1)
  select coalesce(
    (select jsonb_build_object('type',case kind when 'sales_orders' then 'sales' when 'purchase_orders' then 'purchases' else 'services' end,
      'document_id',id,'document_kind',kind,'document_number',number::text,'via',via) from document),
    (select jsonb_build_object('type','transfers','document_id',null,'document_kind',null,'document_number',null,'via',null)
      from erp_stock.movement m left join erp_stock.movement o on o.id=m.reverses_id
      where m.id=p_movement_id and (m.kind='transfer' or (m.kind='reversal' and o.kind='transfer'))),
    jsonb_build_object('type','none','document_id',null,'document_kind',null,'document_number',null,'via',null));
$$;

-- Linha do extrato: somente as posições do produto consultado (limita o tamanho da página) e a contagem das demais.
create function erp_stock.ledger_row(p_movement_id uuid,p_product_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',m.id,'kind',m.kind,'occurred_on',m.occurred_on,'reason',m.reason,'reference',m.reference,
    'created_at',m.created_at,'recorded_at_local',to_char(m.created_at at time zone 'America/Sao_Paulo','YYYY-MM-DD"T"HH24:MI:SS'),
    'reverses_id',m.reverses_id,'reversed_by',(select r.id from erp_stock.movement r where r.reverses_id=m.id),
    'items',(select jsonb_agg(jsonb_build_object('product_id',e.product_id,'warehouse_id',e.warehouse_id,'quantity',e.quantity::text,'unit',e.unit,
      'balance_after',e.balance_after::text,'balance_version',e.balance_version) order by e.ordinal)
      from erp_stock.entry e where e.movement_id=m.id and e.product_id=p_product_id),
    'other_items',(select count(*)::integer from erp_stock.entry e where e.movement_id=m.id and e.product_id<>p_product_id),
    'origin',erp_stock.ledger_origin(m.id))
  from erp_stock.movement m where m.id=p_movement_id;
$$;

-- Extrato paginado por número de página (offset), com total e totalizador sobre todo o conjunto filtrado.
-- Entradas/saídas: soma exata das posições do produto (e do depósito, se filtrado) nos lançamentos filtrados.
-- Saldo atual: saldo registrado agora no depósito filtrado ou em todos; não depende de tipo, origem ou período.
create function public.erp_stock_ledger(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null,p_kind text default null,
  p_origin text default null,p_date_from date default null,p_date_to date default null,p_limit integer default 100,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_unit text;v_result jsonb;
begin
  perform erp_stock.require_access(p_user_id,false);
  if p_product_id is null or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
    or (p_kind is not null and p_kind not in('receipt','issue','adjustment','transfer','reversal'))
    or (p_origin is not null and p_origin not in('sales','purchases','services','transfers','none'))
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
    select m.id,m.occurred_on,m.created_at,case when p_origin is null then null else erp_stock.ledger_origin(m.id)->>'type' end origin
    from (select distinct e.movement_id from erp_stock.entry e
      where e.product_id=p_product_id and (p_warehouse_id is null or e.warehouse_id=p_warehouse_id)) x
    join erp_stock.movement m on m.id=x.movement_id
    where (p_kind is null or m.kind=p_kind) and (p_date_from is null or m.occurred_on>=p_date_from) and (p_date_to is null or m.occurred_on<=p_date_to)),
  filtered as materialized(select id,occurred_on,created_at from scoped where p_origin is null or origin=p_origin),
  page as materialized(select id,occurred_on,created_at from filtered order by occurred_on desc,created_at desc,id desc limit p_limit offset p_offset),
  counted as (select count(*)::integer total from filtered),
  sums as (select coalesce(sum(e.quantity) filter(where e.quantity>0),0) entries,coalesce(sum(-e.quantity) filter(where e.quantity<0),0) exits
    from erp_stock.entry e join filtered f on f.id=e.movement_id
    where e.product_id=p_product_id and (p_warehouse_id is null or e.warehouse_id=p_warehouse_id))
  select jsonb_build_object('product_id',p_product_id,
    'items',coalesce((select jsonb_agg(erp_stock.ledger_row(p.id,p_product_id) order by p.occurred_on desc,p.created_at desc,p.id desc) from page p),'[]'::jsonb),
    'limit',p_limit,'offset',p_offset,'total',c.total,'has_more',c.total>p_offset+p_limit,
    'next_offset',case when c.total>p_offset+p_limit then p_offset+p_limit end,
    'filters',jsonb_build_object('warehouse_id',p_warehouse_id,'kind',p_kind,'origin',p_origin,'date_from',p_date_from,'date_to',p_date_to),
    'totals',jsonb_build_object('entries',s.entries::numeric(38,6)::text,'exits',s.exits::numeric(38,6)::text,
      'current_balance',(select coalesce(sum(b.quantity),0) from erp_stock.balance b
        where b.product_id=p_product_id and (p_warehouse_id is null or b.warehouse_id=p_warehouse_id))::numeric(38,6)::text,'unit',v_unit),
    'data_mode','erp_native') into v_result
  from counted c cross join sums s;
  return v_result;
end $$;

revoke all on function erp_stock.ledger_origin(uuid) from public,anon,authenticated,service_role;
revoke all on function erp_stock.ledger_row(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer) from public,anon,authenticated;
grant execute on function public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer) to service_role;
commit;
