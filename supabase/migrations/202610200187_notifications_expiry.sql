-- 187: notificações "Cliente a ser visitado" e "Produto com data de validade próxima" (Origin) e o aviso "Produtos próximos da
-- validade" da página inicial.
-- * Central de Notificações: duas chaves novas (destinatários) na página da 151, depois das chaves já aplicadas.
-- * Cliente a ser visitado: um aviso por dia com os contatos ativos cuja Próxima visita (cadastro do contato) é hoje; para quem
--   consulta contatos.
-- * Produto com data de validade próxima: um aviso por dia com os produtos ativos e não excluídos cuja Data de validade vence de
--   hoje até hoje + N dias, sendo N "Número de dias antes da data de validade" (Preferências › Cadastros › Configurações de
--   produtos, chave produtos.dias_aviso_validade); para quem consulta produtos.
-- * Certificado A1 próximo do vencimento (aviso do Brufap, além dos tipos do Origin): um aviso por dia enquanto o certificado A1 em
--   custódia vence em até 30 dias ou já venceu; para administrador e fiscal.
-- * Página inicial: erp_home_expiring lista os mesmos produtos, incluindo os já vencidos, do mais próximo ao mais distante (até
--   20, com o total), só para quem consulta produtos.
-- Datas no calendário de São Paulo. Substitui erp_home.notification_roles, notification_types e notification_digest (151);
-- qualquer outra versão interrompe a migração. Nenhum e-mail é enviado.
begin;

