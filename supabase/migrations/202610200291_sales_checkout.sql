-- 291: Vendas › Logística › Checkout de pedidos (Origin vendas.checkout.php) e a situação "Checkout parcial" dos pedidos de venda.
-- * Situação padrão "Checkout parcial" (checkout_partial, código 12 do Origin, #DEF3FC): o pedido Em aberto vai para ela quando o
--   checkout é salvo com parte dos itens conferidos, e dela para Verificado quando todos os itens são conferidos (Origin: "nunca mostra
--   Verificado (só via checkout)"); também volta para Em aberto ou segue para Em andamento ou Cancelado. Editável como Em aberto; sem
--   Lançar estoque nem Lançar contas nela (nenhuma regra de lançamento a aceita). Com estoque ou reserva ativos, Em aberto ↔ Checkout
--   parcial e Checkout parcial → Verificado passam pelas travas.
-- * Checkout (erp_documents.checkout): as quantidades conferidas por linha do pedido (o item, ou o componente da estrutura com
--   "Desmembrar produtos Físico / Virtual em uma estrutura no checkout"), com versão, comando e auditoria imutável. Salvar grava a
--   conferência e muda a situação pela mesma transição dos documentos (erp_document_transition: ocorrência, situação, regras do
--   Gerenciador e lançamento automático de contas ao ir para Verificado): tudo conferido = Verificado; parte = Checkout parcial;
--   nada = Em aberto. Só pedidos Em aberto ou Checkout parcial; nunca mais do que a quantidade da linha.
-- * Leitura: as linhas com código, GTIN, GTIN tributário e localização do cadastro atual, e as opções de Preferências › Vendas ›
--   Checkout de Pedidos (Ordenar itens por localização, Desmembrar, método picking, Salvar automaticamente ao ler todos itens, Permite
--   inserir quantidade do item). "Considerar número do pedido da loja virtual" não entra (não há loja virtual).
-- Substitui erp_documents.transitions() e erp_documents.effects_transition_allowed() da 245 (conferidas pelo hash). Nada escreve no Origin.
-- Publicação: a Página inicial resume os pedidos por situação; publique a API logo depois do banco (a API nova aceita os dois).
begin;

do $$declare r record;begin
 for r in select * from(values
  ('erp_documents.transitions()','2f66ce30634fcbc108237e0c71210f0d9614df50bc835caa22f62a3f93571b98'),
  ('erp_documents.effects_transition_allowed(text,text,text)','47873c2a1e4bb29945c34ce9b6da467483de07200990ad4204ae941c81246faa'),
  ('public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text)','d672aaea4a0a024371173c854874f6c62c8bdb82758dcb859644b8ea8eb17b97'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'sales_checkout_291_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regclass('erp_documents.checkout') is not null then raise exception 'sales_checkout_291_already_applied' using errcode='55000'; end if;
end$$;

-- 245 plus Checkout parcial (pedidos de venda): from Em aberto (the checkout) and to Em aberto, Verificado, Em andamento and Cancelado.
create or replace function erp_documents.transitions()
returns jsonb language sql immutable set search_path=pg_catalog as $$ select '{"sales_proposals":{"draft":["open","pending","waiting","approved","rejected","cancelled"],"open":["draft","pending","waiting","approved","rejected","cancelled"],"pending":["draft","open","waiting","approved","rejected","cancelled"],"waiting":["draft","open","pending","approved","rejected","cancelled"],"approved":["draft","open","pending","waiting","rejected","cancelled"],"rejected":["draft","open","pending","waiting","approved","cancelled"],"cancelled":["draft","open","pending","waiting","approved","rejected"],"completed":[]},"sales_orders":{"draft":["open","verified","in_progress","agency_sale","fulfilled","cancelled"],"open":["draft","verified","in_progress","agency_sale","fulfilled","cancelled","checkout_partial"],"verified":["draft","open","in_progress","agency_sale","fulfilled","cancelled"],"in_progress":["draft","open","verified","agency_sale","partially_fulfilled","fulfilled","cancelled"],"agency_sale":["draft","open","verified","in_progress","fulfilled","cancelled"],"checkout_partial":["open","verified","in_progress","cancelled"],"partially_fulfilled":["in_progress","partially_invoiced","fulfilled","cancelled"],"partially_invoiced":["partially_fulfilled","cancelled"],"fulfilled":["draft","open","verified","in_progress","agency_sale","cancelled"],"cancelled":["draft","open","verified","in_progress","agency_sale","fulfilled"]},"purchase_orders":{"open":["in_progress","fulfilled","cancelled"],"in_progress":["open","partially_fulfilled","fulfilled","cancelled"],"partially_fulfilled":["in_progress","fulfilled","cancelled"],"fulfilled":["open","in_progress","cancelled"],"cancelled":["open","in_progress","fulfilled"]},"service_orders":{"open":["quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"quoted":["open","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"approved":["open","quoted","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"rejected":["open","quoted","approved","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"in_progress":["open","quoted","approved","rejected","waiting_parts","service_done","finalized","no_repair","cancelled"],"waiting_parts":["open","quoted","approved","rejected","in_progress","service_done","finalized","no_repair","cancelled"],"service_done":["open","quoted","approved","rejected","in_progress","waiting_parts","finalized","no_repair","cancelled"],"finalized":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","no_repair","cancelled"],"no_repair":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","cancelled"],"cancelled":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair"]}}'::jsonb $$;

-- 245 plus Em aberto ↔ Checkout parcial and Checkout parcial → Verificado with active effects (the checkout of a pedido with stock).
create or replace function erp_documents.effects_transition_allowed(p_kind text,p_from text,p_to text)
returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_from=p_to or case p_kind
 when 'sales_orders' then (p_from='verified' and p_to='in_progress') or(p_from='in_progress' and p_to in('partially_fulfilled','fulfilled')) or(p_from='partially_fulfilled' and p_to in('fulfilled','partially_invoiced'))
  or(p_from='partially_invoiced' and p_to='partially_fulfilled')
  or(p_from='open' and p_to='checkout_partial') or(p_from='checkout_partial' and p_to in('open','verified'))
 when 'purchase_orders' then (p_from='in_progress' and p_to in('partially_fulfilled','fulfilled')) or(p_from='partially_fulfilled' and p_to='fulfilled')
 when 'service_orders' then (p_from='approved' and p_to='in_progress') or(p_from='in_progress' and p_to in('waiting_parts','service_done')) or(p_from='waiting_parts' and p_to='in_progress') or(p_from='service_done' and p_to='finalized')
 else false end,false);
$$;

-- ---------------------------------------------------------------- Checkout
create table erp_documents.checkout(
 document_id uuid primary key references erp_documents.document(id),
 reads jsonb not null check(jsonb_typeof(reads)='array' and jsonb_array_length(reads)<=1000),
 split boolean not null,
 version integer not null check(version between 1 and 2147483647),
 updated_by uuid not null references auth.users(id), updated_at timestamptz not null default clock_timestamp()
);
create table erp_documents.checkout_audit(
 id bigint generated always as identity primary key, document_id uuid not null, actor uuid not null references auth.users(id), command_id uuid not null,
 version integer not null, status_before text not null, status_after text not null, reads jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create function erp_documents.checkout_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $function$
begin raise exception 'erp_document_checkout_audit_immutable' using errcode='55000'; end $function$;
create trigger checkout_audit_immutable before update or delete on erp_documents.checkout_audit for each row execute function erp_documents.checkout_audit_immutable();
alter table erp_documents.checkout enable row level security; alter table erp_documents.checkout_audit enable row level security;
revoke all on erp_documents.checkout,erp_documents.checkout_audit from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_documents from public,anon,authenticated,service_role;

-- Preferências › Vendas › Checkout de Pedidos.
create function erp_documents.checkout_settings() returns jsonb language sql stable set search_path=pg_catalog as $function$
 select jsonb_build_object('order',case when erp_documents.preference('vendas.checkout_ordenar')='"crescente"'::jsonb then 'crescente' else 'nao_ordenar' end,
  'split',erp_documents.preference('vendas.checkout_desmembrar')='true'::jsonb,'picking',erp_documents.preference('vendas.checkout_picking')='true'::jsonb,
  'auto_save',erp_documents.preference('vendas.checkout_salvar_auto')='true'::jsonb,'quantity_input',erp_documents.preference('vendas.checkout_quantidade')='true'::jsonb)
$function$;
-- The lines of the checkout: each item, or (with Desmembrar) each component of the current structure of its product (quantity × item).
create function erp_documents.checkout_lines(p_id uuid,p_split boolean) returns jsonb language sql stable set search_path=pg_catalog as $function$
 with items as(select i.*,exists(select 1 from erp_stock.composition_current c where c.product_id=i.product_id) composed from erp_documents.item i where i.document_id=p_id),
 lines as(
  select i.position,0 sub,i.id::text line_key,i.id item_id,null::uuid component_id,i.product_id,i.data->>'description' description,i.data->>'code' code,i.data->>'unit' unit,i.quantity,
   case when i.product_id is not null then erp_catalog.dto(i.product_id) end product
  from items i where not(p_split and i.composed)
  union all
  select i.position,c.position,i.id::text||':'||c.component_id::text,i.id,c.component_id,c.component_id,left(r.name,200),left(r.code,100),left(p.unit,16),c.quantity*i.quantity,erp_catalog.dto(c.component_id)
  from items i join erp_stock.composition_current c on c.product_id=i.product_id join erp_catalog.record r on r.id=c.component_id left join erp_catalog.product p on p.record_id=c.component_id
  where p_split and i.composed)
 -- "SEM GTIN" (the GTIN tributário of a product without GTIN) is not a code to read.
 select coalesce(jsonb_agg(jsonb_build_object('key',l.line_key,'item_id',l.item_id,'component_id',l.component_id,'product_id',l.product_id,'position',l.position,
   'description',l.description,'code',l.code,'unit',l.unit,'quantity',l.quantity::numeric(24,6)::text,
   'gtin',case when upper(btrim(l.product->>'gtin')) not in('','SEM GTIN') then btrim(l.product->>'gtin') end,
   'gtin_tax',case when upper(btrim(l.product->>'gtin_tax')) not in('','SEM GTIN') then btrim(l.product->>'gtin_tax') end,
   'location',nullif(btrim(l.product->>'location'),'')) order by l.position,l.sub),'[]'::jsonb)
 from lines l
$function$;
create function erp_documents.checkout_view(p_id uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $function$
declare d erp_documents.document; c erp_documents.checkout; v_settings jsonb:=erp_documents.checkout_settings(); v_split boolean; v_lines jsonb; v_reads jsonb;
begin
 select * into d from erp_documents.document where id=p_id;
 select * into c from erp_documents.checkout where document_id=p_id;
 -- A checkout already started keeps the lines it was read with (the preference can change meanwhile).
 v_split:=coalesce(c.split,(v_settings->>'split')::boolean);
 v_lines:=erp_documents.checkout_lines(p_id,v_split);
 -- Em aberto and Checkout parcial stay editable: the reads saved before are kept only for the lines the pedido still has, never above
 -- the quantity of the line (an item removed or reduced since the last Salvar).
 select coalesce(jsonb_agg(jsonb_build_object('key',r.value->>'key','quantity',least((r.value->>'quantity')::numeric,(l.value->>'quantity')::numeric)::numeric(24,6)::text)
   order by r.ordinality),'[]'::jsonb) into v_reads
  from jsonb_array_elements(coalesce(c.reads,'[]'::jsonb)) with ordinality r(value,ordinality) join jsonb_array_elements(v_lines) l(value) on l.value->>'key'=r.value->>'key';
 -- 'order' (not 'document'): the replay of a command adds the effect flags only to a 'document'.
 return jsonb_build_object('kind','sales_orders','order',jsonb_build_object('id',d.id,'number',d.number::text,'version',d.version,'status',d.status,
   'contact_name',left(d.contact_snapshot->>'name',200),'date',d.body->>'date'),
  'available',d.status in('open','checkout_partial'),'split',v_split,'lines',v_lines,
  'reads',v_reads,'checkout_version',coalesce(c.version,0),'settings',v_settings,'data_mode','erp_native','operational_effects',false);
end $function$;

create function public.erp_document_checkout_get(p_user_id uuid,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $function$
declare v_contact uuid;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 select contact_id into v_contact from erp_documents.document where id=p_id and kind='sales_orders';
 if not found or not erp_documents.contact_usable(p_user_id,v_contact) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 return erp_documents.checkout_view(p_id);
end $function$;

-- Salvar: the reads (never above the line), the checkout version (CAS) and the situação by the same transition of the documents.
create function public.erp_document_checkout_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_checkout_version integer,p_command_id uuid,p_reads jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $function$
declare v_hash text; v_replay jsonb; d erp_documents.document; c erp_documents.checkout; v_lines jsonb; v_split boolean; v_reads jsonb:='[]'::jsonb; r jsonb; l jsonb;
 v_qty numeric; v_keys text[]:='{}'; v_complete boolean:=true; v_any boolean:=false; v_target text; v_transition jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 or p_checkout_version is null or p_checkout_version<0 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','checkout','actor',p_user_id,'id',p_id,'version',p_expected_version,'checkout_version',p_checkout_version,'reads',p_reads)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into d from erp_documents.document where id=p_id and kind='sales_orders' for update;
 if not found or not erp_documents.contact_usable(p_user_id,d.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if d.version<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if d.status not in('open','checkout_partial') then raise exception 'erp_document_checkout_unavailable' using errcode='40001'; end if;
 select * into c from erp_documents.checkout where document_id=p_id for update;
 if coalesce(c.version,0)<>p_checkout_version or c.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_split:=coalesce(c.split,(erp_documents.checkout_settings()->>'split')::boolean);
 v_lines:=erp_documents.checkout_lines(p_id,v_split);
 if p_reads is null or jsonb_typeof(p_reads)<>'array' or jsonb_array_length(p_reads)>1000 then raise exception 'erp_document_checkout_invalid' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(p_reads) loop
  if jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>2 or not(r?&array['key','quantity']) or jsonb_typeof(r->'key')<>'string' or r->>'key'=any(v_keys) then
   raise exception 'erp_document_checkout_invalid' using errcode='22023'; end if;
  select x into l from jsonb_array_elements(v_lines) x where x->>'key'=r->>'key';
  if l is null then raise exception 'erp_document_checkout_invalid' using errcode='22023'; end if;
  v_qty:=erp_documents.decimal_value(r->'quantity',6,15);
  if v_qty>(l->>'quantity')::numeric then raise exception 'erp_document_checkout_exceeds' using errcode='22023'; end if;
  v_keys:=v_keys||(r->>'key');
  if v_qty>0 then v_reads:=v_reads||jsonb_build_array(jsonb_build_object('key',r->>'key','quantity',v_qty::numeric(24,6)::text)); v_any:=true; end if;
 end loop;
 for l in select value from jsonb_array_elements(v_lines) loop
  if coalesce((select (x->>'quantity')::numeric from jsonb_array_elements(v_reads) x where x->>'key'=l->>'key'),0)<>(l->>'quantity')::numeric then v_complete:=false; end if;
 end loop;
 if jsonb_array_length(v_lines)=0 then raise exception 'erp_document_checkout_invalid' using errcode='22023'; end if;
 v_target:=case when v_complete then 'verified' when v_any then 'checkout_partial' else 'open' end;
 if c.document_id is null then insert into erp_documents.checkout(document_id,reads,split,version,updated_by) values(p_id,v_reads,v_split,1,p_user_id);
 else update erp_documents.checkout set reads=v_reads,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where document_id=p_id; end if;
 insert into erp_documents.checkout_audit(document_id,actor,command_id,version,status_before,status_after,reads)
  values(p_id,p_user_id,p_command_id,p_checkout_version+1,d.status,v_target,v_reads);
 if v_target<>d.status then
  -- The situação changes by the transition of the documents (occurrence, Gerenciador, automatic contas), with a derived command.
  v_transition:=public.erp_document_transition(p_user_id,'sales_orders',p_id,d.version,md5(p_command_id::text||':checkout')::uuid,v_target,null);
 end if;
 v_result:=erp_documents.checkout_view(p_id)||jsonb_build_object('complete',v_complete,'replayed',false)
  ||case when v_transition?'auto_finance' then jsonb_build_object('auto_finance',v_transition->'auto_finance') else '{}'::jsonb end;
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

revoke all on function erp_documents.transitions(),erp_documents.effects_transition_allowed(text,text,text),erp_documents.checkout_audit_immutable(),
 erp_documents.checkout_settings(),erp_documents.checkout_lines(uuid,boolean),erp_documents.checkout_view(uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_document_checkout_get(uuid,uuid)','erp_document_checkout_save(uuid,uuid,integer,integer,uuid,jsonb)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
