-- Sincronização de mão dupla com o Origin (decisão do dono em 22/10/2026). O Brufap passa a criar, editar, apagar e lançar;
-- o que muda aqui vai para o Origin, e o que muda no Origin chega ao Brufap. Em conflito vale a alteração mais recente.
-- Esta migração instala o núcleo:
-- * erp_sync.outbox: cada alteração local (cadastro, documento, conta, baixa, movimento de estoque) entra numa fila de envio,
--   coalescida por registro. O Worker da API monta a requisição no banco (010/011), envia ao Origin e confirma.
-- * erp_sync.inbox: cada versão nova de origin_sync.raw_record entra numa fila de recebimento; os aplicadores (010/011) gravam
--   nas tabelas nativas como o ator técnico, com erp_sync.applying ligado para não devolver o próprio eco ao Origin.
-- * erp_sync.link: o vínculo (entidade, registro do Brufap, ID do Origin) de tudo o que foi enviado ou recebido.
-- * As travas de somente leitura dos espelhos passam a valer por autoridade (authority), não por origem: um documento vindo do
--   Origin e convertido para o modelo nativo fica com origin='origin' e authority='brufap', editável como qualquer outro.
-- * erp_sync.run: o botão "Sincronizar" registra uma rodada que o Worker conduz (envio, censo de IDs, recebimento).
begin;
do $$begin
 if to_regclass('erp_documents.origin_mirror') is null or to_regprocedure('erp_document_mirror.guard_document()') is null
  or to_regclass('erp_stock_mirror.current_position') is null then
  raise exception 'origin_two_way_009_requires_006_007_and_stock_mirror' using errcode='55000'; end if;
end$$;

create schema erp_sync;
revoke all on schema erp_sync from public,anon,authenticated,service_role;

create table erp_sync.settings(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default true,
 actor_id uuid references auth.users,
 -- Conta financeira usada nas baixas recebidas do Origin quando o portador não tem conta vinculada.
 default_account_id uuid references erp_finance.account,
 updated_at timestamptz not null default clock_timestamp()
);
-- O ator técnico do espelho de documentos passa a ser o ator da sincronização: sem senha nem login (banned), mas membro
-- administrador, porque os aplicadores reutilizam os comandos nativos (estoque, baixas) e suas regras.
insert into erp_sync.settings(actor_id) select (select actor_id from erp_document_mirror.settings where singleton);
insert into erp_access.membership(user_id,role,active)
 select actor_id,'admin',true from erp_sync.settings where actor_id is not null
 on conflict(user_id) do update set role='admin',active=true,updated_at=clock_timestamp();

create table erp_sync.link(
 entity text not null check(entity in('contacts','products','sales_orders','sales_proposals','purchase_orders','service_orders','receivables','payables')),
 record_id uuid not null,
 origin_id text not null check(origin_id~'^[1-9][0-9]{0,39}$'),
 pushed_at timestamptz,
 pulled_version bigint,
 pulled_hash text,
 pulled_at timestamptz,
 deleted boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 primary key(entity,record_id),
 unique(entity,origin_id)
);

create table erp_sync.outbox(
 id bigint generated always as identity primary key,
 entity text not null check(entity in('contacts','products','sales_orders','sales_proposals','purchase_orders','service_orders','receivables','payables','stock')),
 record_id uuid not null,
 item integer not null default 0,
 op text not null check(op in('upsert','delete','settle','stock')),
 state text not null default 'pending' check(state in('pending','sending','done','failed','superseded','skipped')),
 dirty boolean not null default false,
 detail jsonb,
 changed_at timestamptz not null default clock_timestamp(),
 enqueued_at timestamptz not null default clock_timestamp(),
 next_attempt_at timestamptz not null default '-infinity',
 attempts integer not null default 0,
 claim_token uuid,
 claimed_at timestamptz,
 finished_at timestamptz,
 http_status integer,
 error text check(length(error)<=500),
 origin_id text
);
create unique index outbox_open on erp_sync.outbox(entity,record_id,item,op) where state in('pending','sending');
create index outbox_due on erp_sync.outbox(next_attempt_at,id) where state='pending';
create index outbox_record on erp_sync.outbox(entity,record_id,state);
create index outbox_finished on erp_sync.outbox(finished_at) where state in('done','superseded','skipped');

