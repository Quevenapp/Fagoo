-- Tags no padrão do Origin: grupos de tags e tags têm um Tipo (Produtos | Contatos). As tags que já existem (migração 119)
-- são de Produtos e continuam iguais nos produtos. As tags de Contatos ganham o vínculo com os clientes e fornecedores:
-- leitura para a coluna Marcadores e o formulário, "Editar tags" (substitui o conjunto) e "Incluir tags para selecionados"
-- (acrescenta), e o filtro Tags da listagem de contatos (Todos | Sem Tag | tag), junto com o filtro Lista de preço.
--
-- As tags do contato têm versão própria (contact_tag_state): gravar as tags não muda a versão do cadastro do contato, então o
-- formulário aberto continua salvando os outros campos sem conflito. Comando idempotente, auditoria em erp_catalog.audit e a
-- visibilidade "Contato acessível somente ao vendedor vinculado" (erp_catalog.contact_scope) valem em todas as leituras e
-- gravações. Nenhuma função da lane de contatos é redefinida: a listagem e a exportação com os filtros novos são funções
-- próprias que reutilizam erp_catalog.contact_where/contact_list_item (migração 125). Depende de 119, 121 e 124-125.
begin;

-- ---------------------------------------------------------------------------------------------------------------
-- Tipo das tags e dos grupos de tags. Categorias e grupos de produtos não têm tipo.
alter table erp_catalog.taxonomy add column tag_type text check(tag_type in('products','contacts'));
update erp_catalog.taxonomy set tag_type='products' where kind in('tag_groups','tags');
alter table erp_catalog.taxonomy add constraint erp_catalog_taxonomy_tag_type check((kind in('tag_groups','tags'))=(tag_type is not null));
alter table erp_catalog.taxonomy add constraint erp_catalog_taxonomy_typed unique(id,kind,tag_type);
-- Nomes únicos por tipo: a tag "VIP" de Produtos e a tag "VIP" de Contatos convivem.
drop index erp_catalog.erp_catalog_taxonomy_name;
create unique index erp_catalog_taxonomy_name on erp_catalog.taxonomy(kind,coalesce(tag_type,''),coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),erp_catalog.fold(name));

-- O tipo é escolhido na inclusão e não muda depois; a tag de um grupo tem o tipo do grupo.
create function erp_catalog.taxonomy_type_guard() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='UPDATE' and new.tag_type is distinct from old.tag_type then raise exception 'erp_catalog_taxonomy_type_fixed' using errcode='22023'; end if;
 if new.kind='tags' and new.parent_id is not null
  and(select t.tag_type from erp_catalog.taxonomy t where t.id=new.parent_id) is distinct from new.tag_type then
  raise exception 'erp_catalog_taxonomy_parent_invalid' using errcode='22023'; end if;
 return new;
end $$;
create trigger erp_catalog_taxonomy_type_guard before insert or update on erp_catalog.taxonomy
 for each row execute function erp_catalog.taxonomy_type_guard();

-- O produto só recebe tags de Produtos (a mesma regra também fica na conferência das referências do formulário).
alter table erp_catalog.product_tag add column tag_type text not null default 'products' check(tag_type='products');
alter table erp_catalog.product_tag add constraint erp_catalog_product_tag_typed foreign key(tag_id,tag_kind,tag_type) references erp_catalog.taxonomy(id,kind,tag_type);

