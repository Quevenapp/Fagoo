-- 295: Conversão de unidade na entrada de estoque pela nota fiscal de entrada (onda G do estoque, NFE-203). Requer 259 e 280.
-- Até aqui um item da nota de entrada numa unidade diferente da do produto (por exemplo CX na nota e UN no cadastro) bloqueava o
-- "Lançar estoque" da nota e o "Lançar estoque ao finalizar Check-in" com erp_invoice_stock_unit_mismatch. Agora:
-- - A mesma unidade escrita com outra caixa ou espaços ("un" e "UN") é a mesma unidade, nas notas de entrada e de saída.
-- - Nota de entrada: a quantidade do item vai para o estoque na unidade do produto pela primeira regra que existir:
--   1. "Fator de conversão" do fornecedor: 1 <unidade da nota> = <fator> <unidade do produto>, gravado para o produto, o fornecedor (o
--      contato da nota) e a unidade da nota, informado na conferência do "Lançar estoque" da nota e reaproveitado nas notas seguintes do
--      mesmo fornecedor (como a conversão do fornecedor do produto). Nunca muda o cadastro do produto nem a nota.
--   2. Unidade tributária da nota (uTrib/qTrib do XML, aba Outros do item): quando a unidade tributária é a do produto, a quantidade
--      tributária é a quantidade no estoque (no check-in, proporcional à Qtde Recebida).
--   Sem regra, o item continua bloqueado com o motivo, e a conferência mostra onde informar o fator. Uma conta que precisaria de mais de
--   6 casas decimais é recusada (as quantidades nunca são arredondadas).
-- - O preço do item da nota vira preço por unidade do produto (preço da nota × quantidade da nota ÷ quantidade no estoque, 10 casas) no
--   extrato e no custo médio, como já era o preço dos itens na mesma unidade.
-- - A conversão aparece em cada item da conferência (quantidade e unidade da nota, regra e fator); a prévia muda de hash quando o fator
--   muda, e a conferência aberta antes é recusada.
-- Quem informa o fator: quem lança estoque pela nota (administrador e estoque); quem consulta: administrador, estoque e fiscal.
-- Funções substituídas (o corpo publicado é conferido pelo hash, sem CR; outra versão interrompe a migração). Nenhuma nota, movimento,
-- saldo ou cadastro existente é reescrito; uma nota com os itens na unidade do produto tem a mesma prévia (e o mesmo hash) de antes.
-- Ordem de travas: comando 174852918 -> nota 174852923 -> nota FOR SHARE -> mutex do estoque -> cadastro -> fator.
begin;

