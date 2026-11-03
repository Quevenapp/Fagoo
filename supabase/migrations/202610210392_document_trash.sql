-- Leva H, lane documentos (VND-015, VND-166): lixeira de propostas, pedidos de venda, pedidos de compra e ordens de serviço.
-- * Excluir é lógico e só para documentos sem efeitos: sem estoque ou contas lançados, sem nota fiscal ligada, sem reserva de
--   estoque, sem faturamento agrupado, sem leituras de checkout e sem documento gerado a partir dele. Com efeitos, o caminho é
--   cancelar e estornar (a recusa diz o motivo).
-- * Restaurar devolve o documento como estava. Enquanto está na lixeira ele não muda: nem itens, nem situação, nem efeitos novos.
-- * A lista operacional deixa os excluídos de fora; a situação "Excluídos" mostra a lixeira. Os painéis de Meu Negócio também os
--   deixam de fora. Movimentos válidos nunca saem dos saldos (documento com movimento não vai para a lixeira).
-- * Cada comando (excluir ou restaurar vários) é gravado uma vez e auditado por documento.
-- As funções substituídas são conferidas pelo hash; outra versão interrompe a migração.
begin;

do $$declare r record;begin
 for r in select * from(values
  ('public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid,text[],jsonb)','67ad7c59efb44d2b3a6fb8402a3ec7e309cbd0da93c77dd1102ea332ad677f1b'),
  ('erp_home.biz_orders(date,date,text[])','0701bfcfad8468348cad7fc32724eacdbe6c4c71c11b23ca494054b9a6c8bffd'))v(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.hash then
   raise exception 'document_trash_392_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
 if to_regprocedure('public.erp_document_trash(uuid,uuid,text,text,jsonb,text)') is not null then raise exception 'document_trash_392_already_applied' using errcode='55000'; end if;
end$$;

alter table erp_documents.document add column deleted_at timestamptz,add column deleted_by uuid references auth.users(id),add column delete_reason text,
 add constraint document_deleted_fields check((deleted_at is null and deleted_by is null and delete_reason is null) or (deleted_at is not null and deleted_by is not null and delete_reason is not null and length(delete_reason) between 3 and 1000));

-- Por que o documento não pode ir para a lixeira (null: pode).
create function erp_documents.trash_blocker(p_id uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare f jsonb:=erp_documents.effect_flags(p_id);
begin
 if (f->>'stock_active')::boolean then return 'stock_posted'; end if;
 if (f->>'finance_active')::boolean then return 'finance_posted'; end if;
 if exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id where o.document_id=p_id and n.deleted_at is null) then return 'invoice_linked'; end if;
 if exists(select 1 from erp_stock.reservation r where r.document_id=p_id and r.state='active') then return 'stock_reserved'; end if;
 if exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=p_id and g.active) then return 'grouped_billing'; end if;
 if exists(select 1 from erp_documents.checkout c where c.document_id=p_id and jsonb_array_length(c.reads)>0) then return 'checkout'; end if;
 if exists(select 1 from erp_documents.document d where d.source_proposal_id=p_id and d.deleted_at is null) then return 'generated_document'; end if;
 return null;
end $$;

-- Na lixeira nada muda; excluir e restaurar só mexem nos campos da exclusão.
create function erp_documents.guard_trash() returns trigger language plpgsql set search_path=pg_catalog as $$
declare k text[]:=array['deleted_at','deleted_by','delete_reason','version','updated_at','updated_by'];
begin
 if old.deleted_at is not null and new.deleted_at is not null then raise exception 'erp_document_deleted' using errcode='40001'; end if;
 if old.deleted_at is distinct from new.deleted_at and (to_jsonb(new)-k) is distinct from (to_jsonb(old)-k) then raise exception 'erp_document_deleted' using errcode='40001'; end if;
 return new;
end $$;
create trigger guard_trash before update on erp_documents.document for each row execute function erp_documents.guard_trash();
create function erp_documents.guard_trash_child() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if exists(select 1 from erp_documents.document d where d.id=(case when tg_op='DELETE' then old.document_id else new.document_id end) and d.deleted_at is not null) then
  raise exception 'erp_document_deleted' using errcode='40001'; end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger guard_trash before insert or update or delete on erp_documents.item for each row execute function erp_documents.guard_trash_child();