-- ---------------------------------------------------------------------------------------------------------------
-- Tags dos contatos e a versão do conjunto de tags de cada contato.
create table erp_catalog.contact_tag(
 record_id uuid not null references erp_catalog.contact(record_id),
 tag_id uuid not null, tag_kind text not null default 'tags' check(tag_kind='tags'),
 tag_type text not null default 'contacts' check(tag_type='contacts'),
 primary key(record_id,tag_id),
 foreign key(tag_id,tag_kind,tag_type) references erp_catalog.taxonomy(id,kind,tag_type)
);
create index erp_catalog_contact_tag_tag on erp_catalog.contact_tag(tag_id);
create table erp_catalog.contact_tag_state(
 record_id uuid primary key references erp_catalog.contact(record_id),
 version integer not null check(version between 1 and 2147483647),
 updated_by uuid not null references auth.users(id),
 updated_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
 foreach t in array array['contact_tag','contact_tag_state'] loop
  execute format('alter table erp_catalog.%I enable row level security',t);
  execute format('revoke all on table erp_catalog.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Permissões por tipo: as tags de Produtos seguem a permissão de produtos; as de Contatos, a de contatos.
create function erp_catalog.tag_entity(p_tag_type text) returns text
language sql immutable set search_path=pg_catalog as $$
 select case p_tag_type when 'products' then 'products' when 'contacts' then 'contacts' end
$$;
create function erp_catalog.tag_types_readable(p_user_id uuid) returns text[]
language sql stable set search_path=pg_catalog as $$
 select coalesce(array_agg(t order by t),'{}'::text[]) from unnest(array['contacts','products']) t
 where exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and erp_catalog.allowed(m.role,erp_catalog.tag_entity(t),false))
$$;
-- Categorias e grupos de produtos: permissão de produtos. Tags e grupos de tags: a do tipo; sem o tipo (ainda não lido), basta
-- poder consultar/gravar um dos dois tipos.
create function erp_catalog.require_taxonomy_access(p_user_id uuid,p_kind text,p_tag_type text,p_write boolean) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_kind in('tag_groups','tags') then
  if p_tag_type is not null then perform erp_catalog.require_access(p_user_id,erp_catalog.tag_entity(p_tag_type),p_write);
  elsif not exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active
    and(erp_catalog.allowed(m.role,'products',p_write) or erp_catalog.allowed(m.role,'contacts',p_write))) then
   raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
 else perform erp_catalog.require_access(p_user_id,'products',p_write); end if;
end $$;

create or replace function erp_catalog.taxonomy_item(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',t.id,'kind',t.kind,'parent_id',t.parent_id,'name',t.name,'version',t.version,
  'created_at',t.created_at,'updated_at',t.updated_at,'tag_type',t.tag_type,
  'children',(select count(*) from erp_catalog.taxonomy c where c.parent_id=t.id)::integer,
  'products',case t.kind
   when 'categories' then (select count(*) from erp_catalog.product_detail d where d.category_id=t.id)
   when 'product_groups' then (select count(*) from erp_catalog.product_detail d where d.product_group_id=t.id)
   when 'tags' then (select count(*) from erp_catalog.product_tag x where x.tag_id=t.id) else 0 end::integer,
  'contacts',case t.kind when 'tags' then (select count(*) from erp_catalog.contact_tag x where x.tag_id=t.id) else 0 end::integer)
 from erp_catalog.taxonomy t where t.id=p_id
$$;

