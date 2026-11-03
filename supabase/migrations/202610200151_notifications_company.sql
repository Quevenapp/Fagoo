-- 151: barra superior e Empresa no padrão do Origin.
-- * Meu perfil: nome, e-mail, perfil e razão social da empresa para o menu do usuário e o painel da página inicial.
-- * Armazenamento: tamanho dos arquivos guardados no Storage do projeto (anexos, XMLs fiscais, arquivos de cobrança,
--   backup do Origin e certificado), lido dos metadados de storage.objects. Total para todos; detalhe só para administrador.
-- * Notificações (sino): um aviso por tipo e por dia (horário de São Paulo), gerado quando a barra superior lê as não lidas
--   (ao entrar na área da empresa) ou o usuário abre o sino, para os
--   destinatários escolhidos na Central de Notificações (página de preferências desta migração; sem escolha, os
--   administradores) que consultam o módulo do aviso. "Marcar como lida" é um comando idempotente.
-- * Dados da empresa: campos do Origin que a identidade fiscal (016) não tem, numa tabela própria com versão (CAS),
--   comando idempotente e auditoria em erp_company.audit. A identidade e a confirmação do regime continuam nas RPCs de 016.
-- * Usuários: Dispositivos utilizados (sessões do Supabase Auth) e Histórico do segundo fator, só leitura, administrador.
-- As colunas de auth.* são lidas só dentro de funções plpgsql (validadas na execução).
begin;

-- BEGIN GENERATED DEFINITIONS (tools/preferences/generate-definitions.mjs)
insert into erp_preferences.page(id,category,ordinal,scope,read_roles)values
 ('central-notificacoes','sistema',18,'company',array['admin','consulta','vendas','financeiro','estoque','fiscal']::text[]);
