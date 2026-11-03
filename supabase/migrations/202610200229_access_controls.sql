-- 229: Sistema › Usuários: Tipo de usuário (Normal | Contador), Restringir horários de acesso e Permissões (onda D).
-- * Controles de acesso de cada usuário numa tabela própria (versão, comando idempotente e auditoria em erp_access.user_audit):
--   o tipo, os horários (Início, Fim e dias da semana, horário de São Paulo) e o conjunto de permissões do catálogo do Origin
--   (packages/erp-domain/src/user-permissions.mjs; o teste compara as chaves). Sem conjunto gravado o usuário tem tudo o que o
--   perfil permite; as permissões só restringem o perfil, nunca dão mais. O administrador sempre tem tudo e nunca é bloqueado
--   por horário.
-- * Horário: erp_access.schedule_allows(usuário, instante) junta os horários do usuário e os do vendedor vinculado
--   (Cadastros › Vendedores, erp_catalog.seller_access_allowed). erp_access_me informa a janela (o Worker recusa a sessão fora
--   dela com ERP_ACCESS_OUTSIDE_SCHEDULE), erp_access_gate atende o Worker em cada requisição de quem tem horário e
--   erp_access.require_schedule fica para as RPCs das outras frentes.
-- * Permissões: erp_access.permitted(usuário, chave) e erp_access.require_permission para as frentes. Aqui já valem as de
--   Meu Negócio › Dashboard (erp_home_business_panel atende os painéis e as metas).
-- * Lista de usuários com o filtro Tipo de usuário (erp_access_users_list_v2).
-- Substitui erp_access_me (004, conferida pelo hash; outra versão interrompe a migração).
begin;

do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure('public.erp_access_me(uuid)'))
  is distinct from 'df5f27ecec1a02e726ef3b907b4ed41426bd14e107e066dbb6c0bb0575e54df9' then
  raise exception 'access_controls_229_previous_definition_changed public.erp_access_me(uuid)' using errcode='55000';end if;
end$$;

