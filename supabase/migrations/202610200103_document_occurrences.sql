-- Ocorrências do Origin (pedidos, propostas e OS) e situações "todas para todas".
-- * erp_documents.occurrence guarda cada ocorrência (data, hora, texto, usuário, situação antes/depois e, na proposta,
--   o próximo contato). É imutável. Toda mudança de situação feita por erp_document_transition grava uma ocorrência.
-- * Transições: propostas, pedidos e OS passam a ir de qualquer situação para qualquer outra, como no Gerenciador de
--   transições do Origin (exceções: Concluído da proposta só pela conversão; Atendido parcialmente mantém 008).
--   As travas de estoque, contas, reservas e recebimentos (effects_transition_allowed) não mudam. O motivo continua
--   obrigatório para cancelar, para as reaberturas de 008 e para qualquer saída nova de uma situação fechada.
-- Nenhum efeito de estoque, financeiro ou fiscal é criado. Requer 008, 017, 018, 019, 070 e 090.
begin;

create function erp_documents.legacy_transitions()
returns jsonb language sql immutable set search_path=pg_catalog as $$ select '{"sales_proposals":{"draft":["open","cancelled"],"open":["pending","waiting","approved","rejected","cancelled"],"pending":["open","waiting","approved","rejected","cancelled"],"waiting":["open","pending","approved","rejected","cancelled"],"approved":["open","cancelled"],"rejected":["open"],"cancelled":["open"],"completed":[]},"sales_orders":{"draft":["open","cancelled"],"open":["verified","in_progress","cancelled"],"verified":["open","in_progress","cancelled"],"in_progress":["partially_fulfilled","fulfilled","cancelled"],"partially_fulfilled":["in_progress","fulfilled","cancelled"],"fulfilled":["open"],"cancelled":["open"]},"purchase_orders":{"open":["in_progress","cancelled"],"in_progress":["partially_fulfilled","fulfilled","cancelled"],"partially_fulfilled":["in_progress","fulfilled","cancelled"],"fulfilled":["open"],"cancelled":["open"]},"service_orders":{"open":["quoted","no_repair","cancelled"],"quoted":["approved","rejected","cancelled"],"approved":["in_progress","cancelled"],"rejected":["quoted","no_repair"],"in_progress":["waiting_parts","service_done","no_repair","cancelled"],"waiting_parts":["in_progress","no_repair","cancelled"],"service_done":["in_progress","finalized"],"finalized":["open"],"no_repair":["open"],"cancelled":["open"]}}'::jsonb $$;

create or replace function erp_documents.transitions()
returns jsonb language sql immutable set search_path=pg_catalog as $$ select '{"sales_proposals":{"draft":["open","pending","waiting","approved","rejected","cancelled"],"open":["draft","pending","waiting","approved","rejected","cancelled"],"pending":["draft","open","waiting","approved","rejected","cancelled"],"waiting":["draft","open","pending","approved","rejected","cancelled"],"approved":["draft","open","pending","waiting","rejected","cancelled"],"rejected":["draft","open","pending","waiting","approved","cancelled"],"cancelled":["draft","open","pending","waiting","approved","rejected"],"completed":[]},"sales_orders":{"draft":["open","verified","in_progress","fulfilled","cancelled"],"open":["draft","verified","in_progress","fulfilled","cancelled"],"verified":["draft","open","in_progress","fulfilled","cancelled"],"in_progress":["draft","open","verified","partially_fulfilled","fulfilled","cancelled"],"partially_fulfilled":["in_progress","fulfilled","cancelled"],"fulfilled":["draft","open","verified","in_progress","cancelled"],"cancelled":["draft","open","verified","in_progress","fulfilled"]},"purchase_orders":{"open":["in_progress","cancelled"],"in_progress":["partially_fulfilled","fulfilled","cancelled"],"partially_fulfilled":["in_progress","fulfilled","cancelled"],"fulfilled":["open"],"cancelled":["open"]},"service_orders":{"open":["quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"quoted":["open","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"approved":["open","quoted","rejected","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"rejected":["open","quoted","approved","in_progress","waiting_parts","service_done","finalized","no_repair","cancelled"],"in_progress":["open","quoted","approved","rejected","waiting_parts","service_done","finalized","no_repair","cancelled"],"waiting_parts":["open","quoted","approved","rejected","in_progress","service_done","finalized","no_repair","cancelled"],"service_done":["open","quoted","approved","rejected","in_progress","waiting_parts","finalized","no_repair","cancelled"],"finalized":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","no_repair","cancelled"],"no_repair":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","cancelled"],"cancelled":["open","quoted","approved","rejected","in_progress","waiting_parts","service_done","finalized","no_repair"]}}'::jsonb $$;

