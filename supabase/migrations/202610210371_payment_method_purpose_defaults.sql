-- 371: formas de pagamento com padrão por finalidade (leva H, lane financeiro: CTT-130).
-- Decisão recomendada (10.3, CTT-130): definir separadamente a forma padrão para recebimentos, pagamentos e devoluções, respeitando
-- a finalidade ("Aplicável à") e o estado ativo. O indicador de devolução só aparece quando a configuração existe.
-- * erp_catalog.payment_method ganha default_receipt, default_payment e default_return, cada um com no máximo uma forma.
-- * O padrão de recebimentos exige forma aplicável a recebimentos (ou ambos); o de pagamentos, a pagamentos (ou ambos); o de
--   devoluções, a recebimentos (ou ambos), porque a devolução estorna um recebimento ao cliente.
-- * is_default (127), que a Frente de caixa, os documentos e as gavetas já leem, passa a ser sempre o padrão de recebimentos.
-- * Inativar, excluir ou mudar a finalidade tira a forma dos padrões que ela não atende mais (gatilho).
-- * Menu ⋮: Forma padrão de recebimentos, Forma padrão de pagamentos, Forma padrão de devoluções e Remover padrão de devoluções;
--   a ação antiga "default" vira o padrão da finalidade da forma.
-- * As gavetas de contas (175/210) ordenam e marcam a forma padrão da finalidade da conta (a receber ou a pagar).
-- Nenhuma conta, documento ou movimento é alterado.
begin;

do $$ declare r record; begin
  for r in select * from (values
    ('erp_catalog.payment_method_dto(uuid)','6c7e1e07f88093bff3205dfe659bdf635458543228e110dffb625a1961d6a917'),
    ('public.erp_finance_payment_methods(uuid,text)','168e5ab98ef584f9b72bf75172e2bd249944fd5e94f361c36baffb4b9c11d311'),
    ('public.erp_catalog_payment_method_action(uuid,uuid,integer,uuid,text)','1ad6d30f57f5bff255bf40631dc9284948507af8d4f96ea8a5620d6e53c49be3')) v(sig,expected) loop
    if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
      raise exception 'payment_method_defaults_371_previous_definition_changed' using errcode='55000',detail=r.sig; end if;
  end loop;
  if exists(select 1 from information_schema.columns where table_schema='erp_catalog' and table_name='payment_method' and column_name='default_receipt') then
    raise exception 'payment_method_defaults_371_already_applied' using errcode='55000'; end if;
end $$;

alter table erp_catalog.payment_method add column default_receipt boolean not null default false,add column default_payment boolean not null default false,
  add column default_return boolean not null default false;
update erp_catalog.payment_method set default_receipt=is_default and applicable in ('recebimentos','ambos'),default_payment=is_default and applicable in ('pagamentos','ambos')
  where is_default;
update erp_catalog.payment_method set is_default=false where is_default and not default_receipt;
alter table erp_catalog.payment_method add constraint payment_method_default_receipt check(not default_receipt or (active and deleted_at is null and applicable in ('recebimentos','ambos'))),
  add constraint payment_method_default_payment check(not default_payment or (active and deleted_at is null and applicable in ('pagamentos','ambos'))),
  add constraint payment_method_default_return check(not default_return or (active and deleted_at is null and applicable in ('recebimentos','ambos'))),
  add constraint payment_method_default_mirror check(is_default=default_receipt);
create unique index erp_catalog_payment_method_default_receipt on erp_catalog.payment_method(default_receipt) where default_receipt;
create unique index erp_catalog_payment_method_default_payment on erp_catalog.payment_method(default_payment) where default_payment;
create unique index erp_catalog_payment_method_default_return on erp_catalog.payment_method(default_return) where default_return;

-- A forma deixa os padrões que não atende mais (inativada, excluída ou com outra finalidade); is_default acompanha o de recebimentos.
create function erp_catalog.payment_method_defaults_fit() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if not new.active or new.deleted_at is not null then new.default_receipt:=false; new.default_payment:=false; new.default_return:=false; end if;
  if new.applicable not in ('recebimentos','ambos') then new.default_receipt:=false; new.default_return:=false; end if;
  if new.applicable not in ('pagamentos','ambos') then new.default_payment:=false; end if;
  new.is_default:=new.default_receipt;
  return new;
end $$;
create trigger payment_method_defaults_fit before insert or update on erp_catalog.payment_method for each row execute function erp_catalog.payment_method_defaults_fit();

