-- 259: Lançar estoque e Estornar estoque pela nota fiscal, no padrão do Origin (onda E do estoque), e "Lançar estoque ao finalizar
-- Check-in". Requer 112 (notas fiscais do Brufap), 147 (check-in), 182, 222, 224 e 258. Nenhum movimento, saldo, nota, documento ou
-- recebimento existente é reescrito; a nota fiscal nunca é alterada (o lançamento é um registro do estoque ligado à nota e à versão dela).
-- - Notas do Brufap (NF-e de saída, NFC-e e NF-e de entrada): "Lançar estoque" escolhe o depósito e lança as saídas (nota de saída e
--   NFC-e) ou as entradas (nota de entrada) dos itens com produto, num único movimento (mesmo motor: mutex, versões esperadas, política
--   de estoque negativo e reservas), com prévia, comando idempotente e auditoria. A composição de uma nota de saída movimenta a
--   composição e/ou os componentes conforme "Lançar estoque" (222); nota de entrada não recebe composição (como o pedido de compra).
--   Itens sem produto e serviços ficam de fora com o motivo. A unidade do item precisa ser a do produto (a conversão de unidade do
--   fornecedor não existe no cadastro de produtos). A data segue "Ao lançar estoque utilizar data atual ou data entrada/saída".
-- - Letra E da listagem: "S" quando o estoque foi lançado pela nota e "R" quando foi lançado pela referência (o pedido de venda, a OS
--   ou o pedido de compra ligados à nota lançaram o estoque); com "R" a nota não lança de novo e o estorno é feito pelo documento.
--   O pedido ligado a uma nota que lançou o estoque também não lança de novo (lançamento do documento, recebimento de compra) e sai da
--   reserva pelas situações de venda. Com o pedido ligado reservado (070) a nota não lança: a reserva sai pelo pedido. A nota com
--   estoque lançado por ela só é excluída depois do estorno (cancelada ou denegada, o estorno continua pela listagem).
-- - "Estornar estoque": o movimento oposto, hoje, com o motivo automático, e a regra "Considerar estorno ... se houver balanço após o
--   lançamento original" (224) também para a nota.
-- - Check-in de Recebimentos: "Finalizar" com "Lançar estoque ao finalizar Check-in" finaliza o check-in e lança a entrada da Qtde
--   Recebida de cada item (itens recusados e sem quantidade ficam de fora) no depósito escolhido, no mesmo comando. A opção vem marcada
--   quando "Lançar estoque ao finalizar Check-in na NF de Entrada" (Preferências › Notas Fiscais › Configurações de NF-e) está ligada.
-- - Extrato: origem "Notas Fiscais" (filtro Tipo de Origem) com o link da nota para quem lê as notas do Brufap; o preço do item da nota
--   aparece para quem lê as notas e entra no custo médio e no preço da última compra (nota de entrada).
-- Quem lança e estorna: quem lança estoque (administrador e estoque); quem consulta a letra e a prévia: administrador, estoque e fiscal.
-- Ordem de travas: comando 174852918 -> nota 174852923 -> (check-in 174852922) -> nota FOR SHARE -> mutex do estoque -> cadastro -> saldos.
begin;

