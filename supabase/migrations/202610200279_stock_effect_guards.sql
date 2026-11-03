-- 279: Travas do estoque nos documentos, no padrão do Origin (onda F do estoque). Requer 017, 018, 070, 090 e 245.
-- - Pedido de compra com o estoque lançado (lançamento inteiro, 018, ou recebimentos ativos, 090): como no Origin, ficam somente leitura
--   os itens, o fornecedor (com o retrato do contato) e o depósito; os demais campos (datas, observações, transporte, ordem de compra,
--   condição e parcelas planejadas, frete e descontos) podem ser gravados. O número também não muda. Sem contas lançadas: a trava do
--   financeiro (frente financeira) continua valendo quando houver contas.
-- - Pedido de venda e OS com estoque lançado ou reserva ativa (070): só "Observações" e "Observações internas" podem ser gravadas
--   ("Bloqueio total após lançar estoque ou contas pelo pedido (só observações continuam editáveis)").
-- - Itens: a gravação do documento reenvia os itens; um item reenviado sem nenhuma mudança passa pela trava (a regravação idêntica
--   não muda o estoque); incluir, excluir ou mudar um item continua recusado.
-- - Lançar estoque (e reservar) no pedido de venda "Em aberto", como no Origin; com o estoque lançado, "Em aberto" segue para
--   Verificado, Em andamento ou Atendido sem estornar.
-- Funções substituídas (o corpo publicado é conferido pelo hash, sem CR; outra versão interrompe a migração). Nenhum documento,
-- movimento ou saldo é reescrito.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_documents.effects_transition_allowed(text,text,text)') is null or to_regclass('erp_purchase_receipts.receipt') is null
  or to_regclass('erp_stock.reservation') is null then
  raise exception 'stock_effect_guards_279_requires_017_070_090' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.document_eligible(text,text)','00c8c223e3efd538a828022bf811a3a49a028b8ce8cafdf7320f8f591177ba45'),
  ('erp_stock.guard_posted_document()','8b442e4a5bc747b5f712516b6b9c7669db119b7f90ddbc4137778abf57fc0994'),
  ('erp_stock.guard_posted_item()','e8ba342a0ee1155eaf05047780314487562d62a19fb9e3fd663342b9f065a6a4'),
  ('erp_stock.guard_reserved_document()','1dc81690fe13ce3b41e578111567f59e848e0c48513aa730f4a60f589197b1cb'),
  ('erp_stock.guard_reserved_item()','7d0b124ec2b57cbb7f9ec9f256b29566cb04769e0a88c16a038d109033e9994a'),
  ('erp_purchase_receipts.guard_document()','f348ac05b9810abb72bf322f78a3c095deadd0dae25e6b674af606ee82454af7'),
  ('erp_purchase_receipts.guard_item()','788f18695db8e2d9c44f1c4d8be12a2fa9053334309fd889fede31a634de04e7'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_effect_guards_279_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regprocedure('erp_stock.effect_edit_allowed(erp_documents.document,erp_documents.document)') is not null then
  raise exception 'stock_effect_guards_279_already_applied' using errcode='55000';end if;
end$$;

-- 1. Lançar estoque no pedido de venda Em aberto (Origin: "Lançar estoque" e "Lançar contas" no pedido Em aberto).
create or replace function erp_stock.document_eligible(p_kind text,p_status text)
returns boolean language sql immutable set search_path=pg_catalog as $$ select coalesce(case p_kind
 when 'sales_orders' then p_status in('open','verified','in_progress','partially_fulfilled','fulfilled')
 when 'purchase_orders' then p_status in('in_progress','partially_fulfilled','fulfilled')
 when 'service_orders' then p_status in('approved','in_progress','waiting_parts','service_done','finalized') else false end,false) $$;

-- 2. With active stock, reservation or receipt: the transitions of 017/245, plus Em aberto forward (it now posts stock).
create function erp_stock.effect_transition_allowed(p_kind text,p_from text,p_to text)returns boolean language sql immutable set search_path=pg_catalog as $$
 select erp_documents.effects_transition_allowed(p_kind,p_from,p_to) or coalesce(p_kind='sales_orders' and p_from='open' and p_to in('verified','in_progress','fulfilled'),false)
$$;
-- What a save may change with active stock (no change of status here): pedido de compra, everything but the fornecedor, its retrato,
-- the depósito and the number; pedido de venda and OS, only Observações and Observações internas.
create function erp_stock.effect_edit_allowed(o erp_documents.document,n erp_documents.document)returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce((to_jsonb(n)-array['status','version','updated_at','updated_by','body','total'])=(to_jsonb(o)-array['status','version','updated_at','updated_by','body','total'])
  and case when o.kind='purchase_orders' then(n.body->'contact_id') is not distinct from(o.body->'contact_id') and(n.body->'warehouse_id') is not distinct from(o.body->'warehouse_id')
   else n.total=o.total and(n.body-array['notes','internal_notes'])=(o.body-array['notes','internal_notes']) end,false)
$$;
-- The document row under an active effect: a transition the effect allows, or a save of the fields above (never a deletion).
create function erp_stock.effect_document_allowed(o erp_documents.document,n erp_documents.document)returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(case when o.status<>n.status then erp_stock.effect_transition_allowed(o.kind,o.status,n.status)
   and(to_jsonb(n)-array['status','version','updated_at','updated_by'])=(to_jsonb(o)-array['status','version','updated_at','updated_by'])
  else erp_stock.effect_edit_allowed(o,n) end,false)
$$;
-- An item under an active effect: only its identical rewrite by the save (insert of an existing item, then the same values).
create function erp_stock.effect_item_allowed(p_op text,o erp_documents.item,n erp_documents.item)returns boolean language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_op='INSERT' then return exists(select 1 from erp_documents.item i where i.id=n.id and i.document_id=n.document_id);end if;
 if p_op='UPDATE' then return to_jsonb(n)=to_jsonb(o);end if;
 return false;
end$$;

-- 3. The guards of 018 (estoque lançado), 070 (reserva) and 090 (recebimento) with these rules.
create or replace function erp_stock.guard_posted_document()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ begin
 if exists(select 1 from erp_stock.document_posting where document_id=old.id and state='active') then
  if tg_op='DELETE' then raise exception 'erp_document_active_stock' using errcode='40001';end if;
  -- 279: a pedido de compra keeps everything but the items, the fornecedor and the depósito editable; venda and OS, the observações.
  if not erp_stock.effect_document_allowed(old,new) then raise exception 'erp_document_active_stock' using errcode='40001';end if;
 end if;if tg_op='DELETE' then return old;end if;return new;
end $$;
create or replace function erp_stock.guard_posted_item()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ declare d uuid;begin
 d:=case when tg_op='INSERT' then new.document_id else old.document_id end;
 if exists(select 1 from erp_stock.document_posting where state='active' and(document_id=d or(tg_op='UPDATE' and document_id=new.document_id)))
  -- 279: the identical rewrite of an item by the save passes.
  and not erp_stock.effect_item_allowed(tg_op,old,new) then
  raise exception 'erp_document_active_stock' using errcode='40001';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create or replace function erp_stock.guard_reserved_document() returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if exists(select 1 from erp_stock.reservation where document_id=old.id and state='active') then
  if tg_op='DELETE' then raise exception 'erp_document_active_reservation' using errcode='40001';end if;
  if not erp_stock.effect_document_allowed(old,new) then raise exception 'erp_document_active_reservation' using errcode='40001';end if;
 end if;if tg_op='DELETE' then return old;end if;return new;
end $$;
create or replace function erp_stock.guard_reserved_item() returns trigger language plpgsql security definer set search_path=pg_catalog as $$declare d uuid;begin
 d:=case when tg_op='INSERT' then new.document_id else old.document_id end;
 if exists(select 1 from erp_stock.reservation where state='active' and(document_id=d or(tg_op='UPDATE' and document_id=new.document_id)))
  and not erp_stock.effect_item_allowed(tg_op,old,new) then
  raise exception 'erp_document_active_reservation' using errcode='40001';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create or replace function erp_purchase_receipts.guard_document() returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if erp_purchase_receipts.active(old.id)then
  if tg_op='DELETE' or not erp_stock.effect_document_allowed(old,new) then raise exception 'purchase_receipt_active'using errcode='40001';end if;
 end if;if tg_op='DELETE'then return old;end if;return new;
end$$;
create or replace function erp_purchase_receipts.guard_item() returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if((tg_op<>'INSERT'and erp_purchase_receipts.active(old.document_id))or(tg_op<>'DELETE'and erp_purchase_receipts.active(new.document_id)))
  and not erp_stock.effect_item_allowed(tg_op,old,new) then
  raise exception 'purchase_receipt_active'using errcode='40001';end if;if tg_op='DELETE'then return old;end if;return new;
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_purchase_receipts from public,anon,authenticated,service_role;
commit;
