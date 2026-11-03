-- 253: "Histórico do produto para o cliente" (218) limitado e rápido, sem mudar o esquema origin_sync (onda E da frente de notas).
-- A 218 lia todas as notas do espelho do Origin (origin_sync.raw_record, nfe e nfce) e abria os itens de cada uma a cada consulta.
-- Agora um índice próprio da área fiscal (erp_fiscal_invoices.origin_item_index: contato do Origin, código do produto, sentido,
-- data, número, série, quantidade, valor e total de cada item) responde a consulta pelo índice, com no máximo 20 linhas de cada
-- origem. O índice é montado nesta migração e acompanha o espelho por partes: cada consulta processa até 300 notas do Origin
-- novas ou alteradas (pelo índice (entity, changed_at) que o espelho já tem, com 15 minutos de sobreposição e conferência do
-- version_hash), sem esperar outra consulta que já esteja atualizando. Nada muda no espelho, no coletor nem em map_origin.
-- A resposta da consulta é a mesma da 218. Somente leitura para o usuário; nada é emitido ou lançado.
begin;

do $$declare r record;begin
 for r in select * from(values
  ('public.erp_fiscal_invoice_item_history(uuid,uuid,uuid,text)','9d50f11da4536780c8946d1e4de451766ef6fbf75aa053d7d8069a65e8c52169'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'fiscal_history_253_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- Last indexed version of each Origin note (a note without items with a code still has its row, so it is not read again).
create table erp_fiscal_invoices.origin_item_source(
 entity text not null check(entity in('nfe','nfce')),source_id text not null,version_hash text not null,
 indexed_at timestamptz not null default clock_timestamp(),primary key(entity,source_id)
);
create table erp_fiscal_invoices.origin_item_index(
 entity text not null check(entity in('nfe','nfce')),source_id text not null,position integer not null check(position>0),
 contact_source text not null,direction text not null,product_code text not null,
 number integer,series integer,issue_date date,quantity text,unit_price text,total numeric(15,2),
 primary key(entity,source_id,position),
 foreign key(entity,source_id) references erp_fiscal_invoices.origin_item_source(entity,source_id) on delete cascade
);
create index erp_fiscal_origin_item_lookup on erp_fiscal_invoices.origin_item_index(contact_source,product_code,direction,issue_date desc,number desc);
create table erp_fiscal_invoices.origin_item_state(
 singleton boolean primary key default true check(singleton),changed_at timestamptz,refreshed_at timestamptz
);
insert into erp_fiscal_invoices.origin_item_state(singleton) values(true);
do $$ declare t text; begin foreach t in array array['origin_item_source','origin_item_index','origin_item_state'] loop
 execute format('alter table erp_fiscal_invoices.%I enable row level security',t);
 execute format('revoke all on erp_fiscal_invoices.%I from public,anon,authenticated,service_role',t); end loop; end $$;

-- Indexes up to p_limit Origin notes (null = all) new or changed since the last pass, oldest change first. The 15 minutes of
-- overlap cover a collector batch that committed after a later pass; version_hash skips what is already indexed.
create function erp_fiscal_invoices.origin_items_refresh(p_limit integer) returns integer
language plpgsql set search_path=pg_catalog as $$
declare s erp_fiscal_invoices.origin_item_state%rowtype;v_from timestamptz;v_done integer:=0;v_max timestamptz;r record;
begin
 select * into s from erp_fiscal_invoices.origin_item_state where singleton for update;
 v_from:=coalesce(s.changed_at-interval '15 minutes','-infinity'::timestamptz);
 for r in select x.entity,x.source_id,x.version_hash,x.changed_at,x.payload from origin_sync.raw_record x
  where x.entity in('nfe','nfce') and x.changed_at>=v_from
   and not exists(select 1 from erp_fiscal_invoices.origin_item_source b where b.entity=x.entity and b.source_id=x.source_id and b.version_hash=x.version_hash)
  order by x.changed_at,x.entity,x.source_id limit coalesce(p_limit,2147483647) loop
  insert into erp_fiscal_invoices.origin_item_source(entity,source_id,version_hash) values(r.entity,r.source_id,r.version_hash)
   on conflict(entity,source_id) do update set version_hash=excluded.version_hash,indexed_at=clock_timestamp();
  delete from erp_fiscal_invoices.origin_item_index where entity=r.entity and source_id=r.source_id;
  insert into erp_fiscal_invoices.origin_item_index(entity,source_id,position,contact_source,direction,product_code,number,series,issue_date,quantity,unit_price,total)
  select r.entity,r.source_id,e.n::integer,c.contact,c.direction,erp_fiscal_invoices.scalar(e.value->'codigo',60),
   erp_fiscal_invoices.origin_int(to_jsonb(nullif(ltrim(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(r.payload->'numero',20)),'0'),''))),
   erp_fiscal_invoices.origin_int(r.payload->'serie'),erp_fiscal_invoices.origin_date(r.payload->'dataEmissao'),
   case when erp_fiscal_invoices.scalar(e.value->'quantidade',30) ~ '^[0-9]{1,12}(\.[0-9]{1,10})?$' then e.value->>'quantidade' end,
   case when erp_fiscal_invoices.scalar(e.value->'valor',30) ~ '^[0-9]{1,13}(\.[0-9]{1,10})?$' then e.value->>'valor' end,
   erp_fiscal_invoices.origin_money(e.value->'valorTotal')
  from(select erp_fiscal_invoices.scalar(r.payload#>'{contato,id}',40) contact,
    case when r.entity='nfce' then '1' else erp_fiscal_invoices.scalar(r.payload->'tipo',2) end direction) c
  cross join lateral jsonb_array_elements(case when jsonb_typeof(r.payload->'itens')='array' then r.payload->'itens' else '[]'::jsonb end) with ordinality e(value,n)
  where c.contact is not null and c.direction is not null and erp_fiscal_invoices.scalar(e.value->'codigo',60) is not null;
  v_done:=v_done+1;v_max:=greatest(v_max,r.changed_at);
 end loop;
 update erp_fiscal_invoices.origin_item_state set changed_at=greatest(s.changed_at,v_max),refreshed_at=clock_timestamp() where singleton;
 return v_done;
end $$;
revoke all on function erp_fiscal_invoices.origin_items_refresh(integer) from public,anon,authenticated,service_role;

-- Every note of the mirror today (one pass at publication; it only reads the mirror, so the collector keeps writing meanwhile).
set local statement_timeout='30min';
select erp_fiscal_invoices.origin_items_refresh(null);

-- 218 with the same answer: the Origin side reads the index (at most 20 rows), the Brufap side at most 20 rows too.
create or replace function public.erp_fiscal_invoice_item_history(p_user_id uuid,p_contact_id uuid,p_product_id uuid,p_direction text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);v_code text;v_sources text[];v_items jsonb;
begin
 if p_contact_id is null or p_product_id is null or p_direction is null or p_direction not in('0','1') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 if not exists(select 1 from erp_catalog.record where id=p_contact_id and entity='contacts') or not exists(select 1 from erp_catalog.record where id=p_product_id and entity='products') then
  raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);
 select nullif(code,'') into v_code from erp_catalog.record where id=p_product_id;
 v_sources:=array(select o.source_id from erp_catalog.origin o where o.entity='contacts' and o.record_id=p_contact_id);
 -- Bounded catch-up of the index; a consultation never waits for another one that is already updating it.
 if v_code is not null and cardinality(v_sources)>0 and pg_try_advisory_xact_lock(174852942,253) then perform erp_fiscal_invoices.origin_items_refresh(300); end if;
 with brufap as(
  select 'brufap'::text origin,v.id::text id,v.number,v.series,v.issue_date,v.issue_type,i.quantity::text quantity,i.unit_price::text unit_price,i.total
  from erp_fiscal_invoices.invoice v join erp_fiscal_invoices.invoice_item i on i.invoice_id=v.id
  where v.deleted_at is null and v.direction=p_direction and v.recipient->>'contact_id'=p_contact_id::text and i.product_id=p_product_id
  order by v.issue_date desc nulls last,v.number desc nulls last,v.id limit 20
 ),origin as(
  select 'origin'::text origin,b.source_id id,b.number,b.series,b.issue_date,null::text issue_type,b.quantity,b.unit_price,b.total
  from erp_fiscal_invoices.origin_item_index b
  where v_code is not null and b.contact_source=any(v_sources) and b.product_code=v_code and b.direction=p_direction
  order by b.issue_date desc nulls last,b.number desc nulls last,b.source_id limit 20
 ),rows as(select * from brufap union all select * from origin order by issue_date desc nulls last,number desc nulls last,id limit 20)
 select coalesce(jsonb_agg(jsonb_build_object('origin',x.origin,'id',x.id,'number',x.number,'series',x.series,'issue_date',x.issue_date,'issue_type',x.issue_type,
   'quantity',x.quantity,'unit_price',x.unit_price,'total',case when x.total is null then null else erp_fiscal_invoices.money_text(x.total) end)
   order by x.issue_date desc nulls last,x.number desc nulls last,x.id),'[]'::jsonb) into v_items from rows x;
 return jsonb_build_object('items',v_items,'contact_id',p_contact_id,'product_id',p_product_id,'direction',p_direction,'data_mode','erp_native');
end $$;
revoke all on function public.erp_fiscal_invoice_item_history(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_item_history(uuid,uuid,uuid,text) to service_role;
commit;
