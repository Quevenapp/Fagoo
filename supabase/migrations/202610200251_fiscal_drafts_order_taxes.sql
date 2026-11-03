-- 251: rascunho fiscal (emissor de homologação) de um pedido de venda com Total do IPI / Total ICMS ST (onda E da frente de notas).
-- Desde a 196 (documentos), o pedido de venda pode somar ao total o IPI e o ICMS ST estimados (tax_ipi e tax_icms_st do corpo,
-- totais ipi e icms_st). A cópia do pedido no rascunho (erp_fiscal_drafts.capture, 022) guardava só os totais antigos: o total
-- copiado já tinha os impostos, mas o Worker não os via, recalculava um total menor e respondia 502 ao criar ou abrir o rascunho.
-- Agora a cópia leva tax_ipi e tax_icms_st (quando o pedido os tem) e os totais ipi e icms_st. Rascunhos e revisões já gravados
-- não mudam (a cópia é imutável e o hash da cópia continua o mesmo); o Worker reconhece a cópia antiga com impostos sem separação.
-- Nada é emitido, assinado, transmitido ou numerado.
begin;

-- The replaced body must still be the published one (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 for r in select * from(values
  ('erp_fiscal_drafts.capture(uuid)','a5eb14b0de3a87193fc59e059cdec3cfb090d48fbd4b984efea34c72b94385ed'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'fiscal_drafts_251_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- Called only after the order row and the company singleton advisory lock are held (erp_fiscal_draft_execute, 022).
-- Same copy as 022, plus the taxes of 196 when the order carries them (never invented when it does not).
create or replace function erp_fiscal_drafts.capture(p_document_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('catalog_basis','document_snapshot','document_id',d.id,'document_version',d.version,
  'kind',d.kind,'number',d.number::text,'status',d.status,'date',d.body->'date','contact_id',d.contact_id,
  'contact',erp_fiscal_drafts.pick(d.contact_snapshot,array['id','version','name','person_type','document','ie','postal_code','street','number','complement','district','city','state']),
  'items',(select coalesce(jsonb_agg(erp_fiscal_drafts.pick(i.data,array['id','position','product_id','description','code','unit','quantity','unit_price','discount_percent','gross','discount','total'])
   ||jsonb_build_object('product',erp_fiscal_drafts.pick(i.product_snapshot,array['id','version','name','code','unit','kind','format','ncm','gtin'])) order by i.position),'[]'::jsonb) from erp_documents.item i where i.document_id=d.id),
  'discount_mode',d.body->'discount_mode','discount_value',d.body->'discount_value',
  'totals',erp_fiscal_drafts.pick(d.body->'totals',array['gross','line_discount','subtotal','discount','freight','other_expenses','total'])
   ||(select coalesce(jsonb_object_agg(k,d.body#>array['totals',k]),'{}'::jsonb) from unnest(array['ipi','icms_st']) k where d.body->'totals' ? k),
  'installments',d.body->'installments','notes',d.body->'notes','payment_terms',d.body->'payment_terms','delivery_terms',d.body->'delivery_terms',
  'company',(select jsonb_build_object('identity_version',c.version,'fiscal_version',f.version,
    'identity',erp_fiscal_drafts.pick(c.data,array['legal_name','trade_name','cnpj','ie','postal_code','street','number','complement','district','city','municipality_code','state']),
    'crt',f.crt,'regime_confirmed',f.crt is not null)
   from erp_company.identity c left join erp_company.fiscal f using(singleton) where c.singleton))
  ||(select coalesce(jsonb_object_agg(k,d.body->k),'{}'::jsonb) from unnest(array['tax_ipi','tax_icms_st']) k where d.body ? k)
 from erp_documents.document d where d.id=p_document_id and d.kind='sales_orders'
$$;
revoke all on function erp_fiscal_drafts.capture(uuid) from public,anon,authenticated,service_role;
commit;
