-- 217: "Importar XML NF-e" de entrada (Importação de XML de entrada, X) com o cadastro de produtos, onda D.
-- 1. Item do fornecedor: depois do GTIN (143), o código do produto no fornecedor (Fornecedores do cadastro de produtos, 119) também
--    liga o item, quando o remetente é um contato do cadastro e um só produto ativo tem esse código para ele.
-- 2. Preferências › Cadastros › Produtos "Cadastrar automaticamente produtos a partir de compras (entradas)": o item que ficou sem
--    produto vira um produto do cadastro (descrição, código quando livre, unidade, NCM, GTIN quando nenhum outro produto o usa,
--    CEST e origem) com o remetente como fornecedor padrão (código, descrição e preço de custo do item), no mesmo comando, pela
--    gravação do cadastro (erp_catalog_product_save, com auditoria e versão).
-- 3. Preferências › Configurações de NF-e "Automatização de atualização de dados" (NCM, GTIN, CEST, Descrição do fornecedor): o
--    produto ligado ao item recebe os valores do XML que mudaram, pela mesma gravação do cadastro, com a versão atual.
-- As duas automações valem só para quem cadastra produtos (administrador; o fiscal importa sem elas) e nunca impedem a importação:
-- um produto que o cadastro recusa (por exemplo, um GTIN inválido) fica para "Conciliar produtos" e é contado no resultado
-- (created_products, updated_products, product_failures). Nada aqui emite, transmite ou lança estoque/contas.
-- Requer as migrações publicadas até 202610200190 (143 e o cadastro de produtos de 119, com a gravação atual de 156).
begin;

