-- Leva H, lane plataforma (VND-042): o triângulo 'Este pedido contém pendências' passa a conferir o Município do cliente na tabela
-- oficial de municípios do IBGE (332), dentro da UF informada. Município vazio, UF vazia, UF EX e contato estrangeiro seguem as
-- regras que já existiam. Nada é apagado nem corrigido no cadastro: a pendência só avisa, e Limpar avisos confere de novo.
-- Substitui erp_documents.pendencies (168), conferida pelo hash; qualquer outra versão interrompe a migração. Requer 332.
begin;

do $$begin
 if to_regprocedure('erp_reference.municipality_known(text,text)') is null then raise exception 'pendencies_333_requires_332' using errcode='55000'; end if;
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure('erp_documents.pendencies(uuid)'))
  is distinct from 'b9788b78c54dfb58e7371fcbf0833d5ac81d54fa4961b744b86353db81cf5166' then
  raise exception 'pendencies_333_previous_definition_changed' using errcode='55000'; end if;
end$$;

create or replace function erp_documents.pendencies(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 with d as (select * from erp_documents.document where id=p_id and kind='sales_orders'),
 c as (select k.*,cp.taxpayer,coalesce(cp.ie_exempt,false) ie_exempt from d join erp_catalog.contact k on k.record_id=d.contact_id left join erp_catalog.contact_profile cp on cp.record_id=k.record_id),
 checks as (
  select 1 o,'Cliente' section,'O campo CPF/CNPJ é obrigatório' message from c where coalesce(c.person_type,'')<>'E' and nullif(btrim(c.document),'') is null
  union all select 2,'Cliente','O CPF/CNPJ informado é inválido' from c where coalesce(c.person_type,'')<>'E' and nullif(btrim(c.document),'') is not null
   and not erp_catalog.valid_cpf(regexp_replace(c.document,'[^0-9]','','g')) and not erp_catalog.valid_cnpj(regexp_replace(c.document,'[^0-9]','','g'))
  union all select 3,'Cliente','O campo Inscrição Estadual é obrigatório para contribuinte do ICMS' from c where c.taxpayer='1' and nullif(btrim(coalesce(c.ie,'')),'') is null and not c.ie_exempt
  union all select 4,'Cliente','O campo Endereço é obrigatório' from c where nullif(btrim(c.street),'') is null
  union all select 5,'Cliente','O campo Número é obrigatório' from c where nullif(btrim(c.number),'') is null
  union all select 6,'Cliente','O campo Bairro é obrigatório' from c where nullif(btrim(c.district),'') is null
  union all select 7,'Cliente','O campo Cidade é obrigatório' from c where nullif(btrim(c.city),'') is null
  union all select 8,'Cliente','O campo UF é obrigatório' from c where nullif(btrim(c.state),'') is null
  union all select 9,'Cliente','A UF informada é inválida' from c where nullif(btrim(c.state),'') is not null
   and upper(btrim(c.state))!~'^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$'
  union all select 10,'Cliente','O campo CEP é obrigatório' from c where coalesce(c.person_type,'')<>'E' and regexp_replace(coalesce(c.postal_code,''),'[^0-9]','','g')!~'^[0-9]{8}$'
  -- 333: the Município must be an IBGE municipality of the UF (erp_reference, 332); EX and empty fields are left to the checks above.
  union all select 11,'Cliente','O município informado não consta na tabela do IBGE para a UF '||upper(btrim(c.state)) from c
   where coalesce(c.person_type,'')<>'E' and erp_reference.municipality_known(c.city,c.state) is false
  union all select 50,'Transportador','O campo Transportador é obrigatório para o frete por conta do destinatário ou de terceiros' from d
   where d.body#>>'{commercial,transport,freight_mode}' in('1','2') and coalesce(d.body#>'{commercial,transport,carrier_reference}','null'::jsonb)='null'::jsonb
   and d.body->>'carrier_id' is null
  union all select 100+i.position,'Produto '||(i.data->>'description'),'O item não está vinculado a um produto cadastrado'
   from d join erp_documents.item i on i.document_id=d.id where i.product_id is null
  union all select 100+i.position,'Produto '||(i.data->>'description'),m.message
   from d join erp_documents.item i on i.document_id=d.id join erp_catalog.product p on p.record_id=i.product_id
   cross join lateral (values (p.ncm is null or p.ncm!~'^[0-9]{8}$','O campo NCM é obrigatório'),(p.origin is null,'O campo Origem é obrigatório'),
    (nullif(btrim(coalesce(i.data->>'unit','')),'') is null,'O campo Unidade é obrigatório')) m(missing,message) where m.missing
 )
 select coalesce(jsonb_agg(jsonb_build_object('section',section,'message',message) order by o,message),'[]'::jsonb) from checks
$$;

revoke all on function erp_documents.pendencies(uuid) from public,anon,authenticated,service_role;
commit;
