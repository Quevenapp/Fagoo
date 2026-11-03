-- Marcadores (tags) das notas fiscais no padrão do Origin (onda E, área de produtos, item NFE-014):
-- * Tags e grupos de tags ganham o Tipo "Notas fiscais" (invoices), ao lado de Produtos e Contatos (153). Consultam as tags desse
--   tipo os perfis que consultam as notas (administrador, consulta e fiscal); incluem, editam e excluem os que gravam notas
--   (administrador e fiscal), como as notas do Brufap.
-- * Vínculo das tags com as notas da listagem: as notas espelhadas do Origin (pelo id de origem, NF-e ou NFC-e) e as notas do
--   Brufap (homologação). As tags ficam só no Brufap: não vão para o Origin e as tags do Origin não são espelhadas. Cada nota tem
--   a versão do seu conjunto de tags (invoice_tag_state): "Editar tags" substitui o conjunto com a versão esperada; "Incluir tags"
--   acrescenta sem versão. Comando idempotente e auditoria própria (invoice_tag_audit). Excluir uma tag de Notas fiscais tira a
--   tag das notas com nova versão do conjunto e auditoria.
-- * Coluna Marcadores (erp_catalog_invoice_tags, até 100 notas por leitura) e o filtro Tags da listagem
--   (erp_catalog_invoice_list_tagged: os mesmos filtros e a mesma resposta de erp_fiscal_invoice_list, 215, mais a tag ou
--   "Sem Tag"; usada só com o filtro). Nenhuma função da área de notas é redefinida: as linhas vêm de erp_fiscal_invoices.list_rows.
-- * Preferências > Sistema > Campos customizados (229): o formulário da categoria só muda os campos customizáveis vinculados
--   com a permissão "Inclusão e edição" de Campos Customizados.
-- Nada aqui envia, assina ou transmite nota, gera estoque, título, imposto, XML ou escrita no Origin. Depende de 113/153/156/215/235.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 if to_regprocedure('erp_fiscal_invoices.list_rows(text,text,text,text)') is null or to_regprocedure('erp_fiscal_invoices.origin_seller_ids(uuid)') is null
  or to_regprocedure('erp_catalog.require_custom_field_permission(uuid,text)') is null then
  raise exception 'invoice_tags_236_requires_113_215_235' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_catalog.tag_types_readable(uuid)','f463d55a095de61fb8d03ac1fed6b26d8d89b50eb8e4f1ef02b13c2e4f11de80'),
  ('erp_catalog.require_taxonomy_access(uuid,text,text,boolean)','49008640c5a4a9fdf4b56e74f5d423f1d51ffef3d50d417408083bd84a9584b5'),
  ('erp_catalog.taxonomy_item(uuid)','8b7b7efa74ae42fc2690402e1cd17bf1f5f1926106c0384e7306eaa8e18f01a4'),
  ('public.erp_catalog_taxonomy_save(uuid,text,uuid,integer,uuid,jsonb)','da1b62595d1a54458a0582488d007955ab8e8de14d2a4d366251b5430df674ae'),
  ('public.erp_catalog_taxonomy_delete(uuid,text,uuid,integer,uuid)','90dd0f98e88b5d3aeb5b2c9f1f5c0972a8b9ef20bd3dc2450dc3737df0f2f2b1'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'invoice_tags_236_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
 if not exists(select 1 from pg_constraint where conrelid='erp_catalog.taxonomy'::regclass and conname='taxonomy_tag_type_check') then
  raise exception 'invoice_tags_236_tag_type_check_missing' using errcode='55000'; end if;
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Tipo "Notas fiscais" das tags e dos grupos de tags.
alter table erp_catalog.taxonomy drop constraint taxonomy_tag_type_check;
alter table erp_catalog.taxonomy add constraint taxonomy_tag_type_check check(tag_type in('products','contacts','invoices'));

-- Tags das notas: origem (origin: id de origem da NF-e/NFC-e espelhada; brufap: a nota do Brufap), modelo e a nota.
create table erp_catalog.invoice_tag(
 origin text not null check(origin in('origin','brufap')),
 model text not null check(model in('55','65')),
 invoice_id text not null,
 tag_id uuid not null, tag_kind text not null default 'tags' check(tag_kind='tags'),
 tag_type text not null default 'invoices' check(tag_type='invoices'),
 primary key(origin,model,invoice_id,tag_id),
 foreign key(tag_id,tag_kind,tag_type) references erp_catalog.taxonomy(id,kind,tag_type),
 check((origin='origin' and invoice_id~'^[0-9]{1,40}$') or(origin='brufap' and invoice_id~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);
create index erp_catalog_invoice_tag_tag on erp_catalog.invoice_tag(tag_id);
create table erp_catalog.invoice_tag_state(
 origin text not null check(origin in('origin','brufap')),
 model text not null check(model in('55','65')),
 invoice_id text not null,
 version integer not null check(version between 1 and 2147483647),
 updated_by uuid not null references auth.users(id),
 updated_at timestamptz not null default clock_timestamp(),
 primary key(origin,model,invoice_id)
);
create table erp_catalog.invoice_tag_audit(
 id bigint generated always as identity primary key,
 actor uuid not null references auth.users(id), command_id uuid not null,
 origin text not null, model text not null, invoice_id text not null,
 action text not null check(action in('tags_update','tags_added','tag_removed')),
 before_data jsonb not null, after_data jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
 foreach t in array array['invoice_tag','invoice_tag_state','invoice_tag_audit'] loop
  execute format('alter table erp_catalog.%I enable row level security',t);
  execute format('revoke all on table erp_catalog.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Permissões por tipo: Produtos e Contatos como em 153; Notas fiscais pelos perfis das notas (consultar: administrador,
-- consulta e fiscal; gravar: administrador e fiscal).
create function erp_catalog.invoice_tags_allowed(p_role text,p_write boolean) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_role in('admin','fiscal') or(not p_write and p_role='consulta'),false)
$$;
create or replace function erp_catalog.tag_types_readable(p_user_id uuid) returns text[]
language sql stable set search_path=pg_catalog as $$
 select coalesce(array_agg(t order by t),'{}'::text[]) from unnest(array['contacts','invoices','products']) t
 where exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active
  and case t when 'invoices' then erp_catalog.invoice_tags_allowed(m.role,false) else erp_catalog.allowed(m.role,erp_catalog.tag_entity(t),false) end)
$$;
-- Categorias e grupos de produtos: permissão de produtos. Tags e grupos de tags: a do tipo; sem o tipo (ainda não lido), basta
-- poder consultar/gravar um dos tipos.
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
 else perform erp_catalog.require_access(p_user_id,'products',p_write); end if;
end $$;

-- 153 plus, for the tags of Notas fiscais only, how many notes have the tag (the key exists only on those items).
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
  ||case when t.tag_type='invoices' then jsonb_build_object('invoices',case t.kind when 'tags' then(select count(*) from erp_catalog.invoice_tag x where x.tag_id=t.id) else 0 end::integer) else '{}'::jsonb end
 from erp_catalog.taxonomy t where t.id=p_id
$$;

-- Inclusão e edição (156) com o Tipo Notas fiscais e a permissão de Campos Customizados no vínculo dos campos da categoria. O
-- resto do corpo é o publicado em 156.
create or replace function public.erp_catalog_taxonomy_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_spec jsonb:=erp_catalog.taxonomy_spec(p_kind); v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.taxonomy%rowtype;
 v_name text; v_parent uuid; v_parent_kind text; v_parent_type text; v_type text; v_id uuid; v_before jsonb; v_result jsonb; v_tagged boolean:=p_kind in('tag_groups','tags');
 v_fields uuid[]; v_linked integer:=0;
begin
 perform erp_catalog.require_taxonomy_access(p_user_id,p_kind,null,true);
 if v_spec is null or p_command_id is null or p_expected_version is null or p_data is null or jsonb_typeof(p_data)<>'object'
  or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647)
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in('name','parent_id','tag_type','custom_field_ids'))
  or jsonb_typeof(p_data->'name') is distinct from 'string'
  or(p_data?'parent_id' and jsonb_typeof(p_data->'parent_id') not in('string','null'))
  or(p_data->>'parent_id' is not null and p_data->>'parent_id'!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
  or(p_data?'tag_type' and(not v_tagged or jsonb_typeof(p_data->'tag_type') is distinct from 'string' or p_data->>'tag_type' not in('products','contacts','invoices')))
  or(p_data?'custom_field_ids' and(p_kind<>'categories' or jsonb_typeof(p_data->'custom_field_ids')<>'array' or jsonb_array_length(p_data->'custom_field_ids')>60
   or exists(select 1 from jsonb_array_elements(p_data->'custom_field_ids') x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   or(select count(distinct x#>>'{}') from jsonb_array_elements(p_data->'custom_field_ids') x)<>jsonb_array_length(p_data->'custom_field_ids'))) then
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
 -- 235: the custom fields linked to a category change the field definitions ("Inclusão e edição" of Campos Customizados).
 if p_data?'custom_field_ids' then perform erp_catalog.require_custom_field_permission(p_user_id,'ie'); end if;
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
 if p_data?'custom_field_ids' then
  perform pg_advisory_xact_lock(174852913,hashtext('products'));
  v_fields:=(select coalesce(array_agg((x#>>'{}')::uuid),'{}'::uuid[]) from jsonb_array_elements(p_data->'custom_field_ids') x);
 end if;
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
 if v_fields is not null then v_linked:=erp_catalog.category_custom_fields_set(p_user_id,p_command_id,v_id,v_fields); end if;
 -- The linked fields are part of the category form: changing them gives the category a new version (once per command), so a
 -- form opened before gets a conflict instead of silently undoing this change.
 if v_linked>0 and p_id is not null and v_row.name is not distinct from v_name then
  if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
  v_before:=erp_catalog.taxonomy_item(v_id);
  update erp_catalog.taxonomy set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data)
   values(p_user_id,p_command_id,p_kind,v_id,'update',v_before,erp_catalog.taxonomy_item(v_id)||jsonb_build_object('custom_field_ids',to_jsonb(v_fields)));
 end if;
 v_result:=jsonb_build_object('kind',p_kind,'saved',true,'item',erp_catalog.taxonomy_item(v_id),'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Tags de uma nota: leitura, versão do conjunto e auditoria.
create function erp_catalog.invoice_tag_ids(p_origin text,p_model text,p_id text) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(x.tag_id::text order by x.tag_id::text),'[]'::jsonb) from erp_catalog.invoice_tag x where x.origin=p_origin and x.model=p_model and x.invoice_id=p_id
$$;
create function erp_catalog.invoice_tags_data(p_origin text,p_model text,p_id text) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('invoice_id',p_id,'version',coalesce((select s.version from erp_catalog.invoice_tag_state s where s.origin=p_origin and s.model=p_model and s.invoice_id=p_id),0),
  'tag_ids',erp_catalog.invoice_tag_ids(p_origin,p_model,p_id),
  'tags',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'group_id',t.parent_id,'group_name',g.name) order by erp_catalog.fold(t.name),t.id)
   from erp_catalog.invoice_tag x join erp_catalog.taxonomy t on t.id=x.tag_id left join erp_catalog.taxonomy g on g.id=t.parent_id
   where x.origin=p_origin and x.model=p_model and x.invoice_id=p_id),'[]'::jsonb))
$$;
create function erp_catalog.invoice_tag_bump(p_user_id uuid,p_origin text,p_model text,p_id text) returns void
language plpgsql set search_path=pg_catalog as $$
begin
 if(select version from erp_catalog.invoice_tag_state where origin=p_origin and model=p_model and invoice_id=p_id)=2147483647 then
  raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
 insert into erp_catalog.invoice_tag_state(origin,model,invoice_id,version,updated_by,updated_at) values(p_origin,p_model,p_id,1,p_user_id,clock_timestamp())
  on conflict(origin,model,invoice_id) do update set version=erp_catalog.invoice_tag_state.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
end $$;
-- Identificador válido para a origem: o id de origem do Origin (dígitos) ou o UUID da nota do Brufap (minúsculo).
create function erp_catalog.invoice_tag_key_valid(p_origin text,p_model text,p_id text) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_model in('55','65') and case p_origin when 'origin' then p_id~'^[0-9]{1,40}$'
  when 'brufap' then p_id~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' else false end,false)
$$;
-- A nota existe: a NF-e/NFC-e espelhada do Origin, ou a nota do Brufap (não excluída) do mesmo modelo.
create function erp_catalog.invoice_tag_target(p_origin text,p_model text,p_id text) returns boolean
language sql stable set search_path=pg_catalog as $$
 select case p_origin
  when 'brufap' then exists(select 1 from erp_fiscal_invoices.invoice v where v.id=p_id::uuid and v.model=p_model and v.deleted_at is null)
  when 'origin' then exists(select 1 from origin_sync.raw_record r where r.entity=case p_model when '55' then 'nfe' else 'nfce' end and r.source_id=p_id)
  else false end
$$;
-- Profile of the notes: read (administrador, consulta, fiscal) or write (administrador, fiscal); the Brufap notes only for the
-- profiles that see them (administrador and fiscal, as in the list).
create function erp_catalog.require_invoice_tags(p_user_id uuid,p_origin text,p_write boolean) returns text
language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if not erp_catalog.invoice_tags_allowed(v_role,p_write) or(p_origin='brufap' and v_role not in('admin','fiscal')) then
  raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
 return v_role;
end $$;

-- Marcadores da listagem: as tags de até 100 notas de uma origem e um modelo, na ordem pedida.
create function public.erp_catalog_invoice_tags(p_user_id uuid,p_origin text,p_model text,p_ids text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.require_invoice_tags(p_user_id,p_origin,false);
 if p_ids is null or cardinality(p_ids) not between 1 and 100 or array_position(p_ids,null) is not null
  or(select count(distinct i) from unnest(p_ids) i)<>cardinality(p_ids) or exists(select 1 from unnest(p_ids) i where not erp_catalog.invoice_tag_key_valid(p_origin,p_model,i)) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 return jsonb_build_object('scope','invoice_tags','origin',p_origin,'model',p_model,'data_mode','erp_native',
  'items',(select jsonb_agg(erp_catalog.invoice_tags_data(p_origin,p_model,u.id) order by u.n) from unnest(p_ids) with ordinality u(id,n)));
end $$;

-- "Editar tags" (p_mode replace, com a versão do conjunto) e "Incluir tags" (p_mode add, sem versão: acrescentar é comutativo e
-- nunca tira uma tag gravada por outra operação). Até 50 tags de Notas fiscais por nota.
-- Ordem de travas: as tags (como nas tags dos contatos), depois o conjunto de tags da nota.
create function public.erp_catalog_invoice_tags_save(p_user_id uuid,p_origin text,p_model text,p_id text,p_expected_version integer,p_command_id uuid,
 p_tag_ids jsonb,p_mode text default 'replace')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_tags uuid[]; v_current integer; v_before jsonb; v_after jsonb; v_changed boolean; v_result jsonb;
begin
 perform erp_catalog.require_invoice_tags(p_user_id,p_origin,true);
 if p_command_id is null or p_mode is null or p_mode not in('replace','add') or not erp_catalog.invoice_tag_key_valid(p_origin,p_model,p_id)
  or(p_mode='replace' and(p_expected_version is null or p_expected_version not between 0 and 2147483646)) or(p_mode='add' and p_expected_version is not null)
  or p_tag_ids is null or jsonb_typeof(p_tag_ids)<>'array' or jsonb_array_length(p_tag_ids)>50 or(p_mode='add' and jsonb_array_length(p_tag_ids)=0)
  or exists(select 1 from jsonb_array_elements(p_tag_ids) t where jsonb_typeof(t)<>'string' or t#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 select coalesce(array_agg(distinct(t#>>'{}')::uuid),'{}'::uuid[]) into v_tags from jsonb_array_elements(p_tag_ids) t;
 if cardinality(v_tags)<>jsonb_array_length(p_tag_ids) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','invoice_tags','origin',p_origin,'model',p_model,'id',p_id,'version',p_expected_version,
  'mode',p_mode,'tags',p_tag_ids)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 perform 1 from erp_catalog.taxonomy t where t.id=any(v_tags) order by t.id for key share;
 if(select count(*) from erp_catalog.taxonomy t where t.id=any(v_tags) and t.kind='tags' and t.tag_type='invoices')<>cardinality(v_tags) then
  raise exception 'erp_catalog_invalid_reference' using errcode='22023'; end if;
 if not erp_catalog.invoice_tag_target(p_origin,p_model,p_id) then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 -- One tag writer per note: two first saves (no state row yet) cannot both pass the version check.
 perform pg_advisory_xact_lock(174853101,hashtext(p_origin||':'||p_model||':'||p_id));
 select version into v_current from erp_catalog.invoice_tag_state where origin=p_origin and model=p_model and invoice_id=p_id for update;
 v_current:=coalesce(v_current,0);
 if p_mode='replace' and v_current<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 v_before:=erp_catalog.invoice_tag_ids(p_origin,p_model,p_id);
 if p_mode='replace' then delete from erp_catalog.invoice_tag where origin=p_origin and model=p_model and invoice_id=p_id and not tag_id=any(v_tags); end if;
 insert into erp_catalog.invoice_tag(origin,model,invoice_id,tag_id) select p_origin,p_model,p_id,t from unnest(v_tags) t on conflict do nothing;
 if(select count(*) from erp_catalog.invoice_tag where origin=p_origin and model=p_model and invoice_id=p_id)>50 then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
 v_after:=erp_catalog.invoice_tag_ids(p_origin,p_model,p_id); v_changed:=v_after is distinct from v_before;
 if v_changed then
  perform erp_catalog.invoice_tag_bump(p_user_id,p_origin,p_model,p_id);
  insert into erp_catalog.invoice_tag_audit(actor,command_id,origin,model,invoice_id,action,before_data,after_data)
   values(p_user_id,p_command_id,p_origin,p_model,p_id,case p_mode when 'add' then 'tags_added' else 'tags_update' end,jsonb_build_object('tag_ids',v_before),jsonb_build_object('tag_ids',v_after));
 end if;
 v_result:=jsonb_build_object('scope','invoice_tags','origin',p_origin,'model',p_model,'invoice',erp_catalog.invoice_tags_data(p_origin,p_model,p_id),'changed',v_changed,
  'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Ao excluir uma tag de Notas fiscais, as notas que a tinham perdem só essa tag: nova versão do conjunto de tags e auditoria.
create function erp_catalog.taxonomy_detach_invoices(p_user_id uuid,p_command_id uuid,p_tag_id uuid) returns integer
language plpgsql set search_path=pg_catalog as $$
declare v record; v_before jsonb; v_count integer:=0;
begin
 for v in select x.origin,x.model,x.invoice_id from erp_catalog.invoice_tag x where x.tag_id=p_tag_id order by x.origin,x.model,x.invoice_id loop
  perform pg_advisory_xact_lock(174853101,hashtext(v.origin||':'||v.model||':'||v.invoice_id));
  perform 1 from erp_catalog.invoice_tag_state where origin=v.origin and model=v.model and invoice_id=v.invoice_id for update;
  v_before:=erp_catalog.invoice_tag_ids(v.origin,v.model,v.invoice_id);
  delete from erp_catalog.invoice_tag where origin=v.origin and model=v.model and invoice_id=v.invoice_id and tag_id=p_tag_id;
  if not found then continue; end if;
  perform erp_catalog.invoice_tag_bump(p_user_id,v.origin,v.model,v.invoice_id);
  insert into erp_catalog.invoice_tag_audit(actor,command_id,origin,model,invoice_id,action,before_data,after_data)
   values(p_user_id,p_command_id,v.origin,v.model,v.invoice_id,'tag_removed',jsonb_build_object('tag_ids',v_before),jsonb_build_object('tag_ids',erp_catalog.invoice_tag_ids(v.origin,v.model,v.invoice_id)));
  v_count:=v_count+1;
 end loop;
 return v_count;
end $$;

-- Exclusão (153): o tipo decide a permissão; as tags de Notas fiscais saem das notas. O resto do corpo é o publicado em 153.
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
 if p_kind='tags' and v_row.tag_type='invoices' then v_affected:=erp_catalog.taxonomy_detach_invoices(p_user_id,p_command_id,p_id); end if;
 delete from erp_catalog.taxonomy where id=p_id;
 insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data) values(p_user_id,p_command_id,p_kind,p_id,'delete',v_before,null);
 v_result:=jsonb_build_object('kind',p_kind,'id',p_id,'deleted',true,'products',v_affected,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Filtro Tags da listagem de notas: os mesmos parâmetros, filtros e resposta de erp_fiscal_invoice_list (215), mais p_tag ('none' =
-- Sem Tag, ou a tag de Notas fiscais). As linhas vêm de erp_fiscal_invoices.list_rows (113); um teste compara esta função com a
-- listagem da área de notas. Usada pela tela só com o filtro Tags.
create function public.erp_catalog_invoice_list_tagged(p_user_id uuid,p_origin text default 'origin',p_model text default '55',p_direction text default '1',p_page integer default 1,
 p_limit integer default 100,p_order text default 'date_desc',p_query text default null,p_date_type text default 'issue',p_date_from date default null,p_date_to date default null,
 p_status text default null,p_product_id uuid default null,p_state text default null,p_nature text default null,p_carrier text default null,p_trade_name text default null,
 p_person_type text default null,p_document text default null,p_email text default null,p_phone text default null,p_series integer default null,p_contact_code text default null,
 p_order_number text default null,p_tracking text default null,p_seller_id uuid default null,p_tag text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_read(p_user_id);q text:=nullif(btrim(p_query),'');qd text;codes smallint[];product_code text;result jsonb;origin_sellers text[];
 v_entity text:=case p_model when '65' then 'nfce' else 'nfe' end;
begin
 if p_origin is null or p_origin not in('origin','brufap') or p_model is null or p_model not in('55','65') or p_direction is null or p_direction not in('0','1') or (p_model='65' and p_direction<>'1')
  or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or p_order is null or p_order not in('date_desc','date_asc','number_desc','number_asc')
  or p_date_type is null or p_date_type not in('issue','entry') or (p_date_from is not null and p_date_to is not null and p_date_from>p_date_to)
  or (p_status is not null and erp_fiscal_invoices.status_group(p_status) is null) or (p_state is not null and not p_state=any(erp_fiscal_invoices.ufs()||array['EX']))
  or (p_person_type is not null and p_person_type not in('J','F','E')) or (p_series is not null and p_series not between 0 and 999)
  or exists(select 1 from unnest(array[p_query,p_nature,p_carrier,p_trade_name,p_document,p_email,p_phone,p_contact_code,p_order_number,p_tracking]) t where length(t)>120 or t~'[[:cntrl:]]')
  or p_tag is null or(p_tag<>'none' and p_tag!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 if p_origin='brufap' and role not in('admin','fiscal') then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 qd:=erp_fiscal_invoices.digits(q);codes:=erp_fiscal_invoices.status_group(p_status);
 if p_product_id is not null then select code into product_code from erp_catalog.record where id=p_product_id and entity='products'; end if;
 if p_seller_id is not null and p_origin='origin' then origin_sellers:=erp_fiscal_invoices.origin_seller_ids(p_seller_id); end if;
 with rows as materialized(
  select * from erp_fiscal_invoices.list_rows(p_origin,p_model,p_direction,role) x
  where (q is null or strpos(lower(coalesce(x.name,'')),lower(q))>0 or strpos(lower(coalesce(x.trade_name,'')),lower(q))>0
    or (length(qd)>=5 and strpos(coalesce(x.document,''),qd)>0) or (qd=q and qd<>'' and ltrim(x.number::text,'0')=ltrim(qd,'0')) or (length(qd)=44 and x.access_key=qd))
   and (p_date_from is null or (case when p_date_type='entry' then x.entry_date else x.issue_date end)>=p_date_from)
   and (p_date_to is null or (case when p_date_type='entry' then x.entry_date else x.issue_date end)<=p_date_to)
   and (codes is null or x.status=any(codes))
   and (p_product_id is null or p_product_id=any(x.product_ids) or (product_code is not null and product_code=any(x.product_codes)))
   and (p_state is null or x.state=p_state)
   and (nullif(btrim(p_nature),'') is null or strpos(lower(coalesce(x.nature,'')),lower(btrim(p_nature)))>0)
   and (nullif(btrim(p_carrier),'') is null or strpos(lower(coalesce(x.carrier,'')),lower(btrim(p_carrier)))>0)
   and (nullif(btrim(p_trade_name),'') is null or strpos(lower(coalesce(x.trade_name,'')),lower(btrim(p_trade_name)))>0)
   and (p_person_type is null or x.person_type=p_person_type)
   and (nullif(erp_fiscal_invoices.digits(p_document),'') is null or x.document=erp_fiscal_invoices.digits(p_document))
   and (nullif(btrim(p_email),'') is null or strpos(lower(coalesce(x.email,'')),lower(btrim(p_email)))>0)
   and (nullif(erp_fiscal_invoices.digits(p_phone),'') is null or strpos(coalesce(x.phone,''),erp_fiscal_invoices.digits(p_phone))>0)
   and (p_series is null or x.series=p_series)
   and (nullif(btrim(p_contact_code),'') is null or x.contact_code=btrim(p_contact_code))
   and (nullif(btrim(p_order_number),'') is null or btrim(p_order_number)=any(x.order_numbers))
   and (nullif(btrim(p_tracking),'') is null or strpos(lower(coalesce(x.tracking,'')),lower(btrim(p_tracking)))>0)
   and (p_seller_id is null
    or (x.origin='brufap' and exists(select 1 from erp_fiscal_invoices.invoice v where v.id::text=x.id and v.seller_id=p_seller_id))
    or (x.origin='origin' and cardinality(origin_sellers)>0 and exists(select 1 from origin_sync.raw_record n where n.entity=v_entity and n.source_id=x.id
     and n.payload#>>'{vendedor,id}'=any(origin_sellers))))
   -- 236: Tags (Sem Tag ou a tag de Notas fiscais).
   and case when p_tag='none' then not exists(select 1 from erp_catalog.invoice_tag t where t.origin=x.origin and t.model=p_model and t.invoice_id=x.id)
    else exists(select 1 from erp_catalog.invoice_tag t where t.origin=x.origin and t.model=p_model and t.invoice_id=x.id and t.tag_id=p_tag::uuid) end
 ),ordered as(
  select r.*,row_number() over(order by
   case when p_order='date_desc' then r.issue_date end desc nulls last,case when p_order='date_asc' then r.issue_date end asc nulls last,
   case when p_order in('number_desc','date_desc') then r.number end desc nulls last,case when p_order in('number_asc','date_asc') then r.number end asc nulls last,
   r.origin,r.id desc) ord from rows r
 ),page as(select * from ordered where ord>(p_page-1)::bigint*p_limit and ord<=p_page::bigint*p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('origin',p.origin,'id',p.id,'version',p.version,'number',p.number,'series',p.series,
   'issue_date',p.issue_date,'entry_date',p.entry_date,'name',p.name,'document',p.document,'state',p.state,'nature',p.nature,'status',p.status,'status_raw',p.status_raw,
   'total',erp_fiscal_invoices.money_text(p.total),'total_known',p.total is not null,'environment',p.environment,'issue_type',p.issue_type,'access_key',p.access_key,
   'xml_id',p.xml_id,'xml_hash',p.xml_hash,'xml_size',p.xml_size,'protocol_present',p.protocol_present,'event_count',p.event_count,'orders',p.orders) order by p.ord)
   from page p),'[]'::jsonb),
  'origin',p_origin,'model',p_model,'direction',p_direction,'page',p_page,'limit',p_limit,'order',p_order,'has_more',(select count(*) from rows)>p_page::bigint*p_limit,
  'total_count',(select count(*)::integer from rows),'total_amount',erp_fiscal_invoices.money_text((select sum(total) from rows)),
  'amount_unknown',(select count(*)::integer from rows where total is null),'brufap_visible',role in('admin','fiscal'),
  'show_totals',erp_fiscal_invoices.preference('nfe.exibir_totais','boolean','true'),
  'data_mode',case p_origin when 'origin' then 'origin_mirror_readonly' else 'erp_native_homologation' end)
 into result;
 return result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_taxonomy_save(uuid,text,uuid,integer,uuid,jsonb)','erp_catalog_taxonomy_delete(uuid,text,uuid,integer,uuid)',
  'erp_catalog_invoice_tags(uuid,text,text,text[])','erp_catalog_invoice_tags_save(uuid,text,text,text,integer,uuid,jsonb,text)',
  'erp_catalog_invoice_list_tagged(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid,text)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
