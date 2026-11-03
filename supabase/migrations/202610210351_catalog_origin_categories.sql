-- 351 (leva H, lane espelho, PRD-138): categorias de produtos do Origin com hierarquia estável.
-- O coletor já guarda /categorias/produtos em origin_sync.raw_record (entity product_categories: id, descricao, categoriaPai.id).
-- "Sincronizar categorias do Origin" (administrador) leva essas categorias para as Categorias de produtos do Brufap
-- (erp_catalog.taxonomy kind categories) pelo id externo, guardado em erp_catalog.taxonomy_source:
-- * renomear no Origin renomeia a mesma categoria; trocar a categoria superior move a mesma categoria (sem ciclos);
-- * uma categoria local com o mesmo nome no mesmo nível é adotada, sem duplicar a árvore; repetir a sincronização não muda nada;
-- * a inativação só vale com evidência do Origin (situação I/E ou exclusão confirmada pelo coletor): a categoria fica marcada
--   "Inativa no Origin" e continua nos produtos (a lista do Origin sem uma categoria não é prova de exclusão);
-- * uma categoria do Origin excluída no Brufap não volta sozinha: o vínculo fica sem categoria e a sincronização a ignora.
-- Os eventos podem chegar repetidos ou fora de ordem: a sincronização sempre lê o estado atual do espelho. Nada é escrito no Origin.
begin;

create table erp_catalog.taxonomy_source(
 kind text not null default 'categories' check(kind='categories'),
 system text not null default 'origin' check(system='origin'),
 source_id text not null check(source_id~'^[1-9][0-9]{0,39}$'),
 taxonomy_id uuid,
 source_parent_id text,
 source_hash text not null check(source_hash~'^[0-9a-f]{64}$'),
 source_name text not null check(length(source_name) between 1 and 200),
 inactive boolean not null default false,
 issue text check(issue in('parent_missing','cycle','name_conflict','name_invalid','limit')),
 synced_at timestamptz not null default clock_timestamp(),
 primary key(kind,system,source_id),
 unique(taxonomy_id),
 foreign key(taxonomy_id,kind) references erp_catalog.taxonomy(id,kind) on delete set null (taxonomy_id)
);
comment on table erp_catalog.taxonomy_source is 'Vínculo estável entre a categoria do Origin (id externo) e a categoria do Brufap (leva H, 351). taxonomy_id nulo: excluída no Brufap, a sincronização não a recria.';
alter table erp_catalog.taxonomy_source enable row level security;
revoke all on erp_catalog.taxonomy_source from public,anon,authenticated,service_role;

