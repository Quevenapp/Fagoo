-- 282: Cadastros no padrão do Origin, frente mista da onda F, parte de produtos.
-- * Sistema › Usuários › Permissões › Outros: "Cadastro de grupos de tags" e "Cadastro de tags" passam a valer no banco. Incluir,
--   editar e excluir um grupo de tags exige "Cadastro de grupos de tags"; incluir, editar e excluir uma tag exige "Cadastro de
--   tags" (de qualquer Tipo: Produtos, Contatos ou Notas fiscais), além do perfil que já valia. Marcar e desmarcar tags num produto,
--   num contato ou numa nota continua com a permissão do próprio cadastro. Um usuário sem permissões gravadas e o administrador
--   continuam com tudo o que o perfil permite.
-- * Listas de preços nos formulários de venda: erp_pricing.list_applies decide se uma lista vale agora (horário de São Paulo) para o
--   documento: Outra sempre; Contato, o cliente; Região, a UF (a informada ou a do cliente); Vendedor, o vendedor do documento
--   ("Vendedores selecionados terão acesso a esta lista de preços nos formulários de venda"); Forma de pagamento, uma das formas das
--   parcelas. erp_pricing_applicable_lists_v2 lista as que valem com até 20 formas de pagamento (a v1 de 192 continua com uma
--   forma). erp_pricing.list_applies não tem execução pública: é para a gravação dos documentos conferir a lista escolhida.
-- * A UF de um cliente que não é uma das 27 UFs (por exemplo "EX", o cliente do exterior espelhado do Origin) não é usada: a resposta
--   vem sem UF (null) e nenhuma lista de Região vale, em vez de uma resposta que a API recusa. Vale para a v1 (192) e a v2.
-- Substitui erp_catalog.require_taxonomy_access (236) e erp_pricing_applicable_lists (192), conferidas pelo hash; qualquer outra
-- versão interrompe a migração. Nada aqui escreve no Origin, gera estoque, título, imposto ou XML.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_access.permitted(uuid,text)') is null or to_regclass('erp_pricing.price_list_seller') is null or to_regclass('erp_pricing.price_list_payment_method') is null
  or to_regprocedure('erp_pricing.valid_now(erp_pricing.price_list)') is null then
  raise exception 'products_282_requires_154_229' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_catalog.require_taxonomy_access(uuid,text,text,boolean)','68944b38c193d5e8e9158c9aed715c608e0e4cc0b80ccffaabe173160dee4927'),
  ('public.erp_pricing_applicable_lists(uuid,uuid,uuid,uuid,text)','e4605bfdcf3f2e122cf7d19e2f822f20a34b785ed16fd495d6524f398e50de3f'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'products_282_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 236 plus the Outros permissions of the tag screens (Gerenciar grupos de tags, Gerenciar tags) on every write.
create or replace function erp_catalog.require_taxonomy_access(p_user_id uuid,p_kind text,p_tag_type text,p_write boolean) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
 if p_kind in('tag_groups','tags') then
  if p_tag_type='invoices' then
   select role into v_role from erp_access.membership where user_id=p_user_id and active;
   if not erp_catalog.invoice_tags_allowed(v_role,p_write) then raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
  elsif p_tag_type is not null then perform erp_catalog.require_access(p_user_id,erp_catalog.tag_entity(p_tag_type),p_write);
  elsif not exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active
    and(erp_catalog.allowed(m.role,'products',p_write) or erp_catalog.allowed(m.role,'contacts',p_write) or erp_catalog.invoice_tags_allowed(m.role,p_write))) then
   raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
  -- 282: Sistema › Usuários › Permissões › Outros › Cadastro de grupos de tags / Cadastro de tags.
  if p_write and not erp_access.permitted(p_user_id,case p_kind when 'tags' then 'outros.tags' else 'outros.grupos_tags' end) then
   raise exception 'erp_catalog_permission_denied' using errcode='42501'; end if;
 else perform erp_catalog.require_access(p_user_id,'products',p_write); end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- The UF of the cliente when it is one of the 27 UFs (a contact mirrored from Origin may carry "EX", exterior, or any two letters).
create function erp_pricing.contact_uf(p_contact uuid) returns text
language sql stable set search_path=pg_catalog as $$
 select upper(c.state) from erp_catalog.contact c where c.record_id=p_contact
  and upper(c.state) in('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')
