-- Leva H, lane plataforma (PRF-280, PRF-283): executor de tarefas do servidor e gerador agendado das notificações internas.
-- * Cada tarefa tem empresa (a instalação tem uma empresa só: company_key 'empresa'), finalidade, identificador de operação,
--   tentativas, resultado e histórico. (company_key, purpose, operation_id) é único: pedir de novo a mesma operação devolve a
--   tarefa existente, e uma entrega repetida (cron que dispara duas vezes, Cloudflare Queues que reentrega) não repete o efeito.
-- * O Worker reserva uma tarefa por vez com um lease de 5 minutos (FOR UPDATE SKIP LOCKED); só quem tem o lease conclui ou
--   registra o andamento. Um lease vencido volta a fila e conta uma tentativa nova; esgotadas as tentativas, a tarefa falha.
-- * Cada finalidade tem a própria regra de ativação: notifications_generate (uma por hora, pelo agendamento), company_export (pedida
--   pelo administrador, 331) e export_cleanup (uma por dia, pelo agendamento, 331).
-- * notifications_generate cria as notificações do dia de cada membro ativo com as mesmas regras da leitura (151, 187, 283):
--   destinatários da Central de Notificações e um aviso por (usuário, tipo, dia). A unicidade da tabela impede a duplicata.
-- * Consultar gestão de ações lista as tarefas: o administrador vê todas; os demais, as que pediram.
-- Tabelas e funções novas; nenhuma função de outra frente é redefinida. Requer 151 (notificações) e 117 (administrador).
begin;

do $$begin
 if to_regclass('erp_home.notification') is null or to_regprocedure('erp_home.notification_digest(text,date)') is null
  or to_regprocedure('erp_home.notification_recipient(uuid,text,text)') is null or to_regprocedure('erp_access.read_admin(uuid)') is null then
  raise exception 'platform_330_requires_117_151' using errcode='55000'; end if;
 if to_regnamespace('erp_platform') is not null then raise exception 'platform_330_already_applied' using errcode='55000'; end if;
end$$;

create schema erp_platform;
revoke all on schema erp_platform from public,anon,authenticated,service_role;

create table erp_platform.task(
 id uuid primary key default gen_random_uuid(),
 company_key text not null default 'empresa' check(company_key='empresa'),
 purpose text not null check(purpose in('notifications_generate','company_export','export_cleanup')),
 operation_id text not null check(operation_id~'^[a-z0-9][A-Za-z0-9:._-]{0,95}$'),
 requested_by uuid references auth.users(id),
 payload jsonb not null default '{}'::jsonb check(jsonb_typeof(payload)='object' and length(payload::text)<=4096),
 status text not null default 'queued' check(status in('queued','running','done','failed')),
 attempts integer not null default 0 check(attempts>=0),
 max_attempts integer not null default 5 check(max_attempts between 1 and 10),
 lease_token uuid,lease_until timestamptz,
 next_attempt_at timestamptz not null default clock_timestamp(),
 progress jsonb not null default '{}'::jsonb check(jsonb_typeof(progress)='object' and length(progress::text)<=65536),
 result jsonb check(result is null or jsonb_typeof(result)='object' and length(result::text)<=16384),
 error_code text check(error_code is null or error_code~'^[A-Za-z0-9_]{1,80}$'),
 created_at timestamptz not null default clock_timestamp(),started_at timestamptz,finished_at timestamptz,
 unique(company_key,purpose,operation_id),
 check((lease_token is null)=(lease_until is null)),
 check(status='running' or lease_token is null),
 check(status not in('done','failed') or finished_at is not null),
 check(attempts<=max_attempts)
);
create index erp_platform_task_due on erp_platform.task(next_attempt_at,created_at) where status in('queued','running');
create index erp_platform_task_recent on erp_platform.task(created_at desc,id);
create table erp_platform.task_attempt(
 id bigint generated always as identity primary key,
 task_id uuid not null references erp_platform.task(id),attempt integer not null check(attempt>=1),lease_token uuid not null,
 started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 outcome text check(outcome is null or outcome in('done','retry','failed','expired')),
 error_code text check(error_code is null or error_code~'^[A-Za-z0-9_]{1,80}$'),
 unique(task_id,attempt)
);
alter table erp_platform.task enable row level security;
alter table erp_platform.task_attempt enable row level security;
revoke all on table erp_platform.task,erp_platform.task_attempt from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_platform from public,anon,authenticated,service_role;