do $$declare v record;begin
 for v in select * from(values('erp_home.notification_roles(text)','e0312794979e92c25f783b4efebe87ecfdb9e6b6fd1f1b3b29633d4774684015'),
  ('erp_home.notification_types()','e7b75dfa9853fb6a60563348bc30b4a46d65499a01ada4682a2afcccbb96ecf6'),
  ('erp_home.notification_digest(text,date)','c79de2a8fb51b6f6b2b4db6b42e4cc677bb786267329dd6d9b0fb19fc7a06806')) x(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'notifications_187_previous_definition_changed %',v.sig using errcode='55000';end if;
 end loop;
end$$;

-- BEGIN GENERATED DEFINITIONS (tools/preferences/generate-definitions.mjs)
insert into erp_preferences.definition(key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format)values
 ('notificacoes.cliente_visitado','central-notificacoes','notificacoes',9,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('notificacoes.validade','central-notificacoes','notificacoes',10,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('notificacoes.certificado_a1','central-notificacoes','notificacoes',11,'users',null,'[]'::jsonb,null,null,null,null,100,null);
-- END GENERATED DEFINITIONS

do $$declare c text;begin
 for c in select conname from pg_constraint where conrelid='erp_home.notification'::regclass and contype='c' and pg_get_constraintdef(oid) like '%contas_pagar_atrasadas%' loop
  execute format('alter table erp_home.notification drop constraint %I',c);
 end loop;
end$$;
alter table erp_home.notification add constraint notification_type_check check(type in('contas_pagar_atrasadas','contas_receber_atrasadas','estoque_abaixo_minimo','estoque_maximo','estoque_zerado',
 'pagamento_efetuado','pagamento_recebido','proximo_contato','cliente_visitado','validade','certificado_a1'));

-- Who reads each type: finanças (008/010), estoque (009), propostas (008), contatos and produtos (006).
create or replace function erp_home.notification_roles(p_type text) returns text[] language sql immutable set search_path=pg_catalog as $$
 select case when p_type in('contas_pagar_atrasadas','contas_receber_atrasadas','pagamento_efetuado','pagamento_recebido') then array['admin','consulta','financeiro']
  when p_type in('estoque_abaixo_minimo','estoque_maximo','estoque_zerado','validade') then array['admin','consulta','vendas','estoque','fiscal']
  when p_type='proximo_contato' then array['admin','consulta','financeiro','vendas']
  when p_type='cliente_visitado' then array['admin','consulta','vendas','financeiro','estoque','fiscal']
  when p_type='certificado_a1' then array['admin','fiscal'] else array[]::text[] end
$$;
create or replace function erp_home.notification_types() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['contas_pagar_atrasadas','contas_receber_atrasadas','estoque_abaixo_minimo','estoque_maximo','estoque_zerado','pagamento_efetuado','pagamento_recebido','proximo_contato',
  'cliente_visitado','validade','certificado_a1']
$$;
-- "Número de dias antes da data de validade" (0 to 9999; an unreadable value counts as 0).
create function erp_home.expiry_days() returns integer language sql stable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='number' and(v#>>'{}')~'^[0-9]{1,4}$' then(v#>>'{}')::integer else 0 end from(select erp_preferences.get('produtos.dias_aviso_validade') v) x
$$;
-- Active, not deleted products with a Data de validade up to p_until (and from p_from when given).
create function erp_home.expiring_products(p_from date,p_until date) returns table(product_id uuid,code text,name text,expiry_date date) language sql stable set search_path=pg_catalog as $$
 select r.id,r.code,r.name,d.expiry_date from erp_catalog.product_detail d join erp_catalog.record r on r.id=d.record_id
 where r.active and d.deleted_at is null and d.expiry_date is not null and d.expiry_date<=p_until and(p_from is null or d.expiry_date>=p_from)
$$;
-- Today's digest of one type: (quantity, amount). Stock uses the considered warehouses (106) and the product limits (023).
create or replace function erp_home.notification_digest(p_type text,p_today date) returns table(quantity integer,amount numeric) language sql stable set search_path=pg_catalog as $$
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
 union all
 select count(*)::integer,null from erp_catalog.contact_profile cp join erp_catalog.record r on r.id=cp.record_id
  where p_type='cliente_visitado' and r.active and cp.next_visit=p_today
 union all
 select count(*)::integer,null from erp_home.expiring_products(p_today,p_today+erp_home.expiry_days()) x where p_type='validade'
 union all
 -- The A1 in custody (erp_a1.head, metadata validated by 041) that ends within 30 days of today, or already ended.
 select count(*)::integer,null from erp_a1.head h join erp_a1.credential c on c.id=h.credential_id
  where p_type='certificado_a1' and h.singleton and(c.metadata->>'not_after')::timestamptz<((p_today+31)::timestamp at time zone 'America/Sao_Paulo')
$$;

-- Página inicial: "Produtos próximos da validade" (vencidos inclusive), para quem consulta produtos.
create function public.erp_home_expiring(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_today date;v_days integer;v_total integer;v_items jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 v_today:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;v_days:=erp_home.expiry_days();
 select count(*)::integer into v_total from erp_home.expiring_products(null,v_today+v_days);
 select coalesce(jsonb_agg(jsonb_build_object('product_id',x.product_id,'code',left(x.code,60),'name',left(regexp_replace(x.name,'[[:cntrl:]]',' ','g'),200),'expiry_date',to_char(x.expiry_date,'YYYY-MM-DD'),
   'expired',x.expiry_date<v_today) order by x.expiry_date,lower(x.name),x.product_id),'[]'::jsonb) into v_items
  from(select * from erp_home.expiring_products(null,v_today+v_days) order by expiry_date,lower(name),product_id limit 20) x;
 return jsonb_build_object('scope','product_expiry','data_mode','erp_native','business_date',to_char(v_today,'YYYY-MM-DD'),'days',v_days,'total',v_total,'items',v_items);
end $$;

revoke all on all functions in schema erp_home from public,anon,authenticated,service_role;
revoke all on function public.erp_home_expiring(uuid) from public,anon,authenticated,service_role;
grant execute on function public.erp_home_expiring(uuid) to service_role;
-- The RPCs of 151 keep their grants (create or replace keeps them); the helper functions stay without grants.
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in('erp_home_notifications','erp_home_notifications_read')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
