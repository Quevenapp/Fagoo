-- 213: Remessas e Retornos (CNAB) no padrão Origin (onda D, lane financeiro). As operações bancárias continuam desligadas:
-- nada aqui gera arquivo, transmite ao banco, lê retorno ou baixa conta.
-- * Remessas: listagem com Data, Nome (arquivo), Banco, Nº Remessa, Nro Títulos e Valor Títulos, Pesquisar, período pela data da
--   remessa e Quantidade de remessas do filtro; detalhe com os Títulos da remessa (Cliente, Nro. no Banco, Nro. documento, Emissão,
--   Vencimento, Histórico, Valor), Dados da Conta (Banco, Agência, Conta) e Informações (Número de títulos, Valor total).
--   "Excluir as remessas selecionadas" vale só para a remessa reservada sem arquivo: os títulos ficam livres para outra remessa, a
--   reserva fica guardada em erp_cnab.remittance_exclusion (auditada) e o número volta a ser o próximo quando era o último reservado.
--   Remessa com arquivo não se exclui (o banco pode tê-la registrado).
-- * Retornos: listagem com Data, Nome (arquivo .RET), Banco, Nro Títulos e Valor Títulos, Pesquisar, período e Quantidade de
--   retornos; detalhe com Dados do retorno, Resumo do processamento e as Entradas, Baixas e Outras ocorrências, em páginas.
--   "Excluir selecionados" só tira da listagem o retorno sem ocorrência aplicada (vínculo ou baixa): o arquivo e os eventos ficam
--   como evidência auditada.
-- Leitura: administrador, financeiro e consulta. Exclusões: administrador e financeiro, com comando idempotente e auditoria.
begin;

do $$ begin
  if to_regclass('erp_cnab.operational_settlement') is null or to_regprocedure('erp_cnab.start_command(uuid,uuid,text,jsonb)') is null then
    raise exception 'cnab_lists_213_requires_014_043' using errcode='55000'; end if;
end $$;

create table erp_cnab.remittance_exclusion (
  remittance_id uuid primary key, profile_id uuid not null references erp_cnab.profile(id), sequence bigint not null, generated_on date not null,
  purpose text not null, snapshot jsonb not null, titles jsonb not null, released_sequence boolean not null,
  actor uuid not null references auth.users(id), command_id uuid not null unique, created_at timestamptz not null default clock_timestamp()
);
create table erp_cnab.return_exclusion (
  file_id uuid primary key references erp_cnab.return_file(id), actor uuid not null references auth.users(id), command_id uuid not null unique,
  created_at timestamptz not null default clock_timestamp()
);
alter table erp_cnab.remittance_exclusion enable row level security;
alter table erp_cnab.return_exclusion enable row level security;
revoke all on erp_cnab.remittance_exclusion,erp_cnab.return_exclusion from public,anon,authenticated,service_role;
create function erp_cnab.exclusion_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_cnab_exclusion_immutable' using errcode='42501'; end $$;
create trigger remittance_exclusion_immutable before update or delete on erp_cnab.remittance_exclusion for each row execute function erp_cnab.exclusion_immutable();
create trigger return_exclusion_immutable before update or delete on erp_cnab.return_exclusion for each row execute function erp_cnab.exclusion_immutable();

-- Names of the files as the CNAB screens show them (042/067).
create function erp_cnab.remittance_filename(p_remittance erp_cnab.remittance) returns text language sql immutable set search_path=pg_catalog as $$
  select case when p_remittance.snapshot->'profile'->>'bank'='077' then 'CI400_001_' else 'ITAU_COBRANCA_' end||lpad(p_remittance.sequence::text,7,'0')||'.REM';
$$;
create function erp_cnab.bank_label(p_code text) returns text language sql immutable set search_path=pg_catalog as $$
  select case p_code when '341' then 'Itaú' when '077' then 'Inter' else coalesce(p_code,'') end;
$$;
create function erp_cnab.list_query(p_query text) returns void language plpgsql immutable set search_path=pg_catalog as $$
begin
  if p_query is not null and (length(p_query)>120 or p_query~'[[:cntrl:]]') then raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
end $$;