-- ---- Catálogo das permissões (mesma lista e ordem de PERMISSION_KEYS, sem as telas do perfil Administrador) ----
create function erp_access.permission_keys() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['cadastros.clientes_fornecedores','cadastros.clientes_fornecedores.ie','cadastros.clientes_fornecedores.ex','cadastros.clientes_fornecedores.limite_credito',
  'cadastros.clientes_fornecedores.vendedores','cadastros.clientes_fornecedores.transportadores','cadastros.clientes_fornecedores.tecnicos',
  'cadastros.clientes_fornecedores.fornecedores','cadastros.clientes_fornecedores.desenvolvedores','cadastros.clientes_fornecedores.clientes',
  'cadastros.clientes_fornecedores.exportar','cadastros.listas_precos','cadastros.listas_precos.ie','cadastros.listas_precos.ex','cadastros.produtos',
  'cadastros.produtos.ie','cadastros.produtos.ex','cadastros.produtos.reajuste','cadastros.produtos.preco_venda','cadastros.produtos.fornecedor',
  'cadastros.produtos.estoque_cadastro','cadastros.produtos.exportar','cadastros.produtos.imagens','cadastros.produtos.variacoes',
  'cadastros.produtos.relatorio_precos','cadastros.vendedores','cadastros.categorias_produtos','cadastros.categorias_produtos.ie',
  'cadastros.categorias_produtos.ex','cadastros.controle_lotes','cadastros.controle_lotes.ie','cadastros.controle_lotes.ex','cadastros.controle_lotes.nfe_entrada',
  'cadastros.controle_lotes.relatorio','suprimentos.controle_estoque','suprimentos.controle_estoque.precos_lancamentos','suprimentos.controle_estoque.insercao',
  'suprimentos.controle_estoque.importador_saldos','suprimentos.controle_estoque.edicao_exclusao','suprimentos.controle_estoque.entradas_saidas',
  'suprimentos.controle_estoque.relatorio_transferencia','suprimentos.controle_estoque.transferencia','suprimentos.controle_estoque.saldos',
  'suprimentos.controle_estoque.maior_circulacao','suprimentos.controle_estoque.sem_movimentacao','suprimentos.controle_estoque.abaixo_minimo',
  'suprimentos.controle_estoque.visao_financeira','suprimentos.controle_estoque.movimentacao_produto','suprimentos.pedidos_compra','suprimentos.pedidos_compra.ie',
  'suprimentos.pedidos_compra.ex','suprimentos.pedidos_compra.lancar_estoque','suprimentos.pedidos_compra.lancar_contas','suprimentos.pedidos_compra.situacoes',
  'suprimentos.pedidos_compra.relatorio','suprimentos.notas_entrada','suprimentos.notas_entrada.ie','suprimentos.notas_entrada.ex',
  'suprimentos.notas_entrada.lancar_estoque','suprimentos.notas_entrada.lancar_contas','suprimentos.notas_entrada.relatorios','suprimentos.conferencias',
  'suprimentos.conferencias.saldo_atual','suprimentos.checkin','suprimentos.depositos','suprimentos.depositos.ie','vendas.frente_caixa',
  'vendas.frente_caixa.fechamento','vendas.frente_caixa.forma_pagamento','vendas.frente_caixa.registro_itens','vendas.frente_caixa.exclusao_itens',
  'vendas.frente_caixa.preco_unitario','vendas.frente_caixa.registro_pagamento','vendas.nfce','vendas.nfce.totais','vendas.propostas','vendas.propostas.ie',
  'vendas.propostas.ex','vendas.propostas.situacoes','vendas.propostas.limite_desconto','vendas.propostas.exportar','vendas.pedidos_venda',
  'vendas.pedidos_venda.ie','vendas.pedidos_venda.ex','vendas.pedidos_venda.lancar_estoque','vendas.pedidos_venda.lancar_contas',
  'vendas.pedidos_venda.forma_pagamento','vendas.pedidos_venda.situacoes','vendas.pedidos_venda.limite_desconto','vendas.pedidos_venda.exportar',
  'vendas.relatorios_vendas','vendas.relatorios_vendas.romaneio','vendas.relatorios_vendas.vendas','vendas.relatorios_vendas.agrupado_bairro',
  'vendas.notas_fiscais','vendas.notas_fiscais.ie','vendas.notas_fiscais.ex','vendas.notas_fiscais.lancar_estoque','vendas.notas_fiscais.lancar_contas',
  'vendas.notas_fiscais.importar_lote','vendas.notas_fiscais.emissao','vendas.notas_fiscais.parcial','vendas.notas_fiscais.difal','vendas.relatorios_notas',
  'vendas.relatorios_notas.operacao','vendas.relatorios_notas.cliente','vendas.relatorios_notas.produto','vendas.relatorios_notas.evolucao','vendas.comissoes',
  'vendas.comissoes.complementar','vendas.checkout','vendas.checkout.produto_unico','vendas.checkout.correcao','vendas.checkout.leitura_manual',
  'vendas.checkout.automacoes','vendas.checkout.separacao','vendas.controle_caixa','vendas.controle_caixa.ie','vendas.controle_caixa.ex',
  'vendas.controle_caixa.caixas_unicos','vendas.controle_caixa.relatorio','financas.caixas_bancos','financas.caixas_bancos.ie','financas.caixas_bancos.ex',
  'financas.caixas_bancos.transferencia','financas.caixas_bancos.balancete','financas.caixas_bancos.dre','financas.caixas_bancos.fluxo',
  'financas.caixas_bancos.resumo_categoria','financas.caixas_bancos.resumo_cliente','financas.contas_pagar','financas.contas_pagar.ie','financas.contas_pagar.ex',
  'financas.contas_pagar.cancelar','financas.contas_pagar.baixar','financas.contas_pagar.relatorio','financas.contas_receber','financas.contas_receber.ie',
  'financas.contas_receber.ex','financas.contas_receber.cancelar','financas.contas_receber.baixar','financas.contas_receber.relatorio','financas.remessas',
  'financas.remessas.ie','financas.remessas.ex','financas.remessas.gerar','financas.ficha','financas.ficha.ie','financas.ficha.ex','financas.ficha.baixar',
  'financas.categorias','financas.categorias.ie','financas.categorias.ex','financas.contas_contabeis','financas.contas_contabeis.ie','financas.contas_contabeis.ex',
  'financas.retornos','financas.retornos.ie','financas.retornos.ex','financas.faturamento_agrupado','financas.conciliacao','financas.boletos',
  'servicos.ordem_servico','servicos.ordem_servico.ie','servicos.ordem_servico.ex','servicos.ordem_servico.historico_financeiro',
  'servicos.ordem_servico.lancar_estoque','servicos.ordem_servico.lancar_contas','servicos.ordem_servico.situacoes','servicos.ordem_servico.forma_pagamento',
  'preferencias.central_notificacoes','preferencias.central_notificacoes.novidades','preferencias.campos_customizados','preferencias.campos_customizados.ie',
  'preferencias.campos_customizados.ex','preferencias.campos_customizados.contatos','preferencias.campos_customizados.importador',
  'preferencias.campos_customizados.os','preferencias.campos_customizados.produtos','contabilidade.meu_contador','meu_negocio.dashboard',
  'meu_negocio.dashboard.vendedor','meu_negocio.dashboard.canal','meu_negocio.dashboard.pedidos','meu_negocio.dashboard.novos_recorrentes',
  'meu_negocio.dashboard.metas','meu_negocio.dashboard.estoque_produtos','meu_negocio.dashboard.mensal','meu_negocio.dashboard.diario',
  'meu_negocio.dashboard.margem_sku','meu_negocio.dashboard.curva_abc','meu_negocio.dashboard.sugestao_compras','meu_negocio.dashboard.sem_movimentacao',
  'meu_negocio.dashboard.previsao_estoque','meu_negocio.dashboard.carteira','outros.dados_empresa','outros.dados_empresa.gerenciar','outros.borderos',
  'outros.borderos.ex','outros.grupos_tags','outros.tags','outros.emissao_boletos','outros.sintegra','outros.importacao_nfe_xml','outros.importacao_pedido_xml',
  'outros.relatorios_customizados','outros.dados_basicos','outros.sped']
