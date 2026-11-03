-- 287: Documentos (onda G), parte 1: lotes dos itens, garantia por item da OS, IPI % do pedido de compra, valores dos campos
-- customizados da OS e casas decimais da quantidade.
-- * "Informar lotes" (pedido de venda e peças da OS): o item de um produto pode levar lots [{lot_id, quantity}], até 50 lotes do
--   próprio produto, sem repetir, quantidades com até 6 casas e soma igual à quantidade do item. Lista vazia = "Sem lote" (não é
--   guardada). A frente de estoque consome exatamente esses lotes no Lançar estoque e no Estornar estoque do documento; sem lotes,
--   o lançamento continua "Sem lote" como antes. Mudar os lotes segue a mesma trava dos itens (com estoque lançado, estorne antes).
-- * Garantia (dias) por item da OS: warranty_days do item, de 0 a 9999, só nas ordens de serviço.
-- * IPI % do pedido de compra (Origin: coluna "IPI %" dos itens e "Total do IPI"): ipi_rate do item, até 100% com 4 casas. O IPI do
--   item é o total do item × alíquota, em centavos (meio para cima), e o Total do IPI (a soma) entra no total do pedido; o pedido de
--   compra não guarda tax_ipi (o IPI vem só dos itens). O "Total ICMS ST" do pedido de compra continua fora.
-- * Campos customizados da OS: custom_fields {id do campo: valor}, conferidos pelas definições de erp_documents.custom_field (a tela
--   de Preferências › Sistema › Campos customizados › Ordem de Serviço chega na 288): tipo, opção, tamanho, obrigatório e ativo.
-- * Preferências › Empresa "Número de casas decimais na quantidade": as quantidades dos itens e dos lotes aceitam até essa
--   quantidade de casas (no máximo 6, a precisão do estoque; 7 a 10 valem como 6) e o acesso dos documentos informa o valor às telas.
-- Substitui funções das migrações 164, 168, 239 e 270 (conferidas pelo hash; outra versão interrompe a migração). Nenhum documento,
-- movimento, saldo ou conta existente é reescrito; nada escreve no Origin.
begin;