do $$declare r record;begin
 if to_regclass('erp_stock.invoice_posting') is null or to_regclass('erp_stock.item_component_command') is null then
  raise exception 'stock_invoice_unit_conversion_295_requires_259_280' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.command_taken(uuid)','428d047fa061b6be4b8f1233d474a2bd5d1c9c2caa008120d998e5df2b6af3dc'),
  ('erp_stock.invoice_preview_data(erp_fiscal_invoices.invoice,uuid,text,jsonb)','39738ebc9f555580e0158eefe0a8698d2ce5ba23aad60b90ac1e341050e53e89'),
  ('erp_stock.ledger_document_price(uuid,uuid)','5692c59282aca640ce9c330fc327c1cb7aaeb4db0a48b1d82f82e5e031cd9290'),
  ('erp_stock.average_costs(uuid[])','ca938fff4a57e74fde865ceacdb56cdf5c99ea219e42d9f223cdf8c0c50446e3'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_invoice_unit_conversion_295_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regclass('erp_stock.unit_conversion') is not null then raise exception 'stock_invoice_unit_conversion_295_already_applied' using errcode='55000';end if;
end$$;

-- 1. Tables. The factor of a supplier (1 unidade da nota = factor unidades do produto) and one immutable receipt per command, with the
-- factor before and after (the audit of the change).
create table erp_stock.unit_conversion(
 product_id uuid not null references erp_catalog.product(record_id),
 supplier_id uuid not null references erp_catalog.contact(record_id),
 unit text not null check(length(unit) between 1 and 6 and unit=upper(btrim(unit)) and unit!~'[[:cntrl:]]'),
 factor numeric(12,6) not null check(factor>0 and factor<=999999.999999),
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid not null references auth.users(id),command_id uuid not null,
 primary key(product_id,supplier_id,unit)
);
create index erp_stock_unit_conversion_supplier on erp_stock.unit_conversion(supplier_id);
create table erp_stock.unit_conversion_command(
 id uuid primary key,actor uuid not null references auth.users(id),invoice_id uuid not null references erp_fiscal_invoices.invoice(id),
 product_id uuid not null,supplier_id uuid not null,unit text not null,
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create index erp_stock_unit_conversion_command_invoice on erp_stock.unit_conversion_command(invoice_id,created_at);
create trigger immutable_stock_unit_conversion_command before update or delete on erp_stock.unit_conversion_command for each row execute function erp_stock.immutable_ledger();
-- Only a command writes a factor: a new row starts at version 1, every change is one version more by another command.
create function erp_stock.guard_unit_conversion()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if(tg_op='INSERT' and new.version<>1)or(tg_op='UPDATE' and(new.product_id<>old.product_id or new.supplier_id<>old.supplier_id or new.unit<>old.unit
   or new.version<>old.version+1 or new.command_id=old.command_id))then
  raise exception 'erp_stock_unit_conversion_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_unit_conversion before insert or update on erp_stock.unit_conversion for each row execute function erp_stock.guard_unit_conversion();
do $$declare t text;begin foreach t in array array['unit_conversion','unit_conversion_command']loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

-- One UUID identifies one effect across every stock command family, now including the factors of the notes.
create or replace function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
  or exists(select 1 from erp_stock.warehouse_command where id=p_id)or exists(select 1 from erp_stock.ledger_command where id=p_id)
  or exists(select 1 from erp_stock.count_command where id=p_id)or exists(select 1 from erp_stock.dashboard_command where id=p_id)
  or exists(select 1 from erp_stock.checkin_command where id=p_id)or exists(select 1 from erp_stock.supply_command where id=p_id)
  or exists(select 1 from erp_stock.composition_command where id=p_id)or exists(select 1 from erp_stock.lot_command where id=p_id)
  or exists(select 1 from erp_stock.invoice_command where id=p_id)or exists(select 1 from erp_stock.item_component_command where id=p_id)
  or exists(select 1 from erp_stock.unit_conversion_command where id=p_id)
$$;

-- 2. Helpers.
-- A unit as compared: "un", " UN" and "Un" are the same unit.
create function erp_stock.unit_key(p text)returns text language sql immutable set search_path=pg_catalog as $$ select upper(btrim(p)) $$;
-- The supplier of a note: its contact (recipient.contact_id), when it is a contact of the cadastro.
create function erp_stock.invoice_supplier(v erp_fiscal_invoices.invoice)returns uuid language sql stable set search_path=pg_catalog as $$
 select c.record_id from erp_catalog.contact c where v.recipient->>'contact_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and c.record_id=(v.recipient->>'contact_id')::uuid
$$;
-- The quantity of an item of a note (p_quantity, in the unit of the note; p_item_quantity is the whole quantity of the item) in the unit
-- of the product: {"conversion":"supplier","factor":"12.000000","quantity":"24.000000"}, {"conversion":"tax_unit","quantity":...},
-- the same with "problem":"inexact"|"excess" when the result would need more than 6 decimals or is too large, or null without a rule.
create function erp_stock.invoice_unit_rule(p_supplier uuid,p_product uuid,p_product_unit text,p_item_unit text,p_data jsonb,p_quantity numeric,p_item_quantity numeric)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare c erp_stock.unit_conversion;q numeric;tq numeric;v_rule jsonb;begin
 if p_supplier is not null then
  select * into c from erp_stock.unit_conversion where product_id=p_product and supplier_id=p_supplier and unit=erp_stock.unit_key(p_item_unit);
  if c.product_id is not null then
   q:=p_quantity*c.factor;
   v_rule:=jsonb_build_object('conversion','supplier','factor',c.factor::numeric(12,6)::text);
   if q>999999999999.999999 then return v_rule||jsonb_build_object('problem','excess');end if;
   if q<>round(q,6) then return v_rule||jsonb_build_object('problem','inexact');end if;
   return v_rule||jsonb_build_object('quantity',q::numeric(18,6)::text);
  end if;
 end if;
 if jsonb_typeof(p_data->'others')='object' and erp_stock.unit_key(p_data#>>'{others,tax_unit}')=erp_stock.unit_key(p_product_unit)
  and coalesce(p_data#>>'{others,tax_quantity}','')~'^[0-9]{1,12}(\.[0-9]{1,6})?$' and(p_data#>>'{others,tax_quantity}')::numeric>0 then
  tq:=(p_data#>>'{others,tax_quantity}')::numeric;v_rule:=jsonb_build_object('conversion','tax_unit');
  q:=case when p_quantity=p_item_quantity then tq else round(tq*p_quantity/p_item_quantity,6) end;
  if q>999999999999.999999 then return v_rule||jsonb_build_object('problem','excess');end if;
  if q*p_item_quantity<>tq*p_quantity or q<=0 then return v_rule||jsonb_build_object('problem','inexact');end if;
  return v_rule||jsonb_build_object('quantity',q::numeric(18,6)::text);
 end if;
 return null;
end$$;
-- The unit price of a note item per unit of the product: the price of the note × the quantity of the note ÷ the quantity posted, by the
-- source of the posting (295); an item posted in the unit of the product keeps its price.
create function erp_stock.invoice_unit_price(p_price numeric,p_snapshot jsonb,p_position integer,p_product uuid)returns numeric language sql immutable set search_path=pg_catalog as $$
 select coalesce((select round(p_price*(s->>'invoice_quantity')::numeric/(s->>'quantity')::numeric,10)
  from jsonb_array_elements(coalesce(p_snapshot->'positions','[]'::jsonb)) j cross join jsonb_array_elements(coalesce(j->'sources','[]'::jsonb)) s
  where j->>'product_id'=p_product::text and(s->>'position')::integer=p_position and s ? 'invoice_quantity' and(s->>'quantity')::numeric>0 limit 1),p_price)
$$;

-- 3. Prévia (259) with the conversion of the units of an entry note. The rest of the body is the published one.
create or replace function erp_stock.invoice_preview_data(v erp_fiscal_invoices.invoice,p_warehouse uuid,p_source text,p_lines jsonb default null)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare w erp_catalog.record;row record;l record;ignored jsonb:='[]';positions jsonb;result jsonb;direction text;v_lines jsonb:='[]';v_day date;v_reason text;v_supplier uuid;v_rule jsonb;begin
 if p_source not in('invoice','checkin') or(p_source='checkin')<>(p_lines is not null) then raise exception 'erp_invoice_stock_invalid' using errcode='22023';end if;
 direction:=case when v.direction='0' then 'receipt' else 'issue' end;
 perform pg_advisory_xact_lock(174852909,0);
 -- 259: re-read after the mutex, the same check that a document posting or a purchase receipt makes for the note.
 if exists(select 1 from erp_stock.invoice_posting p where p.invoice_id=v.id and p.state='active') then raise exception 'erp_invoice_stock_already_posted' using errcode='40001';end if;
 if erp_stock.invoice_reference(v.id) is not null then raise exception 'erp_invoice_stock_posted_by_reference' using errcode='40001';end if;
 if erp_stock.invoice_reserved(v.id) then raise exception 'erp_invoice_stock_reserved_document' using errcode='40001';end if;
 -- The 011 importer takes catalog rows in UUID order; the warehouse, the products and the components of the compositions together.
 perform 1 from erp_catalog.record where id=p_warehouse or id in(select product_id from erp_fiscal_invoices.invoice_item where invoice_id=v.id)
  or id in(select c.component_id from erp_fiscal_invoices.invoice_item i join erp_stock.composition_current c on c.product_id=i.product_id where i.invoice_id=v.id) order by id for update;
 perform 1 from erp_catalog.product where record_id in(select product_id from erp_fiscal_invoices.invoice_item where invoice_id=v.id)
  or record_id in(select c.component_id from erp_fiscal_invoices.invoice_item i join erp_stock.composition_current c on c.product_id=i.product_id where i.invoice_id=v.id) order by record_id for update;
 select r.* into w from erp_catalog.record r join erp_catalog.warehouse x on x.record_id=r.id where r.id=p_warehouse and r.active;
 if not found then raise exception 'erp_stock_warehouse_unavailable' using errcode='22023';end if;
 -- 295: the factors of the supplier of the note are read under the stock mutex (their writer takes it too).
 v_supplier:=case when direction='receipt' then erp_stock.invoice_supplier(v) end;
 for row in select i.position,i.product_id,case when p_source='checkin' then(select(j->>'quantity')::numeric from jsonb_array_elements(p_lines)j where(j->>'position')::integer=i.position)else i.quantity end quantity,
   i.quantity item_quantity,i.data,r.active,r.version,p.unit,p.kind,p.format
  from erp_fiscal_invoices.invoice_item i left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id
  where i.invoice_id=v.id and(p_source='invoice' or exists(select 1 from jsonb_array_elements(p_lines)j where(j->>'position')::integer=i.position)) order by i.position loop
  if row.product_id is null or row.kind='S' then
   ignored:=ignored||jsonb_build_array(jsonb_build_object('position',row.position,'product_id',row.product_id,'description',left(coalesce(row.data->>'description',''),120),
    'quantity',row.quantity::numeric(18,6)::text,'unit',row.data->>'unit','reason',case when row.product_id is null then 'unlinked_item' else 'service' end));
  elsif row.kind is distinct from 'P' or not coalesce(row.active,false) or row.unit is null then
   raise exception 'erp_stock_product_unavailable' using errcode='22023';
  elsif row.format='V' or(row.format='E' and direction='receipt') then raise exception 'erp_invoice_stock_composition_unsupported' using errcode='22023';
  elsif erp_stock.unit_key(row.unit) is distinct from erp_stock.unit_key(row.data->>'unit') then
   -- 295: an entry note item in another unit enters by the factor of the supplier or by the unidade tributária of the note.
   v_rule:=case when direction='receipt' then erp_stock.invoice_unit_rule(v_supplier,row.product_id,row.unit,row.data->>'unit',row.data,row.quantity,row.item_quantity) end;
   if v_rule is null then raise exception 'erp_invoice_stock_unit_mismatch' using errcode='22023',detail=row.position::text;end if;
   if v_rule ? 'problem' then raise exception 'erp_invoice_stock_conversion_inexact' using errcode='22023',detail=row.position::text;end if;
   v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',row.product_id,'quantity',v_rule->>'quantity',
    'source',jsonb_build_object('position',row.position,'quantity',v_rule->>'quantity','invoice_quantity',row.quantity::numeric(18,6)::text,
     'invoice_unit',row.data->>'unit','conversion',v_rule->>'conversion')||case when v_rule ? 'factor' then jsonb_build_object('factor',v_rule->>'factor') else '{}'::jsonb end));
  elsif row.format='E' then
   for l in select * from erp_stock.composition_lines(row.product_id,row.quantity) loop
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',l.quantity::text,'source',case when l.role='composition'
     then jsonb_build_object('position',row.position,'quantity',row.quantity::numeric(18,6)::text)
     else jsonb_build_object('position',row.position,'quantity',l.quantity::numeric(18,6)::text,'kit_product_id',row.product_id,
      'kit_quantity',row.quantity::numeric(18,6)::text,'component_quantity',l.per_kit::numeric(18,6)::text)end));
   end loop;
  else
   v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',row.product_id,'quantity',row.quantity::text,
    'source',jsonb_build_object('position',row.position,'quantity',row.quantity::numeric(18,6)::text)));
  end if;
 end loop;
 with lines as(select(j->>'product_id')::uuid product_id,(j->>'quantity')::numeric qty,j->'source' source from jsonb_array_elements(v_lines)j),
 groups as(select product_id,sum(qty) qty,jsonb_agg(source order by(source->>'position')::integer) sources from lines group by product_id)
 select coalesce(jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',r.name,'catalog_version',r.version,
  'warehouse_id',w.id,'unit',p.unit,'quantity',(case when direction='issue' then -g.qty else g.qty end)::numeric(18,6)::text,
  'balance_before',coalesce(b.quantity,0)::numeric(18,6)::text,
  'balance_after',round(coalesce(b.quantity,0)+case when direction='issue' then -g.qty else g.qty end,6)::text,
  'expected_version',coalesce(b.version,0),'sources',g.sources) order by g.product_id),'[]') into positions
 from groups g join erp_catalog.record r on r.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id;
 if jsonb_array_length(positions) not between 1 and 100 then raise exception 'erp_invoice_stock_position_limit' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(positions) j where((j->>'quantity')::numeric<0 and(j->>'balance_after')::numeric<0 and not erp_stock.negative_allowed())
  or(j->>'balance_after')::numeric>999999999999.999999 or(j->>'balance_after')::numeric<-999999999999.999999 or(j->>'expected_version')::integer=2147483647)then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 v_day:=erp_stock.invoice_day(v.issue_date,v.exit_date);
 v_reason:=case when p_source='checkin' then 'Check-in de recebimento da ' else 'Lançamento de estoque da ' end||erp_stock.invoice_label(v.model,v.number);
 result:=jsonb_build_object('action','post','source',p_source,'invoice',erp_stock.invoice_summary(v),'direction',direction,'occurred_on',v_day,'reason',v_reason,
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'positions',positions,'ignored',ignored);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end$$;