$$;
create function erp_access.permission_parent(p_key text) returns text language sql immutable set search_path=pg_catalog as $$
 select case when array_length(string_to_array(p_key,'.'),1)>2 then split_part(p_key,'.',1)||'.'||split_part(p_key,'.',2) end
$$;

-- ---- Controles de acesso de cada usuário ----
create table erp_access.user_control(
 user_id uuid primary key references auth.users(id),
 user_type text not null default 'normal' check(user_type in('normal','contador')),
 schedule_enabled boolean not null default false,
 windows jsonb not null default '[]' check(jsonb_typeof(windows)='array' and jsonb_array_length(windows)<=10),
 permissions text[] check(permissions is null or cardinality(permissions)<=300),
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id),
 check(not schedule_enabled or jsonb_array_length(windows)>=1)
);
alter table erp_access.user_control enable row level security;
revoke all on erp_access.user_control from public,anon,authenticated,service_role;
alter table erp_access.user_command drop constraint user_command_kind_check;
alter table erp_access.user_command add constraint user_command_kind_check check(kind in('save','invite','controls'));

-- One window {start:'HH:MM', end:'HH:MM', days:[0..6 crescentes]}; the end minute is included (as the seller windows).
create function erp_access.windows_valid(p jsonb) returns boolean language sql immutable set search_path=pg_catalog as $$
 select jsonb_typeof(p)='array' and jsonb_array_length(p)<=10 and not exists(select 1 from jsonb_array_elements(p) w where
  jsonb_typeof(w)<>'object' or(select count(*) from jsonb_object_keys(w))<>3 or jsonb_typeof(w->'start')<>'string' or jsonb_typeof(w->'end')<>'string'
  or w->>'start'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or w->>'end'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or w->>'start'>=w->>'end'
  or jsonb_typeof(w->'days')<>'array' or jsonb_array_length(w->'days') not between 1 and 7
  or exists(select 1 from jsonb_array_elements(w->'days') with ordinality d(v,i) where jsonb_typeof(d.v)<>'number' or d.v::text!~'^[0-6]$'
   or(i>1 and d.v::text::integer<=((w->'days')->(i::integer-2))::text::integer)))