-- The identity of a task never changes and the rows are never deleted; a finished task stays as it ended.
create function erp_platform.task_guard() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'erp_platform_task_immutable' using errcode='40001'; end if;
 if(new.id,new.company_key,new.purpose,new.operation_id,new.requested_by,new.payload,new.max_attempts,new.created_at)
   is distinct from(old.id,old.company_key,old.purpose,old.operation_id,old.requested_by,old.payload,old.max_attempts,old.created_at)
  or old.status in('done','failed') or new.attempts<old.attempts then
  raise exception 'erp_platform_task_immutable' using errcode='40001'; end if;
 return new;
end $$;
create trigger task_guard before update or delete on erp_platform.task for each row execute function erp_platform.task_guard();
create function erp_platform.attempt_guard() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' or old.finished_at is not null or(new.id,new.task_id,new.attempt,new.lease_token,new.started_at)
   is distinct from(old.id,old.task_id,old.attempt,old.lease_token,old.started_at) then
  raise exception 'erp_platform_task_immutable' using errcode='40001'; end if;
 return new;
end $$;
create trigger attempt_guard before update or delete on erp_platform.task_attempt for each row execute function erp_platform.attempt_guard();

create function erp_platform.task_dto(t erp_platform.task) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',t.id,'purpose',t.purpose,'operation_id',t.operation_id,'status',t.status,'attempts',t.attempts,'max_attempts',t.max_attempts,
  'created_at',t.created_at,'started_at',t.started_at,'finished_at',t.finished_at,'next_attempt_at',case when t.status='queued' then t.next_attempt_at end,
  'result',t.result,'error_code',t.error_code,'progress',case when t.status='running' then t.progress->'summary' end,
  'requested_by_name',(select left(p.name,120) from erp_access.profile p where p.user_id=t.requested_by),
  'history',coalesce((select jsonb_agg(jsonb_build_object('attempt',a.attempt,'started_at',a.started_at,'finished_at',a.finished_at,'outcome',a.outcome,'error_code',a.error_code) order by a.attempt)
   from erp_platform.task_attempt a where a.task_id=t.id),'[]'::jsonb))
$$;

-- The one way to create a task: the same (purpose, operation) returns the existing row, never a second one.
create function erp_platform.enqueue(p_purpose text,p_operation text,p_requested_by uuid,p_payload jsonb,p_max_attempts integer default 5)
returns erp_platform.task language plpgsql set search_path=pg_catalog as $$
declare t erp_platform.task;
begin
 insert into erp_platform.task(purpose,operation_id,requested_by,payload,max_attempts) values(p_purpose,p_operation,p_requested_by,coalesce(p_payload,'{}'::jsonb),p_max_attempts)
  on conflict(company_key,purpose,operation_id) do nothing returning * into t;
 if t.id is null then select * into t from erp_platform.task where company_key='empresa' and purpose=p_purpose and operation_id=p_operation; end if;
 return t;
end $$;

-- Agendamento (cron do Worker): the periodic tasks of the hour and of the day, in São Paulo time. Repeating it is harmless.
create function public.erp_platform_schedule(p_now timestamptz) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_local timestamp;t1 erp_platform.task;t2 erp_platform.task;
begin
 if p_now is null or p_now<clock_timestamp()-interval '1 day' or p_now>clock_timestamp()+interval '1 day' then
  raise exception 'erp_platform_schedule_input_invalid' using errcode='22023'; end if;
 v_local:=p_now at time zone 'America/Sao_Paulo';
 t1:=erp_platform.enqueue('notifications_generate','notificacoes:'||to_char(v_local,'YYYY-MM-DD"T"HH24'),null,jsonb_build_object('day',to_char(v_local,'YYYY-MM-DD')),3);
 t2:=erp_platform.enqueue('export_cleanup','limpeza-exportacoes:'||to_char(v_local,'YYYY-MM-DD'),null,'{}'::jsonb,3);
 return jsonb_build_object('scope','platform_schedule','data_mode','erp_native','tasks',jsonb_build_array(t1.id,t2.id));