do $$declare r record;begin
 if to_regclass('erp_stock.lot')is null or to_regclass('erp_stock.checkin')is null or to_regclass('erp_fiscal_invoices.invoice_order')is null
  or to_regprocedure('erp_stock.balance_kept(uuid,uuid,uuid)')is null then raise exception 'stock_invoice_postings_259_requires_112_147_224_258' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.command_taken(uuid)','31f69540bda95c50711cdee95b245355b1ef28c33d14e1000b862a493cf3b5bf'),
  ('erp_stock.post(uuid,uuid,text,date,text,text,jsonb,uuid)','a2b1b5a90a9b72eb2130b516d0d752827f8009997748d003445dfaa24aa868f3'),
  ('public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb)','54a9b6b8c585117facb365d8139c168bdf975eb137e5c89e534cd2d194a6eb7f'),
  ('erp_stock.ledger_origin(uuid)','deda02eeba344e4a95ebfd1e1b508e676b0d7131ea08de13cbd59a6e17b969e3'),
  ('erp_stock.ledger_row_105(uuid,uuid,text)','c9bbc6c022445b1ce92f7d66b20a160013b8c5791549c5b8d86d821131b79a19'),
  ('erp_stock.ledger_document_price(uuid,uuid)','cb339cc94685e1021dd9e69bec99cd65065922f3d42d4f2e13f7128d698c228c'),
  ('public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer,text)','c2b5e7b54b5fc9174652a52998b4e4b364d26a110c258b7b11c450416085de6e'),
  ('erp_stock.average_costs(uuid[])','440a4fb0c27024b21f926fe59ecb2f5c93ff94dc692b8203f784f9e5ea4b1729'),
  ('erp_stock.document_preview_data(erp_documents.document,date,text)','88d510060896a7d0b8ddd01dfe8baf1d5b849537d3d9247f76718dda2500b6b1'),
  ('erp_purchase_receipts.preview(uuid,erp_documents.document,text,date,text,jsonb,uuid)','b0ab7d7411d695f930a9861c2b5ad26caba43a914ec4d5cadccc6d0f4d907145'),
  ('erp_stock.situation_reservations(uuid)','bc2c91c0e0b2790eab7fd054a44ca3261521fd7f6a5bda7588d5fdf7d1e94a3d'),
  ('public.erp_stock_checkin_finish(uuid,uuid,uuid,integer)','889683ece3cfaf63d807b01fe02a4db35f2c356c9f45ca2bfe1efa7a1ee2e4ed'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_invoice_postings_259_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regclass('erp_stock.invoice_posting')is not null then raise exception 'stock_invoice_postings_259_already_applied' using errcode='55000';end if;
end$$;

-- 1. Tables. One immutable command row per accepted command (the receipt of "Conferir resultado").
create table erp_stock.invoice_command(
 id uuid primary key,actor uuid not null references auth.users(id),
 action text not null check(action in('post','reverse','checkin')),
 invoice_id uuid not null references erp_fiscal_invoices.invoice(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create index erp_stock_invoice_command_invoice on erp_stock.invoice_command(invoice_id,created_at);
create table erp_stock.invoice_posting(
 id uuid primary key default gen_random_uuid(),
 invoice_id uuid not null references erp_fiscal_invoices.invoice(id),
 invoice_version integer not null check(invoice_version>0),
 -- invoice: ⋮ Lançar estoque of the note; checkin: Finalizar with "Lançar estoque ao finalizar Check-in" (Qtde Recebida).
 source text not null check(source in('invoice','checkin')),
 warehouse_id uuid not null references erp_catalog.warehouse(record_id),
 movement_id uuid not null unique references erp_stock.movement(id),
 state text not null default 'active' check(state in('active','reversed')),
 version integer not null default 1 check(version between 1 and 2147483647),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),preview_hash text not null check(preview_hash~'^[a-f0-9]{64}$'),
 actor uuid not null references auth.users(id),command_id uuid not null unique,created_at timestamptz not null default clock_timestamp(),
 reversal_movement_id uuid unique references erp_stock.movement(id),reversed_at timestamptz,reversed_by uuid references auth.users(id),reversal_command_id uuid unique,
 check((state='active' and reversal_movement_id is null and reversed_at is null and reversed_by is null and reversal_command_id is null)
  or(state='reversed' and reversal_movement_id is not null and reversed_at is not null and reversed_by is not null and reversal_command_id is not null))
);
create unique index erp_stock_invoice_one_active on erp_stock.invoice_posting(invoice_id) where state='active';
create index erp_stock_invoice_posting_history on erp_stock.invoice_posting(invoice_id,created_at);
create trigger immutable_stock_invoice_command before update or delete on erp_stock.invoice_command for each row execute function erp_stock.immutable_ledger();
-- A posting only moves from active to reversed, by the reversal of its own movement; nothing else changes and it is never deleted.
create function erp_stock.guard_invoice_posting()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or(tg_op='INSERT' and(new.state<>'active' or new.version<>1))
  or(tg_op='UPDATE' and(old.state<>'active' or new.state<>'reversed' or new.version<>old.version+1
   or(to_jsonb(new)-array['state','version','reversal_movement_id','reversed_at','reversed_by','reversal_command_id'])
    is distinct from(to_jsonb(old)-array['state','version','reversal_movement_id','reversed_at','reversed_by','reversal_command_id'])
   or not exists(select 1 from erp_stock.movement where id=new.reversal_movement_id and reverses_id=old.movement_id)))then
  raise exception 'erp_invoice_stock_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_invoice_posting before insert or update or delete on erp_stock.invoice_posting for each row execute function erp_stock.guard_invoice_posting();
-- A note whose stock it posted (S) is not deleted before its "Estornar estoque": a deleted note leaves the lists and its lançamento could
-- no longer be reversed (the extrato sends it to the note). Cancelada and Denegada keep the posting and are reversed from the list. The
-- same guard as 070 puts on the documents with a reservation; the note itself is never written here.
create function erp_stock.guard_invoice_stock_delete()returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if exists(select 1 from erp_stock.invoice_posting p where p.invoice_id=new.id and p.state='active') then
  raise exception 'erp_invoice_stock_posted_delete' using errcode='40001';end if;
 return new;
end$$;
create trigger protect_invoice_stock_posting before update of deleted_at on erp_fiscal_invoices.invoice for each row
 when(old.deleted_at is null and new.deleted_at is not null) execute function erp_stock.guard_invoice_stock_delete();
do $$declare t text;begin foreach t in array array['invoice_command','invoice_posting']loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

-- One UUID identifies one effect across every stock command family, now including the notes.
create or replace function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
  or exists(select 1 from erp_stock.warehouse_command where id=p_id)or exists(select 1 from erp_stock.ledger_command where id=p_id)
  or exists(select 1 from erp_stock.count_command where id=p_id)or exists(select 1 from erp_stock.dashboard_command where id=p_id)
  or exists(select 1 from erp_stock.checkin_command where id=p_id)or exists(select 1 from erp_stock.supply_command where id=p_id)
  or exists(select 1 from erp_stock.composition_command where id=p_id)or exists(select 1 from erp_stock.lot_command where id=p_id)
  or exists(select 1 from erp_stock.invoice_command where id=p_id)
$$;

-- 2. Helpers.
-- Read: administrador, estoque (check-in) and fiscal (the native notes, 113); write: whoever posts stock (administrador e estoque).
create function erp_stock.invoice_access(p_actor uuid,p_write boolean)returns text language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;begin
 select role into v_role from erp_access.membership where user_id=p_actor and active;
 if v_role is null or(p_write and v_role not in('admin','estoque'))or(not p_write and v_role not in('admin','estoque','fiscal'))then
  raise exception 'erp_invoice_stock_access_denied' using errcode='42501';end if;
 if p_write then perform erp_stock.require_access(p_actor,true);end if;
 return v_role;
end$$;
create function erp_stock.invoice_screen(p_model text,p_direction text)returns text language sql immutable set search_path=pg_catalog as $$
 select case when p_model='65' then 'nfce' when p_direction='0' then 'nfe_entrada' else 'nfe_saida' end
$$;
create function erp_stock.invoice_label(p_model text,p_number integer)returns text language sql immutable set search_path=pg_catalog as $$
 select case when p_model='65' then 'NFC-e' else 'NF-e' end||' '||coalesce(lpad(p_number::text,6,'0'),'sem número')
$$;
-- The documents linked to the note (invoice_order) whose stock was posted by them: the active lançamento of the pedido de venda / OS
-- (018) or an active receipt of the pedido de compra (090). That is the "R" of Origin (estoque lançado pela referência).
create function erp_stock.invoice_reference(p_invoice uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(
  (select jsonb_build_object('document_id',d.id,'kind',d.kind,'number',d.number::text,'via','document_stock','warehouse',
     jsonb_build_object('id',(p.snapshot#>>'{warehouse,id}')::uuid,'name',p.snapshot#>>'{warehouse,name}'))
   from erp_fiscal_invoices.invoice_order o join erp_documents.document d on d.id=o.document_id
   join erp_stock.document_posting p on p.document_id=d.id and p.state='active' where o.invoice_id=p_invoice order by d.number,d.id limit 1),
  (select jsonb_build_object('document_id',d.id,'kind',d.kind,'number',d.number::text,'via','purchase_receipt','warehouse',
     jsonb_build_object('id',(r.snapshot#>>'{warehouse,id}')::uuid,'name',r.snapshot#>>'{warehouse,name}'))
   from erp_fiscal_invoices.invoice_order o join erp_documents.document d on d.id=o.document_id
   join erp_purchase_receipts.receipt r on r.document_id=d.id where o.invoice_id=p_invoice
    and not exists(select 1 from erp_purchase_receipts.reversal x where x.receipt_id=r.id) order by d.number,d.id,r.created_at limit 1))
$$;
-- A pedido (venda, OS ou compra) linked to a note whose stock was posted by the note.
create function erp_stock.invoice_posted_for_document(p_document uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_stock.invoice_posting p on p.invoice_id=o.invoice_id and p.state='active' where o.document_id=p_document)
$$;
create function erp_stock.invoice_posting_dto(p_id uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',p.id,'invoice_id',p.invoice_id,'invoice_version',p.invoice_version,'source',p.source,'state',p.state,'version',p.version,
  'warehouse',jsonb_build_object('id',p.warehouse_id,'name',(select name from erp_catalog.record where id=p.warehouse_id)),'movement_id',p.movement_id,
  'occurred_on',p.snapshot->>'occurred_on','direction',p.snapshot->>'direction','positions',jsonb_array_length(p.snapshot->'positions'),'ignored_items',jsonb_array_length(p.snapshot->'ignored'),
  'created_at',p.created_at,'reversal_movement_id',p.reversal_movement_id,'reversed_at',p.reversed_at)
 from erp_stock.invoice_posting p where p.id=p_id
$$;
-- Letra E: S (lançado pela nota) with the warehouse, R (lançado pela referência) with the warehouse of the document, or none.
create function erp_stock.invoice_flag(p_invoice uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select case when p.id is not null then jsonb_build_object('flag','S','warehouse',jsonb_build_object('id',p.warehouse_id,'name',(select name from erp_catalog.record where id=p.warehouse_id)),
   'posting_id',p.id,'posting_version',p.version,'source',p.source,'reference',null)
  when ref.value is not null then jsonb_build_object('flag','R','warehouse',ref.value->'warehouse','posting_id',null,'posting_version',null,'source',null,'reference',ref.value-'warehouse')
  else jsonb_build_object('flag',null,'warehouse',null,'posting_id',null,'posting_version',null,'source',null,'reference',null)end
 from(select p_invoice id)x left join erp_stock.invoice_posting p on p.invoice_id=x.id and p.state='active' cross join lateral(select erp_stock.invoice_reference(x.id) value)ref
$$;
-- "Ao lançar estoque utilizar data atual ou data entrada/saída" (Preferências > Suprimentos > Estoque): Data entrada/saída is the Data
-- de saída/entrada of the note, or its Data de emissão; a future date becomes today (São Paulo).
create function erp_stock.invoice_day(p_issue date,p_exit date)returns date language sql stable set search_path=pg_catalog as $$
 select case when erp_preferences.get('estoque.data_lancamento')#>>'{}'='data_documento' then least(coalesce(p_exit,p_issue),(clock_timestamp() at time zone 'America/Sao_Paulo')::date)
  else(clock_timestamp() at time zone 'America/Sao_Paulo')::date end
$$;
create function erp_stock.invoice_summary(v erp_fiscal_invoices.invoice)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',v.id,'model',v.model,'direction',v.direction,'screen',erp_stock.invoice_screen(v.model,v.direction),'number',v.number,'series',v.series,'status',v.status,
  'version',v.version,'label',erp_stock.invoice_label(v.model,v.number),'issue_date',v.issue_date,'exit_date',v.exit_date,'deleted',v.deleted_at is not null)
$$;
-- A pedido de venda linked to the note that holds an active reservation (070): its stock leaves by the reservation ("Lançar estoque"
-- of the pedido consumes it, the note then shows R), so the note does not post the same goods while the reservation still holds them.
create function erp_stock.invoice_reserved(p_invoice uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_stock.reservation r on r.document_id=o.document_id and r.state='active' where o.invoice_id=p_invoice)
$$;
-- Why a note cannot post its stock now (null when it can).
create function erp_stock.invoice_block(v erp_fiscal_invoices.invoice)returns text language sql stable set search_path=pg_catalog as $$
 select case when v.deleted_at is not null then 'deleted' when v.status=3 then 'cancelled' when v.status=10 then 'denied'
  when exists(select 1 from erp_stock.invoice_posting p where p.invoice_id=v.id and p.state='active') then 'posted'
  when erp_stock.invoice_reference(v.id) is not null then 'reference'
  when erp_stock.invoice_reserved(v.id) then 'reserved'
  when not exists(select 1 from erp_fiscal_invoices.invoice_item i where i.invoice_id=v.id and i.product_id is not null) then 'no_products' end
$$;

-- 3. Prévia (the positions of the note, or of the check-in lines [{position, quantity}]), under the stock mutex and the catalog locks.
create function erp_stock.invoice_preview_data(v erp_fiscal_invoices.invoice,p_warehouse uuid,p_source text,p_lines jsonb default null)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare w erp_catalog.record;row record;l record;ignored jsonb:='[]';positions jsonb;result jsonb;direction text;v_lines jsonb:='[]';v_day date;v_reason text;begin
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
 for row in select i.position,i.product_id,case when p_source='checkin' then(select(j->>'quantity')::numeric from jsonb_array_elements(p_lines)j where(j->>'position')::integer=i.position)else i.quantity end quantity,
   i.data,r.active,r.version,p.unit,p.kind,p.format
  from erp_fiscal_invoices.invoice_item i left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id
  where i.invoice_id=v.id and(p_source='invoice' or exists(select 1 from jsonb_array_elements(p_lines)j where(j->>'position')::integer=i.position)) order by i.position loop
  if row.product_id is null or row.kind='S' then
   ignored:=ignored||jsonb_build_array(jsonb_build_object('position',row.position,'product_id',row.product_id,'description',left(coalesce(row.data->>'description',''),120),
    'quantity',row.quantity::numeric(18,6)::text,'unit',row.data->>'unit','reason',case when row.product_id is null then 'unlinked_item' else 'service' end));
  elsif row.kind is distinct from 'P' or not coalesce(row.active,false) or row.unit is null then
   raise exception 'erp_stock_product_unavailable' using errcode='22023';
  elsif row.format='V' or(row.format='E' and direction='receipt') then raise exception 'erp_invoice_stock_composition_unsupported' using errcode='22023';
  elsif row.unit is distinct from row.data->>'unit' then raise exception 'erp_invoice_stock_unit_mismatch' using errcode='22023';
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
-- Prévia do estorno: the opposite of each line of the posted movement; a position that keeps its balance (224) is marked and not refused.
create function erp_stock.invoice_reverse_preview_data(v erp_fiscal_invoices.invoice,p erp_stock.invoice_posting)returns jsonb language plpgsql set search_path=pg_catalog as $$
declare positions jsonb;result jsonb;v_day date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;begin
 perform pg_advisory_xact_lock(174852909,0);
 perform 1 from erp_catalog.record where id in(select product_id from erp_stock.entry where movement_id=p.movement_id union select warehouse_id from erp_stock.entry where movement_id=p.movement_id) order by id for update;
 perform 1 from erp_catalog.product where record_id in(select product_id from erp_stock.entry where movement_id=p.movement_id) order by record_id for update;
 perform 1 from erp_stock.balance b join erp_stock.entry e on e.product_id=b.product_id and e.warehouse_id=b.warehouse_id where e.movement_id=p.movement_id order by b.product_id,b.warehouse_id for update of b;
 select jsonb_agg(jsonb_build_object('product_id',e.product_id,'product_name',r.name,'catalog_version',r.version,'warehouse_id',e.warehouse_id,
  'unit',e.unit,'quantity',(-e.quantity)::text,'balance_before',b.quantity::text,'balance_after',round(b.quantity-e.quantity,6)::text,
  'expected_version',b.version,'sources','[]'::jsonb)||case when erp_stock.balance_kept(p.movement_id,e.product_id,e.warehouse_id) then '{"balance_kept":true}'::jsonb else '{}'::jsonb end
  order by e.product_id,e.warehouse_id) into positions
 from erp_stock.entry e join erp_stock.balance b on b.product_id=e.product_id and b.warehouse_id=e.warehouse_id join erp_catalog.record r on r.id=e.product_id where e.movement_id=p.movement_id;
 if positions is null or jsonb_array_length(positions) not between 1 and 100 or exists(select 1 from jsonb_array_elements(positions) j where
   ((j->>'balance_after')::numeric<0 and(j->>'quantity')::numeric<0 and not erp_stock.negative_allowed() and not coalesce((j->>'balance_kept')::boolean,false))
   or(j->>'balance_after')::numeric>999999999999.999999 or(j->>'expected_version')::integer=2147483647)then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 if v_day<(select occurred_on from erp_stock.movement where id=p.movement_id) then v_day:=(select occurred_on from erp_stock.movement where id=p.movement_id);end if;
 result:=jsonb_build_object('action','reverse','invoice',erp_stock.invoice_summary(v),'posting',erp_stock.invoice_posting_dto(p.id),'direction','reversal','occurred_on',v_day,
  'reason','Estorno do estoque da '||erp_stock.invoice_label(v.model,v.number),'warehouse',jsonb_build_object('id',p.warehouse_id,'name',(select name from erp_catalog.record where id=p.warehouse_id)),
  'positions',positions,'ignored','[]'::jsonb);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end$$;
-- Command lock, replay (same UUID and body) and the conflict of a UUID taken by another stock family.
create function erp_stock.invoice_replay(p_actor uuid,p_command uuid,p_action text,p_invoice uuid,p_hash text)returns jsonb language plpgsql set search_path=pg_catalog as $$
declare c erp_stock.invoice_command;begin
 if p_command is null then raise exception 'erp_invoice_stock_invalid' using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852918,hashtext(p_command::text));perform erp_stock.invoice_access(p_actor,true);
 select * into c from erp_stock.invoice_command where id=p_command;
 if found then
  if c.actor<>p_actor or c.action<>p_action or c.invoice_id<>p_invoice or c.request_hash<>p_hash then raise exception 'erp_invoice_stock_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('flag',erp_stock.invoice_flag(p_invoice),'replayed',true);
 end if;
 if erp_stock.command_taken(p_command)then raise exception 'erp_invoice_stock_conflict' using errcode='40001';end if;
 return null;
end$$;
create function erp_stock.invoice_lock(p_actor uuid,p_invoice uuid,p_version integer)returns erp_fiscal_invoices.invoice language plpgsql set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice;begin
 if p_invoice is null then raise exception 'erp_invoice_stock_invalid' using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852923,hashtext(p_invoice::text));perform erp_stock.invoice_access(p_actor,true);
 select * into v from erp_fiscal_invoices.invoice where id=p_invoice for share;
 if not found then raise exception 'erp_invoice_not_found' using errcode='P0002';end if;
 if p_version is not null and v.version<>p_version then raise exception 'erp_invoice_stock_version_conflict' using errcode='40001';end if;
 return v;
end$$;

-- 4. RPCs: letra E of a page of notes, the stock state of one note, prévia, lançamento, prévia do estorno e estorno.
create function public.erp_stock_invoice_flags(p_user_id uuid,p_ids jsonb)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_stock.invoice_access(p_user_id,false);
 if p_ids is null or jsonb_typeof(p_ids)<>'array' or jsonb_array_length(p_ids) not between 1 and 100
  or exists(select 1 from jsonb_array_elements(p_ids)x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  or(select count(distinct x)from jsonb_array_elements_text(p_ids)x)<>jsonb_array_length(p_ids)then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 select jsonb_build_object('scope','stock_invoice_flags','data_mode','erp_native','items',coalesce(jsonb_agg(jsonb_build_object('invoice_id',v.id)||erp_stock.invoice_flag(v.id) order by v.id),'[]'::jsonb))
  into v_result from erp_fiscal_invoices.invoice v where v.id in(select x::uuid from jsonb_array_elements_text(p_ids)x);
 return v_result;
end$$;
create function public.erp_stock_invoice_get(p_user_id uuid,p_invoice_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice;v_role text;begin
 v_role:=erp_stock.invoice_access(p_user_id,false);
 select * into v from erp_fiscal_invoices.invoice where id=p_invoice_id;
 if not found then raise exception 'erp_invoice_not_found' using errcode='P0002';end if;
 return jsonb_build_object('scope','stock_invoice','data_mode','erp_native','invoice',erp_stock.invoice_summary(v),'flag',erp_stock.invoice_flag(v.id),'block',erp_stock.invoice_block(v),
  'can_manage',v_role in('admin','estoque'),'occurred_on',erp_stock.invoice_day(v.issue_date,v.exit_date),
  'date_mode',coalesce(erp_preferences.get('estoque.data_lancamento')#>>'{}','data_atual'),
  -- Preferências › Notas Fiscais › Configurações de NF-e: "Lançar estoque ao finalizar Check-in na NF de Entrada" (the default of Finalizar).
  'checkin_post',coalesce(erp_preferences.get('nfe.estoque_checkin')='true'::jsonb,false),
  'default_warehouse',(select jsonb_build_object('id',r.id,'name',r.name) from erp_stock.warehouse_default d join erp_catalog.record r on r.id=d.warehouse_id where r.active),
  'postings',coalesce((select jsonb_agg(erp_stock.invoice_posting_dto(p.id) order by p.created_at desc,p.id) from(select * from erp_stock.invoice_posting where invoice_id=v.id order by created_at desc,id limit 20)p),'[]'::jsonb));
end$$;
create function public.erp_stock_invoice_preview(p_user_id uuid,p_invoice_id uuid,p_expected_version integer,p_warehouse_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice;v_block text;begin
 perform erp_stock.invoice_access(p_user_id,true);
 if p_expected_version is null or p_expected_version<1 or p_warehouse_id is null then raise exception 'erp_invoice_stock_invalid' using errcode='22023';end if;
 v:=erp_stock.invoice_lock(p_user_id,p_invoice_id,p_expected_version);v_block:=erp_stock.invoice_block(v);
 if v_block in('deleted','cancelled','denied','no_products') then raise exception 'erp_invoice_stock_ineligible' using errcode='40001',detail=v_block;end if;
 return jsonb_build_object('scope','stock_invoice_preview','data_mode','erp_native','preview',erp_stock.invoice_preview_data(v,p_warehouse_id,'invoice'));
end$$;
create function public.erp_stock_invoice_post(p_user_id uuid,p_command_id uuid,p_invoice_id uuid,p_expected_version integer,p_warehouse_id uuid,p_preview_hash text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;v erp_fiscal_invoices.invoice;v_block text;preview jsonb;items jsonb;movement jsonb;pid uuid;result jsonb;begin
 perform erp_stock.invoice_access(p_user_id,true);
 if p_expected_version is null or p_expected_version<1 or p_warehouse_id is null or p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' then
  raise exception 'erp_invoice_stock_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-invoice-post-259','actor',p_user_id,'invoice_id',p_invoice_id,'version',p_expected_version,
  'warehouse_id',p_warehouse_id,'hash',p_preview_hash)::text,'UTF8')),'hex');
 replay:=erp_stock.invoice_replay(p_user_id,p_command_id,'post',p_invoice_id,h);if replay is not null then return replay;end if;
 v:=erp_stock.invoice_lock(p_user_id,p_invoice_id,p_expected_version);v_block:=erp_stock.invoice_block(v);
 if v_block in('deleted','cancelled','denied','no_products') then raise exception 'erp_invoice_stock_ineligible' using errcode='40001',detail=v_block;end if;
 preview:=erp_stock.invoice_preview_data(v,p_warehouse_id,'invoice');
 if p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_invoice_stock_preview_conflict' using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('product_id',j->'product_id','warehouse_id',j->'warehouse_id','quantity',j->'quantity','expected_version',j->'expected_version') order by j->>'product_id')
  into items from jsonb_array_elements(preview->'positions') j;
 movement:=erp_stock.post(p_user_id,p_command_id,preview->>'direction',(preview->>'occurred_on')::date,preview->>'reason',erp_stock.invoice_label(v.model,v.number),items);
 if coalesce((movement->>'replayed')::boolean,true) then raise exception 'erp_invoice_stock_conflict' using errcode='40001';end if;
 insert into erp_stock.invoice_posting(invoice_id,invoice_version,source,warehouse_id,movement_id,snapshot,preview_hash,actor,command_id)
  values(v.id,v.version,'invoice',p_warehouse_id,(movement#>>'{movement,id}')::uuid,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id) returning id into pid;
 result:=jsonb_build_object('scope','stock_invoice_post','data_mode','erp_native','command_id',p_command_id,'invoice',erp_stock.invoice_summary(v),
  'posting',erp_stock.invoice_posting_dto(pid),'movement',movement->'movement');
 insert into erp_stock.invoice_command(id,actor,action,invoice_id,request_hash,result)values(p_command_id,p_user_id,'post',v.id,h,result);
 return result||jsonb_build_object('flag',erp_stock.invoice_flag(v.id),'replayed',false);
end$$;
create function public.erp_stock_invoice_reverse_preview(p_user_id uuid,p_invoice_id uuid,p_posting_id uuid,p_posting_version integer)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice;p erp_stock.invoice_posting;begin
 perform erp_stock.invoice_access(p_user_id,true);
 if p_posting_id is null or p_posting_version is null or p_posting_version<1 then raise exception 'erp_invoice_stock_invalid' using errcode='22023';end if;
 v:=erp_stock.invoice_lock(p_user_id,p_invoice_id,null);
 select * into p from erp_stock.invoice_posting where id=p_posting_id and invoice_id=v.id for update;
 if not found then raise exception 'erp_invoice_stock_not_found' using errcode='P0002';end if;
 if p.state<>'active' or p.version<>p_posting_version then raise exception 'erp_invoice_stock_version_conflict' using errcode='40001';end if;
 return jsonb_build_object('scope','stock_invoice_reverse_preview','data_mode','erp_native','preview',erp_stock.invoice_reverse_preview_data(v,p));
end$$;
create function public.erp_stock_invoice_reverse(p_user_id uuid,p_command_id uuid,p_invoice_id uuid,p_posting_id uuid,p_posting_version integer,p_preview_hash text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;v erp_fiscal_invoices.invoice;p erp_stock.invoice_posting;preview jsonb;items jsonb;movement jsonb;result jsonb;begin
 perform erp_stock.invoice_access(p_user_id,true);
 if p_posting_id is null or p_posting_version is null or p_posting_version<1 or p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' then
  raise exception 'erp_invoice_stock_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-invoice-reverse-259','actor',p_user_id,'invoice_id',p_invoice_id,'posting_id',p_posting_id,
  'posting_version',p_posting_version,'hash',p_preview_hash)::text,'UTF8')),'hex');
 replay:=erp_stock.invoice_replay(p_user_id,p_command_id,'reverse',p_invoice_id,h);if replay is not null then return replay;end if;
 v:=erp_stock.invoice_lock(p_user_id,p_invoice_id,null);
 select * into p from erp_stock.invoice_posting where id=p_posting_id and invoice_id=v.id for update;
 if not found then raise exception 'erp_invoice_stock_not_found' using errcode='P0002';end if;
 if p.state<>'active' or p.version<>p_posting_version then raise exception 'erp_invoice_stock_version_conflict' using errcode='40001';end if;
 preview:=erp_stock.invoice_reverse_preview_data(v,p);
 if p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_invoice_stock_preview_conflict' using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('product_id',j->'product_id','warehouse_id',j->'warehouse_id','quantity',j->'quantity','expected_version',j->'expected_version') order by j->>'product_id')
  into items from jsonb_array_elements(preview->'positions') j;
 movement:=erp_stock.post(p_user_id,p_command_id,'reversal',(preview->>'occurred_on')::date,preview->>'reason','Estorno '||erp_stock.invoice_label(v.model,v.number),items,p.movement_id);
 if coalesce((movement->>'replayed')::boolean,true) then raise exception 'erp_invoice_stock_conflict' using errcode='40001';end if;
 update erp_stock.invoice_posting set state='reversed',version=version+1,reversal_movement_id=(movement#>>'{movement,id}')::uuid,reversed_at=clock_timestamp(),reversed_by=p_user_id,
  reversal_command_id=p_command_id where id=p.id;
 result:=jsonb_build_object('scope','stock_invoice_reverse','data_mode','erp_native','command_id',p_command_id,'invoice',erp_stock.invoice_summary(v),
  'posting',erp_stock.invoice_posting_dto(p.id),'movement',movement->'movement','balance_adjustments',coalesce(movement->'balance_adjustments','[]'::jsonb));
 insert into erp_stock.invoice_command(id,actor,action,invoice_id,request_hash,result)values(p_command_id,p_user_id,'reverse',v.id,h,result);
 return result||jsonb_build_object('flag',erp_stock.invoice_flag(v.id),'replayed',false);
end$$;

-- 5. Check-in de Recebimentos: "Lançar estoque ao finalizar Check-in". The lines are the Qtde Recebida of the copied items (147), except
-- the refused ones and those without quantity; the check-in must be the current one (not stale, same version) and still open.
create function erp_stock.checkin_post_lines(p_checkin uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('position',i.position,'quantity',i.received::numeric(18,6)::text) order by i.position),'[]'::jsonb)
 from erp_stock.checkin_item i where i.checkin_id=p_checkin and i.received>0 and i.issue is distinct from 'refused'
$$;
create function erp_stock.checkin_post_begin(p_actor uuid,p_invoice uuid,p_expected integer)returns erp_stock.checkin language plpgsql set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice;c erp_stock.checkin;begin
 perform erp_stock.checkin_access(p_actor,true);
 perform pg_advisory_xact_lock(174852922,hashtext(p_invoice::text));
 select * into v from erp_fiscal_invoices.invoice where id=p_invoice for share;
 if not found or v.direction<>'0' then raise exception 'erp_stock_checkin_note_not_found' using errcode='P0002';end if;
 select * into c from erp_stock.checkin where invoice_id=p_invoice for update;
 if c.id is null or c.version<>p_expected then raise exception 'erp_stock_checkin_version_conflict' using errcode='40001';end if;
 if c.state='finished' then raise exception 'erp_stock_checkin_finished' using errcode='40001';end if;
 if not erp_stock.checkin_note_open(v.direction,v.deleted_at,v.status) then raise exception 'erp_stock_checkin_note_closed' using errcode='40001';end if;
 if c.invoice_version<>v.version then raise exception 'erp_stock_checkin_note_changed' using errcode='40001';end if;
 if jsonb_array_length(erp_stock.checkin_post_lines(c.id))=0 then raise exception 'erp_stock_checkin_nothing_received' using errcode='22023';end if;
 return c;
end$$;
create function public.erp_stock_checkin_post_preview(p_user_id uuid,p_invoice_id uuid,p_expected_version integer,p_warehouse_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice;c erp_stock.checkin;begin
 perform erp_stock.invoice_access(p_user_id,true);
 if p_expected_version is null or p_expected_version not between 1 and 2147483645 or p_warehouse_id is null then raise exception 'erp_invoice_stock_invalid' using errcode='22023';end if;
 v:=erp_stock.invoice_lock(p_user_id,p_invoice_id,null);c:=erp_stock.checkin_post_begin(p_user_id,p_invoice_id,p_expected_version);
 return jsonb_build_object('scope','stock_checkin_post_preview','data_mode','erp_native','checkin_version',c.version,
  'preview',erp_stock.invoice_preview_data(v,p_warehouse_id,'checkin',erp_stock.checkin_post_lines(c.id)));
end$$;
create function public.erp_stock_checkin_finish_post(p_user_id uuid,p_command_id uuid,p_invoice_id uuid,p_expected_version integer,p_warehouse_id uuid,p_preview_hash text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;v erp_fiscal_invoices.invoice;c erp_stock.checkin;preview jsonb;finish jsonb;items jsonb;movement jsonb;pid uuid;result jsonb;begin
 perform erp_stock.invoice_access(p_user_id,true);
 if p_expected_version is null or p_expected_version not between 1 and 2147483645 or p_warehouse_id is null or p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' then
  raise exception 'erp_invoice_stock_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-checkin-post-259','actor',p_user_id,'invoice_id',p_invoice_id,'version',p_expected_version,
  'warehouse_id',p_warehouse_id,'hash',p_preview_hash)::text,'UTF8')),'hex');
 replay:=erp_stock.invoice_replay(p_user_id,p_command_id,'checkin',p_invoice_id,h);
 if replay is not null then return replay||jsonb_build_object('checkin',erp_stock.checkin_dto(p_invoice_id));end if;
 v:=erp_stock.invoice_lock(p_user_id,p_invoice_id,null);c:=erp_stock.checkin_post_begin(p_user_id,p_invoice_id,p_expected_version);
 preview:=erp_stock.invoice_preview_data(v,p_warehouse_id,'checkin',erp_stock.checkin_post_lines(c.id));
 if p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_invoice_stock_preview_conflict' using errcode='40001';end if;
 -- "Finalizar" of 147, with a command derived from this one (its own receipt and history), then the entry of the received quantities.
 finish:=public.erp_stock_checkin_finish(p_user_id,erp_stock.supply_part(p_command_id,'checkin-finish'),p_invoice_id,p_expected_version);
 if coalesce((finish->>'replayed')::boolean,true) then raise exception 'erp_invoice_stock_conflict' using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('product_id',j->'product_id','warehouse_id',j->'warehouse_id','quantity',j->'quantity','expected_version',j->'expected_version') order by j->>'product_id')
  into items from jsonb_array_elements(preview->'positions') j;
 movement:=erp_stock.post(p_user_id,p_command_id,'receipt',(preview->>'occurred_on')::date,preview->>'reason',erp_stock.invoice_label(v.model,v.number),items);
 if coalesce((movement->>'replayed')::boolean,true) then raise exception 'erp_invoice_stock_conflict' using errcode='40001';end if;
 insert into erp_stock.invoice_posting(invoice_id,invoice_version,source,warehouse_id,movement_id,snapshot,preview_hash,actor,command_id)
  values(v.id,v.version,'checkin',p_warehouse_id,(movement#>>'{movement,id}')::uuid,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id) returning id into pid;
 result:=jsonb_build_object('scope','stock_checkin_post','data_mode','erp_native','command_id',p_command_id,'invoice',erp_stock.invoice_summary(v),
  'posting',erp_stock.invoice_posting_dto(pid),'movement',movement->'movement','finish_command_id',erp_stock.supply_part(p_command_id,'checkin-finish'));
 insert into erp_stock.invoice_command(id,actor,action,invoice_id,request_hash,result)values(p_command_id,p_user_id,'checkin',v.id,h,result);
 return result||jsonb_build_object('flag',erp_stock.invoice_flag(v.id),'checkin',erp_stock.checkin_dto(v.id),'replayed',false);
end$$;

-- 6. Motor (224): the reversal of a note posting is compensated like the reversal of a document (option off and a later Balanço).
create or replace function erp_stock.post(p_user_id uuid,p_command_id uuid,p_kind text,p_occurred_on date,p_reason text,p_reference text,p_items jsonb,p_reverses_id uuid default null)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare result jsonb;v_items jsonb:=p_items;v_before jsonb;v_after jsonb;v_pre uuid;v_post uuid;v_reason text:='Estorno anterior ao balanço: saldo atual mantido';begin
 perform erp_stock.require_access(p_user_id,true);perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 if not exists(select 1 from erp_stock.command where id=p_command_id) and exists(select 1 from erp_stock.reservation_command where id=p_command_id) then
  raise exception 'erp_stock_command_conflict' using errcode='40001';end if;
 if p_kind='reversal' and p_reverses_id is not null and p_command_id is not null and jsonb_typeof(p_items)='array'
  and not exists(select 1 from erp_stock.command where id=p_command_id)
  and(exists(select 1 from erp_stock.document_posting where movement_id=p_reverses_id)or exists(select 1 from erp_purchase_receipts.receipt where movement_id=p_reverses_id)
   or exists(select 1 from erp_stock.invoice_posting where movement_id=p_reverses_id))then
  -- 224: the positions that keep their balance; a reversal that lowers one is compensated before it, one that raises it after it.
  select jsonb_agg(jsonb_build_object('product_id',i->'product_id','warehouse_id',i->'warehouse_id','quantity',ltrim(i->>'quantity','-'),'expected_version',i->'expected_version'))
   into v_before from jsonb_array_elements(p_items) i
   where jsonb_typeof(i)='object' and i->>'quantity' like '-%' and erp_stock.balance_kept(p_reverses_id,(i->>'product_id')::uuid,(i->>'warehouse_id')::uuid);
  select jsonb_agg(jsonb_build_object('product_id',i->'product_id','warehouse_id',i->'warehouse_id','quantity','-'||(i->>'quantity'),'expected_version',to_jsonb((i->>'expected_version')::bigint+1)))
   into v_after from jsonb_array_elements(p_items) i
   where jsonb_typeof(i)='object' and i->>'quantity' not like '-%' and erp_stock.balance_kept(p_reverses_id,(i->>'product_id')::uuid,(i->>'warehouse_id')::uuid);
  if v_before is not null or v_after is not null then
   v_pre:=erp_stock.derived_command(p_command_id,'before');v_post:=erp_stock.derived_command(p_command_id,'after');
   if v_before is not null then
    select jsonb_agg(case when exists(select 1 from jsonb_array_elements(v_before) b where b->'product_id'=i->'product_id' and b->'warehouse_id'=i->'warehouse_id')
      then jsonb_set(i,'{expected_version}',to_jsonb((i->>'expected_version')::bigint+1)) else i end) into v_items from jsonb_array_elements(p_items) i;
    perform set_config('erp_stock.reversal_compensation',v_pre::text,true);
    perform erp_stock.post_physical_025(p_user_id,v_pre,'adjustment',p_occurred_on,v_reason,null,v_before);
    perform set_config('erp_stock.reversal_compensation','',true);
   end if;
   result:=erp_stock.post_physical_025(p_user_id,p_command_id,p_kind,p_occurred_on,p_reason,p_reference,v_items,p_reverses_id);
   if v_after is not null then
    perform set_config('erp_stock.reversal_compensation',v_post::text,true);
    perform erp_stock.post_physical_025(p_user_id,v_post,'adjustment',p_occurred_on,v_reason,null,v_after);
    perform set_config('erp_stock.reversal_compensation','',true);
   end if;
   perform erp_stock.reservation_write_access(p_user_id);
   return result||jsonb_build_object('balance_adjustments',(select coalesce(jsonb_agg(c.result->'movement' order by c.created_at,c.id),'[]'::jsonb)from erp_stock.command c where c.id in(v_pre,v_post)));
  end if;
 end if;
 result:=erp_stock.post_physical_025(p_user_id,p_command_id,p_kind,p_occurred_on,p_reason,p_reference,p_items,p_reverses_id);
 perform erp_stock.reservation_write_access(p_user_id);return result;
end $$;

-- 7. "Estornar lançamento" do extrato: a lançamento of a note is reversed by the note (as the documents, 018, and the receipts, 090).
create or replace function public.erp_stock_reverse(p_user_id uuid,p_movement_id uuid,p_command_id uuid,p_occurred_on date,p_reason text,p_versions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_items jsonb;v_count integer;v_pre uuid;v_after uuid;v_absorbed jsonb;v_before_items jsonb;v_after_items jsonb;v_result jsonb;v_reason text:='Estorno anterior ao balanço: saldo atual mantido';begin
 perform erp_stock.require_access(p_user_id,true);
 perform pg_advisory_xact_lock(174852909,0);
 if exists(select 1 from erp_purchase_receipts.receipt where movement_id=p_movement_id)or exists(select 1 from erp_purchase_receipts.reversal where movement_id=p_movement_id)then raise exception 'purchase_receipt_reverse_via_receipt'using errcode='40001';end if;
 if exists(select 1 from erp_stock.document_posting where movement_id=p_movement_id or reversal_movement_id=p_movement_id) then raise exception 'erp_stock_reverse_via_document' using errcode='40001';end if;
 if exists(select 1 from erp_stock.invoice_posting where movement_id=p_movement_id or reversal_movement_id=p_movement_id) then raise exception 'erp_stock_reverse_via_invoice' using errcode='40001';end if;
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

-- 8. Extrato (098/105): origem "Notas Fiscais" (the note of the lançamento or of its reversal), its prices for who reads the notes
-- (administrador e fiscal, 113) and the Tipo de Origem filter. The rest is the published body.
create or replace function erp_stock.ledger_origin(p_movement_id uuid)
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
  ), document as (select * from linked where kind in('sales_orders','purchase_orders','service_orders') order by rank limit 1),
  invoice as (select v.id,v.number,v.model,v.direction from erp_stock.invoice_posting p join erp_fiscal_invoices.invoice v on v.id=p.invoice_id
    where p.movement_id=p_movement_id or p.reversal_movement_id=p_movement_id limit 1)
  select coalesce(
    (select jsonb_build_object('type',case kind when 'sales_orders' then 'sales' when 'purchase_orders' then 'purchases' else 'services' end,
      'document_id',id,'document_kind',kind,'document_number',number::text,'via',via) from document),
    (select jsonb_build_object('type','invoices','document_id',id,'document_kind',erp_stock.invoice_screen(model,direction),'document_number',number::text,'via','invoice_stock') from invoice),
    (select jsonb_build_object('type','transfers','document_id',null,'document_kind',null,'document_number',null,'via',null)
      from erp_stock.movement m left join erp_stock.movement o on o.id=m.reverses_id
      where m.id=p_movement_id and (m.kind='transfer' or (m.kind='reversal' and o.kind='transfer'))),
    jsonb_build_object('type','none','document_id',null,'document_kind',null,'document_number',null,'via',null));
$$;
create or replace function erp_stock.ledger_row_105(p_movement_id uuid,p_product_id uuid,p_role text)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d erp_stock.movement_detail;c erp_stock.balance_count;price numeric;cost numeric;source text;v_row jsonb;v_kind text;v_hidden boolean;begin
 v_row:=erp_stock.ledger_row(p_movement_id,p_product_id);v_kind:=v_row#>>'{origin,document_kind}';
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
create or replace function erp_stock.ledger_document_price(p_movement uuid,p_product uuid)returns numeric language sql stable set search_path=pg_catalog as $$
 with doc as(select coalesce(
   (select document_id from erp_stock.document_posting where movement_id=p_movement or reversal_movement_id=p_movement limit 1),
   (select document_id from erp_purchase_receipts.receipt where movement_id=p_movement),
   (select document_id from erp_purchase_receipts.reversal where movement_id=p_movement))id),
 -- 259: a lançamento of a note (or of its check-in) takes the unit price of the note items.
 inv as(select invoice_id id from erp_stock.invoice_posting where movement_id=p_movement or reversal_movement_id=p_movement limit 1),
 prices as(select distinct i.unit_price from erp_documents.item i join doc on i.document_id=doc.id where i.product_id=p_product
  union select distinct i.unit_price from erp_fiscal_invoices.invoice_item i join inv on i.invoice_id=inv.id where i.product_id=p_product)
 select case when(select count(*)from prices)=1 then(select unit_price from prices)end
$$;
create or replace function public.erp_stock_ledger(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null,p_kind text default null,
  p_origin text default null,p_date_from date default null,p_date_to date default null,p_limit integer default 100,p_offset integer default 0,p_direction text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_unit text;v_role text;v_result jsonb;
begin
  perform erp_stock.require_access(p_user_id,false);
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if p_product_id is null or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
    or (p_kind is not null and p_kind not in('receipt','issue','adjustment','transfer','reversal'))
    or (p_origin is not null and p_origin not in('sales','purchases','services','transfers','none','invoices'))
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
    select m.id,m.occurred_on,m.created_at,case when p_origin is null then null else erp_stock.ledger_origin(m.id)->>'type' end origin,
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

-- 9. Custo médio (145): an entry posted by a note without a price detail takes the unit price of the note items, like a pedido de compra.
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
    select l.movement,l.p,case when count(distinct i.unit_price)=1 then min(i.unit_price)end price
    from linked l join erp_fiscal_invoices.invoice_item i on i.invoice_id=l.invoice_id and i.product_id=l.p group by l.movement,l.p)
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

-- 10. The pedido of a note that posted its stock does not post it again (lançamento do documento, 222; recebimento de compra, 224) and
-- leaves the reserva pelas situações de venda (226). The rest of each body is the published one.
create or replace function erp_stock.document_preview_data(d erp_documents.document,p_day date,p_reason text)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare w erp_catalog.record;row record;ignored jsonb:='[]';positions jsonb;result jsonb;direction text;v_lines jsonb:='[]';l record;begin
 perform erp_stock.document_meta(p_day,p_reason);
 if not erp_stock.document_eligible(d.kind,d.status) then raise exception 'erp_document_stock_ineligible_state' using errcode='40001';end if;
 if exists(select 1 from erp_stock.document_posting where document_id=d.id and state='active') then raise exception 'erp_document_stock_already_posted' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);
 -- 259: the stock of a pedido whose note posted it ("S" of the note) is not posted again.
 if erp_stock.invoice_posted_for_document(d.id) then raise exception 'erp_document_stock_posted_by_invoice' using errcode='40001';end if;
 -- The 011 importer takes catalog rows in UUID order; never prelock catalog before the stock lock. 222: the components of the
 -- compositions of the document are locked in the same pass and order.
 perform 1 from erp_catalog.record where id=d.warehouse_id or id in(select product_id from erp_documents.item where document_id=d.id)
  or id in(select c.component_id from erp_documents.item i join erp_stock.composition_current c on c.product_id=i.product_id where i.document_id=d.id) order by id for update;
 perform 1 from erp_catalog.product where record_id in(select product_id from erp_documents.item where document_id=d.id)
  or record_id in(select c.component_id from erp_documents.item i join erp_stock.composition_current c on c.product_id=i.product_id where i.document_id=d.id) order by record_id for update;
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
  elsif row.format='V' or(row.format='E' and d.kind='purchase_orders') then raise exception 'erp_document_stock_composition_unsupported' using errcode='22023';
  elsif row.unit is distinct from row.data->>'unit' then raise exception 'erp_document_stock_unit_mismatch' using errcode='22023';
  elsif row.format='E' then
   for l in select * from erp_stock.composition_lines(row.product_id,row.quantity) loop
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',l.quantity::text,'source',case when l.role='composition'
     then jsonb_build_object('id',row.id,'position',row.position,'quantity',row.quantity::numeric(18,6)::text)
     else jsonb_build_object('id',row.id,'position',row.position,'quantity',l.quantity::numeric(18,6)::text,'kit_product_id',row.product_id,
      'kit_quantity',row.quantity::numeric(18,6)::text,'component_quantity',l.per_kit::numeric(18,6)::text)end));
   end loop;
  else
   v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',row.product_id,'quantity',row.quantity::text,
    'source',jsonb_build_object('id',row.id,'position',row.position,'quantity',row.quantity::text)));
  end if;
 end loop;
 direction:=case when d.kind='purchase_orders' then 'receipt' else 'issue' end;
 with lines as(select(j->>'product_id')::uuid product_id,(j->>'quantity')::numeric qty,j->'source' source from jsonb_array_elements(v_lines)j),
 groups as(select product_id,sum(qty) qty,jsonb_agg(source order by(source->>'position')::integer) sources from lines group by product_id)
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

create or replace function erp_purchase_receipts.preview(p_actor uuid,d erp_documents.document,p_action text,p_day date,p_reason text,p_items jsonb,p_receipt uuid default null)
returns jsonb language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare r erp_purchase_receipts.receipt;selection jsonb;lines jsonb:='[]';positions jsonb;w erp_catalog.record;row record;qty numeric;net numeric;result jsonb;begin
 perform erp_stock.document_meta(p_day,p_reason);
 if p_action not in('receive','reverse')or p_action is null then raise exception 'purchase_receipt_input_invalid'using errcode='22023';end if;
 if exists(select 1 from erp_stock.document_posting where document_id=d.id)then raise exception 'purchase_receipt_legacy_mode'using errcode='40001';end if;
 if p_action='receive'then
  if not erp_stock.document_eligible(d.kind,d.status)then raise exception 'purchase_receipt_ineligible_state'using errcode='40001';end if;
  if p_items is null or jsonb_typeof(p_items)<>'array'or jsonb_array_length(p_items)not between 1 and 250 or octet_length(p_items::text)>131072 then raise exception 'purchase_receipt_items_invalid'using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(p_items)j where jsonb_typeof(j)<>'object'or jsonb_typeof(j->'item_id')is distinct from'string'
   or coalesce(j->>'item_id','')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'or jsonb_typeof(j->'quantity')is distinct from'string'
   or coalesce(j->>'quantity','')!~'^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$'or exists(select 1 from jsonb_object_keys(j)k where k not in('item_id','quantity')))then raise exception 'purchase_receipt_items_invalid'using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(p_items)j where(j->>'quantity')::numeric<=0)
   or exists(select 1 from jsonb_array_elements(p_items)j group by j->>'item_id'having count(*)>1)
   or exists(select 1 from jsonb_array_elements(p_items)j where not exists(select 1 from erp_documents.item where id=(j->>'item_id')::uuid and document_id=d.id))then raise exception 'purchase_receipt_items_invalid'using errcode='22023';end if;
  selection:=p_items;
 else
  select * into r from erp_purchase_receipts.receipt where id=p_receipt and document_id=d.id;
  if r.id is null then raise exception 'purchase_receipt_not_found'using errcode='P0002';end if;
  if exists(select 1 from erp_purchase_receipts.reversal where receipt_id=r.id)then raise exception 'purchase_receipt_already_reversed'using errcode='40001';end if;
  if p_day<(r.snapshot->>'occurred_on')::date then raise exception 'purchase_receipt_reversal_date_invalid'using errcode='22023';end if;
  select jsonb_agg(jsonb_build_object('item_id',j->'item_id','quantity',j->'quantity'))into selection from jsonb_array_elements(r.snapshot->'items')j;
 end if;
 -- Same business-lock order as018/070. All sources are reread after the mutex/catalog waits.
 perform pg_advisory_xact_lock(174852909,0);perform erp_purchase_receipts.access(p_actor);
 -- 259: a pedido de compra whose entry note posted the stock ("S" of the note) is not received again.
 if p_action='receive' and erp_stock.invoice_posted_for_document(d.id) then raise exception 'purchase_receipt_posted_by_invoice' using errcode='40001';end if;
 perform 1 from erp_catalog.record where id=d.warehouse_id or id in(select i.product_id from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid where i.document_id=d.id)order by id for update;
 perform erp_purchase_receipts.access(p_actor);
 perform 1 from erp_catalog.product where record_id in(select i.product_id from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid where i.document_id=d.id)order by record_id for update;
 perform erp_purchase_receipts.access(p_actor);
 perform 1 from erp_stock.balance where warehouse_id=d.warehouse_id and product_id in(select i.product_id from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid where i.document_id=d.id)order by product_id,warehouse_id for update;
 perform erp_purchase_receipts.access(p_actor,true);
 select c.* into w from erp_catalog.record c join erp_catalog.warehouse x on x.record_id=c.id where c.id=d.warehouse_id;
 if w.id is null or(p_action='receive'and not w.active)then raise exception 'purchase_receipt_warehouse_unavailable'using errcode='22023';end if;
 for row in select i.*,c.active,c.version catalog_version,p.unit product_unit,p.kind product_kind,p.format,j->>'quantity' requested
  from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid
  left join erp_catalog.record c on c.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id where i.document_id=d.id order by i.position loop
  if row.product_id is null or row.product_kind is distinct from'P'or row.product_unit is null or(p_action='receive'and(not coalesce(row.active,false)or row.format in('E','V')))then raise exception 'purchase_receipt_product_unavailable'using errcode='22023';end if;
  if row.product_unit is distinct from row.data->>'unit'then raise exception 'purchase_receipt_unit_mismatch'using errcode='22023';end if;
  qty:=row.requested::numeric*case when p_action='receive'then 1 else -1 end;net:=erp_purchase_receipts.received(d.id,row.id);
  if net+qty<0 or net+qty>row.quantity then raise exception 'purchase_receipt_quantity_exceeded'using errcode='40001';end if;
  lines:=lines||jsonb_build_array(jsonb_build_object('item_id',row.id,'position',row.position,'product_id',row.product_id,'unit',row.product_unit,'ordered_quantity',row.quantity::text,
   'quantity',qty::numeric(18,6)::text,'received_before',net::numeric(18,6)::text,'received_after',(net+qty)::numeric(18,6)::text,'remaining_after',(row.quantity-net-qty)::numeric(18,6)::text));
 end loop;
 if jsonb_array_length(lines)<>jsonb_array_length(selection)then raise exception 'purchase_receipt_items_changed'using errcode='40001';end if;
 -- Check numeric range before formatting numeric(18,6); a full position must
 -- produce the same closed business conflict, never an intermediate cast overflow.
 -- 224: a reversed position that keeps its balance (Balanço after the receipt, option off) is not refused for its balance.
 if exists(select 1 from(select(j->>'product_id')::uuid product_id,sum((j->>'quantity')::numeric)qty from jsonb_array_elements(lines)j group by j->>'product_id')g
  left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id
  where((g.qty<0 and coalesce(b.quantity,0)+g.qty<0 and not erp_stock.negative_allowed())
  or coalesce(b.quantity,0)+g.qty>999999999999.999999 or coalesce(b.quantity,0)+g.qty<-999999999999.999999
  or(g.qty<0 and erp_stock.reserved_quantity(g.product_id,w.id)>0 and coalesce(b.quantity,0)+g.qty-erp_stock.reserved_quantity(g.product_id,w.id)<0))
  and not(p_action='reverse' and erp_stock.balance_kept(r.movement_id,g.product_id,w.id))or b.version=2147483647)then
  raise exception 'purchase_receipt_balance_unavailable'using errcode='40001';end if;
 with groups as(select(j->>'product_id')::uuid product_id,sum((j->>'quantity')::numeric)qty from jsonb_array_elements(lines)j group by j->>'product_id')
 select jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',c.name,'warehouse_id',w.id,'unit',p.unit,'quantity',g.qty::numeric(18,6)::text,
  'catalog_version',c.version,'physical_version',coalesce(b.version,0),'reservation_hash',erp_stock.reservation_position_hash(g.product_id,w.id),
  'physical_before',coalesce(b.quantity,0)::numeric(18,6)::text,'reserved_before',q.qty::numeric(18,6)::text,'available_before',(coalesce(b.quantity,0)-q.qty)::numeric(18,6)::text,
  'physical_after',(coalesce(b.quantity,0)+g.qty)::numeric(18,6)::text,'available_after',(coalesce(b.quantity,0)+g.qty-q.qty)::numeric(18,6)::text)
  -- 224: the conferência of the reversal says which positions keep their balance (the compensation is posted with the reversal).
  ||case when p_action='reverse' and erp_stock.balance_kept(r.movement_id,g.product_id,w.id) then '{"balance_kept":true}'::jsonb else '{}'::jsonb end order by g.product_id)into positions
 from groups g join erp_catalog.record c on c.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id cross join lateral(select erp_stock.reserved_quantity(g.product_id,w.id)qty)q;
 if positions is null or jsonb_array_length(positions)not between 1 and 100 then raise exception 'purchase_receipt_position_limit'using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(positions)j where(((j->>'quantity')::numeric<0 and(j->>'physical_after')::numeric<0 and not erp_stock.negative_allowed())
  or(j->>'physical_after')::numeric>999999999999.999999 or(j->>'physical_after')::numeric<-999999999999.999999
  or((j->>'quantity')::numeric<0 and(j->>'reserved_before')::numeric>0 and(j->>'available_after')::numeric<0))
  and not(p_action='reverse' and erp_stock.balance_kept(r.movement_id,(j->>'product_id')::uuid,w.id))or(j->>'physical_version')::integer=2147483647)then raise exception 'purchase_receipt_balance_unavailable'using errcode='40001';end if;
 result:=jsonb_build_object('action',p_action,'document',erp_purchase_receipts.document(d.id),'receipt_id',p_receipt,'occurred_on',p_day,'reason',btrim(p_reason),
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'items',lines,'positions',positions);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end$$;

