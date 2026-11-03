-- 352 (leva H, lane espelho, PRD-006): situação Excluído do Origin e sua restauração nos produtos.
-- O coletor já lê os produtos excluídos do Origin (criterio 4, situacao E). Até aqui a importação só guardava o "excluído na
-- origem" como pendência (origin.state source_deleted) sem caminho para aplicá-lo. Agora:
-- * "Exclusões do Origin" lista os produtos excluídos no Origin que ainda estão no Brufap e os produtos que o Brufap excluiu por
--   causa do Origin e que o Origin restaurou;
-- * o administrador aplica: Excluir leva o produto para Excluídos (a mesma exclusão lógica de erp_catalog_product_set_deleted,
--   com versão, comando e auditoria) e aceita a pendência da origem; Restaurar devolve o produto como ativo;
-- * o id externo e os vínculos históricos (documentos, estoque, notas) ficam como estão; nada é apagado;
-- * a sincronização não recria nem restaura um produto excluído sozinha: a origem já existe (nunca é "criar"), o produto excluído
--   é somente leitura (guard_deleted_product) e só volta por Restaurar. Restaurado, um produto que não tinha edição local volta a
--   receber o Origin.
-- Eventos repetidos ou fora de ordem: a lista lê sempre o estado atual do espelho e a aplicação confere esse estado de novo.
begin;

create table erp_catalog.product_source_deletion(
 record_id uuid primary key,entity text not null default 'products' check(entity='products'),
 source_id text not null,source_hash text not null check(source_hash~'^[0-9a-f]{64}$'),
 human_edited_before boolean not null,
 applied_by uuid not null references auth.users(id),applied_at timestamptz not null default clock_timestamp(),
 restored_by uuid references auth.users(id),restored_at timestamptz,
 foreign key(record_id,entity) references erp_catalog.record(id,entity)
);
comment on table erp_catalog.product_source_deletion is 'Produtos levados para Excluídos porque o Origin os excluiu (leva H, 352), com a restauração.';
alter table erp_catalog.product_source_deletion enable row level security;
revoke all on erp_catalog.product_source_deletion from public,anon,authenticated,service_role;

-- Situação atual do produto no espelho do Origin: A, I, E (inclusive excluído confirmado pelo coletor sem detalhe) ou null.
create function erp_catalog.origin_product_status(p_payload jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when p_payload#>'{_brufap_source,deleted}'='true'::jsonb then 'E'
  when erp_catalog.origin_text(p_payload->'situacao',2) in('A','I','E') then erp_catalog.origin_text(p_payload->'situacao',2) end
$$;

create function erp_catalog.origin_deletion_rows() returns table(id uuid,version integer,name text,code text,source_id text,source_hash text,source_status text,action text,deleted_at timestamptz)
language sql stable set search_path=pg_catalog as $$
 select r.id,r.version,r.name,r.code,o.source_id,x.version_hash,erp_catalog.origin_product_status(x.payload),
  case when d.deleted_at is null then 'delete' else 'restore' end,d.deleted_at
 from erp_catalog.origin o join erp_catalog.record r on r.id=o.record_id
 join origin_sync.raw_record x on x.entity='products' and x.source_id=o.source_id
 left join erp_catalog.product_detail d on d.record_id=r.id
 left join erp_catalog.product_source_deletion s on s.record_id=r.id and s.restored_at is null
 where o.entity='products' and (
  (d.deleted_at is null and erp_catalog.origin_product_status(x.payload)='E')
  or (d.deleted_at is not null and s.record_id is not null and erp_catalog.origin_product_status(x.payload) in('A','I')))
$$;

create function public.erp_catalog_origin_deletions(p_user_id uuid,p_limit integer default 50,p_after uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_more boolean;
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 with page as materialized(select * from erp_catalog.origin_deletion_rows() x where p_after is null or x.id>p_after order by x.id limit p_limit+1)
 select coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'version',p.version,'name',p.name,'code',p.code,'source_id',p.source_id,'source_status',p.source_status,
   'action',p.action,'deleted_at',p.deleted_at) order by p.id) from (select * from page order by id limit p_limit) p),'[]'::jsonb),(select count(*)>p_limit from page)
 into v_items,v_more;
 return jsonb_build_object('scope','origin_deletions','data_mode','erp_native','system','origin','limit',p_limit,'has_more',v_more,
  'writable',erp_catalog.require_access(p_user_id,'products',false)='admin','items',v_items,
  'source_seen_at',(select max(last_seen_at) from origin_sync.raw_record where entity='products'));
