-- Reviewed proposal import v2. Original 052 policy and evidence are not rewritten.
-- Requires 054. No automatic catalogue mapping, approvals or operational effects.
begin;
create function erp_documents.origin_import_flags_v2() returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select erp_documents.origin_import_flags()||'{"policy":"origin-open-proposal-v2"}'::jsonb
$$;
create function erp_documents.origin_source_reference_v2(v jsonb,p_kind text) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare sid text; label jsonb;
begin
 if erp_documents.origin_import_empty_reference(v,p_kind) then return 'null'::jsonb;end if;
 if jsonb_typeof(v)<>'object' or exists(select 1 from jsonb_object_keys(v) k where not(k='id'
  or(p_kind='store' and k='unidadeNegocio') or(p_kind='carrier' and k='nome')
  or(p_kind='volume' and k in('servico','codigoRastreamento')))) then
  raise exception 'erp_origin_reference_invalid' using errcode='22023';end if;
 sid:=erp_documents.origin_import_id(v->'id');
 if sid is null then raise exception 'erp_origin_reference_invalid' using errcode='22023';end if;
 label:=case p_kind when 'carrier' then v->'nome' when 'volume' then v->'servico' else 'null'::jsonb end;
 return erp_documents.commercial_reference(jsonb_build_object('system','origin','source_id',sid,'label',label));
