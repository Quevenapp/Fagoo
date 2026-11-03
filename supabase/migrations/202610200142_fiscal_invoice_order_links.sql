-- Vínculo da nota com pedidos e trava de edição pelo pedido de venda:
-- 1. "Vincular à pedido de compra" / "Desvincular pedido de compra" (e o mesmo com pedidos de venda nas notas de saída),
--    um comando idempotente por vínculo, com versão esperada, revisão e auditoria;
-- 2. "Bloquear edição da nota quando o estoque/a conta foi lançado(a) pela venda" (Preferências › Configurações de NF-e):
--    a leitura da nota informa a trava e a gravação recusa mudar itens ou parcelas travados.
-- Só lê os indicadores de efeito dos pedidos (erp_documents.effect_flags); nada aqui lança estoque, contas ou emite.
begin;
-- Effects already posted by the linked sales orders (stock and finance), read from the documents lane helper.
create function erp_fiscal_invoices.order_effects(p_id uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare stock boolean:=false;finance boolean:=false;f jsonb;o uuid;
begin
 for o in select i.document_id from erp_fiscal_invoices.invoice_order i join erp_documents.document d on d.id=i.document_id where i.invoice_id=p_id and d.kind='sales_orders' loop
  f:=erp_documents.effect_flags(o);
  stock:=stock or coalesce((f->>'stock_active')::boolean,false);finance:=finance or coalesce((f->>'finance_active')::boolean,false);
 end loop;
 return jsonb_build_object('stock',stock,'finance',finance);
end $$;
create function erp_fiscal_invoices.edit_locks(p_id uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare e jsonb:=erp_fiscal_invoices.order_effects(p_id);
begin
 return jsonb_build_object('items',(e->>'stock')::boolean and (erp_fiscal_invoices.preference('nfe.bloquear_edicao_estoque','boolean','false'))::text::boolean,
  'installments',(e->>'finance')::boolean and (erp_fiscal_invoices.preference('nfe.bloquear_edicao_contas','boolean','false'))::text::boolean);
end $$;
-- What a lock protects: products and quantities of the items (and the linked orders), dates and amounts of the parcels.
create function erp_fiscal_invoices.items_signature(p_items jsonb) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_array(x->>'product_id',(x->>'quantity')::numeric) order by n),'[]'::jsonb) from jsonb_array_elements(p_items) with ordinality t(x,n)
$$;
create function erp_fiscal_invoices.installments_signature(p_payment jsonb) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_array(x->>'date',(x->>'amount')::numeric) order by n),'[]'::jsonb) from jsonb_array_elements(coalesce(p_payment->'installments','[]'::jsonb)) with ordinality t(x,n)
$$;

create or replace function public.erp_fiscal_invoice_get(p_user_id uuid,p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);r jsonb;
begin
 if p_id is null then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 r:=erp_fiscal_invoices.invoice_record(p_id);
 if r is null then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 return erp_fiscal_invoices.invoice_envelope(r,role)||jsonb_build_object('locks',erp_fiscal_invoices.edit_locks(p_id));
end $$;

