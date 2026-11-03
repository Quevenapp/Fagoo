-- Relatório por vencimento. Principal pendente no Brufap; não é saldo de banco ou caixa.
begin;

create index erp_finance_title_due_open on erp_finance.title(due_on)
  where not cancelled and settled_cents < amount_cents;

create function public.erp_finance_due_report(
  p_user_id uuid, p_from text default null, p_to text default null
) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
  v_role text; v_today date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_from date; v_to date; v_result jsonb;
begin
  v_role := erp_finance.require_access(p_user_id,false);
  if p_from is null and p_to is null then
    v_from := v_today; v_to := v_today + 29;
  else
    if p_from is null or p_to is null
      or length(p_from)<>10 or length(p_to)<>10
      or p_from !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_to !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or p_from<'1900-01-01' or p_to>'2100-12-31' then
      raise exception 'erp_finance_invalid_report_period' using errcode='22023';
    end if;
    begin
      v_from := p_from::date; v_to := p_to::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'erp_finance_invalid_report_period' using errcode='22023';
    end;
    if to_char(v_from,'YYYY-MM-DD')<>p_from or to_char(v_to,'YYYY-MM-DD')<>p_to then
      raise exception 'erp_finance_invalid_report_period' using errcode='22023';
    end if;
  end if;
  if v_from<'1900-01-01'::date or v_to>'2100-12-31'::date or v_to<v_from or v_to-v_from>365 then
    raise exception 'erp_finance_invalid_report_period' using errcode='22023';
  end if;

  -- One statement/snapshot and one contribution per native title; no joins to payments or CNAB.
  with amounts as materialized (
    select t.due_on,
      count(*) filter(where t.kind='receivable') as receivable_count,
      coalesce(sum(t.amount_cents-t.settled_cents) filter(where t.kind='receivable'),0) as receivable_cents,
      count(*) filter(where t.kind='payable') as payable_count,
      coalesce(sum(t.amount_cents-t.settled_cents) filter(where t.kind='payable'),0) as payable_cents
    from erp_finance.title t
    where t.due_on between v_from and v_to and not t.cancelled and t.settled_cents<t.amount_cents
    group by t.due_on
  ), days as materialized (
    select v_from+s.offset_day as day,
      coalesce(a.receivable_count,0) as receivable_count,coalesce(a.receivable_cents,0) as receivable_cents,
      coalesce(a.payable_count,0) as payable_count,coalesce(a.payable_cents,0) as payable_cents
    from generate_series(0,v_to-v_from) as s(offset_day)
    left join amounts a on a.due_on=v_from+s.offset_day
  ) select jsonb_build_object(
    'scope','due_report','data_mode','erp_native','role',v_role,
    'timezone','America/Sao_Paulo','business_date',v_today,'as_of',statement_timestamp(),
    'from',v_from,'to',v_to,'day_count',v_to-v_from+1,
    'basis','outstanding_principal',
    'days',jsonb_agg(jsonb_build_object(
      'day',day,'receivable_count',receivable_count::text,'receivable_cents',receivable_cents::text,
      'payable_count',payable_count::text,'payable_cents',payable_cents::text,
      'difference_cents',(receivable_cents-payable_cents)::text) order by day),
    'totals',jsonb_build_object(
      'receivable_count',sum(receivable_count)::text,'receivable_cents',sum(receivable_cents)::text,
      'payable_count',sum(payable_count)::text,'payable_cents',sum(payable_cents)::text,
      'difference_cents',(sum(receivable_cents)-sum(payable_cents))::text)
  ) into v_result from days;
  return v_result;
end $$;

revoke all on function public.erp_finance_due_report(uuid,text,text) from public,anon,authenticated;
grant execute on function public.erp_finance_due_report(uuid,text,text) to service_role;
commit;
