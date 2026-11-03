-- 363 (leva H, lane espelho, FIN-156): letras de origem do extrato (Caixas e bancos) também nas contas importadas do Origin.
-- O Origin mostra na coluna de origem do extrato N (Nota fiscal), V (Pedido de venda), P vermelho (Pagamento) e R (Recebimento).
-- O Brufap já mostra V e N pelos vínculos nativos (lançamento do pedido 017, lançamento da nota 247) e P/R nas demais baixas.
-- Agora, uma conta importada do Origin pela 039 (erp_finance.origin_import_origin) sem vínculo nativo mostra a origem declarada
-- pelo Origin na própria conta (payload.origem do espelho: tipoOrigem e numero): venda vira V e nota fiscal (NF-e ou NFC-e) vira N,
-- com o número do Origin e a marca source 'origin' (o documento não é aberto no Brufap). Um tipo de origem que não seja venda ou
-- nota, ou sem número, fica sem letra de documento (P ou R, como as outras baixas). Nada é lançado: nenhuma conta, baixa ou
-- vínculo é criado para mostrar uma letra.
-- Requires 136, 137, 247 and 039 (statement_line_dto of today is hash-checked before it is replaced).
begin;

do $$declare r record;begin
 for r in select * from(values
  ('erp_finance.statement_line_dto(erp_finance.statement_line)','5b0932faf1cc058db6db600882d53f36a9f9ce353afb5c2e773a3d16f4e854ec'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'finance_statement_363_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- The document a Origin conta declares (origem.tipoOrigem + origem.numero), as the extrato letter: V for a venda, N for a nota fiscal.
create function erp_finance.origin_declared_origin(p_title_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select case when x.kind is not null and x.number is not null then jsonb_build_object('kind',x.kind,'number',x.number,'source','origin') end
 from erp_finance.origin_import_origin o
 join origin_sync.raw_record r on r.entity=o.entity and r.source_id=o.source_id
 cross join lateral(select case when jsonb_typeof(r.payload->'origem')='object' and jsonb_typeof(r.payload#>'{origem,tipoOrigem}')='string' then
    case lower(regexp_replace(r.payload#>>'{origem,tipoOrigem}','[^A-Za-z]','','g'))
     when 'venda' then 'sales_orders' when 'vendas' then 'sales_orders' when 'pedidovenda' then 'sales_orders' when 'pedidodevenda' then 'sales_orders'
     when 'notafiscal' then 'fiscal_invoices' when 'nfe' then 'fiscal_invoices' when 'nfce' then 'fiscal_invoices' when 'nota' then 'fiscal_invoices' end end kind,
   case when jsonb_typeof(r.payload#>'{origem,numero}') in('string','number') then nullif(ltrim(r.payload#>>'{origem,numero}','0'),'') end raw_number) y
 cross join lateral(select y.kind,case when y.raw_number ~ '^[1-9][0-9]{0,9}$' then y.raw_number end number) x
 where o.title_id=p_title_id
$$;

-- Extrato: the native links first (pedido 017, nota 247); a conta imported from the Origin without them shows what the Origin declares.
create or replace function erp_finance.statement_line_dto(p_line erp_finance.statement_line)
 returns jsonb language plpgsql stable set search_path to 'pg_catalog' as $function$
declare v_doc jsonb;
begin
  if p_line.title_id is not null then
    select jsonb_build_object('kind',d.kind,'number',d.number::text) into v_doc from erp_finance.document_title l join erp_finance.document_posting dp on dp.id=l.posting_id
      join erp_documents.document d on d.id=dp.document_id where l.title_id=p_line.title_id limit 1;
    if v_doc is null then
      select jsonb_build_object('kind','fiscal_invoices','number',i.number::text) into v_doc from erp_finance.invoice_title l join erp_finance.invoice_posting ip on ip.id=l.posting_id
        join erp_fiscal_invoices.invoice i on i.id=ip.invoice_id where l.title_id=p_line.title_id and i.number is not null limit 1;
    end if;
    -- 363: the origin declared by the Origin conta (imported by 039), only when there is no native link.
    if v_doc is null then v_doc:=erp_finance.origin_declared_origin(p_line.title_id); end if;
  end if;
  return jsonb_build_object('line_id',p_line.line_id,'line_kind',p_line.line_kind,'posted_on',p_line.posted_on,'competence_on',p_line.competence_on,'account_id',p_line.account_id,
    'account_name',(select name from erp_finance.account where id=p_line.account_id),'amount_cents',p_line.amount_cents::text,
    'category_id',p_line.category_id,'category_name',(select name from erp_finance.category where id=p_line.category_id),
    'contact_id',p_line.contact_id,'contact_name',(select name from erp_catalog.record where id=p_line.contact_id),'note',p_line.note,
    'title_id',p_line.title_id,'title_kind',p_line.title_kind,'document',v_doc,'transfer_id',p_line.transfer_id,'entry_id',p_line.entry_id,'entry_version',p_line.entry_version,
    'entry_origin',p_line.entry_origin,'reconciled',erp_finance.line_reconciled(p_line.line_kind,p_line.line_id));
end $function$;

revoke all on function erp_finance.origin_declared_origin(uuid),erp_finance.statement_line_dto(erp_finance.statement_line) from public,anon,authenticated,service_role;
commit;