create or replace function public.erp_fiscal_invoice_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;keys text[];v_id uuid;expected integer;v erp_fiscal_invoices.invoice%rowtype;d jsonb;rec jsonb;result jsonb;reason text;locks jsonb;
begin
 role:=erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_action is null or p_action not in('create','update','delete') or p_data is null or jsonb_typeof(p_data)<>'object' then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 keys:=case p_action when 'create' then array['invoice','orders'] when 'update' then array['id','expected_version','invoice','orders'] else array['id','expected_version','reason'] end;
 if exists(select 1 from jsonb_object_keys(p_data) k where not k=any(keys)) or not p_data ?& (case p_action when 'create' then array['invoice'] when 'update' then array['id','expected_version','invoice'] else array['id','expected_version','reason'] end) then
  raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 if p_action in('create','update') then d:=erp_fiscal_invoices.invoice_input(p_data->'invoice'); end if;
 if p_action<>'create' then v_id:=erp_fiscal_invoices.uuid_input(p_data->'id');expected:=erp_fiscal_invoices.version_input(p_data->'expected_version'); end if;
 -- Origin asks for the reason of every deletion; the database requires it too, not only the Worker.
 if p_action='delete' then reason:=erp_fiscal_invoices.text_input(p_data->'reason',1000,true);
  if length(reason)<3 then raise exception 'erp_fiscal_invoice_reason_invalid' using errcode='22023'; end if; end if;
 h:=erp_fiscal_invoices.command_hash(p_user_id,'invoice',p_action,p_data);
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'invoice',h);
 if replay is not null then return replay; end if;
 if p_action<>'create' then
  select * into v from erp_fiscal_invoices.invoice where id=v_id for update;
  if not found then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
  if v.version<>expected or v.version=2147483647 or v.deleted_at is not null then raise exception 'erp_fiscal_invoice_version_conflict' using errcode='40001'; end if;
 end if;
 -- A nature deleted by "Excluir as operações selecionadas" (141) stays on the notes that already carry it, but no note takes it anew.
 if p_action in('create','update') and exists(select 1 from erp_fiscal_invoices.nature n
   where n.deleted_at is not null and n.id in(select (d->>'nature_id')::uuid union select (x->>'nature_id')::uuid from jsonb_array_elements(d->'items') x)
    and (p_action='create' or (n.id is distinct from v.nature_id
     and not exists(select 1 from erp_fiscal_invoices.invoice_item i where i.invoice_id=v_id and i.data->>'nature_id'=n.id::text)))) then
  raise exception 'erp_fiscal_invoice_nature_not_found' using errcode='22023'; end if;
 if p_action='update' then
  if v.status not in(1,5,8,12) then raise exception 'erp_fiscal_invoice_not_editable' using errcode='40001'; end if;
  if d->>'model'<>v.model or d->>'direction'<>v.direction or (d->>'environment') is distinct from v.environment then raise exception 'erp_fiscal_invoice_type_immutable' using errcode='22023'; end if;
  -- Imported XML notes (S/X, migration 143) keep the XML as their source: the form never rewrites them, not even as "Emitida por Terceiros".
  if v.issue_type in('S','X') then raise exception 'erp_fiscal_invoice_not_editable' using errcode='40001'; end if;
  -- "Bloquear edição da nota quando o estoque/a conta foi lançado(a) pela venda": items or parcels of a locked note stay as they are.
  locks:=erp_fiscal_invoices.edit_locks(v_id);
  if (locks->>'items')::boolean and erp_fiscal_invoices.items_signature(d->'items')
   <>erp_fiscal_invoices.items_signature(coalesce((select jsonb_agg(i.data order by i.position) from erp_fiscal_invoices.invoice_item i where i.invoice_id=v_id),'[]'::jsonb)) then
   raise exception 'erp_fiscal_invoice_locked_by_order' using errcode='40001'; end if;
  if (locks->>'installments')::boolean and erp_fiscal_invoices.installments_signature(d->'payment')<>erp_fiscal_invoices.installments_signature(v.payment) then
   raise exception 'erp_fiscal_invoice_locked_by_order' using errcode='40001'; end if;
  if ((locks->>'items')::boolean or (locks->>'installments')::boolean)
   and coalesce((select array_agg(x order by x) from (select distinct erp_fiscal_invoices.uuid_input(e) x from jsonb_array_elements(erp_fiscal_invoices.array_input(p_data->'orders',20)) e) s),'{}'::uuid[])
    <>coalesce((select array_agg(o.document_id order by o.document_id) from erp_fiscal_invoices.invoice_order o where o.invoice_id=v_id),'{}'::uuid[]) then
   raise exception 'erp_fiscal_invoice_locked_by_order' using errcode='40001'; end if;
 end if;
 if p_action='create' then
  insert into erp_fiscal_invoices.invoice(model,direction,issue_type,environment,status,series,number,access_key,nature_id,nature_description,cfop,issue_date,exit_date,exit_time,
   crt,purpose,credit_debit_type,presence,final_consumer,recipient,export,import_declaration,doc_references,transport,payment,authorized_xml,intermediary,additional_info,
   nature_additional_info,nature_fiscal_info,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by)
  values(d->>'model',d->>'direction',d->>'issue_type',d->>'environment',(d->>'status')::smallint,(d->>'series')::integer,(d->>'number')::integer,d->>'access_key',
   (d->>'nature_id')::uuid,d->>'nature_description',d->>'cfop',(d->>'issue_date')::date,(d->>'exit_date')::date,d->>'exit_time',d->>'crt',d->>'purpose',d->>'credit_debit_type',
   d->>'presence',(d->>'final_consumer')::boolean,d->'recipient',nullif(d->'export','null'::jsonb),nullif(d->'import_declaration','null'::jsonb),d->'references',d->'transport',
   d->'payment',d->'authorized_xml',d->'intermediary',d->>'additional_info',d->>'nature_additional_info',d->>'nature_fiscal_info',(d->>'auto_tax')::boolean,
   (d->>'freight')::numeric,(d->>'insurance')::numeric,(d->>'other_expenses')::numeric,(d->>'discount')::numeric,d->'totals',p_user_id,p_user_id) returning id into v_id;
 elsif p_action='update' then
  update erp_fiscal_invoices.invoice set issue_type=d->>'issue_type',
   series=(d->>'series')::integer,number=(d->>'number')::integer,access_key=case when d->>'issue_type' in('T','S','X') then d->>'access_key' else v.access_key end,
   nature_id=(d->>'nature_id')::uuid,nature_description=d->>'nature_description',cfop=d->>'cfop',issue_date=(d->>'issue_date')::date,exit_date=(d->>'exit_date')::date,
   exit_time=d->>'exit_time',crt=d->>'crt',purpose=d->>'purpose',credit_debit_type=d->>'credit_debit_type',presence=d->>'presence',final_consumer=(d->>'final_consumer')::boolean,
   recipient=d->'recipient',export=nullif(d->'export','null'::jsonb),import_declaration=nullif(d->'import_declaration','null'::jsonb),doc_references=d->'references',
   transport=d->'transport',payment=d->'payment',authorized_xml=d->'authorized_xml',intermediary=d->'intermediary',additional_info=d->>'additional_info',
   nature_additional_info=d->>'nature_additional_info',nature_fiscal_info=d->>'nature_fiscal_info',auto_tax=(d->>'auto_tax')::boolean,freight=(d->>'freight')::numeric,
   insurance=(d->>'insurance')::numeric,other_expenses=(d->>'other_expenses')::numeric,discount=(d->>'discount')::numeric,totals=d->'totals',
   version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 else
  update erp_fiscal_invoices.invoice set deleted_at=clock_timestamp(),deleted_by=p_user_id,delete_reason=reason,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 end if;
 if p_action in('create','update') then
  perform erp_fiscal_invoices.store_items(v_id,d->'items');
  perform erp_fiscal_invoices.store_orders(v_id,d->>'direction',p_data->'orders');
 end if;
 rec:=erp_fiscal_invoices.invoice_record(v_id);
 insert into erp_fiscal_invoices.invoice_revision(invoice_id,version,record) values(v_id,(rec->>'version')::integer,rec);
 result:=erp_fiscal_invoices.invoice_envelope(rec,role)||jsonb_build_object('action',p_action,'replayed',false);
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'invoice',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'invoice',v_id,(rec->>'version')::integer,p_action,reason);
 return result;
