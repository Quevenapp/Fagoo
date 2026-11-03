-- 269: Documentos (onda F), parte 3: versões da proposta comercial (Origin "Salvar nova versão").
-- * "Salvar nova versão" (chevron do Salvar da proposta): grava o formulário como uma proposta nova ligada à proposta de origem, com o
--   número-base e a sequência da versão (a proposta 123 tem as versões 123-2, 123-3...). A gravação é a mesma de uma proposta nova
--   (erp_document_save: regras das Preferências, vendedor, limite de crédito e auditoria), com comando derivado; o comando da versão
--   tem "Conferir resultado" e a versão lida (CAS) da proposta de origem.
-- * A versão anterior fica só leitura: erp_document_save recusa a gravação de uma proposta que já tem versão mais nova
--   (erp_document_version_locked); mudar a situação, gerar venda ou OS, clonar e imprimir continuam disponíveis.
-- * Leitura da proposta (document_view) com proposal_version (número-base, sequência, rótulo, versão mais nova) e a linha da listagem
--   com version_label ("123-2"). Modelos não têm versões.
-- Substitui funções das migrações 196, 198 e 239 (conferidas pelo hash; outra versão interrompe a migração). Nenhum efeito de
-- estoque, financeiro ou fiscal; nada escreve no Origin.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_documents.transition_command(uuid,text)') is null then raise exception 'proposal_versions_269_requires_163' using errcode='55000'; end if;
 for r in select * from(values
  ('public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb)','9123695d978585005769fef7a4517b5b0a977d335e9469aafc57afecc31cb934'),
  ('erp_documents.document_view(uuid)','0726cd2cbbc72a20b5af83c0ea961a4934c8cdf531871dac34d8d89a4f87e9a1'),
  ('erp_documents.list_row(uuid,boolean,boolean)','822caafb5d67471ee9b7327587f5367f11d9c93375a944a6af8c30d96a563128'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'proposal_versions_269_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- One row per version after the first: the document, the first proposta of the family (base) and the sequence (2, 3...).
create table erp_documents.proposal_version (
  document_id uuid primary key references erp_documents.document(id),
  base_id uuid not null references erp_documents.document(id),
  version_seq integer not null check(version_seq between 2 and 9999),
  source_id uuid not null references erp_documents.document(id),
  created_by uuid not null references auth.users(id), created_at timestamptz not null default clock_timestamp(),
  unique(base_id,version_seq), check(document_id<>base_id)
);
create index erp_documents_proposal_version_source on erp_documents.proposal_version(source_id);
alter table erp_documents.proposal_version enable row level security;
revoke all on erp_documents.proposal_version from public,anon,authenticated,service_role;
-- The version rows are history: never changed nor removed.
create function erp_documents.proposal_version_immutable() returns trigger language plpgsql set search_path=pg_catalog as $function$
begin raise exception 'erp_document_version_immutable' using errcode='55000'; end $function$;
create trigger proposal_version_immutable before update or delete on erp_documents.proposal_version for each row execute function erp_documents.proposal_version_immutable();

-- Base and sequence of a proposta (the first one of the family is the sequence 1).
create function erp_documents.proposal_superseded(p_id uuid) returns boolean language sql stable set search_path=pg_catalog as $function$
 select exists(select 1 from erp_documents.proposal_version v
  where v.base_id=coalesce((select x.base_id from erp_documents.proposal_version x where x.document_id=p_id),p_id)
   and v.version_seq>coalesce((select x.version_seq from erp_documents.proposal_version x where x.document_id=p_id),1))
$function$;
-- Null when the proposta has no other version; else the número-base, its sequence, the label (123 or 123-2) and the latest version.
create function erp_documents.proposal_version_json(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $function$
 with me as (select coalesce(v.base_id,d.id) base_id,coalesce(v.version_seq,1) seq from erp_documents.document d
   left join erp_documents.proposal_version v on v.document_id=d.id where d.id=p_id and d.kind='sales_proposals'),
  family as (select v.document_id id,v.version_seq seq from erp_documents.proposal_version v join me on v.base_id=me.base_id union all select me.base_id,1 from me),
  latest as (select f.id,f.seq from family f order by f.seq desc limit 1)
 select case when (select count(*) from family)<2 then null else jsonb_build_object('base_id',me.base_id,'base_number',b.number::text,'seq',me.seq,
   'label',case when me.seq=1 then b.number::text else b.number::text||'-'||me.seq::text end,'versions',(select count(*) from family),'superseded',me.seq<l.seq,
   'latest',jsonb_build_object('id',l.id,'label',case when l.seq=1 then b.number::text else b.number::text||'-'||l.seq::text end)) end
 from me join erp_documents.document b on b.id=me.base_id cross join latest l
$function$;

-- ---------------------------------------------------------------- Salvar nova versão
create function public.erp_document_proposal_version(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_body jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $function$
declare v_hash text; v_replay jsonb; s erp_documents.document%rowtype; v_base uuid; v_seq integer; v_saved jsonb; v_id uuid; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 if p_id is null or p_command_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 -- The version takes the automatic numbering; it never carries a proposta of origin nor a refresh of the contact.
 if p_body is null or jsonb_typeof(p_body)<>'object' or p_body?'number' or p_body?'source_proposal' or p_body?'refresh_contact' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','proposal_version','actor',p_user_id,'id',p_id,'version',p_expected_version,'body',p_body)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into s from erp_documents.document where id=p_id and kind='sales_proposals' for update;
 if not found or not erp_documents.contact_usable(p_user_id,s.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if s.version<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if coalesce((s.body->>'template')::boolean,false) or p_body->'template'='true'::jsonb then raise exception 'erp_proposal_version_template' using errcode='22023'; end if;
 if erp_documents.proposal_superseded(p_id) then raise exception 'erp_document_version_locked' using errcode='40001'; end if;
 v_base:=coalesce((select base_id from erp_documents.proposal_version where document_id=p_id),p_id);
 -- One version at a time per family (the base row is the lock).
 perform 1 from erp_documents.document where id=v_base for update;
 v_seq:=coalesce((select max(version_seq) from erp_documents.proposal_version where base_id=v_base),1)+1;
 if v_seq>9999 then raise exception 'erp_proposal_version_limit' using errcode='54000'; end if;
 v_saved:=public.erp_document_save(p_user_id,'sales_proposals',null,0,erp_documents.transition_command(p_command_id,'proposal_version'),p_body);
 v_id:=(v_saved#>>'{document,id}')::uuid;
 insert into erp_documents.proposal_version(document_id,base_id,version_seq,source_id,created_by) values(v_id,v_base,v_seq,p_id,p_user_id);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,p_id,'proposal_version',null,jsonb_build_object('version_id',v_id,'version_seq',v_seq,'base_id',v_base));
 v_result:=jsonb_build_object('kind','sales_proposals','document',erp_documents.dto(v_id),'proposal_version',erp_documents.proposal_version_json(v_id),
  'source',jsonb_build_object('id',s.id,'number',s.number::text,'version',s.version),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

-- ---------------------------------------------------------------- A versão anterior fica só leitura
create or replace function public.erp_document_save(p_user_id uuid, p_kind text, p_id uuid, p_expected_version integer, p_command_id uuid, p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_hash text; v_replay jsonb; v_data jsonb; v_row erp_documents.document%rowtype; v_id uuid;
 v_contact uuid; v_warehouse uuid; v_snapshot jsonb; v_before jsonb; v_result jsonb; v_body jsonb; v_number bigint; v_seller uuid; v_refresh boolean:=false;
 v_source_id uuid; v_source_version integer; v_source erp_documents.document%rowtype; v_source_before jsonb; v_auto jsonb;
 v_approval uuid; v_saved erp_documents.document%rowtype; v_situation jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_expected_version is null or (p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version<1) then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','save','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,'body',p_body)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 if p_body is null or jsonb_typeof(p_body)<>'object' then raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 v_body:=p_body;
 if p_body?'number' then
  if jsonb_typeof(p_body->'number')<>'string' or p_body->>'number'!~'^[1-9][0-9]{0,9}$' then raise exception 'erp_document_number_invalid' using errcode='22023'; end if;
  v_number:=(p_body->>'number')::bigint; v_body:=p_body-'number';
 end if;
 if v_body?'refresh_contact' then
  if v_body->'refresh_contact'<>'true'::jsonb then raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
  v_refresh:=true; v_body:=v_body-'refresh_contact';
 end if;
 if v_body?'source_proposal' then
  if p_id is not null or p_kind not in('sales_orders','service_orders') or jsonb_typeof(v_body->'source_proposal')<>'object'
   or exists(select 1 from jsonb_object_keys(v_body->'source_proposal') k where k not in('id','expected_version'))
   or jsonb_typeof(v_body#>'{source_proposal,expected_version}') is distinct from 'number' or v_body#>>'{source_proposal,expected_version}'!~'^[1-9][0-9]{0,9}$'
   or (v_body#>>'{source_proposal,expected_version}')::bigint>2147483647 then
   raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
  v_source_id:=erp_documents.uuid_value(v_body#>'{source_proposal,id}',true); v_source_version:=(v_body#>>'{source_proposal,expected_version}')::integer;
  v_body:=v_body-'source_proposal';
 end if;
 v_data:=erp_documents.normalize(p_kind,v_body); v_contact:=(v_data->>'contact_id')::uuid; v_warehouse:=(v_data->>'warehouse_id')::uuid; v_seller:=(v_data->>'seller_id')::uuid;
 v_data:=jsonb_set(v_data,'{items}',erp_documents.auto_products(p_user_id,p_kind,p_command_id,v_data->'items'));
 perform erp_documents.check_preference_rules(p_kind,v_data);
 -- 239: the seller rules with the approval of the discount (the approval situação, or null when nothing waits for approval).
 v_approval:=erp_documents.seller_rules(p_user_id,p_kind,v_data);
 if p_id is not null then
  select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
  if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
  -- 238: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
  if not erp_documents.contact_usable(p_user_id,v_row.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  if not erp_documents.editable(v_row.status) then raise exception 'erp_document_state_locked' using errcode='40001'; end if;
  -- 269: a proposta with a newer version stays read-only (Origin Salvar nova versão).
  if p_kind='sales_proposals' and erp_documents.proposal_superseded(p_id) then raise exception 'erp_document_version_locked' using errcode='40001'; end if;
  v_before:=erp_documents.dto(p_id);
  perform erp_documents.require_commercial_input(v_before,v_body);
  if v_number=v_row.number then v_number:=null; end if;
 end if;
 if v_seller is not null and (p_id is null or v_row.body->>'seller_id' is distinct from v_seller::text) then perform erp_documents.require_seller(v_seller); end if;
 perform erp_documents.check_links(p_kind,v_data,case when p_id is not null then v_row.body end);
 perform erp_documents.check_payment_links(p_kind,v_data,case when p_id is not null then v_row.body end);
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Alterar forma de pagamento": a Forma not yet in the OS needs it.
 if p_kind='service_orders' and exists(select 1 from jsonb_array_elements(coalesce(v_data->'installments','[]'::jsonb)) p where p->>'payment_method_id' is not null
   and not exists(select 1 from jsonb_array_elements(case when p_id is not null then coalesce(v_row.body->'installments','[]'::jsonb) else '[]'::jsonb end) o where o->>'payment_method_id'=p->>'payment_method_id')) then
  perform erp_documents.require_os_permission(p_user_id,p_kind,'forma_pagamento'); end if;
 perform erp_documents.check_credit_limit(p_user_id,p_kind,v_data,case when p_id is not null then v_row.body||jsonb_build_object('contact_id',v_row.contact_id) end);
 if v_source_id is not null then
  -- Same rules as erp_proposal_convert / erp_proposal_convert_to_service (164): one document per proposta, never a template.
  perform erp_documents.require_access(p_user_id,'sales_proposals',true);
  select * into v_source from erp_documents.document where id=v_source_id and kind='sales_proposals' for update;
  if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
  if v_source.version<>v_source_version or v_source.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  if exists(select 1 from erp_documents.document where source_proposal_id=v_source_id) then raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
  if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
  v_source_before:=erp_documents.dto(v_source_id);
 end if;
 perform erp_documents.check_tax_preference(v_data,case when p_id is not null then v_row.body when v_source_id is not null then v_source.body end);
 if v_number is not null then
  -- Same lock as erp_documents.next_number: a free number and the automatic sequence never collide.
  perform 1 from erp_documents.numbering where kind=p_kind for update;
  if not erp_documents.number_editable(p_kind) then raise exception 'erp_document_number_locked' using errcode='22023'; end if;
  if exists(select 1 from erp_documents.document where kind=p_kind and number=v_number) then
   -- Origin: a number already used becomes the next free number (new document) or stays the current one (edit).
   v_number:=null;
  else
   update erp_documents.numbering set last_number=greatest(last_number,v_number) where kind=p_kind;
  end if;
 end if;
 -- 238: a new or changed contact must be one the user sees (the Frente de caixa consumidor padrão always is).
 if (p_id is null or v_row.contact_id<>v_contact) and not erp_documents.contact_usable(p_user_id,v_contact) then
  raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 if p_id is not null and v_row.contact_id=v_contact and not v_refresh then v_snapshot:=v_row.contact_snapshot;
 else
  select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=v_contact and r.active;
  if not found then raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 end if;
 if v_warehouse is not null and (p_id is null or v_row.warehouse_id is distinct from v_warehouse)
  and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=v_warehouse and r.active) then
  raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 if p_id is null then
  insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)
  values(p_kind,coalesce(v_number,erp_documents.next_number(p_kind)),erp_documents.initial_status(p_kind),
   v_contact,v_warehouse,v_snapshot,v_data-'items',(v_data#>>'{totals,total}')::numeric,v_source_id,p_user_id,p_user_id) returning id into v_id;
 else
  v_id:=p_id;
  update erp_documents.document set version=version+1,contact_id=v_contact,warehouse_id=v_warehouse,contact_snapshot=v_snapshot,number=coalesce(v_number,number),
   body=v_data-'items',total=(v_data#>>'{totals,total}')::numeric,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 end if;
 perform erp_documents.replace_items(v_id,v_data->'items');
 if v_source_id is not null then
  update erp_documents.document set status='completed',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_source_id;
  perform erp_documents.record_occurrence(v_source_id,p_user_id,p_command_id,v_source.version+1,v_source.status,'completed',null);
  insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
   values(p_user_id,p_command_id,v_source_id,case when p_kind='sales_orders' then 'convert_to_sale' else 'convert_to_service' end,v_source_before,erp_documents.dto(v_source_id));
 end if;
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,v_id,case when v_source_id is not null then 'create_from_proposal' when p_id is null then 'create' else 'edit' end,v_before,erp_documents.dto(v_id));
 -- 239: Preferências › Vendas "Situação para aprovação de descontos": a pedido above the discount limit of the seller goes to Em
 -- digitação in the approval situação ("Venda enviada para aprovação do desconto") until an approver moves it.
 if v_approval is not null then
  if not exists(select 1 from erp_documents.document_situation x where x.document_id=v_id and x.situation_id=any(erp_documents.approval_situations())) then
   select * into v_saved from erp_documents.document where id=v_id;
   -- Active stock, contas or reservas keep the pedido where it is: the old refusal stands.
   if v_saved.status<>'draft' and (exists(select 1 from erp_finance.document_posting f where f.document_id=v_id and f.state='active')
    or exists(select 1 from erp_stock.document_posting s where s.document_id=v_id and s.state='active')
    or exists(select 1 from erp_stock.reservation r where r.document_id=v_id and r.state='active')) then
    raise exception 'erp_document_seller_discount_limit' using errcode='22023'; end if;
   v_situation:=erp_documents.document_situation_json(v_id);
   update erp_documents.document set status='draft',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
   delete from erp_documents.document_situation where document_id=v_id;
   insert into erp_documents.document_situation(document_id,kind,situation_id,base_status,actor,command_id) values(v_id,p_kind,v_approval,'draft',p_user_id,p_command_id);
   perform erp_documents.record_situation_occurrence(v_id,p_user_id,p_command_id,erp_documents.current_version(v_id),v_saved.status,
    case when v_saved.status<>'draft' then 'draft' end,'Venda enviada para aprovação do desconto',v_situation,erp_documents.document_situation_json(v_id));
   insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
    values(p_user_id,p_command_id,v_id,'discount_approval','Venda enviada para aprovação do desconto',null,erp_documents.document_view(v_id));
  end if;
 end if;
 v_auto:=erp_documents.auto_finance(p_user_id,v_id,p_command_id);
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false)
  ||case when v_approval is not null then jsonb_build_object('discount_approval',jsonb_build_object('situation',erp_documents.document_situation_json(v_id))) else '{}'::jsonb end
  ||case when v_auto is not null then jsonb_build_object('auto_finance',v_auto) else '{}'::jsonb end
  ||case when v_source_id is not null then jsonb_build_object('source_proposal',(select jsonb_build_object('id',s.id,'number',s.number::text,'version',s.version,'status',s.status)
   from erp_documents.document s where s.id=v_source_id)) else '{}'::jsonb end;
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

-- ---------------------------------------------------------------- Leituras
create or replace function erp_documents.document_view(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 select erp_documents.dto(p_id)||jsonb_build_object('situation',erp_documents.document_situation_json(p_id),
  'seller_name',(select left(r.name,200) from erp_documents.document d join erp_catalog.seller s on s.id::text=d.body->>'seller_id' join erp_catalog.record r on r.id=s.contact_id where d.id=p_id),
  'category_name',(select left(c.name,200) from erp_documents.document d join erp_finance.category c on c.id::text=d.body->>'category_id' where d.id=p_id),
  'carrier_name',(select left(r.name,200) from erp_documents.document d join erp_catalog.record r on r.id::text=d.body->>'carrier_id' where d.id=p_id),
  'price_list_name',(select left(l.name,120) from erp_documents.document d join erp_pricing.price_list l on l.id::text=d.body->>'price_list_id' where d.id=p_id),
  'payment_account_name',(select left(a.name,200) from erp_documents.document d join erp_finance.account a on a.id::text=d.body->>'payment_account_id' where d.id=p_id),
  'payment_method_names',(select coalesce(jsonb_object_agg(f.id::text,left(f.description,100)),'{}'::jsonb) from erp_catalog.payment_method f
   where f.id::text in(select p->>'payment_method_id' from erp_documents.document d,jsonb_array_elements(coalesce(d.body->'installments','[]'::jsonb)) p where d.id=p_id)),
  'payment_account_names',(select coalesce(jsonb_object_agg(a.id::text,left(a.name,200)),'{}'::jsonb) from erp_finance.account a
   where a.id::text in(select p#>>'{details,account_id}' from erp_documents.document d,jsonb_array_elements(coalesce(d.body->'installments','[]'::jsonb)) p where d.id=p_id)))
  -- 269: the versions of the proposta.
  ||case when (select d.kind from erp_documents.document d where d.id=p_id)='sales_proposals' then jsonb_build_object('proposal_version',erp_documents.proposal_version_json(p_id)) else '{}'::jsonb end
$function$;

create or replace function erp_documents.list_row(p_id uuid, p_fiscal boolean, p_stock boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 select jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'date',d.body->>'date','expected_date',d.body->>'expected_date','next_contact',d.body->>'next_contact',
  'template',coalesce(d.body->'template'='true'::jsonb,false),
  'total',d.total::text,'contact_id',d.contact_id,'contact_name',d.contact_snapshot->>'name',
  'warehouse_id',d.warehouse_id,'warehouse_name',case when p_stock then w.name end,
  'source_proposal_id',d.source_proposal_id,'source_proposal_number',p.number::text,
  'finance_active',exists(select 1 from erp_finance.document_posting f where f.document_id=d.id and f.state='active'),
  'stock_active',exists(select 1 from erp_stock.document_posting s where s.document_id=d.id and s.state='active'),
  'receipt_active',d.kind='purchase_orders' and erp_purchase_receipts.active(d.id),
  'reservation_active',case when p_stock then d.kind='sales_orders' and exists(select 1 from erp_stock.reservation r where r.document_id=d.id and r.state='active') end,
  'fiscal_draft',case when p_fiscal and d.kind='sales_orders' then exists(select 1 from erp_fiscal_drafts.draft x where x.source_document_id=d.id and x.status='draft') end,
  'internal_notes',left(d.body->>'internal_notes',280),
  'created_at',d.created_at,'updated_at',d.updated_at,
  'customer_po_number',d.body->>'customer_po_number','ship_date',d.body->>'ship_date',
  'contact_email',nullif(d.contact_snapshot->>'email',''),'contact_phone',coalesce(nullif(d.contact_snapshot->>'phone',''),nullif(d.contact_snapshot->>'mobile','')),
  'contact_document',nullif(d.contact_snapshot->>'document',''),
  'address',left(coalesce(erp_documents.address_text(nullif(d.body->'delivery_address','null'::jsonb)),erp_documents.address_text(d.contact_snapshot)),500),
  'carrier_name',coalesce((select left(r.name,200) from erp_catalog.record r where r.id::text=d.body->>'carrier_id'),left(nullif(d.body#>>'{commercial,transport,carrier_reference,label}',''),200)),
  'first_sale',d.kind='sales_orders' and d.status<>'cancelled' and not exists(select 1 from erp_documents.document o
    where o.kind='sales_orders' and o.contact_id=d.contact_id and o.status<>'cancelled' and o.id<>d.id
     and (o.body->>'date',o.number)<(d.body->>'date',d.number)),
  -- 198: the nota of the ordem de serviço too (176 links the NF-e to the OS, letter O on the notes list).
  'invoice',case when p_fiscal and d.kind in('sales_orders','service_orders') then erp_documents.order_invoice(d.id) end,
  'pendencies',d.kind='sales_orders' and d.status<>'cancelled' and jsonb_array_length(erp_documents.pendencies(d.id))>0,
  'service_order_number',(select s.number::text from erp_documents.sales_service_link l join erp_documents.document s on s.id=l.service_order_id where l.sales_order_id=d.id),
  'template_name',case when d.kind='sales_proposals' then d.body->>'template_name' end,
  -- 163: situação of the Gerenciador de transições and whether a nota is linked (the menu rules of every profile).
  'situation',erp_documents.situation_json(d.kind,d.status,ds.situation_id),
  'invoice_linked',d.kind in('sales_orders','service_orders') and erp_documents.order_invoice(d.id) is not null,
  -- 164: native vendedor (Cadastros › Vendedores) of the document.
  'seller_id',case when d.body->>'seller_id'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then d.body->>'seller_id' end,
  'seller_name',(select left(r.name,200) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id::text=d.body->>'seller_id'))
  -- 269: the version of the proposta ("123-2"; null for the first one and for the other kinds).
  ||jsonb_build_object('version_label',(select b.number::text||'-'||v.version_seq::text from erp_documents.proposal_version v join erp_documents.document b on b.id=v.base_id where v.document_id=d.id))
 from erp_documents.document d
 left join erp_catalog.record w on w.id=d.warehouse_id
 left join erp_documents.document p on p.id=d.source_proposal_id
 left join erp_documents.document_situation ds on ds.document_id=d.id
 where d.id=p_id;
$function$;

revoke all on function erp_documents.proposal_version_immutable(),erp_documents.proposal_superseded(uuid),erp_documents.proposal_version_json(uuid),
 erp_documents.document_view(uuid),erp_documents.list_row(uuid,boolean,boolean) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_proposal_version(uuid,uuid,integer,uuid,jsonb),public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.erp_document_proposal_version(uuid,uuid,integer,uuid,jsonb),public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb) to service_role;
commit;
