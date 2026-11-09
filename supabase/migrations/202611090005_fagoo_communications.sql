-- Internal communication engine mappings. Auth and authorization remain Fagoo-owned.
begin;
create table fagoo.communication_binding (
  unit_id uuid primary key references fagoo.unit(id) on delete cascade,
  profile_id text not null unique check(length(profile_id) between 1 and 120)
);
create table fagoo.communication_bot_policy (
  unit_id uuid not null references fagoo.unit(id) on delete cascade,
  bot_id text not null check(length(bot_id) between 1 and 120),
  required_capabilities text[] not null default array['team.chat']::text[],
  required_resources text[] not null default '{}'::text[],
  required_permissions text[] not null default '{}'::text[],
  enabled boolean not null default true,
  primary key(unit_id,bot_id)
);
alter table fagoo.communication_binding enable row level security;
alter table fagoo.communication_bot_policy enable row level security;
revoke all on fagoo.communication_binding,fagoo.communication_bot_policy from public,anon,authenticated,service_role;

create function public.fagoo_communication_context(p_user_id uuid,p_unit_id uuid,p_capability text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_context jsonb; v_unit jsonb; v_profile text; v_bots jsonb; v_people jsonb;
begin
  if p_capability not in ('communication.read','communication.claim','communication.reply','communication.transfer','communication.configure','team.chat') then
    raise exception 'fagoo_access_denied' using errcode='42501';
  end if;
  perform fagoo.require_unit(p_user_id,null,p_unit_id,p_capability);
  v_context:=public.fagoo_context(p_user_id);
  select value into v_unit from jsonb_array_elements(v_context->'units') where value->>'id'=p_unit_id::text;
  if v_unit is null then raise exception 'fagoo_access_denied' using errcode='42501'; end if;
  select profile_id into v_profile from fagoo.communication_binding where unit_id=p_unit_id;
  select coalesce(jsonb_agg(bot_id),'[]'::jsonb) into v_bots
    from fagoo.communication_bot_policy b where b.unit_id=p_unit_id and b.enabled
      and (v_context->>'role'='admin' or (b.required_capabilities <@ array(select jsonb_array_elements_text(v_unit->'capabilities'))
        and b.required_resources <@ erp_access.resources_for_role(v_context->>'role')
        and not exists(select 1 from unnest(b.required_resources) r where not erp_access.permitted(p_user_id,case r when 'contacts' then 'cadastros.clientes_fornecedores' when 'products' then 'cadastros.produtos' when 'sales_orders' then 'vendas.pedidos_venda' when 'purchase_orders' then 'suprimentos.pedidos_compra' when 'sales_proposals' then 'vendas.propostas' when 'receivables' then 'financas.contas_receber' when 'payables' then 'financas.contas_pagar' when 'nfe' then 'vendas.notas_fiscais' when 'nfce' then 'vendas.nfce' else '' end))
        and not exists(select 1 from unnest(b.required_permissions) p where not erp_access.permitted(p_user_id,p))));
  select coalesce(jsonb_agg(jsonb_build_object('id',m.user_id,'name',coalesce(nullif(u.raw_user_meta_data->>'name',''),split_part(u.email,'@',1),m.user_id::text),'role',m.role,'team_ids',coalesce(to_jsonb(um.team_ids),'[]'::jsonb))),'[]'::jsonb)
    into v_people from erp_access.membership m join auth.users u on u.id=m.user_id
    left join fagoo.unit_member um on um.user_id=m.user_id and um.unit_id=p_unit_id
    where m.active and (m.role='admin' or (um.user_id is not null and ('team.chat'=any(um.capabilities) or 'communication.read'=any(um.capabilities))));
  return jsonb_build_object('user_id',p_user_id,'unit_id',p_unit_id,'profile_id',coalesce(v_profile,p_unit_id::text),
    'name',coalesce((select coalesce(nullif(raw_user_meta_data->>'name',''),split_part(email,'@',1)) from auth.users where id=p_user_id),p_user_id::text),
    'unit_name',v_unit->>'name','role',v_context->>'role','capabilities',v_unit->'capabilities','team_ids',coalesce(v_unit->'team_ids','[]'::jsonb),'bots',v_bots,'people',v_people);
end $$;
revoke all on function public.fagoo_communication_context(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fagoo_communication_context(uuid,uuid,text) to service_role;

create function public.fagoo_communication_bot_policy(p_user_id uuid,p_unit_id uuid,p_bot_id text,p_required_capabilities text[],p_enabled boolean,p_required_resources text[] default '{}',p_required_permissions text[] default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform fagoo.require_unit(p_user_id,null,p_unit_id,'communication.configure');
  if p_bot_id is null or length(p_bot_id) not between 1 and 120 or p_required_capabilities is null or not p_required_capabilities <@ fagoo.capabilities() or cardinality(p_required_capabilities)>40 or p_enabled is null or p_required_resources is null or not p_required_resources <@ erp_access.resources_for_role('admin') or p_required_permissions is null or not p_required_permissions <@ erp_access.permission_keys() then
    raise exception 'fagoo_invalid_input' using errcode='22023';
  end if;
  insert into fagoo.communication_bot_policy(unit_id,bot_id,required_capabilities,enabled,required_resources,required_permissions)
    values(p_unit_id,p_bot_id,p_required_capabilities,p_enabled,p_required_resources,p_required_permissions)
    on conflict(unit_id,bot_id) do update set required_capabilities=excluded.required_capabilities,enabled=excluded.enabled,required_resources=excluded.required_resources,required_permissions=excluded.required_permissions;
  return jsonb_build_object('bot_id',p_bot_id,'required_capabilities',p_required_capabilities,'enabled',p_enabled,'required_resources',p_required_resources,'required_permissions',p_required_permissions);
end $$;
revoke all on function public.fagoo_communication_bot_policy(uuid,uuid,text,text[],boolean,text[],text[]) from public,anon,authenticated;
grant execute on function public.fagoo_communication_bot_policy(uuid,uuid,text,text[],boolean,text[],text[]) to service_role;
create function public.fagoo_communication_bot_policies(p_user_id uuid,p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fagoo.require_unit(p_user_id,null,p_unit_id,'communication.configure');
 return jsonb_build_object('data',(select coalesce(jsonb_agg(to_jsonb(b)),'[]') from fagoo.communication_bot_policy b where unit_id=p_unit_id),'permission_keys',erp_access.permission_keys());
end $$;
revoke all on function public.fagoo_communication_bot_policies(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fagoo_communication_bot_policies(uuid,uuid) to service_role;
create function public.fagoo_communication_contact_access(p_user_id uuid,p_unit_id uuid,p_contact_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform fagoo.require_unit(p_user_id,null,p_unit_id,'communication.configure');
 perform fagoo.require_unit(p_user_id,null,p_unit_id,'crm.read');
 perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);
 if not exists(select 1 from erp_catalog.contact where record_id=p_contact_id) then raise exception 'fagoo_contact_not_found' using errcode='P0002';end if;
 return jsonb_build_object('contact_id',p_contact_id);
end $$;
revoke all on function public.fagoo_communication_contact_access(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fagoo_communication_contact_access(uuid,uuid,uuid) to service_role;
commit;
