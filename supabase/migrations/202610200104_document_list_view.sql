-- Configurações por usuário das listagens de pedidos, propostas e OS (Origin "Tornar padrão" e "Listagem customizada").
-- Cada usuário guarda, por tipo de documento, as situações do filtro padrão e as colunas visíveis da listagem
-- customizada (só pedidos de venda, como no Origin). Sem padrão salvo vale o do Origin: "Em aberto"
-- (nas propostas, "Em aberto" agrupa Rascunho, Em aberto, Pendente e Aguardando; nos pedidos, Em digitação e Em aberto,
-- porque o pedido novo do Brufap nasce Em digitação e no Origin ele nasce Em aberto e aparece no filtro padrão).
-- Não altera documentos nem efeitos.
-- Requer 008, 019 e 102 (colunas opcionais da listagem).
begin;

create table erp_documents.list_view (
 user_id uuid not null references auth.users(id),
 kind text not null check(kind in ('sales_proposals','sales_orders','service_orders')),
 custom_view boolean not null default false,
 columns text[],
 default_statuses text[],
 version integer not null default 1 check(version>0),
 updated_at timestamptz not null default clock_timestamp(),
 primary key(user_id,kind)
);
alter table erp_documents.list_view enable row level security;
revoke all on erp_documents.list_view from public,anon,authenticated,service_role;

-- Colunas que o usuário pode ligar (Número e Situação são fixas), na ordem padrão do Origin.
create function erp_documents.list_view_columns(p_kind text) returns text[]
language sql immutable set search_path=pg_catalog as $$
 select case p_kind when 'sales_orders' then array['date','contact','total','customer_po_number','address','ship_date','contact_email','contact_phone','contact_document','carrier_name']
  else array[]::text[] end
$$;
create function erp_documents.list_view_default_statuses(p_kind text) returns text[]
language sql immutable set search_path=pg_catalog as $$
 select case p_kind when 'sales_proposals' then array['draft','open','pending','waiting'] when 'sales_orders' then array['draft','open'] else array['open'] end
$$;

create function erp_documents.list_view_dto(p_user_id uuid,p_kind text) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('kind',p_kind,'custom_view',coalesce(v.custom_view,false),
  'columns',to_jsonb(coalesce(v.columns,case when p_kind='sales_orders' then array['date','contact','total'] else array[]::text[] end)),
  'default_statuses',to_jsonb(coalesce(v.default_statuses,erp_documents.list_view_default_statuses(p_kind))),'statuses_saved',v.default_statuses is not null,
  'available_columns',to_jsonb(erp_documents.list_view_columns(p_kind)),'column_limit',8,'version',coalesce(v.version,0),
  'data_mode','erp_native','operational_effects',false)
 from (select 1) one left join erp_documents.list_view v on v.user_id=p_user_id and v.kind=p_kind
$$;

create function public.erp_document_list_view_get(p_user_id uuid,p_kind text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_kind not in('sales_proposals','sales_orders','service_orders') then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 return erp_documents.list_view_dto(p_user_id,p_kind);
end $$;

-- Quem lê a listagem guarda as próprias preferências (inclusive consulta); nunca as de outro usuário.
create function public.erp_document_list_view_save(p_user_id uuid,p_kind text,p_expected_version integer,p_command_id uuid,
 p_custom_view boolean,p_columns text[],p_default_statuses text[])
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.list_view%rowtype; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_kind not in('sales_proposals','sales_orders','service_orders') or p_expected_version is null or p_expected_version<0 or p_custom_view is null
  or p_columns is null or p_default_statuses is null or array_position(p_columns,null) is not null or array_position(p_default_statuses,null) is not null
  or cardinality(p_columns)>8 or (p_kind='sales_orders' and p_custom_view and cardinality(p_columns)=0) or (p_kind<>'sales_orders' and (p_custom_view or cardinality(p_columns)>0))
  or exists(select 1 from unnest(p_columns) c where c<>all(erp_documents.list_view_columns(p_kind)))
  or (select count(distinct c) from unnest(p_columns) c)<>cardinality(p_columns)
  or cardinality(p_default_statuses)>20 or exists(select 1 from unnest(p_default_statuses) s where not (erp_documents.transitions()->p_kind)?s)
  or (select count(distinct s) from unnest(p_default_statuses) s)<>cardinality(p_default_statuses) then
  raise exception 'erp_document_list_view_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','list_view','actor',p_user_id,'kind',p_kind,'version',p_expected_version,'custom_view',p_custom_view,
  'columns',to_jsonb(p_columns),'statuses',to_jsonb(p_default_statuses))::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_documents.list_view where user_id=p_user_id and kind=p_kind for update;
 if found then
  if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  update erp_documents.list_view set custom_view=p_custom_view,columns=p_columns,default_statuses=p_default_statuses,version=version+1,updated_at=clock_timestamp()
   where user_id=p_user_id and kind=p_kind;
 else
  if p_expected_version<>0 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  insert into erp_documents.list_view(user_id,kind,custom_view,columns,default_statuses) values(p_user_id,p_kind,p_custom_view,p_columns,p_default_statuses);
 end if;
 v_result:=erp_documents.list_view_dto(p_user_id,p_kind)||'{"replayed":false}'::jsonb;
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on function erp_documents.list_view_columns(text),erp_documents.list_view_default_statuses(text),erp_documents.list_view_dto(uuid,text)
 from public,anon,authenticated,service_role;
revoke all on function public.erp_document_list_view_get(uuid,text),public.erp_document_list_view_save(uuid,text,integer,uuid,boolean,text[],text[])
 from public,anon,authenticated,service_role;
grant execute on function public.erp_document_list_view_get(uuid,text),public.erp_document_list_view_save(uuid,text,integer,uuid,boolean,text[],text[]) to service_role;
commit;
