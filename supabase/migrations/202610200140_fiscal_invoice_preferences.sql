-- Preferências › Notas Fiscais (migração 115) passam a valer nas notas do Brufap:
-- o contexto do formulário devolve os padrões de preenchimento, grupos visíveis, pessoas autorizadas e travas de edição,
-- e a listagem devolve "Exibir totais em listas de Notas Fiscais". Só leitura de preferências: nada aqui emite, transmite,
-- reserva número ou lança estoque/contas, e as travas de ambiente 022/041/046/064 não mudam.
begin;
-- Current company value (or the page default) of one preference; the fallback keeps the type the caller expects.
create function erp_fiscal_invoices.preference(p_key text,p_type text,p_default jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v jsonb;
begin
 if to_regprocedure('erp_preferences.get(text,uuid)') is not null then execute 'select erp_preferences.get($1,null)' into v using p_key; end if;
 if v is null or jsonb_typeof(v)<>p_type then return p_default; end if;
 return v;
end $$;
-- Preferences the note form and list follow. NFC-e reads its own groups and authorized people (Configurações de NFC-e);
-- the remaining fill-in defaults come from Configurações de NF-e, like Origin reuses the note form for NFC-e.
create function erp_fiscal_invoices.invoice_preferences(p_model text) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare p text:=case when p_model='65' then 'nfce' else 'nfe' end;b text:='boolean';
 people jsonb;validation jsonb;freight text;species text;markup text;volumes jsonb;
begin
 people:=erp_fiscal_invoices.preference(p||'.autxml_pessoas','array','[]');
 -- Only well-formed {document,name} rows (11 or 14 digits, distinct) reach the form; the page validated them on save.
 select coalesce(jsonb_agg(jsonb_build_object('document',x->>'document','name',left(x->>'name',60)) order by n),'[]') into people
 from jsonb_array_elements(people) with ordinality t(x,n)
 where n<=10 and jsonb_typeof(x)='object' and x->>'document'~'^([0-9]{11}|[0-9]{14})$' and jsonb_typeof(x->'name')='string';
 validation:=erp_fiscal_invoices.preference('nfe.validacao_opcional','array','[]');
 freight:=erp_fiscal_invoices.preference('nfe.frete_por_conta','string','"9"')#>>'{}';
 species:=erp_fiscal_invoices.preference('nfe.especie_padrao','string','"volumes"')#>>'{}';
 markup:=erp_fiscal_invoices.preference('nfe.markup','string','"0"')#>>'{}';
 volumes:=erp_fiscal_invoices.preference('nfe.volume_padrao','number','0');
 return jsonb_build_object(
  'show_totals',erp_fiscal_invoices.preference('nfe.exibir_totais',b,'true'),
  'freight_by',case when freight in('0','1','2','3','4','9') then freight else '9' end,
  'species',case when species in('outros','volumes','unidades','caixas','pacotes','envelopes') then species else 'volumes' end,
  'volume_quantity',case when volumes::text~'^[0-9]{1,5}$' then volumes else '0'::jsonb end,
  'markup',case when markup~'^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$' then markup else '0' end,
  'sum_weight',erp_fiscal_invoices.preference('nfe.somar_peso',b,'false'),
  'compute_volume',erp_fiscal_invoices.preference('nfe.calcular_volume',b,'false'),
  'ipi_first_installment',erp_fiscal_invoices.preference('nfe.ipi_primeira_parcela',b,'false'),
  'st_first_installment',erp_fiscal_invoices.preference('nfe.st_primeira_parcela',b,'false'),
  'tracking_in_info',erp_fiscal_invoices.preference('nfe.rastreio_infcpl',b,'false'),
  'purchase_order_in_info',erp_fiscal_invoices.preference('nfe.ordem_compra_infcpl',b,'false'),
  'simples_credit_message',erp_fiscal_invoices.preference('nfe.mensagem_credito_simples',b,'false'),
  'optional_installments',validation ? 'parcelas',
  'fuel_group',erp_fiscal_invoices.preference(p||'.grupo_combustiveis',b,'false'),
  'weapon_group',erp_fiscal_invoices.preference(p||'.grupo_armamento',b,'false'),
  'vehicle_group',erp_fiscal_invoices.preference(p||'.grupo_veiculos',b,'false'),
  'retention_group',case when p_model='65' then 'false'::jsonb else erp_fiscal_invoices.preference('nfe.grupo_retencao',b,'false') end,
  'autxml_carrier',erp_fiscal_invoices.preference(p||'.autxml_transportadora',b,'false'),
  'autxml_people',people,
  'block_edit_stock',erp_fiscal_invoices.preference('nfe.bloquear_edicao_estoque',b,'false'),
  'block_edit_finance',erp_fiscal_invoices.preference('nfe.bloquear_edicao_contas',b,'false'));
end $$;

create or replace function public.erp_fiscal_invoice_context(p_user_id uuid,p_model text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);company jsonb;series jsonb:='[]';
begin
 if p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 select jsonb_build_object('crt',f.crt,'regime_confirmed',f.crt is not null,'state',i.data->>'state','cnpj_present',nullif(i.data->>'cnpj','') is not null)
 into company from erp_company.identity i left join erp_company.fiscal f using(singleton) where i.singleton;
 if to_regclass('erp_fiscal_numbering.series') is not null then
  execute 'select coalesce(jsonb_agg(jsonb_build_object(''series'',series,''next_number'',next_number,''enabled'',enabled) order by series),''[]''::jsonb)
   from erp_fiscal_numbering.series where model=$1 and environment=''2''' into series using p_model;
 end if;
 return jsonb_build_object('company',coalesce(company,jsonb_build_object('crt',null,'regime_confirmed',false,'state',null,'cnpj_present',false)),'series',series,
  'defaults',coalesce((select jsonb_object_agg(d.code,jsonb_build_object('id',n.id,'description',n.description)) from erp_fiscal_invoices.nature_default d
   join erp_fiscal_invoices.nature n on n.id=d.nature_id where n.active),'{}'::jsonb),
  'preferences',erp_fiscal_invoices.invoice_preferences(p_model),
  'writable',true,'emission_enabled',false,'production_enabled',false,'data_mode','erp_native');
end $$;

create or replace function public.erp_fiscal_invoice_list(p_user_id uuid,p_origin text default 'origin',p_model text default '55',p_direction text default '1',p_page integer default 1,
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
  'amount_unknown',(select count(*)::integer from rows where total is null),'brufap_visible',role in('admin','fiscal'),
  -- "Exibir totais em listas de Notas Fiscais": the list hides Quantidade and Valor total when it is off.
  'show_totals',erp_fiscal_invoices.preference('nfe.exibir_totais','boolean','true'),
  'data_mode',case p_origin when 'origin' then 'origin_mirror_readonly' else 'erp_native_homologation' end)
 into result;
 return result;
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_invoice_context(uuid,text),
 public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_context(uuid,text),
 public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text) to service_role;
commit;