create table erp_sync.inbox(
 entity text not null,
 source_id text not null,
 version bigint not null,
 seen_at timestamptz not null default clock_timestamp(),
 retry_at timestamptz not null default '-infinity',
 attempts integer not null default 0,
 error text check(length(error)<=500),
 primary key(entity,source_id)
);
create index inbox_due on erp_sync.inbox(retry_at,entity,source_id);

create table erp_sync.issue(
 id bigint generated always as identity primary key,
 created_at timestamptz not null default clock_timestamp(),
 direction text not null check(direction in('push','pull','census')),
 entity text not null,
 record_id uuid,
 source_id text,
 code text not null check(length(code)<=80),
 detail text check(length(detail)<=500),
 resolved_at timestamptz
);
create index issue_open on erp_sync.issue(entity,record_id,source_id) where resolved_at is null;

create table erp_sync.run(
 id uuid primary key default gen_random_uuid(),
 requested_by uuid references auth.users,
 requested_at timestamptz not null default clock_timestamp(),
 started_at timestamptz,
 finished_at timestamptz,
 state text not null default 'queued' check(state in('queued','running','done','failed')),
 phase text not null default 'push' check(phase in('push','census','fetch','pull','stock','done')),
 cursor jsonb not null default '{}'::jsonb,
 stats jsonb not null default '{}'::jsonb,
 error text check(length(error)<=500)
);
create unique index run_active on erp_sync.run((true)) where state in('queued','running');

-- IDs listados no Origin durante o censo de uma rodada (descobre criações e exclusões que o coletor não viu).
create table erp_sync.census(
 run_id uuid not null references erp_sync.run on delete cascade,
 entity text not null,
 origin_id text not null,
 primary key(run_id,entity,origin_id)
);

-- Situações do Origin por entidade, nos dois sentidos. origin_status é o ID da situação (pedidos de venda e OS),
-- 'valor:N' (pedidos de compra) ou o texto da situação (propostas). push=false: só leitura (várias situações do Origin
-- caem na mesma situação do Brufap; a que volta ao Origin é a marcada).
create table erp_sync.status_map(
 entity text not null check(entity in('sales_orders','sales_proposals','purchase_orders','service_orders')),
 origin_status text not null check(length(origin_status) between 1 and 80),
 native_status text not null,
 push boolean not null default true,
 primary key(entity,origin_status),
 check((erp_documents.transitions()->entity)?native_status)
);
create unique index status_map_push on erp_sync.status_map(entity,native_status) where push;
insert into erp_sync.status_map(entity,origin_status,native_status,push) values
 ('sales_orders','6','open',true),('sales_orders','9','fulfilled',true),('sales_orders','12','cancelled',true),
 ('sales_orders','15','in_progress',true),('sales_orders','18','agency_sale',true),('sales_orders','21','draft',true),
 ('sales_orders','24','verified',true),
 ('purchase_orders','valor:0','open',true),('purchase_orders','valor:1','fulfilled',true),
 ('purchase_orders','valor:2','cancelled',true),('purchase_orders','valor:3','in_progress',true),
 ('sales_proposals','Rascunho','draft',true),('sales_proposals','Em aberto','open',true),('sales_proposals','Pendente','pending',true),
 ('sales_proposals','Aguardando','waiting',true),('sales_proposals','Aprovado','approved',true),('sales_proposals','Aprovada','approved',false),
 ('sales_proposals','Não aprovado','rejected',true),('sales_proposals','Não aprovada','rejected',false),
 ('sales_proposals','Concluído','completed',true),('sales_proposals','Concluída','completed',false),
 ('sales_proposals','Cancelado','cancelled',true),('sales_proposals','Cancelada','cancelled',false);

-- Saldo por produto e depósito: quando o Brufap enviou um movimento ao Origin pela última vez e quando ajustou pelo Origin.
create table erp_sync.stock_pair(
 product_id uuid not null,
 warehouse_id uuid not null,
 last_push_at timestamptz,
 last_pull_at timestamptz,
 primary key(product_id,warehouse_id)
);

do $$declare t text;begin
 foreach t in array array['settings','link','outbox','inbox','issue','run','census','status_map','stock_pair'] loop
  execute format('alter table erp_sync.%I enable row level security',t);
 end loop;
end$$;

