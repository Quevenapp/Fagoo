-- 239: Documentos (onda E), parte 2: permissões de Serviços (Ordem de Serviço) e aprovação de descontos do vendedor.
-- * Sistema › Usuários › Permissões › Serviços › Ordem de Serviço (229, erp_access.permitted) passam a valer nas OS: visualizar
--   (listagem, leitura e tudo que lê a OS), Inclusão e edição (gravar, copiar, anexos, diário e ocorrências sem situação), Gerenciar
--   situações (mudança de situação, também pelas ocorrências), Lançar estoque e Lançar contas (lançamentos e estornos, também pelas
--   ações do Gerenciador de transições), Histórico financeiro (aba Financeiro do histórico do cliente) e Alterar forma de pagamento
--   (uma Forma que a OS ainda não tem). Sem conjunto gravado o usuário tem tudo o que o perfil permite (regra de 229); Exclusão fica
--   guardada (a OS não é excluída no Brufap). erp_document_access informa as permissões para as telas.
-- * Preferências › Vendas › Vendas "Situação para aprovação de descontos" (situações personalizadas de Em digitação, até cinco, em
--   ordem): o pedido de venda do vendedor com desconto acima do "Limite de desconto" deixa de ser recusado e vai para Em digitação na
--   primeira situação ativa da lista ("Venda enviada para aprovação do desconto"); só quem tem "Desconsiderar limite de desconto do
--   vendedor" (o administrador, ou a permissão gravada no conjunto do usuário) tira o pedido dessas situações. Sem situação
--   configurada, ou com estoque, contas ou reservas ativos, a recusa de 164 continua. Quem tem a permissão não é limitado (pedidos
--   e propostas, cada um com a sua chave).
-- * Pedido de compra, "Últimas compras" do produto: também os lançamentos manuais de entrada (Estoque › Lançar estoque) não estornados,
--   quando não há fornecedor escolhido ("de todos"), com o preço de compra do lançamento (senão o custo); tipo "Lançamento de estoque".
-- * A gravação também segue o escopo do vendedor de 238 (contato visível) e a mudança de situação e a ocorrência recusam um documento
--   de contato que o usuário não vê.
-- Substitui funções das migrações 008, 017, 018, 196, 199 e 238 (conferidas pelo hash; outra versão interrompe a migração).
begin;

