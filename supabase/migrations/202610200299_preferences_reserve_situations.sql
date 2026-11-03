-- 299: Preferências › Suprimentos › Estoque › Reserva de estoque: "Situações de vendas consideradas" passa a oferecer também as
-- situações personalizadas dos pedidos de venda (Sistema › Gerenciador de transições, 148), como o Origin, que lista todas as
-- situações. A frente de estoque já reserva os pedidos numa situação personalizada cujo id (UUID em texto) esteja na lista
-- (erp_stock.reserve_situation_ids, 277); faltava a tela e a regra da preferência.
-- * erp_preferences.definition ganha situation_kind: um campo de múltipla escolha com ela aceita, depois das opções padrão (na
--   ordem das opções), os ids das situações personalizadas desse tipo de documento, em ordem crescente e sem repetir (até 30, o
--   limite de situações por aba). Só "estoque.reserva_situacoes" usa (pedidos de venda).
-- * Salvar: um id acrescentado agora tem de ser de uma situação personalizada ativa de pedido de venda; um id já gravado continua
--   aceito mesmo que a situação tenha sido inativada depois (pode ficar ou ser desmarcado), como os usuários dos campos de usuários.
-- * A página traz as situações personalizadas (id, nome, situação base, cor e ativa) em "situations", só nas páginas que têm um
--   campo assim; as demais páginas não mudam.
-- Substitui erp_preferences.value_valid e page_dto (264) e erp_preferences_save (115), conferidas pelo hash; outra versão
-- interrompe a migração. Nenhum valor gravado é reescrito.
begin;

