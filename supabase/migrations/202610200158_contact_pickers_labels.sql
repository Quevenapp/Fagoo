-- Clientes e fornecedores, onda C (lane contatos): o que os seletores das outras telas pedem ao cadastro de contatos.
--  * Seletor de contatos por papel (Cliente | Fornecedor | Transportador) que respeita "Contato acessível somente ao
--    vendedor vinculado": documentos, financeiro, notas e produtos passam a pesquisar por aqui (erp_catalog_contact_options).
--  * Resumo do contato para os seletores: olho "Visualizar pessoas de contato" e o card azul com as Observações.
--  * "Visualizar histórico" do cliente (pedidos de venda) e do fornecedor (pedidos de compra).
--  * "Imprimir etiquetas" da listagem: os modelos de etiqueta do tipo Contato das Etiquetas customizadas (migração 149,
--    só leitura) e os valores dos contatos selecionados.
--  * Horário de acesso do vendedor (Cadastros > Vendedores) como regra pronta para o controle de acesso (outra área).
-- Só funções novas de contato; nenhuma tabela é alterada e nenhuma função existente é redefinida. Leituras de outras
-- áreas, sem alterá-las: documentos (erp_documents.document e o acesso por tipo) e as etiquetas das Preferências.
-- Depende das migrações publicadas até 202610200152 (contatos 124-128, etiquetas 149).
begin;

-- Picker item: the fields of the legacy /v1/cadastros/contacts record (pickers keep reading id and name) plus the
-- situation, the contact types and whether the summary has something to show.
create function erp_catalog.contact_option_item(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',r.id,'entity','contacts','version',r.version,'active',r.active,'name',r.name,'code',r.code,
   'trade_name',c.trade_name,'person_type',c.person_type,'document',c.document,'ie',c.ie,'email',c.email,'phone',c.phone,'mobile',c.mobile,
   'postal_code',c.postal_code,'street',c.street,'number',c.number,'complement',c.complement,'district',c.district,'city',c.city,'state',c.state,
   'roles',to_jsonb(c.roles),'types',to_jsonb(erp_catalog.contact_type_slugs(r.id)),
   'situation',erp_catalog.contact_situation(r.active,coalesce(cp.situation,erp_catalog.contact_source_situation(r.id))),
   'has_notes',nullif(btrim(coalesce(cp.notes,'')),'') is not null,
   'persons',(select count(*) from erp_catalog.contact_person p where p.contact_id=r.id)::integer,
   'created_at',r.created_at,'updated_at',r.updated_at,
   'source',(select jsonb_build_object('system','origin','source_id',o.source_id,'state',o.state) from erp_catalog.origin o where o.record_id=r.id))
 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id left join erp_catalog.contact_profile cp on cp.record_id=r.id
 where r.id=p_id and r.entity='contacts'
$$;

-- Seletor de contatos: só cadastros ativos (Ativo e Sem movimento), o papel pedido pela tela (Fornecedor no pedido de
-- compra e no fornecedor do produto), a busca da listagem (nome, código, fantasia, e-mail, CPF/CNPJ e telefones) e a
-- cidade da busca avançada. Com a preferência do vendedor ligada, só a carteira do vendedor do usuário.
create function public.erp_catalog_contact_options(p_user_id uuid,p_query text default null,p_role text default null,p_city text default null,p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_terms text[]; v_scope uuid; v_city text:=nullif(btrim(p_city),''); v_ids uuid[];
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_limit is null or p_limit not between 1 and 50 or(p_query is not null and(length(p_query)>120 or p_query~'[[:cntrl:]]'))
  or(p_role is not null and p_role not in('customer','supplier','carrier')) or(p_city is not null and(length(p_city)>100 or p_city~'[[:cntrl:]]')) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_scope:=erp_catalog.contact_scope(p_user_id); v_terms:=erp_catalog.search_terms(p_query);
 select array(select r.id from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id left join erp_catalog.contact_profile cp on cp.record_id=r.id
  where r.entity='contacts' and r.active and(v_scope is null or cp.seller_id=v_scope) and(p_role is null or p_role=any(c.roles))
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code,c.trade_name,c.email,c.document,c.phone,c.mobile)),
    regexp_replace(lower(coalesce(c.document,'')),'[^0-9a-z]','','g'),regexp_replace(concat_ws('|',c.document,c.phone,c.mobile,cp.fax),'[^0-9|]','','g')))
   and(v_city is null or strpos(erp_catalog.fold(coalesce(c.city,'')),erp_catalog.fold(v_city))>0)
  order by erp_catalog.fold(r.name),r.id limit p_limit+1) into v_ids;
 return jsonb_build_object('scope','contact_options','data_mode','erp_native','role',p_role,'limit',p_limit,'scoped',v_scope is not null,
  'has_more',cardinality(v_ids)>p_limit,
  'items',(select coalesce(jsonb_agg(erp_catalog.contact_option_item(u.id) order by u.n),'[]'::jsonb) from unnest(v_ids[1:p_limit]) with ordinality u(id,n)));
