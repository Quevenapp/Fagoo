-- 292: Frente de caixa (onda G): a devolução total da venda marca as contas a receber em aberto como "Devolvido" (Origin: Situação
-- Devolvido das contas, FIN-011).
-- * Quando a devolução completa a venda (todos os itens devolvidos), as parcelas ainda em aberto do pedido da venda (a prazo, cartão a
--   receber, Ficha Financeira; nenhum valor recebido) são marcadas pela função do financeiro erp_finance.titles_mark_returned (281):
--   ficam canceladas com a marca de devolução imutável (origem pos_return, a venda), na mesma transação e com o comando derivado da
--   devolução. O dinheiro devolvido pelo caixa passa a ser o que a venda recebeu (antes a devolução era recusada por passar do recebido).
-- * Uma parcela recebida em parte não é devolvida: a devolução total é recusada (erp_pos_return_partial_title) até a baixa parcial ser
--   estornada. Devoluções parciais continuam como antes (só dinheiro, até o que a venda recebeu).
-- * A resposta da devolução informa returned_titles (quantas contas ficaram Devolvido).
-- Substitui erp_pos_return_execute da 206 (conferida pelo hash; outra versão interrompe a migração). Nada escreve no Origin.
begin;

do $$begin
 if to_regprocedure('erp_finance.titles_mark_returned(uuid,uuid,uuid[],jsonb)') is null then raise exception 'pos_returned_titles_292_requires_281' using errcode='55000'; end if;
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure('public.erp_pos_return_execute(uuid,uuid,text,jsonb)'))
  is distinct from '03f85392091e2d3ad8181c0cef13e32c97f44ef338a9273a7b3fb8001bc669d8' then
  raise exception 'pos_returned_titles_292_previous_definition_changed' using errcode='55000',detail='public.erp_pos_return_execute(uuid,uuid,text,jsonb)'; end if;
end$$;

create or replace function public.erp_pos_return_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a jsonb; v_role text; v_hash text; c erp_pos.command%rowtype; s erp_pos.sale%rowtype; d erp_documents.document%rowtype; v_before jsonb; v_result jsonb;
 v_items jsonb:='[]'::jsonb; v_stock jsonb:='[]'::jsonb; x jsonb; i erp_documents.item%rowtype; v_qty numeric; v_done jsonb; v_factor numeric; v_line bigint; v_cents bigint:=0;
 v_reason text; v_account uuid; v_session uuid; sess erp_finance.cash_session%rowtype; v_today date:=erp_pos.today(); v_movement uuid; v_entry uuid; v_res jsonb; v_kind text;
 v_seen uuid[]:=array[]::uuid[]; v_stock_posting erp_stock.document_posting%rowtype; v_finance_posting uuid; v_paid bigint; v_refunded bigint; v_refund bigint:=0; v_subtotal numeric;
 -- 292: the full return of the sale marks its open contas a receber as Devolvido (erp_finance.titles_mark_returned, 281).
 v_complete boolean; v_open uuid[]:='{}'; v_cash bigint; v_titles jsonb;
