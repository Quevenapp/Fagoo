-- Leva H, lane espelho (NFE-063, NFE-185): modelo fiscal, origem e ambiente de origem como atributos independentes.
-- * O ambiente da coluna invoice.environment continua sendo o da emissão do Brufap ('2' homologação, ou nulo nas notas
--   registradas T/S/X) e as travas 022/041/046/064 não mudam. O ambiente de ORIGEM de um XML importado (Importação de XML de
--   saída S, de entrada X, NF-e ou NFC-e) é outro atributo: o <tpAmb> do próprio XML guardado em invoice_xml.
-- * erp_fiscal_invoices.invoice_source guarda esse ambiente, gravado por um gatilho AFTER INSERT em invoice_xml (o XML é imutável,
--   então o valor também é) e pela carga inicial abaixo. Nulo quando o <tpAmb> de <ide> e o do protocolo não concordam ou faltam.
-- * A deduplicação da importação continua pela chave de acesso (143/274), mais estrita que chave + ambiente: a importação só
--   aceita XML de produção (tpAmb 1, recusa xml_homologation no Worker), então chave e chave + ambiente coincidem.
-- A listagem (358) expõe source_origin (origin, brufap_native, third_party, xml_import) e source_environment.
-- Nada aqui emite, transmite, cria conta ou estoque.
begin;

do $$begin
 if to_regclass('erp_fiscal_invoices.invoice_xml') is null then raise exception 'fiscal_invoice_source_357_requires_143' using errcode='55000'; end if;
end$$;

create table erp_fiscal_invoices.invoice_source(
 invoice_id uuid primary key references erp_fiscal_invoices.invoice(id),
 xml_sha256 text not null check(xml_sha256~'^[0-9a-f]{64}$'),
 source_environment text check(source_environment in('1','2')),
 recorded_at timestamptz not null default clock_timestamp()
);
alter table erp_fiscal_invoices.invoice_source enable row level security;
revoke all on erp_fiscal_invoices.invoice_source from public,anon,authenticated,service_role;
create trigger immutable_invoice_source before update or delete on erp_fiscal_invoices.invoice_source for each row execute function erp_fiscal_invoices.immutable_history();
comment on table erp_fiscal_invoices.invoice_source is 'NFE-063/185: ambiente de origem (tpAmb) do XML importado, independente do ambiente de emissão do Brufap.';

-- <tpAmb> of <ide> and of <infProt>; the environment only when both are present and agree.
create function erp_fiscal_invoices.xml_source_environment(p_xml text) returns text language sql immutable set search_path=pg_catalog as $$
 select case when i.v is not null and i.v=p.v then i.v end
 from (select substring(substring(p_xml from '<ide>.*?</ide>') from '<tpAmb>([12])</tpAmb>') v) i,
  (select substring(substring(p_xml from '<infProt[^>]*>.*?</infProt>') from '<tpAmb>([12])</tpAmb>') v) p
$$;

create function erp_fiscal_invoices.invoice_source_record() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 insert into erp_fiscal_invoices.invoice_source(invoice_id,xml_sha256,source_environment)
 values(new.invoice_id,new.sha256,erp_fiscal_invoices.xml_source_environment(new.content)) on conflict(invoice_id) do nothing;
 return new;
end $$;
create trigger invoice_source_record after insert on erp_fiscal_invoices.invoice_xml for each row execute function erp_fiscal_invoices.invoice_source_record();

insert into erp_fiscal_invoices.invoice_source(invoice_id,xml_sha256,source_environment)
select x.invoice_id,x.sha256,erp_fiscal_invoices.xml_source_environment(x.content) from erp_fiscal_invoices.invoice_xml x on conflict(invoice_id) do nothing;

revoke all on function erp_fiscal_invoices.xml_source_environment(text),erp_fiscal_invoices.invoice_source_record() from public,anon,authenticated,service_role;
commit;
