-- "Gerar nota fiscal" / "Gerar NFC-e" a partir do pedido (onda C da paridade item a item):
-- 1. erp_fiscal_invoice_order_source: o pedido de venda, a ordem de serviço (só as peças) ou o pedido de compra (nota de
--    entrada) com o contato e os produtos do cadastro atual, a natureza do contato e os motivos do Origin que impedem gerar a
--    nota ("Erro ao gerar a Nota fiscal — Motivo: …"). Só leitura: o formulário da nota mostra o rascunho e somente o Salvar
--    grava. A nota de saída passa a se ligar também à ordem de serviço (letra O), em store_orders e erp_fiscal_invoice_link.
--    O pedido só sai, e um vínculo novo só entra, para o perfil que lê aquele tipo de documento (erp_documents.allowed): o
--    fiscal lê pedidos de venda e de compra, não ordens de serviço.
-- 2. erp_fiscal_invoice_execute (redefinida de 142): com "Campos com validação opcional: Parcelas" desmarcado, o banco recusa
--    parcelas que não somam o total da nota, exceto quando as parcelas seguem as contas já lançadas pelo pedido
--    ("Bloquear edição da nota quando a conta foi lançada pela venda"), que a nota não pode mudar.
-- 3. erp_fiscal_tax_estimate_context: natureza, regras e configurações globais para o Worker estimar o IPI e o ICMS ST dos
--    itens de pedidos e propostas pelo mesmo cálculo automático da nota (perfis que leem esses documentos).
-- 4. Índice de invoice_order(document_id): a lista de documentos e os relatórios de vendas procuram a nota pelo pedido.
-- 5. erp_fiscal_invoice_order_link_states: coluna "Vinculação" dos pedidos de compra (Não vinculado, Vinculado, Parcial) pelas
--    notas de entrada do Brufap ligadas a eles, para os perfis que leem pedidos de compra (só o estado, nenhum dado da nota).
-- 6. "Informar desconto individualmente nos itens": desconto por item (invoice_specs, invoice_input) e a preferência no contexto
--    do formulário (erp_fiscal_invoice_context).
-- Nada aqui emite, transmite, reserva número ou lança estoque/contas; as travas de ambiente 022/041/046/064 não mudam.
begin;
create index erp_fiscal_invoice_order_document on erp_fiscal_invoices.invoice_order(document_id);

-- The order as the note form needs it: current contact and product cadastro (like Origin), the saved order values and the
-- reasons Origin refuses "Gerar nota fiscal". Purchase orders feed entry notes (direction 0); service orders feed exit notes with
-- their parts only (services belong to the NFS-e, out of scope); NFC-e only exists for sales orders.
create function erp_fiscal_invoices.order_source(p_document_id uuid,p_model text) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d erp_documents.document%rowtype;v_direction text;contact jsonb;profile jsonb;items jsonb;existing jsonb;reasons jsonb:='[]';effects jsonb;nature jsonb;
 positions jsonb;transport jsonb;
