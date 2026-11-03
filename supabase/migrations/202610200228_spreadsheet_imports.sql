-- 228: Importações de Dados por planilha (Preferências › Importações de Dados) e Consultar gestão de ações.
-- * O navegador lê a planilha, relaciona as colunas e valida cada célula (packages/erp-domain/src/spreadsheet-import.mjs); o
--   Worker aceita só valores canônicos; aqui cada item passa pela RPC do próprio módulo, com as mesmas regras da tela:
--   produtos (erp_catalog_product_save), contatos (erp_catalog_contact_save), pedidos de compra e de venda
--   (erp_document_save), movimentações de estoque (erp_stock_post), contas a receber e a pagar (erp_finance_title_execute) e notas
--   fiscais em lote (erp_fiscal_invoice_execute: rascunhos de NF-e de saída em homologação, sem número nem envio).
-- * Validar (dry run) executa cada item num subtransação e a desfaz: a prévia usa as regras reais e não grava nada.
-- * Importar grava por lote: um command_id por lote (o mesmo comando devolve o mesmo resultado; outro corpo é recusado), cada
--   item recebe um command_id derivado do lote e da linha, e uma linha já registrada no arquivo (job) nunca é importada de novo.
--   Linhas recusadas ficam no resultado com o motivo; as demais do lote são gravadas.
-- * O arquivo (job) guarda tipo, arquivo, total, contadores e situação, e cada linha o resultado: é a tela "Consultar gestão de
--   ações" do menu do usuário. Importar é só do administrador; ver as ações é de qualquer usuário ativo (as próprias; o
--   administrador vê todas).
-- * Tabelas novas, nenhuma função de outra frente redefinida.
begin;

