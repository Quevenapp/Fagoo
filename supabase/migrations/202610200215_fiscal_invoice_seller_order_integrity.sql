-- 215: Notas fiscais no padrão Origin, onda D (paridade item a item, 20/10/2026).
-- 1. Uma nota por pedido também no Salvar: duas abas abertas com "Gerar nota fiscal" do mesmo pedido de venda (ou da mesma OS)
--    não gravam duas notas. erp_fiscal_invoice_execute e erp_fiscal_invoice_link recusam (erp_fiscal_invoice_order_has_invoice)
--    um vínculo novo de nota de saída com pedido de venda ou OS que já tem outra nota do Brufap não excluída; o pedido é
--    travado (pg_advisory_xact_lock) para que duas gravações simultâneas não passem juntas. Vínculos que a nota já tinha
--    continuam (notas antigas seguem editáveis). Pedidos de compra continuam aceitando várias notas de entrada (Vinculação Parcial).
-- 2. Vendedor da nota (Destinatário › Vendedor): invoice.seller_id (cadastro de vendedores), copiado do pedido ou do contato e
--    filtrável na lista (Vendedor). Nas notas do Origin, o filtro usa o vendedor do Origin ligado ao contato do vendedor do Brufap
--    (mesma ligação das comissões, 171).
-- 3. "Preencher manualmente Destino da Operação" (Preferências › Configurações de NF-e): invoice.operation_destination (idDest
--    1 interna, 2 interestadual, 3 exterior), conferido contra o destinatário (3 só para estrangeiro; NFC-e só 1).
-- 4. erp_fiscal_invoice_order_source_v2: o pedido com o vendedor, o transportador do cadastro (grupo transporta: CNPJ/CPF, IE, UF,
--    município e endereço) e "Considerar a data da venda / da ordem de serviço nas parcelas" (keep_order_dates). A versão anterior
--    continua como estava para o Worker anterior.
-- 5. erp_fiscal_invoice_contact_source: Contribuinte (indIEDest), e-mail da NF-e, natureza de operação padrão e vendedor do
--    contato escolhido no formulário da nota (contatos onda B: contact_profile).
-- 6. erp_fiscal_invoice_context: a preferência do Destino da Operação manual e as de "Permite a visualização das contas a receber /
--    a pagar em aberto nos pedidos/notas fiscais", fora do bloco preferences (o Worker anterior continua lendo o contexto).
-- Nada aqui emite, transmite, reserva número ou lança estoque/contas; as travas de ambiente 022/041/046/064 não mudam.
-- Requer as migrações publicadas até 202610200190 (112, 113, 140, 142, 143, 176, a 124 dos contatos e a 127 das formas de pagamento).
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare v record;begin
 if to_regclass('erp_catalog.contact_profile') is null or to_regclass('erp_catalog.seller') is null or to_regprocedure('erp_catalog.contact_require_visible(uuid,uuid)') is null then
  raise exception 'fiscal_invoice_215_requires_124' using errcode='55000'; end if;
 if to_regprocedure('public.erp_fiscal_invoice_order_source(uuid,uuid,text)') is null then raise exception 'fiscal_invoice_215_requires_176' using errcode='55000'; end if;
 if to_regclass('erp_catalog.payment_method') is null then raise exception 'fiscal_invoice_215_requires_127' using errcode='55000'; end if;
 for v in select * from(values
  ('public.erp_fiscal_invoice_execute(uuid,uuid,text,jsonb)','827a98d36a9cdd302554b138ee6bd2908661c74f890894d226b67719ef5b0132'),
  ('public.erp_fiscal_invoice_link(uuid,uuid,jsonb)','2570cccceafd700c71068d24a1c749d00002b7e614cf08b483ea68daccfc3f46'),
  ('erp_fiscal_invoices.invoice_input(jsonb)','d06b948fee013c514b385402c1a13a489c801895307b2b4d70f17362aabf539c'),
  ('erp_fiscal_invoices.invoice_record(uuid)','e9b6e8014de4bce74c4e3bf5dd44871a10c988b84428d75870b0da41d86cf021'),
  ('public.erp_fiscal_invoice_context(uuid,text)','9bc2eb0fb1d67893082fcbf3449d5c5f5e41631d8df3b5f12e7eae84730573f6'),
  ('public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text)','03f7df9b1243ca4c727ca55d2de047a4a25b83f54c7f8e2a69e4305312a70ae4'))v(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'fiscal_invoice_215_previous_definition_changed' using errcode='55000',detail=v.sig; end if;
 end loop;
end$$;

alter table erp_fiscal_invoices.invoice add column seller_id uuid references erp_catalog.seller(id),
 add column operation_destination text check(operation_destination in('1','2','3'));
create index erp_fiscal_invoice_seller on erp_fiscal_invoices.invoice(seller_id) where seller_id is not null and deleted_at is null;

-- 176 plus "Vendedor" (seller_id) and "Destino da Operação" (operation_destination). Both keys are optional so an older form keeps
-- working: absent on an update, the stored value stays (erp_fiscal_invoice_execute).
create or replace function erp_fiscal_invoices.invoice_input(p_data jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d jsonb;model text;direction text;issue text;n erp_fiscal_invoices.nature%rowtype;items jsonb:='[]';i jsonb;series integer;number integer;v_key text;
 totals jsonb;weights numeric[]:='{}';fr numeric[];ins numeric[];oth numeric[];dsc numeric[];k integer;freight numeric;insurance numeric;other numeric;discount numeric;
 products numeric:=0;line numeric;sums jsonb;total numeric;deson numeric;nature_description text;item_discounts numeric[]:='{}';item_mode boolean:=false;
 v_seller uuid;v_destination text;recipient jsonb;
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>4194304 or exists(select 1 from jsonb_object_keys(p_data) x where x not in('model','direction','issue_type',
  'series','number','access_key','nature_id','nature_description','cfop','issue_date','exit_date','exit_time','crt','purpose','credit_debit_type','presence','final_consumer',
  'recipient','export','import_declaration','references','items','auto_tax','freight','insurance','other_expenses','discount','transport','payment','authorized_xml',
  'intermediary','additional_info','nature_additional_info','nature_fiscal_info','seller_id','operation_destination')) then raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
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
 recipient:=erp_fiscal_invoices.recipient_input(p_data->'recipient',model);
 -- 215 "Vendedor": a seller of the cadastro (erp_fiscal_invoice_execute checks that a new one has an active contact).
 if p_data?'seller_id' then
  v_seller:=erp_fiscal_invoices.uuid_input(p_data->'seller_id',false);
  if v_seller is not null and not exists(select 1 from erp_catalog.seller s where s.id=v_seller) then raise exception 'erp_fiscal_invoice_seller_unavailable' using errcode='22023'; end if;
 end if;
 -- 215 "Destino da Operação" (idDest): 3 only for a foreign recipient and always for one; the NFC-e is always 1 (interna).
 if p_data?'operation_destination' and p_data->'operation_destination'<>'null'::jsonb then
  if jsonb_typeof(p_data->'operation_destination')<>'string' or p_data->>'operation_destination' not in('1','2','3') then raise exception 'erp_fiscal_invoice_destination_invalid' using errcode='22023'; end if;
  v_destination:=p_data->>'operation_destination';
  -- coalesce: a recipient without Tipo or UF is not foreign (a null comparison must not let '3' through).
  if (v_destination='3')<>coalesce(recipient->>'person_type'='E' or recipient->>'state'='EX',false) or (model='65' and v_destination<>'1') then
   raise exception 'erp_fiscal_invoice_destination_invalid' using errcode='22023'; end if;
 end if;
 d:=jsonb_build_object('model',model,'direction',direction,'issue_type',issue,'environment',case when issue in('T','S','X') then null else '2' end,
  'status',case when issue in('T','S','X') then 8 else 1 end,'series',series,'number',number,'access_key',v_key,
  'nature_id',case when n.id is null then null else n.id end,'nature_description',nature_description,
  'cfop',erp_fiscal_invoices.check_value(p_data->'cfop','x:^[1-7][0-9]{3}$')#>>'{}',
  'issue_date',erp_fiscal_invoices.check_value(p_data->'issue_date','a')#>>'{}','exit_date',erp_fiscal_invoices.check_value(p_data->'exit_date','a')#>>'{}',
  'exit_time',erp_fiscal_invoices.check_value(p_data->'exit_time','x:^([01][0-9]|2[0-3]):[0-5][0-9]$')#>>'{}',
  'crt',p_data->>'crt','purpose',p_data->>'purpose','credit_debit_type',erp_fiscal_invoices.check_value(p_data->'credit_debit_type','x:^[0-9]{2}$')#>>'{}',
  'presence',p_data->>'presence','final_consumer',erp_fiscal_invoices.bool_input(p_data->'final_consumer',model='65'),
  'recipient',recipient,
  'export',case when issue='E' then erp_fiscal_invoices.spec_object(p_data->'export',erp_fiscal_invoices.invoice_specs()->'export') end,
  'import_declaration',case when issue='I' then erp_fiscal_invoices.import_input(p_data->'import_declaration') end,
  'references',erp_fiscal_invoices.references_input(p_data->'references'),'items',items,'auto_tax',erp_fiscal_invoices.bool_input(p_data->'auto_tax',true),
  'freight',erp_fiscal_invoices.money_text(freight),'insurance',erp_fiscal_invoices.money_text(insurance),'other_expenses',erp_fiscal_invoices.money_text(other),
  'discount',erp_fiscal_invoices.money_text(discount),'totals',totals,'transport',erp_fiscal_invoices.transport_input(p_data->'transport'),
  'payment',erp_fiscal_invoices.payment_input(p_data->'payment'),'authorized_xml',erp_fiscal_invoices.authorized_input(p_data->'authorized_xml'),
  'intermediary',erp_fiscal_invoices.spec_object(p_data->'intermediary',erp_fiscal_invoices.invoice_specs()->'intermediary'),
  'additional_info',erp_fiscal_invoices.text_input(p_data->'additional_info',5000,false,true),
  'nature_additional_info',erp_fiscal_invoices.text_input(p_data->'nature_additional_info',5000,false,true),
  'nature_fiscal_info',erp_fiscal_invoices.text_input(p_data->'nature_fiscal_info',2000,false,true))
  ||case when p_data?'seller_id' then jsonb_build_object('seller_id',v_seller) else '{}'::jsonb end
  ||case when p_data?'operation_destination' then jsonb_build_object('operation_destination',v_destination) else '{}'::jsonb end;
 if d->>'issue_date' is null then raise exception 'erp_fiscal_invoice_issue_date_required' using errcode='22023'; end if;
 if (d->'intermediary'->>'present')::boolean and not (d->'intermediary') ?& array['cnpj','identification'] then raise exception 'erp_fiscal_invoice_intermediary_invalid' using errcode='22023'; end if;
 return d;
end $$;

-- 112 plus the seller (with its name for the form) and the Destino da Operação.
create or replace function erp_fiscal_invoices.invoice_record(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',v.id,'model',v.model,'direction',v.direction,'issue_type',v.issue_type,'environment',v.environment,'status',v.status,'version',v.version,
  'series',v.series,'number',v.number,'access_key',v.access_key,'protocol',v.protocol,'authorized_at',v.authorized_at,'nature_id',v.nature_id,
  'nature_description',v.nature_description,'cfop',v.cfop,'issue_date',v.issue_date,'exit_date',v.exit_date,'exit_time',v.exit_time,'crt',v.crt,'purpose',v.purpose,
  'credit_debit_type',v.credit_debit_type,'presence',v.presence,'final_consumer',v.final_consumer,'recipient',v.recipient,'export',v.export,
  'import_declaration',v.import_declaration,'references',v.doc_references,
  'items',coalesce((select jsonb_agg(i.data||jsonb_build_object('position',i.position) order by i.position) from erp_fiscal_invoices.invoice_item i where i.invoice_id=v.id),'[]'::jsonb),
  'auto_tax',v.auto_tax,'freight',erp_fiscal_invoices.money_text(v.freight),'insurance',erp_fiscal_invoices.money_text(v.insurance),
  'other_expenses',erp_fiscal_invoices.money_text(v.other_expenses),'discount',erp_fiscal_invoices.money_text(v.discount),'totals',v.totals,'transport',v.transport,
  'payment',v.payment,'authorized_xml',v.authorized_xml,'intermediary',v.intermediary,'additional_info',v.additional_info,
  'nature_additional_info',v.nature_additional_info,'nature_fiscal_info',v.nature_fiscal_info,
  'orders',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'date',d.body->>'date','contact_name',c.name) order by d.number,d.id)
   from erp_fiscal_invoices.invoice_order o join erp_documents.document d on d.id=o.document_id left join erp_catalog.record c on c.id=d.contact_id where o.invoice_id=v.id),'[]'::jsonb),
  'seller_id',v.seller_id,'seller_name',(select left(r.name,200) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id=v.seller_id),
  'operation_destination',v.operation_destination,
  'created_at',v.created_at,'updated_at',v.updated_at,'deleted_at',v.deleted_at,'delete_reason',v.delete_reason)
 from erp_fiscal_invoices.invoice v where v.id=p_id
