-- 270: Documentos (onda F), parte 4: texto rico seguro nos documentos e o Cabeçalho personalizado das impressões.
-- * Texto rico (erp_documents.rich_text): estrutura fechada {version 1, blocos com alinhamento, recuo e código, trechos com negrito,
--   itálico, sublinhado, cor do texto e de fundo e tamanho}, nunca HTML; a tela e a impressão mostram o texto escapado.
-- * Proposta comercial, "Outros itens ou serviços" (Produtos e serviços eventuais ou não cadastrados): texto rico e "Total outros
--   itens", somado ao total da proposta (as parcelas acompanham o total; o desconto continua sobre os itens).
-- * Proposta comercial, "Condições comerciais" Nenhum | Parcela | Texto: Nenhum e Texto não têm parcelas; Texto guarda o texto rico.
-- * Gerar venda / Gerar ordem de serviço pré-preenchidos: os Outros itens viram um item livre "Outros itens ou serviços" (o total não
--   muda; um desconto em % vira o valor do desconto da proposta); as conversões diretas recusam a proposta com outros itens
--   (erp_proposal_other_items). A cópia conferida mantém os dois campos.
-- * "Exibir tipo de cabeçalho: Personalizado" (Preferências de Vendas, Propostas, Ordens de serviço e Pedidos de compra): o texto do
--   cabeçalho de cada tipo em erp_documents.print_header, gravado pelo administrador com comando, versão e auditoria imutável.
-- Substitui funções das migrações 164, 196, 267 e 268 (conferidas pelo hash; outra versão interrompe a migração). Nenhum efeito de
-- estoque, financeiro ou fiscal; nada escreve no Origin.
begin;