do $$declare v record;begin
 if to_regclass('erp_catalog.product_supplier') is null or to_regprocedure('public.erp_catalog_product_save(uuid,uuid,integer,uuid,jsonb,jsonb)') is null
  or to_regprocedure('erp_catalog.product_detail_data(uuid,boolean)') is null then raise exception 'fiscal_import_217_requires_119' using errcode='55000'; end if;
 for v in select * from(values
  ('public.erp_fiscal_invoice_import(uuid,uuid,jsonb)','1ccba0e51c085f5ade111f04a87d22da899d90ed697551897153e955965d7a93'))v(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'fiscal_import_217_previous_definition_changed' using errcode='55000',detail=v.sig; end if;
 end loop;
end$$;

-- The one active product whose supplier row of this contact carries the code, or null.
create function erp_fiscal_invoices.supplier_product(p_supplier uuid,p_code text) returns uuid language sql stable set search_path=pg_catalog as $$
 select case when count(distinct s.record_id)=1 then min(s.record_id::text)::uuid end from erp_catalog.product_supplier s join erp_catalog.record r on r.id=s.record_id
 where p_supplier is not null and p_code is not null and s.supplier_id=p_supplier and s.code=p_code and r.entity='products' and r.active
$$;

-- "Cadastrar automaticamente produtos a partir de compras": a product from a free item of the entry note, or null when the catalog
-- refuses it (the item stays for "Conciliar produtos").
create function erp_fiscal_invoices.import_new_product(p_user_id uuid,p_command uuid,p_item jsonb,p_supplier uuid) returns uuid language plpgsql set search_path=pg_catalog as $$
declare v_code text:=nullif(btrim(coalesce(p_item->>'code','')),'');v_gtin text:=p_item->>'gtin';v_data jsonb;v_saved jsonb;
begin
 if v_code is not null and exists(select 1 from erp_catalog.record r where r.entity='products' and r.code=v_code) then v_code:=null; end if;
 if v_gtin is null or v_gtin='SEM GTIN' or exists(select 1 from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where p.gtin=v_gtin and r.entity='products') then v_gtin:=null; end if;
 v_data:=jsonb_strip_nulls(jsonb_build_object('name',left(p_item->>'description',200),'code',left(v_code,100),'unit',left(p_item->>'unit',16),'kind','P','format','S',
  'ncm',case when p_item->>'ncm' ~ '^[0-9]{8}$' then p_item->>'ncm' end,'gtin',v_gtin,'cest',case when p_item->>'cest' ~ '^[0-9]{7}$' then p_item->>'cest' end,
  'origin',case when p_item#>>'{icms,origin}' ~ '^[0-8]$' then p_item#>>'{icms,origin}' end));
 if p_supplier is not null then
  v_data:=v_data||jsonb_build_object('suppliers',jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('supplier_id',p_supplier,'code',left(p_item->>'code',60),
   'description',left(p_item->>'description',120),'cost_price',p_item->>'unit_price'))||'{"is_default":true}'::jsonb));
 end if;
 begin
  v_saved:=public.erp_catalog_product_save(p_user_id,null,0,md5('fiscal-import-product:'||p_command::text||':'||(p_item->>'position'))::uuid,v_data);
  return (v_saved#>>'{record,id}')::uuid;
 exception when others then return null;
 end;
end $$;

-- "Automatização de atualização de dados" for a product linked to an item of the entry note: the changed NCM, GTIN, CEST and the
-- description of the item in the supplier row. Returns 1 updated, 0 unchanged, -1 refused by the catalog (the note still imports).
create function erp_fiscal_invoices.import_update_product(p_user_id uuid,p_command uuid,p_item jsonb,p_supplier uuid,p_flags jsonb) returns integer language plpgsql set search_path=pg_catalog as $$
declare v_id uuid:=(p_item->>'product_id')::uuid;v_row erp_catalog.record%rowtype;p erp_catalog.product%rowtype;v_patch jsonb:='{}';v_suppliers jsonb;v_found boolean:=false;v_list jsonb:='[]';s jsonb;
begin
 select * into v_row from erp_catalog.record where id=v_id and entity='products';
 if not found then return 0; end if;
 select * into p from erp_catalog.product where record_id=v_id;
 if (p_flags->>'ncm')::boolean and p_item->>'ncm' ~ '^[0-9]{8}$' and p_item->>'ncm' is distinct from p.ncm then v_patch:=v_patch||jsonb_build_object('ncm',p_item->>'ncm'); end if;
 if (p_flags->>'gtin')::boolean and p_item->>'gtin' ~ '^([0-9]{8}|[0-9]{12,14})$' and p_item->>'gtin' is distinct from p.gtin then v_patch:=v_patch||jsonb_build_object('gtin',p_item->>'gtin'); end if;
 if (p_flags->>'cest')::boolean and p_item->>'cest' ~ '^[0-9]{7}$' and p_item->>'cest' is distinct from p.cest then v_patch:=v_patch||jsonb_build_object('cest',p_item->>'cest'); end if;
 if (p_flags->>'supplier_description')::boolean and p_supplier is not null and nullif(btrim(coalesce(p_item->>'description','')),'') is not null then
  v_suppliers:=coalesce(erp_catalog.product_detail_data(v_id,false)->'suppliers','[]'::jsonb);
  for s in select value from jsonb_array_elements(v_suppliers) loop
   if s->>'supplier_id'=p_supplier::text then
    v_found:=true;
    if s->>'description' is distinct from left(p_item->>'description',120) then s:=s||jsonb_build_object('description',left(p_item->>'description',120)); end if;
   end if;
   v_list:=v_list||jsonb_build_array(s);
  end loop;
  if not v_found and jsonb_array_length(v_list)<20 then
   v_list:=v_list||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('supplier_id',p_supplier,'code',left(p_item->>'code',60),'description',left(p_item->>'description',120)))
    ||jsonb_build_object('is_default',jsonb_array_length(v_list)=0));
  end if;
  if v_list is distinct from v_suppliers then v_patch:=v_patch||jsonb_build_object('suppliers',v_list); end if;
 end if;
 if v_patch='{}'::jsonb then return 0; end if;
 begin
  perform public.erp_catalog_product_save(p_user_id,v_id,v_row.version,md5('fiscal-import-update:'||p_command::text||':'||(p_item->>'position'))::uuid,v_patch);
  return 1;
 exception when others then return -1;
 end;
end $$;