create trigger guard_trash before insert on erp_stock.document_posting for each row execute function erp_documents.guard_trash_child();
create trigger guard_trash before insert on erp_finance.document_posting for each row execute function erp_documents.guard_trash_child();
create trigger guard_trash before insert on erp_fiscal_invoices.invoice_order for each row execute function erp_documents.guard_trash_child();
create trigger guard_trash before insert on erp_stock.reservation for each row execute function erp_documents.guard_trash_child();
create trigger guard_trash before insert on erp_finance.grouped_billing_document for each row execute function erp_documents.guard_trash_child();
create trigger guard_trash before insert or update on erp_documents.checkout for each row execute function erp_documents.guard_trash_child();

create function erp_documents.trash_key(p_kind text) returns text language sql immutable set search_path=pg_catalog as $$
 select case p_kind when 'sales_proposals' then 'vendas.propostas.ex' when 'sales_orders' then 'vendas.pedidos_venda.ex'
  when 'purchase_orders' then 'suprimentos.pedidos_compra.ex' when 'service_orders' then 'servicos.ordem_servico.ex' end
$$;

-- Excluir (para a lixeira) ou Restaurar os documentos selecionados: até 100 por comando; o resultado diz o de cada um.
create function public.erp_document_trash(p_user_id uuid,p_command_id uuid,p_kind text,p_action text,p_ids jsonb,p_reason text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_prior erp_documents.command; v_ids uuid[]; v_id uuid; d erp_documents.document; v_block text; v_results jsonb:='[]'; v_result jsonb; v_reason text;
begin
 if p_kind is null or p_kind not in('sales_proposals','sales_orders','purchase_orders','service_orders') or p_action is null or p_action not in('delete','restore') or p_command_id is null
  or p_ids is null or jsonb_typeof(p_ids)<>'array' or jsonb_array_length(p_ids) not between 1 and 100 then raise exception 'erp_document_trash_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if not erp_access.permitted(p_user_id,erp_documents.trash_key(p_kind)) then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 v_reason:=nullif(btrim(coalesce(p_reason,'')),'');
 if p_action='delete' and (v_reason is null or length(v_reason) not between 3 and 1000) then raise exception 'erp_document_trash_reason' using errcode='22023'; end if;
 if p_action='restore' then v_reason:=null; end if;
 select array_agg(distinct (x#>>'{}')::uuid order by (x#>>'{}')::uuid) into v_ids from jsonb_array_elements(p_ids) x;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('kind',p_kind,'action',p_action,'ids',to_jsonb(v_ids),'reason',v_reason)::text,'UTF8')),'hex');
 select * into v_prior from erp_documents.command where command_id=p_command_id;
 if found then
  if v_prior.actor<>p_user_id or v_prior.request_hash<>v_hash then raise exception 'erp_document_command_conflict' using errcode='40001'; end if;
  return v_prior.result||jsonb_build_object('replayed',true);
 end if;
 foreach v_id in array v_ids loop
  select * into d from erp_documents.document where id=v_id and kind=p_kind for update;
  if not found or not erp_documents.contact_usable(p_user_id,d.contact_id) then v_results:=v_results||jsonb_build_object('id',v_id,'ok',false,'reason','not_found'); continue; end if;
  if (p_action='delete')=(d.deleted_at is not null) then v_results:=v_results||jsonb_build_object('id',v_id,'ok',true,'reason',null); continue; end if;
  if p_action='delete' then
   v_block:=erp_documents.trash_blocker(v_id);
   if v_block is not null then v_results:=v_results||jsonb_build_object('id',v_id,'ok',false,'reason',v_block); continue; end if;
   update erp_documents.document set deleted_at=clock_timestamp(),deleted_by=p_user_id,delete_reason=v_reason,version=version+1,updated_at=clock_timestamp(),updated_by=p_user_id where id=v_id;
  else
   update erp_documents.document set deleted_at=null,deleted_by=null,delete_reason=null,version=version+1,updated_at=clock_timestamp(),updated_by=p_user_id where id=v_id;
  end if;
  insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
   values(p_user_id,p_command_id,v_id,case p_action when 'delete' then 'trash' else 'restore' end,v_reason,jsonb_build_object('deleted',d.deleted_at is not null,'version',d.version),
    jsonb_build_object('deleted',p_action='delete','version',d.version+1));
  v_results:=v_results||jsonb_build_object('id',v_id,'ok',true,'reason',null);
 end loop;
 v_result:=jsonb_build_object('scope','document_trash','data_mode','erp_native','kind',p_kind,'action',p_action,'command_id',p_command_id,'results',v_results);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result||jsonb_build_object('replayed',false);
end $$;

create or replace function public.erp_document_list(p_user_id uuid, p_kind text, p_limit integer DEFAULT 25, p_after uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_date_from text DEFAULT NULL::text, p_date_to text DEFAULT NULL::text, p_page integer DEFAULT NULL::integer, p_order text DEFAULT 'id'::text, p_statuses text[] DEFAULT NULL::text[], p_date_type text DEFAULT 'date'::text, p_warehouse_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid, p_city text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_technician text DEFAULT NULL::text, p_equipment text DEFAULT NULL::text, p_serial_number text DEFAULT NULL::text, p_internal_note text DEFAULT NULL::text, p_postal_code text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_tracking_code text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_carrier text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_template boolean DEFAULT NULL::boolean, p_situations text[] DEFAULT NULL::text[], p_seller_id uuid DEFAULT NULL::uuid, p_component_id uuid DEFAULT NULL::uuid, p_service_id uuid DEFAULT NULL::uuid, p_lots text[] DEFAULT NULL::text[], p_custom jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_role text; v_fiscal boolean; v_stock boolean; v_statuses text[]; v_query text; v_digits text; v_from date; v_to date; v_offset bigint;
 v_cursor erp_documents.document%rowtype; v_cursor_day text; v_items jsonb; v_more boolean; v_last uuid; v_count bigint; v_amount numeric;
 v_city text; v_technician text; v_equipment text; v_serial text; v_note text;
 v_postal text; v_district text; v_tracking text; v_po text; v_carrier text; v_email text;
 v_warranty text:=coalesce(erp_documents.preference('os.garantia_base')#>>'{}','nao_utilizar');
 v_scope uuid:=erp_catalog.contact_scope(p_user_id);
 -- 289: Lote (até 50 lotes separados por ;) and Busca customizada (Adicionar filtros).
 v_lots text[]; v_conditions jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 v_fiscal:=v_role in ('admin','fiscal');
 v_stock:=v_role in ('admin','consulta','estoque','vendas','fiscal');
 v_statuses:=case when p_statuses is not null then p_statuses when p_status is not null then array[p_status] end;
 if p_limit is null or p_limit not between 1 and 100
  or (p_status is not null and p_statuses is not null)
  or (v_statuses is not null and (coalesce(cardinality(v_statuses),0) not between 1 and 20 or array_position(v_statuses,null) is not null
   or exists(select 1 from unnest(v_statuses) s where not ((erp_documents.transitions()->p_kind)?s or s='deleted'))
   or (select count(distinct s) from unnest(v_statuses) s)<>cardinality(v_statuses)))
  or (p_situations is not null and (v_statuses is not null or not erp_documents.situation_adopted(p_kind) or coalesce(cardinality(p_situations),0) not between 1 and 50
   or array_position(p_situations,null) is not null or exists(select 1 from unnest(p_situations) s where not erp_documents.situation_key_valid(p_kind,s))
   or (select count(distinct s) from unnest(p_situations) s)<>cardinality(p_situations)))
  or length(p_query)>120 or p_query ~ '[[:cntrl:]]'
  or (p_date_from is not null and p_date_from !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_date_to is not null and p_date_to !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_page is not null and (p_page not between 1 and 100000 or p_after is not null))
  or p_order is null or p_order not in ('date_desc','date_asc','number_desc','number_asc','id')
  or p_date_type is null or p_date_type not in ('date','expected_date','next_contact','ship_date','finish_date','warranty_until')
  or (p_date_type='next_contact' and p_kind<>'sales_proposals')
  or (p_date_type='ship_date' and p_kind not in ('sales_orders','service_orders'))
  or (p_date_type in ('finish_date','warranty_until') and p_kind<>'service_orders')
  or ((p_city is not null or p_state is not null) and p_kind not in ('sales_orders','sales_proposals'))
  or ((p_technician is not null or p_equipment is not null or p_serial_number is not null) and p_kind<>'service_orders')
  or (p_internal_note is not null and p_kind<>'purchase_orders')
  or ((p_postal_code is not null or p_district is not null or p_tracking_code is not null or p_customer_po_number is not null or p_carrier is not null) and p_kind<>'sales_orders')
  or ((p_contact_email is not null or p_template is not null) and p_kind<>'sales_proposals')
  or (p_seller_id is not null and p_kind not in ('sales_orders','sales_proposals','service_orders'))
  or (p_component_id is not null and p_kind<>'sales_orders')
  -- 268: the filters Peça (p_product_id) and Serviço (p_service_id) of the ordens de serviço.
  or (p_service_id is not null and p_kind<>'service_orders')
  -- 289: Lote of the pedidos de venda and of the OS: 1 to 50 codes.
  or (p_lots is not null and (p_kind not in('sales_orders','service_orders') or coalesce(cardinality(p_lots),0) not between 1 and 50 or array_position(p_lots,null) is not null
   or exists(select 1 from unnest(p_lots) x where char_length(btrim(x)) not between 1 and 60 or x~'[[:cntrl:]]')))
  or length(p_city)>100 or length(p_technician)>200 or length(p_equipment)>200 or length(p_serial_number)>100 or length(p_internal_note)>200
  or length(p_district)>100 or length(p_tracking_code)>200 or length(p_customer_po_number)>60 or length(p_carrier)>200 or length(p_contact_email)>254
  or (p_postal_code is not null and p_postal_code!~'^[0-9]{1,8}$')
  or concat(p_city,p_technician,p_equipment,p_serial_number,p_internal_note,p_district,p_tracking_code,p_customer_po_number,p_carrier,p_contact_email) ~ '[[:cntrl:]]'
  or (p_state is not null and p_state !~ '^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$') then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_city:=lower(nullif(btrim(p_city),''));v_technician:=lower(nullif(btrim(p_technician),''));v_equipment:=lower(nullif(btrim(p_equipment),''));
 v_serial:=lower(nullif(btrim(p_serial_number),''));v_note:=lower(nullif(btrim(p_internal_note),''));
 v_postal:=p_postal_code;v_district:=lower(nullif(btrim(p_district),''));v_tracking:=lower(nullif(btrim(p_tracking_code),''));
 v_po:=lower(nullif(btrim(p_customer_po_number),''));v_carrier:=lower(nullif(btrim(p_carrier),''));v_email:=lower(nullif(btrim(p_contact_email),''));
 if (p_city is not null and v_city is null) or (p_technician is not null and v_technician is null) or (p_equipment is not null and v_equipment is null)
  or (p_serial_number is not null and v_serial is null) or (p_internal_note is not null and v_note is null)
  or (p_district is not null and v_district is null) or (p_tracking_code is not null and v_tracking is null) or (p_customer_po_number is not null and v_po is null)
  or (p_carrier is not null and v_carrier is null) or (p_contact_email is not null and v_email is null) then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_lots:=case when p_lots is not null then array(select distinct lower(btrim(x)) from unnest(p_lots) x) end;
 v_conditions:=erp_documents.list_conditions(p_kind,p_custom);
 v_from:=erp_documents.date_value(to_jsonb(p_date_from));
 v_to:=erp_documents.date_value(to_jsonb(p_date_to));
 if v_from>v_to then raise exception 'erp_document_period_invalid' using errcode='22023'; end if;
 v_query:=lower(nullif(btrim(p_query),''));
 v_digits:=case when v_query ~ '^[0-9./ -]+$' then regexp_replace(v_query,'[^0-9]','','g') end;
 if length(v_digits)<5 then v_digits:=null; end if;
 if p_after is not null and p_order<>'id' then
  select * into v_cursor from erp_documents.document where id=p_after and kind=p_kind;
  if not found then raise exception 'erp_document_cursor_invalid' using errcode='22023'; end if;
  v_cursor_day:=v_cursor.body->>'date';
 end if;
 v_offset:=case when p_page is null then 0 else (p_page-1)::bigint*p_limit end;
 with filtered as materialized(
  select d.id,d.number,d.body->>'date' as day,d.total from erp_documents.document d
  left join erp_documents.document_situation ds on ds.document_id=d.id
  where d.kind=p_kind
   -- Leva H (392): "Excluídos" (deleted) lists the lixeira; every other filter leaves the excluded documents out.
   and (case when v_statuses is not null and 'deleted'=any(v_statuses) then d.deleted_at is not null else d.deleted_at is null and (v_statuses is null or d.status=any(v_statuses)) end)
   and (p_situations is null or coalesce(ds.situation_id::text,d.status)=any(p_situations))
   and (p_seller_id is null or d.body->>'seller_id'=p_seller_id::text)
   -- 238: Preferências › Contatos "Contato acessível somente ao vendedor vinculado": the documents of the contacts of the seller.
   and (v_scope is null or exists(select 1 from erp_catalog.contact_profile cp where cp.record_id=d.contact_id and cp.seller_id=v_scope))
   -- 238: Origin "Componente": pedidos with a product whose current structure (Estoque › composições) has the component.
   and (p_component_id is null or exists(select 1 from erp_documents.item i join erp_stock.composition_current c on c.product_id=i.product_id
    where i.document_id=d.id and c.component_id=p_component_id))
   and (v_from is null and v_to is null
    or p_date_type='date' and (v_from is null or d.body->>'date'>=p_date_from) and (v_to is null or d.body->>'date'<=p_date_to)
    or p_date_type='expected_date' and (v_from is null or d.body->>'expected_date'>=p_date_from) and (v_to is null or d.body->>'expected_date'<=p_date_to)
    or p_date_type='next_contact' and (v_from is null or d.body->>'next_contact'>=p_date_from) and (v_to is null or d.body->>'next_contact'<=p_date_to)
    or p_date_type='ship_date' and (v_from is null or d.body->>'ship_date'>=p_date_from) and (v_to is null or d.body->>'ship_date'<=p_date_to)
    or p_date_type='finish_date' and (v_from is null or d.body->>'finish_date'>=p_date_from) and (v_to is null or d.body->>'finish_date'<=p_date_to)
    or p_date_type='warranty_until' and d.body->>'warranty_days' is not null
     and (v_from is null or erp_documents.warranty_until(d.body,v_warranty)>=v_from)
     and (v_to is null or erp_documents.warranty_until(d.body,v_warranty)<=v_to))
   and (p_warehouse_id is null or d.warehouse_id=p_warehouse_id)
   and (p_product_id is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=p_product_id))
   and (p_service_id is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=p_service_id))
   -- 289: Lote: a lot informed in an item (Informar lotes) or posted by the stock of the document (Informar lotes of the line, 278).
   and (v_lots is null or exists(select 1 from erp_documents.item i cross join jsonb_array_elements(case when jsonb_typeof(i.data->'lots')='array' then i.data->'lots' else '[]'::jsonb end) l
     join erp_stock.lot x on x.id::text=l->>'lot_id' where i.document_id=d.id and lower(x.code)=any(v_lots))
    or exists(select 1 from erp_stock.document_posting sp join erp_stock.lot_entry e on e.movement_id=sp.movement_id join erp_stock.lot x on x.id=e.lot_id
     where sp.document_id=d.id and sp.state='active' and lower(x.code)=any(v_lots)))
   -- 289: Busca customizada: every condition of Adicionar filtros.
   and (v_conditions is null or erp_documents.list_conditions_match(d,v_conditions))
   and (v_city is null or strpos(lower(coalesce(d.contact_snapshot->>'city','')),v_city)>0)
   and (p_state is null or upper(coalesce(d.contact_snapshot->>'state',''))=p_state)
   and (v_technician is null or strpos(lower(coalesce(d.body->>'technician','')),v_technician)>0)
   and (v_equipment is null or strpos(lower(coalesce(d.body->>'equipment','')),v_equipment)>0)
   and (v_serial is null or strpos(lower(coalesce(d.body->>'serial_number','')),v_serial)>0)
   and (v_note is null or strpos(lower(coalesce(d.body->>'internal_notes','')),v_note)>0)
   and (v_postal is null or strpos(regexp_replace(coalesce(d.contact_snapshot->>'postal_code',''),'[^0-9]','','g'),v_postal)=1
    or strpos(coalesce(d.body#>>'{delivery_address,postal_code}',''),v_postal)=1)
   and (v_district is null or strpos(lower(coalesce(d.contact_snapshot->>'district','')),v_district)>0
    or strpos(lower(coalesce(d.body#>>'{delivery_address,district}','')),v_district)>0)
   and (v_tracking is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,tracking_code}','')),v_tracking)>0)
   and (v_po is null or strpos(lower(coalesce(d.body->>'customer_po_number','')),v_po)>0)
   and (v_carrier is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,carrier_reference,label}','')),v_carrier)>0
    or exists(select 1 from erp_catalog.record r where r.id::text=d.body->>'carrier_id' and strpos(lower(r.name),v_carrier)>0))
   and (v_email is null or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_email)>0)
   and (p_template is null or coalesce(d.body->'template'='true'::jsonb,false)=p_template)
   and (v_query is null or strpos(d.number::text,v_query)>0 or d.id::text=v_query
    or strpos(lower(coalesce(d.contact_snapshot->>'name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'trade_name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'code','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_query)>0
    or (p_kind='purchase_orders' and strpos(lower(coalesce(d.body->>'order_reference','')),v_query)>0)
    or (v_digits is not null and strpos(regexp_replace(coalesce(d.contact_snapshot->>'document',''),'[^0-9]','','g'),v_digits)>0)
    or (v_digits is not null and p_kind='service_orders' and strpos(regexp_replace(coalesce(d.contact_snapshot->>'postal_code',''),'[^0-9]','','g'),v_digits)>0))
 ), ordered as materialized(
  select f.id,row_number() over(order by
    case when p_order='id' then f.id end,
    case when p_order='date_desc' then f.day end desc,
    case when p_order='date_asc' then f.day end,
    case when p_order in ('date_desc','number_desc') then f.number end desc,
    case when p_order in ('date_asc','number_asc') then f.number end) as position
  from filtered f
  where p_after is null
   or (p_order='id' and f.id>p_after)
   or (p_order='date_desc' and (f.day,f.number)<(v_cursor_day,v_cursor.number))
   or (p_order='date_asc' and (f.day,f.number)>(v_cursor_day,v_cursor.number))
   or (p_order='number_desc' and f.number<v_cursor.number)
   or (p_order='number_asc' and f.number>v_cursor.number)
 ), page as materialized(
  select id,position from ordered where position>v_offset and position<=v_offset+p_limit+1
 )
 select coalesce((select jsonb_agg(erp_documents.list_row(id,v_fiscal,v_stock) order by position) from page where position<=v_offset+p_limit),'[]'::jsonb),
  (select count(*) from page)>p_limit,
  (select id from page where position<=v_offset+p_limit order by position desc limit 1),
  (select count(*) from filtered),(select coalesce(sum(total),0) from filtered)
 into v_items,v_more,v_last,v_count,v_amount;
 return jsonb_build_object('kind',p_kind,'items',v_items,'limit',p_limit,'page',p_page,
  'order',p_order,'has_more',v_more,'next_cursor',case when v_more then v_last end,
  'total_count',v_count,'total_amount',case when erp_documents.list_totals_visible(p_user_id,p_kind) then v_amount::numeric(20,2)::text end,
  'data_mode','erp_native','operational_effects',false);
end $function$;


create or replace function erp_home.biz_orders(p_from date,p_to date,p_statuses text[])
returns table(id uuid,number bigint,day date,status text,contact_id uuid,contact_name text,channel text,seller text,state text,total numeric,freight numeric,units numeric,warehouse_id uuid)
language sql stable set search_path=pg_catalog as $$
 select d.id,d.number,(d.body->>'date')::date,d.status,d.contact_id,coalesce(erp_home.biz_text(d.contact_snapshot->>'name',200),'Contato sem nome'),
  erp_home.biz_channel(d.body),erp_home.biz_seller(d.body),erp_home.biz_state(d.body,d.contact_snapshot),d.total,erp_home.biz_freight(d.body),
  coalesce((select sum(i.quantity) from erp_documents.item i where i.document_id=d.id),0),d.warehouse_id
 from erp_documents.document d
 where d.kind='sales_orders' and d.deleted_at is null and d.status=any(p_statuses) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_from and p_to
$$;

revoke all on function erp_documents.trash_blocker(uuid),erp_documents.guard_trash(),erp_documents.guard_trash_child(),erp_documents.trash_key(text),erp_home.biz_orders(date,date,text[])
 from public,anon,authenticated,service_role;
revoke all on function public.erp_document_trash(uuid,uuid,text,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_trash(uuid,uuid,text,text,jsonb,text) to service_role;
revoke all on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid,text[],jsonb) from public,anon,authenticated;
grant execute on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid,text[],jsonb) to service_role;
commit;
