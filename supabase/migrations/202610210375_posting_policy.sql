-- 375: política de contas da venda (leva H, lane financeiro: VND-313, VND-131, EST-053, FIN-125).
-- Decisões recomendadas 3.1 e 10:
-- * Salvar o rascunho de uma NF-e nunca lança contas: nenhum gatilho de nota de saída lança contas (247 só automatiza a NF de
--   entrada, por preferência), e "Lançamento automático de contas em Notas Fiscais" continua guardado até a emissão existir.
-- * Uma venda tem as contas uma vez só. O dono do efeito é, nesta ordem, o lançamento ativo do pedido/OS (017), o faturamento
--   agrupado (174) ou o lançamento da nota avulsa (247). erp_finance.sale_effect(documento) e erp_finance.invoice_effect(nota)
--   dizem quem é o dono e quais contas ele gerou; a lane documentos usa esta política no faturamento parcial (várias notas por
--   pedido referenciam as mesmas contas do pedido, nunca uma cobrança nova por nota).
-- * Nota derivada de pedido: erp_finance_invoice_order_titles mostra as contas já lançadas pelo pedido (ou pelo faturamento
--   agrupado) que a nota referencia, em vez de lançar outras.
-- * Destino (VND-131, EST-053): Caixa ou uma conta financeira só escolhem a conta prevista das parcelas (196). Receber ou pagar é
--   sempre um comando próprio (baixa); a Ficha Financeira (136/247) é a visão dos registros ligados, sem dívida paralela.
-- Só leitura: nenhuma conta, baixa, documento ou nota é alterado.
begin;

do $$ begin
  if to_regprocedure('erp_finance.sale_effect(uuid)') is not null then raise exception 'posting_policy_375_already_applied' using errcode='55000'; end if;
end $$;

-- The titles of an effect, in order.
create function erp_finance.effect_titles(p_kind text,p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'position',x.position,'due_on',t.due_on,'amount_cents',t.amount_cents::text,'settled_cents',t.settled_cents::text,
      'cancelled',t.cancelled,'account_id',t.account_id) order by x.position),'[]'::jsonb)
  from (select l.title_id,l.position from erp_finance.document_title l where p_kind='document' and l.posting_id=p_id
    union all select l.title_id,l.position from erp_finance.grouped_billing_title l where p_kind='grouped' and l.billing_id=p_id
    union all select l.title_id,l.position from erp_finance.invoice_title l where p_kind='invoice' and l.posting_id=p_id) x
  join erp_finance.title t on t.id=x.title_id where t.deleted_at is null;
$$;
-- Who owns the contas of a sale (pedido de venda, OS or pedido de compra): its own active lançamento, else the active faturamento
-- agrupado that took it, else the active lançamento of a note generated from it; null when nobody lançou contas yet.
create function erp_finance.sale_effect(p_document uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
  select coalesce(
    (select jsonb_build_object('owner','document','id',p.id,'titles',erp_finance.effect_titles('document',p.id)) from erp_finance.document_posting p where p.document_id=p_document and p.state='active'),
    (select jsonb_build_object('owner','grouped','id',b.id,'titles',erp_finance.effect_titles('grouped',b.id)) from erp_finance.grouped_billing_document g
      join erp_finance.grouped_billing b on b.id=g.billing_id and b.state='active' where g.document_id=p_document and g.active limit 1),
    (select jsonb_build_object('owner','invoice','id',p.id,'invoice_id',p.invoice_id,'titles',erp_finance.effect_titles('invoice',p.id)) from erp_fiscal_invoices.invoice_order o
      join erp_finance.invoice_posting p on p.invoice_id=o.invoice_id and p.state='active' where o.document_id=p_document order by p.created_at limit 1));
$$;
-- The contas a note answers for: its own lançamento, else the contas of its pedidos (each sale once).
create function erp_finance.invoice_effect(p_invoice uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
  select coalesce(
    (select jsonb_build_object('owner','invoice','id',p.id,'titles',erp_finance.effect_titles('invoice',p.id)) from erp_finance.invoice_posting p where p.invoice_id=p_invoice and p.state='active'),
    (select jsonb_build_object('owner','orders','orders',jsonb_agg(jsonb_build_object('document_id',d.id,'kind',d.kind,'number',d.number::text,'effect',erp_finance.sale_effect(d.id)) order by d.number))
      from erp_fiscal_invoices.invoice_order o join erp_documents.document d on d.id=o.document_id
      where o.invoice_id=p_invoice and erp_finance.sale_effect(d.id)->>'owner' in ('document','grouped') having count(*)>0));
$$;

create function public.erp_finance_invoice_order_titles(p_user_id uuid,p_invoice_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_effect jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_invoice_id is null or not exists(select 1 from erp_fiscal_invoices.invoice where id=p_invoice_id) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  v_effect:=erp_finance.invoice_effect(p_invoice_id);
  return jsonb_build_object('entity','invoice_order_titles','data_mode','erp_native','operational_effects',false,'invoice_id',p_invoice_id,
    'owner',v_effect->>'owner','orders',case when v_effect->>'owner'='orders' then v_effect->'orders' else '[]'::jsonb end);
end $$;

revoke all on function erp_finance.effect_titles(text,uuid),erp_finance.sale_effect(uuid),erp_finance.invoice_effect(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_invoice_order_titles(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_finance_invoice_order_titles(uuid,uuid) to service_role;
commit;
