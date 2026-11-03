-- Leva H, lane espelho (NFE-027): a referência real entre pedido de venda e nota do Origin, para a letra V laranja
-- ("Número pedido: <n> - Data: <d> - Cliente: <nome>") e o filtro "Nº pedido de venda" nas notas do Origin.
-- * A fonte é o próprio pedido: o detalhe v3 de /pedidos/vendas traz notaFiscal {id} (VendasNotaFiscalDTO do contrato
--   versionado de importação v3). Nenhum vínculo é inferido por
--   valor, data ou nome do cliente.
-- * erp_fiscal_invoices.origin_order_link guarda, por pedido do Origin, o id Origin da nota que ele declara, com número, data e nome
--   do cliente do pedido. É derivado só do payload atual de origin_sync.raw_record (que já ignora versões antigas): entrega repetida
--   regrava o mesmo vínculo; entrega fora de ordem é corrigida pela versão atual; notaFiscal trocado ou ausente (ou id 0) remove o
--   vínculo anterior. O gatilho nunca interrompe o staging: qualquer erro só remove o vínculo daquele pedido (ausência, nunca um
--   vínculo errado), e a carga inicial (abaixo) pode ser refeita por erp_fiscal_invoices.origin_order_link_rebuild().
-- * A leitura (list_rows, 358) só mostra o vínculo quando o id da nota existe em uma única entidade (nfe ou nfce); o mesmo id nas
--   duas é ambíguo e fica sem vínculo.
-- Somente leitura do espelho: nada aqui escreve no Origin, cria pedido, nota, conta ou estoque.
begin;

do $$begin
 if to_regclass('origin_sync.raw_record') is null or to_regprocedure('erp_fiscal_invoices.scalar(jsonb,integer)') is null
  or to_regprocedure('erp_fiscal_invoices.origin_date(jsonb)') is null or to_regprocedure('erp_documents.origin_import_id(jsonb)') is null then
  raise exception 'fiscal_origin_order_links_356_requires_001_052_113' using errcode='55000'; end if;
end$$;

create table erp_fiscal_invoices.origin_order_link(
 order_source_id text primary key check(order_source_id~'^[1-9][0-9]{0,39}$'),
 invoice_source_id text not null check(invoice_source_id~'^[1-9][0-9]{0,39}$'),
 order_number text check(order_number~'^[0-9]{1,10}$'),
 order_date date,
 contact_name text check(length(contact_name) between 1 and 200 and contact_name!~'[[:cntrl:]]'),
 source_version bigint not null check(source_version>0),
 source_hash text not null check(source_hash~'^[0-9a-f]{64}$'),
 updated_at timestamptz not null default clock_timestamp()
);
create index origin_order_link_invoice on erp_fiscal_invoices.origin_order_link(invoice_source_id);
alter table erp_fiscal_invoices.origin_order_link enable row level security;
revoke all on erp_fiscal_invoices.origin_order_link from public,anon,authenticated,service_role;
comment on table erp_fiscal_invoices.origin_order_link is 'NFE-027: pedido de venda do Origin -> id Origin da nota declarada em notaFiscal.id do pedido (derivado do payload atual do espelho).';

-- The link one pedido payload declares (null: none). Number and name are kept only when they fit the list contract.
create function erp_fiscal_invoices.origin_order_link_of(p_payload jsonb) returns table(invoice_source_id text,order_number text,order_date date,contact_name text)
language sql immutable set search_path=pg_catalog as $$
 select erp_documents.origin_import_id(p_payload#>'{notaFiscal,id}'),
  case when erp_fiscal_invoices.scalar(p_payload->'numero',20)~'^[0-9]{1,10}$' then ltrim(p_payload->>'numero','0') end,
  erp_fiscal_invoices.origin_date(p_payload->'data'),
  nullif(btrim(erp_fiscal_invoices.scalar(p_payload#>'{contato,nome}',200)),'')
 where jsonb_typeof(p_payload->'notaFiscal')='object' and erp_documents.origin_import_id(p_payload#>'{notaFiscal,id}') is not null
$$;

-- Applies the current payload of one pedido: upsert the declared link or remove the previous one. Idempotent.
create function erp_fiscal_invoices.origin_order_link_apply(p_source_id text,p_payload jsonb,p_version bigint,p_hash text) returns void
language plpgsql security definer set search_path=pg_catalog as $$
declare l record;
begin
 if p_source_id is null or p_source_id!~'^[1-9][0-9]{0,39}$' then return; end if;
 select * into l from erp_fiscal_invoices.origin_order_link_of(p_payload);
 if l.invoice_source_id is null then delete from erp_fiscal_invoices.origin_order_link where order_source_id=p_source_id; return; end if;
 insert into erp_fiscal_invoices.origin_order_link(order_source_id,invoice_source_id,order_number,order_date,contact_name,source_version,source_hash)
 values(p_source_id,l.invoice_source_id,nullif(l.order_number,''),l.order_date,l.contact_name,p_version,p_hash)
 on conflict(order_source_id) do update set invoice_source_id=excluded.invoice_source_id,order_number=excluded.order_number,order_date=excluded.order_date,
  contact_name=excluded.contact_name,source_version=excluded.source_version,source_hash=excluded.source_hash,updated_at=clock_timestamp()
 where (origin_order_link.invoice_source_id,origin_order_link.order_number,origin_order_link.order_date,origin_order_link.contact_name,origin_order_link.source_hash)
  is distinct from (excluded.invoice_source_id,excluded.order_number,excluded.order_date,excluded.contact_name,excluded.source_hash);
exception when others then
 -- Never block the staging: without a trustworthy derivation the pedido simply has no link.
 delete from erp_fiscal_invoices.origin_order_link where order_source_id=p_source_id;
end $$;

create function erp_fiscal_invoices.origin_order_link_sync() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then
  if old.entity='sales_orders' then delete from erp_fiscal_invoices.origin_order_link where order_source_id=old.source_id; end if;
  return old;
 end if;
 if new.entity='sales_orders' then perform erp_fiscal_invoices.origin_order_link_apply(new.source_id,new.payload,new.version,new.version_hash); end if;
 return new;
exception when others then
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger origin_order_link_sync after insert or update of payload,version_hash or delete on origin_sync.raw_record
 for each row execute function erp_fiscal_invoices.origin_order_link_sync();

-- Reconciliation (and the initial load): every pedido of the mirror applied again; links of pedidos no longer mirrored are removed.
create function erp_fiscal_invoices.origin_order_link_rebuild() returns integer
language plpgsql security definer set search_path=pg_catalog as $$
declare r record;n integer:=0;
begin
 delete from erp_fiscal_invoices.origin_order_link l where not exists(select 1 from origin_sync.raw_record s where s.entity='sales_orders' and s.source_id=l.order_source_id);
 for r in select source_id,payload,version,version_hash from origin_sync.raw_record where entity='sales_orders' order by source_id loop
  perform erp_fiscal_invoices.origin_order_link_apply(r.source_id,r.payload,r.version,r.version_hash);n:=n+1;
 end loop;
 return n;
end $$;
select erp_fiscal_invoices.origin_order_link_rebuild();

revoke all on function erp_fiscal_invoices.origin_order_link_of(jsonb),erp_fiscal_invoices.origin_order_link_apply(text,jsonb,bigint,text),
 erp_fiscal_invoices.origin_order_link_sync(),erp_fiscal_invoices.origin_order_link_rebuild() from public,anon,authenticated,service_role;
commit;