end $$;
create function erp_documents.origin_source_transport_v2(v jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare mode text; volume text; weight text; days text; service jsonb; carrier jsonb; track text;
begin
 if jsonb_typeof(v)<>'object' or exists(select 1 from jsonb_object_keys(v) k where k not in('frete','freteModalidade','quantidadeVolumes','prazoEntrega','pesoBruto','contato','volumes')) then
  raise exception 'erp_origin_transport_invalid' using errcode='22023';end if;
 if v?'freteModalidade' and v->'freteModalidade'<>'null'::jsonb then
  if jsonb_typeof(v->'freteModalidade')<>'number' or v->>'freteModalidade' not in('0','1','2','3','4','9') then raise exception 'erp_origin_transport_invalid' using errcode='22023';end if;
  mode:=v->>'freteModalidade';
 end if;
 if v?'quantidadeVolumes' and v->'quantidadeVolumes'<>'null'::jsonb then
  volume:=erp_documents.origin_import_number(v->'quantidadeVolumes',6,12);if volume is null then raise exception 'erp_origin_transport_invalid' using errcode='22023';end if;
 end if;
 if v?'pesoBruto' and v->'pesoBruto'<>'null'::jsonb then
  weight:=erp_documents.origin_import_number(v->'pesoBruto',6,12);if weight is null then raise exception 'erp_origin_transport_invalid' using errcode='22023';end if;
 end if;
 if v?'prazoEntrega' and v->'prazoEntrega'<>'null'::jsonb then
  days:=erp_documents.origin_import_number(v->'prazoEntrega',0,6);if days is null then raise exception 'erp_origin_transport_invalid' using errcode='22023';end if;
 end if;
 carrier:=erp_documents.origin_source_reference_v2(v->'contato','carrier');service:=erp_documents.origin_source_reference_v2(v->'volumes','volume');
 track:=erp_documents.text_value(v#>'{volumes,codigoRastreamento}',200);
 return jsonb_build_object('freight_mode',mode,'volume_count',volume,'gross_weight',weight,'delivery_days',days,
  'carrier_reference',carrier,'service_reference',service,'tracking_code',track);
end $$;
create function erp_documents.origin_proposal_plan_v2(p_actor uuid,p_source_id text) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare s origin_sync.raw_record%rowtype; existing erp_documents.origin_import_origin%rowtype;
 p jsonb; issues jsonb:='[]'; bindings jsonb:='[]'; contact_link jsonb; b jsonb; body jsonb; normalized jsonb;
 rows jsonb:='[]'; installments jsonb:='[]'; row jsonb; parcel jsonb; part jsonb; field text; pos integer:=0;
 sid text; qty text; price text; discount text; total text; products_total text; freight text; other text;
 result jsonb; commercial jsonb; transport jsonb; original_discounts jsonb:='[]'; global_discount text; next_contact jsonb;
 transformations jsonb:='[]'; payment_ref jsonb;
begin
 if p_source_id is null or p_source_id!~'^[1-9][0-9]{0,39}$' then
  raise exception 'erp_origin_proposal_source_invalid' using errcode='22023';end if;
 select * into s from origin_sync.raw_record where entity='sales_proposals' and source_id=p_source_id;
 if not found then raise exception 'erp_origin_proposal_not_found' using errcode='P0002';end if;
 p:=s.payload;
 select * into existing from erp_documents.origin_import_origin where entity='sales_proposals' and source_id=p_source_id;
 if existing.document_id is not null then issues:=issues||erp_documents.origin_import_issue('ALREADY_IMPORTED');end if;
 if octet_length(p::text)>524288 then
  issues:=issues||erp_documents.origin_import_issue('SOURCE_TOO_LARGE');p:='{}';
 end if;
 if erp_documents.origin_import_id(p->'id') is distinct from p_source_id then issues:=issues||erp_documents.origin_import_issue('SOURCE_ID_MISMATCH','id');end if;
 if jsonb_typeof(p->'situacao') is distinct from 'string' or p->>'situacao' not in('Rascunho','Pendente','Aguardando') then
  issues:=issues||erp_documents.origin_import_issue('STATUS_OUTSIDE_PROFILE','situacao');end if;
 if exists(select 1 from jsonb_object_keys(p) k where k not in('id','data','situacao','total','totalProdutos','numero','contato','loja','desconto','outrasDespesas','garantia','dataProximoContato','observacoes','observacaoInterna','totalOutrosItens','aosCuidadosDe','introducao','prazoEntrega','itens','parcelas','vendedor','transporte')) then
  issues:=issues||erp_documents.origin_import_issue('SOURCE_FIELDS_UNSUPPORTED');end if;
 if erp_documents.origin_import_id(p->'numero') is null then issues:=issues||erp_documents.origin_import_issue('SOURCE_NUMBER_INVALID','numero');end if;
 foreach field in array array['data','dataProximoContato'] loop
  begin
   if field='dataProximoContato' and p->field='"0000-00-00"'::jsonb then null;
   else
    -- Evidence dates have an exact grammar; trimming must not invent a date/absence.
    if field='dataProximoContato' and p?field and p->field not in('null'::jsonb,'""'::jsonb)
     and (jsonb_typeof(p->field)<>'string' or p->>field!~'^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$') then
     raise exception 'erp_origin_proposal_source_date_invalid' using errcode='22023';end if;
    perform erp_documents.date_value(p->field,field='data');
   end if;
  exception when sqlstate '22023' then issues:=issues||erp_documents.origin_import_issue('SOURCE_DATE_INVALID',field);end;
 end loop;
 foreach field in array array['observacoes','observacaoInterna','prazoEntrega'] loop
  begin perform erp_documents.text_value(p->field,case when field='prazoEntrega' then 2000 else 4000 end,false,true);
  exception when sqlstate '22023' then issues:=issues||erp_documents.origin_import_issue('SOURCE_TEXT_INVALID',field);end;
 end loop;
 -- These fields have no faithful native destination in this initial profile.
 foreach field in array array['garantia','totalOutrosItens'] loop
  if p?field and p->field<>'null'::jsonb and erp_documents.origin_import_number(p->field,0,9) is distinct from '0' then
   issues:=issues||erp_documents.origin_import_issue('COMMERCIAL_FIELD_UNSUPPORTED',field);end if;
 end loop;
 commercial:=jsonb_build_object('introduction',p->'introducao','attention_to',p->'aosCuidadosDe',
  'seller_reference',null,'store_reference',null,'business_unit_reference',null,'transport',null);
 begin
  commercial:=commercial||jsonb_build_object('seller_reference',erp_documents.origin_source_reference_v2(p->'vendedor','id'),
   'store_reference',erp_documents.origin_source_reference_v2(p->'loja','store'),
   'business_unit_reference',erp_documents.origin_source_reference_v2(p#>'{loja,unidadeNegocio}','id'));
 exception when sqlstate '22023' then issues:=issues||erp_documents.origin_import_issue('COMMERCIAL_REFERENCE_UNSUPPORTED');end;
 global_discount:=erp_documents.origin_import_number(p->'desconto',2,12);
 if global_discount is null then issues:=issues||erp_documents.origin_import_issue('DISCOUNT_UNSUPPORTED','desconto');end if;
 total:=erp_documents.origin_import_number(p->'total',2,12);
 products_total:=erp_documents.origin_import_number(p->'totalProdutos',2,12);
 freight:=erp_documents.origin_import_number(p#>'{transporte,frete}',2,12);
 other:=erp_documents.origin_import_number(p->'outrasDespesas',2,12);
 if total is null or products_total is null or freight is null or other is null then issues:=issues||erp_documents.origin_import_issue('AMOUNTS_MISSING_OR_INVALID');end if;
 if jsonb_typeof(p->'transporte') is distinct from 'object' then issues:=issues||erp_documents.origin_import_issue('TRANSPORT_INVALID','transporte');
 else
  if p#>'{transporte,freteModalidade}'='9'::jsonb and freight::numeric>0 then
   issues:=issues||erp_documents.origin_import_issue('TRANSPORT_CONFLICT','transporte');end if;
  begin
   transport:=erp_documents.origin_source_transport_v2(p->'transporte');
   commercial:=commercial||jsonb_build_object('transport',transport);
  exception when sqlstate '22023' then issues:=issues||erp_documents.origin_import_issue('TRANSPORT_FIELD_UNSUPPORTED','transporte');end;
 end if;
 sid:=erp_documents.origin_import_id(p#>'{contato,id}');
 contact_link:=erp_documents.origin_import_binding('contacts',sid);bindings:=bindings||jsonb_build_array(contact_link);
 if sid is null then issues:=issues||erp_documents.origin_import_issue('CONTACT_REFERENCE_INVALID','contato.id');
 elsif not(contact_link->>'valid')::boolean then issues:=issues||erp_documents.origin_import_issue('CONTACT_MAPPING_UNAVAILABLE','contato.id');end if;
 if jsonb_typeof(p->'itens') is distinct from 'array' then issues:=issues||erp_documents.origin_import_issue('ITEMS_INVALID','itens');
 elsif jsonb_array_length(p->'itens') not between 1 and 250 then issues:=issues||erp_documents.origin_import_issue('ITEMS_INVALID','itens');
 else
  for row in select value from jsonb_array_elements(p->'itens') loop
   pos:=pos+1;
   if jsonb_typeof(row)<>'object' then issues:=issues||erp_documents.origin_import_issue('ITEM_INVALID','itens',pos);continue;end if;
   if exists(select 1 from jsonb_object_keys(row) k where k not in('produto','codigo','unidade','quantidade','desconto','valor','descricaoDetalhada')) then
    issues:=issues||erp_documents.origin_import_issue('ITEM_FIELDS_UNSUPPORTED','itens',pos);end if;
   sid:=erp_documents.origin_import_id(row#>'{produto,id}');b:=erp_documents.origin_import_binding('products',sid);
   bindings:=bindings||jsonb_build_array(b||jsonb_build_object('position',pos));
   if sid is null then issues:=issues||erp_documents.origin_import_issue('PRODUCT_REFERENCE_INVALID','produto.id',pos);
   elsif not(b->>'valid')::boolean then issues:=issues||erp_documents.origin_import_issue('PRODUCT_MAPPING_UNAVAILABLE','produto.id',pos);end if;
   if (b->>'valid')::boolean and row->'unidade' is distinct from b->'unit' then
    issues:=issues||erp_documents.origin_import_issue('PRODUCT_UNIT_MISMATCH','unidade',pos);end if;
   foreach field in array array['descricao','codigo','unidade'] loop
    begin
     perform erp_documents.text_value(case when field='descricao' then row#>'{produto,descricao}' else row->field end,
      case field when 'descricao' then 200 when 'codigo' then 100 else 16 end,field<>'codigo');
    exception when sqlstate '22023' then issues:=issues||erp_documents.origin_import_issue('ITEM_TEXT_INVALID',field,pos);end;
   end loop;
   qty:=erp_documents.origin_import_number(row->'quantidade',6,9);price:=erp_documents.origin_import_number(row->'valor',4,10);
   discount:=erp_documents.origin_import_number(row->'desconto',6,12);
   if qty is null or qty::numeric=0 or price is null then issues:=issues||erp_documents.origin_import_issue('ITEM_DECIMAL_INVALID','quantidade/valor',pos);end if;
   if discount is null then issues:=issues||erp_documents.origin_import_issue('DISCOUNT_UNSUPPORTED','itens.desconto',pos);end if;
   original_discounts:=original_discounts||jsonb_build_array(jsonb_build_object('position',pos,'quantity',qty,'unit_price',price,
    'discount_observed',discount,'discount_unit','unspecified'));
   begin perform erp_documents.text_value(row->'descricaoDetalhada',4000,false,true);
   exception when sqlstate '22023' then issues:=issues||erp_documents.origin_import_issue('ITEM_DETAIL_UNSUPPORTED','descricaoDetalhada',pos);end;
   rows:=rows||jsonb_build_array(jsonb_build_object('product_id',b->'record_id','description',row#>'{produto,descricao}',
    'code',row->'codigo','unit',row->'unidade','quantity',qty,'unit_price',price,'discount_percent','0',
    'detailed_description',row->'descricaoDetalhada'));
  end loop;
 end if;
 if jsonb_typeof(p->'parcelas') is distinct from 'array' then issues:=issues||erp_documents.origin_import_issue('INSTALLMENTS_INVALID','parcelas');
 elsif jsonb_array_length(p->'parcelas')>120 then issues:=issues||erp_documents.origin_import_issue('INSTALLMENTS_INVALID','parcelas');
 else
  pos:=0;
  for parcel in select value from jsonb_array_elements(p->'parcelas') loop
   pos:=pos+1;
   if jsonb_typeof(parcel)<>'object' then issues:=issues||erp_documents.origin_import_issue('INSTALLMENT_INVALID','parcelas',pos);continue;end if;
   if exists(select 1 from jsonb_object_keys(parcel) k where k not in('numeroDias','dataVencimento','valor','observacoes','formaPagamento')) then
    issues:=issues||erp_documents.origin_import_issue('INSTALLMENT_FIELD_UNSUPPORTED','parcelas',pos);end if;
   payment_ref:=null;
   begin
    payment_ref:=erp_documents.origin_source_reference_v2(parcel->'formaPagamento','id');
    perform erp_documents.text_value(parcel->'observacoes',2000,false,true);
   exception when sqlstate '22023' then issues:=issues||erp_documents.origin_import_issue('INSTALLMENT_FIELD_UNSUPPORTED','parcelas',pos);end;
   price:=erp_documents.origin_import_number(parcel->'valor',2,12);
   if price is null or price::numeric=0 then issues:=issues||erp_documents.origin_import_issue('INSTALLMENT_AMOUNT_INVALID','valor',pos);end if;
   begin perform erp_documents.date_value(parcel->'dataVencimento',true);
   exception when sqlstate '22023' then issues:=issues||erp_documents.origin_import_issue('INSTALLMENT_DATE_INVALID','dataVencimento',pos);end;
   -- numeroDias is redundant only when it agrees with the explicit dates.
   if parcel?'numeroDias' and parcel->'numeroDias'<>'null'::jsonb then
    begin
     if erp_documents.origin_import_number(parcel->'numeroDias',0,6) is null
       or (erp_documents.date_value(parcel->'dataVencimento',true)-erp_documents.date_value(p->'data',true))::numeric
        <>(parcel->>'numeroDias')::numeric then
      issues:=issues||erp_documents.origin_import_issue('INSTALLMENT_DAYS_CONFLICT','numeroDias',pos);end if;
    exception when sqlstate '22023' or invalid_text_representation then
     issues:=issues||erp_documents.origin_import_issue('INSTALLMENT_DAYS_CONFLICT','numeroDias',pos);
    end;
   end if;
   installments:=installments||jsonb_build_array(jsonb_build_object('due_date',parcel->'dataVencimento','amount',price,'method',null,
    'note',parcel->'observacoes','payment_reference',payment_ref));
  end loop;
 end if;
 next_contact:=case when p->'dataProximoContato'='"0000-00-00"'::jsonb then 'null'::jsonb else p->'dataProximoContato' end;
 body:=jsonb_build_object('date',p->'data','contact_id',contact_link->'record_id','items',rows,'discount_mode','amount','discount_value',global_discount,
  'freight',freight,'other_expenses',other,'installments',installments,'notes',p->'observacoes','internal_notes',p->'observacaoInterna',
  'delivery_terms',p->'prazoEntrega','next_contact',next_contact,'commercial',commercial);
 if issues='[]'::jsonb and jsonb_array_length(installments)>0 and
   (select sum((v->>'amount')::numeric) from jsonb_array_elements(installments) v)<>total::numeric then
  issues:=issues||erp_documents.origin_import_issue('INSTALLMENT_TOTAL_MISMATCH','parcelas');end if;
 if octet_length(body::text)>262144 then issues:=issues||erp_documents.origin_import_issue('NATIVE_CONTENT_TOO_LARGE');end if;
 if issues='[]'::jsonb then
  begin
   normalized:=erp_documents.normalize('sales_proposals',body);
   if (normalized#>>'{totals,gross}')::numeric<>products_total::numeric or(normalized#>>'{totals,total}')::numeric<>total::numeric then
    issues:=issues||erp_documents.origin_import_issue('SOURCE_TOTAL_MISMATCH');normalized:=null;end if;
  exception when sqlstate '22023' or numeric_value_out_of_range or not_null_violation then
   issues:=issues||erp_documents.origin_import_issue('NATIVE_FIELDS_INVALID');normalized:=null;
  end;
 end if;
 if issues='[]'::jsonb then
  transformations:=jsonb_build_array('UNIT_PRICES_ARE_SOURCE_NET','SOURCE_LINE_DISCOUNTS_NOT_REAPPLIED','GLOBAL_DISCOUNT_RECONCILED_AS_AMOUNT','EXTERNAL_REFERENCES_ARE_UNLINKED');
  if p->'dataProximoContato'='"0000-00-00"'::jsonb then transformations:=transformations||'"ZERO_NEXT_CONTACT_PRESERVED_AS_UNSPECIFIED"'::jsonb;end if;
 end if;
 result:=erp_documents.origin_import_flags_v2()||jsonb_build_object('source_id',p_source_id,'source_hash',s.version_hash,'source_version',s.version::text,
  'source_seen_at',s.last_seen_at,'source_changed_at',s.changed_at,'source_status',case when jsonb_typeof(p->'situacao')='string' and length(p->>'situacao')<=80 then p->>'situacao' end,
  'source_number',erp_documents.origin_import_id(p->'numero'),'can_apply',issues='[]'::jsonb,'issues',issues,'bindings',bindings,
  'warnings',jsonb_build_array('SOURCE_FRESHNESS_NOT_CERTIFIED','MANUAL_DUPLICATES_NOT_DETECTABLE','NATIVE_NUMBER_ASSIGNED_ON_APPLY'),
  'proposed',normalized,'transformations',transformations,'source_evidence',case when issues='[]'::jsonb then jsonb_build_object(
   'schema_version',1,'price_basis','source_net','discount_semantics','original_line_unit_unspecified',
   'products_total',products_total,'global_discount_observed',global_discount,'freight',freight,'other_expenses',other,'total',total,'items',original_discounts,
   'next_contact',jsonb_build_object('state',case when not(p?'dataProximoContato') then 'missing' when p->'dataProximoContato'='null'::jsonb then 'null' when p->>'dataProximoContato'='' then 'empty' when p->>'dataProximoContato'='0000-00-00' then 'zero_date' else 'date' end,'value',p->'dataProximoContato')) end,'existing',case when existing.document_id is not null then jsonb_build_object('document_id',existing.document_id,'command_id',existing.command_id,'imported_at',existing.created_at) end);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'plan',result)::text,'UTF8')),'hex'));
end $$;

create function public.erp_origin_proposal_import_preview_v2(p_user_id uuid,p_source_id text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
begin
 perform erp_cutover.require_admin(p_user_id);
 return erp_documents.origin_proposal_plan_v2(p_user_id,p_source_id)||'{"dry_run":true,"persisted":false}'::jsonb;
end $$;

create function public.erp_origin_proposal_import_apply_v2(p_user_id uuid,p_source_id text,p_preview_hash text,
 p_command_id uuid,p_confirm_import boolean,p_duplicate_reviewed boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare request_hash text; replay jsonb; initial jsonb; plan jsonb; data jsonb; id uuid; receipt jsonb; result jsonb;
 parent_ids uuid[]; source_refs jsonb; snapshot jsonb;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_source_id is null or p_source_id!~'^[1-9][0-9]{0,39}$' or p_preview_hash is null or p_preview_hash!~'^[0-9a-f]{64}$'
  or p_confirm_import is distinct from true or p_duplicate_reviewed is distinct from true then
  raise exception 'erp_origin_proposal_request_invalid' using errcode='22023';end if;
 request_hash:=encode(sha256(convert_to(jsonb_build_object('op','origin_import_proposal_v2','actor',p_user_id,'source_id',p_source_id,
  'preview_hash',p_preview_hash,'confirm_import',p_confirm_import,'duplicate_reviewed',p_duplicate_reviewed)::text,'UTF8')),'hex');
 replay:=erp_documents.command_replay(p_user_id,p_command_id,request_hash);
 if replay is not null then perform erp_cutover.require_admin(p_user_id);return replay;end if;
 perform pg_advisory_xact_lock(174852952,hashtext(p_source_id));
 initial:=erp_documents.origin_proposal_plan_v2(p_user_id,p_source_id);
 if initial->>'preview_hash'<>p_preview_hash or not(initial->>'can_apply')::boolean then
  raise exception 'erp_origin_proposal_preview_conflict' using errcode='40001';end if;
 select array_agg(distinct (v->>'record_id')::uuid order by (v->>'record_id')::uuid) into parent_ids
  from jsonb_array_elements(initial->'bindings') v;
 -- The catalog writer also takes parent rows before source rows (011).
 perform r.id from erp_catalog.record r where r.id=any(parent_ids) order by r.id for share;
 perform c.record_id from erp_catalog.contact c where c.record_id=any(parent_ids) order by c.record_id for share;
 perform p.record_id from erp_catalog.product p where p.record_id=any(parent_ids) order by p.record_id for share;
 select jsonb_agg(ref order by ref->>'entity' collate "C",ref->>'source_id' collate "C") into source_refs from(
  select distinct jsonb_build_object('entity',v->>'entity','source_id',v->>'source_id') ref from jsonb_array_elements(initial->'bindings') v
  union select jsonb_build_object('entity','sales_proposals','source_id',p_source_id)) x;
 perform r.source_id from origin_sync.raw_record r where exists(select 1 from jsonb_array_elements(source_refs) v where r.entity=v->>'entity' and r.source_id=v->>'source_id')
  order by r.entity collate "C",r.source_id collate "C" for share;
 -- No late acquisition of a changed parent. A new snapshot after waits must match.
 plan:=erp_documents.origin_proposal_plan_v2(p_user_id,p_source_id);
 if plan->>'preview_hash'<>p_preview_hash or not(plan->>'can_apply')::boolean then
  raise exception 'erp_origin_proposal_preview_conflict' using errcode='40001';end if;
 perform m.user_id from erp_access.membership m where m.user_id=p_user_id for share;
 perform erp_cutover.require_admin(p_user_id);
 data:=plan->'proposed';
 snapshot:=erp_catalog.dto((data->>'contact_id')::uuid);
 insert into erp_documents.document(kind,number,status,contact_id,contact_snapshot,body,total,created_by,updated_by)
 values('sales_proposals',erp_documents.next_number('sales_proposals'),'draft',(data->>'contact_id')::uuid,snapshot,data-'items',
  (data#>>'{totals,total}')::numeric,p_user_id,p_user_id) returning document.id into id;
 perform erp_documents.replace_items(id,data->'items');
 receipt:=jsonb_build_object('command_id',p_command_id,'entity','sales_proposals','source_id',p_source_id,
  'source_hash',plan->'source_hash','source_version',plan->'source_version','source_seen_at',plan->'source_seen_at',
  'source_number',plan->'source_number','source_status',plan->'source_status','preview_hash',p_preview_hash,'duplicate_reviewed',true,'policy','origin-open-proposal-v2',
  'document',erp_documents.summary(id),'imported_at',clock_timestamp());
 result:=erp_documents.origin_import_flags_v2()||jsonb_build_object('dry_run',false,'persisted',true,'replayed',false,'receipt',receipt);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,request_hash,result);
 insert into erp_documents.origin_import_origin(entity,source_id,document_id,command_id,evidence)
 values('sales_proposals',p_source_id,id,p_command_id,jsonb_build_object('policy','origin-open-proposal-v2','receipt',receipt,'bindings',plan->'bindings','normalized_body',data,
  'source_evidence',plan->'source_evidence','transformations',plan->'transformations',
  'item_links',(select jsonb_agg(jsonb_build_object('source_position',position,'native_item_id',i.id) order by position) from erp_documents.item i where i.document_id=(receipt#>>'{document,id}')::uuid)));
 insert into erp_documents.audit(actor,command_id,document_id,action,after_data)
 values(p_user_id,p_command_id,id,'origin_import_proposal_v2',erp_documents.dto(id));
 return result;
end $$;

create function public.erp_origin_proposal_import_command_v2(p_user_id uuid,p_command_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_documents.command%rowtype; id uuid;
begin
 perform erp_cutover.require_admin(p_user_id);
 select * into c from erp_documents.command where command_id=p_command_id and result->>'policy'='origin-open-proposal-v2';
 if not found then raise exception 'erp_origin_proposal_not_found' using errcode='P0002';end if;
 id:=(c.result#>>'{receipt,document,id}')::uuid;
 return erp_documents.origin_import_flags_v2()||jsonb_build_object('read_only',true,'receipt',c.result->'receipt','current_document',erp_documents.dto(id),
  'historical_evidence',(select jsonb_build_object('source_evidence',o.evidence->'source_evidence','normalized_body',o.evidence->'normalized_body',
   'transformations',o.evidence->'transformations','item_links',o.evidence->'item_links') from erp_documents.origin_import_origin o where o.document_id=(c.result#>>'{receipt,document,id}')::uuid));
end $$;

create function public.erp_origin_proposal_import_origin_v2(p_user_id uuid,p_source_id text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare o erp_documents.origin_import_origin%rowtype;
begin
 perform erp_cutover.require_admin(p_user_id);
 select * into o from erp_documents.origin_import_origin where entity='sales_proposals' and source_id=p_source_id and evidence->>'policy'='origin-open-proposal-v2';
 if not found then raise exception 'erp_origin_proposal_not_found' using errcode='P0002';end if;
 return erp_documents.origin_import_flags_v2()||jsonb_build_object('read_only',true,'receipt',o.evidence->'receipt','current_document',erp_documents.dto(o.document_id),'historical_evidence',
  jsonb_build_object('source_evidence',o.evidence->'source_evidence','normalized_body',o.evidence->'normalized_body','transformations',o.evidence->'transformations','item_links',o.evidence->'item_links'));
end $$;

create or replace function public.erp_origin_proposal_import_origin(p_user_id uuid,p_source_id text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare o erp_documents.origin_import_origin%rowtype;
begin
 perform erp_cutover.require_admin(p_user_id);
 select * into o from erp_documents.origin_import_origin where entity='sales_proposals' and source_id=p_source_id and coalesce(evidence->>'policy','origin-open-proposal-v1')='origin-open-proposal-v1';
 if not found then raise exception 'erp_origin_proposal_not_found' using errcode='P0002';end if;
 return erp_documents.origin_import_flags()||jsonb_build_object('read_only',true,'receipt',o.evidence->'receipt','current_document',erp_documents.dto(o.document_id));
end $$;
create or replace function public.erp_origin_proposal_document_origin(p_user_id uuid,p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare kind text; o erp_documents.origin_import_origin%rowtype;
begin
 select d.kind into kind from erp_documents.document d where d.id=p_document_id;
 if not found then raise exception 'erp_origin_proposal_not_found' using errcode='P0002';end if;
 perform erp_documents.require_access(p_user_id,kind,false);
 select * into o from erp_documents.origin_import_origin where document_id=p_document_id;
 return jsonb_build_object('data_mode','erp_native','read_only',true,'document_id',p_document_id,'kind',kind,
  'origin',case when o.document_id is not null then jsonb_build_object('system','origin','policy',coalesce(o.evidence->>'policy','origin-open-proposal-v1'),'entity',o.entity,'source_id',o.source_id,
   'source_number',o.evidence#>'{receipt,source_number}','source_hash',o.evidence#>'{receipt,source_hash}',
   'source_version',o.evidence#>'{receipt,source_version}','command_id',o.command_id,'imported_at',o.created_at) end);
end $$;

create function public.erp_origin_proposal_import_sources_v2(p_user_id uuid,p_limit integer default 25,p_after text default null,p_query text default null)
returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select public.erp_origin_proposal_import_sources(p_user_id,p_limit,p_after,p_query)||erp_documents.origin_import_flags_v2()
$$;
create or replace function erp_documents.origin_import_command_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if old.result->>'policy' in('origin-open-proposal-v1','origin-open-proposal-v2') then
  raise exception 'erp_origin_proposal_evidence_immutable' using errcode='42501';end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
revoke all on function erp_documents.origin_import_flags_v2(),erp_documents.origin_source_reference_v2(jsonb,text),
 erp_documents.origin_source_transport_v2(jsonb),erp_documents.origin_proposal_plan_v2(uuid,text)
 from public,anon,authenticated,service_role;
revoke all on function public.erp_origin_proposal_import_sources_v2(uuid,integer,text,text),public.erp_origin_proposal_import_preview_v2(uuid,text),
 public.erp_origin_proposal_import_apply_v2(uuid,text,text,uuid,boolean,boolean),public.erp_origin_proposal_import_command_v2(uuid,uuid),public.erp_origin_proposal_import_origin_v2(uuid,text)
 from public,anon,authenticated;
grant execute on function public.erp_origin_proposal_import_sources_v2(uuid,integer,text,text),public.erp_origin_proposal_import_preview_v2(uuid,text),
 public.erp_origin_proposal_import_apply_v2(uuid,text,text,uuid,boolean,boolean),public.erp_origin_proposal_import_command_v2(uuid,uuid),public.erp_origin_proposal_import_origin_v2(uuid,text)
 to service_role;
commit;