-- ---------------------------------------------------------------------------------------------------------------
create function erp_sync.enabled() returns boolean
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce((select enabled from erp_sync.settings where singleton),false)
$$;
create function erp_sync.actor() returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select actor_id from erp_sync.settings where singleton
$$;
-- Ligado só dentro da transação de um aplicador: a escrita veio do Origin e não volta para lá.
create function erp_sync.applying() returns boolean
language sql stable set search_path=pg_catalog as $$
 select coalesce(current_setting('erp_sync.applying',true),'')='on'
$$;
create function erp_sync.set_applying(p_on boolean) returns void
language plpgsql volatile set search_path=pg_catalog as $$
begin perform set_config('erp_sync.applying',case when p_on then 'on' else '' end,true); end$$;

create function erp_sync.note_issue(p_direction text,p_entity text,p_record uuid,p_source text,p_code text,p_detail text default null) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if exists(select 1 from erp_sync.issue where resolved_at is null and direction=p_direction and entity=p_entity
   and record_id is not distinct from p_record and source_id is not distinct from p_source and code=left(p_code,80)) then return; end if;
 insert into erp_sync.issue(direction,entity,record_id,source_id,code,detail)
 values(p_direction,p_entity,p_record,p_source,left(coalesce(p_code,'UNKNOWN'),80),left(p_detail,500));
end$$;
create function erp_sync.resolve_issues(p_direction text,p_entity text,p_record uuid,p_source text) returns void
language sql security definer set search_path=pg_catalog as $$
 update erp_sync.issue set resolved_at=clock_timestamp() where resolved_at is null and direction=p_direction and entity=p_entity
  and (p_record is null or record_id=p_record) and (p_source is null or source_id=p_source)
$$;

-- Vínculos: o próprio link, ou os vínculos anteriores dos espelhos (cadastros 006/350, documentos 006, financeiro 039).
create function erp_sync.origin_id(p_entity text,p_record uuid) returns text
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce(
  (select origin_id from erp_sync.link where entity=p_entity and record_id=p_record),
  case when p_entity in('contacts','products') then (select source_id from erp_catalog.origin where entity=p_entity and record_id=p_record) end,
  case when p_entity in('sales_orders','sales_proposals','purchase_orders','service_orders')
   then (select source_id from erp_documents.origin_mirror where document_id=p_record) end,
  case when p_entity in('receivables','payables') then (select source_id from erp_finance.origin_import_origin where title_id=p_record and entity=p_entity) end)
$$;
create function erp_sync.local_id(p_entity text,p_origin text) returns uuid
language sql stable security definer set search_path=pg_catalog as $$
 select coalesce(
  (select record_id from erp_sync.link where entity=p_entity and origin_id=p_origin),
  case when p_entity in('contacts','products') then (select record_id from erp_catalog.origin where entity=p_entity and source_id=p_origin) end,
  case when p_entity in('sales_orders','sales_proposals','purchase_orders','service_orders')
   then (select document_id from erp_documents.origin_mirror where entity=p_entity and source_id=p_origin) end,
  case when p_entity in('receivables','payables') then (select title_id from erp_finance.origin_import_origin where entity=p_entity and source_id=p_origin) end)
$$;
create function erp_sync.remember(p_entity text,p_record uuid,p_origin text) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_origin is null or p_record is null then return; end if;
 -- Um ID do Origin pertence a um único registro: um vínculo antigo para outro registro é desfeito.
 delete from erp_sync.link where entity=p_entity and origin_id=p_origin and record_id<>p_record;
 insert into erp_sync.link(entity,record_id,origin_id) values(p_entity,p_record,p_origin)
 on conflict(entity,record_id) do update set origin_id=excluded.origin_id,deleted=false,updated_at=clock_timestamp();
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Fila de envio. Coalesce por registro; uma linha em envio que recebe nova alteração fica "suja" e volta para a fila
-- quando o envio atual terminar. Uma exclusão substitui o envio pendente do mesmo registro e vice-versa.
create function erp_sync.enqueue(p_entity text,p_record uuid,p_op text,p_item integer default 0,p_detail jsonb default null) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_record is null or not erp_sync.enabled() or erp_sync.applying()
  or coalesce(current_user='erp_document_mirror_writer',false) then return; end if;
 if p_op in('upsert','delete') then
  update erp_sync.outbox set state='superseded',finished_at=clock_timestamp()
   where entity=p_entity and record_id=p_record and state='pending' and op=case p_op when 'upsert' then 'delete' else 'upsert' end;
 end if;
 insert into erp_sync.outbox(entity,record_id,item,op,detail) values(p_entity,p_record,coalesce(p_item,0),p_op,p_detail)
 on conflict(entity,record_id,item,op) where state in('pending','sending') do update
  set changed_at=clock_timestamp(),detail=coalesce(excluded.detail,erp_sync.outbox.detail),
   dirty=erp_sync.outbox.state='sending',next_attempt_at=case when erp_sync.outbox.state='pending' then '-infinity' else erp_sync.outbox.next_attempt_at end;
