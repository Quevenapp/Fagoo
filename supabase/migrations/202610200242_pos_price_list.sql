-- 242: Frente de caixa (documentos lane, onda E): a Lista de preço escolhida na venda passa a ser gravada no pedido de venda.
-- * Com "Situação para aprovação de descontos" (239), a venda da Frente de caixa acima do limite do vendedor continua recusada (o
--   pedido não vai para aprovação a partir do caixa).
-- * Até aqui a venda guardava a lista só em erp_pos.sale; o pedido gerado não a tinha. Agora o corpo do pedido leva price_list_id
--   (migração 196), conferido pela gravação dos documentos quando novo ou trocado (lista existente e válida agora), e Pedidos de
--   venda, a impressão e Gerar venda mostram a lista aplicada.
-- Substitui erp_pos.sale_write (205, conferida pelo hash; outra versão interrompe a migração). Nenhuma outra regra muda.
begin;

do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure('erp_pos.sale_write(uuid,uuid,jsonb,boolean,jsonb)'))
  is distinct from '24d9a6011bcb5f069119f892822b5e73e3e7632d079bc5cb637c2e7e3da11e8a' then
  raise exception 'pos_price_list_242_previous_definition_changed' using errcode='55000',detail='erp_pos.sale_write(uuid,uuid,jsonb,boolean,jsonb)';end if;
end$$;

create or replace function erp_pos.sale_write(p_user uuid,p_command uuid,p_data jsonb,p_finish boolean,a jsonb) returns uuid
language plpgsql set search_path=pg_catalog as $$
declare
 v_sale erp_pos.sale%rowtype; v_id uuid; v_kind text; v_table integer; v_account uuid; v_session uuid; v_session_account uuid; sess erp_finance.cash_session%rowtype;
 v_contact uuid; v_identified boolean; v_doc jsonb; v_body jsonb; v_installments jsonb:='[]'::jsonb; v_payments jsonb:='[]'::jsonb; p jsonb; m erp_catalog.payment_method%rowtype;
 v_pos integer:=0; v_days integer; v_amount bigint; v_sum bigint:=0; v_cash bigint:=0; v_today date:=erp_pos.today(); v_saved jsonb; v_document uuid; v_total bigint;
 v_received bigint; v_change bigint:=0; v_dest uuid; v_list uuid; v_wh uuid; v_item jsonb; v_price numeric; v_list_price text; v_methods integer; v_note text; r record;