$$;
create function erp_access.window_open(p_windows jsonb,p_at timestamptz) returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from jsonb_array_elements(p_windows) w
  where to_char(p_at at time zone 'America/Sao_Paulo','HH24:MI') between w->>'start' and w->>'end'
   and w->'days' @> to_jsonb(extract(dow from p_at at time zone 'America/Sao_Paulo')::integer))
$$;
-- End of the open windows at that instant (the last second of the Fim minute, São Paulo), for "acesso até".
create function erp_access.window_until(p_windows jsonb,p_at timestamptz) returns timestamptz language sql stable set search_path=pg_catalog as $$
 select max((((p_at at time zone 'America/Sao_Paulo')::date+(w->>'end')::time+interval '59 seconds') at time zone 'America/Sao_Paulo'))
 from jsonb_array_elements(p_windows) w
 where to_char(p_at at time zone 'America/Sao_Paulo','HH24:MI') between w->>'start' and w->>'end'
  and w->'days' @> to_jsonb(extract(dow from p_at at time zone 'America/Sao_Paulo')::integer)
$$;
/** Whether the user may use Brufap at that instant: the administrador always; otherwise the user windows (when enabled) and the
 * windows of the linked seller (Cadastros › Vendedores) must both be open. */
create function erp_access.schedule_allows(p_user uuid,p_at timestamptz default clock_timestamp()) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce((select m.role='admin' from erp_access.membership m where m.user_id=p_user and m.active),false)
  or(coalesce((select not c.schedule_enabled or erp_access.window_open(c.windows,p_at) from erp_access.user_control c where c.user_id=p_user),true)
   and erp_catalog.seller_access_allowed(p_user,p_at))
$$;
create function erp_access.schedule_until(p_user uuid,p_at timestamptz default clock_timestamp()) returns timestamptz language sql stable set search_path=pg_catalog as $$
 select case when not erp_access.schedule_allows(p_user,p_at) or coalesce((select m.role='admin' from erp_access.membership m where m.user_id=p_user and m.active),false) then null
  else nullif(least(coalesce((select case when c.schedule_enabled then erp_access.window_until(c.windows,p_at) end from erp_access.user_control c where c.user_id=p_user),'infinity'::timestamptz),
   coalesce((select case when s.access_hours_enabled and jsonb_array_length(s.access_windows)>0 then erp_access.window_until(s.access_windows,p_at) end from erp_catalog.seller s where s.user_id=p_user),'infinity'::timestamptz)),'infinity') end
$$;
-- For the RPCs of the other lanes: refuses a user outside the access windows.
create function erp_access.require_schedule(p_user uuid) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if not erp_access.schedule_allows(p_user) then raise exception 'erp_access_outside_schedule' using errcode='42501'; end if;
end $$;
-- The user needs a gate at every request when there is any window to follow.
create function erp_access.gate_required(p_user uuid) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce((select c.schedule_enabled from erp_access.user_control c where c.user_id=p_user),false)
  or coalesce((select s.access_hours_enabled and jsonb_array_length(s.access_windows)>0 from erp_catalog.seller s where s.user_id=p_user),false)
$$;
/** Permission of the catalog: the administrador always; a user without a saved set has everything of the profile; otherwise the
 * key and its module must be in the set. Unknown keys are refused. */
create function erp_access.permitted(p_user uuid,p_key text) returns boolean language sql stable set search_path=pg_catalog as $$
 select p_key=any(erp_access.permission_keys()) and(coalesce((select m.role='admin' from erp_access.membership m where m.user_id=p_user and m.active),false)
  or coalesce((select c.permissions is null or(p_key=any(c.permissions) and(erp_access.permission_parent(p_key) is null or erp_access.permission_parent(p_key)=any(c.permissions)))
   from erp_access.user_control c where c.user_id=p_user),true))
