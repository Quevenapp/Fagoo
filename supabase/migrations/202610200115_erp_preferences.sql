-- Preferências no padrão do Origin: páginas de Empresa, Sistema, Cadastros, Suprimentos, Vendas, Notas Fiscais, Finanças,
-- Serviços e Contabilidade. Cada página tem no servidor o catálogo das suas chaves (tipo, opções, limites e padrão); o valor
-- de cada chave é versionado (CAS por chave), muda só por comando idempotente (command_id) e cada mudança fica auditada.
-- Escopo "company": lido pelos perfis do módulo, alterado só pelo administrador. Escopo "user": cada usuário guarda o seu.
-- Esta migração apenas guarda as preferências. Nenhuma regra existente de documentos, estoque, financeiro, cobrança ou fiscal
-- passa a ler estes valores aqui; as próximas ondas leem com erp_preferences.get(chave) na mesma transação.
-- As definições são geradas de packages/erp-domain/src/preferences (um arquivo por página) por
-- tools/preferences/generate-definitions.mjs; o teste PGlite confere a paridade.
begin;

create schema erp_preferences;
revoke all on schema erp_preferences from public,anon,authenticated,service_role;

create table erp_preferences.page(
 id text primary key check(id~'^[a-z][a-z0-9-]{1,47}$'),
 category text not null check(category~'^[a-z][a-z0-9-]{1,39}$'),
 ordinal integer not null unique check(ordinal>0),
 scope text not null check(scope in('company','user')),
 read_roles text[] not null check(cardinality(read_roles) between 1 and 6 and array_position(read_roles,null) is null
  and read_roles<@array['admin','consulta','vendas','financeiro','estoque','fiscal']::text[])
);
create table erp_preferences.definition(
 key text primary key check(length(key)<=80 and key~'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
 page_id text not null references erp_preferences.page(id),
 section text not null check(section~'^[a-z][a-z0-9-]{0,39}$'),
 ordinal integer not null check(ordinal>0),
 kind text not null check(kind in('toggle','choice','multi','integer','decimal','text','textarea','users','keymap','documents')),
 options jsonb,
 default_value jsonb not null,
 min_value integer,max_value integer,
 scale integer check(scale between 1 and 6),
 max_length integer check(max_length between 1 and 4000),
 max_items integer check(max_items between 1 and 500),
 format text check(format in('plain','email','email_list')),
 unique(page_id,ordinal),
 check(case kind when 'choice' then jsonb_typeof(options)='array' and jsonb_array_length(options)>0
  when 'multi' then jsonb_typeof(options)='array' and jsonb_array_length(options)>0
  when 'keymap' then jsonb_typeof(options)='object' and jsonb_typeof(options->'actions')='array' and jsonb_typeof(options->'keys')='array'
  else options is null end),
 check((kind in('integer','decimal'))=(min_value is not null and max_value is not null) and (min_value is null or min_value<=max_value)),
 check((kind='decimal')=(scale is not null)),
 check((kind in('text','textarea'))=(max_length is not null)),
 check((kind='text')=(format is not null)),
 check((kind in('multi','users','documents') or format='email_list')=(max_items is not null))
);

-- One row per accepted command; it is also the receipt returned to "Conferir resultado".
create table erp_preferences.command(
 id uuid primary key,
 actor uuid not null references auth.users(id),
 page_id text not null references erp_preferences.page(id),
 owner uuid references auth.users(id),
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),
 created_at timestamptz not null default clock_timestamp(),
 check(owner is null or owner=actor)
);
create table erp_preferences.company_value(
 key text primary key references erp_preferences.definition(key),
 value jsonb not null,
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id),
 command_id uuid not null references erp_preferences.command(id)
);
create table erp_preferences.user_value(
 key text not null references erp_preferences.definition(key),
 user_id uuid not null references auth.users(id),
 value jsonb not null,
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null,
 command_id uuid not null references erp_preferences.command(id),
 primary key(key,user_id)
);
create table erp_preferences.audit(
 id bigint generated always as identity primary key,
 command_id uuid not null references erp_preferences.command(id),
 actor uuid not null references auth.users(id),
 key text not null references erp_preferences.definition(key),
 owner uuid references auth.users(id),
 from_version integer not null check(from_version between 0 and 2147483646),
 to_version integer not null check(to_version=from_version+1),
 before_value jsonb not null,
 after_value jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(command_id,key)
);
create index erp_preferences_audit_key on erp_preferences.audit(key,created_at);

