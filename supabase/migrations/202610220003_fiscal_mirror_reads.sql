-- Fiscal: listas existentes passam ao resumo versionado, com XML indexado, chave única, carteira e cobertura.
-- Preserva o contrato origin=origin/brufap; nenhuma emissão ou efeito operacional é criado.
begin;
do $$declare r record;begin for r in select *from(values
  ('public.erp_fiscal_invoice_origin_get(uuid,text,text)','2edb0e469b2d1cf87e28475c9468eb143ab5714ad91a7884e3d0bc9e9015694a'),
  ('public.erp_fiscal_report_difal(uuid,text,text,text)','f512111cf7e93bdabeb06dcef6a2d31cdb1f9dac3e21cf88990bc357505cde87'),
  ('public.erp_fiscal_report_invoices(uuid,text,text,text,text)','ba818780023ea79057e601d8d38aad03addf30ea2f5a24ee4ece642fce09d7ce'),
  ('erp_fiscal_invoices.list_query(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid,boolean,text,uuid)','f060b933eb9b32a86e7ee25fc2def1d68d331b0472008589caa89900a635ddaa'),
  ('erp_fiscal_invoices.list_rows(text,text,text,text)','f046170d2a947e3cfa2c8dbb4e0d33baa2aef61a4390c57df04d8ddb3853da9e'),
  ('erp_fiscal_invoices.report_notes(date,date)','23401beef4668426f3b2ae62015185826ec70e397cbbe721f940e916533ce4f2')
 )v(sig,expected)loop
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
 raise exception 'fiscal_mirror_003_previous_definition_changed'using errcode='55000',detail=r.sig;end if;
 end loop;end$$;
create function erp_fiscal_mirror.report_visible(p_user_id uuid,p_origin text,p_ref text,p_invoice_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select case when p_origin='origin'then erp_fiscal_mirror.visible(p_user_id,split_part(p_ref,':',1),split_part(p_ref,':',2))
  else erp_fiscal_mirror.native_visible(p_user_id,p_invoice_id)end
$$;

CREATE OR REPLACE FUNCTION erp_fiscal_invoices.list_rows(p_origin text, p_model text, p_direction text, p_role text)
 RETURNS TABLE(origin text, id text, version integer, number integer, series integer, issue_date date, entry_date date, name text, trade_name text, document text, person_type text, email text, phone text, state text, nature text, status smallint, status_raw text, total numeric, environment text, issue_type text, access_key text, xml_id uuid, xml_hash text, xml_size integer, protocol_present boolean, event_count integer, carrier text, tracking text, contact_code text, product_ids uuid[], product_codes text[], orders jsonb, order_numbers text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 select 'brufap',v.id::text,v.version,v.number,v.series,v.issue_date,v.exit_date,v.recipient->>'name',c.trade_name,v.recipient->>'document',v.recipient->>'person_type',
  v.recipient->>'email',v.recipient->>'phone',v.recipient->>'state',v.nature_description,v.status,null,(v.totals->>'total')::numeric,v.environment,v.issue_type,v.access_key,
  null::uuid,null::text,null::integer,v.protocol is not null,0,v.transport#>>'{carrier,name}',v.transport->>'tracking_code',cr.code,
  array(select i.product_id from erp_fiscal_invoices.invoice_item i where i.invoice_id=v.id and i.product_id is not null),'{}'::text[],
  coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'date',d.body->>'date','contact_name',dc.name) order by d.number,d.id)
   from erp_fiscal_invoices.invoice_order o join erp_documents.document d on d.id=o.document_id left join erp_catalog.record dc on dc.id=d.contact_id where o.invoice_id=v.id),'[]'::jsonb),
  array(select d.number::text from erp_fiscal_invoices.invoice_order o join erp_documents.document d on d.id=o.document_id where o.invoice_id=v.id)
 from erp_fiscal_invoices.invoice v
 left join erp_catalog.contact c on c.record_id=(v.recipient->>'contact_id')::uuid left join erp_catalog.record cr on cr.id=(v.recipient->>'contact_id')::uuid
 where p_origin='brufap' and p_role in('admin','fiscal') and v.deleted_at is null and v.model=p_model and v.direction=p_direction
 union all
 select 'origin',r.source_id,null,(r.listing->>'number')::integer,(r.listing->>'series')::integer,
  (r.listing->>'issue_date')::date,(r.listing->>'entry_date')::date,r.listing->>'name',r.listing->>'trade_name',r.listing->>'document',r.listing->>'person_type',
  r.listing->>'email',r.listing->>'phone',r.listing->>'state',null,(r.listing->>'status')::smallint,r.status_raw,(r.listing->>'total')::numeric,
  r.environment,null,r.access_key,r.xml_id,r.xml_hash,r.xml_size,r.protocol_present,r.event_count,
  r.listing->>'carrier',r.listing->>'tracking',ccr.payload->>'codigo','{}'::uuid[],
  array(select jsonb_array_elements_text(r.listing->'product_codes')),coalesce(bo.orders,'[]'::jsonb),coalesce(bo.numbers,'{}'::text[])
 from erp_fiscal_mirror.listing_rows r
 left join origin_sync.raw_record ccr on ccr.entity='contacts'and ccr.source_id=r.listing->>'contact_source_id'
 left join lateral(
  select jsonb_agg(jsonb_build_object('id',l.order_source_id,'kind','sales_orders','number',l.order_number,'date',l.order_date,'contact_name',l.contact_name)
    order by l.order_number::bigint,l.order_source_id)orders,array_agg(l.order_number order by l.order_number::bigint,l.order_source_id)numbers
  from erp_fiscal_invoices.origin_order_link l where l.invoice_source_id=r.source_id and l.order_number is not null
   and not exists(select 1 from erp_fiscal_mirror.current a where a.entity=case r.entity when'nfe'then'nfce'else'nfe'end and a.source_id=r.source_id))bo on true
 where p_origin='origin'and r.entity=case p_model when'55'then'nfe'else'nfce'end
  and(p_model='65'or r.listing->>'direction'=p_direction)and r.eligible and r.canonical
