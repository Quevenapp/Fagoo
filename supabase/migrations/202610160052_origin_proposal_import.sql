-- One reviewed Origin proposal -> one new native draft. No source writes or effects.
-- Depends on 008 (documents), 011 (catalog lock order) and 020 (admin review).
begin;

create table erp_documents.origin_import_origin (
 entity text not null check(entity='sales_proposals'),
 source_id text not null check(source_id~'^[1-9][0-9]{0,39}$'),
 document_id uuid not null unique references erp_documents.document(id),
 command_id uuid not null unique references erp_documents.command(command_id),
 evidence jsonb not null check(jsonb_typeof(evidence)='object'),
 created_at timestamptz not null default clock_timestamp(),
 primary key(entity,source_id)
);
alter table erp_documents.origin_import_origin enable row level security;
revoke all on erp_documents.origin_import_origin from public,anon,authenticated,service_role;

create function erp_documents.origin_import_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_origin_proposal_evidence_immutable' using errcode='42501'; end $$;
create trigger origin_import_origin_immutable before update or delete on erp_documents.origin_import_origin
for each row execute function erp_documents.origin_import_immutable();
create function erp_documents.origin_import_command_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if old.result->>'policy'='origin-open-proposal-v1' then
  raise exception 'erp_origin_proposal_evidence_immutable' using errcode='42501';
 end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger origin_import_command_immutable before update or delete on erp_documents.command
for each row execute function erp_documents.origin_import_command_immutable();

