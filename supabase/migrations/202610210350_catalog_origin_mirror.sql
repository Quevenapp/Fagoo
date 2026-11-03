-- 350 (leva H, lane espelho): espelho ampliado de contatos e produtos (CTT-083, PRD-112) e busca de transportador (EST-057).
-- * erp_catalog.origin_mirror guarda, por cadastro sincronizado, os campos do Origin v3 aplicados (origem, id externo, hash e data
--   da sincronização), separados das colunas nativas e dos complementos exclusivos do Brufap (contact_profile, product_detail,
--   contact_role_complement). É derivado do snapshot que a importação aplicou (origin.applied_hash): repetir ou receber fora de
--   ordem o mesmo dado não muda nada, e um dado mais novo ainda não aplicado fica só como latest_hash (pendente).
-- * map_origin passa a trazer, quando o Origin envia e o valor é válido, marca, condição, produção, pesos, dimensões, volumes, itens
--   por caixa, GTIN tributário, estoque mínimo e máximo, localização, CEST, origem e informações adicionais do produto, e os papéis
--   Cliente/Fornecedor/Transportador do contato (tiposContato). Um valor inválido nunca recusa o cadastro: fica só no espelho.
-- * O seletor de transportador lista primeiro os transportadores (papel, tipo Transportador no Origin ou complemento do Brufap) e
--   depois os contatos sem tipo. Marcar um contato sincronizado como transportador é um complemento controlado: não altera o
--   cadastro espelhado, não o marca como editado e fica auditado.
-- Nada aqui escreve no Origin, no estoque, no financeiro ou no fiscal. Substitui map_origin (044), import_changes (013) e
-- erp_catalog_contact_options (241), conferidas pelo hash.
begin;

