-- 302: Empresa › Alterar dados da empresa: com Tipo da Pessoa = Pessoa Física (Dados complementares, 151; produtor rural etc.), a
-- identidade da empresa aceita e confere o CPF no lugar do CNPJ (mesmo campo "cnpj" da identidade, que a NF-e nativa já lê como
-- documento do emitente: CPF em emit e 000+CPF na chave de acesso, frente de notas, 273). Com Pessoa Jurídica (ou sem dados
-- complementares) continua valendo só o CNPJ, numérico ou alfanumérico, como em 016.
-- * Um documento que não muda é mantido como está (CPF ou CNPJ), para que uma troca do Tipo da Pessoa nunca trave a edição do
--   endereço; a tela avisa a divergência e a NF-e recusa o emitente até a correção. Informar ou corrigir o documento segue o Tipo da
--   Pessoa e continua exigindo o "Motivo da correção" (189); trocar o documento retira a confirmação do regime, como antes.
-- * O comando já registrado responde o mesmo recibo antes de qualquer conferência (mesmo depois de uma troca do Tipo da Pessoa).
-- Substitui erp_company_save_identity (189), conferida pelo hash; outra versão interrompe a migração. erp_company.normalize (016)
-- não muda: erp_company.normalize_identity segue as mesmas regras e só troca a conferência do documento.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_company.cpf_valid(text)') is null or to_regclass('erp_company.extra') is null then
  raise exception 'company_identity_cpf_302_requires_151_189' using errcode='55000';end if;
 for r in select * from(values
  ('public.erp_company_save_identity(uuid,integer,uuid,jsonb,text)','6c58e9cc6290ee46c43cd3bb4e7b5418bf1bfdbe39f1da883c030736556aadca'),
  ('erp_company.normalize(jsonb)','7afbe7a83ad6b1f7b7c77686294d52bc66ca4bc63042877042acb61b775735b8'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,chr(13),''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'company_identity_cpf_302_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regprocedure('erp_company.normalize_identity(jsonb,text)') is not null then raise exception 'company_identity_cpf_302_already_applied' using errcode='55000';end if;
end$$;

-- The CPF of the company: 11 digits or 000.000.000-00, both check digits (erp_company.cpf_valid, 189).
create function erp_company.cpf(p_input text) returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text:=btrim(p_input);
begin
 if v is null or v!~'^([0-9]{11}|[0-9]{3}[.][0-9]{3}[.][0-9]{3}-[0-9]{2})$' then raise exception 'erp_company_cpf_invalid' using errcode='22023'; end if;
 v:=translate(v,'.-','');
 if not erp_company.cpf_valid(v) then raise exception 'erp_company_cpf_invalid' using errcode='22023'; end if;
 return v;
end $$;
-- The document of the identity: 'cpf', 'cnpj' or 'any' (a CPF when it has the form of one, else a CNPJ).
create function erp_company.document(p_input text,p_kind text) returns text language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_kind='cpf' or(p_kind='any' and btrim(p_input)~'^([0-9]{11}|[0-9]{3}[.][0-9]{3}[.][0-9]{3}-[0-9]{2})$') then return erp_company.cpf(p_input); end if;
 if p_kind not in('cnpj','any') then raise exception 'erp_company_data_invalid' using errcode='22023'; end if;
 return erp_company.cnpj(p_input);
end $$;
-- Tipo da Pessoa of the Dados complementares (151); without them, Pessoa Jurídica.
create function erp_company.person_type() returns text language sql stable set search_path=pg_catalog as $$
 select case when(select data->>'person_type' from erp_company.extra where singleton)='fisica' then 'fisica' else 'juridica' end
$$;
-- The rules of erp_company.normalize (016), with the document checked by p_document.
create function erp_company.normalize_identity(p_data jsonb,p_document text) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_fields jsonb:='{"legal_name":200,"trade_name":200,"cnpj":18,"ie":30,"postal_code":9,"street":200,"number":30,"complement":200,"district":100,"city":100,"municipality_code":7,"state":2,"phone":40,"email":254}';
 v_states jsonb:='{"RO":"11","AC":"12","AM":"13","RR":"14","PA":"15","AP":"16","TO":"17","MA":"21","PI":"22","CE":"23","RN":"24","PB":"25","PE":"26","AL":"27","SE":"28","BA":"29","MG":"31","ES":"32","RJ":"33","SP":"35","PR":"41","SC":"42","RS":"43","MS":"50","MT":"51","GO":"52","DF":"53"}';
 v jsonb:='{}';k text;t text;v_state text;
begin
 if p_data is null or jsonb_typeof(p_data)<>'object'or octet_length(p_data::text)>16384 or exists(select 1 from jsonb_object_keys(p_data)x where not v_fields?x)then raise exception 'erp_company_data_invalid'using errcode='22023';end if;
 for k in select jsonb_object_keys(v_fields)loop
  if p_data?k and p_data->k<>'null'::jsonb then
   if jsonb_typeof(p_data->k)<>'string'then raise exception 'erp_company_field_invalid'using errcode='22023';end if;
   t:=p_data->>k;if length(t)>(v_fields->>k)::integer or t ~ '[[:cntrl:]]'then raise exception 'erp_company_field_invalid'using errcode='22023';end if;t:=nullif(btrim(t),'');
  else t:=null;end if;
  if k=any(array['legal_name','cnpj','postal_code','street','number','district','city','municipality_code','state'])and t is null then raise exception 'erp_company_field_required'using errcode='22023';end if;
  v:=v||jsonb_build_object(k,t);
 end loop;
 -- 302: CPF for Pessoa Física, CNPJ for Pessoa Jurídica, either for a document kept as it is.
 v:=v||jsonb_build_object('cnpj',erp_company.document(v->>'cnpj',p_document));v_state:=upper(v->>'state');
 if not v_states?v_state then raise exception 'erp_company_state_invalid'using errcode='22023';end if;
 t:=v->>'postal_code';if t !~ '^[0-9]{5}-?[0-9]{3}$'or replace(t,'-','')='00000000'then raise exception 'erp_company_address_invalid'using errcode='22023';end if;
 v:=v||jsonb_build_object('state',v_state,'postal_code',replace(t,'-',''));
 if v->>'municipality_code'!~'^[0-9]{7}$'or left(v->>'municipality_code',2)<>v_states->>v_state then raise exception 'erp_company_address_invalid'using errcode='22023';end if;
 if v->>'email'is not null and v->>'email'!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'then raise exception 'erp_company_email_invalid'using errcode='22023';end if;
 if v->>'phone'is not null then t:=translate(v->>'phone',' ()-.','');if t!~'^\+?[0-9]{8,15}$'then raise exception 'erp_company_phone_invalid'using errcode='22023';end if;v:=v||jsonb_build_object('phone',t);end if;
 return v;
end $$;

-- ------------------------------------------------------------------------------------------------------------------------
-- Dados da empresa: Nome, Nome Fantasia e CNPJ/CPF são bloqueados como no Origin; corrigi-los exige motivo (3 a 1000 caracteres),
-- guardado na auditoria ("motivo") e mostrado no Registro de atividades. 302: o documento segue o Tipo da Pessoa.
create or replace function public.erp_company_save_identity(p_user_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_command erp_company.command%rowtype;v_row erp_company.identity%rowtype;v_data jsonb;v_before jsonb;v_result jsonb;v_fiscal jsonb;v_reason text;v_locked boolean;v_kind text;
begin
 perform erp_company.require_access(p_user_id,'identity');
 if p_expected_version is null or p_expected_version<0 or p_command_id is null then raise exception 'erp_company_command_invalid'using errcode='22023';end if;
 if p_reason is not null and(length(btrim(p_reason)) not between 3 and 1000 or p_reason~'[[:cntrl:]]') then raise exception 'erp_company_reason_invalid' using errcode='22023'; end if;
 v_reason:=nullif(btrim(p_reason),'');
 if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>16384 then raise exception 'erp_company_data_invalid'using errcode='22023';end if;
 v_hash:=encode(sha256(convert_to((jsonb_build_object('op','identity','actor',p_user_id,'version',p_expected_version,'data',p_data)
  ||case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason',v_reason) end)::text,'UTF8')),'hex');
 -- The same lock as the Dados complementares (151): the Tipo da Pessoa read below cannot change during the save.
 perform pg_advisory_xact_lock(174852920,1);
 select * into v_command from erp_company.command where command_id=p_command_id;
 if found then if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_company_command_conflict'using errcode='40001';end if;return v_command.result||'{"replayed":true}'::jsonb;end if;
 select * into v_row from erp_company.identity where singleton for update;
 -- 302: CPF with Pessoa Física, CNPJ otherwise; a document equal to the stored one is kept as it is.
 v_kind:=case when erp_company.person_type()='fisica' then 'cpf' else 'cnpj' end;
 if v_row.version is not null and jsonb_typeof(p_data->'cnpj')='string' and length(p_data->>'cnpj')<=18 then
  begin
   if erp_company.document(p_data->>'cnpj','any')=v_row.data->>'cnpj' then v_kind:='any'; end if;
  exception when sqlstate '22023' then null;
  end;
 end if;
 v_data:=erp_company.normalize_identity(p_data,v_kind);
 if coalesce(v_row.version,0)<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_company_version_conflict'using errcode='40001';end if;
 v_locked:=v_row.version is not null and(v_row.data->>'legal_name' is distinct from v_data->>'legal_name' or v_row.data->>'trade_name' is distinct from v_data->>'trade_name'
  or v_row.data->>'cnpj' is distinct from v_data->>'cnpj');
 if v_locked and v_reason is null then raise exception 'erp_company_reason_required' using errcode='22023'; end if;
 if not v_locked then v_reason:=null; end if;
 v_before:=erp_company.identity_dto();
 if v_row.version is null then
  insert into erp_company.identity(singleton,version,data,updated_by)values(true,1,v_data,p_user_id);
  insert into erp_company.fiscal(singleton,version)values(true,1);
 elsif v_row.data is distinct from v_data then
  v_fiscal:=erp_company.fiscal_dto();
  update erp_company.identity set data=v_data,version=version+1,updated_at=clock_timestamp(),updated_by=p_user_id where singleton;
  if v_row.data->>'cnpj'<>v_data->>'cnpj'then
   if(v_fiscal->>'version')::integer=2147483647 then raise exception 'erp_company_version_conflict'using errcode='40001';end if;
   update erp_company.fiscal set crt=null,confirmed_at=null,confirmed_by=null,reason=null,version=version+1,updated_at=clock_timestamp()where singleton;
   insert into erp_company.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'fiscal_reset_identity_changed',v_fiscal,erp_company.fiscal_dto());
  end if;
 end if;
 v_result:=jsonb_build_object('section','identity','record',erp_company.identity_dto(),'replayed',false,'data_mode','erp_native','emission_enabled',false);
 if v_before is distinct from v_result->'record'then insert into erp_company.audit(actor,command_id,action,before_data,after_data)
  values(p_user_id,p_command_id,'save_identity',v_before,(v_result->'record')||case when v_reason is null then '{}'::jsonb else jsonb_build_object('motivo',v_reason) end);end if;
 insert into erp_company.command values(p_command_id,p_user_id,v_hash,v_result,clock_timestamp());return v_result;
end $$;

revoke all on function erp_company.cpf(text),erp_company.document(text,text),erp_company.person_type(),erp_company.normalize_identity(jsonb,text) from public,anon,authenticated,service_role;
revoke all on function public.erp_company_save_identity(uuid,integer,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_company_save_identity(uuid,integer,uuid,jsonb,text) to service_role;
commit;
