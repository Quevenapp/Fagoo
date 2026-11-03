-- Vendas > Frente de caixa (PDV), lane frente de caixa, onda D — parte 3: "Gerar devolução" e o resumo do caixa.
-- - Devolução de itens de uma venda finalizada com os efeitos lançados: os produtos voltam ao estoque (erp_stock_post, entrada no
--   depósito do lançamento do pedido) e o valor é devolvido em dinheiro pela conta do caixa (erp_finance_cash_execute, lançamento de
--   saída), até o que a venda recebeu, ligados à venda original. A nota fiscal de devolução, o abatimento das parcelas em aberto e o
--   crédito na ficha financeira do cliente não são gerados (dependem das notas e do financeiro).
-- - "Nº da mesa" do pedido gerado pela Frente de caixa (erp_pos_order), lido pelo formulário do pedido.
-- - Resumo do caixa para o Controle de caixa (migração 173) e para "Fechar caixa" no PDV: Total registrado por forma de pagamento,
--   as vendas de cada forma ("Ver vendas") e os Movimentos dos Grupos de Produtos, contando só as vendas cujas situações estão em
--   "Situações da venda consideradas para o fechamento de caixa". Com "Exibir formas de pagamento Dinheiro e Cheque no Controle de
--   caixa", Dinheiro e Cheque aparecem mesmo sem vendas.
begin;

do $$begin
 if to_regprocedure('public.erp_pos_sale_execute(uuid,uuid,text,jsonb)') is null or to_regprocedure('public.erp_stock_post(uuid,uuid,text,date,text,jsonb,text)') is null
  or to_regprocedure('public.erp_finance_cash_execute(uuid,uuid,text,jsonb)') is null then
  raise exception 'pos_returns_206_requires_205' using errcode='55000'; end if;
end$$;

-- A tabela erp_pos.sale_return nasce na 205 (o cancelamento recusa a venda com devolução).
-- Quantidade já devolvida de cada item da venda.
create function erp_pos.returned(p_sale uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_object_agg(x.item_id,x.qty::text),'{}'::jsonb) from(select i->>'item_id' item_id,sum((i->>'quantity')::numeric) qty
  from erp_pos.sale_return r cross join jsonb_array_elements(r.items) i where r.sale_id=p_sale group by 1) x
$$;
-- Devoluções da venda (leitura compacta: as linhas levam o item, a quantidade e o valor; a descrição está nos itens da venda). No
-- máximo 20 devoluções por venda, para a leitura da venda caber na resposta limitada do Worker.
create function erp_pos.returns_view(p_sale uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'created_at',r.created_at,'value_cents',r.value_cents::text,'refund_cents',r.refund_cents::text,'reason',r.reason,
  'items',(select coalesce(jsonb_agg(jsonb_build_object('item_id',l->>'item_id','quantity',l->>'quantity','value_cents',l->>'value_cents') order by o),'[]'::jsonb)
   from jsonb_array_elements(r.items) with ordinality x(l,o)),
  'actor_name',erp_activity.actor_label(r.actor),'stock',r.stock_movement_id is not null,'refund_account_id',r.refund_account_id) order by r.created_at,r.id),'[]'::jsonb)
 from erp_pos.sale_return r where r.sale_id=p_sale
$$;