do $$declare r record;begin
 if to_regprocedure('erp_access.permitted(uuid,text)') is null or to_regprocedure('erp_documents.contact_usable(uuid,uuid)') is null then
  raise exception 'document_permissions_approval_239_requires_229_238' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_documents.require_access(uuid,text,boolean)','b98a19a91ec18234570a68cd1fe2eaddd0b820a064e427bad9b075daffce6e5f'),
  ('public.erp_document_access(uuid)','284d745934ed65f7d1f8dfc1543c4b1c09a0131bac521a62506048dc456f6ac4'),
  ('public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb)','63866f9c4588ce32115894d2596331eb12911111c7620cbd0d06d5b89934f01a'),
  ('public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text)','ef0b386a4ab3540d8ea9ef9b04a6bf7e9028a0d2196172ab9141f73efa7a4446'),
  ('public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text)','f624fcd58379835a0db1d9e7afe6032ca6f1817c3f0ae4d6a44c3616384312cd'),
  ('public.erp_document_stock_preview(uuid,text,uuid,integer,date,text)','630dbccc909fcd2c2b74d315bb5c00479a61cdcf83e165db099306f3bba8e5ad'),
  ('public.erp_document_stock_post(uuid,text,uuid,integer,uuid,text,date,text,jsonb)','e6edac451da9c309493447f70c1f5c0646e6ecd5a6b66d3a23899022090790b3'),
  ('public.erp_document_stock_reverse_preview(uuid,text,uuid,integer,uuid,integer,date,text)','ea7e6efc7157ee05bd3f7e51f7aa290e4efb324cd74fc02d1366e9fa8dc0c60d'),
  ('public.erp_document_stock_reverse(uuid,text,uuid,integer,uuid,integer,uuid,text,date,text)','240f06ab07d3dcc884e6aa43aad89305e6f108a190c8db3da139882352addd86'),
  ('public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb)','63ffac6a2313aab0b2d6c8a88083215acf0a7bdf31d6fe3bba1ceb4ee8acea18'),
  ('public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb)','2564822845b1a9d411a44e4d5ce5ad539870f685e74b3bada677ea47f034d653'),
  ('public.erp_document_finance_reverse_preview(uuid,text,uuid,integer,uuid,integer)','9f3bc7b9a7100c9adeb27ea2aca608bfebf222e9e99a7461df3cf715c6e18c63'),
  ('public.erp_document_finance_reverse(uuid,text,uuid,integer,uuid,integer,uuid,text,jsonb,text)','c6ad0e5622e3275e76abeefa091659d7523452ae2feac2ed098f71713eea259b'),
  ('public.erp_document_history(uuid,text,uuid,uuid,text,integer)','9e0f27b406f3fddcd4131435f19a54562d3420ddb99d3260b8ed6e14e9e468b0'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'document_permissions_approval_239_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- ---------------------------------------------------------------- Permissões da OS
-- The 008 rule of the profile (perfil), kept for the RPCs that check a permission of their own.
create function erp_documents.require_role(p_user_id uuid,p_kind text,p_write boolean)
returns void language plpgsql stable set search_path=pg_catalog as $$
declare v_role text; begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if not found or not erp_documents.allowed(v_role,p_kind,p_write) then
  raise exception 'erp_document_access_denied' using errcode='42501'; end if;
end $$;
-- Sistema › Usuários › Permissões › Serviços › Ordem de Serviço: the module (null) or one of its keys (ie, situacoes, lancar_estoque,
-- lancar_contas, historico_financeiro, forma_pagamento).
create function erp_documents.os_permitted(p_user_id uuid,p_key text) returns boolean language sql stable set search_path=pg_catalog as $$
 select erp_access.permitted(p_user_id,'servicos.ordem_servico'||coalesce('.'||p_key,''))
$$;
create function erp_documents.require_os_permission(p_user_id uuid,p_kind text,p_key text) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_kind='service_orders' and not erp_documents.os_permitted(p_user_id,p_key) then raise exception 'erp_document_permission_denied' using errcode='42501'; end if;
end $$;
-- The profile and, for the OS, the module (read) or Inclusão e edição (write).
create or replace function erp_documents.require_access(p_user_id uuid,p_kind text,p_write boolean)
returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 perform erp_documents.require_role(p_user_id,p_kind,p_write);
 if p_kind='service_orders' and not erp_documents.os_permitted(p_user_id,case when p_write then 'ie' end) then
  raise exception 'erp_document_access_denied' using errcode='42501'; end if;
end $$;
create function erp_documents.kind_allowed(p_user_id uuid,p_role text,p_kind text,p_write boolean) returns boolean language sql stable set search_path=pg_catalog as $$
 select erp_documents.allowed(p_role,p_kind,p_write) and (p_kind<>'service_orders' or erp_documents.os_permitted(p_user_id,case when p_write then 'ie' end))
$$;

-- ---------------------------------------------------------------- Aprovação de descontos
create table erp_documents.discount_approval(
 singleton boolean primary key default true check(singleton),
 situation_ids uuid[] not null default '{}' check(cardinality(situation_ids)<=5 and array_position(situation_ids,null) is null),
 version integer not null default 0 check(version between 0 and 2147483647),
 updated_by uuid references auth.users(id),updated_at timestamptz
);
insert into erp_documents.discount_approval(singleton) values(true);
create table erp_documents.discount_approval_audit(
 id bigint generated always as identity primary key,actor uuid not null references auth.users(id),command_id uuid not null unique,
 before_ids uuid[] not null,after_ids uuid[] not null,version integer not null check(version between 1 and 2147483647),created_at timestamptz not null default clock_timestamp()
);
create function erp_documents.discount_approval_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_document_discount_approval_audit_immutable' using errcode='55000'; end $$;
create trigger discount_approval_audit_immutable before update or delete on erp_documents.discount_approval_audit for each row execute function erp_documents.discount_approval_audit_immutable();
alter table erp_documents.discount_approval enable row level security;
alter table erp_documents.discount_approval_audit enable row level security;
revoke all on erp_documents.discount_approval,erp_documents.discount_approval_audit from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_documents from public,anon,authenticated,service_role;

-- "Desconsiderar limite de desconto do vendedor" (Pedidos de Venda / Propostas Comerciais): the administrador, or the key saved in
-- the permission set of the user. A user without a saved set keeps the limit of the seller (the 164 rule).
create function erp_documents.discount_approver(p_user_id uuid,p_kind text) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce((select m.role='admin' from erp_access.membership m where m.user_id=p_user_id and m.active),false)
  or coalesce((select c.permissions is not null and k.module=any(c.permissions) and k.module||'.limite_desconto'=any(c.permissions)
   from erp_access.user_control c,(select case p_kind when 'sales_orders' then 'vendas.pedidos_venda' when 'sales_proposals' then 'vendas.propostas' end module) k
   where c.user_id=p_user_id and k.module is not null),false)
$$;
-- The configured approval situações that are still custom situações of Em digitação, in order.
create function erp_documents.approval_situations() returns uuid[] language sql stable set search_path=pg_catalog as $$
 select coalesce(array(select u.id from erp_documents.discount_approval a,unnest(a.situation_ids) with ordinality u(id,n)
  where a.singleton and exists(select 1 from erp_preferences.situation s where s.id=u.id and s.kind='sales_orders' and s.base_status='draft') order by u.n),'{}'::uuid[])
$$;
-- Where a pedido above the limit goes: the first active approval situação (null: none, the pedido is refused as in 164).
create function erp_documents.approval_target() returns uuid language sql stable set search_path=pg_catalog as $$
 select u.id from unnest(erp_documents.approval_situations()) with ordinality u(id,n)
 where exists(select 1 from erp_preferences.situation s where s.id=u.id and s.active) order by u.n limit 1
$$;
-- 164 check_seller_rules plus the approval: returns the approval situação of a pedido de venda above the discount limit (null when
-- nothing waits for approval); raises as before otherwise. An approver of the kind is not limited.
create function erp_documents.seller_rules(p_user_id uuid,p_kind text,p_data jsonb) returns uuid
language plpgsql stable set search_path=pg_catalog as $$
declare s erp_catalog.seller%rowtype; v_gross numeric; v_discount numeric; v_target uuid;
begin
 if p_kind not in('sales_orders','sales_proposals','service_orders') then return null; end if;
 select * into s from erp_catalog.seller where user_id=p_user_id;
 if not found then return null; end if;
 if p_kind='sales_orders' and not s.allow_unregistered_products and exists(select 1 from jsonb_array_elements(p_data->'items') i where i->>'product_id' is null) then
  raise exception 'erp_document_seller_product_required' using errcode='22023'; end if;
 if s.discount_limit>0 and not erp_documents.discount_approver(p_user_id,p_kind) then
  v_gross:=(p_data#>>'{totals,gross}')::numeric; v_discount:=(p_data#>>'{totals,line_discount}')::numeric+(p_data#>>'{totals,discount}')::numeric;
  if exists(select 1 from jsonb_array_elements(p_data->'items') i where (i->>'discount_percent')::numeric>s.discount_limit)
   or (v_gross>0 and v_discount*100>s.discount_limit*v_gross) then
   v_target:=case when p_kind='sales_orders' then erp_documents.approval_target() end;
   if v_target is null then raise exception 'erp_document_seller_discount_limit' using errcode='22023'; end if;
   return v_target;
  end if;
 end if;
 return null;
end $$;
-- A change of situação the user may make: "Gerenciar situações" of the OS, and only an approver takes a pedido out of the approval
-- situações (moving between them stays open).
create function erp_documents.check_situation_change(p_user_id uuid,p_kind text,p_from_key text,p_to_key text) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare v_set uuid[];
begin
 perform erp_documents.require_os_permission(p_user_id,p_kind,'situacoes');
 if p_kind<>'sales_orders' then return; end if;
 v_set:=erp_documents.approval_situations();
 if p_from_key~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and p_from_key::uuid=any(v_set) and not(coalesce(p_to_key,'')~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and p_to_key::uuid=any(v_set))
  and not erp_documents.discount_approver(p_user_id,'sales_orders') then
  raise exception 'erp_document_discount_approval_required' using errcode='42501'; end if;
end $$;

-- GET /v1/documentos/sales_orders/aprovacao-descontos: the configured situações (also inactive ones, shown as such).
create function public.erp_document_discount_approval(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare a erp_documents.discount_approval%rowtype;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 select * into a from erp_documents.discount_approval where singleton;
 return jsonb_build_object('kind','sales_orders','version',a.version,
  'can_write',exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and m.role='admin'),
  'situations',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'color',s.color,'active',s.active) order by u.n),'[]'::jsonb)
   from unnest(erp_documents.approval_situations()) with ordinality u(id,n) join erp_preferences.situation s on s.id=u.id),
  'data_mode','erp_native','operational_effects',false);
