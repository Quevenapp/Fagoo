-- 303: Contas lançadas e Faturamento agrupado deixam salvar Observações e Observações internas (Origin: o pedido com contas
-- lançadas continua com as observações editáveis; contrato da onda G com a frente de documentos, erp_document_notes_save).
-- * Com contas lançadas (017) ou num Faturamento agrupado ativo (174), o documento continua travado como antes, exceto por uma
--   gravação que muda só Observações (body.notes) e Observações internas (body.internal_notes), sem trocar a situação: o resto do
--   documento (contato, retrato, depósito, número, total, itens, parcelas e demais campos do corpo) tem de ficar igual.
-- * Os itens continuam travados; só a regravação idêntica de um item que já existe passa (a mesma regra das travas de estoque da
--   279), para que a gravação das observações nunca esbarre nos itens que ela não muda.
-- * As transições permitidas com contas (017 e a 248) não mudam. Nenhum título, parcela ou lançamento é tocado.
-- Substitui erp_finance.guard_posted_document (248) e erp_finance.guard_posted_item (174), conferidas pelo hash; outra versão
-- interrompe a migração. As funções novas são aditivas.
begin;

do $$declare r record;begin
 if to_regclass('erp_finance.document_posting') is null or to_regclass('erp_finance.grouped_billing_document') is null
  or to_regprocedure('erp_documents.effects_transition_allowed(text,text,text)') is null then
  raise exception 'finance_notes_guard_303_requires_017_174' using errcode='55000';end if;
 for r in select * from(values
  ('erp_finance.guard_posted_document()','8514a345d1565a39b0dafd7800d3eb93b32dc04aad0a12d84eb734bff15ab15a'),
  ('erp_finance.guard_posted_item()','cf476a64e2925508147772ab90ae2c1758f97d1f8ca79c926845b20c8c50b230'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'finance_notes_guard_303_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regprocedure('erp_finance.notes_edit_allowed(erp_documents.document,erp_documents.document)') is not null then
  raise exception 'finance_notes_guard_303_already_applied' using errcode='55000';end if;
end$$;

-- A save that changes only Observações and Observações internas of the document row (the situação stays).
create function erp_finance.notes_edit_allowed(o erp_documents.document,n erp_documents.document) returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(o.status=n.status
  and(to_jsonb(n)-array['version','updated_at','updated_by','body'])=(to_jsonb(o)-array['version','updated_at','updated_by','body'])
  and(n.body-array['notes','internal_notes'])=(o.body-array['notes','internal_notes']),false)
$$;
-- An item under contas lançadas: only the identical rewrite of an existing item (insert of an item that exists, then the same values).
create function erp_finance.notes_item_allowed(p_op text,o erp_documents.item,n erp_documents.item) returns boolean language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_op='INSERT' then return exists(select 1 from erp_documents.item i where i.id=n.id and i.document_id=n.document_id);end if;
 if p_op='UPDATE' then return to_jsonb(n)=to_jsonb(o);end if;
 return false;
end$$;

create or replace function erp_finance.guard_posted_document()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ begin
 -- 174: a pedido in an active Faturamento agrupado is locked like a pedido with contas lançadas.
 if exists(select 1 from erp_finance.document_posting where document_id=old.id and state='active') or exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=old.id and g.active) then
  if tg_op='DELETE' then raise exception 'erp_document_active_finance' using errcode='40001'; end if;
  -- 303: a save of only Observações and Observações internas passes (erp_document_notes_save).
  if not erp_finance.notes_edit_allowed(old,new) and(
   (to_jsonb(new)-array['status','version','updated_at','updated_by']) is distinct from (to_jsonb(old)-array['status','version','updated_at','updated_by'])
   or not (erp_documents.effects_transition_allowed(old.kind,old.status,new.status)
     or (old.kind='purchase_orders' and old.status='open' and new.status in ('in_progress','partially_fulfilled','fulfilled')))) then
   raise exception 'erp_document_active_finance' using errcode='40001'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;return new;
end $$;
create or replace function erp_finance.guard_posted_item()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$ declare d uuid; begin
 d:=case when tg_op='INSERT' then new.document_id else old.document_id end;
 if (exists(select 1 from erp_finance.document_posting where state='active' and(document_id=d or(tg_op='UPDATE' and document_id=new.document_id)))
  or exists(select 1 from erp_finance.grouped_billing_document g where g.active and(g.document_id=d or(tg_op='UPDATE' and g.document_id=new.document_id))))
  -- 303: the identical rewrite of an existing item passes (the save of the observações never changes the items).
  and not erp_finance.notes_item_allowed(tg_op,old,new) then
  raise exception 'erp_document_active_finance' using errcode='40001'; end if;
 if tg_op='DELETE' then return old; end if;return new;
end $$;

revoke all on function erp_finance.notes_edit_allowed(erp_documents.document,erp_documents.document),erp_finance.notes_item_allowed(text,erp_documents.item,erp_documents.item),
 erp_finance.guard_posted_document(),erp_finance.guard_posted_item() from public,anon,authenticated,service_role;
commit;