begin
 select * into d from erp_documents.document where id=p_document_id;
 if not found or d.kind not in('sales_orders','purchase_orders','service_orders') then raise exception 'erp_fiscal_invoice_order_not_found' using errcode='P0002'; end if;
 v_direction:=case d.kind when 'purchase_orders' then '0' else '1' end;
 if p_model='65' and d.kind<>'sales_orders' then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 select jsonb_build_object('contact_id',r.id,'name',r.name,'code',r.code,'active',r.active,'trade_name',c.trade_name,'person_type',c.person_type,'document',c.document,'ie',c.ie,
   'email',c.email,'phone',c.phone,'mobile',c.mobile,'postal_code',c.postal_code,'street',c.street,'number',c.number,'complement',c.complement,'district',c.district,'city',c.city,'state',c.state,
   'taxpayer',null,'country',null,'nfe_email',null)
 into contact from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=d.contact_id;
 -- Contribuinte, país, e-mail da NF-e and natureza of the contact come from the Origin contact profile (124) when it exists.
 if to_regclass('erp_catalog.contact_profile') is not null then
  execute 'select jsonb_build_object(''taxpayer'',p.taxpayer,''country'',p.country,''nfe_email'',p.nfe_email,''nature_id'',p.operation_nature_id) from erp_catalog.contact_profile p where p.record_id=$1'
   into profile using d.contact_id;
  contact:=contact||jsonb_build_object('taxpayer',profile->'taxpayer','country',profile->'country','nfe_email',profile->'nfe_email');
 end if;
 -- The contact's natureza de operação, when it fits the note (direction, active, not deleted); otherwise the form picks the default.
 select jsonb_build_object('id',n.id,'description',n.description,'crt',n.crt) into nature from erp_fiscal_invoices.nature n
  where n.id=(profile->>'nature_id')::uuid and n.direction=v_direction and n.active and n.deleted_at is null;
 select coalesce(jsonb_agg(jsonb_build_object('position',i.position,'product_id',i.product_id,'description',i.data->>'description','code',i.data->>'code','unit',i.data->>'unit',
   'quantity',i.data->>'quantity','unit_price',i.data->>'unit_price','gross',i.data->>'gross','discount',i.data->>'discount','total',i.data->>'total',
   'product',case when p.record_id is null then null else jsonb_build_object('kind',p.kind,'ncm',p.ncm,'gtin',p.gtin,'gtin_tax',p.gtin_tax,'cest',p.cest,'origin',p.origin,
    'gross_weight',p.gross_weight::text,'net_weight',p.net_weight::text,'volumes',p.volumes::text) end) order by i.position),'[]'::jsonb)
 into items from erp_documents.item i left join erp_catalog.product p on p.record_id=i.product_id where i.document_id=d.id;
 select jsonb_build_object('id',n.id,'model',n.model,'number',n.number,'status',n.status) into existing
 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id
 where o.document_id=d.id and n.deleted_at is null order by n.created_at desc,n.id desc limit 1;
 effects:=erp_documents.effect_flags(d.id);
 -- Origin: "Erro ao gerar a Nota fiscal — Motivo: …". Each reason is a code the screen translates; positions name the items.
 if d.status='cancelled' then reasons:=reasons||'[{"code":"cancelled","items":[]}]'::jsonb; end if;
 if jsonb_array_length(items)=0 then reasons:=reasons||'[{"code":"no_items","items":[]}]'::jsonb;
 elsif d.kind='service_orders' and not exists(select 1 from jsonb_array_elements(items) x where coalesce(x#>>'{product,kind}','P')<>'S') then
  reasons:=reasons||'[{"code":"no_products","items":[]}]'::jsonb; end if;
 if existing is not null then reasons:=reasons||'[{"code":"has_invoice","items":[]}]'::jsonb; end if;
 if contact->>'person_type'='E' or upper(coalesce(contact->>'state',''))='EX' then reasons:=reasons||'[{"code":"international","items":[]}]'::jsonb; end if;
 -- The note keeps quantities with four decimals (qCom); the order keeps six.
 select coalesce(jsonb_agg((x->>'position')::integer order by (x->>'position')::integer),'[]') into positions from jsonb_array_elements(items) x
 where (x->>'quantity')::numeric<>trunc((x->>'quantity')::numeric,4);
 if jsonb_array_length(positions)>0 then reasons:=reasons||jsonb_build_array(jsonb_build_object('code','quantity_precision','items',positions)); end if;
 -- "Permite geração de NF a partir da venda e ordem de serviço com estoque negativo" (Preferências › Suprimentos › Estoque):
 -- off, the note is not generated while a physical item would leave the order's depósito negative. When the order already
 -- posted its stock, the quantities have already left and nothing is checked again.
 if v_direction='1' and d.warehouse_id is not null and not coalesce((effects->>'stock_active')::boolean,false)
  and not (erp_fiscal_invoices.preference('estoque.nf_estoque_negativo','boolean','false'))::text::boolean then
  select coalesce(jsonb_agg(q.pos order by q.pos),'[]') into positions from (
   select (x->>'position')::integer as pos,(x->>'product_id')::uuid as product_id,
    sum((x->>'quantity')::numeric) over(partition by x->>'product_id') as needed
   from jsonb_array_elements(items) x where x->>'product_id' is not null and coalesce(x#>>'{product,kind}','P')<>'S') q
  where q.needed>coalesce((select b.quantity from erp_stock.balance b where b.product_id=q.product_id and b.warehouse_id=d.warehouse_id),0);
  if jsonb_array_length(positions)>0 then reasons:=reasons||jsonb_build_array(jsonb_build_object('code','stock_negative','items',positions)); end if;
 end if;
 transport:=case when jsonb_typeof(d.body#>'{commercial,transport}')='object' then jsonb_build_object('freight_mode',d.body#>'{commercial,transport,freight_mode}',
  'volume_count',d.body#>'{commercial,transport,volume_count}','gross_weight',d.body#>'{commercial,transport,gross_weight}','tracking_code',d.body#>'{commercial,transport,tracking_code}',
  'carrier_label',case when jsonb_typeof(d.body#>'{commercial,transport,carrier_reference}')='object' then d.body#>'{commercial,transport,carrier_reference,label}' else 'null'::jsonb end) end;
 return jsonb_build_object('document',jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'version',d.version,'status',d.status,'date',d.body->'date',
   'ship_date',coalesce(d.body->'ship_date','null'::jsonb),'customer_po_number',coalesce(d.body->'customer_po_number','null'::jsonb),'notes',coalesce(d.body->'notes','null'::jsonb),
   'warehouse_id',d.warehouse_id,'stock_active',coalesce((effects->>'stock_active')::boolean,false),'finance_active',coalesce((effects->>'finance_active')::boolean,false)),
  'direction',v_direction,'model',p_model,'eligible',jsonb_array_length(reasons)=0,'reasons',reasons,'contact',contact,'nature',nature,'items',items,
  'totals',jsonb_build_object('gross',d.body#>'{totals,gross}','line_discount',d.body#>'{totals,line_discount}','discount',d.body#>'{totals,discount}',
   'freight',d.body#>'{totals,freight}','other_expenses',d.body#>'{totals,other_expenses}','total',d.body#>'{totals,total}'),
  'installments',coalesce((select jsonb_agg(jsonb_build_object('position',(x->>'position')::integer,'due_date',x->'due_date','amount',x->'amount','method',coalesce(x->'method','null'::jsonb),
    'note',coalesce(x->'note','null'::jsonb)) order by (x->>'position')::integer) from jsonb_array_elements(case when jsonb_typeof(d.body->'installments')='array' then d.body->'installments' else '[]' end) x),'[]'::jsonb),
  'delivery',case when jsonb_typeof(d.body->'delivery_address')='object' then d.body->'delivery_address' else 'null'::jsonb end,
  'transport',coalesce(transport,'null'::jsonb),'existing_invoice',coalesce(existing,'null'::jsonb));
end $$;

create function public.erp_fiscal_invoice_order_source(p_user_id uuid,p_document_id uuid,p_model text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);v_kind text;
begin
 if p_document_id is null or p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 -- The pedido leaves only to the profiles that read its kind (erp_documents.allowed): fiscal reads pedidos de venda and de
 -- compra, not ordens de serviço, so only the administrator generates the note of an OS.
 select d.kind into v_kind from erp_documents.document d where d.id=p_document_id;
 if v_kind is not null and not erp_documents.allowed(role,v_kind,false) then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 return erp_fiscal_invoices.order_source(p_document_id,p_model)||jsonb_build_object('writable',role in('admin','fiscal'),'emission_enabled',false,'production_enabled',false,'data_mode','erp_native');
end $$;

-- A note takes a new link only to documents its author reads (erp_documents.allowed); links already on the note stay, so a
-- fiscal user still saves a note an administrator linked to an ordem de serviço.
create function erp_fiscal_invoices.require_orders_readable(p_role text,p_id uuid,p_orders jsonb) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if exists(select 1 from jsonb_array_elements(erp_fiscal_invoices.array_input(p_orders,20)) x join erp_documents.document d on d.id=erp_fiscal_invoices.uuid_input(x)
   where not erp_documents.allowed(p_role,d.kind,false)
    and not exists(select 1 from erp_fiscal_invoices.invoice_order o where o.invoice_id=p_id and o.document_id=d.id)) then
  raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
end $$;

-- Exit notes link pedidos de venda and ordens de serviço (V and O letters); entry notes link pedidos de compra.
create or replace function erp_fiscal_invoices.store_orders(p_id uuid,p_direction text,p_orders jsonb) returns void language plpgsql set search_path=pg_catalog as $$
declare o uuid;
begin
 delete from erp_fiscal_invoices.invoice_order where invoice_id=p_id;
 for o in select distinct erp_fiscal_invoices.uuid_input(x) from jsonb_array_elements(erp_fiscal_invoices.array_input(p_orders,20)) x loop
  if not exists(select 1 from erp_documents.document d where d.id=o and d.kind=any(case p_direction when '1' then array['sales_orders','service_orders'] else array['purchase_orders'] end)) then
   raise exception 'erp_fiscal_invoice_order_not_found' using errcode='22023'; end if;
  insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values(p_id,o);
 end loop;
end $$;

-- Sales orders whose contas are already posted lock the parcels of a new note when "Bloquear edição da nota quando a conta foi
-- lançada pela venda" is on, like an update of a note linked to them.
create function erp_fiscal_invoices.orders_finance_locked(p_orders jsonb) returns boolean language plpgsql stable set search_path=pg_catalog as $$
declare o uuid;
begin
 if not (erp_fiscal_invoices.preference('nfe.bloquear_edicao_contas','boolean','false'))::text::boolean then return false; end if;
 for o in select distinct erp_fiscal_invoices.uuid_input(x) from jsonb_array_elements(erp_fiscal_invoices.array_input(p_orders,20)) x loop
  if exists(select 1 from erp_documents.document d where d.id=o and d.kind='sales_orders') and coalesce((erp_documents.effect_flags(o)->>'finance_active')::boolean,false) then return true; end if;
 end loop;
 return false;
end $$;

create or replace function public.erp_fiscal_invoice_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;keys text[];v_id uuid;expected integer;v erp_fiscal_invoices.invoice%rowtype;d jsonb;rec jsonb;result jsonb;reason text;locks jsonb;parcels_locked boolean:=false;
begin
 role:=erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_action is null or p_action not in('create','update','delete') or p_data is null or jsonb_typeof(p_data)<>'object' then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 keys:=case p_action when 'create' then array['invoice','orders'] when 'update' then array['id','expected_version','invoice','orders'] else array['id','expected_version','reason'] end;
 if exists(select 1 from jsonb_object_keys(p_data) k where not k=any(keys)) or not p_data ?& (case p_action when 'create' then array['invoice'] when 'update' then array['id','expected_version','invoice'] else array['id','expected_version','reason'] end) then
  raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 if p_action in('create','update') then d:=erp_fiscal_invoices.invoice_input(p_data->'invoice'); end if;
 if p_action<>'create' then v_id:=erp_fiscal_invoices.uuid_input(p_data->'id');expected:=erp_fiscal_invoices.version_input(p_data->'expected_version'); end if;
 -- Origin asks for the reason of every deletion; the database requires it too, not only the Worker.
 if p_action='delete' then reason:=erp_fiscal_invoices.text_input(p_data->'reason',1000,true);
  if length(reason)<3 then raise exception 'erp_fiscal_invoice_reason_invalid' using errcode='22023'; end if; end if;
 h:=erp_fiscal_invoices.command_hash(p_user_id,'invoice',p_action,p_data);
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'invoice',h);
 if replay is not null then return replay; end if;
 if p_action<>'create' then
  select * into v from erp_fiscal_invoices.invoice where id=v_id for update;
  if not found then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
  if v.version<>expected or v.version=2147483647 or v.deleted_at is not null then raise exception 'erp_fiscal_invoice_version_conflict' using errcode='40001'; end if;
 end if;
 -- A nature deleted by "Excluir as operações selecionadas" (141) stays on the notes that already carry it, but no note takes it anew.
 if p_action in('create','update') and exists(select 1 from erp_fiscal_invoices.nature n
   where n.deleted_at is not null and n.id in(select (d->>'nature_id')::uuid union select (x->>'nature_id')::uuid from jsonb_array_elements(d->'items') x)
    and (p_action='create' or (n.id is distinct from v.nature_id
     and not exists(select 1 from erp_fiscal_invoices.invoice_item i where i.invoice_id=v_id and i.data->>'nature_id'=n.id::text)))) then
  raise exception 'erp_fiscal_invoice_nature_not_found' using errcode='22023'; end if;
 if p_action='update' then
  if v.status not in(1,5,8,12) then raise exception 'erp_fiscal_invoice_not_editable' using errcode='40001'; end if;
  if d->>'model'<>v.model or d->>'direction'<>v.direction or (d->>'environment') is distinct from v.environment then raise exception 'erp_fiscal_invoice_type_immutable' using errcode='22023'; end if;
  -- Imported XML notes (S/X, migration 143) keep the XML as their source: the form never rewrites them, not even as "Emitida por Terceiros".
  if v.issue_type in('S','X') then raise exception 'erp_fiscal_invoice_not_editable' using errcode='40001'; end if;
  -- "Bloquear edição da nota quando o estoque/a conta foi lançado(a) pela venda": items or parcels of a locked note stay as they are.
  locks:=erp_fiscal_invoices.edit_locks(v_id);
  if (locks->>'items')::boolean and erp_fiscal_invoices.items_signature(d->'items')
   <>erp_fiscal_invoices.items_signature(coalesce((select jsonb_agg(i.data order by i.position) from erp_fiscal_invoices.invoice_item i where i.invoice_id=v_id),'[]'::jsonb)) then
   raise exception 'erp_fiscal_invoice_locked_by_order' using errcode='40001'; end if;
  if (locks->>'installments')::boolean and erp_fiscal_invoices.installments_signature(d->'payment')<>erp_fiscal_invoices.installments_signature(v.payment) then
   raise exception 'erp_fiscal_invoice_locked_by_order' using errcode='40001'; end if;
  if ((locks->>'items')::boolean or (locks->>'installments')::boolean)
   and coalesce((select array_agg(x order by x) from (select distinct erp_fiscal_invoices.uuid_input(e) x from jsonb_array_elements(erp_fiscal_invoices.array_input(p_data->'orders',20)) e) s),'{}'::uuid[])
    <>coalesce((select array_agg(o.document_id order by o.document_id) from erp_fiscal_invoices.invoice_order o where o.invoice_id=v_id),'{}'::uuid[]) then
   raise exception 'erp_fiscal_invoice_locked_by_order' using errcode='40001'; end if;
  parcels_locked:=(locks->>'installments')::boolean;
 elsif p_action='create' then parcels_locked:=erp_fiscal_invoices.orders_finance_locked(p_data->'orders');
 end if;
 -- 176: Origin refuses parcels that do not add up to the note total unless "Campos com validação opcional: Parcelas" is set.
 -- Parcels that follow contas already posted by the order cannot change, so they never make the note unsavable.
 if p_action in('create','update') and not parcels_locked and jsonb_array_length(d#>'{payment,installments}')>0
  and not (erp_fiscal_invoices.preference('nfe.validacao_opcional','array','[]') ? 'parcelas')
  and (select sum((x->>'amount')::numeric) from jsonb_array_elements(d#>'{payment,installments}') x)<>(d#>>'{totals,total}')::numeric then
  raise exception 'erp_fiscal_invoice_installments_mismatch' using errcode='22023'; end if;
 if p_action in('create','update') then perform erp_fiscal_invoices.require_orders_readable(role,v_id,p_data->'orders'); end if;
 if p_action='create' then
  insert into erp_fiscal_invoices.invoice(model,direction,issue_type,environment,status,series,number,access_key,nature_id,nature_description,cfop,issue_date,exit_date,exit_time,
   crt,purpose,credit_debit_type,presence,final_consumer,recipient,export,import_declaration,doc_references,transport,payment,authorized_xml,intermediary,additional_info,
   nature_additional_info,nature_fiscal_info,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by)
  values(d->>'model',d->>'direction',d->>'issue_type',d->>'environment',(d->>'status')::smallint,(d->>'series')::integer,(d->>'number')::integer,d->>'access_key',
   (d->>'nature_id')::uuid,d->>'nature_description',d->>'cfop',(d->>'issue_date')::date,(d->>'exit_date')::date,d->>'exit_time',d->>'crt',d->>'purpose',d->>'credit_debit_type',
   d->>'presence',(d->>'final_consumer')::boolean,d->'recipient',nullif(d->'export','null'::jsonb),nullif(d->'import_declaration','null'::jsonb),d->'references',d->'transport',
   d->'payment',d->'authorized_xml',d->'intermediary',d->>'additional_info',d->>'nature_additional_info',d->>'nature_fiscal_info',(d->>'auto_tax')::boolean,
   (d->>'freight')::numeric,(d->>'insurance')::numeric,(d->>'other_expenses')::numeric,(d->>'discount')::numeric,d->'totals',p_user_id,p_user_id) returning id into v_id;
 elsif p_action='update' then
  update erp_fiscal_invoices.invoice set issue_type=d->>'issue_type',
   series=(d->>'series')::integer,number=(d->>'number')::integer,access_key=case when d->>'issue_type' in('T','S','X') then d->>'access_key' else v.access_key end,
   nature_id=(d->>'nature_id')::uuid,nature_description=d->>'nature_description',cfop=d->>'cfop',issue_date=(d->>'issue_date')::date,exit_date=(d->>'exit_date')::date,
   exit_time=d->>'exit_time',crt=d->>'crt',purpose=d->>'purpose',credit_debit_type=d->>'credit_debit_type',presence=d->>'presence',final_consumer=(d->>'final_consumer')::boolean,
   recipient=d->'recipient',export=nullif(d->'export','null'::jsonb),import_declaration=nullif(d->'import_declaration','null'::jsonb),doc_references=d->'references',
   transport=d->'transport',payment=d->'payment',authorized_xml=d->'authorized_xml',intermediary=d->'intermediary',additional_info=d->>'additional_info',
   nature_additional_info=d->>'nature_additional_info',nature_fiscal_info=d->>'nature_fiscal_info',auto_tax=(d->>'auto_tax')::boolean,freight=(d->>'freight')::numeric,
   insurance=(d->>'insurance')::numeric,other_expenses=(d->>'other_expenses')::numeric,discount=(d->>'discount')::numeric,totals=d->'totals',
   version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 else
  update erp_fiscal_invoices.invoice set deleted_at=clock_timestamp(),deleted_by=p_user_id,delete_reason=reason,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 end if;
 if p_action in('create','update') then
  perform erp_fiscal_invoices.store_items(v_id,d->'items');
  perform erp_fiscal_invoices.store_orders(v_id,d->>'direction',p_data->'orders');
 end if;
 rec:=erp_fiscal_invoices.invoice_record(v_id);
 insert into erp_fiscal_invoices.invoice_revision(invoice_id,version,record) values(v_id,(rec->>'version')::integer,rec);
 result:=erp_fiscal_invoices.invoice_envelope(rec,role)||jsonb_build_object('action',p_action,'replayed',false);
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'invoice',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'invoice',v_id,(rec->>'version')::integer,p_action,reason);
 return result;
end $$;

-- "Vincular à pedido de compra" / "Desvincular pedido compra" (142), with the ordens de serviço among the documents of exit notes.
create or replace function public.erp_fiscal_invoice_link(p_user_id uuid,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;v erp_fiscal_invoices.invoice%rowtype;v_id uuid;expected integer;doc uuid;action text;rec jsonb;result jsonb;
begin
 role:=erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_data is null or jsonb_typeof(p_data)<>'object' or exists(select 1 from jsonb_object_keys(p_data) k where k not in('invoice_id','expected_version','action','document_id'))
  or not p_data ?& array['invoice_id','expected_version','action','document_id'] or jsonb_typeof(p_data->'action') is distinct from 'string' or p_data->>'action' not in('link','unlink') then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 v_id:=erp_fiscal_invoices.uuid_input(p_data->'invoice_id');doc:=erp_fiscal_invoices.uuid_input(p_data->'document_id');expected:=erp_fiscal_invoices.version_input(p_data->'expected_version');action:=p_data->>'action';
 h:=erp_fiscal_invoices.command_hash(p_user_id,'invoice',action||'_order',p_data);
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'invoice',h);
 if replay is not null then return replay; end if;
 select * into v from erp_fiscal_invoices.invoice where id=v_id for update;
 if not found then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 if v.version<>expected or v.version=2147483647 or v.deleted_at is not null then raise exception 'erp_fiscal_invoice_version_conflict' using errcode='40001'; end if;
 if not exists(select 1 from erp_documents.document d where d.id=doc and d.kind=any(case v.direction when '1' then array['sales_orders','service_orders'] else array['purchase_orders'] end)) then
  raise exception 'erp_fiscal_invoice_order_not_found' using errcode='22023'; end if;
 if action='link' then
  perform erp_fiscal_invoices.require_orders_readable(role,v_id,jsonb_build_array(doc));
  if exists(select 1 from erp_fiscal_invoices.invoice_order where invoice_id=v_id and document_id=doc) then raise exception 'erp_fiscal_invoice_order_state_conflict' using errcode='40001'; end if;
  if (select count(*) from erp_fiscal_invoices.invoice_order where invoice_id=v_id)>=20 then raise exception 'erp_fiscal_invoice_order_limit' using errcode='22023'; end if;
  insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values(v_id,doc);
 else
  if not exists(select 1 from erp_fiscal_invoices.invoice_order where invoice_id=v_id and document_id=doc) then raise exception 'erp_fiscal_invoice_order_state_conflict' using errcode='40001'; end if;
  if (erp_fiscal_invoices.edit_locks(v_id)->>'items')::boolean or (erp_fiscal_invoices.edit_locks(v_id)->>'installments')::boolean then
   raise exception 'erp_fiscal_invoice_locked_by_order' using errcode='40001'; end if;
  delete from erp_fiscal_invoices.invoice_order where invoice_id=v_id and document_id=doc;
 end if;
 update erp_fiscal_invoices.invoice set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 rec:=erp_fiscal_invoices.invoice_record(v_id);
 insert into erp_fiscal_invoices.invoice_revision(invoice_id,version,record) values(v_id,(rec->>'version')::integer,rec);
 result:=erp_fiscal_invoices.invoice_envelope(rec,role)||jsonb_build_object('action',action||'_order','replayed',false,'document_id',doc);
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'invoice',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'invoice',v_id,(rec->>'version')::integer,action||'_order',doc::text);
 return result;
end $$;

-- What the Worker needs to estimate "Total do IPI" and "Total do ICMS ST" of a pedido de venda or proposta comercial with the
-- note's own engine: the natureza of the contact (or the default by person type), its rules, the global tax settings and the
-- NCM of the products. Profiles that read those documents may ask; the rules never leave the Worker.
create function public.erp_fiscal_tax_estimate_context(p_user_id uuid,p_kind text,p_contact_id uuid,p_product_ids jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.role_of(p_user_id);v_crt text;v_state text;v_recipient jsonb;v_nature uuid;v_taxpayer text;t erp_fiscal_invoices.tax_settings%rowtype;
 v_defaults jsonb:=erp_fiscal_invoices.tax_settings_input('{}','{}');v_products jsonb;v_ids uuid[];
begin
 if p_kind is null or p_kind not in('sales_orders','sales_proposals') or p_product_ids is null or jsonb_typeof(p_product_ids)<>'array' or jsonb_array_length(p_product_ids)>250 then
  raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 v_ids:=array(select erp_fiscal_invoices.uuid_input(x) from jsonb_array_elements(p_product_ids) x);
 if not erp_documents.allowed(role,p_kind,false) then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 select f.crt,upper(i.data->>'state') into v_crt,v_state from erp_company.identity i left join erp_company.fiscal f using(singleton) where i.singleton;
 if p_contact_id is not null then
  select jsonb_build_object('person_type',c.person_type,'state',upper(c.state),'ie',c.ie,'taxpayer',null) into v_recipient
  from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=p_contact_id and r.entity='contacts';
  if v_recipient is null then raise exception 'erp_fiscal_invoice_contact_not_found' using errcode='22023'; end if;
  if to_regclass('erp_catalog.contact_profile') is not null then
   execute 'select p.taxpayer,p.operation_nature_id from erp_catalog.contact_profile p where p.record_id=$1' into v_taxpayer,v_nature using p_contact_id;
   v_recipient:=v_recipient||jsonb_build_object('taxpayer',v_taxpayer);
   if not exists(select 1 from erp_fiscal_invoices.nature n where n.id=v_nature and n.direction='1' and n.active and n.deleted_at is null and n.crt=v_crt) then v_nature:=null; end if;
  end if;
 end if;
 if v_nature is null then
  select d.nature_id into v_nature from erp_fiscal_invoices.nature_default d join erp_fiscal_invoices.nature n on n.id=d.nature_id
  where n.active and n.deleted_at is null and d.code in(case v_recipient->>'person_type' when 'F' then 'VF' when 'J' then 'VJ' else 'S' end,'S')
  order by d.code='S',d.code limit 1;
 end if;
 select * into t from erp_fiscal_invoices.tax_settings where singleton;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'ncm',p.ncm,'kind',p.kind) order by r.id),'[]') into v_products
 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=any(v_ids);
 return jsonb_build_object('enabled',erp_fiscal_invoices.preference('propostas.exibir_ipi_st','boolean','false'),'company',jsonb_build_object('crt',v_crt,'state',v_state),
  'recipient',v_recipient,'nature',case when v_nature is null then null else erp_fiscal_invoices.nature_record(v_nature) end,
  'settings',coalesce(t.settings,v_defaults->'settings'),'difal_by_state',coalesce(t.difal_by_state,'{}'::jsonb),'products',v_products,'data_mode','erp_native');
end $$;

-- "Vinculação" of the pedidos de compra list: Não vinculado without an entry note of Brufap, Vinculado when the linked entry notes
-- cover the quantity of every product of the pedido, Parcial otherwise. Only the state leaves; the notes stay admin/fiscal.
create function public.erp_fiscal_invoice_order_link_states(p_user_id uuid,p_document_ids jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.role_of(p_user_id);v_ids uuid[];v_items jsonb;
begin
 if p_document_ids is null or jsonb_typeof(p_document_ids)<>'array' or jsonb_array_length(p_document_ids)>100 then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 if not erp_documents.allowed(role,'purchase_orders',false) then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 v_ids:=array(select distinct erp_fiscal_invoices.uuid_input(x) from jsonb_array_elements(p_document_ids) x);
 select coalesce(jsonb_agg(jsonb_build_object('document_id',d.id,'state',
   case when not exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id where o.document_id=d.id and n.deleted_at is null and n.direction='0') then 'none'
    when exists(select 1 from (select i.product_id,sum(i.quantity) needed from erp_documents.item i where i.document_id=d.id and i.product_id is not null group by i.product_id) p
     where p.needed>coalesce((select sum(ni.quantity) from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id
      join erp_fiscal_invoices.invoice_item ni on ni.invoice_id=n.id where o.document_id=d.id and n.deleted_at is null and n.direction='0' and ni.product_id=p.product_id),0)) then 'partial'
    else 'linked' end) order by d.id),'[]'::jsonb)
 into v_items from erp_documents.document d where d.id=any(v_ids) and d.kind='purchase_orders';
 return jsonb_build_object('items',v_items,'data_mode','erp_native');
end $$;

-- "Informar desconto individualmente nos itens" (Preferências › Configurações de NF-e, ligada por padrão como no Origin): o item
-- pode ter o próprio desconto (vDesc do item). Com algum item com desconto, o desconto da nota é a soma dos itens e cada item
-- fica com o seu; sem nenhum, o desconto da nota é rateado pelos itens como antes, e as notas já salvas não mudam.
create or replace function erp_fiscal_invoices.invoice_specs() returns jsonb language sql immutable set search_path=pg_catalog as $spec$
 select '{"recipient":{"contact_id":"u","name":"t:60","person_type":"e:J|F|E","document":"x:^([0-9]{11}|[0-9]{14})$","foreign_id":"x:^[A-Za-z0-9.:/-]{0,20}$","ie":"x:^([0-9]{2,14}|ISENTO)$","ie_indicator":"e:1|2|9","email":"t:60","phone":"x:^[0-9]{6,14}$","postal_code":"x:^[0-9]{8}$","street":"t:60","number":"t:60","complement":"t:60","district":"t:60","city":"t:60","municipality_code":"x:^[0-9]{7}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO|EX","country":"t:60"},"export":{"exit_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","exit_place":"t:60","dispatch_place":"t:60"},"import":{"number":"t:15","registration_date":"a","exporter_code":"t:60","customs_expenses":"d:2:13","clearance_place":"t:60","clearance_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","clearance_date":"a","afrmm_value":"d:2:13","acquirer_cnpj":"x:^[0-9]{14}$","acquirer_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","transport_route":"e:1|2|3|4|5|6|7|8|9|10|11|12|13","intermediation":"e:1|2|3","unit_value_with_ii":"b"},"addition":{"number":"x:^[0-9]{1,3}$","sequence":"x:^[0-9]{1,5}$","manufacturer":"t:60","discount":"d:2:13","drawback":"x:^[0-9]{1,20}$"},"reference":{"type":"e:nfe|ecf|nf01|nf02|nfp01|nfp04|cte","key":"x:^[0-9]{44}$","year_month":"x:^[0-9]{2}(0[1-9]|1[0-2])$","number":"x:^[0-9]{1,9}$","series":"x:^[0-9]{1,3}$"},"transport":{"mode":"e:none|manual","freight_by":"e:0|1|2|3|4|9","tracking_code":"t:60"},"carrier":{"contact_id":"u","name":"t:60","document":"x:^([0-9]{11}|[0-9]{14})$","ie":"x:^([0-9]{2,14}|ISENTO)$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","city":"t:60","address":"t:60"},"vehicle":{"plate":"x:^[A-Z0-9]{7}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","rntc":"t:20"},"volumes":{"quantity":"x:^[0-9]{1,15}$","gross_weight":"d:3:12","net_weight":"d:3:12","numbering":"t:60","brand":"t:60","species":"e:outros|volumes|unidades|caixas|pacotes|envelopes|pallets|sacos"},"delivery":{"name":"t:60","postal_code":"x:^[0-9]{8}$","state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO|EX","city":"t:60","street":"t:60","number":"t:60","district":"t:60","complement":"t:60","country":"t:60"},"installment":{"days":"x:^[0-9]{1,4}$","date":"a","amount":"d:2:13","method":"e:01|02|03|04|05|10|11|12|13|15|16|17|18|19|20|90|99","note":"t:255"},"card":{"integration":"e:1|2","cnpj":"x:^[0-9]{14}$","brand":"x:^[0-9]{2}$","authorization":"t:128","received":"d:2:13","fee":"d:2:13","commission_fee":"d:2:13"},"authorized":{"contact_id":"u","name":"t:60","document":"x:^([0-9]{11}|[0-9]{14})$"},"intermediary":{"present":"b","cnpj":"x:^[0-9]{14}$","identification":"t:60"},"item":{"product_id":"u","description":"t:120","code":"t:60","kind":"e:P|S","unit":"t:6","quantity":"d:4:11","unit_price":"d:10:11","discount":"d:2:13","discount_type":"e:C|I","nature_id":"u","cfop":"x:^[1-7][0-9]{3}$","ncm":"x:^([0-9]{8}|00)$","cest":"x:^[0-9]{7}$","gtin":"x:^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$","gtin_tax":"x:^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$","barcode":"t:30","barcode_tax":"t:30","gross_weight":"d:3:12","net_weight":"d:3:12","volumes":"x:^[0-9]{1,6}$","invoiced":"b","info":"m:500","complementary_info":"m:2000","fiscal_info":"m:2000"},"item_groups":{"icms":{"origin":"e:0|1|2|3|4|5|6|7|8","situation":"e:00|02|10|15|20|30|40|41|50|51|53|60|61|70|90|101|102|103|201|202|203|300|400|500|900","taxation":"e:T|I|O","bc_mode":"e:0|1|2|3","pauta_value":"d:4:11","base_rate":"d:4:3","base":"d:2:13","deferral_rate":"d:4:3","presumed_rate":"d:4:3","presumed_value":"d:2:13","rate":"d:4:3","value":"d:2:13","fcp_rate":"d:4:3","fcp_value":"d:2:13","fcp_deferral_rate":"d:4:3","fcp_deferral_value":"d:2:13","fcp_effective_value":"d:2:13","credit_rate":"d:4:3","credit_value":"d:2:13","deson_value":"d:2:13","deson_reason":"e:1|3|4|5|6|7|8|9|10|11|90","deson_deduct":"b","reduction_reason":"e:1|9","benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","presumed_credit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","rbc_benefit_code":"x:^[A-Z0-9]{8}([A-Z0-9]{2})?$","mono_qty":"d:4:11","mono_rate":"d:4:3","mono_value":"d:2:13","mono_deferred_value":"d:2:13","mono_icms_value":"d:2:13","st_bc_mode":"e:0|1|2|3|4|5|6","st_pauta_value":"d:4:11","st_mva":"d:4:3","st_base_rate":"d:4:3","st_base":"d:2:13","st_rate":"d:4:3","st_value":"d:2:13","st_fcp_value":"d:2:13","st_deson_value":"d:2:13","st_deson_reason":"e:3|9|90","pis_st_base":"d:2:13","pis_st_rate":"d:4:3","pis_st_value":"d:2:13","cofins_st_base":"d:2:13","cofins_st_rate":"d:4:3","cofins_st_value":"d:2:13","ret_unit_base":"d:4:11","ret_unit_icms":"d:4:11","ret_unit_substitute":"d:4:11","ret_substitute_value":"d:2:13","ret_base_rate":"d:4:3","ret_base":"d:2:13","ret_rate":"d:4:3","ret_value":"d:2:13","difal_type":"e:N|I","difal_base_rate":"d:4:3","difal_base":"d:2:13","difal_fcp_rate":"d:4:3","difal_fcp_value":"d:2:13","difal_internal_rate":"d:4:3","difal_interstate_rate":"e:4.0000|7.0000|12.0000","difal_share_rate":"d:4:3","difal_dest_value":"d:2:13","difal_origin_value":"d:2:13","complementary_info":"m:2000","fiscal_info":"m:2000"},"ipi":{"taxation":"e:T|I|O","situation":"e:00|01|02|03|04|05|49|50|51|52|53|54|55|99","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","class_code":"t:5","seal_code":"t:60","framing_code":"x:^[0-9]{3}$","tipi_exception":"x:^[0-9]{1,3}$","final_consumer":"b","devol_rate":"d:4:3","devol_value":"d:2:13","complementary_info":"m:2000","fiscal_info":"m:2000"},"pis":{"situation":"e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99","taxation":"e:T|I|O","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","complementary_info":"m:2000","fiscal_info":"m:2000"},"cofins":{"situation":"e:01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99","taxation":"e:T|I|O","base_rate":"d:4:3","base":"d:2:13","rate":"d:4:3","value":"d:2:13","unit_value":"d:4:11","complementary_info":"m:2000","fiscal_info":"m:2000"},"ii":{"situation":"e:T|N","base":"d:2:13","rate":"d:4:3","value":"d:2:13","taxation":"e:T|I|O","customs_expense":"d:2:13","add_icms":"b","add_other":"b","addition":"x:^[0-9]{1,3}$"},"export":{"drawback":"x:^[0-9]{1,20}$","registry":"x:^[0-9]{1,12}$","key":"x:^[0-9]{44}$"},"fuel":{"anp_code":"x:^[0-9]{9}$","anp_description":"t:95","codif":"x:^[0-9]{1,21}$","consumption_state":"e:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO","ambient_qty":"d:4:11","glp_rate":"d:4:3","glgnn_rate":"d:4:3","glgni_rate":"d:4:3","start_value":"d:2:13","cide_base":"d:4:11","cide_rate":"d:4:11","cide_value":"d:2:13","biodiesel_rate":"d:4:3"},"medicine":{"anvisa_code":"x:^([0-9A-Za-z]{13}|ISENTO)$","max_price":"d:2:13","exemption_reason":"t:255"},"others":{"presumed_pis_cofins":"b","funrural_rate":"d:4:3","sped_type":"e:00|01|02|03|04|05|06|07|08|09|10|99","commission_base":"d:2:13","commission_rate":"d:4:3","commission_value":"d:2:13","fci":"x:^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$","purchase_order":"t:15","purchase_order_item":"x:^[0-9]{1,6}$","ibpt_rate":"d:4:3","approx_taxes":"d:2:13","tax_unit":"t:6","tax_quantity":"d:4:11"},"stock":{"supplier_code":"t:60","scale":"e:S|N","manufacturer_cnpj":"x:^[0-9]{14}$"},"retentions":{"csrf":"b","pis_value":"d:2:13","cofins_value":"d:2:13","csll_rate":"d:4:3","csll_value":"d:2:13","ir":"b","ir_csll_base":"d:2:13","ir_rate":"d:4:3","ir_value":"d:2:13"},"weapon":{"type":"e:0|1","description":"t:256","serial":"t:15","barrel":"t:15"},"vehicle":{"operation":"e:0|1|2|3","chassis":"x:^[A-Z0-9]{17}$","color_code":"t:4","color":"t:40","power":"t:4","displacement":"t:4","net_weight":"t:9","gross_weight":"t:9","serial":"t:9","fuel_type":"x:^[0-9]{2}$","engine_number":"t:21","cmt":"t:9","wheelbase":"t:4","model_year":"x:^[0-9]{4}$","manufacture_year":"x:^[0-9]{4}$","paint_type":"t:1","vehicle_type":"x:^[0-9]{1,2}$","species":"e:1|2|3|4|5|6","vin_condition":"e:R|N","vehicle_condition":"e:1|2|3","brand_model_code":"x:^[0-9]{1,6}$","denatran_color":"x:^[0-9]{2}$","capacity":"x:^[0-9]{1,3}$","restriction":"e:0|1|2|3|4|9"}}}'::jsonb
$spec$;
create or replace function erp_fiscal_invoices.invoice_input(p_data jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d jsonb;model text;direction text;issue text;n erp_fiscal_invoices.nature%rowtype;items jsonb:='[]';i jsonb;series integer;number integer;v_key text;
 totals jsonb;weights numeric[]:='{}';fr numeric[];ins numeric[];oth numeric[];dsc numeric[];k integer;freight numeric;insurance numeric;other numeric;discount numeric;
 products numeric:=0;line numeric;sums jsonb;total numeric;deson numeric;nature_description text;item_discounts numeric[]:='{}';item_mode boolean:=false;
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>4194304 or exists(select 1 from jsonb_object_keys(p_data) x where x not in('model','direction','issue_type',
  'series','number','access_key','nature_id','nature_description','cfop','issue_date','exit_date','exit_time','crt','purpose','credit_debit_type','presence','final_consumer',
  'recipient','export','import_declaration','references','items','auto_tax','freight','insurance','other_expenses','discount','transport','payment','authorized_xml',
  'intermediary','additional_info','nature_additional_info','nature_fiscal_info')) then raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 model:=p_data->>'model';direction:=p_data->>'direction';issue:=p_data->>'issue_type';
 if jsonb_typeof(p_data->'model') is distinct from 'string' or model not in('55','65') or jsonb_typeof(p_data->'direction') is distinct from 'string' or direction not in('0','1')
  or jsonb_typeof(p_data->'issue_type') is distinct from 'string' or not((direction='0' and issue in('N','I','T','X')) or (direction='1' and issue in('N','D','E','T','S','C')))
  or (model='65')<>(issue='C') then raise exception 'erp_fiscal_invoice_type_invalid' using errcode='22023'; end if;
 -- XML import (S/X) creates notes only through its own importer, not built yet.
 if issue in('S','X') then raise exception 'erp_fiscal_invoice_issue_type_unavailable' using errcode='22023'; end if;
 if jsonb_typeof(p_data->'series') is distinct from 'string' or p_data->>'series' !~ '^(0|[1-9][0-9]{0,2})$' then raise exception 'erp_fiscal_invoice_series_invalid' using errcode='22023'; end if;
 series:=(p_data->>'series')::integer;
 if issue='T' then
  if jsonb_typeof(p_data->'number') is distinct from 'string' or p_data->>'number' !~ '^[1-9][0-9]{0,8}$' then raise exception 'erp_fiscal_invoice_number_invalid' using errcode='22023'; end if;
  number:=(p_data->>'number')::integer;v_key:=erp_fiscal_invoices.check_value(p_data->'access_key','x:^[0-9]{44}$')#>>'{}';
  if v_key is not null and (not erp_fiscal_invoices.access_key_valid(v_key) or substring(v_key,21,2)<>model or substring(v_key,23,3)::integer<>series or substring(v_key,26,9)::integer<>number) then
   raise exception 'erp_fiscal_invoice_access_key_invalid' using errcode='22023'; end if;
 elsif (p_data->'number' is not null and p_data->'number'<>'null'::jsonb) or (p_data->'access_key' is not null and p_data->'access_key'<>'null'::jsonb) then
  -- Own notes receive number and key only when the homologation series reserves them.
  raise exception 'erp_fiscal_invoice_number_reserved_on_send' using errcode='22023';
 end if;
 nature_description:=erp_fiscal_invoices.text_input(p_data->'nature_description',60);
 if p_data->'nature_id' is not null and p_data->'nature_id'<>'null'::jsonb then
  select * into n from erp_fiscal_invoices.nature where id=erp_fiscal_invoices.uuid_input(p_data->'nature_id');
  if not found or n.direction<>direction then raise exception 'erp_fiscal_invoice_nature_not_found' using errcode='22023'; end if;
  nature_description:=n.description;
 end if;
 if nature_description is null then raise exception 'erp_fiscal_invoice_nature_required' using errcode='22023'; end if;
 if jsonb_typeof(p_data->'crt') is distinct from 'string' or p_data->>'crt' not in('1','2','3','4') or jsonb_typeof(p_data->'purpose') is distinct from 'string'
  or p_data->>'purpose' not in('1','2','3','4','5','6') or jsonb_typeof(p_data->'presence') is distinct from 'string' or p_data->>'presence' not in('0','1','2','3','4','5','9') then
  raise exception 'erp_fiscal_invoice_header_invalid' using errcode='22023'; end if;
 if model='65' and (p_data->>'presence' not in('1','4') or not erp_fiscal_invoices.bool_input(p_data->'final_consumer',true) or direction<>'1' or p_data->>'purpose'<>'1') then
  raise exception 'erp_fiscal_invoice_nfce_invalid' using errcode='22023'; end if;
 if (p_data->>'purpose' not in('5','6') and p_data->'credit_debit_type' is not null and p_data->'credit_debit_type'<>'null'::jsonb) then raise exception 'erp_fiscal_invoice_header_invalid' using errcode='22023'; end if;
 if issue<>'E' and p_data->'export' is not null and p_data->'export'<>'null'::jsonb then raise exception 'erp_fiscal_invoice_export_invalid' using errcode='22023'; end if;
 if issue<>'I' and p_data->'import_declaration' is not null and p_data->'import_declaration'<>'null'::jsonb then raise exception 'erp_fiscal_invoice_import_invalid' using errcode='22023'; end if;
 if jsonb_array_length(erp_fiscal_invoices.array_input(p_data->'items',990))=0 then raise exception 'erp_fiscal_invoice_items_required' using errcode='22023'; end if;
 for i in select value from jsonb_array_elements(p_data->'items') loop items:=items||jsonb_build_array(erp_fiscal_invoices.item_input(i,p_data->>'crt',direction)); end loop;
 freight:=erp_fiscal_invoices.money_input(p_data->'freight');insurance:=erp_fiscal_invoices.money_input(p_data->'insurance');
 other:=erp_fiscal_invoices.money_input(p_data->'other_expenses');discount:=erp_fiscal_invoices.money_input(p_data->'discount');
 for i in select value from jsonb_array_elements(items) loop
  line:=round((i->>'quantity')::numeric*(i->>'unit_price')::numeric,2);
  if line>=10000000000000 then raise exception 'erp_fiscal_invoice_amount_invalid' using errcode='22023'; end if;
  weights:=weights||(case when coalesce((i->>'invoiced')::boolean,true) then line else 0 end);
  if coalesce((i->>'invoiced')::boolean,true) then products:=products+line; end if;
  -- 176 "Informar desconto individualmente nos itens": an item may carry its own discount.
  item_discounts:=item_discounts||coalesce((i->>'discount')::numeric,0);
  if i?'discount' then item_mode:=true; end if;
 end loop;
 if discount>products then raise exception 'erp_fiscal_invoice_discount_exceeds' using errcode='22023'; end if;
 fr:=erp_fiscal_invoices.allocate(freight,weights);ins:=erp_fiscal_invoices.allocate(insurance,weights);
 oth:=erp_fiscal_invoices.allocate(other,weights);
 -- With item discounts, the note discount is their sum and each item keeps its own; otherwise it is spread as before.
 if item_mode then
  if (select coalesce(sum(x),0) from unnest(item_discounts) x)<>discount then raise exception 'erp_fiscal_invoice_discount_mismatch' using errcode='22023'; end if;
  dsc:=item_discounts;
 else dsc:=erp_fiscal_invoices.allocate(discount,weights); end if;
 for k in 1..jsonb_array_length(items) loop
  i:=items->(k-1);
  if (dsc[k]>weights[k] and weights[k]>0) or (weights[k]=0 and dsc[k]>0) then raise exception 'erp_fiscal_invoice_discount_exceeds' using errcode='22023'; end if;
  items:=jsonb_set(items,array[(k-1)::text],i||jsonb_build_object('total',erp_fiscal_invoices.money_text(round((i->>'quantity')::numeric*(i->>'unit_price')::numeric,2)),
   'allocated',jsonb_build_object('freight',erp_fiscal_invoices.money_text(fr[k]),'insurance',erp_fiscal_invoices.money_text(ins[k]),
    'other_expenses',erp_fiscal_invoices.money_text(oth[k]),'discount',erp_fiscal_invoices.money_text(dsc[k]))));
 end loop;
 select jsonb_build_object(
  'icms_base',coalesce(sum((x#>>'{icms,base}')::numeric),0),'icms',coalesce(sum((x#>>'{icms,value}')::numeric),0),
  'st_base',coalesce(sum((x#>>'{icms,st_base}')::numeric),0),'st',coalesce(sum((x#>>'{icms,st_value}')::numeric),0),
  'fcp',coalesce(sum((x#>>'{icms,fcp_value}')::numeric),0),'fcp_st',coalesce(sum((x#>>'{icms,st_fcp_value}')::numeric),0),
  'deson',coalesce(sum((x#>>'{icms,deson_value}')::numeric),0),'deson_deducted',coalesce(sum(case when (x#>>'{icms,deson_deduct}')::boolean then (x#>>'{icms,deson_value}')::numeric end),0),
  'credit',coalesce(sum((x#>>'{icms,credit_value}')::numeric),0),'difal_dest',coalesce(sum((x#>>'{icms,difal_dest_value}')::numeric),0),
  'difal_origin',coalesce(sum((x#>>'{icms,difal_origin_value}')::numeric),0),'difal_fcp',coalesce(sum((x#>>'{icms,difal_fcp_value}')::numeric),0),
  'ipi',coalesce(sum((x#>>'{ipi,value}')::numeric),0),'ipi_devol',coalesce(sum((x#>>'{ipi,devol_value}')::numeric),0),'ii',coalesce(sum((x#>>'{ii,value}')::numeric),0),
  'pis',coalesce(sum((x#>>'{pis,value}')::numeric),0),'cofins',coalesce(sum((x#>>'{cofins,value}')::numeric),0),
  'approx_taxes',coalesce(sum((x#>>'{others,approx_taxes}')::numeric),0),'funrural',0,
  'ret_ir',coalesce(sum((x#>>'{retentions,ir_value}')::numeric),0),'ret_csll',coalesce(sum((x#>>'{retentions,csll_value}')::numeric),0),
  'ret_pis',coalesce(sum((x#>>'{retentions,pis_value}')::numeric),0),'ret_cofins',coalesce(sum((x#>>'{retentions,cofins_value}')::numeric),0),
  'ret_base',coalesce(sum((x#>>'{retentions,ir_csll_base}')::numeric),0))
 into sums from jsonb_array_elements(items) x;
 deson:=(sums->>'deson_deducted')::numeric;
 total:=products-discount-deson+(sums->>'st')::numeric+(sums->>'fcp_st')::numeric+freight+insurance+other+(sums->>'ii')::numeric+(sums->>'ipi')::numeric+(sums->>'ipi_devol')::numeric;
 if total<0 or total>=10000000000000 then raise exception 'erp_fiscal_invoice_amount_invalid' using errcode='22023'; end if;
 select jsonb_object_agg(key,erp_fiscal_invoices.money_text(value::text::numeric)) into totals from jsonb_each(sums);
 totals:=totals||jsonb_build_object('products',erp_fiscal_invoices.money_text(products),'freight',erp_fiscal_invoices.money_text(freight),
  'insurance',erp_fiscal_invoices.money_text(insurance),'other_expenses',erp_fiscal_invoices.money_text(other),'discount',erp_fiscal_invoices.money_text(discount),
  'services','0.00','issqn','0.00','total',erp_fiscal_invoices.money_text(total),'invoiced',erp_fiscal_invoices.money_text(total));
 d:=jsonb_build_object('model',model,'direction',direction,'issue_type',issue,'environment',case when issue in('T','S','X') then null else '2' end,
  'status',case when issue in('T','S','X') then 8 else 1 end,'series',series,'number',number,'access_key',v_key,
  'nature_id',case when n.id is null then null else n.id end,'nature_description',nature_description,
  'cfop',erp_fiscal_invoices.check_value(p_data->'cfop','x:^[1-7][0-9]{3}$')#>>'{}',
  'issue_date',erp_fiscal_invoices.check_value(p_data->'issue_date','a')#>>'{}','exit_date',erp_fiscal_invoices.check_value(p_data->'exit_date','a')#>>'{}',
  'exit_time',erp_fiscal_invoices.check_value(p_data->'exit_time','x:^([01][0-9]|2[0-3]):[0-5][0-9]$')#>>'{}',
  'crt',p_data->>'crt','purpose',p_data->>'purpose','credit_debit_type',erp_fiscal_invoices.check_value(p_data->'credit_debit_type','x:^[0-9]{2}$')#>>'{}',
  'presence',p_data->>'presence','final_consumer',erp_fiscal_invoices.bool_input(p_data->'final_consumer',model='65'),
  'recipient',erp_fiscal_invoices.recipient_input(p_data->'recipient',model),
  'export',case when issue='E' then erp_fiscal_invoices.spec_object(p_data->'export',erp_fiscal_invoices.invoice_specs()->'export') end,
  'import_declaration',case when issue='I' then erp_fiscal_invoices.import_input(p_data->'import_declaration') end,
  'references',erp_fiscal_invoices.references_input(p_data->'references'),'items',items,'auto_tax',erp_fiscal_invoices.bool_input(p_data->'auto_tax',true),
  'freight',erp_fiscal_invoices.money_text(freight),'insurance',erp_fiscal_invoices.money_text(insurance),'other_expenses',erp_fiscal_invoices.money_text(other),
  'discount',erp_fiscal_invoices.money_text(discount),'totals',totals,'transport',erp_fiscal_invoices.transport_input(p_data->'transport'),
  'payment',erp_fiscal_invoices.payment_input(p_data->'payment'),'authorized_xml',erp_fiscal_invoices.authorized_input(p_data->'authorized_xml'),
  'intermediary',erp_fiscal_invoices.spec_object(p_data->'intermediary',erp_fiscal_invoices.invoice_specs()->'intermediary'),
  'additional_info',erp_fiscal_invoices.text_input(p_data->'additional_info',5000,false,true),
  'nature_additional_info',erp_fiscal_invoices.text_input(p_data->'nature_additional_info',5000,false,true),
  'nature_fiscal_info',erp_fiscal_invoices.text_input(p_data->'nature_fiscal_info',2000,false,true));
 if d->>'issue_date' is null then raise exception 'erp_fiscal_invoice_issue_date_required' using errcode='22023'; end if;
 if (d->'intermediary'->>'present')::boolean and not (d->'intermediary') ?& array['cnpj','identification'] then raise exception 'erp_fiscal_invoice_intermediary_invalid' using errcode='22023'; end if;
 return d;
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
  -- 176: "Informar desconto individualmente nos itens" (Configurações de NF-e), outside the preferences block so older Workers keep reading it.
  'item_discount',erp_fiscal_invoices.preference('nfe.desconto_itens','boolean','true'),
  'writable',true,'emission_enabled',false,'production_enabled',false,'data_mode','erp_native');
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_invoice_order_link_states(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_order_link_states(uuid,jsonb) to service_role;
revoke all on function public.erp_fiscal_invoice_order_source(uuid,uuid,text),public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb),public.erp_fiscal_invoice_link(uuid,uuid,jsonb),
 public.erp_fiscal_tax_estimate_context(uuid,text,uuid,jsonb),public.erp_fiscal_invoice_context(uuid,text) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_order_source(uuid,uuid,text),public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb),public.erp_fiscal_invoice_link(uuid,uuid,jsonb),
 public.erp_fiscal_tax_estimate_context(uuid,text,uuid,jsonb),public.erp_fiscal_invoice_context(uuid,text) to service_role;
commit;
