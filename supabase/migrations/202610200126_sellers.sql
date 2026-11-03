-- Cadastros > Vendedores no padrão do Origin (lane contatos, onda B). O vendedor é um contato (tipo Vendedor) com as
-- configurações próprias de erp_catalog.seller (tabela da migração 124): usuário do sistema vinculado, permissões de
-- pedidos e estoque, horários de acesso, módulos, comissionamento e limite de desconto. Também "Tornar vendedor" e
-- "Vincular a vendedor" da listagem de contatos e as opções de vendedor dos filtros e do formulário do contato.
-- O usuário vinculado é o que aplica "Contato acessível somente ao vendedor vinculado". As demais configurações ficam
-- guardadas para documentos, comissões e frente de caixa (outras áreas), sem efeito ainda; a tela diz isso.
-- Leitura do vendedor: admin, consulta, vendas e financeiro. Gravação: admin. Opções (nome) para quem lê contatos.
begin;

create function erp_catalog.seller_access(p_user_id uuid,p_write boolean) returns text
language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if v_role is null or not(case when p_write then v_role='admin' else v_role in('admin','consulta','vendas','financeiro') end) then
  raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
 return v_role;
end $$;

-- Módulos que podem ser acessados pelo vendedor (Origin VF-09 e Frente de Caixa VF-12), sem Multilojas, Tickets e
-- Cotação Logística (fora do escopo ou dependentes de decisão).
create function erp_catalog.seller_module_keys() returns text[]
language sql immutable set search_path=pg_catalog as $$
 select array['clientes','clientes_limite_credito','clientes_ver_clientes','clientes_ver_fornecedores','clientes_ver_tecnicos','clientes_ver_transportadores',
  'clientes_ver_vendedores','clientes_ver_desenvolvedores','listas_precos','comissoes','controle_caixa','frente_caixa','pdv_registro_itens','pdv_registro_pagamento',
  'pdv_fechamento','pdv_editar_preco','pdv_exclusao_itens','pdv_alterar_forma_pagamento','pdv_gerenciador_pos','pedidos_venda','pedidos_exportar',
  'pedidos_alterar_forma_pagamento','visualizacao_lote','propostas','propostas_outros_vendedores','propostas_alterar_status','propostas_exportar',
  'gerenciador_arquivos','relatorio_controle_caixa','relatorio_saldos_estoque','relatorio_vendas','relatorio_visao_financeira_estoque','ordens_servico',
  'os_alterar_forma_pagamento','os_permitir_exclusao']::text[]
$$;
create function erp_catalog.percent_valid(p_value jsonb,p_null boolean) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select case when p_value is null or p_value='null'::jsonb then p_null
  else jsonb_typeof(p_value)='string' and p_value#>>'{}'~'^(0|[1-9][0-9]?|100)(\.[0-9]{1,4})?$' and(p_value#>>'{}')::numeric<=100 end