do $$declare r record;begin
 if to_regclass('erp_documents.proposal_version') is null then raise exception 'document_rich_text_270_requires_269' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_documents.extension_keys()','46c0ae1ae23d2eaa31121f6ea612fc1621189d76f51ecaaa8139efda2410e701'),
  ('erp_documents.extension_data(jsonb)','556ea49ce29c4071269c6807b8a2db61b74cf3e52b2865e35191668bb3ad36a6'),
  ('erp_documents.normalize(text,jsonb)','1819897db732af2abe5b09c63ac33bd2a46cd658197d64f77acd376e0ba090d1'),
  ('erp_documents.sale_body_from_proposal(jsonb)','5e034891e40dfd378e62fc40e32bd15a3f45b28f9309bec961490900eff29cd2'),
  ('public.erp_document_conversion_preview(uuid,text,uuid)','6f3704284440108e2fe2f8bf3cf4e5de78af75b4d2d03c59fb114ba9bed0271d'),
  ('public.erp_document_copy_preview(uuid,text,uuid)','cc765b722ae1156650ea5bd8a7286f7595a799ecd20ef54296df155d4f04340d'),
  ('public.erp_proposal_convert(uuid,uuid,integer,uuid)','c8a57f254adddc4913af877fc1a6ff989e03073b120aa8cd1bbfaad7189ec440'),
  ('public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid)','506dd010c85a2d69c54c51ad28dd8146c958b03ae74e8a241b17facdd53ef5ac'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'document_rich_text_270_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- ---------------------------------------------------------------- Texto rico
-- Same rules as packages/erp-domain/src/rich-text.mjs: every key present, at most 200 blocks, 1,000 runs and 20,000 characters.
create function erp_documents.rich_text(p_value jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $function$
declare b jsonb; r jsonb; v_runs integer:=0; v_chars integer:=0;
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 if jsonb_typeof(p_value)<>'object' or (select count(*) from jsonb_object_keys(p_value))<>2 or not(p_value?&array['version','blocks'])
  or p_value->'version'<>'1'::jsonb or jsonb_typeof(p_value->'blocks')<>'array' or jsonb_array_length(p_value->'blocks')>200 then
  raise exception 'erp_document_rich_text_invalid' using errcode='22023'; end if;
 for b in select x from jsonb_array_elements(p_value->'blocks') x loop
  if jsonb_typeof(b)<>'object' or (select count(*) from jsonb_object_keys(b))<>4 or not(b?&array['align','indent','code','runs'])
   or jsonb_typeof(b->'align')<>'string' or b->>'align' not in('left','center','right','justify')
   or jsonb_typeof(b->'indent')<>'number' or b->>'indent'!~'^[0-5]$' or jsonb_typeof(b->'code')<>'boolean' or jsonb_typeof(b->'runs')<>'array' then
   raise exception 'erp_document_rich_text_invalid' using errcode='22023'; end if;
  for r in select x from jsonb_array_elements(b->'runs') x loop
   if jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>7 or not(r?&array['text','bold','italic','underline','color','background','size'])
    or jsonb_typeof(r->'text')<>'string' or r->>'text'='' or r->>'text'~'[\x01-\x1f\x7f]'
    or jsonb_typeof(r->'bold')<>'boolean' or jsonb_typeof(r->'italic')<>'boolean' or jsonb_typeof(r->'underline')<>'boolean'
    or (r->'color'<>'null'::jsonb and (jsonb_typeof(r->'color')<>'string' or r->>'color'!~'^#[0-9a-f]{6}$'))
    or (r->'background'<>'null'::jsonb and (jsonb_typeof(r->'background')<>'string' or r->>'background'!~'^#[0-9a-f]{6}$'))
    or (r->'size'<>'null'::jsonb and (jsonb_typeof(r->'size')<>'number' or r->>'size' not in('8','9','10','11','12','14','16','18','20','24','28','36'))) then
    raise exception 'erp_document_rich_text_invalid' using errcode='22023'; end if;
   v_runs:=v_runs+1; v_chars:=v_chars+char_length(r->>'text');
  end loop;
 end loop;
 if v_runs>1000 or v_chars>20000 then raise exception 'erp_document_rich_text_invalid' using errcode='22023'; end if;
 return p_value;
end $function$;
-- The text without the formatting, one line per block (the pedido item made of the Outros itens takes it as Descrição detalhada).
create function erp_documents.rich_text_plain(p_value jsonb) returns text language sql immutable set search_path=pg_catalog as $function$
 select string_agg(coalesce((select string_agg(r->>'text','' order by rn) from jsonb_array_elements(b->'runs') with ordinality y(r,rn)),''),E'\n' order by bn)
 from jsonb_array_elements(case when jsonb_typeof(p_value->'blocks')='array' then p_value->'blocks' else '[]'::jsonb end) with ordinality x(b,bn)
$function$;

-- ---------------------------------------------------------------- Outros itens e Condições comerciais da proposta
create or replace function erp_documents.extension_keys()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
 select array['ship_date','finish_date','start_time','end_time','customer_po_number','quote_requested','quoted','warranty_days',
  'warranty_months','warranty_info','reception_notes','template_name','delivery_address','order_reference','seller_id',
  'category_id','carrier_id','price_list_id','payment_account_id','payment_means','payment_indicator',
  -- 270: Outros itens ou serviços and Condições comerciais of the proposta.
  'other_items','commercial_conditions']
$function$;

create or replace function erp_documents.extension_data(p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare v_result jsonb:='{}'; v jsonb; k text;
begin
 foreach k in array erp_documents.extension_keys() loop
  if not p_body?k then continue; end if;
  v:=p_body->k;
  if k in('ship_date','finish_date') then v:=to_jsonb(erp_documents.date_value(v));
  elsif k in('start_time','end_time') then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'erp_document_time_invalid' using errcode='22023'; end if;
  elsif k in('quote_requested','quoted') then
   if v<>'null'::jsonb and jsonb_typeof(v)<>'boolean' then raise exception 'erp_document_flag_invalid' using errcode='22023'; end if;
  elsif k='warranty_days' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^(0|[1-9][0-9]{0,3})$') then
    raise exception 'erp_document_warranty_invalid' using errcode='22023'; end if;
  elsif k='warranty_months' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^(0|[1-9][0-9]{0,2})$') then
    raise exception 'erp_document_warranty_invalid' using errcode='22023'; end if;
  elsif k='customer_po_number' then v:=to_jsonb(erp_documents.text_value(v,60));
  elsif k='template_name' then v:=to_jsonb(erp_documents.text_value(v,120));
  elsif k='order_reference' then v:=to_jsonb(erp_documents.text_value(v,100));
  elsif k in('warranty_info','reception_notes') then v:=to_jsonb(erp_documents.text_value(v,4000,false,true));
  elsif k='delivery_address' then v:=erp_documents.delivery_address(v);
  elsif k in('seller_id','category_id','carrier_id','price_list_id','payment_account_id') then v:=to_jsonb(erp_documents.uuid_value(v));
  elsif k='payment_means' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or not (v#>>'{}')=any(erp_documents.payment_types())) then
    raise exception 'erp_document_payment_invalid' using errcode='22023'; end if;
  elsif k='payment_indicator' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}' not in('0','1')) then
    raise exception 'erp_document_payment_invalid' using errcode='22023'; end if;
  -- 270: {content: texto rico | null, total} and {mode: none | installments | text, text: texto rico | null}.
  elsif k='other_items' then
   if v<>'null'::jsonb then
    if jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>2 or not(v?&array['content','total']) then
     raise exception 'erp_document_other_items_invalid' using errcode='22023'; end if;
    v:=jsonb_build_object('content',erp_documents.rich_text(v->'content'),'total',erp_documents.decimal_value(v->'total',2,12)::numeric(18,2)::text);
   end if;
  elsif k='commercial_conditions' then
   if v<>'null'::jsonb then
    if jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>2 or not(v?&array['mode','text']) or jsonb_typeof(v->'mode')<>'string'
     or v->>'mode' not in('none','installments','text') then raise exception 'erp_document_conditions_invalid' using errcode='22023'; end if;
    v:=jsonb_build_object('mode',v->>'mode','text',erp_documents.rich_text(v->'text'));
   end if;
  end if;
  v_result:=v_result||jsonb_build_object(k,coalesce(v,'null'::jsonb));
 end loop;
 return v_result;
end $function$;

create or replace function erp_documents."normalize"(p_kind text, p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare v_core jsonb; v_result jsonb; v_items jsonb:='[]'; v_item jsonb; v_out jsonb; v_i integer:=0; v_installments jsonb:='[]';
 v_ipi numeric:=0; v_st numeric:=0; v_total numeric; v_sum numeric:=0; v_amount numeric; v_code text;
begin
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 -- 268: equipment leaves the core (200 characters there) and is checked here with 4,000 and line breaks.
 v_core:=p_body-erp_documents.extension_keys()-array['installments','tax_ipi','tax_icms_st','equipment'];
 if jsonb_typeof(p_body->'items')='array' then
  v_core:=jsonb_set(v_core,'{items}',(select coalesce(jsonb_agg(case when jsonb_typeof(i.value)='object' then i.value-array['list_price','supplier_code','group','quote','done'] else i.value end order by i.n),'[]'::jsonb)
   from jsonb_array_elements(p_body->'items') with ordinality i(value,n)));
 end if;
 v_result:=erp_documents.normalize_core(p_kind,v_core)||erp_documents.extension_data(p_body);
 if p_kind<>'service_orders' and erp_documents.text_value(p_body->'equipment',4000,false,true) is not null then
  raise exception 'erp_document_service_field_invalid' using errcode='22023'; end if;
 v_result:=v_result||jsonb_build_object('equipment',erp_documents.text_value(p_body->'equipment',4000,false,true));
 -- 270: Outros itens ou serviços and Condições comerciais belong to the proposta.
 if p_kind<>'sales_proposals' and (coalesce(v_result->'other_items','null'::jsonb)<>'null'::jsonb or coalesce(v_result->'commercial_conditions','null'::jsonb)<>'null'::jsonb) then
  raise exception 'erp_document_other_items_invalid' using errcode='22023'; end if;
 if p_kind='purchase_orders' and v_result->>'price_list_id' is not null then raise exception 'erp_document_price_list_invalid' using errcode='22023'; end if;
 if (p_kind='sales_proposals' and v_result->>'payment_account_id' is not null)
  or (p_kind<>'sales_orders' and (v_result->>'payment_means' is not null or v_result->>'payment_indicator' is not null)) then
  raise exception 'erp_document_payment_invalid' using errcode='22023'; end if;
 for v_item in select value from jsonb_array_elements(p_body->'items') loop
  v_out:=v_result->'items'->v_i; v_i:=v_i+1;
  if v_item?'list_price' then
   v_out:=v_out||jsonb_build_object('list_price',case when v_item->'list_price'='null'::jsonb then null
    else erp_catalog.unit_price_numeric(erp_catalog.unit_price(v_item->'list_price',10)::numeric,10) end);
  end if;
  if v_item?'supplier_code' then
   v_code:=erp_documents.text_value(v_item->'supplier_code',100);
   if v_code is not null and p_kind<>'purchase_orders' then raise exception 'erp_document_supplier_code_invalid' using errcode='22023'; end if;
   v_out:=v_out||jsonb_build_object('supplier_code',v_code);
  end if;
  -- 268: Peças / Serviços executados of the OS; Orçar and OK only of a serviço.
  if v_item?'group' or v_item?'quote' or v_item?'done' then
   if p_kind<>'service_orders' or (v_item?'group' and coalesce(v_item->>'group','') not in('part','service'))
    or (v_item?'quote' and jsonb_typeof(v_item->'quote')<>'boolean') or (v_item?'done' and jsonb_typeof(v_item->'done')<>'boolean')
    or ((v_item->'quote'='true'::jsonb or v_item->'done'='true'::jsonb) and v_item->>'group' is distinct from 'service') then
    raise exception 'erp_document_item_group_invalid' using errcode='22023'; end if;
   v_out:=v_out||case when v_item?'group' then jsonb_build_object('group',v_item->>'group') else '{}'::jsonb end
    ||case when v_item?'quote' then jsonb_build_object('quote',v_item->'quote') else '{}'::jsonb end
    ||case when v_item?'done' then jsonb_build_object('done',v_item->'done') else '{}'::jsonb end;
  end if;
  v_items:=v_items||jsonb_build_array(v_out);
 end loop;
 v_result:=jsonb_set(v_result,'{items}',v_items);
 if p_body?'tax_ipi' then v_ipi:=erp_documents.decimal_value(p_body->'tax_ipi',2,12); end if;
 if p_body?'tax_icms_st' then v_st:=erp_documents.decimal_value(p_body->'tax_icms_st',2,12); end if;
 if p_kind='purchase_orders' and (v_ipi<>0 or v_st<>0) then raise exception 'erp_document_tax_invalid' using errcode='22023'; end if;
 -- 270: Total outros itens of the proposta adds to its total.
 v_total:=(v_result#>>'{totals,total}')::numeric+v_ipi+v_st+coalesce((v_result#>>'{other_items,total}')::numeric,0);
 if v_total>999999999999.99 then raise exception 'erp_document_total_limit' using errcode='22023'; end if;
 if p_body?'tax_ipi' or p_body?'tax_icms_st' then
  v_result:=jsonb_set(v_result,'{totals}',(v_result->'totals')||jsonb_build_object('ipi',v_ipi::numeric(18,2)::text,'icms_st',v_st::numeric(18,2)::text,'total',v_total::numeric(18,2)::text))
   ||case when p_body?'tax_ipi' then jsonb_build_object('tax_ipi',v_ipi::numeric(18,2)::text) else '{}'::jsonb end
   ||case when p_body?'tax_icms_st' then jsonb_build_object('tax_icms_st',v_st::numeric(18,2)::text) else '{}'::jsonb end;
 end if;
 if coalesce(v_result->'other_items','null'::jsonb)<>'null'::jsonb then
  v_result:=jsonb_set(v_result,'{totals}',(v_result->'totals')||jsonb_build_object('other_items',v_result#>>'{other_items,total}','total',v_total::numeric(18,2)::text));
 end if;
 if p_body?'installments' and (jsonb_typeof(p_body->'installments')<>'array' or jsonb_array_length(p_body->'installments')>120) then
  raise exception 'erp_document_installments_invalid' using errcode='22023'; end if;
 v_i:=0;
 for v_item in select value from jsonb_array_elements(coalesce(p_body->'installments','[]'::jsonb)) loop
  if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('due_date','amount','method','note','payment_reference','payment_method_id','details')) then
   raise exception 'erp_document_installment_invalid' using errcode='22023'; end if;
  v_amount:=erp_documents.decimal_value(v_item->'amount',2,12);
  if v_amount<=0 then raise exception 'erp_document_installment_invalid' using errcode='22023'; end if;
  v_i:=v_i+1; v_sum:=v_sum+v_amount;
  v_installments:=v_installments||jsonb_build_array(jsonb_build_object('position',v_i,'due_date',erp_documents.date_value(v_item->'due_date',true),
   'amount',v_amount::numeric(18,2)::text,'method',erp_documents.text_value(v_item->'method',100))
   ||case when v_item?'note' then jsonb_build_object('note',erp_documents.text_value(v_item->'note',2000,false,true)) else '{}'::jsonb end
   ||case when v_item?'payment_reference' then jsonb_build_object('payment_reference',erp_documents.commercial_reference(v_item->'payment_reference')) else '{}'::jsonb end
   ||case when v_item?'payment_method_id' then jsonb_build_object('payment_method_id',erp_documents.uuid_value(v_item->'payment_method_id')) else '{}'::jsonb end
   ||case when v_item?'details' then jsonb_build_object('details',erp_documents.installment_details(p_kind,v_item->'details',v_amount)) else '{}'::jsonb end);
 end loop;
 if v_i>0 and v_sum<>v_total then raise exception 'erp_document_installment_total_mismatch' using errcode='22023'; end if;
 -- 270: Condições comerciais Nenhum or Texto carry no parcelas.
 if v_i>0 and v_result#>>'{commercial_conditions,mode}' in('none','text') then raise exception 'erp_document_conditions_invalid' using errcode='22023'; end if;
 return jsonb_set(v_result,'{installments}',v_installments);
end $function$;

-- The pedido / OS made from a proposta never carries the two fields of the proposta.
create or replace function erp_documents.sale_body_from_proposal(p_body jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 select (p_body-array['other_items','commercial_conditions'])||'{"template":false}'::jsonb||case when erp_documents.preference('propostas.data_prevista_prazo')='true'::jsonb
   and p_body#>>'{commercial,transport,delivery_days}'~'^(0|[1-9][0-9]{0,3})$'
   and (p_body->>'date')::date+(p_body#>>'{commercial,transport,delivery_days}')::integer+coalesce((erp_documents.preference('estoque.cross_docking_dias')#>>'{}')::integer,0)<='2099-12-31'::date
  then jsonb_build_object('expected_date',((p_body->>'date')::date+(p_body#>>'{commercial,transport,delivery_days}')::integer
   +coalesce((erp_documents.preference('estoque.cross_docking_dias')#>>'{}')::integer,0))::text) else '{}'::jsonb end
$function$;

create or replace function public.erp_document_conversion_preview(p_user_id uuid, p_kind text, p_proposal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_source erp_documents.document%rowtype; v_body jsonb; v_items jsonb;
begin
 if p_kind is null or p_kind not in('sales_orders','service_orders') then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 select * into v_source from erp_documents.document where id=p_proposal_id and kind='sales_proposals';
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if not erp_documents.contact_usable(p_user_id,v_source.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if exists(select 1 from erp_documents.document where source_proposal_id=p_proposal_id) then raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 v_body:=case when p_kind='sales_orders' then erp_documents.sale_body_from_proposal(v_source.body) else v_source.body||'{"template":false}'::jsonb end;
 v_body:=v_body-array['totals','template_name','valid_until','next_contact','template','other_items','commercial_conditions'];
 v_body:=jsonb_set(v_body,'{installments}',(select coalesce(jsonb_agg(p.value-'position' order by p.n),'[]'::jsonb) from jsonb_array_elements(coalesce(v_body->'installments','[]'::jsonb)) with ordinality p(value,n)));
 select coalesce(jsonb_agg(jsonb_build_object('id',null,'product_id',i.product_id,'description',i.data->'description',
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),
  -- 240: Preferências › Propostas "Enviar informações da descrição detalhada dos produtos para a venda" (off: the pedido starts without it).
  'discount_percent',i.discount_percent::text,'detailed_description',case when p_kind='sales_orders' and erp_documents.preference('propostas.enviar_descricao_venda')='false'::jsonb
   then 'null'::jsonb else coalesce(i.data->'detailed_description','null'::jsonb) end)
  ||case when i.data?'list_price' then jsonb_build_object('list_price',i.data->'list_price') else '{}'::jsonb end
  -- 268: in the OS a product of type Serviço (S) goes to the Serviços executados, the other items to the Peças.
  ||case when p_kind='service_orders' then jsonb_build_object('group',case when i.product_snapshot->>'kind'='S' then 'service' else 'part' end,'quote',false,'done',false) else '{}'::jsonb end order by i.position),'[]'::jsonb) into v_items
  from erp_documents.item i where i.document_id=p_proposal_id;
 -- 270: the Outros itens ou serviços become one free item with their total (the pedido / OS total stays the one of the proposta).
 if coalesce((v_source.body#>>'{other_items,total}')::numeric,0)>0 then
  v_items:=v_items||jsonb_build_array(jsonb_build_object('id',null,'product_id',null,'description','Outros itens ou serviços','code',null,'unit','UN','quantity','1',
   'unit_price',v_source.body#>>'{other_items,total}','discount_percent','0','detailed_description',nullif(left(erp_documents.rich_text_plain(v_source.body#>'{other_items,content}'),4000),''))
   ||case when p_kind='service_orders' then '{"group":"service","quote":false,"done":false}'::jsonb else '{}'::jsonb end);
  if v_body->>'discount_mode'='percent' then
   v_body:=v_body||jsonb_build_object('discount_mode','amount','discount_value',coalesce(v_source.body#>>'{totals,discount}','0.00'));
  end if;
 end if;
 return jsonb_build_object('source',jsonb_build_object('id',v_source.id,'kind','sales_proposals','number',v_source.number::text,'version',v_source.version),
  'kind',p_kind,'data',v_body||jsonb_build_object('items',v_items),'contact',jsonb_build_object('id',v_source.contact_id,'name',left(v_source.contact_snapshot->>'name',200)),
  'price_list_name',(select left(l.name,120) from erp_pricing.price_list l where l.id::text=v_body->>'price_list_id'),
  'persisted',false,'data_mode','erp_native','operational_effects',false);
end $function$;

create or replace function public.erp_document_copy_preview(p_user_id uuid, p_kind text, p_source_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_source erp_documents.document%rowtype; v_data jsonb; v_items jsonb; field text; v_keep_date boolean;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_source.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 v_keep_date:=p_kind='purchase_orders' and erp_documents.preference('compras.clonagem_data')='"data_original"'::jsonb;
 select coalesce(jsonb_agg(jsonb_build_object('id',null,'product_id',i.product_id,'description',i.data->'description',
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),
  'discount_percent',i.discount_percent::text)
  ||case when i.data?'detailed_description' then jsonb_build_object('detailed_description',i.data->'detailed_description') else '{}'::jsonb end
  ||case when i.data?'list_price' then jsonb_build_object('list_price',i.data->'list_price') else '{}'::jsonb end
  ||case when i.data?'supplier_code' then jsonb_build_object('supplier_code',i.data->'supplier_code') else '{}'::jsonb end
  -- 267/268: Peças / Serviços executados of the OS, with Orçar and OK of the serviço.
  ||case when i.data?'group' then jsonb_build_object('group',i.data->'group','quote',coalesce(i.data->'quote','false'::jsonb),'done',coalesce(i.data->'done','false'::jsonb)) else '{}'::jsonb end order by i.position),'[]'::jsonb) into v_items
  from erp_documents.item i where i.document_id=p_source_id;
 v_data:=jsonb_build_object('date',case when v_keep_date then (v_source.body->>'date')::date else (clock_timestamp() at time zone 'America/Sao_Paulo')::date end,
  'contact_id',v_source.contact_id,'warehouse_id',v_source.warehouse_id,'expected_date',case when v_keep_date then (v_source.body->>'expected_date')::date end,'valid_until',null,
  'next_contact',null,'template',false,'items',v_items,'installments','[]'::jsonb,
  'equipment',null,'serial_number',null,'technician',null,'defect',null,'solution',null);
 foreach field in array array['discount_mode','discount_value','freight','other_expenses','payment_terms','delivery_terms','notes','internal_notes'] loop
  v_data:=v_data||jsonb_build_object(field,v_source.body->field);
 end loop;
 if p_kind<>'purchase_orders' and v_source.body->>'seller_id' is not null then v_data:=v_data||jsonb_build_object('seller_id',v_source.body->'seller_id'); end if;
 -- 168: the copy keeps the categoria and the transportador while they can still be chosen.
 if erp_documents.category_usable(p_kind,v_source.body->>'category_id') then v_data:=v_data||jsonb_build_object('category_id',v_source.body->'category_id'); end if;
 if erp_documents.carrier_usable(v_source.body->>'carrier_id') then v_data:=v_data||jsonb_build_object('carrier_id',v_source.body->'carrier_id'); end if;
 -- 196: Lista de preço (valid now), Destino (active conta), Detalhes de pagamento and the taxes of the source.
 if exists(select 1 from erp_pricing.price_list l where l.id::text=v_source.body->>'price_list_id' and erp_pricing.valid_now(l)) then
  v_data:=v_data||jsonb_build_object('price_list_id',v_source.body->'price_list_id'); end if;
 if exists(select 1 from erp_finance.account a where a.id::text=v_source.body->>'payment_account_id' and a.active) then
  v_data:=v_data||jsonb_build_object('payment_account_id',v_source.body->'payment_account_id'); end if;
 -- 270: Outros itens ou serviços and Condições comerciais of the proposta.
 foreach field in array array['payment_means','payment_indicator','tax_ipi','tax_icms_st','other_items','commercial_conditions'] loop
  if v_source.body?field then v_data:=v_data||jsonb_build_object(field,v_source.body->field); end if;
 end loop;
 if erp_documents.has_commercial_data(erp_documents.dto(p_source_id)) then
  select coalesce(jsonb_agg(value||jsonb_build_object('detailed_description',value->'detailed_description') order by ordinality),'[]'::jsonb) into v_items
   from jsonb_array_elements(v_items) with ordinality;
  v_data:=v_data||jsonb_build_object('commercial',v_source.body->'commercial','items',v_items);
 elsif v_source.body?'commercial' then
  v_data:=v_data||jsonb_build_object('commercial',v_source.body->'commercial');
 end if;
 return jsonb_build_object('source',jsonb_build_object('id',v_source.id,'kind',v_source.kind,'number',v_source.number::text,'version',v_source.version),
  'data',v_data,'reset_fields',case when v_keep_date then jsonb_build_array('valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution')
   else jsonb_build_array('date','expected_date','valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution') end,
  'persisted',false,'data_mode','erp_native','operational_effects',false);
end $function$;

create or replace function public.erp_proposal_convert(p_user_id uuid, p_id uuid, p_expected_version integer, p_command_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype; v_sale erp_documents.document%rowtype;
 v_id uuid; v_before jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','convert','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_proposals' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_source.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version or v_source.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 select * into v_sale from erp_documents.document where source_proposal_id=p_id;
 if found then raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 -- 270: a proposta with Outros itens is converted by the prefilled pedido (the free item keeps the total).
 if coalesce((v_source.body#>>'{other_items,total}')::numeric,0)>0 then raise exception 'erp_proposal_other_items' using errcode='22023'; end if;
 perform erp_documents.check_preference_rules('sales_orders',erp_documents.stored_rules_data(p_id));
 v_before:=erp_documents.dto(p_id);
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)
 values('sales_orders',erp_documents.next_number('sales_orders'),erp_documents.initial_status('sales_orders'),v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  erp_documents.sale_body_from_proposal(v_source.body),v_source.total,p_id,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,
   i.data||jsonb_build_object('id',n.new_id)
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null)n where i.document_id=p_id;
 update erp_documents.document set status='completed',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_source.version+1,v_source.status,'completed',null);
 v_result:=jsonb_build_object('proposal',erp_documents.dto(p_id),'sale',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,p_id,'convert_to_sale',v_before,erp_documents.dto(p_id)),
  (p_user_id,p_command_id,v_id,'create_from_proposal',null,erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

create or replace function public.erp_proposal_convert_to_service(p_user_id uuid, p_id uuid, p_expected_version integer, p_command_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype;
 v_id uuid; v_before jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','convert_to_service','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash);
 if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_proposals' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 267: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_source.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version or v_source.version=2147483647 then
  raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from erp_documents.document where source_proposal_id=p_id) then
  raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then
  raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 -- 270: a proposta with Outros itens is converted by the prefilled OS (the free item keeps the total).
 if coalesce((v_source.body#>>'{other_items,total}')::numeric,0)>0 then raise exception 'erp_proposal_other_items' using errcode='22023'; end if;
 perform erp_documents.check_preference_rules('service_orders',erp_documents.stored_rules_data(p_id));
 v_before:=erp_documents.dto(p_id);
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)
 values('service_orders',erp_documents.next_number('service_orders'),'open',v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  (v_source.body-array['other_items','commercial_conditions'])||'{"template":false}'::jsonb,v_source.total,p_id,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,
  i.data||jsonb_build_object('id',n.new_id)
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null)n where i.document_id=p_id;
 update erp_documents.document set status='completed',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_source.version+1,v_source.status,'completed',null);
 v_result:=jsonb_build_object('proposal',erp_documents.dto(p_id),'service_order',erp_documents.dto(v_id),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,p_id,'convert_to_service',v_before,erp_documents.dto(p_id)),
  (p_user_id,p_command_id,v_id,'create_from_proposal',null,erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

-- ---------------------------------------------------------------- Cabeçalho personalizado
create table erp_documents.print_header (
  kind text primary key references erp_documents.numbering(kind),
  content jsonb, version integer not null check(version between 1 and 2147483646),
  updated_by uuid not null references auth.users(id), updated_at timestamptz not null default clock_timestamp()
);
create table erp_documents.print_header_audit (
  id bigint generated always as identity primary key, kind text not null, actor uuid not null references auth.users(id), command_id uuid not null,
  version integer not null, before_data jsonb, after_data jsonb, created_at timestamptz not null default clock_timestamp()
);
create function erp_documents.print_header_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $function$
begin raise exception 'erp_document_print_header_audit_immutable' using errcode='55000'; end $function$;
create trigger print_header_audit_immutable before update or delete on erp_documents.print_header_audit for each row execute function erp_documents.print_header_audit_immutable();
alter table erp_documents.print_header enable row level security; alter table erp_documents.print_header_audit enable row level security;
revoke all on erp_documents.print_header,erp_documents.print_header_audit from public,anon,authenticated,service_role;

create function erp_documents.print_header_view(p_kind text,p_user_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $function$
 select jsonb_build_object('kind',p_kind,'content',h.content,'version',coalesce(h.version,0),'updated_at',h.updated_at,
  'can_manage',exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and m.role='admin'),'data_mode','erp_native','operational_effects',false)
 from (select 1) one left join erp_documents.print_header h on h.kind=p_kind
$function$;
-- Read by whoever reads the documents of the kind (the print uses it with "Personalizado").
create function public.erp_document_print_header(p_user_id uuid,p_kind text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $function$
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 return erp_documents.print_header_view(p_kind,p_user_id);
end $function$;
-- Saved by the administrador: command (Conferir resultado), the version read (CAS) and an immutable audit; null content clears it.
create function public.erp_document_print_header_save(p_user_id uuid,p_kind text,p_command_id uuid,p_expected_version integer,p_content jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $function$
declare v_hash text; v_replay jsonb; v_current erp_documents.print_header%rowtype; v_content jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if not exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and m.role='admin') then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 if p_command_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','print_header','actor',p_user_id,'kind',p_kind,'version',p_expected_version,'content',p_content)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 v_content:=erp_documents.rich_text(p_content);
 perform 1 from erp_documents.numbering where kind=p_kind for update;
 select * into v_current from erp_documents.print_header where kind=p_kind;
 if coalesce(v_current.version,0)<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if v_current.kind is null then insert into erp_documents.print_header(kind,content,version,updated_by) values(p_kind,v_content,1,p_user_id);
 else update erp_documents.print_header set content=v_content,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where kind=p_kind; end if;
 insert into erp_documents.print_header_audit(kind,actor,command_id,version,before_data,after_data) values(p_kind,p_user_id,p_command_id,p_expected_version+1,v_current.content,v_content);
 v_result:=erp_documents.print_header_view(p_kind,p_user_id)||jsonb_build_object('replayed',false);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

revoke all on function erp_documents.rich_text(jsonb),erp_documents.rich_text_plain(jsonb),erp_documents.extension_keys(),erp_documents.extension_data(jsonb),
 erp_documents."normalize"(text,jsonb),erp_documents.sale_body_from_proposal(jsonb),erp_documents.print_header_audit_immutable(),erp_documents.print_header_view(text,uuid)
 from public,anon,authenticated,service_role;
do $$declare f text;begin
 foreach f in array array['erp_document_conversion_preview(uuid,text,uuid)','erp_document_copy_preview(uuid,text,uuid)','erp_proposal_convert(uuid,uuid,integer,uuid)',
  'erp_proposal_convert_to_service(uuid,uuid,integer,uuid)','erp_document_print_header(uuid,text)','erp_document_print_header_save(uuid,text,uuid,integer,jsonb)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end$$;
commit;
