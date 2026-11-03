-- 196: Pagamento, Lista de preço, impostos e lançamento automático de contas nos documentos (onda D da frente de documentos).
-- * Pagamento (pedidos de venda, OS e pedidos de compra): Destino (payment_account_id: a conta financeira das contas lançadas;
--   vazio = Contas a receber/pagar) e, no pedido de venda, Detalhes de pagamento (payment_means = tPag e payment_indicator =
--   indPag da NF-e; vazio = padrão da empresa). Cada parcela ganha a Forma (payment_method_id, Cadastros > Formas de pagamento,
--   também nas propostas) e os "Detalhes da parcela" (details: conta financeira, tipo de pagamento, bandeira, tipo de integração,
--   CNPJ da credenciadora, código de autorização, valor recebido, valor de taxa e de taxa de comissão). Conferidos na gravação
--   quando novos ou trocados (forma ativa e aplicável ao tipo do documento, conta financeira ativa).
-- * Lançar contas (manual, das transições e automático) grava a forma da parcela e a conta financeira do Destino em cada conta,
--   que continua em aberto: a ponte documento -> contas nunca baixa conta nem movimenta caixa (cash_movement_performed=false).
-- * Lista de preço (price_list_id) gravada no pedido de venda, na proposta e na OS (conferida quando nova ou trocada: lista
--   existente e válida agora) e o Preço lista de cada item (list_price). No pedido de compra, o Código no fornecedor do item
--   (supplier_code, até 100) e a consulta dos códigos do vínculo produto-fornecedor (erp_document_supplier_codes).
-- * Total do IPI e Total do ICMS ST (tax_ipi e tax_icms_st) somados ao total do documento (pedido de venda, proposta e OS; um
--   valor novo ou trocado exige Preferências > Vendas > Propostas "Exibe campos IPI e ST").
-- * Preferências > Vendas > Vendas "Lançamento automático de contas em Pedidos de Venda": ao salvar um pedido numa situação de
--   lançamento (Verificado, Em andamento, Atendido parcialmente, Atendido) ou ao mudar para uma delas, o servidor lança as
--   contas na mesma transação (parcelas salvas ou uma parcela à vista na data do pedido; categoria do pedido, senão a padrão),
--   com o perfil de quem salva. Sem permissão de contas ou com um impedimento, o pedido é salvo e a resposta diz o motivo.
-- * "Gerar venda" e "Gerar ordem de serviço" da proposta abrem o documento novo preenchido (erp_document_conversion_preview, nada
--   é gravado); o Salvar grava o documento com o vínculo único e conclui a proposta na mesma transação (source_proposal).
-- * Opções de pagamento do formulário (erp_document_payment_options): formas ativas aplicáveis ao tipo e contas financeiras ativas,
--   para quem grava o tipo de documento (quem escolhe; quem só lê vê os nomes escolhidos na leitura do documento).
-- Requer 102, 163, 164, 165, 168, 174 e 175.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 if to_regprocedure('erp_finance.payment_method_fee(uuid,bigint)') is null or to_regprocedure('erp_finance.document_title_number()') is null then
  raise exception 'document_payment_196_requires_174_175' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_documents.normalize(text,jsonb)','756983c4dd13bc7f6dc4deb944d26e0fbf35bbcdf7091320dd3083793becc1df'),
  ('erp_documents.extension_keys()','570bfd89747cce8805d6597f2ed81deed2d3960b2b8f8bd6a5b133d13042e9d5'),
  ('erp_documents.extension_data(jsonb)','d7618462bac867071cd32400b3b67f59c6230201e8e6bbcd5a26ab9dc24df3f1'),
  ('erp_documents.require_commercial_input(jsonb,jsonb)','90d4eb28113d9438a599e38382ffabb12d1a4b3b918b45e417d3430504f0641d'),
  ('public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb)','21c7a061d3c084479f0a92f8a15f8658b17a41382185306c6b7d06d9e8128637'),
  ('public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb)','41fe170a2f75bab24c72a3d3b66e91c33862b442a8925475a2889065bc1ee37d'),
  ('public.erp_document_copy_preview(uuid,text,uuid)','f8563c2ad5b77864c3cec06dc5bc74818066449e3c18de838d525b26527ebd8e'),
  ('public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid)','ee7c805c667d45045b0b00b89187f9358ef2c4523329eef1d908b01c3b7091f8'),
  ('public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb)','9768dfcb7603404ccb223da52cc97dea331b821959896fb31132bf8d1205ecd7'),
  ('public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb)','1dc6bdb4a34e6f3aef5fd164dcdd5b68ea6e9252622a127125e89f744fe16a7e'),
  ('public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text)','9597994a42c86321e401843545a77f1384bd3cac68717e7c461bb4cdba562d00'),
  ('erp_documents.document_view(uuid)','1c5786c3afd2faf7367a6a380a29781cacc2120b2d81e1821617aec374aacb40'),
  ('public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text)','ad8a9c2dc52eb7b436fd3e6e6bb8a411708400e7668c850472e1a378d9ee9aef'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'document_payment_196_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- ---------------------------------------------------------------- Corpo do documento
create or replace function erp_documents.extension_keys() returns text[]
language sql immutable set search_path=pg_catalog as $$
 select array['ship_date','finish_date','start_time','end_time','customer_po_number','quote_requested','quoted','warranty_days',
  'warranty_months','warranty_info','reception_notes','template_name','delivery_address','order_reference','seller_id',
  'category_id','carrier_id','price_list_id','payment_account_id','payment_means','payment_indicator']
$$;
-- Tipos de pagamento (tPag da NF-e), os mesmos códigos de Cadastros > Formas de pagamento (127).
create function erp_documents.payment_types() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['01','02','03','04','05','10','11','12','13','14','15','16','17','18','19','20','21','22','90','91','99']
$$;
-- 168 plus the Lista de preço, the Destino and the Detalhes de pagamento.
create or replace function erp_documents.extension_data(p_body jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v_result jsonb:='{}'; v jsonb; k text;
begin
 foreach k in array erp_documents.extension_keys() loop
  if not p_body?k then continue; end if;
  v:=p_body->k;
  if k in('ship_date','finish_date') then v:=to_jsonb(erp_documents.date_value(v));
  elsif k in('start_time','end_time') then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'erp_document_time_invalid' using errcode='22023'; end if;
  elsif k in('quote_requested','quoted') then
   if v<>'null'::jsonb and jsonb_typeof(v)<>'boolean' then raise exception 'erp_document_flag_invalid' using errcode='22023'; end if;
  elsif k='warranty_days' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^(0|[1-9][0-9]{0,3})$') then
    raise exception 'erp_document_warranty_invalid' using errcode='22023'; end if;
  elsif k='warranty_months' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^(0|[1-9][0-9]{0,2})$') then
    raise exception 'erp_document_warranty_invalid' using errcode='22023'; end if;
  elsif k='customer_po_number' then v:=to_jsonb(erp_documents.text_value(v,60));
  elsif k='template_name' then v:=to_jsonb(erp_documents.text_value(v,120));
  elsif k='order_reference' then v:=to_jsonb(erp_documents.text_value(v,100));
  elsif k in('warranty_info','reception_notes') then v:=to_jsonb(erp_documents.text_value(v,4000,false,true));
  elsif k='delivery_address' then v:=erp_documents.delivery_address(v);
  elsif k in('seller_id','category_id','carrier_id','price_list_id','payment_account_id') then v:=to_jsonb(erp_documents.uuid_value(v));
  elsif k='payment_means' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or not (v#>>'{}')=any(erp_documents.payment_types())) then
    raise exception 'erp_document_payment_invalid' using errcode='22023'; end if;
  elsif k='payment_indicator' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}' not in('0','1')) then
    raise exception 'erp_document_payment_invalid' using errcode='22023'; end if;
  end if;
  v_result:=v_result||jsonb_build_object(k,coalesce(v,'null'::jsonb));
 end loop;
 return v_result;
end $$;

-- An optional amount of the parcela details (null when not informed).
create function erp_documents.optional_amount(p_value jsonb) returns text language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 return erp_documents.decimal_value(p_value,2,12)::numeric(18,2)::text;
end $$;
-- "Detalhes da parcela" (Ver detalhes): every key, null when not informed; never in propostas. Amounts up to the parcela.
create function erp_documents.installment_details(p_kind text,p_value jsonb,p_amount numeric) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare k text; v_result jsonb;
begin
 if p_value is null or p_value='null'::jsonb then return 'null'::jsonb; end if;
 if p_kind='sales_proposals' or jsonb_typeof(p_value)<>'object'
  or exists(select 1 from jsonb_object_keys(p_value) x where x not in('account_id','payment_type','card_brand','integration_type','acquirer_cnpj','authorization_code','received_amount','fee_amount','commission_fee_amount'))
  or not p_value?&array['account_id','payment_type','card_brand','integration_type','acquirer_cnpj','authorization_code','received_amount','fee_amount','commission_fee_amount'] then
  raise exception 'erp_document_installment_details_invalid' using errcode='22023'; end if;
 foreach k in array array['payment_type','card_brand','integration_type','acquirer_cnpj','authorization_code'] loop
  if p_value->k<>'null'::jsonb and jsonb_typeof(p_value->k)<>'string' then raise exception 'erp_document_installment_details_invalid' using errcode='22023'; end if;
 end loop;
 if (p_value->>'payment_type' is not null and not (p_value->>'payment_type')=any(erp_documents.payment_types()))
  or (p_value->>'card_brand' is not null and p_value->>'card_brand' not in('01','02','03','04','05','06','07','08','09','99'))
  or (p_value->>'integration_type' is not null and p_value->>'integration_type' not in('1','2'))
  or (p_value->>'acquirer_cnpj' is not null and p_value->>'acquirer_cnpj'!~'^[A-Z0-9]{12}[0-9]{2}$')
  or (p_value->>'authorization_code' is not null and p_value->>'authorization_code'!~'^[A-Za-z0-9./-]{1,128}$') then
  raise exception 'erp_document_installment_details_invalid' using errcode='22023'; end if;
 v_result:=jsonb_build_object('account_id',erp_documents.uuid_value(p_value->'account_id'),'payment_type',p_value->'payment_type','card_brand',p_value->'card_brand',
  'integration_type',p_value->'integration_type','acquirer_cnpj',p_value->'acquirer_cnpj','authorization_code',p_value->'authorization_code',
  'received_amount',erp_documents.optional_amount(p_value->'received_amount'),'fee_amount',erp_documents.optional_amount(p_value->'fee_amount'),
  'commission_fee_amount',erp_documents.optional_amount(p_value->'commission_fee_amount'));
 if exists(select 1 from unnest(array['received_amount','fee_amount','commission_fee_amount']) x where (v_result->>x)::numeric>p_amount) then
  raise exception 'erp_document_installment_details_invalid' using errcode='22023'; end if;
 return v_result;
end $$;

-- 102 plus the 196 fields: the 057 core keeps every rule of the items, discounts and totals; the wrapper validates the Preço lista
-- and the Código no fornecedor of the items, the taxes added to the total and the parcelas (with their Forma and details).
create or replace function erp_documents.normalize(p_kind text,p_body jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_core jsonb; v_result jsonb; v_items jsonb:='[]'; v_item jsonb; v_out jsonb; v_i integer:=0; v_installments jsonb:='[]';
 v_ipi numeric:=0; v_st numeric:=0; v_total numeric; v_sum numeric:=0; v_amount numeric; v_code text;
begin
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 v_core:=p_body-erp_documents.extension_keys()-array['installments','tax_ipi','tax_icms_st'];
 if jsonb_typeof(p_body->'items')='array' then
  v_core:=jsonb_set(v_core,'{items}',(select coalesce(jsonb_agg(case when jsonb_typeof(i.value)='object' then i.value-array['list_price','supplier_code'] else i.value end order by i.n),'[]'::jsonb)
   from jsonb_array_elements(p_body->'items') with ordinality i(value,n)));
 end if;
 v_result:=erp_documents.normalize_core(p_kind,v_core)||erp_documents.extension_data(p_body);
 if p_kind='purchase_orders' and v_result->>'price_list_id' is not null then raise exception 'erp_document_price_list_invalid' using errcode='22023'; end if;
 if (p_kind='sales_proposals' and v_result->>'payment_account_id' is not null)
  or (p_kind<>'sales_orders' and (v_result->>'payment_means' is not null or v_result->>'payment_indicator' is not null)) then
  raise exception 'erp_document_payment_invalid' using errcode='22023'; end if;
 for v_item in select value from jsonb_array_elements(p_body->'items') loop
  v_out:=v_result->'items'->v_i; v_i:=v_i+1;
  if v_item?'list_price' then
   v_out:=v_out||jsonb_build_object('list_price',case when v_item->'list_price'='null'::jsonb then null
    else erp_catalog.unit_price_numeric(erp_catalog.unit_price(v_item->'list_price',10)::numeric,10) end);
  end if;
  if v_item?'supplier_code' then
   v_code:=erp_documents.text_value(v_item->'supplier_code',100);
   if v_code is not null and p_kind<>'purchase_orders' then raise exception 'erp_document_supplier_code_invalid' using errcode='22023'; end if;
   v_out:=v_out||jsonb_build_object('supplier_code',v_code);
  end if;
  v_items:=v_items||jsonb_build_array(v_out);
 end loop;
 v_result:=jsonb_set(v_result,'{items}',v_items);
 if p_body?'tax_ipi' then v_ipi:=erp_documents.decimal_value(p_body->'tax_ipi',2,12); end if;
 if p_body?'tax_icms_st' then v_st:=erp_documents.decimal_value(p_body->'tax_icms_st',2,12); end if;
 if p_kind='purchase_orders' and (v_ipi<>0 or v_st<>0) then raise exception 'erp_document_tax_invalid' using errcode='22023'; end if;
 v_total:=(v_result#>>'{totals,total}')::numeric+v_ipi+v_st;
 if v_total>999999999999.99 then raise exception 'erp_document_total_limit' using errcode='22023'; end if;
 if p_body?'tax_ipi' or p_body?'tax_icms_st' then
  v_result:=jsonb_set(v_result,'{totals}',(v_result->'totals')||jsonb_build_object('ipi',v_ipi::numeric(18,2)::text,'icms_st',v_st::numeric(18,2)::text,'total',v_total::numeric(18,2)::text))
   ||case when p_body?'tax_ipi' then jsonb_build_object('tax_ipi',v_ipi::numeric(18,2)::text) else '{}'::jsonb end
   ||case when p_body?'tax_icms_st' then jsonb_build_object('tax_icms_st',v_st::numeric(18,2)::text) else '{}'::jsonb end;
 end if;
 if p_body?'installments' and (jsonb_typeof(p_body->'installments')<>'array' or jsonb_array_length(p_body->'installments')>120) then
  raise exception 'erp_document_installments_invalid' using errcode='22023'; end if;
 v_i:=0;
 for v_item in select value from jsonb_array_elements(coalesce(p_body->'installments','[]'::jsonb)) loop
  if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('due_date','amount','method','note','payment_reference','payment_method_id','details')) then
   raise exception 'erp_document_installment_invalid' using errcode='22023'; end if;
  v_amount:=erp_documents.decimal_value(v_item->'amount',2,12);
  if v_amount<=0 then raise exception 'erp_document_installment_invalid' using errcode='22023'; end if;
  v_i:=v_i+1; v_sum:=v_sum+v_amount;
  v_installments:=v_installments||jsonb_build_array(jsonb_build_object('position',v_i,'due_date',erp_documents.date_value(v_item->'due_date',true),
   'amount',v_amount::numeric(18,2)::text,'method',erp_documents.text_value(v_item->'method',100))
   ||case when v_item?'note' then jsonb_build_object('note',erp_documents.text_value(v_item->'note',2000,false,true)) else '{}'::jsonb end
   ||case when v_item?'payment_reference' then jsonb_build_object('payment_reference',erp_documents.commercial_reference(v_item->'payment_reference')) else '{}'::jsonb end
   ||case when v_item?'payment_method_id' then jsonb_build_object('payment_method_id',erp_documents.uuid_value(v_item->'payment_method_id')) else '{}'::jsonb end
   ||case when v_item?'details' then jsonb_build_object('details',erp_documents.installment_details(p_kind,v_item->'details',v_amount)) else '{}'::jsonb end);
 end loop;
 if v_i>0 and v_sum<>v_total then raise exception 'erp_document_installment_total_mismatch' using errcode='22023'; end if;
 return jsonb_set(v_result,'{installments}',v_installments);
end $$;

-- 102 plus the 196 fields: an older full-replacement client must not silently erase them.
create or replace function erp_documents.require_commercial_input(p_current jsonb,p_input jsonb) returns void
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if erp_documents.has_commercial_data(p_current) and (not(p_input?'commercial')
  or exists(select 1 from jsonb_array_elements(p_input->'items') i where not(i?'detailed_description'))
  or exists(select 1 from jsonb_array_elements(coalesce(p_input->'installments','[]'::jsonb)) p where not(p?&array['note','payment_reference']))) then
  raise exception 'erp_document_commercial_fields_required' using errcode='40001';end if;
 if exists(select 1 from unnest(erp_documents.extension_keys()) k where coalesce(p_current->k,'null'::jsonb)<>'null'::jsonb and not p_input?k) then
  raise exception 'erp_document_fields_required' using errcode='40001';end if;
 if (exists(select 1 from jsonb_array_elements(coalesce(p_current->'items','[]'::jsonb)) i where coalesce(i->'list_price','null'::jsonb)<>'null'::jsonb or coalesce(i->'supplier_code','null'::jsonb)<>'null'::jsonb)
   and exists(select 1 from jsonb_array_elements(p_input->'items') i where not(i?&array['list_price','supplier_code'])))
  or (exists(select 1 from jsonb_array_elements(coalesce(p_current->'installments','[]'::jsonb)) p where coalesce(p->'payment_method_id','null'::jsonb)<>'null'::jsonb or coalesce(p->'details','null'::jsonb)<>'null'::jsonb)
   and exists(select 1 from jsonb_array_elements(coalesce(p_input->'installments','[]'::jsonb)) p where not(p?&array['payment_method_id','details'])))
  or ((coalesce(p_current->>'tax_ipi','0')::numeric<>0 or coalesce(p_current->>'tax_icms_st','0')::numeric<>0) and not(p_input?&array['tax_ipi','tax_icms_st'])) then
  raise exception 'erp_document_fields_required' using errcode='40001';end if;
end $$;

-- Like the vendedor (164) and the categoria (168): a new or changed link must be usable; a link already saved that became
-- inactive stays. The Forma must apply to the kind (recebimentos or pagamentos). The taxes: check_tax_preference below.
create function erp_documents.check_payment_links(p_kind text,p_data jsonb,p_before jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare v_applicable text:=case when p_kind='purchase_orders' then 'pagamentos' else 'recebimentos' end; v_methods uuid[]; v_accounts uuid[];
begin
 if p_data->>'price_list_id' is not null and (p_before is null or p_before->>'price_list_id' is distinct from p_data->>'price_list_id')
  and not exists(select 1 from erp_pricing.price_list l where l.id=(p_data->>'price_list_id')::uuid and erp_pricing.valid_now(l)) then
  raise exception 'erp_document_price_list_unavailable' using errcode='22023'; end if;
 v_accounts:=array(select (p#>>'{details,account_id}')::uuid from jsonb_array_elements(coalesce(p_before->'installments','[]'::jsonb)) p where p#>>'{details,account_id}' is not null)
  ||array(select (p_before->>'payment_account_id')::uuid where p_before->>'payment_account_id' is not null);
 if exists(select 1 from (select p_data->>'payment_account_id' id union all select p#>>'{details,account_id}' from jsonb_array_elements(coalesce(p_data->'installments','[]'::jsonb)) p) x
  where x.id is not null and not x.id::uuid=any(v_accounts) and not exists(select 1 from erp_finance.account a where a.id=x.id::uuid and a.active)) then
  raise exception 'erp_document_payment_account_unavailable' using errcode='22023'; end if;
 v_methods:=array(select (p->>'payment_method_id')::uuid from jsonb_array_elements(coalesce(p_before->'installments','[]'::jsonb)) p where p->>'payment_method_id' is not null);
 if exists(select 1 from jsonb_array_elements(coalesce(p_data->'installments','[]'::jsonb)) p where p->>'payment_method_id' is not null
  and not ((p->>'payment_method_id')::uuid=any(v_methods) and exists(select 1 from erp_catalog.payment_method f where f.id=(p->>'payment_method_id')::uuid))
  and not exists(select 1 from erp_catalog.payment_method f where f.id=(p->>'payment_method_id')::uuid and f.active and f.deleted_at is null and f.applicable in('ambos',v_applicable))) then
  raise exception 'erp_document_payment_method_unavailable' using errcode='22023'; end if;
end $$;
-- A new or changed Total do IPI / ICMS ST needs Preferências › Propostas "Exibe campos IPI e ST". p_before is the document
-- itself (edit) or the document it comes from (copy, or the proposta of Gerar venda / Gerar ordem de serviço): taxes carried
-- unchanged from it stay valid after the preference is switched off.
create function erp_documents.check_tax_preference(p_data jsonb,p_before jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if (coalesce(p_data->>'tax_ipi','0')::numeric<>0 or coalesce(p_data->>'tax_icms_st','0')::numeric<>0)
  and (p_before is null or (coalesce(p_before->>'tax_ipi','0')::numeric,coalesce(p_before->>'tax_icms_st','0')::numeric)
   is distinct from (coalesce(p_data->>'tax_ipi','0')::numeric,coalesce(p_data->>'tax_icms_st','0')::numeric))
  and coalesce(erp_documents.preference('propostas.exibir_ipi_st'),'false'::jsonb)<>'true'::jsonb then
  raise exception 'erp_document_tax_disabled' using errcode='22023'; end if;
end $$;

-- Preferências › Vendas › Propostas "Bloquear a geração da proposta comercial quando o valor total parcelado excede o limite de
-- crédito do cliente": a proposta (not a modelo) whose parcelas plus the open contas a receber of the cliente go above the Limite
-- de crédito of the cadastro (Zero or a value) is refused when created or when its parcelas grow. The administrador (Origin
-- "Desconsiderar limite de crédito") saves it anyway.
create function erp_documents.check_credit_limit(p_user_id uuid,p_kind text,p_data jsonb,p_before jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare v_mode text; v_limit numeric; v_planned numeric; v_open numeric;
begin
 if p_kind<>'sales_proposals' or coalesce((p_data->>'template')::boolean,false)
  or coalesce(erp_documents.preference('propostas.bloquear_limite_credito'),'false'::jsonb)<>'true'::jsonb
  or exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and m.role='admin') then return; end if;
 select credit_limit_mode,credit_limit into v_mode,v_limit from erp_catalog.contact_profile where record_id=(p_data->>'contact_id')::uuid;
 if coalesce(v_mode,'unlimited')='unlimited' then return; end if;
 v_planned:=(select coalesce(sum((p->>'amount')::numeric),0) from jsonb_array_elements(coalesce(p_data->'installments','[]'::jsonb)) p);
 if v_planned=0 or (p_before is not null and p_before->>'contact_id'=p_data->>'contact_id'
  and v_planned<=(select coalesce(sum((p->>'amount')::numeric),0) from jsonb_array_elements(coalesce(p_before->'installments','[]'::jsonb)) p)) then return; end if;
 v_open:=(select coalesce(sum(t.amount_cents-t.settled_cents),0) from erp_finance.title t where t.contact_id=(p_data->>'contact_id')::uuid and t.kind='receivable' and not t.cancelled and t.deleted_at is null)/100.0;
 v_limit:=case when v_mode='zero' then 0 else v_limit end;
 if v_planned+v_open>v_limit then raise exception 'erp_document_credit_limit' using errcode='22023'; end if;
end $$;

-- ---------------------------------------------------------------- Lançamento automático de contas
-- Preferências > Vendas > Vendas "Lançamento automático de contas em Pedidos de Venda": the same preview and post of the manual
-- Lançar contas, with the profile of whoever saves or changes the situação, inside the same transaction. A refusal (profile
-- without contas, contato inativo, parcela anterior ao pedido...) never undoes the save: the answer says why nothing was posted.
create function erp_documents.auto_finance(p_user_id uuid,p_id uuid,p_command uuid) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare d erp_documents.document; v_plan jsonb; v_category uuid; v_preview jsonb; v_post jsonb;
begin
 select * into d from erp_documents.document where id=p_id;
 if not found or d.kind<>'sales_orders' or coalesce(erp_documents.preference('vendas.contas_automaticas_pedido'),'false'::jsonb)<>'true'::jsonb
  or d.status not in('verified','in_progress','partially_fulfilled','fulfilled')
  or exists(select 1 from erp_finance.document_posting p where p.document_id=p_id and p.state='active')
  or exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=p_id and g.active) then return null; end if;
 if not exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and m.role in('admin','financeiro')) then
  return jsonb_build_object('outcome','skipped','reason','erp_finance_access_denied'); end if;
 if d.total<=0 then return jsonb_build_object('outcome','skipped','reason','erp_document_finance_zero_total'); end if;
 if jsonb_array_length(coalesce(d.body->'installments','[]'::jsonb))=0 then
  v_plan:=jsonb_build_array(jsonb_build_object('amount_cents',((d.total*100)::bigint)::text,'due_on',d.body->>'date','method',null));
 end if;
 v_category:=erp_documents.document_finance_category(d,null);
 begin
  v_preview:=public.erp_document_finance_preview(p_user_id,d.kind,p_id,d.version,v_category,v_plan)->'preview';
  v_post:=public.erp_document_finance_post(p_user_id,d.kind,p_id,d.version,erp_documents.transition_command(p_command,'auto_finance'),v_preview->>'preview_hash',v_category,v_plan);
  return jsonb_build_object('outcome','done','posting_id',v_post#>>'{posting,id}');
 exception when sqlstate '22023' or sqlstate '40001' or sqlstate '42501' or sqlstate 'P0002' then
  return jsonb_build_object('outcome','skipped','reason',case when sqlerrm~'^erp_[a-z0-9_]{1,80}$' then sqlerrm else 'erp_document_finance_refused' end);
 end;
end $$;

-- ---------------------------------------------------------------- Gravação
-- 168 plus: the 196 links, the proposta that the new pedido/OS comes from (source_proposal: Gerar venda / Gerar ordem de serviço
-- opened prefilled, concluded in the same transaction as in erp_proposal_convert) and the automatic lançamento de contas.
create or replace function public.erp_document_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_data jsonb; v_row erp_documents.document%rowtype; v_id uuid;
 v_contact uuid; v_warehouse uuid; v_snapshot jsonb; v_before jsonb; v_result jsonb; v_body jsonb; v_number bigint; v_seller uuid; v_refresh boolean:=false;
 v_source_id uuid; v_source_version integer; v_source erp_documents.document%rowtype; v_source_before jsonb; v_auto jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_expected_version is null or (p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version<1) then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','save','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,'body',p_body)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 if p_body is null or jsonb_typeof(p_body)<>'object' then raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 v_body:=p_body;
 if p_body?'number' then
  if jsonb_typeof(p_body->'number')<>'string' or p_body->>'number'!~'^[1-9][0-9]{0,9}$' then raise exception 'erp_document_number_invalid' using errcode='22023'; end if;
  v_number:=(p_body->>'number')::bigint; v_body:=p_body-'number';
 end if;
 if v_body?'refresh_contact' then
  if v_body->'refresh_contact'<>'true'::jsonb then raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
  v_refresh:=true; v_body:=v_body-'refresh_contact';
 end if;
 if v_body?'source_proposal' then
  if p_id is not null or p_kind not in('sales_orders','service_orders') or jsonb_typeof(v_body->'source_proposal')<>'object'
   or exists(select 1 from jsonb_object_keys(v_body->'source_proposal') k where k not in('id','expected_version'))
   or jsonb_typeof(v_body#>'{source_proposal,expected_version}') is distinct from 'number' or v_body#>>'{source_proposal,expected_version}'!~'^[1-9][0-9]{0,9}$'
   or (v_body#>>'{source_proposal,expected_version}')::bigint>2147483647 then
   raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
  v_source_id:=erp_documents.uuid_value(v_body#>'{source_proposal,id}',true); v_source_version:=(v_body#>>'{source_proposal,expected_version}')::integer;
  v_body:=v_body-'source_proposal';
 end if;
 v_data:=erp_documents.normalize(p_kind,v_body); v_contact:=(v_data->>'contact_id')::uuid; v_warehouse:=(v_data->>'warehouse_id')::uuid; v_seller:=(v_data->>'seller_id')::uuid;
 v_data:=jsonb_set(v_data,'{items}',erp_documents.auto_products(p_user_id,p_kind,p_command_id,v_data->'items'));
 perform erp_documents.check_preference_rules(p_kind,v_data);
 perform erp_documents.check_seller_rules(p_user_id,p_kind,v_data);
 if p_id is not null then
  select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
  if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  if not erp_documents.editable(v_row.status) then raise exception 'erp_document_state_locked' using errcode='40001'; end if;
  v_before:=erp_documents.dto(p_id);
  perform erp_documents.require_commercial_input(v_before,v_body);
  if v_number=v_row.number then v_number:=null; end if;
 end if;
 if v_seller is not null and (p_id is null or v_row.body->>'seller_id' is distinct from v_seller::text) then perform erp_documents.require_seller(v_seller); end if;
 perform erp_documents.check_links(p_kind,v_data,case when p_id is not null then v_row.body end);
 perform erp_documents.check_payment_links(p_kind,v_data,case when p_id is not null then v_row.body end);
 perform erp_documents.check_credit_limit(p_user_id,p_kind,v_data,case when p_id is not null then v_row.body||jsonb_build_object('contact_id',v_row.contact_id) end);
 if v_source_id is not null then
  -- Same rules as erp_proposal_convert / erp_proposal_convert_to_service (164): one document per proposta, never a template.
  perform erp_documents.require_access(p_user_id,'sales_proposals',true);
  select * into v_source from erp_documents.document where id=v_source_id and kind='sales_proposals' for update;
  if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
  if v_source.version<>v_source_version or v_source.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  if exists(select 1 from erp_documents.document where source_proposal_id=v_source_id) then raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
  if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
  v_source_before:=erp_documents.dto(v_source_id);
 end if;
 perform erp_documents.check_tax_preference(v_data,case when p_id is not null then v_row.body when v_source_id is not null then v_source.body end);
 if v_number is not null then
  -- Same lock as erp_documents.next_number: a free number and the automatic sequence never collide.
  perform 1 from erp_documents.numbering where kind=p_kind for update;
  if not erp_documents.number_editable(p_kind) then raise exception 'erp_document_number_locked' using errcode='22023'; end if;
  if exists(select 1 from erp_documents.document where kind=p_kind and number=v_number) then
   -- Origin: a number already used becomes the next free number (new document) or stays the current one (edit).
   v_number:=null;
  else
   update erp_documents.numbering set last_number=greatest(last_number,v_number) where kind=p_kind;
  end if;
 end if;
 if p_id is not null and v_row.contact_id=v_contact and not v_refresh then v_snapshot:=v_row.contact_snapshot;
 else
  select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=v_contact and r.active;
  if not found then raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 end if;
 if v_warehouse is not null and (p_id is null or v_row.warehouse_id is distinct from v_warehouse)
  and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=v_warehouse and r.active) then
  raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 if p_id is null then
  insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)
  values(p_kind,coalesce(v_number,erp_documents.next_number(p_kind)),erp_documents.initial_status(p_kind),
   v_contact,v_warehouse,v_snapshot,v_data-'items',(v_data#>>'{totals,total}')::numeric,v_source_id,p_user_id,p_user_id) returning id into v_id;
 else
  v_id:=p_id;
  update erp_documents.document set version=version+1,contact_id=v_contact,warehouse_id=v_warehouse,contact_snapshot=v_snapshot,number=coalesce(v_number,number),
   body=v_data-'items',total=(v_data#>>'{totals,total}')::numeric,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 end if;
 perform erp_documents.replace_items(v_id,v_data->'items');
 if v_source_id is not null then
  update erp_documents.document set status='completed',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_source_id;
  perform erp_documents.record_occurrence(v_source_id,p_user_id,p_command_id,v_source.version+1,v_source.status,'completed',null);
  insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
   values(p_user_id,p_command_id,v_source_id,case when p_kind='sales_orders' then 'convert_to_sale' else 'convert_to_service' end,v_source_before,erp_documents.dto(v_source_id));
 end if;
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,v_id,case when v_source_id is not null then 'create_from_proposal' when p_id is null then 'create' else 'edit' end,v_before,erp_documents.dto(v_id));
 v_auto:=erp_documents.auto_finance(p_user_id,v_id,p_command_id);
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false)
  ||case when v_auto is not null then jsonb_build_object('auto_finance',v_auto) else '{}'::jsonb end
  ||case when v_source_id is not null then jsonb_build_object('source_proposal',(select jsonb_build_object('id',s.id,'number',s.number::text,'version',s.version,'status',s.status)
   from erp_documents.document s where s.id=v_source_id)) else '{}'::jsonb end;
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 168 plus the 196 links (a copy is a new document: every link must be usable now).
create or replace function public.erp_document_copy(p_user_id uuid,p_kind text,p_source_id uuid,p_expected_source_version integer,p_command_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_source erp_documents.document%rowtype; v_hash text; v_replay jsonb; v_data jsonb; v_items jsonb;
 v_contact uuid; v_warehouse uuid; v_refs uuid[]; v_snapshot jsonb; v_id uuid; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_source_id is null or p_expected_source_version is null or p_expected_source_version<1 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','copy_document','actor',p_user_id,'kind',p_kind,'source',p_source_id,
  'source_version',p_expected_source_version,'body',p_body)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash);
 if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind for share;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_source_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_data:=erp_documents.normalize(p_kind,p_body);
 perform erp_documents.require_commercial_input(erp_documents.dto(p_source_id),p_body);
 perform erp_documents.check_preference_rules(p_kind,v_data);
 perform erp_documents.check_seller_rules(p_user_id,p_kind,v_data);
 perform erp_documents.require_seller((v_data->>'seller_id')::uuid);
 perform erp_documents.check_links(p_kind,v_data,null);
 perform erp_documents.check_payment_links(p_kind,v_data,null);
 perform erp_documents.check_tax_preference(v_data,v_source.body);
 perform erp_documents.check_credit_limit(p_user_id,p_kind,v_data,null);
 v_contact:=(v_data->>'contact_id')::uuid;v_warehouse:=(v_data->>'warehouse_id')::uuid;
 select array_agg(distinct id) into v_refs from (
  select v_contact id union all select v_warehouse union all
  select (value->>'product_id')::uuid from jsonb_array_elements(v_data->'items')) refs where id is not null;
 perform r.id from erp_catalog.record r where r.id=any(v_refs) order by r.id for share;
 select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id
  where r.id=v_contact and r.active;
 if not found then raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 if v_warehouse is not null and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=v_warehouse and r.active) then
  raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(v_data->'items') i where i->>'product_id' is not null and not exists(
  select 1 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=(i->>'product_id')::uuid and r.active)) then
  raise exception 'erp_document_product_unavailable' using errcode='22023'; end if;
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
 values(p_kind,erp_documents.next_number(p_kind),erp_documents.initial_status(p_kind),
  v_contact,v_warehouse,v_snapshot,v_data-'items',(v_data#>>'{totals,total}')::numeric,p_user_id,p_user_id) returning id into v_id;
 select coalesce(jsonb_agg(value||'{"id":null}'::jsonb order by position),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_data->'items') with ordinality as lines(value,position);
 perform erp_documents.replace_items(v_id,v_items);
 insert into erp_documents.copy_source(destination_id,source_id,source_kind,source_number,source_version,actor,command_id)
  values(v_id,p_source_id,p_kind,v_source.number,p_expected_source_version,p_user_id,p_command_id);
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(v_id),'copy_source',erp_documents.copy_source_dto(v_id),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,v_id,'create_from_copy',jsonb_build_object('copy_source',erp_documents.copy_source_dto(v_id)),erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 168 plus: the Preço lista and the Código no fornecedor of the items, the Lista de preço and the Destino while they can still be
-- chosen, the Detalhes de pagamento and the taxes (the parcelas are reset, as before).
create or replace function public.erp_document_copy_preview(p_user_id uuid,p_kind text,p_source_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_source erp_documents.document%rowtype; v_data jsonb; v_items jsonb; field text; v_keep_date boolean;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 v_keep_date:=p_kind='purchase_orders' and erp_documents.preference('compras.clonagem_data')='"data_original"'::jsonb;
 select coalesce(jsonb_agg(jsonb_build_object('id',null,'product_id',i.product_id,'description',i.data->'description',
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),
  'discount_percent',i.discount_percent::text)
  ||case when i.data?'detailed_description' then jsonb_build_object('detailed_description',i.data->'detailed_description') else '{}'::jsonb end
  ||case when i.data?'list_price' then jsonb_build_object('list_price',i.data->'list_price') else '{}'::jsonb end
  ||case when i.data?'supplier_code' then jsonb_build_object('supplier_code',i.data->'supplier_code') else '{}'::jsonb end order by i.position),'[]'::jsonb) into v_items
  from erp_documents.item i where i.document_id=p_source_id;
 v_data:=jsonb_build_object('date',case when v_keep_date then (v_source.body->>'date')::date else (clock_timestamp() at time zone 'America/Sao_Paulo')::date end,
  'contact_id',v_source.contact_id,'warehouse_id',v_source.warehouse_id,'expected_date',case when v_keep_date then (v_source.body->>'expected_date')::date end,'valid_until',null,
  'next_contact',null,'template',false,'items',v_items,'installments','[]'::jsonb,
  'equipment',null,'serial_number',null,'technician',null,'defect',null,'solution',null);
 foreach field in array array['discount_mode','discount_value','freight','other_expenses','payment_terms','delivery_terms','notes','internal_notes'] loop
  v_data:=v_data||jsonb_build_object(field,v_source.body->field);
 end loop;
 if p_kind<>'purchase_orders' and v_source.body->>'seller_id' is not null then v_data:=v_data||jsonb_build_object('seller_id',v_source.body->'seller_id'); end if;
 -- 168: the copy keeps the categoria and the transportador while they can still be chosen.
 if erp_documents.category_usable(p_kind,v_source.body->>'category_id') then v_data:=v_data||jsonb_build_object('category_id',v_source.body->'category_id'); end if;
 if erp_documents.carrier_usable(v_source.body->>'carrier_id') then v_data:=v_data||jsonb_build_object('carrier_id',v_source.body->'carrier_id'); end if;
 -- 196: Lista de preço (valid now), Destino (active conta), Detalhes de pagamento and the taxes of the source.
 if exists(select 1 from erp_pricing.price_list l where l.id::text=v_source.body->>'price_list_id' and erp_pricing.valid_now(l)) then
  v_data:=v_data||jsonb_build_object('price_list_id',v_source.body->'price_list_id'); end if;
 if exists(select 1 from erp_finance.account a where a.id::text=v_source.body->>'payment_account_id' and a.active) then
  v_data:=v_data||jsonb_build_object('payment_account_id',v_source.body->'payment_account_id'); end if;
 foreach field in array array['payment_means','payment_indicator','tax_ipi','tax_icms_st'] loop
  if v_source.body?field then v_data:=v_data||jsonb_build_object(field,v_source.body->field); end if;
 end loop;
 if erp_documents.has_commercial_data(erp_documents.dto(p_source_id)) then
  select coalesce(jsonb_agg(value||jsonb_build_object('detailed_description',value->'detailed_description') order by ordinality),'[]'::jsonb) into v_items
   from jsonb_array_elements(v_items) with ordinality;
  v_data:=v_data||jsonb_build_object('commercial',v_source.body->'commercial','items',v_items);
 elsif v_source.body?'commercial' then
  v_data:=v_data||jsonb_build_object('commercial',v_source.body->'commercial');
 end if;
 return jsonb_build_object('source',jsonb_build_object('id',v_source.id,'kind',v_source.kind,'number',v_source.number::text,'version',v_source.version),
  'data',v_data,'reset_fields',case when v_keep_date then jsonb_build_array('valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution')
   else jsonb_build_array('date','expected_date','valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution') end,
  'persisted',false,'data_mode','erp_native','operational_effects',false);
end $$;

-- "Gerar venda" / "Gerar ordem de serviço" of the proposta (Origin vendas.php#idOrigem/<id>): the new document prefilled with the
-- proposta, nothing saved. The save (source_proposal) checks the proposta again and concludes it in the same transaction.
create function public.erp_document_conversion_preview(p_user_id uuid,p_kind text,p_proposal_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_source erp_documents.document%rowtype; v_body jsonb; v_items jsonb;
begin
 if p_kind is null or p_kind not in('sales_orders','service_orders') then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 select * into v_source from erp_documents.document where id=p_proposal_id and kind='sales_proposals';
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if exists(select 1 from erp_documents.document where source_proposal_id=p_proposal_id) then raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 v_body:=case when p_kind='sales_orders' then erp_documents.sale_body_from_proposal(v_source.body) else v_source.body||'{"template":false}'::jsonb end;
 v_body:=v_body-array['totals','template_name','valid_until','next_contact','template'];
 v_body:=jsonb_set(v_body,'{installments}',(select coalesce(jsonb_agg(p.value-'position' order by p.n),'[]'::jsonb) from jsonb_array_elements(coalesce(v_body->'installments','[]'::jsonb)) with ordinality p(value,n)));
 select coalesce(jsonb_agg(jsonb_build_object('id',null,'product_id',i.product_id,'description',i.data->'description',
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),
  'discount_percent',i.discount_percent::text,'detailed_description',coalesce(i.data->'detailed_description','null'::jsonb))
  ||case when i.data?'list_price' then jsonb_build_object('list_price',i.data->'list_price') else '{}'::jsonb end order by i.position),'[]'::jsonb) into v_items
  from erp_documents.item i where i.document_id=p_proposal_id;
 return jsonb_build_object('source',jsonb_build_object('id',v_source.id,'kind','sales_proposals','number',v_source.number::text,'version',v_source.version),
  'kind',p_kind,'data',v_body||jsonb_build_object('items',v_items),'contact',jsonb_build_object('id',v_source.contact_id,'name',left(v_source.contact_snapshot->>'name',200)),
  'price_list_name',(select left(l.name,120) from erp_pricing.price_list l where l.id::text=v_body->>'price_list_id'),
  'persisted',false,'data_mode','erp_native','operational_effects',false);
end $$;

-- 164 without the Detalhes de pagamento of the pedido (only pedidos de venda carry them).
create or replace function public.erp_sales_order_convert_to_service(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype; v_id uuid; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','sales_to_service','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_orders' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from erp_documents.sales_service_link where sales_order_id=p_id) then raise exception 'erp_sales_order_already_converted' using errcode='40001'; end if;
 if v_source.status='cancelled' or erp_documents.order_invoice(p_id) is not null then raise exception 'erp_sales_order_not_convertible' using errcode='22023'; end if;
 perform erp_documents.check_preference_rules('service_orders',erp_documents.stored_rules_data(p_id));
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
 values('service_orders',erp_documents.next_number('service_orders'),'open',v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  v_source.body-array['ship_date','customer_po_number','delivery_address','payment_means','payment_indicator']||'{"template":false}'::jsonb,v_source.total,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,i.data||jsonb_build_object('id',n.new_id)
 -- Correlated lateral: one new id per item (131 drew a single id for every line, so a pedido with two items failed).
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null) n where i.document_id=p_id;
 insert into erp_documents.sales_service_link(sales_order_id,service_order_id,actor,command_id) values(p_id,v_id,p_user_id,p_command_id);
 perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_source.version,v_source.status,null,
  'Ordem de serviço '||(select number::text from erp_documents.document where id=v_id)||' gerada a partir deste pedido');
 v_result:=jsonb_build_object('sale',erp_documents.dto(p_id),'service_order',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,v_id,'create_from_sales_order',jsonb_build_object('sales_order_id',p_id,'sales_order_number',v_source.number::text),erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- ---------------------------------------------------------------- Leitura
-- 168 plus the names of the Lista de preço, of the Destino and of the Formas of the parcelas.
create or replace function erp_documents.document_view(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_documents.dto(p_id)||jsonb_build_object('situation',erp_documents.document_situation_json(p_id),
  'seller_name',(select left(r.name,200) from erp_documents.document d join erp_catalog.seller s on s.id::text=d.body->>'seller_id' join erp_catalog.record r on r.id=s.contact_id where d.id=p_id),
  'category_name',(select left(c.name,200) from erp_documents.document d join erp_finance.category c on c.id::text=d.body->>'category_id' where d.id=p_id),
  'carrier_name',(select left(r.name,200) from erp_documents.document d join erp_catalog.record r on r.id::text=d.body->>'carrier_id' where d.id=p_id),
  'price_list_name',(select left(l.name,120) from erp_documents.document d join erp_pricing.price_list l on l.id::text=d.body->>'price_list_id' where d.id=p_id),
  'payment_account_name',(select left(a.name,200) from erp_documents.document d join erp_finance.account a on a.id::text=d.body->>'payment_account_id' where d.id=p_id),
  'payment_method_names',(select coalesce(jsonb_object_agg(f.id::text,left(f.description,100)),'{}'::jsonb) from erp_catalog.payment_method f
   where f.id::text in(select p->>'payment_method_id' from erp_documents.document d,jsonb_array_elements(coalesce(d.body->'installments','[]'::jsonb)) p where d.id=p_id)),
  'payment_account_names',(select coalesce(jsonb_object_agg(a.id::text,left(a.name,200)),'{}'::jsonb) from erp_finance.account a
   where a.id::text in(select p#>>'{details,account_id}' from erp_documents.document d,jsonb_array_elements(coalesce(d.body->'installments','[]'::jsonb)) p where d.id=p_id)))
$$;

-- Formas de pagamento (active, applicable to the kind: recebimentos or pagamentos) and contas financeiras (active) of the form,
-- for the profiles that write the kind (who choose them; a reader sees the chosen names in the document). Read-only.
create function public.erp_document_payment_options(p_user_id uuid,p_kind text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_applicable text;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 v_applicable:=case when p_kind='purchase_orders' then 'pagamentos' else 'recebimentos' end;
 return jsonb_build_object('kind',p_kind,
  'methods',(select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'description',left(f.description,100),'payment_type',f.payment_type,'condition',f.condition,
    'destination',f.destination,'account_id',case when f.destination='caixa' then f.account_id end,'card_brand',f.card_brand,'card_integration',f.card_integration,'card_cnpj',f.card_cnpj,
    'is_default',f.is_default) order by f.is_default desc,lower(f.description),f.id),'[]'::jsonb)
   from (select * from erp_catalog.payment_method f where f.active and f.deleted_at is null and f.applicable in('ambos',v_applicable)
    order by f.is_default desc,lower(f.description),f.id limit 200) f),
  'accounts',case when p_kind='sales_proposals' then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',left(a.name,200),'kind',a.kind) order by lower(a.name),a.id),'[]'::jsonb)
   from (select * from erp_finance.account a where a.active order by lower(a.name),a.id limit 200) a) end,
  'data_mode','erp_native','operational_effects',false);
end $$;

-- Código no fornecedor (Cadastros > Produtos, aba Fornecedores) of the products for the fornecedor of the pedido de compra.
create function public.erp_document_supplier_codes(p_user_id uuid,p_contact_id uuid,p_product_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_documents.require_access(p_user_id,'purchase_orders',false);
 if p_contact_id is null or p_product_ids is null or cardinality(p_product_ids) not between 1 and 250 or array_position(p_product_ids,null) is not null
  or (select count(distinct x) from unnest(p_product_ids) x)<>cardinality(p_product_ids) then
  raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 return jsonb_build_object('contact_id',p_contact_id,'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',s.record_id,'code',s.code) order by s.record_id),'[]'::jsonb)
  from erp_catalog.product_supplier s where s.supplier_id=p_contact_id and s.record_id=any(p_product_ids) and nullif(btrim(s.code),'') is not null),
  'data_mode','erp_native','operational_effects',false);
end $$;

-- ---------------------------------------------------------------- Lançar contas
-- The preview of 017/165/168 plus, per parcela, the Forma (payment_method_id) and the conta financeira of the Destino (the
-- parcela's own conta, else the Destino of the document). The contas stay open: nothing is settled or moved.
create function erp_documents.finance_payment_preview(d erp_documents.document,p_preview jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v_parts jsonb:='[]'; part jsonb; src jsonb; v_account uuid; v_method uuid; r jsonb;
begin
 for part in select value from jsonb_array_elements(p_preview->'installments') loop
  src:=case when p_preview->>'plan_source'='document' then d.body->'installments'->((part->>'position')::integer-1) end;
  v_method:=(src->>'payment_method_id')::uuid;
  v_account:=coalesce((src#>>'{details,account_id}')::uuid,(d.body->>'payment_account_id')::uuid);
  if v_account is not null and not exists(select 1 from erp_finance.account a where a.id=v_account and a.active) then
   raise exception 'erp_document_finance_account_unavailable' using errcode='22023'; end if;
  v_parts:=v_parts||jsonb_build_array(part||jsonb_build_object('payment_method_id',v_method,
   'payment_method_name',(select left(f.description,100) from erp_catalog.payment_method f where f.id=v_method),
   'account_id',v_account,'account_name',(select left(a.name,200) from erp_finance.account a where a.id=v_account)));
 end loop;
 r:=(p_preview-'preview_hash')||jsonb_build_object('installments',v_parts);
 return r||jsonb_build_object('preview_hash',encode(sha256(convert_to(r::text,'UTF8')),'hex'));
end $$;

create or replace function public.erp_document_finance_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_category_id uuid default null,p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_documents.finance_payment_preview(d,erp_finance.document_preview_data(d,erp_documents.document_finance_category(d,p_category_id),p_plan)),
  'data_mode','erp_native','cash_movement_performed',false);
end $$;
-- 168 plus the Forma and the conta financeira of each conta.
create or replace function public.erp_document_finance_post(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,p_preview_hash text,p_category_id uuid default null,p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;pid uuid;gid uuid:=gen_random_uuid();tid uuid;part jsonb;label text;result jsonb;before_doc jsonb;v_category uuid;begin
 -- The command keeps the category as requested, so a replay of an older command still matches.
 data:=jsonb_build_object('kind',p_kind,'document_id',p_document_id,'version',p_expected_version,'preview_hash',p_preview_hash,'category_id',p_category_id,'plan',p_plan);
 replay:=erp_finance.document_command_start(p_user_id,p_command_id,'post',data);if replay is not null then return replay;end if;
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 v_category:=erp_documents.document_finance_category(d,p_category_id);
 preview:=erp_documents.finance_payment_preview(d,erp_finance.document_preview_data(d,v_category,p_plan));
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_finance_preview_conflict' using errcode='40001';end if;
 before_doc:=erp_documents.dto(d.id);
 insert into erp_finance.document_posting(document_id,document_version,group_id,snapshot,preview_hash,actor,command_id)
 values(d.id,d.version,gid,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id) returning id into pid;
 label:=case d.kind when 'sales_orders' then 'Pedido de venda' when 'purchase_orders' then 'Pedido de compra' else 'Ordem de serviço' end||' nº '||d.number::text;
 for part in select value from jsonb_array_elements(preview->'installments') loop
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,amount_cents,payment_method_id,account_id)
  values(gid,(part->>'position')::integer,jsonb_array_length(preview->'installments'),preview->>'direction',d.contact_id,v_category,label,
   (preview->>'issued_on')::date,(part->>'due_on')::date,(part->>'amount_cents')::bigint,(part->>'payment_method_id')::uuid,(part->>'account_id')::uuid) returning id into tid;
  insert into erp_finance.document_title(title_id,posting_id,position)values(tid,pid,(part->>'position')::integer);
 end loop;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_finance.document_posting_summary(pid),'titles',erp_finance.document_title_rows(pid));
 insert into erp_finance.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'document_post',null,result);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)values(p_user_id,p_command_id,d.id,'finance_post',before_doc,result);
 return erp_finance.document_command_finish(p_user_id,p_command_id,'post',data,result);
end $$;

-- ---------------------------------------------------------------- Mudança de situação
-- 163 plus the automatic lançamento de contas of the pedido de venda (after the actions of the transition).
create or replace function public.erp_document_transition(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,
 p_command_id uuid,p_status text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_before jsonb; v_result jsonb; v_reason text;
 v_current uuid; v_from_key text; v_rule jsonb; v_target jsonb; v_pair_active boolean; v_to_base text; v_custom uuid; v_actions text[]; v_action text;
 v_effects jsonb:='[]'; v_from_situation jsonb; v_to_situation jsonb; v_auto jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','transition','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,'status',p_status,'reason',p_reason)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_reason:=erp_documents.text_value(to_jsonb(p_reason),1000);
 if not erp_documents.situation_adopted(p_kind) then
  if p_status is null or not coalesce((erp_documents.transitions()#>array[p_kind,v_row.status])?p_status,false) then
   raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
  if erp_documents.transition_reason_required(p_kind,v_row.status,p_status) and coalesce(length(v_reason),0)<3 then
   raise exception 'erp_document_reason_required' using errcode='22023'; end if;
  if coalesce((v_row.body->>'template')::boolean,false) and p_status='approved' then raise exception 'erp_document_template_not_approvable' using errcode='22023'; end if;
  v_before:=erp_documents.dto(p_id);
  update erp_documents.document set status=p_status,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
  perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_row.version+1,v_row.status,p_status,v_reason);
  v_auto:=erp_documents.auto_finance(p_user_id,p_id,p_command_id);
  v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(p_id),'replayed',false,'data_mode','erp_native','operational_effects',false)
   ||case when v_auto is not null then jsonb_build_object('auto_finance',v_auto) else '{}'::jsonb end;
  insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
   values(p_user_id,p_command_id,p_id,'transition',v_reason,v_before,erp_documents.dto(p_id));
  insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  return v_result;
 end if;
 select situation_id into v_current from erp_documents.document_situation where document_id=p_id;
 v_from_key:=coalesce(v_current::text,v_row.status);
 if p_status is null or p_status=v_from_key or not erp_documents.situation_key_valid(p_kind,p_status) then
  raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
 v_rule:=erp_preferences.transition_rule(p_kind,v_from_key,p_status);
 v_target:=erp_preferences.situation_of(p_kind,p_status);
 if v_rule is null or v_target is null or not (v_rule->>'configured')::boolean then raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
 -- The pair must be active and the target situação too; leaving an inactive situação stays possible.
 v_pair_active:=coalesce((select t.active from erp_preferences.transition t where t.kind=p_kind and t.from_key=v_from_key and t.to_key=p_status),true);
 if not v_pair_active or not (v_target->>'active')::boolean then raise exception 'erp_document_transition_inactive' using errcode='22023'; end if;
 v_to_base:=v_rule->>'to_base';
 v_custom:=case when (v_target->>'default')::boolean then null else p_status::uuid end;
 if v_to_base<>v_row.status and erp_documents.transition_reason_required(p_kind,v_row.status,v_to_base) and coalesce(length(v_reason),0)<3 then
  raise exception 'erp_document_reason_required' using errcode='22023'; end if;
 v_actions:=array(select jsonb_array_elements_text(v_rule->'actions'));
 v_from_situation:=erp_documents.situation_json(p_kind,v_row.status,v_current);
 v_before:=erp_documents.document_view(p_id);
 foreach v_action in array array['reverse_stock','reverse_finance'] loop
  if v_action=any(v_actions) then v_effects:=v_effects||jsonb_build_array(erp_documents.transition_action(p_user_id,p_kind,p_id,p_command_id,v_action,v_target->>'name')); end if;
 end loop;
 update erp_documents.document set status=v_to_base,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 delete from erp_documents.document_situation where document_id=p_id;
 if v_custom is not null then
  insert into erp_documents.document_situation(document_id,kind,situation_id,base_status,actor,command_id) values(p_id,p_kind,v_custom,v_to_base,p_user_id,p_command_id);
 end if;
 foreach v_action in array array['post_stock','post_finance'] loop
  if v_action=any(v_actions) then v_effects:=v_effects||jsonb_build_array(erp_documents.transition_action(p_user_id,p_kind,p_id,p_command_id,v_action,v_target->>'name')); end if;
 end loop;
 v_auto:=erp_documents.auto_finance(p_user_id,p_id,p_command_id);
 v_to_situation:=erp_documents.situation_json(p_kind,v_to_base,v_custom);
 perform erp_documents.record_situation_occurrence(p_id,p_user_id,p_command_id,erp_documents.current_version(p_id),v_row.status,
  case when v_to_base<>v_row.status then v_to_base end,v_reason,v_from_situation,v_to_situation);
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.document_view(p_id),'effects',v_effects,'replayed',false,'data_mode','erp_native','operational_effects',false)
  ||case when v_auto is not null then jsonb_build_object('auto_finance',v_auto) else '{}'::jsonb end;
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
  values(p_user_id,p_command_id,p_id,'transition',v_reason,v_before,erp_documents.document_view(p_id)||jsonb_build_object('effects',v_effects)
   ||case when v_auto is not null then jsonb_build_object('auto_finance',v_auto) else '{}'::jsonb end);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 163 plus the automatic lançamento de contas of the change of situação made by the occurrence.
create or replace function public.erp_document_occurrence_add(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,
 p_occurred_on text,p_occurred_time text,p_text text default null,p_status text default null,p_next_contact text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_on date; v_time text; v_text text; v_next date; v_change boolean; v_before jsonb; v_result jsonb;
 v_last erp_documents.occurrence; v_adopted boolean; v_key text; v_transition jsonb; v_now timestamp:=clock_timestamp() at time zone 'America/Sao_Paulo';
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 v_adopted:=erp_documents.situation_adopted(p_kind);
 if p_document_id is null or p_expected_version is null or p_expected_version<1 or p_occurred_time is null or p_occurred_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or (p_status is not null and not (case when v_adopted then erp_documents.situation_key_valid(p_kind,p_status) else (erp_documents.transitions()->p_kind)?p_status end))
  or (p_next_contact is not null and p_kind<>'sales_proposals') then
  raise exception 'erp_document_occurrence_invalid' using errcode='22023'; end if;
 v_on:=erp_documents.date_value(to_jsonb(p_occurred_on),true);
 v_text:=erp_documents.text_value(to_jsonb(p_text),1000,false,true);
 v_next:=erp_documents.date_value(to_jsonb(p_next_contact));
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','occurrence','actor',p_user_id,'kind',p_kind,'id',p_document_id,'version',p_expected_version,
  'occurred_on',p_occurred_on,'occurred_time',p_occurred_time,'text',p_text,'status',p_status,'next_contact',p_next_contact)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 -- Without the preference the occurrence keeps the current date and time; with it, any moment up to now.
 if erp_documents.preference('empresa.editar_data_ocorrencia')='true'::jsonb then
  v_time:=p_occurred_time;
  if v_on+v_time::time>date_trunc('minute',v_now) then raise exception 'erp_document_occurrence_future' using errcode='22023'; end if;
 else
  v_on:=v_now::date; v_time:=to_char(v_now,'HH24:MI');
 end if;
 select * into v_row from erp_documents.document where id=p_document_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_key:=case when v_adopted then coalesce((select s.situation_id::text from erp_documents.document_situation s where s.document_id=v_row.id),v_row.status) else v_row.status end;
 v_change:=p_status is not null and p_status<>v_key;
 if not v_change and v_text is null and v_next is null then raise exception 'erp_document_occurrence_empty' using errcode='22023'; end if;
 perform set_config('erp_documents.occurrence_on',v_on::text,true),set_config('erp_documents.occurrence_time',v_time,true),
  set_config('erp_documents.occurrence_text',coalesce(v_text,''),true),set_config('erp_documents.occurrence_next_contact',coalesce(v_next::text,''),true);
 if v_change then
  v_transition:=public.erp_document_transition(p_user_id,p_kind,p_document_id,v_row.version,md5('occurrence-transition:'||p_command_id::text)::uuid,p_status,
   nullif(btrim(regexp_replace(coalesce(v_text,''),'[[:cntrl:]]+',' ','g')),''));
 elsif v_adopted then
  perform erp_documents.record_situation_occurrence(p_document_id,p_user_id,p_command_id,v_row.version,v_row.status,null,v_text,erp_documents.document_situation_json(p_document_id),null);
 else
  perform erp_documents.record_occurrence(p_document_id,p_user_id,p_command_id,v_row.version,v_row.status,null,v_text);
 end if;
 perform set_config('erp_documents.occurrence_on','',true),set_config('erp_documents.occurrence_time','',true),
  set_config('erp_documents.occurrence_text','',true),set_config('erp_documents.occurrence_next_contact','',true);
 if v_next is not null then
  v_before:=erp_documents.dto(p_document_id);
  update erp_documents.document set body=jsonb_set(body,'{next_contact}',to_jsonb(v_next::text),true),version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_document_id;
  insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
   values(p_user_id,p_command_id,p_document_id,'next_contact',v_before,erp_documents.dto(p_document_id));
 elsif not v_change then
  insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
   values(p_user_id,p_command_id,p_document_id,'occurrence',v_text,null,null);
 end if;
 select * into v_last from erp_documents.occurrence where document_id=p_document_id order by sequence desc limit 1;
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.document_view(p_document_id),'occurrence',erp_documents.occurrence_json(v_last),
  'replayed',false,'data_mode','erp_native','operational_effects',false)
  ||case when v_transition?'auto_finance' then jsonb_build_object('auto_finance',v_transition->'auto_finance') else '{}'::jsonb end;
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on function erp_documents.extension_keys(),erp_documents.extension_data(jsonb),erp_documents.payment_types(),erp_documents.optional_amount(jsonb),
 erp_documents.installment_details(text,jsonb,numeric),erp_documents.normalize(text,jsonb),erp_documents.require_commercial_input(jsonb,jsonb),
 erp_documents.check_payment_links(text,jsonb,jsonb),erp_documents.check_tax_preference(jsonb,jsonb),erp_documents.check_credit_limit(uuid,text,jsonb,jsonb),erp_documents.auto_finance(uuid,uuid,uuid),erp_documents.document_view(uuid),
 erp_documents.finance_payment_preview(erp_documents.document,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb),
 public.erp_document_copy_preview(uuid,text,uuid),public.erp_document_conversion_preview(uuid,text,uuid),public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid),
 public.erp_document_payment_options(uuid,text),public.erp_document_supplier_codes(uuid,uuid,uuid[]),
 public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb),
 public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text),public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb),
 public.erp_document_copy_preview(uuid,text,uuid),public.erp_document_conversion_preview(uuid,text,uuid),public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid),
 public.erp_document_payment_options(uuid,text),public.erp_document_supplier_codes(uuid,uuid,uuid[]),
 public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb),
 public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text),public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text) to service_role;
commit;