create function erp_documents.origin_import_flags() returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select '{"data_mode":"proposal_import_review","policy":"origin-open-proposal-v1","entity":"sales_proposals","creates_draft":true,"stock_effects":false,"financial_effects":false,"fiscal_effects":false,"coverage_certified":false,"cutoff_at":null}'::jsonb
$$;
create function erp_documents.origin_import_id(v jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v) in('string','number') and v#>>'{}'~'^[1-9][0-9]{0,39}$' then v#>>'{}' end
$$;
create function erp_documents.origin_import_number(v jsonb,p_scale integer,p_integers integer) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare n numeric;
begin
 if jsonb_typeof(v) is distinct from 'number' or octet_length(v::text)>80 then return null;end if;
 n:=(v#>>'{}')::numeric;
 if n<0 or n>=power(10::numeric,p_integers) or trunc(n,p_scale)<>n then return null;end if;
 return round(n,p_scale)::text;
exception when numeric_value_out_of_range or invalid_text_representation then return null;
end $$;
create function erp_documents.origin_import_issue(p_code text,p_field text default null,p_position integer default null) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_array(jsonb_build_object('code',p_code,'field',p_field,'position',p_position))
$$;
-- API objects may contain their complete empty shape. This only recognizes
-- documented keys with explicit zero/empty values; it never resolves an ID.
create function erp_documents.origin_import_empty_reference(v jsonb,p_kind text) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare field text; part jsonb;
begin
 if v is null or v='null'::jsonb then return true;end if;
 if jsonb_typeof(v)<>'object' then return false;end if;
 for field,part in select key,value from jsonb_each(v) loop
  if field='id' and part='0'::jsonb then continue;end if;
  if p_kind='store' and field='unidadeNegocio' and erp_documents.origin_import_empty_reference(part,'id') then continue;end if;
  if ((p_kind='carrier' and field='nome') or(p_kind='volume' and field in('servico','codigoRastreamento')))
    and part='""'::jsonb then continue;end if;
  return false;
 end loop;
 return true;
end $$;

-- Exact source linkage only. Names/codes/prices are never matching keys.
create function erp_documents.origin_import_binding(p_entity text,p_source text) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('entity',p_entity,'source_id',p_source,'record_id',r.id,'record_version',r.version,
  'name',r.name,'unit',(select p.unit from erp_catalog.product p where p.record_id=r.id),'active',r.active,'human_edited',r.human_edited,'origin_state',o.state,
  'candidate_pending',o.candidate is not null,'applied_hash',o.applied_hash,'latest_hash',o.latest_hash,
  'source_hash',s.version_hash,'source_version',s.version::text,
  'valid',coalesce(r.active and not r.human_edited and o.state='synced' and o.candidate is null
   and o.applied_hash=s.version_hash and o.latest_hash=s.version_hash
   and ((p_entity='contacts' and exists(select 1 from erp_catalog.contact c where c.record_id=r.id))
     or(p_entity='products' and exists(select 1 from erp_catalog.product p where p.record_id=r.id and p.format='S' and p.kind in('P','S')))),false))
 from (select 1) anchor left join erp_catalog.origin o on o.entity=p_entity and o.source_id=p_source
 left join erp_catalog.record r on r.id=o.record_id and r.entity=p_entity
 left join origin_sync.raw_record s on s.entity=p_entity and s.source_id=p_source
$$;

create function erp_documents.origin_proposal_plan(p_actor uuid,p_source_id text) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare s origin_sync.raw_record%rowtype; existing erp_documents.origin_import_origin%rowtype;
 p jsonb; issues jsonb:='[]'; bindings jsonb:='[]'; contact_link jsonb; b jsonb; body jsonb; normalized jsonb;
 rows jsonb:='[]'; installments jsonb:='[]'; row jsonb; parcel jsonb; part jsonb; field text; pos integer:=0;
 sid text; qty text; price text; discount text; total text; products_total text; freight text; other text;
 result jsonb;
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
  begin perform erp_documents.date_value(p->field,field='data');
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
 foreach field in array array['introducao','aosCuidadosDe'] loop
  if p?field and p->field not in('null'::jsonb,'""'::jsonb) then issues:=issues||erp_documents.origin_import_issue('COMMERCIAL_FIELD_UNSUPPORTED',field);end if;
 end loop;
 foreach field in array array['loja','vendedor'] loop
  if not erp_documents.origin_import_empty_reference(p->field,case when field='loja' then 'store' else 'id' end) then
   issues:=issues||erp_documents.origin_import_issue('COMMERCIAL_REFERENCE_UNSUPPORTED',field);end if;
 end loop;
 discount:=erp_documents.origin_import_number(p->'desconto',4,12);
 if discount is null or discount::numeric<>0 then issues:=issues||erp_documents.origin_import_issue('DISCOUNT_UNSUPPORTED','desconto');end if;
 total:=erp_documents.origin_import_number(p->'total',2,12);
 products_total:=erp_documents.origin_import_number(p->'totalProdutos',2,12);
 freight:=erp_documents.origin_import_number(p#>'{transporte,frete}',2,12);
 other:=erp_documents.origin_import_number(p->'outrasDespesas',2,12);
 if total is null or products_total is null or freight is null or other is null then issues:=issues||erp_documents.origin_import_issue('AMOUNTS_MISSING_OR_INVALID');end if;
 if jsonb_typeof(p->'transporte') is distinct from 'object' then issues:=issues||erp_documents.origin_import_issue('TRANSPORT_INVALID','transporte');
 else
  if p#>'{transporte,freteModalidade}'='9'::jsonb and freight::numeric>0 then
   issues:=issues||erp_documents.origin_import_issue('TRANSPORT_CONFLICT','transporte');end if;
  for field,part in select key,value from jsonb_each(p->'transporte') loop
   if field='frete' then continue;end if;
   if (field='freteModalidade' and part in('9'::jsonb,'0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb)) then
    -- Modalidade cannot be represented in the native draft; only "sem frete" is lossless.
    if part<>'9'::jsonb then issues:=issues||erp_documents.origin_import_issue('TRANSPORT_FIELD_UNSUPPORTED','transporte.'||field);end if;
   elsif (field in('quantidadeVolumes','pesoBruto','prazoEntrega') and part='0'::jsonb)
      or (field='contato' and erp_documents.origin_import_empty_reference(part,'carrier'))
      or (field='volumes' and erp_documents.origin_import_empty_reference(part,'volume')) then null;
   else issues:=issues||erp_documents.origin_import_issue('TRANSPORT_FIELD_UNSUPPORTED','transporte');end if;
  end loop;
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
   discount:=erp_documents.origin_import_number(row->'desconto',4,12);
   if qty is null or qty::numeric=0 or price is null then issues:=issues||erp_documents.origin_import_issue('ITEM_DECIMAL_INVALID','quantidade/valor',pos);end if;
   if discount is null or discount::numeric<>0 then issues:=issues||erp_documents.origin_import_issue('DISCOUNT_UNSUPPORTED','itens.desconto',pos);end if;
   if row?'descricaoDetalhada' and row->'descricaoDetalhada' not in('null'::jsonb,'""'::jsonb) then
    issues:=issues||erp_documents.origin_import_issue('ITEM_DETAIL_UNSUPPORTED','descricaoDetalhada',pos);end if;
   rows:=rows||jsonb_build_array(jsonb_build_object('product_id',b->'record_id','description',row#>'{produto,descricao}',
    'code',row->'codigo','unit',row->'unidade','quantity',qty,'unit_price',price,'discount_percent','0'));
  end loop;
 end if;
 if jsonb_typeof(p->'parcelas') is distinct from 'array' then issues:=issues||erp_documents.origin_import_issue('INSTALLMENTS_INVALID','parcelas');
 elsif jsonb_array_length(p->'parcelas')>120 then issues:=issues||erp_documents.origin_import_issue('INSTALLMENTS_INVALID','parcelas');
 else
  pos:=0;
  for parcel in select value from jsonb_array_elements(p->'parcelas') loop
   pos:=pos+1;
   if jsonb_typeof(parcel)<>'object' then issues:=issues||erp_documents.origin_import_issue('INSTALLMENT_INVALID','parcelas',pos);continue;end if;
   if exists(select 1 from jsonb_object_keys(parcel) k where k not in('numeroDias','dataVencimento','valor','observacoes','formaPagamento'))
    or(parcel?'observacoes' and parcel->'observacoes' not in('null'::jsonb,'""'::jsonb))
    or not erp_documents.origin_import_empty_reference(parcel->'formaPagamento','id') then
    issues:=issues||erp_documents.origin_import_issue('INSTALLMENT_FIELD_UNSUPPORTED','parcelas',pos);end if;
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
   installments:=installments||jsonb_build_array(jsonb_build_object('due_date',parcel->'dataVencimento','amount',price,'method',null));
  end loop;
 end if;
 body:=jsonb_build_object('date',p->'data','contact_id',contact_link->'record_id','items',rows,'discount_mode','amount','discount_value','0',
  'freight',freight,'other_expenses',other,'installments',installments,'notes',p->'observacoes','internal_notes',p->'observacaoInterna',
  'delivery_terms',p->'prazoEntrega','next_contact',p->'dataProximoContato');
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
 result:=erp_documents.origin_import_flags()||jsonb_build_object('source_id',p_source_id,'source_hash',s.version_hash,'source_version',s.version::text,
  'source_seen_at',s.last_seen_at,'source_changed_at',s.changed_at,'source_status',case when jsonb_typeof(p->'situacao')='string' and length(p->>'situacao')<=80 then p->>'situacao' end,
  'source_number',erp_documents.origin_import_id(p->'numero'),'can_apply',issues='[]'::jsonb,'issues',issues,'bindings',bindings,
  'warnings',jsonb_build_array('SOURCE_FRESHNESS_NOT_CERTIFIED','MANUAL_DUPLICATES_NOT_DETECTABLE','NATIVE_NUMBER_ASSIGNED_ON_APPLY'),
  'proposed',normalized,'existing',case when existing.document_id is not null then jsonb_build_object('document_id',existing.document_id,'command_id',existing.command_id,'imported_at',existing.created_at) end);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'plan',result)::text,'UTF8')),'hex'));