insert into erp_preferences.definition(key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format)values
 ('notificacoes.contas_pagar_atrasadas','central-notificacoes','notificacoes',1,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('notificacoes.contas_receber_atrasadas','central-notificacoes','notificacoes',2,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('notificacoes.estoque_abaixo_minimo','central-notificacoes','notificacoes',3,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('notificacoes.estoque_maximo','central-notificacoes','notificacoes',4,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('notificacoes.estoque_zerado','central-notificacoes','notificacoes',5,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('notificacoes.pagamento_efetuado','central-notificacoes','notificacoes',6,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('notificacoes.pagamento_recebido','central-notificacoes','notificacoes',7,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('notificacoes.proximo_contato','central-notificacoes','notificacoes',8,'users',null,'[]'::jsonb,null,null,null,null,100,null);
-- END GENERATED DEFINITIONS

create function erp_access.member_role(p_user uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare v text;
begin
 select role into v from erp_access.membership where user_id=p_user and active;
 if p_user is null or v is null then raise exception 'erp_access_member_required' using errcode='42501'; end if;
 return v;
end $$;

-- Meu perfil (menu do usuário e painel da página inicial).
create function public.erp_access_profile_me(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_email text;v_name text;v_company jsonb;
begin
 v_role:=erp_access.member_role(p_user_id);
 select lower(u.email) into v_email from auth.users u where u.id=p_user_id;
 select p.name into v_name from erp_access.profile p where p.user_id=p_user_id;
 select jsonb_build_object('legal_name',left(i.data->>'legal_name',200),'trade_name',left(i.data->>'trade_name',200)) into v_company from erp_company.identity i where i.singleton;
 return jsonb_build_object('scope','access_profile','data_mode','erp_native','user_id',p_user_id,'role',v_role,'name',v_name,
  'email',case when v_email~'^[^@ ]+@[^@ ]+\.[^@ ]+$' and length(v_email)<=254 then v_email end,'company',v_company);
end $$;

-- Espaço e armazenamento: bytes of the private buckets of the project, by group.
create function erp_access.storage_group(p_bucket text) returns text language sql immutable set search_path=pg_catalog as $$
 select case p_bucket when 'erp-attachments' then 'anexos' when 'origin-fiscal-xml' then 'fiscal' when 'brufap-fiscal-artifacts' then 'fiscal' when 'brufap-received-dfe' then 'fiscal'
  when 'brufap-cnab' then 'cobranca' when 'origin-backups' then 'backup' when 'brufap-a1-vault' then 'certificado' else 'outros' end
$$;
create function public.erp_access_storage(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_groups jsonb;v_total numeric;v_count bigint;
begin
 v_role:=erp_access.member_role(p_user_id);
 with o as materialized(select erp_access.storage_group(bucket_id) g,case when metadata->>'size'~'^[0-9]{1,15}$' then(metadata->>'size')::numeric else 0 end bytes from storage.objects),
  g as(select k.g,k.n,coalesce(sum(o.bytes),0) bytes,count(o.g) objects from unnest(array['anexos','fiscal','cobranca','backup','certificado','outros']) with ordinality k(g,n) left join o on o.g=k.g group by k.g,k.n)
 select(select coalesce(sum(bytes),0) from o),(select count(*) from o),jsonb_agg(jsonb_build_object('group',g,'bytes',bytes::text,'objects',objects::integer) order by n) into v_total,v_count,v_groups from g;
 return jsonb_build_object('scope','storage_usage','data_mode','erp_native','total_bytes',v_total::text,'objects',v_count::integer,'limit_bytes',null,
  'groups',case when v_role='admin' then v_groups end,'as_of',clock_timestamp());
end $$;

-- Notificações.
create table erp_home.notification_command(
 id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create table erp_home.notification(
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id),
 type text not null check(type in('contas_pagar_atrasadas','contas_receber_atrasadas','estoque_abaixo_minimo','estoque_maximo','estoque_zerado','pagamento_efetuado','pagamento_recebido','proximo_contato')),
 day date not null,
 quantity integer not null check(quantity>0),
 amount numeric(18,2) check(amount is null or amount>=0),
 created_at timestamptz not null default clock_timestamp(),
 read_at timestamptz,read_command uuid references erp_home.notification_command(id),
 unique(user_id,type,day),check((read_at is null)=(read_command is null))
);
create index erp_home_notification_user on erp_home.notification(user_id,created_at desc);
do $$declare t text;begin foreach t in array array['notification_command','notification'] loop
 execute format('alter table erp_home.%I enable row level security',t);
 execute format('revoke all on erp_home.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on all sequences in schema erp_home from public,anon,authenticated,service_role;
create trigger immutable_notification_command before update or delete on erp_home.notification_command for each row execute function erp_home.immutable_history();
-- A notification only changes once: unread to read, by a recorded command.
create function erp_home.guard_notification() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' or old.read_at is not null or new.read_at is null or new.id<>old.id or new.user_id<>old.user_id or new.type<>old.type or new.day<>old.day
  or new.quantity<>old.quantity or new.amount is distinct from old.amount or new.created_at<>old.created_at then
  raise exception 'erp_home_notification_immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger guard_notification before update or delete on erp_home.notification for each row execute function erp_home.guard_notification();
-- Who reads each type: finanças (008/010), estoque (009) and propostas (008).
create function erp_home.notification_roles(p_type text) returns text[] language sql immutable set search_path=pg_catalog as $$
 select case when p_type in('contas_pagar_atrasadas','contas_receber_atrasadas','pagamento_efetuado','pagamento_recebido') then array['admin','consulta','financeiro']
  when p_type in('estoque_abaixo_minimo','estoque_maximo','estoque_zerado') then array['admin','consulta','vendas','estoque','fiscal']
  when p_type='proximo_contato' then array['admin','consulta','financeiro','vendas'] else array[]::text[] end
$$;
create function erp_home.notification_types() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['contas_pagar_atrasadas','contas_receber_atrasadas','estoque_abaixo_minimo','estoque_maximo','estoque_zerado','pagamento_efetuado','pagamento_recebido','proximo_contato']
$$;
-- Recipients of the Central de Notificações; nobody chosen means the administradores.
create function erp_home.notification_recipient(p_user uuid,p_role text,p_type text) returns boolean language sql stable set search_path=pg_catalog as $$
 select p_role=any(erp_home.notification_roles(p_type)) and case when jsonb_array_length(coalesce(erp_preferences.get('notificacoes.'||p_type),'[]'::jsonb))=0 then p_role='admin'
  else erp_preferences.get('notificacoes.'||p_type)?(p_user::text) end
$$;
-- Today's digest of one type: (quantity, amount). Stock uses the considered warehouses (106) and the product limits (023).
create function erp_home.notification_digest(p_type text,p_today date) returns table(quantity integer,amount numeric) language sql stable set search_path=pg_catalog as $$
 select count(*)::integer,round(sum(t.amount_cents-t.settled_cents)/100.0,2) from erp_finance.title t
  where p_type in('contas_pagar_atrasadas','contas_receber_atrasadas') and t.kind=case p_type when 'contas_pagar_atrasadas' then 'payable' else 'receivable' end
   and not t.cancelled and t.due_on<p_today and t.amount_cents>t.settled_cents
 union all
 select count(*)::integer,round(sum(s.principal_cents)/100.0,2) from erp_finance.settlement s join erp_finance.title t on t.id=s.title_id
  where p_type in('pagamento_efetuado','pagamento_recebido') and t.kind=case p_type when 'pagamento_efetuado' then 'payable' else 'receivable' end
   and s.kind='payment' and s.posted_on=p_today and not exists(select 1 from erp_finance.settlement r where r.reverses_id=s.id)
 union all
 select count(*)::integer,null from(select p.record_id,p.stock_min,p.stock_max,erp_stock.count_physical(p.record_id,null) stock,exists(select 1 from erp_stock.balance b where b.product_id=p.record_id) positioned
   from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where r.active and coalesce(p.kind,'P')='P') x
  where p_type='estoque_abaixo_minimo' and x.stock_min is not null and x.stock<x.stock_min
   or p_type='estoque_maximo' and x.stock_max is not null and x.stock_max>0 and x.stock>=x.stock_max
   or p_type='estoque_zerado' and x.positioned and x.stock<=0
 union all
 select count(*)::integer,null from erp_documents.document d
  where p_type='proximo_contato' and d.kind='sales_proposals' and d.status not in('completed','cancelled','rejected') and d.body->>'next_contact'=to_char(p_today,'YYYY-MM-DD')
$$;
create function erp_home.notification_dto(n erp_home.notification) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',n.id::text,'type',n.type,'day',to_char(n.day,'YYYY-MM-DD'),'quantity',n.quantity,'amount',case when n.amount is null then null else n.amount::numeric(18,2)::text end,
  'created_at',n.created_at,'read',n.read_at is not null)
$$;
create function erp_home.notifications_view(p_user uuid,p_role text,p_tab text) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('scope','notifications','data_mode','erp_native','tab',p_tab,'role',p_role,'business_date',to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD'),
  'unread',(select count(*)::integer from erp_home.notification n where n.user_id=p_user and n.read_at is null and p_role=any(erp_home.notification_roles(n.type))),
  'items',coalesce((select jsonb_agg(erp_home.notification_dto(n) order by n.created_at desc,n.id desc) from(select * from erp_home.notification n where n.user_id=p_user and p_role=any(erp_home.notification_roles(n.type))
   and(p_tab='todas' or n.read_at is null) order by n.created_at desc,n.id desc limit 100) n),'[]'::jsonb))
$$;
-- Opening the bell creates today's notifications the user receives (once per type and day), then lists them.
create function public.erp_home_notifications(p_user_id uuid,p_tab text) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text;v_today date;t text;d record;
begin
 v_role:=erp_access.member_role(p_user_id);
 if p_tab is null or p_tab not in('nao_lidas','todas') then raise exception 'erp_home_notifications_input_invalid' using errcode='22023'; end if;
 v_today:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
 foreach t in array erp_home.notification_types() loop
  if erp_home.notification_recipient(p_user_id,v_role,t) and not exists(select 1 from erp_home.notification n where n.user_id=p_user_id and n.type=t and n.day=v_today) then
   select * into d from erp_home.notification_digest(t,v_today) x where x.quantity>0 limit 1;
   if d.quantity is not null then insert into erp_home.notification(user_id,type,day,quantity,amount) values(p_user_id,t,v_today,d.quantity,d.amount) on conflict(user_id,type,day) do nothing; end if;
  end if;
 end loop;
 return erp_home.notifications_view(p_user_id,v_role,p_tab);
end $$;
-- "Marcar todas como lida" (p_ids null) or one notification; the same command replays its receipt.
create function public.erp_home_notifications_read(p_user_id uuid,p_command_id uuid,p_ids jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text;v_hash text;c erp_home.notification_command;v_ids bigint[];v_marked integer;v_result jsonb;
begin
 v_role:=erp_access.member_role(p_user_id);
 if p_command_id is null or p_ids is not null and(jsonb_typeof(p_ids)<>'array' or jsonb_array_length(p_ids) not between 1 and 100
  or exists(select 1 from jsonb_array_elements(p_ids) x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[1-9][0-9]{0,17}$')) then
  raise exception 'erp_home_notifications_input_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-home-notifications-read-v1','actor',p_user_id,'ids',p_ids)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtext('erp_home_notification_command'),hashtext(p_command_id::text));
 select * into c from erp_home.notification_command where id=p_command_id;
 if c.id is not null then
  if c.actor<>p_user_id or c.request_hash<>v_hash then raise exception 'erp_home_notifications_command_conflict' using errcode='40001'; end if;
  return c.result||jsonb_build_object('view',erp_home.notifications_view(p_user_id,v_role,'nao_lidas'),'replayed',true);
 end if;
 v_ids:=case when p_ids is null then null else array(select(x#>>'{}')::bigint from jsonb_array_elements(p_ids) x) end;
 if v_ids is not null and exists(select 1 from unnest(v_ids) i where not exists(select 1 from erp_home.notification n where n.id=i and n.user_id=p_user_id)) then
  raise exception 'erp_home_notification_not_found' using errcode='P0002'; end if;
 -- Rows are locked first, so the receipt written with the command has the exact count of what this command marks.
 perform 1 from erp_home.notification n where n.user_id=p_user_id and n.read_at is null and(v_ids is null or n.id=any(v_ids)) for update;
 select count(*)::integer into v_marked from erp_home.notification n where n.user_id=p_user_id and n.read_at is null and v_role=any(erp_home.notification_roles(n.type)) and(v_ids is null or n.id=any(v_ids));
 v_result:=jsonb_build_object('scope','notifications_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'all',p_ids is null,'marked',v_marked,'changed_at',clock_timestamp()));
 insert into erp_home.notification_command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 update erp_home.notification n set read_at=clock_timestamp(),read_command=p_command_id
  where n.user_id=p_user_id and n.read_at is null and v_role=any(erp_home.notification_roles(n.type)) and(v_ids is null or n.id=any(v_ids));
 return v_result||jsonb_build_object('view',erp_home.notifications_view(p_user_id,v_role,'nao_lidas'),'replayed',false);
end $$;
-- Dados da empresa do Origin que a identidade (016) não guarda: Tipo da Pessoa, Isento, Inscrição Municipal, Suframa, CNAE,
-- Tamanho da empresa, Seu segmento, Faturamento do último ano, Quantidade de funcionários, Contato e Inscrições Estaduais
-- dos substitutos tributários. Lido por todo membro ativo (como a identidade); alterado só pelo administrador.
create table erp_company.extra(
 singleton boolean primary key default true check(singleton),
 version integer not null check(version between 1 and 2147483647),
 data jsonb not null check(jsonb_typeof(data)='object'),
 updated_at timestamptz not null,updated_by uuid not null references auth.users(id),command_id uuid not null
);
alter table erp_company.extra enable row level security;
revoke all on erp_company.extra from public,anon,authenticated,service_role;
create function erp_company.extra_text(p jsonb,p_max integer,p_pattern text default null) returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
 if p is null or p='null'::jsonb then return null; end if;
 if jsonb_typeof(p)<>'string' then raise exception 'erp_company_extra_invalid' using errcode='22023'; end if;
 v:=p#>>'{}';
 if v='' then return null; end if;
 if length(v)>p_max or v<>btrim(v) or v~'[[:cntrl:]]' or p_pattern is not null and v!~p_pattern then raise exception 'erp_company_extra_invalid' using errcode='22023'; end if;
 return v;
end $$;
create function erp_company.extra_choice(p jsonb,p_options text[]) returns text language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p is null or p='null'::jsonb then return null; end if;
 if jsonb_typeof(p)<>'string' or not(p#>>'{}')=any(p_options) then raise exception 'erp_company_extra_invalid' using errcode='22023'; end if;
 return p#>>'{}';
end $$;
create function erp_company.extra_normalize(p jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_keys text[]:=array['billing_email','cnae','company_size','contacts','employees','ie_exempt','mobile','municipal_registration','person_type','revenue','segments','site','substitute_ies','suframa'];
 v_segments jsonb;v_ies jsonb:='[]';e jsonb;v_ufs text[]:='{}';v_cnae text;
begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>16384 or(select array_agg(k order by k) from jsonb_object_keys(p) k)<>v_keys
  or jsonb_typeof(p->'ie_exempt')<>'boolean' or jsonb_typeof(p->'segments')<>'array' or jsonb_typeof(p->'substitute_ies')<>'array' or jsonb_array_length(p->'substitute_ies')>27
  or exists(select 1 from jsonb_array_elements(p->'segments') x where jsonb_typeof(x)<>'string' or not(x#>>'{}')=any(array['comercio','ecommerce','industria','servicos']))
  or(select count(distinct x) from jsonb_array_elements_text(p->'segments') x)<>jsonb_array_length(p->'segments') or jsonb_array_length(p->'segments')=0 then
  raise exception 'erp_company_extra_invalid' using errcode='22023'; end if;
 select jsonb_agg(s order by n) into v_segments from unnest(array['comercio','ecommerce','industria','servicos']) with ordinality x(s,n) where p->'segments'?s;
 for e in select x from jsonb_array_elements(p->'substitute_ies') x loop
  if jsonb_typeof(e)<>'object' or(select array_agg(k order by k) from jsonb_object_keys(e) k)<>array['ie','uf'] or jsonb_typeof(e->'uf')<>'string' or jsonb_typeof(e->'ie')<>'string'
   or e->>'uf'!~'^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$' or e->>'uf'=any(v_ufs) or e->>'ie'!~'^[0-9A-Za-z./-]{2,20}$' then
   raise exception 'erp_company_extra_invalid' using errcode='22023'; end if;
  v_ufs:=v_ufs||(e->>'uf');v_ies:=v_ies||jsonb_build_array(jsonb_build_object('uf',e->>'uf','ie',e->>'ie'));
 end loop;
 -- CNAE subclasse: 7 dígitos, guardado como NNNN-N/NN.
 v_cnae:=erp_company.extra_text(p->'cnae',9,'^[0-9]{4}-?[0-9]/?[0-9]{2}$');
 if v_cnae is not null then v_cnae:=translate(v_cnae,'-/','');v_cnae:=left(v_cnae,4)||'-'||substr(v_cnae,5,1)||'/'||right(v_cnae,2); end if;
 return jsonb_build_object('person_type',coalesce(erp_company.extra_choice(p->'person_type',array['juridica','fisica']),'juridica'),'ie_exempt',(p->>'ie_exempt')::boolean,
  'municipal_registration',erp_company.extra_text(p->'municipal_registration',30,'^[0-9A-Za-z./-]+$'),'suframa',erp_company.extra_text(p->'suframa',12,'^[0-9]{8,12}$'),'cnae',v_cnae,
  'company_size',erp_company.extra_choice(p->'company_size',array['mei','micro','pequena','media','grande']),'segments',v_segments,
  'revenue',erp_company.extra_choice(p->'revenue',array['ate_60k','de_60k_360k','acima_360k']),'employees',erp_company.extra_choice(p->'employees',array['ate_5','de_5_10','mais_10']),
  'contacts',erp_company.extra_text(p->'contacts',120),'mobile',erp_company.extra_text(p->'mobile',20,'^\+?[0-9() -]{8,20}$'),
  'billing_email',erp_company.extra_text(p->'billing_email',254,'^[^@ ]+@[^@ ]+\.[^@ ]+$'),'site',erp_company.extra_text(p->'site',200,'^[^ ]+\.[^ ]+$'),'substitute_ies',v_ies);
end $$;
create function erp_company.extra_dto() returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('version',version,'data',data,'updated_at',updated_at) from erp_company.extra where singleton
$$;
create function public.erp_company_extra_get(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=erp_company.require_access(p_user_id,'read');
 return jsonb_build_object('scope','company_extra','data_mode','erp_native','can_manage',v_role='admin','record',erp_company.extra_dto());
end $$;
create function public.erp_company_extra_save(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_data jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_command erp_company.command%rowtype;v_row erp_company.extra%rowtype;v_data jsonb;v_before jsonb;v_result jsonb;v_at timestamptz;
begin
 perform erp_company.require_access(p_user_id,'identity');
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 then raise exception 'erp_company_command_invalid' using errcode='22023'; end if;
 v_data:=erp_company.extra_normalize(p_data);
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','extra','actor',p_user_id,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852920,1);
 select * into v_command from erp_company.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_company_command_conflict' using errcode='40001'; end if;
  perform erp_company.require_access(p_user_id,'identity');
  return v_command.result||jsonb_build_object('record',erp_company.extra_dto(),'replayed',true);
 end if;
 select * into v_row from erp_company.extra where singleton for update;
 if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_company_version_conflict' using errcode='40001'; end if;
 if v_row.data=v_data then raise exception 'erp_company_extra_unchanged' using errcode='22023'; end if;
 v_before:=erp_company.extra_dto();v_at:=clock_timestamp();
 if v_row.version is null then insert into erp_company.extra(singleton,version,data,updated_at,updated_by,command_id) values(true,1,v_data,v_at,p_user_id,p_command_id);
 else update erp_company.extra set data=v_data,version=version+1,updated_at=v_at,updated_by=p_user_id,command_id=p_command_id where singleton and version=p_expected_version; end if;
 v_result:=jsonb_build_object('scope','company_extra_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'from_version',p_expected_version,'to_version',p_expected_version+1,'changed_at',v_at));
 insert into erp_company.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,'save_extra',v_before,erp_company.extra_dto());
 insert into erp_company.command values(p_command_id,p_user_id,v_hash,v_result,v_at);
 perform erp_company.require_access(p_user_id,'identity');
 return v_result||jsonb_build_object('record',erp_company.extra_dto(),'replayed',false);
end $$;

-- Sistema > Usuários, menu ⋮: Dispositivos utilizados (sessões do Auth) e Histórico do segundo fator. Nunca lê segredos.
create function public.erp_access_user_security(p_user_id uuid,p_target uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_sessions jsonb:='[]';v_factors jsonb:='[]';v_challenges jsonb:='[]';
begin
 perform erp_access.read_admin(p_user_id);
 if p_target is null then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
 if not exists(select 1 from auth.users where id=p_target) then raise exception 'erp_access_user_not_found' using errcode='P0002'; end if;
 if to_regclass('auth.sessions') is not null then
  execute $q$select coalesce(jsonb_agg(jsonb_build_object('last_access',coalesce(s.refreshed_at::timestamptz,s.updated_at,s.created_at),'created_at',s.created_at,
    'ip',left(host(s.ip),45),'device',left(btrim(regexp_replace(coalesce(s.user_agent,''),'[[:cntrl:]]',' ','g')),300),'aal',s.aal::text) order by coalesce(s.refreshed_at::timestamptz,s.updated_at,s.created_at) desc),'[]'::jsonb)
   from(select * from auth.sessions where user_id=$1 order by coalesce(refreshed_at::timestamptz,updated_at,created_at) desc limit 50) s$q$ into v_sessions using p_target;
 end if;
 if to_regclass('auth.mfa_factors') is not null then
  execute $q$select coalesce(jsonb_agg(jsonb_build_object('type',f.factor_type::text,'status',f.status::text,'created_at',f.created_at) order by f.created_at),'[]'::jsonb)
   from(select factor_type,status,created_at from auth.mfa_factors where user_id=$1 order by created_at limit 20) f$q$ into v_factors using p_target;
  if to_regclass('auth.mfa_challenges') is not null then
   execute $q$select coalesce(jsonb_agg(jsonb_build_object('created_at',c.created_at,'ip',left(host(c.ip_address),45),'type',c.factor_type,'valid',c.verified_at is not null) order by c.created_at desc),'[]'::jsonb)
    from(select ch.created_at,ch.ip_address,ch.verified_at,f.factor_type::text factor_type from auth.mfa_challenges ch join auth.mfa_factors f on f.id=ch.factor_id
     where f.user_id=$1 order by ch.created_at desc limit 50) c$q$ into v_challenges using p_target;
  end if;
 end if;
 return jsonb_build_object('scope','access_user_security','data_mode','erp_native','user_id',p_target,
  'mfa',(select count(*)>0 from jsonb_array_elements(v_factors) f where f->>'status'='verified'),'sessions',v_sessions,'factors',v_factors,'challenges',v_challenges);
end $$;

revoke all on function erp_access.member_role(uuid),erp_access.storage_group(text) from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_home from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_company from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_access_profile_me','erp_access_storage','erp_home_notifications','erp_home_notifications_read','erp_company_extra_get','erp_company_extra_save','erp_access_user_security')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