$$;

-- One note per pedido de venda / OS: the new links of an exit note must not belong to another Brufap note that is not deleted.
-- The documents are locked in a fixed order first, so two saves of the same pedido wait for each other instead of both passing.
create function erp_fiscal_invoices.require_single_invoice(p_id uuid,p_direction text,p_orders jsonb) returns void language plpgsql set search_path=pg_catalog as $$
declare o uuid;
begin
 if p_direction<>'1' then return; end if;
 for o in select distinct erp_fiscal_invoices.uuid_input(x) id from jsonb_array_elements(erp_fiscal_invoices.array_input(p_orders,20)) x order by 1 loop
  if p_id is not null and exists(select 1 from erp_fiscal_invoices.invoice_order where invoice_id=p_id and document_id=o) then continue; end if;
  perform pg_advisory_xact_lock(174852946,hashtext(o::text));
  if exists(select 1 from erp_documents.document d where d.id=o and d.kind in('sales_orders','service_orders'))
   and exists(select 1 from erp_fiscal_invoices.invoice_order x join erp_fiscal_invoices.invoice n on n.id=x.invoice_id
    where x.document_id=o and n.deleted_at is null and n.direction='1' and n.id is distinct from p_id) then
   raise exception 'erp_fiscal_invoice_order_has_invoice' using errcode='40001'; end if;
 end loop;
