-- 300: Preferências › Importações de Dados › Importar lotes (Origin: Importações › Produtos › Lotes). A planilha modelo tem Código do
-- produto, Lote, Data de fabricação, Data de validade e Obs.; cada linha passa por erp_stock_lot_import (frente de estoque, 277), com
-- as regras de "+ Adicionar lote" (258): o produto precisa ter Controle de lote, um Lote novo é incluído no produto e um Lote que ele
-- já tem atualiza só as datas e a Obs. preenchidas (vazio mantém); valem as datas obrigatórias de Preferências › Cadastros ›
-- Controle de lotes e a fabricação até a validade. Uma linha igual ao lote gravado fica "Sem alteração". Nada lança estoque.
-- Cada linha usa o comando derivado do lote da planilha (o mesmo arquivo reenviado com o mesmo comando não duplica nada), como os
-- demais tipos.
-- Substitui erp_preferences.import_item (283) e erp_preferences_import_batch (265), conferidas pelo hash; outra versão interrompe a
-- migração. Só a lista de tipos e o desvio para os lotes mudam.
begin;

do $$declare r record;begin
 if to_regprocedure('public.erp_stock_lot_import(uuid,uuid,uuid,text,date,date,text)') is null or to_regclass('erp_preferences.import_job') is null then
  raise exception 'preferences_lot_import_300_requires_228_277' using errcode='55000';end if;
 for r in select * from(values
  ('erp_preferences.import_item(uuid,text,uuid,text,jsonb)','7ae097fde77b9fba3e273086fe8d27dd56b1f3ab02b53d95d91ee185e3aa2371'),
  ('public.erp_preferences_import_batch(uuid,uuid,uuid,text,text,integer,boolean,jsonb)','dd9c76c96be3aa6861f089e455de09ef49bcb15253749332ebddfef0253537b3'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'preferences_lot_import_300_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regprocedure('erp_preferences.import_item_lot(uuid,uuid,jsonb)') is not null then raise exception 'preferences_lot_import_300_already_applied' using errcode='55000';end if;
end$$;

-- The job of the new kind (265 accepted eleven).
alter table erp_preferences.import_job drop constraint import_job_kind_check;
alter table erp_preferences.import_job add constraint import_job_kind_check check(kind in('products','contacts','purchase_orders','stock_movements','receivables','payables','sales_orders','nfe',
 'compositions','custom_fields','product_suppliers','lots'));

-- One lot of the sheet: the product by Código (one, not deleted), the lot through the stock lane RPC with the derived command.
create function erp_preferences.import_item_lot(p_user_id uuid,p_command uuid,p_data jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_id uuid; v_res jsonb;
begin
 v_id:=erp_preferences.import_product(p_data->>'code','code',true);
 v_res:=public.erp_stock_lot_import(p_user_id,p_command,v_id,p_data->>'lot',(p_data->>'manufactured_on')::date,(p_data->>'expires_on')::date,p_data->>'note');
 return jsonb_build_object('action',case when v_res->>'outcome'='created' then 'create' else 'update' end,'record_id',v_res#>>'{lot,id}',
  'reference',left('Lote '||(p_data->>'lot')||' · '||(p_data->>'code'),120),'unchanged',v_res->>'outcome'='unchanged');
end $$;

create or replace function erp_preferences.import_item(p_user_id uuid,p_kind text,p_command uuid,p_file text,p_data jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_id uuid; v_version integer; v_patch jsonb; v_res jsonb; v_origin text; v_items jsonb:='[]'::jsonb; v_item jsonb; v_product uuid; v_line integer:=0;
 v_body jsonb; v_wh uuid; v_qty numeric; v_balance numeric; v_bversion integer; v_kind text; v_cents bigint; v_reason text; v_doc text; v_ids uuid[];
 v_contact erp_catalog.contact%rowtype; v_profile erp_catalog.contact_profile%rowtype; v_nature erp_fiscal_invoices.nature%rowtype; v_crt text; v_series text; v_person text; v_name text; v_text text;
 v_kits uuid[]:='{}';
begin
 if p_kind='products' then
  if p_data?'code' then v_id:=erp_preferences.import_product(p_data->>'code','code',false); end if;
  v_patch:=p_data-'category'-'product_group';
  if p_data?'category' then v_patch:=v_patch||jsonb_build_object('category_id',erp_preferences.import_named('categories',p_data->>'category','category')); end if;
  if p_data?'product_group' then v_patch:=v_patch||jsonb_build_object('product_group_id',erp_preferences.import_named('product_groups',p_data->>'product_group','product_group')); end if;
  if v_id is null then
   -- Preferências › Configurações de produtos: "Origem padrão de tributação de produtos" fills a new product without Origem.
   v_origin:=erp_preferences.get('produtos.origem_padrao')#>>'{}';
   if not v_patch?'origin' and v_origin~'^[0-8]$' then v_patch:=v_patch||jsonb_build_object('origin',v_origin); end if;
   v_res:=public.erp_catalog_product_save(p_user_id,null,0,p_command,v_patch,null);
   return jsonb_build_object('action','create','record_id',v_res#>>'{record,id}','reference',left(coalesce(v_res#>>'{record,code}',v_res#>>'{record,name}'),120),'unchanged',false);
  end if;
  select version into v_version from erp_catalog.record where id=v_id;
  v_patch:=v_patch-'code';
  if v_patch='{}'::jsonb then return jsonb_build_object('action','update','record_id',v_id,'reference',left(p_data->>'code',120),'unchanged',true); end if;
  -- 283: with "Atualizar preço de custo / peso / preço de venda das composições com base nos componentes" (222), the compositions that use
  -- the product follow its new price and weights, each with the derived command, the version and the audit of the composition (235). Lock
  -- order of 235: the product and the compositions, by UUID, before the first write.
  if v_patch ?| array['price','net_weight','gross_weight'] and erp_catalog.composition_sync_on() then
   v_kits:=erp_catalog.composition_kits(array[v_id]);
   if cardinality(v_kits)>0 then perform 1 from erp_catalog.record where id=v_id or id=any(v_kits) order by id for update; end if;
  end if;
  v_res:=public.erp_catalog_product_save(p_user_id,v_id,v_version,p_command,v_patch,null);
  if cardinality(v_kits)>0 and(v_res#>>'{record,version}')::integer<>v_version then perform erp_catalog.composition_sync(p_user_id,p_command,erp_catalog.composition_kits(array[v_id])); end if;
  return jsonb_build_object('action','update','record_id',v_id,'reference',left(p_data->>'code',120),'unchanged',(v_res#>>'{record,version}')::integer=v_version);
 elsif p_kind='contacts' then
  v_doc:=nullif(erp_catalog.compact(p_data->>'document'),'');
  if v_doc is not null then
   select array_agg(r.id order by r.id) into v_ids from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id left join erp_catalog.contact_profile p on p.record_id=r.id
    where r.entity='contacts' and coalesce(p.situation,'A')<>'E' and erp_catalog.compact(c.document)=v_doc;
   if cardinality(v_ids)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:document'); end if;
   v_id:=v_ids[1];
  end if;
  if v_id is null then
   v_res:=public.erp_catalog_contact_save(p_user_id,null,0,p_command,p_data,null);
   return jsonb_build_object('action','create','record_id',v_res#>>'{record,id}','reference',left(coalesce(v_res#>>'{record,code}',v_res#>>'{record,name}'),120),'unchanged',false);
  end if;
  select version into v_version from erp_catalog.record where id=v_id;
  v_res:=public.erp_catalog_contact_save(p_user_id,v_id,v_version,p_command,p_data,null);
  return jsonb_build_object('action','update','record_id',v_id,'reference',left(coalesce(v_res#>>'{record,name}',v_doc),120),'unchanged',(v_res#>>'{record,version}')::integer=v_version);
 elsif p_kind in('purchase_orders','sales_orders') then
  v_body:=jsonb_build_object('date',p_data->'date','contact_id',erp_preferences.import_contact(p_data->>'contact_name',p_data->>'contact_document','contact_name','contact_document'));
  for v_item in select x from jsonb_array_elements(p_data->'items') x loop
   v_line:=v_line+1; v_product:=null;
   if v_item?'code' then v_product:=erp_preferences.import_product(v_item->>'code','item_code',true); end if;
   v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('product_id',v_product,
    'description',coalesce(v_item->>'description',(select r.name from erp_catalog.record r where r.id=v_product)),
    'code',case when v_product is not null then (select r.code from erp_catalog.record r where r.id=v_product) end,
    'unit',coalesce(v_item->>'unit',(select p.unit from erp_catalog.product p where p.record_id=v_product),'UN'),
    'quantity',v_item->'quantity',
    'unit_price',coalesce(v_item->>'unit_price',(select erp_catalog.unit_price_numeric(p.price,10) from erp_catalog.product p where p.record_id=v_product and p.price is not null),'0'),
    'discount_percent',v_item->'discount_percent')));
  end loop;
  v_body:=v_body||jsonb_build_object('items',v_items)||jsonb_strip_nulls(jsonb_build_object('expected_date',p_data->'expected_date','freight',p_data->'freight',
   'notes',p_data->'notes','internal_notes',p_data->'internal_notes'));
  v_res:=public.erp_document_save(p_user_id,p_kind,null,0,p_command,v_body);
  return jsonb_build_object('action','create','record_id',v_res#>>'{document,id}','reference',left('nº '||(v_res#>>'{document,number}')||' (planilha '||(p_data->>'number')||')',120),'unchanged',false);
 elsif p_kind='stock_movements' then
  v_product:=erp_preferences.import_product(p_data->>'code','code',true);
  if p_data?'warehouse' then v_wh:=erp_preferences.import_named('warehouses',p_data->>'warehouse','warehouse');
  else select warehouse_id into v_wh from erp_stock.warehouse_default; if v_wh is null then perform erp_preferences.import_fail('erp_preferences_import_required:warehouse'); end if; end if;
  select b.quantity,b.version into v_balance,v_bversion from erp_stock.balance b where b.product_id=v_product and b.warehouse_id=v_wh;
  v_balance:=coalesce(v_balance,0); v_bversion:=coalesce(v_bversion,0); v_qty:=(p_data->>'quantity')::numeric;
  if p_data->>'movement' in('receipt','issue') and v_qty<=0 then perform erp_preferences.import_fail('erp_preferences_import_invalid:quantity'); end if;
  v_kind:=case p_data->>'movement' when 'balance' then 'adjustment' else p_data->>'movement' end;
  v_qty:=case p_data->>'movement' when 'receipt' then v_qty when 'issue' then -v_qty else v_qty-v_balance end;
  if v_qty=0 then return jsonb_build_object('action','update','record_id',null,'reference','Saldo já igual à quantidade','unchanged',true); end if;
  v_reason:=coalesce(nullif(btrim(p_data->>'note'),''),'Importação de movimentações de estoque');
  if length(v_reason)<3 then v_reason:='Importação: '||v_reason; end if;
  v_res:=public.erp_stock_post(p_user_id,p_command,v_kind,coalesce((p_data->>'date')::date,(clock_timestamp() at time zone 'America/Sao_Paulo')::date),v_reason,
   jsonb_build_array(jsonb_build_object('product_id',v_product,'warehouse_id',v_wh,'quantity',v_qty::numeric(18,6)::text,'expected_version',v_bversion)),left('Importação '||p_file,100));
  return jsonb_build_object('action','create','record_id',v_res#>>'{movement,id}','reference',left(case v_kind when 'receipt' then 'Entrada' when 'issue' then 'Saída' else 'Balanço' end||' '||(v_qty::numeric(18,6))::text,120),'unchanged',false);
 elsif p_kind='nfe' then
  -- Notas fiscais em lote: a rascunho de NF-e de saída in homologation, the same input the notas screen sends (recipient from
  -- the cadastro, items with the product NCM/CEST/GTIN/origem, Cálculo automático). Number and SEFAZ stay with the emission steps.
  -- Preferências › Empresa: the tax regime must be confirmed before any note.
  select f.crt into v_crt from erp_company.fiscal f where f.singleton;
  if v_crt is null then perform erp_preferences.import_fail('erp_preferences_import_company_regime'); end if;
  v_id:=erp_preferences.import_contact(p_data->>'contact_name',p_data->>'contact_document','contact_name','contact_document');
  select * into v_contact from erp_catalog.contact where record_id=v_id;
  select * into v_profile from erp_catalog.contact_profile where record_id=v_id;
  select r.name into v_name from erp_catalog.record r where r.id=v_id;
  v_doc:=nullif(erp_catalog.compact(v_contact.document),'');
  v_person:=coalesce(nullif(v_contact.person_type,''),case length(v_doc) when 14 then 'J' when 11 then 'F' end);
  if p_data?'nature' then
   select array_agg(n.id order by n.id) into v_ids from erp_fiscal_invoices.nature n
    where n.direction='1' and n.active and n.deleted_at is null and lower(btrim(n.description))=lower(btrim(p_data->>'nature'));
   if cardinality(v_ids)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:nature'); end if;
   if v_ids is null then perform erp_preferences.import_fail('erp_preferences_import_not_found:nature'); end if;
   select * into v_nature from erp_fiscal_invoices.nature where id=v_ids[1];
  else
   select n.* into v_nature from erp_fiscal_invoices.nature_default d join erp_fiscal_invoices.nature n on n.id=d.nature_id
    where n.active and n.deleted_at is null and d.code=any(case v_person when 'F' then array['VF','S'] when 'J' then array['VJ','S'] else array['S'] end)
    order by array_position(case v_person when 'F' then array['VF','S'] when 'J' then array['VJ','S'] else array['S'] end,d.code) limit 1;
   if v_nature.id is null then perform erp_preferences.import_fail('erp_preferences_import_required:nature'); end if;
  end if;
  v_series:=v_nature.series::text;
  if v_series is null and to_regclass('erp_fiscal_numbering.series') is not null then
   execute 'select series::text from erp_fiscal_numbering.series where model=''55'' and environment=''2'' and enabled order by series limit 1' into v_series;
  end if;
  for v_item in select x from jsonb_array_elements(p_data->'items') x loop
   v_product:=null;
   if v_item?'code' then v_product:=erp_preferences.import_product(v_item->>'code','item_code',true); end if;
   v_items:=v_items||jsonb_build_array(jsonb_strip_nulls((select jsonb_build_object('product_id',v_product,'code',left(r.code,60),
     'description',left(coalesce(v_item->>'description',r.name),120),'unit',left(coalesce(v_item->>'unit',p.unit,'UN'),6),'quantity',v_item->'quantity',
     'unit_price',coalesce(v_item->>'unit_price',erp_catalog.unit_price_numeric(p.price,10),'0'),
     'ncm',case when p.ncm~'^[0-9]{8}$' then p.ncm end,'cest',case when p.cest~'^[0-9]{7}$' then p.cest end,
     'gtin',case when p.gtin~'^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$' then p.gtin end,'gtin_tax',case when p.gtin_tax~'^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$' then p.gtin_tax end,
     'icms',case when p.origin~'^[0-8]$' then jsonb_build_object('origin',p.origin) end)
    from(select 1) one left join erp_catalog.record r on r.id=v_product left join erp_catalog.product p on p.record_id=v_product)));
  end loop;
  v_text:=nullif(regexp_replace(coalesce(v_contact.ie,''),'[^0-9]','','g'),'');
  v_body:=jsonb_build_object('model','55','direction','1','issue_type','N','series',coalesce(v_series,'1'),'nature_id',v_nature.id,
   'issue_date',coalesce(p_data->>'date',to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD')),'crt',v_crt,'purpose','1',
   'presence',coalesce(v_nature.presence,'1'),'final_consumer',coalesce(v_nature.final_consumer,false),'auto_tax',true,'items',v_items,
   'recipient',jsonb_strip_nulls(jsonb_build_object('contact_id',v_id,'name',left(v_name,60),'person_type',v_person,
    'document',case when v_person in('F','J') and length(v_doc) in(11,14) then v_doc end,
    'ie',case when length(v_text) between 2 and 14 then v_text when upper(btrim(v_contact.ie))='ISENTO' then 'ISENTO' end,
    'ie_indicator',case when v_profile.taxpayer in('1','2','9') then v_profile.taxpayer end,
    'email',case when left(coalesce(nullif(v_profile.nfe_email,''),v_contact.email),60)~'^[^[:space:]@]+@[^[:space:]@]+$' then left(coalesce(nullif(v_profile.nfe_email,''),v_contact.email),60) end,
    'postal_code',case when regexp_replace(coalesce(v_contact.postal_code,''),'[^0-9]','','g')~'^[0-9]{8}$' then regexp_replace(v_contact.postal_code,'[^0-9]','','g') end,
    'street',nullif(left(v_contact.street,60),''),'number',nullif(left(v_contact.number,60),''),'complement',nullif(left(v_contact.complement,60),''),
    'district',nullif(left(v_contact.district,60),''),'city',nullif(left(v_contact.city,60),''),
    'state',case when upper(v_contact.state) in('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO') then upper(v_contact.state) end)))
   ||jsonb_strip_nulls(jsonb_build_object('additional_info',p_data->'notes'));
  v_res:=public.erp_fiscal_invoice_execute(p_user_id,p_command,'create',jsonb_build_object('invoice',v_body));
  return jsonb_build_object('action','create','record_id',v_res#>>'{invoice,id}','reference',left('Rascunho de NF-e (planilha '||(p_data->>'number')||')',120),'unchanged',false);
 elsif p_kind in('receivables','payables') then
  v_kind:=case p_kind when 'receivables' then 'receivable' else 'payable' end;
  v_cents:=((p_data->>'amount')::numeric*100)::bigint;
  v_res:=public.erp_finance_title_execute(p_user_id,p_command,'title_create',jsonb_strip_nulls(jsonb_build_object('kind',v_kind,
   'contact_id',erp_preferences.import_contact(p_data->>'contact_name',p_data->>'contact_document','contact_name','contact_document'),
   'category_id',erp_preferences.import_named('finance_categories',p_data->>'category','category',v_kind),
   'account_id',erp_preferences.import_named('accounts',p_data->>'account','account'),
   'payment_method_id',erp_preferences.import_named('payment_methods',p_data->>'payment_method','payment_method',v_kind),
   'description',p_data->'description','source_reference',p_data->'source_reference','issued_on',p_data->'issued_on','competence_on',coalesce(p_data->'competence_on',p_data->'issued_on'),
   'total_cents',v_cents::text,'installments',jsonb_build_array(jsonb_build_object('amount_cents',v_cents::text,'due_on',p_data->'due_on')))));
  return jsonb_build_object('action','create','record_id',v_res#>>'{items,0,id}','reference',left(p_data->>'description',120),'unchanged',false);
 end if;
 -- 265: composições, campos customizados and fornecedores de produtos (erp_preferences.import_item_e).
 if p_kind in('compositions','custom_fields','product_suppliers') then return erp_preferences.import_item_e(p_user_id,p_kind,p_command,p_data); end if;
 -- 300: lotes (erp_preferences.import_item_lot, through erp_stock_lot_import of the stock lane).
 if p_kind='lots' then return erp_preferences.import_item_lot(p_user_id,p_command,p_data); end if;
 perform erp_preferences.import_fail('erp_preferences_import_kind_invalid');
 return null;
end $$;

create or replace function public.erp_preferences_import_batch(p_user_id uuid,p_command_id uuid,p_job_id uuid,p_kind text,p_file_name text,p_total_rows integer,p_dry_run boolean,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_preferences.import_command%rowtype; v_job erp_preferences.import_job%rowtype; v_item jsonb; v_row integer; v_done erp_preferences.import_row%rowtype;
 v_out jsonb; v_message text; v_state text; v_reason text; v_result jsonb; v_items jsonb:='[]'::jsonb; v_seed uuid:=coalesce(p_command_id,gen_random_uuid());
 v_new integer:=0; v_created integer:=0; v_updated integer:=0; v_unchanged integer:=0; v_invalid integer:=0; v_status text; v_action text; v_entry jsonb;
begin
 perform erp_preferences.import_require_admin(p_user_id);
 if p_kind is null or p_kind not in('products','contacts','purchase_orders','stock_movements','receivables','payables','sales_orders','nfe','compositions','custom_fields','product_suppliers','lots') or p_dry_run is null
  or(not p_dry_run and(p_command_id is null or p_job_id is null)) or p_file_name is null or length(p_file_name) not between 1 and 200 or p_file_name~'[[:cntrl:]]'
  or btrim(p_file_name)<>p_file_name or p_total_rows is null or p_total_rows not between 1 and 10000
  or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50 or octet_length(p_rows::text)>262144
  or exists(select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x)<>'object' or(select count(*) from jsonb_object_keys(x))<>3
   or jsonb_typeof(x->'row')<>'number' or(x->>'row')!~'^[1-9][0-9]{0,4}$' or(x->>'row')::integer not between 2 and 10001
   or jsonb_typeof(x->'lines')<>'array' or jsonb_array_length(x->'lines') not between 1 and 250 or x->'lines'->0<>x->'row' or jsonb_typeof(x->'data')<>'object')
  or(select count(distinct x->>'row') from jsonb_array_elements(p_rows) x)<>jsonb_array_length(p_rows) then
  raise exception 'erp_preferences_import_invalid' using errcode='22023'; end if;
 if not p_dry_run then
  v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-import-v1','actor',p_user_id,'kind',p_kind,'job',p_job_id,'file',p_file_name,'total',p_total_rows,'items',p_rows)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended('erp-import-command:'||p_command_id::text,0));
  select * into v_command from erp_preferences.import_command where command_id=p_command_id;
  if found then
   if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_preferences_import_command_conflict' using errcode='40001'; end if;
   return v_command.result||jsonb_build_object('replayed',true,'job',erp_preferences.import_job_dto(v_command.job_id));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('erp-import-job:'||p_job_id::text,0));
  select * into v_job from erp_preferences.import_job where id=p_job_id for update;
  if not found then
   insert into erp_preferences.import_job(id,kind,actor,file_name,total_rows) values(p_job_id,p_kind,p_user_id,p_file_name,p_total_rows) returning * into v_job;
  elsif v_job.actor<>p_user_id then raise exception 'erp_preferences_import_job_denied' using errcode='42501';
  elsif v_job.kind<>p_kind or v_job.file_name<>p_file_name or v_job.total_rows<>p_total_rows then raise exception 'erp_preferences_import_job_mismatch' using errcode='22023';
  elsif v_job.status='concluida' then raise exception 'erp_preferences_import_job_finished' using errcode='40001';
  end if;
 end if;
 for v_item in select x from jsonb_array_elements(p_rows) x order by (x->>'row')::integer loop
  v_row:=(v_item->>'row')::integer; v_out:=null; v_reason:=null;
  if not p_dry_run then
   select * into v_done from erp_preferences.import_row where job_id=p_job_id and row=v_row;
   -- A line already imported in this file answers its recorded result and is never sent to the module again.
   if found then v_items:=v_items||jsonb_build_array(erp_preferences.import_row_dto(v_done)); continue; end if;
  end if;
  begin
   v_out:=erp_preferences.import_item(p_user_id,p_kind,erp_preferences.import_item_command(v_seed,v_row),p_file_name,v_item->'data');
   if p_dry_run then raise exception 'erp_preferences_import_dry_run' using errcode='P0001'; end if;
  exception when sqlstate 'P0001' or sqlstate '22023' or sqlstate '22P02' or sqlstate '22003' or sqlstate '22007' or sqlstate '22008' or sqlstate '22001'
   or sqlstate '23505' or sqlstate '23503' or sqlstate '23502' or sqlstate '23514' or sqlstate 'P0002' or sqlstate '40001' then
   get stacked diagnostics v_message=message_text,v_state=returned_sqlstate;
   if v_message<>'erp_preferences_import_dry_run' then v_reason:=erp_preferences.import_reason(v_message,v_state); end if;
  end;
  v_action:=v_out->>'action';
  v_status:=case when v_reason is not null then 'invalid' when p_dry_run then 'valid' when v_action='create' then 'created' when (v_out->>'unchanged')::boolean then 'unchanged' else 'updated' end;
  v_entry:=jsonb_build_object('row',v_row,'status',v_status,'action',case when v_reason is null then v_action end,'reason',v_reason,
   'field',case when v_reason is not null then erp_preferences.import_field(v_reason) end,
   'record_id',case when v_status in('created','updated','unchanged') then v_out->>'record_id' end,
   'reference',case when v_reason is null and not p_dry_run then nullif(left(regexp_replace(v_out->>'reference','[[:cntrl:]]',' ','g'),120),'') end);
  v_items:=v_items||jsonb_build_array(v_entry);
  if not p_dry_run then
   insert into erp_preferences.import_row(job_id,row,lines,command_id,status,action,reason,field,record_id,reference)
    values(p_job_id,v_row,array(select jsonb_array_elements_text(v_item->'lines')::integer),p_command_id,v_status,v_entry->>'action',v_reason,v_entry->>'field',
     (v_entry->>'record_id')::uuid,v_entry->>'reference');
   v_new:=v_new+1;
   case v_status when 'created' then v_created:=v_created+1; when 'updated' then v_updated:=v_updated+1; when 'unchanged' then v_unchanged:=v_unchanged+1; else v_invalid:=v_invalid+1; end case;
  end if;
 end loop;
 -- The role may have changed while a lock was awaited: a refusal here undoes the whole batch before the receipt.
 perform erp_preferences.import_require_admin(p_user_id);
 if not p_dry_run then
  if v_job.rows_done+v_new>v_job.total_rows then raise exception 'erp_preferences_import_total_exceeded' using errcode='22023'; end if;
  update erp_preferences.import_job set rows_done=rows_done+v_new,created=created+v_created,updated=updated+v_updated,unchanged=unchanged+v_unchanged,invalid=invalid+v_invalid,
   status=case when rows_done+v_new=total_rows then 'concluida' else status end,finished_at=case when rows_done+v_new=total_rows then clock_timestamp() end,updated_at=clock_timestamp()
   where id=p_job_id;
 end if;
 v_result:=jsonb_build_object('scope','import_batch','data_mode','erp_native','kind',p_kind,'dry_run',p_dry_run,'replayed',false,
  'job',case when p_dry_run then null else erp_preferences.import_job_dto(p_job_id) end,'items',v_items);
 if not p_dry_run then
  insert into erp_preferences.import_command(command_id,actor,job_id,request_hash,result) values(p_command_id,p_user_id,p_job_id,v_hash,v_result-'job');
 end if;
 return v_result;
end $$;

revoke all on function erp_preferences.import_item_lot(uuid,uuid,jsonb),erp_preferences.import_item(uuid,text,uuid,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.erp_preferences_import_batch(uuid,uuid,uuid,text,text,integer,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.erp_preferences_import_batch(uuid,uuid,uuid,text,text,integer,boolean,jsonb) to service_role;
commit;
