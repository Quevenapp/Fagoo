-- Fiscal: UF inválida do Origin fica desconhecida na lista, sem invalidar a página do DTO.
-- O payload e as observações preservam integralmente o valor de origem; só o resumo corrente é reparado.
begin;
do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,chr(13),''),'UTF8')),'hex')from pg_proc
  where oid=to_regprocedure('erp_fiscal_mirror.list_data(jsonb)'))is distinct from
  'bdfacca9da369ee22f5b16096d1d9c0671bad16f48afb84a690d2738dadfe567' then
  raise exception 'fiscal_mirror_005_previous_definition_changed'using errcode='55000';
 end if;
end$$;

create or replace function erp_fiscal_mirror.list_data(p jsonb)returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('number',erp_fiscal_invoices.origin_int(to_jsonb(nullif(ltrim(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(p->'numero',20)),'0'),''))),
  'series',erp_fiscal_invoices.origin_int(p->'serie'),'issue_date',erp_fiscal_invoices.origin_date(p->'dataEmissao'),'entry_date',erp_fiscal_invoices.origin_date(p->'dataOperacao'),
  'name',erp_fiscal_invoices.scalar(p#>'{contato,nome}',200),'trade_name',erp_fiscal_invoices.scalar(p#>'{contato,fantasia}',200),
  'document',nullif(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(p#>'{contato,numeroDocumento}',30)),''),
  'person_type',coalesce(case erp_fiscal_invoices.scalar(p#>'{contato,tipoPessoa}',1)when'J'then'J'when'F'then'F'when'E'then'E'end,
   case length(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(p#>'{contato,numeroDocumento}',30)))when 14 then'J'when 11 then'F'end),
  'email',erp_fiscal_invoices.scalar(p#>'{contato,email}',254),'phone',nullif(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(p#>'{contato,telefone}',40)),''),
  'state',case when upper(erp_fiscal_invoices.scalar(p#>'{contato,endereco,uf}',2))=any(erp_fiscal_invoices.ufs()||array['EX'])
   then upper(erp_fiscal_invoices.scalar(p#>'{contato,endereco,uf}',2))end,'status',erp_fiscal_invoices.origin_status(p->'situacao'),
  'total',erp_fiscal_invoices.origin_money(p->'valorNota'),'direction',erp_fiscal_invoices.scalar(p->'tipo',2),
  'carrier',erp_fiscal_invoices.scalar(p#>'{transporte,transportador,nome}',200),'contact_source_id',erp_fiscal_invoices.scalar(p#>'{contato,id}',40),
  'seller_source_id',erp_fiscal_invoices.scalar(p#>'{vendedor,id}',40),
  'tracking',(select left(string_agg(e.value#>>'{}',' 'order by e.value#>>'{}'),4000)
   from jsonb_path_query(case when jsonb_typeof(p->'transporte')='object'then p->'transporte'else'{}'::jsonb end,'strict $.**')o(node)
   cross join lateral jsonb_each(case when jsonb_typeof(o.node)='object'then o.node else'{}'::jsonb end)e
   where e.key~*'rastre'and jsonb_typeof(e.value)in('string','number')),
  'product_codes',(select coalesce(jsonb_agg(erp_fiscal_invoices.scalar(e->'codigo',60)),'[]')from jsonb_array_elements(case when jsonb_typeof(p->'itens')='array'then p->'itens'else'[]'end)e))
$$;

-- A condição atinge somente resumos já inválidos (duas NFC-e no preflight), sem alterar versão, hash ou timestamps.
update erp_fiscal_mirror.current
 set listing=jsonb_set(listing,'{state}','null'::jsonb)
 where listing->>'state' is not null and not(listing->>'state'=any(erp_fiscal_invoices.ufs()||array['EX']));
commit;
