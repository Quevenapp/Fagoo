-- 182: Estorno com balanço posterior e estoque negativo nas vendas, no padrão do Origin (onda C do estoque).
-- Requer 100 (política "Permitir estoque negativo"), 115 (preferências) e 145 (estorno com balanço posterior).
-- Nenhum movimento, saldo, preço ou documento existente é gravado ou reescrito aqui; mudam só as regras dos próximos comandos.
-- - "Considerar estorno para o cálculo do saldo atual se houver balanço após o lançamento original" desligada (145):
--   * um Balanço já estornado deixa de ser "balanço posterior": o estorno do lançamento original muda o saldo como sempre;
--   * o ajuste de compensação do estorno vale como o próprio estorno: produto ou depósito inativado, ou produto que passou a ter
--     composição ou variações depois do Balanço, não impedem mais o estorno de um lançamento válido. A dispensa vale só para o
--     ajuste derivado do comando do estorno (marca da transação definida pelo próprio estorno e motivo fixo da 145).
-- - "Permite venda de produtos com estoque negativo" (Preferências > Vendas > Vendas): o lançamento de estoque de um pedido de
--   venda só deixa o saldo negativo quando a política geral "Permitir estoque negativo" (100) e esta opção estão ligadas, como no
--   Origin. As demais baixas (OS, lançamentos manuais, recebimentos) seguem só a política geral.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 if to_regprocedure('erp_preferences.get(text,uuid)')is null or to_regprocedure('erp_stock.derived_command(uuid,text)')is null then
  raise exception 'stock_reversal_182_requires_115_145' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.post_physical_025(uuid,uuid,text,date,text,text,jsonb,uuid)','e3e1e25d262b11828817b25d8ddeb24a4a014fc389a44800ee3863622c11ea8d'),
  ('public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb)','798fdb2439ef7c00121ec28bcb1362aa3154e52c56111ff80c0a0717e6cde87e'),
  ('erp_stock.document_preview_data(erp_documents.document,date,text)','fc23d5b1b4dcb82be1837cdb296d05b2e466bb9f5ef0a6328f38f0eb5ed7f095'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_reversal_182_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 1. Motor de estoque (100) com uma única dispensa nova: o ajuste de compensação do estorno após balanço (145) não confere produto
-- ou depósito ativo nem o formato, exatamente como o estorno que ele acompanha. O resto do corpo é o publicado.
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
    if not v_free and v_format in('E','V') then raise exception 'erp_stock_composition_unsupported' using errcode='22023'; end if;
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

-- 2. Estornar lançamento (145): um Balanço estornado não é "balanço posterior"; os ajustes de compensação são marcados na transação
-- para a dispensa do motor (1).
create or replace function public.erp_stock_reverse(p_user_id uuid,p_movement_id uuid,p_command_id uuid,p_occurred_on date,p_reason text,p_versions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_items jsonb;v_count integer;v_pre uuid;v_after uuid;v_absorbed jsonb;v_before_items jsonb;v_after_items jsonb;v_result jsonb;v_reason text:='Estorno anterior ao balanço: saldo atual mantido';begin
 perform erp_stock.require_access(p_user_id,true);
 perform pg_advisory_xact_lock(174852909,0);
 if exists(select 1 from erp_purchase_receipts.receipt where movement_id=p_movement_id)or exists(select 1 from erp_purchase_receipts.reversal where movement_id=p_movement_id)then raise exception 'purchase_receipt_reverse_via_receipt'using errcode='40001';end if;
 if exists(select 1 from erp_stock.document_posting where movement_id=p_movement_id or reversal_movement_id=p_movement_id) then raise exception 'erp_stock_reverse_via_document' using errcode='40001';end if;
 if p_versions is null or jsonb_typeof(p_versions)<>'array' or jsonb_array_length(p_versions) not between 1 and 100
  or exists(select 1 from jsonb_array_elements(p_versions) j where jsonb_typeof(j)<>'object' or exists(select 1 from jsonb_object_keys(j) k where k not in('product_id','warehouse_id','expected_version'))) then raise exception 'erp_stock_invalid_versions' using errcode='22023';end if;
 select count(*) into v_count from erp_stock.entry where movement_id=p_movement_id;
 if v_count=0 then raise exception 'erp_stock_movement_not_found' using errcode='P0002';end if;
 select jsonb_agg(jsonb_build_object('product_id',e.product_id,'warehouse_id',e.warehouse_id,'quantity',(-e.quantity)::text,'expected_version',v->'expected_version') order by e.ordinal) into v_items
 from erp_stock.entry e join jsonb_array_elements(p_versions) v on v->>'product_id'=e.product_id::text and v->>'warehouse_id'=e.warehouse_id::text where e.movement_id=p_movement_id;
 if jsonb_array_length(p_versions)<>v_count or coalesce(jsonb_array_length(v_items),0)<>v_count then raise exception 'erp_stock_invalid_versions' using errcode='22023';end if;
 v_pre:=erp_stock.derived_command(p_command_id,'before');v_after:=erp_stock.derived_command(p_command_id,'after');
 -- A repeated command returns what the first execution recorded (the stored reversal and its compensations, if any). The
 -- positions compensated before the reversal were posted one version later, exactly as in the first execution.
 if exists(select 1 from erp_stock.command where id=p_command_id) then
  select jsonb_agg(case when exists(select 1 from erp_stock.command c,jsonb_array_elements(c.result#>'{movement,items}') b where c.id=v_pre
    and b->>'product_id'=i->>'product_id' and b->>'warehouse_id'=i->>'warehouse_id') then jsonb_set(i,'{expected_version}',to_jsonb((i->>'expected_version')::bigint+1)) else i end)
   into v_items from jsonb_array_elements(v_items) i;
 end if;
 if exists(select 1 from erp_stock.command where id=p_command_id)
  or coalesce(erp_preferences.get('estoque.estorno_balanco')<>'false'::jsonb,true)
  or exists(select 1 from erp_stock.movement where id=p_movement_id and kind='reversal') then
  v_result:=erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,null,v_items,p_movement_id);
  return v_result||jsonb_build_object('balance_adjustments',(select coalesce(jsonb_agg(c.result->'movement' order by c.created_at,c.id),'[]'::jsonb)from erp_stock.command c where c.id in(v_pre,v_after)));
 end if;
 -- Positions of the original lançamento with a Balanço registered after it (same product and warehouse). 182: a Balanço that was
 -- itself reversed no longer fixes the balance, so it does not count.
 select coalesce(jsonb_agg(i),'[]'::jsonb) into v_absorbed from jsonb_array_elements(v_items) i
 where exists(select 1 from erp_stock.balance_count c join erp_stock.movement b on b.id=c.movement_id join erp_stock.movement o on o.id=p_movement_id
  where c.product_id=(i->>'product_id')::uuid and c.warehouse_id=(i->>'warehouse_id')::uuid and b.created_at>o.created_at
   and not exists(select 1 from erp_stock.movement x where x.reverses_id=b.id));
 if jsonb_array_length(v_absorbed)=0 then
  v_result:=erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,null,v_items,p_movement_id);
  return v_result||jsonb_build_object('balance_adjustments','[]'::jsonb);
 end if;
 -- A reversal that lowers a position is compensated before it (never below the balance), one that raises it after it.
 select jsonb_agg(jsonb_build_object('product_id',i->'product_id','warehouse_id',i->'warehouse_id','quantity',ltrim(i->>'quantity','-'),'expected_version',i->'expected_version'))
  into v_before_items from jsonb_array_elements(v_absorbed) i where i->>'quantity' like '-%';
 select jsonb_agg(case when exists(select 1 from jsonb_array_elements(coalesce(v_before_items,'[]'::jsonb)) b where b->'product_id'=i->'product_id' and b->'warehouse_id'=i->'warehouse_id')
   then jsonb_set(i,'{expected_version}',to_jsonb((i->>'expected_version')::bigint+1)) else i end) into v_items from jsonb_array_elements(v_items) i;
 select jsonb_agg(jsonb_build_object('product_id',i->'product_id','warehouse_id',i->'warehouse_id','quantity','-'||(i->>'quantity'),'expected_version',to_jsonb((i->>'expected_version')::bigint+1)))
  into v_after_items from jsonb_array_elements(v_absorbed) i where i->>'quantity' not like '-%';
 -- 182: each compensation is marked for its own derived command only, and the mark is cleared right after it.
 if v_before_items is not null then
  perform set_config('erp_stock.reversal_compensation',v_pre::text,true);
  perform erp_stock.post(p_user_id,v_pre,'adjustment',p_occurred_on,v_reason,null,v_before_items);
  perform set_config('erp_stock.reversal_compensation','',true);
 end if;
 v_result:=erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,null,v_items,p_movement_id);
 if v_after_items is not null then
  perform set_config('erp_stock.reversal_compensation',v_after::text,true);
  perform erp_stock.post(p_user_id,v_after,'adjustment',p_occurred_on,v_reason,null,v_after_items);
  perform set_config('erp_stock.reversal_compensation','',true);
 end if;
 return v_result||jsonb_build_object('balance_adjustments',(select coalesce(jsonb_agg(c.result->'movement' order by c.created_at,c.id),'[]'::jsonb)from erp_stock.command c where c.id in(v_pre,v_after)));