end$$;

create function erp_sync.capture_catalog() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_id uuid; v_entity text;
begin
 if tg_table_name='record' then
  if tg_op='DELETE' then
   if old.entity in('contacts','products') then perform erp_sync.enqueue(old.entity,old.id,'delete'); end if;
   return null;
  end if;
  if new.entity in('contacts','products') then perform erp_sync.enqueue(new.entity,new.id,'upsert'); end if;
  return null;
 end if;
 v_id:=case when tg_op='DELETE' then old.record_id else new.record_id end;
 select entity into v_entity from erp_catalog.record where id=v_id;
 if v_entity in('contacts','products') then
  -- A lixeira de produtos (product_detail.deleted_at) é uma exclusão no Origin; restaurar volta a enviar o cadastro.
  if tg_table_name='product_detail' and tg_op='UPDATE' then
   if new.deleted_at is not null and old.deleted_at is null then perform erp_sync.enqueue(v_entity,v_id,'delete'); return null; end if;
  end if;
  perform erp_sync.enqueue(v_entity,v_id,'upsert');
 end if;
 return null;
end$$;
create trigger zz_origin_sync after insert or update or delete on erp_catalog.record for each row execute function erp_sync.capture_catalog();
create trigger zz_origin_sync after insert or update on erp_catalog.contact for each row execute function erp_sync.capture_catalog();
create trigger zz_origin_sync after insert or update on erp_catalog.product for each row execute function erp_sync.capture_catalog();
create trigger zz_origin_sync after insert or update on erp_catalog.contact_profile for each row execute function erp_sync.capture_catalog();
create trigger zz_origin_sync after insert or update on erp_catalog.product_detail for each row execute function erp_sync.capture_catalog();

create function erp_sync.capture_document() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;
begin
 if tg_table_name='document' then
  if tg_op='DELETE' then perform erp_sync.enqueue(old.kind,old.id,'delete'); return null; end if;
  -- Espelho ainda não convertido continua com o Origin; documento-modelo de proposta não existe no Origin.
  if new.authority='origin' or coalesce((new.body->>'template')::boolean,false) then return null; end if;
  if new.deleted_at is not null then
   if tg_op='INSERT' or old.deleted_at is null then perform erp_sync.enqueue(new.kind,new.id,'delete'); end if;
  else perform erp_sync.enqueue(new.kind,new.id,'upsert'); end if;
  return null;
 end if;
 select * into d from erp_documents.document where id=case when tg_op='DELETE' then old.document_id else new.document_id end;
 if found and d.authority='brufap' and d.deleted_at is null and not coalesce((d.body->>'template')::boolean,false) then
  perform erp_sync.enqueue(d.kind,d.id,'upsert'); end if;
 return null;
end$$;
create trigger zz_origin_sync after insert or update or delete on erp_documents.document for each row execute function erp_sync.capture_document();
create trigger zz_origin_sync after insert or update or delete on erp_documents.item for each row execute function erp_sync.capture_document();

create function erp_sync.capture_finance() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_kind text;
begin
 if tg_table_name='title' then
  v_kind:=case new.kind when 'receivable' then 'receivables' else 'payables' end;
  if new.deleted_at is not null then
   if tg_op='INSERT' or old.deleted_at is null then perform erp_sync.enqueue(v_kind,new.id,'delete'); end if;
  else perform erp_sync.enqueue(v_kind,new.id,'upsert'); end if;
  return null;
 end if;
 -- Baixa e estorno de baixa: um envio por lançamento, com o título no detalhe.
 select case kind when 'receivable' then 'receivables' else 'payables' end into v_kind from erp_finance.title where id=new.title_id;
 perform erp_sync.enqueue(v_kind,new.id,'settle',0,jsonb_build_object('title_id',new.title_id));
 return null;
end$$;
create trigger zz_origin_sync after insert or update on erp_finance.title for each row execute function erp_sync.capture_finance();
create trigger zz_origin_sync after insert on erp_finance.settlement for each row execute function erp_sync.capture_finance();

