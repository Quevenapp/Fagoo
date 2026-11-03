-- "Importar XML NF-e" (Mais ações › Importar): registra uma NF-e 4.00 autorizada (nfeProc, modelo 55) como nota do Brufap.
-- O Worker lê o XML e manda as duas leituras possíveis (empresa emitente ou destinatária); o banco escolhe pela CNPJ da
-- empresa: "Importação de XML de saída" (S) ou "Importação de XML de entrada" (X). A nota fica Registrada, sem ambiente,
-- com a chave e o protocolo do XML, e o XML fica guardado com SHA-256 para "Baixar XML". Nada aqui emite, transmite,
-- reserva número nem lança estoque ou contas; as travas 022/041/046/064 não mudam.
-- Também: "Conciliar produtos" das notas importadas (vínculo dos itens com o cadastro, com versão e auditoria).
begin;
create table erp_fiscal_invoices.invoice_xml(
 invoice_id uuid primary key references erp_fiscal_invoices.invoice(id),
 sha256 text not null check(sha256~'^[0-9a-f]{64}$'),size integer not null check(size between 1 and 1048576),content text not null,
 signed boolean not null,protocol_status text not null check(protocol_status in('100','150')),
 imported_by uuid not null references auth.users(id),imported_at timestamptz not null default clock_timestamp(),
 check(octet_length(convert_to(content,'UTF8'))=size)
);
alter table erp_fiscal_invoices.invoice_xml enable row level security;
revoke all on erp_fiscal_invoices.invoice_xml from public,anon,authenticated,service_role;
create trigger immutable_invoice_xml before update or delete on erp_fiscal_invoices.invoice_xml for each row execute function erp_fiscal_invoices.immutable_history();

-- Imported notes (S/X) are read-only in the form: the XML is their source. Only "Conciliar produtos" and Excluir change them.
create or replace function erp_fiscal_invoices.invoice_envelope(p_record jsonb,p_role text) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('invoice',p_record,'writable',p_role in('admin','fiscal') and p_record->'deleted_at'='null'::jsonb and (p_record->>'status')::integer in(1,5,8,12)
   and p_record->>'issue_type' not in('S','X'),
  'emission_enabled',false,'production_enabled',false,'operational_effects',false,'data_mode','erp_native')
$$;
create function erp_fiscal_invoices.company_document() returns text language sql stable set search_path=pg_catalog as $$
 select nullif(erp_fiscal_invoices.digits(i.data->>'cnpj'),'') from erp_company.identity i where i.singleton
$$;
-- One active catalog record with that value, or null (several candidates are left for "Conciliar produtos").
create function erp_fiscal_invoices.unique_product(p_code text,p_gtin text) returns uuid language sql stable set search_path=pg_catalog as $$
 select case when count(*)=1 then min(r.id::text)::uuid end from erp_catalog.record r left join erp_catalog.product p on p.record_id=r.id
 where r.entity='products' and r.active and ((p_code is not null and r.code=p_code) or (p_gtin is not null and p_gtin<>'SEM GTIN' and p.gtin=p_gtin))
$$;
create function erp_fiscal_invoices.unique_contact(p_document text) returns uuid language sql stable set search_path=pg_catalog as $$
 select case when count(*)=1 then min(r.id::text)::uuid end from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id
 where p_document is not null and r.entity='contacts' and r.active and erp_fiscal_invoices.digits(c.document)=p_document
$$;