-- 4. Extrato and custo médio (259) with the price of a converted item per unit of the product. The rest of each body is the published one.
create or replace function erp_stock.ledger_document_price(p_movement uuid,p_product uuid)returns numeric language sql stable set search_path=pg_catalog as $$
 with doc as(select coalesce(
   (select document_id from erp_stock.document_posting where movement_id=p_movement or reversal_movement_id=p_movement limit 1),
   (select document_id from erp_purchase_receipts.receipt where movement_id=p_movement),
   (select document_id from erp_purchase_receipts.reversal where movement_id=p_movement))id),
 -- 259: a lançamento of a note (or of its check-in) takes the unit price of the note items; 295: per unit of the product.
 inv as(select invoice_id id,snapshot from erp_stock.invoice_posting where movement_id=p_movement or reversal_movement_id=p_movement limit 1),
 prices as(select distinct i.unit_price from erp_documents.item i join doc on i.document_id=doc.id where i.product_id=p_product
  union select distinct erp_stock.invoice_unit_price(i.unit_price,inv.snapshot,i.position,p_product) from erp_fiscal_invoices.invoice_item i join inv on i.invoice_id=inv.id where i.product_id=p_product)
 select case when(select count(*)from prices)=1 then(select unit_price from prices)end
$$;
create or replace function erp_stock.average_costs(p_products uuid[] default null)returns table(product_id uuid,average_cost numeric)
language plpgsql stable set search_path=pg_catalog as $$
declare r record;v_product uuid;v_qty numeric;v_avg numeric;v_base text;begin
 v_base:=erp_stock.settings_dto()->>'average_cost_base';
 for r in
  with scoped as materialized(select e.product_id p,e.quantity q,m.kind,m.id movement,m.created_at,e.ordinal from erp_stock.entry e join erp_stock.movement m on m.id=e.movement_id
    where p_products is null or e.product_id=any(p_products)),
   -- Only an increase of a receipt or of an adjustment (Balanço) brings a purchase price; transfers and reversals never do.
   costed as materialized(select distinct movement,p from scoped where q>0 and kind in('receipt','adjustment')),
   detail as materialized(select distinct on(x.movement_id,x.product_id) x.movement_id,x.product_id,x.unit_price,x.unit_cost from erp_stock.movement_detail x
    join costed c on c.movement=x.movement_id and c.p=x.product_id order by x.movement_id,x.product_id,x.revision desc),
   linked as materialized(select c.movement,c.p,coalesce((select dp.document_id from erp_stock.document_posting dp where dp.movement_id=c.movement limit 1),
     (select rr.document_id from erp_purchase_receipts.receipt rr where rr.movement_id=c.movement)) document_id,
     (select ip.invoice_id from erp_stock.invoice_posting ip where ip.movement_id=c.movement) invoice_id
    from costed c where not exists(select 1 from detail d where d.movement_id=c.movement and d.product_id=c.p)),
   docprice as materialized(select l.movement,l.p,case when count(distinct i.unit_price)=1 then min(i.unit_price)end price
    from linked l join erp_documents.item i on i.document_id=l.document_id and i.product_id=l.p group by l.movement,l.p
    union all
    -- 295: a converted item of a note costs its price per unit of the product.
    select l.movement,l.p,case when count(distinct erp_stock.invoice_unit_price(i.unit_price,ip.snapshot,i.position,l.p))=1 then min(erp_stock.invoice_unit_price(i.unit_price,ip.snapshot,i.position,l.p))end price
    from linked l join erp_stock.invoice_posting ip on ip.movement_id=l.movement join erp_fiscal_invoices.invoice_item i on i.invoice_id=l.invoice_id and i.product_id=l.p group by l.movement,l.p)
  select s.p,s.q,s.kind,case when not(s.q>0 and s.kind in('receipt','adjustment'))then null when d.movement_id is not null then
    case when v_base='custo_lancamento' then coalesce(d.unit_cost,d.unit_price)else d.unit_price end else dp.price end cost
  from scoped s left join detail d on d.movement_id=s.movement and d.product_id=s.p left join docprice dp on dp.movement=s.movement and dp.p=s.p
  order by s.p,s.created_at,s.movement,s.ordinal loop
  if v_product is distinct from r.p then
   if v_product is not null then product_id:=v_product;average_cost:=v_avg;return next;end if;
   v_product:=r.p;v_qty:=0;v_avg:=null;
  end if;
  if r.cost is not null then
   if v_avg is null or v_qty<=0 then v_avg:=r.cost;else v_avg:=round((v_qty*v_avg+r.q*r.cost)/(v_qty+r.q),10);end if;
  end if;
  v_qty:=v_qty+r.q;
 end loop;
 if v_product is not null then product_id:=v_product;average_cost:=v_avg;return next;end if;
