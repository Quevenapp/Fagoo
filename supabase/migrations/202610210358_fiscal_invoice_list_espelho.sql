-- Leva H, lane espelho: listagem de notas fiscais (NFE-027, NFE-069, NFE-063, NFE-185, NFE-024, NFE-172).
-- 1. NFE-027: as notas do Origin passam a responder orders/order_numbers a partir de erp_fiscal_invoices.origin_order_link (356),
--    a referência que o pedido de venda do Origin declara em notaFiscal.id. O id da nota é procurado só na entidade da listagem;
--    se o mesmo id existir como nfe e como nfce, o vínculo é ambíguo e não é mostrado. Assim a letra V e o filtro "Nº pedido de
--    venda" valem também para as notas do Origin. O pedido do Origin é identificado pelo id de origem (não há documento do Brufap).
-- 2. NFE-069: o mapeamento de situação segue o contrato versionado de importação v3:
--    NotasFiscaisDadosBaseDTO.situacao é inteiro "1 Pendente, 2 Cancelada, 3 Aguardando
--    recibo, 4 Rejeitada, 5 Autorizada, 6 Emitida DANFE, 7 Registrada, 8 Aguardando protocolo, 9 Denegada, 10 Consulta situação,
--    11 Bloqueada" (o filtro situacao de GET /nfce aceita também 12, sem descrição: fica sem código de tela e status_raw guarda
--    '12'). ContasReceberDadosOrigemDTO.situacao confirma os códigos de tela (3 Cancelada ... 7 Emitida DANFE ...). O mapa
--    origin_status (113) confere e não muda; status_raw continua com o código de origem. O estado fiscal fica separado da
--    impressão do DANFE: cada linha traz fiscal_status (7 Emitida DANFE é uma nota autorizada: 6) e danfe_emitted. O grupo
--    'authorized' segue [6] porque é o filtro "Autorizadas - Sem DANFE" do Origin; 'issued' ([6,7]) é o de todas as autorizadas.
-- 3. NFE-063/185: cada linha traz source_origin (origin, brufap_native, third_party, xml_import) e source_environment (o ambiente
--    da origem: tpAmb do XML importado, 357; o do XML arquivado do Origin; '2' das notas próprias de homologação), ao lado do
--    modelo e da environment de emissão, que não mudam.
-- 4. NFE-024/172: filtro Categoria (p_category_id, último e opcional): a categoria financeira das contas lançadas pela nota do
--    Brufap (247: invoice_posting ativo -> invoice_title -> title.category_id) ou pelo Faturamento agrupado ativo em que ela está
--    (grouped_billing_invoice ativo -> grouped_billing_title). As notas do Origin não têm contas vinculadas no Brufap (o espelho
--    financeiro não liga contas a notas nem categorias do Origin às do Brufap): a Categoria com a origem Origin é recusada como
--    consulta inválida, em vez de devolver uma lista vazia enganosa. Nenhuma conta é criada para preencher o filtro.
--    Loja e Filial não se aplicam: multiloja e multiempresa estão fora do escopo do Brufap (decisões recomendadas).
-- As duas funções públicas (erp_fiscal_invoice_list, 215; erp_catalog_invoice_list_tagged, 236) passam a usar uma única consulta
-- (erp_fiscal_invoices.list_query) com os mesmos filtros, a mesma resposta e o mesmo require_read. Somente leitura.
begin;

