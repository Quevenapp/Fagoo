-- Cadastros > Listas de preços, onda D (área de produtos):
-- * Gaveta "Inserir produtos" > "Acesse a planilha modelo aqui e vincule seus produtos à uma lista de preço": a planilha (código
--   do produto e, na lista customizada, o preço) vincula os produtos de mesmo código à lista, num comando com versão esperada,
--   até 500 linhas por envio. Código não encontrado, repetido na planilha ou de mais de um produto fica de fora e aparece no
--   resumo; produto excluído não entra em lista. Na customizada, um preço na linha grava o preço do produto na lista.
-- * Listas aplicáveis agora (horário de São Paulo) a um contato, à UF, a um vendedor e a uma forma de pagamento, nas categorias
--   Outra, Contato, Região, Vendedor e Forma de pagamento: a consulta que os pedidos e as propostas usam para oferecer a lista.
-- Nada aqui muda preço de produto, documento, estoque ou financeiro. Depende de 121 e 154.
begin;

do $$begin
 if to_regprocedure('erp_pricing.valid_now(erp_pricing.price_list)') is null or to_regclass('erp_pricing.price_list_seller') is null then
  raise exception 'price_lists_192_requires_154' using errcode='55000'; end if;
end$$;

-- Vincular produtos pela planilha: [{code, price?}] com 1 a 500 linhas. A primeira linha de um código vale; as repetidas contam no resumo.
create function public.erp_pricing_list_import(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_pricing.price_list%rowtype; v_item jsonb; v_code text; v_price text; v_ids uuid[]; v_seen text[]:='{}';
 v_added integer:=0; v_updated integer:=0; v_unchanged integer:=0; v_duplicates integer:=0; v_missing jsonb:='[]'::jsonb; v_missing_total integer:=0;
 v_ambiguous jsonb:='[]'::jsonb; v_ambiguous_total integer:=0; v_before integer; v_result jsonb; v_current numeric; v_in boolean;
begin
 perform erp_pricing.require(p_user_id,true);
 if p_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483647 or p_rows is null or jsonb_typeof(p_rows)<>'array'
  or jsonb_array_length(p_rows) not between 1 and 500
  or exists(select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x)<>'object' or exists(select 1 from jsonb_object_keys(x) k where k not in('code','price'))
   or jsonb_typeof(x->'code') is distinct from 'string' or length(btrim(x->>'code')) not between 1 and 100 or x->>'code'~'[[:cntrl:]]'
   or(x?'price' and jsonb_typeof(x->'price') not in('string','null')) or length(x->>'price')>80) then
  raise exception 'erp_pricing_invalid_data' using errcode='22023'; end if;
 v_hash:=erp_pricing.hash(jsonb_build_object('actor',p_user_id,'action','import','id',p_id,'version',p_expected_version,'rows',p_rows));
 v_replay:=erp_pricing.replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_pricing.price_list where id=p_id for update;
 if not found then raise exception 'erp_pricing_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version then raise exception 'erp_pricing_version_conflict' using errcode='40001'; end if;
 -- Rates and period lists price every product by the rule: a price in the sheet only belongs to a customized list.
 if v_row.list_type<>'custom' and exists(select 1 from jsonb_array_elements(p_rows) x where nullif(btrim(coalesce(x->>'price','')),'') is not null) then
  raise exception 'erp_pricing_invalid_data' using errcode='22023'; end if;
 v_before:=(select count(*) from erp_pricing.price_list_item where list_id=p_id);
 for v_item in select value from jsonb_array_elements(p_rows) loop
  v_code:=btrim(v_item->>'code');
  if lower(v_code)=any(v_seen) then v_duplicates:=v_duplicates+1; continue; end if;
  v_seen:=v_seen||lower(v_code);
  v_price:=case when nullif(btrim(coalesce(v_item->>'price','')),'') is null then null else erp_catalog.unit_price(to_jsonb(btrim(v_item->>'price')),14) end;
  select array_agg(r.id order by r.id) into v_ids from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id
   where r.entity='products' and lower(r.code)=lower(v_code) and not exists(select 1 from erp_catalog.product_detail d where d.record_id=r.id and d.deleted_at is not null);
  if v_ids is null then
   v_missing_total:=v_missing_total+1; if jsonb_array_length(v_missing)<50 then v_missing:=v_missing||to_jsonb(v_code); end if; continue; end if;
  if cardinality(v_ids)>1 then
   v_ambiguous_total:=v_ambiguous_total+1; if jsonb_array_length(v_ambiguous)<50 then v_ambiguous:=v_ambiguous||to_jsonb(v_code); end if; continue; end if;
  select true,i.custom_price into v_in,v_current from erp_pricing.price_list_item i where i.list_id=p_id and i.product_id=v_ids[1];
  if v_in is null then
   insert into erp_pricing.price_list_item(list_id,product_id,custom_price) values(p_id,v_ids[1],v_price::numeric); v_added:=v_added+1;
  elsif v_price is not null and v_current is distinct from v_price::numeric then
   update erp_pricing.price_list_item set custom_price=v_price::numeric where list_id=p_id and product_id=v_ids[1]; v_updated:=v_updated+1;
  else v_unchanged:=v_unchanged+1; end if;
  v_in:=null; v_current:=null;
 end loop;
 if v_before+v_added>15000 then raise exception 'erp_pricing_item_limit' using errcode='22023'; end if;
 if v_added+v_updated>0 then
  if v_row.version=2147483647 then raise exception 'erp_pricing_version_exhausted' using errcode='40001'; end if;
  update erp_pricing.price_list set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 end if;
 v_result:=jsonb_build_object('saved',true,'list',erp_pricing.header(p_id),'added',v_added,'updated',v_updated,'unchanged',v_unchanged,'duplicates',v_duplicates,
  'not_found',v_missing,'not_found_total',v_missing_total,'ambiguous',v_ambiguous,'ambiguous_total',v_ambiguous_total,'replayed',false,'data_mode','erp_native');
 if v_added+v_updated>0 then insert into erp_pricing.audit(actor,command_id,list_id,action,before_data,after_data) values(p_user_id,p_command_id,p_id,'items',
  jsonb_build_object('products',v_before),jsonb_build_object('import',jsonb_build_object('rows',jsonb_array_length(p_rows),'added',v_added,'updated',v_updated),'products',(v_result#>>'{list,products}')::integer)); end if;
 insert into erp_pricing.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Listas que valem agora para o documento: Outra sempre; Contato, Região (a UF informada ou a do contato), Vendedor e Forma de
-- pagamento só com o vínculo. Só leitura, sem os vínculos de cada lista.
create function public.erp_pricing_applicable_lists(p_user_id uuid,p_contact_id uuid default null,p_seller_id uuid default null,p_payment_method_id uuid default null,p_state text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_state text;
begin
 perform erp_pricing.require(p_user_id,false);
 if p_state is not null and p_state not in('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO') then
  raise exception 'erp_pricing_invalid_query' using errcode='22023'; end if;
 v_state:=coalesce(p_state,(select upper(c.state) from erp_catalog.contact c where c.record_id=p_contact_id));
 return jsonb_build_object('data_mode','erp_native','contact_id',p_contact_id,'seller_id',p_seller_id,'payment_method_id',p_payment_method_id,'state',v_state,
  'items',coalesce((select jsonb_agg(erp_pricing.header(l.id)-'contacts'-'sellers'-'payment_methods'-'regions' order by erp_catalog.fold(l.name),l.id)
   from erp_pricing.price_list l where erp_pricing.valid_now(l) and case l.category
    when 'other' then true
    when 'contact' then exists(select 1 from erp_pricing.price_list_contact c where c.list_id=l.id and c.contact_id=p_contact_id)
    when 'region' then exists(select 1 from erp_pricing.price_list_region g where g.list_id=l.id and g.state=v_state)
    when 'seller' then exists(select 1 from erp_pricing.price_list_seller s where s.list_id=l.id and s.seller_id=p_seller_id)
    when 'payment_method' then exists(select 1 from erp_pricing.price_list_payment_method m where m.list_id=l.id and m.payment_method_id=p_payment_method_id)
    else false end),'[]'::jsonb));
end $$;

revoke all on all functions in schema erp_pricing from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_pricing_list_import(uuid,uuid,integer,uuid,jsonb)','erp_pricing_applicable_lists(uuid,uuid,uuid,uuid,text)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
