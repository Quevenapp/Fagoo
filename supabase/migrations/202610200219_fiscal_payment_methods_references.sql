-- 219: formulário "Nota fiscal" no padrão Origin, onda D — Forma das parcelas e Documento referenciado.
-- 1. Pagamento › Parcelas › Forma: as formas de pagamento do cadastro (Cadastros › Formas de pagamento, contatos 127) que valem
--    para recebimentos (nota de saída) ou pagamentos (nota de entrada). A parcela guarda a forma do cadastro (payment_method_id) com o
--    tPag dela e os dados do cartão; a tabela fixa de tPag continua para quem não usa o cadastro. erp_fiscal_invoice_payment_methods
--    lista as formas ativas para os perfis da nota (admin e fiscal), porque o fiscal não lê o cadastro de formas de pagamento.
-- 2. Documento referenciado: erp_fiscal_invoice_key_lookup procura a chave nas notas do Brufap e no acervo de XML do Origin (027) e
--    diz qual nota é (número, série, data, contato, valor), só para conferência; nada é gravado.
-- Nada aqui emite, transmite ou lança estoque/contas. Requer as migrações publicadas até 202610200190 (112, 113, 127 e 176).
begin;

do $$declare v record;begin
 if to_regclass('erp_catalog.payment_method') is null or to_regclass('origin_fiscal.source') is null then raise exception 'fiscal_invoice_219_requires_127' using errcode='55000'; end if;
 for v in select * from(values
  ('erp_fiscal_invoices.invoice_specs()','7ade8ec69cf51ab416acf02ad2d35607c25058cb10e10ff0009368612c467bdf'),
  ('erp_fiscal_invoices.payment_input(jsonb)','2d54e43042f87d68804474a0b7c9cdedd9f62c28724a8f3a85c8580296811b80'))v(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'fiscal_invoice_219_previous_definition_changed' using errcode='55000',detail=v.sig; end if;
 end loop;
end$$;

-- 176 plus installment.payment_method_id (the forma de pagamento of the cadastro).
create or replace function erp_fiscal_invoices.invoice_specs() returns jsonb language sql immutable set search_path=pg_catalog as $spec$
 select '{"recipient":{"contact_id":"u","name":"t:60","person_type":"e:J|F|E","document":"x:^([0-9]{11}|[0-9]{14})$","foreign_id":"x:^[A-Za-z0-9.:/-]{0,20}$","ie":"x:^([0-9]{2,14}|ISENTO)$","ie_indicator":"e:1|2|9","email":"t:60","phone":"x:^[0-9]{6,14}$","postal_code":"x:^[0-9]{8}$","street":"t:60","number":"t:60","complement":"t:60","district":"t:60","city":"t:60","municipality_code":"x:^[0-9]{7}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO|EX","country":"t:60"},"export":{"exit_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","exit_place":"t:60","dispatch_place":"t:60"},"import":{"number":"t:15","registration_date":"a","exporter_code":"t:60","customs_expenses":"d:2:13","clearance_place":"t:60","clearance_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","clearance_date":"a","afrmm_value":"d:2:13","acquirer_cnpj":"x:^[0-9]{14}$","acquirer_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","transport_route":"e:1|2|3|4|5|6|7|8|9|10|11|12|13","intermediation":"e:1|2|3","unit_value_with_ii":"b"},"addition":{"number":"x:^[0-9]{1,3}$","sequence":"x:^[0-9]{1,5}$","manufacturer":"t:60","discount":"d:2:13","drawback":"x:^[0-9]{1,20}$"},"reference":{"type":"e:nfe|ecf|nf01|nf02|nfp01|nfp04|cte","key":"x:^[0-9]{44}$","year_month":"x:^[0-9]{2}(0[1-9]|1[0-2])$","number":"x:^[0-9]{1,9}$","series":"x:^[0-9]{1,3}$"},"transport":{"mode":"e:none|manual","freight_by":"e:0|1|2|3|4|9","tracking_code":"t:60"},"carrier":{"contact_id":"u","name":"t:60","document":"x:^([0-9]{11}|[0-9]{14})$","ie":"x:^([0-9]{2,14}|ISENTO)$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","city":"t:60","address":"t:60"},"vehicle":{"plate":"x:^[A-Z0-9]{7}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","rntc":"t:20"},"volumes":{"quantity":"x:^[0-9]{1,15}$","gross_weight":"d:3:12","net_weight":"d:3:12","numbering":"t:60","brand":"t:60","species":"e:outros|volumes|unidades|caixas|pacotes|envelopes|pallets|sacos"},"delivery":{"name":"t:60","postal_code":"x:^[0-9]{8}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO|EX","city":"t:60","street":"t:60","number":"t:60","district":"t:60","complement":"t:60","country":"t:60"},"installment":{"days":"x:^[0-9]{1,4}$","date":"a","amount":"d:2:13","method":"e:01|02|03|04|05|10|11|12|13|15|16|17|18|19|20|90|99","note":"t:255","payment_method_id":"u"},"card":{"integration":"e:1|2","cnpj":"x:^[0-9]{14}$","brand":"x:^[0-9]{2}$","authorization":"t:128","received":"d:2:13","fee":"d:2:13","commission_fee":"d:2:13"},"authorized":{"contact_id":"u","name":"t:60","document":"x:^([0-9]{11}|[0-9]{14})$"},"intermediary":{"present":"b","cnpj":"x:^[0-9]{14}$","identification":"t:60"},"item":{"product_id":"u","description":"t:120","code":"t:60","kind":"e:P|S","unit":"t:6","quantity":"d:4:11","unit_price":"d:10:11","discount":"d:2:13","discount_type":"e:C|I","nature_id":"u","cfop":"x:^[1-7][0-9]{3}$","ncm":"x:^([0-9]{8}|00)$","cest":"x:^[0-9]{7}$","gtin":"x:^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$","gtin_tax":"x:^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$","barcode":"t:30","barcode_tax":"t:30","gross_weight":"d:3:12","net_weight":"d:3:12","volumes":"x:^[0-9]{1,6}$","invoiced":"b","info":"m:500","complementary_info":"m:2000","fiscal_info":"m:2000"},"item_groups":{"icms":{"origin":"e:0|1|2|3|4|5|6|7|8","situation":"e:00|02|10|15|20|30|40|41|50|51|53|60|61|70|90|101|102|103|201|202|203|300|400|500|900","taxation":"e:T|I|O","bc_mode":"e:0|1|2|3","pauta_value":"d:4:11","base_rate":"d:4:3","base":"d:2:13","deferral_rate":"d:4:3","presumed_rate":"d:4:3","presumed_value":"d:2:13","rate":"d:4:3","value":"d:2:13","fcp_rate":"d:4:3","fcp_value":"d:2:13","fcp_deferral_rate":"d:4:3","fcp_deferral_value":"d:2:13","fcp_effective_value":"d:2:13","credit_rate":"d:4:3","credit_value":"d:2:13","deson_value":"d:2:13","deson_reason":"e:1|3|4|5|6|7|8|9|10|11|90","deson_deduct":"b","reduction_reason":"e:1|9","benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","presumed_credit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","rbc_benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","mono_qty":"d:4:11","mono_rate":"d:4:3","mono_value":"d:2:13","mono_deferred_value":"d:2:13","mono_icms_value":"d:2:13","st_bc_mode":"e:0|1|2|3|4|5|6","st_pauta_value":"d:4:11","st_mva":"d:4:3","st_base_rate":"d:4:3","st_base":"d:2:13","st_rate":"d:4:3","st_value":"d:2:13","st_fcp_value":"d:2:13","st_deson_value":"d:2:13","st_deson_reason":"e:3|9|90","pis_st_base":"d:2:13","pis_st_rate":"d:4:3","pis_st_value":"d:2:13","cofins_st_base":"d:2:13","cofins_st_rate":"d:4:3","cofins_st_value":"d:2:13","ret_unit_base":"d:4:11","ret_unit_icms":"d:4:11","ret_unit_substitute":"d:4:11","ret_substitute_value":"d:2:13","ret_base_rate":"d:4:3","ret_base":"d:2:13","ret_rate":"d:4:3","ret_value":"d:2:13","difal_type":"e:N|I","difal_base_rate":"d:4:3","difal_base":"d:2:13","difal_fcp_rate":"d:4:3","difal_fcp_value":"d:2:13","difal_internal_rate":"d:4:3","difal_interstate_rate":"e:4.0000|7.0000|12.0000","difal_share_rate":"d:4:3","difal_dest_value":"d:2:13","difal_origin_value":"d:2:13","complementary_info":"m:2000","fiscal_info":"m:2000"},"ipi":{"taxation":"e:T|I|O","situation":"e:00|01|02|03|04|05|49|50|51|52|53|54|55|99","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","class_code":"t:5","seal_code":"t:60","framing_code":"x:^[0-9]{3}$","tipi_exception":"x:^[0-9]{1,3}$","final_consumer":"b","devol_rate":"d:4:3","devol_value":"d:2:13","complementary_info":"m:2000","fiscal_info":"m:2000"},"pis":{"situation":"e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99","taxation":"e:T|I|O","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","complementary_info":"m:2000","fiscal_info":"m:2000"},"cofins":{"situation":"e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99","taxation":"e:T|I|O","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","complementary_info":"m:2000","fiscal_info":"m:2000"},"ii":{"situation":"e:T|N","base":"d:2:13","rate":"d:4:3","value":"d:2:13","taxation":"e:T|I|O","customs_expense":"d:2:13","add_icms":"b","add_other":"b","addition":"x:^[0-9]{1,3}$"},"export":{"drawback":"x:^[0-9]{1,20}$","registry":"x:^[0-9]{1,12}$","key":"x:^[0-9]{44}$"},"fuel":{"anp_code":"x:^[0-9]{9}$","anp_description":"t:95","codif":"x:^[0-9]{1,21}$","consumption_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","ambient_qty":"d:4:11","glp_rate":"d:4:3","glgnn_rate":"d:4:3","glgni_rate":"d:4:3","start_value":"d:2:13","cide_base":"d:4:11","cide_rate":"d:4:11","cide_value":"d:2:13","biodiesel_rate":"d:4:3"},"medicine":{"anvisa_code":"x:^([0-9A-Za-z]{13}|ISENTO)$","max_price":"d:2:13","exemption_reason":"t:255"},"others":{"presumed_pis_cofins":"b","funrural_rate":"d:4:3","sped_type":"e:00|01|02|03|04|05|06|07|08|09|10|99","commission_base":"d:2:13","commission_rate":"d:4:3","commission_value":"d:2:13","fci":"x:^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$","purchase_order":"t:15","purchase_order_item":"x:^[0-9]{1,6}$","ibpt_rate":"d:4:3","approx_taxes":"d:2:13","tax_unit":"t:6","tax_quantity":"d:4:11"},"stock":{"supplier_code":"t:60","scale":"e:S|N","manufacturer_cnpj":"x:^[0-9]{14}$"},"retentions":{"csrf":"b","pis_value":"d:2:13","cofins_value":"d:2:13","csll_rate":"d:4:3","csll_value":"d:2:13","ir":"b","ir_csll_base":"d:2:13","ir_rate":"d:4:3","ir_value":"d:2:13"},"weapon":{"type":"e:0|1","description":"t:256","serial":"t:15","barrel":"t:15"},"vehicle":{"operation":"e:0|1|2|3","chassis":"x:^[A-Z0-9]{17}$","color_code":"t:4","color":"t:40","power":"t:4","displacement":"t:4","net_weight":"t:9","gross_weight":"t:9","serial":"t:9","fuel_type":"x:^[0-9]{2}$","engine_number":"t:21","cmt":"t:9","wheelbase":"t:4","model_year":"x:^[0-9]{4}$","manufacture_year":"x:^[0-9]{4}$","paint_type":"t:1","vehicle_type":"x:^[0-9]{1,2}$","species":"e:1|2|3|4|5|6","vin_condition":"e:R|N","vehicle_condition":"e:1|2|3","brand_model_code":"x:^[0-9]{1,6}$","denatran_color":"x:^[0-9]{2}$","capacity":"x:^[0-9]{1,3}$","restriction":"e:0|1|2|3|4|9"}}}'::jsonb
$spec$;

-- 112 plus the forma de pagamento of the cadastro: it must exist (an inactive one stays on the parcels that already carry it).
create or replace function erp_fiscal_invoices.payment_input(p_value jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare s jsonb:=erp_fiscal_invoices.invoice_specs();v jsonb;i jsonb;card jsonb;result jsonb:='[]';
begin
 if p_value is null or p_value='null'::jsonb then p_value:='{}'; end if;
 if jsonb_typeof(p_value)<>'object' or exists(select 1 from jsonb_object_keys(p_value) k where k not in('condition','installments')) then
  raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 for v in select value from jsonb_array_elements(erp_fiscal_invoices.array_input(p_value->'installments',120)) loop
  if jsonb_typeof(v)<>'object' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  i:=erp_fiscal_invoices.spec_object(v-'card',s->'installment');
  if not i ?& array['date','amount'] then raise exception 'erp_fiscal_invoice_installment_invalid' using errcode='22023'; end if;
  -- The forma must exist. One excluded later stays on the parcels that already carry it (the note keeps saving);
  -- erp_fiscal_invoice_execute (215) refuses it on a parcel that did not have it.
  if i?'payment_method_id' and not exists(select 1 from erp_catalog.payment_method m where m.id=(i->>'payment_method_id')::uuid) then
   raise exception 'erp_fiscal_invoice_payment_method_not_found' using errcode='22023'; end if;
  card:=case when v->'card' is null or v->'card'='null'::jsonb then null else erp_fiscal_invoices.spec_object(v->'card',s->'card') end;
  result:=result||jsonb_build_array(i||jsonb_build_object('card',card));
 end loop;
 return jsonb_build_object('condition',erp_fiscal_invoices.text_input(p_value->'condition',60),'installments',result);
end $$;

-- "Forma" of the parcels: the active formas de pagamento for recebimentos (exit notes) or pagamentos (entry notes), up to 200.
create function public.erp_fiscal_invoice_payment_methods(p_user_id uuid,p_direction text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);
begin
 if p_direction is null or p_direction not in('0','1') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 return jsonb_build_object('direction',p_direction,'data_mode','erp_native','items',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'description',x.description,'payment_type',x.payment_type,
   'card_brand',x.card_brand,'card_integration',x.card_integration,'card_cnpj',x.card_cnpj) order by lower(x.description),x.id) from(
  select m.* from erp_catalog.payment_method m where m.deleted_at is null and m.active
   and m.applicable in('ambos',case p_direction when '1' then 'recebimentos' else 'pagamentos' end) order by lower(m.description),m.id limit 200) x),'[]'::jsonb));
