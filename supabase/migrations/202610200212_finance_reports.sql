-- 212: Relatórios financeiros e "Desfazer vínculo" da conciliação (onda D, lane financeiro).
-- * Financeiro > Ver relatórios financeiros: Fluxo de caixa realizado (entradas, saídas e o saldo de cada dia ou mês),
--   Fluxo de caixa previsto (contas em aberto por vencimento sobre o saldo atual, com as atrasadas à parte), Receitas e despesas
--   por categoria (as baixas com a Categorização para DRE gravada em cada baixa, 210, e os lançamentos de caixa) e
--   Recebimentos e pagamentos por cliente/fornecedor. Somente leitura, por período de até um ano por dia ou dez anos por mês,
--   numa conta financeira ou em todas, com páginas de até 100 linhas para que toda resposta caiba no limite da API.
-- * Conciliação bancária, "Desfazer vínculo": a sugestão de uma linha pendente do extrato é descartada (fica registrada, com
--   comando idempotente e auditoria) e a próxima sugestão, se houver, aparece no lugar.
-- Nada é escrito nas contas, baixas, movimentos ou lançamentos. Requer 110, 136, 137, 172 e 210.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$ declare r record; begin
  for r in select * from (values
    ('erp_finance.bank_line_dto(uuid,boolean)','0972e7b477bc85c54a5e15f423d4a96190e66973aeab3e0e0047be405a266e33')) v(sig,expected) loop
    if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
      raise exception 'finance_reports_212_previous_definition_changed' using errcode='55000',detail=r.sig; end if;
  end loop;
  if to_regclass('erp_finance.settlement_category') is null then raise exception 'finance_reports_212_requires_210' using errcode='55000'; end if;
end $$;

-- ---------------------------------------------------------------- Conciliação: Desfazer vínculo
create table erp_finance.bank_line_dismissal (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references erp_finance.bank_statement_line(id),
  target_kind text not null check(target_kind in ('entry','movement')),
  target_id uuid not null,
  actor uuid not null references auth.users(id), command_id uuid not null unique,
  created_at timestamptz not null default clock_timestamp(),
  unique(line_id,target_kind,target_id)
);
alter table erp_finance.bank_line_dismissal enable row level security;
revoke all on erp_finance.bank_line_dismissal from public,anon,authenticated,service_role;
create function erp_finance.bank_line_dismissal_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_finance_dismissal_immutable' using errcode='42501'; end $$;
create trigger bank_line_dismissal_immutable before update or delete on erp_finance.bank_line_dismissal for each row execute function erp_finance.bank_line_dismissal_immutable();