do $$declare r record;begin
 if to_regclass('erp_preferences.situation') is null or to_regprocedure('erp_stock.reserve_situation_ids()') is null then
  raise exception 'preferences_reserve_situations_299_requires_148_277' using errcode='55000';end if;
 for r in select * from(values
  ('erp_preferences.value_valid(erp_preferences.definition,jsonb)','1af6dd8f9653a37652d5b3e8172798ad824e51e812e5898472c4caf684fceab3'),
  ('erp_preferences.page_dto(erp_preferences.page,text,uuid)','d99a7829af5ae5a4e1cc37d21fe44ce79a1788354b7ed296d9587b6bb6701851'),
  ('public.erp_preferences_save(uuid,uuid,text,jsonb)','f6f6700379ebd5a4f0cff482b288b4b92ce91d73b523be783b6be7c1885681cc'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'preferences_reserve_situations_299_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if not exists(select 1 from erp_preferences.definition where key='estoque.reserva_situacoes' and page_id='suprimentos-estoque' and kind='multi' and max_items=8
  and options='["em_aberto","atendido","cancelado","em_andamento","venda_agenciada","em_digitacao","verificado","checkout_parcial"]'::jsonb) then
  raise exception 'preferences_reserve_situations_299_definition_changed' using errcode='55000';end if;
end$$;

alter table erp_preferences.definition add column situation_kind text;
alter table erp_preferences.definition add constraint definition_situation_kind_check
 check(situation_kind is null or(kind='multi' and situation_kind in('sales_orders','purchase_orders','service_orders')));
update erp_preferences.definition set situation_kind='sales_orders' where key='estoque.reserva_situacoes';

create or replace function erp_preferences.value_valid(d erp_preferences.definition,v jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare e jsonb; s text; t text; seen text[]:='{}'; prev text; c jsonb;
begin
 if d.key is null or v is null then return false; end if;
 case d.kind
 when 'toggle' then return jsonb_typeof(v)='boolean';
 when 'choice' then return jsonb_typeof(v)='string' and d.options?(v#>>'{}');
 when 'multi' then
  if jsonb_typeof(v)<>'array' then return false; end if;
  -- 299: after the default options, the ids of custom situações of the kind (lower-case UUIDs, ascending, distinct, up to 30).
  if d.situation_kind is not null then
   if exists(select 1 from jsonb_array_elements(v) x where jsonb_typeof(x)<>'string') then return false; end if;
   select coalesce(jsonb_agg(x order by n),'[]'::jsonb) into c from jsonb_array_elements(v) with ordinality y(x,n) where not d.options?(x#>>'{}');
   if jsonb_array_length(c)>30 then return false; end if;
   for e in select x from jsonb_array_elements(c) x loop
    if e#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or(prev is not null and(e#>>'{}') collate "C"<=prev collate "C") then return false; end if;
    prev:=e#>>'{}';
   end loop;
   prev:=null;
   -- The custom ids come after every default option.
   if(select coalesce(jsonb_agg(x order by n),'[]'::jsonb) from jsonb_array_elements(v) with ordinality y(x,n) where d.options?(x#>>'{}'))||c<>v then return false; end if;
   v:=(select coalesce(jsonb_agg(x order by n),'[]'::jsonb) from jsonb_array_elements(v) with ordinality y(x,n) where d.options?(x#>>'{}'));
  end if;
  if jsonb_array_length(v)>d.max_items then return false; end if;
  if exists(select 1 from jsonb_array_elements(v) x where jsonb_typeof(x)<>'string' or not d.options?(x#>>'{}')) then return false; end if;
  -- Distinct and in option order, so one choice has one representation.
  return not exists(select 1 from(select o.i,lag(o.i)over(order by x.n) as before_i from jsonb_array_elements_text(v) with ordinality x(val,n)
   join jsonb_array_elements_text(d.options) with ordinality o(opt,i) on o.opt=x.val) q where q.before_i is not null and q.i<=q.before_i);
 when 'integer' then
  if jsonb_typeof(v)<>'number' or v::text!~'^-?(0|[1-9][0-9]{0,8})$' then return false; end if;
  return v::text::integer between d.min_value and d.max_value;
 when 'decimal' then
  if jsonb_typeof(v)<>'string' then return false; end if; s:=v#>>'{}';
  if s!~('^(0|[1-9][0-9]{0,8})(\.[0-9]{1,'||d.scale||'})?$') then return false; end if;
  return s::numeric between d.min_value and d.max_value;
 when 'text' then
  if jsonb_typeof(v)<>'string' then return false; end if; s:=v#>>'{}';
  if length(s)>d.max_length or s~'[\x01-\x1f\x7f]' or s~'^ | $' then return false; end if;
  if s='' or d.format='plain' then return true; end if;
  if d.format='email' then return s~'^[^@ ]+@[^@ ]+\.[^@ ]+$'; end if;
  -- 264: only digits, from min_length (or 1) to max_length.
  if d.format='digits' then return s~'^[0-9]+$' and length(s) between coalesce(d.min_length,1) and d.max_length; end if;
  return cardinality(regexp_split_to_array(s,','))<=d.max_items
   and not exists(select 1 from unnest(regexp_split_to_array(s,',')) p where btrim(p,' ')!~'^[^@ ]+@[^@ ]+\.[^@ ]+$');
 when 'textarea' then
  if jsonb_typeof(v)<>'string' then return false; end if; s:=v#>>'{}';
  return length(s)<=d.max_length and s!~'[\x01-\x09\x0b-\x1f\x7f]' and s!~'^[ \n]|[ \n]$';
 when 'users' then
  if jsonb_typeof(v)<>'array' or jsonb_array_length(v)>d.max_items then return false; end if;
  for e in select x from jsonb_array_elements(v) x loop
   if jsonb_typeof(e)<>'string' or e#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (prev is not null and (e#>>'{}') collate "C"<=prev collate "C") then return false; end if;
   prev:=e#>>'{}';
  end loop;
  return true;
 when 'keymap' then
  if jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(d.options->'actions') then return false; end if;
  if exists(select 1 from jsonb_array_elements_text(d.options->'actions') a where not v?a or jsonb_typeof(v->a)<>'string' or not(d.options->'keys')?(v->>a)) then return false; end if;
  return(select count(distinct v->>a) from jsonb_array_elements_text(d.options->'actions') a)=jsonb_array_length(d.options->'actions');
 when 'documents' then
  if jsonb_typeof(v)<>'array' or jsonb_array_length(v)>d.max_items then return false; end if;
  for e in select x from jsonb_array_elements(v) x loop
   if jsonb_typeof(e)<>'object' or(select count(*) from jsonb_object_keys(e))<>2 or not(e?'document' and e?'name')
    or jsonb_typeof(e->'document')<>'string' or jsonb_typeof(e->'name')<>'string' then return false; end if;
   s:=e->>'document';t:=e->>'name';
   if not(erp_catalog.valid_cpf(s) or erp_catalog.valid_cnpj(s)) or s=any(seen) then return false; end if;
   if length(t)>80 or t~'[\x01-\x1f\x7f]' or t~'^ | $' then return false; end if;
   seen:=seen||s;
  end loop;
  return true;
 else return false;
 end case;
end $$;

-- The custom situações a page offers (only the kinds of its fields with situation_kind): id, name, base, color and active.
create function erp_preferences.page_situations(p_page text) returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'name',s.name,'base_status',s.base_status,'base_label',coalesce(b.label,s.base_status),'color',s.color,'active',s.active)
   order by array_position(array['sales_orders','purchase_orders','service_orders'],s.kind),coalesce(b.ordinal,1000),lower(s.name),s.id),'[]'::jsonb)
 from erp_preferences.situation s left join lateral(select x.label,x.ordinal from erp_preferences.situation_bases(s.kind) x where x.status=s.base_status) b on true
 where s.kind in(select d.situation_kind from erp_preferences.definition d where d.page_id=p_page and d.situation_kind is not null)
$$;

create or replace function erp_preferences.page_dto(p_page erp_preferences.page,p_role text,p_user uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v_key text:=erp_preferences.page_permission(p_page.id);
begin
 -- 264: Espaço Meu Contador and Central de Notificações follow the permission of the user (the administrador always has it).
 if v_key is not null and not erp_access.permitted(p_user,v_key) then raise exception 'erp_preferences_permission_denied' using errcode='42501'; end if;
 return(select jsonb_build_object('scope','preferences_page','data_mode','erp_native','page',p_page.id,'owner',p_page.scope,'role',p_role,
  'can_manage',p_page.scope='user' or p_role='admin',
  'items',(select coalesce(jsonb_agg(jsonb_build_object('key',d.key,'value',coalesce(v.value,d.default_value),'version',coalesce(v.version,0),'updated_at',v.updated_at) order by d.ordinal),'[]'::jsonb)
   from erp_preferences.definition d
   left join lateral(select c.value,c.version,c.updated_at from erp_preferences.company_value c where p_page.scope='company' and c.key=d.key
    union all select u.value,u.version,u.updated_at from erp_preferences.user_value u where p_page.scope='user' and u.key=d.key and u.user_id=p_user) v on true
   where d.page_id=p_page.id),
  'directory',case when(p_page.scope='user' or p_role='admin')and exists(select 1 from erp_preferences.definition d where d.page_id=p_page.id and d.kind='users')
   then erp_preferences.directory() end)
  -- 299: the custom situações, only on a page with a field that offers them.
  ||case when exists(select 1 from erp_preferences.definition d where d.page_id=p_page.id and d.situation_kind is not null)
   then jsonb_build_object('situations',erp_preferences.page_situations(p_page.id)) else '{}'::jsonb end);
end $$;

-- Saves only the changed keys of one page. Each change carries the version it was read at (CAS per key); a key changed by
-- someone else since then refuses the whole command, and nothing is written.
create or replace function public.erp_preferences_save(p_user_id uuid,p_command_id uuid,p_page text,p_changes jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text; v_page erp_preferences.page; v_owner uuid; v_canonical jsonb; v_hash text; v_command erp_preferences.command;
 v_change jsonb; v_def erp_preferences.definition; v_value jsonb; v_version integer; v_receipt jsonb:='[]'::jsonb; v_at timestamptz; v_result jsonb; v_rows integer;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 if p_command_id is null or p_page is null or p_changes is null or jsonb_typeof(p_changes)<>'array' or jsonb_array_length(p_changes)=0 then
  raise exception 'erp_preferences_input_invalid' using errcode='22023'; end if;
 select * into v_page from erp_preferences.page where id=p_page;
 if v_page.id is null then raise exception 'erp_preferences_page_not_found' using errcode='P0002'; end if;
 if not v_role=any(v_page.read_roles) or(v_page.scope='company' and v_role<>'admin') then
  raise exception 'erp_preferences_access_denied' using errcode='42501'; end if;
 if jsonb_array_length(p_changes)>(select count(*) from erp_preferences.definition where page_id=p_page)
  or exists(select 1 from jsonb_array_elements(p_changes) c where jsonb_typeof(c)<>'object'
   or(select count(*) from jsonb_object_keys(c))<>3 or not(c?'key' and c?'expected_version' and c?'value')
   or jsonb_typeof(c->'key')<>'string' or jsonb_typeof(c->'expected_version')<>'number'
   or(c->'expected_version')::text!~'^(0|[1-9][0-9]{0,9})$' or(c->>'expected_version')::bigint>2147483646
   or not exists(select 1 from erp_preferences.definition d where d.page_id=p_page and d.key=c->>'key')
   or not erp_preferences.value_valid((select d from erp_preferences.definition d where d.key=c->>'key'),c->'value'))
  or(select count(distinct c->>'key') from jsonb_array_elements(p_changes) c)<>jsonb_array_length(p_changes) then
  raise exception 'erp_preferences_input_invalid' using errcode='22023'; end if;
 v_owner:=case when v_page.scope='user' then p_user_id end;
 select jsonb_agg(jsonb_build_object('key',c->>'key','expected_version',(c->>'expected_version')::integer,'value',c->'value') order by c->>'key' collate "C")
  into v_canonical from jsonb_array_elements(p_changes) c;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-preferences-v1','actor',p_user_id,'page',p_page,'changes',v_canonical)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtext('erp_preferences_command'),hashtext(p_command_id::text));
 select * into v_command from erp_preferences.command where id=p_command_id;
 if v_command.id is not null then
  v_role:=erp_preferences.write_access(p_user_id,v_page);
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_preferences_command_conflict' using errcode='40001'; end if;
  return v_command.result||jsonb_build_object('page',erp_preferences.page_dto(v_page,v_role,p_user_id),'replayed',true);
 end if;
 -- Writers of the same page (and owner) are serialized; access is checked again after the wait.
 perform pg_advisory_xact_lock(hashtext('erp_preferences_page'),hashtext(p_page||':'||coalesce(v_owner::text,'company')));
 v_role:=erp_preferences.write_access(p_user_id,v_page);
 for v_change in select x from jsonb_array_elements(v_canonical) x loop
  select * into v_def from erp_preferences.definition where key=v_change->>'key';
  v_value:=null;v_version:=0;
  if v_page.scope='company' then select c.value,c.version into v_value,v_version from erp_preferences.company_value c where c.key=v_def.key for update;
  else select u.value,u.version into v_value,v_version from erp_preferences.user_value u where u.key=v_def.key and u.user_id=p_user_id for update; end if;
  if v_value is null then v_value:=v_def.default_value;v_version:=0; end if;
  if v_version<>(v_change->>'expected_version')::integer then raise exception 'erp_preferences_version_conflict' using errcode='40001'; end if;
  if v_value=v_change->'value' then raise exception 'erp_preferences_unchanged' using errcode='22023'; end if;
  -- "users" fields: a person added now must be an active member; one already marked who was later deactivated may stay
  -- (or be removed), so editing the field never requires reactivating someone first.
  if v_def.kind='users' and exists(select 1 from jsonb_array_elements_text(v_change->'value') u where not(v_value?u)
    and not exists(select 1 from erp_access.membership m where m.user_id::text=u and m.active)) then
   raise exception 'erp_preferences_user_invalid' using errcode='22023'; end if;
  -- 299: a custom situação added now must be an active one of the kind; one already chosen and inactivated later may stay.
  if v_def.situation_kind is not null and exists(select 1 from jsonb_array_elements_text(v_change->'value') x where not v_def.options?x and not(v_value?x)
    and not exists(select 1 from erp_preferences.situation s where s.id::text=x and s.kind=v_def.situation_kind and s.active)) then
   raise exception 'erp_preferences_situation_invalid' using errcode='22023'; end if;
  v_receipt:=v_receipt||jsonb_build_array(jsonb_build_object('key',v_def.key,'from_version',v_version,'to_version',v_version+1,'before',v_value,'after',v_change->'value'));
 end loop;
 v_at:=clock_timestamp();
 v_result:=jsonb_build_object('scope','preferences_command','data_mode','erp_native',
  'receipt',jsonb_build_object('command_id',p_command_id,'page',p_page,'changed_at',v_at,'changes',v_receipt));
 insert into erp_preferences.command(id,actor,page_id,owner,request_hash,result) values(p_command_id,p_user_id,p_page,v_owner,v_hash,v_result);
 for v_change in select x from jsonb_array_elements(v_receipt) x loop
  if v_page.scope='company' then
   if(v_change->>'from_version')::integer=0 then
    insert into erp_preferences.company_value(key,value,version,updated_at,updated_by,command_id) values(v_change->>'key',v_change->'after',1,v_at,p_user_id,p_command_id);
   else
    update erp_preferences.company_value set value=v_change->'after',version=version+1,updated_at=v_at,updated_by=p_user_id,command_id=p_command_id
     where key=v_change->>'key' and version=(v_change->>'from_version')::integer;
    get diagnostics v_rows=row_count; if v_rows<>1 then raise exception 'erp_preferences_version_conflict' using errcode='40001'; end if;
   end if;
  else
   if(v_change->>'from_version')::integer=0 then
    insert into erp_preferences.user_value(key,user_id,value,version,updated_at,command_id) values(v_change->>'key',p_user_id,v_change->'after',1,v_at,p_command_id);
   else
    update erp_preferences.user_value set value=v_change->'after',version=version+1,updated_at=v_at,command_id=p_command_id
     where key=v_change->>'key' and user_id=p_user_id and version=(v_change->>'from_version')::integer;
    get diagnostics v_rows=row_count; if v_rows<>1 then raise exception 'erp_preferences_version_conflict' using errcode='40001'; end if;
   end if;
  end if;
  insert into erp_preferences.audit(command_id,actor,key,owner,from_version,to_version,before_value,after_value)
   values(p_command_id,p_user_id,v_change->>'key',v_owner,(v_change->>'from_version')::integer,(v_change->>'to_version')::integer,v_change->'before',v_change->'after');
 end loop;
 v_role:=erp_preferences.write_access(p_user_id,v_page);
 return v_result||jsonb_build_object('page',erp_preferences.page_dto(v_page,v_role,p_user_id),'replayed',false);
end $$;

-- The stored value and the default of the key keep valid (the new rule only widens the old one; no value is rewritten here).
do $$begin
 if exists(select 1 from erp_preferences.company_value c join erp_preferences.definition d on d.key=c.key where d.situation_kind is not null and not erp_preferences.value_valid(d,c.value))
  or exists(select 1 from erp_preferences.definition d where d.situation_kind is not null and not erp_preferences.value_valid(d,d.default_value)) then
  raise exception 'preferences_reserve_situations_299_value_invalid' using errcode='55000';end if;
end$$;

revoke all on function erp_preferences.value_valid(erp_preferences.definition,jsonb),erp_preferences.page_dto(erp_preferences.page,text,uuid),erp_preferences.page_situations(text)
 from public,anon,authenticated,service_role;
revoke all on function public.erp_preferences_save(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.erp_preferences_save(uuid,uuid,text,jsonb) to service_role;
commit;
