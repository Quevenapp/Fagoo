-- Cadastros > Contas Financeiras e Categorias Financeiras no padrão Origin.
-- Contas: tipo de conta do Origin (corrente, poupança, caixa, recebimento, outros, integração), instituição, agência,
-- conta e DV, data de início dos lançamentos, saldo inicial no próprio cadastro, conta padrão de movimentações e de
-- boletos, inativar e excluir (lógico). O tipo antigo (bank, cash, other) continua sendo a regra de CNAB e dos leitores
-- existentes; o tipo do Origin é derivado dele para os escritores antigos.
-- Categorias: árvore Receitas | Despesas com subcategorias, grupo de DRE, categorias padrão (Categorização para DRE e
-- padrões de venda, serviço, transferência recebida e compra), mover lançamentos entre categorias, importar e excluir
-- (lógico). As categorias "Receitas e despesas" (both) são divididas em duas, uma por tipo.
-- Nenhum banco é chamado, nenhum valor muda: só cadastro e classificação. Centavos continuam inteiros exatos.
begin;

-- ---------------------------------------------------------------- Contas financeiras
alter table erp_finance.account
  add column account_type text,
  add column institution_code text,
  add column institution_name text,
  add column agency text,
  add column account_number text,
  add column account_digit text,
  add column start_on date,
  add column default_movements boolean not null default false,
  add column default_boleto boolean not null default false,
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users(id);

-- Contas existentes: corrente para "bank"; o início dos lançamentos é a data do saldo inicial, quando houver.
update erp_finance.account a set account_type=case a.kind when 'bank' then 'checking' when 'cash' then 'cash' else 'other' end,
  start_on=(select m.posted_on from erp_finance.movement m where m.account_id=a.id and m.kind='opening');

-- Escritores antigos (010 account_save) informam só o tipo antigo: o tipo do Origin acompanha.
create function erp_finance.account_defaults()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='INSERT' then
    new.account_type:=coalesce(new.account_type,case new.kind when 'bank' then 'checking' when 'cash' then 'cash' else 'other' end);
  elsif new.kind is distinct from old.kind and new.account_type is not distinct from old.account_type then
    new.account_type:=case new.kind when 'bank' then 'checking' when 'cash' then 'cash' else 'other' end;
  end if;
  if tg_op='UPDATE' and old.deleted_at is not null then raise exception 'erp_finance_deleted_account' using errcode='40001'; end if;
  return new;
end $$;
create trigger account_defaults before insert or update on erp_finance.account for each row execute function erp_finance.account_defaults();

alter table erp_finance.account
  alter column account_type set not null,
  add constraint account_type_check check(account_type in ('checking','savings','cash','receiving','other','integration')),
  add constraint account_type_kind check((account_type in ('checking','savings') and kind='bank') or (account_type='cash' and kind='cash')
    or (account_type in ('receiving','other','integration') and kind='other')),
  add constraint account_institution_check check((institution_code is null and institution_name is null)
    or (institution_code~'^[0-9]{3}$' and length(institution_name) between 1 and 80 and institution_name=btrim(institution_name) and institution_name!~'[[:cntrl:]]')),
  add constraint account_bank_data_check check((agency is null or agency~'^[0-9A-Za-z-]{1,10}$') and (account_number is null or account_number~'^[0-9A-Za-z.-]{1,20}$')
    and (account_digit is null or account_digit~'^[0-9A-Za-z]{1,2}$')),
  add constraint account_start_range check(start_on is null or start_on between date '1900-01-01' and date '2100-12-31'),
  add constraint account_deleted_check check((deleted_at is null and deleted_by is null) or (deleted_at is not null and deleted_by is not null and not active and not default_movements and not default_boleto)),
  add constraint account_defaults_active check(active or (not default_movements and not default_boleto)),
  add constraint account_boleto_bank check(not default_boleto or kind='bank');
create unique index erp_finance_account_default_movements on erp_finance.account((true)) where default_movements;
create unique index erp_finance_account_default_boleto on erp_finance.account((true)) where default_boleto;

-- Data de início dos lançamentos: nenhum movimento (baixa, transferência, retorno, lançamento) antes dela.
create function erp_finance.movement_account_start()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if exists(select 1 from erp_finance.account a where a.id=new.account_id and a.start_on is not null and new.posted_on<a.start_on) then
    raise exception 'erp_finance_before_account_start' using errcode='22023'; end if;
  return new;
end $$;
create trigger movement_account_start before insert on erp_finance.movement for each row execute function erp_finance.movement_account_start();

-- Categoria do lançamento de caixa (lançamentos avulsos, transferências e ajustes, 136). Baixas usam a do borderô.
alter table erp_finance.movement add column category_id uuid references erp_finance.category(id);
create index erp_finance_movement_category on erp_finance.movement(category_id) where category_id is not null;

-- ---------------------------------------------------------------- Categorias financeiras (árvore)
alter table erp_finance.category
  add column parent_id uuid references erp_finance.category(id),
  add column dre_group text,
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users(id);
create index erp_finance_category_parent on erp_finance.category(parent_id) where parent_id is not null;
create index erp_finance_title_category on erp_finance.title(category_id) where category_id is not null;
create index erp_finance_bordero_category on erp_finance.bordero(category_id) where category_id is not null;
create index erp_finance_bordero_item_category on erp_finance.bordero_item(category_id) where category_id is not null;

