-- Notas fiscais e naturezas de operação, segunda leva:
-- 1. grupos Armamento (arma) e Veículo (veicProd) no item da nota, exibidos conforme Preferências › Configurações de NF-e;
-- 2. "Excluir as operações selecionadas": exclusão lógica da natureza (fica no histórico e nas notas que a usaram);
-- 3. Revisão "Confirmo que revisei e configurei as naturezas de operação", registrada com usuário e data.
-- Nada aqui emite, transmite, reserva número ou lança estoque/contas; as travas 022/041/046/064 não mudam.
begin;
-- Same descriptors as packages/erp-domain/src/fiscal-invoice-dto.mjs (compared in test), now with weapon and vehicle.
create or replace function erp_fiscal_invoices.invoice_specs() returns jsonb language sql immutable set search_path=pg_catalog as $spec$
 select '{"recipient":{"contact_id":"u","name":"t:60","person_type":"e:J|F|E","document":"x:^([0-9]{11}|[0-9]{14})$","foreign_id":"x:^[A-Za-z0-9.:/-]{0,20}$","ie":"x:^([0-9]{2,14}|ISENTO)$","ie_indicator":"e:1|2|9","email":"t:60","phone":"x:^[0-9]{6,14}$","postal_code":"x:^[0-9]{8}$","street":"t:60","number":"t:60","complement":"t:60","district":"t:60","city":"t:60","municipality_code":"x:^[0-9]{7}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO|EX","country":"t:60"},"export":{"exit_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","exit_place":"t:60","dispatch_place":"t:60"},"import":{"number":"t:15","registration_date":"a","exporter_code":"t:60","customs_expenses":"d:2:13","clearance_place":"t:60","clearance_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","clearance_date":"a","afrmm_value":"d:2:13","acquirer_cnpj":"x:^[0-9]{14}$","acquirer_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","transport_route":"e:1|2|3|4|5|6|7|8|9|10|11|12|13","intermediation":"e:1|2|3","unit_value_with_ii":"b"},"addition":{"number":"x:^[0-9]{1,3}$","sequence":"x:^[0-9]{1,5}$","manufacturer":"t:60","discount":"d:2:13","drawback":"x:^[0-9]{1,20}$"},"reference":{"type":"e:nfe|ecf|nf01|nf02|nfp01|nfp04|cte","key":"x:^[0-9]{44}$","year_month":"x:^[0-9]{2}(0[1-9]|1[0-2])$","number":"x:^[0-9]{1,9}$","series":"x:^[0-9]{1,3}$"},"transport":{"mode":"e:none|manual","freight_by":"e:0|1|2|3|4|9","tracking_code":"t:60"},"carrier":{"contact_id":"u","name":"t:60","document":"x:^([0-9]{11}|[0-9]{14})$","ie":"x:^([0-9]{2,14}|ISENTO)$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","city":"t:60","address":"t:60"},"vehicle":{"plate":"x:^[A-Z0-9]{7}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","rntc":"t:20"},"volumes":{"quantity":"x:^[0-9]{1,15}$","gross_weight":"d:3:12","net_weight":"d:3:12","numbering":"t:60","brand":"t:60","species":"e:outros|volumes|unidades|caixas|pacotes|envelopes|pallets|sacos"},"delivery":{"name":"t:60","postal_code":"x:^[0-9]{8}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO|EX","city":"t:60","street":"t:60","number":"t:60","district":"t:60","complement":"t:60","country":"t:60"},"installment":{"days":"x:^[0-9]{1,4}$","date":"a","amount":"d:2:13","method":"e:01|02|03|04|05|10|11|12|13|15|16|17|18|19|20|90|99","note":"t:255"},"card":{"integration":"e:1|2","cnpj":"x:^[0-9]{14}$","brand":"x:^[0-9]{2}$","authorization":"t:128","received":"d:2:13","fee":"d:2:13","commission_fee":"d:2:13"},"authorized":{"contact_id":"u","name":"t:60","document":"x:^([0-9]{11}|[0-9]{14})$"},"intermediary":{"present":"b","cnpj":"x:^[0-9]{14}$","identification":"t:60"},"item":{"product_id":"u","description":"t:120","code":"t:60","kind":"e:P|S","unit":"t:6","quantity":"d:4:11","unit_price":"d:10:11","discount_type":"e:C|I","nature_id":"u","cfop":"x:^[1-7][0-9]{3}$","ncm":"x:^([0-9]{8}|00)$","cest":"x:^[0-9]{7}$","gtin":"x:^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$","gtin_tax":"x:^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$","barcode":"t:30","barcode_tax":"t:30","gross_weight":"d:3:12","net_weight":"d:3:12","volumes":"x:^[0-9]{1,6}$","invoiced":"b","info":"m:500","complementary_info":"m:2000","fiscal_info":"m:2000"},"item_groups":{"icms":{"origin":"e:0|1|2|3|4|5|6|7|8","situation":"e:00|02|10|15|20|30|40|41|50|51|53|60|61|70|90|101|102|103|201|202|203|300|400|500|900","taxation":"e:T|I|O","bc_mode":"e:0|1|2|3","pauta_value":"d:4:11","base_rate":"d:4:3","base":"d:2:13","deferral_rate":"d:4:3","presumed_rate":"d:4:3","presumed_value":"d:2:13","rate":"d:4:3","value":"d:2:13","fcp_rate":"d:4:3","fcp_value":"d:2:13","fcp_deferral_rate":"d:4:3","fcp_deferral_value":"d:2:13","fcp_effective_value":"d:2:13","credit_rate":"d:4:3","credit_value":"d:2:13","deson_value":"d:2:13","deson_reason":"e:1|3|4|5|6|7|8|9|10|11|90","deson_deduct":"b","reduction_reason":"e:1|9","benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","presumed_credit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","rbc_benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","mono_qty":"d:4:11","mono_rate":"d:4:3","mono_value":"d:2:13","mono_deferred_value":"d:2:13","mono_icms_value":"d:2:13","st_bc_mode":"e:0|1|2|3|4|5|6","st_pauta_value":"d:4:11","st_mva":"d:4:3","st_base_rate":"d:4:3","st_base":"d:2:13","st_rate":"d:4:3","st_value":"d:2:13","st_fcp_value":"d:2:13","st_deson_value":"d:2:13","st_deson_reason":"e:3|9|90","pis_st_base":"d:2:13","pis_st_rate":"d:4:3","pis_st_value":"d:2:13","cofins_st_base":"d:2:13","cofins_st_rate":"d:4:3","cofins_st_value":"d:2:13","ret_unit_base":"d:4:11","ret_unit_icms":"d:4:11","ret_unit_substitute":"d:4:11","ret_substitute_value":"d:2:13","ret_base_rate":"d:4:3","ret_base":"d:2:13","ret_rate":"d:4:3","ret_value":"d:2:13","difal_type":"e:N|I","difal_base_rate":"d:4:3","difal_base":"d:2:13","difal_fcp_rate":"d:4:3","difal_fcp_value":"d:2:13","difal_internal_rate":"d:4:3","difal_interstate_rate":"e:4.0000|7.0000|12.0000","difal_share_rate":"d:4:3","difal_dest_value":"d:2:13","difal_origin_value":"d:2:13","complementary_info":"m:2000","fiscal_info":"m:2000"},"ipi":{"taxation":"e:T|I|O","situation":"e:00|01|02|03|04|05|49|50|51|52|53|54|55|99","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","class_code":"t:5","seal_code":"t:60","framing_code":"x:^[0-9]{3}$","tipi_exception":"x:^[0-9]{1,3}$","final_consumer":"b","devol_rate":"d:4:3","devol_value":"d:2:13","complementary_info":"m:2000","fiscal_info":"m:2000"},"pis":{"situation":"e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99","taxation":"e:T|I|O","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","complementary_info":"m:2000","fiscal_info":"m:2000"},"cofins":{"situation":"e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99","taxation":"e:T|I|O","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","complementary_info":"m:2000","fiscal_info":"m:2000"},"ii":{"situation":"e:T|N","base":"d:2:13","rate":"d:4:3","value":"d:2:13","taxation":"e:T|I|O","customs_expense":"d:2:13","add_icms":"b","add_other":"b","addition":"x:^[0-9]{1,3}$"},"export":{"drawback":"x:^[0-9]{1,20}$","registry":"x:^[0-9]{1,12}$","key":"x:^[0-9]{44}$"},"fuel":{"anp_code":"x:^[0-9]{9}$","anp_description":"t:95","codif":"x:^[0-9]{1,21}$","consumption_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","ambient_qty":"d:4:11","glp_rate":"d:4:3","glgnn_rate":"d:4:3","glgni_rate":"d:4:3","start_value":"d:2:13","cide_base":"d:4:11","cide_rate":"d:4:11","cide_value":"d:2:13","biodiesel_rate":"d:4:3"},"medicine":{"anvisa_code":"x:^([0-9A-Za-z]{13}|ISENTO)$","max_price":"d:2:13","exemption_reason":"t:255"},"others":{"presumed_pis_cofins":"b","funrural_rate":"d:4:3","sped_type":"e:00|01|02|03|04|05|06|07|08|09|10|99","commission_base":"d:2:13","commission_rate":"d:4:3","commission_value":"d:2:13","fci":"x:^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$","purchase_order":"t:15","purchase_order_item":"x:^[0-9]{1,6}$","ibpt_rate":"d:4:3","approx_taxes":"d:2:13","tax_unit":"t:6","tax_quantity":"d:4:11"},"stock":{"supplier_code":"t:60","scale":"e:S|N","manufacturer_cnpj":"x:^[0-9]{14}$"},"retentions":{"csrf":"b","pis_value":"d:2:13","cofins_value":"d:2:13","csll_rate":"d:4:3","csll_value":"d:2:13","ir":"b","ir_csll_base":"d:2:13","ir_rate":"d:4:3","ir_value":"d:2:13"},"weapon":{"type":"e:0|1","description":"t:256","serial":"t:15","barrel":"t:15"},"vehicle":{"operation":"e:0|1|2|3","chassis":"x:^[A-Z0-9]{17}$","color_code":"t:4","color":"t:40","power":"t:4","displacement":"t:4","net_weight":"t:9","gross_weight":"t:9","serial":"t:9","fuel_type":"x:^[0-9]{2}$","engine_number":"t:21","cmt":"t:9","wheelbase":"t:4","model_year":"x:^[0-9]{4}$","manufacture_year":"x:^[0-9]{4}$","paint_type":"t:1","vehicle_type":"x:^[0-9]{1,2}$","species":"e:1|2|3|4|5|6","vin_condition":"e:R|N","vehicle_condition":"e:1|2|3","brand_model_code":"x:^[0-9]{1,6}$","denatran_color":"x:^[0-9]{2}$","capacity":"x:^[0-9]{1,3}$","restriction":"e:0|1|2|3|4|9"}}}'::jsonb
