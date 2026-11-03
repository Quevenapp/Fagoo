-- 216: Naturezas de operação no padrão Origin, onda D — regra por "Grupo de Produtos".
-- O modal da regra do Origin oferece, em "Quando for", Qualquer produto, NCM, Produto ou Grupo de Produtos (até 10 por regra).
-- 1. nature_rule.group_ids (grupos do cadastro de produtos, erp_catalog.taxonomy kind product_groups) com product_scope 'groups';
--    a regra de grupo vale para o produto daquele grupo (sem herdar subgrupos). Uma regra de produto listado continua mais
--    específica; a de grupo vem antes da de NCM e da de qualquer produto (proposta de precedência para revisão do contador).
-- 2. As regras só trazem group_ids/groups quando o escopo é de grupo: as naturezas que já existem voltam iguais e o Worker
--    anterior continua lendo-as.
-- 3. erp_fiscal_invoice_product_groups: o grupo de cada produto dos itens, para o cálculo automático do formulário da nota
--    (admin e fiscal, até 100 produtos por consulta). erp_fiscal_tax_estimate_context_v2: o contexto da estimativa de IPI/ICMS ST
--    dos pedidos e propostas com o grupo de cada produto (a versão anterior fica como estava para o Worker anterior).
-- Clonar Operação (erp_fiscal_nature_execute, 141) copia os grupos. Nada aqui emite, transmite ou lança estoque/contas.
-- Requer as migrações publicadas até 202610200190 (111, 141, 176 e o cadastro de produtos de 119).
begin;

