-- 274 (notas fiscais lane, wave F): "Importar XML" of the NFC-e and the signature of the imported XML.
-- 1. NFC-e (model 65): an authorized NFC-e of the company (the company is the emitter) is registered like the NF-e of 143/217, as
--    "Importação de XML de saída" (S), situação Registrada, with the key, the protocol and the XML kept for "Baixar XML". It is checked by
--    the rules of the NFC-e (consumidor final, presença 1 or 4, destinatário optional) and keeps the number and the key of the XML, which
--    must agree with each other. An NFC-e of another company with the company as consumer is refused ("nfce_recipient"): the consumer note
--    is not a purchase note. The table accepts model 65 with S from now on (C stays only for the NFC-e of the Brufap).
-- 2. Signature: the Worker checks the XMLDSig signature of infNFe, the digVal of the protocol and the CNPJ base of the certificate before
--    calling here and says so in protocol.signature_verified (inside the protocol object, which the import before 274 already accepts with
--    other keys, so a new Worker keeps importing on the database before 274); invoice_xml keeps it (null: imported before, never checked).
-- Nothing here emits, transmits or posts stock or contas (⋮ Lançar contas / Lançar estoque of the note do, with their own commands).
-- Requires 143 and 217 (the import of today is hash-checked before it is replaced).
begin;

