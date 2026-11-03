-- Leva H, lane plataforma (PRF-252): card Notas Fiscais da página inicial, "● N novas NF-es".
-- * Durante a convivência, conta só notas reais desde a última visualização do próprio usuário:
--   - sincronizadas do Origin (espelho origin_sync.raw_record, modelo 55) autorizadas ou com DANFE emitido (situações 6 e 7 do Origin),
--     sem as de homologação do acervo XML (ambiente 2);
--   - recebidas da SEFAZ pela Distribuição DF-e (resumos e notas completas) no canal de produção (ambiente 1).
--   A mesma chave de acesso conta uma vez. Rascunhos do Brufap e notas em homologação nunca entram.
-- * "Marcar como vistas" grava a visualização com comando idempotente. Sem visualização, conta os últimos 7 dias.
-- * Lido por quem lê as notas fiscais (administrador, consulta e fiscal).
-- Tabelas e funções novas; nenhuma função de outra frente é redefinida. Requer 330, 045 (DF-e) e 113 (lista de notas).
begin;

do $$begin
 if to_regnamespace('erp_platform') is null or to_regclass('erp_dfe.document') is null or to_regprocedure('erp_fiscal_invoices.origin_status(jsonb)') is null then
  raise exception 'platform_334_requires_330_045_113' using errcode='55000'; end if;
 if to_regclass('erp_platform.card_view') is not null then raise exception 'platform_334_already_applied' using errcode='55000'; end if;
end$$;

create table erp_platform.card_view(
 user_id uuid not null references auth.users(id),card text not null check(card='novas_nfes'),seen_at timestamptz not null,
 command_id uuid not null,updated_at timestamptz not null default clock_timestamp(),primary key(user_id,card)
);
create table erp_platform.card_view_command(
 id uuid primary key,actor uuid not null references auth.users(id),result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
alter table erp_platform.card_view enable row level security;
alter table erp_platform.card_view_command enable row level security;
revoke all on table erp_platform.card_view,erp_platform.card_view_command from public,anon,authenticated,service_role;

create function erp_platform.invoice_reader(p_user_id uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=erp_access.member_role(p_user_id);
 if v_role not in('admin','consulta','fiscal') then raise exception 'erp_platform_invoices_forbidden' using errcode='42501'; end if;
 return v_role;
end $$;

-- The notes counted after p_since: (source, access key or Origin id). The key, when there is one, removes the double count.
create function erp_platform.new_invoices(p_since timestamptz) returns table(source text,ident text) language sql stable set search_path=pg_catalog as $$
 select distinct on(coalesce(x.access_key,x.source||':'||x.ident)) x.source,coalesce(x.access_key,x.ident) from(
  select 'origin'::text source,r.source_id ident,case when r.payload->>'chaveAcesso'~'^[0-9]{44}$' then r.payload->>'chaveAcesso' end access_key,1 o
   from origin_sync.raw_record r where r.entity='nfe' and r.first_seen_at>p_since and erp_fiscal_invoices.origin_status(r.payload->'situacao') in(6,7)
    -- Homologation XMLs of the Origin archive stay out, as in the Origin view of the notes (113).
    and not exists(select 1 from origin_fiscal.source s join origin_fiscal.item i on i.revision=s.current_revision join origin_fiscal.object ob on ob.hash=i.object_hash
     where s.entity='nfe' and s.source_id=r.source_id and s.access_key=r.payload->>'chaveAcesso' and ob.metadata->>'kind'='invoice' and ob.metadata->>'environment'='2')
  union all
  select 'sefaz',d.id::text,d.access_key,2 from erp_dfe.document d join erp_dfe.channel ch on ch.id=d.channel_id
   where ch.environment='1' and d.kind in('invoice_summary','invoice') and not d.quarantined and d.created_at>p_since) x
 order by coalesce(x.access_key,x.source||':'||x.ident),x.o
$$;

create function erp_platform.new_invoices_view(p_user_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 with v as(select coalesce((select seen_at from erp_platform.card_view where user_id=p_user_id and card='novas_nfes'),clock_timestamp()-interval '7 days') since,
  exists(select 1 from erp_platform.card_view where user_id=p_user_id and card='novas_nfes') seen),
 n as(select * from erp_platform.new_invoices((select since from v)))
 select jsonb_build_object('scope','home_new_invoices','data_mode','erp_native','since',(select since from v),'seen_before',(select seen from v),
  'total',(select count(*)::integer from n),'synced',(select count(*)::integer from n where source='origin'),'received',(select count(*)::integer from n where source='sefaz'),
  'as_of',clock_timestamp())
$$;

create function public.erp_platform_new_invoices(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin perform erp_platform.invoice_reader(p_user_id); return erp_platform.new_invoices_view(p_user_id); end $$;

create function public.erp_platform_new_invoices_seen(p_user_id uuid,p_command_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c erp_platform.card_view_command;v_result jsonb;
begin
 perform erp_platform.invoice_reader(p_user_id);
 if p_command_id is null then raise exception 'erp_platform_input_invalid' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext('erp_platform_card_view'),hashtext(p_command_id::text));
 select * into c from erp_platform.card_view_command where id=p_command_id;
 if c.id is not null then
  if c.actor<>p_user_id then raise exception 'erp_platform_command_conflict' using errcode='40001'; end if;
  return c.result||jsonb_build_object('view',erp_platform.new_invoices_view(p_user_id),'replayed',true);
 end if;
 v_result:=jsonb_build_object('scope','home_new_invoices_seen','data_mode','erp_native','seen_at',clock_timestamp());
 insert into erp_platform.card_view_command(id,actor,result) values(p_command_id,p_user_id,v_result);
 insert into erp_platform.card_view(user_id,card,seen_at,command_id) values(p_user_id,'novas_nfes',clock_timestamp(),p_command_id)
  on conflict(user_id,card) do update set seen_at=excluded.seen_at,command_id=excluded.command_id,updated_at=clock_timestamp();
 return v_result||jsonb_build_object('view',erp_platform.new_invoices_view(p_user_id),'replayed',false);
end $$;

revoke all on all functions in schema erp_platform from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in('erp_platform_new_invoices','erp_platform_new_invoices_seen')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