end$$;

-- 5. Leitura: "Conversão de unidades" of the conferência of an entry note. Each item with a product of the cadastro whose unit is not
-- the unit of the product (up to 100, by position), with the factor of the supplier, the unidade tributária and the rule that applies.
create function erp_stock.invoice_units_dto(p_role text,v erp_fiscal_invoices.invoice)returns jsonb language sql stable set search_path=pg_catalog as $$
 with s as(select erp_stock.invoice_supplier(v) supplier),
 items as materialized(select i.position,i.quantity,i.data,r.id,r.name,r.code,p.unit
   from erp_fiscal_invoices.invoice_item i join erp_catalog.record r on r.id=i.product_id join erp_catalog.product p on p.record_id=i.product_id
   where i.invoice_id=v.id and v.direction='0' and p.kind='P' and p.unit is not null and coalesce(p.format,'S') not in('E','V')
    and erp_stock.unit_key(p.unit) is distinct from erp_stock.unit_key(i.data->>'unit')),
 page as(select * from items order by position limit 100)
 select jsonb_build_object('scope','stock_invoice_units','data_mode','erp_native','invoice',erp_stock.invoice_summary(v),
  'supplier',(select jsonb_build_object('id',r.id,'name',r.name) from s join erp_catalog.record r on r.id=s.supplier),
  'can_manage',coalesce(p_role in('admin','estoque') and v.direction='0' and v.deleted_at is null,false),'total',(select count(*) from items)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('position',x.position,'description',left(coalesce(x.data->>'description',''),120),'unit',x.data->>'unit',
    'quantity',x.quantity::numeric(18,6)::text,'product',jsonb_build_object('id',x.id,'name',x.name,'code',x.code,'unit',x.unit),
    'tax',case when jsonb_typeof(x.data->'others')='object' and coalesce(x.data#>>'{others,tax_unit}','')<>'' then
      jsonb_build_object('unit',x.data#>>'{others,tax_unit}','quantity',x.data#>>'{others,tax_quantity}') end,
    'factor',(select jsonb_build_object('factor',c.factor::numeric(12,6)::text,'version',c.version) from s join erp_stock.unit_conversion c
      on c.supplier_id=s.supplier and c.product_id=x.id and c.unit=erp_stock.unit_key(x.data->>'unit')),
    'rule',u.value->>'conversion','converted_quantity',u.value->>'quantity','problem',u.value->>'problem') order by x.position)
   from page x cross join s cross join lateral(select erp_stock.invoice_unit_rule(s.supplier,x.id,x.unit,x.data->>'unit',x.data,x.quantity,x.quantity) value)u),'[]'::jsonb))