begin
 perform erp_pos.keys(p_data,array['sale_id','expected_version','document_version','kind','table_number','account_id','cash_session_id','contact_id','price_list_id','document','payments',
  'destination_account_id','to_ledger','cash_received_cents'],array['sale_id','expected_version','document_version','kind','table_number','account_id','cash_session_id','contact_id','price_list_id','document',
  'payments','destination_account_id','to_ledger','cash_received_cents']);
 if not (a->>'items')::boolean then raise exception 'erp_pos_items_denied' using errcode='42501'; end if;
 v_kind:=erp_pos.txt(p_data,'kind',10,true); v_table:=erp_pos.int(p_data,'table_number',1,9999,false);
 if v_kind not in('balcao','mesa') or (v_kind='mesa')<>(v_table is not null) then raise exception 'erp_pos_invalid_kind' using errcode='22023'; end if;
 if v_kind='mesa' and not erp_pos.pref_flag('pdv.controle_mesas') then raise exception 'erp_pos_tables_disabled' using errcode='22023'; end if;
 v_id:=erp_pos.uid(p_data,'sale_id');
 if v_id is null then
  if erp_pos.int(p_data,'expected_version',0,0)<>0 or erp_pos.int(p_data,'document_version',1,2147483646,false) is not null then raise exception 'erp_pos_invalid_number' using errcode='22023'; end if;
 else
  select * into v_sale from erp_pos.sale where id=v_id for update;
  if not found then raise exception 'erp_pos_not_found' using errcode='P0002'; end if;
  if v_sale.version<>erp_pos.int(p_data,'expected_version',1,2147483646) then raise exception 'erp_pos_version_conflict' using errcode='40001'; end if;
  if v_sale.state<>'open' then raise exception 'erp_pos_sale_state' using errcode='40001'; end if;
  -- O pedido da venda aberta pode ser editado em Pedidos de venda: a frente de caixa só grava sobre a versão do pedido que leu.
  if erp_pos.int(p_data,'document_version',1,2147483646)<>erp_pos.document_version(v_sale.document_id) then raise exception 'erp_pos_document_state' using errcode='40001'; end if;
 end if;

 -- Caixa: com "Utilizar controle de caixa" a venda é finalizada só num caixa aberto que o usuário usa. A conta é travada antes
 -- do caixa (a ordem de quem escreve no caixa).
 v_account:=erp_pos.uid(p_data,'account_id'); v_session:=erp_pos.uid(p_data,'cash_session_id');
 if v_session is not null then
  select account_id into v_session_account from erp_finance.cash_session where id=v_session;
  if not found then raise exception 'erp_pos_cash_session_unavailable' using errcode='40001'; end if;
  perform 1 from erp_finance.account where id=v_session_account for update;
  select * into sess from erp_finance.cash_session where id=v_session for share;
  if not erp_pos.usable_session(p_user,sess) then raise exception 'erp_pos_cash_session_unavailable' using errcode='40001'; end if;
  if v_account is distinct from sess.account_id then raise exception 'erp_pos_invalid_store' using errcode='22023'; end if;
 elsif p_finish and erp_pos.pref_flag('pdv.controle_caixa') then
  raise exception 'erp_pos_cash_session_required' using errcode='40001';
 end if;
 if v_account is not null and not exists(select 1 from erp_finance.account where id=v_account and kind='cash' and active and deleted_at is null) then
  raise exception 'erp_pos_invalid_store' using errcode='22023'; end if;
 v_dest:=erp_pos.uid(p_data,'destination_account_id');
 if v_dest is not null and not exists(select 1 from erp_finance.account where id=v_dest and active and deleted_at is null) then raise exception 'erp_pos_invalid_account' using errcode='22023'; end if;
 v_list:=erp_pos.uid(p_data,'price_list_id');
 if v_list is not null and v_list is distinct from v_sale.price_list_id and not exists(select 1 from erp_pricing.price_list where id=v_list) then
  raise exception 'erp_pos_invalid_price_list' using errcode='22023'; end if;
 if jsonb_typeof(p_data->'to_ledger')<>'boolean' or (erp_pos.flag(p_data,'to_ledger') and v_dest is not null) then raise exception 'erp_pos_invalid_data' using errcode='22023'; end if;

 -- Cliente: sem cliente identificado, o cliente padrão das configurações do PDV (Consumidor final).
 v_contact:=erp_pos.uid(p_data,'contact_id'); v_identified:=v_contact is not null;
 -- Destino "Ficha Financeira": as parcelas ficam em aberto na ficha do cliente, que precisa estar identificado.
 if erp_pos.flag(p_data,'to_ledger') and not v_identified then raise exception 'erp_pos_ledger_requires_contact' using errcode='22023'; end if;
 if v_contact is null then
  select consumer_contact_id into v_contact from erp_pos.settings where singleton;
  if v_contact is null then raise exception 'erp_pos_consumer_required' using errcode='22023'; end if;
 end if;

 v_doc:=p_data->'document';
 perform erp_pos.keys(v_doc,array['date','warehouse_id','expected_date','items','discount_mode','discount_value','freight','other_expenses','notes','internal_notes','seller_id','category_id'],
  array['date','items']);
 if jsonb_typeof(v_doc->'date')<>'string' or v_doc->>'date'<>v_today::text then raise exception 'erp_pos_invalid_date' using errcode='22023'; end if;
 if jsonb_typeof(v_doc->'items')<>'array' or jsonb_array_length(v_doc->'items') not between 1 and 250 then raise exception 'erp_pos_invalid_items' using errcode='22023'; end if;
 v_wh:=erp_pos.uid(v_doc,'warehouse_id');

 -- Pagamento: parcelas com a forma do cadastro (recebimentos), dias e valor; o vencimento é a data da venda mais os dias.
 if jsonb_typeof(p_data->'payments')<>'array' or jsonb_array_length(p_data->'payments')>120 then raise exception 'erp_pos_invalid_payments' using errcode='22023'; end if;
 if jsonb_array_length(p_data->'payments')>0 and not (a->>'payments')::boolean then raise exception 'erp_pos_payments_denied' using errcode='42501'; end if;
 if p_finish and(not (a->>'payments')::boolean or not (a->>'finish')::boolean) then raise exception 'erp_pos_finish_denied' using errcode='42501'; end if;
 if p_finish and jsonb_array_length(p_data->'payments')=0 then raise exception 'erp_pos_payments_required' using errcode='22023'; end if;
 for p in select value from jsonb_array_elements(p_data->'payments') loop
  perform erp_pos.keys(p,array['payment_method_id','days','amount_cents','note'],array['payment_method_id','days','amount_cents','note']);
  select * into m from erp_catalog.payment_method where id=erp_pos.uid(p,'payment_method_id',true) and active and deleted_at is null and applicable in('recebimentos','ambos');
  if not found then raise exception 'erp_pos_invalid_payment_method' using errcode='22023'; end if;
  v_days:=erp_pos.int(p,'days',0,9999); v_amount:=erp_pos.cents(p,'amount_cents',true); v_note:=erp_pos.txt(p,'note',2000,false,true); v_pos:=v_pos+1;
  if v_today+v_days>date '2100-12-31' then raise exception 'erp_pos_invalid_number' using errcode='22023'; end if;
  v_installments:=v_installments||jsonb_build_array(jsonb_build_object('due_date',(v_today+v_days)::text,'amount',erp_pos.amount_text(v_amount),'method',m.description,'note',v_note,'payment_reference',null));
  v_payments:=v_payments||jsonb_build_array(jsonb_build_object('position',v_pos,'payment_method_id',m.id,'method_name',m.description,'payment_type',m.payment_type,'days',v_days,
   'due_on',v_today+v_days,'amount_cents',v_amount,'note',v_note));
  v_sum:=v_sum+v_amount;
  -- Troco: calculado das parcelas à vista em Dinheiro (01) ou Cheque (02).
  if v_days=0 and m.payment_type in('01','02') then v_cash:=v_cash+v_amount; end if;
 end loop;
 select count(distinct value->>'payment_method_id') into v_methods from jsonb_array_elements(p_data->'payments');
 if v_methods>1 and not (a->>'change_method')::boolean then raise exception 'erp_pos_change_method_denied' using errcode='42501'; end if;
 v_received:=erp_pos.cents(p_data,'cash_received_cents',false,false);
 if v_received is not null then
  if v_cash=0 or v_received<v_cash then raise exception 'erp_pos_cash_received_invalid' using errcode='22023'; end if;
  v_change:=v_received-v_cash;
 end if;

 -- "Editar o preço unitário" (vendedor sem o módulo): o item do cadastro sai pelo preço do cadastro ou pelo da lista de preço.
 if not (a->>'edit_price')::boolean then
  for v_item in select value from jsonb_array_elements(v_doc->'items') loop
   if jsonb_typeof(v_item)<>'object' or jsonb_typeof(v_item->'unit_price')<>'string' then raise exception 'erp_pos_invalid_items' using errcode='22023'; end if;
   if v_item->>'product_id' is not null then
    select x.price into v_price from erp_catalog.product x where x.record_id=erp_pos.uid(v_item,'product_id');
    v_list_price:=case when v_list is null then null else (select i->>'list_price' from jsonb_array_elements(public.erp_pricing_product_lists(p_user,erp_pos.uid(v_item,'product_id'))->'items') i where i->>'id'=v_list::text) end;
    if (v_item->>'unit_price')!~'^[0-9]{1,12}(\.[0-9]{1,10})?$' or ((v_item->>'unit_price')::numeric is distinct from v_price and (v_list_price is null or (v_item->>'unit_price')::numeric<>v_list_price::numeric)) then
     raise exception 'erp_pos_edit_price_denied' using errcode='42501'; end if;
   end if;
  end loop;
 end if;
 -- "Exclusão de itens" (vendedor sem o módulo): a venda aberta não perde itens nem quantidade.
 if v_id is not null and not (a->>'remove_items')::boolean and exists(select 1 from erp_documents.item i where i.document_id=v_sale.document_id
   and not exists(select 1 from jsonb_array_elements(v_doc->'items') n where n->>'id'=i.id::text and jsonb_typeof(n->'quantity')='string' and (n->>'quantity')~'^[0-9]{1,9}(\.[0-9]{1,6})?$' and (n->>'quantity')::numeric>=i.quantity)) then
  raise exception 'erp_pos_remove_items_denied' using errcode='42501'; end if;

 -- Estoque do depósito da venda (saldo físico): "Bloquear vendas com quantidade zero" e, sem "Permite incluir produtos com
 -- estoque negativo", nenhuma quantidade acima do saldo. Só os produtos de estoque (tipo P) contam.
 if v_wh is not null then
  for r in select (n->>'product_id')::uuid product_id,sum((n->>'quantity')::numeric) qty
   from jsonb_array_elements(v_doc->'items') n join erp_catalog.product x on x.kind='P'
    and x.record_id=case when n->>'product_id'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (n->>'product_id')::uuid end
   where jsonb_typeof(n->'quantity')='string' and (n->>'quantity')~'^[0-9]{1,9}(\.[0-9]{1,6})?$' group by 1 loop
   v_price:=coalesce((select b.quantity from erp_stock.balance b where b.product_id=r.product_id and b.warehouse_id=v_wh),0);
   if erp_pos.pref_flag('pdv.bloquear_quantidade_zero') and v_price<=0 then raise exception 'erp_pos_stock_zero' using errcode='22023'; end if;
   if not erp_pos.pref_flag('pdv.estoque_negativo') and r.qty>v_price then raise exception 'erp_pos_stock_insufficient' using errcode='22023'; end if;
  end loop;
 end if;

 -- 242: the Lista de preço of the sale is also the one of the pedido (196 price_list_id), read by Pedidos de venda and the print.
 v_body:=v_doc||jsonb_build_object('contact_id',v_contact,'installments',v_installments,'ship_date',v_today::text,'price_list_id',v_list,
  'commercial',jsonb_build_object('introduction',null,'attention_to',null,'seller_reference',null,'store_reference',null,'business_unit_reference',null,
   'transport',jsonb_build_object('freight_mode',case when coalesce(v_doc->>'freight','0')~'^0+(\.0+)?$' then '9' else '0' end,'volume_count',null,'gross_weight',null,
    'delivery_days',null,'carrier_reference',null,'service_reference',null,'tracking_code',null)));
 if v_id is null then
  v_saved:=public.erp_document_save(p_user,'sales_orders',null,0,erp_pos.step(p_command,'save'),v_body);
 else
  v_saved:=public.erp_document_save(p_user,'sales_orders',v_sale.document_id,erp_pos.document_version(v_sale.document_id),erp_pos.step(p_command,'save'),v_body);
 end if;
 -- 242: the Frente de caixa does not send a sale for the approval of the discount (239): above the limit it stays refused.
 if v_saved ? 'discount_approval' then raise exception 'erp_document_seller_discount_limit' using errcode='22023'; end if;
 v_document:=(v_saved#>>'{document,id}')::uuid;
 if (v_saved#>>'{document,status}') is distinct from 'open' then raise exception 'erp_pos_document_state' using errcode='40001'; end if;
 v_total:=round((v_saved#>>'{document,totals,total}')::numeric*100)::bigint;
 if jsonb_array_length(v_payments)>0 and v_sum<>v_total then raise exception 'erp_pos_payments_mismatch' using errcode='22023'; end if;

 if v_id is null then
  insert into erp_pos.sale(document_id,account_id,cash_session_id,operator_id,kind,table_number,state,customer_identified,price_list_id,destination_account_id,to_ledger,total_cents,
   cash_received_cents,change_cents,command_id)
  values(v_document,v_account,v_session,p_user,v_kind,v_table,'open',v_identified,v_list,v_dest,erp_pos.flag(p_data,'to_ledger'),v_total,v_received,v_change,p_command) returning id into v_id;
 else
  -- O caixa é o desta gravação: a venda conta no caixa em que foi finalizada (nunca num caixa anterior, talvez já fechado).
  update erp_pos.sale set account_id=v_account,cash_session_id=v_session,kind=v_kind,table_number=v_table,customer_identified=v_identified,price_list_id=v_list,
   destination_account_id=v_dest,to_ledger=erp_pos.flag(p_data,'to_ledger'),total_cents=v_total,cash_received_cents=v_received,change_cents=v_change,version=version+1,updated_at=clock_timestamp() where id=v_id;
  delete from erp_pos.sale_payment where sale_id=v_id;
 end if;
 insert into erp_pos.sale_payment(sale_id,position,payment_method_id,method_name,payment_type,days,due_on,amount_cents,note)
 select v_id,(x->>'position')::integer,(x->>'payment_method_id')::uuid,x->>'method_name',x->>'payment_type',(x->>'days')::integer,(x->>'due_on')::date,(x->>'amount_cents')::bigint,x->>'note'
 from jsonb_array_elements(v_payments) x;
 return v_id;
end $$;

revoke all on function erp_pos.sale_write(uuid,uuid,jsonb,boolean,jsonb) from public,anon,authenticated,service_role;
commit;
