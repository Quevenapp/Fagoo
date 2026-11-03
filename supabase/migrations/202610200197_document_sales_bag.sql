-- 197: Sacola de vendas (Origin fa-shopping-bag da listagem de produtos), onda D da frente de documentos.
-- A sacola é do usuário e fica no servidor (vale em qualquer dispositivo, como no Origin): produto e quantidade (decimal exato
-- de seis casas, como os itens dos documentos), até 250 produtos (o limite de itens de um pedido). Na listagem de produtos, o
-- ícone da sacola mostra o contador e abre a gaveta "Sacola de vendas" (quantidade editável, remover, limpar e "Gerar pedido de
-- venda"); a sacola da linha pede "Quantidade a adicionar:" e "Adicionar". "Gerar pedido de venda" abre um pedido novo, ainda não
-- gravado, com os itens da sacola e o preço atual de cada produto; a sacola é esvaziada depois que esse pedido é salvo.
-- Só para quem inclui pedidos de venda (administrador e vendas). Cada mudança é um comando idempotente (command_id) do próprio
-- usuário, guardado com o resultado; nada é lançado em estoque, financeiro ou documentos.
begin;

create table erp_documents.sales_bag_item(
 user_id uuid not null references auth.users(id),
 product_id uuid not null references erp_catalog.product(record_id),
 quantity numeric(18,6) not null check(quantity>0 and quantity<=999999999.999999),
 added_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 primary key(user_id,product_id)
);
create table erp_documents.sales_bag_command(
 command_id uuid primary key,
 actor uuid not null references auth.users(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 action text not null check(action in('add','set','remove','clear')),
 result jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create index erp_documents_sales_bag_command_actor on erp_documents.sales_bag_command(actor,created_at);
alter table erp_documents.sales_bag_item enable row level security;
alter table erp_documents.sales_bag_command enable row level security;
revoke all on erp_documents.sales_bag_item,erp_documents.sales_bag_command from public,anon,authenticated,service_role;

-- The bag of one user, in the order the products were added: current name, code, unit and price of each product.
create function erp_documents.sales_bag_view(p_user_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('product_id',b.product_id,'name',left(r.name,200),'code',left(r.code,100),'unit',left(p.unit,16),
   'price',erp_catalog.unit_price_numeric(p.price,10),'quantity',b.quantity::text,'active',r.active,'kind',p.kind) order by b.added_at,b.product_id),'[]'::jsonb),
  'count',count(*)::integer,'limit',250,'data_mode','erp_native','operational_effects',false)
 from erp_documents.sales_bag_item b join erp_catalog.record r on r.id=b.product_id join erp_catalog.product p on p.record_id=b.product_id
 where b.user_id=p_user_id
$$;

create function public.erp_document_sales_bag(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 return erp_documents.sales_bag_view(p_user_id);
end $$;

-- add: soma a quantidade (inclui o produto); set: troca a quantidade; remove: tira o produto; clear: esvazia a sacola.
create function public.erp_document_sales_bag_change(p_user_id uuid,p_command_id uuid,p_action text,p_product_id uuid default null,p_quantity text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_documents.sales_bag_command%rowtype; v_quantity numeric; v_current numeric; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 if p_command_id is null or p_action is null or p_action not in('add','set','remove','clear')
  or (p_action='clear')<>(p_product_id is null) or (p_action in('add','set'))<>(p_quantity is not null) then
  raise exception 'erp_document_sales_bag_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'product',p_product_id,'quantity',p_quantity)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('sales-bag:'||p_user_id::text,0));
 select * into v_command from erp_documents.sales_bag_command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_document_sales_bag_command_conflict' using errcode='40001'; end if;
  return v_command.result||jsonb_build_object('replayed',true);
 end if;
 if p_action in('add','set') then
  v_quantity:=erp_documents.decimal_value(to_jsonb(p_quantity),6,9);
  if v_quantity<=0 then raise exception 'erp_document_sales_bag_invalid' using errcode='22023'; end if;
  if not exists(select 1 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=p_product_id and r.active) then
   raise exception 'erp_document_sales_bag_product_unavailable' using errcode='22023'; end if;
  select quantity into v_current from erp_documents.sales_bag_item where user_id=p_user_id and product_id=p_product_id for update;
  if not found then
   if (select count(*) from erp_documents.sales_bag_item where user_id=p_user_id)>=250 then raise exception 'erp_document_sales_bag_full' using errcode='22023'; end if;
   insert into erp_documents.sales_bag_item(user_id,product_id,quantity) values(p_user_id,p_product_id,v_quantity);
  else
   v_quantity:=case when p_action='add' then v_current+v_quantity else v_quantity end;
   if v_quantity>999999999.999999 then raise exception 'erp_document_sales_bag_invalid' using errcode='22023'; end if;
   update erp_documents.sales_bag_item set quantity=v_quantity,updated_at=clock_timestamp() where user_id=p_user_id and product_id=p_product_id;
  end if;
 elsif p_action='remove' then
  delete from erp_documents.sales_bag_item where user_id=p_user_id and product_id=p_product_id;
 else
  delete from erp_documents.sales_bag_item where user_id=p_user_id;
 end if;
 -- The role may have changed while the lock waited; the failure undoes everything before the receipt of the command.
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 v_result:=erp_documents.sales_bag_view(p_user_id)||jsonb_build_object('action',p_action,'product_id',p_product_id,'replayed',false);
 insert into erp_documents.sales_bag_command(command_id,actor,request_hash,action,result) values(p_command_id,p_user_id,v_hash,p_action,v_result);
 return v_result;
end $$;

revoke all on function erp_documents.sales_bag_view(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_sales_bag(uuid),public.erp_document_sales_bag_change(uuid,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.erp_document_sales_bag(uuid),public.erp_document_sales_bag_change(uuid,uuid,text,uuid,text) to service_role;
commit;