do $$declare r record;begin
 if to_regclass('erp_documents.print_header') is null or to_regclass('erp_stock.lot') is null then
  raise exception 'document_item_extensions_287_requires_258_270' using errcode='55000'; end if;
 if to_regclass('erp_documents.custom_field') is not null then raise exception 'document_item_extensions_287_already_applied' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_documents.normalize(text,jsonb)','02122bca8b7a949b19a85c128dfe0ecd6f64341cbc32ded653d53745f57d71ae'),
  ('erp_documents.check_links(text,jsonb,jsonb)','98210730c1d6895a6116287477ec0c500ac47b7c36dd4b872909a0867b6c9170'),
  ('erp_documents.check_preference_rules(text,jsonb)','0078e27ca3341287ed286529dc8cdd6025df7a7a9d9fd5a957086bf1287e21a8'),
  ('public.erp_document_access(uuid)','f53f31f5aca95e8c7f95425969ba46f1e9ed21498e0335a1d574d4a7fc9d2058'),
  ('public.erp_document_copy_preview(uuid,text,uuid)','37c3637583ecd99b214a3ad197fbdcc33f966584af3b1d1b5b4aabcb8c10250c'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'document_item_extensions_287_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- ---------------------------------------------------------------- Campos customizados da OS (definições)
-- Same model as the campos customizados of the produtos (156): fixed type, name, hint, info, required, sizes, list options, width
-- and situação. The options of a list keep their ids (the value of an OS is the id of the option).
create table erp_documents.custom_field(
 id uuid primary key default gen_random_uuid(),
 kind text not null default 'service_orders' check(kind='service_orders') references erp_documents.numbering(kind),
 field_type text not null check(field_type in('integer','decimal','list','text','long_text','boolean','date')),
 name text not null check(length(name) between 1 and 60 and name=btrim(name) and name!~'[[:cntrl:]]'),
 hint text check(length(hint) between 1 and 100 and hint=btrim(hint) and hint!~'[[:cntrl:]]'),
 info text check(length(info) between 1 and 300 and info=btrim(info,E' \t\r\n')),
 required boolean not null default false,
 min_length integer check(min_length between 1 and 4000),
 max_length integer check(max_length between 1 and 4000),
 width text not null default 'medium' check(width in('small','medium','large','extra_large')),
 options jsonb not null default '[]'::jsonb check(jsonb_typeof(options)='array' and jsonb_array_length(options)<=50),
 active boolean not null default true,
 version integer not null default 1 check(version between 1 and 2147483647),
 created_by uuid not null references auth.users(id), updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 check(min_length is null or max_length is null or min_length<=max_length),
 check((min_length is null and max_length is null) or field_type in('integer','decimal','text','long_text')),
 check((field_type='list')=(jsonb_array_length(options)>0))
);
create unique index erp_documents_custom_field_name on erp_documents.custom_field(kind,lower(name));
create table erp_documents.custom_field_audit(
 id bigint generated always as identity primary key,
 actor uuid not null references auth.users(id), command_id uuid not null, field_id uuid not null,
 action text not null check(action in('create','update','delete')),
 before_data jsonb, after_data jsonb, created_at timestamptz not null default clock_timestamp()
);
create function erp_documents.custom_field_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $function$
begin raise exception 'erp_document_custom_field_audit_immutable' using errcode='55000'; end $function$;
create trigger custom_field_audit_immutable before update or delete on erp_documents.custom_field_audit for each row execute function erp_documents.custom_field_audit_immutable();
alter table erp_documents.custom_field enable row level security; alter table erp_documents.custom_field_audit enable row level security;
revoke all on erp_documents.custom_field,erp_documents.custom_field_audit from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_documents from public,anon,authenticated,service_role;

-- The canonical text of a value (as erp_catalog.custom_value of the produtos): integer and decimal exact (the decimal without
-- trailing zeros), text on one line and long text with line breaks, boolean 'true'/'false', date AAAA-MM-DD, list = id of the
-- option. The sizes count the characters of the value. A value that is not already canonical is refused.
create function erp_documents.custom_field_value(f erp_documents.custom_field,p_value text) returns text
language plpgsql immutable set search_path=pg_catalog as $function$
declare v text:=p_value;
begin
 if v is null or v='' then return null; end if;
 if f.field_type in('text','long_text') and v<>btrim(v) then raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
 if f.field_type='integer' then
  if v!~'^-?(0|[1-9][0-9]{0,17})$' or v='-0' then raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
 elsif f.field_type='decimal' then
  if v!~'^-?(0|[1-9][0-9]{0,14})(\.[0-9]{0,5}[1-9])?$' or v='-0' then raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
 elsif f.field_type='text' then
  if length(v)>255 or v~'[[:cntrl:]]' then raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
 elsif f.field_type='long_text' then
  if length(v)>4000 or translate(v,E'\n\r\t','')~'[[:cntrl:]]' then raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
 elsif f.field_type='boolean' then
  if v not in('true','false') then raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
 elsif f.field_type='date' then
  if v!~'^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' or erp_documents.date_value(to_jsonb(v))::text<>v then raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
 else
  if v!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or not exists(select 1 from jsonb_array_elements(f.options) o where o->>'id'=v) then
   raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
 end if;
 if(f.min_length is not null and length(v)<f.min_length) or(f.max_length is not null and length(v)>f.max_length) then
  raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
 return v;
end $function$;

-- The values of a save: fields of the kind; an inactive field keeps only the value already saved; every required active field filled.
create function erp_documents.check_custom_fields(p_kind text,p_values jsonb,p_before jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $function$
declare v_field erp_documents.custom_field; v_key text; v_text text;
begin
 for v_key,v_text in select x.key,x.value#>>'{}' from jsonb_each(coalesce(p_values,'{}'::jsonb)) x loop
  select * into v_field from erp_documents.custom_field x where x.id=v_key::uuid and x.kind=p_kind;
  if not found then raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
  if not v_field.active and (p_before is null or p_before#>>array['custom_fields',v_key] is distinct from v_text) then
   raise exception 'erp_document_custom_field_inactive' using errcode='22023'; end if;
  if v_field.active and erp_documents.custom_field_value(v_field,v_text) is distinct from v_text then raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
 end loop;
 if exists(select 1 from erp_documents.custom_field x where x.kind=p_kind and x.active and x.required and coalesce(p_values->>x.id::text,'')='') then
  raise exception 'erp_document_custom_field_required' using errcode='22023'; end if;
end $function$;

-- ---------------------------------------------------------------- Corpo do documento
create or replace function erp_documents."normalize"(p_kind text, p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare v_core jsonb; v_result jsonb; v_items jsonb:='[]'; v_item jsonb; v_out jsonb; v_i integer:=0; v_installments jsonb:='[]';
 v_ipi numeric:=0; v_st numeric:=0; v_total numeric; v_sum numeric:=0; v_amount numeric; v_code text;
 v_item_ipi numeric:=0; v_rated boolean:=false; v_rate numeric; v_lots jsonb; v_lot jsonb; v_lot_sum numeric; v_seen uuid[]; v_lot_id uuid; v_qty numeric;
 v_fields jsonb; v_key text; v_value jsonb;
begin
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 -- 268: equipment leaves the core (200 characters there) and is checked here with 4,000 and line breaks.
 -- 287: custom_fields (campos customizados of the OS) are checked here too.
 v_core:=p_body-erp_documents.extension_keys()-array['installments','tax_ipi','tax_icms_st','equipment','custom_fields'];
 if jsonb_typeof(p_body->'items')='array' then
  v_core:=jsonb_set(v_core,'{items}',(select coalesce(jsonb_agg(case when jsonb_typeof(i.value)='object' then i.value-array['list_price','supplier_code','group','quote','done','lots','warranty_days','ipi_rate'] else i.value end order by i.n),'[]'::jsonb)
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
  -- 287: Informar lotes (pedido de venda and peças of the OS): lots of the product adding up to the quantity; [] = Sem lote.
  if v_item?'lots' and v_item->'lots'<>'null'::jsonb then
   if p_kind not in('sales_orders','service_orders') or jsonb_typeof(v_item->'lots')<>'array' or jsonb_array_length(v_item->'lots')>50 then
    raise exception 'erp_document_item_lots_invalid' using errcode='22023'; end if;
   if jsonb_array_length(v_item->'lots')>0 then
    if v_out->>'product_id' is null or (p_kind='service_orders' and v_item->>'group' is not distinct from 'service') then
     raise exception 'erp_document_item_lots_invalid' using errcode='22023'; end if;
    v_lots:='[]'::jsonb; v_lot_sum:=0; v_seen:='{}';
    for v_lot in select value from jsonb_array_elements(v_item->'lots') loop
     if jsonb_typeof(v_lot)<>'object' or (select count(*) from jsonb_object_keys(v_lot))<>2 or not(v_lot?&array['lot_id','quantity']) then
      raise exception 'erp_document_item_lots_invalid' using errcode='22023'; end if;
     v_lot_id:=erp_documents.uuid_value(v_lot->'lot_id',true);
     if v_lot_id=any(v_seen) then raise exception 'erp_document_item_lots_invalid' using errcode='22023'; end if;
     v_seen:=v_seen||v_lot_id;
     v_qty:=erp_documents.decimal_value(v_lot->'quantity',6,9);
     if v_qty<=0 then raise exception 'erp_document_item_lots_invalid' using errcode='22023'; end if;
     v_lot_sum:=v_lot_sum+v_qty;
     v_lots:=v_lots||jsonb_build_array(jsonb_build_object('lot_id',v_lot_id,'quantity',v_qty::numeric(18,6)::text));
    end loop;
    if v_lot_sum<>(v_out->>'quantity')::numeric then raise exception 'erp_document_item_lots_quantity' using errcode='22023'; end if;
    v_out:=v_out||jsonb_build_object('lots',v_lots);
   end if;
  end if;
  -- 287: Garantia (dias) of the item of the OS.
  if v_item?'warranty_days' and v_item->'warranty_days'<>'null'::jsonb then
   if p_kind<>'service_orders' or jsonb_typeof(v_item->'warranty_days')<>'string' or v_item->>'warranty_days'!~'^(0|[1-9][0-9]{0,3})$' then
    raise exception 'erp_document_warranty_invalid' using errcode='22023'; end if;
   v_out:=v_out||jsonb_build_object('warranty_days',v_item->>'warranty_days');
  end if;
  -- 287: IPI % of the item of the pedido de compra; its IPI is the total of the item × the rate, in cents.
  if v_item?'ipi_rate' and v_item->'ipi_rate'<>'null'::jsonb then
   if p_kind<>'purchase_orders' then raise exception 'erp_document_tax_invalid' using errcode='22023'; end if;
   v_rate:=erp_documents.decimal_value(v_item->'ipi_rate',4,3);
   if v_rate>100 then raise exception 'erp_document_tax_invalid' using errcode='22023'; end if;
   v_out:=v_out||jsonb_build_object('ipi_rate',v_rate::numeric(7,4)::text);
   v_item_ipi:=v_item_ipi+round((v_out->>'total')::numeric*v_rate/100,2); v_rated:=true;
  end if;
  v_items:=v_items||jsonb_build_array(v_out);
 end loop;
 v_result:=jsonb_set(v_result,'{items}',v_items);
 -- 287: Campos customizados of the OS: {id: value}, empty values dropped; the definitions are checked by check_links.
 if p_body?'custom_fields' and p_body->'custom_fields'<>'null'::jsonb then
  if p_kind<>'service_orders' or jsonb_typeof(p_body->'custom_fields')<>'object' or (select count(*) from jsonb_object_keys(p_body->'custom_fields'))>60 then
   raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
  v_fields:='{}'::jsonb;
  for v_key,v_value in select x.key,x.value from jsonb_each(p_body->'custom_fields') x loop
   if v_key!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or (v_value<>'null'::jsonb and jsonb_typeof(v_value)<>'string')
    or length(v_value#>>'{}')>4000 or translate(coalesce(v_value#>>'{}',''),E'\n\r\t','')~'[[:cntrl:]]' then
    raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
   if coalesce(v_value#>>'{}','')<>'' then v_fields:=v_fields||jsonb_build_object(v_key,v_value#>>'{}'); end if;
  end loop;
  if v_fields<>'{}'::jsonb then v_result:=v_result||jsonb_build_object('custom_fields',v_fields); end if;
 end if;
 if p_body?'tax_ipi' then v_ipi:=erp_documents.decimal_value(p_body->'tax_ipi',2,12); end if;
 if p_body?'tax_icms_st' then v_st:=erp_documents.decimal_value(p_body->'tax_icms_st',2,12); end if;
 -- 287: the pedido de compra takes its IPI only from the IPI % of the items (a tax_ipi sent with them follows the items and is not
 -- kept); it still has no ICMS ST.
 if v_rated then v_ipi:=v_item_ipi;
 elsif p_kind='purchase_orders' and v_ipi<>0 then raise exception 'erp_document_tax_invalid' using errcode='22023'; end if;
 if p_kind='purchase_orders' and v_st<>0 then raise exception 'erp_document_tax_invalid' using errcode='22023'; end if;
 -- 270: Total outros itens of the proposta adds to its total.
 v_total:=(v_result#>>'{totals,total}')::numeric+v_ipi+v_st+coalesce((v_result#>>'{other_items,total}')::numeric,0);
 if v_total>999999999999.99 then raise exception 'erp_document_total_limit' using errcode='22023'; end if;
 if p_body?'tax_ipi' or p_body?'tax_icms_st' or v_rated then
  v_result:=jsonb_set(v_result,'{totals}',(v_result->'totals')||jsonb_build_object('ipi',v_ipi::numeric(18,2)::text,'icms_st',v_st::numeric(18,2)::text,'total',v_total::numeric(18,2)::text))
   ||case when p_body?'tax_ipi' and not v_rated then jsonb_build_object('tax_ipi',v_ipi::numeric(18,2)::text) else '{}'::jsonb end
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

-- ---------------------------------------------------------------- Conferências da gravação
-- 168 plus: the lots of each item are lots of its product (Estoque › Lotes e validades), and the campos customizados of the OS.
create or replace function erp_documents.check_links(p_kind text,p_data jsonb,p_before jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_kind='sales_proposals' and p_data->>'category_id' is not null then raise exception 'erp_document_category_invalid' using errcode='22023'; end if;
 if p_data->>'category_id' is not null and (p_before is null or p_before->>'category_id' is distinct from p_data->>'category_id')
  and not erp_documents.category_usable(p_kind,p_data->>'category_id') then
  raise exception 'erp_document_category_unavailable' using errcode='22023'; end if;
 if p_data->>'carrier_id' is not null and (p_before is null or p_before->>'carrier_id' is distinct from p_data->>'carrier_id')
  and not erp_documents.carrier_usable(p_data->>'carrier_id') then
  raise exception 'erp_document_carrier_unavailable' using errcode='22023'; end if;
 -- 287: a lot of another product (or a lot that does not exist) is refused.
 if exists(select 1 from jsonb_array_elements(coalesce(p_data->'items','[]'::jsonb)) i cross join jsonb_array_elements(coalesce(i->'lots','[]'::jsonb)) l
  where not exists(select 1 from erp_stock.lot x where x.id=(l->>'lot_id')::uuid and x.product_id=(i->>'product_id')::uuid)) then
  raise exception 'erp_document_item_lot_unavailable' using errcode='22023'; end if;
 if p_kind='service_orders' then perform erp_documents.check_custom_fields(p_kind,p_data->'custom_fields',p_before); end if;
end $$;

-- 164 plus Preferências › Empresa "Número de casas decimais na quantidade" (items and lots; at most 6, the stock precision).
create or replace function erp_documents.check_preference_rules(p_kind text,p_data jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
declare v_decimals integer;
begin
 if p_kind='sales_orders' and erp_documents.preference('vendas.produtos_nao_cadastrados')='false'::jsonb
  and exists(select 1 from jsonb_array_elements(p_data->'items') i where i->>'product_id' is null) then
  raise exception 'erp_document_product_required' using errcode='22023'; end if;
 if p_kind='service_orders' and erp_documents.preference('os.itens_repetidos')='false'::jsonb
  and exists(select 1 from jsonb_array_elements(p_data->'items') i where i->>'product_id' is not null group by i->>'product_id' having count(*)>1) then
  raise exception 'erp_document_item_repeated' using errcode='22023'; end if;
 if p_kind='sales_proposals' and erp_documents.preference('propostas.proximo_contato_obrigatorio')='true'::jsonb
  and not coalesce((p_data->>'template')::boolean,false) and p_data->>'next_contact' is null then
  raise exception 'erp_document_next_contact_required' using errcode='22023'; end if;
 if p_kind='purchase_orders' and p_data->>'seller_id' is not null then raise exception 'erp_document_seller_invalid' using errcode='22023'; end if;
 if p_data->>'seller_id' is null and ((p_kind='sales_orders' and erp_documents.preference('vendas.vendedor_obrigatorio')='true'::jsonb)
  or (p_kind='sales_proposals' and erp_documents.preference('propostas.vendedor_obrigatorio')='true'::jsonb and not coalesce((p_data->>'template')::boolean,false))
  or (p_kind='service_orders' and erp_documents.preference('os.vendedor_obrigatorio')='true'::jsonb)) then
  raise exception 'erp_document_seller_required' using errcode='22023'; end if;
 v_decimals:=coalesce((erp_documents.preference(case when p_kind='purchase_orders' then 'empresa.decimais_preco_entrada' else 'empresa.decimais_preco_saida' end)#>>'{}')::integer,10);
 if exists(select 1 from jsonb_array_elements(p_data->'items') i where erp_documents.price_decimals(i->>'unit_price')>v_decimals) then
  raise exception 'erp_document_price_decimals' using errcode='22023'; end if;
 -- 287: "Número de casas decimais na quantidade" (0 to 10; the quantities keep at most 6).
 v_decimals:=erp_documents.quantity_decimals();
 if exists(select 1 from jsonb_array_elements(p_data->'items') i where erp_documents.price_decimals(i->>'quantity')>v_decimals
  or exists(select 1 from jsonb_array_elements(coalesce(i->'lots','[]'::jsonb)) l where erp_documents.price_decimals(l->>'quantity')>v_decimals)) then
  raise exception 'erp_document_quantity_decimals' using errcode='22023'; end if;
end $$;
create function erp_documents.quantity_decimals() returns integer language sql stable set search_path=pg_catalog as $$
 select least(greatest(coalesce(case when jsonb_typeof(erp_documents.preference('empresa.decimais_quantidade'))='number'
  then (erp_documents.preference('empresa.decimais_quantidade')#>>'{}')::integer end,6),0),6)
$$;

-- 239 plus settings.quantity_decimals (Preferências › Empresa "Número de casas decimais na quantidade", 0 to 6).
create or replace function public.erp_document_access(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if not found then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 return jsonb_build_object('read',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.kind_allowed(p_user_id,v_role,k,false)),
  'write',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.kind_allowed(p_user_id,v_role,k,true)),
  'settings',jsonb_build_object(
   'price_decimals_out',coalesce((erp_documents.preference('empresa.decimais_preco_saida')#>>'{}')::integer,10),
   'price_decimals_in',coalesce((erp_documents.preference('empresa.decimais_preco_entrada')#>>'{}')::integer,10),
   'weight_decimals',least(greatest(coalesce((erp_documents.preference('empresa.decimais_peso')#>>'{}')::integer,3),0),5),
   'quantity_decimals',erp_documents.quantity_decimals(),
   'cross_docking_days',coalesce((erp_documents.preference('estoque.cross_docking_dias')#>>'{}')::integer,0),
   'occurrence_date_editable',erp_documents.preference('empresa.editar_data_ocorrencia')='true'::jsonb,
   'stock_launch_date',case when erp_documents.preference('estoque.data_lancamento')='"data_documento"'::jsonb then 'data_documento' else 'data_atual' end,
   'auto_products',jsonb_build_object('sales',erp_documents.preference('produtos.cadastro_auto_vendas')='true'::jsonb,
    'purchases',erp_documents.preference('produtos.cadastro_auto_compras')='true'::jsonb,'services',erp_documents.preference('produtos.cadastro_auto_os')='true'::jsonb),
   'default_warehouse',(select jsonb_build_object('id',r.id,'name',left(r.name,200)) from erp_stock.warehouse_default x join erp_catalog.record r on r.id=x.warehouse_id where r.active)),
  'seller',(select jsonb_build_object('id',s.id,'name',left(r.name,200),'allow_unregistered_products',s.allow_unregistered_products,'view_stock',s.view_stock,
    'discount_limit',s.discount_limit::numeric(7,4)::text) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.user_id=p_user_id),
  -- 239: what the screens enable for the user (Sistema › Usuários › Permissões; the server checks each action again).
  'permissions',jsonb_build_object(
   'service_orders',jsonb_build_object('situations',erp_documents.os_permitted(p_user_id,'situacoes'),'stock',erp_documents.os_permitted(p_user_id,'lancar_estoque'),
    'finance',erp_documents.os_permitted(p_user_id,'lancar_contas'),'finance_history',erp_documents.os_permitted(p_user_id,'historico_financeiro'),
    'payment_method',erp_documents.os_permitted(p_user_id,'forma_pagamento')),
   'sales_orders',jsonb_build_object('discount_approver',erp_documents.discount_approver(p_user_id,'sales_orders'),
    'approval_situations',to_jsonb(erp_documents.approval_situations()))),
  'data_mode','erp_native','operational_effects',false);
end $$;

-- 270 plus the Garantia of the items of the OS, the IPI % of the items of the pedido de compra and the campos customizados of the
-- OS (active fields only). The lots of the items are not copied (the copy is a new sale; inform them again).
create or replace function public.erp_document_copy_preview(p_user_id uuid, p_kind text, p_source_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_source erp_documents.document%rowtype; v_data jsonb; v_items jsonb; field text; v_keep_date boolean; v_fields jsonb;
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
  ||case when i.data?'group' then jsonb_build_object('group',i.data->'group','quote',coalesce(i.data->'quote','false'::jsonb),'done',coalesce(i.data->'done','false'::jsonb)) else '{}'::jsonb end
  -- 287: Garantia of the item (OS) and IPI % of the item (pedido de compra).
  ||case when i.data?'warranty_days' then jsonb_build_object('warranty_days',i.data->'warranty_days') else '{}'::jsonb end
  ||case when i.data?'ipi_rate' then jsonb_build_object('ipi_rate',i.data->'ipi_rate') else '{}'::jsonb end order by i.position),'[]'::jsonb) into v_items
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
 -- 287: the campos customizados of the OS whose field is still active.
 if p_kind='service_orders' and jsonb_typeof(v_source.body->'custom_fields')='object' then
  select jsonb_object_agg(x.key,x.value) into v_fields from jsonb_each(v_source.body->'custom_fields') x
   join erp_documents.custom_field f on f.id::text=x.key and f.kind=p_kind and f.active;
  if v_fields is not null then v_data:=v_data||jsonb_build_object('custom_fields',v_fields); end if;
 end if;
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

revoke all on function erp_documents."normalize"(text,jsonb),erp_documents.check_links(text,jsonb,jsonb),erp_documents.check_preference_rules(text,jsonb),
 erp_documents.quantity_decimals(),erp_documents.custom_field_value(erp_documents.custom_field,text),erp_documents.check_custom_fields(text,jsonb,jsonb),
 erp_documents.custom_field_audit_immutable() from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_document_access(uuid)','erp_document_copy_preview(uuid,text,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