end $$;
-- POST: the administrador chooses up to five custom situações of Em digitação (active), with command, version and audit.
create function public.erp_document_discount_approval_save(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_situations jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; a erp_documents.discount_approval%rowtype; v_ids uuid[]; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 if not exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and m.role='admin') then
  raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 if p_expected_version is null or p_expected_version not between 0 and 2147483646 or p_situations is null or jsonb_typeof(p_situations)<>'array'
  or jsonb_array_length(p_situations)>5 or exists(select 1 from jsonb_array_elements(p_situations) x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  or (select count(distinct x) from jsonb_array_elements_text(p_situations) x)<>jsonb_array_length(p_situations) then
  raise exception 'erp_document_discount_approval_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','discount_approval','actor',p_user_id,'version',p_expected_version,'situations',p_situations)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 v_ids:=array(select x::uuid from jsonb_array_elements_text(p_situations) with ordinality u(x,n) order by n);
 if exists(select 1 from unnest(v_ids) i where not exists(select 1 from erp_preferences.situation s where s.id=i and s.kind='sales_orders' and s.base_status='draft' and s.active)) then
  raise exception 'erp_document_discount_approval_invalid' using errcode='22023'; end if;
 select * into a from erp_documents.discount_approval where singleton for update;
 if a.version<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 update erp_documents.discount_approval set situation_ids=v_ids,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where singleton;
 insert into erp_documents.discount_approval_audit(actor,command_id,before_ids,after_ids,version) values(p_user_id,p_command_id,a.situation_ids,v_ids,a.version+1);
 v_result:=public.erp_document_discount_approval(p_user_id)||jsonb_build_object('replayed',false);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

create or replace function public.erp_document_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
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
end $$;