create table erp_preferences.import_job(
 id uuid primary key,
 kind text not null check(kind in('products','contacts','purchase_orders','stock_movements','receivables','payables','sales_orders','nfe')),
 actor uuid not null references auth.users(id),
 file_name text not null check(length(file_name) between 1 and 200 and file_name!~'[[:cntrl:]]' and btrim(file_name)=file_name),
 total_rows integer not null check(total_rows between 1 and 10000),
 rows_done integer not null default 0,created integer not null default 0,updated integer not null default 0,unchanged integer not null default 0,invalid integer not null default 0,
 status text not null default 'em_andamento' check(status in('em_andamento','concluida')),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 check(least(created,updated,unchanged,invalid)>=0 and rows_done=created+updated+unchanged+invalid and rows_done<=total_rows),
 check((status='concluida')=(finished_at is not null) and(status='em_andamento' or rows_done=total_rows))
);
create index erp_preferences_import_job_actor on erp_preferences.import_job(actor,created_at desc,id);
create index erp_preferences_import_job_created on erp_preferences.import_job(created_at desc,id);
create table erp_preferences.import_row(
 job_id uuid not null references erp_preferences.import_job(id),
 row integer not null check(row between 2 and 10001),
 lines integer[] not null check(cardinality(lines) between 1 and 250 and lines[1]=row),
 command_id uuid not null,
 status text not null check(status in('created','updated','unchanged','invalid')),
 action text check(action in('create','update')),
 reason text check(reason~'^erp_[a-z0-9_]{1,80}(:[a-z0-9_]{1,40})?$'),
 field text check(field~'^[a-z_]{1,40}$'),
 record_id uuid,
 reference text check(length(reference) between 1 and 120),
 created_at timestamptz not null default clock_timestamp(),
 primary key(job_id,row),
 check((status='invalid')=(reason is not null) and(status<>'invalid' or record_id is null) and(status in('invalid','unchanged') or record_id is not null)
  and(status<>'created' or action='create') and(status not in('updated','unchanged') or action='update'))
);
create table erp_preferences.import_command(
 command_id uuid primary key,
 actor uuid not null references auth.users(id),
 job_id uuid not null references erp_preferences.import_job(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create index erp_preferences_import_command_job on erp_preferences.import_command(job_id);
create trigger immutable_import_row before update or delete on erp_preferences.import_row for each row execute function erp_preferences.immutable_history();
create trigger immutable_import_command before update or delete on erp_preferences.import_command for each row execute function erp_preferences.immutable_history();
-- A job only moves forward: the same identity, counters that never decrease and a finished job that stays finished.
create function erp_preferences.guard_import_job() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' or tg_op='UPDATE' and(new.id<>old.id or new.kind<>old.kind or new.actor<>old.actor or new.file_name<>old.file_name or new.total_rows<>old.total_rows
  or new.created_at<>old.created_at or new.rows_done<old.rows_done or new.created<old.created or new.updated<old.updated or new.unchanged<old.unchanged or new.invalid<old.invalid
  or old.status='concluida') then raise exception 'erp_preferences_import_job_immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger guard_import_job before update or delete on erp_preferences.import_job for each row execute function erp_preferences.guard_import_job();
do $$declare t text;begin foreach t in array array['import_job','import_row','import_command'] loop
 execute format('alter table erp_preferences.%I enable row level security',t);
 execute format('revoke all on erp_preferences.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

create function erp_preferences.import_require_admin(p_user_id uuid) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_user_id is null or not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin') then
  raise exception 'erp_preferences_import_denied' using errcode='42501'; end if;
end $$;
-- Command of one item: derived from the batch command and the first line, so the module RPC sees one stable command per item.
create function erp_preferences.import_item_command(p_command uuid,p_row integer) returns uuid language sql immutable set search_path=pg_catalog as $$
 select md5('erp-import-item:'||p_command::text||':'||p_row::text)::uuid
$$;
create function erp_preferences.import_fail(p_reason text,p_state text default '22023') returns void language plpgsql set search_path=pg_catalog as $$
begin raise exception '%',p_reason using errcode=p_state; end $$;

-- ---- Lookups by the names and documents of the sheet (unique, active; otherwise the line says why) ----
create function erp_preferences.import_contact(p_name text,p_document text,p_field_name text,p_field_document text) returns uuid language plpgsql stable set search_path=pg_catalog as $$
declare v uuid[];
begin
 if p_document is not null then
  select array_agg(r.id order by r.id) into v from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id
   left join erp_catalog.contact_profile p on p.record_id=r.id
   where r.entity='contacts' and coalesce(p.situation,'A')<>'E' and erp_catalog.compact(c.document)=p_document;
  if cardinality(v)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:'||p_field_document); end if;
  if v is null then perform erp_preferences.import_fail('erp_preferences_import_not_found:'||p_field_document); end if;
  return v[1];
 end if;
 select array_agg(r.id order by r.id) into v from erp_catalog.record r left join erp_catalog.contact_profile p on p.record_id=r.id
  where r.entity='contacts' and coalesce(p.situation,'A')<>'E' and lower(btrim(r.name))=lower(btrim(p_name));
 if cardinality(v)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:'||p_field_name); end if;
 if v is null then perform erp_preferences.import_fail('erp_preferences_import_not_found:'||p_field_name); end if;
 return v[1];
end $$;
create function erp_preferences.import_product(p_code text,p_field text,p_required boolean) returns uuid language plpgsql stable set search_path=pg_catalog as $$
declare v uuid[];
begin
 select array_agg(r.id order by r.id) into v from erp_catalog.record r where r.entity='products' and r.code=p_code
  and not exists(select 1 from erp_catalog.product_detail d where d.record_id=r.id and d.deleted_at is not null);
 if cardinality(v)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:'||p_field); end if;
 if v is null and p_required then perform erp_preferences.import_fail('erp_preferences_import_not_found:'||p_field); end if;
 return v[1];
end $$;
create function erp_preferences.import_named(p_kind text,p_name text,p_field text,p_title_kind text default null) returns uuid language plpgsql stable set search_path=pg_catalog as $$
declare v uuid[];
begin
 if p_name is null then return null; end if;
 case p_kind
  when 'categories','product_groups' then select array_agg(t.id order by t.id) into v from erp_catalog.taxonomy t where t.kind=p_kind and lower(btrim(t.name))=lower(btrim(p_name));
  when 'warehouses' then select array_agg(r.id order by r.id) into v from erp_catalog.record r where r.entity='warehouses' and r.active and lower(btrim(r.name))=lower(btrim(p_name));
  when 'finance_categories' then select array_agg(c.id order by c.id) into v from erp_finance.category c
   where c.active and c.deleted_at is null and c.kind in(p_title_kind,'both') and lower(btrim(c.name))=lower(btrim(p_name));
  when 'accounts' then select array_agg(a.id order by a.id) into v from erp_finance.account a where a.active and a.deleted_at is null and lower(btrim(a.name))=lower(btrim(p_name));
  when 'payment_methods' then select array_agg(m.id order by m.id) into v from erp_catalog.payment_method m where m.active and m.deleted_at is null
   and m.applicable in('ambos',case when p_title_kind='receivable' then 'recebimentos' else 'pagamentos' end) and lower(btrim(m.description))=lower(btrim(p_name));
 end case;
 if cardinality(v)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:'||p_field); end if;
 if v is null then perform erp_preferences.import_fail('erp_preferences_import_not_found:'||p_field); end if;
 return v[1];
end $$;

-- ---- One item through the module RPC. Returns {action, record_id, reference, unchanged}; a refusal raises. ----
create function erp_preferences.import_item(p_user_id uuid,p_kind text,p_command uuid,p_file text,p_data jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_id uuid; v_version integer; v_patch jsonb; v_res jsonb; v_origin text; v_items jsonb:='[]'::jsonb; v_item jsonb; v_product uuid; v_line integer:=0;
 v_body jsonb; v_wh uuid; v_qty numeric; v_balance numeric; v_bversion integer; v_kind text; v_cents bigint; v_reason text; v_doc text; v_ids uuid[];
 v_contact erp_catalog.contact%rowtype; v_profile erp_catalog.contact_profile%rowtype; v_nature erp_fiscal_invoices.nature%rowtype; v_crt text; v_series text; v_person text; v_name text; v_text text;
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
  v_res:=public.erp_catalog_product_save(p_user_id,v_id,v_version,p_command,v_patch,null);
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
 perform erp_preferences.import_fail('erp_preferences_import_kind_invalid');
 return null;
end $$;

-- Error of one item → reason (identifier of the refusal, never user text) and the field when the identifier names one.
create function erp_preferences.import_reason(p_message text,p_state text) returns text language sql immutable set search_path=pg_catalog as $$
 select case when p_message~'^erp_[a-z0-9_]{1,80}(:[a-z0-9_]{1,40})?$' then p_message
  when p_state='23505' then 'erp_preferences_import_duplicate' when p_state='40001' then 'erp_preferences_import_conflict'
  when p_state='P0002' then 'erp_preferences_import_not_found' else 'erp_preferences_import_refused' end
$$;
-- Only a field name the import_row check accepts: a suffix with other characters (a module may name an item, such as item_2)
-- stays in the reason and the line keeps no field, instead of refusing the whole batch.
create function erp_preferences.import_field(p_reason text) returns text language sql immutable set search_path=pg_catalog as $$
 select case when p_reason like '%:%' then case when split_part(p_reason,':',2)~'^[a-z_]{1,40}$' then split_part(p_reason,':',2) end
  when p_reason in('erp_catalog_name_required') then 'name' end
$$;

create function erp_preferences.import_job_dto(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',j.id,'kind',j.kind,'file_name',j.file_name,'total_rows',j.total_rows,'rows_done',j.rows_done,'created',j.created,'updated',j.updated,
  'unchanged',j.unchanged,'invalid',j.invalid,'status',j.status,'actor',jsonb_build_object('user_id',j.actor,'label',erp_activity.actor_label(j.actor)),
  'created_at',j.created_at,'updated_at',j.updated_at,'finished_at',j.finished_at)
 from erp_preferences.import_job j where j.id=p_id
$$;
create function erp_preferences.import_row_dto(r erp_preferences.import_row) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('row',r.row,'status',r.status,'action',r.action,'reason',r.reason,'field',r.field,'record_id',r.record_id,'reference',r.reference)
$$;

create function public.erp_preferences_import_batch(p_user_id uuid,p_command_id uuid,p_job_id uuid,p_kind text,p_file_name text,p_total_rows integer,p_dry_run boolean,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_preferences.import_command%rowtype; v_job erp_preferences.import_job%rowtype; v_item jsonb; v_row integer; v_done erp_preferences.import_row%rowtype;
 v_out jsonb; v_message text; v_state text; v_reason text; v_result jsonb; v_items jsonb:='[]'::jsonb; v_seed uuid:=coalesce(p_command_id,gen_random_uuid());
 v_new integer:=0; v_created integer:=0; v_updated integer:=0; v_unchanged integer:=0; v_invalid integer:=0; v_status text; v_action text; v_entry jsonb;
begin
 perform erp_preferences.import_require_admin(p_user_id);
 if p_kind is null or p_kind not in('products','contacts','purchase_orders','stock_movements','receivables','payables','sales_orders','nfe') or p_dry_run is null
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

-- Consultar gestão de ações: the user's own jobs (the administrador sees every user's), newest first.
create function public.erp_preferences_import_jobs(p_user_id uuid,p_status text,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_admin boolean; v_total integer; v_items jsonb;
begin
 select role='admin' into v_admin from erp_access.membership where user_id=p_user_id and active;
 if p_user_id is null or v_admin is null then raise exception 'erp_preferences_import_denied' using errcode='42501'; end if;
 if p_status is not null and p_status not in('em_andamento','concluida') or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000 then
  raise exception 'erp_preferences_import_invalid' using errcode='22023'; end if;
 select count(*) into v_total from erp_preferences.import_job j where(v_admin or j.actor=p_user_id) and(p_status is null or j.status=p_status);
 select coalesce(jsonb_agg(erp_preferences.import_job_dto(x.id) order by x.created_at desc,x.id),'[]'::jsonb) into v_items
  from(select j.id,j.created_at from erp_preferences.import_job j where(v_admin or j.actor=p_user_id) and(p_status is null or j.status=p_status)
   order by j.created_at desc,j.id limit p_limit offset p_offset) x;
 return jsonb_build_object('scope','import_jobs','data_mode','erp_native','status',p_status,'limit',p_limit,'offset',p_offset,'total',v_total,
  'has_more',p_offset+jsonb_array_length(v_items)<v_total,'all_users',v_admin,'items',v_items);
end $$;
create function public.erp_preferences_import_job(p_user_id uuid,p_job_id uuid,p_errors boolean,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_admin boolean; v_total integer; v_items jsonb;
begin
 select role='admin' into v_admin from erp_access.membership where user_id=p_user_id and active;
 if p_user_id is null or v_admin is null then raise exception 'erp_preferences_import_denied' using errcode='42501'; end if;
 if p_job_id is null or p_errors is null or p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset not between 0 and 10000 then
  raise exception 'erp_preferences_import_invalid' using errcode='22023'; end if;
 if not exists(select 1 from erp_preferences.import_job j where j.id=p_job_id and(v_admin or j.actor=p_user_id)) then
  raise exception 'erp_preferences_import_job_not_found' using errcode='P0002'; end if;
 select count(*) into v_total from erp_preferences.import_row r where r.job_id=p_job_id and(not p_errors or r.status='invalid');
 select coalesce(jsonb_agg(erp_preferences.import_row_dto(x) order by x.row),'[]'::jsonb) into v_items
  from(select * from erp_preferences.import_row r where r.job_id=p_job_id and(not p_errors or r.status='invalid') order by r.row limit p_limit offset p_offset) x;
 return jsonb_build_object('scope','import_job','data_mode','erp_native','job',erp_preferences.import_job_dto(p_job_id),'errors',p_errors,'limit',p_limit,'offset',p_offset,
  'total',v_total,'has_more',p_offset+jsonb_array_length(v_items)<v_total,'items',v_items);
end $$;

revoke all on function erp_preferences.guard_import_job(),erp_preferences.import_require_admin(uuid),erp_preferences.import_item_command(uuid,integer),erp_preferences.import_fail(text,text),
 erp_preferences.import_contact(text,text,text,text),erp_preferences.import_product(text,text,boolean),erp_preferences.import_named(text,text,text,text),
 erp_preferences.import_item(uuid,text,uuid,text,jsonb),erp_preferences.import_reason(text,text),erp_preferences.import_field(text),erp_preferences.import_job_dto(uuid),
 erp_preferences.import_row_dto(erp_preferences.import_row) from public,anon,authenticated,service_role;
do $$declare f text;begin foreach f in array array['erp_preferences_import_batch(uuid,uuid,uuid,text,text,integer,boolean,jsonb)',
  'erp_preferences_import_jobs(uuid,text,integer,integer)','erp_preferences_import_job(uuid,uuid,boolean,integer,integer)'] loop
 execute format('revoke all on function public.%s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function public.%s to service_role',f);
end loop;end$$;
commit;
