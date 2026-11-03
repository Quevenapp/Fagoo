-- 241: Cadastros › Vendedores (contatos da frente de documentos, onda E): "Visualizar horários de acesso" vale em cada requisição.
-- * Os horários do vendedor já entram no login e na revalidação de /v1/me (erp_access.schedule_allows, 229); a conferência em cada
--   requisição só acontece para quem tem a marca app_metadata.brufap_access_gate no Auth, que até aqui só Sistema › Usuários gravava.
--   Agora a gravação do vendedor devolve, para o usuário vinculado antes e o vinculado agora, se ele precisa da conferência
--   (erp_access.gate_required: horários do próprio usuário ou do vendedor), e a API grava a marca no Auth logo depois. Uma marca não
--   gravada vira "Conferir resultado": o mesmo comando devolve o recibo e grava a marca de novo.
-- * Seletor de contatos com o papel Transportador (o Transportador dos pedidos de venda, de compra e das propostas): além dos
--   contatos do tipo Transportador, também os contatos sem tipo definido, como os que vêm do espelho do Origin (que não traz os
--   tipos de contato). Sem isso, as transportadoras já cadastradas no Origin não apareceriam no seletor.
-- Substitui erp_catalog_seller_save (126) e erp_catalog_contact_options (158), conferidas pelo hash; outra versão interrompe a
-- migração.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_access.gate_required(uuid)') is null then raise exception 'contacts_sellers_241_requires_229' using errcode='55000'; end if;
 for r in select * from(values
  ('public.erp_catalog_seller_save(uuid,uuid,integer,integer,uuid,jsonb,jsonb,jsonb)','f55a6f2977b6e441751d98236cc85ae3fb0bf802c33eac7a5c9d9fd5be486d38'),
  ('public.erp_catalog_contact_options(uuid,text,text,text,integer)','2b6eed15934eff6ef2085efc274b260d3cb90f3fb65ebe3ebecd2d72d21524a6'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'contacts_sellers_241_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 158 plus: the Transportador role also lists the contacts without any role (Sem tipo definido, e.g. mirrored from the Origin).
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
  where r.entity='contacts' and r.active and(v_scope is null or cp.seller_id=v_scope)
   and(p_role is null or p_role=any(c.roles) or(p_role='carrier' and cardinality(c.roles)=0))
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code,c.trade_name,c.email,c.document,c.phone,c.mobile)),
    regexp_replace(lower(coalesce(c.document,'')),'[^0-9a-z]','','g'),regexp_replace(concat_ws('|',c.document,c.phone,c.mobile,cp.fax),'[^0-9|]','','g')))
   and(v_city is null or strpos(erp_catalog.fold(coalesce(c.city,'')),erp_catalog.fold(v_city))>0)
  order by erp_catalog.fold(r.name),r.id limit p_limit+1) into v_ids;
 return jsonb_build_object('scope','contact_options','data_mode','erp_native','role',p_role,'limit',p_limit,'scoped',v_scope is not null,
  'has_more',cardinality(v_ids)>p_limit,
  'items',(select coalesce(jsonb_agg(erp_catalog.contact_option_item(u.id) order by u.n),'[]'::jsonb) from unnest(v_ids[1:p_limit]) with ordinality u(id,n)));
end $$;

-- Whether each user needs the access gate now (the windows of the user or of the linked seller), in user id order.
create function erp_catalog.seller_access_gates(p_users jsonb) returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('user_id',u,'gate_required',erp_access.gate_required(u::uuid)) order by u),'[]'::jsonb)
 from jsonb_array_elements_text(case when jsonb_typeof(p_users)='array' then p_users else '[]'::jsonb end) u
 where u~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

create or replace function public.erp_catalog_seller_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_contact_expected_version integer,p_command_id uuid,
 p_contact jsonb,p_settings jsonb,p_acknowledged jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_seller erp_catalog.seller%rowtype; v_settings jsonb; v_contact jsonb; v_id uuid; v_before jsonb; v_result jsonb; v_users jsonb;