create function erp_sync.capture_stock() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 perform erp_sync.enqueue('stock',new.movement_id,'stock',new.ordinal,jsonb_build_object('product_id',new.product_id,'warehouse_id',new.warehouse_id));
 return null;
end$$;
create trigger zz_origin_sync after insert on erp_stock.entry for each row execute function erp_sync.capture_stock();

-- ---------------------------------------------------------------------------------------------------------------
-- Travas por autoridade. Origem continua imutável (procedência). A autoridade só muda pelo conversor da sincronização.
create or replace function erp_document_mirror.guard_document() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare v_sync boolean:=erp_sync.applying(); v_writer boolean:=coalesce(erp_document_mirror.writing(),false);
begin
 if tg_op='DELETE' then
  if old.authority='origin' and not v_sync then raise exception 'erp_document_mirror_readonly' using errcode='42501';end if;
  return old;
 end if;
 if tg_op='UPDATE' and (new.origin<>old.origin or new.id<>old.id or new.kind<>old.kind) then
  raise exception 'erp_document_mirror_identity_immutable' using errcode='42501';end if;
 if tg_op='UPDATE' and new.authority<>old.authority and not v_sync then
  raise exception 'erp_document_mirror_identity_immutable' using errcode='42501';end if;
 if new.authority='origin' then
  if not (v_writer or v_sync) or (v_writer and new.origin<>'origin') then raise exception 'erp_document_mirror_readonly' using errcode='42501';end if;
 elsif v_writer then
  raise exception 'erp_document_mirror_writer_native_denied' using errcode='42501';
 end if;
 if new.source_proposal_id is not null and exists(select 1 from erp_documents.document d where d.id=new.source_proposal_id and d.authority='origin') then
  raise exception 'erp_document_mirror_effect_forbidden' using errcode='42501';end if;
 return new;
end$$;

create or replace function erp_document_mirror.guard_item() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare old_mirror boolean:=false;new_mirror boolean:=false;v_writer boolean:=coalesce(erp_document_mirror.writing(),false);
begin
 if tg_op<>'INSERT' then select d.authority='origin' into old_mirror from erp_documents.document d where d.id=old.document_id;end if;
 if tg_op<>'DELETE' then select d.authority='origin' into new_mirror from erp_documents.document d where d.id=new.document_id;end if;
 if coalesce(old_mirror,false) or coalesce(new_mirror,false) then
  if not (v_writer or erp_sync.applying()) or (tg_op='UPDATE' and old.document_id<>new.document_id) then
   raise exception 'erp_document_mirror_readonly' using errcode='42501';end if;
 elsif v_writer then raise exception 'erp_document_mirror_writer_native_denied' using errcode='42501';end if;
 if tg_op='DELETE' then return old;end if;return new;
end$$;

create or replace function erp_document_mirror.require_visible(p_user uuid,p_document uuid,p_write boolean default false) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if exists(select 1 from erp_documents.document d where d.id=p_document and d.origin='origin') then
  if not erp_document_mirror.visible(p_user,p_document) then raise exception 'erp_document_not_found' using errcode='P0002';end if;
  if p_write and exists(select 1 from erp_documents.document d where d.id=p_document and d.authority='origin') then
   raise exception 'erp_document_mirror_readonly' using errcode='42501';end if;
 end if;
end$$;