end $$;

-- Resumo para os seletores (olho "Visualizar pessoas de contato" e o card azul das Observações). Com a preferência do
-- vendedor ligada, e-mail e telefones de uma pessoa de contato de outra carteira não aparecem (o nome, sim).
create function public.erp_catalog_contact_summary(p_user_id uuid,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_scope uuid;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_id is null or not exists(select 1 from erp_catalog.record where id=p_id and entity='contacts') then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_id);
 v_scope:=erp_catalog.contact_scope(p_user_id);
 return(select jsonb_build_object('scope','contact_summary','data_mode','erp_native','id',r.id,'name',r.name,'code',r.code,
   'situation',erp_catalog.contact_situation_of(r.id),'notes',cp.notes,'contact_info',cp.contact_info,
   'persons',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'code',x.code,'situation',erp_catalog.contact_situation_of(x.id),'visible',x.visible,
      'email',case when x.visible then x.email end,'phone',case when x.visible then x.phone end,'mobile',case when x.visible then x.mobile end) order by x.position),'[]'::jsonb)
    from(select pr.id,pr.name,pr.code,pc.email,pc.phone,pc.mobile,p.position,v_scope is null or coalesce(pp.seller_id=v_scope,false) visible
     from erp_catalog.contact_person p join erp_catalog.record pr on pr.id=p.person_id join erp_catalog.contact pc on pc.record_id=pr.id
     left join erp_catalog.contact_profile pp on pp.record_id=pr.id where p.contact_id=r.id) x))
  from erp_catalog.record r left join erp_catalog.contact_profile cp on cp.record_id=r.id where r.id=p_id);
end $$;

-- "Visualizar histórico": os 10 documentos nativos mais recentes do contato, do tipo pedido pela tela (pedidos de venda
-- do cliente, pedidos de compra do fornecedor), só para quem consulta esse tipo de documento.
create function public.erp_catalog_contact_history(p_user_id uuid,p_contact_id uuid,p_kind text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_visible boolean:=true;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_kind is null or p_kind not in('sales_orders','purchase_orders') then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 if p_contact_id is null or not exists(select 1 from erp_catalog.record where id=p_contact_id and entity='contacts') then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);
 begin perform erp_documents.require_access(p_user_id,p_kind,false);
 exception when insufficient_privilege then v_visible:=false; end;
 return jsonb_build_object('scope','contact_history','data_mode','erp_native','contact_id',p_contact_id,'kind',p_kind,'visible',v_visible,
  'items',case when v_visible then(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'number',d.number::text,'date',d.body->>'date','status',d.status,'total',d.total::text)
    order by d.body->>'date' desc,d.number desc),'[]'::jsonb)
   from(select * from erp_documents.document where kind=p_kind and contact_id=p_contact_id order by body->>'date' desc,number desc limit 10) d) else '[]'::jsonb end);
end $$;