end $$;

-- 3. "Permite venda de produtos com estoque negativo" (Preferências > Vendas > Vendas, 115).
create function erp_stock.sales_negative_allowed()returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce(erp_preferences.get('vendas.estoque_negativo')='true'::jsonb,false)
$$;
-- Prévia do lançamento de estoque do documento (100): pedido de venda só fica negativo com a política geral e a opção de vendas.
create or replace function erp_stock.document_preview_data(d erp_documents.document,p_day date,p_reason text)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare w erp_catalog.record;row record;ignored jsonb:='[]';positions jsonb;result jsonb;direction text;begin
 perform erp_stock.document_meta(p_day,p_reason);
 if not erp_stock.document_eligible(d.kind,d.status) then raise exception 'erp_document_stock_ineligible_state' using errcode='40001';end if;
 if exists(select 1 from erp_stock.document_posting where document_id=d.id and state='active') then raise exception 'erp_document_stock_already_posted' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);
 -- The 011 importer takes catalog rows in UUID order; never prelock catalog before the stock lock.
 perform 1 from erp_catalog.record where id=d.warehouse_id or id in(select product_id from erp_documents.item where document_id=d.id) order by id for update;
 perform 1 from erp_catalog.product where record_id in(select product_id from erp_documents.item where document_id=d.id) order by record_id for update;
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
  elsif row.format in('E','V') then raise exception 'erp_document_stock_composition_unsupported' using errcode='22023';
  elsif row.unit is distinct from row.data->>'unit' then raise exception 'erp_document_stock_unit_mismatch' using errcode='22023';end if;
 end loop;
 direction:=case when d.kind='purchase_orders' then 'receipt' else 'issue' end;
 with groups as(select i.product_id,sum(i.quantity) qty,jsonb_agg(jsonb_build_object('id',i.id,'position',i.position,'quantity',i.quantity::text) order by i.position) sources
  from erp_documents.item i join erp_catalog.product p on p.record_id=i.product_id where i.document_id=d.id and p.kind='P' group by i.product_id)
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

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
revoke all on function public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb) from public,anon,authenticated;
grant execute on function public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb) to service_role;
commit;