create or replace function public.erp_document_transition(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,
 p_command_id uuid,p_status text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_before jsonb; v_result jsonb; v_reason text;
 v_current uuid; v_from_key text; v_rule jsonb; v_target jsonb; v_pair_active boolean; v_to_base text; v_custom uuid; v_actions text[]; v_action text;
 v_effects jsonb:='[]'; v_from_situation jsonb; v_to_situation jsonb; v_auto jsonb;
begin
 -- 239: the profile writes the kind; the OS also needs "Gerenciar situações" (checked below with the approval rule).
 perform erp_documents.require_role(p_user_id,p_kind,true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','transition','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,'status',p_status,'reason',p_reason)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_reason:=erp_documents.text_value(to_jsonb(p_reason),1000);
 if not erp_documents.contact_usable(p_user_id,v_row.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if not erp_documents.situation_adopted(p_kind) then
  perform erp_documents.check_situation_change(p_user_id,p_kind,v_row.status,p_status);
  if p_status is null or not coalesce((erp_documents.transitions()#>array[p_kind,v_row.status])?p_status,false) then
   raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
  if erp_documents.transition_reason_required(p_kind,v_row.status,p_status) and coalesce(length(v_reason),0)<3 then
   raise exception 'erp_document_reason_required' using errcode='22023'; end if;
  if coalesce((v_row.body->>'template')::boolean,false) and p_status='approved' then raise exception 'erp_document_template_not_approvable' using errcode='22023'; end if;
  v_before:=erp_documents.dto(p_id);
  update erp_documents.document set status=p_status,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
  perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_row.version+1,v_row.status,p_status,v_reason);
  v_auto:=erp_documents.auto_finance(p_user_id,p_id,p_command_id);
  v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(p_id),'replayed',false,'data_mode','erp_native','operational_effects',false)
   ||case when v_auto is not null then jsonb_build_object('auto_finance',v_auto) else '{}'::jsonb end;
  insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
   values(p_user_id,p_command_id,p_id,'transition',v_reason,v_before,erp_documents.dto(p_id));
  insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  return v_result;
 end if;
 select situation_id into v_current from erp_documents.document_situation where document_id=p_id;
 v_from_key:=coalesce(v_current::text,v_row.status);
 perform erp_documents.check_situation_change(p_user_id,p_kind,v_from_key,p_status);
 if p_status is null or p_status=v_from_key or not erp_documents.situation_key_valid(p_kind,p_status) then
  raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
 v_rule:=erp_preferences.transition_rule(p_kind,v_from_key,p_status);
 v_target:=erp_preferences.situation_of(p_kind,p_status);
 if v_rule is null or v_target is null or not (v_rule->>'configured')::boolean then raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
 -- The pair must be active and the target situação too; leaving an inactive situação stays possible.
 v_pair_active:=coalesce((select t.active from erp_preferences.transition t where t.kind=p_kind and t.from_key=v_from_key and t.to_key=p_status),true);
 if not v_pair_active or not (v_target->>'active')::boolean then raise exception 'erp_document_transition_inactive' using errcode='22023'; end if;
 v_to_base:=v_rule->>'to_base';
 v_custom:=case when (v_target->>'default')::boolean then null else p_status::uuid end;
 if v_to_base<>v_row.status and erp_documents.transition_reason_required(p_kind,v_row.status,v_to_base) and coalesce(length(v_reason),0)<3 then
  raise exception 'erp_document_reason_required' using errcode='22023'; end if;
 v_actions:=array(select jsonb_array_elements_text(v_rule->'actions'));
 v_from_situation:=erp_documents.situation_json(p_kind,v_row.status,v_current);
 v_before:=erp_documents.document_view(p_id);
 foreach v_action in array array['reverse_stock','reverse_finance'] loop
  if v_action=any(v_actions) then v_effects:=v_effects||jsonb_build_array(erp_documents.transition_action(p_user_id,p_kind,p_id,p_command_id,v_action,v_target->>'name')); end if;
 end loop;
 update erp_documents.document set status=v_to_base,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 delete from erp_documents.document_situation where document_id=p_id;
 if v_custom is not null then
  insert into erp_documents.document_situation(document_id,kind,situation_id,base_status,actor,command_id) values(p_id,p_kind,v_custom,v_to_base,p_user_id,p_command_id);
 end if;
 foreach v_action in array array['post_stock','post_finance'] loop
  if v_action=any(v_actions) then v_effects:=v_effects||jsonb_build_array(erp_documents.transition_action(p_user_id,p_kind,p_id,p_command_id,v_action,v_target->>'name')); end if;
 end loop;
 v_auto:=erp_documents.auto_finance(p_user_id,p_id,p_command_id);
 v_to_situation:=erp_documents.situation_json(p_kind,v_to_base,v_custom);
 perform erp_documents.record_situation_occurrence(p_id,p_user_id,p_command_id,erp_documents.current_version(p_id),v_row.status,
  case when v_to_base<>v_row.status then v_to_base end,v_reason,v_from_situation,v_to_situation);
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.document_view(p_id),'effects',v_effects,'replayed',false,'data_mode','erp_native','operational_effects',false)
  ||case when v_auto is not null then jsonb_build_object('auto_finance',v_auto) else '{}'::jsonb end;
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
  values(p_user_id,p_command_id,p_id,'transition',v_reason,v_before,erp_documents.document_view(p_id)||jsonb_build_object('effects',v_effects)
   ||case when v_auto is not null then jsonb_build_object('auto_finance',v_auto) else '{}'::jsonb end);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

create or replace function public.erp_document_occurrence_add(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,
 p_occurred_on text,p_occurred_time text,p_text text default null,p_status text default null,p_next_contact text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_on date; v_time text; v_text text; v_next date; v_change boolean; v_before jsonb; v_result jsonb;
 v_last erp_documents.occurrence; v_adopted boolean; v_key text; v_transition jsonb; v_now timestamp:=clock_timestamp() at time zone 'America/Sao_Paulo';
begin
 -- 239: a change of situação is checked by erp_document_transition (Gerenciar situações, approval); a note needs the edit permission.
 perform erp_documents.require_role(p_user_id,p_kind,true);
 if p_status is null then perform erp_documents.require_access(p_user_id,p_kind,true); end if;
 v_adopted:=erp_documents.situation_adopted(p_kind);
 if p_document_id is null or p_expected_version is null or p_expected_version<1 or p_occurred_time is null or p_occurred_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or (p_status is not null and not (case when v_adopted then erp_documents.situation_key_valid(p_kind,p_status) else (erp_documents.transitions()->p_kind)?p_status end))
  or (p_next_contact is not null and p_kind<>'sales_proposals') then
  raise exception 'erp_document_occurrence_invalid' using errcode='22023'; end if;
 v_on:=erp_documents.date_value(to_jsonb(p_occurred_on),true);
 v_text:=erp_documents.text_value(to_jsonb(p_text),1000,false,true);
 v_next:=erp_documents.date_value(to_jsonb(p_next_contact));
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','occurrence','actor',p_user_id,'kind',p_kind,'id',p_document_id,'version',p_expected_version,
  'occurred_on',p_occurred_on,'occurred_time',p_occurred_time,'text',p_text,'status',p_status,'next_contact',p_next_contact)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 -- Without the preference the occurrence keeps the current date and time; with it, any moment up to now.
 if erp_documents.preference('empresa.editar_data_ocorrencia')='true'::jsonb then
  v_time:=p_occurred_time;
  if v_on+v_time::time>date_trunc('minute',v_now) then raise exception 'erp_document_occurrence_future' using errcode='22023'; end if;
 else
  v_on:=v_now::date; v_time:=to_char(v_now,'HH24:MI');
 end if;
 select * into v_row from erp_documents.document where id=p_document_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if not erp_documents.contact_usable(p_user_id,v_row.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 v_key:=case when v_adopted then coalesce((select s.situation_id::text from erp_documents.document_situation s where s.document_id=v_row.id),v_row.status) else v_row.status end;
 v_change:=p_status is not null and p_status<>v_key;
 -- A status equal to the current one is only a note: it needs the edit permission too (OS: Inclusão e edição).
 if p_status is not null and not v_change then perform erp_documents.require_access(p_user_id,p_kind,true); end if;
 if not v_change and v_text is null and v_next is null then raise exception 'erp_document_occurrence_empty' using errcode='22023'; end if;
 perform set_config('erp_documents.occurrence_on',v_on::text,true),set_config('erp_documents.occurrence_time',v_time,true),
  set_config('erp_documents.occurrence_text',coalesce(v_text,''),true),set_config('erp_documents.occurrence_next_contact',coalesce(v_next::text,''),true);
 if v_change then
  v_transition:=public.erp_document_transition(p_user_id,p_kind,p_document_id,v_row.version,md5('occurrence-transition:'||p_command_id::text)::uuid,p_status,
   nullif(btrim(regexp_replace(coalesce(v_text,''),'[[:cntrl:]]+',' ','g')),''));
 elsif v_adopted then
  perform erp_documents.record_situation_occurrence(p_document_id,p_user_id,p_command_id,v_row.version,v_row.status,null,v_text,erp_documents.document_situation_json(p_document_id),null);
 else
  perform erp_documents.record_occurrence(p_document_id,p_user_id,p_command_id,v_row.version,v_row.status,null,v_text);
 end if;
 perform set_config('erp_documents.occurrence_on','',true),set_config('erp_documents.occurrence_time','',true),
  set_config('erp_documents.occurrence_text','',true),set_config('erp_documents.occurrence_next_contact','',true);
 if v_next is not null then
  v_before:=erp_documents.dto(p_document_id);
  update erp_documents.document set body=jsonb_set(body,'{next_contact}',to_jsonb(v_next::text),true),version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_document_id;
  insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
   values(p_user_id,p_command_id,p_document_id,'next_contact',v_before,erp_documents.dto(p_document_id));
 elsif not v_change then
  insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
   values(p_user_id,p_command_id,p_document_id,'occurrence',v_text,null,null);
 end if;
 select * into v_last from erp_documents.occurrence where document_id=p_document_id order by sequence desc limit 1;
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.document_view(p_document_id),'occurrence',erp_documents.occurrence_json(v_last),
  'replayed',false,'data_mode','erp_native','operational_effects',false)
  ||case when v_transition?'auto_finance' then jsonb_build_object('auto_finance',v_transition->'auto_finance') else '{}'::jsonb end;
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

create or replace function public.erp_document_stock_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_occurred_on date,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
 perform erp_documents.require_os_permission(p_user_id,p_kind,'lancar_estoque');
 d:=erp_stock.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_stock.document_preview_data(d,p_occurred_on,p_reason),'data_mode','erp_native');