$$;
create function public.erp_stock_invoice_units(p_user_id uuid,p_invoice_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice;v_role text;begin
 v_role:=erp_stock.invoice_access(p_user_id,false);
 if p_invoice_id is null then raise exception 'erp_invoice_stock_invalid' using errcode='22023';end if;
 select * into v from erp_fiscal_invoices.invoice where id=p_invoice_id;
 if not found then raise exception 'erp_invoice_not_found' using errcode='P0002';end if;
 return erp_stock.invoice_units_dto(v_role,v);
end$$;

-- 6. Gravação do "Fator de conversão" (1 <unidade da nota> = p_factor <unidade do produto>) do item p_position da nota de entrada,
-- para o produto e o fornecedor da nota; p_factor null remove o fator. Versão esperada 0 para um fator novo.
create function public.erp_stock_invoice_unit_save(p_user_id uuid,p_command_id uuid,p_invoice_id uuid,p_position integer,p_expected_version integer,p_factor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.unit_conversion_command;v erp_fiscal_invoices.invoice;i erp_fiscal_invoices.invoice_item;p erp_catalog.product;k erp_stock.unit_conversion;
  v_supplier uuid;v_unit text;v_factor numeric;v_role text;v_result jsonb;begin
 perform erp_stock.invoice_access(p_user_id,true);
 if p_command_id is null or p_invoice_id is null or p_position is null or p_position not between 1 and 990 or p_expected_version is null or p_expected_version not between 0 and 2147483646
  or(p_factor is not null and(p_factor!~'^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$' or p_factor::numeric=0))or(p_factor is null and p_expected_version=0)then
  raise exception 'erp_stock_unit_conversion_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-invoice-unit-295','actor',p_user_id,'invoice_id',p_invoice_id,'position',p_position,
  'expected_version',p_expected_version,'factor',p_factor)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));v_role:=erp_stock.invoice_access(p_user_id,true);
 select * into c from erp_stock.unit_conversion_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>h then raise exception 'erp_stock_unit_conversion_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id) then raise exception 'erp_stock_unit_conversion_conflict' using errcode='40001';end if;
 -- The note (its lock and FOR SHARE), then the stock mutex: a prévia of any note reads the factors under the same mutex.
 v:=erp_stock.invoice_lock(p_user_id,p_invoice_id,null);
 perform pg_advisory_xact_lock(174852909,0);v_role:=erp_stock.invoice_access(p_user_id,true);
 if v.deleted_at is not null or v.direction<>'0' then raise exception 'erp_stock_unit_conversion_unavailable' using errcode='22023',detail='not_entry';end if;
 v_supplier:=erp_stock.invoice_supplier(v);
 if v_supplier is null then raise exception 'erp_stock_unit_conversion_unavailable' using errcode='22023',detail='no_supplier';end if;
 select * into i from erp_fiscal_invoices.invoice_item where invoice_id=v.id and position=p_position;
 if i.invoice_id is null then raise exception 'erp_invoice_item_not_found' using errcode='P0002';end if;
 perform 1 from erp_catalog.record where id in(i.product_id,v_supplier) order by id for update;
 select * into p from erp_catalog.product where record_id=i.product_id;
 if p.record_id is null or p.kind is distinct from 'P' or p.unit is null or coalesce(p.format,'S') in('E','V') then
  raise exception 'erp_stock_unit_conversion_unavailable' using errcode='22023',detail='no_product';end if;
 v_unit:=erp_stock.unit_key(i.data->>'unit');
 if v_unit is null or v_unit='' or length(v_unit)>6 or v_unit~'[[:cntrl:]]' or v_unit=erp_stock.unit_key(p.unit) then
  raise exception 'erp_stock_unit_conversion_unavailable' using errcode='22023',detail='same_unit';end if;
 select * into k from erp_stock.unit_conversion where product_id=p.record_id and supplier_id=v_supplier and unit=v_unit for update;
 if coalesce(k.version,0)<>p_expected_version then raise exception 'erp_stock_unit_conversion_version_conflict' using errcode='40001';end if;
 v_factor:=p_factor::numeric;
 if k.factor is not distinct from v_factor then raise exception 'erp_stock_unit_conversion_unchanged' using errcode='22023';end if;
 if v_factor is null then delete from erp_stock.unit_conversion where product_id=k.product_id and supplier_id=k.supplier_id and unit=k.unit;
 elsif k.product_id is null then
  insert into erp_stock.unit_conversion(product_id,supplier_id,unit,factor,version,updated_by,command_id)values(p.record_id,v_supplier,v_unit,v_factor,1,p_user_id,p_command_id);
 else update erp_stock.unit_conversion set factor=v_factor,version=version+1,updated_at=clock_timestamp(),updated_by=p_user_id,command_id=p_command_id
  where product_id=k.product_id and supplier_id=k.supplier_id and unit=k.unit;
 end if;
 v_result:=jsonb_build_object('scope','stock_invoice_unit_save','data_mode','erp_native','command_id',p_command_id,'position',p_position,
  'product_id',p.record_id,'supplier_id',v_supplier,'unit',v_unit,'product_unit',p.unit,
  'before',case when k.product_id is not null then jsonb_build_object('factor',k.factor::numeric(12,6)::text,'version',k.version) end,
  'after',(select jsonb_build_object('factor',x.factor::numeric(12,6)::text,'version',x.version) from erp_stock.unit_conversion x where x.product_id=p.record_id and x.supplier_id=v_supplier and x.unit=v_unit),
  'saved_at',clock_timestamp(),'units',erp_stock.invoice_units_dto(v_role,v)-array['scope','data_mode']);
 insert into erp_stock.unit_conversion_command(id,actor,invoice_id,product_id,supplier_id,unit,request_hash,result)values(p_command_id,p_user_id,v.id,p.record_id,v_supplier,v_unit,h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_invoice_units','erp_stock_invoice_unit_save')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
