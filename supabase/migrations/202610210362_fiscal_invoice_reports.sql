-- 362 (leva H, lane espelho): Relatórios de Notas Fiscais do Origin (Relatórios de vendas), somente leitura, sobre notas reais:
-- * erp_fiscal_report_difal: "Notas Fiscais ICMS DIFAL" por período e UF de destino (VND-265).
-- * erp_fiscal_report_invoices: "Notas Fiscais por Operação", "por Cliente", "por Produto" e "Evolução do Faturamento" (VND-266).
-- Notas reais de faturamento são as notas de saída autorizadas ou registradas de duas origens:
-- * XML importado (Importação de XML de saída, issue_type S, sem ambiente, com o XML guardado em invoice_xml, 143/274);
-- * espelho do Origin (origin_sync.raw_record nfe de saída e nfce), situação Autorizada, Emitida DANFE ou Registrada (113).
-- A nota que existe nas duas origens (mesma chave de acesso) conta uma vez, pelo XML. As notas próprias do Brufap são de
-- homologação (ambiente 2) e nunca entram no faturamento; canceladas, denegadas e pendentes também não entram. Faturamento
-- fiscal é separado de pedidos e recebimentos: nada aqui lê pedidos, contas ou baixas.
-- DIFAL: só o XML autorizado traz o grupo ICMSTot (vICMSUFDest, vICMSUFRemet, vFCPUFDest). As notas do Origin ficam como
-- "sem detalhamento" (o XML delas está só no Storage), contadas na cobertura e nunca somadas como zero. Uma nota do XML sem
-- esses campos tem DIFAL zero declarado pelo próprio XML. Cada resposta traz a origem, a cobertura e a data da última
-- sincronização das notas do Origin. Nenhum efeito é criado; as travas 022/041/046/064 não mudam.
-- Acesso: quem lê as notas (erp_fiscal_invoices.require_read: administrador, consulta e fiscal) com a permissão Notas Fiscais.
begin;

-- The DIFAL group of an authorized XML: the ICMSTot totals and the destination UF, or null when the XML gives no detail.
create function erp_fiscal_invoices.report_difal_xml(p_content text) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare x xml;ns text[]:=array[array['n','http://www.portalfiscal.inf.br/nfe']];tot integer;v_dest text;v_remet text;v_fcp text;v_uf text;
begin
 if p_content is null or not xml_is_well_formed_document(p_content) then return null; end if;
 x:=xmlparse(document p_content);
 tot:=cardinality(xpath('//n:infNFe/n:total/n:ICMSTot',x,ns));
 if tot<>1 then return null; end if;
 v_dest:=(xpath('//n:infNFe/n:total/n:ICMSTot/n:vICMSUFDest/text()',x,ns))[1]::text;
 v_remet:=(xpath('//n:infNFe/n:total/n:ICMSTot/n:vICMSUFRemet/text()',x,ns))[1]::text;
 v_fcp:=(xpath('//n:infNFe/n:total/n:ICMSTot/n:vFCPUFDest/text()',x,ns))[1]::text;
 v_uf:=(xpath('//n:infNFe/n:dest/n:enderDest/n:UF/text()',x,ns))[1]::text;
 if (v_dest is not null and v_dest!~'^[0-9]{1,13}(\.[0-9]{1,2})?$') or (v_remet is not null and v_remet!~'^[0-9]{1,13}(\.[0-9]{1,2})?$')
  or (v_fcp is not null and v_fcp!~'^[0-9]{1,13}(\.[0-9]{1,2})?$') then return null; end if;
 return jsonb_build_object('dest',coalesce(v_dest::numeric,0),'remet',coalesce(v_remet::numeric,0),'fcp',coalesce(v_fcp::numeric,0),
  'declared',v_dest is not null or v_remet is not null or v_fcp is not null,'state',case when v_uf ~ '^[A-Z]{2}$' then v_uf end);
exception when others then return null;
end $$;

-- The real notes of faturamento issued in the period, one row per note (the XML wins over the Origin mirror for the same key).
create function erp_fiscal_invoices.report_notes(p_from date,p_to date) returns table(
 origin text,ref text,model text,number integer,series integer,issue_date date,contact_key text,contact_name text,contact_document text,
 state text,nature_key text,nature text,total numeric,invoice_id uuid,payload jsonb)
