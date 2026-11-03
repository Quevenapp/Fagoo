-- Fila de eventos fiscais das notas próprias do Brufap, só no ambiente 2 (homologação):
-- cancelamento (110111), carta de correção (110110, só NF-e) e inutilização de numeração.
-- Registrar um pedido o coloca como "Aguardando transmissão". A transmissão à SEFAZ ainda não existe no Brufap:
-- nenhuma função aqui transmite, muda a situação da nota, reserva número ou altera as travas 022/041/046/064.
begin;
create table erp_fiscal_invoices.event_request(
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in('cancel','correction','inutilization')),
 invoice_id uuid references erp_fiscal_invoices.invoice(id),
 model text not null check(model in('55','65')),environment text not null check(environment='2'),
 series integer not null check(series between 0 and 999),
 number_from integer not null check(number_from between 1 and 999999999),number_to integer not null check(number_to between 1 and 999999999),
 sequence integer check(sequence between 1 and 20),
 text text not null check(length(text) between 15 and 1000 and text=btrim(text)),
 state text not null default 'pending' check(state in('pending')),
 requested_by uuid not null references auth.users(id),requested_at timestamptz not null default clock_timestamp(),
 command_id uuid not null unique references erp_fiscal_invoices.command(command_id) deferrable initially deferred,
 check((kind='inutilization')=(invoice_id is null)),
 check((kind='correction')=(sequence is not null)),check(kind<>'correction' or model='55'),
 check(kind='correction' or length(text)<=255),
 check(number_from<=number_to and number_to-number_from<10000),
 check(kind='inutilization' or number_from=number_to)
);
create unique index erp_fiscal_event_one_cancel on erp_fiscal_invoices.event_request(invoice_id) where kind='cancel';
create unique index erp_fiscal_event_correction_sequence on erp_fiscal_invoices.event_request(invoice_id,sequence) where kind='correction';
create index erp_fiscal_event_kind on erp_fiscal_invoices.event_request(kind,requested_at desc,id);
alter table erp_fiscal_invoices.event_request enable row level security;
revoke all on erp_fiscal_invoices.event_request from public,anon,authenticated,service_role;
-- Requests are history: the future transmitter records its outcome elsewhere, never by rewriting a request.
create trigger immutable_event_request before update or delete on erp_fiscal_invoices.event_request for each row execute function erp_fiscal_invoices.immutable_history();

create function erp_fiscal_invoices.event_record(e erp_fiscal_invoices.event_request) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',e.id,'kind',e.kind,'invoice_id',e.invoice_id,'model',e.model,'environment',e.environment,'series',e.series,
  'number_from',e.number_from,'number_to',e.number_to,'sequence',e.sequence,'text',e.text,'state',e.state,'protocol',null,'requested_at',e.requested_at,
  'access_key',(select v.access_key from erp_fiscal_invoices.invoice v where v.id=e.invoice_id))
