-- Normalize only the exact NCM display mask from Origin. No price rounding, source rewrites or automatic import.
begin;
create or replace function erp_catalog.map_origin(p_entity text,p_payload jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_data jsonb; v_address jsonb; v_ncm jsonb;
begin
  v_data:=jsonb_build_object('name',p_payload->'nome','code',p_payload->'codigo');
  if p_entity='contacts' then
    v_address:=p_payload#>'{endereco,geral}';
    v_data:=v_data||jsonb_build_object('trade_name',p_payload->'fantasia','person_type',p_payload->'tipo',
      'document',p_payload->'numeroDocumento','ie',p_payload->'ie','email',p_payload->'email',
      'phone',p_payload->'telefone','mobile',p_payload->'celular','postal_code',v_address->'cep',
      'street',v_address->'endereco','number',v_address->'numero','complement',v_address->'complemento',
      'district',v_address->'bairro','city',v_address->'municipio','state',v_address->'uf','roles','[]'::jsonb);
  elsif p_entity='products' then
    v_ncm:=p_payload#>'{tributacao,ncm}';
    -- Formatting only: preserve every digit, including leading zeroes.
    if jsonb_typeof(v_ncm)='string' and v_ncm#>>'{}'~'^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$' then
      v_ncm:=to_jsonb(replace(v_ncm#>>'{}','.',''));
    end if;
    if p_payload?'preco' and p_payload->'preco'<>'null'::jsonb and jsonb_typeof(p_payload->'preco') not in ('number','string') then
      raise exception 'erp_catalog_invalid_source_price' using errcode='22023'; end if;
    v_data:=v_data||jsonb_build_object('unit',p_payload->'unidade','price',p_payload->>'preco',
      'kind',p_payload->'tipo','format',p_payload->'formato','description',p_payload->'descricaoCurta',
      'ncm',v_ncm,'gtin',p_payload->'gtin');
  else raise exception 'erp_catalog_invalid_import_entity' using errcode='22023'; end if;
  return erp_catalog.validate_data(p_entity,v_data,true);
end $$;

revoke all on function erp_catalog.map_origin(text,jsonb) from public,anon,authenticated,service_role;
commit;