end $$;

create or replace function public.erp_fiscal_invoice_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;keys text[];v_id uuid;expected integer;v erp_fiscal_invoices.invoice%rowtype;d jsonb;rec jsonb;result jsonb;reason text;locks jsonb;parcels_locked boolean:=false;
 v_seller uuid;v_destination text;
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
 -- 219 "Forma" of the parcels: the same rule for a forma de pagamento excluded in Cadastros (the note that has it keeps saving).
 if p_action in('create','update') and exists(select 1 from jsonb_array_elements(coalesce(d#>'{payment,installments}','[]'::jsonb)) x
   join erp_catalog.payment_method m on m.id::text=x->>'payment_method_id'
   where m.deleted_at is not null and (p_action='create' or not exists(select 1 from jsonb_array_elements(coalesce(v.payment->'installments','[]'::jsonb)) y
    where y->>'payment_method_id'=m.id::text))) then
  raise exception 'erp_fiscal_invoice_payment_method_not_found' using errcode='22023'; end if;
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
 if p_action in('create','update') then
  perform erp_fiscal_invoices.require_orders_readable(role,v_id,p_data->'orders');
  -- 215: one note per pedido de venda / OS, also when two tabs save the same "Gerar nota fiscal".
  perform erp_fiscal_invoices.require_single_invoice(v_id,d->>'direction',p_data->'orders');
  -- 215 "Vendedor": absent from an older form, the stored seller stays; a new or changed seller needs an active contact.
  v_seller:=case when d?'seller_id' then (d->>'seller_id')::uuid when p_action='update' then v.seller_id end;
  if v_seller is not null and v_seller is distinct from v.seller_id
   and not exists(select 1 from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id=v_seller and r.active) then
   raise exception 'erp_fiscal_invoice_seller_unavailable' using errcode='22023'; end if;
  v_destination:=case when d?'operation_destination' then d->>'operation_destination' when p_action='update' then v.operation_destination end;
  if v_destination is not null and not d?'operation_destination'
   and (v_destination='3')<>coalesce(d#>>'{recipient,person_type}'='E' or d#>>'{recipient,state}'='EX',false) then v_destination:=null; end if;
 end if;
 if p_action='create' then
  insert into erp_fiscal_invoices.invoice(model,direction,issue_type,environment,status,series,number,access_key,nature_id,nature_description,cfop,issue_date,exit_date,exit_time,
   crt,purpose,credit_debit_type,presence,final_consumer,recipient,export,import_declaration,doc_references,transport,payment,authorized_xml,intermediary,additional_info,
   nature_additional_info,nature_fiscal_info,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by,seller_id,operation_destination)
  values(d->>'model',d->>'direction',d->>'issue_type',d->>'environment',(d->>'status')::smallint,(d->>'series')::integer,(d->>'number')::integer,d->>'access_key',
   (d->>'nature_id')::uuid,d->>'nature_description',d->>'cfop',(d->>'issue_date')::date,(d->>'exit_date')::date,d->>'exit_time',d->>'crt',d->>'purpose',d->>'credit_debit_type',
   d->>'presence',(d->>'final_consumer')::boolean,d->'recipient',nullif(d->'export','null'::jsonb),nullif(d->'import_declaration','null'::jsonb),d->'references',d->'transport',
   d->'payment',d->'authorized_xml',d->'intermediary',d->>'additional_info',d->>'nature_additional_info',d->>'nature_fiscal_info',(d->>'auto_tax')::boolean,
   (d->>'freight')::numeric,(d->>'insurance')::numeric,(d->>'other_expenses')::numeric,(d->>'discount')::numeric,d->'totals',p_user_id,p_user_id,v_seller,v_destination) returning id into v_id;
 elsif p_action='update' then
  update erp_fiscal_invoices.invoice set issue_type=d->>'issue_type',
   series=(d->>'series')::integer,number=(d->>'number')::integer,access_key=case when d->>'issue_type' in('T','S','X') then d->>'access_key' else v.access_key end,
   nature_id=(d->>'nature_id')::uuid,nature_description=d->>'nature_description',cfop=d->>'cfop',issue_date=(d->>'issue_date')::date,exit_date=(d->>'exit_date')::date,
   exit_time=d->>'exit_time',crt=d->>'crt',purpose=d->>'purpose',credit_debit_type=d->>'credit_debit_type',presence=d->>'presence',final_consumer=(d->>'final_consumer')::boolean,
   recipient=d->'recipient',export=nullif(d->'export','null'::jsonb),import_declaration=nullif(d->'import_declaration','null'::jsonb),doc_references=d->'references',
   transport=d->'transport',payment=d->'payment',authorized_xml=d->'authorized_xml',intermediary=d->'intermediary',additional_info=d->>'additional_info',
   nature_additional_info=d->>'nature_additional_info',nature_fiscal_info=d->>'nature_fiscal_info',auto_tax=(d->>'auto_tax')::boolean,freight=(d->>'freight')::numeric,
   insurance=(d->>'insurance')::numeric,other_expenses=(d->>'other_expenses')::numeric,discount=(d->>'discount')::numeric,totals=d->'totals',
   seller_id=v_seller,operation_destination=v_destination,
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

-- 176 plus one note per pedido de venda / OS on "Vincular".
create or replace function public.erp_fiscal_invoice_link(p_user_id uuid,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;v erp_fiscal_invoices.invoice%rowtype;v_id uuid;doc uuid;expected integer;action text;rec jsonb;result jsonb;
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
  perform erp_fiscal_invoices.require_single_invoice(v_id,v.direction,jsonb_build_array(doc));
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

-- The contact snapshot the note form copies (the same keys as the pedido source of 176).
create function erp_fiscal_invoices.contact_snapshot(p_contact_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('contact_id',r.id,'name',r.name,'code',r.code,'active',r.active,'trade_name',c.trade_name,'person_type',c.person_type,'document',c.document,'ie',c.ie,
   'email',c.email,'phone',c.phone,'mobile',c.mobile,'postal_code',c.postal_code,'street',c.street,'number',c.number,'complement',c.complement,'district',c.district,'city',c.city,'state',c.state,
   'taxpayer',p.taxpayer,'country',p.country,'nfe_email',p.nfe_email)
 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id left join erp_catalog.contact_profile p on p.record_id=r.id
 where r.id=p_contact_id and r.entity='contacts'
$$;
-- Seller of the cadastro with its name, or null.
create function erp_fiscal_invoices.seller_ref(p_seller uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',s.id,'name',left(r.name,200)) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id=p_seller and r.active
$$;

-- "Gerar nota fiscal" (176) plus the seller and the carrier of the pedido and the parcels rule of Preferências › Configurações de
-- NF-e: "Considerar a data da venda nas parcelas" (pedido de venda) and "... da ordem de serviço ..." (OS). Off (Origin default),
-- the form moves each parcel by the days between the pedido and the note; on, the parcels keep the pedido due dates.
create function erp_fiscal_invoices.order_source_v2(p_document_id uuid,p_model text) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d erp_documents.document%rowtype;base jsonb;carrier jsonb;keep boolean;
begin
 base:=erp_fiscal_invoices.order_source(p_document_id,p_model);
 select * into d from erp_documents.document where id=p_document_id;
 if d.body->>'carrier_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  carrier:=erp_fiscal_invoices.contact_snapshot((d.body->>'carrier_id')::uuid)-'code'-'trade_name'-'email'-'phone'-'mobile'-'taxpayer'-'country'-'nfe_email';
 end if;
 keep:=case d.kind when 'sales_orders' then (erp_fiscal_invoices.preference('nfe.data_venda_parcelas','boolean','false'))::text::boolean
  when 'service_orders' then (erp_fiscal_invoices.preference('nfe.data_os_parcelas','boolean','false'))::text::boolean else true end;
 return base||jsonb_build_object('seller',coalesce(case when d.body->>'seller_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then erp_fiscal_invoices.seller_ref((d.body->>'seller_id')::uuid) end,'null'::jsonb),'carrier',coalesce(carrier,'null'::jsonb),'keep_order_dates',keep);
end $$;
create function public.erp_fiscal_invoice_order_source_v2(p_user_id uuid,p_document_id uuid,p_model text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);v_kind text;
begin
 if p_document_id is null or p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 -- Same rule as 176: the pedido leaves only to the profiles that read its kind (erp_documents.allowed).
 select d.kind into v_kind from erp_documents.document d where d.id=p_document_id;
 if v_kind is not null and not erp_documents.allowed(role,v_kind,false) then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 return erp_fiscal_invoices.order_source_v2(p_document_id,p_model)||jsonb_build_object('writable',role in('admin','fiscal'),'emission_enabled',false,'production_enabled',false,'data_mode','erp_native');
end $$;

-- A contact picked in the note form (destinatário, remetente or transportadora): current cadastro with Contribuinte and e-mail da
-- NF-e, its natureza de operação padrão when it fits the direction of the note (the form checks the regime) and its vendedor.
-- "Contato acessível somente ao vendedor vinculado" applies (erp_catalog.contact_require_visible).
create function public.erp_fiscal_invoice_contact_source(p_user_id uuid,p_contact_id uuid,p_direction text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);contact jsonb;p erp_catalog.contact_profile%rowtype;nature jsonb;
begin
 if p_contact_id is null or p_direction is null or p_direction not in('0','1') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 contact:=erp_fiscal_invoices.contact_snapshot(p_contact_id);
 if contact is null then raise exception 'erp_fiscal_invoice_contact_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);
 select * into p from erp_catalog.contact_profile where record_id=p_contact_id;
 select jsonb_build_object('id',n.id,'description',n.description,'crt',n.crt) into nature from erp_fiscal_invoices.nature n
  where n.id=p.operation_nature_id and n.direction=p_direction and n.active and n.deleted_at is null;
 return jsonb_build_object('contact',contact,'nature',coalesce(nature,'null'::jsonb),'seller',coalesce(erp_fiscal_invoices.seller_ref(p.seller_id),'null'::jsonb),
  'writable',role in('admin','fiscal'),'data_mode','erp_native');
end $$;

-- 176 plus "Preencher manualmente Destino da Operação" and the open contas panels, outside the preferences block.
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
  -- 215: "Preencher manualmente Destino da Operação" (NF-e only: the NFC-e is always interna).
  'operation_destination_manual',p_model='55' and (erp_fiscal_invoices.preference('nfe.destino_manual','boolean','false'))::text::boolean,
  -- 215: Vendas / Suprimentos "Permite a visualização das contas a receber / a pagar em aberto nos pedidos/notas fiscais".
  'open_titles',jsonb_build_object('receivable',erp_fiscal_invoices.preference('vendas.ver_contas_receber','boolean','false'),
   'payable',erp_fiscal_invoices.preference('compras.ver_contas_pagar','boolean','false')),
  'writable',true,'emission_enabled',false,'production_enabled',false,'data_mode','erp_native');
end $$;

-- Origin vendedor ids of a Brufap seller: Origin vendedor -> Origin contact -> Brufap contact -> seller (the link of commissions, 171).
create function erp_fiscal_invoices.origin_seller_ids(p_seller uuid) returns text[] language sql stable set search_path=pg_catalog as $$
 select coalesce(array_agg(distinct r.source_id),'{}'::text[]) from origin_sync.raw_record r
  join erp_catalog.origin o on o.entity='contacts' and o.source_id=(r.payload#>>'{contato,id}')
  join erp_catalog.seller s on s.contact_id=o.record_id
 where r.entity='sellers' and s.id=p_seller
$$;

-- 140 plus the Vendedor filter (p_seller_id, last and optional so the previous Worker keeps calling it).
drop function public.erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text);
create function public.erp_fiscal_invoice_list(p_user_id uuid,p_origin text default 'origin',p_model text default '55',p_direction text default '1',p_page integer default 1,
 p_limit integer default 100,p_order text default 'date_desc',p_query text default null,p_date_type text default 'issue',p_date_from date default null,p_date_to date default null,
 p_status text default null,p_product_id uuid default null,p_state text default null,p_nature text default null,p_carrier text default null,p_trade_name text default null,
 p_person_type text default null,p_document text default null,p_email text default null,p_phone text default null,p_series integer default null,p_contact_code text default null,
 p_order_number text default null,p_tracking text default null,p_seller_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_read(p_user_id);q text:=nullif(btrim(p_query),'');qd text;codes smallint[];product_code text;result jsonb;origin_sellers text[];
 v_entity text:=case p_model when '65' then 'nfce' else 'nfe' end;
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
do $$ declare f text; begin
 foreach f in array array['erp_fiscal_invoice_execute(uuid,uuid,text,jsonb)','erp_fiscal_invoice_link(uuid,uuid,jsonb)','erp_fiscal_invoice_context(uuid,text)',
  'erp_fiscal_invoice_order_source_v2(uuid,uuid,text)','erp_fiscal_invoice_contact_source(uuid,uuid,text)',
  'erp_fiscal_invoice_list(uuid,text,text,text,integer,integer,text,text,text,date,date,text,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