end $$;

create or replace function public.erp_document_stock_post(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,p_preview_hash text,p_occurred_on date,p_reason text,p_ignored_item_ids jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;pid uuid;result jsonb;ack jsonb;wanted jsonb;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
 perform erp_documents.require_os_permission(p_user_id,p_kind,'lancar_estoque');
 data:=jsonb_build_object('kind',p_kind,'id',p_document_id,'version',p_expected_version,'hash',p_preview_hash,'date',p_occurred_on,'reason',p_reason,'ignored',p_ignored_item_ids);
 replay:=erp_stock.document_command_start(p_user_id,p_command_id,'post',data);if replay is not null then return replay;end if;
 d:=erp_stock.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);preview:=erp_stock.document_preview_data(d,p_occurred_on,p_reason);
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_stock_preview_conflict' using errcode='40001';end if;
 if p_ignored_item_ids is null or jsonb_typeof(p_ignored_item_ids)<>'array' or jsonb_array_length(p_ignored_item_ids)>250
  or exists(select 1 from jsonb_array_elements(p_ignored_item_ids) j where jsonb_typeof(j)<>'string' or(j#>>'{}')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then raise exception 'erp_document_stock_ignored_ack_required' using errcode='22023';end if;
 select coalesce(jsonb_agg(value order by value),'[]') into ack from jsonb_array_elements(p_ignored_item_ids);
 select coalesce(jsonb_agg(value->'id' order by value->'id'),'[]') into wanted from jsonb_array_elements(preview->'ignored');
 if ack<>wanted then raise exception 'erp_document_stock_ignored_ack_required' using errcode='22023';end if;
 if exists(select 1 from erp_stock.command where id=p_command_id) then raise exception 'erp_document_stock_command_conflict' using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('product_id',j->'product_id','warehouse_id',j->'warehouse_id','quantity',j->'quantity','expected_version',j->'expected_version') order by j->>'product_id') into items from jsonb_array_elements(preview->'positions') j;
 movement:=erp_stock.post(p_user_id,p_command_id,preview->>'direction',p_occurred_on,p_reason,'Documento '||d.kind||' '||d.number::text,items);
 insert into erp_stock.document_posting(document_id,document_version,movement_id,snapshot,preview_hash,actor,command_id)
  values(d.id,d.version,(movement#>>'{movement,id}')::uuid,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id) returning id into pid;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_stock.document_posting_summary(pid),'movement',movement->'movement');
 insert into erp_stock.document_audit(actor,command_id,document_id,posting_id,action,result) values(p_user_id,p_command_id,d.id,pid,'post',result);
 insert into erp_documents.audit(actor,command_id,document_id,action,after_data) values(p_user_id,p_command_id,d.id,'stock_post',result);
 return erp_stock.document_command_finish(p_user_id,p_command_id,'post',data,result);
end $$;

create or replace function public.erp_document_stock_reverse_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_posting_id uuid,p_posting_version integer,p_occurred_on date,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
 perform erp_documents.require_os_permission(p_user_id,p_kind,'lancar_estoque');
 d:=erp_stock.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_stock.document_reverse_preview_data(d,p_posting_id,p_posting_version,p_occurred_on,p_reason),'data_mode','erp_native');
end $$;

create or replace function public.erp_document_stock_reverse(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_posting_id uuid,p_posting_version integer,p_command_id uuid,p_preview_hash text,p_occurred_on date,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;items jsonb;movement jsonb;result jsonb;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque".
 perform erp_documents.require_os_permission(p_user_id,p_kind,'lancar_estoque');
 data:=jsonb_build_object('kind',p_kind,'id',p_document_id,'version',p_expected_version,'posting',p_posting_id,'posting_version',p_posting_version,'hash',p_preview_hash,'date',p_occurred_on,'reason',p_reason);
 replay:=erp_stock.document_command_start(p_user_id,p_command_id,'reverse',data);if replay is not null then return replay;end if;
 d:=erp_stock.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 preview:=erp_stock.document_reverse_preview_data(d,p_posting_id,p_posting_version,p_occurred_on,p_reason);
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_stock_preview_conflict' using errcode='40001';end if;
 if exists(select 1 from erp_stock.command where id=p_command_id) then raise exception 'erp_document_stock_command_conflict' using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('product_id',j->'product_id','warehouse_id',j->'warehouse_id','quantity',j->'quantity','expected_version',j->'expected_version') order by j->>'product_id') into items from jsonb_array_elements(preview->'positions') j;
 movement:=erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,'Estorno documento '||d.kind||' '||d.number::text,items,(preview#>>'{posting,movement_id}')::uuid);
 update erp_stock.document_posting set state='reversed',version=version+1,reversal_movement_id=(movement#>>'{movement,id}')::uuid,reversed_at=clock_timestamp(),reversed_by=p_user_id,reason=btrim(p_reason) where id=p_posting_id;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_stock.document_posting_summary(p_posting_id),'movement',movement->'movement');
 insert into erp_stock.document_audit(actor,command_id,document_id,posting_id,action,result) values(p_user_id,p_command_id,d.id,p_posting_id,'reverse',result);
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,after_data) values(p_user_id,p_command_id,d.id,'stock_reverse',btrim(p_reason),result);
 return erp_stock.document_command_finish(p_user_id,p_command_id,'reverse',data,result);
end $$;

create or replace function public.erp_document_finance_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_category_id uuid default null,p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
 perform erp_documents.require_os_permission(p_user_id,p_kind,'lancar_contas');
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_documents.finance_payment_preview(d,erp_finance.document_preview_data(d,erp_documents.document_finance_category(d,p_category_id),p_plan)),
  'data_mode','erp_native','cash_movement_performed',false);
end $$;

create or replace function public.erp_document_finance_post(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,p_preview_hash text,p_category_id uuid default null,p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;pid uuid;gid uuid:=gen_random_uuid();tid uuid;part jsonb;label text;result jsonb;before_doc jsonb;v_category uuid;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
 perform erp_documents.require_os_permission(p_user_id,p_kind,'lancar_contas');
 -- The command keeps the category as requested, so a replay of an older command still matches.
 data:=jsonb_build_object('kind',p_kind,'document_id',p_document_id,'version',p_expected_version,'preview_hash',p_preview_hash,'category_id',p_category_id,'plan',p_plan);
 replay:=erp_finance.document_command_start(p_user_id,p_command_id,'post',data);if replay is not null then return replay;end if;
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 v_category:=erp_documents.document_finance_category(d,p_category_id);
 preview:=erp_documents.finance_payment_preview(d,erp_finance.document_preview_data(d,v_category,p_plan));
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_finance_preview_conflict' using errcode='40001';end if;
 before_doc:=erp_documents.dto(d.id);
 insert into erp_finance.document_posting(document_id,document_version,group_id,snapshot,preview_hash,actor,command_id)
 values(d.id,d.version,gid,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id) returning id into pid;
 label:=case d.kind when 'sales_orders' then 'Pedido de venda' when 'purchase_orders' then 'Pedido de compra' else 'Ordem de serviço' end||' nº '||d.number::text;
 for part in select value from jsonb_array_elements(preview->'installments') loop
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,amount_cents,payment_method_id,account_id)
  values(gid,(part->>'position')::integer,jsonb_array_length(preview->'installments'),preview->>'direction',d.contact_id,v_category,label,
   (preview->>'issued_on')::date,(part->>'due_on')::date,(part->>'amount_cents')::bigint,(part->>'payment_method_id')::uuid,(part->>'account_id')::uuid) returning id into tid;
  insert into erp_finance.document_title(title_id,posting_id,position)values(tid,pid,(part->>'position')::integer);
 end loop;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_finance.document_posting_summary(pid),'titles',erp_finance.document_title_rows(pid));
 insert into erp_finance.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'document_post',null,result);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)values(p_user_id,p_command_id,d.id,'finance_post',before_doc,result);
 return erp_finance.document_command_finish(p_user_id,p_command_id,'post',data,result);