do $$declare v record;begin
 if to_regclass('erp_catalog.taxonomy') is null or to_regclass('erp_catalog.product_detail') is null then raise exception 'fiscal_nature_216_requires_119' using errcode='55000'; end if;
 for v in select * from(values
  ('erp_fiscal_invoices.nature_rule_input(jsonb,text,text)','9ab1df2a60fc35000f2ab929d56a88ad0608a9523f576bfce62b8f2c3b949b05'),
  ('erp_fiscal_invoices.nature_record(uuid)','4bb97479a2082adab0214805ddb1f4db714e7055bff3a7a33ec53d9a99bdcc84'),
  ('erp_fiscal_invoices.replace_rules(uuid,jsonb)','d4745cb6798842b3feae91fbe39beca823bf09ca517cdcf1d83fffcf7a20ab1d'),
  ('public.erp_fiscal_nature_execute(uuid,uuid,text,jsonb)','8aa916cdbae6c6d6e0041f088281d3f1caaba7f19780160e4d314c4c02c34c20'),
  ('public.erp_fiscal_tax_estimate_context(uuid,text,uuid,jsonb)','7952108f8b952136b19ef91f3f28ecc5f4c277957bc87f7d857ade5002a4a75b'))v(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'fiscal_nature_216_previous_definition_changed' using errcode='55000',detail=v.sig; end if;
 end loop;
end$$;

alter table erp_fiscal_invoices.nature_rule add column group_ids uuid[] not null default '{}';
-- The scope checks of 111 are replaced by the same rules plus 'groups' (found by definition, not by a generated name).
do $$declare c record;begin
 for c in select conname from pg_constraint where conrelid='erp_fiscal_invoices.nature_rule'::regclass and contype='c' and pg_get_constraintdef(oid) like '%product_scope%' loop
  execute format('alter table erp_fiscal_invoices.nature_rule drop constraint %I',c.conname);
 end loop;
end$$;
alter table erp_fiscal_invoices.nature_rule add constraint nature_rule_scope check(
 (product_scope='any' and cardinality(ncms)=0 and cardinality(product_ids)=0 and cardinality(group_ids)=0)
 or(product_scope='ncm' and cardinality(ncms) between 1 and 10 and cardinality(product_ids)=0 and cardinality(group_ids)=0)
 or(product_scope='products' and cardinality(product_ids) between 1 and 10 and cardinality(ncms)=0 and cardinality(group_ids)=0)
 or(product_scope='groups' and cardinality(group_ids) between 1 and 10 and cardinality(ncms)=0 and cardinality(product_ids)=0));

-- 111 plus "Grupo de Produtos": group_ids of erp_catalog.taxonomy (kind product_groups), up to 10, only with the groups scope.
create or replace function erp_fiscal_invoices.nature_rule_input(p_rule jsonb,p_crt text,p_direction text) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare tax text;spec jsonb;data jsonb;dest text[];scope text;ncms text[];products uuid[];groups uuid[];v text;
begin
 if p_rule is null or jsonb_typeof(p_rule)<>'object' or exists(select 1 from jsonb_object_keys(p_rule) k
  where k not in('tax','destinations','product_scope','ncms','product_ids','group_ids','data','additional_info','fiscal_info')) then
  raise exception 'erp_fiscal_rule_invalid' using errcode='22023'; end if;
 tax:=p_rule->>'tax';
 if jsonb_typeof(p_rule->'tax') is distinct from 'string' or tax not in('icms','ipi','pis','cofins','ii') then raise exception 'erp_fiscal_rule_invalid' using errcode='22023'; end if;
 spec:=erp_fiscal_invoices.nature_specs()->'rules'->(case when tax='icms' then case when p_crt='3' then 'icms_normal' else 'icms_sn' end else tax end);
 data:=erp_fiscal_invoices.spec_object(p_rule->'data',spec);
 if not data?'situation' then raise exception 'erp_fiscal_rule_situation_required' using errcode='22023'; end if;
 if tax='ipi' and not erp_fiscal_invoices.ipi_situation_allowed(p_direction,data->>'situation') then raise exception 'erp_fiscal_rule_situation_invalid' using errcode='22023'; end if;
 if jsonb_typeof(coalesce(p_rule->'destinations','[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_rule->'destinations','[]'::jsonb))>28 then raise exception 'erp_fiscal_rule_invalid' using errcode='22023'; end if;
 select coalesce(array_agg(x order by x),'{}') into dest from jsonb_array_elements_text(coalesce(p_rule->'destinations','[]'::jsonb)) x;
 if exists(select 1 from jsonb_array_elements(coalesce(p_rule->'destinations','[]'::jsonb)) x where jsonb_typeof(x)<>'string')
  or exists(select 1 from unnest(dest) d where not d=any(erp_fiscal_invoices.ufs()||array['EX']))
  or cardinality(dest)<>(select count(distinct d) from unnest(dest) d) then raise exception 'erp_fiscal_rule_destination_invalid' using errcode='22023'; end if;
 scope:=coalesce(p_rule->>'product_scope','any');
 if scope not in('any','ncm','products','groups') then raise exception 'erp_fiscal_rule_invalid' using errcode='22023'; end if;
 if jsonb_typeof(coalesce(p_rule->'ncms','[]'::jsonb))<>'array' or jsonb_typeof(coalesce(p_rule->'product_ids','[]'::jsonb))<>'array' or jsonb_typeof(coalesce(p_rule->'group_ids','[]'::jsonb))<>'array'
  or jsonb_array_length(coalesce(p_rule->'ncms','[]'::jsonb))>10 or jsonb_array_length(coalesce(p_rule->'product_ids','[]'::jsonb))>10 or jsonb_array_length(coalesce(p_rule->'group_ids','[]'::jsonb))>10 then
  raise exception 'erp_fiscal_rule_product_invalid' using errcode='22023'; end if;
 select coalesce(array_agg(x order by x),'{}') into ncms from jsonb_array_elements_text(coalesce(p_rule->'ncms','[]'::jsonb)) x;
 if exists(select 1 from unnest(ncms) n where n !~ '^[0-9]{2}([0-9]{2}){0,3}$') or cardinality(ncms)<>(select count(distinct n) from unnest(ncms) n) then
  raise exception 'erp_fiscal_rule_product_invalid' using errcode='22023'; end if;
 select coalesce(array_agg(erp_fiscal_invoices.uuid_input(x) order by x::text),'{}') into products from jsonb_array_elements(coalesce(p_rule->'product_ids','[]'::jsonb)) x;
 if cardinality(products)<>(select count(distinct p) from unnest(products) p)
  or exists(select 1 from unnest(products) p where not exists(select 1 from erp_catalog.record r where r.id=p and r.entity='products')) then
  raise exception 'erp_fiscal_rule_product_invalid' using errcode='22023'; end if;
 select coalesce(array_agg(erp_fiscal_invoices.uuid_input(x) order by x::text),'{}') into groups from jsonb_array_elements(coalesce(p_rule->'group_ids','[]'::jsonb)) x;
 if cardinality(groups)<>(select count(distinct g) from unnest(groups) g)
  or exists(select 1 from unnest(groups) g where not exists(select 1 from erp_catalog.taxonomy t where t.id=g and t.kind='product_groups')) then
  raise exception 'erp_fiscal_rule_group_invalid' using errcode='22023'; end if;
 if (scope='any' and (cardinality(ncms)>0 or cardinality(products)>0 or cardinality(groups)>0)) or (scope='ncm' and (cardinality(ncms)=0 or cardinality(products)>0 or cardinality(groups)>0))
  or (scope='products' and (cardinality(products)=0 or cardinality(ncms)>0 or cardinality(groups)>0)) or (scope='groups' and (cardinality(groups)=0 or cardinality(ncms)>0 or cardinality(products)>0)) then
  raise exception 'erp_fiscal_rule_product_invalid' using errcode='22023'; end if;
 return jsonb_build_object('tax',tax,'destinations',to_jsonb(dest),'product_scope',scope,'ncms',to_jsonb(ncms),'product_ids',to_jsonb(products),'data',data,
  'additional_info',erp_fiscal_invoices.text_input(p_rule->'additional_info',2000,false,true),'fiscal_info',erp_fiscal_invoices.text_input(p_rule->'fiscal_info',2000,false,true))
  ||case when scope='groups' then jsonb_build_object('group_ids',to_jsonb(groups)) else '{}'::jsonb end;
end $$;

-- 111 plus the groups of a "Grupo de Produtos" rule (ids and names); other rules come back exactly as before.
create or replace function erp_fiscal_invoices.nature_record(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',n.id,'description',n.description,'series',n.series,'direction',n.direction,'crt',n.crt,'presence',n.presence,'invoiced',n.invoiced,
  'final_consumer',n.final_consumer,'return_operation',n.return_operation,'update_last_purchase_price',n.update_last_purchase_price,'include_freight_ipi_base',n.include_freight_ipi_base,
  'others',n.others,'retentions',n.retentions,'additional_info',n.additional_info,'fiscal_info',n.fiscal_info,'active',n.active,'version',n.version,
  'created_at',n.created_at,'updated_at',n.updated_at,
  'rules',coalesce((select jsonb_agg(jsonb_build_object('tax',r.tax,'position',r.position,'destinations',to_jsonb(r.destinations),'product_scope',r.product_scope,
    'ncms',to_jsonb(r.ncms),'product_ids',to_jsonb(r.product_ids),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'code',c.code) order by c.name,c.id) from erp_catalog.record c where c.id=any(r.product_ids)),'[]'::jsonb),
    'data',r.data,'additional_info',r.additional_info,'fiscal_info',r.fiscal_info)
    ||case when r.product_scope='groups' then jsonb_build_object('group_ids',to_jsonb(r.group_ids),
     'groups',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) order by t.name,t.id) from erp_catalog.taxonomy t where t.id=any(r.group_ids)),'[]'::jsonb)) else '{}'::jsonb end
    order by array_position(array['icms','ipi','pis','cofins','ii'],r.tax),r.position)
   from erp_fiscal_invoices.nature_rule r where r.nature_id=n.id),'[]'::jsonb),
  'defaults',coalesce((select jsonb_agg(d.code order by d.code) from erp_fiscal_invoices.nature_default d where d.nature_id=n.id),'[]'::jsonb))
 from erp_fiscal_invoices.nature n where n.id=p_id
