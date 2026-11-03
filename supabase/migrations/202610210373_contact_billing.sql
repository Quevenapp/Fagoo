-- 373: cobrança do contato (leva H, lane financeiro: CTT-050, PRF-299).
-- Decisões recomendadas (10.3 e 10.7):
-- * CTT-050: o endereço geral (erp_catalog.contact) e o de cobrança (erp_catalog.contact_profile, 124) continuam separados; a opção
--   explícita "Usar o endereço geral para cobrança" fica em erp_catalog.contact_billing. O endereço de cobrança efetivo
--   (erp_catalog.contact_billing_address) entra no contrato financeiro de leitura (a gaveta da conta e a Ficha), sem ativar operação
--   bancária: a remessa do CNAB (067) não é alterada.
-- * PRF-299: E-mail de cobrança próprio do contato. O selo "E-mail verificado" só existe para um endereço confirmado por um fluxo
--   explícito (erp_catalog.contact_email_verification). Esse fluxo depende do e-mail transacional, que ainda não envia confirmações,
--   então a tabela começa vazia e o selo não aparece; o login confirmado de um usuário nunca conta como verificação do contato.
-- Tabelas próprias: as funções do cadastro de contatos (124 e seguintes) e o espelho do Origin não são alterados.
begin;

do $$ begin
  if to_regclass('erp_catalog.contact_billing') is not null then raise exception 'contact_billing_373_already_applied' using errcode='55000'; end if;
end $$;