-- 143 plus the supplier code, the automatic products and the automatic update of the product cadastro (entry notes only).
create or replace function public.erp_fiscal_invoice_import(p_user_id uuid,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;company text;candidate jsonb;issue text;d jsonb;v_id uuid;existing uuid;rec jsonb;result jsonb;items jsonb:='[]';item jsonb;product uuid;matched integer:=0;
 contact uuid;xml text;received timestamptz;products_writable boolean;auto_create boolean;flags jsonb;created integer:=0;updated integer:=0;failures integer:=0;outcome integer;
begin
 role:=erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_data is null or jsonb_typeof(p_data)<>'object'
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in('xml','sha256','size','key','signed','emitter_document','recipient_document','protocol','as_emitter','as_recipient'))
  or not p_data ?& array['xml','sha256','size','key','signed','emitter_document','recipient_document','protocol','as_emitter','as_recipient']
  or jsonb_typeof(p_data->'xml')<>'string' or jsonb_typeof(p_data->'sha256')<>'string' or jsonb_typeof(p_data->'size')<>'number' or jsonb_typeof(p_data->'signed')<>'boolean'
  or jsonb_typeof(p_data->'key')<>'string' or not erp_fiscal_invoices.access_key_valid(p_data->>'key') or substring(p_data->>'key',21,2)<>'55'
  or jsonb_typeof(p_data->'protocol')<>'object' or p_data#>>'{protocol,number}' !~ '^[0-9]{15}$' or p_data#>>'{protocol,status}' not in('100','150')
  or (p_data->>'emitter_document') !~ '^([0-9]{11}|[0-9]{14})$' or (jsonb_typeof(p_data->'recipient_document')<>'null' and (p_data->>'recipient_document') !~ '^([0-9]{11}|[0-9]{14})$')
  or jsonb_typeof(p_data->'as_emitter') not in('object','null') or jsonb_typeof(p_data->'as_recipient') not in('object','null') then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 xml:=p_data->>'xml';
 if octet_length(convert_to(xml,'UTF8'))<>(p_data->>'size')::integer or (p_data->>'size')::integer>1048576
  or encode(sha256(convert_to(xml,'UTF8')),'hex')<>p_data->>'sha256' or strpos(xml,'NFe'||(p_data->>'key'))=0 then
  raise exception 'erp_fiscal_import_xml_mismatch' using errcode='22023'; end if;
 begin received:=(p_data#>>'{protocol,received_at}')::timestamptz; exception when others then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end;
 h:=erp_fiscal_invoices.command_hash(p_user_id,'invoice','import',p_data-'xml');
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'invoice',h);
 if replay is not null then return replay; end if;
 -- Which side of the XML is the company decides the type; an XML of other companies is not imported.
 company:=erp_fiscal_invoices.company_document();
 if company is null then return jsonb_build_object('imported',false,'refused','company_missing','invoice_id',null,'data_mode','erp_native'); end if;
 if p_data->>'emitter_document'=company then candidate:=p_data->'as_emitter';issue:=case when candidate->>'direction'='1' then 'S' else 'X' end;
 elsif p_data->>'recipient_document'=company then candidate:=p_data->'as_recipient';issue:='X';
 else return jsonb_build_object('imported',false,'refused','other_company','invoice_id',null,'data_mode','erp_native'); end if;
 -- The Worker sends null for a reading the field contract cannot hold (for example, an XML without recipient).
 if jsonb_typeof(candidate)='null' then return jsonb_build_object('imported',false,'refused','xml_unsupported','invoice_id',null,'data_mode','erp_native'); end if;
 if candidate->>'access_key' is distinct from p_data->>'key' or candidate->>'issue_type' is distinct from 'T' then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(174852943,hashtext(p_data->>'key'));
 select id into existing from erp_fiscal_invoices.invoice where access_key=p_data->>'key' and deleted_at is null;
 if existing is not null then return jsonb_build_object('imported',false,'refused','duplicate','invoice_id',existing,'data_mode','erp_native'); end if;
 -- Same validation as "Emitida por Terceiros" (number and key checked against model and series), stored as S or X.
 d:=erp_fiscal_invoices.invoice_input(candidate);
 d:=jsonb_set(d,'{issue_type}',to_jsonb(issue));
 contact:=erp_fiscal_invoices.unique_contact(d#>>'{recipient,document}');
 -- 217: the catalog automations of entry notes, for the profiles that write products.
 products_writable:=issue='X' and p_data->>'emitter_document'<>company and erp_catalog.allowed(role,'products',true);
 auto_create:=products_writable and (erp_fiscal_invoices.preference('produtos.cadastro_auto_compras','boolean','false'))::text::boolean;
 flags:=jsonb_build_object('ncm',erp_fiscal_invoices.preference('nfe.atualizar_ncm','boolean','false'),'gtin',erp_fiscal_invoices.preference('nfe.atualizar_gtin','boolean','false'),
  'cest',erp_fiscal_invoices.preference('nfe.atualizar_cest','boolean','false'),'supplier_description',erp_fiscal_invoices.preference('nfe.atualizar_descricao_fornecedor','boolean','false'));
 if not products_writable then flags:='{"ncm":false,"gtin":false,"cest":false,"supplier_description":false}'::jsonb; end if;
 for item in select value||jsonb_build_object('position',ordinality) from jsonb_array_elements(d->'items') with ordinality loop
  if not item?'product_id' then
   product:=case when issue='S' or p_data->>'emitter_document'=company then erp_fiscal_invoices.unique_product(item->>'code',null) else erp_fiscal_invoices.unique_product(null,item->>'gtin') end;
   -- 217: the code of the product at this supplier (Fornecedores of the product cadastro).
   if product is null and issue='X' and p_data->>'emitter_document'<>company then product:=erp_fiscal_invoices.supplier_product(contact,nullif(btrim(coalesce(item->>'code','')),'')); end if;
   if product is not null then item:=item||jsonb_build_object('product_id',product);matched:=matched+1;
    outcome:=erp_fiscal_invoices.import_update_product(p_user_id,p_command_id,item,contact,flags);
    if outcome=1 then updated:=updated+1; elsif outcome<0 then failures:=failures+1; end if;
   elsif auto_create then
    product:=erp_fiscal_invoices.import_new_product(p_user_id,p_command_id,item,contact);
    if product is null then failures:=failures+1; else item:=item||jsonb_build_object('product_id',product);matched:=matched+1;created:=created+1; end if;
   end if;
  else matched:=matched+1; end if;
  items:=items||jsonb_build_array(item-'position');
 end loop;
 if contact is not null and not (d->'recipient')?'contact_id' then d:=jsonb_set(d,'{recipient,contact_id}',to_jsonb(contact)); end if;
 insert into erp_fiscal_invoices.invoice(model,direction,issue_type,environment,status,series,number,access_key,protocol,authorized_at,nature_id,nature_description,cfop,issue_date,exit_date,exit_time,
  crt,purpose,credit_debit_type,presence,final_consumer,recipient,export,import_declaration,doc_references,transport,payment,authorized_xml,intermediary,additional_info,
  nature_additional_info,nature_fiscal_info,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by)
 values(d->>'model',d->>'direction',issue,null,8,(d->>'series')::integer,(d->>'number')::integer,d->>'access_key',p_data#>>'{protocol,number}',received,
  null,d->>'nature_description',d->>'cfop',(d->>'issue_date')::date,(d->>'exit_date')::date,d->>'exit_time',d->>'crt',d->>'purpose',d->>'credit_debit_type',
  d->>'presence',(d->>'final_consumer')::boolean,d->'recipient',null,null,d->'references',d->'transport',d->'payment',d->'authorized_xml',d->'intermediary',d->>'additional_info',
  d->>'nature_additional_info',d->>'nature_fiscal_info',false,(d->>'freight')::numeric,(d->>'insurance')::numeric,(d->>'other_expenses')::numeric,(d->>'discount')::numeric,d->'totals',p_user_id,p_user_id)
 returning id into v_id;
 perform erp_fiscal_invoices.store_items(v_id,items);
 insert into erp_fiscal_invoices.invoice_xml(invoice_id,sha256,size,content,signed,protocol_status,imported_by) values(v_id,p_data->>'sha256',(p_data->>'size')::integer,xml,(p_data->>'signed')::boolean,p_data#>>'{protocol,status}',p_user_id);
 rec:=erp_fiscal_invoices.invoice_record(v_id);
 insert into erp_fiscal_invoices.invoice_revision(invoice_id,version,record) values(v_id,1,rec);
 result:=erp_fiscal_invoices.invoice_envelope(rec,role)||jsonb_build_object('action','import','replayed',false,'imported',true,'matched_items',matched,'contact_matched',contact is not null,
  'created_products',created,'updated_products',updated,'product_failures',failures);
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'invoice',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'invoice',v_id,1,'import',p_data->>'key');
 return result;
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_invoice_import(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_import(uuid,uuid,jsonb) to service_role;
commit;
