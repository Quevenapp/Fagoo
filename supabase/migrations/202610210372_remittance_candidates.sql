-- 372: títulos elegíveis para a remessa, com filtros (leva H, lane financeiro: FIN-176, FIN-180, FIN-182).
-- Decisões recomendadas (10.2): o painel de remessa funciona sem envio bancário real. Esta migração só lê: nenhum título, número,
-- remessa, perfil ou trava do CNAB (014, 042, 067, 213) é alterado, e a reserva e a geração continuam em erp_cnab_operational_*_v2,
-- com as mesmas aprovações e conferências.
-- * erp_cnab_remittance_candidates: as contas a receber em aberto que ainda não estão em nenhuma remessa (erp_cnab.billing_title),
--   sem baixa, emitidas até hoje e com vencimento a partir de hoje, nativas do Brufap (os títulos importados do Origin ficam de fora,
--   como na reserva), com os filtros Forma de pagamento (Todas ou uma forma, inativas marcadas) e Conta financeira, com a opção
--   explícita "Incluir títulos sem conta financeira". Cursor de 15 linhas, como a lista do editor (FIN-182: nada é incluído
--   sozinho; o usuário escolhe e remove cada título).
-- * O total de elegíveis e o limite de 30 títulos por remessa voltam junto, para a tela mostrar quantas remessas adicionais faltam.
-- * O pagador pronto (contato ativo, pessoa física ou jurídica) é indicado, sem mudar a conferência da reserva.
begin;

do $$ begin
  if to_regprocedure('public.erp_cnab_remittance_candidates(uuid,uuid,uuid,boolean,text,uuid,integer)') is not null then
    raise exception 'remittance_candidates_372_already_applied' using errcode='55000'; end if;
end $$;

create function public.erp_cnab_remittance_candidates(p_user_id uuid,p_payment_method_id uuid default null,p_account_id uuid default null,p_without_account boolean default true,
  p_query text default null,p_after uuid default null,p_limit integer default 15)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_query text:=lower(nullif(btrim(p_query),'')); v_items jsonb; v_more boolean; v_cursor uuid; v_total bigint;
begin
  perform erp_cnab.access(p_user_id);
  if p_without_account is null or p_limit is null or p_limit not between 1 and 15 or length(p_query)>120 or p_query~'[[:cntrl:]]' then
    raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  if p_payment_method_id is not null and not exists(select 1 from erp_catalog.payment_method where id=p_payment_method_id and deleted_at is null) then
    raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  if p_account_id is not null and not exists(select 1 from erp_finance.account where id=p_account_id) then raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  with eligible as materialized (
    select t.id,t.version,t.description,t.amount_cents,t.settled_cents,t.issued_on,t.due_on,t.cancelled,t.account_id,t.payment_method_id,t.contact_id
    from erp_finance.title t
    where t.kind='receivable' and not t.cancelled and t.deleted_at is null and t.settled_cents=0 and t.amount_cents between 1 and 9999999999999
      and t.issued_on<=v_today and t.due_on>=v_today
      and not exists(select 1 from erp_cnab.billing_title b where b.title_id=t.id)
      and not exists(select 1 from erp_finance.origin_import_origin o where o.title_id=t.id)
      and (p_payment_method_id is null or t.payment_method_id=p_payment_method_id)
      and (p_account_id is null or t.account_id=p_account_id or (p_without_account and t.account_id is null))
      and (p_account_id is not null or p_without_account or t.account_id is not null)
  ), named as materialized (
    select e.*,r.name contact_name,r.active and c.person_type in ('F','J') payer_ready from eligible e join erp_catalog.record r on r.id=e.contact_id join erp_catalog.contact c on c.record_id=r.id
    where v_query is null or strpos(lower(concat_ws(' ',e.description,r.name)),v_query)>0
  ), page as (select * from named where p_after is null or id>p_after order by id limit p_limit+1)
  select (select count(*) from named),
    (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'version',p.version,'kind','receivable','description',p.description,'contact_name',p.contact_name,
       'amount_cents',p.amount_cents::text,'settled_cents',p.settled_cents::text,'issued_on',p.issued_on,'due_on',p.due_on,'cancelled',p.cancelled,'payer_ready',p.payer_ready,
       'account_id',p.account_id,'account_name',(select left(a.name,200) from erp_finance.account a where a.id=p.account_id),
       'payment_method_id',p.payment_method_id,'payment_method_name',(select left(m.description,200) from erp_catalog.payment_method m where m.id=p.payment_method_id)) order by p.id),'[]'::jsonb)
      from (select * from page order by id limit p_limit) p),
    (select count(*)>p_limit from page),(select max(id::text)::uuid from (select id from page order by id limit p_limit) x)
    into v_total,v_items,v_more,v_cursor;
  return jsonb_build_object('entity','titles','data_mode','erp_native','operational_effects',false,'items',v_items,'has_more',v_more,'next_cursor',case when v_more then v_cursor end,
    'eligible_total',v_total,'remittance_limit',30,
    'filters',jsonb_build_object('payment_method_id',p_payment_method_id,'account_id',p_account_id,'without_account',p_without_account),
    -- Forma de pagamento: Todas or a forma applicable to recebimentos; the inactive ones are marked, the ones linked to the conta first.
    'payment_methods',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'description',left(m.description,200),'active',m.active,'linked',coalesce(p_account_id is not null and m.account_id=p_account_id,false))
       order by coalesce(p_account_id is not null and m.account_id=p_account_id,false) desc,m.active desc,lower(m.description),m.id),'[]'::jsonb)
      from (select * from erp_catalog.payment_method where deleted_at is null and applicable in ('recebimentos','ambos') order by lower(description),id limit 200) m));
end $$;

revoke all on function public.erp_cnab_remittance_candidates(uuid,uuid,uuid,boolean,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.erp_cnab_remittance_candidates(uuid,uuid,uuid,boolean,text,uuid,integer) to service_role;
commit;