$$;
-- Validated settings, complete (every key present). Windows: up to 20 rows of start < end (HH:MM) and distinct days 0-6.
create function erp_catalog.seller_settings(p jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare v_keys text[]:=array['user_id','allow_unregistered_products','view_stock','access_hours_enabled','access_windows','modules','commission_rule',
 'commission_mode','commission_rate','commission_bands','discount_limit','notes']; v_window jsonb; v_band jsonb; v_previous numeric:=-1; v_notes text;
begin
 if p is null or jsonb_typeof(p)<>'object' or exists(select 1 from jsonb_object_keys(p) k where not k=any(v_keys))
  or(select count(*) from jsonb_object_keys(p))<>cardinality(v_keys) then raise exception 'erp_catalog_seller_invalid' using errcode='22023'; end if;
 if p->'user_id'<>'null'::jsonb and(jsonb_typeof(p->'user_id')<>'string' or p->>'user_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'erp_catalog_seller_invalid:user_id' using errcode='22023'; end if;
 if jsonb_typeof(p->'allow_unregistered_products')<>'boolean' or jsonb_typeof(p->'view_stock')<>'boolean' or jsonb_typeof(p->'access_hours_enabled')<>'boolean' then
  raise exception 'erp_catalog_seller_invalid:flags' using errcode='22023'; end if;
 if jsonb_typeof(p->'access_windows')<>'array' or jsonb_array_length(p->'access_windows')>20 then raise exception 'erp_catalog_seller_invalid:access_windows' using errcode='22023'; end if;
 for v_window in select x from jsonb_array_elements(p->'access_windows') x loop
  if jsonb_typeof(v_window)<>'object' or(select count(*) from jsonb_object_keys(v_window))<>3 or not(v_window?'start' and v_window?'end' and v_window?'days')
   or jsonb_typeof(v_window->'start')<>'string' or jsonb_typeof(v_window->'end')<>'string' or v_window->>'start'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
   or v_window->>'end'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or v_window->>'start'>=v_window->>'end'
   or jsonb_typeof(v_window->'days')<>'array' or jsonb_array_length(v_window->'days') not between 1 and 7
   or exists(select 1 from jsonb_array_elements(v_window->'days') d where jsonb_typeof(d)<>'number' or d::text not in('0','1','2','3','4','5','6'))
   or(select count(distinct d::text) from jsonb_array_elements(v_window->'days') d)<>jsonb_array_length(v_window->'days') then
   raise exception 'erp_catalog_seller_invalid:access_windows' using errcode='22023'; end if;
 end loop;
 if jsonb_typeof(p->'modules')<>'object' or exists(select 1 from jsonb_each(p->'modules') m where not m.key=any(erp_catalog.seller_module_keys()) or jsonb_typeof(m.value)<>'boolean') then
  raise exception 'erp_catalog_seller_invalid:modules' using errcode='22023'; end if;
 if jsonb_typeof(p->'commission_rule')<>'string' or p->>'commission_rule' not in('parcial','faturamento','primeira_parcela','ultima_parcela')
  or jsonb_typeof(p->'commission_mode')<>'string' or p->>'commission_mode' not in('fixa','descontos') then raise exception 'erp_catalog_seller_invalid:commission' using errcode='22023'; end if;
 if not erp_catalog.percent_valid(p->'commission_rate',true) or not erp_catalog.percent_valid(p->'discount_limit',false) then
  raise exception 'erp_catalog_seller_invalid:percent' using errcode='22023'; end if;
 if jsonb_typeof(p->'commission_bands')<>'array' or jsonb_array_length(p->'commission_bands')>20 then raise exception 'erp_catalog_seller_invalid:commission_bands' using errcode='22023'; end if;
 for v_band in select x from jsonb_array_elements(p->'commission_bands') x loop
  if jsonb_typeof(v_band)<>'object' or(select count(*) from jsonb_object_keys(v_band))<>2 or not(v_band?'discount_up_to' and v_band?'rate')
   or not erp_catalog.percent_valid(v_band->'discount_up_to',false) or not erp_catalog.percent_valid(v_band->'rate',false)
   or(v_band->>'discount_up_to')::numeric<=v_previous then raise exception 'erp_catalog_seller_invalid:commission_bands' using errcode='22023'; end if;
  v_previous:=(v_band->>'discount_up_to')::numeric;
 end loop;
 v_notes:=erp_catalog.contact_text('notes',p->'notes',4000,true);
 return jsonb_build_object('user_id',p->'user_id','allow_unregistered_products',p->'allow_unregistered_products','view_stock',p->'view_stock',
  'access_hours_enabled',p->'access_hours_enabled','access_windows',p->'access_windows',
  'modules',(select coalesce(jsonb_object_agg(m.key,m.value order by m.key),'{}'::jsonb) from jsonb_each(p->'modules') m where m.value='true'::jsonb),
  'commission_rule',p->'commission_rule','commission_mode',p->'commission_mode',
  'commission_rate',case when p->'commission_rate'='null'::jsonb then 'null'::jsonb else to_jsonb((p->>'commission_rate')::numeric(7,4)::text) end,
  'commission_bands',(select coalesce(jsonb_agg(jsonb_build_object('discount_up_to',(b->>'discount_up_to')::numeric(7,4)::text,'rate',(b->>'rate')::numeric(7,4)::text)
   order by (b->>'discount_up_to')::numeric),'[]'::jsonb) from jsonb_array_elements(p->'commission_bands') b),
  'discount_limit',to_jsonb((p->>'discount_limit')::numeric(7,4)::text),'notes',to_jsonb(v_notes));
end $$;
create function erp_catalog.seller_dto(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',s.id,'contact_id',s.contact_id,'version',s.version,'user_id',s.user_id,
  'user_name',case when s.user_id is null then null else erp_activity.actor_label(s.user_id) end,
  'allow_unregistered_products',s.allow_unregistered_products,'view_stock',s.view_stock,'access_hours_enabled',s.access_hours_enabled,
  'access_windows',s.access_windows,'modules',s.modules,'commission_rule',s.commission_rule,'commission_mode',s.commission_mode,
  'commission_rate',s.commission_rate::text,'commission_bands',s.commission_bands,'discount_limit',s.discount_limit::text,'notes',s.notes,
  'created_at',s.created_at,'updated_at',s.updated_at)
 from erp_catalog.seller s where s.id=p_id
$$;
-- Users offered for "Usuário do sistema": active members (with the name from Sistema > Usuários).
create function erp_catalog.seller_users() returns jsonb
language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'name',erp_activity.actor_label(m.user_id),'role',m.role) order by m.created_at,m.user_id),'[]'::jsonb)
 from(select user_id,role,created_at from erp_access.membership where active order by created_at,user_id limit 500) m