-- ---- Imprimir etiquetas (listagem de contatos, com seleção) ----
-- Same values as erp_preferences_label_records for the Contato type (migration 149), so a model prints the same here.
create function erp_catalog.contact_label_values(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('nome',erp_preferences.report_clean(r.name,200),'fantasia',erp_preferences.report_clean(c.trade_name,200),
   'documento',erp_preferences.report_clean(c.document,20),
   'endereco',erp_preferences.report_clean(concat_ws(', ',c.street,c.number)||coalesce(' - '||nullif(btrim(c.complement),''),''),200),
   'bairro',erp_preferences.report_clean(c.district,100),'cidade_uf',erp_preferences.report_clean(concat_ws('/',c.city,c.state),110),
   'cep',erp_preferences.report_clean(c.postal_code,9),'telefone',erp_preferences.report_clean(c.phone,40))
 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=p_id and r.entity='contacts'
$$;
-- Up to 100 selected contacts (one listing page), in the order sent, with the Contato models: the Padrão and the
-- Customizadas of Preferências > Etiquetas customizadas. Every id must be a contact the user sees; the print is audited.
create function public.erp_catalog_contact_labels(p_user_id uuid,p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_scope uuid; v_result jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'contacts',false);
 if p_ids is null or cardinality(p_ids) not between 1 and 100 or array_position(p_ids,null) is not null
  or(select count(distinct x) from unnest(p_ids) x)<>cardinality(p_ids) then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 if exists(select 1 from unnest(p_ids) x where not exists(select 1 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=x and r.entity='contacts')) then
  raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 v_scope:=erp_catalog.contact_scope(p_user_id);
 if v_scope is not null and exists(select 1 from unnest(p_ids) x where not exists(select 1 from erp_catalog.contact_profile cp where cp.record_id=x and cp.seller_id=v_scope)) then
  raise exception 'erp_catalog_contact_not_visible' using errcode='42501'; end if;
 v_result:=jsonb_build_object('scope','contact_labels','data_mode','erp_native',
  'templates',(select coalesce(jsonb_agg(d||jsonb_build_object('default',true,'version',0,'updated_at',null) order by o),'[]'::jsonb)
    from jsonb_array_elements(erp_preferences.label_defaults()) with ordinality x(d,o) where d->>'type'='contato')
   ||(select coalesce(jsonb_agg(jsonb_build_object('id',t.id::text,'type',t.type,'description',t.description,'default',false,'config',t.config,'version',t.version,'updated_at',t.updated_at)
     order by lower(t.description),t.id),'[]'::jsonb)
    from(select * from erp_preferences.label_template where type='contato' order by lower(description),id limit 100) t),
  'items',(select jsonb_agg(jsonb_build_object('id',x.id,'values',erp_catalog.contact_label_values(x.id)) order by x.n) from unnest(p_ids) with ordinality x(id,n)));
 insert into erp_catalog.auxiliary_audit(actor,subject,action,after_data) values(p_user_id,'contacts_export','labels',jsonb_build_object('total',cardinality(p_ids)));
 return v_result;
end $$;

-- ---- Horários de acesso do vendedor (Origin VF-08) ----
-- Whether the user may use the system at p_at (São Paulo time): true for a user who is not a seller's user, for a seller
-- without "Visualizar horários de acesso" or without rows; otherwise a row must contain the weekday (0 = domingo) and
-- the minute (início e fim inclusive). Ready for the access control of the Preferências area, which owns the sign-in.
create function erp_catalog.seller_access_allowed(p_user_id uuid,p_at timestamptz default clock_timestamp()) returns boolean
language sql stable set search_path=pg_catalog as $$
 select coalesce((select not s.access_hours_enabled or jsonb_array_length(s.access_windows)=0 or exists(
   select 1 from jsonb_array_elements(s.access_windows) w
   where to_char(p_at at time zone 'America/Sao_Paulo','HH24:MI') between w->>'start' and w->>'end'
    and w->'days' @> to_jsonb(extract(dow from p_at at time zone 'America/Sao_Paulo')::integer))
  from erp_catalog.seller s where s.user_id=p_user_id),true)
$$;

-- Only this migration's helpers (other lanes may add erp_catalog functions in parallel): private to everyone.
revoke all on function erp_catalog.contact_option_item(uuid),erp_catalog.contact_label_values(uuid),erp_catalog.seller_access_allowed(uuid,timestamptz)
 from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_contact_options(uuid,text,text,text,integer)','erp_catalog_contact_summary(uuid,uuid)',
  'erp_catalog_contact_history(uuid,uuid,text)','erp_catalog_contact_labels(uuid,uuid[])'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
