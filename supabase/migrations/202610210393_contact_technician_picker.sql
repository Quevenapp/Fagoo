-- Leva H, lane documentos (VND-248): o Técnico da OS vem dos contatos com o tipo Técnico (Cadastros › Clientes e fornecedores ›
-- Tipos de contato), sem exigir login; o seletor de contatos ganha o papel Técnico. A OS continua guardando o nome do técnico
-- escolhido (body.technician), como antes; ter login não dá acesso a nada.
-- A função substituída é conferida pelo hash; outra versão interrompe a migração.
begin;

do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure('public.erp_catalog_contact_options(uuid,text,text,text,integer)'))
  is distinct from 'b77247978bf224f8ccf995b214a0ddf8f1e53e6f89f34169b8832912a9c5a7d3' then
  raise exception 'contact_technician_393_previous_definition_changed public.erp_catalog_contact_options' using errcode='55000'; end if;
end$$;

create or replace function public.erp_catalog_contact_options(p_user_id uuid,p_query text default null,p_role text default null,p_city text default null,p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_terms text[]; v_scope uuid; v_city text:=nullif(btrim(p_city),''); v_ids uuid[];
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_limit is null or p_limit not between 1 and 50 or(p_query is not null and(length(p_query)>120 or p_query~'[[:cntrl:]]'))
  or(p_role is not null and p_role not in('customer','supplier','carrier','technician')) or(p_city is not null and(length(p_city)>100 or p_city~'[[:cntrl:]]')) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_scope:=erp_catalog.contact_scope(p_user_id); v_terms:=erp_catalog.search_terms(p_query);
 select array(select r.id from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id left join erp_catalog.contact_profile cp on cp.record_id=r.id
  cross join lateral(select case when p_role='carrier' then erp_catalog.contact_carrier_match(r.id) end carrier) m
  where r.entity='contacts' and r.active and(v_scope is null or cp.seller_id=v_scope)
   and(p_role is null or p_role=any(c.roles) or(p_role='carrier' and m.carrier is not null)
    -- Leva H (VND-248): Técnico is the contact type of the cadastro (Tipos de contato), not a fiscal role.
    or(p_role='technician' and exists(select 1 from erp_catalog.contact_type_link l join erp_catalog.contact_type t on t.id=l.type_id where l.contact_id=r.id and t.slug='technician' and t.active)))
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code,c.trade_name,c.email,c.document,c.phone,c.mobile)),
    regexp_replace(lower(coalesce(c.document,'')),'[^0-9a-z]','','g'),regexp_replace(concat_ws('|',c.document,c.phone,c.mobile,cp.fax),'[^0-9|]','','g')))
   and(v_city is null or strpos(erp_catalog.fold(coalesce(c.city,'')),erp_catalog.fold(v_city))>0)
  order by case when m.carrier='untyped' then 1 else 0 end,erp_catalog.fold(r.name),r.id limit p_limit+1) into v_ids;
 return jsonb_build_object('scope','contact_options','data_mode','erp_native','role',p_role,'limit',p_limit,'scoped',v_scope is not null,
  'has_more',cardinality(v_ids)>p_limit,
  'items',(select coalesce(jsonb_agg(erp_catalog.contact_option_item(u.id)||case when p_role='carrier' then jsonb_build_object('carrier_match',erp_catalog.contact_carrier_match(u.id)) else '{}'::jsonb end
    order by u.n),'[]'::jsonb) from unnest(v_ids[1:p_limit]) with ordinality u(id,n)));
end $$;

revoke all on function public.erp_catalog_contact_options(uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.erp_catalog_contact_options(uuid,text,text,text,integer) to service_role;
commit;
