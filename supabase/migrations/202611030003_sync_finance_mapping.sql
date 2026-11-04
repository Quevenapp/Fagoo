-- Financial synchronization must not select an arbitrary account or category.
begin;
create or replace function erp_sync.account_origin(p_native uuid) returns text
language sql stable security definer set search_path=pg_catalog as $$
 select case when count(*)=1 then min(r.source_id) end
 from erp_finance.account a join origin_sync.raw_record r on r.entity='ledger_accounts'
 and lower(btrim(r.payload->>'descricao'))=lower(btrim(a.name))
 where a.id=p_native and a.active and a.deleted_at is null
$$;
create or replace function erp_sync.category_origin(p_native uuid) returns text
language sql stable security definer set search_path=pg_catalog as $$
 select case when count(*)=1 then min(r.source_id) end
 from erp_finance.category c join origin_sync.raw_record r on r.entity='financial_categories'
 and lower(btrim(r.payload->>'descricao'))=lower(btrim(c.name))
 where c.id=p_native and c.active and c.deleted_at is null
$$;
create or replace function erp_sync.account_native(p_origin text) returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select case when count(*)>1 then null else coalesce(min(a.id::text)::uuid,
  (select f.id from erp_sync.settings s join erp_finance.account f on f.id=s.default_account_id
   where s.singleton and f.active and f.deleted_at is null)) end
 from origin_sync.raw_record r join erp_finance.account a
 on lower(btrim(a.name))=lower(btrim(r.payload->>'descricao'))
 where r.entity='ledger_accounts' and r.source_id=p_origin and a.active and a.deleted_at is null
$$;

create or replace function erp_sync.category_native(p_origin text,p_kind text) returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select case when count(*)=1 then min(c.id::text)::uuid end
 from origin_sync.raw_record r join erp_finance.category c
 on lower(btrim(c.name))=lower(btrim(r.payload->>'descricao'))
 where r.entity='financial_categories' and r.source_id=p_origin
 and c.active and c.deleted_at is null and c.kind in(p_kind,'both')
$$;
create or replace function erp_sync.payment_method_origin(p_native uuid) returns text
language sql stable security definer set search_path=pg_catalog as $$
 select case when count(*)=1 then min(r.source_id) end
 from erp_catalog.payment_method m join origin_sync.raw_record r on r.entity='payment_methods'
 and lower(btrim(r.payload->>'descricao'))=lower(btrim(m.description))
 where m.id=p_native and m.active and m.deleted_at is null
$$;
create or replace function erp_sync.payment_method_native(p_origin text) returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select case when count(*)=1 then min(m.id::text)::uuid end
 from origin_sync.raw_record r join erp_catalog.payment_method m
 on lower(btrim(m.description))=lower(btrim(r.payload->>'descricao'))
 where r.entity='payment_methods' and r.source_id=p_origin and m.active and m.deleted_at is null
$$;

