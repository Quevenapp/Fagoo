-- Mão dupla com o Origin, parte 3: contas a receber e a pagar (com baixas) e estoque.
-- * Contas: um título do Brufap vira uma conta no Origin (POST/PUT/DELETE /contas/receber|pagar); uma baixa do Brufap vira
--   POST /contas/.../baixar. Do Origin chegam a conta, o valor pago (valor - saldo) e o cancelamento: o que foi pago no Origin
--   e ainda não no Brufap vira uma baixa nativa na conta financeira padrão da sincronização (ou na conta de mesmo nome do
--   portador). A API do Origin não tem estorno de baixa: um estorno feito no Brufap fica registrado como pendência para ser
--   repetido no Origin; um estorno feito no Origin estorna a baixa mais recente no Brufap.
-- * Estoque: cada lançamento nativo (manual, de documento, de nota, balanço) vai ao Origin como entrada ou saída
--   (POST /estoques) no depósito vinculado (086). O que muda no saldo do Origin sem ter saído do Brufap (venda lançada no Origin,
--   balanço no Origin) chega como ajuste nativo, deixando o saldo do Brufap igual ao do Origin.
begin;
do $$begin
 if to_regprocedure('erp_sync.pull_one(text,text)') is null then raise exception 'origin_two_way_011_requires_010' using errcode='55000'; end if;
end$$;

-- Vínculo por nome com as tabelas de apoio do Origin (área bruta): categorias de receita/despesa e contas (portadores).
create function erp_sync.category_origin(p_native uuid) returns text
language sql stable security definer set search_path=pg_catalog as $$
 select r.source_id from erp_finance.category c join origin_sync.raw_record r on r.entity='financial_categories'
  and lower(btrim(r.payload->>'descricao'))=lower(btrim(c.name)) where c.id=p_native order by r.source_id limit 1
$$;
create function erp_sync.category_native(p_origin text,p_kind text) returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select c.id from origin_sync.raw_record r join erp_finance.category c on lower(btrim(c.name))=lower(btrim(r.payload->>'descricao'))
 where r.entity='financial_categories' and r.source_id=p_origin and c.active and c.deleted_at is null and c.kind in(p_kind,'both') order by c.id limit 1
$$;
create function erp_sync.account_origin(p_native uuid) returns text
language sql stable security definer set search_path=pg_catalog as $$
 select r.source_id from erp_finance.account a join origin_sync.raw_record r on r.entity='ledger_accounts'
  and lower(btrim(r.payload->>'descricao'))=lower(btrim(a.name)) where a.id=p_native order by r.source_id limit 1
$$;
create function erp_sync.account_native(p_origin text) returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce(
  (select a.id from origin_sync.raw_record r join erp_finance.account a on lower(btrim(a.name))=lower(btrim(r.payload->>'descricao'))
   where r.entity='ledger_accounts' and r.source_id=p_origin and a.active and a.deleted_at is null order by a.id limit 1),
  (select default_account_id from erp_sync.settings where singleton),
  (select id from erp_finance.account where active and deleted_at is null order by default_movements desc,created_at,id limit 1))
$$;
create function erp_sync.cents(p_value jsonb) returns bigint
language sql immutable set search_path=pg_catalog as $$
 select case when erp_sync.origin_number(p_value) is not null then round(erp_sync.origin_number(p_value)::numeric*100)::bigint end