end $$;

create function public.erp_origin_proposal_import_preview(p_user_id uuid,p_source_id text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
begin
 perform erp_cutover.require_admin(p_user_id);
 return erp_documents.origin_proposal_plan(p_user_id,p_source_id)||'{"dry_run":true,"persisted":false}'::jsonb;
end $$;

-- Discovery is not an eligibility verdict. Always open a fresh full preview.
create function public.erp_origin_proposal_import_sources(p_user_id uuid,p_limit integer default 25,p_after text default null,p_query text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare items jsonb; ids text[]; more boolean;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_limit is null or p_limit not between 1 and 25 or (p_after is not null and (length(p_after) not between 1 and 200 or p_after~'[[:cntrl:]]'))
  or (p_query is not null and (length(p_query)>100 or p_query~'[[:cntrl:]]')) then
  raise exception 'erp_origin_proposal_query_invalid' using errcode='22023';end if;
 select array_agg(source_id order by source_id collate "C") into ids from(
  select s.source_id from origin_sync.raw_record s where s.entity='sales_proposals'
   and(p_after is null or s.source_id collate "C">p_after collate "C")
   and(nullif(btrim(p_query),'') is null or strpos(s.source_id,btrim(p_query))>0
    or strpos(coalesce(erp_documents.origin_import_id(s.payload->'numero'),''),btrim(p_query))>0)
   order by s.source_id collate "C" limit p_limit+1) page;
 more:=coalesce(array_length(ids,1),0)>p_limit;
 select coalesce(jsonb_agg(jsonb_build_object('source_id',s.source_id,'source_hash',s.version_hash,'source_version',s.version::text,
  'source_seen_at',s.last_seen_at,'source_number',erp_documents.origin_import_id(s.payload->'numero'),
  'source_status',case when jsonb_typeof(s.payload->'situacao')='string' and length(s.payload->>'situacao')<=80 then s.payload->>'situacao' end,
  'document_id',o.document_id,'requires_preview',true) order by s.source_id collate "C"),'[]'::jsonb) into items
 from origin_sync.raw_record s left join erp_documents.origin_import_origin o on o.entity=s.entity and o.source_id=s.source_id
 where s.entity='sales_proposals' and s.source_id=any(ids[1:p_limit]);
 return erp_documents.origin_import_flags()||jsonb_build_object('read_only',true,'items',items,'limit',p_limit,'has_more',more,
  'next_cursor',case when more then ids[p_limit] end);
end $$;

create function public.erp_origin_proposal_import_apply(p_user_id uuid,p_source_id text,p_preview_hash text,
 p_command_id uuid,p_confirm_import boolean,p_duplicate_reviewed boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare request_hash text; replay jsonb; initial jsonb; plan jsonb; data jsonb; id uuid; receipt jsonb; result jsonb;
 parent_ids uuid[]; source_refs jsonb; snapshot jsonb;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_source_id is null or p_source_id!~'^[1-9][0-9]{0,39}$' or p_preview_hash is null or p_preview_hash!~'^[0-9a-f]{64}$'
  or p_confirm_import is distinct from true or p_duplicate_reviewed is distinct from true then
  raise exception 'erp_origin_proposal_request_invalid' using errcode='22023';end if;
 request_hash:=encode(sha256(convert_to(jsonb_build_object('op','origin_import_proposal','actor',p_user_id,'source_id',p_source_id,
  'preview_hash',p_preview_hash,'confirm_import',p_confirm_import,'duplicate_reviewed',p_duplicate_reviewed)::text,'UTF8')),'hex');
 replay:=erp_documents.command_replay(p_user_id,p_command_id,request_hash);
 if replay is not null then perform erp_cutover.require_admin(p_user_id);return replay;end if;
 perform pg_advisory_xact_lock(174852952,hashtext(p_source_id));
 initial:=erp_documents.origin_proposal_plan(p_user_id,p_source_id);
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
 plan:=erp_documents.origin_proposal_plan(p_user_id,p_source_id);
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
  'source_number',plan->'source_number','source_status',plan->'source_status','preview_hash',p_preview_hash,'duplicate_reviewed',true,
  'document',erp_documents.summary(id),'imported_at',clock_timestamp());
 result:=erp_documents.origin_import_flags()||jsonb_build_object('dry_run',false,'persisted',true,'replayed',false,'receipt',receipt);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,request_hash,result);
 insert into erp_documents.origin_import_origin(entity,source_id,document_id,command_id,evidence)
 values('sales_proposals',p_source_id,id,p_command_id,jsonb_build_object('receipt',receipt,'bindings',plan->'bindings','normalized_body',data));
 insert into erp_documents.audit(actor,command_id,document_id,action,after_data)
 values(p_user_id,p_command_id,id,'origin_import_proposal',erp_documents.dto(id));
 return result;
end $$;

create function public.erp_origin_proposal_import_command(p_user_id uuid,p_command_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_documents.command%rowtype; id uuid;
begin
 perform erp_cutover.require_admin(p_user_id);
 select * into c from erp_documents.command where command_id=p_command_id and result->>'policy'='origin-open-proposal-v1';
 if not found then raise exception 'erp_origin_proposal_not_found' using errcode='P0002';end if;
 id:=(c.result#>>'{receipt,document,id}')::uuid;
 return erp_documents.origin_import_flags()||jsonb_build_object('read_only',true,'receipt',c.result->'receipt','current_document',erp_documents.dto(id));
end $$;
create function public.erp_origin_proposal_import_origin(p_user_id uuid,p_source_id text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare o erp_documents.origin_import_origin%rowtype;
begin
 perform erp_cutover.require_admin(p_user_id);
 select * into o from erp_documents.origin_import_origin where entity='sales_proposals' and source_id=p_source_id;
 if not found then raise exception 'erp_origin_proposal_not_found' using errcode='P0002';end if;
 return erp_documents.origin_import_flags()||jsonb_build_object('read_only',true,'receipt',o.evidence->'receipt','current_document',erp_documents.dto(o.document_id));
end $$;
create function public.erp_origin_proposal_document_origin(p_user_id uuid,p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare kind text; o erp_documents.origin_import_origin%rowtype;
begin
 select d.kind into kind from erp_documents.document d where d.id=p_document_id;
 if not found then raise exception 'erp_origin_proposal_not_found' using errcode='P0002';end if;
 perform erp_documents.require_access(p_user_id,kind,false);
 select * into o from erp_documents.origin_import_origin where document_id=p_document_id;
 return jsonb_build_object('data_mode','erp_native','read_only',true,'document_id',p_document_id,'kind',kind,
  'origin',case when o.document_id is not null then jsonb_build_object('system','origin','entity',o.entity,'source_id',o.source_id,
   'source_number',o.evidence#>'{receipt,source_number}','source_hash',o.evidence#>'{receipt,source_hash}',
   'source_version',o.evidence#>'{receipt,source_version}','command_id',o.command_id,'imported_at',o.created_at) end);
end $$;

revoke all on function erp_documents.origin_import_immutable(),erp_documents.origin_import_command_immutable(),
 erp_documents.origin_import_flags(),erp_documents.origin_import_id(jsonb),erp_documents.origin_import_number(jsonb,integer,integer),
 erp_documents.origin_import_issue(text,text,integer),erp_documents.origin_import_empty_reference(jsonb,text),erp_documents.origin_import_binding(text,text),erp_documents.origin_proposal_plan(uuid,text)
 from public,anon,authenticated,service_role;
revoke all on function public.erp_origin_proposal_import_sources(uuid,integer,text,text),public.erp_origin_proposal_import_preview(uuid,text),public.erp_origin_proposal_import_apply(uuid,text,text,uuid,boolean,boolean),
 public.erp_origin_proposal_import_command(uuid,uuid),public.erp_origin_proposal_import_origin(uuid,text),public.erp_origin_proposal_document_origin(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.erp_origin_proposal_import_sources(uuid,integer,text,text),public.erp_origin_proposal_import_preview(uuid,text),public.erp_origin_proposal_import_apply(uuid,text,text,uuid,boolean,boolean),
 public.erp_origin_proposal_import_command(uuid,uuid),public.erp_origin_proposal_import_origin(uuid,text),public.erp_origin_proposal_document_origin(uuid,uuid)
 to service_role;
commit;