$spec$;

alter table erp_fiscal_invoices.nature add column deleted_at timestamptz,add column deleted_by uuid references auth.users(id),
 add constraint nature_deleted_consistent check((deleted_at is null)=(deleted_by is null)),add constraint nature_deleted_inactive check(deleted_at is null or not active);
create or replace function erp_fiscal_invoices.guard_nature() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'erp_fiscal_nature_no_delete' using errcode='42501'; end if;
 if new.id<>old.id or new.direction<>old.direction or new.created_at<>old.created_at or new.created_by<>old.created_by
  or old.version=2147483647 or new.version<>old.version+1 then raise exception 'erp_fiscal_nature_immutable_identity' using errcode='40001'; end if;
 -- A deleted nature is history: it never changes again.
 if old.deleted_at is not null then raise exception 'erp_fiscal_nature_deleted' using errcode='40001'; end if;
 return new;
end $$;
create table erp_fiscal_invoices.nature_review(
 singleton boolean primary key default true check(singleton),version integer not null check(version>0),
 confirmed_by uuid not null references auth.users(id),confirmed_at timestamptz not null default clock_timestamp()
);
alter table erp_fiscal_invoices.nature_review enable row level security;
revoke all on erp_fiscal_invoices.nature_review from public,anon,authenticated,service_role;
create function erp_fiscal_invoices.nature_review_record() returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce((select jsonb_build_object('confirmed',true,'version',r.version,'confirmed_at',r.confirmed_at) from erp_fiscal_invoices.nature_review r where r.singleton),
  jsonb_build_object('confirmed',false,'version',0,'confirmed_at',null))