-- Divisão das categorias "both": a original fica com o tipo de maior vínculo imutável (tarifa de retorno = despesa) e
-- a gêmea, com o mesmo nome e situação, recebe as contas e borderôs do outro tipo. O registro fica em category_split.
create table erp_finance.category_split (
  original_id uuid primary key references erp_finance.category(id), twin_id uuid not null unique references erp_finance.category(id),
  original_kind text not null, twin_kind text not null, titles integer not null, borderos integer not null, created_at timestamptz not null default clock_timestamp()
);
alter table erp_finance.category_split enable row level security;
revoke all on erp_finance.category_split from public,anon,authenticated,service_role;

-- Reclassificação (mover categorias, alterar categorias): só a categoria muda; valores, datas e contas continuam imutáveis.
create or replace function erp_finance.bordero_immutable()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='DELETE' then raise exception 'erp_finance_bordero_immutable' using errcode='55000'; end if;
  if current_setting('erp_finance.reclassify',true)='on' and (to_jsonb(new)-'category_id')=(to_jsonb(old)-'category_id') then return new; end if;
  if tg_table_name='bordero_item' then raise exception 'erp_finance_bordero_immutable' using errcode='55000'; end if;
  if old.deleted_at is not null or (new.id,new.kind,new.posted_on,new.account_id,new.category_id,new.note,new.grouped,new.actor,new.command_id,new.created_at)
    is distinct from (old.id,old.kind,old.posted_on,old.account_id,old.category_id,old.note,old.grouped,old.actor,old.command_id,old.created_at) then
    raise exception 'erp_finance_bordero_immutable' using errcode='55000'; end if;
  return new;
end $$;
create or replace function erp_finance.transfer_immutable()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='UPDATE' and tg_table_name='movement' and current_setting('erp_finance.reclassify',true)='on'
    and (to_jsonb(new)-'category_id')=(to_jsonb(old)-'category_id') then return new; end if;
  raise exception 'erp_finance_transfer_immutable' using errcode='55000';
end $$;

do $$
declare c erp_finance.category%rowtype; v_keep text; v_other text; v_twin uuid; v_titles integer; v_borderos integer;
begin
  perform set_config('erp_finance.reclassify','on',true);
  alter table erp_finance.title disable trigger title_history_guard;
  for c in select * from erp_finance.category where kind='both' order by id loop
    v_keep:=case when exists(select 1 from erp_finance.cnab_cash_plan p where p.category_id=c.id) then 'payable' else 'receivable' end;
    v_other:=case when v_keep='receivable' then 'payable' else 'receivable' end;
    insert into erp_finance.category(name,kind,active,created_at,updated_at) values(c.name,v_other,c.active,c.created_at,clock_timestamp()) returning id into v_twin;
    update erp_finance.category set kind=v_keep,version=version+1,updated_at=clock_timestamp() where id=c.id;
    update erp_finance.title set category_id=v_twin,version=version+1,updated_at=clock_timestamp() where category_id=c.id and kind=v_other;
    get diagnostics v_titles=row_count;
    update erp_finance.bordero set category_id=v_twin where category_id=c.id and kind=v_other;
    get diagnostics v_borderos=row_count;
    update erp_finance.bordero_item i set category_id=v_twin from erp_finance.settlement s join erp_finance.title t on t.id=s.title_id
      where i.settlement_id=s.id and i.category_id=c.id and t.kind=v_other;
    insert into erp_finance.category_split(original_id,twin_id,original_kind,twin_kind,titles,borderos) values(c.id,v_twin,v_keep,v_other,v_titles,v_borderos);
  end loop;
  alter table erp_finance.title enable trigger title_history_guard;
  perform set_config('erp_finance.reclassify','',true);
end $$;

alter table erp_finance.category
  add constraint category_kind_split check(kind in ('receivable','payable')),
  add constraint category_dre_check check(dre_group is null or (parent_id is null and ((kind='receivable' and dre_group in ('none','gross_revenue','financial_revenue','other_revenue'))
    or (kind='payable' and dre_group in ('none','revenue_deductions','operating_expenses','financial_expenses','other_expenses','income_taxes'))))),
  add constraint category_deleted_check check((deleted_at is null and deleted_by is null) or (deleted_at is not null and deleted_by is not null and not active)),
  add constraint category_parent_self check(parent_id is distinct from id);

-- Árvore: pai do mesmo tipo e não excluído; receitas com 2 níveis (categoria > subcategoria), despesas com 3.
-- O pai não muda e o tipo só muda em categoria sem pai e sem filhos (escritor 010).
create function erp_finance.category_depth(p_id uuid)
returns integer language sql stable set search_path=pg_catalog as $$
  with recursive up as (select id,parent_id,1 depth from erp_finance.category where id=p_id
    union all select c.id,c.parent_id,up.depth+1 from erp_finance.category c join up on c.id=up.parent_id where up.depth<10)
  select max(depth) from up;
$$;
create function erp_finance.category_tree_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare p erp_finance.category%rowtype;
begin
  if tg_op='UPDATE' then
    if new.parent_id is distinct from old.parent_id then raise exception 'erp_finance_category_parent_locked' using errcode='40001'; end if;
    -- The 010 writer may still change the tipo: never of a category in a tree, in use (contas, borderôs, lançamentos,
    -- tarifas) or chosen as a default of the other tipo.
    if new.kind<>old.kind and (new.parent_id is not null or exists(select 1 from erp_finance.category where parent_id=new.id)
      or erp_finance.category_in_use(new.id) or exists(select 1 from erp_finance.category_default where category_id=new.id)) then
      raise exception 'erp_finance_category_in_use' using errcode='40001'; end if;
    if old.deleted_at is not null then raise exception 'erp_finance_deleted_category' using errcode='40001'; end if;
  end if;
  if new.parent_id is not null then
    select * into p from erp_finance.category where id=new.parent_id;
    if not found or p.kind<>new.kind or p.deleted_at is not null then raise exception 'erp_finance_invalid_parent' using errcode='22023'; end if;
    if erp_finance.category_depth(new.parent_id)+1>(case when new.kind='payable' then 3 else 2 end) then raise exception 'erp_finance_category_depth' using errcode='22023'; end if;
  end if;
  return new;