end $$;

create or replace function public.erp_document_finance_reverse_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_posting_id uuid,p_posting_version integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
 perform erp_documents.require_os_permission(p_user_id,p_kind,'lancar_contas');
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_finance.document_reverse_preview_data(d,p_posting_id,p_posting_version),'data_mode','erp_native','cash_movement_performed',false);
end $$;

create or replace function public.erp_document_finance_reverse(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_posting_id uuid,p_posting_version integer,p_command_id uuid,p_preview_hash text,p_title_versions jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;expected jsonb;actual jsonb;part jsonb;note text;result jsonb;before_doc jsonb;begin
 -- 239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar contas".
 perform erp_documents.require_os_permission(p_user_id,p_kind,'lancar_contas');
 data:=jsonb_build_object('kind',p_kind,'document_id',p_document_id,'version',p_expected_version,'posting_id',p_posting_id,'posting_version',p_posting_version,
  'preview_hash',p_preview_hash,'title_versions',p_title_versions,'reason',p_reason);
 replay:=erp_finance.document_command_start(p_user_id,p_command_id,'reverse',data);if replay is not null then return replay;end if;
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 preview:=erp_finance.document_reverse_preview_data(d,p_posting_id,p_posting_version);
 note:=erp_documents.text_value(to_jsonb(p_reason),1000,true);
 if length(note)<3 then raise exception 'erp_document_finance_reason_required' using errcode='22023';end if;
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_finance_preview_conflict' using errcode='40001';end if;
 if p_title_versions is null or jsonb_typeof(p_title_versions)<>'array' or jsonb_array_length(p_title_versions) not between 1 and 120 or octet_length(p_title_versions::text)>32768 then
  raise exception 'erp_document_finance_titles_required' using errcode='22023';end if;
 for part in select value from jsonb_array_elements(p_title_versions) loop
  perform erp_finance.keys(part,array['id','version']);perform erp_finance.uuid_value(part->'id');perform erp_finance.expected(part->'version');end loop;
 select jsonb_agg(jsonb_build_object('id',value->>'id','version',(value->>'version')::integer) order by value->>'id') into expected from jsonb_array_elements(p_title_versions);
 select jsonb_agg(jsonb_build_object('id',value->>'id','version',(value->>'version')::integer) order by value->>'id') into actual from jsonb_array_elements(preview->'titles');
 if expected is distinct from actual then raise exception 'erp_document_finance_title_version_conflict' using errcode='40001';end if;
 before_doc:=erp_documents.dto(d.id);
 update erp_finance.title t set cancelled=true,version=version+1,updated_at=clock_timestamp() from erp_finance.document_title l
  where l.title_id=t.id and l.posting_id=p_posting_id and not t.cancelled;
 update erp_finance.document_posting set state='reversed',version=version+1,reversed_at=clock_timestamp(),reversed_by=p_user_id,reason=note where id=p_posting_id;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_finance.document_posting_summary(p_posting_id),'titles',erp_finance.document_title_rows(p_posting_id));
 insert into erp_finance.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'document_reverse',preview-'preview_hash',result);
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)values(p_user_id,p_command_id,d.id,'finance_reverse',note,before_doc,result);
 return erp_finance.document_command_finish(p_user_id,p_command_id,'reverse',data,result);