end $$;

-- "Vincular à pedido de compra" / "Desvincular pedido de compra": one link per command. Entry notes link purchase orders and
-- exit notes link sales orders, like the V letter of the lists. Origin notes are linked in Origin.
create function public.erp_fiscal_invoice_link(p_user_id uuid,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;v erp_fiscal_invoices.invoice%rowtype;v_id uuid;expected integer;doc uuid;action text;rec jsonb;result jsonb;
begin
 role:=erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_data is null or jsonb_typeof(p_data)<>'object' or exists(select 1 from jsonb_object_keys(p_data) k where k not in('invoice_id','expected_version','action','document_id'))
  or not p_data ?& array['invoice_id','expected_version','action','document_id'] or jsonb_typeof(p_data->'action') is distinct from 'string' or p_data->>'action' not in('link','unlink') then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 v_id:=erp_fiscal_invoices.uuid_input(p_data->'invoice_id');doc:=erp_fiscal_invoices.uuid_input(p_data->'document_id');expected:=erp_fiscal_invoices.version_input(p_data->'expected_version');action:=p_data->>'action';
 h:=erp_fiscal_invoices.command_hash(p_user_id,'invoice',action||'_order',p_data);
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'invoice',h);
 if replay is not null then return replay; end if;
 select * into v from erp_fiscal_invoices.invoice where id=v_id for update;
 if not found then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 if v.version<>expected or v.version=2147483647 or v.deleted_at is not null then raise exception 'erp_fiscal_invoice_version_conflict' using errcode='40001'; end if;
 if not exists(select 1 from erp_documents.document d where d.id=doc and d.kind=case v.direction when '1' then 'sales_orders' else 'purchase_orders' end) then
  raise exception 'erp_fiscal_invoice_order_not_found' using errcode='22023'; end if;
 if action='link' then
  if exists(select 1 from erp_fiscal_invoices.invoice_order where invoice_id=v_id and document_id=doc) then raise exception 'erp_fiscal_invoice_order_state_conflict' using errcode='40001'; end if;
  if (select count(*) from erp_fiscal_invoices.invoice_order where invoice_id=v_id)>=20 then raise exception 'erp_fiscal_invoice_order_limit' using errcode='22023'; end if;
  insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values(v_id,doc);
 else
  if not exists(select 1 from erp_fiscal_invoices.invoice_order where invoice_id=v_id and document_id=doc) then raise exception 'erp_fiscal_invoice_order_state_conflict' using errcode='40001'; end if;
  if (erp_fiscal_invoices.edit_locks(v_id)->>'items')::boolean or (erp_fiscal_invoices.edit_locks(v_id)->>'installments')::boolean then
   raise exception 'erp_fiscal_invoice_locked_by_order' using errcode='40001'; end if;
  delete from erp_fiscal_invoices.invoice_order where invoice_id=v_id and document_id=doc;
 end if;
 update erp_fiscal_invoices.invoice set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 rec:=erp_fiscal_invoices.invoice_record(v_id);
 insert into erp_fiscal_invoices.invoice_revision(invoice_id,version,record) values(v_id,(rec->>'version')::integer,rec);
 result:=erp_fiscal_invoices.invoice_envelope(rec,role)||jsonb_build_object('action',action||'_order','replayed',false,'document_id',doc);
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'invoice',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'invoice',v_id,(rec->>'version')::integer,action||'_order',doc::text);
 return result;
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_invoice_get(uuid,uuid),public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb),public.erp_fiscal_invoice_link(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_get(uuid,uuid),public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb),public.erp_fiscal_invoice_link(uuid,uuid,jsonb) to service_role;
commit;