$$;
create function erp_catalog.seller_write(p_user_id uuid,p_seller_id uuid,p_contact_id uuid,p jsonb) returns uuid
language plpgsql set search_path=pg_catalog as $$
declare v_id uuid:=p_seller_id;
begin
 if p->>'user_id' is not null then
  if not exists(select 1 from erp_access.membership where user_id=(p->>'user_id')::uuid and active) then raise exception 'erp_catalog_seller_invalid:user_id' using errcode='22023'; end if;
  if exists(select 1 from erp_catalog.seller where user_id=(p->>'user_id')::uuid and id is distinct from p_seller_id) then raise exception 'erp_catalog_seller_user_taken' using errcode='23505'; end if;
 end if;
 if v_id is null then
  insert into erp_catalog.seller(contact_id,user_id,allow_unregistered_products,view_stock,access_hours_enabled,access_windows,modules,commission_rule,commission_mode,
   commission_rate,commission_bands,discount_limit,notes,created_by,updated_by)
  values(p_contact_id,(p->>'user_id')::uuid,(p->>'allow_unregistered_products')::boolean,(p->>'view_stock')::boolean,(p->>'access_hours_enabled')::boolean,
   p->'access_windows',p->'modules',p->>'commission_rule',p->>'commission_mode',(p->>'commission_rate')::numeric,p->'commission_bands',(p->>'discount_limit')::numeric,
   p->>'notes',p_user_id,p_user_id) returning id into v_id;
 else
  update erp_catalog.seller set user_id=(p->>'user_id')::uuid,allow_unregistered_products=(p->>'allow_unregistered_products')::boolean,view_stock=(p->>'view_stock')::boolean,
   access_hours_enabled=(p->>'access_hours_enabled')::boolean,access_windows=p->'access_windows',modules=p->'modules',commission_rule=p->>'commission_rule',
   commission_mode=p->>'commission_mode',commission_rate=(p->>'commission_rate')::numeric,commission_bands=p->'commission_bands',discount_limit=(p->>'discount_limit')::numeric,
   notes=p->>'notes',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 end if;
 return v_id;
