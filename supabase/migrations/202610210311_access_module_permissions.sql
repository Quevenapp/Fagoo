-- Leva H, lane acesso (PRF-215, PRF-216, PRF-217): as permissões de Sistema › Usuários › Permissões passam a valer no
-- banco para os módulos, nos helpers de acesso que todas as RPCs de cada módulo já chamam:
-- * documentos: Propostas (vendas.propostas), Pedidos de venda (vendas.pedidos_venda) e Pedidos de compra
--   (suprimentos.pedidos_compra) para ler; o mesmo cartão com .ie para incluir e editar (a OS segue com a chave da 239);
-- * estoque: Controle de Estoque (suprimentos.controle_estoque) para ler e .insercao para lançar;
-- * notas fiscais: Notas Fiscais (vendas.notas_fiscais) ou Notas de Entrada (suprimentos.notas_entrada) para ler, e o .ie de
--   um deles para gravar;
-- * cadastros: Clientes e Fornecedores, Produtos e Depósitos com .ie para incluir e editar. A leitura de contatos e produtos
--   segue pelo perfil, porque os seletores dos documentos usam o mesmo helper.
-- Quem não tem permissões salvas (permissions nulo) continua com tudo o que o perfil permite; o administrador, sempre. Só um
-- conjunto salvo restringe, como já era o contrato da 229.
-- Os helpers substituídos são conferidos pelo hash; outra versão interrompe a migração.
begin;

do $$declare r record;begin
 for r in select * from(values
  ('erp_catalog.require_access(uuid,text,boolean)','4147830a4a490f6ea324659f7998ebde07f35e2d5563283e0d650e66c5ba9fd8'),
  ('erp_documents.require_access(uuid,text,boolean)','a707a1c144bd1fdf502fce34081ca4f0cf043d08b67ae9dd643188b15a04cfaf'),
  ('erp_stock.require_access(uuid,boolean)','39736c8f4b867b364b301ca9bce45eff379e01d33ae198d0d966fdc5b2aa192e'),
  ('erp_fiscal_invoices.require_read(uuid)','b2541d656c488d30f099969115dd707e8ec59c1bf490343d69c6d42fee4ad23c'),
  ('erp_fiscal_invoices.require_write(uuid)','da6d0598ddc52fb3a4df276b505227a63d05793e5101baf314381c24e88f5912'))v(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.hash then
   raise exception 'access_module_permissions_311_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
end$$;

create or replace function erp_catalog.require_access(p_user_id uuid,p_entity text,p_write boolean)
returns text language plpgsql stable set search_path=pg_catalog as $$
declare v_role text; v_keyed boolean;
begin
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if not found or not erp_catalog.allowed(v_role,p_entity,p_write) then
    raise exception 'erp_catalog_access_denied' using errcode='42501';
  end if;
  -- Leva H: incluir e editar exigem o .ie do cartão.
  v_keyed:=not p_write or case p_entity
    when 'contacts' then erp_access.permitted(p_user_id,'cadastros.clientes_fornecedores.ie')
    when 'products' then erp_access.permitted(p_user_id,'cadastros.produtos.ie')
    when 'warehouses' then erp_access.permitted(p_user_id,'suprimentos.depositos.ie')
    else true end;
  if not v_keyed then raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
  return v_role;
end $$;

create or replace function erp_documents.require_access(p_user_id uuid,p_kind text,p_write boolean)
returns void language plpgsql stable set search_path=pg_catalog as $$
declare v_card text;
begin
 perform erp_documents.require_role(p_user_id,p_kind,p_write);
 if p_kind='service_orders' and not erp_documents.os_permitted(p_user_id,case when p_write then 'ie' end) then
  raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 -- Leva H: o cartão do documento (e o .ie para gravar).
 v_card:=case p_kind when 'sales_proposals' then 'vendas.propostas' when 'sales_orders' then 'vendas.pedidos_venda' when 'purchase_orders' then 'suprimentos.pedidos_compra' end;
 if p_write then v_card:=v_card||'.ie'; end if;
 if v_card is not null and not erp_access.permitted(p_user_id,v_card) then
  raise exception 'erp_document_access_denied' using errcode='42501'; end if;
end $$;

create or replace function erp_stock.require_access(p_user_id uuid,p_write boolean)
returns void language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if not found or (p_write and v_role not in ('admin','estoque'))
    or (not p_write and v_role not in ('admin','consulta','estoque','vendas','fiscal')) then
    raise exception 'erp_stock_access_denied' using errcode='42501';
  end if;
  -- Leva H: Controle de Estoque para consultar e Inserção para lançar.
  if not erp_access.permitted(p_user_id,'suprimentos.controle_estoque'||(case when p_write then '.insercao' else '' end)) then
    raise exception 'erp_stock_access_denied' using errcode='42501';
  end if;
end $$;

create or replace function erp_fiscal_invoices.require_read(p_user_id uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare r text:=erp_fiscal_invoices.role_of(p_user_id);
begin
 if r not in('admin','consulta','fiscal') then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 -- Leva H: Notas Fiscais (saída) ou Notas de Entrada.
 if not(erp_access.permitted(p_user_id,'vendas.notas_fiscais') or erp_access.permitted(p_user_id,'suprimentos.notas_entrada')) then
  raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 return r;
end $$;
create or replace function erp_fiscal_invoices.require_write(p_user_id uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare r text:=erp_fiscal_invoices.role_of(p_user_id);
begin
 if r not in('admin','fiscal') then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 if not(erp_access.permitted(p_user_id,'vendas.notas_fiscais.ie') or erp_access.permitted(p_user_id,'suprimentos.notas_entrada.ie')) then
  raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 return r;
end $$;

revoke all on function erp_catalog.require_access(uuid,text,boolean),
 erp_documents.require_access(uuid,text,boolean),erp_stock.require_access(uuid,boolean),erp_fiscal_invoices.require_read(uuid),erp_fiscal_invoices.require_write(uuid)
 from public,anon,authenticated,service_role;
commit;