-- Grupos de tags e tags: cada perfil vê os tipos que pode consultar (produtos e/ou contatos).
create or replace function public.erp_catalog_taxonomy_list(p_user_id uuid,p_kind text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_types text[];
begin
 if erp_catalog.taxonomy_spec(p_kind) is null then
  perform erp_catalog.require_access(p_user_id,'products',false);
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 if p_kind in('tag_groups','tags') then
  v_types:=erp_catalog.tag_types_readable(p_user_id);
  if cardinality(v_types)=0 then raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
 else perform erp_catalog.require_access(p_user_id,'products',false); end if;
 return jsonb_build_object('kind',p_kind,'data_mode','erp_native','items',coalesce((select jsonb_agg(erp_catalog.taxonomy_item(t.id) order by erp_catalog.fold(t.name),t.id)
  from erp_catalog.taxonomy t where t.kind=p_kind and(v_types is null or t.tag_type=any(v_types))),'[]'::jsonb));
end $$;

-- Inclusão e edição. Tags e grupos de tags: tag_type na inclusão (sem ele, o tipo do grupo ou Produtos, como antes); a tag
-- de um grupo tem o tipo do grupo; na edição o tipo não muda. Nome único no mesmo tipo e no mesmo pai.
create or replace function public.erp_catalog_taxonomy_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_spec jsonb:=erp_catalog.taxonomy_spec(p_kind); v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.taxonomy%rowtype;
 v_name text; v_parent uuid; v_parent_kind text; v_parent_type text; v_type text; v_id uuid; v_before jsonb; v_result jsonb; v_tagged boolean:=p_kind in('tag_groups','tags');
begin
 perform erp_catalog.require_taxonomy_access(p_user_id,p_kind,null,true);
 if v_spec is null or p_command_id is null or p_expected_version is null or p_data is null or jsonb_typeof(p_data)<>'object'
  or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647)
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in('name','parent_id','tag_type'))
  or jsonb_typeof(p_data->'name') is distinct from 'string'
  or(p_data?'parent_id' and jsonb_typeof(p_data->'parent_id') not in('string','null'))
  or(p_data->>'parent_id' is not null and p_data->>'parent_id'!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
  or(p_data?'tag_type' and(not v_tagged or jsonb_typeof(p_data->'tag_type') is distinct from 'string' or p_data->>'tag_type' not in('products','contacts'))) then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_name:=btrim(p_data->>'name'); v_parent:=(p_data->>'parent_id')::uuid;
 -- The type decides the permission: the stored type (edição), else the requested one, the group's type or Produtos.
 if v_tagged then
  if p_id is not null then
   select tag_type into v_type from erp_catalog.taxonomy where id=p_id and kind=p_kind;
   if v_type is not null and p_data?'tag_type' and p_data->>'tag_type'<>v_type then raise exception 'erp_catalog_taxonomy_type_fixed' using errcode='22023'; end if;
  else
   if v_parent is not null then select tag_type into v_parent_type from erp_catalog.taxonomy where id=v_parent; end if;
   v_type:=coalesce(p_data->>'tag_type',v_parent_type,'products');
  end if;
  perform erp_catalog.require_taxonomy_access(p_user_id,p_kind,coalesce(v_type,p_data->>'tag_type','products'),true);
 end if;
 if v_name='' or length(v_name)>(v_spec->>'name')::integer or v_name~'[[:cntrl:]]' then raise exception 'erp_catalog_invalid_text' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','taxonomy_save','kind',p_kind,'id',p_id,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 -- One writer per kind at a time: the unique name check and the per-kind limit stay exact.
 perform pg_advisory_xact_lock(174852908,hashtext(p_kind));
 if p_id is null then
  if v_parent is not null then
   select kind,tag_type into v_parent_kind,v_parent_type from erp_catalog.taxonomy where id=v_parent for key share;
   if v_parent_kind is distinct from v_spec->>'parent' or(v_tagged and v_parent_type is distinct from v_type) then
    raise exception 'erp_catalog_taxonomy_parent_invalid' using errcode='22023'; end if;
  end if;
  if(select count(*) from erp_catalog.taxonomy where kind=p_kind)>=2000 then raise exception 'erp_catalog_taxonomy_limit' using errcode='22023'; end if;
 else
  select * into v_row from erp_catalog.taxonomy where id=p_id and kind=p_kind for update;
  if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  if p_data?'parent_id' and v_parent is distinct from v_row.parent_id then raise exception 'erp_catalog_taxonomy_parent_fixed' using errcode='22023'; end if;
  v_parent:=v_row.parent_id; v_type:=v_row.tag_type;
 end if;
 if exists(select 1 from erp_catalog.taxonomy t where t.kind=p_kind and t.parent_id is not distinct from v_parent and t.tag_type is not distinct from v_type
   and erp_catalog.fold(t.name)=erp_catalog.fold(v_name) and t.id is distinct from p_id) then
  return jsonb_build_object('kind',p_kind,'saved',false,'reason','duplicate_name','replayed',false,'data_mode','erp_native');
 end if;
 if p_id is null then
  insert into erp_catalog.taxonomy(kind,parent_id,name,tag_type,created_by,updated_by) values(p_kind,v_parent,v_name,case when v_tagged then v_type end,p_user_id,p_user_id) returning id into v_id;
  insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data) values(p_user_id,p_command_id,p_kind,v_id,'create',null,erp_catalog.taxonomy_item(v_id));
 else
  v_id:=p_id;
  if v_row.name is distinct from v_name then
   if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
   v_before:=erp_catalog.taxonomy_item(v_id);
   update erp_catalog.taxonomy set name=v_name,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
   insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data) values(p_user_id,p_command_id,p_kind,v_id,'update',v_before,erp_catalog.taxonomy_item(v_id));
  end if;
 end if;
 v_result:=jsonb_build_object('kind',p_kind,'saved',true,'item',erp_catalog.taxonomy_item(v_id),'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Ao excluir uma tag de Contatos, os contatos que a tinham perdem só essa tag: nova versão do conjunto de tags e auditoria.
create function erp_catalog.taxonomy_detach_contacts(p_user_id uuid,p_command_id uuid,p_tag_id uuid) returns integer
language plpgsql set search_path=pg_catalog as $$
declare v_id uuid; v_before jsonb; v_count integer:=0;
begin
 for v_id in select x.record_id from erp_catalog.contact_tag x where x.tag_id=p_tag_id order by x.record_id loop
  perform pg_advisory_xact_lock(174852912,hashtext(v_id::text));
  perform 1 from erp_catalog.contact_tag_state where record_id=v_id for update;
  v_before:=erp_catalog.contact_tag_ids(v_id);
  delete from erp_catalog.contact_tag where record_id=v_id and tag_id=p_tag_id;
  if not found then continue; end if;
  perform erp_catalog.contact_tag_bump(p_user_id,v_id);
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
   values(p_user_id,p_command_id,'contacts',v_id,'tag_removed',jsonb_build_object('tag_ids',v_before),jsonb_build_object('tag_ids',erp_catalog.contact_tag_ids(v_id)));
  v_count:=v_count+1;
 end loop;
 return v_count;
end $$;

-- Exclusão: o tipo decide a permissão; tags de Produtos saem dos produtos (como em 119) e as de Contatos saem dos contatos.
create or replace function public.erp_catalog_taxonomy_delete(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.taxonomy%rowtype; v_before jsonb; v_result jsonb; v_affected integer:=0; v_type text;
begin
 perform erp_catalog.require_taxonomy_access(p_user_id,p_kind,null,true);
 if erp_catalog.taxonomy_spec(p_kind) is null or p_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483647 then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 if p_kind in('tag_groups','tags') then
  select tag_type into v_type from erp_catalog.taxonomy where id=p_id and kind=p_kind;
  perform erp_catalog.require_taxonomy_access(p_user_id,p_kind,coalesce(v_type,'products'),true);
 end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','taxonomy_delete','kind',p_kind,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 perform pg_advisory_xact_lock(174852908,hashtext(p_kind));
 select * into v_row from erp_catalog.taxonomy where id=p_id and kind=p_kind for update;
 if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 v_before:=erp_catalog.taxonomy_item(p_id);
 if(v_before->>'children')::integer>0 then
  return jsonb_build_object('kind',p_kind,'id',p_id,'deleted',false,'reason','has_children','replayed',false,'data_mode','erp_native'); end if;
 if p_kind='product_groups' and(v_before->>'products')::integer>0 then
  return jsonb_build_object('kind',p_kind,'id',p_id,'deleted',false,'reason','in_use','replayed',false,'data_mode','erp_native'); end if;
 if p_kind='categories' or(p_kind='tags' and v_row.tag_type='products') then v_affected:=erp_catalog.taxonomy_detach(p_user_id,p_command_id,v_row); end if;
 if p_kind='tags' and v_row.tag_type='contacts' then v_affected:=erp_catalog.taxonomy_detach_contacts(p_user_id,p_command_id,p_id); end if;
 delete from erp_catalog.taxonomy where id=p_id;
 insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data) values(p_user_id,p_command_id,p_kind,p_id,'delete',v_before,null);
 v_result:=jsonb_build_object('kind',p_kind,'id',p_id,'deleted',true,'products',v_affected,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- O formulário do produto só aceita tags de Produtos.
create or replace function erp_catalog.product_detail_references(p_detail jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if(p_detail->>'category_id' is not null and not exists(select 1 from erp_catalog.taxonomy where id=(p_detail->>'category_id')::uuid and kind='categories'))
  or(p_detail->>'product_group_id' is not null and not exists(select 1 from erp_catalog.taxonomy where id=(p_detail->>'product_group_id')::uuid and kind='product_groups'))
  or exists(select 1 from jsonb_array_elements_text(coalesce(p_detail->'tag_ids','[]'::jsonb)) t where not exists(select 1 from erp_catalog.taxonomy where id=t::uuid and kind='tags' and tag_type='products'))
  or exists(select 1 from jsonb_array_elements(coalesce(p_detail->'suppliers','[]'::jsonb)) s where not exists(select 1 from erp_catalog.contact where record_id=(s->>'supplier_id')::uuid)) then
  raise exception 'erp_catalog_invalid_reference' using errcode='22023'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Tags do contato: leitura, versão e gravação.
create function erp_catalog.contact_tag_ids(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(x.tag_id::text order by x.tag_id::text),'[]'::jsonb) from erp_catalog.contact_tag x where x.record_id=p_id
$$;
create function erp_catalog.contact_tag_bump(p_user_id uuid,p_id uuid) returns void
language plpgsql set search_path=pg_catalog as $$
begin
 if(select version from erp_catalog.contact_tag_state where record_id=p_id)=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
 insert into erp_catalog.contact_tag_state(record_id,version,updated_by,updated_at) values(p_id,1,p_user_id,clock_timestamp())
  on conflict(record_id) do update set version=erp_catalog.contact_tag_state.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
end $$;
create function erp_catalog.contact_tags_data(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('contact_id',p_id,'version',coalesce((select s.version from erp_catalog.contact_tag_state s where s.record_id=p_id),0),
  'tag_ids',erp_catalog.contact_tag_ids(p_id),
  'tags',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'group_id',t.parent_id,'group_name',g.name) order by erp_catalog.fold(t.name),t.id)
   from erp_catalog.contact_tag x join erp_catalog.taxonomy t on t.id=x.tag_id left join erp_catalog.taxonomy g on g.id=t.parent_id where x.record_id=p_id),'[]'::jsonb))