$$;

create or replace function public.erp_fiscal_nature_list(p_user_id uuid,p_active boolean default true,p_query text default null,p_direction text default null,
 p_crt text default null,p_page integer default 1,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text;q text:=nullif(btrim(p_query),'');result jsonb;
begin
 role:=erp_fiscal_invoices.require_read(p_user_id);
 if p_active is null or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query ~ '[[:cntrl:]]'
  or (p_direction is not null and p_direction not in('0','1')) or (p_crt is not null and p_crt not in('1','2','3','4')) then
  raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 with rows as materialized(
  select n.id,n.description from erp_fiscal_invoices.nature n
  where n.deleted_at is null and n.active=p_active and(p_direction is null or n.direction=p_direction) and(p_crt is null or n.crt=p_crt)
   and(q is null or strpos(lower(n.description),lower(q))>0)
 ),page as(select id,description from rows order by lower(description),id offset (p_page-1)*p_limit limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'description',n.description,'series',n.series,'direction',n.direction,
   'crt',n.crt,'presence',n.presence,'invoiced',n.invoiced,'final_consumer',n.final_consumer,'return_operation',n.return_operation,'active',n.active,'version',n.version,
   'defaults',coalesce((select jsonb_agg(d.code order by d.code) from erp_fiscal_invoices.nature_default d where d.nature_id=n.id),'[]'::jsonb),
   'rule_count',(select count(*)::integer from erp_fiscal_invoices.nature_rule r where r.nature_id=n.id)) order by lower(p.description),p.id)
   from page p join erp_fiscal_invoices.nature n on n.id=p.id),'[]'::jsonb),
  'page',p_page,'limit',p_limit,'total_count',(select count(*)::integer from rows),'writable',role in('admin','fiscal'),
  'review',erp_fiscal_invoices.nature_review_record(),'data_mode','erp_native') into result;
 return result;