$$;
-- Does the list apply now to a document with this cliente, vendedor, formas de pagamento and UF?
create function erp_pricing.list_applies(p_list erp_pricing.price_list,p_contact uuid,p_seller uuid,p_payment_methods uuid[],p_state text) returns boolean
language sql stable set search_path=pg_catalog as $$
 select coalesce(erp_pricing.valid_now(p_list) and case p_list.category
  when 'other' then true
  when 'contact' then p_contact is not null and exists(select 1 from erp_pricing.price_list_contact c where c.list_id=p_list.id and c.contact_id=p_contact)
  when 'region' then exists(select 1 from erp_pricing.price_list_region g where g.list_id=p_list.id
   and g.state=coalesce(upper(p_state),erp_pricing.contact_uf(p_contact)))
  when 'seller' then p_seller is not null and exists(select 1 from erp_pricing.price_list_seller s where s.list_id=p_list.id and s.seller_id=p_seller)
  when 'payment_method' then exists(select 1 from erp_pricing.price_list_payment_method m where m.list_id=p_list.id and m.payment_method_id=any(coalesce(p_payment_methods,'{}'::uuid[])))
  else false end,false)
$$;

-- Listas que valem agora para o documento (formulários de pedido de venda, proposta e Frente de caixa). Só leitura, para quem lê
-- produtos, sem os vínculos de cada lista.
create function public.erp_pricing_applicable_lists_v2(p_user_id uuid,p_contact_id uuid default null,p_seller_id uuid default null,p_payment_method_ids uuid[] default null,
 p_state text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_state text;
begin
 perform erp_pricing.require(p_user_id,false);
 if p_state is not null and p_state not in('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')
  or p_payment_method_ids is not null and(array_ndims(p_payment_method_ids) is distinct from 1 or cardinality(p_payment_method_ids) not between 1 and 20
   or array_position(p_payment_method_ids,null) is not null or(select count(distinct x) from unnest(p_payment_method_ids) x)<>cardinality(p_payment_method_ids)) then
  raise exception 'erp_pricing_invalid_query' using errcode='22023'; end if;
 v_state:=coalesce(p_state,erp_pricing.contact_uf(p_contact_id));
 return jsonb_build_object('data_mode','erp_native','contact_id',p_contact_id,'seller_id',p_seller_id,
  'payment_method_ids',coalesce(to_jsonb(array(select x from unnest(p_payment_method_ids) x order by x)),'[]'::jsonb),'state',v_state,
  'items',coalesce((select jsonb_agg(erp_pricing.header(l.id)-'contacts'-'sellers'-'payment_methods'-'regions' order by erp_catalog.fold(l.name),l.id)
   from erp_pricing.price_list l where erp_pricing.list_applies(l,p_contact_id,p_seller_id,p_payment_method_ids,v_state)),'[]'::jsonb));
end $$;

-- 192 with the UF of the cliente only when it is one of the 27 UFs (the rest of the function is unchanged).
create or replace function public.erp_pricing_applicable_lists(p_user_id uuid,p_contact_id uuid default null,p_seller_id uuid default null,p_payment_method_id uuid default null,p_state text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_state text;
begin
 perform erp_pricing.require(p_user_id,false);
 if p_state is not null and p_state not in('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO') then
  raise exception 'erp_pricing_invalid_query' using errcode='22023'; end if;
 v_state:=coalesce(p_state,erp_pricing.contact_uf(p_contact_id));
 return jsonb_build_object('data_mode','erp_native','contact_id',p_contact_id,'seller_id',p_seller_id,'payment_method_id',p_payment_method_id,'state',v_state,
  'items',coalesce((select jsonb_agg(erp_pricing.header(l.id)-'contacts'-'sellers'-'payment_methods'-'regions' order by erp_catalog.fold(l.name),l.id)
   from erp_pricing.price_list l where erp_pricing.valid_now(l) and case l.category
    when 'other' then true
    when 'contact' then exists(select 1 from erp_pricing.price_list_contact c where c.list_id=l.id and c.contact_id=p_contact_id)
    when 'region' then exists(select 1 from erp_pricing.price_list_region g where g.list_id=l.id and g.state=v_state)
    when 'seller' then exists(select 1 from erp_pricing.price_list_seller s where s.list_id=l.id and s.seller_id=p_seller_id)
    when 'payment_method' then exists(select 1 from erp_pricing.price_list_payment_method m where m.list_id=l.id and m.payment_method_id=p_payment_method_id)
    else false end),'[]'::jsonb));
end $$;

revoke all on function erp_catalog.require_taxonomy_access(uuid,text,text,boolean),erp_pricing.list_applies(erp_pricing.price_list,uuid,uuid,uuid[],text),
 erp_pricing.contact_uf(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_pricing_applicable_lists_v2(uuid,uuid,uuid,uuid[],text),public.erp_pricing_applicable_lists(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.erp_pricing_applicable_lists_v2(uuid,uuid,uuid,uuid[],text),public.erp_pricing_applicable_lists(uuid,uuid,uuid,uuid,text) to service_role;
commit;