$$;
create function erp_access.require_permission(p_user uuid,p_key text) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if not erp_access.permitted(p_user,p_key) then raise exception 'erp_access_permission_denied' using errcode='42501'; end if;
end $$;
create function erp_access.permissions_valid(p text[]) returns boolean language sql immutable set search_path=pg_catalog as $$
 select p is null or(cardinality(p)<=cardinality(erp_access.permission_keys()) and(select count(distinct k) from unnest(p) k)=cardinality(p)
  and not exists(select 1 from unnest(p) k where k is null or not k=any(erp_access.permission_keys()) or(erp_access.permission_parent(k) is not null and not erp_access.permission_parent(k)=any(p))))
$$;
-- The administrador has every permission and is never blocked: windows or a set saved before the user became administrador do
-- not apply, so they are shown as the effective state (no restriction); a save of the administrador clears them.
create function erp_access.controls_dto(p_target uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('scope','access_user_controls','data_mode','erp_native','target',p_target,
  'role',m.role,'version',coalesce(c.version,0),'user_type',coalesce(c.user_type,'normal'),
  'schedule',jsonb_build_object('enabled',coalesce(c.schedule_enabled,false) and m.role is distinct from 'admin','windows',coalesce(c.windows,'[]'::jsonb)),
  'permissions',case when c.permissions is null or m.role='admin' then 'null'::jsonb
   else(select coalesce(jsonb_agg(k order by array_position(erp_access.permission_keys(),k)),'[]'::jsonb) from unnest(c.permissions) k) end,
  'seller',(select jsonb_build_object('name',left(coalesce(r.name,'Vendedor'),200),'enabled',s.access_hours_enabled,'windows',s.access_windows)
   from erp_catalog.seller s left join erp_catalog.record r on r.id=s.contact_id where s.user_id=p_target limit 1),
  'updated_at',c.updated_at,'gate_required',erp_access.gate_required(p_target))
 from(select 1) one left join erp_access.user_control c on c.user_id=p_target left join erp_access.membership m on m.user_id=p_target
$$;

create function public.erp_access_user_controls_get(p_user_id uuid,p_target uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_access.read_admin(p_user_id);
 if p_target is null or not exists(select 1 from auth.users where id=p_target) then raise exception 'erp_access_user_not_found' using errcode='P0002'; end if;
 return erp_access.controls_dto(p_target);
end $$;
-- Salvar of the controls: whole desired state after comparing the version the screen read; one command, one audit row.
create function public.erp_access_user_controls_save(p_user_id uuid,p_command_id uuid,p_target uuid,p_expected_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; c erp_access.user_command; v erp_access.user_control; m erp_access.membership; v_at timestamptz; v_before jsonb; v_after jsonb; v_result jsonb;
 v_type text; v_enabled boolean; v_windows jsonb; v_permissions text[];
begin
 perform erp_access.read_admin(p_user_id);
 if p_command_id is null or p_target is null or p_expected_version is null or p_expected_version<0 or p_data is null or jsonb_typeof(p_data)<>'object'
  or(select array_agg(k order by k) from jsonb_object_keys(p_data) k)<>array['permissions','schedule','user_type']
  or jsonb_typeof(p_data->'user_type')<>'string' or p_data->>'user_type' not in('normal','contador')
  or jsonb_typeof(p_data->'schedule')<>'object' or(select array_agg(k order by k) from jsonb_object_keys(p_data->'schedule') k)<>array['enabled','windows']
  or jsonb_typeof(p_data#>'{schedule,enabled}')<>'boolean' or not erp_access.windows_valid(p_data#>'{schedule,windows}')
  or jsonb_typeof(p_data->'permissions') not in('null','array')
  or(jsonb_typeof(p_data->'permissions')='array' and exists(select 1 from jsonb_array_elements(p_data->'permissions') k where jsonb_typeof(k)<>'string')) then
  raise exception 'erp_access_controls_input_invalid' using errcode='22023'; end if;
 v_type:=p_data->>'user_type';v_enabled:=(p_data#>>'{schedule,enabled}')::boolean;v_windows:=p_data#>'{schedule,windows}';
 v_permissions:=case when jsonb_typeof(p_data->'permissions')='array' then array(select jsonb_array_elements_text(p_data->'permissions')) end;
 if v_enabled and jsonb_array_length(v_windows)=0 or not erp_access.permissions_valid(v_permissions) then raise exception 'erp_access_controls_input_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-access-controls-v1','actor',p_user_id,'target',p_target,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtext('erp_access_user_command'),hashtext(p_command_id::text));
 select * into c from erp_access.user_command where id=p_command_id;
 if c.id is not null then
  perform erp_access.require_admin(p_user_id,true);
  if c.actor<>p_user_id or c.kind<>'controls' or c.request_hash<>v_hash then raise exception 'erp_access_users_command_conflict' using errcode='40001'; end if;
  return c.result||jsonb_build_object('controls',erp_access.controls_dto(c.target),'replayed',true);
 end if;
 perform pg_advisory_xact_lock(hashtext('erp_access_users'),0);
 perform erp_access.require_admin(p_user_id,true);
 perform 1 from auth.users where id=p_target for key share;
 if not found then raise exception 'erp_access_user_not_found' using errcode='P0002'; end if;
 select * into m from erp_access.membership where user_id=p_target for share;
 -- The administrador has every permission and is never blocked by the access windows.
 if m.role='admin' and(v_enabled or v_permissions is not null) then raise exception 'erp_access_controls_admin' using errcode='22023'; end if;
 select * into v from erp_access.user_control where user_id=p_target for update;
 if coalesce(v.version,0)<>p_expected_version then raise exception 'erp_access_users_version_conflict' using errcode='40001'; end if;
 v_before:=jsonb_build_object('user_type',coalesce(v.user_type,'normal'),'schedule',jsonb_build_object('enabled',coalesce(v.schedule_enabled,false),'windows',coalesce(v.windows,'[]'::jsonb)),
  'permissions',to_jsonb(v.permissions));
 v_after:=jsonb_build_object('user_type',v_type,'schedule',jsonb_build_object('enabled',v_enabled,'windows',v_windows),'permissions',to_jsonb(v_permissions));
 if v_before=v_after then raise exception 'erp_access_users_unchanged' using errcode='22023'; end if;
 if v.version=2147483647 then raise exception 'erp_access_users_version_conflict' using errcode='40001'; end if;
 v_at:=clock_timestamp();
 if v.user_id is null then insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values(p_target,v_type,v_enabled,v_windows,v_permissions,1,v_at,p_user_id);
 else update erp_access.user_control set user_type=v_type,schedule_enabled=v_enabled,windows=v_windows,permissions=v_permissions,version=version+1,updated_at=v_at,updated_by=p_user_id where user_id=p_target; end if;
 v_result:=jsonb_build_object('scope','access_controls_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'target',p_target,'changed_at',v_at));
 insert into erp_access.user_command(id,actor,kind,target,request_hash,state,result,completed_at) values(p_command_id,p_user_id,'controls',p_target,v_hash,'done',v_result,v_at);
 insert into erp_access.user_audit(command_id,actor,target,before_data,after_data) values(p_command_id,p_user_id,p_target,v_before,v_after);
 perform erp_access.require_admin(p_user_id,true);
 return v_result||jsonb_build_object('controls',erp_access.controls_dto(p_target),'replayed',false);
end $$;

-- What the signed-in user may open and whether the access windows are open now (the screens hide what the server refuses).
create function public.erp_access_permissions_me(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; c erp_access.user_control;
begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if p_user_id is null or v_role is null then raise exception 'erp_access_denied' using errcode='42501'; end if;
 select * into c from erp_access.user_control where user_id=p_user_id;
 return jsonb_build_object('scope','access_permissions','data_mode','erp_native','user_id',p_user_id,'role',v_role,'user_type',coalesce(c.user_type,'normal'),
  'permissions',case when v_role='admin' or c.permissions is null then 'null'::jsonb
   else(select coalesce(jsonb_agg(k order by array_position(erp_access.permission_keys(),k)),'[]'::jsonb) from unnest(c.permissions) k) end,
  'access',jsonb_build_object('open',erp_access.schedule_allows(p_user_id),'until',erp_access.schedule_until(p_user_id)));
end $$;
-- The Worker asks at each request of a user with access windows (and caches the answer for the São Paulo minute).
create function public.erp_access_gate(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 if p_user_id is null or not exists(select 1 from erp_access.membership where user_id=p_user_id and active) then raise exception 'erp_access_denied' using errcode='42501'; end if;
 return jsonb_build_object('scope','access_gate','data_mode','erp_native','user_id',p_user_id,'open',erp_access.schedule_allows(p_user_id),'until',erp_access.schedule_until(p_user_id));
end $$;
-- /v1/me: the same membership, plus the access window (the Worker refuses the session when it is closed).
create or replace function public.erp_access_me(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare v_role text;
begin
  select role into v_role from erp_access.membership where user_id = p_user_id and active;
  if not found then raise exception 'erp_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object('user_id', p_user_id::text, 'role', v_role,
    'resources', erp_access.resources_for_role(v_role), 'data_mode', 'staging_readonly',
    'access_window', case when erp_access.schedule_allows(p_user_id) then 'open' else 'closed' end);
end;
$$;

-- Sistema › Usuários with the Origin filter "Tipo de usuário" (Todos | Normal | Contador); each row carries its type.
create function public.erp_access_users_list_v2(p_user_id uuid,p_query text,p_status text,p_type text,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_total integer; v_counts jsonb; v_q text;
begin
 perform erp_access.read_admin(p_user_id);
 if p_status is null or p_status not in('todos','ativo','inativo','sem_acesso') or p_type is null or p_type not in('todos','normal','contador')
  or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
  or p_query is not null and(length(p_query)>120 or p_query~'[\x01-\x1f\x7f]') then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
 v_q:=nullif(lower(btrim(coalesce(p_query,''))),'');
 with accounts as materialized(
  select erp_access.user_dto(u.id)||jsonb_build_object('user_type',coalesce(c.user_type,'normal')) d from auth.users u left join erp_access.user_control c on c.user_id=u.id
 ), filtered as materialized(
  select d from accounts where d->>'user_id' is not null and(p_status='todos' or d->>'status'=p_status) and(p_type='todos' or d->>'user_type'=p_type)
   and(v_q is null or strpos(lower(coalesce(d->>'name','')),v_q)>0 or strpos(d->>'email',v_q)>0)
 )
 select(select count(*) from filtered),
  (select coalesce(jsonb_agg(d order by lower(coalesce(d->>'name',d->>'email')),d->>'email',d->>'user_id'),'[]'::jsonb) from(select d from filtered order by lower(coalesce(d->>'name',d->>'email')),d->>'email',d->>'user_id' limit p_limit offset p_offset) x),
  (select jsonb_build_object('ativo',count(*) filter(where d->>'status'='ativo'),'inativo',count(*) filter(where d->>'status'='inativo'),'sem_acesso',count(*) filter(where d->>'status'='sem_acesso')) from accounts where d->>'user_id' is not null)
  into v_total,v_items,v_counts;
 return jsonb_build_object('scope','access_users','data_mode','erp_native','status',p_status,'type',p_type,'query',v_q,'limit',p_limit,'offset',p_offset,'total',v_total,
  'has_more',p_offset+jsonb_array_length(v_items)<v_total,'items',v_items,'counts',v_counts,'actor',p_user_id);
end $$;

-- ---- Meu Negócio › Dashboard: the panels and the metas through the permission of each dashboard ----
create function public.erp_home_business_panel(p_user_id uuid,p_panel text,p_args jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_key text; v_keys text[];
begin
 v_key:=case p_panel when 'mensal' then 'mensal' when 'diario' then 'diario' when 'pedidos-venda' then 'pedidos' when 'vendas-vendedor' then 'vendedor' when 'venda-canal' then 'canal'
  when 'previsao-estoque' then 'previsao_estoque' when 'margem-pedido' then 'margem_sku' when 'novos-recorrentes' then 'novos_recorrentes' when 'atividade-carteira' then 'carteira'
  when 'curva-abc' then 'curva_abc' when 'metas' then 'metas' when 'metas_save' then 'metas' when 'metas_command' then 'metas' end;
 v_keys:=case p_panel when 'mensal' then array['p_compare_from','p_compare_to','p_from','p_statuses','p_to'] when 'diario' then array['p_compare_day','p_day','p_statuses']
  when 'pedidos-venda' then array['p_from','p_state','p_statuses','p_to'] when 'vendas-vendedor' then array['p_from','p_seller','p_statuses','p_to'] when 'venda-canal' then array[]::text[]
  when 'previsao-estoque' then array['p_from','p_reserve','p_to','p_warehouse_id'] when 'margem-pedido' then array['p_from','p_statuses','p_tab','p_to']
  when 'novos-recorrentes' then array['p_from','p_statuses','p_to'] when 'atividade-carteira' then array['p_brand','p_from','p_keywords','p_min_days','p_to']
  when 'curva-abc' then array['p_brand','p_from','p_statuses','p_to'] when 'metas' then array['p_tab'] when 'metas_save' then array['p_command_id','p_data','p_expected_version','p_goal_id']
  when 'metas_command' then array['p_command_id'] end;
 if v_key is null or p_args is null or jsonb_typeof(p_args)<>'object' or coalesce((select array_agg(k order by k) from jsonb_object_keys(p_args) k),array[]::text[])<>v_keys then
  raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 perform erp_access.require_permission(p_user_id,'meu_negocio.dashboard');
 perform erp_access.require_permission(p_user_id,'meu_negocio.dashboard.'||v_key);
 return case p_panel
  when 'mensal' then public.erp_home_business_monthly(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date,(p_args->>'p_compare_from')::date,(p_args->>'p_compare_to')::date)
  when 'diario' then public.erp_home_business_daily(p_user_id,p_args->'p_statuses',(p_args->>'p_day')::date,(p_args->>'p_compare_day')::date)
  when 'pedidos-venda' then public.erp_home_business_orders(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date,p_args->>'p_state')
  when 'vendas-vendedor' then public.erp_home_business_sellers(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date,p_args->>'p_seller')
  when 'venda-canal' then public.erp_home_business_channels(p_user_id)
  when 'previsao-estoque' then public.erp_home_business_forecast(p_user_id,(p_args->>'p_from')::date,(p_args->>'p_to')::date,(p_args->>'p_warehouse_id')::uuid,(p_args->>'p_reserve')::boolean)
  when 'margem-pedido' then public.erp_home_business_margin(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date,p_args->>'p_tab')
  when 'novos-recorrentes' then public.erp_home_business_customers(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date)
  when 'atividade-carteira' then public.erp_home_business_portfolio(p_user_id,(p_args->>'p_from')::date,(p_args->>'p_to')::date,p_args->>'p_brand',(p_args->>'p_min_days')::integer,p_args->'p_keywords')
  when 'curva-abc' then public.erp_home_business_abc(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date,p_args->>'p_brand')
  when 'metas' then public.erp_home_business_goals(p_user_id,p_args->>'p_tab')
  when 'metas_save' then public.erp_home_business_goal_save(p_user_id,(p_args->>'p_command_id')::uuid,(p_args->>'p_goal_id')::uuid,(p_args->>'p_expected_version')::integer,p_args->'p_data')
  else public.erp_home_business_goal_command(p_user_id,(p_args->>'p_command_id')::uuid) end;
end $$;

revoke all on function erp_access.permission_keys(),erp_access.permission_parent(text),erp_access.windows_valid(jsonb),erp_access.window_open(jsonb,timestamptz),
 erp_access.window_until(jsonb,timestamptz),erp_access.schedule_allows(uuid,timestamptz),erp_access.schedule_until(uuid,timestamptz),erp_access.require_schedule(uuid),
 erp_access.gate_required(uuid),erp_access.permitted(uuid,text),erp_access.require_permission(uuid,text),erp_access.permissions_valid(text[]),erp_access.controls_dto(uuid)
 from public,anon,authenticated,service_role;
do $$declare f text;begin foreach f in array array['erp_access_user_controls_get(uuid,uuid)','erp_access_user_controls_save(uuid,uuid,uuid,integer,jsonb)',
  'erp_access_permissions_me(uuid)','erp_access_gate(uuid)','erp_access_me(uuid)','erp_access_users_list_v2(uuid,text,text,text,integer,integer)',
  'erp_home_business_panel(uuid,text,jsonb)'] loop
 execute format('revoke all on function public.%s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function public.%s to service_role',f);
end loop;end$$;
commit;
