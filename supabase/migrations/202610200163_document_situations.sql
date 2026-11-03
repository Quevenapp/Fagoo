-- 163: o Gerenciador de transições (148) passa a valer nos pedidos de venda, pedidos de compra e ordens de serviço.
-- * Os três tipos são registrados em erp_preferences.situation_adoption: as ações das transições (Estornar estoque,
--   Estornar contas, Lançar estoque e Lançar contas) deixam de ser recusadas no Gerenciador e passam a rodar na mesma
--   transação da mudança de situação.
-- * Situação personalizada do documento: erp_documents.document_situation (o status continua sendo a situação-base, que
--   rege editabilidade, travas de estoque, contas, reservas e recebimentos, relatórios e a página inicial). Sem linha, vale
--   a situação padrão do status. Qualquer mudança do status por outro caminho volta o documento à situação padrão.
-- * erp_document_transition aceita a chave da situação (o status-base ou o id da situação personalizada) e segue
--   erp_preferences.transition_rule: a transição precisa existir e estar ativa (a situação de destino também). O motivo
--   segue a regra de 103 entre situações-base diferentes. As ações rodam com o perfil de quem muda a situação, com as
--   mesmas funções e conferências dos lançamentos manuais: estornos antes da mudança, lançamentos depois; um lançamento
--   ativo não é repetido; categoria padrão (Preferências › Finanças: Padrão venda/serviço/compra) e as parcelas salvas
--   do documento; a data do estoque segue Preferências › Estoque ("Ao lançar estoque utilizar data atual ou data
--   entrada/saída"; uma data futura vira a data atual). Faltando dado ou permissão, nada muda.
-- * Ocorrências guardam a situação antes/depois (nome e cor do momento). "Permite a edição da data e hora das
--   ocorrências" (Preferências › Empresa): desligada, a ocorrência registra a data e a hora atuais (São Paulo); ligada,
--   aceita a data e a hora informadas até agora. O horário real continua em recorded_at.
-- * Listagem: a linha traz a situação (chave, nome e cor) e se o pedido tem nota vinculada (para todos os perfis; número
--   e data da nota continuam só para administrador e fiscal, como em 113/131); o filtro p_situations escolhe situações
--   exatas; "Tornar padrão" aceita situações personalizadas.
-- Requer 008, 017, 018, 070, 090, 102, 103, 104, 115, 129, 131 e 148.
begin;

insert into erp_preferences.situation_adoption(kind,migration) values
 ('sales_orders','202610200163'),('purchase_orders','202610200163'),('service_orders','202610200163')
 on conflict(kind) do nothing;

-- Current custom situação of a document (no row: the situação padrão of its status).
create table erp_documents.document_situation (
 document_id uuid primary key references erp_documents.document(id),
 kind text not null check(kind in('sales_orders','purchase_orders','service_orders')),
 situation_id uuid not null references erp_preferences.situation(id),
 base_status text not null check(base_status~'^[a-z_]{2,40}$'),
 actor uuid not null references auth.users(id),
 command_id uuid not null,
 set_at timestamptz not null default clock_timestamp()
);
create index erp_documents_document_situation_id on erp_documents.document_situation(situation_id);
alter table erp_documents.document_situation enable row level security;
revoke all on erp_documents.document_situation from public,anon,authenticated,service_role;

-- A status changed by any other path (recebimento, conversão, versão antiga da API) returns to the situação padrão.
create function erp_documents.situation_follow_status() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
 if new.status is distinct from old.status then
  delete from erp_documents.document_situation where document_id=new.id and base_status<>new.status;
 end if;
 return null;
end $$;
create trigger situation_follow_status after update of status on erp_documents.document for each row execute function erp_documents.situation_follow_status();

-- Situações and occurrences: the occurrence keeps the situação (key, name, color) of the moment.
alter table erp_documents.occurrence add column situation_before jsonb, add column situation_after jsonb;
alter table erp_documents.occurrence add constraint occurrence_situation_shape check(
 (situation_before is null or (jsonb_typeof(situation_before)='object' and jsonb_typeof(situation_before->'key')='string' and jsonb_typeof(situation_before->'name')='string'))
 and (situation_after is null or (jsonb_typeof(situation_after)='object' and jsonb_typeof(situation_after->'key')='string' and jsonb_typeof(situation_after->'name')='string')));

create function erp_documents.situation_adopted(p_kind text) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce(p_kind in('sales_orders','purchase_orders','service_orders') and exists(select 1 from erp_preferences.situation_adoption a where a.kind=p_kind),false)
$$;
-- The situação as the screens show it (null outside the adopted kinds or when the custom row vanished).
create function erp_documents.situation_json(p_kind text,p_status text,p_situation uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select case when not erp_documents.situation_adopted(p_kind) then null
  when p_situation is null then jsonb_build_object('key',p_status,'base_status',p_status,'name',erp_preferences.situation_base_label(p_kind,p_status),
   'color',erp_preferences.situation_base_color(p_status),'default',true)
  else (select jsonb_build_object('key',s.id::text,'base_status',s.base_status,'name',s.name,'color',s.color,'default',false)
   from erp_preferences.situation s where s.id=p_situation and s.kind=p_kind) end
$$;
create function erp_documents.document_situation_json(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_documents.situation_json(d.kind,d.status,(select s.situation_id from erp_documents.document_situation s where s.document_id=d.id))
 from erp_documents.document d where d.id=p_id
$$;
-- dto (008/019) plus the situação and the name of the native vendedor (164); used by the single-document reads and the
-- transition result.
create function erp_documents.document_view(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_documents.dto(p_id)||jsonb_build_object('situation',erp_documents.document_situation_json(p_id),
  'seller_name',(select left(r.name,200) from erp_documents.document d join erp_catalog.seller s on s.id::text=d.body->>'seller_id' join erp_catalog.record r on r.id=s.contact_id where d.id=p_id))
$$;
-- Occurrence snapshot of a situação: key, name and color only.
create function erp_documents.situation_snapshot(p jsonb) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select case when p is null then null else jsonb_build_object('key',p->>'key','name',p->>'name','color',p->>'color') end
$$;
create function erp_documents.situation_key_valid(p_kind text,p_key text) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce((erp_documents.transitions()->p_kind)?p_key
  or (p_key~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and exists(select 1 from erp_preferences.situation s where s.id=p_key::uuid and s.kind=p_kind)),false)
$$;

-- 103 record_occurrence plus the situação before/after (same session settings for date, time, text and next contact).
create function erp_documents.record_situation_occurrence(p_document uuid,p_actor uuid,p_command uuid,p_version integer,p_before text,p_after text,p_text text,
 p_situation_before jsonb,p_situation_after jsonb)
returns erp_documents.occurrence language plpgsql set search_path=pg_catalog as $$
declare v erp_documents.occurrence; v_role text;
begin
 select role into v_role from erp_access.membership where user_id=p_actor and active;
 insert into erp_documents.occurrence(document_id,sequence,occurred_on,occurred_time,text,status_before,status_after,next_contact,actor_id,actor_role,command_id,document_version,situation_before,situation_after)
 values(p_document,(select coalesce(max(sequence),0)+1 from erp_documents.occurrence where document_id=p_document),
  coalesce(nullif(current_setting('erp_documents.occurrence_on',true),'')::date,(clock_timestamp() at time zone 'America/Sao_Paulo')::date),
  coalesce(nullif(current_setting('erp_documents.occurrence_time',true),''),to_char(clock_timestamp() at time zone 'America/Sao_Paulo','HH24:MI')),
  coalesce(nullif(current_setting('erp_documents.occurrence_text',true),''),p_text),
  p_before,p_after,nullif(current_setting('erp_documents.occurrence_next_contact',true),'')::date,p_actor,coalesce(v_role,'desconhecido'),p_command,p_version,
  erp_documents.situation_snapshot(p_situation_before),erp_documents.situation_snapshot(p_situation_after))
 returning * into v;
 return v;
end $$;
create or replace function erp_documents.occurrence_json(o erp_documents.occurrence) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('id',o.id,'sequence',o.sequence,'occurred_on',o.occurred_on::text,'occurred_time',o.occurred_time,'text',o.text,
  'status_before',o.status_before,'status_after',o.status_after,'next_contact',o.next_contact::text,'actor_id',o.actor_id,'actor_role',o.actor_role,
  'document_version',o.document_version,'recorded_at',o.recorded_at,'situation_before',o.situation_before,'situation_after',o.situation_after)
$$;

-- Transition actions: the same functions and checks as the manual postings, with derived commands of the transition.
create function erp_documents.transition_command(p_command uuid,p_action text) returns uuid language sql immutable set search_path=pg_catalog as $$
 select md5('situation-transition:'||p_action||':'||p_command::text)::uuid
$$;
create function erp_documents.current_version(p_id uuid) returns integer language sql stable set search_path=pg_catalog as $$
 select version from erp_documents.document where id=p_id
$$;
-- Preferências › Estoque "Ao lançar estoque utilizar data atual ou data entrada/saída" (a future date becomes today).
create function erp_documents.stock_launch_date(p_id uuid) returns date language sql stable set search_path=pg_catalog as $$
 select least((clock_timestamp() at time zone 'America/Sao_Paulo')::date,
  case when erp_documents.preference('estoque.data_lancamento')='"data_documento"'::jsonb then
   coalesce(case when d.kind in('sales_orders','service_orders') then (d.body->>'ship_date')::date else (d.body->>'expected_date')::date end,(d.body->>'date')::date)
  else (clock_timestamp() at time zone 'America/Sao_Paulo')::date end)
 from erp_documents.document d where d.id=p_id
$$;
create function erp_documents.transition_action(p_user_id uuid,p_kind text,p_id uuid,p_command uuid,p_action text,p_label text) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare v_posting record; v_preview jsonb; v_day date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_reason text; v_category uuid; v_result jsonb; v_titles jsonb;
begin
 v_reason:=left(case when p_action like 'reverse_%' then 'Estorno pela mudança de situação para ' else 'Lançamento pela mudança de situação para ' end||p_label,500);
 if p_action='reverse_stock' then
  select id,version into v_posting from erp_stock.document_posting where document_id=p_id and state='active';
  if v_posting.id is null then return jsonb_build_object('action',p_action,'outcome','skipped'); end if;
  v_preview:=public.erp_document_stock_reverse_preview(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_posting.id,v_posting.version,v_day,v_reason)->'preview';
  v_result:=public.erp_document_stock_reverse(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_posting.id,v_posting.version,erp_documents.transition_command(p_command,p_action),
   v_preview->>'preview_hash',v_day,v_reason);
  return jsonb_build_object('action',p_action,'outcome','done','posting_id',v_posting.id);
 elsif p_action='reverse_finance' then
  select id,version into v_posting from erp_finance.document_posting where document_id=p_id and state='active';
  if v_posting.id is null then return jsonb_build_object('action',p_action,'outcome','skipped'); end if;
  v_preview:=public.erp_document_finance_reverse_preview(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_posting.id,v_posting.version)->'preview';
  select coalesce(jsonb_agg(jsonb_build_object('id',t->>'id','version',(t->>'version')::integer)),'[]'::jsonb) into v_titles from jsonb_array_elements(v_preview->'titles') t;
  v_result:=public.erp_document_finance_reverse(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_posting.id,v_posting.version,erp_documents.transition_command(p_command,p_action),
   v_preview->>'preview_hash',v_titles,v_reason);
  return jsonb_build_object('action',p_action,'outcome','done','posting_id',v_posting.id);
 elsif p_action='post_stock' then
  if exists(select 1 from erp_stock.document_posting where document_id=p_id and state='active') then return jsonb_build_object('action',p_action,'outcome','skipped'); end if;
  v_day:=erp_documents.stock_launch_date(p_id);
  v_preview:=public.erp_document_stock_preview(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_day,v_reason)->'preview';
  v_result:=public.erp_document_stock_post(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),erp_documents.transition_command(p_command,p_action),
   v_preview->>'preview_hash',v_day,v_reason,coalesce((select jsonb_agg(i->'id') from jsonb_array_elements(v_preview->'ignored') i),'[]'::jsonb));
  return jsonb_build_object('action',p_action,'outcome','done','posting_id',v_result#>>'{posting,id}');
 elsif p_action='post_finance' then
  if exists(select 1 from erp_finance.document_posting where document_id=p_id and state='active') then return jsonb_build_object('action',p_action,'outcome','skipped'); end if;
  select category_id into v_category from erp_finance.category_default where key=case p_kind when 'sales_orders' then 'sale' when 'service_orders' then 'service' else 'purchase' end;
  if v_category is null then raise exception 'erp_document_transition_category_required' using errcode='22023'; end if;
  v_preview:=public.erp_document_finance_preview(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),v_category,null)->'preview';
  v_result:=public.erp_document_finance_post(p_user_id,p_kind,p_id,erp_documents.current_version(p_id),erp_documents.transition_command(p_command,p_action),v_preview->>'preview_hash',v_category,null);
  return jsonb_build_object('action',p_action,'outcome','done','posting_id',v_result#>>'{posting,id}');
 end if;
 raise exception 'erp_document_transition_action_invalid' using errcode='22023';
end $$;

-- 103 for propostas; pedidos de venda, pedidos de compra and OS follow the Gerenciador de transições (p_status is the key of
-- the target situação: a status-base or the id of a custom situação). Same hash as before, so older commands still replay.
create or replace function public.erp_document_transition(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,
 p_command_id uuid,p_status text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_before jsonb; v_result jsonb; v_reason text;
 v_current uuid; v_from_key text; v_rule jsonb; v_target jsonb; v_pair_active boolean; v_to_base text; v_custom uuid; v_actions text[]; v_action text;
 v_effects jsonb:='[]'; v_from_situation jsonb; v_to_situation jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','transition','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,'status',p_status,'reason',p_reason)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_reason:=erp_documents.text_value(to_jsonb(p_reason),1000);
 if not erp_documents.situation_adopted(p_kind) then
  if p_status is null or not coalesce((erp_documents.transitions()#>array[p_kind,v_row.status])?p_status,false) then
   raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
  if erp_documents.transition_reason_required(p_kind,v_row.status,p_status) and coalesce(length(v_reason),0)<3 then
   raise exception 'erp_document_reason_required' using errcode='22023'; end if;
  if coalesce((v_row.body->>'template')::boolean,false) and p_status='approved' then raise exception 'erp_document_template_not_approvable' using errcode='22023'; end if;
  v_before:=erp_documents.dto(p_id);
  update erp_documents.document set status=p_status,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
  perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_row.version+1,v_row.status,p_status,v_reason);
  v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(p_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
  insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
   values(p_user_id,p_command_id,p_id,'transition',v_reason,v_before,erp_documents.dto(p_id));
  insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  return v_result;
 end if;
 select situation_id into v_current from erp_documents.document_situation where document_id=p_id;
 v_from_key:=coalesce(v_current::text,v_row.status);
 if p_status is null or p_status=v_from_key or not erp_documents.situation_key_valid(p_kind,p_status) then
  raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
 v_rule:=erp_preferences.transition_rule(p_kind,v_from_key,p_status);
 v_target:=erp_preferences.situation_of(p_kind,p_status);
 if v_rule is null or v_target is null or not (v_rule->>'configured')::boolean then raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
 -- The pair must be active and the target situação too; leaving an inactive situação stays possible.
 v_pair_active:=coalesce((select t.active from erp_preferences.transition t where t.kind=p_kind and t.from_key=v_from_key and t.to_key=p_status),true);
 if not v_pair_active or not (v_target->>'active')::boolean then raise exception 'erp_document_transition_inactive' using errcode='22023'; end if;
 v_to_base:=v_rule->>'to_base';
 v_custom:=case when (v_target->>'default')::boolean then null else p_status::uuid end;
 if v_to_base<>v_row.status and erp_documents.transition_reason_required(p_kind,v_row.status,v_to_base) and coalesce(length(v_reason),0)<3 then
  raise exception 'erp_document_reason_required' using errcode='22023'; end if;
 v_actions:=array(select jsonb_array_elements_text(v_rule->'actions'));
 v_from_situation:=erp_documents.situation_json(p_kind,v_row.status,v_current);
 v_before:=erp_documents.document_view(p_id);
 foreach v_action in array array['reverse_stock','reverse_finance'] loop
  if v_action=any(v_actions) then v_effects:=v_effects||jsonb_build_array(erp_documents.transition_action(p_user_id,p_kind,p_id,p_command_id,v_action,v_target->>'name')); end if;
 end loop;
 update erp_documents.document set status=v_to_base,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 delete from erp_documents.document_situation where document_id=p_id;
 if v_custom is not null then
  insert into erp_documents.document_situation(document_id,kind,situation_id,base_status,actor,command_id) values(p_id,p_kind,v_custom,v_to_base,p_user_id,p_command_id);
 end if;
 foreach v_action in array array['post_stock','post_finance'] loop
  if v_action=any(v_actions) then v_effects:=v_effects||jsonb_build_array(erp_documents.transition_action(p_user_id,p_kind,p_id,p_command_id,v_action,v_target->>'name')); end if;
 end loop;
 v_to_situation:=erp_documents.situation_json(p_kind,v_to_base,v_custom);
 perform erp_documents.record_situation_occurrence(p_id,p_user_id,p_command_id,erp_documents.current_version(p_id),v_row.status,
  case when v_to_base<>v_row.status then v_to_base end,v_reason,v_from_situation,v_to_situation);
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.document_view(p_id),'effects',v_effects,'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
  values(p_user_id,p_command_id,p_id,'transition',v_reason,v_before,erp_documents.document_view(p_id)||jsonb_build_object('effects',v_effects));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 103 with the situação keys of the adopted kinds and Preferências › Empresa "Permite a edição da data e hora das ocorrências".
create or replace function public.erp_document_occurrence_add(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,
 p_occurred_on text,p_occurred_time text,p_text text default null,p_status text default null,p_next_contact text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_on date; v_time text; v_text text; v_next date; v_change boolean; v_before jsonb; v_result jsonb;
 v_last erp_documents.occurrence; v_adopted boolean; v_key text; v_now timestamp:=clock_timestamp() at time zone 'America/Sao_Paulo';
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 v_adopted:=erp_documents.situation_adopted(p_kind);
 if p_document_id is null or p_expected_version is null or p_expected_version<1 or p_occurred_time is null or p_occurred_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or (p_status is not null and not (case when v_adopted then erp_documents.situation_key_valid(p_kind,p_status) else (erp_documents.transitions()->p_kind)?p_status end))
  or (p_next_contact is not null and p_kind<>'sales_proposals') then
  raise exception 'erp_document_occurrence_invalid' using errcode='22023'; end if;
 v_on:=erp_documents.date_value(to_jsonb(p_occurred_on),true);
 v_text:=erp_documents.text_value(to_jsonb(p_text),1000,false,true);
 v_next:=erp_documents.date_value(to_jsonb(p_next_contact));
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','occurrence','actor',p_user_id,'kind',p_kind,'id',p_document_id,'version',p_expected_version,
  'occurred_on',p_occurred_on,'occurred_time',p_occurred_time,'text',p_text,'status',p_status,'next_contact',p_next_contact)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 -- Without the preference the occurrence keeps the current date and time; with it, any moment up to now.
 if erp_documents.preference('empresa.editar_data_ocorrencia')='true'::jsonb then
  v_time:=p_occurred_time;
  if v_on+v_time::time>date_trunc('minute',v_now) then raise exception 'erp_document_occurrence_future' using errcode='22023'; end if;
 else
  v_on:=v_now::date; v_time:=to_char(v_now,'HH24:MI');
 end if;
 select * into v_row from erp_documents.document where id=p_document_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_key:=case when v_adopted then coalesce((select s.situation_id::text from erp_documents.document_situation s where s.document_id=v_row.id),v_row.status) else v_row.status end;
 v_change:=p_status is not null and p_status<>v_key;
 if not v_change and v_text is null and v_next is null then raise exception 'erp_document_occurrence_empty' using errcode='22023'; end if;
 perform set_config('erp_documents.occurrence_on',v_on::text,true),set_config('erp_documents.occurrence_time',v_time,true),
  set_config('erp_documents.occurrence_text',coalesce(v_text,''),true),set_config('erp_documents.occurrence_next_contact',coalesce(v_next::text,''),true);
 if v_change then
  perform public.erp_document_transition(p_user_id,p_kind,p_document_id,v_row.version,md5('occurrence-transition:'||p_command_id::text)::uuid,p_status,
   nullif(btrim(regexp_replace(coalesce(v_text,''),'[[:cntrl:]]+',' ','g')),''));
 elsif v_adopted then
  perform erp_documents.record_situation_occurrence(p_document_id,p_user_id,p_command_id,v_row.version,v_row.status,null,v_text,erp_documents.document_situation_json(p_document_id),null);
 else
  perform erp_documents.record_occurrence(p_document_id,p_user_id,p_command_id,v_row.version,v_row.status,null,v_text);
 end if;
 perform set_config('erp_documents.occurrence_on','',true),set_config('erp_documents.occurrence_time','',true),
  set_config('erp_documents.occurrence_text','',true),set_config('erp_documents.occurrence_next_contact','',true);
 if v_next is not null then
  v_before:=erp_documents.dto(p_document_id);
  update erp_documents.document set body=jsonb_set(body,'{next_contact}',to_jsonb(v_next::text),true),version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_document_id;
  insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
   values(p_user_id,p_command_id,p_document_id,'next_contact',v_before,erp_documents.dto(p_document_id));
 elsif not v_change then
  insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
   values(p_user_id,p_command_id,p_document_id,'occurrence',v_text,null,null);
 end if;
 select * into v_last from erp_documents.occurrence where document_id=p_document_id order by sequence desc limit 1;
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.document_view(p_document_id),'occurrence',erp_documents.occurrence_json(v_last),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- 129 plus the current situação of the document and whether date and time may be typed.
create or replace function public.erp_document_occurrence_list(p_user_id uuid,p_kind text,p_document_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_row erp_documents.document%rowtype; v_role text; v_items jsonb; v_count bigint;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 select * into v_row from erp_documents.document where id=p_document_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 select coalesce(jsonb_agg(erp_documents.occurrence_list_json(o) order by o.sequence desc),'[]'::jsonb) into v_items
  from (select * from erp_documents.occurrence x where x.document_id=p_document_id
   and not exists(select 1 from erp_documents.occurrence_removal r where r.occurrence_id=x.id) order by x.sequence desc limit 500) o;
 select count(*) into v_count from erp_documents.occurrence x where x.document_id=p_document_id
  and not exists(select 1 from erp_documents.occurrence_removal r where r.occurrence_id=x.id);
 return jsonb_build_object('kind',p_kind,'document',jsonb_build_object('id',v_row.id,'kind',v_row.kind,'number',v_row.number::text,'status',v_row.status,'version',v_row.version,
   'situation',erp_documents.document_situation_json(v_row.id)),
  'items',v_items,'has_more',v_count>500,'can_write',erp_documents.allowed(v_role,p_kind,true),
  'date_editable',erp_documents.preference('empresa.editar_data_ocorrencia')='true'::jsonb,'data_mode','erp_native','operational_effects',false);
end $$;

-- Single document read (008) with the situação.
create or replace function public.erp_document_get(p_user_id uuid,p_kind text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if not exists(select 1 from erp_documents.document where id=p_id and kind=p_kind) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('kind',p_kind,'document',erp_documents.document_view(p_id),'data_mode','erp_native','operational_effects',false);
end $$;

-- Situações and transitions of one kind for the document screens (every profile that reads the kind): the selector,
-- filters and badges, and the targets from each situação. Propostas are not managed (adopted false, empty lists).
create function public.erp_document_situations(p_user_id uuid,p_kind text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_adopted boolean;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 v_adopted:=erp_documents.situation_adopted(p_kind);
 return jsonb_build_object('kind',p_kind,'adopted',v_adopted,
  'situations',case when v_adopted then (select coalesce(jsonb_agg(jsonb_build_object('key',s.key,'base_status',s.base_status,'name',s.name,'color',s.color,'default',s.is_default,'active',s.active)
    order by s.ordinal,s.is_default desc,s.created_at,s.key),'[]'::jsonb) from erp_preferences.situation_list(p_kind) s) else '[]'::jsonb end,
  'transitions',case when v_adopted then (select coalesce(jsonb_agg(jsonb_build_object('from',t.from_key,'to',t.to_key,'active',t.active,'actions',to_jsonb(t.actions))
    order by t.from_ord,t.to_ord),'[]'::jsonb) from erp_preferences.transition_list(p_kind) t) else '[]'::jsonb end,
  'occurrence_date_editable',erp_documents.preference('empresa.editar_data_ocorrencia')='true'::jsonb,
  'data_mode','erp_native','operational_effects',false);
end $$;

-- 131 plus the situação and the "nota vinculada" flag (every profile; the nota itself stays admin and fiscal).
create or replace function erp_documents.list_row(p_id uuid,p_fiscal boolean,p_stock boolean)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'date',d.body->>'date','expected_date',d.body->>'expected_date','next_contact',d.body->>'next_contact',
  'template',coalesce(d.body->'template'='true'::jsonb,false),
  'total',d.total::text,'contact_id',d.contact_id,'contact_name',d.contact_snapshot->>'name',
  'warehouse_id',d.warehouse_id,'warehouse_name',case when p_stock then w.name end,
  'source_proposal_id',d.source_proposal_id,'source_proposal_number',p.number::text,
  'finance_active',exists(select 1 from erp_finance.document_posting f where f.document_id=d.id and f.state='active'),
  'stock_active',exists(select 1 from erp_stock.document_posting s where s.document_id=d.id and s.state='active'),
  'receipt_active',d.kind='purchase_orders' and erp_purchase_receipts.active(d.id),
  'reservation_active',case when p_stock then d.kind='sales_orders' and exists(select 1 from erp_stock.reservation r where r.document_id=d.id and r.state='active') end,
  'fiscal_draft',case when p_fiscal and d.kind='sales_orders' then exists(select 1 from erp_fiscal_drafts.draft x where x.source_document_id=d.id and x.status='draft') end,
  'internal_notes',left(d.body->>'internal_notes',280),
  'created_at',d.created_at,'updated_at',d.updated_at,
  'customer_po_number',d.body->>'customer_po_number','ship_date',d.body->>'ship_date',
  'contact_email',nullif(d.contact_snapshot->>'email',''),'contact_phone',coalesce(nullif(d.contact_snapshot->>'phone',''),nullif(d.contact_snapshot->>'mobile','')),
  'contact_document',nullif(d.contact_snapshot->>'document',''),
  'address',left(coalesce(erp_documents.address_text(nullif(d.body->'delivery_address','null'::jsonb)),erp_documents.address_text(d.contact_snapshot)),500),
  'carrier_name',left(nullif(d.body#>>'{commercial,transport,carrier_reference,label}',''),200),
  'first_sale',d.kind='sales_orders' and d.status<>'cancelled' and not exists(select 1 from erp_documents.document o
    where o.kind='sales_orders' and o.contact_id=d.contact_id and o.status<>'cancelled' and o.id<>d.id
     and (o.body->>'date',o.number)<(d.body->>'date',d.number)),
  'invoice',case when p_fiscal and d.kind='sales_orders' then erp_documents.order_invoice(d.id) end,
  'pendencies',d.kind='sales_orders' and d.status<>'cancelled' and jsonb_array_length(erp_documents.pendencies(d.id))>0,
  'service_order_number',(select s.number::text from erp_documents.sales_service_link l join erp_documents.document s on s.id=l.service_order_id where l.sales_order_id=d.id),
  'template_name',case when d.kind='sales_proposals' then d.body->>'template_name' end,
  -- 163: situação of the Gerenciador de transições and whether a nota is linked (the menu rules of every profile).
  'situation',erp_documents.situation_json(d.kind,d.status,ds.situation_id),
  'invoice_linked',d.kind='sales_orders' and erp_documents.order_invoice(d.id) is not null,
  -- 164: native vendedor (Cadastros › Vendedores) of the document.
  'seller_id',case when d.body->>'seller_id'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then d.body->>'seller_id' end,
  'seller_name',(select left(r.name,200) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id::text=d.body->>'seller_id'))
 from erp_documents.document d
 left join erp_catalog.record w on w.id=d.warehouse_id
 left join erp_documents.document p on p.id=d.source_proposal_id
 left join erp_documents.document_situation ds on ds.document_id=d.id
 where d.id=p_id;
$$;

-- 129 plus p_situations (exact situações: status-base for the situação padrão, or the id of a custom one) and p_seller_id
-- (native vendedor of the document, 164).
drop function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean);
create function public.erp_document_list(
 p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null,p_status text default null,
 p_query text default null,p_date_from text default null,p_date_to text default null,
 p_page integer default null,p_order text default 'id',p_statuses text[] default null,p_date_type text default 'date',
 p_warehouse_id uuid default null,p_product_id uuid default null,p_city text default null,p_state text default null,
 p_technician text default null,p_equipment text default null,p_serial_number text default null,p_internal_note text default null,
 p_postal_code text default null,p_district text default null,p_tracking_code text default null,p_customer_po_number text default null,
 p_carrier text default null,p_contact_email text default null,p_template boolean default null,p_situations text[] default null,p_seller_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_fiscal boolean; v_stock boolean; v_statuses text[]; v_query text; v_digits text; v_from date; v_to date; v_offset bigint;
 v_cursor erp_documents.document%rowtype; v_cursor_day text; v_items jsonb; v_more boolean; v_last uuid; v_count bigint; v_amount numeric;
 v_city text; v_technician text; v_equipment text; v_serial text; v_note text;
 v_postal text; v_district text; v_tracking text; v_po text; v_carrier text; v_email text;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 v_fiscal:=v_role in ('admin','fiscal');
 v_stock:=v_role in ('admin','consulta','estoque','vendas','fiscal');
 v_statuses:=case when p_statuses is not null then p_statuses when p_status is not null then array[p_status] end;
 if p_limit is null or p_limit not between 1 and 100
  or (p_status is not null and p_statuses is not null)
  or (v_statuses is not null and (coalesce(cardinality(v_statuses),0) not between 1 and 20 or array_position(v_statuses,null) is not null
   or exists(select 1 from unnest(v_statuses) s where not (erp_documents.transitions()->p_kind)?s)
   or (select count(distinct s) from unnest(v_statuses) s)<>cardinality(v_statuses)))
  or (p_situations is not null and (v_statuses is not null or not erp_documents.situation_adopted(p_kind) or coalesce(cardinality(p_situations),0) not between 1 and 50
   or array_position(p_situations,null) is not null or exists(select 1 from unnest(p_situations) s where not erp_documents.situation_key_valid(p_kind,s))
   or (select count(distinct s) from unnest(p_situations) s)<>cardinality(p_situations)))
  or length(p_query)>120 or p_query ~ '[[:cntrl:]]'
  or (p_date_from is not null and p_date_from !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_date_to is not null and p_date_to !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_page is not null and (p_page not between 1 and 100000 or p_after is not null))
  or p_order is null or p_order not in ('date_desc','date_asc','number_desc','number_asc','id')
  or p_date_type is null or p_date_type not in ('date','expected_date','next_contact','ship_date','finish_date','warranty_until')
  or (p_date_type='next_contact' and p_kind<>'sales_proposals')
  or (p_date_type='ship_date' and p_kind not in ('sales_orders','service_orders'))
  or (p_date_type in ('finish_date','warranty_until') and p_kind<>'service_orders')
  or ((p_city is not null or p_state is not null) and p_kind not in ('sales_orders','sales_proposals'))
  or ((p_technician is not null or p_equipment is not null or p_serial_number is not null) and p_kind<>'service_orders')
  or (p_internal_note is not null and p_kind<>'purchase_orders')
  or ((p_postal_code is not null or p_district is not null or p_tracking_code is not null or p_customer_po_number is not null or p_carrier is not null) and p_kind<>'sales_orders')
  or ((p_contact_email is not null or p_template is not null) and p_kind<>'sales_proposals')
  or (p_seller_id is not null and p_kind not in ('sales_orders','sales_proposals','service_orders'))
  or length(p_city)>100 or length(p_technician)>200 or length(p_equipment)>200 or length(p_serial_number)>100 or length(p_internal_note)>200
  or length(p_district)>100 or length(p_tracking_code)>200 or length(p_customer_po_number)>60 or length(p_carrier)>200 or length(p_contact_email)>254
  or (p_postal_code is not null and p_postal_code!~'^[0-9]{1,8}$')
  or concat(p_city,p_technician,p_equipment,p_serial_number,p_internal_note,p_district,p_tracking_code,p_customer_po_number,p_carrier,p_contact_email) ~ '[[:cntrl:]]'
  or (p_state is not null and p_state !~ '^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$') then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_city:=lower(nullif(btrim(p_city),''));v_technician:=lower(nullif(btrim(p_technician),''));v_equipment:=lower(nullif(btrim(p_equipment),''));
 v_serial:=lower(nullif(btrim(p_serial_number),''));v_note:=lower(nullif(btrim(p_internal_note),''));
 v_postal:=p_postal_code;v_district:=lower(nullif(btrim(p_district),''));v_tracking:=lower(nullif(btrim(p_tracking_code),''));
 v_po:=lower(nullif(btrim(p_customer_po_number),''));v_carrier:=lower(nullif(btrim(p_carrier),''));v_email:=lower(nullif(btrim(p_contact_email),''));
 if (p_city is not null and v_city is null) or (p_technician is not null and v_technician is null) or (p_equipment is not null and v_equipment is null)
  or (p_serial_number is not null and v_serial is null) or (p_internal_note is not null and v_note is null)
  or (p_district is not null and v_district is null) or (p_tracking_code is not null and v_tracking is null) or (p_customer_po_number is not null and v_po is null)
  or (p_carrier is not null and v_carrier is null) or (p_contact_email is not null and v_email is null) then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_from:=erp_documents.date_value(to_jsonb(p_date_from));
 v_to:=erp_documents.date_value(to_jsonb(p_date_to));
 if v_from>v_to then raise exception 'erp_document_period_invalid' using errcode='22023'; end if;
 v_query:=lower(nullif(btrim(p_query),''));
 v_digits:=case when v_query ~ '^[0-9./ -]+$' then regexp_replace(v_query,'[^0-9]','','g') end;
 if length(v_digits)<5 then v_digits:=null; end if;
 if p_after is not null and p_order<>'id' then
  select * into v_cursor from erp_documents.document where id=p_after and kind=p_kind;
  if not found then raise exception 'erp_document_cursor_invalid' using errcode='22023'; end if;
  v_cursor_day:=v_cursor.body->>'date';
 end if;
 v_offset:=case when p_page is null then 0 else (p_page-1)::bigint*p_limit end;
 with filtered as materialized(
  select d.id,d.number,d.body->>'date' as day,d.total from erp_documents.document d
  left join erp_documents.document_situation ds on ds.document_id=d.id
  where d.kind=p_kind
   and (v_statuses is null or d.status=any(v_statuses))
   and (p_situations is null or coalesce(ds.situation_id::text,d.status)=any(p_situations))
   and (p_seller_id is null or d.body->>'seller_id'=p_seller_id::text)
   and (v_from is null and v_to is null
    or p_date_type='date' and (v_from is null or d.body->>'date'>=p_date_from) and (v_to is null or d.body->>'date'<=p_date_to)
    or p_date_type='expected_date' and (v_from is null or d.body->>'expected_date'>=p_date_from) and (v_to is null or d.body->>'expected_date'<=p_date_to)
    or p_date_type='next_contact' and (v_from is null or d.body->>'next_contact'>=p_date_from) and (v_to is null or d.body->>'next_contact'<=p_date_to)
    or p_date_type='ship_date' and (v_from is null or d.body->>'ship_date'>=p_date_from) and (v_to is null or d.body->>'ship_date'<=p_date_to)
    or p_date_type='finish_date' and (v_from is null or d.body->>'finish_date'>=p_date_from) and (v_to is null or d.body->>'finish_date'<=p_date_to)
    or p_date_type='warranty_until' and d.body->>'warranty_days' is not null
     and (v_from is null or (coalesce(d.body->>'ship_date',d.body->>'date')::date+(d.body->>'warranty_days')::integer)>=v_from)
     and (v_to is null or (coalesce(d.body->>'ship_date',d.body->>'date')::date+(d.body->>'warranty_days')::integer)<=v_to))
   and (p_warehouse_id is null or d.warehouse_id=p_warehouse_id)
   and (p_product_id is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=p_product_id))
   and (v_city is null or strpos(lower(coalesce(d.contact_snapshot->>'city','')),v_city)>0)
   and (p_state is null or upper(coalesce(d.contact_snapshot->>'state',''))=p_state)
   and (v_technician is null or strpos(lower(coalesce(d.body->>'technician','')),v_technician)>0)
   and (v_equipment is null or strpos(lower(coalesce(d.body->>'equipment','')),v_equipment)>0)
   and (v_serial is null or strpos(lower(coalesce(d.body->>'serial_number','')),v_serial)>0)
   and (v_note is null or strpos(lower(coalesce(d.body->>'internal_notes','')),v_note)>0)
   and (v_postal is null or strpos(regexp_replace(coalesce(d.contact_snapshot->>'postal_code',''),'[^0-9]','','g'),v_postal)=1
    or strpos(coalesce(d.body#>>'{delivery_address,postal_code}',''),v_postal)=1)
   and (v_district is null or strpos(lower(coalesce(d.contact_snapshot->>'district','')),v_district)>0
    or strpos(lower(coalesce(d.body#>>'{delivery_address,district}','')),v_district)>0)
   and (v_tracking is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,tracking_code}','')),v_tracking)>0)
   and (v_po is null or strpos(lower(coalesce(d.body->>'customer_po_number','')),v_po)>0)
   and (v_carrier is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,carrier_reference,label}','')),v_carrier)>0)
   and (v_email is null or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_email)>0)
   and (p_template is null or coalesce(d.body->'template'='true'::jsonb,false)=p_template)
   and (v_query is null or strpos(d.number::text,v_query)>0 or d.id::text=v_query
    or strpos(lower(coalesce(d.contact_snapshot->>'name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'trade_name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'code','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_query)>0
    or (p_kind='purchase_orders' and strpos(lower(coalesce(d.body->>'order_reference','')),v_query)>0)
    or (v_digits is not null and strpos(regexp_replace(coalesce(d.contact_snapshot->>'document',''),'[^0-9]','','g'),v_digits)>0)
    or (v_digits is not null and p_kind='service_orders' and strpos(regexp_replace(coalesce(d.contact_snapshot->>'postal_code',''),'[^0-9]','','g'),v_digits)>0))
 ), ordered as materialized(
  select f.id,row_number() over(order by
    case when p_order='id' then f.id end,
    case when p_order='date_desc' then f.day end desc,
    case when p_order='date_asc' then f.day end,
    case when p_order in ('date_desc','number_desc') then f.number end desc,
    case when p_order in ('date_asc','number_asc') then f.number end) as position
  from filtered f
  where p_after is null
   or (p_order='id' and f.id>p_after)
   or (p_order='date_desc' and (f.day,f.number)<(v_cursor_day,v_cursor.number))
   or (p_order='date_asc' and (f.day,f.number)>(v_cursor_day,v_cursor.number))
   or (p_order='number_desc' and f.number<v_cursor.number)
   or (p_order='number_asc' and f.number>v_cursor.number)
 ), page as materialized(
  select id,position from ordered where position>v_offset and position<=v_offset+p_limit+1
 )
 select coalesce((select jsonb_agg(erp_documents.list_row(id,v_fiscal,v_stock) order by position) from page where position<=v_offset+p_limit),'[]'::jsonb),
  (select count(*) from page)>p_limit,
  (select id from page where position<=v_offset+p_limit order by position desc limit 1),
  (select count(*) from filtered),(select coalesce(sum(total),0) from filtered)
 into v_items,v_more,v_last,v_count,v_amount;
 return jsonb_build_object('kind',p_kind,'items',v_items,'limit',p_limit,'page',p_page,
  'order',p_order,'has_more',v_more,'next_cursor',case when v_more then v_last end,
  'total_count',v_count,'total_amount',case when erp_documents.list_totals_visible(p_user_id,p_kind) then v_amount::numeric(20,2)::text end,
  'data_mode','erp_native','operational_effects',false);
end $$;

-- 104 with the custom situações of the adopted kinds in "Tornar padrão".
create or replace function public.erp_document_list_view_save(p_user_id uuid,p_kind text,p_expected_version integer,p_command_id uuid,
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
  or cardinality(p_default_statuses)>20 or exists(select 1 from unnest(p_default_statuses) s where not (case when erp_documents.situation_adopted(p_kind)
   then erp_documents.situation_key_valid(p_kind,s) else (erp_documents.transitions()->p_kind)?s end))
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

revoke all on function erp_documents.situation_follow_status(),erp_documents.situation_adopted(text),erp_documents.situation_json(text,text,uuid),
 erp_documents.document_situation_json(uuid),erp_documents.document_view(uuid),erp_documents.situation_snapshot(jsonb),erp_documents.situation_key_valid(text,text),
 erp_documents.record_situation_occurrence(uuid,uuid,uuid,integer,text,text,text,jsonb,jsonb),erp_documents.occurrence_json(erp_documents.occurrence),
 erp_documents.transition_command(uuid,text),erp_documents.current_version(uuid),erp_documents.stock_launch_date(uuid),
 erp_documents.transition_action(uuid,text,uuid,uuid,text,text),erp_documents.list_row(uuid,boolean,boolean) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text),
 public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text),public.erp_document_occurrence_list(uuid,text,uuid),
 public.erp_document_get(uuid,text,uuid),public.erp_document_situations(uuid,text),
 public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid),
 public.erp_document_list_view_save(uuid,text,integer,uuid,boolean,text[],text[]) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text),
 public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text),public.erp_document_occurrence_list(uuid,text,uuid),
 public.erp_document_get(uuid,text,uuid),public.erp_document_situations(uuid,text),
 public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid),
 public.erp_document_list_view_save(uuid,text,integer,uuid,boolean,text[],text[]) to service_role;
commit;