$$;
create function erp_sync.money(p_cents bigint) returns jsonb
language sql immutable set search_path=pg_catalog as $$ select to_jsonb(round(p_cents/100.0,2)) $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Envio de contas e baixas
create function erp_sync.title_request(p_entity text,p_id uuid,p_op text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare t erp_finance.title; v_origin text:=erp_sync.origin_id(p_entity,p_id); v_path text:=case p_entity when 'receivables' then '/contas/receber' else '/contas/pagar' end;
 v_contact text; b jsonb; v_ref text;
begin
 select * into t from erp_finance.title where id=p_id;
 if p_op='delete' or not found or t.deleted_at is not null or t.cancelled then
  if v_origin is null then return jsonb_build_object('skip','NOT_IN_ORIGIN'); end if;
  return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','DELETE','path',v_path||'/'||v_origin)),'origin_id',v_origin,'deleted',true);
 end if;
 v_contact:=erp_sync.origin_id('contacts',t.contact_id);
 if v_contact is null then
  perform erp_sync.enqueue_dependency('contacts',t.contact_id);
  return jsonb_build_object('blocked',jsonb_build_array(jsonb_build_object('entity','contacts','record_id',t.contact_id)));
 end if;
 b:=erp_sync.base_payload(p_entity,v_origin)-'situacao'-'vencimentoOriginal'-'ocorrencia';
 b:=b||jsonb_strip_nulls(jsonb_build_object('vencimento',t.due_on::text,'valor',erp_sync.money(t.amount_cents),'contato',jsonb_build_object('id',v_contact::bigint),
  'dataEmissao',t.issued_on::text,'competencia',t.competence_on::text,'historico',left(coalesce(t.history,t.description),1000),'numeroDocumento',left(t.source_reference,50)));
 v_ref:=erp_sync.payment_method_origin(t.payment_method_id); if v_ref is not null then b:=b||jsonb_build_object('formaPagamento',jsonb_build_object('id',v_ref::bigint)); end if;
 v_ref:=erp_sync.category_origin(t.category_id); if v_ref is not null then b:=b||jsonb_build_object('categoria',jsonb_build_object('id',v_ref::bigint)); end if;
 v_ref:=erp_sync.account_origin(t.account_id); if v_ref is not null then b:=b||jsonb_build_object('portador',jsonb_build_object('id',v_ref::bigint)); end if;
 if v_origin is null then
  return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','POST','path',v_path,'body',b||'{"ocorrencia":{"tipo":1}}'::jsonb)),'fetch',v_path||'/{id}');
 end if;
 return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','PUT','path',v_path||'/'||v_origin,'body',b)),'origin_id',v_origin,'fetch',v_path||'/'||v_origin);
end$$;

create function erp_sync.settlement_request(p_entity text,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare st erp_finance.settlement; t erp_finance.title; v_title text; v_path text:=case p_entity when 'receivables' then '/contas/receber' else '/contas/pagar' end;
 v_portador text; v_category text; v_base jsonb;
begin
 select * into st from erp_finance.settlement where id=p_id;
 if not found then return jsonb_build_object('skip','NOTHING_TO_SEND'); end if;
 if st.kind='reversal' then return jsonb_build_object('skip','ORIGIN_API_HAS_NO_SETTLEMENT_REVERSAL'); end if;
 select * into t from erp_finance.title where id=st.title_id;
 v_title:=erp_sync.origin_id(p_entity,t.id);
 if v_title is null then
  perform erp_sync.enqueue_dependency(p_entity,t.id);
  return jsonb_build_object('blocked',jsonb_build_array(jsonb_build_object('entity',p_entity,'record_id',t.id)));
 end if;
 select payload into v_base from origin_sync.raw_record where entity=p_entity and source_id=v_title;
 v_portador:=coalesce(erp_sync.account_origin(st.account_id),erp_sync.origin_ref(v_base#>'{portador,id}'),
  (select source_id from origin_sync.raw_record where entity='ledger_accounts' order by source_id limit 1));
 v_category:=coalesce(erp_sync.category_origin(t.category_id),erp_sync.origin_ref(v_base#>'{categoria,id}'),
  (select source_id from origin_sync.raw_record where entity='financial_categories' order by source_id limit 1));
 if v_portador is null or v_category is null then return jsonb_build_object('skip','ORIGIN_ACCOUNT_OR_CATEGORY_UNKNOWN'); end if;
 return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','POST','path',v_path||'/'||v_title||'/baixar','body',
  jsonb_build_object('data',st.posted_on::text,'usarDataVencimento',false,'portador',jsonb_build_object('id',v_portador::bigint),
   'categoria',jsonb_build_object('id',v_category::bigint),'historico',left(coalesce(st.note,'Baixa registrada no Brufap'),500),
   'valorRecebido',erp_sync.money(st.principal_cents),'juros',erp_sync.money(st.interest_cents+st.penalty_cents),
   'desconto',erp_sync.money(st.discount_cents),'acrescimo',0,'tarifa',erp_sync.money(st.fee_cents)))),
  'fetch',v_path||'/'||v_title,'fetch_entity',p_entity);
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Envio de movimentos de estoque
create function erp_sync.stock_request(p_movement uuid,p_ordinal integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare e erp_stock.entry; m erp_stock.movement; v_product text; v_deposit text; md erp_stock.movement_detail;
begin
 select * into e from erp_stock.entry where movement_id=p_movement and ordinal=p_ordinal;
 if not found then return jsonb_build_object('skip','NOTHING_TO_SEND'); end if;
 select * into m from erp_stock.movement where id=p_movement;
 if e.quantity=0 then return jsonb_build_object('skip','NOTHING_TO_SEND'); end if;
 v_product:=erp_sync.origin_id('products',e.product_id);
 if v_product is null then
  perform erp_sync.enqueue_dependency('products',e.product_id);
  return jsonb_build_object('blocked',jsonb_build_array(jsonb_build_object('entity','products','record_id',e.product_id)));
 end if;
 select source_id into v_deposit from erp_warehouse_import.binding where warehouse_id=e.warehouse_id order by imported_at desc limit 1;
 if v_deposit is null then return jsonb_build_object('skip','WAREHOUSE_NOT_IN_ORIGIN'); end if;
 select * into md from erp_stock.movement_detail where movement_id=p_movement and product_id=e.product_id order by revision desc limit 1;
 return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','POST','path','/estoques','body',jsonb_strip_nulls(jsonb_build_object(
   'produto',jsonb_build_object('id',v_product::bigint),'deposito',jsonb_build_object('id',v_deposit::bigint),
   'operacao',case when e.quantity>0 then 'E' else 'S' end,'quantidade',to_jsonb(abs(e.quantity)),
   'preco',to_jsonb(md.unit_price),'custo',to_jsonb(md.unit_cost),'observacoes',left('Brufap: '||m.reason,200))))),
  'fetch_stock',v_product);
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Recebimento de contas
create function erp_sync.pull_title(s origin_sync.raw_record) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare v_kind text:=case s.entity when 'receivables' then 'receivable' else 'payable' end; v_id uuid:=erp_sync.local_id(s.entity,s.source_id);
 v_remote timestamptz:=coalesce(s.source_updated_at,s.changed_at); t erp_finance.title; v_contact uuid; v_party text; v_amount bigint; v_paid bigint;
 v_situation text:=s.payload->>'situacao'; v_due date; v_issued date; v_actor uuid:=erp_sync.actor(); v_deleted boolean; v_account uuid; v_delta bigint;
 st erp_finance.settlement; v_result text:='updated'; v_category uuid; v_method uuid;