do $$declare v record;begin
 if to_regclass('erp_fiscal_invoices.invoice_xml') is null or to_regprocedure('erp_fiscal_invoices.supplier_product(uuid,text)') is null then
  raise exception 'fiscal_import_274_requires_143_217' using errcode='55000'; end if;
 for v in select * from(values
  ('public.erp_fiscal_invoice_import(uuid,uuid,jsonb)','22b226836ef4096e54943bec0e39778c1afefb4c4ac77ab6d159132881421467'))v(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'fiscal_import_274_previous_definition_changed' using errcode='55000',detail=v.sig; end if;
 end loop;
end$$;

-- Model 65 is the NFC-e of the Brufap (C) or an imported NFC-e of the company (S); C is never another model.
do $$declare c record;n integer:=0;begin
 for c in select conname from pg_constraint where conrelid='erp_fiscal_invoices.invoice'::regclass and contype='c'
  and pg_get_constraintdef(oid)='CHECK (((model = ''65''::text) = (issue_type = ''C''::text)))' loop
  execute format('alter table erp_fiscal_invoices.invoice drop constraint %I',c.conname);n:=n+1;
 end loop;
 if n<>1 then raise exception 'fiscal_import_274_model_constraint_not_found' using errcode='55000'; end if;
end$$;
alter table erp_fiscal_invoices.invoice add constraint invoice_model_issue_type check(case when model='65' then issue_type in('C','S') else issue_type<>'C' end);

alter table erp_fiscal_invoices.invoice_xml add column signature_verified boolean check(signature_verified is null or signature_verified);
comment on column erp_fiscal_invoices.invoice_xml.signature_verified is 'true: the Worker checked the XMLDSig signature, the digVal of the protocol and the CNPJ base of the certificate (not the ICP-Brasil chain); null: imported before 202610200274.';

-- 217 plus the NFC-e and signature_verified.
create or replace function public.erp_fiscal_invoice_import(p_user_id uuid,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;company text;candidate jsonb;issue text;d jsonb;v_id uuid;existing uuid;rec jsonb;result jsonb;items jsonb:='[]';item jsonb;product uuid;matched integer:=0;
 contact uuid;xml text;received timestamptz;products_writable boolean;auto_create boolean;flags jsonb;created integer:=0;updated integer:=0;failures integer:=0;outcome integer;
 v_model text;v_key text;
begin
 role:=erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_data is null or jsonb_typeof(p_data)<>'object'
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in('xml','sha256','size','key','signed','emitter_document','recipient_document','protocol','as_emitter','as_recipient'))
  or not p_data ?& array['xml','sha256','size','key','signed','emitter_document','recipient_document','protocol','as_emitter','as_recipient']
  or jsonb_typeof(p_data->'xml')<>'string' or jsonb_typeof(p_data->'sha256')<>'string' or jsonb_typeof(p_data->'size')<>'number' or jsonb_typeof(p_data->'signed')<>'boolean'
  or ((p_data->'protocol')?'signature_verified' and p_data#>'{protocol,signature_verified}' is distinct from 'true'::jsonb)
  or jsonb_typeof(p_data->'key')<>'string' or not erp_fiscal_invoices.access_key_valid(p_data->>'key') or substring(p_data->>'key',21,2) not in('55','65')
  or jsonb_typeof(p_data->'protocol')<>'object' or p_data#>>'{protocol,number}' !~ '^[0-9]{15}$' or p_data#>>'{protocol,status}' not in('100','150')
  or (p_data->>'emitter_document') !~ '^([0-9]{11}|[0-9]{14})$' or (jsonb_typeof(p_data->'recipient_document')<>'null' and (p_data->>'recipient_document') !~ '^([0-9]{11}|[0-9]{14})$')
  or jsonb_typeof(p_data->'as_emitter') not in('object','null') or jsonb_typeof(p_data->'as_recipient') not in('object','null') then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 xml:=p_data->>'xml';v_key:=p_data->>'key';v_model:=substring(v_key,21,2);
 if octet_length(convert_to(xml,'UTF8'))<>(p_data->>'size')::integer or (p_data->>'size')::integer>1048576
  or encode(sha256(convert_to(xml,'UTF8')),'hex')<>p_data->>'sha256' or strpos(xml,'NFe'||v_key)=0 then
  raise exception 'erp_fiscal_import_xml_mismatch' using errcode='22023'; end if;
 begin received:=(p_data#>>'{protocol,received_at}')::timestamptz; exception when others then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end;
 h:=erp_fiscal_invoices.command_hash(p_user_id,'invoice','import',p_data-'xml');
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'invoice',h);
 if replay is not null then return replay; end if;
 -- Which side of the XML is the company decides the type; an XML of other companies is not imported.
 company:=erp_fiscal_invoices.company_document();
 if company is null then return jsonb_build_object('imported',false,'refused','company_missing','invoice_id',null,'data_mode','erp_native'); end if;
 if p_data->>'emitter_document'=company then candidate:=p_data->'as_emitter';issue:=case when candidate->>'direction'='1' then 'S' else 'X' end;
 elsif p_data->>'recipient_document'=company then
  -- 274: an NFC-e of another company is never a purchase note of the company.
  if v_model='65' then return jsonb_build_object('imported',false,'refused','nfce_recipient','invoice_id',null,'data_mode','erp_native'); end if;
  candidate:=p_data->'as_recipient';issue:='X';
 else return jsonb_build_object('imported',false,'refused','other_company','invoice_id',null,'data_mode','erp_native'); end if;
 -- The Worker sends null for a reading the field contract cannot hold (for example, an XML without recipient).
 if jsonb_typeof(candidate)='null' then return jsonb_build_object('imported',false,'refused','xml_unsupported','invoice_id',null,'data_mode','erp_native'); end if;
 if candidate->>'access_key' is distinct from v_key or candidate->>'issue_type' is distinct from 'T' or candidate->>'model' is distinct from v_model or (v_model='65' and issue<>'S') then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(174852943,hashtext(v_key));
 select id into existing from erp_fiscal_invoices.invoice where access_key=v_key and deleted_at is null;
 if existing is not null then return jsonb_build_object('imported',false,'refused','duplicate','invoice_id',existing,'data_mode','erp_native'); end if;
 if v_model='65' then
  -- 274: checked like an NFC-e of the Brufap (C, without number and key), then registered with the number and the key of the XML.
  if jsonb_typeof(candidate->'number') is distinct from 'string' or candidate->>'number' !~ '^[1-9][0-9]{0,8}$' or jsonb_typeof(candidate->'series') is distinct from 'string'
   or candidate->>'series' !~ '^(0|[1-9][0-9]{0,2})$' or substring(v_key,23,3)::integer<>(candidate->>'series')::integer or substring(v_key,26,9)::integer<>(candidate->>'number')::integer then
   raise exception 'erp_fiscal_invoice_access_key_invalid' using errcode='22023'; end if;
  d:=erp_fiscal_invoices.invoice_input(candidate||jsonb_build_object('issue_type','C','number',null,'access_key',null));
  d:=d||jsonb_build_object('number',(candidate->>'number')::integer,'access_key',v_key);
 else
  -- Same validation as "Emitida por Terceiros" (number and key checked against model and series), stored as S or X.
  d:=erp_fiscal_invoices.invoice_input(candidate);
 end if;
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
 insert into erp_fiscal_invoices.invoice_xml(invoice_id,sha256,size,content,signed,protocol_status,imported_by,signature_verified)
  values(v_id,p_data->>'sha256',(p_data->>'size')::integer,xml,(p_data->>'signed')::boolean,p_data#>>'{protocol,status}',p_user_id,case when p_data#>'{protocol,signature_verified}'='true'::jsonb then true end);
 rec:=erp_fiscal_invoices.invoice_record(v_id);
 insert into erp_fiscal_invoices.invoice_revision(invoice_id,version,record) values(v_id,1,rec);
 result:=erp_fiscal_invoices.invoice_envelope(rec,role)||jsonb_build_object('action','import','replayed',false,'imported',true,'matched_items',matched,'contact_matched',contact is not null,
  'created_products',created,'updated_products',updated,'product_failures',failures);
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'invoice',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'invoice',v_id,1,'import',v_key);
 return result;
end $$;

revoke all on function public.erp_fiscal_invoice_import(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_import(uuid,uuid,jsonb) to service_role;
commit;