create table erp_catalog.contact_billing (
  contact_id uuid primary key references erp_catalog.contact(record_id),
  same_as_general boolean not null default false,
  billing_email text check(billing_email is null or (length(billing_email) between 3 and 254 and billing_email!~'[[:cntrl:]]')),
  version integer not null default 1 check(version between 1 and 2147483647),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default clock_timestamp()
);
create table erp_catalog.contact_billing_command (
  command_id uuid primary key, actor uuid not null references auth.users(id), request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
  result jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table erp_catalog.contact_billing_audit (
  id bigint generated always as identity primary key, contact_id uuid not null, actor uuid not null references auth.users(id), command_id uuid not null,
  before_data jsonb, after_data jsonb not null, created_at timestamptz not null default clock_timestamp()
);
-- Confirmations of an e-mail address of a contact by an explicit flow (none exists yet: the table starts empty).
create table erp_catalog.contact_email_verification (
  contact_id uuid not null references erp_catalog.contact(record_id),
  email text not null check(email=lower(btrim(email)) and length(email) between 3 and 254 and email!~'[[:cntrl:]]'),
  purpose text not null check(purpose in ('geral','cobranca')),
  confirmed_at timestamptz not null,
  method text not null check(method in ('link_transacional')),
  primary key(contact_id,email,purpose)
);
do $$ declare t text; begin foreach t in array array['contact_billing','contact_billing_command','contact_billing_audit','contact_email_verification'] loop
  execute format('alter table erp_catalog.%I enable row level security',t);
  execute format('revoke all on erp_catalog.%I from public,anon,authenticated,service_role',t);
end loop; end $$;
create function erp_catalog.contact_billing_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_catalog_audit_immutable' using errcode='55000'; end $$;
create trigger contact_billing_audit_immutable before update or delete on erp_catalog.contact_billing_audit for each row execute function erp_catalog.contact_billing_audit_immutable();

-- The selo: only an address confirmed for that purpose (each address of a ;-separated list must be confirmed).
create function erp_catalog.contact_email_verified(p_contact uuid,p_emails text,p_purpose text)
returns boolean language sql stable set search_path=pg_catalog as $$
  select coalesce(nullif(btrim(p_emails),'') is not null and not exists(select 1 from regexp_split_to_table(p_emails,'[;,]') x where btrim(x)<>''
    and not exists(select 1 from erp_catalog.contact_email_verification v where v.contact_id=p_contact and v.purpose=p_purpose and v.email=lower(btrim(x)))),false);
$$;

-- Endereço de cobrança efetivo: o geral quando o contato escolheu "Usar o endereço geral" ou não informou o de cobrança.
create function erp_catalog.contact_billing_address(p_contact uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select case when coalesce(b.same_as_general,false) or coalesce(nullif(btrim(concat(p.billing_street,p.billing_postal_code,p.billing_city)),''),'')=''
    then jsonb_build_object('source','geral','postal_code',c.postal_code,'state',c.state,'city',c.city,'district',c.district,'street',c.street,'number',c.number,'complement',c.complement,'foreign_state',null)
    else jsonb_build_object('source','cobranca','postal_code',p.billing_postal_code,'state',p.billing_state,'city',p.billing_city,'district',p.billing_district,'street',p.billing_street,
      'number',p.billing_number,'complement',p.billing_complement,'foreign_state',p.billing_foreign_state) end
  from erp_catalog.contact c left join erp_catalog.contact_profile p on p.record_id=c.record_id left join erp_catalog.contact_billing b on b.contact_id=c.record_id
  where c.record_id=p_contact;
$$;
create function erp_catalog.contact_billing_view(p_contact uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('contact_id',c.record_id,'same_as_general',coalesce(b.same_as_general,false),'billing_email',b.billing_email,
    'email_verified',erp_catalog.contact_email_verified(c.record_id,c.email,'geral'),
    'billing_email_verified',erp_catalog.contact_email_verified(c.record_id,b.billing_email,'cobranca'),
    -- Without the explicit confirmation flow (e-mail transacional), no address is shown as verified.
    'verification_available',false,'address',erp_catalog.contact_billing_address(c.record_id),'version',coalesce(b.version,0))
  from erp_catalog.contact c left join erp_catalog.contact_billing b on b.contact_id=c.record_id where c.record_id=p_contact;
$$;

create function public.erp_contact_billing_get(p_user_id uuid,p_contact_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  perform erp_catalog.require_access(p_user_id,'contacts',false);
  if p_contact_id is null or not exists(select 1 from erp_catalog.contact where record_id=p_contact_id)
    or not erp_catalog.contact_visible_to(erp_catalog.contact_scope(p_user_id),p_contact_id) then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity','contact_billing','data_mode','erp_native','operational_effects',false,'item',erp_catalog.contact_billing_view(p_contact_id));
end $$;

create function public.erp_contact_billing_save(p_user_id uuid,p_contact_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.contact_billing_command; v_row erp_catalog.contact_billing; v_before jsonb; v_result jsonb; v_email text; v_same boolean;
begin
  perform erp_catalog.require_access(p_user_id,'contacts',true);
  if p_contact_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or jsonb_typeof(p_data) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_data) k where k not in ('same_as_general','billing_email')) or not p_data?&array['same_as_general','billing_email']
    or jsonb_typeof(p_data->'same_as_general')<>'boolean' or jsonb_typeof(p_data->'billing_email') not in ('string','null') then
    raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
  v_same:=(p_data->>'same_as_general')::boolean; v_email:=nullif(btrim(p_data->>'billing_email'),'');
  if v_email is not null and (length(v_email)>254 or v_email~'[[:cntrl:]]' or not erp_catalog.contact_email_list(v_email,254)) then raise exception 'erp_catalog_contact_invalid:billing_email' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-contact-billing-v1','actor',p_user_id,'contact',p_contact_id,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(174852930,hashtext(p_command_id::text));
  select * into v_command from erp_catalog.contact_billing_command where command_id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
    return v_command.result||'{"replayed":true}'::jsonb;
  end if;
  if not exists(select 1 from erp_catalog.contact where record_id=p_contact_id) or not erp_catalog.contact_visible_to(erp_catalog.contact_scope(p_user_id),p_contact_id) then
    raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  perform 1 from erp_catalog.contact where record_id=p_contact_id for update;
  select * into v_row from erp_catalog.contact_billing where contact_id=p_contact_id for update;
  if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  v_before:=case when v_row.contact_id is null then null else erp_catalog.contact_billing_view(p_contact_id) end;
  insert into erp_catalog.contact_billing(contact_id,same_as_general,billing_email,version,updated_by) values(p_contact_id,v_same,v_email,1,p_user_id)
    on conflict(contact_id) do update set same_as_general=excluded.same_as_general,billing_email=excluded.billing_email,version=erp_catalog.contact_billing.version+1,
      updated_by=p_user_id,updated_at=clock_timestamp();
  v_result:=jsonb_build_object('entity','contact_billing','data_mode','erp_native','operational_effects',false,'replayed',false,'item',erp_catalog.contact_billing_view(p_contact_id));
  insert into erp_catalog.contact_billing_audit(contact_id,actor,command_id,before_data,after_data) values(p_contact_id,p_user_id,p_command_id,v_before,v_result->'item');
  insert into erp_catalog.contact_billing_command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  return v_result;
end $$;

revoke all on function erp_catalog.contact_billing_audit_immutable(),erp_catalog.contact_email_verified(uuid,text,text),erp_catalog.contact_billing_address(uuid),
  erp_catalog.contact_billing_view(uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_contact_billing_get(uuid,uuid)','erp_contact_billing_save(uuid,uuid,integer,uuid,jsonb)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
