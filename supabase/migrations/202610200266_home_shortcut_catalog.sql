-- 266: Atalhos favoritos (Meu Negócio > Página inicial). A migração 233 já foi aplicada; esta assume o bloco gerado de
-- erp_home.shortcut_catalog() (tools/home/generate-shortcut-catalog.mjs grava aqui a partir de agora). A lista é gerada do menu
-- real (apps/erp/src/lib/origin-menu.ts) junto com HOME_SHORTCUTS do Worker; os testes falham se o menu, o Worker e este bloco
-- divergirem. Quando outra entrega acrescentar telas reais ao menu antes desta migração ser aplicada, basta regerar o bloco
-- (node tools/home/generate-shortcut-catalog.mjs --write). Depois de aplicada, uma nova migração assume o bloco do mesmo jeito.
-- Só a lista muda: as regras de 097 (perfis, recursos, atalhos salvos que deixam de valer ficam ocultos) continuam as mesmas.
begin;

-- The versions replaced here are the ones migration 233 may have applied: the version committed with the Frente de caixa and the
-- Origin finance lists in the menu, and the earlier 233 version (equal to the applied 190 list). Any other version stops the
-- migration.
do $$begin
 if coalesce((select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure('erp_home.shortcut_catalog()')),'') not in(
  'c380dea74af3e230dc62fbcc6c953235de6357bb63fea690f551fb7dacd92db6','1c83430c26a838770a179b67f0a4ee857b262a274ab4ec57305166bb5a93ef43') then
  raise exception 'home_shortcut_catalog_266_previous_definition_changed' using errcode='55000';end if;
end$$;

-- BEGIN GENERATED HOME SHORTCUTS (tools/home/generate-shortcut-catalog.mjs)
create or replace function erp_home.shortcut_catalog() returns table(ordinal integer,path text,roles text[],resource text)
language sql immutable set search_path=pg_catalog as $$
 values
  (1,'/meu-negocio?painel=mensal',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (2,'/meu-negocio?painel=margem-pedido',array['admin','consulta','financeiro','estoque','fiscal'],null::text),
  (3,'/painel-produtos-empresa',array['admin','consulta','vendas','estoque','fiscal'],null::text),
  (4,'/meu-negocio?painel=novos-recorrentes',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (5,'/meu-negocio?painel=curva-abc',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (6,'/meu-negocio?painel=metas',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (7,'/cadastros-reais?cadastro=products',null::text[],'products'),
  (8,'/cadastros-reais?cadastro=contacts',null::text[],'contacts'),
  (9,'/vendedores-empresa',array['admin','consulta','vendas','financeiro'],null::text),
  (10,'/funcionarios-empresa',array['admin'],null::text),
  (11,'/financeiro-empresa?area=contas-financeiras',array['admin','consulta','financeiro'],null::text),
  (12,'/financeiro-empresa?area=categories',array['admin','consulta','financeiro'],null::text),
  (13,'/formas-pagamento-empresa',array['admin','consulta','vendas','financeiro'],null::text),
  (14,'/categorias-produtos',null::text[],'products'),
  (15,'/listas-precos',null::text[],'products'),
  (16,'/documentos-empresa?tipo=sales_orders',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (17,'/historico-fiscal?modelo=55',array['admin','consulta','fiscal'],null::text),
  (18,'/historico-fiscal?modelo=65',array['admin','consulta','fiscal'],null::text),
  (19,'/frente-caixa-empresa',array['admin','consulta','vendas','financeiro'],null::text),
  (20,'/documentos-empresa?tipo=sales_proposals',array['admin','consulta','vendas','financeiro'],null::text),
  (21,'/documentos-empresa?tipo=service_orders',array['admin','consulta','vendas','financeiro'],null::text),
  (22,'/documentos-empresa?tipo=service_orders&acao=relatorios',array['admin','consulta','vendas','financeiro'],null::text),
  (23,'/documentos-empresa?tipo=sales_orders&acao=relatorios',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (24,'/documentos-empresa?tipo=purchase_orders',array['admin','consulta','financeiro','estoque','fiscal'],null::text),
  (25,'/notas-entrada',array['admin','consulta','fiscal'],null::text),
  (26,'/cadastros-reais?cadastro=contacts&contato=fornecedor',null::text[],'contacts'),
  (27,'/painel-produtos-empresa?painel=sugestao',array['admin','consulta','estoque','fiscal'],null::text),
  (28,'/checkin-recebimentos',array['admin','estoque','fiscal'],null::text),
  (29,'/estoque-empresa',array['admin','consulta','vendas','estoque','fiscal'],null::text),
  (30,'/conferencia-estoque-empresa',array['admin','estoque'],null::text),
  (31,'/cadastros-reais?cadastro=warehouses',array['admin','consulta','estoque'],null::text),
  (32,'/relatorios-estoque',array['admin','consulta','vendas','estoque','fiscal'],null::text),
  (33,'/financeiro-empresa?area=accounts',array['admin','consulta','financeiro'],null::text),
  (34,'/financeiro-empresa?area=payable',array['admin','consulta','financeiro'],null::text),
  (35,'/financeiro-empresa?area=receivable',array['admin','consulta','financeiro'],null::text),
  (36,'/financeiro-empresa?area=remessas',array['admin','consulta','financeiro'],null::text),
  (37,'/financeiro-empresa?area=ficha',array['admin','consulta','financeiro'],null::text),
  (38,'/financeiro-empresa?area=comissoes',array['admin','consulta','financeiro'],null::text),
  (39,'/financeiro-empresa?area=controle-caixa',array['admin','consulta','financeiro'],null::text),
  (40,'/financeiro-empresa?area=faturamento-agrupado',array['admin','consulta','financeiro'],null::text),
  (41,'/financeiro-empresa?area=relatorios',array['admin','consulta','financeiro'],null::text)
$$;
revoke all on function erp_home.shortcut_catalog() from public,anon,authenticated,service_role;
-- END GENERATED HOME SHORTCUTS

commit;