begin
 v_deleted:=coalesce(s.payload#>'{_brufap_source,deleted}'='true'::jsonb,false);
 if v_id is not null then
  select * into t from erp_finance.title where id=v_id for update;
  if not found then v_id:=null; end if;
 end if;
 if v_id is not null then
  if erp_sync.local_newer(s.entity,v_id,v_remote) then return 'local_newer'; end if;
  perform erp_sync.local_superseded(s.entity,v_id);
 elsif v_deleted then return 'deleted_unknown';
 end if;
 perform erp_sync.set_applying(true);
 if v_deleted or v_situation='5' then
  if v_id is not null and not t.cancelled then
   update erp_finance.title set cancelled=true,deleted_at=case when v_deleted then clock_timestamp() end,deleted_by=case when v_deleted then v_actor end,
    deleted_note=case when v_deleted then 'Excluída no Origin' end,version=version+1,updated_at=clock_timestamp() where id=v_id;
  end if;
  if v_id is not null then perform erp_sync.mark_pulled(s.entity,v_id,s,v_deleted); end if;
  perform erp_sync.set_applying(false);
  if v_id is null and not v_deleted and v_situation='5' then return 'cancelled_unknown'; end if;
  return 'cancelled';
 end if;
 v_party:=erp_sync.origin_ref(s.payload#>'{contato,id}');
 v_contact:=erp_sync.local_id('contacts',v_party);
 if v_contact is null then
  if exists(select 1 from erp_sync.inbox where entity='contacts' and source_id=v_party) then raise exception 'DEPENDENCY_PENDING' using errcode='55000'; end if;
  raise exception 'CONTACT_NOT_IN_ORIGIN_SYNC' using errcode='22023';
 end if;
 v_amount:=erp_sync.cents(s.payload->'valor');
 if v_amount is null or v_amount<=0 then raise exception 'AMOUNT_INVALID' using errcode='22023'; end if;
 v_due:=erp_fiscal_invoices.origin_date(s.payload->'vencimento');
 v_issued:=least(coalesce(erp_fiscal_invoices.origin_date(s.payload->'dataEmissao'),v_due),v_due);
 if v_due is null then raise exception 'DUE_DATE_INVALID' using errcode='22023'; end if;
 v_category:=erp_sync.category_native(erp_sync.origin_ref(s.payload#>'{categoria,id}'),v_kind);
 v_method:=erp_sync.payment_method_native(erp_sync.origin_ref(s.payload#>'{formaPagamento,id}'));
 if v_id is null then
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents,
   competence_on,original_due_on,payment_method_id,bank_number)
  values(gen_random_uuid(),1,1,v_kind,v_contact,v_category,left(coalesce(nullif(btrim(s.payload->>'historico'),''),'Conta do Origin '||s.source_id),240),
   left(s.payload->>'numeroDocumento',200),v_issued,v_due,v_amount,coalesce(erp_fiscal_invoices.origin_date(s.payload->'competencia'),v_issued),
   coalesce(erp_fiscal_invoices.origin_date(s.payload->'vencimentoOriginal'),v_due),v_method,left(s.payload->>'numeroBanco',40))
  returning * into t;
  v_id:=t.id; v_result:='created';
 else
  update erp_finance.title set contact_id=v_contact,due_on=v_due,issued_on=v_issued,
   amount_cents=case when settled_cents<=v_amount then v_amount else amount_cents end,cancelled=false,
   category_id=coalesce(v_category,category_id),payment_method_id=coalesce(v_method,payment_method_id),
   description=left(coalesce(nullif(btrim(s.payload->>'historico'),''),description),240),source_reference=coalesce(left(s.payload->>'numeroDocumento',200),source_reference),
   competence_on=coalesce(erp_fiscal_invoices.origin_date(s.payload->'competencia'),competence_on),
   version=version+1,updated_at=clock_timestamp() where id=v_id returning * into t;
 end if;
 -- Valor pago no Origin: valor - saldo (situações 2 pago, 3 parcial, 7 confirmado); aberto sem saldo informado é zero.
 v_paid:=case when v_situation in('2','7') then coalesce(v_amount-erp_sync.cents(s.payload->'saldo'),v_amount)
  when v_situation='3' then coalesce(v_amount-erp_sync.cents(s.payload->'saldo'),t.settled_cents) else coalesce(v_amount-erp_sync.cents(s.payload->'saldo'),0) end;
 v_paid:=greatest(0,least(v_paid,v_amount));
 v_delta:=v_paid-t.settled_cents;
 if v_delta>0 then
  v_account:=erp_sync.account_native(erp_sync.origin_ref(s.payload#>'{portador,id}'));
  -- Sem conta financeira no Brufap a baixa não tem onde entrar: a conta volta para a fila e a pendência aparece na tela.
  if v_account is null then raise exception 'NO_FINANCE_ACCOUNT_FOR_SETTLEMENT' using errcode='55000'; end if;
  -- Conta que já chega paga: a data é a do pagamento informado (ou o vencimento), não a de hoje, para não jogar o histórico
  -- no caixa do dia. Pagamento observado depois: a data da observação.
  perform public.erp_finance_execute(v_actor,gen_random_uuid(),'settle',jsonb_build_object('id',v_id,'expected_version',t.version,'account_id',v_account,
   'posted_on',(case when v_result='created' then least(greatest(coalesce(erp_fiscal_invoices.origin_date(s.payload->'dataPagamento'),v_due),t.issued_on),current_date)
    else greatest(current_date,t.issued_on) end)::text,'principal_cents',v_delta::text,'note','Baixa registrada no Origin'));
 elsif v_delta<0 then
  -- Estorno no Origin: estorna as baixas mais recentes até o valor pago voltar ao do Origin.
  for st in select * from erp_finance.settlement x where x.title_id=v_id and x.kind='payment'
   and not exists(select 1 from erp_finance.settlement r where r.reverses_id=x.id) order by x.posted_on desc,x.created_at desc loop
   exit when (select settled_cents from erp_finance.title where id=v_id)<=v_paid;
   perform public.erp_finance_execute(v_actor,gen_random_uuid(),'reverse',jsonb_build_object('id',v_id,'expected_version',(select version from erp_finance.title where id=v_id),
    'settlement_id',st.id,'posted_on',greatest(current_date,st.posted_on)::text,'note','Baixa estornada no Origin'));
  end loop;
 end if;
 perform erp_sync.mark_pulled(s.entity,v_id,s,false);
 perform erp_sync.set_applying(false);
 return v_result;
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Recebimento de saldos: ajuste nativo para igualar o saldo do Origin, por produto e depósito vinculados.
create function erp_sync.pull_stock(s origin_sync.raw_record) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare v_product uuid:=erp_sync.local_id('products',erp_sync.origin_ref(s.payload#>'{produto,id}')); dep jsonb; v_warehouse uuid; v_origin numeric;
 b erp_stock.balance; v_delta numeric; v_items jsonb:='[]'; v_pair erp_sync.stock_pair; v_skipped integer:=0; v_actor uuid:=erp_sync.actor();
begin
 if v_product is null then return 'product_unknown'; end if;
 if not exists(select 1 from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where p.record_id=v_product and p.kind='P' and coalesce(p.format,'S')<>'V' and p.unit is not null) then
  return 'not_stocked'; end if;
 for dep in select value from jsonb_array_elements(case when jsonb_typeof(s.payload->'depositos')='array' then s.payload->'depositos' else '[]'::jsonb end) loop
  select warehouse_id into v_warehouse from erp_warehouse_import.binding where source_id=erp_sync.origin_ref(dep->'id') order by imported_at desc limit 1;
  v_origin:=erp_sync.origin_number(dep->'saldoFisico')::numeric;
  if v_warehouse is null or v_origin is null then continue; end if;
  select * into v_pair from erp_sync.stock_pair where product_id=v_product and warehouse_id=v_warehouse;
  -- Movimento do Brufap ainda não enviado, ou leitura anterior ao último envio: o saldo do Origin ainda não o contém.
  if exists(select 1 from erp_sync.outbox o where o.entity='stock' and o.state in('pending','sending')
     and (o.detail->>'product_id')::uuid=v_product and (o.detail->>'warehouse_id')::uuid=v_warehouse)
   or (v_pair.last_push_at is not null and s.last_seen_at<v_pair.last_push_at) then v_skipped:=v_skipped+1; continue; end if;
  select * into b from erp_stock.balance where product_id=v_product and warehouse_id=v_warehouse;
  v_delta:=round(v_origin-coalesce(b.quantity,0),6);
  if v_delta<>0 then
   v_items:=v_items||jsonb_build_array(jsonb_build_object('product_id',v_product,'warehouse_id',v_warehouse,'quantity',v_delta::text,'expected_version',coalesce(b.version,0)));
  end if;
  insert into erp_sync.stock_pair(product_id,warehouse_id,last_pull_at) values(v_product,v_warehouse,clock_timestamp())
  on conflict(product_id,warehouse_id) do update set last_pull_at=excluded.last_pull_at;
 end loop;
 if jsonb_array_length(v_items)>0 then
  perform erp_sync.set_applying(true);
  perform erp_stock.post(v_actor,gen_random_uuid(),'adjustment',(clock_timestamp() at time zone 'America/Sao_Paulo')::date,'Saldo sincronizado com o Origin',
   left('Origin '||(s.payload#>>'{produto,id}'),100),v_items);
  perform erp_sync.set_applying(false);
 end if;
 -- O envio pendente relê o saldo do Origin depois de confirmado (erp_sync_stage), e essa nova leitura volta para cá.
 return case when jsonb_array_length(v_items)>0 then 'adjusted' when v_skipped>0 then 'waiting_push' else 'unchanged' end;
end$$;

revoke all on all functions in schema erp_sync from public,anon,authenticated,service_role;
grant execute on function erp_sync.applying(),erp_sync.enabled(),erp_sync.enqueue(text,uuid,text,integer,jsonb) to erp_document_mirror_writer;
commit;
