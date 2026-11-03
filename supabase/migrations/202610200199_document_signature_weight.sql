-- 199: Assinatura da proposta por usuário e casas decimais do peso nos documentos (onda D da frente de documentos).
-- * Proposta comercial › Assinatura (Origin "Saudação" e "Departamento", "Definido por usuário"): cada usuário guarda a sua
--   saudação e o seu departamento, impressos ao fim da proposta com o nome do usuário (Sistema › Usuários). Comando idempotente
--   com versão (CAS) e auditoria imutável; ler exige ler propostas e gravar exige gravar propostas.
-- * Preferências › Empresa "Número de casas decimais no peso do produto" (empresa.decimais_peso, 0 a 5) vai para as
--   configurações dos documentos (erp_document_access.settings.weight_decimals): o peso bruto dos documentos aceita e mostra até
--   esse número de casas.
-- Nada aqui grava documento, estoque ou financeiro. Requer 117 e 164.
begin;

do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure('public.erp_document_access(uuid)'))
  is distinct from '56a1adf49e5c4a73b1d0a9d62d6b6d61ceacecccf04e1bc47464deace6bfe0fd' then
  raise exception 'document_signature_199_previous_definition_changed' using errcode='55000',detail='public.erp_document_access(uuid)';end if;
end$$;

create table erp_documents.user_signature(
 user_id uuid primary key references auth.users(id),
 greeting text check(greeting is null or(length(greeting) between 1 and 200 and greeting=btrim(greeting) and greeting!~'[[:cntrl:]]')),
 department text check(department is null or(length(department) between 1 and 100 and department=btrim(department) and department!~'[[:cntrl:]]')),
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null default clock_timestamp()
);
create table erp_documents.user_signature_audit(
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id),
 command_id uuid not null unique,
 before_data jsonb, after_data jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table erp_documents.user_signature enable row level security;
alter table erp_documents.user_signature_audit enable row level security;
revoke all on erp_documents.user_signature,erp_documents.user_signature_audit from public,anon,authenticated,service_role;
create function erp_documents.user_signature_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_document_signature_audit_immutable' using errcode='55000'; end $$;
create trigger user_signature_audit_immutable before update or delete on erp_documents.user_signature_audit
 for each row execute function erp_documents.user_signature_audit_immutable();

-- The name is the one of Sistema › Usuários (erp_access.profile); without it nothing is printed in its place (the e-mail of
-- the user never goes into a document handed to a client).
create function erp_documents.signature_view(p_user_id uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v_row erp_documents.user_signature%rowtype; v_name text;
begin
 select * into v_row from erp_documents.user_signature where user_id=p_user_id;
 select left(p.name,200) into v_name from erp_access.profile p where p.user_id=p_user_id;
 return jsonb_build_object('greeting',v_row.greeting,'department',v_row.department,'version',coalesce(v_row.version,0),'name',v_name,
  'data_mode','erp_native','operational_effects',false);
end $$;
create function public.erp_document_signature(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',false);
 return erp_documents.signature_view(p_user_id);
end $$;
create function public.erp_document_signature_save(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_greeting text,p_department text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.user_signature%rowtype; v_greeting text; v_department text; v_before jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 then raise exception 'erp_document_signature_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','signature','actor',p_user_id,'version',p_expected_version,'greeting',p_greeting,'department',p_department)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 v_greeting:=erp_documents.text_value(to_jsonb(p_greeting),200); v_department:=erp_documents.text_value(to_jsonb(p_department),100);
 select * into v_row from erp_documents.user_signature where user_id=p_user_id for update;
 if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_before:=case when v_row.user_id is null then null else erp_documents.signature_view(p_user_id) end;
 insert into erp_documents.user_signature(user_id,greeting,department,version) values(p_user_id,v_greeting,v_department,1)
 on conflict(user_id) do update set greeting=excluded.greeting,department=excluded.department,version=erp_documents.user_signature.version+1,updated_at=clock_timestamp();
 v_result:=erp_documents.signature_view(p_user_id)||jsonb_build_object('replayed',false);
 insert into erp_documents.user_signature_audit(user_id,command_id,before_data,after_data) values(p_user_id,p_command_id,v_before,v_result);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 164 plus the casas decimais of the peso (Preferências › Empresa).
create or replace function public.erp_document_access(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if not found then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 return jsonb_build_object('read',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.allowed(v_role,k,false)),
  'write',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.allowed(v_role,k,true)),
  'settings',jsonb_build_object(
   'price_decimals_out',coalesce((erp_documents.preference('empresa.decimais_preco_saida')#>>'{}')::integer,10),
   'price_decimals_in',coalesce((erp_documents.preference('empresa.decimais_preco_entrada')#>>'{}')::integer,10),
   'weight_decimals',least(greatest(coalesce((erp_documents.preference('empresa.decimais_peso')#>>'{}')::integer,3),0),5),
   'cross_docking_days',coalesce((erp_documents.preference('estoque.cross_docking_dias')#>>'{}')::integer,0),
   'occurrence_date_editable',erp_documents.preference('empresa.editar_data_ocorrencia')='true'::jsonb,
   'stock_launch_date',case when erp_documents.preference('estoque.data_lancamento')='"data_documento"'::jsonb then 'data_documento' else 'data_atual' end,
   'auto_products',jsonb_build_object('sales',erp_documents.preference('produtos.cadastro_auto_vendas')='true'::jsonb,
    'purchases',erp_documents.preference('produtos.cadastro_auto_compras')='true'::jsonb,'services',erp_documents.preference('produtos.cadastro_auto_os')='true'::jsonb),
   'default_warehouse',(select jsonb_build_object('id',r.id,'name',left(r.name,200)) from erp_stock.warehouse_default x join erp_catalog.record r on r.id=x.warehouse_id where r.active)),
  'seller',(select jsonb_build_object('id',s.id,'name',left(r.name,200),'allow_unregistered_products',s.allow_unregistered_products,'view_stock',s.view_stock,
    'discount_limit',s.discount_limit::numeric(7,4)::text) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.user_id=p_user_id),
  'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function erp_documents.signature_view(uuid),erp_documents.user_signature_audit_immutable() from public,anon,authenticated,service_role;
revoke all on function public.erp_document_signature(uuid),public.erp_document_signature_save(uuid,uuid,integer,text,text),public.erp_document_access(uuid) from public,anon,authenticated;
grant execute on function public.erp_document_signature(uuid),public.erp_document_signature_save(uuid,uuid,integer,text,text),public.erp_document_access(uuid) to service_role;
commit;