end $$;
create trigger category_tree_guard before insert or update on erp_finance.category for each row execute function erp_finance.category_tree_guard();

-- Categorias padrão: Categorização para DRE (valores adicionais das baixas) e padrões de venda, serviço,
-- transferência recebida e compra. Uma categoria por chave, do tipo da chave.
create table erp_finance.category_default (
  key text primary key check(key in ('receipt_additions','receipt_interest','receipt_discounts','receipt_fees','payment_additions','payment_interest','payment_discounts',
    'sale','service','transfer_in','purchase')),
  category_id uuid references erp_finance.category(id),
  version integer not null default 1 check(version>0),
  actor uuid references auth.users(id), updated_at timestamptz not null default clock_timestamp()
);
insert into erp_finance.category_default(key) select unnest(array['receipt_additions','receipt_interest','receipt_discounts','receipt_fees','payment_additions','payment_interest','payment_discounts','sale','service','transfer_in','purchase']);
alter table erp_finance.category_default enable row level security;
revoke all on erp_finance.category_default from public,anon,authenticated,service_role;
create function erp_finance.category_default_kind(p_key text)
returns text language sql immutable set search_path=pg_catalog as $$
  select case when p_key in ('receipt_additions','receipt_interest','payment_discounts','sale','service','transfer_in') then 'receivable'
    when p_key in ('receipt_discounts','receipt_fees','payment_additions','payment_interest','purchase') then 'payable' end;
$$;