-- O projetor 006 grava espelhos somente leitura. Com a mão dupla ligada, a fila de recebimento converte o documento para o
-- modelo nativo (010); o projetor só descarta a fila dele, sem reescrever documentos convertidos.
create or replace function public.erp_document_mirror_project(p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare n integer;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'document_mirror_invalid_limit'using errcode='22023';end if;
 if not pg_try_advisory_xact_lock(174852901,220006) then return jsonb_build_object('state','busy','processed',0,'applied',0,'failed',0,'seeded',0,'pending',null);end if;
 with gone as(delete from erp_document_mirror.seed where ctid in(select ctid from erp_document_mirror.seed limit p_limit*10) returning 1)
 select count(*) into n from gone;
 with gone as(delete from erp_document_mirror.pending where ctid in(select ctid from erp_document_mirror.pending limit p_limit*10) returning 1)
 select n+count(*) into n from gone;
 return jsonb_build_object('state','two_way','processed',n,'applied',0,'failed',0,'seeded',0,
  'pending',(select count(*)from erp_document_mirror.seed)+(select count(*)from erp_document_mirror.pending));
end$$;

-- Leituras, relatórios e indicadores tratavam todo documento de origem Origin como espelho. Passam a olhar a autoridade:
-- um documento convertido entra nos totais e nos relatórios como qualquer documento do Brufap. A troca é textual e só
-- alcança comparações literais de documentos (alias.origin='origin'|'brufap'); notas fiscais e numeração não mudam.
do $migration$declare r record; definition text; changed text;begin
 for r in select p.oid,n.nspname||'.'||p.proname sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname,p.proname) in(('erp_documents','document_view'),('erp_documents','dto'),('erp_documents','list_row'),('erp_documents','summary'),
   ('erp_home','biz_new_customers'),('erp_home','biz_orders'),('erp_home','biz_unit_cost'),('erp_home','notification_digest'),
   ('erp_preferences','report_source'),('public','erp_catalog_contact_history'),('public','erp_catalog_contact_sales'),
   ('public','erp_catalog_product_purchase_info'),('public','erp_document_export'),('public','erp_document_history'),('public','erp_document_list'),
   ('public','erp_document_sales_abc'),('public','erp_document_sales_report'),('public','erp_document_sales_romaneio'),
   ('public','erp_document_service_occurrence_report'),('public','erp_document_service_report'),('public','erp_document_stock_list'),
   ('public','erp_finance_grouped_billing_candidates'),('public','erp_finance_grouped_billing_documents'),('public','erp_home_business_customers'),
   ('public','erp_home_business_goals'),('public','erp_home_overview'),('public','erp_home_summary'),('public','erp_home_top_products'),
   ('public','erp_stock_purchase_suggestion'),('public','erp_stock_report_purchase_orders'))
 loop
  definition:=replace(pg_get_functiondef(r.oid),E'\r','');
  changed:=regexp_replace(definition,'\m([a-z])\.origin(\s*)(=|<>)(\s*)''(origin|brufap)''','\1.authority\2\3\4''\5''','g');
  changed:=regexp_replace(changed,'\(select \* from erp_documents\.document where origin=''brufap''and','(select * from erp_documents.document where authority=''brufap''and','g');
  changed:=replace(changed,'d.origin as origin,d.id as document_id','d.authority as origin,d.id as document_id');
  if changed is distinct from definition then execute changed; end if;
 end loop;
end$migration$;

-- Números: o próximo número do Brufap começa depois do maior número já usado no Origin, para não repetir no envio.
update erp_documents.numbering n set last_number=greatest(n.last_number,coalesce((select max(d.number) from erp_documents.document d where d.kind=n.kind and d.number<=9999999999),0));

-- ---------------------------------------------------------------------------------------------------------------
-- Fila de recebimento: toda versão nova da área bruta das entidades em mão dupla.
create function erp_sync.capture_raw() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if tg_op='UPDATE' and new.version=old.version and new.version_hash=old.version_hash then return null; end if;
 insert into erp_sync.inbox(entity,source_id,version,seen_at) values(new.entity,new.source_id,new.version,clock_timestamp())
 on conflict(entity,source_id) do update set version=greatest(erp_sync.inbox.version,excluded.version),seen_at=excluded.seen_at,retry_at='-infinity',attempts=0,error=null;
 return null;
end$$;
create trigger zz_origin_two_way after insert or update on origin_sync.raw_record for each row
 when(new.entity in('contacts','products','sales_orders','sales_proposals','purchase_orders','service_orders','receivables','payables','stock_balances'))
 execute function erp_sync.capture_raw();
insert into erp_sync.inbox(entity,source_id,version)
 select entity,source_id,version from origin_sync.raw_record
 where entity in('contacts','products','sales_orders','sales_proposals','purchase_orders','service_orders','receivables','payables','stock_balances');