end $$;

create or replace function public.erp_document_history(p_user_id uuid,p_kind text,p_contact_id uuid,p_product_id uuid default null,
 p_query text default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_fiscal boolean; v_purchase boolean; v_query text; v_items jsonb; v_count integer; v_finance jsonb;
 v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 v_fiscal:=v_role in('admin','fiscal');
 v_purchase:=p_kind='purchase_orders';
 if p_limit is null or p_limit not between 1 and 50 or (not v_purchase and p_contact_id is null) or (v_purchase and p_product_id is null)
  or length(p_query)>120 or p_query~'[[:cntrl:]]' then
  raise exception 'erp_document_history_invalid' using errcode='22023'; end if;
 -- 238: the history of a contact the user does not see is refused; the purchases of a product keep only the visible fornecedores.
 if p_contact_id is not null and not erp_catalog.contact_visible_to(v_scope,p_contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 v_query:=lower(nullif(btrim(p_query),''));
 with lines as (
  select case when v_purchase then 'purchase' else 'sale' end as type,d.id as document_id,d.number::bigint as num,(d.body->>'date')::date as day,i.position,
   coalesce(i.data->>'description','') as description,nullif(i.data->>'code','') as code,i.product_id,coalesce(i.data->>'unit','') as unit,
   i.quantity::numeric(24,6) as quantity,i.unit_price
  from erp_documents.document d join erp_documents.item i on i.document_id=d.id
  where d.kind=case when v_purchase then 'purchase_orders' else 'sales_orders' end and d.status<>'cancelled'
   and (p_contact_id is null or d.contact_id=p_contact_id) and (p_product_id is null or i.product_id=p_product_id) and erp_catalog.contact_visible_to(v_scope,d.contact_id)
  union all
  select 'invoice',v.id,v.number::bigint,v.issue_date,t.position,coalesce(t.data->>'description',''),nullif(t.data->>'code',''),t.product_id,
   coalesce(t.data->>'unit',''),t.quantity::numeric(24,6),t.unit_price
  from erp_fiscal_invoices.invoice v join erp_fiscal_invoices.invoice_item t on t.invoice_id=v.id
  where v_fiscal and v.deleted_at is null and v.number is not null and v.direction=case when v_purchase then '0' else '1' end
   and v.status in(6,7,8) and (v_purchase or v.status in(6,7))
   and (p_contact_id is null or v.recipient->>'contact_id'=p_contact_id::text) and (p_product_id is null or t.product_id=p_product_id)
   and (v_scope is null or exists(select 1 from erp_catalog.contact_profile cp where cp.record_id::text=v.recipient->>'contact_id' and cp.seller_id=v_scope))
  union all
  -- 239: manual entries (Lançar estoque, entrada) not reversed, for the purchases of a product from every fornecedor.
  select 'stock',m.id,null::bigint,m.occurred_on,e.ordinal,left(coalesce(r.name,''),200),nullif(r.code,''),e.product_id,coalesce(e.unit,''),e.quantity::numeric(24,6),
   coalesce((select coalesce(md.unit_price,md.unit_cost) from erp_stock.movement_detail md where md.movement_id=m.id and md.product_id=e.product_id order by md.revision desc limit 1),0)
  from erp_stock.movement m join erp_stock.entry e on e.movement_id=m.id join erp_catalog.record r on r.id=e.product_id
  where v_purchase and p_contact_id is null and m.kind='receipt' and e.product_id=p_product_id and e.quantity>0
   and exists(select 1 from erp_stock.ledger_command c where c.movement_id=m.id and c.action='launch')
   and not exists(select 1 from erp_stock.movement x where x.reverses_id=m.id)
 ), found as (
  select * from lines l where v_query is null or strpos(lower(l.description),v_query)>0 or strpos(lower(coalesce(l.code,'')),v_query)>0
 ), page as (
  select * from found order by day desc,num desc nulls last,position limit p_limit+1
 )
 select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('type',type,'document_id',document_id,'number',num::text,'date',day::text,'position',position,
   'description',left(description,200),'code',left(code,100),'product_id',product_id,'unit',left(unit,16),'quantity',quantity::text,
   'unit_price',erp_catalog.unit_price_numeric(unit_price,14)) order by day desc,num desc nulls last,position) filter (where rn<=p_limit),'[]'::jsonb)
 into v_count,v_items
 from (select p.*,row_number() over(order by day desc,num desc nulls last,position) rn from page p) ranked;
 -- 239: the Financeiro tab of the OS needs "Histórico financeiro" (Sistema › Usuários › Serviços › Ordem de Serviço).
 if not v_purchase and p_product_id is null and (p_kind<>'service_orders' or erp_documents.os_permitted(p_user_id,'historico_financeiro')) then
  select jsonb_build_object('open_count',count(*),'open_amount',(coalesce(sum(t.amount_cents-t.settled_cents),0)/100.0)::numeric(18,2)::text,
   'overdue_amount',(coalesce(sum(t.amount_cents-t.settled_cents) filter (where t.due_on<v_today),0)/100.0)::numeric(18,2)::text,
   'titles',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'due_on',o.due_on::text,'description',left(o.description,200),
     'installment',o.installment,'installments',o.installments,'amount',(o.amount_cents/100.0)::numeric(18,2)::text,
     'open_amount',((o.amount_cents-o.settled_cents)/100.0)::numeric(18,2)::text) order by o.due_on,o.id)
    from (select * from erp_finance.title x where x.kind='receivable' and x.contact_id=p_contact_id and not x.cancelled and x.deleted_at is null
     and x.settled_cents<x.amount_cents order by x.due_on,x.id limit 20) o),'[]'::jsonb))
  into v_finance
  from erp_finance.title t where t.kind='receivable' and t.contact_id=p_contact_id and not t.cancelled and t.deleted_at is null and t.settled_cents<t.amount_cents;
 end if;
 return jsonb_build_object('kind',p_kind,'contact_id',p_contact_id,'product_id',p_product_id,'items',v_items,'has_more',v_count>p_limit,
  'invoices_included',v_fiscal,'finance',v_finance,'data_mode','erp_native','operational_effects',false)
  ||case when p_kind='service_orders' and p_product_id is null and v_finance is null then jsonb_build_object('finance_hidden',true) else '{}'::jsonb end;
