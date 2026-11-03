-- Documentos comerciais: observações contínuas e projeção sem comandos nem efeitos operacionais.
-- As funções publicadas não são substituídas. Aplicar 007 antes de ativar o projetor.
begin;
create role erp_document_mirror_writer nologin noinherit;
do $$begin execute format('grant erp_document_mirror_writer to %I',current_user);end$$;
create schema erp_document_mirror;
revoke all on schema erp_document_mirror from public,anon,authenticated,service_role;
-- ALTER OWNER exige CREATE no schema para o novo proprietário, inclusive quando
-- a migração é executada pelo postgres gerenciado do Supabase sem SUPERUSER.
grant usage,create on schema erp_document_mirror to erp_document_mirror_writer;
alter table erp_documents.document add column origin text not null default 'brufap' check(origin in('brufap','origin')),
 add column authority text not null default 'brufap' check(authority in('brufap','origin'));
alter table erp_documents.document alter column number drop not null,alter column contact_id drop not null,alter column total drop not null,
 drop constraint document_kind_number_key,drop constraint erp_document_state_valid,
 add constraint document_native_required check(origin='origin' or(number is not null and contact_id is not null and total is not null)),
 add constraint erp_document_state_valid check((origin='origin'and status='source_unknown')or(erp_documents.transitions()->kind)?status);
create unique index document_native_kind_number on erp_documents.document(kind,number)where origin='brufap';
alter table erp_documents.item alter column quantity drop not null,alter column unit_price drop not null,
 alter column discount_percent drop not null,alter column total drop not null;

create table erp_documents.origin_mirror(
 entity text not null check(entity in('sales_proposals','sales_orders','purchase_orders','service_orders')),source_id text not null,
 document_id uuid not null unique references erp_documents.document,applied_version bigint not null,applied_hash text not null,
 mapper_version integer not null default 1,state text not null check(state in('synced','pending')),
 source_number text,source_status text,source_status_label text,observed_at timestamptz not null,source_updated_at timestamptz,
 source_deleted boolean not null,issues jsonb not null,reconciliation jsonb not null,effects jsonb not null,capture_hash text,plan_hash text not null,
 primary key(entity,source_id)
);
create table erp_documents.origin_status_map(
 entity text not null,source_status text not null,native_status text not null,approved_by uuid not null references auth.users,
 approved_at timestamptz not null,primary key(entity,source_status),check((erp_documents.transitions()->entity)?native_status)
);
-- Sem mapa presumido: a aprovação operacional é uma decisão futura explícita do administrador.
create table erp_document_mirror.settings(singleton boolean primary key default true check(singleton),actor_id uuid not null references auth.users);
create table erp_document_mirror.source_version(
 entity text not null,source_id text not null,source_version bigint not null,source_hash text not null,payload jsonb not null,
 document_links jsonb not null,price_capture jsonb,observed_at timestamptz not null,source_updated_at timestamptz,
 primary key(entity,source_id,source_version)
);
create table erp_document_mirror.pending(
 entity text not null,source_id text not null,source_version bigint not null,seen_at timestamptz not null,
 retry_at timestamptz not null default '-infinity',attempts integer not null default 0,
 primary key(entity,source_id,source_version),foreign key(entity,source_id,source_version)references erp_document_mirror.source_version
);
-- 059/071/078 anexam a captura lexical depois do payload, na mesma transação e versão.
-- Evidência adicional é append-only; não reescreve a primeira observação do payload.
create table erp_document_mirror.price_observation(
 entity text not null,source_id text not null,source_version bigint not null,capture_hash text not null,
 capture jsonb not null,observed_at timestamptz not null default clock_timestamp(),
 primary key(entity,source_id,source_version,capture_hash),foreign key(entity,source_id,source_version)references erp_document_mirror.source_version
);
create index document_mirror_pending_retry on erp_document_mirror.pending(retry_at,entity,source_id,source_version);
create table erp_document_mirror.source_dependency(
 entity text not null,source_id text not null,source_version bigint not null,ref_entity text not null,ref_source_id text not null,
 primary key(entity,source_id,source_version,ref_entity,ref_source_id),
 foreign key(entity,source_id,source_version)references erp_document_mirror.source_version
);
create index document_mirror_dependency_lookup on erp_document_mirror.source_dependency(ref_entity,ref_source_id,entity,source_id,source_version);
create table erp_document_mirror.seed(entity text not null,source_id text not null,primary key(entity,source_id));
create table erp_document_mirror.issue(
 entity text not null,source_id text not null,source_version bigint not null,code text not null,
 created_at timestamptz not null default clock_timestamp(),resolved_at timestamptz,primary key(entity,source_id,source_version,code)
);
create table erp_document_mirror.revision(
 entity text not null,source_id text not null,source_version bigint not null,mapper_version integer not null,
 document_id uuid not null references erp_documents.document,command_id uuid not null unique,
 before_document jsonb,after_document jsonb not null,before_items jsonb,after_items jsonb not null,
 observed_at timestamptz not null,applied_at timestamptz not null default clock_timestamp(),actor_id uuid not null references auth.users,
 projection_version integer not null,capture_hash text,
 primary key(entity,source_id,source_version,mapper_version,projection_version)
);
create function erp_document_mirror.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'document_mirror_immutable'using errcode='55000';end$$;
create trigger immutable_source before update or delete on erp_document_mirror.source_version for each row execute function erp_document_mirror.immutable();
create trigger immutable_revision before update or delete on erp_document_mirror.revision for each row execute function erp_document_mirror.immutable();
create trigger immutable_price before update or delete on erp_document_mirror.price_observation for each row execute function erp_document_mirror.immutable();
create function erp_document_mirror.native_item_required()returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if exists(select 1 from erp_documents.document where id=new.document_id and origin='brufap')
  and(new.quantity is null or new.unit_price is null or new.discount_percent is null or new.total is null)then
  raise exception 'document_native_item_required'using errcode='23502';end if;return new;
