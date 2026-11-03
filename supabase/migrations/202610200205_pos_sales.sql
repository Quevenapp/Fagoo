-- Vendas > Frente de caixa (PDV), lane frente de caixa, onda D — parte 2: guardar, finalizar, cancelar e trocar a mesa da venda.
-- A venda é gravada como pedido de venda pelas RPCs públicas de documentos (erp_document_save e erp_document_transition, nunca
-- redefinidas aqui), numa única transação idempotente (command_id; os comandos das outras áreas usam identificadores derivados):
-- - "Enviar pré-venda" e a comanda de mesa guardam o pedido Em aberto, sem efeitos.
-- - "Finalizar venda" grava o pedido, muda para Atendido e, conforme o perfil, lança o estoque (erp_document_stock_preview/post),
--   as contas a receber (erp_document_finance_preview/post) e a baixa das parcelas à vista no caixa (erp_finance_execute settle);
--   com o Destino "Ficha Financeira" as parcelas ficam em aberto na ficha do cliente.
--   Perfil sem permissão de estoque ou do financeiro deixa esses efeitos pendentes no pedido (Lançar estoque / Lançar contas).
-- - Cancelar estorna a baixa, as contas e o estoque pelas mesmas RPCs e muda o pedido para Cancelado, com o motivo; a venda com
--   devolução (206) não é cancelada.
-- - A venda aberta grava só sobre a versão do pedido que a tela leu (o pedido pode ser editado em Pedidos de venda).
-- As preferências de Preferências > Vendas > Frente de caixa (controle de caixa, caixas únicos, estoque negativo, quantidade zero,
-- mesas) e os módulos do vendedor (registro de itens e de pagamento, fechamento, preço unitário, exclusão de itens e forma das
-- parcelas) são conferidos aqui, não só na tela. Nenhuma nota fiscal é emitida: a NFC-e é preparada pela tela de notas fiscais
-- (homologação), a partir do pedido.
begin;

do $$begin
 if to_regprocedure('erp_pos.access(uuid,boolean)') is null or to_regprocedure('public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text)') is null
  or to_regprocedure('public.erp_document_stock_post(uuid,text,uuid,integer,uuid,text,date,text,jsonb)') is null
  or to_regprocedure('public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb)') is null
  or to_regprocedure('public.erp_finance_execute(uuid,uuid,text,jsonb)') is null or to_regprocedure('public.erp_pricing_product_lists(uuid,uuid)') is null then
  raise exception 'pos_sales_205_requires_204' using errcode='55000'; end if;
end$$;

create function erp_pos.document_version(p_id uuid) returns integer language sql stable set search_path=pg_catalog as $$
 select version from erp_documents.document where id=p_id $$;

-- Devoluções da venda finalizada ("Gerar devolução", migração 206). A tabela nasce aqui porque o cancelamento abaixo recusa a
-- venda que já tem devolução (o estorno inteiro devolveria de novo o estoque e o dinheiro já devolvidos).
create table erp_pos.sale_return(
 id uuid primary key default gen_random_uuid(),
 sale_id uuid not null references erp_pos.sale(id),
 items jsonb not null check(jsonb_typeof(items)='array' and jsonb_array_length(items) between 1 and 250),
 -- Valor dos itens devolvidos (com a parte do desconto da venda) e o que saiu em dinheiro do caixa (nunca mais do que a venda recebeu).
 value_cents bigint not null check(value_cents between 0 and 99999999999999),
 refund_cents bigint not null check(refund_cents between 0 and value_cents),
 refund_account_id uuid references erp_finance.account(id),
 cash_session_id uuid references erp_finance.cash_session(id),
 stock_movement_id uuid references erp_stock.movement(id),
 cash_entry_id uuid references erp_finance.cash_entry(id),
 reason text not null check(length(reason) between 3 and 500 and reason!~'[[:cntrl:]]'),
 actor uuid not null references auth.users(id),command_id uuid not null unique,created_at timestamptz not null default clock_timestamp(),
 check((cash_entry_id is null)=(refund_account_id is null) and (cash_entry_id is not null or refund_cents=0))
);
create index erp_pos_sale_return_sale on erp_pos.sale_return(sale_id,created_at);
create index erp_pos_sale_return_session on erp_pos.sale_return(cash_session_id) where cash_session_id is not null;
alter table erp_pos.sale_return enable row level security;
revoke all on erp_pos.sale_return from public,anon,authenticated,service_role;
create trigger immutable_return before update or delete on erp_pos.sale_return for each row execute function erp_pos.immutable_history();
create function erp_pos.amount_text(p_cents bigint) returns text language sql immutable set search_path=pg_catalog as $$
 select (p_cents/100)::text||'.'||lpad((p_cents%100)::text,2,'0') $$;