end $$;

-- Aplica a exclusão (delete) ou a restauração (restore) que o Origin indica, somente se o espelho ainda indica isso.
create function public.erp_catalog_origin_deletion_apply(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_action text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row record; v_inner uuid; v_record erp_catalog.record%rowtype; v_was boolean; v_result jsonb; v_origin erp_catalog.origin%rowtype;
begin
 perform erp_catalog.require_import_admin(p_user_id,'products');
 if p_id is null or p_command_id is null or p_action is null or p_action not in('delete','restore') or p_expected_version is null or p_expected_version not between 1 and 2147483646 then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','origin_deletion_apply','id',p_id,'version',p_expected_version,'apply',p_action)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 -- Same order as the canonical import (011/013): the entity, then the record, then the mirror row.
 perform pg_advisory_xact_lock(174852907,hashtext('products'));
 select * into v_record from erp_catalog.record where id=p_id and entity='products' for update;
 if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 select * into v_row from erp_catalog.origin_deletion_rows() x where x.id=p_id;
 if v_row.id is null or v_row.action<>p_action then raise exception 'erp_catalog_origin_deletion_state' using errcode='40001'; end if;
 if v_record.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 perform 1 from origin_sync.raw_record where entity='products' and source_id=v_row.source_id and version_hash=v_row.source_hash for share;
 v_inner:=md5(p_command_id::text||':origin_deletion_apply')::uuid;
 if p_action='delete' then
  v_was:=v_record.human_edited;
  perform public.erp_catalog_product_set_deleted(p_user_id,p_id,p_expected_version,v_inner,true);
  insert into erp_catalog.product_source_deletion(record_id,source_id,source_hash,human_edited_before,applied_by)
   values(p_id,v_row.source_id,v_row.source_hash,v_was,p_user_id)
  on conflict(record_id) do update set source_id=excluded.source_id,source_hash=excluded.source_hash,human_edited_before=excluded.human_edited_before,
   applied_by=excluded.applied_by,applied_at=clock_timestamp(),restored_by=null,restored_at=null;
  -- The pending "excluído na origem" is now applied: the deleted snapshot becomes the applied one (the mirror follows it).
  select * into v_origin from erp_catalog.origin where entity='products' and record_id=p_id for update;
  if v_origin.state='source_deleted' and v_origin.latest_hash=v_row.source_hash then
   update erp_catalog.origin set applied_hash=latest_hash,candidate=null where entity='products' and record_id=p_id;
  end if;
 else
  select human_edited_before into v_was from erp_catalog.product_source_deletion where record_id=p_id for update;
  perform public.erp_catalog_product_set_deleted(p_user_id,p_id,p_expected_version,v_inner,false);
  update erp_catalog.product_source_deletion set restored_by=p_user_id,restored_at=clock_timestamp() where record_id=p_id;
  -- Without a local edit before the deletion, the product follows the Origin again (the next import applies the restored data).
  if not v_was then
   update erp_catalog.record set human_edited=false,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
  end if;
 end if;
 insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
  values(p_user_id,p_command_id,'products',p_id,'origin_'||p_action,jsonb_build_object('source_id',v_row.source_id,'source_status',v_row.source_status),
   jsonb_build_object('source_hash',v_row.source_hash));
 v_result:=jsonb_build_object('scope','origin_deletion_apply','id',p_id,'action',p_action,
  'version',(select version from erp_catalog.record where id=p_id),
  'deleted',exists(select 1 from erp_catalog.product_detail d where d.record_id=p_id and d.deleted_at is not null),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on function erp_catalog.origin_product_status(jsonb),erp_catalog.origin_deletion_rows() from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_origin_deletions(uuid,integer,uuid)','erp_catalog_origin_deletion_apply(uuid,uuid,integer,uuid,text)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