$$;

create or replace function erp_fiscal_invoices.replace_rules(p_id uuid,p_rules jsonb) returns void language plpgsql set search_path=pg_catalog as $$
declare r jsonb;pos integer;
begin
 delete from erp_fiscal_invoices.nature_rule where nature_id=p_id;
 for r in select value from jsonb_array_elements(p_rules) loop
  select coalesce(max(position),0)+1 into pos from erp_fiscal_invoices.nature_rule where nature_id=p_id and tax=r->>'tax';
  insert into erp_fiscal_invoices.nature_rule(nature_id,tax,position,destinations,product_scope,ncms,product_ids,group_ids,data,additional_info,fiscal_info)
  values(p_id,r->>'tax',pos,array(select jsonb_array_elements_text(r->'destinations')),r->>'product_scope',array(select jsonb_array_elements_text(r->'ncms')),
   array(select jsonb_array_elements_text(r->'product_ids')::uuid),array(select jsonb_array_elements_text(coalesce(r->'group_ids','[]'::jsonb))::uuid),r->'data',r->>'additional_info',r->>'fiscal_info');
 end loop;
end $$;

-- 141 with "Clonar Operação" copying the groups of the rules.
create or replace function public.erp_fiscal_nature_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare h text;replay jsonb;keys text[];v_id uuid;expected integer;n erp_fiscal_invoices.nature%rowtype;input jsonb;rec jsonb;result jsonb;v_code text;bumped boolean:=true;
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_action is null or p_action not in('create','update','clone','set_active','set_default','delete') or p_data is null
  or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>262144 then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 keys:=case p_action when 'create' then array['nature'] when 'update' then array['id','expected_version','nature'] when 'clone' then array['id','expected_version']
  when 'set_active' then array['id','expected_version','active'] when 'delete' then array['id','expected_version'] else array['id','expected_version','code'] end;
 if exists(select 1 from jsonb_object_keys(p_data) k where not k=any(keys)) or exists(select 1 from unnest(keys) k where not p_data?k) then
  raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 if p_action='create' or p_action='update' then input:=erp_fiscal_invoices.nature_input(p_data->'nature'); end if;
 if p_action<>'create' then v_id:=erp_fiscal_invoices.uuid_input(p_data->'id');expected:=erp_fiscal_invoices.version_input(p_data->'expected_version'); end if;
 if p_action='set_active' and jsonb_typeof(p_data->'active') is distinct from 'boolean' then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 if p_action='set_default' then
  v_code:=p_data->>'code';
  if jsonb_typeof(p_data->'code') is distinct from 'string' or v_code not in('S','E','VF','VJ','CF','CJ','C','DE','DS') then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 end if;
 h:=erp_fiscal_invoices.command_hash(p_user_id,'nature',p_action,p_data);
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'nature',h);
 if replay is not null then return replay; end if;
 if p_action<>'create' then
  select * into n from erp_fiscal_invoices.nature where id=v_id for update;
  if not found or n.deleted_at is not null then raise exception 'erp_fiscal_nature_not_found' using errcode='P0002'; end if;
  if n.version<>expected or n.version=2147483647 then raise exception 'erp_fiscal_nature_version_conflict' using errcode='40001'; end if;
 end if;
 if p_action='update' and input->>'direction'<>n.direction then raise exception 'erp_fiscal_nature_direction_immutable' using errcode='22023'; end if;
 if p_action='create' then
  insert into erp_fiscal_invoices.nature(description,series,direction,crt,presence,invoiced,final_consumer,return_operation,update_last_purchase_price,include_freight_ipi_base,
   others,retentions,additional_info,fiscal_info,created_by,updated_by)
  values(input->>'description',(input->>'series')::integer,input->>'direction',input->>'crt',input->>'presence',(input->>'invoiced')::boolean,(input->>'final_consumer')::boolean,
   (input->>'return_operation')::boolean,(input->>'update_last_purchase_price')::boolean,(input->>'include_freight_ipi_base')::boolean,input->'others',input->'retentions',
   input->>'additional_info',input->>'fiscal_info',p_user_id,p_user_id) returning id into v_id;
  perform erp_fiscal_invoices.replace_rules(v_id,input->'rules');
 elsif p_action='update' then
  update erp_fiscal_invoices.nature set description=input->>'description',series=(input->>'series')::integer,crt=input->>'crt',presence=input->>'presence',
   invoiced=(input->>'invoiced')::boolean,final_consumer=(input->>'final_consumer')::boolean,return_operation=(input->>'return_operation')::boolean,
   update_last_purchase_price=(input->>'update_last_purchase_price')::boolean,include_freight_ipi_base=(input->>'include_freight_ipi_base')::boolean,
   others=input->'others',retentions=input->'retentions',additional_info=input->>'additional_info',fiscal_info=input->>'fiscal_info',
   version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  perform erp_fiscal_invoices.replace_rules(v_id,input->'rules');
 elsif p_action='clone' then
  insert into erp_fiscal_invoices.nature(description,series,direction,crt,presence,invoiced,final_consumer,return_operation,update_last_purchase_price,include_freight_ipi_base,
   others,retentions,additional_info,fiscal_info,created_by,updated_by)
  values(left('Cópia de '||n.description,60),n.series,n.direction,n.crt,n.presence,n.invoiced,n.final_consumer,n.return_operation,n.update_last_purchase_price,
   n.include_freight_ipi_base,n.others,n.retentions,n.additional_info,n.fiscal_info,p_user_id,p_user_id) returning id into v_id;
  insert into erp_fiscal_invoices.nature_rule(nature_id,tax,position,destinations,product_scope,ncms,product_ids,group_ids,data,additional_info,fiscal_info)
  select v_id,tax,position,destinations,product_scope,ncms,product_ids,group_ids,data,additional_info,fiscal_info from erp_fiscal_invoices.nature_rule where nature_id=n.id;
 elsif p_action='set_active' then
  if n.active=(p_data->>'active')::boolean then raise exception 'erp_fiscal_nature_state_conflict' using errcode='40001'; end if;
  update erp_fiscal_invoices.nature set active=(p_data->>'active')::boolean,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  if not (p_data->>'active')::boolean then delete from erp_fiscal_invoices.nature_default where nature_id=v_id; end if;
 elsif p_action='delete' then
  -- Logical deletion: notes that used the nature keep its description and the revisions keep its rules.
  delete from erp_fiscal_invoices.nature_default where nature_id=v_id;
  update erp_fiscal_invoices.nature set active=false,deleted_at=clock_timestamp(),deleted_by=p_user_id,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 else
  if not n.active then raise exception 'erp_fiscal_nature_inactive' using errcode='40001'; end if;
  if (case when v_code in('S','VF','VJ','C','DS') then '1' else '0' end)<>n.direction then raise exception 'erp_fiscal_nature_default_direction' using errcode='22023'; end if;
  if exists(select 1 from erp_fiscal_invoices.nature_default where code=p_data->>'code' and nature_id=v_id) then raise exception 'erp_fiscal_nature_state_conflict' using errcode='40001'; end if;
  insert into erp_fiscal_invoices.nature_default(code,nature_id) values(v_code,v_id) on conflict(code) do update set nature_id=excluded.nature_id,updated_at=clock_timestamp();
  bumped:=false;
 end if;
 rec:=erp_fiscal_invoices.nature_record(v_id);
 if bumped then insert into erp_fiscal_invoices.nature_revision(nature_id,version,record) values(v_id,(rec->>'version')::integer,rec); end if;
 result:=jsonb_build_object('nature',rec,'action',p_action,'replayed',false,'data_mode','erp_native');
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'nature',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'nature',v_id,(rec->>'version')::integer,p_action,v_code);
 return result;