end $$;

-- Documento referenciado: which note the access key is, among the Brufap notes and the Origin XML archive (conference only).
create function public.erp_fiscal_invoice_key_lookup(p_user_id uuid,p_key text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);v_items jsonb;
begin
 if p_key is null or p_key !~ '^[0-9]{44}$' then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 select coalesce(jsonb_agg(x.item order by x.ord,x.item->>'id'),'[]'::jsonb) into v_items from(
  select 1 ord,jsonb_build_object('origin','brufap','id',v.id::text,'model',v.model,'direction',v.direction,'number',v.number,'series',v.series,'issue_date',v.issue_date,
   'name',left(v.recipient->>'name',200),'total',erp_fiscal_invoices.money_text((v.totals->>'total')::numeric)) item
  from erp_fiscal_invoices.invoice v where v.access_key=p_key and v.deleted_at is null
  union all
  select 2,jsonb_build_object('origin','origin','id',r.source_id,'model',case r.entity when 'nfe' then '55' else '65' end,
   'direction',case when r.entity='nfce' then '1' when erp_fiscal_invoices.scalar(r.payload->'tipo',2) in('0','1') then r.payload->>'tipo' end,
   'number',erp_fiscal_invoices.origin_int(to_jsonb(nullif(ltrim(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(r.payload->'numero',20)),'0'),''))),
   'series',erp_fiscal_invoices.origin_int(r.payload->'serie'),'issue_date',erp_fiscal_invoices.origin_date(r.payload->'dataEmissao'),
   'name',erp_fiscal_invoices.scalar(r.payload#>'{contato,nome}',200),
   'total',case when erp_fiscal_invoices.origin_money(r.payload->'valorNota') is null then null else erp_fiscal_invoices.money_text(erp_fiscal_invoices.origin_money(r.payload->'valorNota')) end)
  from origin_fiscal.source s join origin_sync.raw_record r on r.entity=s.entity and r.source_id=s.source_id where s.access_key=p_key limit 5) x;
 return jsonb_build_object('key',p_key,'items',v_items,'data_mode','erp_native');
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_fiscal_invoice_payment_methods(uuid,text)','erp_fiscal_invoice_key_lookup(uuid,text)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
