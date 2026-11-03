-- 240: Documentos (onda E), parte 3: estrutura dos produtos para as impressões e a descrição detalhada ao gerar venda.
-- * erp_document_structures: a estrutura atual (Estoque › composições, 222) de cada produto de um documento salvo, com a quantidade
--   de cada componente por unidade e no total do item, e a Produção do produto (Própria | Terceiros). Lida pelas impressões do
--   pedido de venda ("Opções de impressão": Desmembrar produtos da estrutura e Ocultar itens produzidos por terceiros) e pelo
--   Relatório de Produção ("Exibir estrutura de itens"). Somente leitura, para quem lê o documento (e vê o contato).
-- * Preferências › Vendas › Propostas "Enviar informações da descrição detalhada dos produtos para a venda": desligada, o pedido de
--   venda aberto a partir da proposta (Gerar venda) começa sem a descrição detalhada dos itens. A OS gerada da proposta não muda.
-- Substitui erp_document_conversion_preview (196, conferida pelo hash; outra versão interrompe a migração).
begin;

do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure('public.erp_document_conversion_preview(uuid,text,uuid)'))
  is distinct from 'dddc5994e45202705312988257cc08512e9beda02ab990ca69123c30a0e5a4d0' then
  raise exception 'document_print_structures_240_previous_definition_changed' using errcode='55000',detail='public.erp_document_conversion_preview(uuid,text,uuid)';end if;
end$$;

create function public.erp_document_structures(p_user_id uuid,p_kind text,p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_contact uuid;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select contact_id into v_contact from erp_documents.document where id=p_document_id and kind=p_kind;
 if not found or not erp_documents.contact_usable(p_user_id,v_contact) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('kind',p_kind,'document_id',p_document_id,
  'items',(select coalesce(jsonb_agg(jsonb_build_object('item_id',i.id,'position',i.position,'product_id',i.product_id,'production',p.production,
    'components',(select coalesce(jsonb_agg(jsonb_build_object('product_id',c.component_id,'code',left(r.code,100),'description',left(r.name,200),'unit',left(cp.unit,16),
       'quantity',c.quantity::numeric(18,6)::text,'total',(c.quantity*i.quantity)::numeric(24,6)::text) order by c.position),'[]'::jsonb)
     from erp_stock.composition_current c join erp_catalog.record r on r.id=c.component_id left join erp_catalog.product cp on cp.record_id=c.component_id
     where c.product_id=i.product_id)) order by i.position),'[]'::jsonb)
   from erp_documents.item i left join erp_catalog.product p on p.record_id=i.product_id where i.document_id=p_document_id and i.product_id is not null),
  'data_mode','erp_native','operational_effects',false);
end $$;

create or replace function public.erp_document_conversion_preview(p_user_id uuid,p_kind text,p_proposal_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
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
 v_body:=v_body-array['totals','template_name','valid_until','next_contact','template'];
 v_body:=jsonb_set(v_body,'{installments}',(select coalesce(jsonb_agg(p.value-'position' order by p.n),'[]'::jsonb) from jsonb_array_elements(coalesce(v_body->'installments','[]'::jsonb)) with ordinality p(value,n)));
 select coalesce(jsonb_agg(jsonb_build_object('id',null,'product_id',i.product_id,'description',i.data->'description',
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),
  -- 240: Preferências › Propostas "Enviar informações da descrição detalhada dos produtos para a venda" (off: the pedido starts without it).
  'discount_percent',i.discount_percent::text,'detailed_description',case when p_kind='sales_orders' and erp_documents.preference('propostas.enviar_descricao_venda')='false'::jsonb
   then 'null'::jsonb else coalesce(i.data->'detailed_description','null'::jsonb) end)
  ||case when i.data?'list_price' then jsonb_build_object('list_price',i.data->'list_price') else '{}'::jsonb end order by i.position),'[]'::jsonb) into v_items
  from erp_documents.item i where i.document_id=p_proposal_id;
 return jsonb_build_object('source',jsonb_build_object('id',v_source.id,'kind','sales_proposals','number',v_source.number::text,'version',v_source.version),
  'kind',p_kind,'data',v_body||jsonb_build_object('items',v_items),'contact',jsonb_build_object('id',v_source.contact_id,'name',left(v_source.contact_snapshot->>'name',200)),
  'price_list_name',(select left(l.name,120) from erp_pricing.price_list l where l.id::text=v_body->>'price_list_id'),
  'persisted',false,'data_mode','erp_native','operational_effects',false);
end $$;

do $$ declare f text; begin
 foreach f in array array['erp_document_structures(uuid,text,uuid)','erp_document_conversion_preview(uuid,text,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