-- "Gerar devolução" exige os efeitos da venda lançados (estoque dos produtos de estoque e contas): com efeito pendente, o lançamento
-- posterior no pedido ignoraria a devolução. Os produtos voltam ao depósito do próprio lançamento de estoque do pedido; o dinheiro
-- devolvido sai do caixa e nunca passa do que a venda recebeu (parcelas baixadas menos as devoluções anteriores): parcelas em aberto
-- (a prazo, cartão a receber ou Ficha Financeira) não viram dinheiro, e o abatimento delas ou o crédito do cliente dependem do financeiro.
create function public.erp_pos_return_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a jsonb; v_role text; v_hash text; c erp_pos.command%rowtype; s erp_pos.sale%rowtype; d erp_documents.document%rowtype; v_before jsonb; v_result jsonb;
 v_items jsonb:='[]'::jsonb; v_stock jsonb:='[]'::jsonb; x jsonb; i erp_documents.item%rowtype; v_qty numeric; v_done jsonb; v_factor numeric; v_line bigint; v_cents bigint:=0;
 v_reason text; v_account uuid; v_session uuid; sess erp_finance.cash_session%rowtype; v_today date:=erp_pos.today(); v_movement uuid; v_entry uuid; v_res jsonb; v_kind text;
 v_seen uuid[]:=array[]::uuid[]; v_stock_posting erp_stock.document_posting%rowtype; v_finance_posting uuid; v_paid bigint; v_refunded bigint; v_refund bigint:=0; v_subtotal numeric;
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
 -- Dinheiro devolvido pela conta do caixa, até o que a venda recebeu.
 if v_cents>0 then
  if v_role not in('admin','financeiro') then raise exception 'erp_pos_return_finance_denied' using errcode='42501'; end if;
  select coalesce(sum((t->>'settled_cents')::bigint),0) into v_paid from jsonb_array_elements(erp_finance.document_title_rows(v_finance_posting)) t where not (t->>'cancelled')::boolean;
  select coalesce(sum(r.refund_cents),0) into v_refunded from erp_pos.sale_return r where r.sale_id=s.id;
  if v_cents>v_paid-v_refunded then raise exception 'erp_pos_return_exceeds_paid' using errcode='22023'; end if;
  if v_account is null then raise exception 'erp_pos_invalid_account' using errcode='22023'; end if;
  v_res:=public.erp_finance_cash_execute(p_user_id,erp_pos.step(p_command_id,'refund'),'entry_save',jsonb_build_object('id',null,'expected_version',0,'account_id',v_account,
   'kind','out','amount_cents',v_cents::text,'posted_on',v_today::text,'competence_on',v_today::text,'category_id',null,'contact_id',d.contact_id,
   'note',left('Devolução da venda nº '||d.number::text||' (frente de caixa): '||v_reason,2000),'origin','manual'));
  select e.id into v_entry from erp_finance.cash_entry e where e.command_id=erp_pos.step(p_command_id,'refund');
  v_refund:=v_cents;
 end if;
 v_before:=erp_pos.sale_view(s.id,true);
 insert into erp_pos.sale_return(sale_id,items,value_cents,refund_cents,refund_account_id,cash_session_id,stock_movement_id,cash_entry_id,reason,actor,command_id)
  values(s.id,v_items,v_cents,v_refund,case when v_entry is null then null else v_account end,v_session,v_movement,v_entry,v_reason,p_user_id,p_command_id);
 update erp_pos.sale set version=version+1,updated_at=clock_timestamp() where id=s.id;
 perform erp_pos.access(p_user_id,true);
 v_result:=jsonb_build_object('entity','pos_sale','record',erp_pos.sale_view(s.id,true)||jsonb_build_object('returns',erp_pos.returns_view(s.id),'returned',erp_pos.returned(s.id)),
  'return',jsonb_build_object('value_cents',v_cents::text,'refund_cents',v_refund::text,'stock',v_movement is not null,'refund',v_entry is not null,
   'items',(select coalesce(jsonb_agg(jsonb_build_object('item_id',l->>'item_id','quantity',l->>'quantity','value_cents',l->>'value_cents') order by o),'[]'::jsonb)
    from jsonb_array_elements(v_items) with ordinality z(l,o))),'action',p_action,'data_mode','erp_native','replayed',false);
 insert into erp_pos.command(id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'return',v_hash,v_result);
 insert into erp_pos.audit(actor,command_id,sale_id,action,before_data,after_data) values(p_user_id,p_command_id,s.id,p_action,v_before,v_result->'return');
 return v_result;
end $$;

