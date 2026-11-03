-- 184: Depósito escolhido ao lançar o estoque do documento, como no Origin ("Lançar estoque" abre o modal "Depósitos" /
-- "Selecione o depósito" quando o pedido não tem depósito ou para trocar o depósito). Requer 018, 070, 090, 100 e 182.
-- O documento não é alterado: o depósito escolhido fica no lançamento (snapshot da 018, recibo da 090) e no razão. Nenhum
-- movimento, saldo, recibo ou documento existente é reescrito.
-- - Pedido de venda, OS e pedido de compra lançado por inteiro (018): prévia e lançamento com o depósito escolhido, pelo mesmo
--   motor (erp_stock.document_preview_data e erp_stock.post), com versão do documento (CAS), hash da prévia, comando idempotente
--   (o depósito faz parte do corpo do comando), auditoria, política de estoque negativo (100/182) e a recusa com reserva ativa (070).
--   O estorno continua sendo o do documento (erp_document_stock_reverse), pelo depósito do próprio lançamento.
-- - Pedido de compra recebido por itens (090): "Lançar estoque" recebe o pendente no depósito escolhido quando o pedido não tem
--   depósito. O estorno de um recebimento passa a usar o depósito do próprio recebimento (igual ao do pedido nos recebimentos que
--   já existem, porque o pedido com recebimento ativo não muda); o hash dos comandos sem depósito escolhido é o publicado.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_stock.document_preview_data(erp_documents.document,date,text)')is null or to_regprocedure('erp_stock.sales_negative_allowed()')is null then
  raise exception 'stock_document_warehouse_184_requires_182' using errcode='55000';end if;
 for r in select * from(values
  ('erp_purchase_receipts.apply(uuid,uuid,integer,text,date,text,jsonb,uuid,uuid,text,boolean)','a7358dfd28d9d772d5c8a9c31731d880b5d03a7626bcea05bb8daf9cec7143f4'),
  ('public.erp_purchase_receipts_reverse_preview(uuid,uuid,integer,uuid,date,text)','b1caeb0f5dd4906b4a5eac6daa5b4242ff621cf7847778b706492c9d8e35a186'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_document_warehouse_184_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 1. Lançamento inteiro do documento (018) no depósito escolhido.
create function public.erp_stock_document_warehouse_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_warehouse_id uuid,p_occurred_on date,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 if p_warehouse_id is null then raise exception 'erp_document_stock_warehouse_required' using errcode='22023';end if;
 d:=erp_stock.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 d.warehouse_id:=p_warehouse_id;
 return jsonb_build_object('preview',erp_stock.document_preview_data(d,p_occurred_on,p_reason),'data_mode','erp_native');
end $$;
-- The body of erp_document_stock_post (018) with the chosen warehouse in the command data and in the document read under lock.
create function public.erp_stock_document_warehouse_post(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_warehouse_id uuid,p_command_id uuid,p_preview_hash text,
  p_occurred_on date,p_reason text,p_ignored_item_ids jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;pid uuid;result jsonb;ack jsonb;wanted jsonb;begin
 data:=jsonb_build_object('kind',p_kind,'id',p_document_id,'version',p_expected_version,'warehouse_id',p_warehouse_id,'hash',p_preview_hash,'date',p_occurred_on,'reason',p_reason,'ignored',p_ignored_item_ids);
 replay:=erp_stock.document_command_start(p_user_id,p_command_id,'post',data);if replay is not null then return replay;end if;
 if p_warehouse_id is null then raise exception 'erp_document_stock_warehouse_required' using errcode='22023';end if;
 d:=erp_stock.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);d.warehouse_id:=p_warehouse_id;preview:=erp_stock.document_preview_data(d,p_occurred_on,p_reason);
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_stock_preview_conflict' using errcode='40001';end if;
 if p_ignored_item_ids is null or jsonb_typeof(p_ignored_item_ids)<>'array' or jsonb_array_length(p_ignored_item_ids)>250
  or exists(select 1 from jsonb_array_elements(p_ignored_item_ids) j where jsonb_typeof(j)<>'string' or(j#>>'{}')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then raise exception 'erp_document_stock_ignored_ack_required' using errcode='22023';end if;
 select coalesce(jsonb_agg(value order by value),'[]') into ack from jsonb_array_elements(p_ignored_item_ids);
 select coalesce(jsonb_agg(value->'id' order by value->'id'),'[]') into wanted from jsonb_array_elements(preview->'ignored');
 if ack<>wanted then raise exception 'erp_document_stock_ignored_ack_required' using errcode='22023';end if;
 if exists(select 1 from erp_stock.command where id=p_command_id) then raise exception 'erp_document_stock_command_conflict' using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('product_id',j->'product_id','warehouse_id',j->'warehouse_id','quantity',j->'quantity','expected_version',j->'expected_version') order by j->>'product_id') into items from jsonb_array_elements(preview->'positions') j;
 movement:=erp_stock.post(p_user_id,p_command_id,preview->>'direction',p_occurred_on,p_reason,'Documento '||d.kind||' '||d.number::text,items);
 insert into erp_stock.document_posting(document_id,document_version,movement_id,snapshot,preview_hash,actor,command_id)
  values(d.id,d.version,(movement#>>'{movement,id}')::uuid,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id) returning id into pid;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_stock.document_posting_summary(pid),'movement',movement->'movement','warehouse_id',p_warehouse_id);
 insert into erp_stock.document_audit(actor,command_id,document_id,posting_id,action,result) values(p_user_id,p_command_id,d.id,pid,'post',result);
 insert into erp_documents.audit(actor,command_id,document_id,action,after_data) values(p_user_id,p_command_id,d.id,'stock_post',result);
 return erp_stock.document_command_finish(p_user_id,p_command_id,'post',data,result);
end $$;

-- 2. Recebimento do pedido de compra (090) no depósito escolhido. apply_warehouse is the published apply with the chosen warehouse
-- (receive) and the warehouse of the receipt itself (reverse); the request hash of a command without a chosen warehouse is the published one.
create function erp_purchase_receipts.apply_warehouse(p_actor uuid,p_document uuid,p_version integer,p_action text,p_day date,p_reason text,p_items jsonb,p_receipt uuid,p_command uuid,p_hash text,p_confirm boolean,p_warehouse uuid)
returns jsonb language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare d erp_documents.document;c erp_purchase_receipts.command;request_hash text;preview jsonb;items jsonb;movement jsonb;original_movement uuid;id uuid;result jsonb;begin
 perform erp_purchase_receipts.access(p_actor);
 if p_command is null or p_confirm is distinct from true or p_hash is null or p_hash!~'^[a-f0-9]{64}$'
 or p_action not in('receive','reverse')or p_action is null then raise exception 'purchase_receipt_input_invalid'using errcode='22023';end if;
 request_hash:=encode(sha256(convert_to((jsonb_build_object('actor',p_actor,'document_id',p_document,'version',p_version,'action',p_action,'occurred_on',p_day,'reason',p_reason,'items',p_items,'receipt_id',p_receipt,'preview_hash',p_hash,'confirm',p_confirm)||case when p_warehouse is null then '{}'::jsonb else jsonb_build_object('warehouse_id',p_warehouse)end)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command::text));perform erp_purchase_receipts.access(p_actor);
 select *into c from erp_purchase_receipts.command where command.id=p_command;
 if c.id is not null then
  perform erp_purchase_receipts.access(p_actor,true);
  if c.actor<>p_actor or c.request_hash<>request_hash then raise exception 'purchase_receipt_command_conflict'using errcode='40001';end if;
  return jsonb_build_object('scope','purchase_receipts','data_mode','erp_native','receipt',c.result,'current',erp_purchase_receipts.current(c.document_id),'replayed',true);
 end if;
 d:=erp_purchase_receipts.lock_document(p_actor,p_document,p_version);
 -- 184: the chosen warehouse of a receipt (only when the order has none, or the same one) and the warehouse of the receipt for its reversal.
 if p_action='receive' and p_warehouse is not null then
  if d.warehouse_id is not null and d.warehouse_id<>p_warehouse then raise exception 'purchase_receipt_warehouse_conflict' using errcode='22023';end if;
  d.warehouse_id:=p_warehouse;
 elsif p_action='reverse' then
  d.warehouse_id:=coalesce((select(r.snapshot#>>'{warehouse,id}')::uuid from erp_purchase_receipts.receipt r where r.id=p_receipt and r.document_id=d.id),d.warehouse_id);
 end if;
 preview:=erp_purchase_receipts.preview(p_actor,d,p_action,p_day,p_reason,p_items,p_receipt);
 if p_hash<>preview->>'preview_hash'then raise exception 'purchase_receipt_preview_changed'using errcode='40001';end if;
 -- Global009 and command018 mutexes are held; old and new command families cannot mix.
 if exists(select 1 from erp_stock.command where command.id=p_command)
 or exists(select 1 from erp_stock.document_command where document_command.id=p_command)
 or exists(select 1 from erp_stock.reservation_command where reservation_command.id=p_command)then raise exception 'purchase_receipt_command_conflict'using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('product_id',j->'product_id','warehouse_id',j->'warehouse_id','quantity',j->'quantity','expected_version',j->'physical_version')order by j->>'product_id')into items from jsonb_array_elements(preview->'positions')j;
 if p_action='reverse'then select movement_id into original_movement from erp_purchase_receipts.receipt where receipt.id=p_receipt;end if;
 movement:=erp_stock.post(p_actor,p_command,case when p_action='receive'then'receipt'else'reversal'end,p_day,p_reason,'Recebimento compra '||d.number::text,items,original_movement);
 if p_action='receive'then
  insert into erp_purchase_receipts.receipt(document_id,source_document_version,document_version,command_id,movement_id,actor,snapshot,preview_hash)
  values(d.id,d.version,d.version+1,p_command,(movement#>>'{movement,id}')::uuid,p_actor,preview-'preview_hash',p_hash)returning receipt.id into id;
 else
  insert into erp_purchase_receipts.reversal(receipt_id,document_id,source_document_version,document_version,command_id,movement_id,actor,snapshot,preview_hash)
  values(p_receipt,d.id,d.version,d.version+1,p_command,(movement#>>'{movement,id}')::uuid,p_actor,preview-'preview_hash',p_hash)returning reversal.id into id;
 end if;
 update erp_documents.document set version=version+1,updated_by=p_actor,updated_at=clock_timestamp()where document.id=d.id;
 result:=jsonb_build_object('command_id',p_command,'action',p_action,'document_id',d.id,'document_version',d.version+1,
 'receipt',erp_purchase_receipts.record(case when p_action='receive'then id else p_receipt end),
 'reversal',case when p_action='reverse'then erp_purchase_receipts.record(id,true)end);
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,after_data)values(p_actor,p_command,d.id,'purchase_'||p_action,btrim(p_reason),result);
 insert into erp_purchase_receipts.command(id,actor,document_id,action,request_hash,result)values(p_command,p_actor,d.id,p_action,request_hash,result);
 -- auth.users KEY SHARE and membership SHARE remain held through deferred FK checks/commit.
 perform erp_purchase_receipts.access(p_actor);
 return jsonb_build_object('scope','purchase_receipts','data_mode','erp_native','receipt',result,'current',erp_purchase_receipts.current(d.id),'replayed',false);
end$$;
create or replace function erp_purchase_receipts.apply(p_actor uuid,p_document uuid,p_version integer,p_action text,p_day date,p_reason text,p_items jsonb,p_receipt uuid,p_command uuid,p_hash text,p_confirm boolean)
returns jsonb language sql set search_path=pg_catalog set timezone='UTC' as $$
 select erp_purchase_receipts.apply_warehouse(p_actor,p_document,p_version,p_action,p_day,p_reason,p_items,p_receipt,p_command,p_hash,p_confirm,null)
$$;
create or replace function public.erp_purchase_receipts_reverse_preview(p_user_id uuid,p_document_id uuid,p_expected_version integer,p_receipt_id uuid,p_occurred_on date,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$declare d erp_documents.document;begin
 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
 -- 184: the warehouse of the receipt itself (the document's warehouse for every receipt made without a chosen one).
 d.warehouse_id:=coalesce((select(r.snapshot#>>'{warehouse,id}')::uuid from erp_purchase_receipts.receipt r where r.id=p_receipt_id and r.document_id=d.id),d.warehouse_id);
 return jsonb_build_object('scope','purchase_receipts','data_mode','erp_native','preview',erp_purchase_receipts.preview(p_user_id,d,'reverse',p_occurred_on,p_reason,null,p_receipt_id));
end$$;
-- "Lançar estoque" do pedido de compra sem depósito: prévia e recebimento no depósito escolhido (igual ao do pedido, quando ele tem).
create function public.erp_stock_purchase_receive_preview(p_user_id uuid,p_document_id uuid,p_expected_version integer,p_warehouse_id uuid,p_occurred_on date,p_reason text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$declare d erp_documents.document;begin
 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
 if p_warehouse_id is null or(d.warehouse_id is not null and d.warehouse_id<>p_warehouse_id)then raise exception 'purchase_receipt_warehouse_conflict' using errcode='22023';end if;
 d.warehouse_id:=p_warehouse_id;
 return jsonb_build_object('scope','purchase_receipts','data_mode','erp_native','preview',erp_purchase_receipts.preview(p_user_id,d,'receive',p_occurred_on,p_reason,p_items));
end$$;
create function public.erp_stock_purchase_receive(p_user_id uuid,p_document_id uuid,p_expected_version integer,p_warehouse_id uuid,p_occurred_on date,p_reason text,p_items jsonb,
  p_command_id uuid,p_preview_hash text,p_confirm boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$begin
 if p_warehouse_id is null then raise exception 'purchase_receipt_warehouse_conflict' using errcode='22023';end if;
 return erp_purchase_receipts.apply_warehouse(p_user_id,p_document_id,p_expected_version,'receive',p_occurred_on,p_reason,p_items,null,p_command_id,p_preview_hash,p_confirm,p_warehouse_id);
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_purchase_receipts from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_document_warehouse_preview','erp_stock_document_warehouse_post','erp_purchase_receipts_reverse_preview','erp_stock_purchase_receive_preview','erp_stock_purchase_receive')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