$function$;

CREATE OR REPLACE FUNCTION erp_fiscal_invoices.list_query(p_user_id uuid, p_origin text, p_model text, p_direction text, p_page integer, p_limit integer, p_order text, p_query text, p_date_type text, p_date_from date, p_date_to date, p_status text, p_product_id uuid, p_state text, p_nature text, p_carrier text, p_trade_name text, p_person_type text, p_document text, p_email text, p_phone text, p_series integer, p_contact_code text, p_order_number text, p_tracking text, p_seller_id uuid, p_tagged boolean, p_tag text, p_category_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare role text:=erp_fiscal_invoices.require_read(p_user_id);q text:=nullif(btrim(p_query),'');qd text;codes smallint[];product_code text;result jsonb;origin_sellers text[];
 v_entity text:=case p_model when '65' then 'nfce' else 'nfe' end;v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 if p_origin is null or p_origin not in('origin','brufap') or p_model is null or p_model not in('55','65') or p_direction is null or p_direction not in('0','1') or (p_model='65' and p_direction<>'1')
  or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or p_order is null or p_order not in('date_desc','date_asc','number_desc','number_asc')
  or p_date_type is null or p_date_type not in('issue','entry') or (p_date_from is not null and p_date_to is not null and p_date_from>p_date_to)
  or (p_status is not null and erp_fiscal_invoices.status_group(p_status) is null) or (p_state is not null and not p_state=any(erp_fiscal_invoices.ufs()||array['EX']))
  or (p_person_type is not null and p_person_type not in('J','F','E')) or (p_series is not null and p_series not between 0 and 999)
  or exists(select 1 from unnest(array[p_query,p_nature,p_carrier,p_trade_name,p_document,p_email,p_phone,p_contact_code,p_order_number,p_tracking]) t where length(t)>120 or t~'[[:cntrl:]]')
  or (p_tagged and (p_tag is null or(p_tag<>'none' and p_tag!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
  -- 358: Categoria only exists for the notes of the Brufap (contas lançadas by the note).
  or (p_category_id is not null and p_origin<>'brufap') then
  raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 if p_origin='brufap' and role not in('admin','fiscal') then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 qd:=erp_fiscal_invoices.digits(q);codes:=erp_fiscal_invoices.status_group(p_status);
 if p_product_id is not null then select code into product_code from erp_catalog.record where id=p_product_id and entity='products'; end if;
 if p_seller_id is not null and p_origin='origin' then origin_sellers:=erp_fiscal_invoices.origin_seller_ids(p_seller_id); end if;
 with rows as materialized(
  select * from erp_fiscal_invoices.list_rows(p_origin,p_model,p_direction,role) x
  where(v_scope is null or case when x.origin='origin'then exists(
   select 1 from erp_fiscal_mirror.current m join erp_catalog.origin o on o.entity='contacts'and o.source_id=m.listing->>'contact_source_id'
   join erp_catalog.contact_profile cp on cp.record_id=o.record_id where m.entity=v_entity and m.source_id=x.id and cp.seller_id=v_scope)
   else erp_fiscal_mirror.native_visible(p_user_id,x.id::uuid)end)
   and (q is null or strpos(lower(coalesce(x.name,'')),lower(q))>0 or strpos(lower(coalesce(x.trade_name,'')),lower(q))>0
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
   -- 215 "Vendedor": the seller of the Brufap note, or the Origin vendedor linked to the seller's contact.
   and (p_seller_id is null
    or (x.origin='brufap' and exists(select 1 from erp_fiscal_invoices.invoice v where v.id::text=x.id and v.seller_id=p_seller_id))
    or (x.origin='origin' and cardinality(origin_sellers)>0 and exists(select 1 from erp_fiscal_mirror.current n where n.entity=v_entity and n.source_id=x.id
     and n.payload#>>'{vendedor,id}'=any(origin_sellers))))
   -- 236: Tags (Sem Tag ou a tag de Notas fiscais), only through erp_catalog_invoice_list_tagged.
   and (not p_tagged or case when p_tag='none' then not exists(select 1 from erp_catalog.invoice_tag t where t.origin=x.origin and t.model=p_model and t.invoice_id=x.id)
    else exists(select 1 from erp_catalog.invoice_tag t where t.origin=x.origin and t.model=p_model and t.invoice_id=x.id and t.tag_id=p_tag::uuid) end)
   -- 358 Categoria: the category of the contas lançadas by the note (247) or by its active Faturamento agrupado (174/247).
   and (p_category_id is null
    or exists(select 1 from erp_finance.invoice_posting ip join erp_finance.invoice_title it on it.posting_id=ip.id join erp_finance.title t on t.id=it.title_id
     where ip.invoice_id::text=x.id and ip.state='active' and t.category_id=p_category_id)
    or exists(select 1 from erp_finance.grouped_billing_invoice gi join erp_finance.grouped_billing g on g.id=gi.billing_id and g.state='active'
     join erp_finance.grouped_billing_title gt on gt.billing_id=g.id join erp_finance.title t on t.id=gt.title_id
     where gi.invoice_id::text=x.id and gi.active and t.category_id=p_category_id))
 ),ordered as(
  select r.*,row_number() over(order by
   case when p_order='date_desc' then r.issue_date end desc nulls last,case when p_order='date_asc' then r.issue_date end asc nulls last,
   case when p_order in('number_desc','date_desc') then r.number end desc nulls last,case when p_order in('number_asc','date_asc') then r.number end asc nulls last,
   r.origin,r.id desc) ord from rows r
 ),page as(select * from ordered where ord>(p_page-1)::bigint*p_limit and ord<=p_page::bigint*p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('origin',p.origin,'id',p.id,'version',p.version,'number',p.number,'series',p.series,
   'issue_date',p.issue_date,'entry_date',p.entry_date,'name',p.name,'document',p.document,'state',p.state,'nature',p.nature,'status',p.status,'status_raw',p.status_raw,
   'total',erp_fiscal_invoices.money_text(p.total),'total_known',p.total is not null,'environment',p.environment,'issue_type',p.issue_type,'access_key',p.access_key,
   'xml_id',p.xml_id,'xml_hash',p.xml_hash,'xml_size',p.xml_size,'protocol_present',p.protocol_present,'event_count',p.event_count,'orders',p.orders,
   -- 358 (NFE-069): fiscal state apart from the DANFE print; (NFE-063/185): origin and environment of the source.
   'observed_at',case when p.origin='origin'then(select m.last_seen_at from erp_fiscal_mirror.current m where m.entity=v_entity and m.source_id=p.id)end,
   'fiscal_status',case when p.status=7 then 6 else p.status end,'danfe_emitted',coalesce(p.status=7,false),
   'source_origin',case when p.origin='origin' then 'origin' when p.issue_type in('S','X') then 'xml_import' when p.issue_type='T' then 'third_party' else 'brufap_native' end,
   'source_environment',case when p.origin='origin' then p.environment when p.issue_type in('S','X') then (select s.source_environment from erp_fiscal_invoices.invoice_source s where s.invoice_id::text=p.id)
    when p.issue_type='T' then null else p.environment end) order by p.ord)
   from page p),'[]'::jsonb),
  'origin',p_origin,'model',p_model,'direction',p_direction,'page',p_page,'limit',p_limit,'order',p_order,'has_more',(select count(*) from rows)>p_page::bigint*p_limit,
  'total_count',(select count(*)::integer from rows),'total_amount',erp_fiscal_invoices.money_text((select sum(total) from rows)),
  'amount_unknown',(select count(*)::integer from rows where total is null),'brufap_visible',role in('admin','fiscal'),
  -- "Exibir totais em listas de Notas Fiscais": the list hides Quantidade and Valor total when it is off.
  'show_totals',erp_fiscal_invoices.preference('nfe.exibir_totais','boolean','true'),
  'data_mode',case p_origin when 'origin' then 'origin_mirror_readonly' else 'erp_native_homologation' end)
 into result;
 return result||jsonb_build_object('coverage',case when p_origin='origin'then erp_fiscal_mirror.coverage(p_user_id,p_model,p_direction)end);
end $function$;

CREATE OR REPLACE FUNCTION public.erp_fiscal_invoice_origin_get(p_user_id uuid, p_entity text, p_source_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare r erp_fiscal_mirror.current%rowtype;p jsonb;v_xml uuid;v_hash text;v_size integer;v_env text;v_protocol text;v_events jsonb;result jsonb;
begin
 perform erp_fiscal_invoices.require_read(p_user_id);
 if p_entity is null or p_entity not in('nfe','nfce') or p_source_id is null or p_source_id !~ '^[0-9]{1,40}$' then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 select * into r from erp_fiscal_mirror.current where entity=p_entity and source_id=p_source_id;
 if not found or r.source_deleted or not erp_fiscal_mirror.visible(p_user_id,p_entity,p_source_id)or not erp_fiscal_mirror.canonical(p_entity,p_source_id,r.access_key)then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 p:=r.payload;
 select x.xml_id,x.xml_hash,x.xml_size,x.environment,x.protocol,x.events
 into v_xml,v_hash,v_size,v_env,v_protocol,v_events from erp_fiscal_mirror.xml_info(r.entity,r.source_id,r.access_key)x;
 if v_env='2' then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 result:=jsonb_build_object('origin','origin','entity',r.entity,'source_id',r.source_id,'model',case r.entity when 'nfe' then '55' else '65' end,
  'direction',case when r.entity='nfce' then '1' else erp_fiscal_invoices.scalar(p->'tipo',2) end,
  'number',erp_fiscal_invoices.origin_int(to_jsonb(nullif(ltrim(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(p->'numero',20)),'0'),''))),'series',erp_fiscal_invoices.origin_int(p->'serie'),
  'issue_date',erp_fiscal_invoices.origin_date(p->'dataEmissao'),'operation_date',erp_fiscal_invoices.origin_date(p->'dataOperacao'),
  'status',erp_fiscal_invoices.origin_status(p->'situacao'),'status_raw',coalesce(erp_fiscal_invoices.scalar(p#>'{situacao,id}',20),erp_fiscal_invoices.scalar(p->'situacao',20)),
  'access_key',case when erp_fiscal_invoices.scalar(p->'chaveAcesso',44)~'^[0-9]{44}$' then p->>'chaveAcesso' end,
  'total',erp_fiscal_invoices.money_text(erp_fiscal_invoices.origin_money(p->'valorNota')),'total_known',erp_fiscal_invoices.origin_money(p->'valorNota') is not null,
  'freight',case when erp_fiscal_invoices.origin_money(p->'valorFrete') is not null then erp_fiscal_invoices.money_text(erp_fiscal_invoices.origin_money(p->'valorFrete')) end,
  'contact',jsonb_build_object('name',erp_fiscal_invoices.scalar(p#>'{contato,nome}',200),'document',nullif(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(p#>'{contato,numeroDocumento}',30)),''),
   'ie',erp_fiscal_invoices.scalar(p#>'{contato,ie}',30),'email',erp_fiscal_invoices.scalar(p#>'{contato,email}',254),'phone',erp_fiscal_invoices.scalar(p#>'{contato,telefone}',40),
   'street',erp_fiscal_invoices.scalar(p#>'{contato,endereco,endereco}',200),'number',erp_fiscal_invoices.scalar(p#>'{contato,endereco,numero}',30),
   'complement',erp_fiscal_invoices.scalar(p#>'{contato,endereco,complemento}',200),'district',erp_fiscal_invoices.scalar(p#>'{contato,endereco,bairro}',100),
   'postal_code',erp_fiscal_invoices.scalar(p#>'{contato,endereco,cep}',20),'city',erp_fiscal_invoices.scalar(p#>'{contato,endereco,municipio}',100),
   'state',upper(erp_fiscal_invoices.scalar(p#>'{contato,endereco,uf}',2)),'country',erp_fiscal_invoices.scalar(p#>'{contato,endereco,pais}',60)),
  'items',coalesce((select jsonb_agg(jsonb_build_object('code',erp_fiscal_invoices.scalar(e->'codigo',60),'description',erp_fiscal_invoices.scalar(e->'descricao',200),
    'unit',erp_fiscal_invoices.scalar(e->'unidade',10),'quantity',case when erp_fiscal_invoices.scalar(e->'quantidade',30)~'^[0-9]{1,12}(\.[0-9]{1,10})?$' then e->>'quantidade' end,
    'unit_price',case when erp_fiscal_invoices.scalar(e->'valor',30)~'^[0-9]{1,13}(\.[0-9]{1,10})?$' then e->>'valor' end,
    'total',case when erp_fiscal_invoices.origin_money(e->'valorTotal') is not null then erp_fiscal_invoices.money_text(erp_fiscal_invoices.origin_money(e->'valorTotal')) end,
    'cfop',erp_fiscal_invoices.scalar(e->'cfop',4),'ncm',erp_fiscal_invoices.scalar(e->'classificacaoFiscal',10),'gtin',erp_fiscal_invoices.scalar(e->'gtin',14)) order by n)
   from jsonb_array_elements(case when jsonb_typeof(p->'itens')='array' then p->'itens' else '[]' end) with ordinality t(e,n) where n<=990),'[]'::jsonb),
  'installments',coalesce((select jsonb_agg(jsonb_build_object('date',erp_fiscal_invoices.origin_date(e->'data'),
    'amount',case when erp_fiscal_invoices.origin_money(e->'valor') is not null then erp_fiscal_invoices.money_text(erp_fiscal_invoices.origin_money(e->'valor')) end,
    'note',erp_fiscal_invoices.scalar(e->'observacoes',255)) order by n)
   from jsonb_array_elements(case when jsonb_typeof(p->'parcelas')='array' then p->'parcelas' else '[]' end) with ordinality t(e,n) where n<=120),'[]'::jsonb),
  'transport',jsonb_build_object('freight_by',erp_fiscal_invoices.scalar(p#>'{transporte,fretePorConta}',2),'carrier',erp_fiscal_invoices.scalar(p#>'{transporte,transportador,nome}',200)),
  'additional_info',erp_fiscal_invoices.scalar(p#>'{informacoesComplementares}',5000),
  'xml',case when v_xml is null then null else jsonb_build_object('id',v_xml,'hash',v_hash,'size',v_size,'environment',v_env,'protocol',case when v_protocol~'^[0-9]{1,20}$' then v_protocol end) end,
  'events',coalesce(v_events,'[]'::jsonb),'observed_at',r.last_seen_at,'data_mode','origin_mirror_readonly','writable',false);
 return result;
end $function$;

CREATE OR REPLACE FUNCTION erp_fiscal_invoices.report_notes(p_from date, p_to date)
 RETURNS TABLE(origin text, ref text, model text, number integer, series integer, issue_date date, contact_key text, contact_name text, contact_document text, state text, nature_key text, nature text, total numeric, invoice_id uuid, payload jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 select 'xml',v.id::text,v.model,v.number,v.series,v.issue_date,
  coalesce('doc:'||nullif(erp_fiscal_invoices.digits(v.recipient->>'document'),''),'nome:'||lower(nullif(btrim(v.recipient->>'name'),''))),
  nullif(btrim(v.recipient->>'name'),''),nullif(erp_fiscal_invoices.digits(v.recipient->>'document'),''),upper(nullif(v.recipient->>'state','')),
  'xml:'||lower(btrim(v.nature_description)),v.nature_description,erp_fiscal_invoices.origin_money(v.totals->'total'),v.id,null::jsonb
 from erp_fiscal_invoices.invoice v
 where v.issue_type='S' and v.direction='1' and v.environment is null and v.deleted_at is null and v.status in(6,7,8)
  and not exists(select 1 from erp_fiscal_invoices.invoice_source ns where ns.invoice_id=v.id and ns.source_environment='2')
  and v.issue_date between p_from and p_to and exists(select 1 from erp_fiscal_invoices.invoice_xml x where x.invoice_id=v.id)
 union all
 select 'origin',r.entity||':'||r.source_id,case r.entity when 'nfe' then '55' else '65' end,
  erp_fiscal_invoices.origin_int(to_jsonb(nullif(ltrim(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(r.payload->'numero',20)),'0'),''))),
  erp_fiscal_invoices.origin_int(r.payload->'serie'),b.issue_date,
  coalesce('doc:'||b.document,'nome:'||lower(b.name)),b.name,b.document,
  upper(erp_fiscal_invoices.scalar(r.payload#>'{contato,endereco,uf}',2)),
  case when b.nature_id is not null then 'origin:'||b.nature_id end,
  case when b.nature_id is not null then coalesce(erp_fiscal_invoices.scalar(r.payload#>'{naturezaOperacao,descricao}',120),'Natureza Origin #'||b.nature_id) end,
  erp_fiscal_invoices.origin_money(r.payload->'valorNota'),null::uuid,r.payload
 from erp_fiscal_mirror.current r join erp_fiscal_mirror.listing_rows mr on mr.entity=r.entity and mr.source_id=r.source_id
 cross join lateral(select erp_fiscal_invoices.origin_date(r.payload->'dataEmissao') issue_date,erp_fiscal_invoices.origin_status(r.payload->'situacao') status,
   nullif(btrim(erp_fiscal_invoices.scalar(r.payload#>'{contato,nome}',200)),'') name,
   nullif(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(r.payload#>'{contato,numeroDocumento}',30)),'') document,
   case when erp_fiscal_invoices.scalar(r.payload#>'{naturezaOperacao,id}',20)~'^[1-9][0-9]{0,19}$' then r.payload#>>'{naturezaOperacao,id}' end nature_id) b
 where r.entity in('nfe','nfce') and (r.entity='nfce' or erp_fiscal_invoices.scalar(r.payload->'tipo',2)='1')
  and mr.eligible and mr.canonical
  and b.status in(6,7,8) and b.issue_date between p_from and p_to
$function$;

CREATE OR REPLACE FUNCTION public.erp_fiscal_report_difal(p_user_id uuid, p_from text, p_to text, p_state text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_period daterange;v_result jsonb;
begin
 perform erp_fiscal_invoices.report_access(p_user_id);
 v_period:=erp_fiscal_invoices.report_period(p_from,p_to,366);
 if p_state is not null and p_state not in('AC','AL','AM','AP','BA','CE','DF','ES','EX','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO','SEM') then
  raise exception 'erp_fiscal_report_invalid' using errcode='22023'; end if;
 with base as materialized(
   select n.origin,n.ref,n.number,n.series,n.issue_date,n.contact_name,coalesce(n.state,d.detail->>'state') state,n.total,d.detail
   from erp_fiscal_invoices.report_notes(lower(v_period),upper(v_period)-1) n
   left join lateral(select erp_fiscal_invoices.report_difal_xml(x.content) detail from erp_fiscal_invoices.invoice_xml x where n.origin='xml' and x.invoice_id=n.invoice_id) d on true
   where n.model='55'and erp_fiscal_mirror.report_visible(p_user_id,n.origin,n.ref,n.invoice_id)),
  notes as materialized(select * from base where p_state is null or coalesce(state,'SEM')=p_state),
  g as(select coalesce(state,'SEM') uf,count(*) notes,count(detail) detailed,sum(total) amount,count(total) valued,
    sum((detail->>'dest')::numeric) dest,sum((detail->>'remet')::numeric) remet,sum((detail->>'fcp')::numeric) fcp from notes group by 1),
  r as(select *,row_number() over(order by issue_date,number nulls last,ref) position from notes)
 select jsonb_build_object('report','difal','from',lower(v_period)::text,'to',(upper(v_period)-1)::text,'state',p_state,
  'groups',(select coalesce(jsonb_agg(jsonb_build_object('state',case when uf='SEM' then null else uf end,'notes',notes,'detailed',detailed,'without_detail',notes-detailed,
    'amount',case when valued>0 then amount::numeric(20,2)::text end,
    'dest',case when detailed>0 then dest::numeric(20,2)::text end,'remet',case when detailed>0 then remet::numeric(20,2)::text end,
    'fcp',case when detailed>0 then fcp::numeric(20,2)::text end) order by uf='SEM',uf),'[]'::jsonb) from g),
  'group_count',(select count(*) from g),
  'rows',(select coalesce(jsonb_agg(jsonb_build_object('origin',origin,'ref',ref,'number',number,'series',series,'issue_date',issue_date::text,'contact_name',contact_name,'state',state,
    'amount',total::numeric(20,2)::text,'detail',detail is not null,'dest',(detail->>'dest')::numeric(20,2)::text,'remet',(detail->>'remet')::numeric(20,2)::text,
    'fcp',(detail->>'fcp')::numeric(20,2)::text) order by position) filter(where position<=1000),'[]'::jsonb) from r),
  'row_count',(select count(*) from notes),'truncated',(select count(*) from notes)>1000,
  'totals',(select jsonb_build_object('notes',count(*),'detailed',count(detail),'amount',case when count(total)>0 then sum(total)::numeric(20,2)::text end,
    'dest',case when count(detail)>0 then sum((detail->>'dest')::numeric)::numeric(20,2)::text end,'remet',case when count(detail)>0 then sum((detail->>'remet')::numeric)::numeric(20,2)::text end,
    'fcp',case when count(detail)>0 then sum((detail->>'fcp')::numeric)::numeric(20,2)::text end) from notes),
  'coverage',(select jsonb_build_object('notes',count(*),'covered',count(detail)) from notes),
  'sources',(select erp_fiscal_invoices.report_sources((count(*) filter(where origin='xml'))::integer,(count(*) filter(where origin='origin'))::integer) from notes),
  'data_mode','erp_native','operational_effects',false) into v_result;
 return v_result;
end $function$;

CREATE OR REPLACE FUNCTION public.erp_fiscal_report_invoices(p_user_id uuid, p_report text, p_from text, p_to text, p_model text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_period daterange;v_from date;v_to date;v_result jsonb;
begin
 perform erp_fiscal_invoices.report_access(p_user_id);
 if p_report is null or p_report not in('operation','contact','product','billing') or (p_model is not null and p_model not in('55','65')) then
  raise exception 'erp_fiscal_report_invalid' using errcode='22023'; end if;
 v_period:=erp_fiscal_invoices.report_period(p_from,p_to,case when p_report='billing' then 731 else 366 end);
 v_from:=lower(v_period);v_to:=upper(v_period)-1;
 with notes as materialized(select n.* from erp_fiscal_invoices.report_notes(v_from,v_to) n where(p_model is null or n.model=p_model)and erp_fiscal_mirror.report_visible(p_user_id,n.origin,n.ref,n.invoice_id)),
  -- Items of the imported XMLs (invoice_item) and of the Origin notes (itens of the detail); a note without items is outside the coverage.
  items as materialized(
    select n.origin,n.ref,nullif(upper(btrim(i.data->>'code')),'') code,nullif(btrim(i.data->>'description'),'') description,i.quantity,i.total
    from notes n join erp_fiscal_invoices.invoice_item i on i.invoice_id=n.invoice_id where p_report='product' and n.origin='xml'
    union all
    select n.origin,n.ref,nullif(upper(btrim(erp_fiscal_invoices.scalar(e->'codigo',60))),''),nullif(btrim(erp_fiscal_invoices.scalar(e->'descricao',300)),''),
     case when erp_fiscal_invoices.scalar(e->'quantidade',30)~'^[0-9]{1,12}(\.[0-9]{1,10})?$' then (e->>'quantidade')::numeric end,erp_fiscal_invoices.origin_money(e->'valorTotal')
    from notes n cross join lateral jsonb_array_elements(case when jsonb_typeof(n.payload->'itens')='array' then n.payload->'itens' else '[]'::jsonb end) e
    where p_report='product' and n.origin='origin' and jsonb_typeof(e)='object'),
  keyed as(select *,coalesce('code:'||code,'desc:'||lower(description)) key from items where code is not null or description is not null),
  g as(
    select coalesce(nature_key,'sem-natureza') key,min(nature) label,null::text document,count(*) notes,count(total) valued,sum(total) amount,null::numeric quantity,0::bigint counted,
     count(*) filter(where origin='xml') xml_notes,count(*) filter(where origin='origin') origin_notes,null::date bucket
    from notes where p_report='operation' group by 1
    union all
    select coalesce(contact_key,'sem-cliente'),(array_agg(contact_name order by issue_date desc,ref) filter(where contact_name is not null))[1],
     (array_agg(contact_document order by issue_date desc,ref) filter(where contact_document is not null))[1],count(*),count(total),sum(total),null,0,
     count(*) filter(where origin='xml'),count(*) filter(where origin='origin'),null
    from notes where p_report='contact' group by 1
    union all
    select key,(array_agg(description order by ref) filter(where description is not null))[1],min(code),count(distinct ref),count(total),sum(total),sum(quantity),count(quantity),
     count(distinct ref) filter(where origin='xml'),count(distinct ref) filter(where origin='origin'),null
    from keyed group by key
    union all
    select to_char(m.bucket,'YYYY-MM'),to_char(m.bucket,'MM/YYYY'),null,count(n.ref),count(n.total),sum(n.total),null,0,
     count(n.ref) filter(where n.origin='xml'),count(n.ref) filter(where n.origin='origin'),m.bucket
    from(select d::date bucket from generate_series(date_trunc('month',v_from),date_trunc('month',v_to),interval '1 month') d) m
    left join notes n on date_trunc('month',n.issue_date)=m.bucket where p_report='billing' group by m.bucket),
  o as(select g.*,row_number() over(order by g.bucket nulls last,g.amount desc nulls last,g.notes desc,lower(coalesce(g.label,'')),g.key) position from g)
 select jsonb_build_object('report',p_report,'from',v_from::text,'to',v_to::text,'model',p_model,
  'groups',(select coalesce(jsonb_agg(jsonb_build_object('key',key,'label',label,'document',document,'notes',notes,
    'amount',case when notes=0 then '0.00' when valued>0 then amount::numeric(20,2)::text end,'quantity',case when counted>0 then trim_scale(quantity)::text end,
    'xml_notes',xml_notes,'origin_notes',origin_notes) order by position) filter(where position<=2000),'[]'::jsonb) from o),
  'group_count',(select count(*) from o),'truncated',(select count(*) from o)>2000,
  'totals',(select jsonb_build_object('notes',count(*),'amount',case when count(total)>0 then sum(total)::numeric(20,2)::text when count(*)=0 then '0.00' end) from notes),
  'coverage',jsonb_build_object('notes',(select count(*) from notes),'covered',case p_report when 'operation' then (select count(*) from notes where nature_key is not null)
    when 'contact' then (select count(*) from notes where contact_key is not null) when 'product' then (select count(distinct ref) from keyed) else (select count(total) from notes) end),
  'sources',(select erp_fiscal_invoices.report_sources((count(*) filter(where origin='xml'))::integer,(count(*) filter(where origin='origin'))::integer) from notes),
  'data_mode','erp_native','operational_effects',false) into v_result;
 return v_result;
end $function$;

revoke all on function erp_fiscal_mirror.report_visible(uuid,text,text,uuid)from public,anon,authenticated,service_role;
commit;
