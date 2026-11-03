// Synthetic state for the 087 applicator; no project connection or real business data.
export const STOCK_OBSERVATIONS_ACTOR='87000000-0000-4000-8000-000000000001';
export const STOCK_OBSERVATIONS_SEED=`
insert into auth.users values('${STOCK_OBSERVATIONS_ACTOR}');
insert into erp_access.membership(user_id,role)values('${STOCK_OBSERVATIONS_ACTOR}','admin');
create table erp_access.fixture087(id integer primary key,value text);
insert into erp_access.fixture087 values(1,'PRIVATE_SENTINEL');
alter table erp_access.fixture087 enable row level security;
create policy fixture_read on erp_access.fixture087 for select to authenticated using(false);
grant select(value)on erp_access.fixture087 to authenticated;
insert into storage.buckets(id,name,public)values('fixture087','fixture087',false);
insert into storage.objects values('fixture087','PRIVATE_OBJECT','{}');
begin;
insert into erp_sales_history.snapshot(history_id,source_id,command_id,snapshot_hash,observation)
select 'bsh_'||u,'870'||g::text,u,encode(sha256(convert_to(v::text,'UTF8')),'hex'),v
from(select g,('87000000-0000-4000-9000-'||lpad(g::text,12,'0'))::uuid u,jsonb_build_object('profile','origin-sales-history-observation-v1','source_id','870'||g::text)v from generate_series(1,276)g)x;
insert into erp_sales_history.command(command_id,actor,request_hash,history_id,receipt)
select command_id,'${STOCK_OBSERVATIONS_ACTOR}',repeat('a',64),history_id,'{}'::jsonb from erp_sales_history.snapshot;
commit;
insert into origin_sales_price_refresh.origin(source_id,failures,last_error)values('123',3,'HTTP_404');
update origin_sales_price_refresh.scope_state set retry_after=clock_timestamp()+interval'1 hour';
insert into origin_sync.resource_state(resource)values('stock_observations087_fixture');
insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)
select 'warehouses','stock_observations087_fixture','007',p,encode(sha256(convert_to(jsonb_build_object('payload',p,'document_links','[]'::jsonb)::text,'UTF8')),'hex')
from(select '{"id":"007","descricao":"Synthetic inactive087","situacao":0,"padrao":false,"desconsiderarSaldo":false}'::jsonb p)x;
do $$declare s origin_sync.raw_record;p jsonb;begin
select * into strict s from origin_sync.raw_record where entity='warehouses'and source_id='007';
p:=public.erp_origin_warehouse_preview('${STOCK_OBSERVATIONS_ACTOR}','007',s.version_hash,s.version::text);
perform public.erp_origin_warehouse_import('${STOCK_OBSERVATIONS_ACTOR}','007',s.version_hash,s.version::text,p->>'preview_hash','87000000-0000-4000-8000-000000000002',true);
end$$;
insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)
select entity,'stock_observations087_fixture','001',p,encode(sha256(convert_to(jsonb_build_object('payload',p,'document_links','[]'::jsonb)::text,'UTF8')),'hex')
from(values('products','{"id":"001","nome":"Synthetic product087"}'::jsonb),('stock_balances','{"produto":{"id":"001"},"saldoFisicoTotal":0,"saldoVirtualTotal":-0.125,"depositos":[{"id":"007","saldoFisico":0,"saldoVirtual":-0.125}]}'::jsonb))x(entity,p);
alter default privileges grant select on tables to authenticated;
alter default privileges in schema erp_cutover grant execute on functions to authenticated;
`;
