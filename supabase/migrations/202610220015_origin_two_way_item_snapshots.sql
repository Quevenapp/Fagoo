-- Mão dupla (009-014): itens de documentos convertidos sem o retrato do produto.
-- O aplicador mantém os IDs dos itens do espelho (006) pela posição, e erp_documents.replace_items reaproveita o retrato
-- do item antigo quando o produto é o mesmo. Os itens do espelho guardavam o retrato como JSON null, então o documento
-- convertido ficava com produto e sem retrato, e a API recusava a leitura (ERP_UPSTREAM_INVALID_RESPONSE): nenhum
-- documento convertido abria. O aplicador passa a completar o retrato que faltar, e os itens já gravados são corrigidos.
begin;

create function erp_sync.fill_item_snapshots(p_document uuid) returns integer
language plpgsql security definer set search_path=pg_catalog as $$
declare n integer;
begin
 update erp_documents.item i set product_snapshot=erp_catalog.dto(i.product_id)
 where i.document_id=p_document and i.product_id is not null and (i.product_snapshot is null or i.product_snapshot='null'::jsonb)
  and exists(select 1 from erp_catalog.product p where p.record_id=i.product_id);
 get diagnostics n=row_count;
 return n;
end$$;
revoke all on function erp_sync.fill_item_snapshots(uuid) from public,anon,authenticated,service_role;

do $$declare v_def text; v_new text;
begin
 v_def:=replace(pg_get_functiondef('erp_sync.pull_document(origin_sync.raw_record)'::regprocedure),E'\r','');
 v_new:=replace(v_def,' perform erp_documents.replace_items(v_id,v_items);',
  E' perform erp_documents.replace_items(v_id,v_items);\n perform erp_sync.fill_item_snapshots(v_id);');
 if v_new=v_def then raise exception 'origin_two_way_015_pull_document_changed'; end if;
 execute v_new;
end$$;

-- Correção dos itens já gravados, como o aplicador (nada volta para o Origin). Documentos na lixeira ficam como estão.
select erp_sync.set_applying(true);
update erp_documents.item i set product_snapshot=erp_catalog.dto(i.product_id)
from erp_documents.document d
where d.id=i.document_id and d.deleted_at is null and d.authority='brufap'
 and i.product_id is not null and (i.product_snapshot is null or i.product_snapshot='null'::jsonb)
 and exists(select 1 from erp_catalog.product p where p.record_id=i.product_id);
select erp_sync.set_applying(false);

commit;