-- Grava na área bruta um detalhe lido pelo Worker da sincronização (eco de um envio ou registro descoberto no censo),
-- com o mesmo hash do coletor (001). Uma versão nova só nasce quando o conteúdo muda.
create function public.erp_sync_stage(p_entity text,p_source_id text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare h text; r origin_sync.raw_record;
begin
 if p_entity not in('contacts','products','sales_orders','sales_proposals','purchase_orders','service_orders','receivables','payables','stock_balances')
  or p_source_id is null or p_source_id!~'^[1-9][0-9]{0,39}$' or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>1048576 then
  raise exception 'erp_sync_stage_invalid' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(174852901,hashtext(p_entity));
 insert into origin_sync.resource_state(resource) values('two_way_'||p_entity) on conflict do nothing;
 h:=encode(sha256(convert_to(jsonb_build_object('payload',p_payload,'document_links','[]'::jsonb)::text,'UTF8')),'hex');
 insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)
 values(p_entity,'two_way_'||p_entity,p_source_id,p_payload,h)
 on conflict(entity,source_id) do update set last_seen_at=clock_timestamp(),
  payload=case when origin_sync.raw_record.version_hash=excluded.version_hash then origin_sync.raw_record.payload else excluded.payload end,
  version=case when origin_sync.raw_record.version_hash=excluded.version_hash then origin_sync.raw_record.version else origin_sync.raw_record.version+1 end,
  changed_at=case when origin_sync.raw_record.version_hash=excluded.version_hash then origin_sync.raw_record.changed_at else clock_timestamp() end,
  last_resource=excluded.last_resource,version_hash=excluded.version_hash
 returning * into r;
 return jsonb_build_object('entity',r.entity,'source_id',r.source_id,'version',r.version,'hash',r.version_hash);
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Rodadas do botão Sincronizar e situação para a tela.
create function erp_sync.require_member(p_user uuid,p_write boolean) returns text
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 select role into v_role from erp_access.membership where user_id=p_user and active;
 if v_role is null or (p_write and v_role='consulta') then raise exception 'erp_sync_access_denied' using errcode='42501'; end if;
 return v_role;
end$$;

create function erp_sync.status_dto() returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object('scope','origin_sync','enabled',erp_sync.enabled(),'actor_configured',erp_sync.actor() is not null,
  'push',jsonb_build_object('pending',(select count(*) from erp_sync.outbox where state in('pending','sending')),
   'failed',(select count(*) from erp_sync.outbox where state='failed'),
   'last_sent_at',(select max(finished_at) from erp_sync.outbox where state='done')),
  'pull',jsonb_build_object('pending',(select count(*) from erp_sync.inbox),
   'failed',(select count(*) from erp_sync.inbox where attempts>0),
   'last_applied_at',(select max(pulled_at) from erp_sync.link)),
  'issues',(select count(*) from erp_sync.issue where resolved_at is null),
  'recent_issues',(select coalesce(jsonb_agg(jsonb_build_object('at',created_at,'direction',direction,'entity',entity,'record_id',record_id,
     'source_id',source_id,'code',code,'detail',detail) order by created_at desc),'[]'::jsonb)
   from(select * from erp_sync.issue where resolved_at is null order by created_at desc limit 20) i),
  'run',(select jsonb_build_object('id',id,'state',state,'phase',phase,'requested_at',requested_at,'started_at',started_at,
     'finished_at',finished_at,'stats',stats,'error',error) from erp_sync.run order by requested_at desc limit 1))
$$;