create function erp_catalog.origin_category_parent(p_payload jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when erp_catalog.origin_text(p_payload#>'{categoriaPai,id}',40)~'^[1-9][0-9]{0,39}$' then erp_catalog.origin_text(p_payload#>'{categoriaPai,id}',40) end
$$;
create function erp_catalog.origin_category_inactive(p_payload jsonb) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select coalesce(erp_catalog.origin_text(p_payload->'situacao',2) in('I','E','0'),false) or coalesce(p_payload#>'{_brufap_source,deleted}'='true'::jsonb,false)
$$;

-- One category of the Origin (its parent already resolved to a Brufap category or null). Returns the action taken.
create function erp_catalog.origin_category_apply(p_user_id uuid,p_command_id uuid,p_raw origin_sync.raw_record,p_parent uuid,p_issue text)
returns text language plpgsql set search_path=pg_catalog as $$
declare v_link erp_catalog.taxonomy_source%rowtype; v_row erp_catalog.taxonomy%rowtype; v_name text; v_id uuid; v_issue text:=p_issue;
 v_action text:='unchanged'; v_before jsonb; v_parent uuid:=p_parent; v_inactive boolean:=erp_catalog.origin_category_inactive(p_raw.payload);
begin
 v_name:=left(btrim(coalesce(erp_catalog.origin_text(p_raw.payload->'descricao',200),'')),100);
 select * into v_link from erp_catalog.taxonomy_source where kind='categories' and system='origin' and source_id=p_raw.source_id for update;
 if found and v_link.taxonomy_id is null then return 'removed_locally'; end if;
 if v_name='' or v_name~'[[:cntrl:]]' then
  if v_link.source_id is not null then
   update erp_catalog.taxonomy_source set source_hash=p_raw.version_hash,issue='name_invalid',inactive=v_inactive,synced_at=clock_timestamp() where kind='categories' and system='origin' and source_id=p_raw.source_id;
  end if;
  return 'invalid';
 end if;
 if v_link.taxonomy_id is not null then
  select * into v_row from erp_catalog.taxonomy where id=v_link.taxonomy_id and kind='categories' for update;
  -- A new parent under its own subtree would close a cycle: keep the current parent.
  if v_parent is not null and (v_parent=v_row.id or exists(with recursive up(id,parent_id) as(
     select t.id,t.parent_id from erp_catalog.taxonomy t where t.id=v_parent
     union select t.id,t.parent_id from erp_catalog.taxonomy t join up on t.id=up.parent_id) select 1 from up where up.id=v_row.id)) then
   v_parent:=v_row.parent_id; v_issue:='cycle';
  end if;
  if v_row.name is distinct from v_name or v_row.parent_id is distinct from v_parent then
   if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
   if exists(select 1 from erp_catalog.taxonomy t where t.kind='categories' and t.id<>v_row.id and t.parent_id is not distinct from v_parent and erp_catalog.fold(t.name)=erp_catalog.fold(v_name)) then
    v_issue:='name_conflict';
   else
    v_before:=erp_catalog.taxonomy_item(v_row.id);
    update erp_catalog.taxonomy set name=v_name,parent_id=v_parent,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_row.id;
    insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data)
     values(p_user_id,p_command_id,'categories',v_row.id,'update',v_before,erp_catalog.taxonomy_item(v_row.id)||'{"source":"origin"}'::jsonb);
    v_action:='updated';
   end if;
  end if;
  v_id:=v_row.id;
 else
  -- Adopt a local category with the same name at the same level (not linked to another Origin category).
  select t.id into v_id from erp_catalog.taxonomy t where t.kind='categories' and t.parent_id is not distinct from v_parent and erp_catalog.fold(t.name)=erp_catalog.fold(v_name)
   and not exists(select 1 from erp_catalog.taxonomy_source s where s.taxonomy_id=t.id) for update;
  if v_id is not null then v_action:='adopted';
  elsif (select count(*) from erp_catalog.taxonomy where kind='categories')>=2000 then return 'limit';
  elsif exists(select 1 from erp_catalog.taxonomy t where t.kind='categories' and t.parent_id is not distinct from v_parent and erp_catalog.fold(t.name)=erp_catalog.fold(v_name)) then
   return 'name_conflict';
  else
   insert into erp_catalog.taxonomy(kind,parent_id,name,created_by,updated_by) values('categories',v_parent,v_name,p_user_id,p_user_id) returning id into v_id;
   insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data)
    values(p_user_id,p_command_id,'categories',v_id,'create',null,erp_catalog.taxonomy_item(v_id)||'{"source":"origin"}'::jsonb);
   v_action:='created';
  end if;
 end if;
 insert into erp_catalog.taxonomy_source(kind,system,source_id,taxonomy_id,source_parent_id,source_hash,source_name,inactive,issue,synced_at)
 values('categories','origin',p_raw.source_id,v_id,erp_catalog.origin_category_parent(p_raw.payload),p_raw.version_hash,v_name,v_inactive,v_issue,clock_timestamp())
 on conflict(kind,system,source_id) do update set taxonomy_id=excluded.taxonomy_id,source_parent_id=excluded.source_parent_id,source_name=excluded.source_name,
  inactive=excluded.inactive,issue=excluded.issue,
  synced_at=case when taxonomy_source.source_hash=excluded.source_hash and v_action='unchanged' then taxonomy_source.synced_at else excluded.synced_at end,
  source_hash=excluded.source_hash;
 if v_action='unchanged' and (v_link.source_hash is distinct from p_raw.version_hash or v_link.inactive is distinct from v_inactive or v_link.issue is distinct from v_issue) then v_action:='refreshed'; end if;
 return v_action;
end $$;

create function public.erp_catalog_origin_categories_sync(p_user_id uuid,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_pending text[]; v_next text[]; v_src text; v_parent_src text; v_raw origin_sync.raw_record%rowtype;
 v_parent uuid; v_action text; v_counts jsonb:='{}'; v_issues jsonb:='[]'; v_progress boolean; v_result jsonb; v_issue text;
begin
 perform erp_catalog.require_import_admin(p_user_id,'products');
 if p_command_id is null then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','origin_categories_sync')::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 -- One synchronization at a time; the categories of the Brufap serialize on their rows.
 perform pg_advisory_xact_lock(174852908,hashtext('origin_categories'));
 select coalesce(array_agg(source_id order by source_id collate "C"),'{}') into v_pending from origin_sync.raw_record
  where entity='product_categories' and source_id~'^[1-9][0-9]{0,39}$';
 -- Parents first: a category is applied once its parent (if any, in the mirror) is linked.
 loop
  v_progress:=false; v_next:='{}';
  foreach v_src in array v_pending loop
   select * into v_raw from origin_sync.raw_record where entity='product_categories' and source_id=v_src;
   v_parent_src:=erp_catalog.origin_category_parent(v_raw.payload);
   if v_parent_src is null or v_parent_src=v_src or not v_parent_src=any(v_pending) then
    v_issue:=null; v_parent:=null;
    if v_parent_src is not null and v_parent_src<>v_src then
     select taxonomy_id into v_parent from erp_catalog.taxonomy_source where kind='categories' and system='origin' and source_id=v_parent_src;
     if v_parent is null then v_issue:='parent_missing'; end if;
    end if;
    v_action:=erp_catalog.origin_category_apply(p_user_id,p_command_id,v_raw,v_parent,v_issue);
    v_counts:=jsonb_set(v_counts,array[v_action],to_jsonb(coalesce((v_counts->>v_action)::integer,0)+1));
    if v_action in('invalid','limit','name_conflict') or v_issue is not null then v_issues:=v_issues||jsonb_build_array(jsonb_build_object('source_id',v_src,'issue',coalesce(case v_action when 'invalid' then 'name_invalid' when 'limit' then 'limit' when 'name_conflict' then 'name_conflict' end,v_issue))); end if;
    v_progress:=true;
   else v_next:=v_next||v_src; end if;
  end loop;
  v_pending:=v_next;
  exit when not v_progress or cardinality(v_pending)=0;
 end loop;
 -- What remains is a cycle in the Origin itself: applied without a new parent and flagged.
 foreach v_src in array v_pending loop
  select * into v_raw from origin_sync.raw_record where entity='product_categories' and source_id=v_src;
  select t.parent_id into v_parent from erp_catalog.taxonomy_source s join erp_catalog.taxonomy t on t.id=s.taxonomy_id where s.kind='categories' and s.system='origin' and s.source_id=v_src;
  v_action:=erp_catalog.origin_category_apply(p_user_id,p_command_id,v_raw,v_parent,'cycle');
  v_counts:=jsonb_set(v_counts,array[v_action],to_jsonb(coalesce((v_counts->>v_action)::integer,0)+1));
  v_issues:=v_issues||jsonb_build_array(jsonb_build_object('source_id',v_src,'issue','cycle'));
 end loop;
 v_result:=jsonb_build_object('scope','origin_categories_sync','counts',v_counts,'issues',v_issues,
  'total',(select count(*)::integer from origin_sync.raw_record where entity='product_categories'),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Categorias do Origin e seus vínculos (leitura de quem lê produtos): a origem, a data da sincronização e o que falta sincronizar.
create function public.erp_catalog_origin_categories(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 return jsonb_build_object('scope','origin_categories','data_mode','erp_native','system','origin',
  'source_count',(select count(*)::integer from origin_sync.raw_record where entity='product_categories'),
  'source_seen_at',(select max(last_seen_at) from origin_sync.raw_record where entity='product_categories'),
  'pending',(select count(*)::integer from origin_sync.raw_record r where r.entity='product_categories'
    and not exists(select 1 from erp_catalog.taxonomy_source s where s.kind='categories' and s.system='origin' and s.source_id=r.source_id and s.source_hash=r.version_hash)),
  'items',coalesce((select jsonb_agg(jsonb_build_object('source_id',s.source_id,'taxonomy_id',s.taxonomy_id,'name',t.name,'source_name',s.source_name,
    'source_parent_id',s.source_parent_id,'parent_id',t.parent_id,'inactive',s.inactive,'issue',s.issue,'synced_at',s.synced_at,'removed_locally',s.taxonomy_id is null)
    order by s.source_id collate "C") from erp_catalog.taxonomy_source s left join erp_catalog.taxonomy t on t.id=s.taxonomy_id
   where s.kind='categories' and s.system='origin'),'[]'::jsonb));
end $$;

revoke all on function erp_catalog.origin_category_parent(jsonb),erp_catalog.origin_category_inactive(jsonb),
 erp_catalog.origin_category_apply(uuid,uuid,origin_sync.raw_record,uuid,text) from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_origin_categories_sync(uuid,uuid)','erp_catalog_origin_categories(uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
