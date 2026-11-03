-- Mão dupla (009-015): documento convertido do Origin que já tem nota fiscal gerada ou contas lançadas no Origin fica
-- travado como no Origin ("Não é possível alterar o pedido, pois já foram realizadas as seguintes ações: Lançamento de
-- Contas, Nota Fiscal gerada"). Só Observações, Observações internas e a situação mudam; o aplicador continua aplicando
-- o que vem do Origin. Os efeitos são lidos da área bruta do coletor (pedido.notaFiscal.id e contas com origem no pedido
-- ou na nota do pedido) e aparecem em effect_flags como origin_finance e origin_invoice.
begin;

create index if not exists raw_record_origin_id on origin_sync.raw_record((payload#>>'{origem,id}'))
 where entity in('receivables','payables');

create function erp_sync.origin_effects(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare d erp_documents.document; v_origin text; v_payload jsonb; v_nf text;
begin
 select * into d from erp_documents.document where id=p_id;
 if not found or d.origin<>'origin' or d.kind not in('sales_orders','service_orders','purchase_orders') then
  return jsonb_build_object('finance',false,'invoice',false); end if;
 select origin_id into v_origin from erp_sync.link where entity=d.kind and record_id=p_id;
 if v_origin is null then return jsonb_build_object('finance',false,'invoice',false); end if;
 select payload into v_payload from origin_sync.raw_record where entity=d.kind and source_id=v_origin;
 v_nf:=nullif(nullif(v_payload#>>'{notaFiscal,id}','0'),'');
 return jsonb_build_object('invoice',v_nf is not null,
  'finance',exists(select 1 from origin_sync.raw_record r where r.entity in('receivables','payables')
   and (((r.payload#>>'{origem,id}')=v_origin and r.payload#>>'{origem,tipoOrigem}' in('venda','pedido','ordemservico','compra'))
     or (v_nf is not null and (r.payload#>>'{origem,id}')=v_nf and r.payload#>>'{origem,tipoOrigem}'='notafiscal'))));
end$$;
revoke all on function erp_sync.origin_effects(uuid) from public,anon,authenticated,service_role;

create or replace function erp_documents.effect_flags(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('finance_active',exists(select 1 from erp_finance.document_posting p where p.document_id=p_id and p.state='active'),
  'stock_active',exists(select 1 from erp_stock.document_posting p where p.document_id=p_id and p.state='active')or erp_purchase_receipts.active(p_id),
  'origin_finance',(e->>'finance')::boolean,'origin_invoice',(e->>'invoice')::boolean)
 from erp_sync.origin_effects(p_id) e
$$;

create function erp_sync.origin_locked(p_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select not erp_sync.applying() and not coalesce(erp_document_mirror.writing(),false)
  and exists(select 1 from erp_documents.document d where d.id=p_id and d.origin='origin' and d.authority='brufap')
  and (select (e->>'finance')::boolean or (e->>'invoice')::boolean from erp_sync.origin_effects(p_id) e)
$$;
revoke all on function erp_sync.origin_locked(uuid) from public,anon,authenticated,service_role;

-- Documento: só observações, situação e os campos de controle mudam; excluir também é bloqueado.
create function erp_sync.guard_origin_effects_document() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_ignore text[]:=array['status','version','updated_at','updated_by'];
begin
 if not erp_sync.origin_locked(old.id) then return case when tg_op='DELETE' then old else new end; end if;
 if tg_op='DELETE' or (to_jsonb(old)-v_ignore-'body')<>(to_jsonb(new)-v_ignore-'body')
  or (old.body-'notes'-'internal_notes')<>(new.body-'notes'-'internal_notes') then
  raise exception 'erp_document_origin_effects' using errcode='40001';
 end if;
 return new;
end$$;
create trigger ab_origin_effects before update or delete on erp_documents.document
 for each row execute function erp_sync.guard_origin_effects_document();

-- Itens: só a regravação idêntica passa (a mesma regra dos lançamentos nativos).
create function erp_sync.guard_origin_effects_item() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if erp_sync.origin_locked(case when tg_op='INSERT' then new.document_id else old.document_id end)
  and not erp_stock.effect_item_allowed(tg_op,old,new) then
  raise exception 'erp_document_origin_effects' using errcode='40001';
 end if;
 return case when tg_op='DELETE' then old else new end;
end$$;
create trigger ab_origin_effects before insert or update or delete on erp_documents.item
 for each row execute function erp_sync.guard_origin_effects_item();

revoke all on function erp_sync.guard_origin_effects_document(),erp_sync.guard_origin_effects_item() from public,anon,authenticated,service_role;

commit;