-- 137 plus: a sugestão descartada ("Desfazer vínculo") is never suggested again for that line.
CREATE OR REPLACE FUNCTION erp_finance.bank_line_dto(p_id uuid, p_suggest boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare b erp_finance.bank_statement_line%rowtype; v_links jsonb; v_suggestion jsonb;
begin
  select * into b from erp_finance.bank_statement_line where id=p_id;
  select coalesce(jsonb_agg(erp_finance.reconciliation_link_dto(k) order by k.created_at),'[]'::jsonb) into v_links from erp_finance.reconciliation_link k where k.line_id=p_id and k.undone_at is null;
  -- Sugestão: the unlinked lançamento of the same account and value closest in date (up to 3 days), except the dismissed ones (212).
  if p_suggest and b.state='pending' then
    select jsonb_build_object('kind',case when l.line_kind='entry' then 'entry' else 'movement' end,'id',case when l.line_kind='entry' then l.entry_id else l.line_id end,'line_kind',l.line_kind,
      'posted_on',l.posted_on,'amount_cents',l.amount_cents::text,'note',l.note,'contact_name',(select name from erp_catalog.record where id=l.contact_id)) into v_suggestion
    from erp_finance.statement_lines(b.account_id,b.posted_on-3,b.posted_on+3,false) l
    where l.line_kind in ('entry','transfer','settlement') and l.amount_cents=b.amount_cents and not erp_finance.line_reconciled(l.line_kind,l.line_id)
      and (l.line_kind<>'settlement' or exists(select 1 from erp_finance.movement m where m.id=l.line_id and m.kind in ('payment','bank_fee') and not exists(select 1 from erp_finance.settlement x where x.reverses_id=m.settlement_id)))
      and not exists(select 1 from erp_finance.bank_line_dismissal d where d.line_id=b.id and d.target_kind=case when l.line_kind='entry' then 'entry' else 'movement' end
        and d.target_id=case when l.line_kind='entry' then l.entry_id else l.line_id end)
    order by abs(l.posted_on-b.posted_on),l.created_at,l.line_id limit 1;
  end if;
  return jsonb_build_object('id',b.id,'statement_id',b.statement_id,'account_id',b.account_id,'fitid',b.fitid,'posted_on',b.posted_on,'amount_cents',b.amount_cents::text,'memo',b.memo,'trntype',b.trntype,
    'state',b.state,'version',b.version,'links',v_links,'suggestion',v_suggestion);
end $function$;

-- "Desfazer vínculo": only the current sugestão of a pending line, with the version the user saw.
create function public.erp_finance_reconciliation_dismiss(p_user_id uuid,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_finance.command%rowtype; v_line erp_finance.bank_statement_line%rowtype; v_before jsonb; v_suggestion jsonb; v_kind text; v_target uuid; v_result jsonb;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>4096 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  perform erp_finance.keys(p_data,array['line_id','expected_version','target']);
  if jsonb_typeof(p_data->'target') is distinct from 'object' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  perform erp_finance.keys(p_data->'target',array['kind','id']);
  v_kind:=erp_finance.txt(p_data->'target','kind',10,true); v_target:=erp_finance.uuid_value(p_data->'target'->'id');
  if v_kind not in ('entry','movement') then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','line_dismiss','data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;
  select * into v_line from erp_finance.bank_statement_line where id=erp_finance.uuid_value(p_data->'line_id') and deleted_at is null for update;
  if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  if v_line.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
  if v_line.state<>'pending' then raise exception 'erp_finance_line_not_pending' using errcode='40001'; end if;
  v_before:=erp_finance.bank_line_dto(v_line.id,true); v_suggestion:=v_before->'suggestion';
  if v_suggestion is null or jsonb_typeof(v_suggestion)<>'object' or v_suggestion->>'kind'<>v_kind or (v_suggestion->>'id')::uuid<>v_target then
    raise exception 'erp_finance_suggestion_changed' using errcode='40001'; end if;
  insert into erp_finance.bank_line_dismissal(line_id,target_kind,target_id,actor,command_id) values(v_line.id,v_kind,v_target,p_user_id,p_command_id);
  update erp_finance.bank_statement_line set version=version+1,updated_at=clock_timestamp() where id=v_line.id;
  perform erp_finance.require_access(p_user_id,true);
  v_result:=jsonb_build_object('entity','reconciliation','action','line_dismiss','record',erp_finance.bank_line_dto(v_line.id,true),'dismissed',jsonb_build_object('kind',v_kind,'id',v_target),
    'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,'line_dismiss',v_before,v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------- Relatórios financeiros
-- Contribution of every baixa (and estorno) of the period to the categories: principal in the category of the baixa (borderô)
-- or of the conta, juros/multa/desconto/tarifa in the Categorização para DRE recorded on the baixa (210), else with the principal.
-- Values are the cash effect: positive enters, negative leaves (an estorno undoes its baixa with the same categories).
create function erp_finance.report_settlement_parts(p_accounts uuid[],p_from date,p_to date)
returns table(category_id uuid,contact_id uuid,title_kind text,amount_cents bigint) language sql stable set search_path=pg_catalog as $$
  with pay as materialized (
    select s.id,s.kind,coalesce(s.reverses_id,s.id) base_id,case when s.kind='reversal' then -1 else 1 end sign,
      s.principal_cents,s.interest_cents,s.penalty_cents,s.discount_cents,s.fee_cents,t.kind tkind,t.contact_id,t.category_id title_category
    from erp_finance.settlement s join erp_finance.title t on t.id=s.title_id
    where s.account_id=any(p_accounts) and s.posted_on between p_from and p_to
  ), base as materialized (
    select p.*,coalesce(i.category_id,b.category_id,p.title_category) principal_category,c.interest_category_id,c.penalty_category_id,c.discount_category_id,c.fee_category_id,
      case when p.fee_cents>0 then (select pl.category_id from erp_finance.cnab_plan_for_settlement(p.base_id) pl) end plan_fee_category
    from pay p left join erp_finance.bordero_item i on i.settlement_id=p.base_id left join erp_finance.bordero b on b.id=i.bordero_id
      left join erp_finance.settlement_category c on c.settlement_id=p.base_id
  )
  select principal_category,contact_id,tkind,sign*case when tkind='receivable' then principal_cents else -principal_cents end from base
  union all select coalesce(interest_category_id,principal_category),contact_id,tkind,sign*case when tkind='receivable' then interest_cents else -interest_cents end from base where interest_cents>0
  union all select coalesce(penalty_category_id,principal_category),contact_id,tkind,sign*case when tkind='receivable' then penalty_cents else -penalty_cents end from base where penalty_cents>0
  union all select coalesce(discount_category_id,principal_category),contact_id,tkind,sign*case when tkind='receivable' then -discount_cents else discount_cents end from base where discount_cents>0
  union all select coalesce(fee_category_id,plan_fee_category,principal_category),contact_id,tkind,-sign*fee_cents from base where fee_cents>0;
$$;
-- Lançamentos de caixa (manuais, ajustes, conciliação, importação, comissões, sangrias e suprimentos) of the period, with the
-- category of their active posting (as the extrato, 136).
create function erp_finance.report_entry_parts(p_accounts uuid[],p_from date,p_to date)
returns table(category_id uuid,contact_id uuid,title_kind text,amount_cents bigint) language sql stable set search_path=pg_catalog as $$
  select (select m.category_id from erp_finance.movement m where m.entry_id=e.id and m.kind='entry' and not exists(select 1 from erp_finance.movement c where c.compensates_id=m.id) order by m.created_at desc limit 1),
    e.contact_id,case when e.kind='in' then 'receivable' else 'payable' end,case when e.kind='in' then e.amount_cents else -e.amount_cents end
  from erp_finance.cash_entry e where e.deleted_at is null and e.account_id=any(p_accounts) and e.posted_on between p_from and p_to;
$$;
create function erp_finance.report_buckets(p_from date,p_to date,p_group text)
returns table(start_on date,end_on date) language sql immutable set search_path=pg_catalog as $$
  select greatest(b::date,p_from),least((b+case when p_group='day' then interval '1 day' else interval '1 month' end-interval '1 day')::date,p_to)
  from generate_series(date_trunc(p_group,p_from::timestamp),p_to::timestamp,case when p_group='day' then interval '1 day' else interval '1 month' end) b;
$$;

create function public.erp_finance_report(p_user_id uuid,p_report text,p_from date,p_to date,p_account uuid default null,p_group text default 'month',
  p_page integer default 1,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_accounts uuid[]; v_rows jsonb; v_summary jsonb; v_total bigint:=0; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_start bigint;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_report is null or p_report not in ('cash_flow','forecast','categories','contacts') or p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_from<date '1900-01-01' or p_to>date '2100-12-31' or p_from>p_to or p_group is null or p_group not in ('day','month')
    or (p_group='day' and p_to-p_from>366) or p_to-p_from>3660 or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if p_account is not null and not exists(select 1 from erp_finance.account where id=p_account and deleted_at is null) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  select coalesce(array_agg(id),'{}'::uuid[]) into v_accounts from erp_finance.account where deleted_at is null and (p_account is null or id=p_account);

  if p_report='cash_flow' then
    -- Realizado: the movements of the period. With every conta, transfers between them are internal and stay out of Entradas/Saídas;
    -- the saldo of each day or month is always the whole ledger up to that day. A saldo inicial of the period joins the Saldo anterior.
    with b as (select * from erp_finance.report_buckets(p_from,p_to,p_group)),
      m as materialized (select x.posted_on,x.delta_cents from erp_finance.movement x where x.account_id=any(v_accounts) and x.posted_on between p_from and p_to
        and x.kind<>'opening' and (p_account is not null or x.transfer_id is null)),
      r as (select b.start_on,b.end_on,coalesce((select sum(delta_cents) from m where m.posted_on between b.start_on and b.end_on and delta_cents>0),0) in_cents,
        coalesce((select sum(-delta_cents) from m where m.posted_on between b.start_on and b.end_on and delta_cents<0),0) out_cents,
        (select coalesce(sum(x.delta_cents),0) from erp_finance.movement x where x.account_id=any(v_accounts) and x.posted_on<=b.end_on) balance_cents from b)
    select coalesce(jsonb_agg(jsonb_build_object('start_on',start_on,'end_on',end_on,'in_cents',in_cents::text,'out_cents',out_cents::text,'net_cents',(in_cents-out_cents)::text,
        'balance_cents',balance_cents::text) order by start_on),'[]'::jsonb),count(*),
      jsonb_build_object('previous_cents',((select coalesce(sum(x.delta_cents),0) from erp_finance.movement x where x.account_id=any(v_accounts) and x.posted_on<p_from)
          +(select coalesce(sum(x.delta_cents),0) from erp_finance.movement x where x.account_id=any(v_accounts) and x.kind='opening' and x.posted_on between p_from and p_to))::text,
        'in_cents',coalesce(sum(in_cents),0)::text,'out_cents',coalesce(sum(out_cents),0)::text,'net_cents',coalesce(sum(in_cents-out_cents),0)::text,
        'closing_cents',(select coalesce(sum(x.delta_cents),0) from erp_finance.movement x where x.account_id=any(v_accounts) and x.posted_on<=p_to)::text)
    into v_rows,v_total,v_summary from r;

  elsif p_report='forecast' then
    -- Previsto: contas em aberto (not cancelled or excluded) by vencimento in the period, over the saldo atual of the contas; with a
    -- conta financeira, only the contas of that portador. Atrasadas (vencimento before the period) are shown apart.
    v_start:=(select coalesce(sum(x.delta_cents),0) from erp_finance.movement x where x.account_id=any(v_accounts));
    with o as materialized (select t.kind,t.due_on,t.amount_cents-t.settled_cents balance from erp_finance.title t
        where not t.cancelled and t.deleted_at is null and t.settled_cents<t.amount_cents and (p_account is null or t.account_id=p_account) and t.due_on<=p_to),
      b as (select * from erp_finance.report_buckets(p_from,p_to,p_group)),
      r as (select b.start_on,b.end_on,coalesce((select sum(balance) from o where o.kind='receivable' and o.due_on between b.start_on and b.end_on),0) receivable_cents,
        coalesce((select sum(balance) from o where o.kind='payable' and o.due_on between b.start_on and b.end_on),0) payable_cents from b),
      c as (select r.*,v_start+sum(receivable_cents-payable_cents) over (order by start_on) balance_cents from r)
    select coalesce(jsonb_agg(jsonb_build_object('start_on',start_on,'end_on',end_on,'receivable_cents',receivable_cents::text,'payable_cents',payable_cents::text,
        'net_cents',(receivable_cents-payable_cents)::text,'balance_cents',balance_cents::text) order by start_on),'[]'::jsonb),count(*),
      jsonb_build_object('current_cents',v_start::text,'receivable_cents',coalesce(sum(receivable_cents),0)::text,'payable_cents',coalesce(sum(payable_cents),0)::text,
        'net_cents',coalesce(sum(receivable_cents-payable_cents),0)::text,'projected_cents',(v_start+coalesce(sum(receivable_cents-payable_cents),0))::text,
        'overdue_receivable_cents',(select coalesce(sum(balance),0) from o where o.kind='receivable' and o.due_on<p_from)::text,
        'overdue_payable_cents',(select coalesce(sum(balance),0) from o where o.kind='payable' and o.due_on<p_from)::text,'today',v_today)
    into v_rows,v_total,v_summary from c;

  elsif p_report='categories' then
    with parts as materialized (select * from erp_finance.report_settlement_parts(v_accounts,p_from,p_to) union all select * from erp_finance.report_entry_parts(v_accounts,p_from,p_to)),
      g as materialized (select p.category_id,sum(p.amount_cents) amount_cents from parts p group by p.category_id),
      n as materialized (select g.*,c.name,c.kind,(select x.name from erp_finance.category x where x.id=c.parent_id) parent_name,c.deleted_at is not null deleted from g left join erp_finance.category c on c.id=g.category_id),
      pg as (select * from n order by case n.kind when 'receivable' then 0 when 'payable' then 1 else 2 end,lower(coalesce(n.parent_name,n.name,'')),n.parent_name is not null,lower(coalesce(n.name,'')),n.category_id nulls last
        limit p_limit offset (p_page-1)*p_limit)
    select (select count(*) from n),
      (select coalesce(jsonb_agg(jsonb_build_object('category_id',category_id,'name',left(name,200),'parent_name',left(parent_name,200),'kind',kind,'deleted',coalesce(deleted,false),'amount_cents',amount_cents::text)
        order by case kind when 'receivable' then 0 when 'payable' then 1 else 2 end,lower(coalesce(parent_name,name,'')),parent_name is not null,lower(coalesce(name,'')),category_id nulls last),'[]'::jsonb) from pg),
      jsonb_build_object('in_cents',(select coalesce(sum(amount_cents),0) from g where amount_cents>0)::text,'out_cents',(select coalesce(sum(-amount_cents),0) from g where amount_cents<0)::text,
        'net_cents',(select coalesce(sum(amount_cents),0) from g)::text)
    into v_total,v_rows,v_summary;

  else
    -- Por cliente/fornecedor: the cash of the baixas (and estornos) of its contas and of the lançamentos de caixa with that contato.
    with flows as materialized (
        select t.contact_id,t.kind,case when s.kind='reversal' then -s.net_cash_cents else s.net_cash_cents end amount_cents
        from erp_finance.settlement s join erp_finance.title t on t.id=s.title_id where s.account_id=any(v_accounts) and s.posted_on between p_from and p_to
        union all select e.contact_id,case when e.kind='in' then 'receivable' else 'payable' end,e.amount_cents
        from erp_finance.cash_entry e where e.contact_id is not null and e.deleted_at is null and e.account_id=any(v_accounts) and e.posted_on between p_from and p_to),
      g as materialized (select f.contact_id,coalesce(sum(f.amount_cents) filter (where f.kind='receivable'),0) received_cents,coalesce(sum(f.amount_cents) filter (where f.kind='payable'),0) paid_cents
        from flows f group by f.contact_id),
      n as materialized (select g.*,r.name from g join erp_catalog.record r on r.id=g.contact_id),
      pg as (select * from n order by lower(n.name),n.contact_id limit p_limit offset (p_page-1)*p_limit)
    select (select count(*) from n),
      (select coalesce(jsonb_agg(jsonb_build_object('contact_id',contact_id,'name',left(name,200),'received_cents',received_cents::text,'paid_cents',paid_cents::text,'net_cents',(received_cents-paid_cents)::text)
        order by lower(name),contact_id),'[]'::jsonb) from pg),
      jsonb_build_object('received_cents',(select coalesce(sum(received_cents),0) from g)::text,'paid_cents',(select coalesce(sum(paid_cents),0) from g)::text,
        'net_cents',(select coalesce(sum(received_cents-paid_cents),0) from g)::text)
    into v_total,v_rows,v_summary;
  end if;

  return jsonb_build_object('entity','finance_report','report',p_report,'from',p_from,'to',p_to,'account_id',p_account,'group',p_group,
    'page',case when p_report in ('categories','contacts') then p_page else 1 end,'limit',p_limit,'total',v_total,'items',v_rows,'summary',v_summary,'data_mode','erp_native');
end $$;

revoke all on function erp_finance.bank_line_dismissal_immutable(),erp_finance.bank_line_dto(uuid,boolean),erp_finance.report_settlement_parts(uuid[],date,date),
  erp_finance.report_entry_parts(uuid[],date,date),erp_finance.report_buckets(date,date,text) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_finance_reconciliation_dismiss(uuid,uuid,jsonb)','erp_finance_report(uuid,text,date,date,uuid,text,integer,integer)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