$$;
create function erp_catalog.contact_visible_to(p_scope uuid,p_id uuid) returns boolean
language sql stable set search_path=pg_catalog as $$
 select p_scope is null or exists(select 1 from erp_catalog.contact_profile cp where cp.record_id=p_id and cp.seller_id=p_scope)
$$;

-- Marcadores da listagem e tags do formulário: até 100 contatos por leitura, só os visíveis para o perfil.
create function public.erp_catalog_contact_tags(p_user_id uuid,p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_scope uuid;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_ids is null or cardinality(p_ids) not between 1 and 100 or array_position(p_ids,null) is not null
  or(select count(distinct i) from unnest(p_ids) i)<>cardinality(p_ids) then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_scope:=erp_catalog.contact_scope(p_user_id);
 return jsonb_build_object('entity','contacts','data_mode','erp_native','items',coalesce((select jsonb_agg(erp_catalog.contact_tags_data(u.id) order by u.n)
  from unnest(p_ids) with ordinality u(id,n) join erp_catalog.contact c on c.record_id=u.id where erp_catalog.contact_visible_to(v_scope,u.id)),'[]'::jsonb));
end $$;

-- "Editar tags" (p_mode replace, com a versão do conjunto de tags) e "Incluir tags para selecionados" (p_mode add, sem
-- versão: acrescentar é comutativo e nunca tira uma tag gravada por outra operação). Até 50 tags de Contatos por contato.
-- Ordem de travas: as tags (como na gravação do produto), depois o contato e o conjunto de tags dele.
create function public.erp_catalog_contact_tags_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_tag_ids jsonb,p_mode text default 'replace')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_tags uuid[]; v_current integer; v_before jsonb; v_after jsonb; v_changed boolean; v_result jsonb; v_situation text;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_id is null or p_command_id is null or p_mode is null or p_mode not in('replace','add')
  or(p_mode='replace' and(p_expected_version is null or p_expected_version not between 0 and 2147483646)) or(p_mode='add' and p_expected_version is not null)
  or p_tag_ids is null or jsonb_typeof(p_tag_ids)<>'array' or jsonb_array_length(p_tag_ids)>50 or(p_mode='add' and jsonb_array_length(p_tag_ids)=0)
  or exists(select 1 from jsonb_array_elements(p_tag_ids) t where jsonb_typeof(t)<>'string' or t#>>'{}'!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 select coalesce(array_agg(distinct(t#>>'{}')::uuid),'{}'::uuid[]) into v_tags from jsonb_array_elements(p_tag_ids) t;
 if cardinality(v_tags)<>jsonb_array_length(p_tag_ids) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','contact_tags','id',p_id,'version',p_expected_version,'mode',p_mode,'tags',p_tag_ids)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 perform 1 from erp_catalog.taxonomy t where t.id=any(v_tags) order by t.id for key share;
 if(select count(*) from erp_catalog.taxonomy t where t.id=any(v_tags) and t.kind='tags' and t.tag_type='contacts')<>cardinality(v_tags) then
  raise exception 'erp_catalog_invalid_reference' using errcode='22023'; end if;
 perform 1 from erp_catalog.record r where r.id=p_id and r.entity='contacts' for share;
 if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_id);
 v_situation:=erp_catalog.contact_situation_of(p_id);
 -- Excluído is read-only, as in the contact form: restore it before changing its tags.
 if v_situation='E' then raise exception 'erp_catalog_contact_deleted' using errcode='22023'; end if;
 -- One tag writer per contact: two first saves (no state row yet) cannot both pass the version check.
 perform pg_advisory_xact_lock(174852912,hashtext(p_id::text));
 select version into v_current from erp_catalog.contact_tag_state where record_id=p_id for update;
 v_current:=coalesce(v_current,0);
 if p_mode='replace' and v_current<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 v_before:=erp_catalog.contact_tag_ids(p_id);
 if p_mode='replace' then delete from erp_catalog.contact_tag where record_id=p_id and not tag_id=any(v_tags); end if;
 insert into erp_catalog.contact_tag(record_id,tag_id) select p_id,t from unnest(v_tags) t on conflict do nothing;
 if(select count(*) from erp_catalog.contact_tag where record_id=p_id)>50 then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
 v_after:=erp_catalog.contact_tag_ids(p_id); v_changed:=v_after is distinct from v_before;
 if v_changed then
  perform erp_catalog.contact_tag_bump(p_user_id,p_id);
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
   values(p_user_id,p_command_id,'contacts',p_id,case p_mode when 'add' then 'tags_added' else 'tags_update' end,jsonb_build_object('tag_ids',v_before),jsonb_build_object('tag_ids',v_after));
 end if;
 v_result:=jsonb_build_object('entity','contacts','contact',erp_catalog.contact_tags_data(p_id),'changed',v_changed,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Listagem e exportação de contatos com os filtros Tags e Lista de preço. Mesmo resultado de erp_catalog_contact_page e de
-- erp_catalog_contact_export (lane de contatos), com dois parâmetros a mais ($n tag: 'none' ou o id; $n+1 lista de preço).
-- Lista de preço: contatos vinculados à lista (categoria Contato) ou com a UF da lista (categoria Região).
create function erp_catalog.contact_tag_where(p_first integer) returns text
language sql immutable set search_path=pg_catalog as $$
 select format($q$ and($%1$s::text is null or case $%1$s::text when 'none' then not exists(select 1 from erp_catalog.contact_tag x where x.record_id=r.id)
   else exists(select 1 from erp_catalog.contact_tag x where x.record_id=r.id and x.tag_id=$%1$s::uuid) end)
  and($%2$s::uuid is null or exists(select 1 from erp_pricing.price_list_contact pc where pc.list_id=$%2$s::uuid and pc.contact_id=r.id)
   or exists(select 1 from erp_pricing.price_list_region pg where pg.list_id=$%2$s::uuid and pg.state=upper(btrim(c.state))))$q$,p_first,p_first+1)
$$;
create function erp_catalog.contact_tag_filter_valid(p_tag text) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select p_tag is null or p_tag='none' or p_tag~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

create function public.erp_catalog_contact_page_tagged(p_user_id uuid,p_page integer default 1,p_size integer default 100,p_sort text default 'created_desc',
 p_query text default null,p_situation text default 'latest',p_type text default null,p_person_type text default null,p_state text default null,
 p_city text default null,p_phone text default null,p_email text default null,p_seller_id uuid default null,p_period text default null,
 p_from date default null,p_to date default null,p_sale_statuses text[] default null,p_tag text default null,p_price_list_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_terms text[]; v_total bigint; v_ids uuid[]; v_items jsonb; v_scope uuid; v_sql text;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if not erp_catalog.page_valid(p_page,p_size,p_sort,p_query,null,null,null)
  or not erp_catalog.contact_filter_valid(p_situation,p_type,p_person_type,p_state,p_city,p_phone,p_email,p_period,p_from,p_to,p_sale_statuses)
  or not erp_catalog.contact_tag_filter_valid(p_tag) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_scope:=erp_catalog.contact_scope(p_user_id); v_terms:=erp_catalog.search_terms(p_query);
 v_sql:=erp_catalog.page_sql(erp_catalog.contact_where(p_period)||erp_catalog.contact_tag_where(16),p_sort,v_terms is not null,18);
 execute v_sql into v_total,v_ids using p_situation,v_terms,p_type,p_person_type,p_state,nullif(btrim(p_city),''),nullif(erp_catalog.digits(p_phone),''),
  nullif(btrim(p_email),''),p_seller_id,v_scope,
  case when p_from is not null then p_from::timestamp at time zone 'America/Sao_Paulo' end,case when p_to is not null then (p_to+1)::timestamp at time zone 'America/Sao_Paulo' end,
  p_from,p_to,p_sale_statuses,p_tag,p_price_list_id,(p_page-1)*p_size,p_size;
 select coalesce(jsonb_agg(erp_catalog.contact_list_item(u.id) order by u.n),'[]'::jsonb) into v_items from unnest(v_ids) with ordinality u(id,n);
 return jsonb_build_object('entity','contacts','items',v_items,'page',p_page,'size',p_size,'total',v_total,'sort',p_sort,'situation',p_situation,
  'scoped',v_scope is not null,'data_mode','erp_native');
end $$;

create function public.erp_catalog_contact_export_tagged(p_user_id uuid,p_kind text default 'contacts',p_offset integer default 0,p_limit integer default 100,
 p_sort text default 'created_desc',p_query text default null,p_situation text default 'latest',p_type text default null,p_person_type text default null,
 p_state text default null,p_city text default null,p_phone text default null,p_email text default null,p_seller_id uuid default null,p_period text default null,
 p_from date default null,p_to date default null,p_sale_statuses text[] default null,p_birth_from date default null,p_birth_to date default null,
 p_tag text default null,p_price_list_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_terms text[]; v_total bigint; v_ids uuid[]; v_items jsonb; v_scope uuid; v_where text; v_order text; v_whole boolean;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_kind is null or p_kind not in('contacts','birthdays') or p_offset is null or p_offset not between 0 and 9999 or p_limit is null or p_limit not between 1 and 100
  or not erp_catalog.page_valid(1,1,p_sort,p_query,null,null,null)
  or not erp_catalog.contact_filter_valid(p_situation,p_type,p_person_type,p_state,p_city,p_phone,p_email,p_period,p_from,p_to,p_sale_statuses)
  or not erp_catalog.contact_tag_filter_valid(p_tag)
  or(p_kind='contacts' and num_nonnulls(p_birth_from,p_birth_to)>0)
  or(p_kind='birthdays' and(p_birth_from is null or p_birth_to is null or p_birth_from>p_birth_to or p_birth_to-p_birth_from>366
   or p_birth_from<date '1900-01-01' or p_birth_to>date '2100-12-31')) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_scope:=erp_catalog.contact_scope(p_user_id); v_terms:=erp_catalog.search_terms(p_query);
 v_where:=erp_catalog.contact_where(p_period)||erp_catalog.contact_tag_where(18);
 v_whole:=p_kind='birthdays' and p_birth_to-p_birth_from>=365;
 if p_kind='birthdays' then
  -- Same Aniversariantes rule as erp_catalog_contact_export: month/day inside the period (any year); a whole year takes all.
  v_where:=v_where||' and cp.birth_date is not null'||case when v_whole then '' else ' and(case when $16::text<=$17::text then to_char(cp.birth_date,''MMDD'') between $16::text and $17::text
   else to_char(cp.birth_date,''MMDD'')>=$16::text or to_char(cp.birth_date,''MMDD'')<=$17::text end)' end;
  v_order:='to_char(cp.birth_date,''MMDD''),erp_catalog.fold(r.name),r.id';
 else v_order:=erp_catalog.page_order(p_sort); end if;
 execute 'select (select count(*)'||v_where||'),array(select r.id'||v_where||' order by '||v_order||' offset $20 limit $21)' into v_total,v_ids
  using p_situation,v_terms,p_type,p_person_type,p_state,nullif(btrim(p_city),''),nullif(erp_catalog.digits(p_phone),''),nullif(btrim(p_email),''),p_seller_id,v_scope,
   case when p_from is not null then p_from::timestamp at time zone 'America/Sao_Paulo' end,case when p_to is not null then (p_to+1)::timestamp at time zone 'America/Sao_Paulo' end,
   p_from,p_to,p_sale_statuses,
   case when p_kind='birthdays' then to_char(p_birth_from,'MMDD') end,case when p_kind='birthdays' then to_char(p_birth_to,'MMDD') end,p_tag,p_price_list_id,p_offset,p_limit;
 if v_total>10000 then raise exception 'erp_catalog_export_too_large' using errcode='22023'; end if;
 select coalesce(jsonb_agg(erp_catalog.contact_dto(u.id)-'persons'-'source' order by u.n),'[]'::jsonb) into v_items from unnest(v_ids) with ordinality u(id,n);
 if p_offset=0 then
  insert into erp_catalog.auxiliary_audit(actor,subject,action,after_data)
   values(p_user_id,'contacts_export',p_kind,jsonb_build_object('total',v_total,'situation',p_situation,'type',p_type,'period',p_period,'query_present',p_query is not null,
    'tag',p_tag is not null,'price_list',p_price_list_id is not null));
 end if;
 return jsonb_build_object('scope','contacts_export','kind',p_kind,'items',v_items,'offset',p_offset,'limit',p_limit,'total',v_total,'data_mode','erp_native');
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_taxonomy_list(uuid,text)','erp_catalog_taxonomy_save(uuid,text,uuid,integer,uuid,jsonb)',
  'erp_catalog_taxonomy_delete(uuid,text,uuid,integer,uuid)','erp_catalog_contact_tags(uuid,uuid[])',
  'erp_catalog_contact_tags_save(uuid,uuid,integer,uuid,jsonb,text)',
  'erp_catalog_contact_page_tagged(uuid,integer,integer,text,text,text,text,text,text,text,text,text,uuid,text,date,date,text[],text,uuid)',
  'erp_catalog_contact_export_tagged(uuid,text,integer,integer,text,text,text,text,text,text,text,text,text,uuid,text,date,date,text[],date,date,text,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