create function public.erp_sync_status(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_sync.require_member(p_user_id,false);
 return erp_sync.status_dto();
end$$;

create function public.erp_sync_request(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_run erp_sync.run;
begin
 perform erp_sync.require_member(p_user_id,true);
 if not erp_sync.enabled() then raise exception 'erp_sync_disabled' using errcode='55000'; end if;
 select * into v_run from erp_sync.run where state in('queued','running');
 if not found then
  insert into erp_sync.run(requested_by) values(p_user_id) returning * into v_run;
  -- Falhas anteriores voltam para a fila: o botão é a forma de pedir nova tentativa.
  update erp_sync.outbox set state='pending',next_attempt_at='-infinity',attempts=0 where state='failed'
   and not exists(select 1 from erp_sync.outbox o where o.entity=outbox.entity and o.record_id=outbox.record_id and o.item=outbox.item
    and o.op=outbox.op and o.state in('pending','sending'));
  update erp_sync.inbox set retry_at='-infinity' where attempts>0;
 end if;
 return erp_sync.status_dto()||jsonb_build_object('requested_run',v_run.id);
end$$;

-- Worker: a rodada ativa (ou nenhuma) e o avanço dela.
create function public.erp_sync_run_get() returns jsonb
language sql security definer set search_path=pg_catalog as $$
 select coalesce((select to_jsonb(r) from erp_sync.run r where state in('queued','running') order by requested_at limit 1),'null'::jsonb)
$$;
create function public.erp_sync_run_update(p_run uuid,p_state text,p_phase text,p_cursor jsonb,p_stats jsonb,p_error text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare r erp_sync.run;
begin
 update erp_sync.run set state=coalesce(p_state,state),phase=coalesce(p_phase,phase),cursor=coalesce(p_cursor,cursor),
  stats=stats||coalesce(p_stats,'{}'::jsonb),error=left(p_error,500),
  started_at=coalesce(started_at,case when p_state='running' then clock_timestamp() end),
  finished_at=case when p_state in('done','failed') then clock_timestamp() else finished_at end
 where id=p_run and state in('queued','running') returning * into r;
 if r.id is not null and r.state in('done','failed') then delete from erp_sync.census where run_id=r.id; end if;
 return to_jsonb(r);
end$$;

-- Censo: IDs listados no Origin por entidade; a diferença diz o que buscar (novo no Origin) e o que conferir (sumiu do Origin).
create function public.erp_sync_census_add(p_run uuid,p_entity text,p_ids jsonb) returns integer
language plpgsql security definer set search_path=pg_catalog as $$
declare n integer;
begin
 if p_entity not in('contacts','products','sales_orders','sales_proposals','purchase_orders','service_orders','receivables','payables')
  or jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids)>1000
  or exists(select 1 from jsonb_array_elements(p_ids) x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[1-9][0-9]{0,39}$') then
  raise exception 'erp_sync_census_invalid' using errcode='22023'; end if;
 insert into erp_sync.census(run_id,entity,origin_id) select p_run,p_entity,x#>>'{}' from jsonb_array_elements(p_ids) x on conflict do nothing;
 get diagnostics n=row_count; return n;
end$$;

create function public.erp_sync_census_diff(p_run uuid,p_entity text,p_limit integer default 500,p_since date default null) returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object(
  -- Listado no Origin e ainda sem área bruta nem vínculo: buscar o detalhe.
  'fetch',(select coalesce(jsonb_agg(origin_id),'[]'::jsonb) from(select c.origin_id from erp_sync.census c
    where c.run_id=p_run and c.entity=p_entity
     and not exists(select 1 from origin_sync.raw_record r where r.entity=p_entity and r.source_id=c.origin_id)
     and erp_sync.local_id(p_entity,c.origin_id) is null order by c.origin_id limit p_limit) x),
  -- Vinculado no Brufap e ausente da listagem: conferir pelo detalhe (404 confirma a exclusão no Origin).
  'check',(select coalesce(jsonb_agg(origin_id),'[]'::jsonb) from(select l.origin_id from(
     select k.origin_id from erp_sync.link k where k.entity=p_entity and not k.deleted
      and not exists(select 1 from origin_sync.raw_record r where r.entity=p_entity and r.source_id=k.origin_id)
     union select source_id from origin_sync.raw_record where entity=p_entity
      and not coalesce(payload#>'{_brufap_source,deleted}'='true'::jsonb,false) and coalesce(payload->>'situacao','')<>'E'
      -- O censo de documentos e contas lista uma janela de datas; só se confere o que cai nela.
      and (p_since is null or coalesce(erp_fiscal_invoices.origin_date(payload->'data'),erp_fiscal_invoices.origin_date(payload->'dataEmissao'),
       erp_fiscal_invoices.origin_date(payload->'vencimento'))>=p_since)) l
    where not exists(select 1 from erp_sync.census c where c.run_id=p_run and c.entity=p_entity and c.origin_id=l.origin_id)
     and not exists(select 1 from erp_sync.link k where k.entity=p_entity and k.origin_id=l.origin_id and k.deleted)
    order by l.origin_id limit p_limit) x))
$$;

-- ---------------------------------------------------------------------------------------------------------------
revoke all on all tables in schema erp_sync from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_sync from public,anon,authenticated,service_role;
do $$declare f text;begin
 foreach f in array array['erp_sync_stage(text,text,jsonb)','erp_sync_status(uuid)','erp_sync_request(uuid)','erp_sync_run_get()',
  'erp_sync_run_update(uuid,text,text,jsonb,jsonb,text)','erp_sync_census_add(uuid,text,jsonb)','erp_sync_census_diff(uuid,text,integer,date)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end$$;
-- As funções de trava e de captura rodam no contexto de quem escreve (inclusive o papel do projetor 006).
grant usage on schema erp_sync to erp_document_mirror_writer;
grant execute on function erp_sync.applying(),erp_sync.enabled(),erp_sync.enqueue(text,uuid,text,integer,jsonb) to erp_document_mirror_writer;
commit;