language sql stable set search_path=pg_catalog as $$
 select 'xml',v.id::text,v.model,v.number,v.series,v.issue_date,
  coalesce('doc:'||nullif(erp_fiscal_invoices.digits(v.recipient->>'document'),''),'nome:'||lower(nullif(btrim(v.recipient->>'name'),''))),
  nullif(btrim(v.recipient->>'name'),''),nullif(erp_fiscal_invoices.digits(v.recipient->>'document'),''),upper(nullif(v.recipient->>'state','')),
  'xml:'||lower(btrim(v.nature_description)),v.nature_description,erp_fiscal_invoices.origin_money(v.totals->'total'),v.id,null::jsonb
 from erp_fiscal_invoices.invoice v
 where v.issue_type='S' and v.direction='1' and v.environment is null and v.deleted_at is null and v.status in(6,7,8)
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
 from origin_sync.raw_record r
 cross join lateral(select erp_fiscal_invoices.origin_date(r.payload->'dataEmissao') issue_date,erp_fiscal_invoices.origin_status(r.payload->'situacao') status,
   nullif(btrim(erp_fiscal_invoices.scalar(r.payload#>'{contato,nome}',200)),'') name,
   nullif(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(r.payload#>'{contato,numeroDocumento}',30)),'') document,
   case when erp_fiscal_invoices.scalar(r.payload#>'{naturezaOperacao,id}',20)~'^[1-9][0-9]{0,19}$' then r.payload#>>'{naturezaOperacao,id}' end nature_id) b
 where r.entity in('nfe','nfce') and (r.entity='nfce' or erp_fiscal_invoices.scalar(r.payload->'tipo',2)='1')
  and b.status in(6,7,8) and b.issue_date between p_from and p_to
  and not exists(select 1 from erp_fiscal_invoices.invoice v where v.issue_type='S' and v.deleted_at is null and v.access_key is not null
   and v.access_key=erp_fiscal_invoices.scalar(r.payload->'chaveAcesso',44))
$$;

-- Where the numbers come from: imported XMLs (last import) and the Origin mirror (last time the collector saw a note).
create function erp_fiscal_invoices.report_sources(p_xml integer,p_origin integer) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('xml_notes',p_xml,'origin_notes',p_origin,
  'xml_imported_at',(select max(x.imported_at) from erp_fiscal_invoices.invoice_xml x join erp_fiscal_invoices.invoice v on v.id=x.invoice_id where v.issue_type='S' and v.direction='1'),
  'origin_synced_at',(select max(r.last_seen_at) from origin_sync.raw_record r where r.entity in('nfe','nfce')))
$$;
create function erp_fiscal_invoices.report_period(p_from text,p_to text,p_days integer) returns daterange language plpgsql immutable set search_path=pg_catalog as $$
declare v_from date;v_to date;
begin
 if p_from !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' or p_to !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' then raise exception 'erp_fiscal_report_invalid' using errcode='22023'; end if;
 begin v_from:=p_from::date;v_to:=p_to::date; exception when others then raise exception 'erp_fiscal_report_invalid' using errcode='22023'; end;
 if v_from::text<>p_from or v_to::text<>p_to or v_from>v_to or v_to-v_from>p_days then raise exception 'erp_fiscal_report_invalid' using errcode='22023'; end if;
 return daterange(v_from,v_to,'[]');
end $$;
create function erp_fiscal_invoices.report_access(p_user_id uuid) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 perform erp_fiscal_invoices.require_read(p_user_id);
 perform erp_access.require_permission(p_user_id,'vendas.notas_fiscais');
end $$;

-- "Notas Fiscais ICMS DIFAL": NF-e de saída by destination UF. Values come only from the XMLs; Origin notes are counted as
-- without detail and the UF total stays null (indisponível) when none of its notes has detail.
create function public.erp_fiscal_report_difal(p_user_id uuid,p_from text,p_to text,p_state text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
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
   where n.model='55'),
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
end $$;

-- Notas Fiscais por Operação (natureza), por Cliente, por Produto (itens) e Evolução do Faturamento (meses do período).
-- Groups carry key, label, document (CPF/CNPJ of the client or code of the product), notes, amount and the notes of each origin;
-- an amount is null (indisponível) when no note of the group brings its value.
create function public.erp_fiscal_report_invoices(p_user_id uuid,p_report text,p_from text,p_to text,p_model text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_period daterange;v_from date;v_to date;v_result jsonb;
begin
 perform erp_fiscal_invoices.report_access(p_user_id);
 if p_report is null or p_report not in('operation','contact','product','billing') or (p_model is not null and p_model not in('55','65')) then
  raise exception 'erp_fiscal_report_invalid' using errcode='22023'; end if;
 v_period:=erp_fiscal_invoices.report_period(p_from,p_to,case when p_report='billing' then 731 else 366 end);
 v_from:=lower(v_period);v_to:=upper(v_period)-1;
 with notes as materialized(select n.* from erp_fiscal_invoices.report_notes(v_from,v_to) n where p_model is null or n.model=p_model),
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
end $$;

revoke all on function erp_fiscal_invoices.report_difal_xml(text),erp_fiscal_invoices.report_notes(date,date),erp_fiscal_invoices.report_sources(integer,integer),
 erp_fiscal_invoices.report_period(text,text,integer),erp_fiscal_invoices.report_access(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_report_difal(uuid,text,text,text),public.erp_fiscal_report_invoices(uuid,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_fiscal_report_difal(uuid,text,text,text),public.erp_fiscal_report_invoices(uuid,text,text,text,text) to service_role;
commit;