create or replace function erp_stock.situation_reservations(p_product uuid default null)
returns table(document_id uuid,document_number bigint,status text,contact_name text,product_id uuid,warehouse_id uuid,quantity numeric,unit text)
language sql stable set search_path=pg_catalog as $$
 with s as(select erp_stock.reserve_statuses() statuses,(erp_stock.settings_dto()->>'reserve_by_warehouse')::boolean by_warehouse,
   (select d.warehouse_id from erp_stock.warehouse_default d where d.singleton) standard),
 items as(select d.id,d.number,d.status,d.contact_snapshot,d.warehouse_id,i.product_id,i.quantity,p.unit,p.format
  from s cross join erp_documents.document d join erp_documents.item i on i.document_id=d.id join erp_catalog.product p on p.record_id=i.product_id
  where cardinality(s.statuses)>0 and d.kind='sales_orders' and d.status=any(s.statuses)
   -- One product (Saldos do produto): its own items and the composition items that have it as a component, as the 145 filter did.
   and(p_product is null or i.product_id=p_product or exists(select 1 from erp_stock.composition_current c where c.product_id=i.product_id and c.component_id=p_product))
   and p.kind='P' and p.unit is not null and i.data->>'unit' is not distinct from p.unit
   and not exists(select 1 from erp_stock.document_posting x where x.document_id=d.id and x.state='active')
   -- 259: a pedido whose note posted the stock has no reservation left.
   and not erp_stock.invoice_posted_for_document(d.id)
   and not exists(select 1 from erp_stock.reservation r where r.document_id=d.id and r.state='active')),
 -- 222: a composition item reserves what its lançamento would move; a composition without a structure reserves nothing.
 lines as(select x.id,x.number,x.status,x.contact_snapshot,x.warehouse_id,x.product_id target,x.quantity qty,x.unit target_unit from items x where x.format is distinct from 'E'
  union all
  select x.id,x.number,x.status,x.contact_snapshot,x.warehouse_id,x.product_id,x.quantity,x.unit from items x join erp_stock.composition c on c.product_id=x.product_id
   where x.format='E' and c.post_mode in('product','both')
  union all
  select x.id,x.number,x.status,x.contact_snapshot,x.warehouse_id,ci.component_id,x.quantity*ci.quantity,cp.unit from items x join erp_stock.composition_current ci on ci.product_id=x.product_id
   join erp_catalog.product cp on cp.record_id=ci.component_id
   where x.format='E' and ci.post_mode in('components','both') and cp.kind='P' and cp.unit is not null)
 select l.id,l.number,l.status,l.contact_snapshot->>'name',l.target,case when s.by_warehouse then coalesce(l.warehouse_id,s.standard)end,sum(l.qty),l.target_unit
 from s cross join lines l where p_product is null or l.target=p_product
 group by l.id,l.number,l.status,l.contact_snapshot,l.target,l.target_unit,s.by_warehouse,s.standard,l.warehouse_id
$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_purchase_receipts from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_invoice_flags','erp_stock_invoice_get','erp_stock_invoice_preview','erp_stock_invoice_post','erp_stock_invoice_reverse_preview','erp_stock_invoice_reverse',
 'erp_stock_checkin_post_preview','erp_stock_checkin_finish_post','erp_stock_reverse','erp_stock_ledger')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