create function erp_documents.transition_reason_required(p_kind text,p_from text,p_to text)
returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_to='cancelled'
  or (p_to='open' and p_from in('approved','rejected','fulfilled','finalized','no_repair','cancelled'))
  or (p_from='rejected' and p_to='quoted') or (p_from='service_done' and p_to='in_progress')
  or (not coalesce((erp_documents.legacy_transitions()#>array[p_kind,p_from])?p_to,false) and not erp_documents.editable(p_from)),true)
$$;

create table erp_documents.occurrence (
 id uuid primary key default gen_random_uuid(),
 document_id uuid not null references erp_documents.document(id),
 sequence integer not null check(sequence between 1 and 1000000),
 occurred_on date not null,
 occurred_time text not null check(occurred_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 text text check(text is null or length(text) between 1 and 1000),
 status_before text not null,
 status_after text,
 next_contact date,
 actor_id uuid not null references auth.users(id),
 actor_role text not null,
 command_id uuid not null unique,
 document_version integer not null check(document_version>0),
 recorded_at timestamptz not null default clock_timestamp(),
 unique(document_id,sequence),
 check(status_after is null or status_after<>status_before)
);
create index erp_documents_occurrence_document on erp_documents.occurrence(document_id,sequence desc);
create function erp_documents.occurrence_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_document_occurrence_immutable' using errcode='55000'; end $$;
create trigger occurrence_immutable before update or delete on erp_documents.occurrence for each row execute function erp_documents.occurrence_immutable();
alter table erp_documents.occurrence enable row level security;
revoke all on erp_documents.occurrence from public,anon,authenticated,service_role;

create function erp_documents.occurrence_json(o erp_documents.occurrence) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('id',o.id,'sequence',o.sequence,'occurred_on',o.occurred_on::text,'occurred_time',o.occurred_time,'text',o.text,
  'status_before',o.status_before,'status_after',o.status_after,'next_contact',o.next_contact::text,'actor_id',o.actor_id,'actor_role',o.actor_role,
  'document_version',o.document_version,'recorded_at',o.recorded_at)
$$;

-- Registers one occurrence; date, time, text and next contact may come from erp_document_occurrence_add (same transaction).
create function erp_documents.record_occurrence(p_document uuid,p_actor uuid,p_command uuid,p_version integer,p_before text,p_after text,p_text text)
returns erp_documents.occurrence language plpgsql set search_path=pg_catalog as $$
declare v erp_documents.occurrence; v_role text;
begin
 select role into v_role from erp_access.membership where user_id=p_actor and active;
 insert into erp_documents.occurrence(document_id,sequence,occurred_on,occurred_time,text,status_before,status_after,next_contact,actor_id,actor_role,command_id,document_version)
 values(p_document,(select coalesce(max(sequence),0)+1 from erp_documents.occurrence where document_id=p_document),
  coalesce(nullif(current_setting('erp_documents.occurrence_on',true),'')::date,(clock_timestamp() at time zone 'America/Sao_Paulo')::date),
  coalesce(nullif(current_setting('erp_documents.occurrence_time',true),''),to_char(clock_timestamp() at time zone 'America/Sao_Paulo','HH24:MI')),
  coalesce(nullif(current_setting('erp_documents.occurrence_text',true),''),p_text),
  p_before,p_after,nullif(current_setting('erp_documents.occurrence_next_contact',true),'')::date,p_actor,coalesce(v_role,'desconhecido'),p_command,p_version)
 returning * into v;
 return v;
end $$;

-- 008 com as transições novas, a regra de motivo e a ocorrência de cada mudança de situação.
create or replace function public.erp_document_transition(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,
 p_command_id uuid,p_status text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_before jsonb; v_result jsonb; v_reason text;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','transition','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,'status',p_status,'reason',p_reason)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if p_status is null or not coalesce((erp_documents.transitions()#>array[p_kind,v_row.status])?p_status,false) then
  raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
 v_reason:=erp_documents.text_value(to_jsonb(p_reason),1000);
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
end $$;

-- Origin "Ocorrências": linha nova com data, hora, texto e situação. Outra situação muda o documento pela transição
-- (mesmas regras e travas); na proposta, o próximo contato também é atualizado. O texto serve de motivo.
create function public.erp_document_occurrence_add(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,
 p_occurred_on text,p_occurred_time text,p_text text default null,p_status text default null,p_next_contact text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_on date; v_text text; v_next date; v_change boolean; v_before jsonb; v_result jsonb; v_last erp_documents.occurrence;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_document_id is null or p_expected_version is null or p_expected_version<1 or p_occurred_time is null or p_occurred_time!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or (p_status is not null and not (erp_documents.transitions()->p_kind)?p_status) or (p_next_contact is not null and p_kind<>'sales_proposals') then
  raise exception 'erp_document_occurrence_invalid' using errcode='22023'; end if;
 v_on:=erp_documents.date_value(to_jsonb(p_occurred_on),true);
 v_text:=erp_documents.text_value(to_jsonb(p_text),1000,false,true);
 v_next:=erp_documents.date_value(to_jsonb(p_next_contact));
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','occurrence','actor',p_user_id,'kind',p_kind,'id',p_document_id,'version',p_expected_version,
  'occurred_on',p_occurred_on,'occurred_time',p_occurred_time,'text',p_text,'status',p_status,'next_contact',p_next_contact)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_documents.document where id=p_document_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_change:=p_status is not null and p_status<>v_row.status;
 if not v_change and v_text is null and v_next is null then raise exception 'erp_document_occurrence_empty' using errcode='22023'; end if;
 perform set_config('erp_documents.occurrence_on',v_on::text,true),set_config('erp_documents.occurrence_time',p_occurred_time,true),
  set_config('erp_documents.occurrence_text',coalesce(v_text,''),true),set_config('erp_documents.occurrence_next_contact',coalesce(v_next::text,''),true);
 if v_change then
  -- Derived command: the transition keeps its own idempotent record; this command stores the whole result.
  -- The reason is single-line (008); line breaks of the occurrence text become spaces only in the reason.
  perform public.erp_document_transition(p_user_id,p_kind,p_document_id,v_row.version,md5('occurrence-transition:'||p_command_id::text)::uuid,p_status,
   nullif(btrim(regexp_replace(coalesce(v_text,''),'[[:cntrl:]]+',' ','g')),''));
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
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(p_document_id),'occurrence',erp_documents.occurrence_json(v_last),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

create function public.erp_document_occurrence_list(p_user_id uuid,p_kind text,p_document_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_row erp_documents.document%rowtype; v_role text; v_items jsonb; v_count bigint;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 select * into v_row from erp_documents.document where id=p_document_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 select coalesce(jsonb_agg(erp_documents.occurrence_json(o) order by o.sequence desc),'[]'::jsonb) into v_items
  from (select * from erp_documents.occurrence where document_id=p_document_id order by sequence desc limit 500) o;
 select count(*) into v_count from erp_documents.occurrence where document_id=p_document_id;
 return jsonb_build_object('kind',p_kind,'document',jsonb_build_object('id',v_row.id,'kind',v_row.kind,'number',v_row.number::text,'status',v_row.status,'version',v_row.version),
  'items',v_items,'has_more',v_count>500,'can_write',erp_documents.allowed(v_role,p_kind,true),'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function erp_documents.legacy_transitions(),erp_documents.transitions(),erp_documents.transition_reason_required(text,text,text),
 erp_documents.occurrence_immutable(),erp_documents.occurrence_json(erp_documents.occurrence),
 erp_documents.record_occurrence(uuid,uuid,uuid,integer,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text),
 public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text),
 public.erp_document_occurrence_list(uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text),
 public.erp_document_occurrence_add(uuid,text,uuid,integer,uuid,text,text,text,text,text),
 public.erp_document_occurrence_list(uuid,text,uuid) to service_role;
commit;