create function public.erp_fiscal_invoice_import(p_user_id uuid,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;company text;candidate jsonb;issue text;d jsonb;v_id uuid;existing uuid;rec jsonb;result jsonb;items jsonb:='[]';item jsonb;product uuid;matched integer:=0;
 contact uuid;xml text;received timestamptz;
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
 for item in select value from jsonb_array_elements(d->'items') loop
  if not item?'product_id' then
   product:=case when issue='S' or p_data->>'emitter_document'=company then erp_fiscal_invoices.unique_product(item->>'code',null) else erp_fiscal_invoices.unique_product(null,item->>'gtin') end;
   if product is not null then item:=item||jsonb_build_object('product_id',product);matched:=matched+1; end if;
  else matched:=matched+1; end if;
  items:=items||jsonb_build_array(item);
 end loop;
 contact:=erp_fiscal_invoices.unique_contact(d#>>'{recipient,document}');
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
 result:=erp_fiscal_invoices.invoice_envelope(rec,role)||jsonb_build_object('action','import','replayed',false,'imported',true,'matched_items',matched,'contact_matched',contact is not null);
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'invoice',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'invoice',v_id,1,'import',p_data->>'key');
 return result;
end $$;

-- "Baixar XML" of an imported note: the stored bytes with their SHA-256 (the Worker checks both before answering).
create function public.erp_fiscal_invoice_xml_get(p_user_id uuid,p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare x erp_fiscal_invoices.invoice_xml%rowtype;key text;
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_id is null then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 select * into x from erp_fiscal_invoices.invoice_xml where invoice_id=p_id;
 if not found then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 select access_key into key from erp_fiscal_invoices.invoice where id=p_id;
 return jsonb_build_object('invoice_id',x.invoice_id,'access_key',key,'sha256',x.sha256,'size',x.size,'signed',x.signed,'protocol_status',x.protocol_status,'imported_at',x.imported_at,'xml',x.content,'data_mode','erp_native');
end $$;

-- "Conciliar produtos": links (or unlinks) catalog products to the items of an imported note, one command, CAS, audit.
create function public.erp_fiscal_invoice_reconcile(p_user_id uuid,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;v erp_fiscal_invoices.invoice%rowtype;v_id uuid;expected integer;e jsonb;pos integer;product uuid;rec jsonb;result jsonb;seen integer[]:='{}';
begin
 role:=erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_data is null or jsonb_typeof(p_data)<>'object' or exists(select 1 from jsonb_object_keys(p_data) k where k not in('invoice_id','expected_version','items'))
  or not p_data ?& array['invoice_id','expected_version','items'] or jsonb_typeof(p_data->'items')<>'array' or jsonb_array_length(p_data->'items') not between 1 and 990 then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 v_id:=erp_fiscal_invoices.uuid_input(p_data->'invoice_id');expected:=erp_fiscal_invoices.version_input(p_data->'expected_version');
 h:=erp_fiscal_invoices.command_hash(p_user_id,'invoice','reconcile',p_data);
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'invoice',h);
 if replay is not null then return replay; end if;
 select * into v from erp_fiscal_invoices.invoice where id=v_id for update;
 if not found then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 if v.version<>expected or v.version=2147483647 or v.deleted_at is not null then raise exception 'erp_fiscal_invoice_version_conflict' using errcode='40001'; end if;
 if v.issue_type not in('S','X') then raise exception 'erp_fiscal_invoice_not_imported' using errcode='40001'; end if;
 for e in select value from jsonb_array_elements(p_data->'items') loop
  if jsonb_typeof(e)<>'object' or exists(select 1 from jsonb_object_keys(e) k where k not in('position','product_id')) or not e ?& array['position','product_id']
   or jsonb_typeof(e->'position')<>'number' or (e->>'position')!~'^[1-9][0-9]{0,2}$' then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
  pos:=(e->>'position')::integer;product:=erp_fiscal_invoices.uuid_input(e->'product_id',false);
  if pos=any(seen) or not exists(select 1 from erp_fiscal_invoices.invoice_item where invoice_id=v_id and position=pos) then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
  if product is not null and not exists(select 1 from erp_catalog.record r where r.id=product and r.entity='products') then raise exception 'erp_fiscal_invoice_product_not_found' using errcode='22023'; end if;
  seen:=seen||pos;
  update erp_fiscal_invoices.invoice_item set product_id=product,data=case when product is null then data-'product_id' else data||jsonb_build_object('product_id',product) end where invoice_id=v_id and position=pos;
 end loop;
 update erp_fiscal_invoices.invoice set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 rec:=erp_fiscal_invoices.invoice_record(v_id);
 insert into erp_fiscal_invoices.invoice_revision(invoice_id,version,record) values(v_id,(rec->>'version')::integer,rec);
 result:=erp_fiscal_invoices.invoice_envelope(rec,role)||jsonb_build_object('action','reconcile','replayed',false);
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'invoice',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action) values(p_user_id,p_command_id,'invoice',v_id,(rec->>'version')::integer,'reconcile');
 return result;
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_invoice_import(uuid,uuid,jsonb),public.erp_fiscal_invoice_xml_get(uuid,uuid),public.erp_fiscal_invoice_reconcile(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_import(uuid,uuid,jsonb),public.erp_fiscal_invoice_xml_get(uuid,uuid),public.erp_fiscal_invoice_reconcile(uuid,uuid,jsonb) to service_role;
commit;