end$$;
create trigger document_native_item_required before insert or update on erp_documents.item for each row execute function erp_document_mirror.native_item_required();

create function erp_document_mirror.capture_row(s origin_sync.raw_record)returns void language plpgsql security definer set search_path=pg_catalog as $$
declare h text;
begin
 if s.entity not in('sales_proposals','sales_orders','purchase_orders','service_orders')then return;end if;
 perform pg_advisory_xact_lock(174852901,hashtext('document_mirror:'||s.entity||':'||s.source_id));
 insert into erp_document_mirror.source_version values(s.entity,s.source_id,s.version,s.version_hash,s.payload,s.document_links,s.price_capture,s.last_seen_at,s.source_updated_at)on conflict do nothing;
 select source_hash into h from erp_document_mirror.source_version where entity=s.entity and source_id=s.source_id and source_version=s.version;
 if h<>s.version_hash then
  insert into erp_document_mirror.issue(entity,source_id,source_version,code)values(s.entity,s.source_id,s.version,'VERSION_HASH_CONFLICT')on conflict do nothing;
 else
  insert into erp_document_mirror.source_dependency
  select s.entity,s.source_id,s.version,ref_entity,ref_source_id from(
   select 'contacts'::text ref_entity,erp_documents.origin_import_id(case when s.entity='purchase_orders'then coalesce(s.payload#>'{fornecedor,id}',s.payload#>'{contato,id}')else s.payload#>'{contato,id}'end)ref_source_id
   union select 'products',erp_documents.origin_import_id(x#>'{produto,id}')from jsonb_array_elements(
    case when s.entity='service_orders'then
     (case when jsonb_typeof(s.payload->'pecas')='array'then s.payload->'pecas'else'[]'::jsonb end)||
     (case when jsonb_typeof(s.payload->'servicos')='array'then s.payload->'servicos'else'[]'::jsonb end)
    when jsonb_typeof(s.payload->'itens')='array'then s.payload->'itens'else'[]'::jsonb end)x
  )r where ref_source_id is not null on conflict do nothing;
  if s.price_capture->>'source_hash'=s.version_hash and s.price_capture->>'source_version'=s.version::text then
   insert into erp_document_mirror.price_observation(entity,source_id,source_version,capture_hash,capture)
   values(s.entity,s.source_id,s.version,encode(sha256(convert_to(jsonb_build_object('profile',s.price_capture->'profile','tokens',s.price_capture->'tokens')::text,'UTF8')),'hex'),s.price_capture)on conflict do nothing;
  end if;
  insert into erp_document_mirror.pending(entity,source_id,source_version,seen_at)values(s.entity,s.source_id,s.version,s.last_seen_at)
  on conflict(entity,source_id,source_version)do update set seen_at=greatest(erp_document_mirror.pending.seen_at,excluded.seen_at);
 end if;
end$$;
create function erp_document_mirror.capture()returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin perform erp_document_mirror.capture_row(new);return null;end$$;
create trigger document_mirror_capture after insert or update on origin_sync.raw_record for each row
 when(new.entity in('sales_proposals','sales_orders','purchase_orders','service_orders'))execute function erp_document_mirror.capture();
-- Um vínculo por ID que chega depois do documento reabre apenas as fontes dependentes vigentes.
create function erp_document_mirror.binding_changed()returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare q record;
begin
 for q in select d.entity,d.source_id,d.source_version,s.observed_at from erp_document_mirror.source_dependency d
 join erp_document_mirror.source_version s using(entity,source_id,source_version)
 where d.ref_entity=new.entity and d.ref_source_id=new.source_id
 and not exists(select 1 from erp_document_mirror.source_version newer where newer.entity=d.entity and newer.source_id=d.source_id and newer.source_version>d.source_version)
 order by d.entity,d.source_id,d.source_version loop
  -- Serializa com apply/capture: o DELETE da fila não pode consumir uma vinculação que chegou depois do plano.
  perform pg_advisory_xact_lock(174852901,hashtext('document_mirror:'||q.entity||':'||q.source_id));
  insert into erp_document_mirror.pending(entity,source_id,source_version,seen_at)values(q.entity,q.source_id,q.source_version,q.observed_at)
  on conflict(entity,source_id,source_version)do update set retry_at='-infinity';
 end loop;return null;
end$$;
create trigger document_mirror_binding_insert after insert on erp_catalog.origin for each row
 when(new.entity in('contacts','products'))execute function erp_document_mirror.binding_changed();
create trigger document_mirror_binding_update after update of record_id on erp_catalog.origin for each row
 when(new.entity in('contacts','products')and old.record_id is distinct from new.record_id)execute function erp_document_mirror.binding_changed();

create function erp_document_mirror.text(v jsonb,n integer)returns text language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)in('string','number')then nullif(left(btrim(regexp_replace(v#>>'{}','[[:cntrl:]]',' ','g')),n),'')end
$$;
create function erp_document_mirror.uuid(v text)returns uuid language sql immutable set search_path=pg_catalog as $$
 select(substring(h,1,8)||'-'||substring(h,9,4)||'-5'||substring(h,14,3)||'-8'||substring(h,18,3)||'-'||substring(h,21,12))::uuid from(select md5(v)h)s
$$;
create function erp_document_mirror.decimal(v jsonb,p_scale integer,p_digits integer)returns text language plpgsql immutable set search_path=pg_catalog as $$
declare t text;n numeric;
begin
 if jsonb_typeof(v)not in('string','number')then return null;end if;t:=v#>>'{}';
 if length(t)>80 or t!~'^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$'then return null;end if;
 begin n:=t::numeric;exception when others then return null;end;
 if n>=power(10::numeric,p_digits)or min_scale(n)>p_scale then return null;end if;return trim_scale(n)::text;
end$$;
create function erp_document_mirror.binding(p_entity text,p_source_id text)returns uuid language sql stable security definer set search_path=pg_catalog as $$
 select o.record_id from erp_catalog.origin o join erp_catalog.record r on r.id=o.record_id
 where o.entity=p_entity and o.source_id=p_source_id and r.entity=p_entity
$$;

-- Uma proposta legada só é adotável quando o vínculo original prova a identidade e nenhum dependente foi criado.
create function erp_document_mirror.legacy_target(p_entity text,p_source_id text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare d erp_documents.document;o erp_documents.origin_import_origin;k record;blocked boolean;
begin
 select *into o from erp_documents.origin_import_origin where entity=p_entity and source_id=p_source_id;
 if not found then return jsonb_build_object('id',null,'eligible',true);end if;
 select *into d from erp_documents.document where id=o.document_id;
 if d.kind<>p_entity or d.version<>1 or d.status<>'draft'or d.deleted_at is not null or d.source_proposal_id is not null or d.origin<>'brufap'
  or not exists(select 1 from erp_documents.audit a where a.document_id=d.id and a.command_id=o.command_id and a.action in('origin_import_proposal','origin_import_proposal_v2'))
  or exists(select 1 from erp_documents.audit a where a.document_id=d.id and(a.command_id<>o.command_id or a.action not in('origin_import_proposal','origin_import_proposal_v2')))then
  return jsonb_build_object('id',d.id,'eligible',false);end if;
 for k in select n.nspname,t.relname,a.attname from pg_constraint c join pg_class t on t.oid=c.conrelid
  join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=t.oid and a.attnum=c.conkey[1]
  where c.contype='f'and c.confrelid='erp_documents.document'::regclass and cardinality(c.conkey)=1
  and c.conrelid not in('erp_documents.item'::regclass,'erp_documents.audit'::regclass,'erp_documents.origin_import_origin'::regclass)loop
  execute format('select exists(select 1 from %I.%I where %I=$1)',k.nspname,k.relname,k.attname)into blocked using d.id;
  if blocked then return jsonb_build_object('id',d.id,'eligible',false);end if;
 end loop;
 for k in select n.nspname,t.relname,a.attname from pg_constraint c join pg_class t on t.oid=c.conrelid
  join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=t.oid and a.attnum=c.conkey[1]
  where c.contype='f'and c.confrelid='erp_documents.item'::regclass and cardinality(c.conkey)=1 loop
  execute format('select exists(select 1 from %I.%I x join erp_documents.item i on i.id=x.%I where i.document_id=$1)',k.nspname,k.relname,k.attname)into blocked using d.id;
  if blocked then return jsonb_build_object('id',d.id,'eligible',false);end if;
 end loop;
 return jsonb_build_object('id',d.id,'eligible',true);
end$$;

create function erp_document_mirror.plan(s erp_document_mirror.source_version)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare p jsonb:=s.payload;party jsonb;row jsonb;rows jsonb:='[]';issues jsonb:='[]';body jsonb;contact uuid;product uuid;
 number text;total text;gross text;qty text;price text;line_total text;v_source_status text;label text;status text;pos integer:=0;sid text;capture_ok boolean;
 capture jsonb;capture_hash text;inputs jsonb;entry jsonb;path text;installments jsonb:='[]';freight text;other text;
begin
 number:=erp_document_mirror.decimal(p->'numero',0,10);if number='0'then number:=null;end if;
 total:=erp_document_mirror.decimal(p->'total',30,30);gross:=erp_document_mirror.decimal(case when s.entity='service_orders'then p->'totalPecas'else p->'totalProdutos'end,30,30);
 freight:=erp_document_mirror.decimal(case when s.entity='service_orders'then p->'valorFrete'else p#>'{transporte,frete}'end,30,30);
 other:=erp_document_mirror.decimal(p->'outrasDespesas',30,30);
 party:=case when s.entity='purchase_orders'then coalesce(p->'fornecedor',p->'contato')else p->'contato'end;
 contact:=erp_document_mirror.binding('contacts',erp_documents.origin_import_id(party->'id'));
 v_source_status:=coalesce(erp_document_mirror.text(p#>'{situacao,id}',80),erp_document_mirror.text(p->'situacao',80));
 label:=coalesce(erp_document_mirror.text(p#>'{situacao,nome}',120),erp_document_mirror.text(p#>'{situacao,descricao}',120),case when jsonb_typeof(p->'situacao')='string'then erp_document_mirror.text(p->'situacao',120)end);
 select native_status into status from erp_documents.origin_status_map where entity=s.entity and source_status=v_source_status;
 if status is null then issues:=issues||'"STATUS_UNMAPPED"';status:='source_unknown';end if;
 if contact is null then issues:=issues||'"CONTACT_UNLINKED"';end if;
 if number is null then issues:=issues||'"NUMBER_UNKNOWN"';end if;
 if total is null then issues:=issues||'"TOTAL_UNKNOWN"';end if;
 select o.capture,o.capture_hash into capture,capture_hash from erp_document_mirror.price_observation o where o.entity=s.entity and o.source_id=s.source_id and o.source_version=s.source_version
  and o.capture->>'source_hash'=s.source_hash order by observed_at desc,capture_hash desc limit 1;
 capture_ok:=capture->>'source_hash'=s.source_hash and capture->>'source_version'=s.source_version::text;
 if s.entity='service_orders'then capture_ok:=p#>>'{_brufap_service_capture,profile}'='origin-service-json-v1';end if;
 if not coalesce(capture_ok,false)then issues:=issues||'"PRICE_CAPTURE_UNAVAILABLE"';end if;
 if s.entity='service_orders'and(jsonb_typeof(p->'pecas')='array'or jsonb_typeof(p->'servicos')='array')then
  select coalesce(jsonb_agg(x order by family,n),'[]')into inputs from(
   select 0 family,n,jsonb_build_object('path','/pecas/'||(n-1),'row',r)x from jsonb_array_elements(case when jsonb_typeof(p->'pecas')='array'then p->'pecas'else'[]'::jsonb end)with ordinality t(r,n)
   union all select 1,n,jsonb_build_object('path','/servicos/'||(n-1),'row',r)from jsonb_array_elements(case when jsonb_typeof(p->'servicos')='array'then p->'servicos'else'[]'::jsonb end)with ordinality t(r,n))a;
 elsif s.entity<>'service_orders'and jsonb_typeof(p->'itens')='array'then
  select coalesce(jsonb_agg(jsonb_build_object('path','/itens/'||(n-1),'row',r)order by n),'[]')into inputs from jsonb_array_elements(p->'itens')with ordinality t(r,n);
 end if;
 if inputs is not null and jsonb_array_length(inputs)<=250 then
  for entry in select value from jsonb_array_elements(inputs)loop
   row:=entry->'row';path:=entry->>'path';
   pos:=pos+1;sid:=erp_documents.origin_import_id(row#>'{produto,id}');product:=erp_document_mirror.binding('products',sid);
   qty:=erp_document_mirror.decimal(row->'quantidade',30,30);
   price:=erp_document_mirror.decimal(case when s.entity='service_orders'then row->'valorUnitario'else row->'valor'end,30,30);
   if capture_ok and s.entity<>'service_orders'then select erp_document_mirror.decimal(to_jsonb(t->>'lexeme'),30,30)into price from jsonb_array_elements(capture->'tokens')t where t->>'path'=path||'/valor';end if;
   line_total:=erp_document_mirror.decimal(row->'valorTotal',30,30);
   if qty is null or price is null or line_total is null then issues:=issues||'"ITEM_VALUES_INCOMPLETE"';end if;
   if product is null then issues:=issues||'"PRODUCT_UNLINKED"';end if;
   rows:=rows||jsonb_build_array(jsonb_build_object('position',pos,'source_id',sid,'product_id',product,'source_path',path,'hours',erp_document_mirror.decimal(row->'horas',30,30),
    'description',coalesce(erp_document_mirror.text(row->'descricao',200),erp_document_mirror.text(row#>'{produto,descricao}',200),erp_document_mirror.text(row->'descricaoDetalhada',200)),
    'code',coalesce(erp_document_mirror.text(row->'codigo',100),erp_document_mirror.text(row->'codigoFornecedor',100)),'unit',erp_document_mirror.text(row->'unidade',16),
    'quantity',qty,'unit_price',price,'discount_percent',null,'total',line_total,
    'detailed_description',erp_document_mirror.text(row->'descricaoDetalhada',4000)));
  end loop;
 else issues:=issues||'"ITEMS_UNAVAILABLE"';end if;
 if jsonb_typeof(p->'parcelas')='array'then
  select coalesce(jsonb_agg(jsonb_build_object('due_date',erp_fiscal_invoices.origin_date(coalesce(r->'dataVencimento',r->'data')),
   'amount',erp_document_mirror.decimal(r->'valor',30,30),'method',null,'note',erp_document_mirror.text(r->'observacoes',2000))order by n),'[]')into installments
  from jsonb_array_elements(p->'parcelas')with ordinality t(r,n);
 end if;
 body:=jsonb_build_object('date',erp_fiscal_invoices.origin_date(p->'data'),'expected_date',erp_fiscal_invoices.origin_date(p->'dataPrevista'),
  'next_contact',erp_fiscal_invoices.origin_date(p->'dataProximoContato'),'contact_id',contact,'warehouse_id',null,
  'notes',erp_document_mirror.text(p->'observacoes',4000),'internal_notes',erp_document_mirror.text(coalesce(p->'observacaoInterna',p->'observacoesInternas'),4000),
  'ship_date',erp_fiscal_invoices.origin_date(p->'dataSaida'),'completed_date',erp_fiscal_invoices.origin_date(p->'dataConclusao'),
  'equipment',erp_document_mirror.text(p->'equipamento',500),'serial_number',erp_document_mirror.text(p->'numeroSerieEquipamento',200),
  'technician',erp_document_mirror.text(coalesce(p#>'{tecnico,nome}',p->'tecnico'),200),'defect',erp_document_mirror.text(p->'descricaoProblema',4000),
  'delivery_terms',erp_document_mirror.text(p->'prazoEntrega',2000),'template',false,
  'discount_mode',null,'discount_value',erp_document_mirror.decimal(coalesce(p#>'{desconto,valor}',p->'desconto'),30,30),
  'freight',freight,'other_expenses',other,'service_total',erp_document_mirror.decimal(p->'totalServicos',30,30),
  'installments',installments,'totals',jsonb_build_object('gross',gross,'discount',null,'freight',freight,'other_expenses',other,'total',total));
 select coalesce(jsonb_agg(distinct x order by x),'[]')into issues from jsonb_array_elements(issues)x;
 return jsonb_build_object('number',number,'total',total,'contact_id',contact,'status',status,'source_status',v_source_status,'source_status_label',label,'body',body,'items',rows,'issues',issues,'capture_hash',capture_hash,
  'contact_snapshot',jsonb_build_object('id',contact,'name',erp_document_mirror.text(party->'nome',200),'document',erp_document_mirror.text(party->'numeroDocumento',30),
   'email',erp_document_mirror.text(party->'email',254),'phone',erp_document_mirror.text(party->'telefone',40),
   'street',erp_document_mirror.text(party#>'{endereco,endereco}',200),'number',erp_document_mirror.text(party#>'{endereco,numero}',30),
   'complement',erp_document_mirror.text(party#>'{endereco,complemento}',200),'district',erp_document_mirror.text(party#>'{endereco,bairro}',100),
   'city',erp_document_mirror.text(party#>'{endereco,municipio}',100),'state',erp_document_mirror.text(party#>'{endereco,uf}',2),'postal_code',erp_document_mirror.text(party#>'{endereco,cep}',20)),
  'reconciliation',jsonb_build_object('source_total',total,'source_products_total',gross,'calculated_total',null,'difference',null,'state','unknown'),
  'effects',jsonb_build_object('stock','unobservable','finance_count',null,'invoice_source_id',erp_documents.origin_import_id(p#>'{notaFiscal,id}')));
end$$;

create function erp_document_mirror.apply(s erp_document_mirror.source_version,p_actor uuid,p_seen timestamptz)returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare m erp_documents.origin_mirror;v jsonb;legacy jsonb;d uuid;before_doc jsonb;before_items jsonb;item jsonb;i uuid;v_code text;prior_setting text;v_plan_hash text;projection integer;
begin
 perform pg_advisory_xact_lock(174852901,hashtext('document_mirror:'||s.entity||':'||s.source_id));
 select *into m from erp_documents.origin_mirror where entity=s.entity and source_id=s.source_id;
 if m.document_id is not null and s.source_version<m.applied_version then return false;end if;
 if s.source_id!~'^[1-9][0-9]{0,39}$'or not isfinite(s.observed_at)then raise exception 'SOURCE_IDENTITY_INVALID'using errcode='22023';end if;
 v:=erp_document_mirror.plan(s);v_plan_hash:=encode(sha256(convert_to(v::text,'UTF8')),'hex');d:=m.document_id;
 if m.document_id is not null and s.source_version=m.applied_version then
  if s.source_hash<>m.applied_hash then return false;end if;
  if v_plan_hash=m.plan_hash then
   update erp_documents.origin_mirror set observed_at=greatest(observed_at,p_seen)where document_id=m.document_id;return false;
  end if;
 end if;
 if d is null then legacy:=erp_document_mirror.legacy_target(s.entity,s.source_id);
  if not(legacy->>'eligible')::boolean then raise exception 'LEGACY_REVIEW_REQUIRED'using errcode='22023';end if;d:=(legacy->>'id')::uuid;
 end if;
 if d is not null then select to_jsonb(x)into before_doc from erp_documents.document x where id=d for update;
  select coalesce(jsonb_agg(to_jsonb(x)order by position),'[]')into before_items from erp_documents.item x where document_id=d;
 end if;
 prior_setting:=current_setting('erp_mirror.writer',true);perform set_config('erp_mirror.writer','document_mirror',true);
 if d is null then
  insert into erp_documents.document(kind,number,status,contact_id,contact_snapshot,body,total,created_by,updated_by,origin,authority)
  values(s.entity,(v->>'number')::bigint,v->>'status',(v->>'contact_id')::uuid,v->'contact_snapshot',v->'body',erp_document_mirror.decimal(v->'total',2,12)::numeric,p_actor,p_actor,'origin','origin')returning id into d;
 else
  update erp_documents.document set number=(v->>'number')::bigint,status=v->>'status',contact_id=(v->>'contact_id')::uuid,
   contact_snapshot=v->'contact_snapshot',body=v->'body',total=erp_document_mirror.decimal(v->'total',2,12)::numeric,version=version+1,updated_by=p_actor,updated_at=clock_timestamp(),origin='origin',authority='origin'where id=d;
 end if;
 delete from erp_documents.item where document_id=d;
 for item in select value from jsonb_array_elements(v->'items')loop
  i:=erp_document_mirror.uuid('document_mirror:'||s.entity||':'||s.source_id||':'||(item->>'position'));item:=item||jsonb_build_object('id',i);
  insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,discount_percent,total,data)
  values(i,d,(item->>'position')::integer,(item->>'product_id')::uuid,nullif(erp_document_mirror.decimal(item->'quantity',6,12),'0')::numeric,
   erp_document_mirror.decimal(item->'unit_price',10,10)::numeric,null,erp_document_mirror.decimal(item->'total',2,16)::numeric,item);
 end loop;
 select version into projection from erp_documents.document where id=d;
 insert into erp_documents.origin_mirror values(s.entity,s.source_id,d,s.source_version,s.source_hash,1,case when v->'issues'='[]'::jsonb then'synced'else'pending'end,
  erp_document_mirror.text(s.payload->'numero',80),v->>'source_status',v->>'source_status_label',greatest(p_seen,m.observed_at),s.source_updated_at,
  coalesce(s.payload#>'{_brufap_source,deleted}'='true'::jsonb,false),v->'issues',v->'reconciliation',v->'effects',v->>'capture_hash',v_plan_hash)
 on conflict(entity,source_id)do update set applied_version=excluded.applied_version,applied_hash=excluded.applied_hash,state=excluded.state,source_number=excluded.source_number,
  source_status=excluded.source_status,source_status_label=excluded.source_status_label,observed_at=excluded.observed_at,source_updated_at=excluded.source_updated_at,
  source_deleted=excluded.source_deleted,issues=excluded.issues,reconciliation=excluded.reconciliation,effects=excluded.effects,capture_hash=excluded.capture_hash,plan_hash=excluded.plan_hash;
 insert into erp_document_mirror.revision values(s.entity,s.source_id,s.source_version,1,d,erp_document_mirror.uuid('document_mirror:'||s.entity||':'||s.source_id||':'||s.source_version||':1:'||projection),
  before_doc,(select to_jsonb(x)from erp_documents.document x where id=d),before_items,(select coalesce(jsonb_agg(to_jsonb(x)order by position),'[]')from erp_documents.item x where document_id=d),s.observed_at,clock_timestamp(),p_actor,projection,v->>'capture_hash');
 update erp_document_mirror.issue x set resolved_at=clock_timestamp()where x.entity=s.entity and x.source_id=s.source_id and x.source_version<=s.source_version and x.code<>'VERSION_HASH_CONFLICT'and x.resolved_at is null;
 for v_code in select jsonb_array_elements_text(v->'issues')loop
  insert into erp_document_mirror.issue(entity,source_id,source_version,code)values(s.entity,s.source_id,s.source_version,v_code)on conflict(entity,source_id,source_version,code)do update set resolved_at=null;
 end loop;
 perform set_config('erp_mirror.writer',coalesce(prior_setting,''),true);return true;
end$$;
alter function erp_document_mirror.apply(erp_document_mirror.source_version,uuid,timestamptz)owner to erp_document_mirror_writer;
revoke create on schema erp_document_mirror from erp_document_mirror_writer;

create function public.erp_document_mirror_project(p_limit integer default 100)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare q record;s origin_sync.raw_record;v erp_document_mirror.source_version;actor uuid;seeded integer:=0;n integer:=0;a integer:=0;failed integer:=0;code text;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'document_mirror_invalid_limit'using errcode='22023';end if;
 select actor_id into actor from erp_document_mirror.settings where singleton;
 if actor is null then return jsonb_build_object('state','actor_not_configured','processed',0,'applied',0,'failed',0,'seeded',0,'pending',(select count(*)from erp_document_mirror.seed)+(select count(*)from erp_document_mirror.pending));end if;
 if not pg_try_advisory_xact_lock(174852901,220006)then return jsonb_build_object('state','busy','processed',0,'applied',0,'failed',0,'seeded',0,'pending',null);end if;
 for q in select *from erp_document_mirror.seed order by entity,source_id limit p_limit loop
  select *into s from origin_sync.raw_record where entity=q.entity and source_id=q.source_id;
  if found then perform erp_document_mirror.capture_row(s);end if;
  delete from erp_document_mirror.seed where entity=q.entity and source_id=q.source_id;seeded:=seeded+1;
 end loop;
 for q in select *from erp_document_mirror.pending where retry_at<=clock_timestamp()order by retry_at,entity,source_id,source_version limit p_limit loop
  n:=n+1;
  begin
   select *into v from erp_document_mirror.source_version where entity=q.entity and source_id=q.source_id and source_version=q.source_version;
   if erp_document_mirror.apply(v,actor,q.seen_at)then a:=a+1;end if;
   delete from erp_document_mirror.pending where entity=q.entity and source_id=q.source_id and source_version=q.source_version;
  exception when others then
   failed:=failed+1;code:=case when sqlerrm in('LEGACY_REVIEW_REQUIRED','SOURCE_IDENTITY_INVALID')then sqlerrm else'PROJECTION_FAILED'end;
   insert into erp_document_mirror.issue(entity,source_id,source_version,code)values(q.entity,q.source_id,q.source_version,code)on conflict do nothing;
   update erp_document_mirror.pending set retry_at=clock_timestamp()+interval '2 minutes',attempts=attempts+1 where entity=q.entity and source_id=q.source_id and source_version=q.source_version;
  end;
 end loop;
 return jsonb_build_object('state','ready','processed',n,'applied',a,'failed',failed,'seeded',seeded,'pending',(select count(*)from erp_document_mirror.seed)+(select count(*)from erp_document_mirror.pending));
end$$;

create function erp_document_mirror.metadata(p_document uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('entity',entity,'source_id',source_id,'source_version',applied_version::text,'source_hash',applied_hash,'mapper_version',mapper_version,
  'source_number',source_number,'source_status',source_status,'source_status_label',source_status_label,'observed_at',observed_at,'source_updated_at',source_updated_at,
  'source_deleted',source_deleted,'state',state,'partial',state<>'synced','issues',issues,'reconciliation',reconciliation,'effects',effects)
 from erp_documents.origin_mirror where document_id=p_document
$$;

insert into erp_document_mirror.seed select entity,source_id from origin_sync.raw_record where entity in('sales_proposals','sales_orders','purchase_orders','service_orders');
do $$declare t text;begin foreach t in array array['settings','source_version','source_dependency','price_observation','pending','seed','issue','revision']loop
 execute format('alter table erp_document_mirror.%I enable row level security',t);
 execute format('create policy document_mirror_writer on erp_document_mirror.%I for all to erp_document_mirror_writer using(true)with check(true)',t);
end loop;end$$;
alter table erp_documents.origin_mirror enable row level security;
alter table erp_documents.origin_status_map enable row level security;
create policy document_mirror_writer on erp_documents.origin_mirror for all to erp_document_mirror_writer using(true)with check(true);
create policy document_mirror_writer on erp_documents.document for all to erp_document_mirror_writer using(true)with check(true);
create policy document_mirror_writer on erp_documents.item for all to erp_document_mirror_writer using(true)with check(true);
revoke all on all tables in schema erp_document_mirror from public,anon,authenticated,service_role;
revoke all on erp_documents.origin_mirror,erp_documents.origin_status_map from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_document_mirror from public,anon,authenticated,service_role;
grant usage on schema erp_document_mirror,erp_documents to erp_document_mirror_writer;
grant select,insert,update,delete on erp_documents.document,erp_documents.item,erp_documents.origin_mirror to erp_document_mirror_writer;
grant select,insert,update on erp_document_mirror.issue to erp_document_mirror_writer;
grant insert on erp_document_mirror.revision to erp_document_mirror_writer;
grant execute on function erp_document_mirror.plan(erp_document_mirror.source_version),erp_document_mirror.legacy_target(text,text),erp_document_mirror.text(jsonb,integer),erp_document_mirror.uuid(text),erp_document_mirror.decimal(jsonb,integer,integer)to erp_document_mirror_writer;
grant execute on function erp_documents.transitions()to erp_document_mirror_writer;
revoke all on function public.erp_document_mirror_project(integer)from public,anon,authenticated;
grant execute on function public.erp_document_mirror_project(integer)to service_role;
commit;