end $$;

-- The group of each product of the note items, for "Cálculo automático" (only ids leave; the form already reads the products).
create function public.erp_fiscal_invoice_product_groups(p_user_id uuid,p_product_ids jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_ids uuid[];
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_product_ids is null or jsonb_typeof(p_product_ids)<>'array' or jsonb_array_length(p_product_ids) not between 1 and 100 then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 v_ids:=array(select distinct erp_fiscal_invoices.uuid_input(x) from jsonb_array_elements(p_product_ids) x);
 return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'group_id',d.product_group_id) order by r.id)
   from erp_catalog.record r left join erp_catalog.product_detail d on d.record_id=r.id where r.id=any(v_ids) and r.entity='products'),'[]'::jsonb),'data_mode','erp_native');
end $$;

-- 176 plus the group of each product (the rules of "Grupo de Produtos" in the IPI / ICMS ST estimate of pedidos and propostas).
create function public.erp_fiscal_tax_estimate_context_v2(p_user_id uuid,p_kind text,p_contact_id uuid,p_product_ids jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb:=public.erp_fiscal_tax_estimate_context(p_user_id,p_kind,p_contact_id,p_product_ids);
begin
 return jsonb_set(v,'{products}',coalesce((select jsonb_agg(p||jsonb_build_object('group_id',d.product_group_id) order by p->>'id')
  from jsonb_array_elements(v->'products') p left join erp_catalog.product_detail d on d.record_id=(p->>'id')::uuid),'[]'::jsonb));
end $$;

revoke all on all functions in schema erp_fiscal_invoices from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_fiscal_nature_execute(uuid,uuid,text,jsonb)','erp_fiscal_invoice_product_groups(uuid,jsonb)','erp_fiscal_tax_estimate_context_v2(uuid,text,uuid,jsonb)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
