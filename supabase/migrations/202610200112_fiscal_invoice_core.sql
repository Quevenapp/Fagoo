-- Notas fiscais próprias do Brufap (NF-e 55 e NFC-e 65, saída e entrada): cabeçalho, itens com tributos por
-- imposto, documentos referenciados, transporte, pagamento, autXML, intermediador e informações adicionais.
-- Gravar uma nota não emite, não reserva número, não gera XML, não transmite e não lança estoque nem financeiro.
-- Toda nota que o Brufap transmitiria fica no ambiente 2 (homologação); notas de terceiros (tipo T) são só
-- registradas e não têm ambiente. As travas 022/041/046/064 não mudam.
begin;
create table erp_fiscal_invoices.invoice(
 id uuid primary key default gen_random_uuid(),
 model text not null check(model in('55','65')),direction text not null check(direction in('0','1')),
 issue_type text not null check(issue_type in('N','D','E','T','S','C','I','X')),environment text check(environment='2'),
 status smallint not null check(status in(1,2,3,4,5,6,7,8,9,10,11,12,14,15,16)),
 series integer not null check(series between 0 and 999),number integer check(number between 1 and 999999999),
 access_key text check(access_key~'^[0-9]{44}$'),protocol text check(protocol~'^[0-9]{15}$'),authorized_at timestamptz,
 nature_id uuid references erp_fiscal_invoices.nature(id),nature_description text not null check(length(nature_description) between 1 and 60),
 cfop text check(cfop~'^[1-7][0-9]{3}$'),issue_date date not null,exit_date date,exit_time text check(exit_time~'^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 crt text not null check(crt in('1','2','3','4')),purpose text not null check(purpose in('1','2','3','4','5','6')),
 credit_debit_type text check(credit_debit_type~'^[0-9]{2}$'),presence text not null check(presence in('0','1','2','3','4','5','9')),
 final_consumer boolean not null,recipient jsonb not null check(jsonb_typeof(recipient)='object'),export jsonb,import_declaration jsonb,
 doc_references jsonb not null check(jsonb_typeof(doc_references)='array'),transport jsonb not null check(jsonb_typeof(transport)='object'),
 payment jsonb not null check(jsonb_typeof(payment)='object'),authorized_xml jsonb not null check(jsonb_typeof(authorized_xml)='array'),
 intermediary jsonb not null check(jsonb_typeof(intermediary)='object'),additional_info text check(length(additional_info)<=5000),
 nature_additional_info text check(length(nature_additional_info)<=5000),nature_fiscal_info text check(length(nature_fiscal_info)<=2000),
 auto_tax boolean not null,freight numeric(15,2) not null check(freight>=0),insurance numeric(15,2) not null check(insurance>=0),
 other_expenses numeric(15,2) not null check(other_expenses>=0),discount numeric(15,2) not null check(discount>=0),
 totals jsonb not null check(jsonb_typeof(totals)='object'),version integer not null default 1 check(version>0),
 created_by uuid not null references auth.users(id),updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 deleted_at timestamptz,deleted_by uuid references auth.users(id),delete_reason text check(length(delete_reason) between 3 and 1000),
 check((model='65')=(issue_type='C')),check(model='55' or direction='1'),
 check((direction='0' and issue_type in('N','I','T','X')) or (direction='1' and issue_type in('N','D','E','T','S','C'))),
 check((issue_type in('T','S','X'))=(environment is null)),check(issue_type not in('T','S','X') or number is not null),
 check((deleted_at is null and deleted_by is null and delete_reason is null) or (deleted_at is not null and deleted_by is not null and delete_reason is not null))
);
create unique index erp_fiscal_invoice_access_key on erp_fiscal_invoices.invoice(access_key) where access_key is not null and deleted_at is null;
create index erp_fiscal_invoice_list on erp_fiscal_invoices.invoice(model,direction,issue_date desc,number desc) where deleted_at is null;
create table erp_fiscal_invoices.invoice_item(
 invoice_id uuid not null references erp_fiscal_invoices.invoice(id),position integer not null check(position between 1 and 990),
 product_id uuid references erp_catalog.record(id),
 quantity numeric not null check(quantity>0 and quantity<100000000000 and quantity=trunc(quantity,4)),
 unit_price numeric not null check(unit_price>=0 and unit_price<100000000000 and unit_price=trunc(unit_price,10)),
 total numeric(15,2) not null check(total>=0),freight numeric(15,2) not null,insurance numeric(15,2) not null,other_expenses numeric(15,2) not null,
 discount numeric(15,2) not null,data jsonb not null check(jsonb_typeof(data)='object'),primary key(invoice_id,position)
);
create index erp_fiscal_invoice_item_product on erp_fiscal_invoices.invoice_item(product_id) where product_id is not null;
-- Origin documents (V/O letters): pedidos de venda on exit notes, pedidos de compra on entry notes.
create table erp_fiscal_invoices.invoice_order(
 invoice_id uuid not null references erp_fiscal_invoices.invoice(id),document_id uuid not null references erp_documents.document(id),
 primary key(invoice_id,document_id)
);
create table erp_fiscal_invoices.invoice_revision(
 invoice_id uuid not null references erp_fiscal_invoices.invoice(id),version integer not null check(version>0),
 record jsonb not null check(jsonb_typeof(record)='object'),primary key(invoice_id,version)
);
do $$ declare t text; begin foreach t in array array['invoice','invoice_item','invoice_order','invoice_revision'] loop
 execute format('alter table erp_fiscal_invoices.%I enable row level security',t); end loop; end $$;
revoke all on all tables in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
create trigger immutable_invoice_revision before update or delete on erp_fiscal_invoices.invoice_revision for each row execute function erp_fiscal_invoices.immutable_history();
create function erp_fiscal_invoices.guard_invoice() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'erp_fiscal_invoice_no_delete' using errcode='42501'; end if;
 if old.deleted_at is not null or new.id<>old.id or new.model<>old.model or new.direction<>old.direction or new.created_at<>old.created_at
  or new.created_by<>old.created_by or new.environment is distinct from old.environment or old.version=2147483647 or new.version<>old.version+1 then
  raise exception 'erp_fiscal_invoice_immutable_identity' using errcode='40001'; end if;
 -- Production stays off: nothing here can move a note to environment 1 or authorize it.
 if new.protocol is distinct from old.protocol or new.authorized_at is distinct from old.authorized_at or (new.access_key is distinct from old.access_key and new.issue_type not in('T','S','X')) then
  raise exception 'erp_fiscal_invoice_authorization_immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger guard_invoice before update or delete on erp_fiscal_invoices.invoice for each row execute function erp_fiscal_invoices.guard_invoice();

create function erp_fiscal_invoices.invoice_specs() returns jsonb language sql immutable set search_path=pg_catalog as $spec$
 select '{"recipient":{"contact_id":"u","name":"t:60","person_type":"e:J|F|E","document":"x:^([0-9]{11}|[0-9]{14})$","foreign_id":"x:^[A-Za-z0-9.:/-]{0,20}$","ie":"x:^([0-9]{2,14}|ISENTO)$","ie_indicator":"e:1|2|9","email":"t:60","phone":"x:^[0-9]{6,14}$","postal_code":"x:^[0-9]{8}$","street":"t:60","number":"t:60","complement":"t:60","district":"t:60","city":"t:60","municipality_code":"x:^[0-9]{7}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO|EX","country":"t:60"},"export":{"exit_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","exit_place":"t:60","dispatch_place":"t:60"},"import":{"number":"t:15","registration_date":"a","exporter_code":"t:60","customs_expenses":"d:2:13","clearance_place":"t:60","clearance_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","clearance_date":"a","afrmm_value":"d:2:13","acquirer_cnpj":"x:^[0-9]{14}$","acquirer_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","transport_route":"e:1|2|3|4|5|6|7|8|9|10|11|12|13","intermediation":"e:1|2|3","unit_value_with_ii":"b"},"addition":{"number":"x:^[0-9]{1,3}$","sequence":"x:^[0-9]{1,5}$","manufacturer":"t:60","discount":"d:2:13","drawback":"x:^[0-9]{1,20}$"},"reference":{"type":"e:nfe|ecf|nf01|nf02|nfp01|nfp04|cte","key":"x:^[0-9]{44}$","year_month":"x:^[0-9]{2}(0[1-9]|1[0-2])$","number":"x:^[0-9]{1,9}$","series":"x:^[0-9]{1,3}$"},"transport":{"mode":"e:none|manual","freight_by":"e:0|1|2|3|4|9","tracking_code":"t:60"},"carrier":{"contact_id":"u","name":"t:60","document":"x:^([0-9]{11}|[0-9]{14})$","ie":"x:^([0-9]{2,14}|ISENTO)$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","city":"t:60","address":"t:60"},"vehicle":{"plate":"x:^[A-Z0-9]{7}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","rntc":"t:20"},"volumes":{"quantity":"x:^[0-9]{1,15}$","gross_weight":"d:3:12","net_weight":"d:3:12","numbering":"t:60","brand":"t:60","species":"e:outros|volumes|unidades|caixas|pacotes|envelopes|pallets|sacos"},"delivery":{"name":"t:60","postal_code":"x:^[0-9]{8}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO|EX","city":"t:60","street":"t:60","number":"t:60","district":"t:60","complement":"t:60","country":"t:60"},"installment":{"days":"x:^[0-9]{1,4}$","date":"a","amount":"d:2:13","method":"e:01|02|03|04|05|10|11|12|13|15|16|17|18|19|20|90|99","note":"t:255"},"card":{"integration":"e:1|2","cnpj":"x:^[0-9]{14}$","brand":"x:^[0-9]{2}$","authorization":"t:128","received":"d:2:13","fee":"d:2:13","commission_fee":"d:2:13"},"authorized":{"contact_id":"u","name":"t:60","document":"x:^([0-9]{11}|[0-9]{14})$"},"intermediary":{"present":"b","cnpj":"x:^[0-9]{14}$","identification":"t:60"},"item":{"product_id":"u","description":"t:120","code":"t:60","kind":"e:P|S","unit":"t:6","quantity":"d:4:11","unit_price":"d:10:11","discount_type":"e:C|I","nature_id":"u","cfop":"x:^[1-7][0-9]{3}$","ncm":"x:^([0-9]{8}|00)$","cest":"x:^[0-9]{7}$","gtin":"x:^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$","gtin_tax":"x:^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$","barcode":"t:30","barcode_tax":"t:30","gross_weight":"d:3:12","net_weight":"d:3:12","volumes":"x:^[0-9]{1,6}$","invoiced":"b","info":"m:500","complementary_info":"m:2000","fiscal_info":"m:2000"},"item_groups":{"icms":{"origin":"e:0|1|2|3|4|5|6|7|8","situation":"e:00|02|10|15|20|30|40|41|50|51|53|60|61|70|90|101|102|103|201|202|203|300|400|500|900","taxation":"e:T|I|O","bc_mode":"e:0|1|2|3","pauta_value":"d:4:11","base_rate":"d:4:3","base":"d:2:13","deferral_rate":"d:4:3","presumed_rate":"d:4:3","presumed_value":"d:2:13","rate":"d:4:3","value":"d:2:13","fcp_rate":"d:4:3","fcp_value":"d:2:13","fcp_deferral_rate":"d:4:3","fcp_deferral_value":"d:2:13","fcp_effective_value":"d:2:13","credit_rate":"d:4:3","credit_value":"d:2:13","deson_value":"d:2:13","deson_reason":"e:1|3|4|5|6|7|8|9|10|11|90","deson_deduct":"b","reduction_reason":"e:1|9","benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","presumed_credit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","rbc_benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","mono_qty":"d:4:11","mono_rate":"d:4:3","mono_value":"d:2:13","mono_deferred_value":"d:2:13","mono_icms_value":"d:2:13","st_bc_mode":"e:0|1|2|3|4|5|6","st_pauta_value":"d:4:11","st_mva":"d:4:3","st_base_rate":"d:4:3","st_base":"d:2:13","st_rate":"d:4:3","st_value":"d:2:13","st_fcp_value":"d:2:13","st_deson_value":"d:2:13","st_deson_reason":"e:3|9|90","pis_st_base":"d:2:13","pis_st_rate":"d:4:3","pis_st_value":"d:2:13","cofins_st_base":"d:2:13","cofins_st_rate":"d:4:3","cofins_st_value":"d:2:13","ret_unit_base":"d:4:11","ret_unit_icms":"d:4:11","ret_unit_substitute":"d:4:11","ret_substitute_value":"d:2:13","ret_base_rate":"d:4:3","ret_base":"d:2:13","ret_rate":"d:4:3","ret_value":"d:2:13","difal_type":"e:N|I","difal_base_rate":"d:4:3","difal_base":"d:2:13","difal_fcp_rate":"d:4:3","difal_fcp_value":"d:2:13","difal_internal_rate":"d:4:3","difal_interstate_rate":"e:4.0000|7.0000|12.0000","difal_share_rate":"d:4:3","difal_dest_value":"d:2:13","difal_origin_value":"d:2:13","complementary_info":"m:2000","fiscal_info":"m:2000"},"ipi":{"taxation":"e:T|I|O","situation":"e:00|01|02|03|04|05|49|50|51|52|53|54|55|99","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","class_code":"t:5","seal_code":"t:60","framing_code":"x:^[0-9]{3}$","tipi_exception":"x:^[0-9]{1,3}$","final_consumer":"b","devol_rate":"d:4:3","devol_value":"d:2:13","complementary_info":"m:2000","fiscal_info":"m:2000"},"pis":{"situation":"e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99","taxation":"e:T|I|O","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","complementary_info":"m:2000","fiscal_info":"m:2000"},"cofins":{"situation":"e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99","taxation":"e:T|I|O","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","complementary_info":"m:2000","fiscal_info":"m:2000"},"ii":{"situation":"e:T|N","base":"d:2:13","rate":"d:4:3","value":"d:2:13","taxation":"e:T|I|O","customs_expense":"d:2:13","add_icms":"b","add_other":"b","addition":"x:^[0-9]{1,3}$"},"export":{"drawback":"x:^[0-9]{1,20}$","registry":"x:^[0-9]{1,12}$","key":"x:^[0-9]{44}$"},"fuel":{"anp_code":"x:^[0-9]{9}$","anp_description":"t:95","codif":"x:^[0-9]{1,21}$","consumption_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","ambient_qty":"d:4:11","glp_rate":"d:4:3","glgnn_rate":"d:4:3","glgni_rate":"d:4:3","start_value":"d:2:13","cide_base":"d:4:11","cide_rate":"d:4:11","cide_value":"d:2:13","biodiesel_rate":"d:4:3"},"medicine":{"anvisa_code":"x:^([0-9A-Za-z]{13}|ISENTO)$","max_price":"d:2:13","exemption_reason":"t:255"},"others":{"presumed_pis_cofins":"b","funrural_rate":"d:4:3","sped_type":"e:00|01|02|03|04|05|06|07|08|09|10|99","commission_base":"d:2:13","commission_rate":"d:4:3","commission_value":"d:2:13","fci":"x:^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$","purchase_order":"t:15","purchase_order_item":"x:^[0-9]{1,6}$","ibpt_rate":"d:4:3","approx_taxes":"d:2:13","tax_unit":"t:6","tax_quantity":"d:4:11"},"stock":{"supplier_code":"t:60","scale":"e:S|N","manufacturer_cnpj":"x:^[0-9]{14}$"},"retentions":{"csrf":"b","pis_value":"d:2:13","cofins_value":"d:2:13","csll_rate":"d:4:3","csll_value":"d:2:13","ir":"b","ir_csll_base":"d:2:13","ir_rate":"d:4:3","ir_value":"d:2:13"}}}'::jsonb
$spec$;
create function erp_fiscal_invoices.access_key_valid(p_key text) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare s integer:=0;w integer:=2;i integer;dv integer;
begin
 if p_key is null or p_key !~ '^[0-9]{44}$' then return false; end if;
 for i in reverse 43..1 loop s:=s+substr(p_key,i,1)::integer*w;w:=case when w=9 then 2 else w+1 end; end loop;
 dv:=11-(s%11);if dv>=10 then dv:=0; end if;
 return dv=substr(p_key,44,1)::integer;
end $$;
create function erp_fiscal_invoices.money_input(p_value jsonb) returns numeric language plpgsql immutable set search_path=pg_catalog as $$
begin return coalesce((erp_fiscal_invoices.check_value(p_value,'d:2:13')#>>'{}')::numeric,0); end $$;
create function erp_fiscal_invoices.money_text(p_value numeric) returns text language sql immutable set search_path=pg_catalog as $$
 select to_char(round(coalesce(p_value,0),2),'FM9999999999999990.00')
$$;
create function erp_fiscal_invoices.array_input(p_value jsonb,p_max integer) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_value is null or p_value='null'::jsonb then return '[]'::jsonb; end if;
 if jsonb_typeof(p_value)<>'array' or jsonb_array_length(p_value)>p_max then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
 return p_value;
end $$;
create function erp_fiscal_invoices.recipient_input(p_value jsonb,p_model text) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare r jsonb:=erp_fiscal_invoices.spec_object(p_value,erp_fiscal_invoices.invoice_specs()->'recipient');
begin
 if p_model='55' and (not r?'name' or not r?'person_type') then raise exception 'erp_fiscal_invoice_recipient_required' using errcode='22023'; end if;
 if (r->>'person_type'='J' and r?'document' and length(r->>'document')<>14) or (r->>'person_type'='F' and r?'document' and length(r->>'document')<>11)
  or (r->>'person_type'='E' and r?'document') or (r->>'person_type' is distinct from 'E' and r?'foreign_id') then
  raise exception 'erp_fiscal_invoice_recipient_document_invalid' using errcode='22023'; end if;
 if r?'contact_id' and not exists(select 1 from erp_catalog.record c where c.id=(r->>'contact_id')::uuid and c.entity='contacts') then
  raise exception 'erp_fiscal_invoice_contact_not_found' using errcode='22023'; end if;
 return r;
end $$;
create function erp_fiscal_invoices.references_input(p_value jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v jsonb;r jsonb;result jsonb:='[]';keys text[]:='{}';
begin
 for v in select value from jsonb_array_elements(erp_fiscal_invoices.array_input(p_value,100)) loop
  r:=erp_fiscal_invoices.spec_object(v,erp_fiscal_invoices.invoice_specs()->'reference');
  if not r?'type' then raise exception 'erp_fiscal_invoice_reference_invalid' using errcode='22023'; end if;
  if r->>'type' in('nfe','cte') then
   if not r?'key' or r ?| array['year_month','number','series'] or not erp_fiscal_invoices.access_key_valid(r->>'key')
    or substring(r->>'key',21,2)<>(case r->>'type' when 'cte' then '57' else substring(r->>'key',21,2) end)
    or (r->>'type'='nfe' and substring(r->>'key',21,2) not in('55','65')) then raise exception 'erp_fiscal_invoice_reference_key_invalid' using errcode='22023'; end if;
   if r->>'key'=any(keys) then raise exception 'erp_fiscal_invoice_reference_duplicate' using errcode='22023'; end if;
   keys:=keys||(r->>'key');
  elsif r->>'type'='ecf' then
   if not r?'number' or r ?| array['key','year_month'] then raise exception 'erp_fiscal_invoice_reference_invalid' using errcode='22023'; end if;
  elsif not r ?& array['year_month','number','series'] or r?'key' then raise exception 'erp_fiscal_invoice_reference_invalid' using errcode='22023'; end if;
  result:=result||jsonb_build_array(r);
 end loop;
 return result;
end $$;
create function erp_fiscal_invoices.transport_input(p_value jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare s jsonb:=erp_fiscal_invoices.invoice_specs();base jsonb;carrier jsonb;vehicle jsonb;volumes jsonb;delivery jsonb;
begin
 if p_value is null or p_value='null'::jsonb then p_value:='{}'; end if;
 if jsonb_typeof(p_value)<>'object' or exists(select 1 from jsonb_object_keys(p_value) k where k not in('mode','freight_by','tracking_code','carrier','vehicle','volumes','delivery')) then
  raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 base:=erp_fiscal_invoices.spec_object(p_value-'carrier'-'vehicle'-'volumes'-'delivery',s->'transport');
 carrier:=erp_fiscal_invoices.spec_object(p_value->'carrier',s->'carrier');vehicle:=erp_fiscal_invoices.spec_object(p_value->'vehicle',s->'vehicle');
 volumes:=erp_fiscal_invoices.spec_object(p_value->'volumes',s->'volumes');
 delivery:=case when p_value->'delivery' is null or p_value->'delivery'='null'::jsonb then null else erp_fiscal_invoices.spec_object(p_value->'delivery',s->'delivery') end;
 base:=jsonb_build_object('mode','none')||base;
 if base->>'mode'='none' then
  if carrier<>'{}' or vehicle<>'{}' then raise exception 'erp_fiscal_invoice_transport_invalid' using errcode='22023'; end if;
  base:=jsonb_build_object('freight_by','9')||base;
 end if;
 if not base?'freight_by' then base:=base||jsonb_build_object('freight_by','0'); end if;
 if carrier?'contact_id' and not exists(select 1 from erp_catalog.record c where c.id=(carrier->>'contact_id')::uuid and c.entity='contacts') then
  raise exception 'erp_fiscal_invoice_contact_not_found' using errcode='22023'; end if;
 return base||jsonb_build_object('carrier',carrier,'vehicle',vehicle,'volumes',volumes,'delivery',delivery);
end $$;
create function erp_fiscal_invoices.payment_input(p_value jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare s jsonb:=erp_fiscal_invoices.invoice_specs();v jsonb;i jsonb;card jsonb;result jsonb:='[]';
begin
 if p_value is null or p_value='null'::jsonb then p_value:='{}'; end if;
 if jsonb_typeof(p_value)<>'object' or exists(select 1 from jsonb_object_keys(p_value) k where k not in('condition','installments')) then
  raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 for v in select value from jsonb_array_elements(erp_fiscal_invoices.array_input(p_value->'installments',120)) loop
  if jsonb_typeof(v)<>'object' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  i:=erp_fiscal_invoices.spec_object(v-'card',s->'installment');
  if not i ?& array['date','amount'] then raise exception 'erp_fiscal_invoice_installment_invalid' using errcode='22023'; end if;
  card:=case when v->'card' is null or v->'card'='null'::jsonb then null else erp_fiscal_invoices.spec_object(v->'card',s->'card') end;
  result:=result||jsonb_build_array(i||jsonb_build_object('card',card));
 end loop;
 return jsonb_build_object('condition',erp_fiscal_invoices.text_input(p_value->'condition',60),'installments',result);
end $$;
create function erp_fiscal_invoices.authorized_input(p_value jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v jsonb;r jsonb;result jsonb:='[]';
begin
 for v in select value from jsonb_array_elements(erp_fiscal_invoices.array_input(p_value,10)) loop
  r:=erp_fiscal_invoices.spec_object(v,erp_fiscal_invoices.invoice_specs()->'authorized');
  if not r?'document' or exists(select 1 from jsonb_array_elements(result) x where x->>'document'=r->>'document') then
   raise exception 'erp_fiscal_invoice_authorized_invalid' using errcode='22023'; end if;
  if r?'contact_id' and not exists(select 1 from erp_catalog.record c where c.id=(r->>'contact_id')::uuid and c.entity='contacts') then
   raise exception 'erp_fiscal_invoice_contact_not_found' using errcode='22023'; end if;
  result:=result||jsonb_build_array(r);
 end loop;
 return result;
end $$;
create function erp_fiscal_invoices.import_input(p_value jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare s jsonb:=erp_fiscal_invoices.invoice_specs();base jsonb;v jsonb;additions jsonb:='[]';
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 if jsonb_typeof(p_value)<>'object' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
 base:=erp_fiscal_invoices.spec_object(p_value-'additions',s->'import');
 for v in select value from jsonb_array_elements(erp_fiscal_invoices.array_input(p_value->'additions',100)) loop
  additions:=additions||jsonb_build_array(erp_fiscal_invoices.spec_object(v,s->'addition'));
 end loop;
 return base||jsonb_build_object('additions',additions);
end $$;
create function erp_fiscal_invoices.item_input(p_item jsonb,p_crt text,p_direction text) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare s jsonb:=erp_fiscal_invoices.invoice_specs();top jsonb;g text;groups jsonb:='{}';v jsonb;situation text;
begin
 if p_item is null or jsonb_typeof(p_item)<>'object' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
 top:=erp_fiscal_invoices.spec_object(p_item-array(select jsonb_object_keys(s->'item_groups')),s->'item');
 if not top ?& array['description','quantity','unit_price'] or (top->>'quantity')::numeric<=0 then raise exception 'erp_fiscal_invoice_item_invalid' using errcode='22023'; end if;
 for g in select jsonb_object_keys(s->'item_groups') loop
  v:=erp_fiscal_invoices.spec_object(p_item->g,s->'item_groups'->g);
  if v<>'{}' then groups:=groups||jsonb_build_object(g,v); end if;
 end loop;
 situation:=groups#>>'{icms,situation}';
 if situation is not null and ((p_crt='3' and not situation in('00','02','10','15','20','30','40','41','50','51','53','60','61','70','90'))
  or (p_crt<>'3' and not situation in('101','102','103','201','202','203','300','400','500','900','02','15','53','61'))) then
  raise exception 'erp_fiscal_invoice_item_situation_invalid' using errcode='22023'; end if;
 if not erp_fiscal_invoices.ipi_situation_allowed(p_direction,groups#>>'{ipi,situation}') then raise exception 'erp_fiscal_invoice_item_situation_invalid' using errcode='22023'; end if;
 if top?'product_id' and not exists(select 1 from erp_catalog.record c where c.id=(top->>'product_id')::uuid and c.entity='products') then
  raise exception 'erp_fiscal_invoice_product_not_found' using errcode='22023'; end if;
 if top?'nature_id' and not exists(select 1 from erp_fiscal_invoices.nature n where n.id=(top->>'nature_id')::uuid and n.direction=p_direction) then
  raise exception 'erp_fiscal_invoice_nature_not_found' using errcode='22023'; end if;
 return top||groups;
end $$;
-- Header amounts are spread over the invoiced items by their value, truncated to cents; the last such item takes the remainder.
create function erp_fiscal_invoices.allocate(p_amount numeric,p_weights numeric[]) returns numeric[] language plpgsql immutable set search_path=pg_catalog as $$
declare total numeric:=0;result numeric[]:='{}';i integer;given numeric:=0;last integer:=0;share numeric;
begin
 for i in 1..coalesce(array_length(p_weights,1),0) loop total:=total+p_weights[i]; if p_weights[i]>0 then last:=i; end if; result:=result||0::numeric; end loop;
 if p_amount=0 or array_length(p_weights,1) is null then return result; end if;
 if last=0 then last:=array_length(p_weights,1); end if;
 for i in 1..array_length(p_weights,1) loop
  if i<>last and total>0 then share:=trunc(p_amount*p_weights[i]/total,2);result[i]:=share;given:=given+share; end if;
 end loop;
 result[last]:=p_amount-given;
 return result;
end $$;
create function erp_fiscal_invoices.invoice_input(p_data jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d jsonb;model text;direction text;issue text;n erp_fiscal_invoices.nature%rowtype;items jsonb:='[]';i jsonb;series integer;number integer;v_key text;
 totals jsonb;weights numeric[]:='{}';fr numeric[];ins numeric[];oth numeric[];dsc numeric[];k integer;freight numeric;insurance numeric;other numeric;discount numeric;
 products numeric:=0;line numeric;sums jsonb;total numeric;deson numeric;nature_description text;
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>4194304 or exists(select 1 from jsonb_object_keys(p_data) x where x not in('model','direction','issue_type',
  'series','number','access_key','nature_id','nature_description','cfop','issue_date','exit_date','exit_time','crt','purpose','credit_debit_type','presence','final_consumer',
  'recipient','export','import_declaration','references','items','auto_tax','freight','insurance','other_expenses','discount','transport','payment','authorized_xml',
  'intermediary','additional_info','nature_additional_info','nature_fiscal_info')) then raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 model:=p_data->>'model';direction:=p_data->>'direction';issue:=p_data->>'issue_type';
 if jsonb_typeof(p_data->'model') is distinct from 'string' or model not in('55','65') or jsonb_typeof(p_data->'direction') is distinct from 'string' or direction not in('0','1')
  or jsonb_typeof(p_data->'issue_type') is distinct from 'string' or not((direction='0' and issue in('N','I','T','X')) or (direction='1' and issue in('N','D','E','T','S','C')))
  or (model='65')<>(issue='C') then raise exception 'erp_fiscal_invoice_type_invalid' using errcode='22023'; end if;
 -- XML import (S/X) creates notes only through its own importer, not built yet.
 if issue in('S','X') then raise exception 'erp_fiscal_invoice_issue_type_unavailable' using errcode='22023'; end if;
 if jsonb_typeof(p_data->'series') is distinct from 'string' or p_data->>'series' !~ '^(0|[1-9][0-9]{0,2})$' then raise exception 'erp_fiscal_invoice_series_invalid' using errcode='22023'; end if;
 series:=(p_data->>'series')::integer;
 if issue='T' then
  if jsonb_typeof(p_data->'number') is distinct from 'string' or p_data->>'number' !~ '^[1-9][0-9]{0,8}$' then raise exception 'erp_fiscal_invoice_number_invalid' using errcode='22023'; end if;
  number:=(p_data->>'number')::integer;v_key:=erp_fiscal_invoices.check_value(p_data->'access_key','x:^[0-9]{44}$')#>>'{}';
  if v_key is not null and (not erp_fiscal_invoices.access_key_valid(v_key) or substring(v_key,21,2)<>model or substring(v_key,23,3)::integer<>series or substring(v_key,26,9)::integer<>number) then
   raise exception 'erp_fiscal_invoice_access_key_invalid' using errcode='22023'; end if;
 elsif (p_data->'number' is not null and p_data->'number'<>'null'::jsonb) or (p_data->'access_key' is not null and p_data->'access_key'<>'null'::jsonb) then
  -- Own notes receive number and key only when the homologation series reserves them.
  raise exception 'erp_fiscal_invoice_number_reserved_on_send' using errcode='22023';
 end if;
 nature_description:=erp_fiscal_invoices.text_input(p_data->'nature_description',60);
 if p_data->'nature_id' is not null and p_data->'nature_id'<>'null'::jsonb then
  select * into n from erp_fiscal_invoices.nature where id=erp_fiscal_invoices.uuid_input(p_data->'nature_id');
  if not found or n.direction<>direction then raise exception 'erp_fiscal_invoice_nature_not_found' using errcode='22023'; end if;
  nature_description:=n.description;
 end if;
 if nature_description is null then raise exception 'erp_fiscal_invoice_nature_required' using errcode='22023'; end if;
 if jsonb_typeof(p_data->'crt') is distinct from 'string' or p_data->>'crt' not in('1','2','3','4') or jsonb_typeof(p_data->'purpose') is distinct from 'string'
  or p_data->>'purpose' not in('1','2','3','4','5','6') or jsonb_typeof(p_data->'presence') is distinct from 'string' or p_data->>'presence' not in('0','1','2','3','4','5','9') then
  raise exception 'erp_fiscal_invoice_header_invalid' using errcode='22023'; end if;
 if model='65' and (p_data->>'presence' not in('1','4') or not erp_fiscal_invoices.bool_input(p_data->'final_consumer',true) or direction<>'1' or p_data->>'purpose'<>'1') then
  raise exception 'erp_fiscal_invoice_nfce_invalid' using errcode='22023'; end if;
 if (p_data->>'purpose' not in('5','6') and p_data->'credit_debit_type' is not null and p_data->'credit_debit_type'<>'null'::jsonb) then raise exception 'erp_fiscal_invoice_header_invalid' using errcode='22023'; end if;
 if issue<>'E' and p_data->'export' is not null and p_data->'export'<>'null'::jsonb then raise exception 'erp_fiscal_invoice_export_invalid' using errcode='22023'; end if;
 if issue<>'I' and p_data->'import_declaration' is not null and p_data->'import_declaration'<>'null'::jsonb then raise exception 'erp_fiscal_invoice_import_invalid' using errcode='22023'; end if;
 if jsonb_array_length(erp_fiscal_invoices.array_input(p_data->'items',990))=0 then raise exception 'erp_fiscal_invoice_items_required' using errcode='22023'; end if;
 for i in select value from jsonb_array_elements(p_data->'items') loop items:=items||jsonb_build_array(erp_fiscal_invoices.item_input(i,p_data->>'crt',direction)); end loop;
 freight:=erp_fiscal_invoices.money_input(p_data->'freight');insurance:=erp_fiscal_invoices.money_input(p_data->'insurance');
 other:=erp_fiscal_invoices.money_input(p_data->'other_expenses');discount:=erp_fiscal_invoices.money_input(p_data->'discount');
 for i in select value from jsonb_array_elements(items) loop
  line:=round((i->>'quantity')::numeric*(i->>'unit_price')::numeric,2);
  if line>=10000000000000 then raise exception 'erp_fiscal_invoice_amount_invalid' using errcode='22023'; end if;
  weights:=weights||(case when coalesce((i->>'invoiced')::boolean,true) then line else 0 end);
  if coalesce((i->>'invoiced')::boolean,true) then products:=products+line; end if;
 end loop;
 if discount>products then raise exception 'erp_fiscal_invoice_discount_exceeds' using errcode='22023'; end if;
 fr:=erp_fiscal_invoices.allocate(freight,weights);ins:=erp_fiscal_invoices.allocate(insurance,weights);
 oth:=erp_fiscal_invoices.allocate(other,weights);dsc:=erp_fiscal_invoices.allocate(discount,weights);
 for k in 1..jsonb_array_length(items) loop
  i:=items->(k-1);
  if dsc[k]>weights[k] and weights[k]>0 then raise exception 'erp_fiscal_invoice_discount_exceeds' using errcode='22023'; end if;
  items:=jsonb_set(items,array[(k-1)::text],i||jsonb_build_object('total',erp_fiscal_invoices.money_text(round((i->>'quantity')::numeric*(i->>'unit_price')::numeric,2)),
   'allocated',jsonb_build_object('freight',erp_fiscal_invoices.money_text(fr[k]),'insurance',erp_fiscal_invoices.money_text(ins[k]),
    'other_expenses',erp_fiscal_invoices.money_text(oth[k]),'discount',erp_fiscal_invoices.money_text(dsc[k]))));
 end loop;
 select jsonb_build_object(
  'icms_base',coalesce(sum((x#>>'{icms,base}')::numeric),0),'icms',coalesce(sum((x#>>'{icms,value}')::numeric),0),
  'st_base',coalesce(sum((x#>>'{icms,st_base}')::numeric),0),'st',coalesce(sum((x#>>'{icms,st_value}')::numeric),0),
  'fcp',coalesce(sum((x#>>'{icms,fcp_value}')::numeric),0),'fcp_st',coalesce(sum((x#>>'{icms,st_fcp_value}')::numeric),0),
  'deson',coalesce(sum((x#>>'{icms,deson_value}')::numeric),0),'deson_deducted',coalesce(sum(case when (x#>>'{icms,deson_deduct}')::boolean then (x#>>'{icms,deson_value}')::numeric end),0),
  'credit',coalesce(sum((x#>>'{icms,credit_value}')::numeric),0),'difal_dest',coalesce(sum((x#>>'{icms,difal_dest_value}')::numeric),0),
  'difal_origin',coalesce(sum((x#>>'{icms,difal_origin_value}')::numeric),0),'difal_fcp',coalesce(sum((x#>>'{icms,difal_fcp_value}')::numeric),0),
  'ipi',coalesce(sum((x#>>'{ipi,value}')::numeric),0),'ipi_devol',coalesce(sum((x#>>'{ipi,devol_value}')::numeric),0),'ii',coalesce(sum((x#>>'{ii,value}')::numeric),0),
  'pis',coalesce(sum((x#>>'{pis,value}')::numeric),0),'cofins',coalesce(sum((x#>>'{cofins,value}')::numeric),0),
  'approx_taxes',coalesce(sum((x#>>'{others,approx_taxes}')::numeric),0),'funrural',0,
  'ret_ir',coalesce(sum((x#>>'{retentions,ir_value}')::numeric),0),'ret_csll',coalesce(sum((x#>>'{retentions,csll_value}')::numeric),0),
  'ret_pis',coalesce(sum((x#>>'{retentions,pis_value}')::numeric),0),'ret_cofins',coalesce(sum((x#>>'{retentions,cofins_value}')::numeric),0),
  'ret_base',coalesce(sum((x#>>'{retentions,ir_csll_base}')::numeric),0))
 into sums from jsonb_array_elements(items) x;
 deson:=(sums->>'deson_deducted')::numeric;
 total:=products-discount-deson+(sums->>'st')::numeric+(sums->>'fcp_st')::numeric+freight+insurance+other+(sums->>'ii')::numeric+(sums->>'ipi')::numeric+(sums->>'ipi_devol')::numeric;
 if total<0 or total>=10000000000000 then raise exception 'erp_fiscal_invoice_amount_invalid' using errcode='22023'; end if;
 select jsonb_object_agg(key,erp_fiscal_invoices.money_text(value::text::numeric)) into totals from jsonb_each(sums);
 totals:=totals||jsonb_build_object('products',erp_fiscal_invoices.money_text(products),'freight',erp_fiscal_invoices.money_text(freight),
  'insurance',erp_fiscal_invoices.money_text(insurance),'other_expenses',erp_fiscal_invoices.money_text(other),'discount',erp_fiscal_invoices.money_text(discount),
  'services','0.00','issqn','0.00','total',erp_fiscal_invoices.money_text(total),'invoiced',erp_fiscal_invoices.money_text(total));
 d:=jsonb_build_object('model',model,'direction',direction,'issue_type',issue,'environment',case when issue in('T','S','X') then null else '2' end,
  'status',case when issue in('T','S','X') then 8 else 1 end,'series',series,'number',number,'access_key',v_key,
  'nature_id',case when n.id is null then null else n.id end,'nature_description',nature_description,
  'cfop',erp_fiscal_invoices.check_value(p_data->'cfop','x:^[1-7][0-9]{3}$')#>>'{}',
  'issue_date',erp_fiscal_invoices.check_value(p_data->'issue_date','a')#>>'{}','exit_date',erp_fiscal_invoices.check_value(p_data->'exit_date','a')#>>'{}',
  'exit_time',erp_fiscal_invoices.check_value(p_data->'exit_time','x:^([01][0-9]|2[0-3]):[0-5][0-9]$')#>>'{}',
  'crt',p_data->>'crt','purpose',p_data->>'purpose','credit_debit_type',erp_fiscal_invoices.check_value(p_data->'credit_debit_type','x:^[0-9]{2}$')#>>'{}',
  'presence',p_data->>'presence','final_consumer',erp_fiscal_invoices.bool_input(p_data->'final_consumer',model='65'),
  'recipient',erp_fiscal_invoices.recipient_input(p_data->'recipient',model),
  'export',case when issue='E' then erp_fiscal_invoices.spec_object(p_data->'export',erp_fiscal_invoices.invoice_specs()->'export') end,
  'import_declaration',case when issue='I' then erp_fiscal_invoices.import_input(p_data->'import_declaration') end,
  'references',erp_fiscal_invoices.references_input(p_data->'references'),'items',items,'auto_tax',erp_fiscal_invoices.bool_input(p_data->'auto_tax',true),
  'freight',erp_fiscal_invoices.money_text(freight),'insurance',erp_fiscal_invoices.money_text(insurance),'other_expenses',erp_fiscal_invoices.money_text(other),
  'discount',erp_fiscal_invoices.money_text(discount),'totals',totals,'transport',erp_fiscal_invoices.transport_input(p_data->'transport'),
  'payment',erp_fiscal_invoices.payment_input(p_data->'payment'),'authorized_xml',erp_fiscal_invoices.authorized_input(p_data->'authorized_xml'),
  'intermediary',erp_fiscal_invoices.spec_object(p_data->'intermediary',erp_fiscal_invoices.invoice_specs()->'intermediary'),
  'additional_info',erp_fiscal_invoices.text_input(p_data->'additional_info',5000,false,true),
  'nature_additional_info',erp_fiscal_invoices.text_input(p_data->'nature_additional_info',5000,false,true),
  'nature_fiscal_info',erp_fiscal_invoices.text_input(p_data->'nature_fiscal_info',2000,false,true));
 if d->>'issue_date' is null then raise exception 'erp_fiscal_invoice_issue_date_required' using errcode='22023'; end if;
 if (d->'intermediary'->>'present')::boolean and not (d->'intermediary') ?& array['cnpj','identification'] then raise exception 'erp_fiscal_invoice_intermediary_invalid' using errcode='22023'; end if;
 return d;
end $$;
create function erp_fiscal_invoices.invoice_record(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',v.id,'model',v.model,'direction',v.direction,'issue_type',v.issue_type,'environment',v.environment,'status',v.status,'version',v.version,
  'series',v.series,'number',v.number,'access_key',v.access_key,'protocol',v.protocol,'authorized_at',v.authorized_at,'nature_id',v.nature_id,
  'nature_description',v.nature_description,'cfop',v.cfop,'issue_date',v.issue_date,'exit_date',v.exit_date,'exit_time',v.exit_time,'crt',v.crt,'purpose',v.purpose,
  'credit_debit_type',v.credit_debit_type,'presence',v.presence,'final_consumer',v.final_consumer,'recipient',v.recipient,'export',v.export,
  'import_declaration',v.import_declaration,'references',v.doc_references,
  'items',coalesce((select jsonb_agg(i.data||jsonb_build_object('position',i.position) order by i.position) from erp_fiscal_invoices.invoice_item i where i.invoice_id=v.id),'[]'::jsonb),
  'auto_tax',v.auto_tax,'freight',erp_fiscal_invoices.money_text(v.freight),'insurance',erp_fiscal_invoices.money_text(v.insurance),
  'other_expenses',erp_fiscal_invoices.money_text(v.other_expenses),'discount',erp_fiscal_invoices.money_text(v.discount),'totals',v.totals,'transport',v.transport,
  'payment',v.payment,'authorized_xml',v.authorized_xml,'intermediary',v.intermediary,'additional_info',v.additional_info,
  'nature_additional_info',v.nature_additional_info,'nature_fiscal_info',v.nature_fiscal_info,
  'orders',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'date',d.body->>'date','contact_name',c.name) order by d.number,d.id)
   from erp_fiscal_invoices.invoice_order o join erp_documents.document d on d.id=o.document_id left join erp_catalog.record c on c.id=d.contact_id where o.invoice_id=v.id),'[]'::jsonb),
  'created_at',v.created_at,'updated_at',v.updated_at,'deleted_at',v.deleted_at,'delete_reason',v.delete_reason)
 from erp_fiscal_invoices.invoice v where v.id=p_id
$$;
create function erp_fiscal_invoices.store_items(p_id uuid,p_items jsonb) returns void language plpgsql set search_path=pg_catalog as $$
declare i jsonb;k integer:=0;
begin
 delete from erp_fiscal_invoices.invoice_item where invoice_id=p_id;
 for i in select value from jsonb_array_elements(p_items) loop
  k:=k+1;
  insert into erp_fiscal_invoices.invoice_item(invoice_id,position,product_id,quantity,unit_price,total,freight,insurance,other_expenses,discount,data)
  values(p_id,k,(i->>'product_id')::uuid,(i->>'quantity')::numeric,(i->>'unit_price')::numeric,(i->>'total')::numeric,(i#>>'{allocated,freight}')::numeric,
   (i#>>'{allocated,insurance}')::numeric,(i#>>'{allocated,other_expenses}')::numeric,(i#>>'{allocated,discount}')::numeric,i);
 end loop;
end $$;
create function erp_fiscal_invoices.store_orders(p_id uuid,p_direction text,p_orders jsonb) returns void language plpgsql set search_path=pg_catalog as $$
declare o uuid;
begin
 delete from erp_fiscal_invoices.invoice_order where invoice_id=p_id;
 for o in select distinct erp_fiscal_invoices.uuid_input(x) from jsonb_array_elements(erp_fiscal_invoices.array_input(p_orders,20)) x loop
  if not exists(select 1 from erp_documents.document d where d.id=o and d.kind=case p_direction when '1' then 'sales_orders' else 'purchase_orders' end) then
   raise exception 'erp_fiscal_invoice_order_not_found' using errcode='22023'; end if;
  insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values(p_id,o);
 end loop;
end $$;
create function erp_fiscal_invoices.invoice_envelope(p_record jsonb,p_role text) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('invoice',p_record,'writable',p_role in('admin','fiscal') and p_record->'deleted_at'='null'::jsonb and (p_record->>'status')::integer in(1,5,8,12),
  'emission_enabled',false,'production_enabled',false,'operational_effects',false,'data_mode','erp_native')
$$;

-- Native notes are homologation or registration records: only admin and fiscal see them, like the emitter (coexistence rule).
create function public.erp_fiscal_invoice_get(p_user_id uuid,p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);r jsonb;
begin
 if p_id is null then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 r:=erp_fiscal_invoices.invoice_record(p_id);
 if r is null then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 return erp_fiscal_invoices.invoice_envelope(r,role);
end $$;
create function public.erp_fiscal_invoice_context(p_user_id uuid,p_model text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);company jsonb;series jsonb:='[]';
begin
 if p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 select jsonb_build_object('crt',f.crt,'regime_confirmed',f.crt is not null,'state',i.data->>'state','cnpj_present',nullif(i.data->>'cnpj','') is not null)
 into company from erp_company.identity i left join erp_company.fiscal f using(singleton) where i.singleton;
 if to_regclass('erp_fiscal_numbering.series') is not null then
  execute 'select coalesce(jsonb_agg(jsonb_build_object(''series'',series,''next_number'',next_number,''enabled'',enabled) order by series),''[]''::jsonb)
   from erp_fiscal_numbering.series where model=$1 and environment=''2''' into series using p_model;
 end if;
 return jsonb_build_object('company',coalesce(company,jsonb_build_object('crt',null,'regime_confirmed',false,'state',null,'cnpj_present',false)),'series',series,
  'defaults',coalesce((select jsonb_object_agg(d.code,jsonb_build_object('id',n.id,'description',n.description)) from erp_fiscal_invoices.nature_default d
   join erp_fiscal_invoices.nature n on n.id=d.nature_id where n.active),'{}'::jsonb),
  'writable',true,'emission_enabled',false,'production_enabled',false,'data_mode','erp_native');
end $$;
create function public.erp_fiscal_invoice_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;keys text[];v_id uuid;expected integer;v erp_fiscal_invoices.invoice%rowtype;d jsonb;rec jsonb;result jsonb;reason text;
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
 if p_action='update' then
  if v.status not in(1,5,8,12) then raise exception 'erp_fiscal_invoice_not_editable' using errcode='40001'; end if;
  if d->>'model'<>v.model or d->>'direction'<>v.direction or (d->>'environment') is distinct from v.environment then raise exception 'erp_fiscal_invoice_type_immutable' using errcode='22023'; end if;
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

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_invoice_get(uuid,uuid),public.erp_fiscal_invoice_context(uuid,text),public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_get(uuid,uuid),public.erp_fiscal_invoice_context(uuid,text),public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb) to service_role;
commit;
