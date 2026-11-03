-- Brufap SaaS: frescor da cópia do Origin, Fase 1a da convivência. Somente leitura.
-- Mede o staging atual: changed_at, last_seen_at e as passagens concluídas que os
-- checkpoints registram (resource_state e o ledger batch_inbox). Não cria dono de
-- módulo, trava, feed, pista nova nem caminho de escrita. Nenhum payload é lido.
-- Contrato: docs/integrations/origin-sync-freshness.md.
begin;

-- min/max(last_seen_at) por entidade leria todas as linhas da entidade: o único índice
-- existente com last_seen_at é parcial (AP/AR abertos, 030). changed_at já tem índice (001).
create index raw_record_entity_seen_idx on origin_sync.raw_record (entity, last_seen_at);

-- Hora local do coletor (America/Sao_Paulo, contrato de resources.mjs) para instante exato.
create function erp_integration.freshness_local(v text) returns timestamptz
language sql stable set search_path=pg_catalog as $$
 select (erp_integration.local_completion(v)::timestamp) at time zone 'America/Sao_Paulo';
$$;

-- p_as_of fica explícito para os testes de fronteira; a RPC pública usa now().
create function erp_integration.origin_sync_freshness(p_as_of timestamptz) returns jsonb
language sql stable set search_path=pg_catalog as $$
 with levels(level,target_seconds) as (values('A',600),('B',1800),('C',86400)),
 -- Níveis da seção 3.1 de origin-convivencia.md. Uma entidade por namespace canônico do coletor.
 entities(position,entity,level) as (values
  (1,'contacts','A'),(2,'products','A'),(3,'sales_orders','A'),(4,'nfe','A'),(5,'nfce','A'),
  (6,'sales_proposals','B'),(7,'purchase_orders','B'),(8,'service_orders','B'),(9,'receivables','B'),
  (10,'payables','B'),(11,'cash_entries','B'),(12,'stock_balances','B'),
  (13,'sellers','C'),(14,'payment_methods','C'),(15,'warehouses','C'),(16,'product_categories','C'),
  (17,'financial_categories','C'),(18,'ledger_accounts','C')),
 -- Pistas que cobrem cada entidade (workers/origin-sync/src/resources.mjs). Filtro por alteração:
 -- só a recente relê toda mudança. Filtro por data do documento: a histórica é a única que relê
 -- documentos fora dos últimos 30 dias. Sem período (sweep): a varredura inteira.
 lanes(entity,resource,lane,position) as (values
  ('contacts','contacts','recent',1),('contacts','contacts_deleted','sweep',2),
  ('products','products_zero','recent',1),('products','products_positive','recent',2),('products','products_negative','recent',3),
  ('products','products_deleted_zero','sweep',4),('products','products_deleted_positive','sweep',5),('products','products_deleted_negative','sweep',6),
  ('sales_orders','sales_orders','recent',1),
  ('nfe','nfe_in','recent',1),('nfe','nfe_in','history',2),('nfe','nfe_out','recent',3),('nfe','nfe_out','history',4),
  ('nfe','nfe_in_cancelled','recent',5),('nfe','nfe_in_cancelled','history',6),
  ('nfe','nfe_out_cancelled','recent',7),('nfe','nfe_out_cancelled','history',8),
  ('nfce','nfce','recent',1),('nfce','nfce','history',2),
  ('sales_proposals','sales_proposals','recent',1),('sales_proposals','sales_proposals','history',2),
  ('purchase_orders','purchase_orders','recent',1),('purchase_orders','purchase_orders','history',2),
  ('service_orders','service_orders','recent',1),('service_orders','service_orders','history',2),
  ('receivables','receivables','recent',1),('receivables','receivables','history',2),
  ('payables','payables','recent',1),('payables','payables','history',2),
  ('cash_entries','cash_entries_registered','recent',1),('cash_entries','cash_entries_registered','history',2),
  ('cash_entries','cash_entries_deleted','recent',3),('cash_entries','cash_entries_deleted','history',4),
  ('stock_balances','stock_balances','sweep',1),
  ('sellers','sellers','recent',1),('sellers','sellers_deleted','sweep',2),
  ('payment_methods','payment_methods_active','sweep',1),('payment_methods','payment_methods_inactive','sweep',2),
  ('warehouses','warehouses_active','sweep',1),('warehouses','warehouses_inactive','sweep',2),
  ('product_categories','product_categories','sweep',1),('financial_categories','financial_categories','sweep',1),
  ('ledger_accounts','ledger_accounts','sweep',1)),
 state as (
  select l.*,s.checkpoint,coalesce(s.checkpoint_version>0,false) present,
   case l.lane when 'sweep' then 'unfiltered' else l.lane end cursor_key,
   case l.lane when 'sweep' then 'unfilteredCompletedAt' else l.lane||'CompletedAt' end done_key
  from lanes l left join origin_sync.resource_state s on s.resource=l.resource),
 -- *CompletedAt é o corte local da página que encerrou a passagem (sync.mjs, advanceWindow
 -- e stockBatch): é o fim. Um fim mais de 5 min à frente da consulta não é aceito.
 closed as (
  select x.*,coalesce(x.present and jsonb_typeof(x.checkpoint->x.cursor_key)='object',false) open,
   case when x.present then erp_integration.freshness_local(x.checkpoint->>x.done_key) end raw_finished_at
  from state x),
 bounded as (
  select c.*,case when c.raw_finished_at<=p_as_of+interval '5 minutes' then c.raw_finished_at end finished_at
  from closed c),
 -- O lote que encerrou a passagem guarda o checkpoint anterior. Busca limitada pelo índice
 -- (resource, applied_at) à janela em que esse lote foi gravado.
 closing as (
  select b.*,k.checkpoint_before
  from bounded b left join lateral (
   select i.checkpoint_before from origin_sync.batch_inbox i
   where b.finished_at is not null and i.resource=b.resource
    and i.applied_at>=b.finished_at-interval '5 minutes' and i.applied_at<=b.finished_at+interval '30 minutes'
    and i.checkpoint_after->>b.done_key=b.checkpoint->>b.done_key
    and (i.checkpoint_before->>b.done_key) is distinct from (i.checkpoint_after->>b.done_key)
   order by i.applied_at desc limit 1) k on true),
 -- Início: sem cursor antes do lote final, a passagem foi uma página só (início = fim).
 -- Com cursor recente/histórico, o corte congelado do cursor é o início exato. Na varredura
 -- sem período, o cursor não guarda início: vale o encerramento anterior, limite inferior
 -- conservador. Primeira varredura de várias páginas: início desconhecido.
 measured as (
  select c.*,case
    when c.checkpoint_before is null then null
    when coalesce(jsonb_typeof(c.checkpoint_before->c.cursor_key),'')<>'object' then c.finished_at
    when c.lane='sweep' then erp_integration.freshness_local(c.checkpoint_before->>c.done_key)
    else erp_integration.freshness_local(c.checkpoint_before->c.cursor_key->>'cutoff') end raw_started_at
  from closing c),
 lane_rows as (
  select m.entity,m.resource,m.lane,m.position,m.present,m.open,m.finished_at,
   case when m.raw_started_at<=m.finished_at then m.raw_started_at end started_at
  from measured m),
 limiting as (
  select distinct on (entity) entity,resource,lane,started_at,finished_at
  from lane_rows where started_at is not null order by entity,started_at,position),
 summary as (
  select e.position,e.entity,e.level,v.target_seconds,count(*) lanes_total,count(r.started_at) lanes_measured,
   jsonb_agg(jsonb_build_object('resource',r.resource,'lane',r.lane,'checkpoint_present',r.present,'open',r.open,
    'completed_started_at',r.started_at,'completed_finished_at',r.finished_at) order by r.position) lane_list
  from entities e join levels v on v.level=e.level join lane_rows r on r.entity=e.entity
  group by e.position,e.entity,e.level,v.target_seconds),
 -- Frescor = o início mais antigo entre as últimas passagens concluídas de todas as pistas
 -- da entidade. Nunca o último ciclo ou a última leitura. Pista sem passagem medida: sem frescor.
 fresh as (
  select s.*,case when complete then l.started_at end freshness_at,case when complete then l.finished_at end pass_finished_at,
   case when complete then l.resource end pass_resource,case when complete then l.lane end pass_lane
  from (select s.*,s.lanes_measured=s.lanes_total complete from summary s) s left join limiting l on l.entity=s.entity),
 -- Idade arredondada para cima: idade <= alvo em segundos inteiros equivale à comparação exata.
 aged as (
  select f.*,case when f.freshness_at is not null then greatest(0,ceil(extract(epoch from p_as_of-f.freshness_at)))::bigint end age_seconds
  from fresh f),
 run as (select erp_integration.run_summary(s.checkpoint->'lastRun') summary,
   case when jsonb_typeof(s.checkpoint->'lastRun'->'errors')='array' then (s.checkpoint->'lastRun'->'errors')->(-1) end last_error
  from origin_sync.resource_state s where s.resource='__scheduler__')
 select jsonb_build_object(
  'profile','origin-sync-freshness-v1','data_mode','origin_sync_freshness_readonly','as_of',p_as_of,'role','admin',
  'time_zone','America/Sao_Paulo','coverage_certified',false,'erp_mutations',false,
  'levels',(select jsonb_agg(jsonb_build_object('level',level,'target_seconds',target_seconds,'stale_after_seconds',3*target_seconds) order by level) from levels),
  'collector',jsonb_build_object(
   'oauth_connected',exists(select 1 from origin_sync.credentials c where c.account_id=1),
   'oauth_expires_at',(select c.expires_at from origin_sync.credentials c where c.account_id=1),
   'last_run_status',(select r.summary->>'status' from run r),
   'last_run_started_at',(select r.summary->'started_at' from run r),
   'last_run_finished_at',(select r.summary->'finished_at' from run r),
   'last_run_error_count',(select r.summary->'error_count' from run r),
   -- Só códigos já saneados pelo coletor (safeError); mensagens e IDs nunca saem.
   'last_error_code',(select case when jsonb_typeof(r.last_error->'code')='string' and r.last_error->>'code' ~ '^[A-Z][A-Z0-9_]{0,80}$' then r.last_error->>'code' end from run r),
   'last_error_resource',(select case when jsonb_typeof(r.last_error->'resource')='string' and r.last_error->>'resource' ~ '^[a-z][a-z0-9_]{0,79}$' then r.last_error->>'resource' end from run r)),
  'entities',(select jsonb_agg(jsonb_build_object(
   'entity',a.entity,'level',a.level,'target_seconds',a.target_seconds,
   'records',(select count(*) from origin_sync.raw_record r where r.entity=a.entity),
   'last_changed_at',(select max(r.changed_at) from origin_sync.raw_record r where r.entity=a.entity),
   'last_seen_at',(select max(r.last_seen_at) from origin_sync.raw_record r where r.entity=a.entity),
   'oldest_seen_at',(select min(r.last_seen_at) from origin_sync.raw_record r where r.entity=a.entity),
   'lanes_total',a.lanes_total,'lanes_measured',a.lanes_measured,
   'freshness_at',a.freshness_at,'age_seconds',a.age_seconds,
   'pass_finished_at',a.pass_finished_at,'pass_resource',a.pass_resource,'pass_lane',a.pass_lane,
   'status',case when a.age_seconds is null then 'stale' when a.age_seconds<=a.target_seconds then 'ok'
    when a.age_seconds<=3*a.target_seconds then 'attention' else 'stale' end,
   'lanes',a.lane_list) order by a.position) from aged a));
$$;

create function public.erp_origin_sync_freshness(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if p_user_id is null or not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin') then
  raise exception 'erp_admin_required' using errcode='42501';end if;
 return erp_integration.origin_sync_freshness(now());
end; $$;

revoke all on function erp_integration.freshness_local(text) from public,anon,authenticated,service_role;
revoke all on function erp_integration.origin_sync_freshness(timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.erp_origin_sync_freshness(uuid) from public,anon,authenticated;
grant execute on function public.erp_origin_sync_freshness(uuid) to service_role;
comment on function public.erp_origin_sync_freshness(uuid) is 'Frescor somente leitura do staging do Origin por entidade (Fase 1a). Administrador ativo; nenhum payload.';
commit;