-- ---------------------------------------------------------------- Remessas
create function public.erp_cnab_remittance_page(p_user_id uuid,p_query text default null,p_from date default null,p_to date default null,p_page integer default 1,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_rows jsonb;
begin
  perform erp_cnab.access(p_user_id);
  perform erp_cnab.list_query(p_query);
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or p_from>p_to
    or (p_from is not null and (p_from<date '1900-01-01' or p_from>date '2100-12-31')) or (p_to is not null and (p_to<date '1900-01-01' or p_to>date '2100-12-31')) then
    raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  with base as materialized (
    select r.*,erp_cnab.remittance_filename(r) filename,p.identity->>'bank' bank,
      (select count(*) from erp_cnab.billing_title b where b.remittance_id=r.id) titles,
      (select coalesce(sum((b.snapshot#>>'{title,amountCents}')::bigint),0) from erp_cnab.billing_title b where b.remittance_id=r.id) total_cents
    from erp_cnab.remittance r join erp_cnab.profile p on p.id=r.profile_id
    where (p_from is null or r.generated_on>=p_from) and (p_to is null or r.generated_on<=p_to)
  ), filtered as materialized (
    select * from base where v_query is null or strpos(lower(filename),v_query)>0 or strpos(sequence::text,ltrim(v_query,'0'))>0 and ltrim(v_query,'0')<>''
  ), page as (select * from filtered order by generated_on desc,sequence desc,id limit p_limit offset (p_page-1)*p_limit)
  select (select count(*) from filtered),(select coalesce(jsonb_agg(jsonb_build_object('id',id,'profile_id',profile_id,'purpose',purpose,'state',state,'sequence',sequence::text,
      'generated_on',generated_on,'created_at',created_at,'filename',filename,'bank',bank,'bank_name',erp_cnab.bank_label(bank),'titles',titles,'total_cents',total_cents::text,
      'file_hash',file_hash,'byte_size',byte_size,'encoding_profile',snapshot->'encoding_profile','excludable',state='reserved' and object_path is null)
      order by generated_on desc,sequence desc,id),'[]'::jsonb) from page)
  into v_total,v_rows;
  return jsonb_build_object('entity','cnab_remittances','page',p_page,'limit',p_limit,'total',v_total,'items',v_rows,'data_mode','erp_native');
end $$;
-- Detalhe da remessa: até 500 títulos (uma remessa operacional tem até 30), com o total de todos.
create function public.erp_cnab_remittance_detail(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare r erp_cnab.remittance; p erp_cnab.profile; v_rows jsonb; v_count bigint; v_total bigint;
begin
  perform erp_cnab.access(p_user_id);
  select * into r from erp_cnab.remittance where id=p_id;
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  select * into p from erp_cnab.profile where id=r.profile_id;
  select count(*),coalesce(sum((b.snapshot#>>'{title,amountCents}')::bigint),0) into v_count,v_total from erp_cnab.billing_title b where b.remittance_id=r.id;
  select coalesce(jsonb_agg(x.item order by x.due_on,x.document_number,x.id),'[]'::jsonb) into v_rows from (
    select b.id,b.document_number,(b.snapshot#>>'{title,dueOn}')::date due_on,jsonb_build_object('billing_title_id',b.id,'title_id',b.title_id,'contact_name',left(coalesce(b.snapshot#>>'{title,payer,name}',c.name),200),
      'our_number',b.our_number,'document_number',b.document_number,'issued_on',b.snapshot#>>'{title,issuedOn}','due_on',b.snapshot#>>'{title,dueOn}','description',t.description,
      'amount_cents',b.snapshot#>>'{title,amountCents}') item
    from erp_cnab.billing_title b join erp_finance.title t on t.id=b.title_id join erp_catalog.record c on c.id=t.contact_id where b.remittance_id=r.id
    order by (b.snapshot#>>'{title,dueOn}')::date,b.document_number,b.id limit 500) x;
  return jsonb_build_object('entity','cnab_remittance','record',jsonb_build_object('id',r.id,'profile_id',r.profile_id,'purpose',r.purpose,'state',r.state,'sequence',r.sequence::text,
      'generated_on',r.generated_on,'created_at',r.created_at,'filename',erp_cnab.remittance_filename(r),'file_hash',r.file_hash,'byte_size',r.byte_size,'encoding_profile',r.snapshot->'encoding_profile',
      'bank',p.identity->>'bank','bank_name',erp_cnab.bank_label(p.identity->>'bank'),'excludable',r.state='reserved' and r.object_path is null),
    'account',jsonb_build_object('bank',p.identity->>'bank','bank_name',erp_cnab.bank_label(p.identity->>'bank'),'agency',p.identity->>'agency','account',p.identity->>'account',
      'account_digit',p.identity->>'accountDigit','wallet',p.identity->>'wallet','name',(select a.name from erp_finance.account a where a.id=p.account_id)),
    'titles',v_rows,'titles_total',v_count,'total_cents',v_total::text,'data_mode','erp_native');
end $$;
-- "Excluir as remessas selecionadas": one reservation without file per command; the titles leave the remessa.
create function public.erp_cnab_remittance_exclude(p_user_id uuid,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_replay jsonb; r erp_cnab.remittance; p erp_cnab.profile; v_titles jsonb; v_released boolean:=false; v_result jsonb; v_hash text;
begin
  perform erp_cnab.access(p_user_id,true);
  if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  perform erp_finance.keys(p_data,array['id','sequence']);
  v_replay:=erp_cnab.start_command(p_user_id,p_command_id,'remittance_exclude',p_data);
  if v_replay is not null then return v_replay; end if;
  select * into r from erp_cnab.remittance where id=erp_finance.uuid_value(p_data->'id') for update;
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  if jsonb_typeof(p_data->'sequence') is distinct from 'string' or p_data->>'sequence'<>r.sequence::text then raise exception 'erp_cnab_version_conflict' using errcode='40001'; end if;
  if r.state<>'reserved' or r.object_path is not null or r.file_hash is not null then raise exception 'erp_cnab_remittance_has_file' using errcode='40001'; end if;
  select * into p from erp_cnab.profile where id=r.profile_id for update;
  if exists(select 1 from erp_cnab.return_event e join erp_cnab.billing_title b on b.id=e.billing_title_id where b.remittance_id=r.id) then
    raise exception 'erp_cnab_remittance_in_use' using errcode='40001'; end if;
  select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]'::jsonb) into v_titles from erp_cnab.billing_title b where b.remittance_id=r.id;
  delete from erp_cnab.billing_title where remittance_id=r.id;
  delete from erp_cnab.remittance where id=r.id;
  -- The reserved number comes back only when it is the last one handed out (a file was never generated with it).
  if p.next_sequence=r.sequence+1 and not exists(select 1 from erp_cnab.remittance x where x.profile_id=p.id and x.sequence>=r.sequence) then
    update erp_cnab.profile set next_sequence=r.sequence,version=version+1,updated_at=clock_timestamp() where id=p.id; v_released:=true;
  end if;
  insert into erp_cnab.remittance_exclusion(remittance_id,profile_id,sequence,generated_on,purpose,snapshot,titles,released_sequence,actor,command_id)
    values(r.id,r.profile_id,r.sequence,r.generated_on,r.purpose,r.snapshot,v_titles,v_released,p_user_id,p_command_id);
  perform erp_cnab.access(p_user_id,true);
  v_result:=jsonb_build_object('entity','cnab_remittance_exclusion','record',jsonb_build_object('id',r.id,'sequence',r.sequence::text,'titles',jsonb_array_length(v_titles),'released_sequence',v_released),
    'data_mode','erp_native','replayed',false);
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','remittance_exclude','data',p_data)::text,'UTF8')),'hex');
  insert into erp_cnab.command values(p_command_id,p_user_id,v_hash,v_result,clock_timestamp());
  insert into erp_cnab.audit(actor,command_id,action,record_id) values(p_user_id,p_command_id,'remittance_exclude',r.id);
  return v_result;
end $$;

-- ---------------------------------------------------------------- Retornos
-- Groups of the Origin detail: Entradas (entrada confirmada), Baixas (liquidações) and Outras ocorrências.
create function erp_cnab.return_group(p_kind text) returns text language sql immutable set search_path=pg_catalog as $$
  select case when p_kind='REGISTERED' then 'entries' when p_kind in ('PAID','PARTIAL_PAYMENT','NOTARY_PAYMENT','CLOSED_AFTER_PAYMENT') then 'settlements' else 'others' end;
$$;
create function erp_cnab.return_applied(p_file uuid) returns boolean language sql stable set search_path=pg_catalog as $$
  select exists(select 1 from erp_cnab.return_occurrence o join erp_cnab.operational_binding b on b.event_id=o.event_id where o.file_id=p_file)
    or exists(select 1 from erp_cnab.return_occurrence o join erp_cnab.operational_settlement s on s.event_id=o.event_id where o.file_id=p_file)
    or exists(select 1 from erp_cnab.return_occurrence o join erp_cnab.human_review h on h.event_id=o.event_id where o.file_id=p_file);
$$;
create function public.erp_cnab_return_page(p_user_id uuid,p_query text default null,p_from date default null,p_to date default null,p_page integer default 1,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_rows jsonb;
begin
  perform erp_cnab.access(p_user_id);
  perform erp_cnab.list_query(p_query);
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or p_from>p_to
    or (p_from is not null and (p_from<date '1900-01-01' or p_from>date '2100-12-31')) or (p_to is not null and (p_to<date '1900-01-01' or p_to>date '2100-12-31')) then
    raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  with base as materialized (
    select f.*,'RETORNO_'||f.id::text||'.RET' filename,p.identity->>'bank' bank from erp_cnab.return_file f join erp_cnab.profile p on p.id=f.profile_id
    where not exists(select 1 from erp_cnab.return_exclusion x where x.file_id=f.id)
      and (p_from is null or f.generated_on>=p_from) and (p_to is null or f.generated_on<=p_to)
  ), filtered as materialized (select * from base where v_query is null or strpos(lower(filename),v_query)>0 or strpos(file_hash,v_query)=1),
  page as (select * from filtered order by generated_on desc,created_at desc,id limit p_limit offset (p_page-1)*p_limit)
  select (select count(*) from filtered),(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'profile_id',p.profile_id,'purpose',p.purpose,'generated_on',p.generated_on,'created_at',p.created_at,
      'filename',p.filename,'bank',p.bank,'bank_name',erp_cnab.bank_label(p.bank),'titles',p.record_count-2,
      'total_cents',(select coalesce(sum((e.payload->>'amountCents')::bigint),0) from erp_cnab.return_occurrence o join erp_cnab.return_event e on e.id=o.event_id where o.file_id=p.id)::text,
      'excludable',not erp_cnab.return_applied(p.id)) order by p.generated_on desc,p.created_at desc,p.id),'[]'::jsonb) from page p)
  into v_total,v_rows;
  return jsonb_build_object('entity','cnab_returns','page',p_page,'limit',p_limit,'total',v_total,'items',v_rows,'data_mode','erp_native');
end $$;
-- Detalhe do retorno: Dados, Resumo do processamento (todo o arquivo) e uma página (até 100) de um dos grupos.
create function public.erp_cnab_return_detail(p_user_id uuid,p_id uuid,p_group text default 'settlements',p_page integer default 1,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare f erp_cnab.return_file; p erp_cnab.profile; v_summary jsonb; v_rows jsonb; v_total bigint;
begin
  perform erp_cnab.access(p_user_id);
  if p_group is null or p_group not in ('entries','settlements','others') or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  select * into f from erp_cnab.return_file where id=p_id and not exists(select 1 from erp_cnab.return_exclusion x where x.file_id=p_id);
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  select * into p from erp_cnab.profile where id=f.profile_id;
  with ev as materialized (
    select o.line,o.duplicate,e.id event_id,e.payload,erp_cnab.return_group(e.payload->>'kind') grp,coalesce((e.payload->>'amountCents')::bigint,0) amount,coalesce((e.payload->>'paidCents')::bigint,0) paid,
      coalesce((e.payload#>>'{adjustments,fee}')::bigint,0) fee,coalesce((e.payload#>>'{adjustments,interest}')::bigint,0) interest,coalesce((e.payload#>>'{adjustments,discount}')::bigint,0) discount
    from erp_cnab.return_occurrence o join erp_cnab.return_event e on e.id=o.event_id where o.file_id=f.id)
  select jsonb_build_object('titles',count(*),'amount_cents',coalesce(sum(amount),0)::text,'amount_with_additions_cents',coalesce(sum(amount+interest),0)::text,
      'entries',count(*) filter (where grp='entries'),'entries_cents',coalesce(sum(amount) filter (where grp='entries'),0)::text,
      'settlements',count(*) filter (where grp='settlements'),'settlements_cents',coalesce(sum(paid) filter (where grp='settlements'),0)::text,
      'others',count(*) filter (where grp='others'),'interest_cents',coalesce(sum(interest),0)::text,'discount_cents',coalesce(sum(discount),0)::text,'fee_cents',coalesce(sum(fee),0)::text),
    count(*) filter (where grp=p_group),
    (select coalesce(jsonb_agg(x.item order by x.line),'[]'::jsonb) from (select v.line,jsonb_build_object('line',v.line,'event_id',v.event_id,'duplicate',v.duplicate,'kind',v.payload->>'kind','occurrence',v.payload->>'occurrence',
        'document_number',v.payload->>'documentNumber','our_number',v.payload->>'ourNumber','occurrence_date',v.payload->>'occurrenceDate','credit_date',v.payload->>'creditDate','due_date',v.payload->>'dueDate',
        'contact_name',(select left(coalesce(b.snapshot#>>'{title,payer,name}',''),200) from erp_cnab.return_event e2 join erp_cnab.billing_title b on b.id=e2.billing_title_id where e2.id=v.event_id),
        'fee_cents',v.fee::text,'interest_cents',v.interest::text,'amount_cents',v.amount::text,'paid_cents',v.paid::text) item
      from ev v where v.grp=p_group order by v.line limit p_limit offset (p_page-1)*p_limit) x)
  into v_summary,v_total,v_rows from ev;
  return jsonb_build_object('entity','cnab_return','record',jsonb_build_object('id',f.id,'profile_id',f.profile_id,'purpose',f.purpose,'generated_on',f.generated_on,'created_at',f.created_at,
      'filename','RETORNO_'||f.id::text||'.RET','bank',p.identity->>'bank','bank_name',erp_cnab.bank_label(p.identity->>'bank'),'excludable',not erp_cnab.return_applied(f.id)),
    'summary',v_summary,'group',p_group,'page',p_page,'limit',p_limit,'total',v_total,'items',v_rows,'data_mode','erp_native');
end $$;
-- "Excluir selecionados": the retorno leaves the listagem; its file and events stay as audited evidence.
create function public.erp_cnab_return_exclude(p_user_id uuid,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_replay jsonb; f erp_cnab.return_file; v_result jsonb; v_hash text;
begin
  perform erp_cnab.access(p_user_id,true);
  if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  perform erp_finance.keys(p_data,array['id']);
  v_replay:=erp_cnab.start_command(p_user_id,p_command_id,'return_exclude',p_data);
  if v_replay is not null then return v_replay; end if;
  select * into f from erp_cnab.return_file where id=erp_finance.uuid_value(p_data->'id') for share;
  if not found or exists(select 1 from erp_cnab.return_exclusion x where x.file_id=f.id) then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cnab-return:'||f.id::text,0));
  if erp_cnab.return_applied(f.id) then raise exception 'erp_cnab_return_applied' using errcode='40001'; end if;
  insert into erp_cnab.return_exclusion(file_id,actor,command_id) values(f.id,p_user_id,p_command_id);
  perform erp_cnab.access(p_user_id,true);
  v_result:=jsonb_build_object('entity','cnab_return_exclusion','record',jsonb_build_object('id',f.id,'excluded',true),'data_mode','erp_native','replayed',false);
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','return_exclude','data',p_data)::text,'UTF8')),'hex');
  insert into erp_cnab.command values(p_command_id,p_user_id,v_hash,v_result,clock_timestamp());
  insert into erp_cnab.audit(actor,command_id,action,record_id) values(p_user_id,p_command_id,'return_exclude',f.id);
  return v_result;
end $$;

revoke all on function erp_cnab.exclusion_immutable(),erp_cnab.remittance_filename(erp_cnab.remittance),erp_cnab.bank_label(text),erp_cnab.list_query(text),
  erp_cnab.return_group(text),erp_cnab.return_applied(uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_cnab_remittance_page(uuid,text,date,date,integer,integer)','erp_cnab_remittance_detail(uuid,uuid)','erp_cnab_remittance_exclude(uuid,uuid,jsonb)',
    'erp_cnab_return_page(uuid,text,date,date,integer,integer)','erp_cnab_return_detail(uuid,uuid,text,integer,integer)','erp_cnab_return_exclude(uuid,uuid,jsonb)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