do $$declare r record;begin
 for r in select * from(values
  ('erp_catalog.map_origin(text,jsonb)','1b7e2b8b2d56beecf9f8c221849d0bf96015cd49cf2465b0dad9411cc082d15d'),
  ('erp_catalog.import_changes(text,jsonb,jsonb)','d3be4bb4a992d753c1e1d1256b922d1737944fcc0011d52f2ae6323d05199853'),
  ('public.erp_catalog_contact_options(uuid,text,text,text,integer)','a669a32c6a5d38ca93a87a5bee32046888eebc737213f00862da03d30ed20bf5'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'catalog_mirror_350_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Leitura tolerante de valores do payload do Origin (nunca levanta erro).
create function erp_catalog.origin_text(p_value jsonb,p_max integer) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(p_value) in('string','number','boolean') then left(nullif(btrim(p_value#>>'{}'),''),p_max) end
$$;
-- Decimal >= 0 com até 6 casas (formato de validate_data); null quando ausente ou inválido.
create function erp_catalog.origin_decimal(p_value jsonb) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare v numeric;
begin
 if jsonb_typeof(p_value) not in('number','string') or (p_value#>>'{}')!~'^[0-9]{1,12}(\.[0-9]+)?$' then return null; end if;
 v:=round((p_value#>>'{}')::numeric,6);
 if v>=1000000000000 then return null; end if;
 return v::text;
end $$;
create function erp_catalog.origin_count(p_value jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(p_value) in('number','string') and (p_value#>>'{}')~'^[0-9]{1,6}$' then ((p_value#>>'{}')::integer)::text end
$$;
-- Papéis do Brufap a partir dos tipos de contato do Origin (descrição): Cliente, Fornecedor e Transportador(a).
create function erp_catalog.origin_contact_roles(p_payload jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(p_payload->'tiposContato')='array' then
  (select coalesce(jsonb_agg(distinct x.role order by x.role),'[]'::jsonb) from(
   select case when d like 'cliente%' then 'customer' when d like 'fornecedor%' then 'supplier' when d like 'transportador%' then 'carrier' end role
   from jsonb_array_elements(p_payload->'tiposContato') t
   cross join lateral(select erp_catalog.fold(coalesce(erp_catalog.origin_text(case when jsonb_typeof(t)='object' then t->'descricao' else t end,100),'')) d) f) x
   where x.role is not null) end
$$;

-- Campos do cadastro no Origin v3 (detalhe de /contatos/{id} e /produtos/{id}), em texto, só os presentes.
create function erp_catalog.origin_mirror_fields(p_entity text,p_payload jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare p jsonb:=case when jsonb_typeof(p_payload)='object' then p_payload else '{}'::jsonb end;
 v jsonb;
 address constant text:='{"postal_code":"cep","street":"endereco","number":"numero","complement":"complemento","district":"bairro","city":"municipio","state":"uf"}';
 f text; k text;
 function_result jsonb:='{}'::jsonb;
begin
 if p_entity='contacts' then
  for k,f in select * from jsonb_each_text(jsonb_build_object('code','codigo','name','nome','trade_name','fantasia','person_type','tipo','document','numeroDocumento',
   'ie_indicator','indicadorIe','ie','ie','rg','rg','rg_issuer','orgaoEmissor','municipal_registration','inscricaoMunicipal','email','email','nfe_email','emailNotaFiscal',
   'phone','telefone','mobile','celular','situation','situacao')) loop
   function_result:=function_result||jsonb_build_object(k,erp_catalog.origin_text(p->f,254));
  end loop;
  foreach f in array array['geral','cobranca'] loop
   v:=p#>array['endereco',f];
   if jsonb_typeof(v)='object' then
    function_result:=function_result||jsonb_build_object(case f when 'geral' then 'address' else 'billing_address' end,
     jsonb_strip_nulls((select jsonb_object_agg(a.key,erp_catalog.origin_text(v->(a.value#>>'{}'),200)) from jsonb_each(address::jsonb) a)));
   end if;
  end loop;
  if jsonb_typeof(p->'tiposContato')='array' then
   function_result:=function_result||jsonb_build_object('contact_types',(select coalesce(jsonb_agg(d order by d),'[]'::jsonb) from(
     select distinct erp_catalog.origin_text(case when jsonb_typeof(t)='object' then t->'descricao' else t end,100) d from jsonb_array_elements(p->'tiposContato') t) x where d is not null),
    'source_roles',erp_catalog.origin_contact_roles(p));
  end if;
  function_result:=function_result||jsonb_build_object('seller_source_id',erp_catalog.origin_text(p#>'{vendedor,id}',40),
   'credit_limit',erp_catalog.origin_decimal(p#>'{financeiro,limiteCredito}'),'payment_condition',erp_catalog.origin_text(p#>'{financeiro,condicaoPagamento}',100),
   'financial_category_source_id',erp_catalog.origin_text(p#>'{financeiro,categoria,id}',40),
   'birth_date',erp_catalog.origin_text(p#>'{dadosAdicionais,dataNascimento}',10),'gender',erp_catalog.origin_text(p#>'{dadosAdicionais,sexo}',1),
   'birthplace',erp_catalog.origin_text(p#>'{dadosAdicionais,naturalidade}',100),'country',erp_catalog.origin_text(p#>'{pais,nome}',100),
   'persons',case when jsonb_typeof(p->'pessoasContato')='array' then jsonb_array_length(p->'pessoasContato')::text end);
 elsif p_entity='products' then
  for k,f in select * from jsonb_each_text(jsonb_build_object('code','{codigo}','name','{nome}','unit','{unidade}','kind','{tipo}','format','{formato}','situation','{situacao}',
   'short_description','{descricaoCurta}','brand','{marca}','condition','{condicao}','production','{tipoProducao}','gtin','{gtin}','gtin_package','{gtinEmbalagem}',
   'expiry_date','{dataValidade}','free_shipping','{freteGratis}','external_link','{linkExterno}','dimension_unit','{dimensoes,unidadeMedida}',
   'crossdocking','{estoque,crossdocking}','location','{estoque,localizacao}','category_source_id','{categoria,id}','parent_source_id','{idProdutoPai}',
   'tax_origin','{tributacao,origem}','ncm','{tributacao,ncm}','cest','{tributacao,cest}','fci_number','{tributacao,nFCI}','item_type','{tributacao,spedTipoItem}',
   'tax_percent','{tributacao,percentualTributos}','ipi_exception','{tributacao,codigoExcecaoTipi}','product_group_source_id','{tributacao,grupoProduto,id}')) loop
   function_result:=function_result||jsonb_build_object(k,erp_catalog.origin_text(p#>f::text[],200));
  end loop;
  function_result:=function_result||jsonb_build_object('price',erp_catalog.origin_text(p->'preco',30),
   'net_weight',erp_catalog.origin_decimal(p->'pesoLiquido'),'gross_weight',erp_catalog.origin_decimal(p->'pesoBruto'),
   'volumes',erp_catalog.origin_count(p->'volumes'),'items_per_box',erp_catalog.origin_count(p->'itensPorCaixa'),
   'width',erp_catalog.origin_decimal(p#>'{dimensoes,largura}'),'height',erp_catalog.origin_decimal(p#>'{dimensoes,altura}'),'depth',erp_catalog.origin_decimal(p#>'{dimensoes,profundidade}'),
   'stock_min',erp_catalog.origin_decimal(p#>'{estoque,minimo}'),'stock_max',erp_catalog.origin_decimal(p#>'{estoque,maximo}'),
   'complementary_description',erp_catalog.origin_text(p->'descricaoComplementar',4000),'notes',erp_catalog.origin_text(p->'observacoes',2000),
   'additional_info',erp_catalog.origin_text(p#>'{tributacao,dadosAdicionais}',2000),
   'variations',case when jsonb_typeof(p->'variacoes')='array' then jsonb_array_length(p->'variacoes')::text end);
 end if;
 if p ? '_brufap_source' and jsonb_typeof(p->'_brufap_source')='object' and p#>'{_brufap_source,deleted}'='true'::jsonb then
  function_result:=function_result||'{"detail_available":"false","listed_as_deleted":"true"}'::jsonb;
 end if;
 return jsonb_strip_nulls(function_result);
end $$;

create table erp_catalog.origin_mirror(
 entity text not null check(entity in('contacts','products')),
 source_id text not null check(length(source_id) between 1 and 200),
 record_id uuid not null unique,
 applied_hash text not null check(applied_hash~'^[0-9a-f]{64}$'),
 latest_hash text not null check(latest_hash~'^[0-9a-f]{64}$'),
 fields jsonb not null check(jsonb_typeof(fields)='object'),
 source_updated_at timestamptz,
 synced_at timestamptz not null default clock_timestamp(),
 primary key(entity,source_id),
 foreign key(record_id,entity) references erp_catalog.record(id,entity)
);
comment on table erp_catalog.origin_mirror is 'Campos do Origin v3 aplicados a cada cadastro sincronizado (leva H, 350); derivado de origin.applied_hash e source_snapshot. Complementos do Brufap ficam em contact_profile, product_detail e contact_role_complement.';

-- Complemento controlado do Brufap: o papel Transportador de um contato, sem tocar no cadastro espelhado.
create table erp_catalog.contact_role_complement(
 record_id uuid not null,entity text not null default 'contacts' check(entity='contacts'),
 role text not null check(role='carrier'),
 created_by uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp(),
 primary key(record_id,role),
 foreign key(record_id,entity) references erp_catalog.record(id,entity)
);
do $$ declare t text; begin foreach t in array array['origin_mirror','contact_role_complement'] loop
 execute format('alter table erp_catalog.%I enable row level security',t);
 execute format('revoke all on erp_catalog.%I from public,anon,authenticated,service_role',t); end loop; end $$;

-- Mantém o espelho a partir da origem: o snapshot aplicado define os campos; latest_hash mostra um dado novo ainda pendente.
create function erp_catalog.origin_mirror_refresh() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_payload jsonb; v_updated timestamptz;
begin
 if new.applied_hash is null then
  update erp_catalog.origin_mirror set latest_hash=new.latest_hash where entity=new.entity and source_id=new.source_id;
  return null;
 end if;
 if tg_op='UPDATE' and old.applied_hash is not distinct from new.applied_hash and old.record_id=new.record_id
  and exists(select 1 from erp_catalog.origin_mirror m where m.entity=new.entity and m.source_id=new.source_id) then
  update erp_catalog.origin_mirror set latest_hash=new.latest_hash where entity=new.entity and source_id=new.source_id and latest_hash is distinct from new.latest_hash;
  return null;
 end if;
 select payload into v_payload from erp_catalog.source_snapshot where entity=new.entity and source_id=new.source_id and source_hash=new.applied_hash;
 select source_updated_at into v_updated from origin_sync.raw_record where entity=new.entity and source_id=new.source_id and version_hash=new.applied_hash;
 insert into erp_catalog.origin_mirror(entity,source_id,record_id,applied_hash,latest_hash,fields,source_updated_at,synced_at)
 values(new.entity,new.source_id,new.record_id,new.applied_hash,new.latest_hash,erp_catalog.origin_mirror_fields(new.entity,v_payload),v_updated,clock_timestamp())
 on conflict(entity,source_id) do update set record_id=excluded.record_id,latest_hash=excluded.latest_hash,
  applied_hash=excluded.applied_hash,fields=excluded.fields,source_updated_at=coalesce(excluded.source_updated_at,origin_mirror.source_updated_at),
  synced_at=case when origin_mirror.applied_hash=excluded.applied_hash then origin_mirror.synced_at else excluded.synced_at end;
 return null;
end $$;
create trigger erp_catalog_origin_origin_mirror after insert or update on erp_catalog.origin
 for each row execute function erp_catalog.origin_mirror_refresh();

-- Cadastros já sincronizados: o espelho nasce do snapshot aplicado (a data da sincronização é a da captura desse snapshot).
insert into erp_catalog.origin_mirror(entity,source_id,record_id,applied_hash,latest_hash,fields,source_updated_at,synced_at)
select o.entity,o.source_id,o.record_id,o.applied_hash,o.latest_hash,erp_catalog.origin_mirror_fields(o.entity,s.payload),r.source_updated_at,s.captured_at
from erp_catalog.origin o join erp_catalog.source_snapshot s on s.entity=o.entity and s.source_id=o.source_id and s.source_hash=o.applied_hash
left join origin_sync.raw_record r on r.entity=o.entity and r.source_id=o.source_id and r.version_hash=o.applied_hash
where o.applied_hash is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 044 plus the widened product fields and the contact roles. A field is sent only when the Origin sends it: present and
-- valid → the value; present and empty → null (cleared in the Origin); invalid → left out (kept only in the mirror).
create or replace function erp_catalog.map_origin(p_entity text,p_payload jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_data jsonb; v_address jsonb; v_ncm jsonb; v_extra jsonb:='{}'; v_pair record; v_text text; v_roles jsonb;
begin
  v_data:=jsonb_build_object('name',p_payload->'nome','code',p_payload->'codigo');
  if p_entity='contacts' then
    v_address:=p_payload#>'{endereco,geral}';
    v_roles:=coalesce(erp_catalog.origin_contact_roles(p_payload),'[]'::jsonb);
    v_data:=v_data||jsonb_build_object('trade_name',p_payload->'fantasia','person_type',p_payload->'tipo',
      'document',p_payload->'numeroDocumento','ie',p_payload->'ie','email',p_payload->'email',
      'phone',p_payload->'telefone','mobile',p_payload->'celular','postal_code',v_address->'cep',
      'street',v_address->'endereco','number',v_address->'numero','complement',v_address->'complemento',
      'district',v_address->'bairro','city',v_address->'municipio','state',v_address->'uf','roles',v_roles);
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
    -- 350: the widened fields of the Origin detail (name, Origin path, kind).
    for v_pair in select * from (values
      ('brand','{marca}','text100'),('condition','{condicao}','condition'),('production','{tipoProducao}','production'),
      ('net_weight','{pesoLiquido}','decimal'),('gross_weight','{pesoBruto}','decimal'),
      ('width','{dimensoes,largura}','decimal'),('height','{dimensoes,altura}','decimal'),('depth','{dimensoes,profundidade}','decimal'),
      ('dimension_unit','{dimensoes,unidadeMedida}','dimension_unit'),('volumes','{volumes}','count'),('items_per_box','{itensPorCaixa}','count'),
      ('gtin_tax','{gtinEmbalagem}','gtin'),('stock_min','{estoque,minimo}','decimal'),('stock_max','{estoque,maximo}','decimal'),
      ('location','{estoque,localizacao}','text100'),('cest','{tributacao,cest}','cest'),('origin','{tributacao,origem}','origin'),
      ('additional_info','{tributacao,dadosAdicionais}','text2000')) x(field,path,kind) loop
      if p_payload#>v_pair.path::text[] is null then continue; end if;
      if p_payload#>v_pair.path::text[]='null'::jsonb or (jsonb_typeof(p_payload#>v_pair.path::text[])='string' and btrim(p_payload#>>v_pair.path::text[])='') then
        -- Weights and stock limits come as 0 when empty in the Origin; an empty text is a cleared field.
        v_extra:=v_extra||jsonb_build_object(v_pair.field,null); continue; end if;
      v_text:=case v_pair.kind
        when 'decimal' then erp_catalog.origin_decimal(p_payload#>v_pair.path::text[])
        when 'count' then erp_catalog.origin_count(p_payload#>v_pair.path::text[])
        when 'condition' then case erp_catalog.origin_text(p_payload#>v_pair.path::text[],2) when '0' then 'unspecified' when '1' then 'new' when '2' then 'used' when '3' then 'refurbished' end
        when 'production' then case erp_catalog.origin_text(p_payload#>v_pair.path::text[],1) when 'P' then 'own' when 'T' then 'third_party' end
        when 'dimension_unit' then case erp_catalog.origin_text(p_payload#>v_pair.path::text[],2) when '0' then 'm' when '1' then 'cm' when '2' then 'mm' end
        when 'gtin' then case when erp_catalog.origin_text(p_payload#>v_pair.path::text[],20)~'^([0-9]{8}|[0-9]{12,14})$' or erp_catalog.origin_text(p_payload#>v_pair.path::text[],20)='SEM GTIN'
          then erp_catalog.origin_text(p_payload#>v_pair.path::text[],20) end
        when 'cest' then case when regexp_replace(coalesce(erp_catalog.origin_text(p_payload#>v_pair.path::text[],20),''),'[^0-9]','','g')~'^[0-9]{7}$'
          then regexp_replace(erp_catalog.origin_text(p_payload#>v_pair.path::text[],20),'[^0-9]','','g') end
        when 'origin' then case when erp_catalog.origin_text(p_payload#>v_pair.path::text[],2)~'^[0-8]$' then erp_catalog.origin_text(p_payload#>v_pair.path::text[],2) end
        when 'text100' then case when jsonb_typeof(p_payload#>v_pair.path::text[])='string' and length(btrim(p_payload#>>v_pair.path::text[]))<=100
          and btrim(p_payload#>>v_pair.path::text[])!~'[[:cntrl:]]' then btrim(p_payload#>>v_pair.path::text[]) end
        when 'text2000' then case when jsonb_typeof(p_payload#>v_pair.path::text[])='string' and length(btrim(p_payload#>>v_pair.path::text[]))<=2000
          and translate(btrim(p_payload#>>v_pair.path::text[]),E'\n\r\t','')!~'[[:cntrl:]]' then btrim(p_payload#>>v_pair.path::text[]) end end;
      if v_text is not null then v_extra:=v_extra||jsonb_build_object(v_pair.field,v_text); end if;
    end loop;
    -- Both stock limits only when they keep min <= max (the table constraint).
    if v_extra?'stock_min' and v_extra?'stock_max' and (v_extra->>'stock_min')::numeric>(v_extra->>'stock_max')::numeric then
      v_extra:=v_extra-'stock_min'-'stock_max'; end if;
    v_data:=v_data||v_extra;
  else raise exception 'erp_catalog_invalid_import_entity' using errcode='22023'; end if;
  return erp_catalog.validate_data(p_entity,v_data,true);
end $$;
revoke all on function erp_catalog.map_origin(text,jsonb) from public,anon,authenticated,service_role;

-- 013 plus the widened product fields in the review of the import (Prévia).
create or replace function erp_catalog.import_changes(p_entity text,p_before jsonb,p_after jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_field text; v_redacted boolean; v_result jsonb:='[]'; v_before jsonb; v_after jsonb;
begin
 for v_field in select value from jsonb_array_elements_text(case when p_entity='contacts' then
  '["name","code","active","trade_name","person_type","document","ie","email","phone","mobile","postal_code","street","number","complement","district","city","state","roles"]'::jsonb
  else '["name","code","active","unit","price","kind","format","description","ncm","gtin","brand","condition","production","net_weight","gross_weight","width","height","depth","dimension_unit","volumes","items_per_box","gtin_tax","stock_min","stock_max","location","cest","origin","additional_info"]'::jsonb end) loop
  -- 350: a widened field the source does not send keeps the local value (write_fields), so it is not a change.
  if p_entity='products' and v_field not in('name','code','active','unit','price','kind','format','description','ncm','gtin') and not p_after?v_field then continue; end if;
  v_before:=coalesce(p_before->v_field,'null'::jsonb);v_after:=coalesce(p_after->v_field,'null'::jsonb);
  if v_before is distinct from v_after then
   v_redacted:=v_field in ('document','ie','email','phone','mobile','postal_code','street','number','complement','district');
   v_result:=v_result||jsonb_build_array(jsonb_build_object('field',v_field,'redacted',v_redacted,
    'before',case when v_redacted then null else v_before end,'after',case when v_redacted then null else v_after end));
  end if;
 end loop;
 return v_result;
end $$;
revoke all on function erp_catalog.import_changes(text,jsonb,jsonb) from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- EST-057: who counts as transportador (papel do cadastro, tipo Transportador no Origin ou complemento do Brufap).
create function erp_catalog.contact_carrier_match(p_id uuid) returns text
language sql stable set search_path=pg_catalog as $$
 select case when exists(select 1 from erp_catalog.contact c where c.record_id=p_id and 'carrier'=any(c.roles)) then 'role'
  when exists(select 1 from erp_catalog.origin_mirror m where m.record_id=p_id and m.entity='contacts' and m.fields->'source_roles' ? 'carrier') then 'origin'
  when exists(select 1 from erp_catalog.contact_role_complement x where x.record_id=p_id and x.role='carrier') then 'complement'
  when exists(select 1 from erp_catalog.contact c where c.record_id=p_id and cardinality(c.roles)=0) then 'untyped' end
$$;

-- 241 plus: for the Transportador, the transportadores first (papel, Origin, complemento) and then the contacts without type.
create or replace function public.erp_catalog_contact_options(p_user_id uuid,p_query text default null,p_role text default null,p_city text default null,p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_terms text[]; v_scope uuid; v_city text:=nullif(btrim(p_city),''); v_ids uuid[];
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_limit is null or p_limit not between 1 and 50 or(p_query is not null and(length(p_query)>120 or p_query~'[[:cntrl:]]'))
  or(p_role is not null and p_role not in('customer','supplier','carrier')) or(p_city is not null and(length(p_city)>100 or p_city~'[[:cntrl:]]')) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_scope:=erp_catalog.contact_scope(p_user_id); v_terms:=erp_catalog.search_terms(p_query);
 select array(select r.id from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id left join erp_catalog.contact_profile cp on cp.record_id=r.id
  cross join lateral(select case when p_role='carrier' then erp_catalog.contact_carrier_match(r.id) end carrier) m
  where r.entity='contacts' and r.active and(v_scope is null or cp.seller_id=v_scope)
   and(p_role is null or p_role=any(c.roles) or(p_role='carrier' and m.carrier is not null))
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code,c.trade_name,c.email,c.document,c.phone,c.mobile)),
    regexp_replace(lower(coalesce(c.document,'')),'[^0-9a-z]','','g'),regexp_replace(concat_ws('|',c.document,c.phone,c.mobile,cp.fax),'[^0-9|]','','g')))
   and(v_city is null or strpos(erp_catalog.fold(coalesce(c.city,'')),erp_catalog.fold(v_city))>0)
  order by case when m.carrier='untyped' then 1 else 0 end,erp_catalog.fold(r.name),r.id limit p_limit+1) into v_ids;
 return jsonb_build_object('scope','contact_options','data_mode','erp_native','role',p_role,'limit',p_limit,'scoped',v_scope is not null,
  'has_more',cardinality(v_ids)>p_limit,
  'items',(select coalesce(jsonb_agg(erp_catalog.contact_option_item(u.id)||case when p_role='carrier' then jsonb_build_object('carrier_match',erp_catalog.contact_carrier_match(u.id)) else '{}'::jsonb end
    order by u.n),'[]'::jsonb) from unnest(v_ids[1:p_limit]) with ordinality u(id,n)));
end $$;

-- Marcar ou desmarcar o complemento Transportador (Cadastros com gravação; respeita a carteira do vendedor).
create function public.erp_catalog_contact_carrier_complement(p_user_id uuid,p_contact_id uuid,p_carrier boolean,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_scope uuid; v_before boolean; v_result jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_contact_id is null or p_carrier is null or p_command_id is null then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','contact_carrier_complement','id',p_contact_id,'carrier',p_carrier)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 v_scope:=erp_catalog.contact_scope(p_user_id);
 perform 1 from erp_catalog.record r left join erp_catalog.contact_profile cp on cp.record_id=r.id
  where r.id=p_contact_id and r.entity='contacts' and(v_scope is null or cp.seller_id=v_scope) for key share of r;
 if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 v_before:=exists(select 1 from erp_catalog.contact_role_complement where record_id=p_contact_id and role='carrier');
 if p_carrier and not v_before then
  insert into erp_catalog.contact_role_complement(record_id,role,created_by) values(p_contact_id,'carrier',p_user_id);
 elsif not p_carrier and v_before then
  delete from erp_catalog.contact_role_complement where record_id=p_contact_id and role='carrier';
 end if;
 if p_carrier is distinct from v_before then
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
   values(p_user_id,p_command_id,'contacts',p_contact_id,'carrier_complement',jsonb_build_object('carrier_complement',v_before),jsonb_build_object('carrier_complement',p_carrier));
 end if;
 v_result:=jsonb_build_object('scope','contact_carrier_complement','id',p_contact_id,'carrier_complement',p_carrier,
  'carrier_match',erp_catalog.contact_carrier_match(p_contact_id),'changed',p_carrier is distinct from v_before,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- "Dados do Origin" de um cadastro: os campos espelhados, a origem, a data da sincronização, se há dado novo pendente e quais
-- complementos exclusivos do Brufap estão preenchidos. Leitura de quem lê o cadastro (a carteira do vendedor vale para contatos).
create function public.erp_catalog_origin_mirror_get(p_user_id uuid,p_entity text,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_scope uuid; m erp_catalog.origin_mirror%rowtype; o erp_catalog.origin%rowtype; v_raw origin_sync.raw_record%rowtype; v_local jsonb:='[]'; v_category jsonb;
begin
 if p_entity is null or p_entity not in('contacts','products') or p_id is null then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 perform erp_catalog.require_access(p_user_id,p_entity,false);
 if p_entity='contacts' then
  v_scope:=erp_catalog.contact_scope(p_user_id);
  perform 1 from erp_catalog.record r left join erp_catalog.contact_profile cp on cp.record_id=r.id where r.id=p_id and r.entity='contacts' and(v_scope is null or cp.seller_id=v_scope);
 else perform 1 from erp_catalog.record r where r.id=p_id and r.entity='products'; end if;
 if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 select * into o from erp_catalog.origin where record_id=p_id;
 select * into m from erp_catalog.origin_mirror where record_id=p_id;
 if o.source_id is not null then select * into v_raw from origin_sync.raw_record where entity=p_entity and source_id=o.source_id; end if;
 if p_entity='contacts' then
  select coalesce(jsonb_agg(k order by k),'[]'::jsonb) into v_local from erp_catalog.contact_profile cp
   cross join lateral jsonb_each(to_jsonb(cp)-'record_id'-'version'-'updated_at'-'updated_by'-'created_at'-'created_by') e(k,v)
   where cp.record_id=p_id and e.v not in('null'::jsonb,'""'::jsonb,'false'::jsonb,'[]'::jsonb,'{}'::jsonb);
  if exists(select 1 from erp_catalog.contact_role_complement where record_id=p_id) then v_local:=v_local||'["carrier_complement"]'::jsonb; end if;
 else
  select coalesce(jsonb_agg(k order by k),'[]'::jsonb) into v_local from erp_catalog.product_detail d
   cross join lateral jsonb_each(to_jsonb(d)-'record_id'-'category_kind'-'product_group_kind'-'deleted_at'-'deleted_by') e(k,v)
   where d.record_id=p_id and e.v not in('null'::jsonb,'""'::jsonb,'false'::jsonb,'[]'::jsonb,'{}'::jsonb);
 end if;
 return jsonb_build_object('scope','origin_mirror','entity',p_entity,'id',p_id,'data_mode','erp_native','system','origin',
  'linked',o.source_id is not null,'source_id',o.source_id,'state',o.state,
  'synced_at',m.synced_at,'source_updated_at',m.source_updated_at,'source_seen_at',v_raw.last_seen_at,
  'pending',o.source_id is not null and (o.applied_hash is distinct from o.latest_hash or (v_raw.version_hash is not null and v_raw.version_hash is distinct from o.applied_hash)),
  'fields',coalesce(m.fields,'{}'::jsonb),'local_complements',coalesce(v_local,'[]'::jsonb));
end $$;

revoke all on function erp_catalog.origin_text(jsonb,integer),erp_catalog.origin_decimal(jsonb),erp_catalog.origin_count(jsonb),erp_catalog.origin_contact_roles(jsonb),
 erp_catalog.origin_mirror_fields(text,jsonb),erp_catalog.origin_mirror_refresh(),erp_catalog.contact_carrier_match(uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_contact_options(uuid,text,text,text,integer)','erp_catalog_contact_carrier_complement(uuid,uuid,boolean,uuid)','erp_catalog_origin_mirror_get(uuid,text,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