end $$;
-- Contact fields shown by the Vendedor form (VF-01 and VF-03): the only ones "Campos obrigatórios" can demand there, so a
-- required field the form does not show never blocks the save (apps/erp/src/lib/seller-model.ts SELLER_CONTACT_FIELDS).
create function erp_catalog.seller_contact_fields() returns text[]
language sql immutable set search_path=pg_catalog as $$
 select array['name','code','trade_name','person_type','document','taxpayer','ie','rg','birth_date','country','postal_code','state','city','district','street','number',
  'complement','phone','mobile','email']::text[]
$$;
-- The settings part of a seller, compared with what a save would write (no version bump when nothing changed).
create function erp_catalog.seller_values(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select erp_catalog.seller_dto(p_id)-'id'-'contact_id'-'version'-'user_name'-'created_at'-'updated_at'
$$;

create function public.erp_catalog_seller_page(p_user_id uuid,p_page integer default 1,p_size integer default 100,p_sort text default 'created_desc',
 p_query text default null,p_situation text default 'latest',p_type text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text:=erp_catalog.seller_access(p_user_id,false); v_terms text[]; v_total bigint; v_ids uuid[]; v_where text; v_scope uuid;
begin
 if not erp_catalog.page_valid(p_page,p_size,p_sort,p_query,null,null,null)
  or not erp_catalog.contact_filter_valid(p_situation,p_type,null,null,null,null,null,null,null,null,null) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_terms:=erp_catalog.search_terms(p_query);
 -- The contact of a seller is a contact: "Contato acessível somente ao vendedor vinculado" applies here too ($10).
 v_scope:=erp_catalog.contact_scope(p_user_id);
 v_where:=erp_catalog.contact_where(null)||' and exists(select 1 from erp_catalog.seller s where s.contact_id=r.id)';
 execute erp_catalog.page_sql(v_where,p_sort,v_terms is not null,16) into v_total,v_ids
  using p_situation,v_terms,p_type,null::text,null::text,null::text,null::text,null::text,null::uuid,v_scope,null::timestamptz,null::timestamptz,null::date,null::date,null::text[],
   (p_page-1)*p_size,p_size;
 return jsonb_build_object('entity','sellers','page',p_page,'size',p_size,'total',v_total,'sort',p_sort,'situation',p_situation,'can_write',v_role='admin','data_mode','erp_native',
  'items',(select coalesce(jsonb_agg(erp_catalog.contact_list_item(u.id)||jsonb_build_object('seller_id',s.id,'seller_version',s.version) order by u.n),'[]'::jsonb)
   from unnest(v_ids) with ordinality u(id,n) join erp_catalog.seller s on s.contact_id=u.id));
end $$;

create function public.erp_catalog_seller_get(p_user_id uuid,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text:=erp_catalog.seller_access(p_user_id,false); v_contact uuid;
begin
 select contact_id into v_contact from erp_catalog.seller where id=p_id;
 if v_contact is null then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,v_contact);
 return jsonb_build_object('entity','sellers','data_mode','erp_native','can_write',v_role='admin','seller',erp_catalog.seller_dto(p_id),'contact',erp_catalog.contact_dto(v_contact),
  'users',case when v_role='admin' then erp_catalog.seller_users() else '[]'::jsonb end);
end $$;
-- Form of a new seller: the users list for "Usuário do sistema" (administrador).
create function public.erp_catalog_seller_options(p_user_id uuid,p_query text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text:=erp_catalog.require_access(p_user_id,'contacts',false); v_terms text[];
begin
 if p_query is not null and(length(p_query)>120 or p_query~'[[:cntrl:]]') then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_terms:=erp_catalog.search_terms(p_query);
 return jsonb_build_object('scope','seller_options','data_mode','erp_native','users',case when v_role='admin' then erp_catalog.seller_users() else '[]'::jsonb end,
  'items',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'code',x.code) order by erp_catalog.fold(x.name),x.id),'[]'::jsonb) from(
   select s.id,r.name,r.code from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id
   where r.active and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code)),'',''))
   order by erp_catalog.fold(r.name),s.id limit 25) x));