begin
 perform erp_catalog.seller_access(p_user_id,true);
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_command_id is null or p_expected_version is null or p_contact_expected_version is null
  or(p_id is null and(p_expected_version<>0 or p_contact_expected_version<>0)) or(p_id is not null and(p_expected_version not between 1 and 2147483647 or p_contact_expected_version not between 1 and 2147483647))
  or p_contact is null or jsonb_typeof(p_contact)<>'object' or p_contact='{}'::jsonb or not erp_catalog.acknowledged_valid(p_acknowledged) then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-seller-save-v1','actor',p_user_id,'id',p_id,'version',p_expected_version,'contact_version',p_contact_expected_version,
  'contact',p_contact,'settings',p_settings,'acknowledged',p_acknowledged)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  -- 241: the access gates are read again at each answer (the replay of "Conferir resultado" sets the Auth flags again).
  return v_command.result||jsonb_build_object('replayed',true,'access_gates',erp_catalog.seller_access_gates(v_command.result->'access_users'));
 end if;
 v_settings:=erp_catalog.seller_settings(p_settings);
 if p_id is not null then
  select * into v_seller from erp_catalog.seller where id=p_id for update;
  if v_seller.id is null then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  if v_seller.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  if v_seller.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
 end if;
 -- The Vendedor type always stays on the contact of a seller.
 if p_contact?'types' and not(p_contact->'types')?'seller' then
  if jsonb_typeof(p_contact->'types')<>'array' then raise exception 'erp_catalog_contact_invalid:types' using errcode='22023'; end if;
  p_contact:=jsonb_set(p_contact,'{types}',(p_contact->'types')||'["seller"]'::jsonb);
 end if;
 if p_id is null and not p_contact?'types' then p_contact:=p_contact||'{"types":["seller"]}'::jsonb; end if;
 v_contact:=erp_catalog.contact_apply(p_user_id,v_seller.contact_id,p_contact_expected_version,p_command_id,p_contact,p_acknowledged,'update',erp_catalog.seller_contact_fields());
 if p_id is null then
  v_id:=erp_catalog.seller_write(p_user_id,null,(v_contact->>'id')::uuid,v_settings);
  insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,after_data) values(p_user_id,p_command_id,'seller',v_id,'create',erp_catalog.seller_dto(v_id));
 else
  v_id:=p_id; v_before:=erp_catalog.seller_dto(p_id);
  if erp_catalog.seller_values(p_id) is distinct from v_settings then
   perform erp_catalog.seller_write(p_user_id,p_id,v_seller.contact_id,v_settings);
   insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,before_data,after_data) values(p_user_id,p_command_id,'seller',v_id,'update',v_before,erp_catalog.seller_dto(v_id));
  end if;
 end if;
 -- 241: the users whose access gate may have changed: the one linked before and the one linked now.
 v_users:=(select coalesce(jsonb_agg(distinct u::text),'[]'::jsonb) from unnest(array[v_seller.user_id,(select s.user_id from erp_catalog.seller s where s.id=v_id)]) u where u is not null);
 v_result:=jsonb_build_object('entity','sellers','data_mode','erp_native','replayed',false,'seller',erp_catalog.seller_dto(v_id),'contact',erp_catalog.contact_dto((v_contact->>'id')::uuid),
  'access_users',v_users);
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result||jsonb_build_object('access_gates',erp_catalog.seller_access_gates(v_users));
end $$;

revoke all on function erp_catalog.seller_access_gates(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.erp_catalog_seller_save(uuid,uuid,integer,integer,uuid,jsonb,jsonb,jsonb),public.erp_catalog_contact_options(uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.erp_catalog_seller_save(uuid,uuid,integer,integer,uuid,jsonb,jsonb,jsonb),public.erp_catalog_contact_options(uuid,text,text,text,integer) to service_role;
commit;