begin
 a:=erp_pos.access(p_user_id,true); v_role:=a->>'role';
 if p_command_id is null or p_action is distinct from 'sale_return' or p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>65536 then
  raise exception 'erp_pos_invalid_action' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'scope','return','action',p_action,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('erp_pos:'||p_command_id::text,0));
 select * into c from erp_pos.command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>v_hash then raise exception 'erp_pos_command_conflict' using errcode='40001'; end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if not (a->>'finish')::boolean then raise exception 'erp_pos_finish_denied' using errcode='42501'; end if;
 perform erp_pos.keys(p_data,array['sale_id','expected_version','items','refund_account_id','cash_session_id','reason'],array['sale_id','expected_version','items','refund_account_id','cash_session_id','reason']);
 v_reason:=erp_pos.txt(p_data,'reason',500,true); if length(v_reason)<3 then raise exception 'erp_pos_reason_required' using errcode='22023'; end if;
 v_account:=erp_pos.uid(p_data,'refund_account_id'); v_session:=erp_pos.uid(p_data,'cash_session_id');
 if v_session is not null then
  select account_id into v_account from erp_finance.cash_session where id=v_session;
  if not found then raise exception 'erp_pos_cash_session_unavailable' using errcode='40001'; end if;
  perform 1 from erp_finance.account where id=v_account for update;
  select * into sess from erp_finance.cash_session where id=v_session for share;
  if not erp_pos.usable_session(p_user_id,sess) or (p_data->>'refund_account_id' is not null and erp_pos.uid(p_data,'refund_account_id')<>sess.account_id) then
   raise exception 'erp_pos_cash_session_unavailable' using errcode='40001'; end if;
 end if;
 select * into s from erp_pos.sale where id=erp_pos.uid(p_data,'sale_id',true) for update;
 if not found then raise exception 'erp_pos_not_found' using errcode='P0002'; end if;
 if s.version<>erp_pos.int(p_data,'expected_version',1,2147483646) then raise exception 'erp_pos_version_conflict' using errcode='40001'; end if;
 if s.state<>'finished' then raise exception 'erp_pos_sale_state' using errcode='40001'; end if;
 if (select count(*) from erp_pos.sale_return where sale_id=s.id)>=20 then raise exception 'erp_pos_returns_limit' using errcode='22023'; end if;
 select * into d from erp_documents.document where id=s.document_id;
 select * into v_stock_posting from erp_stock.document_posting where document_id=d.id and state='active';
 select id into v_finance_posting from erp_finance.document_posting where document_id=d.id and state='active';
 if v_finance_posting is null or (v_stock_posting.id is null and exists(select 1 from erp_documents.item it join erp_catalog.product p on p.record_id=it.product_id where it.document_id=d.id and p.kind='P')) then
  raise exception 'erp_pos_return_effects_pending' using errcode='40001'; end if;
 v_account:=coalesce(v_account,s.account_id);
 v_done:=erp_pos.returned(s.id);
 if jsonb_typeof(p_data->'items')<>'array' or jsonb_array_length(p_data->'items') not between 1 and 250 then raise exception 'erp_pos_invalid_items' using errcode='22023'; end if;
 -- Valor devolvido: o total do item proporcional à quantidade, com a parte do desconto da venda (frete e outras despesas ficam). A
 -- última devolução do item leva o restante, para a soma das devoluções nunca passar do total do item.
 v_subtotal:=coalesce((d.body#>>'{totals,subtotal}')::numeric,0);
 v_factor:=case when v_subtotal>0 then (v_subtotal-coalesce((d.body#>>'{totals,discount}')::numeric,0))/v_subtotal else 0 end;
 for x in select value from jsonb_array_elements(p_data->'items') loop
  perform erp_pos.keys(x,array['item_id','quantity'],array['item_id','quantity']);
  select * into i from erp_documents.item where id=erp_pos.uid(x,'item_id',true) and document_id=d.id;
  if not found or i.id=any(v_seen) then raise exception 'erp_pos_invalid_items' using errcode='22023'; end if;
  v_seen:=v_seen||i.id;
  if jsonb_typeof(x->'quantity')<>'string' or x->>'quantity'!~'^[0-9]{1,9}(\.[0-9]{1,6})?$' or (x->>'quantity')::numeric<=0 then raise exception 'erp_pos_invalid_items' using errcode='22023'; end if;
  v_qty:=(x->>'quantity')::numeric;
  if v_qty+coalesce((v_done->>i.id::text)::numeric,0)>i.quantity then raise exception 'erp_pos_return_exceeds' using errcode='22023'; end if;
  if v_qty+coalesce((v_done->>i.id::text)::numeric,0)=i.quantity then
   v_line:=greatest(round((i.data->>'total')::numeric*v_factor*100)::bigint-(select coalesce(sum((l->>'value_cents')::bigint),0) from erp_pos.sale_return r cross join jsonb_array_elements(r.items) l
    where r.sale_id=s.id and l->>'item_id'=i.id::text),0);
  else v_line:=round((i.data->>'total')::numeric*v_qty/i.quantity*v_factor*100)::bigint; end if;
  v_cents:=v_cents+v_line;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('item_id',i.id,'product_id',i.product_id,'description',i.data->>'description','unit',i.data->>'unit',
   'quantity',v_qty::numeric(18,6)::text,'value_cents',v_line::text));
  select kind into v_kind from erp_catalog.product where record_id=i.product_id;
  if v_kind='P' then v_stock:=v_stock||jsonb_build_array(jsonb_build_object('product_id',i.product_id,'quantity',v_qty)); end if;
 end loop;
 -- Estoque: entrada no depósito de cada produto no lançamento de estoque do pedido.
 if jsonb_array_length(v_stock)>0 then
  if v_role not in('admin','estoque') then raise exception 'erp_pos_return_stock_denied' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('product_id',g.product_id,'warehouse_id',g.warehouse_id,'quantity',g.qty::numeric(18,6)::text,
    'expected_version',coalesce((select b.version from erp_stock.balance b where b.product_id=g.product_id and b.warehouse_id=g.warehouse_id),0)) order by g.product_id),'[]'::jsonb) into v_stock
   from(select (y->>'product_id')::uuid product_id,w.warehouse_id,sum((y->>'quantity')::numeric) qty from jsonb_array_elements(v_stock) y
    cross join lateral(select e.warehouse_id from erp_stock.entry e where e.movement_id=v_stock_posting.movement_id and e.product_id=(y->>'product_id')::uuid order by e.ordinal limit 1) w
    group by 1,2) g;
  if jsonb_array_length(v_stock)>0 then
   v_res:=public.erp_stock_post(p_user_id,erp_pos.step(p_command_id,'return_stock'),'receipt',v_today,left('Devolução da venda nº '||d.number::text||' na frente de caixa: '||v_reason,500),
    v_stock,left('PDV venda '||d.number::text,100));
   select m.id into v_movement from erp_stock.movement m where m.command_id=erp_pos.step(p_command_id,'return_stock');
  end if;
 end if;
 -- 292: after this return every item of the sale is fully returned (the parcelas still open then become Devolvido).
 v_complete:=not exists(select 1 from erp_documents.item it where it.document_id=d.id
  and it.quantity>coalesce((v_done->>it.id::text)::numeric,0)+coalesce((select sum((l->>'quantity')::numeric) from jsonb_array_elements(v_items) l where l->>'item_id'=it.id::text),0));
 -- Dinheiro devolvido pela conta do caixa, até o que a venda recebeu.
 if v_cents>0 then
  if v_role not in('admin','financeiro') then raise exception 'erp_pos_return_finance_denied' using errcode='42501'; end if;
  select coalesce(sum((t->>'settled_cents')::bigint),0) into v_paid from jsonb_array_elements(erp_finance.document_title_rows(v_finance_posting)) t where not (t->>'cancelled')::boolean;
  select coalesce(sum(r.refund_cents),0) into v_refunded from erp_pos.sale_return r where r.sale_id=s.id;
  if v_complete then
   select coalesce(array_agg((t->>'id')::uuid order by (t->>'position')::integer),'{}') into v_open from jsonb_array_elements(erp_finance.document_title_rows(v_finance_posting)) t
    where not (t->>'cancelled')::boolean and (t->>'settled_cents')::bigint=0;
   -- A parcela partly received is not returned: estorne a baixa parcial antes.
   if exists(select 1 from jsonb_array_elements(erp_finance.document_title_rows(v_finance_posting)) t where not (t->>'cancelled')::boolean
    and (t->>'settled_cents')::bigint>0 and (t->>'settled_cents')::bigint<(t->>'amount_cents')::bigint) then
    raise exception 'erp_pos_return_partial_title' using errcode='22023'; end if;
  end if;
  -- With the open parcelas returned the cash refund is what the sale received; otherwise it never passes it.
  v_cash:=case when cardinality(v_open)>0 then least(v_cents,greatest(v_paid-v_refunded,0)) else v_cents end;
  if v_cash>v_paid-v_refunded then raise exception 'erp_pos_return_exceeds_paid' using errcode='22023'; end if;
  if v_cash>0 then
  if v_account is null then raise exception 'erp_pos_invalid_account' using errcode='22023'; end if;
  v_res:=public.erp_finance_cash_execute(p_user_id,erp_pos.step(p_command_id,'refund'),'entry_save',jsonb_build_object('id',null,'expected_version',0,'account_id',v_account,
   'kind','out','amount_cents',v_cash::text,'posted_on',v_today::text,'competence_on',v_today::text,'category_id',null,'contact_id',d.contact_id,
   'note',left('Devolução da venda nº '||d.number::text||' (frente de caixa): '||v_reason,2000),'origin','manual'));
  select e.id into v_entry from erp_finance.cash_entry e where e.command_id=erp_pos.step(p_command_id,'refund');
  v_refund:=v_cash;
  end if;
  if cardinality(v_open)>0 then
   v_titles:=erp_finance.titles_mark_returned(p_user_id,erp_pos.step(p_command_id,'titles_returned'),v_open,
    jsonb_build_object('kind','pos_return','id',s.id::text,'label',left('Devolução da venda nº '||d.number::text||' (frente de caixa)',120)));
  end if;
 end if;
 v_before:=erp_pos.sale_view(s.id,true);
 insert into erp_pos.sale_return(sale_id,items,value_cents,refund_cents,refund_account_id,cash_session_id,stock_movement_id,cash_entry_id,reason,actor,command_id)
  values(s.id,v_items,v_cents,v_refund,case when v_entry is null then null else v_account end,v_session,v_movement,v_entry,v_reason,p_user_id,p_command_id);
 update erp_pos.sale set version=version+1,updated_at=clock_timestamp() where id=s.id;
 perform erp_pos.access(p_user_id,true);
 v_result:=jsonb_build_object('entity','pos_sale','record',erp_pos.sale_view(s.id,true)||jsonb_build_object('returns',erp_pos.returns_view(s.id),'returned',erp_pos.returned(s.id)),
  'return',jsonb_build_object('value_cents',v_cents::text,'refund_cents',v_refund::text,'stock',v_movement is not null,'refund',v_entry is not null,
   'returned_titles',cardinality(v_open),
   'items',(select coalesce(jsonb_agg(jsonb_build_object('item_id',l->>'item_id','quantity',l->>'quantity','value_cents',l->>'value_cents') order by o),'[]'::jsonb)
    from jsonb_array_elements(v_items) with ordinality z(l,o))),'action',p_action,'data_mode','erp_native','replayed',false);
 insert into erp_pos.command(id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'return',v_hash,v_result);
 insert into erp_pos.audit(actor,command_id,sale_id,action,before_data,after_data) values(p_user_id,p_command_id,s.id,p_action,v_before,v_result->'return');
 return v_result;
end $$;


revoke all on function public.erp_pos_return_execute(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.erp_pos_return_execute(uuid,uuid,text,jsonb) to service_role;
commit;