CREATE OR REPLACE FUNCTION erp_catalog.payment_method_dto(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 select jsonb_build_object('id',m.id,'version',m.version,'description',m.description,'payment_type',m.payment_type,'condition',m.condition,'destination',m.destination,
  'account_id',m.account_id,'account_name',(select left(a.name,200) from erp_finance.account a where a.id=m.account_id),'business_days',m.business_days,
  'applicable',m.applicable,'interest_rate',m.interest_rate::text,'fine_rate',m.fine_rate::text,'card_brand',m.card_brand,'card_integration',m.card_integration,
  'card_cnpj',m.card_cnpj,'auto_settle',m.auto_settle,'pix_integration',m.pix_integration,'pix_cnpj',m.pix_cnpj,'fee_type',m.fee_type,'fee_rate',m.fee_rate::text,
  'fee_fixed',m.fee_fixed::text,'settlement_days',m.settlement_days,'active',m.active,'is_default',m.is_default,
  -- 371: the default of each purpose.
  'default_receipt',m.default_receipt,'default_payment',m.default_payment,'default_return',m.default_return,'created_at',m.created_at,'updated_at',m.updated_at)
 from erp_catalog.payment_method m where m.id=p_id and m.deleted_at is null
$function$;

CREATE OR REPLACE FUNCTION public.erp_finance_payment_methods(p_user_id uuid, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_kind is null or p_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  -- 371: is_default is the default of the purpose of the conta (recebimentos for a conta a receber, pagamentos for a conta a pagar).
  return jsonb_build_object('entity','payment_methods','kind',p_kind,'items',(select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'description',f.description,'payment_type',f.payment_type,
    'account_id',f.account_id,'interest_rate',f.interest_rate::text,'fine_rate',f.fine_rate::text,'fee_type',f.fee_type,'fee_rate',f.fee_rate::text,'fee_fixed',f.fee_fixed::text,'is_default',f.purpose_default,
    -- 210: Prazo de recebimento (dias) and "dias úteis" of the forma, used by the gaveta for the vencimento.
    'settlement_days',f.settlement_days,'business_days',f.business_days)
    order by f.purpose_default desc,lower(f.description),f.id),'[]'::jsonb) from (select f.*,case when p_kind='receivable' then f.default_receipt else f.default_payment end purpose_default
      from erp_catalog.payment_method f where f.active and f.deleted_at is null
      and f.applicable in ('ambos',case when p_kind='receivable' then 'recebimentos' else 'pagamentos' end)
      order by case when p_kind='receivable' then f.default_receipt else f.default_payment end desc,lower(f.description),f.id limit 200) f),'data_mode','erp_native');
end $function$;

-- Menu ⋮ e lixeira (127) com os padrões por finalidade: default_recebimentos, default_pagamentos, default_devolucoes e
-- clear_devolucoes; "default" é o padrão da finalidade da forma (recebimentos quando ela atende recebimentos).
CREATE OR REPLACE FUNCTION public.erp_catalog_payment_method_action(p_user_id uuid, p_id uuid, p_expected_version integer, p_command_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.payment_method%rowtype; v_before jsonb; v_result jsonb; v_previous uuid; v_column text;
begin
 perform erp_catalog.payment_method_access(p_user_id,true);
 if p_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483647 or p_action is null
  or p_action not in('default','default_recebimentos','default_pagamentos','default_devolucoes','clear_devolucoes','activate','inactivate','delete') then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-payment-method-action-v1','actor',p_user_id,'id',p_id,'version',p_expected_version,'action',p_action)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 perform pg_advisory_xact_lock(174852908,3);
 select * into v_row from erp_catalog.payment_method where id=p_id and deleted_at is null for update;
 if v_row.id is null then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
 v_before:=erp_catalog.payment_method_dto(p_id);
 if p_action like 'default%' then
  if not v_row.active then raise exception 'erp_catalog_payment_method_inactive' using errcode='22023'; end if;
  v_column:=case p_action when 'default_recebimentos' then 'default_receipt' when 'default_pagamentos' then 'default_payment' when 'default_devolucoes' then 'default_return'
   else case when v_row.applicable in ('recebimentos','ambos') then 'default_receipt' else 'default_payment' end end;
  if (v_column in ('default_receipt','default_return') and v_row.applicable not in ('recebimentos','ambos')) or (v_column='default_payment' and v_row.applicable not in ('pagamentos','ambos')) then
   raise exception 'erp_catalog_payment_method_purpose' using errcode='22023'; end if;
  if not (case v_column when 'default_receipt' then v_row.default_receipt when 'default_payment' then v_row.default_payment else v_row.default_return end) then
   execute format('select id from erp_catalog.payment_method where %I for update',v_column) into v_previous;
   execute format('update erp_catalog.payment_method set %I=false,version=version+1,updated_by=$1,updated_at=clock_timestamp() where %I',v_column,v_column) using p_user_id;
   execute format('update erp_catalog.payment_method set %I=true,version=version+1,updated_by=$1,updated_at=clock_timestamp() where id=$2',v_column) using p_user_id,p_id;
  end if;
 elsif p_action='clear_devolucoes' then
  if v_row.default_return then update erp_catalog.payment_method set default_return=false,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id; end if;
 elsif p_action='activate' then
  if not v_row.active then update erp_catalog.payment_method set active=true,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id; end if;
 elsif p_action='inactivate' then
  if v_row.active then update erp_catalog.payment_method set active=false,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id; end if;
 else
  update erp_catalog.payment_method set deleted_by=p_user_id,deleted_at=clock_timestamp(),version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 end if;
 v_result:=jsonb_build_object('entity','payment_methods','data_mode','erp_native','replayed',false,'id',p_id,'action',p_action,'item',erp_catalog.payment_method_dto(p_id),'previous_default',v_previous);
 insert into erp_catalog.auxiliary_audit(actor,command_id,subject,subject_id,action,before_data,after_data)
  values(p_user_id,p_command_id,'payment_method',p_id,case p_action when 'delete' then 'archive' when 'activate' then 'activate' when 'inactivate' then 'inactivate' else 'default' end,v_before,v_result->'item');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

revoke all on function erp_catalog.payment_method_defaults_fit(),erp_catalog.payment_method_dto(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_payment_methods(uuid,text),public.erp_catalog_payment_method_action(uuid,uuid,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.erp_finance_payment_methods(uuid,text),public.erp_catalog_payment_method_action(uuid,uuid,integer,uuid,text) to service_role;
commit;