-- An installment must keep its own payment method. Never copy the first method
-- in a remote document or choose the first active method in the catalogue.
create function erp_sync.installment_method(p_installment jsonb,p_base jsonb) returns text
language plpgsql stable security definer set search_path=pg_catalog as $$
declare result text; native_id uuid:=nullif(p_installment->>'payment_method_id','')::uuid;
begin
 if native_id is not null then
  result:=erp_sync.payment_method_origin(native_id);
 elsif erp_sync.origin_ref(p_installment#>'{payment_reference,source_id}') is not null then
  result:=erp_sync.origin_ref(p_installment#>'{payment_reference,source_id}');
 elsif nullif(btrim(p_installment->>'method'),'') is not null then
  select case when count(*)=1 then min(source_id) end into result
  from origin_sync.raw_record where entity='payment_methods'
   and lower(btrim(payload->>'descricao'))=lower(btrim(p_installment->>'method'));
 else
  -- Older imported installments did not retain the reference. Recover only an
  -- unambiguous match by the original due date and amount, never by position.
  select case when count(distinct erp_sync.origin_ref(x#>'{formaPagamento,id}'))=1
   then min(erp_sync.origin_ref(x#>'{formaPagamento,id}')) end into result
  from jsonb_array_elements(coalesce(p_base->'parcelas','[]'::jsonb)) x
  where x->>'dataVencimento'=p_installment->>'due_date'
   and erp_sync.num(x->>'valor')=erp_sync.num(p_installment->>'amount');
 end if;
 if result is null then raise exception 'ORIGIN_PAYMENT_METHOD_UNKNOWN' using errcode='22023'; end if;
 return result;
end$$;
revoke all on function erp_sync.installment_method(jsonb,jsonb) from public,anon,authenticated,service_role;

do $migration$
declare definition text; changed text;
begin
 definition:=replace(pg_get_functiondef('erp_sync.settlement_request(text,uuid)'::regprocedure),E'\r','');
 changed:=replace(definition,$before$ v_portador:=coalesce(erp_sync.account_origin(st.account_id),erp_sync.origin_ref(v_base#>'{portador,id}'),
  (select source_id from origin_sync.raw_record where entity='ledger_accounts' order by source_id limit 1));
 v_category:=coalesce(erp_sync.category_origin(t.category_id),erp_sync.origin_ref(v_base#>'{categoria,id}'),
  (select source_id from origin_sync.raw_record where entity='financial_categories' order by source_id limit 1));
 if v_portador is null or v_category is null then return jsonb_build_object('skip','ORIGIN_ACCOUNT_OR_CATEGORY_UNKNOWN'); end if;$before$,
 $after$ v_portador:=erp_sync.account_origin(st.account_id);
 v_category:=case when t.category_id is not null then erp_sync.category_origin(t.category_id)
  else erp_sync.origin_ref(v_base#>'{categoria,id}') end;
 if v_portador is null or v_category is null then raise exception 'ORIGIN_ACCOUNT_OR_CATEGORY_UNKNOWN' using errcode='22023'; end if;$after$);
 if changed=definition then raise exception 'settlement_mapping_definition_unexpected'; end if;
 execute changed;

 definition:=replace(pg_get_functiondef('erp_sync.document_request(text,uuid,text)'::regprocedure),E'\r','');
 changed:=replace(definition,$before$ v_fallback_method:=coalesce(erp_sync.origin_ref(b#>'{parcelas,0,formaPagamento,id}'),
  (select source_id from origin_sync.raw_record where entity='payment_methods' and (payload->>'situacao')='1' order by source_id limit 1));$before$,'');
 if changed=definition then raise exception 'document_payment_fallback_definition_unexpected'; end if;
 definition:=changed;
 changed:=replace(definition,$before$  v_method:=coalesce(erp_sync.payment_method_origin(nullif(v_inst->>'payment_method_id','')::uuid),v_fallback_method);$before$,
 $after$  v_method:=erp_sync.installment_method(v_inst,b);$after$);
 if changed=definition then raise exception 'document_payment_method_definition_unexpected'; end if;
 execute changed;

 definition:=replace(pg_get_functiondef('erp_sync.pull_document(origin_sync.raw_record)'::regprocedure),E'\r','');
 changed:=replace(definition,$before$  'payment_method_id',erp_sync.payment_method_native(erp_sync.origin_ref(s.payload#>array['parcelas',(n-1)::text,'formaPagamento','id']))$before$,
 $after$  'payment_reference',case when erp_sync.origin_ref(s.payload#>array['parcelas',(n-1)::text,'formaPagamento','id']) is not null then
   jsonb_build_object('system','origin','source_id',erp_sync.origin_ref(s.payload#>array['parcelas',(n-1)::text,'formaPagamento','id']),
    'label',coalesce(nullif(s.payload#>>array['parcelas',(n-1)::text,'formaPagamento','descricao'],''),'Forma '||(s.payload#>>array['parcelas',(n-1)::text,'formaPagamento','id']))) end,
  'payment_method_id',erp_sync.payment_method_native(erp_sync.origin_ref(s.payload#>array['parcelas',(n-1)::text,'formaPagamento','id']))$after$);
 if changed=definition then raise exception 'document_received_payment_definition_unexpected'; end if;
 execute changed;

 definition:=replace(pg_get_functiondef('erp_sync.title_request(text,uuid,text)'::regprocedure),E'\r','');
 changed:=replace(definition,
  'v_ref:=erp_sync.payment_method_origin(t.payment_method_id); if v_ref is not null then',
  'v_ref:=erp_sync.payment_method_origin(t.payment_method_id); if t.payment_method_id is not null and v_ref is null then raise exception ''ORIGIN_PAYMENT_METHOD_UNKNOWN'' using errcode=''22023''; end if; if v_ref is not null then');
 if changed=definition then raise exception 'title_payment_method_definition_unexpected'; end if;
 definition:=changed;
 changed:=replace(definition,
  'v_ref:=erp_sync.category_origin(t.category_id); if v_ref is not null then',
  'v_ref:=erp_sync.category_origin(t.category_id); if t.category_id is not null and v_ref is null then raise exception ''ORIGIN_ACCOUNT_OR_CATEGORY_UNKNOWN'' using errcode=''22023''; end if; if v_ref is not null then');
 if changed=definition then raise exception 'title_category_definition_unexpected'; end if;
 definition:=changed;
 changed:=replace(definition,
  'v_ref:=erp_sync.account_origin(t.account_id); if v_ref is not null then',
  'v_ref:=erp_sync.account_origin(t.account_id); if t.account_id is not null and v_ref is null then raise exception ''ORIGIN_ACCOUNT_OR_CATEGORY_UNKNOWN'' using errcode=''22023''; end if; if v_ref is not null then');
 if changed=definition then raise exception 'title_account_definition_unexpected'; end if;
 execute changed;
end$migration$;
commit;
