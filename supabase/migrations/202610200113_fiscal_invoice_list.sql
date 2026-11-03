-- Listagem de notas fiscais no padrão Origin (saída, NFC-e e entrada), somente leitura.
-- Duas visões, como a convivência exige: "Notas do Origin" lê o espelho (origin_sync.raw_record + acervo XML 027) para
-- admin, consulta e fiscal; "Testes de homologação do Brufap" lê as notas próprias (112) só para admin e fiscal.
-- As notas de homologação nunca entram na visão do Origin nem nos totais dela. Nenhuma função aqui escreve.
-- A situação da API v3 do Origin é convertida para o código da tela do Origin (ver origin_status); mapeamento a conferir.
begin;
create function erp_fiscal_invoices.digits(p_value text) returns text language sql immutable set search_path=pg_catalog as $$
 select regexp_replace(coalesce(p_value,''),'[^0-9]','','g')
$$;
create function erp_fiscal_invoices.scalar(p_value jsonb,p_max integer) returns text language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(p_value) in('string','number') and length(p_value#>>'{}') between 1 and p_max and (p_value#>>'{}')!~'[[:cntrl:]]' then p_value#>>'{}' end
$$;
create function erp_fiscal_invoices.origin_money(p_value jsonb) returns numeric language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(p_value) in('string','number') and (p_value#>>'{}')~'^-?[0-9]{1,13}(\.[0-9]{1,10})?$' then round((p_value#>>'{}')::numeric,2) end
$$;
create function erp_fiscal_invoices.origin_date(p_value jsonb) returns date language plpgsql immutable set search_path=pg_catalog as $$
declare v text:=left(erp_fiscal_invoices.scalar(p_value,40),10);
begin
 if v is null or v !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' then return null; end if;
 return v::date;
exception when others then return null;
end $$;
create function erp_fiscal_invoices.origin_int(p_value jsonb) returns integer language sql immutable set search_path=pg_catalog as $$
 select case when erp_fiscal_invoices.scalar(p_value,20)~'^[0-9]{1,9}$' then (p_value#>>'{}')::integer end
$$;
-- API v3: 1 Pendente, 2 Cancelada, 3 Aguardando recibo, 4 Rejeitada, 5 Autorizada, 6 Emitida DANFE, 7 Registrada,
-- 8 Aguardando protocolo, 9 Denegada, 10 Consulta situação, 11 Bloqueada. Screen codes are the ones of 112.
create function erp_fiscal_invoices.origin_status(p_value jsonb) returns smallint language sql immutable set search_path=pg_catalog as $$
 select case coalesce(erp_fiscal_invoices.scalar(p_value->'id',4),erp_fiscal_invoices.scalar(p_value,4))
  when '1' then 1 when '2' then 3 when '3' then 4 when '4' then 5 when '5' then 6 when '6' then 7 when '7' then 8
  when '8' then 9 when '9' then 10 when '10' then 11 when '11' then 12 end::smallint
$$;
create function erp_fiscal_invoices.status_group(p_group text) returns smallint[] language sql immutable set search_path=pg_catalog as $$
 select case p_group when 'pending' then array[1,5] when 'issued' then array[6,7] when 'authorized' then array[6] when 'cancelled' then array[3]
  when 'denied' then array[10] when 'registered' then array[8] when 'contingency' then array[2] end::smallint[]
$$;

create function erp_fiscal_invoices.list_rows(p_origin text,p_model text,p_direction text,p_role text) returns table(
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
  '[]'::jsonb,'{}'::text[]
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
 where p_origin='origin' and r.entity=case p_model when '55' then 'nfe' else 'nfce' end
  and (p_model='65' or erp_fiscal_invoices.scalar(r.payload->'tipo',2)=p_direction)
  -- Homologation XMLs collected from Origin stay out of the Origin view, like Brufap's own tests.
  and x.environment is distinct from '2'
$$;

create function public.erp_fiscal_invoice_list(p_user_id uuid,p_origin text default 'origin',p_model text default '55',p_direction text default '1',p_page integer default 1,
 p_limit integer default 100,p_order text default 'date_desc',p_query text default null,p_date_type text default 'issue',p_date_from date default null,p_date_to date default null,
 p_status text default null,p_product_id uuid default null,p_state text default null,p_nature text default null,p_carrier text default null,p_trade_name text default null,
 p_person_type text default null,p_document text default null,p_email text default null,p_phone text default null,p_series integer default null,p_contact_code text default null,
 p_order_number text default null,p_tracking text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_read(p_user_id);q text:=nullif(btrim(p_query),'');qd text;codes smallint[];product_code text;result jsonb;
begin
 if p_origin is null or p_origin not in('origin','brufap') or p_model is null or p_model not in('55','65') or p_direction is null or p_direction not in('0','1') or (p_model='65' and p_direction<>'1')
  or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or p_order is null or p_order not in('date_desc','date_asc','number_desc','number_asc')
  or p_date_type is null or p_date_type not in('issue','entry') or (p_date_from is not null and p_date_to is not null and p_date_from>p_date_to)
  or (p_status is not null and erp_fiscal_invoices.status_group(p_status) is null) or (p_state is not null and not p_state=any(erp_fiscal_invoices.ufs()||array['EX']))
  or (p_person_type is not null and p_person_type not in('J','F','E')) or (p_series is not null and p_series not between 0 and 999)
  or exists(select 1 from unnest(array[p_query,p_nature,p_carrier,p_trade_name,p_document,p_email,p_phone,p_contact_code,p_order_number,p_tracking]) t where length(t)>120 or t~'[[:cntrl:]]') then
  raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 if p_origin='brufap' and role not in('admin','fiscal') then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 qd:=erp_fiscal_invoices.digits(q);codes:=erp_fiscal_invoices.status_group(p_status);
 if p_product_id is not null then select code into product_code from erp_catalog.record where id=p_product_id and entity='products'; end if;
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
 ),ordered as(
  select r.*,row_number() over(order by
   case when p_order='date_desc' then r.issue_date end desc nulls last,case when p_order='date_asc' then r.issue_date end asc nulls last,
   case when p_order in('number_desc','date_desc') then r.number end desc nulls last,case when p_order in('number_asc','date_asc') then r.number end asc nulls last,
   r.origin,r.id desc) ord from rows r
 ),page as(select * from ordered where ord>(p_page-1)::bigint*p_limit and ord<=p_page::bigint*p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('origin',p.origin,'id',p.id,'version',p.version,'number',p.number,'series',p.series,
   'issue_date',p.issue_date,'entry_date',p.entry_date,'name',p.name,'document',p.document,'state',p.state,'nature',p.nature,'status',p.status,'status_raw',p.status_raw,
   'total',erp_fiscal_invoices.money_text(p.total),'total_known',p.total is not null,'environment',p.environment,'issue_type',p.issue_type,'access_key',p.access_key,
   'xml_id',p.xml_id,'xml_hash',p.xml_hash,'xml_size',p.xml_size,'protocol_present',p.protocol_present,'event_count',p.event_count,'orders',p.orders) order by p.ord)
   from page p),'[]'::jsonb),
  'origin',p_origin,'model',p_model,'direction',p_direction,'page',p_page,'limit',p_limit,'order',p_order,'has_more',(select count(*) from rows)>p_page::bigint*p_limit,
  'total_count',(select count(*)::integer from rows),'total_amount',erp_fiscal_invoices.money_text((select sum(total) from rows)),
  'amount_unknown',(select count(*)::integer from rows where total is null),'brufap_visible',role in('admin','fiscal'),'data_mode',case p_origin when 'origin' then 'origin_mirror_readonly' else 'erp_native_homologation' end)
 into result;
 return result;
end $$;

-- Read-only projection of one Origin note: allowlisted fields only, never the signed XML/DANFE URLs of the payload.
create function public.erp_fiscal_invoice_origin_get(p_user_id uuid,p_entity text,p_source_id text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare r origin_sync.raw_record%rowtype;p jsonb;v_xml uuid;v_hash text;v_size integer;v_env text;v_protocol text;v_events jsonb;result jsonb;
begin
 perform erp_fiscal_invoices.require_read(p_user_id);
 if p_entity is null or p_entity not in('nfe','nfce') or p_source_id is null or p_source_id !~ '^[0-9]{1,40}$' then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 select * into r from origin_sync.raw_record where entity=p_entity and source_id=p_source_id;
 if not found then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 p:=r.payload;
 select (select i.id from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=fs.current_revision and o.metadata->>'kind'='invoice' order by i.id limit 1) xml_id,
  (select o.hash from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=fs.current_revision and o.metadata->>'kind'='invoice' order by i.id limit 1) xml_hash,
  (select o.size from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=fs.current_revision and o.metadata->>'kind'='invoice' order by i.id limit 1) xml_size,
  (select o.metadata->>'environment' from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=fs.current_revision and o.metadata->>'kind'='invoice' order by i.id limit 1) environment,
  (select o.metadata->>'protocol' from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=fs.current_revision and o.metadata->>'kind'='invoice' order by i.id limit 1) protocol,
  coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'type',o.metadata->>'event_type','sequence',o.metadata->>'event_sequence','hash',o.hash,'size',o.size) order by o.metadata->>'event_type',o.metadata->>'event_sequence',i.id)
   from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=fs.current_revision and o.metadata->>'kind'='event'),'[]'::jsonb) events
 into v_xml,v_hash,v_size,v_env,v_protocol,v_events from origin_fiscal.source fs where fs.entity=r.entity and fs.source_id=r.source_id and fs.access_key=p->>'chaveAcesso' limit 1;
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
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text),
 public.erp_fiscal_invoice_origin_get(uuid,text,text) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text),
 public.erp_fiscal_invoice_origin_get(uuid,text,text) to service_role;
commit;
