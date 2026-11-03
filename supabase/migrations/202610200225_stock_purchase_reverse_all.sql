-- 225: Pedidos de compra > ⋮ "Estornar estoque" como no Origin: uma confirmação ("Estorno de estoque - Confirmar estorno de estoque?")
-- estorna todos os recebimentos ativos do pedido (090), com a data de hoje (America/Sao_Paulo) e o motivo automático
-- "Estorno do pedido de compra N", num único comando: tudo ou nada. Requer 090, 184 e 224. Cada recebimento é estornado pelo próprio
-- caminho do recebimento (erp_purchase_receipts.apply_warehouse, no depósito do recebimento), com comando derivado, versão do pedido,
-- prévia, auditoria do documento e a regra "Considerar estorno ... se houver balanço" (224). Nenhum recebimento existente é reescrito.
begin;

do $$begin
 if to_regprocedure('erp_purchase_receipts.apply_warehouse(uuid,uuid,integer,text,date,text,jsonb,uuid,uuid,text,boolean,uuid)')is null
  or to_regprocedure('erp_stock.balance_kept(uuid,uuid,uuid)')is null or to_regprocedure('erp_stock.supply_part(uuid,text)')is null then
  raise exception 'stock_purchase_reverse_all_225_requires_184_224' using errcode='55000';end if;
 if exists(select 1 from pg_constraint where conname='supply_command_action_check' and conrelid='erp_stock.supply_command'::regclass
   and pg_get_constraintdef(oid) like '%purchase_reverse_all%')then raise exception 'stock_purchase_reverse_all_225_already_applied' using errcode='55000';end if;
end$$;

-- The receipt of the command (one immutable row per accepted command, 183) gets the new action.
alter table erp_stock.supply_command drop constraint supply_command_action_check;
alter table erp_stock.supply_command add constraint supply_command_action_check check(action in('transfer_batch','initial_balance','purchase_reverse_all'));

create function public.erp_stock_purchase_reverse_all(p_user_id uuid,p_command_id uuid,p_document_id uuid,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare h text;c erp_stock.supply_command;d erp_documents.document;v_day date;v_reason text;v_version integer;r record;v_preview jsonb;v_applied jsonb;v_lines jsonb:='[]'::jsonb;v_result jsonb;begin
 perform erp_purchase_receipts.access(p_user_id);
 if p_command_id is null or p_document_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483646 then
  raise exception 'erp_stock_purchase_reverse_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-purchase-reverse-all-225','actor',p_user_id,'document',p_document_id,'version',p_expected_version)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_purchase_receipts.access(p_user_id);
 select * into c from erp_stock.supply_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'purchase_reverse_all' or c.request_hash<>h then raise exception 'erp_stock_purchase_reverse_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_purchase_reverse_conflict' using errcode='40001';end if;
 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
 if not exists(select 1 from erp_purchase_receipts.receipt x where x.document_id=d.id and not exists(select 1 from erp_purchase_receipts.reversal y where y.receipt_id=x.id))then
  raise exception 'erp_stock_purchase_nothing_to_reverse' using errcode='22023';end if;
 v_day:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;v_reason:='Estorno do pedido de compra '||d.number::text;v_version:=d.version;
 -- Newest receipt first (the reverse of the order in which they were received); each one bumps the version of the order.
 for r in select x.id,x.movement_id from erp_purchase_receipts.receipt x where x.document_id=d.id and not exists(select 1 from erp_purchase_receipts.reversal y where y.receipt_id=x.id)
   order by x.created_at desc,x.id desc loop
  v_preview:=(public.erp_purchase_receipts_reverse_preview(p_user_id,d.id,v_version,r.id,v_day,v_reason))->'preview';
  v_applied:=erp_purchase_receipts.apply_warehouse(p_user_id,d.id,v_version,'reverse',v_day,v_reason,null,r.id,erp_stock.supply_part(p_command_id,'reverse:'||r.id),
   v_preview->>'preview_hash',true,null);
  v_version:=(v_applied#>>'{receipt,document_version}')::integer;
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('receipt_id',r.id,'movement_id',v_applied#>'{receipt,reversal,movement_id}','positions',jsonb_array_length(v_preview->'positions')));
 end loop;
 v_result:=jsonb_build_object('scope','stock_purchase_reverse_all','data_mode','erp_native','command_id',p_command_id,'document_id',d.id,'document_number',d.number::text,
  'document_version',v_version,'occurred_on',v_day,'reason',v_reason,'reversed',v_lines);
 insert into erp_stock.supply_command(id,actor,action,request_hash,result)values(p_command_id,p_user_id,'purchase_reverse_all',h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

revoke all on function public.erp_stock_purchase_reverse_all(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.erp_stock_purchase_reverse_all(uuid,uuid,uuid,integer) to service_role;
commit;