do $$declare r record;begin
 if to_regclass('erp_fiscal_invoices.origin_order_link') is null or to_regclass('erp_fiscal_invoices.invoice_source') is null
  or to_regclass('erp_finance.invoice_posting') is null or to_regclass('erp_finance.grouped_billing_invoice') is null then
  raise exception 'fiscal_invoice_list_358_requires_174_247_356_357' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_fiscal_invoices.list_rows(text,text,text,text)','76d2a6f899a425c6ee0cb47c5dad95606ef1224272c044814a4271aec89d0e57'),
  ('erp_fiscal_invoices.origin_status(jsonb)','0612de6f7c7fed236c243e799954c85c37a5ccd14437b5ecda52234244dc653d'),
  ('erp_fiscal_invoices.status_group(text)','d58d31423d911da459cb819067e6c020cf1a8f505a4238ae4a56db6cdc7f33e7'),
  ('public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid)','27d838fa0807600048e9b1b980fb6aa14b3acf08921a2a433654ec36de0cdb74'),
  ('public.erp_catalog_invoice_list_tagged(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid,text)','12a98ab4cc52f10fa785014a81b031df0703aaf3ec40f51c2aa75935c855175d'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'fiscal_invoice_list_358_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
end$$;

-- 113 with the Origin pedidos of 356 in orders/order_numbers (same columns, so the callers keep working).
create or replace function erp_fiscal_invoices.list_rows(p_origin text,p_model text,p_direction text,p_role text) returns table(
 origin text,id text,version integer,number integer,series integer,issue_date date,entry_date date,name text,trade_name text,document text,person_type text,
 email text,phone text,state text,nature text,status smallint,status_raw text,total numeric,environment text,issue_type text,access_key text,xml_id uuid,xml_hash text,xml_size integer,
 protocol_present boolean,event_count integer,carrier text,tracking text,contact_code text,product_ids uuid[],product_codes text[],orders jsonb,order_numbers text[])
language sql stable set search_path=pg_catalog as $$
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
 select 'origin',r.source_id,null,erp_fiscal_invoices.origin_int(to_jsonb(nullif(ltrim(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(r.payload->'numero',20)),'0'),''))),
  erp_fiscal_invoices.origin_int(r.payload->'serie'),erp_fiscal_invoices.origin_date(r.payload->'dataEmissao'),erp_fiscal_invoices.origin_date(r.payload->'dataOperacao'),
  erp_fiscal_invoices.scalar(r.payload#>'{contato,nome}',200),erp_fiscal_invoices.scalar(r.payload#>'{contato,fantasia}',200),
  nullif(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(r.payload#>'{contato,numeroDocumento}',30)),''),
  coalesce(case erp_fiscal_invoices.scalar(r.payload#>'{contato,tipoPessoa}',1) when 'J' then 'J' when 'F' then 'F' when 'E' then 'E' end,
   case length(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(r.payload#>'{contato,numeroDocumento}',30))) when 14 then 'J' when 11 then 'F' end),
  erp_fiscal_invoices.scalar(r.payload#>'{contato,email}',254),nullif(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(r.payload#>'{contato,telefone}',40)),''),
  upper(erp_fiscal_invoices.scalar(r.payload#>'{contato,endereco,uf}',2)),null,erp_fiscal_invoices.origin_status(r.payload->'situacao'),
  coalesce(erp_fiscal_invoices.scalar(r.payload#>'{situacao,id}',20),erp_fiscal_invoices.scalar(r.payload->'situacao',20)),
  erp_fiscal_invoices.origin_money(r.payload->'valorNota'),x.environment,null,case when erp_fiscal_invoices.scalar(r.payload->'chaveAcesso',44)~'^[0-9]{44}$' then r.payload->>'chaveAcesso' end,
  x.xml_id,x.xml_hash,x.xml_size,coalesce(x.protocol_present,false),coalesce(x.event_count,0),erp_fiscal_invoices.scalar(r.payload#>'{transporte,transportador,nome}',200),
  -- Código de rastreio: only the values of tracking keys (volumes[].codigoRastreamento), never the JSON key names or other transport data.
  (select left(string_agg(e.value#>>'{}',' ' order by e.value#>>'{}'),4000)
   from jsonb_path_query(case when jsonb_typeof(r.payload->'transporte')='object' then r.payload->'transporte' else '{}'::jsonb end,'strict $.**') o(node)
   cross join lateral jsonb_each(case when jsonb_typeof(o.node)='object' then o.node else '{}'::jsonb end) e
   where e.key ~* 'rastre' and jsonb_typeof(e.value) in('string','number')),ccr.payload->>'codigo',
  '{}'::uuid[],array(select erp_fiscal_invoices.scalar(e->'codigo',60) from jsonb_array_elements(case when jsonb_typeof(r.payload->'itens')='array' then r.payload->'itens' else '[]' end) e),
  -- 358 (NFE-027): the pedidos of the Origin that declare this note (notaFiscal.id), unless the id is ambiguous between nfe and nfce.
  coalesce(bo.orders,'[]'::jsonb),coalesce(bo.numbers,'{}'::text[])
 from origin_sync.raw_record r
 left join origin_sync.raw_record ccr on ccr.entity='contacts' and ccr.source_id=erp_fiscal_invoices.scalar(r.payload#>'{contato,id}',40)
 left join lateral(
  select (select i.id from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=s.current_revision and o.metadata->>'kind'='invoice' order by i.id limit 1) xml_id,
   (select o.hash from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=s.current_revision and o.metadata->>'kind'='invoice' order by i.id limit 1) xml_hash,
   (select o.size from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=s.current_revision and o.metadata->>'kind'='invoice' order by i.id limit 1) xml_size,
   (select o.metadata->>'environment' from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=s.current_revision and o.metadata->>'kind'='invoice' order by i.id limit 1) environment,
   (select bool_or((o.metadata->>'protocol_present')::boolean) from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=s.current_revision and o.metadata->>'kind'='invoice') protocol_present,
   (select count(*)::integer from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=s.current_revision and o.metadata->>'kind'='event') event_count
  from origin_fiscal.source s where s.entity=r.entity and s.source_id=r.source_id and s.access_key=r.payload->>'chaveAcesso' limit 1) x on true
 left join lateral(
  select jsonb_agg(jsonb_build_object('id',l.order_source_id,'kind','sales_orders','number',l.order_number,'date',l.order_date,'contact_name',l.contact_name)
    order by l.order_number::bigint,l.order_source_id) orders,array_agg(l.order_number order by l.order_number::bigint,l.order_source_id) numbers
  from erp_fiscal_invoices.origin_order_link l
  where l.invoice_source_id=r.source_id and l.order_number is not null
   and not exists(select 1 from origin_sync.raw_record a where a.entity=case r.entity when 'nfe' then 'nfce' else 'nfe' end and a.source_id=r.source_id)) bo on true
 where p_origin='origin' and r.entity=case p_model when '55' then 'nfe' else 'nfce' end
  and (p_model='65' or erp_fiscal_invoices.scalar(r.payload->'tipo',2)=p_direction)
  -- Homologation XMLs collected from Origin stay out of the Origin view, like Brufap's own tests.
  and x.environment is distinct from '2'
$$;

-- The single query of the list (215 and the Tags filter of 236), plus Categoria and the source attributes of each row.
create function erp_fiscal_invoices.list_query(p_user_id uuid,p_origin text,p_model text,p_direction text,p_page integer,p_limit integer,p_order text,p_query text,p_date_type text,
 p_date_from date,p_date_to date,p_status text,p_product_id uuid,p_state text,p_nature text,p_carrier text,p_trade_name text,p_person_type text,p_document text,p_email text,p_phone text,
 p_series integer,p_contact_code text,p_order_number text,p_tracking text,p_seller_id uuid,p_tagged boolean,p_tag text,p_category_id uuid) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_read(p_user_id);q text:=nullif(btrim(p_query),'');qd text;codes smallint[];product_code text;result jsonb;origin_sellers text[];
 v_entity text:=case p_model when '65' then 'nfce' else 'nfe' end;
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
   -- 215 "Vendedor": the seller of the Brufap note, or the Origin vendedor linked to the seller's contact.
   and (p_seller_id is null
    or (x.origin='brufap' and exists(select 1 from erp_fiscal_invoices.invoice v where v.id::text=x.id and v.seller_id=p_seller_id))
    or (x.origin='origin' and cardinality(origin_sellers)>0 and exists(select 1 from origin_sync.raw_record n where n.entity=v_entity and n.source_id=x.id
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
 return result;
end $$;

-- 215 plus Categoria (p_category_id, last and optional: the Worker sends it only when used).
drop function public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid);
create function public.erp_fiscal_invoice_list(p_user_id uuid,p_origin text default 'origin',p_model text default '55',p_direction text default '1',p_page integer default 1,
 p_limit integer default 100,p_order text default 'date_desc',p_query text default null,p_date_type text default 'issue',p_date_from date default null,p_date_to date default null,
 p_status text default null,p_product_id uuid default null,p_state text default null,p_nature text default null,p_carrier text default null,p_trade_name text default null,
 p_person_type text default null,p_document text default null,p_email text default null,p_phone text default null,p_series integer default null,p_contact_code text default null,
 p_order_number text default null,p_tracking text default null,p_seller_id uuid default null,p_category_id uuid default null) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select erp_fiscal_invoices.list_query(p_user_id,p_origin,p_model,p_direction,p_page,p_limit,p_order,p_query,p_date_type,p_date_from,p_date_to,p_status,p_product_id,p_state,p_nature,
  p_carrier,p_trade_name,p_person_type,p_document,p_email,p_phone,p_series,p_contact_code,p_order_number,p_tracking,p_seller_id,false,null,p_category_id)
$$;

-- 236 plus Categoria.
drop function public.erp_catalog_invoice_list_tagged(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid,text);
create function public.erp_catalog_invoice_list_tagged(p_user_id uuid,p_origin text default 'origin',p_model text default '55',p_direction text default '1',p_page integer default 1,
 p_limit integer default 100,p_order text default 'date_desc',p_query text default null,p_date_type text default 'issue',p_date_from date default null,p_date_to date default null,
 p_status text default null,p_product_id uuid default null,p_state text default null,p_nature text default null,p_carrier text default null,p_trade_name text default null,
 p_person_type text default null,p_document text default null,p_email text default null,p_phone text default null,p_series integer default null,p_contact_code text default null,
 p_order_number text default null,p_tracking text default null,p_seller_id uuid default null,p_tag text default null,p_category_id uuid default null) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select erp_fiscal_invoices.list_query(p_user_id,p_origin,p_model,p_direction,p_page,p_limit,p_order,p_query,p_date_type,p_date_from,p_date_to,p_status,p_product_id,p_state,p_nature,
  p_carrier,p_trade_name,p_person_type,p_document,p_email,p_phone,p_series,p_contact_code,p_order_number,p_tracking,p_seller_id,true,p_tag,p_category_id)
$$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid,uuid)',
  'erp_catalog_invoice_list_tagged(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid,text,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