end $$;

-- Incluir/alterar vendedor: contato (com o tipo Vendedor) e configurações numa operação só, com um command_id.
create function public.erp_catalog_seller_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_contact_expected_version integer,p_command_id uuid,
 p_contact jsonb,p_settings jsonb,p_acknowledged jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_seller erp_catalog.seller%rowtype; v_settings jsonb; v_contact jsonb; v_id uuid; v_before jsonb; v_result jsonb;
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
  return v_command.result||'{"replayed":true}'::jsonb;
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
 v_result:=jsonb_build_object('entity','sellers','data_mode','erp_native','replayed',false,'seller',erp_catalog.seller_dto(v_id),'contact',erp_catalog.contact_dto((v_contact->>'id')::uuid));
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Tornar vendedor (menu ⋮ da listagem de contatos): executa direto; o contato ganha o tipo Vendedor.
create function public.erp_catalog_seller_from_contact(p_user_id uuid,p_command_id uuid,p_contact_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.record%rowtype; v_id uuid; v_types jsonb; v_result jsonb;
begin
 perform erp_catalog.seller_access(p_user_id,true);
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_command_id is null or p_contact_id is null then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-seller-from-contact-v1','actor',p_user_id,'contact',p_contact_id)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 select * into v_row from erp_catalog.record where id=p_contact_id and entity='contacts' for update;
 if v_row.id is null then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 if exists(select 1 from erp_catalog.seller where contact_id=p_contact_id) then raise exception 'erp_catalog_seller_exists' using errcode='23505'; end if;
 v_types:=coalesce(erp_catalog.contact_data(p_contact_id)->'types','[]'::jsonb);
 if not v_types?'seller' then
  -- Only the type changes: "Campos obrigatórios" does not block it (the form is not shown).
  perform erp_catalog.contact_apply(p_user_id,p_contact_id,v_row.version,p_command_id,jsonb_build_object('types',v_types||'["seller"]'::jsonb),null,'update','{}'::text[]);
 end if;
 v_id:=erp_catalog.seller_write(p_user_id,null,p_contact_id,erp_catalog.seller_settings(jsonb_build_object('user_id',null,'allow_unregistered_products',false,'view_stock',false,
  'access_hours_enabled',false,'access_windows','[]'::jsonb,'modules','{}'::jsonb,'commission_rule','parcial','commission_mode','fixa','commission_rate',null,
  'commission_bands','[]'::jsonb,'discount_limit','0','notes',null)));
 insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,after_data) values(p_user_id,p_command_id,'seller',v_id,'create',erp_catalog.seller_dto(v_id));
 v_result:=jsonb_build_object('entity','sellers','data_mode','erp_native','replayed',false,'seller',erp_catalog.seller_dto(v_id),'contact',erp_catalog.contact_dto(p_contact_id));
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Vincular a vendedor (lote da listagem): um contato por comando, com a versão lida na listagem.
create function public.erp_catalog_contact_set_seller(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_seller_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_result jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',true);
 if p_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483647 then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-contact-seller-v1','actor',p_user_id,'id',p_id,'version',p_expected_version,'seller',p_seller_id)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 -- A batch action changes only the seller: "Campos obrigatórios" does not block it (legacy contacts stay linkable).
 v_result:=jsonb_build_object('entity','contacts','record',erp_catalog.contact_apply(p_user_id,p_id,p_expected_version,p_command_id,jsonb_build_object('seller_id',p_seller_id),null,'update','{}'::text[]),
  'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_seller_page(uuid,integer,integer,text,text,text,text)','erp_catalog_seller_get(uuid,uuid)','erp_catalog_seller_options(uuid,text)',
  'erp_catalog_seller_save(uuid,uuid,integer,integer,uuid,jsonb,jsonb,jsonb)','erp_catalog_seller_from_contact(uuid,uuid,uuid)',
  'erp_catalog_contact_set_seller(uuid,uuid,integer,uuid,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