end $$;

create or replace function public.erp_document_access(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if not found then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 return jsonb_build_object('read',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.kind_allowed(p_user_id,v_role,k,false)),
  'write',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.kind_allowed(p_user_id,v_role,k,true)),
  'settings',jsonb_build_object(
   'price_decimals_out',coalesce((erp_documents.preference('empresa.decimais_preco_saida')#>>'{}')::integer,10),
   'price_decimals_in',coalesce((erp_documents.preference('empresa.decimais_preco_entrada')#>>'{}')::integer,10),
   'weight_decimals',least(greatest(coalesce((erp_documents.preference('empresa.decimais_peso')#>>'{}')::integer,3),0),5),
   'cross_docking_days',coalesce((erp_documents.preference('estoque.cross_docking_dias')#>>'{}')::integer,0),
   'occurrence_date_editable',erp_documents.preference('empresa.editar_data_ocorrencia')='true'::jsonb,
   'stock_launch_date',case when erp_documents.preference('estoque.data_lancamento')='"data_documento"'::jsonb then 'data_documento' else 'data_atual' end,
   'auto_products',jsonb_build_object('sales',erp_documents.preference('produtos.cadastro_auto_vendas')='true'::jsonb,
    'purchases',erp_documents.preference('produtos.cadastro_auto_compras')='true'::jsonb,'services',erp_documents.preference('produtos.cadastro_auto_os')='true'::jsonb),
   'default_warehouse',(select jsonb_build_object('id',r.id,'name',left(r.name,200)) from erp_stock.warehouse_default x join erp_catalog.record r on r.id=x.warehouse_id where r.active)),
  'seller',(select jsonb_build_object('id',s.id,'name',left(r.name,200),'allow_unregistered_products',s.allow_unregistered_products,'view_stock',s.view_stock,
    'discount_limit',s.discount_limit::numeric(7,4)::text) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.user_id=p_user_id),
  -- 239: what the screens enable for the user (Sistema › Usuários › Permissões; the server checks each action again).
  'permissions',jsonb_build_object(
   'service_orders',jsonb_build_object('situations',erp_documents.os_permitted(p_user_id,'situacoes'),'stock',erp_documents.os_permitted(p_user_id,'lancar_estoque'),
    'finance',erp_documents.os_permitted(p_user_id,'lancar_contas'),'finance_history',erp_documents.os_permitted(p_user_id,'historico_financeiro'),
    'payment_method',erp_documents.os_permitted(p_user_id,'forma_pagamento')),
   'sales_orders',jsonb_build_object('discount_approver',erp_documents.discount_approver(p_user_id,'sales_orders'),
    'approval_situations',to_jsonb(erp_documents.approval_situations()))),
  'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function erp_documents.require_role(uuid,text,boolean),erp_documents.os_permitted(uuid,text),erp_documents.require_os_permission(uuid,text,text),
 erp_documents.require_access(uuid,text,boolean),erp_documents.kind_allowed(uuid,text,text,boolean),erp_documents.discount_approval_audit_immutable(),
 erp_documents.discount_approver(uuid,text),erp_documents.approval_situations(),erp_documents.approval_target(),erp_documents.seller_rules(uuid,text,jsonb),
 erp_documents.check_situation_change(uuid,text,text,text) from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_document_discount_approval(uuid)','erp_document_discount_approval_save(uuid,uuid,integer,jsonb)','erp_document_save(uuid,text,uuid,integer,uuid,jsonb)',
  'erp_document_transition(uuid,text,uuid,integer,uuid,text,text)','erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text)',
  'erp_document_stock_preview(uuid,text,uuid,integer,date,text)','erp_document_stock_post(uuid,text,uuid,integer,uuid,text,date,text,jsonb)',
  'erp_document_stock_reverse_preview(uuid,text,uuid,integer,uuid,integer,date,text)','erp_document_stock_reverse(uuid,text,uuid,integer,uuid,integer,uuid,text,date,text)',
  'erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb)','erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb)',
  'erp_document_finance_reverse_preview(uuid,text,uuid,integer,uuid,integer)','erp_document_finance_reverse(uuid,text,uuid,integer,uuid,integer,uuid,text,jsonb,text)',
  'erp_document_history(uuid,text,uuid,uuid,text,integer)','erp_document_access(uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
