-- 267: Documentos (onda F), parte 1: o escopo do vendedor nas leituras por documento e nos relatórios, a frente de caixa que deixa
-- pendente o efeito recusado e o lançamento automático das contas a pagar ao criar o pedido de compra.
-- * Preferências › Cadastros › Clientes e fornecedores "Contato acessível somente ao vendedor vinculado" (erp_catalog.contact_scope,
--   124; listagem, leitura e gravação desde 238 e 239): também as ocorrências (listar e remover), os anexos (listar, reservar, enviar,
--   baixar, cancelar e excluir, por erp_attachments.authorize), o diário e os eventos da OS (pelos contextos internos), as pendências
--   cadastrais, a cópia conferida (Clonar, Duplicar e modelos), as conversões por id (Gerar venda, Gerar ordem de serviço e Gerar
--   ordem serviço do pedido) e os relatórios de vendas (Relatório de Vendas e curva ABC) e de serviço (Relatório de Ordem de Serviço e
--   Ocorrências por Ordem de Serviço). Um documento de contato que o usuário não vê é "não encontrado"; os relatórios somam só os
--   contatos do vendedor do usuário.
-- * Ordens de serviço com Peças e Serviços executados separados (268): o Relatório de Ordem de Serviço soma Total das peças e Total de
--   serviços pelo grupo do item (sem grupo, pelo tipo do produto, como antes) e a cópia conferida mantém o grupo, Orçar e OK.
-- * Frente de caixa (205): ao finalizar a venda, um Lançar estoque, Lançar contas ou baixa à vista recusado (saldo insuficiente,
--   contato inativo, permissão do usuário, conta inativa...) deixa de desfazer a venda: o efeito fica "pendente" no pedido, com o motivo
--   (stock_reason, finance_reason, settle_reason), como para o perfil que não lança.
-- * Preferências › Suprimentos "Automação lançamento de contas pagar ao criar novo pedido de compra": a gravação que cria o pedido de
--   compra com parcelas lança as contas a pagar na mesma transação (o mesmo Lançar contas do pedido, com a categoria do pedido ou a
--   padrão, comando derivado e idempotente); sem permissão de contas ou com um impedimento, o pedido é salvo e a resposta diz o motivo.
--   A edição, a mudança de situação e as ocorrências do pedido de compra não lançam.
-- Substitui funções das migrações 012, 028, 049, 129, 130, 131, 164, 170, 196, 205 e 239 (conferidas pelo hash; outra versão
-- interrompe a migração). Nenhuma tabela nova; nada emite nota, movimenta banco ou escreve no Origin.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_documents.contact_usable(uuid,uuid)') is null or to_regclass('erp_pos.sale') is null
  or to_regprocedure('erp_finance.document_preview_data(erp_documents.document,uuid,jsonb)') is null then
  raise exception 'document_scope_effects_267_requires_238_205_248' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_attachments.authorize(uuid,text,uuid,boolean)','08871331b6272b4b4afdee8c2e51a69c52b2f41d014ac3e0ea5315f48a197877'),
  ('erp_documents.service_event_context(uuid,uuid)','b2fee3027d5860367f2f2cf2d72be5fd856f172717fde9fd78e109c48eb76761'),
  ('erp_documents.service_journal_context(uuid,uuid,boolean)','9ef2b8659cd4c2d48a66fa6804e7a8c17d47b8ba9169d284351e62bd2f65d176'),
  ('public.erp_document_occurrence_list(uuid,text,uuid)','e8f12ee67705925bd265cad122cd1ce450c5b0247939f83e6659140d8abc1fc3'),
  ('public.erp_document_occurrence_remove(uuid,text,uuid,uuid,uuid)','0646c7978dce42f0ff5c4e3356ed530a130e86a00b2eadacc15c0cb747c46173'),
  ('public.erp_document_pendencies(uuid,text,uuid)','8b6fa14edcc3185f2530d8700dfaad4bb4a3bda15a201ed158f1b61223536cf8'),
  ('public.erp_document_copy_preview(uuid,text,uuid)','bec55daafd898c0188c01f2f8b4577d9467b4bd7ebd030563c7e8e36351dd580'),
  ('public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb)','8b94ce42a67ef73e81dc06c9b12849c9f892daceb709641bbd2cd68b985648b6'),
  ('public.erp_proposal_convert(uuid,uuid,integer,uuid)','d7ca9db9c80b32c9e21b12828ffd2897b2e926df6148a68e5c014a34d2b100f1'),
  ('public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid)','c1df8b15711e8612e7b5c26314640aaf13380092a03a1e835d65d702c68387bf'),
  ('public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid)','613672011675e602763b8b8b587a3ee11093d30d0c24509dce4d9335aa91022c'),
  ('public.erp_document_sales_report(uuid,jsonb)','9a498de6e3d7bebe313f1a58454ca34b3fc31c041552275d91cc4f8651333465'),
  ('public.erp_document_sales_abc(uuid,text,text)','c8217ce213173a17721d6ab19154b87f54e2fbb781975c28f48dbee96464a52f'),
  ('public.erp_document_service_report(uuid,jsonb)','c99c0e84b662db7ef05afd03640d3fd5a477005b0a4fe949aadca5e501821e25'),
  ('public.erp_document_service_occurrence_report(uuid,text,text,text)','89c8e7e5cfc300e5b2e3314d689e1c05d96b5e5478d0daa482cb010e30db6de3'),
  ('erp_pos.sale_effects(uuid,uuid,uuid,jsonb)','02a212e7750fd0dfa0e303fc4d06698afef31fb76f2a2deb405aacbd529c9f8a'),
  ('erp_documents.auto_finance(uuid,uuid,uuid)','56aeef4bd2a36a2f30627a58687ba8cc6844180e149bf8e9914ba238c6d55734'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'document_scope_effects_267_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- ---------------------------------------------------------------- Escopo do vendedor nas leituras por documento
-- Anexos: every RPC of the attachments of a document goes through authorize.
create or replace function erp_attachments.authorize(p_user_id uuid,p_kind text,p_document_id uuid,p_write boolean) returns void
language plpgsql stable set search_path=pg_catalog as $function$
begin
  perform erp_documents.require_access(p_user_id,p_kind,p_write);
  if not exists(select 1 from erp_documents.document where id=p_document_id and kind=p_kind) then
    raise exception 'erp_attachment_document_not_found' using errcode='P0002'; end if;
  -- 267: the attachments of a document of a contact the user does not see are not found.
  if not erp_documents.contact_usable(p_user_id,(select contact_id from erp_documents.document where id=p_document_id)) then
    raise exception 'erp_attachment_document_not_found' using errcode='P0002'; end if;
end $function$;

create or replace function erp_documents.service_event_context(p_actor uuid, p_document_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare d erp_documents.document;r text;write_allowed boolean;begin
 perform erp_documents.require_access(p_actor,'service_orders',false);
 select * into d from erp_documents.document where id=p_document_id and kind='service_orders';
 if not found then raise exception 'erp_service_event_not_found' using errcode='P0002';end if;
 -- 267: the events of an OS of a contact the user does not see are not found.
 if not erp_documents.contact_usable(p_actor,d.contact_id) then raise exception 'erp_service_event_not_found' using errcode='P0002';end if;
 select role into r from erp_access.membership where user_id=p_actor and active;
 write_allowed:=erp_documents.allowed(r,'service_orders',true) and d.status<>'cancelled' and not coalesce((d.body->>'template')::boolean,false);
 return jsonb_build_object('scope','service_order_events','data_mode','erp_native','signature_verified',false,'consent_verified',false,
  'changes_document_status',false,'financial_mutation_performed',false,'stock_mutation_performed',false,
  'document',jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'version',d.version,'status',d.status,
   'total',d.total::text,'commercial_hash',erp_documents.service_event_commercial_hash(d)),
  'can_record',write_allowed,'allowed_event_types',case when write_allowed then erp_documents.service_event_types(d.status) else '[]'::jsonb end);
end $function$;

create or replace function erp_documents.service_journal_context(p_user_id uuid, p_document_id uuid, p_write boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare d erp_documents.document%rowtype;r text;
begin
 perform erp_documents.require_access(p_user_id,'service_orders',p_write);
 select * into d from erp_documents.document where id=p_document_id and kind='service_orders';
 if not found then raise exception 'erp_journal_not_found' using errcode='P0002';end if;
 -- 267: the diário of an OS of a contact the user does not see is not found.
 if not erp_documents.contact_usable(p_user_id,d.contact_id) then raise exception 'erp_journal_not_found' using errcode='P0002';end if;
 select role into r from erp_access.membership where user_id=p_user_id and active;
 return jsonb_build_object('scope','service_order_journal','document_id',d.id,'document_version',d.version,
  'can_write',erp_documents.allowed(r,'service_orders',true),'data_mode','erp_native','operational_effects',false);
end $function$;

create or replace function public.erp_document_occurrence_list(p_user_id uuid, p_kind text, p_document_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_row erp_documents.document%rowtype; v_role text; v_items jsonb; v_count bigint;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 select * into v_row from erp_documents.document where id=p_document_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_row.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 select coalesce(jsonb_agg(erp_documents.occurrence_list_json(o) order by o.sequence desc),'[]'::jsonb) into v_items
  from (select * from erp_documents.occurrence x where x.document_id=p_document_id
   and not exists(select 1 from erp_documents.occurrence_removal r where r.occurrence_id=x.id) order by x.sequence desc limit 500) o;
 select count(*) into v_count from erp_documents.occurrence x where x.document_id=p_document_id
  and not exists(select 1 from erp_documents.occurrence_removal r where r.occurrence_id=x.id);
 return jsonb_build_object('kind',p_kind,'document',jsonb_build_object('id',v_row.id,'kind',v_row.kind,'number',v_row.number::text,'status',v_row.status,'version',v_row.version,
   'situation',erp_documents.document_situation_json(v_row.id)),
  'items',v_items,'has_more',v_count>500,'can_write',erp_documents.allowed(v_role,p_kind,true),
  'date_editable',erp_documents.preference('empresa.editar_data_ocorrencia')='true'::jsonb,'data_mode','erp_native','operational_effects',false);
end $function$;

create or replace function public.erp_document_occurrence_remove(p_user_id uuid, p_kind text, p_document_id uuid, p_occurrence_id uuid, p_command_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_occurrence erp_documents.occurrence; v_role text; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_document_id is null or p_occurrence_id is null then raise exception 'erp_document_occurrence_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','occurrence_remove','actor',p_user_id,'kind',p_kind,'id',p_document_id,'occurrence',p_occurrence_id)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_documents.document where id=p_document_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_row.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 select * into v_occurrence from erp_documents.occurrence where id=p_occurrence_id and document_id=p_document_id;
 if not found or exists(select 1 from erp_documents.occurrence_removal where occurrence_id=p_occurrence_id) then
  raise exception 'erp_document_occurrence_not_found' using errcode='P0002'; end if;
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 insert into erp_documents.occurrence_removal(occurrence_id,document_id,actor_id,actor_role,command_id) values(p_occurrence_id,p_document_id,p_user_id,coalesce(v_role,'desconhecido'),p_command_id);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,p_document_id,'occurrence_remove',erp_documents.occurrence_json(v_occurrence),null);
 v_result:=jsonb_build_object('kind',p_kind,'document',jsonb_build_object('id',v_row.id,'kind',v_row.kind,'number',v_row.number::text,'status',v_row.status,'version',v_row.version),
  'removed_id',p_occurrence_id,'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

create or replace function public.erp_document_pendencies(p_user_id uuid, p_kind text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v erp_documents.document%rowtype;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_kind<>'sales_orders' then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 select * into v from erp_documents.document where id=p_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('kind',p_kind,'document',jsonb_build_object('id',v.id,'kind',v.kind,'number',v.number::text,'status',v.status,'version',v.version),
  'pendencies',erp_documents.pendencies(p_id),'data_mode','erp_native','operational_effects',false);
end $function$;

create or replace function public.erp_document_copy_preview(p_user_id uuid, p_kind text, p_source_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_source erp_documents.document%rowtype; v_data jsonb; v_items jsonb; field text; v_keep_date boolean;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_source.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 v_keep_date:=p_kind='purchase_orders' and erp_documents.preference('compras.clonagem_data')='"data_original"'::jsonb;
 select coalesce(jsonb_agg(jsonb_build_object('id',null,'product_id',i.product_id,'description',i.data->'description',
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),
  'discount_percent',i.discount_percent::text)
  ||case when i.data?'detailed_description' then jsonb_build_object('detailed_description',i.data->'detailed_description') else '{}'::jsonb end
  ||case when i.data?'list_price' then jsonb_build_object('list_price',i.data->'list_price') else '{}'::jsonb end
  ||case when i.data?'supplier_code' then jsonb_build_object('supplier_code',i.data->'supplier_code') else '{}'::jsonb end
  -- 267/268: Peças / Serviços executados of the OS, with Orçar and OK of the serviço.
  ||case when i.data?'group' then jsonb_build_object('group',i.data->'group','quote',coalesce(i.data->'quote','false'::jsonb),'done',coalesce(i.data->'done','false'::jsonb)) else '{}'::jsonb end order by i.position),'[]'::jsonb) into v_items
  from erp_documents.item i where i.document_id=p_source_id;
 v_data:=jsonb_build_object('date',case when v_keep_date then (v_source.body->>'date')::date else (clock_timestamp() at time zone 'America/Sao_Paulo')::date end,
  'contact_id',v_source.contact_id,'warehouse_id',v_source.warehouse_id,'expected_date',case when v_keep_date then (v_source.body->>'expected_date')::date end,'valid_until',null,
  'next_contact',null,'template',false,'items',v_items,'installments','[]'::jsonb,
  'equipment',null,'serial_number',null,'technician',null,'defect',null,'solution',null);
 foreach field in array array['discount_mode','discount_value','freight','other_expenses','payment_terms','delivery_terms','notes','internal_notes'] loop
  v_data:=v_data||jsonb_build_object(field,v_source.body->field);
 end loop;
 if p_kind<>'purchase_orders' and v_source.body->>'seller_id' is not null then v_data:=v_data||jsonb_build_object('seller_id',v_source.body->'seller_id'); end if;
 -- 168: the copy keeps the categoria and the transportador while they can still be chosen.
 if erp_documents.category_usable(p_kind,v_source.body->>'category_id') then v_data:=v_data||jsonb_build_object('category_id',v_source.body->'category_id'); end if;
 if erp_documents.carrier_usable(v_source.body->>'carrier_id') then v_data:=v_data||jsonb_build_object('carrier_id',v_source.body->'carrier_id'); end if;
 -- 196: Lista de preço (valid now), Destino (active conta), Detalhes de pagamento and the taxes of the source.
 if exists(select 1 from erp_pricing.price_list l where l.id::text=v_source.body->>'price_list_id' and erp_pricing.valid_now(l)) then
  v_data:=v_data||jsonb_build_object('price_list_id',v_source.body->'price_list_id'); end if;
 if exists(select 1 from erp_finance.account a where a.id::text=v_source.body->>'payment_account_id' and a.active) then
  v_data:=v_data||jsonb_build_object('payment_account_id',v_source.body->'payment_account_id'); end if;
 foreach field in array array['payment_means','payment_indicator','tax_ipi','tax_icms_st'] loop
  if v_source.body?field then v_data:=v_data||jsonb_build_object(field,v_source.body->field); end if;
 end loop;
 if erp_documents.has_commercial_data(erp_documents.dto(p_source_id)) then
  select coalesce(jsonb_agg(value||jsonb_build_object('detailed_description',value->'detailed_description') order by ordinality),'[]'::jsonb) into v_items
   from jsonb_array_elements(v_items) with ordinality;
  v_data:=v_data||jsonb_build_object('commercial',v_source.body->'commercial','items',v_items);
 elsif v_source.body?'commercial' then
  v_data:=v_data||jsonb_build_object('commercial',v_source.body->'commercial');
 end if;
 return jsonb_build_object('source',jsonb_build_object('id',v_source.id,'kind',v_source.kind,'number',v_source.number::text,'version',v_source.version),
  'data',v_data,'reset_fields',case when v_keep_date then jsonb_build_array('valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution')
   else jsonb_build_array('date','expected_date','valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution') end,
  'persisted',false,'data_mode','erp_native','operational_effects',false);
end $function$;

create or replace function public.erp_document_copy(p_user_id uuid, p_kind text, p_source_id uuid, p_expected_source_version integer, p_command_id uuid, p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_source erp_documents.document%rowtype; v_hash text; v_replay jsonb; v_data jsonb; v_items jsonb;
 v_contact uuid; v_warehouse uuid; v_refs uuid[]; v_snapshot jsonb; v_id uuid; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_source_id is null or p_expected_source_version is null or p_expected_source_version<1 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','copy_document','actor',p_user_id,'kind',p_kind,'source',p_source_id,
  'source_version',p_expected_source_version,'body',p_body)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash);
 if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind for share;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_source.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_source_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_data:=erp_documents.normalize(p_kind,p_body);
 perform erp_documents.require_commercial_input(erp_documents.dto(p_source_id),p_body);
 perform erp_documents.check_preference_rules(p_kind,v_data);
 perform erp_documents.check_seller_rules(p_user_id,p_kind,v_data);
 perform erp_documents.require_seller((v_data->>'seller_id')::uuid);
 perform erp_documents.check_links(p_kind,v_data,null);
 perform erp_documents.check_payment_links(p_kind,v_data,null);
 perform erp_documents.check_tax_preference(v_data,v_source.body);
 perform erp_documents.check_credit_limit(p_user_id,p_kind,v_data,null);
 v_contact:=(v_data->>'contact_id')::uuid;v_warehouse:=(v_data->>'warehouse_id')::uuid;
 select array_agg(distinct id) into v_refs from (
  select v_contact id union all select v_warehouse union all
  select (value->>'product_id')::uuid from jsonb_array_elements(v_data->'items')) refs where id is not null;
 perform r.id from erp_catalog.record r where r.id=any(v_refs) order by r.id for share;
 select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id
  where r.id=v_contact and r.active;
 if not found then raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 if v_warehouse is not null and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=v_warehouse and r.active) then
  raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(v_data->'items') i where i->>'product_id' is not null and not exists(
  select 1 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=(i->>'product_id')::uuid and r.active)) then
  raise exception 'erp_document_product_unavailable' using errcode='22023'; end if;
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
 values(p_kind,erp_documents.next_number(p_kind),erp_documents.initial_status(p_kind),
  v_contact,v_warehouse,v_snapshot,v_data-'items',(v_data#>>'{totals,total}')::numeric,p_user_id,p_user_id) returning id into v_id;
 select coalesce(jsonb_agg(value||'{"id":null}'::jsonb order by position),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_data->'items') with ordinality as lines(value,position);
 perform erp_documents.replace_items(v_id,v_items);
 insert into erp_documents.copy_source(destination_id,source_id,source_kind,source_number,source_version,actor,command_id)
  values(v_id,p_source_id,p_kind,v_source.number,p_expected_source_version,p_user_id,p_command_id);
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(v_id),'copy_source',erp_documents.copy_source_dto(v_id),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,v_id,'create_from_copy',jsonb_build_object('copy_source',erp_documents.copy_source_dto(v_id)),erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

create or replace function public.erp_proposal_convert(p_user_id uuid, p_id uuid, p_expected_version integer, p_command_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype; v_sale erp_documents.document%rowtype;
 v_id uuid; v_before jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','convert','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_proposals' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_source.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version or v_source.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 select * into v_sale from erp_documents.document where source_proposal_id=p_id;
 if found then raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 perform erp_documents.check_preference_rules('sales_orders',erp_documents.stored_rules_data(p_id));
 v_before:=erp_documents.dto(p_id);
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)
 values('sales_orders',erp_documents.next_number('sales_orders'),erp_documents.initial_status('sales_orders'),v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  erp_documents.sale_body_from_proposal(v_source.body),v_source.total,p_id,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,
   i.data||jsonb_build_object('id',n.new_id)
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null)n where i.document_id=p_id;
 update erp_documents.document set status='completed',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_source.version+1,v_source.status,'completed',null);
 v_result:=jsonb_build_object('proposal',erp_documents.dto(p_id),'sale',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,p_id,'convert_to_sale',v_before,erp_documents.dto(p_id)),
  (p_user_id,p_command_id,v_id,'create_from_proposal',null,erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

create or replace function public.erp_proposal_convert_to_service(p_user_id uuid, p_id uuid, p_expected_version integer, p_command_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype;
 v_id uuid; v_before jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','convert_to_service','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash);
 if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_proposals' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_source.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version or v_source.version=2147483647 then
  raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from erp_documents.document where source_proposal_id=p_id) then
  raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then
  raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 perform erp_documents.check_preference_rules('service_orders',erp_documents.stored_rules_data(p_id));
 v_before:=erp_documents.dto(p_id);
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)
 values('service_orders',erp_documents.next_number('service_orders'),'open',v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  v_source.body||'{"template":false}'::jsonb,v_source.total,p_id,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,
  i.data||jsonb_build_object('id',n.new_id)
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null)n where i.document_id=p_id;
 update erp_documents.document set status='completed',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_source.version+1,v_source.status,'completed',null);
 v_result:=jsonb_build_object('proposal',erp_documents.dto(p_id),'service_order',erp_documents.dto(v_id),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,p_id,'convert_to_service',v_before,erp_documents.dto(p_id)),
  (p_user_id,p_command_id,v_id,'create_from_proposal',null,erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

create or replace function public.erp_sales_order_convert_to_service(p_user_id uuid, p_id uuid, p_expected_version integer, p_command_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype; v_id uuid; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','sales_to_service','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_orders' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_source.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from erp_documents.sales_service_link where sales_order_id=p_id) then raise exception 'erp_sales_order_already_converted' using errcode='40001'; end if;
 if v_source.status='cancelled' or erp_documents.order_invoice(p_id) is not null then raise exception 'erp_sales_order_not_convertible' using errcode='22023'; end if;
 perform erp_documents.check_preference_rules('service_orders',erp_documents.stored_rules_data(p_id));
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
 values('service_orders',erp_documents.next_number('service_orders'),'open',v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  v_source.body-array['ship_date','customer_po_number','delivery_address','payment_means','payment_indicator']||'{"template":false}'::jsonb,v_source.total,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,i.data||jsonb_build_object('id',n.new_id)
 -- Correlated lateral: one new id per item (131 drew a single id for every line, so a pedido with two items failed).
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null) n where i.document_id=p_id;
 insert into erp_documents.sales_service_link(sales_order_id,service_order_id,actor,command_id) values(p_id,v_id,p_user_id,p_command_id);
 perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_source.version,v_source.status,null,
  'Ordem de serviço '||(select number::text from erp_documents.document where id=v_id)||' gerada a partir deste pedido');
 v_result:=jsonb_build_object('sale',erp_documents.dto(p_id),'service_order',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,v_id,'create_from_sales_order',jsonb_build_object('sales_order_id',p_id,'sales_order_number',v_source.number::text),erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

-- ---------------------------------------------------------------- Escopo do vendedor nos relatórios
create or replace function public.erp_document_sales_report(p_user_id uuid, p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_from date; v_to date; v_group text; v_sub text; v_order text; v_date text; v_statuses text[]; v_freight boolean; v_items boolean;
 v_contact uuid; v_product uuid; v_warehouse uuid; v_city text; v_state text; v_without boolean; v_first boolean; v_groups jsonb; v_totals jsonb; v_count bigint; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 if p_filters is null or jsonb_typeof(p_filters)<>'object' or exists(select 1 from jsonb_object_keys(p_filters) k where k not in
   ('from','to','date_type','group','subgroup','order','statuses','include_freight','contact_id','product_id','warehouse_id','city','state','without_invoice','first_purchase'))
  or exists(select 1 from unnest(array['include_freight','without_invoice','first_purchase']) k where p_filters?k and jsonb_typeof(p_filters->k)<>'boolean')
  or exists(select 1 from unnest(array['date_type','group','subgroup','order']) k where p_filters?k and jsonb_typeof(p_filters->k)<>'string') then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 v_from:=erp_documents.date_value(p_filters->'from',true); v_to:=erp_documents.date_value(p_filters->'to',true);
 v_group:=coalesce(p_filters->>'group','contact'); v_sub:=nullif(p_filters->>'subgroup','none'); v_order:=coalesce(p_filters->>'order','name'); v_date:=coalesce(p_filters->>'date_type','date');
 v_freight:=coalesce((p_filters->>'include_freight')::boolean,true); v_without:=coalesce((p_filters->>'without_invoice')::boolean,false); v_first:=coalesce((p_filters->>'first_purchase')::boolean,false);
 v_contact:=erp_documents.uuid_value(p_filters->'contact_id'); v_product:=erp_documents.uuid_value(p_filters->'product_id'); v_warehouse:=erp_documents.uuid_value(p_filters->'warehouse_id');
 v_city:=lower(erp_documents.text_value(p_filters->'city',100)); v_state:=upper(erp_documents.text_value(p_filters->'state',2));
 if p_filters ? 'statuses' and p_filters->'statuses'<>'null'::jsonb then
  if jsonb_typeof(p_filters->'statuses')<>'array' or jsonb_array_length(p_filters->'statuses') not between 1 and 20
   or exists(select 1 from jsonb_array_elements(p_filters->'statuses') s where jsonb_typeof(s)<>'string' or not (erp_documents.transitions()->'sales_orders')?(s#>>'{}')) then
   raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
  select array_agg(distinct s) into v_statuses from jsonb_array_elements_text(p_filters->'statuses') s;
 end if;
 if v_from>v_to or v_to-v_from>731 or v_group not in('contact','product','seller','district') or (v_sub is not null and (v_sub not in('contact','product','seller') or v_sub=v_group))
  or v_order not in('name','amount','items','sales') or v_date not in('date','expected_date')
  or (v_state is not null and v_state!~'^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$') then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 -- The Brufap notas (and their drafts) are read only by admin and fiscal (113), so only they filter by them.
 if v_without and not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role in('admin','fiscal')) then
  raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 v_items:=v_group='product' or coalesce(v_sub,'')='product';
 with orders as materialized(
  select d.id,d.contact_id,d.contact_snapshot,d.body,d.total,coalesce((d.body->>'freight')::numeric,0) freight
  from erp_documents.document d
  where d.kind='sales_orders' and (v_statuses is null or d.status=any(v_statuses))
   -- 267: only the contacts of the seller of the user (Contato acessível somente ao vendedor vinculado).
   and erp_catalog.contact_visible_to(v_scope,d.contact_id)
   and (case when v_date='expected_date' then d.body->>'expected_date' else d.body->>'date' end) between v_from::text and v_to::text
   and (v_contact is null or d.contact_id=v_contact) and (v_warehouse is null or d.warehouse_id=v_warehouse)
   and (v_city is null or strpos(lower(coalesce(d.contact_snapshot->>'city','')),v_city)>0) and (v_state is null or upper(coalesce(d.contact_snapshot->>'state',''))=v_state)
   and (v_product is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=v_product))
   and (not v_without or (not exists(select 1 from erp_fiscal_drafts.draft x where x.source_document_id=d.id and x.status='draft')
    and not exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id where o.document_id=d.id and n.deleted_at is null)))
   and (not v_first or (d.status<>'cancelled' and not exists(select 1 from erp_documents.document f where f.kind='sales_orders' and f.contact_id=d.contact_id and f.status<>'cancelled'
    and f.id<>d.id and (f.body->>'date',f.number)<(d.body->>'date',d.number))))
 ), lines as materialized(
  -- One row per item when a product dimension is used (value = item total); else one row per pedido (value = total, with or without frete).
  select o.id order_id,o.contact_id,o.contact_snapshot,o.body,i.product_id,i.data->>'description' description,i.data->>'code' code,i.quantity,
   i.total as amount from orders o join erp_documents.item i on i.document_id=o.id where v_items and (v_product is null or i.product_id=v_product)
  union all
  select o.id,o.contact_id,o.contact_snapshot,o.body,null,null,null,(select coalesce(sum(i.quantity),0) from erp_documents.item i where i.document_id=o.id),
   o.total-case when v_freight then 0 else o.freight end from orders o where not v_items
 ), keyed as materialized(
  select l.*,
   case v_group when 'contact' then l.contact_id::text when 'product' then coalesce(l.product_id::text,'livre:'||lower(l.description)) when 'seller' then coalesce(erp_documents.report_seller(l.body),'')
    else lower(coalesce(nullif(btrim(l.body#>>'{delivery_address,district}'),''),nullif(btrim(l.contact_snapshot->>'district'),''),'')) end group_key,
   case v_group when 'contact' then l.contact_snapshot->>'name' when 'product' then l.description||case when l.code is not null then ' ('||l.code||')' else '' end
    when 'seller' then coalesce(erp_documents.report_seller(l.body),'Sem vendedor') else coalesce(nullif(btrim(l.body#>>'{delivery_address,district}'),''),nullif(btrim(l.contact_snapshot->>'district'),''),'Sem bairro') end group_label,
   case v_sub when 'contact' then l.contact_id::text when 'product' then coalesce(l.product_id::text,'livre:'||lower(l.description)) when 'seller' then coalesce(erp_documents.report_seller(l.body),'') end sub_key,
   case v_sub when 'contact' then l.contact_snapshot->>'name' when 'product' then l.description||case when l.code is not null then ' ('||l.code||')' else '' end
    when 'seller' then coalesce(erp_documents.report_seller(l.body),'Sem vendedor') end sub_label
  from lines l
 ), subs as (
  select group_key,sub_key,min(sub_label) label,count(distinct order_id) sales,sum(quantity) items,sum(amount) amount from keyed where v_sub is not null group by group_key,sub_key
 ), groups as (
  select k.group_key,min(k.group_label) label,count(distinct k.order_id) sales,sum(k.quantity) items,sum(k.amount) amount from keyed k group by k.group_key
 ), ranked as (
  select g.*,row_number() over(order by case when v_order='amount' then g.amount end desc nulls last,case when v_order='items' then g.items end desc nulls last,
   case when v_order='sales' then g.sales end desc nulls last,lower(g.label),g.group_key) position from groups g
 )
 select coalesce(jsonb_agg(jsonb_build_object('key',r.group_key,'label',r.label,'sales',r.sales,'items',r.items::text,'amount',r.amount::numeric(20,2)::text,
   'subgroups',case when v_sub is null then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('key',s.sub_key,'label',s.label,'sales',s.sales,'items',s.items::text,'amount',s.amount::numeric(20,2)::text)
    order by case when v_order='amount' then s.amount end desc nulls last,case when v_order='items' then s.items end desc nulls last,case when v_order='sales' then s.sales end desc nulls last,lower(s.label),s.sub_key),'[]'::jsonb)
    -- The 500 first sub groups in the chosen order (not an arbitrary 500).
    from (select * from subs s where s.group_key=r.group_key order by case when v_order='amount' then s.amount end desc nulls last,case when v_order='items' then s.items end desc nulls last,
     case when v_order='sales' then s.sales end desc nulls last,lower(s.label),s.sub_key limit 500) s) end) order by r.position) filter(where r.position<=2000),'[]'::jsonb),
  count(*),
  jsonb_build_object('sales',(select count(*) from orders),'items',(select coalesce(sum(quantity),0) from keyed)::text,'amount',(select coalesce(sum(amount),0) from keyed)::numeric(20,2)::text)
 into v_groups,v_count,v_totals from ranked r;
 return jsonb_build_object('report','sales','group',v_group,'subgroup',v_sub,'from',v_from::text,'to',v_to::text,'item_values',v_items,'include_freight',v_freight,
  'groups',v_groups,'group_count',v_count,'truncated',v_count>2000,'totals',v_totals,'data_mode','erp_native','operational_effects',false);
end $function$;

create or replace function public.erp_document_sales_abc(p_user_id uuid, p_from text, p_to text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_from date; v_to date; v_rows jsonb; v_total numeric; v_count bigint; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 v_from:=erp_documents.date_value(to_jsonb(p_from),true); v_to:=erp_documents.date_value(to_jsonb(p_to),true);
 if v_from>v_to or v_to-v_from>366 then raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 with lines as(
  select coalesce(i.product_id::text,'livre:'||lower(i.data->>'description')) key,i.product_id,i.data->>'description' description,i.data->>'code' code,i.quantity,i.total
  from erp_documents.document d join erp_documents.item i on i.document_id=d.id
  where d.kind='sales_orders' and d.status<>'cancelled' and d.body->>'date' between v_from::text and v_to::text
   and erp_catalog.contact_visible_to(v_scope,d.contact_id)
 ), products as(
  select key,(array_agg(product_id))[1] product_id,min(description) description,min(code) code,sum(quantity) quantity,sum(total) amount from lines group by key
 ), ranked as(
  select p.*,row_number() over(order by p.amount desc,lower(p.description),p.key) position,sum(p.amount) over() total,
   sum(p.amount) over(order by p.amount desc,lower(p.description),p.key rows between unbounded preceding and current row) accumulated from products p
 )
 select coalesce(jsonb_agg(jsonb_build_object('position',r.position,'product_id',r.product_id,'description',r.description,'code',r.code,'quantity',r.quantity::text,
   'amount',r.amount::numeric(20,2)::text,'percent',case when r.total>0 then round(r.amount*100/r.total,2) else 0 end::numeric(7,2)::text,
   'accumulated',case when r.total>0 then round(r.accumulated*100/r.total,2) else 0 end::numeric(7,2)::text,
   'class',case when r.total=0 or (r.accumulated-r.amount)*100<80*r.total then 'A' when (r.accumulated-r.amount)*100<95*r.total then 'B' else 'C' end) order by r.position) filter(where r.position<=5000),'[]'::jsonb),
  max(r.total),count(*) into v_rows,v_total,v_count from ranked r;
 return jsonb_build_object('report','abc','from',v_from::text,'to',v_to::text,'items',v_rows,'item_count',v_count,'truncated',v_count>5000,
  'total',coalesce(v_total,0)::numeric(20,2)::text,'data_mode','erp_native','operational_effects',false);
end $function$;

create or replace function public.erp_document_service_report(p_user_id uuid, p_conditions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_rows jsonb; v_count bigint; v_condition jsonb; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 perform erp_documents.require_access(p_user_id,'service_orders',false);
 if p_conditions is null or jsonb_typeof(p_conditions)<>'array' or jsonb_array_length(p_conditions)>10 then raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 for v_condition in select x from jsonb_array_elements(p_conditions) x loop
  if jsonb_typeof(v_condition)<>'object' or (select count(*) from jsonb_object_keys(v_condition))<>2 or not(v_condition?'column' and v_condition?'value') or jsonb_typeof(v_condition->'value')<>'string'
   or v_condition->>'column' not in('number','name','date','parts','services','total','status') or length(v_condition->>'value') not between 1 and 120 or (v_condition->>'value')~'[[:cntrl:]]'
   or (v_condition->>'column'='number' and v_condition->>'value'!~'^[1-9][0-9]{0,9}$') or (v_condition->>'column'='date' and v_condition->>'value'!~'^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
   or (v_condition->>'column' in('parts','services','total') and v_condition->>'value'!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$')
   or (v_condition->>'column'='status' and not (erp_documents.transitions()->'service_orders')?(v_condition->>'value')) then
   raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
  if v_condition->>'column'='date' then perform erp_documents.date_value(v_condition->'value',true); end if;
 end loop;
 with os as(
  select d.id,d.number,d.contact_snapshot->>'name' as name,d.body->>'date' as day,d.status,d.total,
   coalesce((select sum(i.total) from erp_documents.item i where i.document_id=d.id and case when i.data?'group' then i.data->>'group'='service' else coalesce(i.product_snapshot->>'kind','')='S' end),0) services,
   coalesce((select sum(i.total) from erp_documents.item i where i.document_id=d.id and case when i.data?'group' then i.data->>'group'='part' else coalesce(i.product_snapshot->>'kind','')<>'S' end),0) parts
  from erp_documents.document d where d.kind='service_orders' and erp_catalog.contact_visible_to(v_scope,d.contact_id)
 ), filtered as(
  select o.* from os o where not exists(select 1 from jsonb_array_elements(p_conditions) c where not case c->>'column'
   when 'number' then o.number=(c->>'value')::bigint when 'name' then strpos(lower(coalesce(o.name,'')),lower(btrim(c->>'value')))>0
   when 'date' then o.day=c->>'value' when 'parts' then o.parts=(c->>'value')::numeric when 'services' then o.services=(c->>'value')::numeric
   when 'total' then o.total=(c->>'value')::numeric else o.status=c->>'value' end)
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'number',f.number::text,'name',f.name,'date',f.day,'parts',f.parts::numeric(20,2)::text,'services',f.services::numeric(20,2)::text,
   'total',f.total::text,'status',f.status) order by f.day desc,f.number desc) filter(where f.rn<=5000),'[]'::jsonb),count(*)
 into v_rows,v_count from (select f.*,row_number() over(order by f.day desc,f.number desc) rn from filtered f) f;
 return jsonb_build_object('report','service_orders','rows',v_rows,'row_count',v_count,'truncated',v_count>5000,'data_mode','erp_native','operational_effects',false);
end $function$;

create or replace function public.erp_document_service_occurrence_report(p_user_id uuid, p_from text, p_to text, p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_from date; v_to date; v_rows jsonb; v_count bigint; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 perform erp_documents.require_access(p_user_id,'service_orders',false);
 v_from:=erp_documents.date_value(to_jsonb(p_from),true); v_to:=erp_documents.date_value(to_jsonb(p_to),true);
 if v_from>v_to or v_to-v_from>366 or (p_status is not null and not (erp_documents.transitions()->'service_orders')?p_status) then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('document_id',x.document_id,'number',x.number::text,'name',x.name,'occurred_on',x.occurred_on::text,'occurred_time',x.occurred_time,
   'text',x.text,'status_before',x.status_before,'status_after',x.status_after,'actor_name',x.actor_name,'actor_role',x.actor_role) order by x.occurred_on desc,x.occurred_time desc,x.number desc,x.sequence desc) filter(where x.rn<=5000),'[]'::jsonb),count(*)
 into v_rows,v_count from (
  select o.*,d.number,d.contact_snapshot->>'name' name,(select left(p.name,120) from erp_access.profile p where p.user_id=o.actor_id) actor_name,
   row_number() over(order by o.occurred_on desc,o.occurred_time desc,d.number desc,o.sequence desc) rn
  from erp_documents.occurrence o join erp_documents.document d on d.id=o.document_id
  where d.kind='service_orders' and o.occurred_on between v_from and v_to and erp_catalog.contact_visible_to(v_scope,d.contact_id) and (p_status is null or coalesce(o.status_after,o.status_before)=p_status)
   and not exists(select 1 from erp_documents.occurrence_removal r where r.occurrence_id=o.id)) x;
 return jsonb_build_object('report','service_occurrences','from',v_from::text,'to',v_to::text,'rows',v_rows,'row_count',v_count,'truncated',v_count>5000,'data_mode','erp_native','operational_effects',false);
end $function$;

-- ---------------------------------------------------------------- Frente de caixa: efeito recusado fica pendente
-- 205 plus: each Lançar estoque, Lançar contas and baixa à vista runs in its own block; a refusal of the RPC (22023, 40001, 42501,
-- P0002) rolls back only that block and the effect stays pending in the pedido, with the reason (an erp_* code, never the SQL text).
create or replace function erp_pos.sale_effects(p_user uuid,p_command uuid,p_id uuid,a jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $function$
declare s erp_pos.sale%rowtype; d erp_documents.document%rowtype; v_role text:=a->>'role'; v_today date:=erp_pos.today(); v_reason text; v_preview jsonb; v_result jsonb;
 v_stock text; v_finance text; v_posting uuid; t jsonb; p erp_pos.sale_payment%rowtype; m erp_catalog.payment_method%rowtype; v_target uuid; v_settled bigint:=0; v_open bigint:=0;
 v_stock_reason text; v_finance_reason text; v_settle_reason text;
begin
 select * into s from erp_pos.sale where id=p_id;
 select * into d from erp_documents.document where id=s.document_id;
 v_reason:='Venda da frente de caixa nº '||d.number::text;
 if d.status<>'fulfilled' then
  perform public.erp_document_transition(p_user,'sales_orders',d.id,d.version,erp_pos.step(p_command,'fulfil'),'fulfilled',null);
 end if;
 -- Estoque: só os produtos de estoque (tipo P) movimentam; uma regra do Gerenciador de transições pode já ter lançado.
 if exists(select 1 from erp_stock.document_posting where document_id=d.id and state='active') then v_stock:='posted';
 elsif not exists(select 1 from erp_documents.item i join erp_catalog.product x on x.record_id=i.product_id where i.document_id=d.id and x.kind='P') then v_stock:='none';
 elsif v_role in('admin','estoque') then
  begin
   v_preview:=public.erp_document_stock_preview(p_user,'sales_orders',d.id,erp_pos.document_version(d.id),v_today,v_reason)->'preview';
   perform public.erp_document_stock_post(p_user,'sales_orders',d.id,erp_pos.document_version(d.id),erp_pos.step(p_command,'stock'),v_preview->>'preview_hash',v_today,v_reason,
    coalesce((select jsonb_agg(i->'id') from jsonb_array_elements(v_preview->'ignored') i),'[]'::jsonb));
   v_stock:='posted';
  exception when sqlstate '22023' or sqlstate '40001' or sqlstate '42501' or sqlstate 'P0002' then
   v_stock:='pending'; v_stock_reason:=case when sqlerrm~'^erp_[a-z0-9_]{1,80}$' then sqlerrm else 'erp_document_stock_refused' end;
  end;
 else v_stock:='pending'; end if;
 -- Contas a receber das parcelas e baixa das parcelas à vista cuja forma vai para "Caixa e bancos": na conta da forma, senão no
 -- Destino da venda, senão na loja (conta Caixa). As demais parcelas ficam em aberto em Contas a receber.
 if exists(select 1 from erp_finance.document_posting where document_id=d.id and state='active') then v_finance:='posted';
 elsif v_role in('admin','financeiro') then
  begin
   v_preview:=public.erp_document_finance_preview(p_user,'sales_orders',d.id,erp_pos.document_version(d.id),null,null)->'preview';
   perform public.erp_document_finance_post(p_user,'sales_orders',d.id,erp_pos.document_version(d.id),erp_pos.step(p_command,'finance'),v_preview->>'preview_hash',null,null);
   v_finance:='posted';
  exception when sqlstate '22023' or sqlstate '40001' or sqlstate '42501' or sqlstate 'P0002' then
   v_finance:='pending'; v_finance_reason:=case when sqlerrm~'^erp_[a-z0-9_]{1,80}$' then sqlerrm else 'erp_document_finance_refused' end;
  end;
 else v_finance:='pending'; end if;
 select id into v_posting from erp_finance.document_posting where document_id=d.id and state='active';
 if v_posting is not null then
  for p in select * from erp_pos.sale_payment where sale_id=s.id order by position loop
   select x into t from jsonb_array_elements(erp_finance.document_title_rows(v_posting)) x where (x->>'position')::integer=p.position;
   if t is null then continue; end if;
   update erp_pos.sale_payment set title_id=(t->>'id')::uuid where sale_id=s.id and position=p.position;
   select * into m from erp_catalog.payment_method where id=p.payment_method_id;
   v_target:=coalesce(m.account_id,s.destination_account_id,s.account_id);
   if v_role in('admin','financeiro') and not s.to_ledger and p.days=0 and m.destination='caixa' and v_target is not null and (t->>'settled_cents')::bigint=0 and not (t->>'cancelled')::boolean then
    begin
     v_result:=public.erp_finance_execute(p_user,erp_pos.step(p_command,'settle:'||p.position::text),'settle',jsonb_build_object('id',t->>'id','expected_version',(t->>'version')::integer,
      'account_id',v_target,'posted_on',v_today::text,'principal_cents',p.amount_cents::text,'note',left('Recebido na frente de caixa — venda nº '||d.number::text,500)));
     update erp_pos.sale_payment set settlement_id=(v_result#>>'{settlement,id}')::uuid where sale_id=s.id and position=p.position;
     v_settled:=v_settled+p.amount_cents;
    exception when sqlstate '22023' or sqlstate '40001' or sqlstate '42501' or sqlstate 'P0002' then
     -- The parcela stays open in Contas a receber (Receber pelo financeiro).
     v_open:=v_open+p.amount_cents;
     v_settle_reason:=coalesce(v_settle_reason,case when sqlerrm~'^erp_[a-z0-9_]{1,80}$' then sqlerrm else 'erp_finance_settle_refused' end);
    end;
   else v_open:=v_open+p.amount_cents; end if;
  end loop;
 end if;
 return jsonb_build_object('stock',v_stock,'finance',v_finance,'settled_cents',v_settled::text,'open_cents',v_open::text)
  ||jsonb_strip_nulls(jsonb_build_object('stock_reason',v_stock_reason,'finance_reason',v_finance_reason,'settle_reason',v_settle_reason));
end $function$;

-- ---------------------------------------------------------------- Lançamento automático de contas
-- 196 plus the pedido de compra: Preferências › Suprimentos "Automação lançamento de contas pagar ao criar novo pedido de compra"
-- posts the contas a pagar in the save that creates the pedido (the audit row "create" of this command), with its parcelas; since 248
-- the Financeiro accepts the pedido de compra Em aberto. Edits, situações and ocorrências of the pedido de compra never post.
create or replace function erp_documents.auto_finance(p_user_id uuid,p_id uuid,p_command uuid) returns jsonb
language plpgsql set search_path=pg_catalog as $function$
declare d erp_documents.document; v_plan jsonb; v_category uuid; v_preview jsonb; v_post jsonb;
begin
 select * into d from erp_documents.document where id=p_id;
 if not found then return null; end if;
 if d.kind='purchase_orders' then
  if coalesce(erp_documents.preference('compras.automacao_contas_pagar'),'false'::jsonb)<>'true'::jsonb
   or not exists(select 1 from erp_documents.audit a where a.document_id=p_id and a.command_id=p_command and a.action='create')
   or d.status not in('open','in_progress','partially_fulfilled','fulfilled')
   or exists(select 1 from erp_finance.document_posting p where p.document_id=p_id and p.state='active') then return null; end if;
 elsif d.kind<>'sales_orders' or coalesce(erp_documents.preference('vendas.contas_automaticas_pedido'),'false'::jsonb)<>'true'::jsonb
  or d.status not in('verified','in_progress','partially_fulfilled','fulfilled')
  or exists(select 1 from erp_finance.document_posting p where p.document_id=p_id and p.state='active')
  or exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=p_id and g.active) then return null; end if;
 if not exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and m.role in('admin','financeiro')) then
  return jsonb_build_object('outcome','skipped','reason','erp_finance_access_denied'); end if;
 if d.total<=0 then return jsonb_build_object('outcome','skipped','reason','erp_document_finance_zero_total'); end if;
 if jsonb_array_length(coalesce(d.body->'installments','[]'::jsonb))=0 then
  -- The pedido de compra posts its parcelas (Origin); the pedido de venda without parcelas posts one à vista on its date.
  if d.kind='purchase_orders' then return jsonb_build_object('outcome','skipped','reason','erp_document_finance_no_installments'); end if;
  v_plan:=jsonb_build_array(jsonb_build_object('amount_cents',((d.total*100)::bigint)::text,'due_on',d.body->>'date','method',null));
 end if;
 v_category:=erp_documents.document_finance_category(d,null);
 begin
  v_preview:=public.erp_document_finance_preview(p_user_id,d.kind,p_id,d.version,v_category,v_plan)->'preview';
  v_post:=public.erp_document_finance_post(p_user_id,d.kind,p_id,d.version,erp_documents.transition_command(p_command,'auto_finance'),v_preview->>'preview_hash',v_category,v_plan);
  return jsonb_build_object('outcome','done','posting_id',v_post#>>'{posting,id}');
 exception when sqlstate '22023' or sqlstate '40001' or sqlstate '42501' or sqlstate 'P0002' then
  return jsonb_build_object('outcome','skipped','reason',case when sqlerrm~'^erp_[a-z0-9_]{1,80}$' then sqlerrm else 'erp_document_finance_refused' end);
 end;
end $function$;

-- Internal functions: no role executes them; the public RPCs keep service_role only.
revoke all on function erp_attachments.authorize(uuid,text,uuid,boolean),erp_documents.service_event_context(uuid,uuid),
 erp_documents.service_journal_context(uuid,uuid,boolean),erp_pos.sale_effects(uuid,uuid,uuid,jsonb),erp_documents.auto_finance(uuid,uuid,uuid)
 from public,anon,authenticated,service_role;
do $$declare f text;begin
 foreach f in array array['erp_document_occurrence_list(uuid,text,uuid)','erp_document_occurrence_remove(uuid,text,uuid,uuid,uuid)',
  'erp_document_pendencies(uuid,text,uuid)','erp_document_copy_preview(uuid,text,uuid)','erp_document_copy(uuid,text,uuid,integer,uuid,jsonb)',
  'erp_proposal_convert(uuid,uuid,integer,uuid)','erp_proposal_convert_to_service(uuid,uuid,integer,uuid)','erp_sales_order_convert_to_service(uuid,uuid,integer,uuid)',
  'erp_document_sales_report(uuid,jsonb)','erp_document_sales_abc(uuid,text,text)','erp_document_service_report(uuid,jsonb)',
  'erp_document_service_occurrence_report(uuid,text,text,text)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end$$;
commit;