end $$;

-- Reserve the next due task of the given purposes (null = any). An expired lease closes its attempt as "expired".
create function public.erp_platform_task_claim(p_lease uuid,p_purposes jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare t erp_platform.task;v_purposes text[];
begin
 if p_lease is null or p_purposes is not null and(jsonb_typeof(p_purposes)<>'array' or jsonb_array_length(p_purposes) not between 1 and 3
  or exists(select 1 from jsonb_array_elements(p_purposes) x where jsonb_typeof(x)<>'string' or x#>>'{}' not in('notifications_generate','company_export','export_cleanup'))) then
  raise exception 'erp_platform_task_input_invalid' using errcode='22023'; end if;
 v_purposes:=case when p_purposes is not null then array(select jsonb_array_elements_text(p_purposes)) end;
 -- Expired leases: the attempt ends as expired; with attempts left the task is due again, else it failed.
 for t in select * from erp_platform.task where status='running' and lease_until<clock_timestamp() for update skip locked loop
  update erp_platform.task_attempt set finished_at=clock_timestamp(),outcome='expired',error_code='ERP_TASK_LEASE_EXPIRED' where task_id=t.id and attempt=t.attempts and finished_at is null;
  if t.attempts>=t.max_attempts then
   update erp_platform.task set status='failed',lease_token=null,lease_until=null,finished_at=clock_timestamp(),error_code='ERP_TASK_LEASE_EXPIRED' where id=t.id;
  else update erp_platform.task set status='queued',lease_token=null,lease_until=null,next_attempt_at=clock_timestamp() where id=t.id; end if;
 end loop;
 select * into t from erp_platform.task where status='queued' and next_attempt_at<=clock_timestamp() and attempts<max_attempts
  and(v_purposes is null or purpose=any(v_purposes)) order by next_attempt_at,created_at,id limit 1 for update skip locked;
 if t.id is null then return jsonb_build_object('scope','platform_task','data_mode','erp_native','task',null); end if;
 update erp_platform.task set status='running',attempts=attempts+1,lease_token=p_lease,lease_until=clock_timestamp()+interval '5 minutes',
  started_at=coalesce(started_at,clock_timestamp()) where id=t.id returning * into t;
 insert into erp_platform.task_attempt(task_id,attempt,lease_token) values(t.id,t.attempts,p_lease);
 return jsonb_build_object('scope','platform_task','data_mode','erp_native','task',erp_platform.task_dto(t)||jsonb_build_object('payload',t.payload,'state',t.progress));
end $$;

-- The running task held by this lease, locked; anything else is a conflict (the work must stop).
create function erp_platform.task_held(p_task uuid,p_lease uuid) returns erp_platform.task language plpgsql set search_path=pg_catalog as $$
declare t erp_platform.task;
begin
 select * into t from erp_platform.task where id=p_task for update;
 if t.id is null then raise exception 'erp_platform_task_not_found' using errcode='P0002'; end if;
 if p_lease is null or t.status<>'running' or t.lease_token is distinct from p_lease or t.lease_until<clock_timestamp() then
  raise exception 'erp_platform_task_lease_lost' using errcode='40001'; end if;
 return t;
end $$;

-- Progress of a multi-step task (the export): the state survives a new attempt, and the lease is extended.
create function public.erp_platform_task_progress(p_task uuid,p_lease uuid,p_progress jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare t erp_platform.task;
begin
 if p_progress is null or jsonb_typeof(p_progress)<>'object' or length(p_progress::text)>65536 then raise exception 'erp_platform_task_input_invalid' using errcode='22023'; end if;
 t:=erp_platform.task_held(p_task,p_lease);
 update erp_platform.task set progress=p_progress,lease_until=clock_timestamp()+interval '5 minutes' where id=t.id returning * into t;
 return jsonb_build_object('scope','platform_task','data_mode','erp_native','task',erp_platform.task_dto(t));
end $$;

-- Conclusion: done with its result, or a failure that is retried with backoff while attempts remain.
create function public.erp_platform_task_finish(p_task uuid,p_lease uuid,p_ok boolean,p_result jsonb,p_error text) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare t erp_platform.task;v_retry boolean;
begin
 if p_ok is null or p_ok and(p_result is null or jsonb_typeof(p_result)<>'object' or length(p_result::text)>16384 or p_error is not null)
  or not p_ok and(p_error is null or p_error!~'^[A-Za-z0-9_]{1,80}$') then raise exception 'erp_platform_task_input_invalid' using errcode='22023'; end if;
 t:=erp_platform.task_held(p_task,p_lease);
 v_retry:=not p_ok and t.attempts<t.max_attempts;
 update erp_platform.task_attempt set finished_at=clock_timestamp(),outcome=case when p_ok then 'done' when v_retry then 'retry' else 'failed' end,error_code=p_error
  where task_id=t.id and attempt=t.attempts and finished_at is null;
 if p_ok then update erp_platform.task set status='done',lease_token=null,lease_until=null,finished_at=clock_timestamp(),result=p_result,error_code=null where id=t.id returning * into t;
 elsif v_retry then update erp_platform.task set status='queued',lease_token=null,lease_until=null,error_code=p_error,
   next_attempt_at=clock_timestamp()+make_interval(mins=>least(60,power(2,t.attempts)::integer)) where id=t.id returning * into t;
 else update erp_platform.task set status='failed',lease_token=null,lease_until=null,finished_at=clock_timestamp(),error_code=p_error where id=t.id returning * into t; end if;
 return jsonb_build_object('scope','platform_task','data_mode','erp_native','task',erp_platform.task_dto(t));
end $$;

-- notifications_generate: today's notifications of every active member, with the rules of the bell (151). Idempotent by the
-- unique (user, type, day): a repeated task, a second cron or the bell opened at the same time never duplicate a notification.
create function public.erp_platform_notifications_run(p_task uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare t erp_platform.task;v_today date;m record;k text;d record;v_new integer:=0;v_members integer:=0;n integer;
begin
 t:=erp_platform.task_held(p_task,p_lease);
 if t.purpose<>'notifications_generate' then raise exception 'erp_platform_task_input_invalid' using errcode='22023'; end if;
 v_today:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
 for k in select unnest(erp_home.notification_types()) loop
  select * into d from erp_home.notification_digest(k,v_today) x where x.quantity>0 limit 1;
  continue when d.quantity is null;
  for m in select user_id,role from erp_access.membership where active order by user_id loop
   if erp_home.notification_recipient(m.user_id,m.role,k) then
    insert into erp_home.notification(user_id,type,day,quantity,amount) values(m.user_id,k,v_today,d.quantity,d.amount) on conflict(user_id,type,day) do nothing;
    get diagnostics n=row_count;v_new:=v_new+n;
   end if;
  end loop;
 end loop;
 select count(*)::integer into v_members from erp_access.membership where active;
 return jsonb_build_object('scope','platform_notifications','data_mode','erp_native','day',to_char(v_today,'YYYY-MM-DD'),'created',v_new,'members',v_members);
end $$;

-- Consultar gestão de ações: the administrador sees every task; the other members, the tasks they asked for.
create function public.erp_platform_tasks(p_user_id uuid,p_limit integer) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=erp_access.member_role(p_user_id);
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_platform_task_input_invalid' using errcode='22023'; end if;
 return jsonb_build_object('scope','platform_tasks','data_mode','erp_native','all',v_role='admin',
  'items',coalesce((select jsonb_agg(erp_platform.task_dto(t) order by t.created_at desc,t.id) from(select * from erp_platform.task t
   where v_role='admin' or t.requested_by=p_user_id order by t.created_at desc,t.id limit p_limit) t),'[]'::jsonb));
end $$;

revoke all on all functions in schema erp_platform from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_platform_schedule','erp_platform_task_claim','erp_platform_task_progress','erp_platform_task_finish','erp_platform_notifications_run','erp_platform_tasks')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