do $$declare t text;begin foreach t in array array['page','definition','command','company_value','user_value','audit'] loop
 execute format('alter table erp_preferences.%I enable row level security',t);
 execute format('revoke all on erp_preferences.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on all sequences in schema erp_preferences from public,anon,authenticated,service_role;
alter default privileges in schema erp_preferences revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_preferences revoke all on functions from public,anon,authenticated,service_role;

create function erp_preferences.immutable_history() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_preferences_history_immutable' using errcode='42501'; end $$;
create trigger immutable_command before update or delete on erp_preferences.command for each row execute function erp_preferences.immutable_history();
create trigger immutable_audit before update or delete on erp_preferences.audit for each row execute function erp_preferences.immutable_history();
-- A value changes only one version at a time, through a command of the same page (and owner, for user values).
create function erp_preferences.check_change(p_op text,p_key text,p_old_key text,p_version integer,p_old_version integer,p_command uuid,p_old_command uuid,p_owner uuid)
returns void language plpgsql set search_path=pg_catalog as $$
begin
 if p_op='DELETE' or p_op='UPDATE' and(p_key<>p_old_key or p_version<>p_old_version+1 or p_command=p_old_command) or p_op='INSERT' and p_version<>1
  or not exists(select 1 from erp_preferences.command c join erp_preferences.definition d on d.page_id=c.page_id
   where c.id=p_command and d.key=p_key and c.owner is not distinct from p_owner) then
  raise exception 'erp_preferences_value_immutable' using errcode='42501'; end if;
end $$;
create function erp_preferences.guard_company_value() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'erp_preferences_value_immutable' using errcode='42501'; end if;
 perform erp_preferences.check_change(tg_op,new.key,case when tg_op='UPDATE' then old.key end,new.version,case when tg_op='UPDATE' then old.version end,
  new.command_id,case when tg_op='UPDATE' then old.command_id end,null);
 return new;
end $$;
create function erp_preferences.guard_user_value() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' or tg_op='UPDATE' and new.user_id<>old.user_id then raise exception 'erp_preferences_value_immutable' using errcode='42501'; end if;
 perform erp_preferences.check_change(tg_op,new.key,case when tg_op='UPDATE' then old.key end,new.version,case when tg_op='UPDATE' then old.version end,
  new.command_id,case when tg_op='UPDATE' then old.command_id end,new.user_id);
 return new;
end $$;
create trigger guard_company_value before insert or update or delete on erp_preferences.company_value for each row execute function erp_preferences.guard_company_value();
create trigger guard_user_value before insert or update or delete on erp_preferences.user_value for each row execute function erp_preferences.guard_user_value();

-- Mirror of preferenceValueValid in packages/erp-domain/src/preferences/core.mjs. Membership of user ids is checked at save.
create function erp_preferences.value_valid(d erp_preferences.definition,v jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare e jsonb; s text; t text; seen text[]:='{}'; prev text;
begin
 if d.key is null or v is null then return false; end if;
 case d.kind
 when 'toggle' then return jsonb_typeof(v)='boolean';
 when 'choice' then return jsonb_typeof(v)='string' and d.options?(v#>>'{}');
 when 'multi' then
  if jsonb_typeof(v)<>'array' or jsonb_array_length(v)>d.max_items then return false; end if;
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

-- BEGIN GENERATED DEFINITIONS (tools/preferences/generate-definitions.mjs)
insert into erp_preferences.page(id,category,ordinal,scope,read_roles)values
 ('empresa-geral','empresa',1,'company',array['admin','consulta','vendas','financeiro','estoque','fiscal']::text[]),
 ('sistema-interface','sistema',2,'user',array['admin','consulta','vendas','financeiro','estoque','fiscal']::text[]),
 ('cadastros-contatos','cadastros',3,'company',array['admin','consulta','vendas','financeiro','estoque','fiscal']::text[]),
 ('cadastros-lotes','cadastros',4,'company',array['admin','consulta','vendas','estoque','fiscal']::text[]),
 ('cadastros-produtos','cadastros',5,'company',array['admin','consulta','vendas','estoque','fiscal']::text[]),
 ('suprimentos-estoque','suprimentos',6,'company',array['admin','consulta','vendas','estoque','fiscal']::text[]),
 ('suprimentos-compras','suprimentos',7,'company',array['admin','consulta','financeiro','estoque','fiscal']::text[]),
 ('vendas-frente-caixa','vendas',8,'company',array['admin','consulta','vendas']::text[]),
 ('vendas-propostas','vendas',9,'company',array['admin','consulta','financeiro','vendas']::text[]),
 ('vendas-vendas','vendas',10,'company',array['admin','consulta','vendas','financeiro','estoque','fiscal']::text[]),
 ('notas-nfce','notas-fiscais',11,'company',array['admin','consulta','fiscal']::text[]),
 ('notas-nfe','notas-fiscais',12,'company',array['admin','consulta','fiscal']::text[]),
 ('financas-pagar','financas',13,'company',array['admin','consulta','financeiro']::text[]),
 ('financas-receber','financas',14,'company',array['admin','consulta','financeiro']::text[]),
 ('servicos-os','servicos',15,'company',array['admin','consulta','financeiro','vendas']::text[]),
 ('contabilidade-contador','contabilidade',16,'company',array['admin','financeiro','fiscal']::text[]);
insert into erp_preferences.definition(key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format)values
 ('empresa.decimais_quantidade','empresa-geral','geral',1,'integer',null,'6'::jsonb,0,10,null,null,null,null),
 ('empresa.decimais_preco_entrada','empresa-geral','geral',2,'integer',null,'10'::jsonb,0,10,null,null,null,null),
 ('empresa.decimais_preco_saida','empresa-geral','geral',3,'integer',null,'10'::jsonb,0,10,null,null,null,null),
 ('empresa.decimais_peso','empresa-geral','geral',4,'integer',null,'3'::jsonb,0,5,null,null,null,null),
 ('empresa.nao_enviar_link','empresa-geral','geral',5,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('empresa.editar_data_ocorrencia','empresa-geral','geral',6,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('sistema.tema_escuro','sistema-interface','interface',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('contatos.acesso_vendedor','cadastros-contatos','contatos',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('contatos.permite_documento_duplicado','cadastros-contatos','contatos',2,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('contatos.codigo','cadastros-contatos','contatos',3,'choice','["manual","sequencial"]'::jsonb,'"manual"'::jsonb,null,null,null,null,null,null),
 ('contatos.campos_obrigatorios','cadastros-contatos','contatos',4,'multi','["carga_media","bairro","bairro_cobranca","celular","cep","cep_cobranca","cidade","cidade_cobranca","cliente_desde","cnpj","complemento","complemento_cobranca","condicao_pagamento","informacoes_contato","cpf_mae","cpf_pai","data_nascimento","email","email_nfe","endereco","endereco_cobranca","numero","numero_cobranca","fantasia","fax","fone","natureza_operacao","inscricao_estadual","inscricao_municipal","inscricao_suframa","limite_credito","naturalidade","nome_mae","nome_pai","pais","observacoes","orgao_emissor","profissao","proxima_visita","rg","website","skype","uf_exterior_cobranca","uf_exterior"]'::jsonb,'[]'::jsonb,null,null,null,null,44,null),
 ('lotes.validade_obrigatoria','cadastros-lotes','lotes',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('lotes.fabricacao_obrigatoria','cadastros-lotes','lotes',2,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('lotes.dias_aviso_validade','cadastros-lotes','lotes',3,'integer',null,'0'::jsonb,0,9999,null,null,null,null),
 ('produtos.codigo','cadastros-produtos','geral',1,'choice','["manual","sequencial","sequencial_ean"]'::jsonb,'"manual"'::jsonb,null,null,null,null,null,null),
 ('produtos.pular_etapas','cadastros-produtos','geral',2,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('produtos.cadastro_auto_compras','cadastros-produtos','geral',3,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.cadastro_auto_vendas','cadastros-produtos','geral',4,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.cadastro_auto_os','cadastros-produtos','geral',5,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.origem_padrao','cadastros-produtos','geral',6,'choice','["0","1","2","3","4","5","6","7","8"]'::jsonb,'"0"'::jsonb,null,null,null,null,null,null),
 ('produtos.estoque_relatorio_preco','cadastros-produtos','geral',7,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.composicao_custo','cadastros-produtos','geral',8,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.composicao_peso','cadastros-produtos','geral',9,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.composicao_preco','cadastros-produtos','geral',10,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.localizacao_recibo','cadastros-produtos','localizacao',11,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.localizacao_relatorio_producao','cadastros-produtos','localizacao',12,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.localizacao_tela_produtos','cadastros-produtos','localizacao',13,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.localizacao_relatorios_estoque','cadastros-produtos','localizacao',14,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.localizacao_relatorio_venda','cadastros-produtos','localizacao',15,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.localizacao_controle_estoque','cadastros-produtos','localizacao',16,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('produtos.dias_aviso_validade','cadastros-produtos','notificacoes',17,'integer',null,'0'::jsonb,0,9999,null,null,null,null),
 ('estoque.exibir_preco_unitario','suprimentos-estoque','estoque',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('estoque.tipo_preco_entrada','suprimentos-estoque','estoque',2,'choice','["ultima_compra","compra_fornecedor","custo_fornecedor"]'::jsonb,'"ultima_compra"'::jsonb,null,null,null,null,null,null),
 ('estoque.considerar_balancos','suprimentos-estoque','estoque',3,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('estoque.nf_estoque_negativo','suprimentos-estoque','estoque',4,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('estoque.data_lancamento','suprimentos-estoque','estoque',5,'choice','["data_atual","data_documento"]'::jsonb,'"data_atual"'::jsonb,null,null,null,null,null,null),
 ('estoque.custo_medio_base','suprimentos-estoque','estoque',6,'choice','["preco_compra","custo_lancamento"]'::jsonb,'"preco_compra"'::jsonb,null,null,null,null,null,null),
 ('estoque.cross_docking_dias','suprimentos-estoque','estoque',7,'integer',null,'0'::jsonb,0,9999,null,null,null,null),
 ('estoque.estorno_balanco','suprimentos-estoque','estoque',8,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('estoque.reserva_por_situacao','suprimentos-estoque','reserva',9,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('estoque.reserva_situacoes','suprimentos-estoque','reserva',10,'multi','["em_aberto","atendido","cancelado","em_andamento","venda_agenciada","em_digitacao","verificado","checkout_parcial"]'::jsonb,'[]'::jsonb,null,null,null,null,8,null),
 ('estoque.reserva_por_deposito','suprimentos-estoque','reserva',11,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('compras.editar_numero','suprimentos-compras','preenchimento',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('compras.preco_padrao','suprimentos-compras','preenchimento',2,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('compras.preco_padrao_tipo','suprimentos-compras','preenchimento',3,'choice','["custo","compra"]'::jsonb,'"custo"'::jsonb,null,null,null,null,null,null),
 ('compras.somar_peso_bruto','suprimentos-compras','preenchimento',4,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('compras.ver_contas_pagar','suprimentos-compras','preenchimento',5,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('compras.data_parcelas','suprimentos-compras','preenchimento',6,'choice','["data_compra","data_prevista"]'::jsonb,'"data_compra"'::jsonb,null,null,null,null,null,null),
 ('compras.observacao_padrao','suprimentos-compras','preenchimento',7,'textarea',null,'""'::jsonb,null,null,null,2000,null,null),
 ('compras.email_assunto','suprimentos-compras','email',8,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('compras.email_copia','suprimentos-compras','email',9,'text',null,'""'::jsonb,null,null,null,100,5,'email_list'),
 ('compras.email_remetente','suprimentos-compras','email',10,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('compras.email_resposta','suprimentos-compras','email',11,'text',null,'""'::jsonb,null,null,null,120,null,'email'),
 ('compras.email_mensagem','suprimentos-compras','email',12,'textarea',null,'""'::jsonb,null,null,null,4000,null,null),
 ('compras.codigo_secundario','suprimentos-compras','impressao',13,'choice','["nenhum","codigo_fornecedor","gtin","gtin_tributario"]'::jsonb,'"nenhum"'::jsonb,null,null,null,null,null,null),
 ('compras.rotulo_titulo','suprimentos-compras','impressao',14,'text',null,'""'::jsonb,null,null,null,60,null,'plain'),
 ('compras.tipo_cabecalho','suprimentos-compras','impressao',15,'choice','["padrao","personalizado"]'::jsonb,'"padrao"'::jsonb,null,null,null,null,null,null),
 ('compras.imprimir_descricao_complementar','suprimentos-compras','impressao',16,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('compras.imprimir_ipi','suprimentos-compras','impressao',17,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('compras.imprimir_vencimento_parcelas','suprimentos-compras','impressao',18,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('compras.imprimir_localizacao','suprimentos-compras','impressao',19,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('compras.automacao_contas_pagar','suprimentos-compras','impressao',20,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('compras.clonagem_data','suprimentos-compras','clonagem',21,'choice','["data_atual","data_original"]'::jsonb,'"data_atual"'::jsonb,null,null,null,null,null,null),
 ('pdv.controle_mesas','vendas-frente-caixa','gerais',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('pdv.controle_caixa','vendas-frente-caixa','gerais',2,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('pdv.dinheiro_cheque','vendas-frente-caixa','gerais',3,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('pdv.usuarios_caixa_unico','vendas-frente-caixa','gerais',4,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('pdv.operacao_padrao','vendas-frente-caixa','gerais',5,'choice','["nenhum","gerar_nfce","comprovante","pre_venda","nfe_simplificada"]'::jsonb,'"nenhum"'::jsonb,null,null,null,null,null,null),
 ('pdv.metodo_pagamento','vendas-frente-caixa','gerais',6,'choice','["nenhum","pix_qrcode_impresso"]'::jsonb,'"nenhum"'::jsonb,null,null,null,null,null,null),
 ('pdv.ordem_comprovante','vendas-frente-caixa','gerais',7,'choice','["alfabetica","insercao"]'::jsonb,'"insercao"'::jsonb,null,null,null,null,null,null),
 ('pdv.desconto_percentual','vendas-frente-caixa','gerais',8,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('pdv.situacoes_fechamento','vendas-frente-caixa','gerais',9,'multi','["atendido","verificado"]'::jsonb,'["atendido","verificado"]'::jsonb,null,null,null,null,2,null),
 ('pdv.estoque_negativo','vendas-frente-caixa','gerais',10,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('pdv.bloquear_quantidade_zero','vendas-frente-caixa','gerais',11,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('pdv.desconto_item','vendas-frente-caixa','item',12,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('pdv.agrupar_itens','vendas-frente-caixa','item',13,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('pdv.teclas_atalho','vendas-frente-caixa','atalhos',14,'keymap','{"actions":["cliente","pagamento","produto","pesquisa","buscar","excluir","fechar","finalizar","imprimir","nova","favoritos","remover-gtin","sangria","suprimento","trocar-loja","balcao","mesa"],"keys":["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z",",","."]}'::jsonb,'{"cliente":"C","pagamento":"B","produto":"Z","pesquisa":"A","buscar":"P","excluir":"Q","fechar":"M","finalizar":"S","imprimir":"I","nova":"N","favoritos":"G","remover-gtin":"R","sangria":",","suprimento":".","trocar-loja":"L","balcao":"T","mesa":"V"}'::jsonb,null,null,null,null,null,null),
 ('propostas.editar_numero','vendas-propostas','configuracoes',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.exibir_ipi_st','vendas-propostas','configuracoes',2,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.observacao_padrao','vendas-propostas','configuracoes',3,'textarea',null,'""'::jsonb,null,null,null,2000,null,null),
 ('propostas.exibir_transportadora','vendas-propostas','configuracoes',4,'choice','["sim","nao"]'::jsonb,'"sim"'::jsonb,null,null,null,null,null,null),
 ('propostas.somar_peso_bruto','vendas-propostas','configuracoes',5,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.exibir_totais','vendas-propostas','configuracoes',6,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('propostas.proximo_contato_obrigatorio','vendas-propostas','configuracoes',7,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.bloquear_limite_credito','vendas-propostas','configuracoes',8,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.vendedor_obrigatorio','vendas-propostas','configuracoes',9,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.data_prevista_prazo','vendas-propostas','configuracoes',10,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.imprimir_descricao_complementar','vendas-propostas','impressao',11,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('propostas.imprimir_quantidades','vendas-propostas','impressao',12,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('propostas.imprimir_valores','vendas-propostas','impressao',13,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('propostas.enviar_descricao_venda','vendas-propostas','impressao',14,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('propostas.imprimir_ncm','vendas-propostas','impressao',15,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.imprimir_desconto_lista','vendas-propostas','impressao',16,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.imprimir_totais','vendas-propostas','impressao',17,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('propostas.imprimir_aprovacao','vendas-propostas','impressao',18,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.imprimir_imagem','vendas-propostas','impressao',19,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.imprimir_numero_item','vendas-propostas','impressao',20,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.imprimir_vencimento_parcelas','vendas-propostas','impressao',21,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('propostas.tipo_cabecalho','vendas-propostas','impressao',22,'choice','["padrao","personalizado"]'::jsonb,'"padrao"'::jsonb,null,null,null,null,null,null),
 ('propostas.email_assunto','vendas-propostas','email',23,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('propostas.email_copia','vendas-propostas','email',24,'text',null,'""'::jsonb,null,null,null,100,5,'email_list'),
 ('propostas.email_remetente','vendas-propostas','email',25,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('propostas.email_resposta','vendas-propostas','email',26,'text',null,'""'::jsonb,null,null,null,120,null,'email'),
 ('propostas.email_mensagem','vendas-propostas','email',27,'textarea',null,'""'::jsonb,null,null,null,4000,null,null),
 ('vendas.vendedor_obrigatorio','vendas-vendas','configuracoes',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.observacao_padrao','vendas-vendas','configuracoes',2,'textarea',null,'""'::jsonb,null,null,null,2000,null,null),
 ('vendas.exibir_detalhes','vendas-vendas','configuracoes',3,'choice','["sim","opcional","nao"]'::jsonb,'"sim"'::jsonb,null,null,null,null,null,null),
 ('vendas.exibir_dados_adicionais','vendas-vendas','configuracoes',4,'choice','["sim","opcional","nao"]'::jsonb,'"sim"'::jsonb,null,null,null,null,null,null),
 ('vendas.exibir_transportadora','vendas-vendas','configuracoes',5,'choice','["sim","opcional","nao"]'::jsonb,'"sim"'::jsonb,null,null,null,null,null,null),
 ('vendas.data_parcelas','vendas-vendas','configuracoes',6,'choice','["data_venda","data_saida","data_prevista"]'::jsonb,'"data_venda"'::jsonb,null,null,null,null,null,null),
 ('vendas.ver_contas_receber','vendas-vendas','configuracoes',7,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.produtos_nao_cadastrados','vendas-vendas','configuracoes',8,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('vendas.desmembrar_fisico','vendas-vendas','configuracoes',9,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.desmembrar_virtual','vendas-vendas','configuracoes',10,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.editar_numero','vendas-vendas','configuracoes',11,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.exibir_totais','vendas-vendas','configuracoes',12,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('vendas.exibir_totais_usuarios','vendas-vendas','configuracoes',13,'users',null,'[]'::jsonb,null,null,null,null,100,null),
 ('vendas.somar_peso_bruto','vendas-vendas','configuracoes',14,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.gerar_nfe','vendas-vendas','configuracoes',15,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.frete_primeira_parcela','vendas-vendas','configuracoes',16,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.estoque_negativo','vendas-vendas','configuracoes',17,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.base_comissao','vendas-vendas','configuracoes',18,'multi','["desconto","frete","icms_st","ipi","taxas_pagamento"]'::jsonb,'[]'::jsonb,null,null,null,null,5,null),
 ('vendas.checkout_ordenar','vendas-vendas','checkout',19,'choice','["crescente","nao_ordenar"]'::jsonb,'"nao_ordenar"'::jsonb,null,null,null,null,null,null),
 ('vendas.checkout_desmembrar','vendas-vendas','checkout',20,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.checkout_picking','vendas-vendas','checkout',21,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.checkout_salvar_auto','vendas-vendas','checkout',22,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.checkout_quantidade','vendas-vendas','checkout',23,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.numero_documento_conta','vendas-vendas','contas-receber',24,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.contas_automaticas_pedido','vendas-vendas','contas-receber',25,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.contas_automaticas_nota','vendas-vendas','contas-receber',26,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.email_assunto','vendas-vendas','email',27,'text',null,'""'::jsonb,null,null,null,50,null,'plain'),
 ('vendas.email_copia','vendas-vendas','email',28,'text',null,'""'::jsonb,null,null,null,100,5,'email_list'),
 ('vendas.email_remetente','vendas-vendas','email',29,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('vendas.email_resposta','vendas-vendas','email',30,'text',null,'""'::jsonb,null,null,null,120,null,'email'),
 ('vendas.email_mensagem','vendas-vendas','email',31,'textarea',null,'""'::jsonb,null,null,null,4000,null,null),
 ('vendas.imprimir_codigo','vendas-vendas','impressao',32,'choice','["codigo","gtin","gtin_tributario"]'::jsonb,'"codigo"'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_ordem','vendas-vendas','impressao',33,'choice','["insercao","alfabetica","localizacao","codigo"]'::jsonb,'"insercao"'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_titulo','vendas-vendas','impressao',34,'multi','["numero_pedido"]'::jsonb,'["numero_pedido"]'::jsonb,null,null,null,null,2,null),
 ('vendas.imprimir_secao_auxiliar','vendas-vendas','impressao',35,'multi','["ordem_compra"]'::jsonb,'[]'::jsonb,null,null,null,null,1,null),
 ('vendas.tipo_cabecalho','vendas-vendas','impressao',36,'choice','["padrao","personalizado"]'::jsonb,'"padrao"'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_codigo_barras','vendas-vendas','impressao',37,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_descricao_complementar','vendas-vendas','impressao',38,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_localizacao','vendas-vendas','impressao',39,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_rodape','vendas-vendas','impressao',40,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_descricao_fornecedor','vendas-vendas','impressao',41,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_codigo_barras_titulo','vendas-vendas','impressao',42,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_ncm','vendas-vendas','impressao',43,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_imagem','vendas-vendas','impressao',44,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_codigo_cliente','vendas-vendas','impressao',45,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_soma_quantidades','vendas-vendas','impressao',46,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_endereco_alternativo','vendas-vendas','impressao',47,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_numero_item','vendas-vendas','impressao',48,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_desconto_lista','vendas-vendas','impressao',49,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.imprimir_colunas_pecas','vendas-vendas','impressao',50,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.comprovante_limitar_descricao','vendas-vendas','comprovante',51,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.comprovante_codigo','vendas-vendas','comprovante',52,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.comprovante_observacao','vendas-vendas','comprovante',53,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.comprovante_comentario','vendas-vendas','comprovante',54,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.comprovante_desconto','vendas-vendas','comprovante',55,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.comprovante_rodape','vendas-vendas','comprovante',56,'textarea',null,'""'::jsonb,null,null,null,500,null,null),
 ('vendas.comprovante_fonte','vendas-vendas','comprovante',57,'integer',null,'12'::jsonb,6,72,null,null,null,null),
 ('vendas.producao_numero_item','vendas-vendas','relatorio-producao',58,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.producao_endereco_transportadora','vendas-vendas','relatorio-producao',59,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.producao_estrutura','vendas-vendas','relatorio-producao',60,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.producao_dados_cliente','vendas-vendas','relatorio-producao',61,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('vendas.producao_descricao_complementar','vendas-vendas','relatorio-producao',62,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfce.lancar_contas','notas-nfce','emissao',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfce.lancar_estoque','notas-nfce','emissao',2,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfce.grupo_combustiveis','notas-nfce','preenchimento',3,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfce.grupo_armamento','notas-nfce','preenchimento',4,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfce.grupo_veiculos','notas-nfce','preenchimento',5,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfce.grupo_bebidas','notas-nfce','preenchimento',6,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfce.autxml_transportadora','notas-nfce','preenchimento',7,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfce.autxml_pessoas','notas-nfce','preenchimento',8,'documents',null,'[]'::jsonb,null,null,null,null,10,null),
 ('nfe.exibir_totais','notas-nfe','gerais',1,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('nfe.lancar_estoque','notas-nfe','gerais',2,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.lancar_contas','notas-nfe','gerais',3,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.marcar_envio_email','notas-nfe','gerais',4,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.data_venda_parcelas','notas-nfe','gerais',5,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.data_os_parcelas','notas-nfe','gerais',6,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.emitir_lote','notas-nfe','gerais',7,'choice','["nao_emitir","emitir_todas"]'::jsonb,'"nao_emitir"'::jsonb,null,null,null,null,null,null),
 ('nfe.email_automatico','notas-nfe','gerais',8,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.consulta_automatica','notas-nfe','gerais',9,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.bloquear_edicao_estoque','notas-nfe','gerais',10,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.bloquear_edicao_contas','notas-nfe','gerais',11,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.contas_pagar_entrada','notas-nfe','gerais',12,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.estoque_checkin','notas-nfe','gerais',13,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.frete_por_conta','notas-nfe','preenchimento',14,'choice','["0","1","2","3","4","9"]'::jsonb,'"9"'::jsonb,null,null,null,null,null,null),
 ('nfe.markup','notas-nfe','preenchimento',15,'decimal',null,'"0"'::jsonb,0,99999,2,null,null,null),
 ('nfe.volume_padrao','notas-nfe','preenchimento',16,'integer',null,'0'::jsonb,0,99999,null,null,null,null),
 ('nfe.especie_padrao','notas-nfe','preenchimento',17,'choice','["outros","volumes","unidades","caixas","pacotes","envelopes"]'::jsonb,'"volumes"'::jsonb,null,null,null,null,null,null),
 ('nfe.ipi_primeira_parcela','notas-nfe','preenchimento',18,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.st_primeira_parcela','notas-nfe','preenchimento',19,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.base_comissao_total','notas-nfe','preenchimento',20,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.rastreio_infcpl','notas-nfe','preenchimento',21,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.somar_peso','notas-nfe','preenchimento',22,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.calcular_volume','notas-nfe','preenchimento',23,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.desconto_itens','notas-nfe','preenchimento',24,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('nfe.ordem_compra_infcpl','notas-nfe','preenchimento',25,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.grupo_combustiveis','notas-nfe','preenchimento',26,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.grupo_armamento','notas-nfe','preenchimento',27,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.grupo_veiculos','notas-nfe','preenchimento',28,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.grupo_bebidas','notas-nfe','preenchimento',29,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.grupo_retencao','notas-nfe','preenchimento',30,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.destino_manual','notas-nfe','preenchimento',31,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.mensagem_credito_simples','notas-nfe','preenchimento',32,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.validacao_opcional','notas-nfe','preenchimento',33,'multi','["parcelas"]'::jsonb,'[]'::jsonb,null,null,null,null,1,null),
 ('nfe.atualizar_ncm','notas-nfe','preenchimento',34,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.atualizar_gtin','notas-nfe','preenchimento',35,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.atualizar_cest','notas-nfe','preenchimento',36,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.atualizar_descricao_fornecedor','notas-nfe','preenchimento',37,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.autxml_transportadora','notas-nfe','preenchimento',38,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.autxml_pessoas','notas-nfe','preenchimento',39,'documents',null,'[]'::jsonb,null,null,null,null,10,null),
 ('nfe.itens_primeira_pagina','notas-nfe','impressao',40,'integer',null,'0'::jsonb,0,999,null,null,null,null),
 ('nfe.itens_demais_paginas','notas-nfe','impressao',41,'integer',null,'0'::jsonb,0,999,null,null,null,null),
 ('nfe.danfe_simplificado_produtos','notas-nfe','impressao',42,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.danfe_simplificado_total','notas-nfe','impressao',43,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.email_transportadora','notas-nfe','email',44,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.email_boleto','notas-nfe','email',45,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('nfe.email_assunto','notas-nfe','email',46,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('nfe.email_copia','notas-nfe','email',47,'text',null,'""'::jsonb,null,null,null,100,5,'email_list'),
 ('nfe.email_remetente','notas-nfe','email',48,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('nfe.email_resposta','notas-nfe','email',49,'text',null,'""'::jsonb,null,null,null,120,null,'email'),
 ('nfe.email_mensagem','notas-nfe','email',50,'textarea',null,'""'::jsonb,null,null,null,4000,null,null),
 ('financas.pagar_cabecalho_recibo','financas-pagar','contas-pagar',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('financas.pagar_aviso_vencimento','financas-pagar','contas-pagar',2,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('financas.pagar_aviso_antes','financas-pagar','contas-pagar',3,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('financas.comissoes_contas_pagar','financas-pagar','contas-pagar',4,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('financas.pagar_dias_aviso','financas-pagar','contas-pagar',5,'integer',null,'0'::jsonb,0,365,null,null,null,null),
 ('financas.pagar_email_aviso','financas-pagar','contas-pagar',6,'text',null,'""'::jsonb,null,null,null,120,null,'email'),
 ('financas.receber_data_baixa','financas-receber','geral',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('financas.receber_cabecalho_recibo','financas-receber','geral',2,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('financas.receber_titulo_credito','financas-receber','geral',3,'choice','["duplicata","nota_promissoria","ambos"]'::jsonb,'"duplicata"'::jsonb,null,null,null,null,null,null),
 ('financas.boletos_vinculo','financas-receber','boletos',4,'choice','["formas_pagamento","contas_financeiras"]'::jsonb,'"formas_pagamento"'::jsonb,null,null,null,null,null,null),
 ('financas.boletos_dias_antes','financas-receber','boletos',5,'integer',null,'0'::jsonb,0,365,null,null,null,null),
 ('financas.boletos_dias_apos','financas-receber','boletos',6,'integer',null,'0'::jsonb,0,365,null,null,null,null),
 ('financas.boletos_no_vencimento','financas-receber','boletos',7,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('financas.cobranca_email_copia','financas-receber','cobrancas',8,'text',null,'""'::jsonb,null,null,null,100,5,'email_list'),
 ('financas.cobranca_remetente','financas-receber','cobrancas',9,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('financas.cobranca_email_resposta','financas-receber','cobrancas',10,'text',null,'""'::jsonb,null,null,null,120,null,'email'),
 ('financas.cobranca_email_contato','financas-receber','cobrancas',11,'choice','["principal","nfe","nfe_ou_principal"]'::jsonb,'"principal"'::jsonb,null,null,null,null,null,null),
 ('financas.cobranca_boleto_assunto','financas-receber','cobrancas',12,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('financas.cobranca_boleto_mensagem','financas-receber','cobrancas',13,'textarea',null,'""'::jsonb,null,null,null,4000,null,null),
 ('financas.carta_assunto','financas-receber','carta',14,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('financas.carta_email_copia','financas-receber','carta',15,'text',null,'""'::jsonb,null,null,null,100,5,'email_list'),
 ('financas.carta_remetente','financas-receber','carta',16,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('financas.carta_email_resposta','financas-receber','carta',17,'text',null,'""'::jsonb,null,null,null,120,null,'email'),
 ('financas.carta_mensagem','financas-receber','carta',18,'textarea',null,'""'::jsonb,null,null,null,4000,null,null),
 ('financas.carta_mensagem_inicial','financas-receber','carta',19,'textarea',null,'""'::jsonb,null,null,null,2000,null,null),
 ('financas.carta_mensagem_final','financas-receber','carta',20,'textarea',null,'""'::jsonb,null,null,null,2000,null,null),
 ('financas.carta_observacoes_contato','financas-receber','carta',21,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('financas.retorno_taxas','financas-receber','retornos',22,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('os.editar_numero','servicos-os','configuracoes',1,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.exibir_totais','servicos-os','configuracoes',2,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('os.imprimir_localizacao','servicos-os','configuracoes',3,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.data_contas','servicos-os','configuracoes',4,'choice','["nao","data_atual","recalcular"]'::jsonb,'"nao"'::jsonb,null,null,null,null,null,null),
 ('os.garantia_base','servicos-os','configuracoes',5,'choice','["nao_utilizar","data_os","data_prevista","data_conclusao","data_saida"]'::jsonb,'"nao_utilizar"'::jsonb,null,null,null,null,null,null),
 ('os.data_parcelas','servicos-os','configuracoes',6,'choice','["data_os","data_saida","data_prevista"]'::jsonb,'"data_os"'::jsonb,null,null,null,null,null,null),
 ('os.numero_documento_conta','servicos-os','configuracoes',7,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.desconto_lista','servicos-os','configuracoes',8,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.insercao_partes','servicos-os','configuracoes',9,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.servicos_nfe','servicos-os','configuracoes',10,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.vendedor_obrigatorio','servicos-os','configuracoes',11,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.itens_repetidos','servicos-os','configuracoes',12,'toggle',null,'true'::jsonb,null,null,null,null,null,null),
 ('os.observacao_padrao','servicos-os','configuracoes',13,'textarea',null,'""'::jsonb,null,null,null,2000,null,null),
 ('os.mensagem_whatsapp','servicos-os','configuracoes',14,'textarea',null,'""'::jsonb,null,null,null,1000,null,null),
 ('os.rotulo_cliente','servicos-os','rotulos',15,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_equipamento','servicos-os','rotulos',16,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_numero_serie','servicos-os','rotulos',17,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_problema','servicos-os','rotulos',18,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_observacoes_recebimento','servicos-os','rotulos',19,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_peca_descricao','servicos-os','rotulos',20,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_servico_descricao','servicos-os','rotulos',21,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_servico_codigo','servicos-os','rotulos',22,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_servico_quantidade','servicos-os','rotulos',23,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_servico_valor','servicos-os','rotulos',24,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_servico_orcar','servicos-os','rotulos',25,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_servico_observacoes','servicos-os','rotulos',26,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_data_entrada','servicos-os','rotulos',27,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_vencimento','servicos-os','impressao',28,'text',null,'""'::jsonb,null,null,null,40,null,'plain'),
 ('os.rotulo_assinatura','servicos-os','impressao',29,'text',null,'""'::jsonb,null,null,null,60,null,'plain'),
 ('os.ocultar_valores','servicos-os','impressao',30,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.ocultar_cliente','servicos-os','impressao',31,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.imprimir_contatos','servicos-os','impressao',32,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.exibir_assinatura','servicos-os','impressao',33,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.imprimir_desconto_lista','servicos-os','impressao',34,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.tipo_cabecalho','servicos-os','impressao',35,'choice','["padrao","personalizado"]'::jsonb,'"padrao"'::jsonb,null,null,null,null,null,null),
 ('os.email_anexos','servicos-os','email',36,'toggle',null,'false'::jsonb,null,null,null,null,null,null),
 ('os.email_assunto','servicos-os','email',37,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('os.email_copia','servicos-os','email',38,'text',null,'""'::jsonb,null,null,null,100,5,'email_list'),
 ('os.email_remetente','servicos-os','email',39,'text',null,'""'::jsonb,null,null,null,100,null,'plain'),
 ('os.email_resposta','servicos-os','email',40,'text',null,'""'::jsonb,null,null,null,120,null,'email'),
 ('os.email_mensagem','servicos-os','email',41,'textarea',null,'""'::jsonb,null,null,null,4000,null,null),
 ('contador.nome','contabilidade-contador','dados',1,'text',null,'""'::jsonb,null,null,null,120,null,'plain'),
 ('contador.crc','contabilidade-contador','dados',2,'text',null,'""'::jsonb,null,null,null,20,null,'plain'),
 ('contador.email','contabilidade-contador','dados',3,'text',null,'""'::jsonb,null,null,null,120,null,'email'),
 ('contador.telefone','contabilidade-contador','dados',4,'text',null,'""'::jsonb,null,null,null,20,null,'plain'),
 ('contador.escritorio','contabilidade-contador','dados',5,'text',null,'""'::jsonb,null,null,null,120,null,'plain'),
 ('contador.dia_fechamento','contabilidade-contador','data',6,'integer',null,'0'::jsonb,0,31,null,null,null,null),
 ('contador.dia_entrega','contabilidade-contador','data',7,'integer',null,'0'::jsonb,0,31,null,null,null,null);
-- END GENERATED DEFINITIONS

do $$begin
 if exists(select 1 from erp_preferences.definition d where not erp_preferences.value_valid(d,d.default_value)) then
  raise exception 'erp_preferences_default_invalid'; end if;
end$$;

-- Readers: any active member whose role reads the page. VOLATILE writers re-check after every lock wait.
create function erp_preferences.reader_role(p_actor uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
 select role into v_role from erp_access.membership where user_id=p_actor and active;
 if p_actor is null or v_role is null then raise exception 'erp_preferences_access_denied' using errcode='42501'; end if;
 return v_role;
end $$;
create function erp_preferences.write_access(p_actor uuid,p_page erp_preferences.page) returns text language plpgsql set search_path=pg_catalog as $$
declare v_role text;
begin
 perform 1 from auth.users where id=p_actor for key share;
 select role into v_role from erp_access.membership where user_id=p_actor and active for share;
 if v_role is null or not v_role=any(p_page.read_roles) or(p_page.scope='company' and v_role<>'admin') then
  raise exception 'erp_preferences_access_denied' using errcode='42501'; end if;
 return v_role;
end $$;
-- Active members offered by "users" fields; migration 117 adds names. Only administradores and owners of user pages see it.
create function erp_preferences.directory() returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'role',m.role,'label',null) order by m.created_at,m.user_id),'[]'::jsonb)
 from(select user_id,role,created_at from erp_access.membership where active order by created_at,user_id limit 500) m
$$;
create function erp_preferences.page_dto(p_page erp_preferences.page,p_role text,p_user uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('scope','preferences_page','data_mode','erp_native','page',p_page.id,'owner',p_page.scope,'role',p_role,
  'can_manage',p_page.scope='user' or p_role='admin',
  'items',(select coalesce(jsonb_agg(jsonb_build_object('key',d.key,'value',coalesce(v.value,d.default_value),'version',coalesce(v.version,0),'updated_at',v.updated_at) order by d.ordinal),'[]'::jsonb)
   from erp_preferences.definition d
   left join lateral(select c.value,c.version,c.updated_at from erp_preferences.company_value c where p_page.scope='company' and c.key=d.key
    union all select u.value,u.version,u.updated_at from erp_preferences.user_value u where p_page.scope='user' and u.key=d.key and u.user_id=p_user) v on true
   where d.page_id=p_page.id),
  'directory',case when(p_page.scope='user' or p_role='admin')and exists(select 1 from erp_preferences.definition d where d.page_id=p_page.id and d.kind='users')
   then erp_preferences.directory() end)
$$;
/** Current value or the default, for module RPCs in later waves (same transaction). Unknown key returns null. */
create function erp_preferences.get(p_key text,p_user_id uuid default null) returns jsonb language sql stable set search_path=pg_catalog as $$
 select case when p.scope='company' then coalesce((select c.value from erp_preferences.company_value c where c.key=d.key),d.default_value)
  else coalesce((select u.value from erp_preferences.user_value u where u.key=d.key and u.user_id=p_user_id),d.default_value) end
 from erp_preferences.definition d join erp_preferences.page p on p.id=d.page_id where d.key=p_key
$$;

create function public.erp_preferences_page(p_user_id uuid,p_page text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_page erp_preferences.page;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 if p_page is null then raise exception 'erp_preferences_input_invalid' using errcode='22023'; end if;
 select * into v_page from erp_preferences.page where id=p_page;
 if v_page.id is null then raise exception 'erp_preferences_page_not_found' using errcode='P0002'; end if;
 if not v_role=any(v_page.read_roles) then raise exception 'erp_preferences_access_denied' using errcode='42501'; end if;
 return erp_preferences.page_dto(v_page,v_role,p_user_id);
end $$;

-- Saves only the changed keys of one page. Each change carries the version it was read at (CAS per key); a key changed by
-- someone else since then refuses the whole command, and nothing is written.
create function public.erp_preferences_save(p_user_id uuid,p_command_id uuid,p_page text,p_changes jsonb) returns jsonb
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

-- "Conferir resultado": the same command, read back by its author, never re-executed.
create function public.erp_preferences_command(p_user_id uuid,p_command_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_command erp_preferences.command; v_page erp_preferences.page;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 if p_command_id is null then raise exception 'erp_preferences_input_invalid' using errcode='22023'; end if;
 select * into v_command from erp_preferences.command where id=p_command_id;
 if v_command.id is null then raise exception 'erp_preferences_command_not_found' using errcode='P0002'; end if;
 if v_command.actor<>p_user_id then raise exception 'erp_preferences_access_denied' using errcode='42501'; end if;
 select * into v_page from erp_preferences.page where id=v_command.page_id;
 if not v_role=any(v_page.read_roles) then raise exception 'erp_preferences_access_denied' using errcode='42501'; end if;
 return v_command.result||jsonb_build_object('page',erp_preferences.page_dto(v_page,v_role,p_user_id),'replayed',true);
end $$;

revoke all on all functions in schema erp_preferences from public,anon,authenticated,service_role;
revoke all on function public.erp_preferences_page(uuid,text) from public,anon,authenticated;
revoke all on function public.erp_preferences_save(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.erp_preferences_command(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_preferences_page(uuid,text) to service_role;
grant execute on function public.erp_preferences_save(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.erp_preferences_command(uuid,uuid) to service_role;
commit;