-- As listagens por cursor (010) deixam de mostrar contas e categorias excluídas.
create or replace function public.erp_finance_list(p_user_id uuid,p_entity text,p_limit integer default 25,p_after uuid default null,
  p_query text default null,p_status text default null,p_kind text default null,p_from date default null,p_to date default null,p_parent_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_more boolean;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_entity is null or p_entity not in ('accounts','categories','titles','settlements','movements') or p_limit is null or p_limit not between 1 and 100
    or length(p_query)>120 or (p_status is not null and p_status not in ('open','partial','paid','cancelled','overdue'))
    or (p_kind is not null and p_kind not in ('receivable','payable','both','bank','cash','other','payment','reversal','opening'))
    or (p_from is not null and (not isfinite(p_from) or p_from<date '1900-01-01' or p_from>date '2100-12-31'))
    or (p_to is not null and (not isfinite(p_to) or p_to<date '1900-01-01' or p_to>date '2100-12-31')) or p_from>p_to
    or (p_entity in ('settlements','movements') and p_parent_id is null) then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  with ids as (
    select id from erp_finance.account where p_entity='accounts' and deleted_at is null
    union all select id from erp_finance.category where p_entity='categories' and deleted_at is null
    union all select id from erp_finance.title where p_entity='titles'
    union all select id from erp_finance.settlement where p_entity='settlements' and title_id=p_parent_id
    union all select id from erp_finance.movement where p_entity='movements' and account_id=p_parent_id
  ), items as materialized (select id,erp_finance.dto(p_entity,id) item from ids where p_after is null or id>p_after), page as (
    select id,item from items where (nullif(btrim(p_query),'') is null or strpos(lower(concat_ws(' ',item->>'name',item->>'description',item->>'contact_name',item->>'source_reference')),lower(btrim(p_query)))>0)
      and (p_status is null or item->>'status'=p_status or (p_status='overdue' and item->>'overdue'='true'))
      and (p_kind is null or item->>'kind'=p_kind)
      and (p_from is null or coalesce(item->>'due_on',item->>'posted_on')>=p_from::text)
      and (p_to is null or coalesce(item->>'due_on',item->>'posted_on')<=p_to::text)
    order by id limit p_limit+1
  ) select coalesce(jsonb_agg(item order by id),'[]'::jsonb),count(*)>p_limit into v_items,v_more from page;
  if v_more then v_items:=v_items-p_limit; end if;
  return jsonb_build_object('entity',p_entity,'items',v_items,'limit',p_limit,'has_more',v_more,
    'next_cursor',case when v_more then v_items->(p_limit-1)->>'id' end,'data_mode','erp_native');
end $$;

-- ---------------------------------------------------------------- Leitura das contas financeiras
create function erp_finance.account_view(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',a.id,'name',a.name,'kind',a.kind,'account_type',a.account_type,'institution_code',a.institution_code,'institution_name',a.institution_name,
    'agency',a.agency,'account_number',a.account_number,'account_digit',a.account_digit,'start_on',a.start_on,'active',a.active,
    'default_movements',a.default_movements,'default_boleto',a.default_boleto,
    'boleto',case when a.default_boleto then 'default' when p.id is not null then 'active' else 'none' end,
    'opening_recorded',a.opening_recorded,'opening_cents',(select m.delta_cents::text from erp_finance.movement m where m.account_id=a.id and m.kind='opening'),
    'balance_cents',coalesce((select sum(m.delta_cents) from erp_finance.movement m where m.account_id=a.id),0)::text,
    'first_movement_on',(select min(m.posted_on) from erp_finance.movement m where m.account_id=a.id),
    'in_use',exists(select 1 from erp_finance.movement m where m.account_id=a.id) or exists(select 1 from erp_finance.title t where t.account_id=a.id)
      or p.id is not null or exists(select 1 from erp_finance.bordero b where b.account_id=a.id),
    'cnab',case when p.id is null then null else jsonb_build_object('bank',p.identity->>'bank','agency',p.identity->>'agency','account',p.identity->>'account','account_digit',p.identity->>'accountDigit') end,
    'version',a.version,'created_at',a.created_at,'updated_at',a.updated_at)
  from erp_finance.account a left join erp_cnab.profile p on p.account_id=a.id where a.id=p_id and a.deleted_at is null;
$$;

-- Cadastros > Contas Financeiras: página numerada com total, Situação (Todos | Ativo | Inativo) e Tipo de Conta (vários).
create function public.erp_finance_account_page(p_user_id uuid,p_page integer default 1,p_limit integer default 100,p_query text default null,
  p_active boolean default null,p_types text[] default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_items jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]'
    or (p_types is not null and (array_ndims(p_types) is distinct from 1 or cardinality(p_types) not between 1 and 6 or array_position(p_types,null) is not null
      or (select count(distinct t) from unnest(p_types) t)<>cardinality(p_types)
      or exists(select 1 from unnest(p_types) t where t not in ('checking','savings','cash','receiving','other','integration')))) then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  with filtered as materialized (
    select a.id,a.name from erp_finance.account a where a.deleted_at is null and (p_active is null or a.active=p_active)
      and (p_types is null or a.account_type=any(p_types))
      and (v_query is null or strpos(lower(concat_ws(' ',a.name,a.institution_name,a.institution_code,a.agency,a.account_number)),v_query)>0)
  ) select (select count(*) from filtered),
      (select coalesce(jsonb_agg(erp_finance.account_view(id) order by lower(name),id),'[]'::jsonb)
        from (select id,name from filtered order by lower(name),id limit p_limit offset (p_page-1)*p_limit) page)
    into v_total,v_items;
  return jsonb_build_object('entity','financial_accounts','items',v_items,'page',p_page,'limit',p_limit,'total',v_total,'data_mode','erp_native');
end $$;

create function public.erp_finance_account_detail(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_id is null then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  v:=erp_finance.account_view(p_id);
  if v is null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity','financial_accounts','record',v,'data_mode','erp_native');
end $$;

create function erp_finance.account_text(p_data jsonb,p_key text,p_pattern text)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
  v:=erp_finance.txt(p_data,p_key,80);
  if v is not null and v!~p_pattern then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
  return v;
end $$;

-- Gravação do cadastro de contas: incluir (com o saldo inicial na data de início), atualizar, inativar, padrões e excluir.
create function public.erp_finance_account_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_account erp_finance.account%rowtype; v_result jsonb; v_before jsonb; v_id uuid;
  v_type text; v_kind text; v_name text; v_code text; v_institution text; v_agency text; v_number text; v_digit text; v_start date; v_opening bigint;
  v_default boolean; v_first date; v_profile jsonb; v_target text; v_value boolean;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('account_create','account_update','account_set_active','account_set_default','account_delete') then
    raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>16384 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;
  -- One default account at a time: every writer of the flags takes this lock first.
  perform pg_advisory_xact_lock(hashtextextended('erp_finance.account_defaults',0));

  if p_action in ('account_create','account_update') then
    if p_action='account_create' then
      perform erp_finance.keys(p_data,array['account_type','institution_code','institution_name','name','agency','account_number','account_digit','start_on','opening_cents','default_movements']);
    else
      perform erp_finance.keys(p_data,array['id','expected_version','account_type','institution_code','institution_name','name','agency','account_number','account_digit','start_on','opening_cents','default_movements','default_boleto']);
      v_id:=erp_finance.uuid_value(p_data->'id');
      select * into v_account from erp_finance.account where id=v_id for update;
      if not found or v_account.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      if v_account.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      v_before:=erp_finance.account_view(v_id);
    end if;
    v_type:=erp_finance.txt(p_data,'account_type',20,true);
    if v_type not in ('checking','savings','cash','receiving','other') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    v_kind:=case when v_type in ('checking','savings') then 'bank' when v_type='cash' then 'cash' else 'other' end;
    v_code:=erp_finance.account_text(p_data,'institution_code','^[0-9]{3}$'); v_institution:=erp_finance.txt(p_data,'institution_name',80);
    if v_type in ('checking','savings','receiving') and (v_code is null or v_institution is null) then raise exception 'erp_finance_institution_required' using errcode='22023'; end if;
    if v_type in ('cash','other') then v_code:=null; v_institution:=null; end if;
    if (v_code is null)<>(v_institution is null) or v_institution~'[[:cntrl:]]' then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
    v_agency:=erp_finance.account_text(p_data,'agency','^[0-9A-Za-z-]{1,10}$'); v_number:=erp_finance.account_text(p_data,'account_number','^[0-9A-Za-z.-]{1,20}$');
    v_digit:=erp_finance.account_text(p_data,'account_digit','^[0-9A-Za-z]{1,2}$');
    if v_kind='bank' and (v_agency is null or v_number is null or v_digit is null) then raise exception 'erp_finance_bank_data_required' using errcode='22023'; end if;
    if v_kind<>'bank' then v_agency:=null; v_number:=null; v_digit:=null; end if;
    v_name:=erp_finance.txt(p_data,'name',200,true);
    -- Origin: Descrição com até 50 caracteres; nomes antigos mais longos só mudam quando editados.
    if length(v_name)>50 and (p_action='account_create' or v_name is distinct from v_account.name) then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
    v_start:=erp_finance.day(p_data->'start_on',true);
    if jsonb_typeof(coalesce(p_data->'default_movements','false'::jsonb))<>'boolean' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    v_default:=coalesce((p_data->>'default_movements')::boolean,false);
    if p_action='account_create' then
      if not p_data?'opening_cents' then raise exception 'erp_finance_invalid_cents' using errcode='22023'; end if;
      v_opening:=erp_finance.cents(p_data->'opening_cents',true,true);
      if v_default then update erp_finance.account set default_movements=false,version=version+1,updated_at=clock_timestamp() where default_movements; end if;
      insert into erp_finance.account(name,kind,account_type,institution_code,institution_name,agency,account_number,account_digit,start_on,opening_recorded,default_movements)
        values(v_name,v_kind,v_type,v_code,v_institution,v_agency,v_number,v_digit,v_start,true,v_default) returning id into v_id;
      insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id) values(v_id,'opening',v_opening,v_start,'Saldo inicial',p_user_id,p_command_id);
    else
      select jsonb_build_object('agency',p.identity->>'agency','account',p.identity->>'account','digit',p.identity->>'accountDigit') into v_profile from erp_cnab.profile p where p.account_id=v_id;
      if v_profile is not null and (v_kind<>'bank' or v_agency is distinct from v_profile->>'agency' or v_number is distinct from v_profile->>'account' or v_digit is distinct from v_profile->>'digit') then
        raise exception 'erp_finance_account_profile_mismatch' using errcode='22023'; end if;
      -- "Tornar padrão de emissão de boletos": só conta bancária com cobrança (perfil CNAB) configurada.
      if jsonb_typeof(coalesce(p_data->'default_boleto',to_jsonb(v_account.default_boleto)))<>'boolean' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      v_value:=coalesce((p_data->>'default_boleto')::boolean,v_account.default_boleto);
      if v_value and (v_kind<>'bank' or v_profile is null or not v_account.active) then raise exception 'erp_finance_boleto_profile_required' using errcode='22023'; end if;
      if v_value and not v_account.default_boleto then update erp_finance.account set default_boleto=false,version=version+1,updated_at=clock_timestamp() where default_boleto and id<>v_id; end if;
      select min(posted_on) into v_first from erp_finance.movement where account_id=v_id;
      if v_first is not null and v_start>v_first then raise exception 'erp_finance_start_after_movement' using errcode='22023'; end if;
      if p_data?'opening_cents' then
        if v_account.opening_recorded or not v_account.active then raise exception 'erp_finance_opening_conflict' using errcode='40001'; end if;
        v_opening:=erp_finance.cents(p_data->'opening_cents',true,true);
      end if;
      if v_default and not v_account.default_movements then
        if not v_account.active then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
        update erp_finance.account set default_movements=false,version=version+1,updated_at=clock_timestamp() where default_movements and id<>v_id;
      end if;
      update erp_finance.account set name=v_name,kind=v_kind,account_type=v_type,institution_code=v_code,institution_name=v_institution,agency=v_agency,account_number=v_number,
        account_digit=v_digit,start_on=v_start,default_movements=v_default,default_boleto=v_value,opening_recorded=opening_recorded or v_opening is not null,version=version+1,updated_at=clock_timestamp() where id=v_id;
      if v_opening is not null then
        insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id) values(v_id,'opening',v_opening,v_start,'Saldo inicial',p_user_id,p_command_id);
      end if;
    end if;

  else
    perform erp_finance.keys(p_data,case p_action when 'account_set_active' then array['id','expected_version','active'] when 'account_set_default' then array['id','expected_version','target','value']
      else array['id','expected_version'] end);
    v_id:=erp_finance.uuid_value(p_data->'id');
    select * into v_account from erp_finance.account where id=v_id for update;
    if not found or v_account.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_account.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    v_before:=erp_finance.account_view(v_id);
    if p_action='account_set_active' then
      if jsonb_typeof(p_data->'active') is distinct from 'boolean' then raise exception 'erp_finance_invalid_active' using errcode='22023'; end if;
      v_value:=(p_data->>'active')::boolean;
      if v_value=v_account.active then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      -- Inativar tira a conta dos padrões, como no Origin (uma conta inativa não recebe movimentações nem boletos).
      update erp_finance.account set active=v_value,default_movements=default_movements and v_value,default_boleto=default_boleto and v_value,
        version=version+1,updated_at=clock_timestamp() where id=v_id;
    elsif p_action='account_set_default' then
      v_target:=erp_finance.txt(p_data,'target',20,true);
      if v_target not in ('movements','boleto') or jsonb_typeof(p_data->'value') is distinct from 'boolean' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      v_value:=(p_data->>'value')::boolean;
      if v_value and not v_account.active then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
      if v_target='boleto' and v_value and (v_account.kind<>'bank' or not exists(select 1 from erp_cnab.profile where account_id=v_id)) then
        raise exception 'erp_finance_boleto_profile_required' using errcode='22023'; end if;
      if v_value=(case v_target when 'movements' then v_account.default_movements else v_account.default_boleto end) then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      if v_value then
        if v_target='movements' then update erp_finance.account set default_movements=false,version=version+1,updated_at=clock_timestamp() where default_movements and id<>v_id;
        else update erp_finance.account set default_boleto=false,version=version+1,updated_at=clock_timestamp() where default_boleto and id<>v_id; end if;
      end if;
      update erp_finance.account set default_movements=case when v_target='movements' then v_value else default_movements end,
        default_boleto=case when v_target='boleto' then v_value else default_boleto end,version=version+1,updated_at=clock_timestamp() where id=v_id;
    else
      -- Excluir: só conta sem movimentos, contas a receber ou pagar, cobrança e borderôs. O cadastro e a auditoria ficam.
      if (v_before->>'in_use')::boolean or exists(select 1 from erp_finance.transfer where from_account_id=v_id or to_account_id=v_id) then
        raise exception 'erp_finance_account_in_use' using errcode='40001'; end if;
      update erp_finance.account set active=false,default_movements=false,default_boleto=false,deleted_at=clock_timestamp(),deleted_by=p_user_id,
        version=version+1,updated_at=clock_timestamp() where id=v_id;
    end if;
  end if;

  perform erp_finance.require_access(p_user_id,true);
  v_result:=jsonb_build_object('entity','financial_accounts','record',case when p_action='account_delete' then jsonb_build_object('id',v_id,'deleted',true) else erp_finance.account_view(v_id) end,
    'action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------- Leitura e gravação das categorias
create function erp_finance.category_subtree(p_id uuid)
returns table(id uuid) language sql stable set search_path=pg_catalog as $$
  with recursive down as (select c.id from erp_finance.category c where c.id=p_id
    union all select c.id from erp_finance.category c join down on c.parent_id=down.id where c.deleted_at is null)
  select id from down;
$$;
create function erp_finance.category_in_use(p_id uuid)
returns boolean language sql stable set search_path=pg_catalog as $$
  select exists(select 1 from erp_finance.title where category_id=p_id) or exists(select 1 from erp_finance.bordero where category_id=p_id)
    or exists(select 1 from erp_finance.bordero_item where category_id=p_id) or exists(select 1 from erp_finance.movement where category_id=p_id)
    or exists(select 1 from erp_finance.cnab_cash_plan where category_id=p_id);
$$;
create function erp_finance.category_view(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',c.id,'parent_id',c.parent_id,'name',c.name,'kind',c.kind,'dre_group',c.dre_group,'active',c.active,'depth',erp_finance.category_depth(c.id),
    'defaults',(select coalesce(jsonb_agg(d.key order by d.key),'[]'::jsonb) from erp_finance.category_default d where d.category_id=c.id),
    'children',(select count(*) from erp_finance.category x where x.parent_id=c.id and x.deleted_at is null),'in_use',erp_finance.category_in_use(c.id),
    'version',c.version,'updated_at',c.updated_at)
  from erp_finance.category c where c.id=p_id and c.deleted_at is null;
$$;

-- Árvore de uma aba (Receitas ou Despesas) e as categorias padrão das duas abas.
create function public.erp_finance_category_tree(p_user_id uuid,p_kind text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_count bigint;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_kind is null or p_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  select count(*) into v_count from erp_finance.category where kind=p_kind and deleted_at is null;
  if v_count>2000 then raise exception 'erp_finance_category_limit' using errcode='54000'; end if;
  select coalesce(jsonb_agg(erp_finance.category_view(id) order by lower(name),id),'[]'::jsonb) into v_items from erp_finance.category where kind=p_kind and deleted_at is null;
  return jsonb_build_object('entity','category_tree','kind',p_kind,'items',v_items,
    'defaults',(select jsonb_object_agg(d.key,jsonb_build_object('category_id',d.category_id,'version',d.version)) from erp_finance.category_default d),'data_mode','erp_native');
end $$;

create function erp_finance.category_name(p_data jsonb,p_key text)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
  v:=erp_finance.txt(p_data,p_key,100,true);
  if v~'[[:cntrl:]]' then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
  return v;
end $$;
create function erp_finance.category_dre(p_value jsonb,p_kind text,p_top boolean)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
  if p_value is null or p_value='null'::jsonb then return null; end if;
  if not p_top or jsonb_typeof(p_value)<>'string' then raise exception 'erp_finance_invalid_dre_group' using errcode='22023'; end if;
  v:=p_value#>>'{}';
  if not ((p_kind='receivable' and v in ('none','gross_revenue','financial_revenue','other_revenue'))
    or (p_kind='payable' and v in ('none','revenue_deductions','operating_expenses','financial_expenses','other_expenses','income_taxes'))) then
    raise exception 'erp_finance_invalid_dre_group' using errcode='22023'; end if;
  return v;
end $$;
create function erp_finance.category_siorigin_taken(p_kind text,p_parent uuid,p_name text,p_except uuid)
returns boolean language sql stable set search_path=pg_catalog as $$
  select exists(select 1 from erp_finance.category where kind=p_kind and parent_id is not distinct from p_parent and deleted_at is null
    and lower(name)=lower(p_name) and id is distinct from p_except);
$$;

create function public.erp_finance_category_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_category erp_finance.category%rowtype; v_target erp_finance.category%rowtype; v_result jsonb; v_before jsonb;
  v_id uuid; v_parent uuid; v_kind text; v_name text; v_dre text; v_active boolean; v_key text; v_row jsonb; v_index integer:=0; v_created jsonb:='[]'::jsonb; v_skipped integer:=0;
  v_ids uuid[]; v_titles integer:=0; v_borderos integer:=0; v_items integer:=0; v_movements integer:=0; v_matches integer; v_default erp_finance.category_default%rowtype;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('category_create','category_update','category_set_active','category_delete','category_move','category_set_default','category_import') then
    raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>131072 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;
  -- The tree changes one writer at a time (names among siorigins, subtrees, moves).
  perform pg_advisory_xact_lock(hashtextextended('erp_finance.category_tree',0));

  if p_action='category_create' then
    perform erp_finance.keys(p_data,array['kind','parent_id','name','dre_group']);
    v_kind:=erp_finance.txt(p_data,'kind',20,true);
    if v_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    v_parent:=erp_finance.uuid_value(p_data->'parent_id',false); v_name:=erp_finance.category_name(p_data,'name');
    v_dre:=erp_finance.category_dre(p_data->'dre_group',v_kind,v_parent is null);
    if v_parent is not null then
      select * into v_target from erp_finance.category where id=v_parent for update;
      if not found or v_target.deleted_at is not null or v_target.kind<>v_kind then raise exception 'erp_finance_invalid_parent' using errcode='22023'; end if;
      if not v_target.active then raise exception 'erp_finance_category_parent_inactive' using errcode='40001'; end if;
    end if;
    if erp_finance.category_siorigin_taken(v_kind,v_parent,v_name,null) then raise exception 'erp_finance_category_duplicate' using errcode='23505'; end if;
    insert into erp_finance.category(name,kind,parent_id,dre_group) values(v_name,v_kind,v_parent,v_dre) returning id into v_id;
    v_result:=jsonb_build_object('record',erp_finance.category_view(v_id));

  elsif p_action in ('category_update','category_set_active','category_delete') then
    perform erp_finance.keys(p_data,case p_action when 'category_update' then array['id','expected_version','name','dre_group'] when 'category_set_active' then array['id','expected_version','active']
      else array['id','expected_version'] end);
    v_id:=erp_finance.uuid_value(p_data->'id');
    select * into v_category from erp_finance.category where id=v_id for update;
    if not found or v_category.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_category.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    v_before:=erp_finance.category_view(v_id);
    if p_action='category_update' then
      v_name:=erp_finance.category_name(p_data,'name');
      v_dre:=case when p_data?'dre_group' then erp_finance.category_dre(p_data->'dre_group',v_category.kind,v_category.parent_id is null) else v_category.dre_group end;
      if erp_finance.category_siorigin_taken(v_category.kind,v_category.parent_id,v_name,v_id) then raise exception 'erp_finance_category_duplicate' using errcode='23505'; end if;
      update erp_finance.category set name=v_name,dre_group=v_dre,version=version+1,updated_at=clock_timestamp() where id=v_id;
      v_result:=jsonb_build_object('record',erp_finance.category_view(v_id));
    elsif p_action='category_set_active' then
      if jsonb_typeof(p_data->'active') is distinct from 'boolean' then raise exception 'erp_finance_invalid_active' using errcode='22023'; end if;
      v_active:=(p_data->>'active')::boolean;
      if v_active=v_category.active then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      if v_active then
        if v_category.parent_id is not null and not exists(select 1 from erp_finance.category where id=v_category.parent_id and active) then
          raise exception 'erp_finance_category_parent_inactive' using errcode='40001'; end if;
        update erp_finance.category set active=true,version=version+1,updated_at=clock_timestamp() where id=v_id;
      else
        -- Inativar a categoria inativa também as subcategorias, que não podem ficar ativas sob ela.
        select array_agg(id order by id) into v_ids from erp_finance.category_subtree(v_id);
        perform 1 from erp_finance.category where id=any(v_ids) order by id for update;
        update erp_finance.category set active=false,version=version+1,updated_at=clock_timestamp() where id=any(v_ids) and active;
      end if;
      v_result:=jsonb_build_object('record',erp_finance.category_view(v_id));
    else
      -- Excluir só categoria sem subcategorias e sem lançamentos; com uso, o Origin oferece inativar.
      if exists(select 1 from erp_finance.category where parent_id=v_id and deleted_at is null) or erp_finance.category_in_use(v_id)
        or exists(select 1 from erp_finance.category_default where category_id=v_id) then raise exception 'erp_finance_category_in_use' using errcode='40001'; end if;
      update erp_finance.category set active=false,deleted_at=clock_timestamp(),deleted_by=p_user_id,version=version+1,updated_at=clock_timestamp() where id=v_id;
      v_result:=jsonb_build_object('record',jsonb_build_object('id',v_id,'deleted',true));
    end if;

  elsif p_action='category_move' then
    -- Mover categorias: todos os lançamentos da categoria e das subcategorias passam para a categoria de destino.
    perform erp_finance.keys(p_data,array['id','expected_version','target_id','confirmed']);
    if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'erp_finance_move_unconfirmed' using errcode='22023'; end if;
    v_id:=erp_finance.uuid_value(p_data->'id'); v_parent:=erp_finance.uuid_value(p_data->'target_id');
    select * into v_category from erp_finance.category where id=v_id for update;
    if not found or v_category.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_category.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    select * into v_target from erp_finance.category where id=v_parent for share;
    if not found or v_target.deleted_at is not null or not v_target.active or v_target.kind<>v_category.kind then raise exception 'erp_finance_invalid_category' using errcode='22023'; end if;
    select array_agg(id order by id) into v_ids from erp_finance.category_subtree(v_id);
    if v_parent=any(v_ids) then raise exception 'erp_finance_invalid_category' using errcode='22023'; end if;
    v_before:=erp_finance.category_view(v_id);
    perform set_config('erp_finance.reclassify','on',true);
    -- Contas excluídas ficam como estão (são histórico fechado); as demais mudam de versão, como numa edição.
    update erp_finance.title set category_id=v_parent,version=version+1,updated_at=clock_timestamp() where category_id=any(v_ids) and deleted_at is null;
    get diagnostics v_titles=row_count;
    update erp_finance.bordero set category_id=v_parent where category_id=any(v_ids);
    get diagnostics v_borderos=row_count;
    update erp_finance.bordero_item set category_id=v_parent where category_id=any(v_ids);
    get diagnostics v_items=row_count;
    update erp_finance.movement set category_id=v_parent where category_id=any(v_ids);
    get diagnostics v_movements=row_count;
    perform set_config('erp_finance.reclassify','',true);
    v_result:=jsonb_build_object('record',erp_finance.category_view(v_id),'target',erp_finance.category_view(v_parent),
      'moved',jsonb_build_object('titles',v_titles,'borderos',v_borderos,'settlements',v_items,'movements',v_movements));

  elsif p_action='category_set_default' then
    perform erp_finance.keys(p_data,array['key','category_id','expected_version']);
    v_key:=erp_finance.txt(p_data,'key',40,true);
    select * into v_default from erp_finance.category_default where key=v_key for update;
    if not found then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    if v_default.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    v_id:=erp_finance.uuid_value(p_data->'category_id',false);
    if v_id is not null then
      select * into v_category from erp_finance.category where id=v_id for share;
      if not found or v_category.deleted_at is not null or not v_category.active or v_category.kind<>erp_finance.category_default_kind(v_key) then
        raise exception 'erp_finance_invalid_category' using errcode='22023'; end if;
    end if;
    v_before:=jsonb_build_object('key',v_key,'category_id',v_default.category_id,'version',v_default.version);
    update erp_finance.category_default set category_id=v_id,version=version+1,actor=p_user_id,updated_at=clock_timestamp() where key=v_key;
    v_result:=jsonb_build_object('record',jsonb_build_object('key',v_key,'category_id',v_id,'version',v_default.version+1));

  else
    -- Importar categorias: pais antes dos filhos (pelo nome do pai na mesma aba); nomes que já existem no mesmo nível ficam.
    perform erp_finance.keys(p_data,array['kind','rows']);
    v_kind:=erp_finance.txt(p_data,'kind',20,true);
    if v_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    if jsonb_typeof(p_data->'rows') is distinct from 'array' or jsonb_array_length(p_data->'rows') not between 1 and 500 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
    for v_row in select value from jsonb_array_elements(p_data->'rows') loop
      v_index:=v_index+1;
      perform erp_finance.keys(v_row,array['name','parent','dre_group']);
      v_name:=erp_finance.category_name(v_row,'name'); v_parent:=null;
      if v_row?'parent' and v_row->'parent'<>'null'::jsonb then
        select count(*),min(id::text)::uuid into v_matches,v_parent from erp_finance.category
          where kind=v_kind and deleted_at is null and lower(name)=lower(erp_finance.category_name(v_row,'parent'));
        if v_matches<>1 then raise exception 'erp_finance_import_parent' using errcode='22023'; end if;
        -- As in "Nova categoria": a subcategoria is never created active under an inactive parent.
        if not exists(select 1 from erp_finance.category where id=v_parent and active) then raise exception 'erp_finance_category_parent_inactive' using errcode='40001'; end if;
      end if;
      if erp_finance.category_siorigin_taken(v_kind,v_parent,v_name,null) then v_skipped:=v_skipped+1; continue; end if;
      insert into erp_finance.category(name,kind,parent_id,dre_group) values(v_name,v_kind,v_parent,erp_finance.category_dre(v_row->'dre_group',v_kind,v_parent is null)) returning id into v_id;
      v_created:=v_created||jsonb_build_array(v_id);
    end loop;
    v_result:=jsonb_build_object('created',v_created,'skipped',v_skipped);
  end if;

  perform erp_finance.require_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('entity','categories_tree','action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

revoke all on function erp_finance.account_defaults(),erp_finance.movement_account_start(),erp_finance.category_depth(uuid),erp_finance.category_tree_guard(),
  erp_finance.category_default_kind(text),erp_finance.account_view(uuid),erp_finance.account_text(jsonb,text,text),erp_finance.category_subtree(uuid),
  erp_finance.category_in_use(uuid),erp_finance.category_view(uuid),erp_finance.category_name(jsonb,text),erp_finance.category_dre(jsonb,text,boolean),
  erp_finance.category_siorigin_taken(text,uuid,text,uuid),erp_finance.bordero_immutable(),erp_finance.transfer_immutable() from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_list(uuid,text,integer,uuid,text,text,text,date,date,uuid),public.erp_finance_account_page(uuid,integer,integer,text,boolean,text[]),
  public.erp_finance_account_detail(uuid,uuid),public.erp_finance_account_execute(uuid,uuid,text,jsonb),public.erp_finance_category_tree(uuid,text),
  public.erp_finance_category_execute(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.erp_finance_list(uuid,text,integer,uuid,text,text,text,date,date,uuid),public.erp_finance_account_page(uuid,integer,integer,text,boolean,text[]),
  public.erp_finance_account_detail(uuid,uuid),public.erp_finance_account_execute(uuid,uuid,text,jsonb),public.erp_finance_category_tree(uuid,text),
  public.erp_finance_category_execute(uuid,uuid,text,jsonb) to service_role;
commit;
