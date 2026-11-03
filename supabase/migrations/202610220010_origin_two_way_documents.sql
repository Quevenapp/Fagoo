-- Mão dupla com o Origin, parte 2: cadastros (contatos e produtos) e documentos comerciais (propostas, pedidos de venda,
-- pedidos de compra e OS).
-- * Envio: erp_sync.request monta, a partir do registro nativo, a requisição da API v3 do Origin. Uma atualização parte do
--   último detalhe lido do Origin (PUT substitui o registro inteiro), sobrepondo os campos que o Brufap mantém, para não apagar
--   no Origin o que o Brufap não modela. Documento cujo contato ou produto ainda não existe no Origin espera o envio dele.
-- * Recebimento: erp_sync.pull_catalog e erp_sync.pull_document gravam a versão do Origin nas tabelas nativas, como o ator
--   técnico, com erp_sync.applying ligado. Um documento espelhado (006) é convertido para o modelo nativo (authority='brufap').
-- * Alteração mais recente vence: se o Brufap tem envio pendente mais novo que a alteração vista no Origin, a versão do Origin
--   é ignorada (o envio a sobrescreve); senão a versão do Origin é aplicada e o envio pendente é descartado.
-- * A API v3 do Origin não tem escrita de ordens de serviço: OS do Origin chegam ao Brufap, mas OS do Brufap não vão ao Origin.
begin;
do $$begin
 if to_regclass('erp_sync.outbox') is null then raise exception 'origin_two_way_010_requires_009' using errcode='55000'; end if;
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Conversões
create function erp_sync.num(p_value text) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select case when p_value ~ '^-?[0-9]+(\.[0-9]+)?$' then to_jsonb(p_value::numeric) end
$$;
create function erp_sync.num(p_value numeric) returns jsonb
language sql immutable set search_path=pg_catalog as $$ select to_jsonb(p_value) $$;
create function erp_sync.origin_number(p_value jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(p_value) in('number','string') and (p_value#>>'{}')~'^-?[0-9]{1,15}(\.[0-9]+)?$' then (p_value#>>'{}')::numeric::text end
$$;
create function erp_sync.origin_ref(p_value jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(p_value) in('number','string') and (p_value#>>'{}')~'^[1-9][0-9]{0,39}$' then p_value#>>'{}' end
$$;
-- Detalhe atual do Origin para o registro, sem campos somente leitura nem marcas internas do coletor.
create function erp_sync.base_payload(p_entity text,p_origin text) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce((select jsonb_object_agg(k,v) from origin_sync.raw_record r cross join lateral jsonb_each(r.payload) e(k,v)
   where r.entity=p_entity and r.source_id=p_origin and k not like '\_%'
    and k not in('id','total','totalProdutos','totalServicos','notaFiscal','saldo','borderos','numeroBanco','situacao','imagemURL','fornecedor','linkBoleto','linkQRCodePix')),'{}'::jsonb)
$$;
create function erp_sync.priority(p_entity text,p_op text) returns integer
language sql immutable set search_path=pg_catalog as $$
 select case when p_entity='contacts' then 1 when p_entity='products' then 2
  when p_entity in('sales_proposals','sales_orders','purchase_orders','service_orders') then 3
  when p_op='settle' then 5 when p_entity in('receivables','payables') then 4 else 6 end
$$;

-- Situação: Origin -> Brufap pelo mapa; o mapa aprende os IDs de situação que aparecem junto com o valor herdado.
create function erp_sync.origin_status(p_entity text,p_payload jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select case p_entity
  when 'sales_proposals' then case when jsonb_typeof(p_payload->'situacao')='string' then left(p_payload->>'situacao',80) end
  when 'purchase_orders' then coalesce(erp_sync.origin_ref(p_payload#>'{situacao,id}'),
   case when (p_payload#>>'{situacao,valor}')~'^[0-9]{1,3}$' then 'valor:'||(p_payload#>>'{situacao,valor}') end)
  else erp_sync.origin_ref(p_payload#>'{situacao,id}') end
$$;
create function erp_sync.native_status(p_entity text,p_payload jsonb) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare v_status text:=erp_sync.origin_status(p_entity,p_payload); v_native text; v_valor text:=p_payload#>>'{situacao,valor}';
begin
 if v_status is null then return null; end if;
 select native_status into v_native from erp_sync.status_map where entity=p_entity and origin_status=v_status;
 if v_native is null and p_entity='purchase_orders' and v_valor~'^[0-9]{1,3}$' then
  select native_status into v_native from erp_sync.status_map where entity=p_entity and origin_status='valor:'||v_valor;
  if v_native is not null and v_status~'^[0-9]+$' then
   insert into erp_sync.status_map(entity,origin_status,native_status,push)
   values(p_entity,v_status,v_native,not exists(select 1 from erp_sync.status_map where entity=p_entity and native_status=v_native and push))
   on conflict do nothing;
  end if;
 end if;
 return v_native;
end$$;
create function erp_sync.push_status(p_entity text,p_native text) returns text
language sql stable security definer set search_path=pg_catalog as $$
 select origin_status from erp_sync.status_map where entity=p_entity and native_status=p_native and push
$$;

-- Formas de pagamento: pela descrição, nos dois sentidos (a forma do Origin está na área bruta, a do Brufap no cadastro).
create function erp_sync.payment_method_origin(p_native uuid) returns text
language sql stable security definer set search_path=pg_catalog as $$
 select r.source_id from erp_catalog.payment_method m join origin_sync.raw_record r on r.entity='payment_methods'
  and lower(btrim(r.payload->>'descricao'))=lower(btrim(m.description))
 where m.id=p_native order by (r.payload->>'situacao')='1' desc,r.source_id limit 1
$$;
create function erp_sync.payment_method_native(p_origin text) returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select m.id from origin_sync.raw_record r join erp_catalog.payment_method m on lower(btrim(m.description))=lower(btrim(r.payload->>'descricao'))
 where r.entity='payment_methods' and r.source_id=p_origin order by m.deleted_at is null desc,m.active desc,m.id limit 1
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Envio de cadastros
create function erp_sync.catalog_request(p_entity text,p_id uuid,p_op text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare r erp_catalog.record; c erp_catalog.contact; cp erp_catalog.contact_profile; p erp_catalog.product; pd erp_catalog.product_detail;
 v_origin text:=erp_sync.origin_id(p_entity,p_id); v_path text:=case p_entity when 'contacts' then '/contatos' else '/produtos' end;
 b jsonb; v_status text;
begin
 select * into r from erp_catalog.record where id=p_id and entity=p_entity;
 if p_op='delete' or not found then
  if v_origin is null then return jsonb_build_object('skip','NOT_IN_ORIGIN'); end if;
  return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','PATCH','path',v_path||'/'||v_origin||'/situacoes','body',jsonb_build_object('situacao','E')))
   ,'origin_id',v_origin,'fetch',v_path||'/'||v_origin,'deleted',true);
 end if;
 b:=coalesce(erp_sync.base_payload(p_entity,v_origin),'{}'::jsonb);
 if p_entity='contacts' then
  select * into c from erp_catalog.contact where record_id=p_id;
  select * into cp from erp_catalog.contact_profile where record_id=p_id;
  -- Situação do contato (A, I, S, E) é a do Brufap (erp_catalog_contact_set_situation); Excluído vai como exclusão no Origin.
  if cp.situation='E' then
   if v_origin is null then return jsonb_build_object('skip','NOT_IN_ORIGIN'); end if;
   return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','PATCH','path',v_path||'/'||v_origin||'/situacoes','body',jsonb_build_object('situacao','E'))),
    'origin_id',v_origin,'fetch',v_path||'/'||v_origin,'deleted',true);
  end if;
  v_status:=case when cp.situation in('A','I','S') then cp.situation when not r.active then 'I' when b->>'situacao'='S' then 'S' else 'A' end;
  b:=b||jsonb_strip_nulls(jsonb_build_object('nome',left(r.name,120),'codigo',r.code,'situacao',v_status,
   'tipo',coalesce(c.person_type,case when length(regexp_replace(coalesce(c.document,''),'\D','','g'))=11 then 'F' else 'J' end),
   'numeroDocumento',c.document,'ie',c.ie,'email',c.email,'telefone',c.phone,'celular',c.mobile,'fantasia',c.trade_name,
   'rg',cp.rg,'orgaoEmissor',cp.rg_issuer,'inscricaoMunicipal',cp.municipal_registration,'emailNotaFiscal',cp.nfe_email,
   'indicadorIe',case when cp.taxpayer~'^[129]$' then to_jsonb(cp.taxpayer::integer) end));
  b:=jsonb_set(b,'{endereco}',coalesce(b->'endereco','{}'::jsonb)||jsonb_build_object(
   'geral',coalesce(b#>'{endereco,geral}','{}'::jsonb)||jsonb_strip_nulls(jsonb_build_object('endereco',c.street,'numero',c.number,'complemento',c.complement,
    'bairro',c.district,'municipio',c.city,'uf',c.state,'cep',c.postal_code)))
   ||case when cp.billing_street is not null or cp.billing_city is not null then jsonb_build_object('cobranca',coalesce(b#>'{endereco,cobranca}','{}'::jsonb)
    ||jsonb_strip_nulls(jsonb_build_object('endereco',cp.billing_street,'numero',cp.billing_number,'complemento',cp.billing_complement,
     'bairro',cp.billing_district,'municipio',cp.billing_city,'uf',cp.billing_state,'cep',cp.billing_postal_code))) else '{}'::jsonb end);
  if cp.credit_limit is not null or cp.payment_condition is not null then
   b:=jsonb_set(b,'{financeiro}',coalesce(b->'financeiro','{}'::jsonb)||jsonb_strip_nulls(jsonb_build_object('limiteCredito',erp_sync.num(cp.credit_limit),'condicaoPagamento',cp.payment_condition)));
  end if;
  if cp.birth_date is not null or cp.gender is not null or cp.birthplace is not null then
   b:=jsonb_set(b,'{dadosAdicionais}',coalesce(b->'dadosAdicionais','{}'::jsonb)||jsonb_strip_nulls(jsonb_build_object('dataNascimento',cp.birth_date::text,
    'sexo',case when cp.gender in('M','F') then cp.gender end,'naturalidade',cp.birthplace)));
  end if;
 else
  select * into p from erp_catalog.product where record_id=p_id;
  select * into pd from erp_catalog.product_detail where record_id=p_id;
  if pd.deleted_at is not null then
   if v_origin is null then return jsonb_build_object('skip','NOT_IN_ORIGIN'); end if;
   return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','PATCH','path',v_path||'/'||v_origin||'/situacoes','body',jsonb_build_object('situacao','E'))),
    'origin_id',v_origin,'fetch',v_path||'/'||v_origin,'deleted',true);
  end if;
  b:=b||jsonb_strip_nulls(jsonb_build_object('nome',left(r.name,120),'codigo',r.code,'situacao',case when r.active then 'A' else 'I' end,
   'tipo',coalesce(p.kind,b->>'tipo','P'),'formato',coalesce(p.format,b->>'formato','S'),'preco',erp_sync.num(p.price),'unidade',p.unit,
   'descricaoCurta',p.description,'gtin',p.gtin,'marca',p.brand,'condicao',case when p.condition~'^[0-2]$' then to_jsonb(p.condition::integer) end,
   'tipoProducao',case when p.production in('P','T') then p.production end,'pesoLiquido',erp_sync.num(p.net_weight),'pesoBruto',erp_sync.num(p.gross_weight),
   'volumes',to_jsonb(p.volumes),'itensPorCaixa',erp_sync.num(coalesce(pd.items_per_box,p.items_per_box::numeric)),
   'descricaoComplementar',pd.complementary_description,'linkExterno',pd.external_link,'observacoes',pd.notes,'freteGratis',to_jsonb(pd.free_shipping),
   'dataValidade',pd.expiry_date::text));
  if p.width is not null or p.height is not null or p.depth is not null then
   b:=jsonb_set(b,'{dimensoes}',coalesce(b->'dimensoes','{}'::jsonb)||jsonb_strip_nulls(jsonb_build_object('largura',erp_sync.num(p.width),'altura',erp_sync.num(p.height),
    'profundidade',erp_sync.num(p.depth),'unidadeMedida',case when p.dimension_unit~'^[0-2]$' then to_jsonb(p.dimension_unit::integer) end)));
  end if;
  if p.stock_min is not null or p.stock_max is not null or p.location is not null then
   b:=jsonb_set(b,'{estoque}',coalesce(b->'estoque','{}'::jsonb)-'saldoVirtualTotal'||jsonb_strip_nulls(jsonb_build_object('minimo',erp_sync.num(p.stock_min),
    'maximo',erp_sync.num(p.stock_max),'localizacao',p.location)));
  end if;
  if p.ncm is not null or p.cest is not null or p.origin is not null then
   b:=jsonb_set(b,'{tributacao}',coalesce(b->'tributacao','{}'::jsonb)||jsonb_strip_nulls(jsonb_build_object('ncm',regexp_replace(p.ncm,'\D','','g'),'cest',p.cest,
    'origem',case when p.origin~'^[0-8]$' then to_jsonb(p.origin::integer) end)));
  end if;
 end if;
 if v_origin is null then
  return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','POST','path',v_path,'body',b)),'fetch',v_path||'/{id}');
 end if;
 return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','PUT','path',v_path||'/'||v_origin,'body',b)),
  'origin_id',v_origin,'fetch',v_path||'/'||v_origin);
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Envio de documentos
create function erp_sync.document_request(p_kind text,p_id uuid,p_op text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare d erp_documents.document; v_origin text:=erp_sync.origin_id(p_kind,p_id); v_contact text; v_path text; b jsonb; v_items jsonb:='[]'; v_parcels jsonb:='[]';
 i erp_documents.item; v_product text; v_blocked jsonb:='[]'; v_inst jsonb; v_method text; v_fallback_method text; v_status text; v_base_status text;
 v_requests jsonb; v_discount jsonb; v_freight jsonb;
begin
 v_path:=case p_kind when 'sales_orders' then '/pedidos/vendas' when 'purchase_orders' then '/pedidos/compras' when 'sales_proposals' then '/propostas-comerciais' end;
 if v_path is null then return jsonb_build_object('skip','ORIGIN_API_HAS_NO_SERVICE_ORDER_WRITE'); end if;
 select * into d from erp_documents.document where id=p_id and kind=p_kind;
 if p_op='delete' or not found or d.deleted_at is not null then
  if v_origin is null then return jsonb_build_object('skip','NOT_IN_ORIGIN'); end if;
  return jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('method','DELETE','path',v_path||'/'||v_origin)),'origin_id',v_origin,'deleted',true);
 end if;
 if d.authority='origin' then return jsonb_build_object('skip','MIRROR_NOT_CONVERTED'); end if;
 v_contact:=erp_sync.origin_id('contacts',d.contact_id);
 if v_contact is null then
  perform erp_sync.enqueue_dependency('contacts',d.contact_id);
  v_blocked:=v_blocked||jsonb_build_object('entity','contacts','record_id',d.contact_id);
 end if;
 b:=erp_sync.base_payload(p_kind,v_origin);
 v_base_status:=(select erp_sync.origin_status(p_kind,payload) from origin_sync.raw_record where entity=p_kind and source_id=v_origin);
 v_fallback_method:=coalesce(erp_sync.origin_ref(b#>'{parcelas,0,formaPagamento,id}'),
  (select source_id from origin_sync.raw_record where entity='payment_methods' and (payload->>'situacao')='1' order by source_id limit 1));
 for i in select * from erp_documents.item where document_id=p_id order by position loop
  v_product:=case when i.product_id is not null then erp_sync.origin_id('products',i.product_id) end;
  if i.product_id is not null and v_product is null then
   perform erp_sync.enqueue_dependency('products',i.product_id);
   v_blocked:=v_blocked||jsonb_build_object('entity','products','record_id',i.product_id);
  end if;
  v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(case p_kind
   when 'purchase_orders' then jsonb_build_object('descricao',coalesce(i.data->>'description',i.product_snapshot->>'name','Item'),'codigoFornecedor',i.data->>'supplier_code',
    'unidade',coalesce(i.data->>'unit','UN'),'valor',erp_sync.num(i.unit_price),'quantidade',erp_sync.num(i.quantity),'descricaoDetalhada',i.data->>'detailed_description',
    'aliquotaIPI',erp_sync.num(i.data->>'ipi_rate'),'produto',case when v_product is not null then jsonb_build_object('id',v_product::bigint) end)
   when 'sales_proposals' then jsonb_build_object('codigo',i.data->>'code','unidade',coalesce(i.data->>'unit','UN'),'quantidade',erp_sync.num(i.quantity),
    'desconto',erp_sync.num(i.discount_percent),'valor',erp_sync.num(i.unit_price),'descricaoDetalhada',i.data->>'detailed_description',
    'produto',jsonb_strip_nulls(jsonb_build_object('id',v_product::bigint,'descricao',coalesce(i.data->>'description',i.product_snapshot->>'name'))))
   else jsonb_build_object('codigo',i.data->>'code','unidade',coalesce(i.data->>'unit','UN'),'quantidade',erp_sync.num(i.quantity),
    'desconto',erp_sync.num(i.discount_percent),'valor',erp_sync.num(i.unit_price),'descricao',coalesce(i.data->>'description',i.product_snapshot->>'name','Item'),
    'descricaoDetalhada',i.data->>'detailed_description','aliquotaIPI',erp_sync.num(i.data->>'ipi_rate'),
    'produto',case when v_product is not null then jsonb_build_object('id',v_product::bigint) end) end));
 end loop;
 if jsonb_array_length(v_blocked)>0 then return jsonb_build_object('blocked',v_blocked); end if;
 for v_inst in select value from jsonb_array_elements(coalesce(d.body->'installments','[]'::jsonb)) loop
  v_method:=coalesce(erp_sync.payment_method_origin(nullif(v_inst->>'payment_method_id','')::uuid),v_fallback_method);
  v_parcels:=v_parcels||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('dataVencimento',v_inst->>'due_date','valor',erp_sync.num(v_inst->>'amount'),
   case when p_kind='purchase_orders' then 'observacao' else 'observacoes' end,v_inst->>'note',
   'formaPagamento',case when v_method is not null then jsonb_build_object('id',v_method::bigint) end)));
 end loop;
 v_freight:=erp_sync.num(d.body->>'freight');
 v_discount:=case when p_kind='sales_proposals' then erp_sync.num(coalesce(d.body#>>'{totals,discount}',d.body->>'discount_value'))
  else jsonb_build_object('valor',erp_sync.num(coalesce(d.body->>'discount_value','0')),'unidade',case when d.body->>'discount_mode'='percent' then 'PERCENTUAL' else 'REAL' end) end;
 b:=b-'parcelas'||jsonb_strip_nulls(jsonb_build_object('numero',to_jsonb(d.number),'data',coalesce(d.body->>'date',current_date::text),
  'outrasDespesas',erp_sync.num(d.body->>'other_expenses'),'observacoes',d.body->>'notes','desconto',v_discount))
  ||jsonb_build_object('itens',v_items)
  ||case when jsonb_array_length(v_parcels)>0 then jsonb_build_object('parcelas',v_parcels) else '{}'::jsonb end;
 if v_freight is not null then b:=jsonb_set(b,'{transporte}',coalesce(b->'transporte','{}'::jsonb)||jsonb_build_object('frete',v_freight)); end if;
 v_status:=erp_sync.push_status(p_kind,d.status);
 if p_kind='sales_orders' then
  b:=b||jsonb_strip_nulls(jsonb_build_object('contato',jsonb_build_object('id',v_contact::bigint),'dataSaida',coalesce(d.body->>'ship_date',d.body->>'date'),
   'dataPrevista',coalesce(d.body->>'expected_date',d.body->>'date'),'observacoesInternas',d.body->>'internal_notes',
   'numeroPedidoCompra',d.body#>>'{commercial,customer_po_number}'));
 elsif p_kind='purchase_orders' then
  b:=b-'contato'||jsonb_strip_nulls(jsonb_build_object('fornecedor',jsonb_build_object('id',v_contact::bigint),'dataPrevista',coalesce(d.body->>'expected_date',d.body->>'date'),
   'observacoesInternas',d.body->>'internal_notes'));
 else
  b:=b||jsonb_strip_nulls(jsonb_build_object('contato',jsonb_build_object('id',v_contact::bigint),'observacaoInterna',d.body->>'internal_notes',
   'dataProximoContato',d.body->>'next_contact','prazoEntrega',d.body->>'delivery_terms','situacao',v_status));
 end if;
 if v_origin is null then
  if p_kind='sales_orders' and v_status~'^[0-9]+$' then b:=b||jsonb_build_object('situacao',jsonb_build_object('id',v_status::bigint)); end if;
  v_requests:=jsonb_build_array(jsonb_build_object('method','POST','path',v_path,'body',b));
  if p_kind='purchase_orders' and v_status~'^[0-9]+$' then
   v_requests:=v_requests||jsonb_build_object('method','PATCH','path',v_path||'/{id}/situacoes/'||v_status); end if;
  return jsonb_build_object('requests',v_requests,'fetch',v_path||'/{id}');
 end if;
 v_requests:=jsonb_build_array(jsonb_build_object('method','PUT','path',v_path||'/'||v_origin,'body',b));
 if p_kind in('sales_orders','purchase_orders') and v_status~'^[0-9]+$' and v_status is distinct from v_base_status then
  v_requests:=v_requests||jsonb_build_object('method','PATCH','path',v_path||'/'||v_origin||'/situacoes/'||v_status); end if;
 if p_kind='sales_proposals' and v_status is not null and v_status is distinct from v_base_status then
  v_requests:=v_requests||jsonb_build_object('method','PATCH','path',v_path||'/'||v_origin||'/situacoes','body',jsonb_build_object('situacao',v_status)); end if;
 return jsonb_build_object('requests',v_requests,'origin_id',v_origin,'fetch',v_path||'/'||v_origin);
end$$;

-- Dependência (contato ou produto citado num documento) ainda sem ID no Origin: entra na fila mesmo sem alteração local.
create function erp_sync.enqueue_dependency(p_entity text,p_record uuid) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_record is null or erp_sync.origin_id(p_entity,p_record) is not null then return; end if;
 insert into erp_sync.outbox(entity,record_id,op) values(p_entity,p_record,'upsert') on conflict(entity,record_id,item,op) where state in('pending','sending') do nothing;
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Recebimento de cadastros
create function erp_sync.local_newer(p_entity text,p_record uuid,p_remote timestamptz) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select exists(select 1 from erp_sync.outbox o where o.entity=p_entity and o.record_id=p_record and o.op in('upsert','delete')
  and o.state in('pending','sending','failed') and o.changed_at>p_remote)
$$;
create function erp_sync.local_superseded(p_entity text,p_record uuid) returns void
language sql security definer set search_path=pg_catalog as $$
 update erp_sync.outbox set state='superseded',finished_at=clock_timestamp(),dirty=false
 where entity=p_entity and record_id=p_record and op in('upsert','delete') and state in('pending','failed')
$$;
create function erp_sync.mark_pulled(p_entity text,p_record uuid,s origin_sync.raw_record,p_deleted boolean) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
 perform erp_sync.remember(p_entity,p_record,s.source_id);
 update erp_sync.link set pulled_version=s.version,pulled_hash=s.version_hash,pulled_at=clock_timestamp(),deleted=p_deleted,updated_at=clock_timestamp()
 where entity=p_entity and record_id=p_record;
 perform erp_sync.resolve_issues('pull',p_entity,null,s.source_id);
end$$;

create function erp_sync.pull_catalog(s origin_sync.raw_record) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare v_id uuid:=erp_sync.local_id(s.entity,s.source_id); v_data jsonb; v_status text:=s.payload->>'situacao'; v_active boolean; v_deleted boolean;
 v_remote timestamptz:=coalesce(s.source_updated_at,s.changed_at); r erp_catalog.record; v_actor uuid:=erp_sync.actor();
begin
 v_deleted:=v_status='E' or coalesce(s.payload#>'{_brufap_source,deleted}'='true'::jsonb,false);
 if v_status not in('A','I','E','S') or v_status is null then
  if v_deleted then v_status:='E'; else perform erp_sync.note_issue('pull',s.entity,v_id,s.source_id,'SOURCE_STATUS_UNKNOWN'); return 'invalid'; end if;
 end if;
 v_active:=v_status in('A','S') and not v_deleted;
 if v_id is not null then
  select * into r from erp_catalog.record where id=v_id for update;
  -- Alteração mais recente vence: envio pendente mais novo, ou edição humana anterior à mão dupla feita depois da leitura do Origin.
  if erp_sync.local_newer(s.entity,v_id,v_remote) then return 'local_newer'; end if;
  if r.human_edited and r.updated_at>v_remote and not exists(select 1 from erp_sync.link where entity=s.entity and record_id=v_id and pulled_at is not null) then
   perform erp_sync.enqueue(s.entity,v_id,'upsert'); return 'local_newer';
  end if;
  perform erp_sync.local_superseded(s.entity,v_id);
 elsif v_deleted then
  return 'deleted_unknown';
 end if;
 v_data:=erp_catalog.map_origin(s.entity,s.payload);
 perform erp_sync.set_applying(true);
 insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)
 values(s.entity,s.source_id,s.version_hash,s.version,s.payload,s.document_links) on conflict(entity,source_id,source_hash) do nothing;
 if v_id is null then
  insert into erp_catalog.record(entity,name,code,active,created_by,updated_by)
  values(s.entity,v_data->>'name',v_data->>'code',v_active,v_actor,v_actor) returning id into v_id;
  perform erp_catalog.write_fields(v_id,s.entity,v_data);
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
  values(v_actor,gen_random_uuid(),s.entity,v_id,'origin_sync_create',null,erp_catalog.dto(v_id));
 else
  update erp_catalog.record set name=v_data->>'name',code=v_data->>'code',active=v_active,human_edited=false,version=version+1,
   updated_by=v_actor,updated_at=clock_timestamp() where id=v_id;
  perform erp_catalog.write_fields(v_id,s.entity,v_data);
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
  values(v_actor,gen_random_uuid(),s.entity,v_id,case when v_deleted then 'origin_sync_delete' else 'origin_sync_update' end,erp_catalog.dto(r.id),erp_catalog.dto(v_id));
 end if;
 if s.entity='contacts' then
  insert into erp_catalog.contact_profile(record_id,situation) values(v_id,case when v_deleted then 'E' else v_status end)
  on conflict(record_id) do update set situation=excluded.situation;
 end if;
 delete from erp_catalog.origin where record_id=v_id and (entity,source_id)<>(s.entity,s.source_id);
 insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state,candidate)
 values(s.entity,s.source_id,v_id,s.version_hash,s.version_hash,case when v_deleted then 'source_deleted' else 'synced' end,null)
 on conflict(entity,source_id) do update set record_id=excluded.record_id,applied_hash=excluded.applied_hash,latest_hash=excluded.latest_hash,
  state=excluded.state,candidate=null;
 perform erp_sync.mark_pulled(s.entity,v_id,s,v_deleted);
 perform erp_sync.set_applying(false);
 return case when r.id is null then 'created' else 'updated' end;
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Recebimento de documentos (conversão para o modelo nativo)
create function erp_sync.pull_document(s origin_sync.raw_record) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare v_id uuid:=erp_sync.local_id(s.entity,s.source_id); v_remote timestamptz:=coalesce(s.source_updated_at,s.changed_at);
 v_plan jsonb; v_body jsonb; v_items jsonb:='[]'; v_data jsonb; v_row jsonb; v_raw jsonb; v_status text; v_contact uuid; v_party text;
 d erp_documents.document; v_actor uuid:=erp_sync.actor(); v_deleted boolean; v_number bigint; v_item_ids uuid[]; v_before jsonb; v_product uuid; v_pos integer:=0;
 v_inst jsonb;
begin
 v_deleted:=coalesce(s.payload#>'{_brufap_source,deleted}'='true'::jsonb,false);
 if v_id is not null then
  select * into d from erp_documents.document where id=v_id for update;
  if not found then v_id:=null; end if;
 end if;
 if v_id is not null then
  if erp_sync.local_newer(s.entity,v_id,v_remote) then return 'local_newer'; end if;
  perform erp_sync.local_superseded(s.entity,v_id);
 elsif v_deleted then return 'deleted_unknown';
 end if;
 if v_deleted then
  perform erp_sync.set_applying(true);
  if d.deleted_at is null then
   update erp_documents.document set deleted_at=clock_timestamp(),deleted_by=v_actor,delete_reason='Excluído no Origin',version=version+1,
    updated_at=clock_timestamp(),updated_by=v_actor where id=v_id;
  end if;
  perform erp_sync.mark_pulled(s.entity,v_id,s,true); perform erp_sync.set_applying(false);
  return 'deleted';
 end if;
 v_party:=erp_documents.origin_import_id(case when s.entity='purchase_orders' then coalesce(s.payload#>'{fornecedor,id}',s.payload#>'{contato,id}') else s.payload#>'{contato,id}' end);
 v_contact:=erp_sync.local_id('contacts',v_party);
 if v_contact is null then
  if exists(select 1 from erp_sync.inbox where entity='contacts' and source_id=v_party) then raise exception 'DEPENDENCY_PENDING' using errcode='55000'; end if;
  raise exception 'CONTACT_NOT_IN_ORIGIN_SYNC' using errcode='22023';
 end if;
 v_plan:=erp_document_mirror.plan(row(s.entity,s.source_id,s.version,s.version_hash,s.payload,s.document_links,s.price_capture,s.last_seen_at,s.source_updated_at)::erp_document_mirror.source_version);
 for v_row in select value from jsonb_array_elements(v_plan->'items') loop
  v_pos:=v_pos+1;
  v_raw:=s.payload#>(string_to_array(trim(both '/' from v_row->>'source_path'),'/'));
  v_product:=erp_sync.local_id('products',v_row->>'source_id');
  if v_product is null and v_row->>'source_id' is not null and exists(select 1 from erp_sync.inbox where entity='products' and source_id=v_row->>'source_id') then
   raise exception 'DEPENDENCY_PENDING' using errcode='55000'; end if;
  if v_product is not null and not exists(select 1 from erp_catalog.record r where r.id=v_product and r.active) then v_product:=null; end if;
  if coalesce((v_row->>'quantity')::numeric,0)<=0 then continue; end if;
  v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('product_id',v_product,
   'description',coalesce(left(v_row->>'description',200),'Item '||v_pos),'code',left(v_row->>'code',100),'unit',coalesce(left(v_row->>'unit',16),'UN'),
   'quantity',round((v_row->>'quantity')::numeric,6)::text,'unit_price',round(coalesce((v_row->>'unit_price')::numeric,0),10)::text,
   'discount_percent',case when erp_sync.origin_number(v_raw->'desconto')::numeric between 0 and 100 then round(erp_sync.origin_number(v_raw->'desconto')::numeric,4)::text else '0' end,
   'detailed_description',v_row->>'detailed_description')));
 end loop;
 if jsonb_array_length(v_items)=0 and s.entity<>'service_orders' then raise exception 'ITEMS_UNAVAILABLE' using errcode='22023'; end if;
 v_body:=jsonb_strip_nulls(jsonb_build_object('date',coalesce(v_plan#>>'{body,date}',(d.body->>'date'),current_date::text),'contact_id',v_contact,
  'expected_date',v_plan#>>'{body,expected_date}','next_contact',v_plan#>>'{body,next_contact}',
  'notes',v_plan#>>'{body,notes}','internal_notes',v_plan#>>'{body,internal_notes}','delivery_terms',v_plan#>>'{body,delivery_terms}',
  'discount_mode','amount','discount_value',coalesce(round((v_plan#>>'{body,discount_value}')::numeric,2)::text,'0'),
  'freight',coalesce(round((v_plan#>>'{body,freight}')::numeric,2)::text,'0'),'other_expenses',coalesce(round((v_plan#>>'{body,other_expenses}')::numeric,2)::text,'0')))
  ||jsonb_build_object('items',v_items)
  ||case when s.entity='service_orders' then jsonb_strip_nulls(jsonb_build_object('equipment',left(v_plan#>>'{body,equipment}',200),'serial_number',left(v_plan#>>'{body,serial_number}',100),
   'technician',left(v_plan#>>'{body,technician}',200),'defect',v_plan#>>'{body,defect}')) else '{}'::jsonb end;
 -- Desconto em percentual no Origin (desconto.unidade='PERCENTUAL').
 if s.payload#>>'{desconto,unidade}'='PERCENTUAL' then v_body:=v_body||jsonb_build_object('discount_mode','percent'); end if;
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('due_date',x->>'due_date','amount',round((x->>'amount')::numeric,2)::text,'note',x->>'note',
  'payment_method_id',erp_sync.payment_method_native(erp_sync.origin_ref(s.payload#>array['parcelas',(n-1)::text,'formaPagamento','id']))))order by n),'[]'::jsonb)
 into v_inst from jsonb_array_elements(v_plan#>'{body,installments}') with ordinality t(x,n) where (x->>'amount')::numeric>0 and x->>'due_date' is not null;
 begin
  v_data:=erp_documents.normalize(s.entity,v_body||jsonb_build_object('installments',v_inst));
 exception when sqlstate '22023' then
  -- Parcelas que não fecham com o total no Origin: o documento entra sem parcelas, com pendência registrada.
  v_data:=erp_documents.normalize(s.entity,v_body);
  if jsonb_array_length(v_inst)>0 then perform erp_sync.note_issue('pull',s.entity,v_id,s.source_id,'INSTALLMENTS_NOT_APPLIED'); end if;
 end;
 v_status:=coalesce(erp_sync.native_status(s.entity,s.payload),case when d.authority='brufap' then d.status end,erp_documents.initial_status(s.entity));
 if erp_sync.native_status(s.entity,s.payload) is null then
  perform erp_sync.note_issue('pull',s.entity,v_id,s.source_id,'STATUS_UNMAPPED',erp_sync.origin_status(s.entity,s.payload)); end if;
 v_number:=nullif(erp_document_mirror.decimal(s.payload->'numero',0,10),'0')::bigint;
 if v_number is null and v_id is null then v_number:=erp_documents.next_number(s.entity); end if;
 perform erp_sync.set_applying(true);
 if v_id is null then
  insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by,origin,authority)
  values(s.entity,v_number,v_status,v_contact,null,erp_catalog.dto(v_contact),v_data-'items',(v_data#>>'{totals,total}')::numeric,v_actor,v_actor,'origin','brufap')
  returning id into v_id;
 else
  v_before:=to_jsonb(d);
  if d.deleted_at is not null then
   update erp_documents.document set deleted_at=null,deleted_by=null,delete_reason=null,version=version+1,updated_at=clock_timestamp(),updated_by=v_actor where id=v_id;
  end if;
  update erp_documents.document set number=coalesce(v_number,number),status=v_status,contact_id=v_contact,
   contact_snapshot=case when contact_id=v_contact and authority='brufap' then contact_snapshot else erp_catalog.dto(v_contact) end,
   -- Campos que só o Brufap conhece (vendedor, condições comerciais, campos extras) ficam; os do Origin são substituídos.
   body=case when authority='brufap' then body else '{}'::jsonb end||(v_data-'items'),total=(v_data#>>'{totals,total}')::numeric,
   authority='brufap',version=version+1,updated_by=v_actor,updated_at=clock_timestamp() where id=v_id;
 end if;
 -- Mantém os IDs dos itens pela posição, para não quebrar vínculos de reserva, lote e nota por item.
 select array_agg(id order by position) into v_item_ids from erp_documents.item where document_id=v_id;
 select coalesce(jsonb_agg(x||jsonb_build_object('id',v_item_ids[n]) order by n),'[]'::jsonb) into v_items
 from jsonb_array_elements(v_data->'items') with ordinality t(x,n);
 perform erp_documents.replace_items(v_id,v_items);
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
 values(v_actor,gen_random_uuid(),v_id,'origin_sync','Sincronização com o Origin',v_before,erp_documents.dto(v_id));
 perform erp_sync.mark_pulled(s.entity,v_id,s,false);
 perform erp_sync.set_applying(false);
 return case when v_before is null then 'created' else 'updated' end;
end$$;

-- Exclusão confirmada no Origin (404 no detalhe de um registro vinculado, no censo).
create function public.erp_sync_remote_deleted(p_entity text,p_origin text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_id uuid:=erp_sync.local_id(p_entity,p_origin); v_actor uuid:=erp_sync.actor(); r origin_sync.raw_record; v_result text:='unknown';
begin
 if v_actor is null then return jsonb_build_object('state','actor_not_configured'); end if;
 select * into r from origin_sync.raw_record where entity=p_entity and source_id=p_origin;
 if found then
  update origin_sync.raw_record set payload=payload||jsonb_build_object('_brufap_source',coalesce(payload->'_brufap_source','{}'::jsonb)||'{"deleted":true}'::jsonb),
   version=version+1,version_hash=encode(sha256(convert_to(jsonb_build_object('payload',payload||jsonb_build_object('_brufap_source',coalesce(payload->'_brufap_source','{}'::jsonb)||'{"deleted":true}'::jsonb),'document_links',document_links)::text,'UTF8')),'hex'),
   changed_at=clock_timestamp(),last_seen_at=clock_timestamp()
  where entity=p_entity and source_id=p_origin and not coalesce(payload#>'{_brufap_source,deleted}'='true'::jsonb,false);
  v_result:='staged';
 elsif v_id is not null then
  perform erp_sync.set_applying(true);
  if p_entity in('contacts','products') then
   update erp_catalog.record set active=false,version=version+1,updated_by=v_actor,updated_at=clock_timestamp() where id=v_id;
  elsif p_entity in('receivables','payables') then
   update erp_finance.title set cancelled=true,deleted_at=clock_timestamp(),deleted_by=v_actor,deleted_note='Excluída no Origin',version=version+1,updated_at=clock_timestamp()
   where id=v_id and deleted_at is null;
  else
   update erp_documents.document set deleted_at=clock_timestamp(),deleted_by=v_actor,delete_reason='Excluído no Origin',version=version+1,
    updated_at=clock_timestamp(),updated_by=v_actor where id=v_id and deleted_at is null;
  end if;
  update erp_sync.link set deleted=true,updated_at=clock_timestamp() where entity=p_entity and record_id=v_id;
  perform erp_sync.set_applying(false);
  v_result:='deleted';
 end if;
 return jsonb_build_object('state','ready','result',v_result);
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Recebimento: um lote da fila, cada item na própria subtransação.
create function erp_sync.pull_one(p_entity text,p_source text) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare s origin_sync.raw_record;
begin
 select * into s from origin_sync.raw_record where entity=p_entity and source_id=p_source;
 if not found then return 'missing'; end if;
 if exists(select 1 from erp_sync.link where entity=p_entity and origin_id=p_source and pulled_version=s.version and pulled_hash=s.version_hash) then return 'unchanged'; end if;
 return case
  when p_entity in('contacts','products') then erp_sync.pull_catalog(s)
  when p_entity in('sales_orders','sales_proposals','purchase_orders','service_orders') then erp_sync.pull_document(s)
  when p_entity in('receivables','payables') then erp_sync.pull_title(s)
  when p_entity='stock_balances' then erp_sync.pull_stock(s)
  else 'ignored' end;
end$$;

create function public.erp_sync_pull(p_limit integer default 100,p_entity text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare q record; v_result text; n integer:=0; ok integer:=0; failed integer:=0; deferred integer:=0; v_code text; counts jsonb:='{}'::jsonb;
begin
 if p_limit is null or p_limit not between 1 and 500 then raise exception 'erp_sync_invalid_limit' using errcode='22023'; end if;
 if not erp_sync.enabled() then return jsonb_build_object('state','disabled'); end if;
 if erp_sync.actor() is null then return jsonb_build_object('state','actor_not_configured','pending',(select count(*) from erp_sync.inbox)); end if;
 if not pg_try_advisory_xact_lock(174852901,220010) then return jsonb_build_object('state','busy'); end if;
 for q in select i.* from erp_sync.inbox i where i.retry_at<=clock_timestamp() and (p_entity is null or i.entity=p_entity)
  order by case i.entity when 'contacts' then 1 when 'products' then 2 when 'stock_balances' then 6 when 'receivables' then 5 when 'payables' then 5 else 3 end,i.seen_at,i.source_id
  limit p_limit for update skip locked loop
  n:=n+1;
  begin
   v_result:=erp_sync.pull_one(q.entity,q.source_id);
   delete from erp_sync.inbox where entity=q.entity and source_id=q.source_id and version=q.version;
   ok:=ok+1; counts:=jsonb_set(counts,array[v_result],to_jsonb(coalesce((counts->>v_result)::integer,0)+1));
  exception when others then
   v_code:=case when sqlerrm~'^[A-Z][A-Z_]{2,79}$' then sqlerrm else left(sqlerrm,80) end;
   if v_code='DEPENDENCY_PENDING' then
    deferred:=deferred+1;
    update erp_sync.inbox set retry_at=clock_timestamp()+interval '30 seconds' where entity=q.entity and source_id=q.source_id;
   else
    failed:=failed+1;
    update erp_sync.inbox set attempts=attempts+1,error=left(sqlerrm,500),
     retry_at=clock_timestamp()+least(interval '6 hours',interval '2 minutes'*power(2,least(attempts,8)))
    where entity=q.entity and source_id=q.source_id;
    perform erp_sync.note_issue('pull',q.entity,null,q.source_id,v_code,left(sqlerrm,500));
   end if;
  end;
 end loop;
 return jsonb_build_object('state','ready','processed',n,'applied',ok,'failed',failed,'deferred',deferred,'results',counts,
  'pending',(select count(*) from erp_sync.inbox));
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Envio: o Worker reserva um lote, executa as requisições e confirma cada item.
create function erp_sync.request(o erp_sync.outbox) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 return case
  when o.entity in('contacts','products') then erp_sync.catalog_request(o.entity,o.record_id,o.op)
  when o.entity in('sales_orders','sales_proposals','purchase_orders','service_orders') then erp_sync.document_request(o.entity,o.record_id,o.op)
  when o.entity in('receivables','payables') and o.op='settle' then erp_sync.settlement_request(o.entity,o.record_id)
  when o.entity in('receivables','payables') then erp_sync.title_request(o.entity,o.record_id,o.op)
  when o.entity='stock' then erp_sync.stock_request(o.record_id,o.item)
  else jsonb_build_object('skip','UNSUPPORTED') end;
end$$;

create function public.erp_sync_claim(p_limit integer,p_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare o erp_sync.outbox; v_req jsonb; v_out jsonb:='[]'; v_code text;
begin
 if p_limit is null or p_limit not between 1 and 100 or p_token is null then raise exception 'erp_sync_invalid_claim' using errcode='22023'; end if;
 if not erp_sync.enabled() then return '[]'::jsonb; end if;
 -- Envio interrompido (Worker encerrado no meio) volta para a fila depois de 10 minutos.
 update erp_sync.outbox set state='pending',claim_token=null,next_attempt_at=clock_timestamp()
 where state='sending' and claimed_at<clock_timestamp()-interval '10 minutes';
 for o in select * from erp_sync.outbox where state='pending' and next_attempt_at<=clock_timestamp()
  order by erp_sync.priority(entity,op),id limit p_limit*3 for update skip locked loop
  exit when jsonb_array_length(v_out)>=p_limit;
  begin
   v_req:=erp_sync.request(o);
  exception when others then
   v_code:=case when sqlerrm~'^[A-Za-z_]{3,80}$' then sqlerrm else 'REQUEST_BUILD_FAILED' end;
   update erp_sync.outbox set state='failed',finished_at=clock_timestamp(),error=left(sqlerrm,500),attempts=attempts+1 where id=o.id;
   perform erp_sync.note_issue('push',o.entity,o.record_id,null,v_code,left(sqlerrm,500));
   continue;
  end;
  if v_req ? 'skip' then
   update erp_sync.outbox set state='skipped',finished_at=clock_timestamp(),error=v_req->>'skip' where id=o.id;
   if v_req->>'skip' not in('NOT_IN_ORIGIN','NOTHING_TO_SEND') then perform erp_sync.note_issue('push',o.entity,o.record_id,null,v_req->>'skip'); end if;
  elsif v_req ? 'blocked' then
   update erp_sync.outbox set next_attempt_at=clock_timestamp()+interval '20 seconds' where id=o.id;
  else
   update erp_sync.outbox set state='sending',claim_token=p_token,claimed_at=clock_timestamp(),attempts=attempts+1,dirty=false where id=o.id;
   v_out:=v_out||jsonb_build_array(jsonb_build_object('id',o.id,'entity',o.entity,'record_id',o.record_id,'item',o.item,'op',o.op,'token',p_token)||v_req);
  end if;
 end loop;
 return v_out;
end$$;

create function public.erp_sync_ack(p_results jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a jsonb; o erp_sync.outbox; v_done integer:=0; v_failed integer:=0; v_retry integer:=0; v_origin text; v_status integer; v_link_entity text;
begin
 if jsonb_typeof(p_results) is distinct from 'array' or jsonb_array_length(p_results)>100 then raise exception 'erp_sync_invalid_ack' using errcode='22023'; end if;
 for a in select value from jsonb_array_elements(p_results) loop
  select * into o from erp_sync.outbox where id=(a->>'id')::bigint and claim_token=(a->>'token')::uuid and state='sending' for update;
  if not found then continue; end if;
  v_origin:=erp_sync.origin_ref(a->'origin_id'); v_status:=nullif(a->>'status','')::integer;
  v_link_entity:=case when o.entity in('stock') or o.op='settle' then null else o.entity end;
  if (a->>'ok')::boolean then
   if v_link_entity is not null and v_origin is not null then
    perform erp_sync.remember(v_link_entity,o.record_id,v_origin);
    update erp_sync.link set pushed_at=clock_timestamp(),deleted=o.op='delete' or coalesce((a->>'deleted')::boolean,false) where entity=v_link_entity and record_id=o.record_id;
   end if;
   if o.entity='stock' then
    insert into erp_sync.stock_pair(product_id,warehouse_id,last_push_at) values((o.detail->>'product_id')::uuid,(o.detail->>'warehouse_id')::uuid,clock_timestamp())
    on conflict(product_id,warehouse_id) do update set last_push_at=excluded.last_push_at;
   end if;
   perform erp_sync.resolve_issues('push',o.entity,o.record_id,null);
   update erp_sync.outbox set state=case when dirty then 'pending' else 'done' end,dirty=false,claim_token=null,
    finished_at=case when dirty then null else clock_timestamp() end,next_attempt_at=clock_timestamp(),http_status=v_status,error=null,
    origin_id=coalesce(v_origin,origin_id),attempts=case when dirty then 0 else attempts end
   where id=o.id;
   v_done:=v_done+1;
  elsif v_status=404 and o.op='delete' then
   update erp_sync.outbox set state='done',claim_token=null,finished_at=clock_timestamp(),http_status=404 where id=o.id;
   update erp_sync.link set deleted=true where entity=o.entity and record_id=o.record_id;
   v_done:=v_done+1;
  elsif v_status=404 and o.op='upsert' and v_link_entity is not null and o.attempts<3 then
   -- Sumiu do Origin e o Brufap alterou depois: o mais recente vence e o registro é criado de novo.
   delete from erp_sync.link where entity=o.entity and record_id=o.record_id;
   update erp_sync.outbox set state='pending',claim_token=null,next_attempt_at=clock_timestamp(),http_status=404 where id=o.id;
   v_retry:=v_retry+1;
  elsif coalesce((a->>'retry')::boolean,false) and o.attempts<8 then
   update erp_sync.outbox set state='pending',claim_token=null,http_status=v_status,error=left(a->>'error',500),
    next_attempt_at=clock_timestamp()+least(interval '1 hour',interval '1 minute'*power(2,o.attempts)) where id=o.id;
   v_retry:=v_retry+1;
  else
   update erp_sync.outbox set state='failed',claim_token=null,finished_at=clock_timestamp(),http_status=v_status,error=left(coalesce(a->>'error','ORIGIN_ERROR'),500) where id=o.id;
   perform erp_sync.note_issue('push',o.entity,o.record_id,null,left(coalesce(a->>'code','ORIGIN_ERROR'),80),left(a->>'error',500));
   v_failed:=v_failed+1;
  end if;
 end loop;
 return jsonb_build_object('done',v_done,'retry',v_retry,'failed',v_failed,'pending',(select count(*) from erp_sync.outbox where state in('pending','sending')));
end$$;

-- ---------------------------------------------------------------------------------------------------------------
revoke all on all functions in schema erp_sync from public,anon,authenticated,service_role;
do $$declare f text;begin
 foreach f in array array['erp_sync_pull(integer,text)','erp_sync_claim(integer,uuid)','erp_sync_ack(jsonb)','erp_sync_remote_deleted(text,text)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end$$;
grant execute on function erp_sync.applying(),erp_sync.enabled(),erp_sync.enqueue(text,uuid,text,integer,jsonb) to erp_document_mirror_writer;
commit;