-- Guarda a venda (nova ou aberta) como pedido Em aberto; devolve o id da venda. Comum a "sale_save" e "sale_finish".
create function erp_pos.sale_write(p_user uuid,p_command uuid,p_data jsonb,p_finish boolean,a jsonb) returns uuid
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

 v_body:=v_doc||jsonb_build_object('contact_id',v_contact,'installments',v_installments,'ship_date',v_today::text,
  'commercial',jsonb_build_object('introduction',null,'attention_to',null,'seller_reference',null,'store_reference',null,'business_unit_reference',null,
   'transport',jsonb_build_object('freight_mode',case when coalesce(v_doc->>'freight','0')~'^0+(\.0+)?$' then '9' else '0' end,'volume_count',null,'gross_weight',null,
    'delivery_days',null,'carrier_reference',null,'service_reference',null,'tracking_code',null)));
 if v_id is null then
  v_saved:=public.erp_document_save(p_user,'sales_orders',null,0,erp_pos.step(p_command,'save'),v_body);
 else
  v_saved:=public.erp_document_save(p_user,'sales_orders',v_sale.document_id,erp_pos.document_version(v_sale.document_id),erp_pos.step(p_command,'save'),v_body);
 end if;
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

-- Efeitos de "Finalizar venda": pedido Atendido e, conforme o perfil, estoque, contas e a baixa das parcelas à vista.
create function erp_pos.sale_effects(p_user uuid,p_command uuid,p_id uuid,a jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare s erp_pos.sale%rowtype; d erp_documents.document%rowtype; v_role text:=a->>'role'; v_today date:=erp_pos.today(); v_reason text; v_preview jsonb; v_result jsonb;
 v_stock text; v_finance text; v_posting uuid; t jsonb; p erp_pos.sale_payment%rowtype; m erp_catalog.payment_method%rowtype; v_target uuid; v_settled bigint:=0; v_open bigint:=0;
begin
 select * into s from erp_pos.sale where id=p_id;
 select * into d from erp_documents.document where id=s.document_id;
 v_reason:='Venda da frente de caixa nº '||d.number::text;
 if d.status<>'fulfilled' then
  perform public.erp_document_transition(p_user,'sales_orders',d.id,d.version,erp_pos.step(p_command,'fulfil'),'fulfilled',null);
 end if;
 -- Estoque: só os produtos de estoque (tipo P) movimentam; uma regra do Gerenciador de transições pode já ter lançado.
 if exists(select 1 from erp_stock.document_posting where document_id=d.id and state='active') then v_stock:='posted';
 elsif not exists(select 1 from erp_documents.item i join erp_catalog.product x on x.record_id=i.product_id where i.document_id=d.id and x.kind='P') then v_stock:='none';
 elsif v_role in('admin','estoque') then
  v_preview:=public.erp_document_stock_preview(p_user,'sales_orders',d.id,erp_pos.document_version(d.id),v_today,v_reason)->'preview';
  perform public.erp_document_stock_post(p_user,'sales_orders',d.id,erp_pos.document_version(d.id),erp_pos.step(p_command,'stock'),v_preview->>'preview_hash',v_today,v_reason,
   coalesce((select jsonb_agg(i->'id') from jsonb_array_elements(v_preview->'ignored') i),'[]'::jsonb));
  v_stock:='posted';
 else v_stock:='pending'; end if;
 -- Contas a receber das parcelas e baixa das parcelas à vista cuja forma vai para "Caixa e bancos": na conta da forma, senão no
 -- Destino da venda, senão na loja (conta Caixa). As demais parcelas ficam em aberto em Contas a receber.
 if exists(select 1 from erp_finance.document_posting where document_id=d.id and state='active') then v_finance:='posted';
 elsif v_role in('admin','financeiro') then
  v_preview:=public.erp_document_finance_preview(p_user,'sales_orders',d.id,erp_pos.document_version(d.id),null,null)->'preview';
  perform public.erp_document_finance_post(p_user,'sales_orders',d.id,erp_pos.document_version(d.id),erp_pos.step(p_command,'finance'),v_preview->>'preview_hash',null,null);
  v_finance:='posted';
 else v_finance:='pending'; end if;
 select id into v_posting from erp_finance.document_posting where document_id=d.id and state='active';
 if v_posting is not null then
  for p in select * from erp_pos.sale_payment where sale_id=s.id order by position loop
   select x into t from jsonb_array_elements(erp_finance.document_title_rows(v_posting)) x where (x->>'position')::integer=p.position;
   if t is null then continue; end if;
   update erp_pos.sale_payment set title_id=(t->>'id')::uuid where sale_id=s.id and position=p.position;
   select * into m from erp_catalog.payment_method where id=p.payment_method_id;
   v_target:=coalesce(m.account_id,s.destination_account_id,s.account_id);
   if v_role in('admin','financeiro') and not s.to_ledger and p.days=0 and m.destination='caixa' and v_target is not null and (t->>'settled_cents')::bigint=0 and not (t->>'cancelled')::boolean then
    v_result:=public.erp_finance_execute(p_user,erp_pos.step(p_command,'settle:'||p.position::text),'settle',jsonb_build_object('id',t->>'id','expected_version',(t->>'version')::integer,
     'account_id',v_target,'posted_on',v_today::text,'principal_cents',p.amount_cents::text,'note',left('Recebido na frente de caixa — venda nº '||d.number::text,500)));
    update erp_pos.sale_payment set settlement_id=(v_result#>>'{settlement,id}')::uuid where sale_id=s.id and position=p.position;
    v_settled:=v_settled+p.amount_cents;
   else v_open:=v_open+p.amount_cents; end if;
  end loop;
 end if;
 return jsonb_build_object('stock',v_stock,'finance',v_finance,'settled_cents',v_settled::text,'open_cents',v_open::text);
end $$;

-- Cancelar a venda: estorna a baixa, as contas e o estoque lançados e muda o pedido para Cancelado (motivo obrigatório).
-- A venda com nota fiscal vinculada não é cancelada aqui (a nota é cancelada ou excluída antes, nas notas fiscais).
create function erp_pos.sale_cancel(p_user uuid,p_command uuid,p_data jsonb,a jsonb) returns uuid
language plpgsql set search_path=pg_catalog as $$
declare s erp_pos.sale%rowtype; d erp_documents.document%rowtype; v_reason text; v_role text:=a->>'role'; v_today date:=erp_pos.today(); p erp_pos.sale_payment%rowtype;
 v_title erp_finance.title%rowtype; v_preview jsonb; v_posting record; v_titles jsonb; v_effects jsonb; v_stock_reversed boolean:=false; v_finance_reversed boolean:=false;
begin
 perform erp_pos.keys(p_data,array['sale_id','expected_version','reason'],array['sale_id','expected_version','reason']);
 select * into s from erp_pos.sale where id=erp_pos.uid(p_data,'sale_id',true) for update;
 if not found then raise exception 'erp_pos_not_found' using errcode='P0002'; end if;
 if s.version<>erp_pos.int(p_data,'expected_version',1,2147483646) then raise exception 'erp_pos_version_conflict' using errcode='40001'; end if;
 if s.state='cancelled' then raise exception 'erp_pos_sale_state' using errcode='40001'; end if;
 if s.state='finished' and not (a->>'finish')::boolean then raise exception 'erp_pos_finish_denied' using errcode='42501'; end if;
 v_reason:=erp_pos.txt(p_data,'reason',1000,true);
 if length(v_reason)<3 then raise exception 'erp_pos_reason_required' using errcode='22023'; end if;
 if erp_pos.nfce(s.document_id) is not null then raise exception 'erp_pos_sale_invoice_linked' using errcode='40001'; end if;
 -- Com devolução, o estorno inteiro devolveria de novo ao estoque e ao cliente o que a devolução já devolveu.
 if exists(select 1 from erp_pos.sale_return where sale_id=s.id) then raise exception 'erp_pos_sale_has_returns' using errcode='40001'; end if;
 if exists(select 1 from erp_stock.document_posting where document_id=s.document_id and state='active') and v_role not in('admin','estoque') then
  raise exception 'erp_pos_reverse_stock_denied' using errcode='42501'; end if;
 if exists(select 1 from erp_finance.document_posting where document_id=s.document_id and state='active') and v_role not in('admin','financeiro') then
  raise exception 'erp_pos_reverse_finance_denied' using errcode='42501'; end if;
 for p in select * from erp_pos.sale_payment where sale_id=s.id and settlement_id is not null order by position loop
  if not exists(select 1 from erp_finance.settlement where reverses_id=p.settlement_id) then
   select * into v_title from erp_finance.title where id=p.title_id;
   perform public.erp_finance_execute(p_user,erp_pos.step(p_command,'unsettle:'||p.position::text),'reverse',jsonb_build_object('id',v_title.id,'expected_version',v_title.version,
    'settlement_id',p.settlement_id,'posted_on',v_today::text,'note',left('Venda cancelada na frente de caixa: '||v_reason,500)));
  end if;
 end loop;
 select id,version into v_posting from erp_finance.document_posting where document_id=s.document_id and state='active';
 if v_posting.id is not null then
  v_preview:=public.erp_document_finance_reverse_preview(p_user,'sales_orders',s.document_id,erp_pos.document_version(s.document_id),v_posting.id,v_posting.version)->'preview';
  select coalesce(jsonb_agg(jsonb_build_object('id',t->>'id','version',(t->>'version')::integer)),'[]'::jsonb) into v_titles from jsonb_array_elements(v_preview->'titles') t;
  perform public.erp_document_finance_reverse(p_user,'sales_orders',s.document_id,erp_pos.document_version(s.document_id),v_posting.id,v_posting.version,
   erp_pos.step(p_command,'finance_reverse'),v_preview->>'preview_hash',v_titles,left('Venda cancelada na frente de caixa: '||v_reason,1000));
  v_finance_reversed:=true;
 end if;
 select id,version into v_posting from erp_stock.document_posting where document_id=s.document_id and state='active';
 if v_posting.id is not null then
  v_preview:=public.erp_document_stock_reverse_preview(p_user,'sales_orders',s.document_id,erp_pos.document_version(s.document_id),v_posting.id,v_posting.version,v_today,
   left('Venda cancelada na frente de caixa: '||v_reason,500))->'preview';
  perform public.erp_document_stock_reverse(p_user,'sales_orders',s.document_id,erp_pos.document_version(s.document_id),v_posting.id,v_posting.version,
   erp_pos.step(p_command,'stock_reverse'),v_preview->>'preview_hash',v_today,left('Venda cancelada na frente de caixa: '||v_reason,500));
  v_stock_reversed:=true;
 end if;
 select * into d from erp_documents.document where id=s.document_id;
 if d.status<>'cancelled' then
  perform public.erp_document_transition(p_user,'sales_orders',d.id,d.version,erp_pos.step(p_command,'cancel'),'cancelled',v_reason);
 end if;
 -- Estornado quando este cancelamento desfez o lançamento (também o lançado depois no pedido, a partir de um efeito pendente).
 v_effects:=jsonb_build_object('stock',case when v_stock_reversed or s.effects->>'stock'='posted' then 'reversed' else coalesce(s.effects->>'stock','none') end,
  'finance',case when v_finance_reversed or s.effects->>'finance'='posted' then 'reversed' else coalesce(s.effects->>'finance','none') end,
  'settled_cents',coalesce(s.effects->>'settled_cents','0'),'open_cents',coalesce(s.effects->>'open_cents','0'));
 update erp_pos.sale set state='cancelled',cancelled_at=clock_timestamp(),cancelled_by=p_user,cancel_reason=v_reason,effects=v_effects,version=version+1,updated_at=clock_timestamp()
  where id=s.id;
 return s.id;
end $$;

create function public.erp_pos_sale_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a jsonb; v_hash text; c erp_pos.command%rowtype; v_id uuid; v_before jsonb; v_result jsonb; v_effects jsonb; s erp_pos.sale%rowtype; v_table integer;
begin
 a:=erp_pos.access(p_user_id,true);
 if p_command_id is null or p_action is null or p_action not in('sale_save','sale_finish','sale_cancel','sale_transfer') or p_data is null or jsonb_typeof(p_data)<>'object'
  or octet_length(p_data::text)>262144 then raise exception 'erp_pos_invalid_action' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'scope','sale','action',p_action,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('erp_pos:'||p_command_id::text,0));
 select * into c from erp_pos.command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>v_hash then raise exception 'erp_pos_command_conflict' using errcode='40001'; end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if p_action in('sale_save','sale_finish') then
  v_id:=erp_pos.uid(p_data,'sale_id');
  if v_id is not null then v_before:=erp_pos.sale_view(v_id,true); end if;
  v_id:=erp_pos.sale_write(p_user_id,p_command_id,p_data,p_action='sale_finish',a);
  if p_action='sale_finish' then
   v_effects:=erp_pos.sale_effects(p_user_id,p_command_id,v_id,a);
   update erp_pos.sale set state='finished',finished_at=clock_timestamp(),finished_by=p_user_id,effects=v_effects,version=version+1,updated_at=clock_timestamp() where id=v_id;
  end if;
 elsif p_action='sale_cancel' then
  v_before:=erp_pos.sale_view(erp_pos.uid(p_data,'sale_id',true),true);
  v_id:=erp_pos.sale_cancel(p_user_id,p_command_id,p_data,a);
 else
  -- Transferir a comanda para outra mesa.
  perform erp_pos.keys(p_data,array['sale_id','expected_version','table_number'],array['sale_id','expected_version','table_number']);
  select * into s from erp_pos.sale where id=erp_pos.uid(p_data,'sale_id',true) for update;
  if not found then raise exception 'erp_pos_not_found' using errcode='P0002'; end if;
  if s.version<>erp_pos.int(p_data,'expected_version',1,2147483646) then raise exception 'erp_pos_version_conflict' using errcode='40001'; end if;
  if s.state<>'open' or s.kind<>'mesa' or not erp_pos.pref_flag('pdv.controle_mesas') then raise exception 'erp_pos_sale_state' using errcode='40001'; end if;
  v_table:=erp_pos.int(p_data,'table_number',1,9999);
  if v_table=s.table_number then raise exception 'erp_pos_invalid_number' using errcode='22023'; end if;
  if exists(select 1 from erp_pos.sale where state='open' and kind='mesa' and table_number=v_table) then raise exception 'erp_pos_table_busy' using errcode='40001'; end if;
  v_before:=erp_pos.sale_view(s.id,true);
  update erp_pos.sale set table_number=v_table,version=version+1,updated_at=clock_timestamp() where id=s.id;
  v_id:=s.id;
 end if;
 perform erp_pos.access(p_user_id,true);
 v_result:=jsonb_build_object('entity','pos_sale','record',erp_pos.sale_view(v_id,true),'action',p_action,'data_mode','erp_native','replayed',false);
 insert into erp_pos.command(id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'sale',v_hash,v_result);
 insert into erp_pos.audit(actor,command_id,sale_id,action,before_data,after_data) values(p_user_id,p_command_id,v_id,p_action,v_before,v_result->'record');
 return v_result;
end $$;

revoke all on all functions in schema erp_pos from public,anon,authenticated,service_role;
do $$declare f text;begin
 foreach f in array array['erp_pos_context(uuid)','erp_pos_settings_execute(uuid,uuid,text,jsonb)','erp_pos_favorites(uuid,uuid)',
  'erp_pos_sales(uuid,uuid,text,text,date,date,uuid,integer,integer)','erp_pos_sale_get(uuid,uuid)','erp_pos_sale_execute(uuid,uuid,text,jsonb)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end$$;
commit;