-- A leitura da venda passa a trazer as devoluções.
create or replace function public.erp_pos_sale_get(p_user_id uuid,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_pos.access(p_user_id,false);
 if p_id is null or not exists(select 1 from erp_pos.sale where id=p_id) then raise exception 'erp_pos_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('entity','pos_sale','data_mode','erp_native','record',erp_pos.sale_view(p_id,true)||jsonb_build_object('returns',erp_pos.returns_view(p_id),'returned',erp_pos.returned(p_id)));
end $$;

-- Pedido de venda gerado pela Frente de caixa: "Nº da mesa" (venda mesa do PDV) e o caixa, para o formulário do pedido.
create function public.erp_pos_order(p_user_id uuid,p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_pos.access(p_user_id,false);
 if p_document_id is null then raise exception 'erp_pos_invalid_query' using errcode='22023'; end if;
 return jsonb_build_object('entity','pos_order','data_mode','erp_native','document_id',p_document_id,
  'record',(select jsonb_build_object('sale_id',s.id,'kind',s.kind,'table_number',s.table_number,'state',s.state,'account_name',(select left(a.name,200) from erp_finance.account a where a.id=s.account_id))
   from erp_pos.sale s where s.document_id=p_document_id));
end $$;

-- Resumo do caixa (Controle de caixa e "Fechar caixa").
create function public.erp_pos_cash_summary(p_user_id uuid,p_session uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_statuses text[]; v_total bigint; v_count integer; v_value numeric;
begin
 perform erp_pos.access(p_user_id,false);
 if p_session is null or not exists(select 1 from erp_finance.cash_session where id=p_session and deleted_at is null) then raise exception 'erp_pos_not_found' using errcode='P0002'; end if;
 v_statuses:=array(select case x when 'atendido' then 'fulfilled' when 'verificado' then 'verified' end from jsonb_array_elements_text(coalesce(erp_preferences.get('pdv.situacoes_fechamento'),'["atendido","verificado"]'::jsonb)) x);
 select count(*),coalesce(sum(s.total_cents),0) into v_count,v_total from erp_pos.sale s join erp_documents.document d on d.id=s.document_id
  where s.cash_session_id=p_session and s.state='finished' and d.status=any(v_statuses);
 select coalesce(sum((i.data->>'total')::numeric),0) into v_value from erp_pos.sale s join erp_documents.document d on d.id=s.document_id join erp_documents.item i on i.document_id=d.id
  where s.cash_session_id=p_session and s.state='finished' and d.status=any(v_statuses);
 return jsonb_build_object('entity','pos_cash_summary','data_mode','erp_native','session_id',p_session,
  'statuses',to_jsonb(coalesce((select array_agg(x order by x) from unnest(v_statuses) x where x is not null),array[]::text[])),
  'sales_count',v_count,'total_cents',v_total::text,
  'returns_cents',(select coalesce(sum(r.refund_cents),0)::text from erp_pos.sale_return r where r.cash_session_id=p_session and r.cash_entry_id is not null),
  'methods',(select coalesce(jsonb_agg(jsonb_build_object('payment_method_id',x.id,'name',x.name,'payment_type',x.payment_type,'registered_cents',x.cents::text,'sales',x.sales)
    order by lower(x.name),x.id),'[]'::jsonb) from(
   select m.id,left(m.description,100) name,m.payment_type,coalesce(sum(p.amount_cents),0) cents,count(distinct p.sale_id)::integer sales
   from erp_catalog.payment_method m
   left join(erp_pos.sale_payment p join erp_pos.sale s on s.id=p.sale_id and s.cash_session_id=p_session and s.state='finished'
    join erp_documents.document d on d.id=s.document_id and d.status=any(v_statuses)) on p.payment_method_id=m.id
   group by m.id
   having count(p.sale_id)>0 or(erp_pos.pref_flag('pdv.dinheiro_cheque') and m.payment_type in('01','02') and bool_or(m.active and m.deleted_at is null))
   order by lower(m.description),m.id limit 100) x),
  'groups',(select coalesce(jsonb_agg(jsonb_build_object('group_id',g.group_id,'name',g.name,'quantity',g.qty::numeric(18,6)::text,'value',g.value::numeric(18,2)::text,
    'percent',case when v_value>0 then round(g.value*100/v_value,2)::text else '0.00' end) order by g.value desc,g.name),'[]'::jsonb) from(
   select t.id group_id,coalesce(left(t.name,100),'Sem grupo') name,sum(i.quantity) qty,sum((i.data->>'total')::numeric) value
   from erp_pos.sale s join erp_documents.document d on d.id=s.document_id join erp_documents.item i on i.document_id=d.id
   left join erp_catalog.product_detail pd on pd.record_id=i.product_id left join erp_catalog.taxonomy t on t.id=pd.product_group_id and t.kind='product_groups'
   where s.cash_session_id=p_session and s.state='finished' and d.status=any(v_statuses)
   group by t.id,t.name order by 4 desc limit 100) g));
end $$;

revoke all on all functions in schema erp_pos from public,anon,authenticated,service_role;
do $$declare f text;begin
 foreach f in array array['erp_pos_context(uuid)','erp_pos_settings_execute(uuid,uuid,text,jsonb)','erp_pos_favorites(uuid,uuid)',
  'erp_pos_sales(uuid,uuid,text,text,date,date,uuid,integer,integer)','erp_pos_sale_get(uuid,uuid)','erp_pos_sale_execute(uuid,uuid,text,jsonb)',
  'erp_pos_return_execute(uuid,uuid,text,jsonb)','erp_pos_cash_summary(uuid,uuid)','erp_pos_order(uuid,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end$$;
commit;