end $$;
create or replace function public.erp_fiscal_nature_get(p_user_id uuid,p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text;r jsonb;
begin
 role:=erp_fiscal_invoices.require_read(p_user_id);
 if p_id is null then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 if exists(select 1 from erp_fiscal_invoices.nature where id=p_id and deleted_at is not null) then raise exception 'erp_fiscal_nature_not_found' using errcode='P0002'; end if;
 r:=erp_fiscal_invoices.nature_record(p_id);
 if r is null then raise exception 'erp_fiscal_nature_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('nature',r,'writable',role in('admin','fiscal'),'data_mode','erp_native');
end $$;
create or replace function public.erp_fiscal_nature_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;keys text[];v_id uuid;expected integer;n erp_fiscal_invoices.nature%rowtype;input jsonb;rec jsonb;result jsonb;v_code text;bumped boolean:=true;
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_action is null or p_action not in('create','update','clone','set_active','set_default','delete') or p_data is null
  or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>262144 then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 keys:=case p_action when 'create' then array['nature'] when 'update' then array['id','expected_version','nature'] when 'clone' then array['id','expected_version']
  when 'set_active' then array['id','expected_version','active'] when 'delete' then array['id','expected_version'] else array['id','expected_version','code'] end;
 if exists(select 1 from jsonb_object_keys(p_data) k where not k=any(keys)) or exists(select 1 from unnest(keys) k where not p_data?k) then
  raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 if p_action='create' or p_action='update' then input:=erp_fiscal_invoices.nature_input(p_data->'nature'); end if;
 if p_action<>'create' then v_id:=erp_fiscal_invoices.uuid_input(p_data->'id');expected:=erp_fiscal_invoices.version_input(p_data->'expected_version'); end if;
 if p_action='set_active' and jsonb_typeof(p_data->'active') is distinct from 'boolean' then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 if p_action='set_default' then
  v_code:=p_data->>'code';
  if jsonb_typeof(p_data->'code') is distinct from 'string' or v_code not in('S','E','VF','VJ','CF','CJ','C','DE','DS') then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 end if;
 h:=erp_fiscal_invoices.command_hash(p_user_id,'nature',p_action,p_data);
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'nature',h);
 if replay is not null then return replay; end if;
 if p_action<>'create' then
  select * into n from erp_fiscal_invoices.nature where id=v_id for update;
  if not found or n.deleted_at is not null then raise exception 'erp_fiscal_nature_not_found' using errcode='P0002'; end if;
  if n.version<>expected or n.version=2147483647 then raise exception 'erp_fiscal_nature_version_conflict' using errcode='40001'; end if;
 end if;
 if p_action='update' and input->>'direction'<>n.direction then raise exception 'erp_fiscal_nature_direction_immutable' using errcode='22023'; end if;
 if p_action='create' then
  insert into erp_fiscal_invoices.nature(description,series,direction,crt,presence,invoiced,final_consumer,return_operation,update_last_purchase_price,include_freight_ipi_base,
   others,retentions,additional_info,fiscal_info,created_by,updated_by)
  values(input->>'description',(input->>'series')::integer,input->>'direction',input->>'crt',input->>'presence',(input->>'invoiced')::boolean,(input->>'final_consumer')::boolean,
   (input->>'return_operation')::boolean,(input->>'update_last_purchase_price')::boolean,(input->>'include_freight_ipi_base')::boolean,input->'others',input->'retentions',
   input->>'additional_info',input->>'fiscal_info',p_user_id,p_user_id) returning id into v_id;
  perform erp_fiscal_invoices.replace_rules(v_id,input->'rules');
 elsif p_action='update' then
  update erp_fiscal_invoices.nature set description=input->>'description',series=(input->>'series')::integer,crt=input->>'crt',presence=input->>'presence',
   invoiced=(input->>'invoiced')::boolean,final_consumer=(input->>'final_consumer')::boolean,return_operation=(input->>'return_operation')::boolean,
   update_last_purchase_price=(input->>'update_last_purchase_price')::boolean,include_freight_ipi_base=(input->>'include_freight_ipi_base')::boolean,
   others=input->'others',retentions=input->'retentions',additional_info=input->>'additional_info',fiscal_info=input->>'fiscal_info',
   version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  perform erp_fiscal_invoices.replace_rules(v_id,input->'rules');
 elsif p_action='clone' then
  insert into erp_fiscal_invoices.nature(description,series,direction,crt,presence,invoiced,final_consumer,return_operation,update_last_purchase_price,include_freight_ipi_base,
   others,retentions,additional_info,fiscal_info,created_by,updated_by)
  values(left('Cópia de '||n.description,60),n.series,n.direction,n.crt,n.presence,n.invoiced,n.final_consumer,n.return_operation,n.update_last_purchase_price,
   n.include_freight_ipi_base,n.others,n.retentions,n.additional_info,n.fiscal_info,p_user_id,p_user_id) returning id into v_id;
  insert into erp_fiscal_invoices.nature_rule(nature_id,tax,position,destinations,product_scope,ncms,product_ids,data,additional_info,fiscal_info)
  select v_id,tax,position,destinations,product_scope,ncms,product_ids,data,additional_info,fiscal_info from erp_fiscal_invoices.nature_rule where nature_id=n.id;
 elsif p_action='set_active' then
  if n.active=(p_data->>'active')::boolean then raise exception 'erp_fiscal_nature_state_conflict' using errcode='40001'; end if;
  update erp_fiscal_invoices.nature set active=(p_data->>'active')::boolean,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  if not (p_data->>'active')::boolean then delete from erp_fiscal_invoices.nature_default where nature_id=v_id; end if;
 elsif p_action='delete' then
  -- Logical deletion: notes that used the nature keep its description and the revisions keep its rules.
  delete from erp_fiscal_invoices.nature_default where nature_id=v_id;
  update erp_fiscal_invoices.nature set active=false,deleted_at=clock_timestamp(),deleted_by=p_user_id,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 else
  if not n.active then raise exception 'erp_fiscal_nature_inactive' using errcode='40001'; end if;
  if (case when v_code in('S','VF','VJ','C','DS') then '1' else '0' end)<>n.direction then raise exception 'erp_fiscal_nature_default_direction' using errcode='22023'; end if;
  if exists(select 1 from erp_fiscal_invoices.nature_default where code=p_data->>'code' and nature_id=v_id) then raise exception 'erp_fiscal_nature_state_conflict' using errcode='40001'; end if;
  insert into erp_fiscal_invoices.nature_default(code,nature_id) values(v_code,v_id) on conflict(code) do update set nature_id=excluded.nature_id,updated_at=clock_timestamp();
  bumped:=false;
 end if;
 rec:=erp_fiscal_invoices.nature_record(v_id);
 if bumped then insert into erp_fiscal_invoices.nature_revision(nature_id,version,record) values(v_id,(rec->>'version')::integer,rec); end if;
 result:=jsonb_build_object('nature',rec,'action',p_action,'replayed',false,'data_mode','erp_native');
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'nature',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'nature',v_id,(rec->>'version')::integer,p_action,v_code);
 return result;