$$;
create function public.erp_fiscal_event_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;keys text[];v erp_fiscal_invoices.invoice%rowtype;e erp_fiscal_invoices.event_request%rowtype;txt text;model text;series integer;
 n_from integer;n_to integer;seq integer;result jsonb;expected integer;used boolean;
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_action is null or p_action not in('cancel','correction','inutilization') or p_data is null or jsonb_typeof(p_data)<>'object' then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 keys:=case p_action when 'cancel' then array['invoice_id','expected_version','justification'] when 'correction' then array['invoice_id','expected_version','correction']
  else array['model','series','number_from','number_to','justification'] end;
 if exists(select 1 from jsonb_object_keys(p_data) k where not k=any(keys)) or not p_data ?& keys then raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 txt:=erp_fiscal_invoices.text_input(p_data->(case p_action when 'correction' then 'correction' else 'justification' end),case p_action when 'correction' then 1000 else 255 end,true,p_action='correction');
 if length(txt)<15 then raise exception 'erp_fiscal_event_text_too_short' using errcode='22023'; end if;
 if p_action='inutilization' then
  model:=p_data->>'model';
  if jsonb_typeof(p_data->'model') is distinct from 'string' or model not in('55','65') or jsonb_typeof(p_data->'series') is distinct from 'string' or p_data->>'series'!~'^(0|[1-9][0-9]{0,2})$'
   or jsonb_typeof(p_data->'number_from') is distinct from 'string' or p_data->>'number_from'!~'^[1-9][0-9]{0,8}$'
   or jsonb_typeof(p_data->'number_to') is distinct from 'string' or p_data->>'number_to'!~'^[1-9][0-9]{0,8}$' then raise exception 'erp_fiscal_event_range_invalid' using errcode='22023'; end if;
  series:=(p_data->>'series')::integer;n_from:=(p_data->>'number_from')::integer;n_to:=(p_data->>'number_to')::integer;
  if n_from>n_to or n_to-n_from>=10000 then raise exception 'erp_fiscal_event_range_invalid' using errcode='22023'; end if;
 else
  expected:=erp_fiscal_invoices.version_input(p_data->'expected_version');
 end if;
 h:=erp_fiscal_invoices.command_hash(p_user_id,'event',p_action,p_data);
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'event',h);
 if replay is not null then return replay; end if;
 if p_action='inutilization' then
  perform pg_advisory_xact_lock(174852942,hashtext(model||':'||series));
  -- A number already reserved by the emitter or carried by a Brufap note cannot be voided.
  if to_regclass('erp_fiscal_numbering.reservation') is not null then
   execute 'select exists(select 1 from erp_fiscal_numbering.reservation where model=$1 and environment=''2'' and series=$2 and number between $3 and $4)' into used using model,series,n_from,n_to;
   if used then raise exception 'erp_fiscal_event_number_used' using errcode='40001'; end if;
  end if;
  if exists(select 1 from erp_fiscal_invoices.invoice i where i.model=p_data->>'model' and i.environment='2' and i.series=(p_data->>'series')::integer and i.number between n_from and n_to) then
   raise exception 'erp_fiscal_event_number_used' using errcode='40001'; end if;
  if exists(select 1 from erp_fiscal_invoices.event_request r where r.kind='inutilization' and r.model=p_data->>'model' and r.series=(p_data->>'series')::integer
   and int4range(r.number_from,r.number_to,'[]') && int4range(n_from,n_to,'[]')) then raise exception 'erp_fiscal_event_range_overlap' using errcode='40001'; end if;
  insert into erp_fiscal_invoices.event_request(kind,model,environment,series,number_from,number_to,text,requested_by,command_id)
  values('inutilization',model,'2',series,n_from,n_to,txt,p_user_id,p_command_id) returning * into e;
 else
  select * into v from erp_fiscal_invoices.invoice where id=erp_fiscal_invoices.uuid_input(p_data->'invoice_id') for update;
  if not found then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
  if v.version<>expected or v.deleted_at is not null then raise exception 'erp_fiscal_invoice_version_conflict' using errcode='40001'; end if;
  -- Only an authorized homologation note of Brufap: Origin notes are cancelled or corrected in Origin during coexistence.
  if v.environment is distinct from '2' or v.status not in(6,7) or v.access_key is null or v.protocol is null or v.number is null then
   raise exception 'erp_fiscal_event_not_allowed' using errcode='40001'; end if;
  if p_action='cancel' then
   if exists(select 1 from erp_fiscal_invoices.event_request where invoice_id=v.id and kind='cancel') then raise exception 'erp_fiscal_event_already_requested' using errcode='40001'; end if;
  else
   if v.model<>'55' then raise exception 'erp_fiscal_event_not_allowed' using errcode='40001'; end if;
   select coalesce(max(sequence),0)+1 into seq from erp_fiscal_invoices.event_request where invoice_id=v.id and kind='correction';
   if seq>20 then raise exception 'erp_fiscal_event_sequence_exhausted' using errcode='40001'; end if;
  end if;
  insert into erp_fiscal_invoices.event_request(kind,invoice_id,model,environment,series,number_from,number_to,sequence,text,requested_by,command_id)
  values(p_action,v.id,v.model,'2',v.series,v.number,v.number,seq,txt,p_user_id,p_command_id) returning * into e;
 end if;
 result:=jsonb_build_object('event',erp_fiscal_invoices.event_record(e),'action',p_action,'replayed',false,'transmission_enabled',false,'data_mode','erp_native_homologation');
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'event',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action) values(p_user_id,p_command_id,'event',e.id,null,p_action);
 return result;
end $$;
create function public.erp_fiscal_event_list(p_user_id uuid,p_kind text,p_query text default null,p_date_from date default null,p_date_to date default null,
 p_page integer default 1,p_limit integer default 100) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare q text:=nullif(btrim(p_query),'');result jsonb;
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_kind is null or p_kind not in('cancel','correction','inutilization') or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
  or length(p_query)>120 or p_query~'[[:cntrl:]]' or (p_date_from is not null and p_date_to is not null and p_date_from>p_date_to) then
  raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 with rows as materialized(
  select e.* from erp_fiscal_invoices.event_request e
  where e.kind=p_kind and (p_date_from is null or (e.requested_at at time zone 'America/Sao_Paulo')::date>=p_date_from)
   and (p_date_to is null or (e.requested_at at time zone 'America/Sao_Paulo')::date<=p_date_to)
   and (q is null or strpos(lower(e.text),lower(q))>0 or (q~'^[0-9]{1,9}$' and q::integer between e.number_from and e.number_to) or e.series::text=q)
 ),page as(select r.*,row_number() over(order by r.requested_at desc,r.id desc) ord from rows r)
 select jsonb_build_object('items',coalesce((select jsonb_agg(erp_fiscal_invoices.event_record(row(p.id,p.kind,p.invoice_id,p.model,p.environment,p.series,p.number_from,p.number_to,
   p.sequence,p.text,p.state,p.requested_by,p.requested_at,p.command_id)::erp_fiscal_invoices.event_request) order by p.ord) from page p
   where p.ord>(p_page-1)::bigint*p_limit and p.ord<=p_page::bigint*p_limit),'[]'::jsonb),
  'kind',p_kind,'page',p_page,'limit',p_limit,'total_count',(select count(*)::integer from rows),'transmission_enabled',false,'data_mode','erp_native_homologation') into result;
 return result;
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_event_execute(uuid,uuid,text,jsonb),public.erp_fiscal_event_list(uuid,text,text,date,date,integer,integer) from public,anon,authenticated;
grant execute on function public.erp_fiscal_event_execute(uuid,uuid,text,jsonb),public.erp_fiscal_event_list(uuid,text,text,date,date,integer,integer) to service_role;
commit;
