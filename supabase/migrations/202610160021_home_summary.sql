-- Resumo operacional da empresa. Leitura agregada, sem misturar staging do Origin.
begin;
create function public.erp_home_summary(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
  v_role text; v_today date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_catalog jsonb; v_documents jsonb; v_stock jsonb := null; v_finance jsonb := null;
begin
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if not found then raise exception 'erp_home_access_denied' using errcode='42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('entity',e,'active',
    (select count(*) from erp_catalog.record r where r.entity=e and r.active),
    'archived',(select count(*) from erp_catalog.record r where r.entity=e and not r.active)) order by e),'[]'::jsonb)
    into v_catalog from unnest(array['contacts','products','warehouses']) e where erp_catalog.allowed(v_role,e,false);

  select coalesce(jsonb_agg(jsonb_build_object('kind',k,'count',
    (select count(*) from erp_documents.document d where d.kind=k),
    'statuses',(select coalesce(jsonb_agg(jsonb_build_object('status',s,'count',
      (select count(*) from erp_documents.document d where d.kind=k and d.status=s)) order by s),'[]'::jsonb)
      from jsonb_object_keys(erp_documents.transitions()->k) s)) order by k),'[]'::jsonb)
    into v_documents from unnest(array['sales_proposals','sales_orders','purchase_orders','service_orders']) k
    where erp_documents.allowed(v_role,k,false);

  if v_role in ('admin','consulta','estoque','vendas','fiscal') then
    select jsonb_build_object('positions',count(*),'positive_positions',count(*) filter(where quantity>0),
      'zero_positions',count(*) filter(where quantity=0),'products',count(distinct product_id),
      'warehouses',count(distinct warehouse_id)) into v_stock from erp_stock.balance;
  end if;

  if v_role in ('admin','financeiro','consulta') then
    select jsonb_build_object('titles',(select jsonb_agg(jsonb_build_object('kind',k,
      'buckets',(select jsonb_agg(jsonb_build_object('bucket',bucket,'count',counted,'balance_cents',balance) order by ordinal)
      from (select b.bucket,b.ordinal,count(t.id) counted,coalesce(sum(t.amount_cents-t.settled_cents),0)::text balance
        from (values ('overdue',1),('today',2),('next_7_days',3),('later',4)) b(bucket,ordinal)
        left join erp_finance.title t on t.kind=k and not t.cancelled and t.amount_cents>t.settled_cents
          and case b.bucket when 'overdue' then t.due_on<v_today when 'today' then t.due_on=v_today
            when 'next_7_days' then t.due_on>v_today and t.due_on<=v_today+7 else t.due_on>v_today+7 end
        group by b.bucket,b.ordinal) buckets)) order by k) from unnest(array['receivable','payable']) k),
      'accounts',jsonb_build_object('active',(select count(*) from erp_finance.account where active),
        'archived',(select count(*) from erp_finance.account where not active),
        'opening_pending',(select count(*) from erp_finance.account where active and not opening_recorded),
        'recorded_balance_cents',(select coalesce(sum(delta_cents),0)::text from erp_finance.movement))) into v_finance;
  end if;
  return jsonb_build_object('data_mode','erp_native','as_of',statement_timestamp(),'business_date',v_today,
    'timezone','America/Sao_Paulo','role',v_role,'catalog',v_catalog,'documents',v_documents,'stock',v_stock,'finance',v_finance);
end $$;
revoke all on function public.erp_home_summary(uuid) from public,anon,authenticated;
grant execute on function public.erp_home_summary(uuid) to service_role;
commit;