end $$;
-- "Confirmo que revisei e configurei as naturezas de operação": one company-wide confirmation, CAS on its version, audited.
create function public.erp_fiscal_nature_review_confirm(p_user_id uuid,p_command_id uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;r erp_fiscal_invoices.nature_review%rowtype;result jsonb;v_version integer;
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 h:=erp_fiscal_invoices.command_hash(p_user_id,'nature','confirm_review',jsonb_build_object('expected_version',p_expected_version));
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'nature',h);
 if replay is not null then return replay; end if;
 perform pg_advisory_xact_lock(174852941,2);
 select * into r from erp_fiscal_invoices.nature_review where singleton for update;
 if coalesce(r.version,0)<>p_expected_version then raise exception 'erp_fiscal_nature_review_version_conflict' using errcode='40001'; end if;
 insert into erp_fiscal_invoices.nature_review(singleton,version,confirmed_by,confirmed_at) values(true,1,p_user_id,clock_timestamp())
 on conflict(singleton) do update set version=nature_review.version+1,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at returning nature_review.version into v_version;
 result:=jsonb_build_object('review',erp_fiscal_invoices.nature_review_record(),'action','confirm_review','replayed',false,'data_mode','erp_native');
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'nature',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action) values(p_user_id,p_command_id,'nature',null,v_version,'confirm_review');
 return result;
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_nature_list(uuid,boolean,text,text,text,integer,integer),public.erp_fiscal_nature_get(uuid,uuid),
 public.erp_fiscal_nature_execute(uuid,uuid,text,jsonb),public.erp_fiscal_nature_review_confirm(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.erp_fiscal_nature_list(uuid,boolean,text,text,text,integer,integer),public.erp_fiscal_nature_get(uuid,uuid),
 public.erp_fiscal_nature_execute(uuid,uuid,text,jsonb),public.erp_fiscal_nature_review_confirm(uuid,uuid,integer) to service_role;
commit;
