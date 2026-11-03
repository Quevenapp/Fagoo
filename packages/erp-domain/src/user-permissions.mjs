/** Sistema › Usuários › Permissões (migration 229): the Origin permission catalog, its tabs and cards, and the closed contract of
 * the access controls of one user (Tipo de usuário, Restringir horários de acesso and Permissões).
 * - Each card is a module with its own key, optional "Inclusão e edição" (.ie) and "Exclusão" (.ex) and indented
 *   sub-permissions, enabled only when the module is checked. Tooltips follow the Origin wording.
 * - Permissions narrow the profile (perfil): they never give a user more than the role reads or writes. A user without a saved
 *   set keeps everything of the role; the administrador always has everything.
 * - `applied` marks what Brufap already enforces on the server (Meu Negócio dashboards; 264: Relatórios customizados, Acesso aos dados da
 *   empresa, Espaço Meu Contador and Central de Notificações); `admin` marks the screens Brufap keeps
 *   for the Administrador profile (not configurable for other profiles); every other key is stored for the modules to adopt
 *   (erp_access.permitted(user, key) in SQL). Out of scope (marketplace, loja virtual, logística, CT-e, NFS-e, DAS MEI, GNRE,
 *   Origin Conta, multiempresa, ordens de produção, API, WhatsApp, POS, iFood, delivery and plano) is left out. */
export const CONTROLS_BODY_BYTES=32768;
export const USER_TYPES=Object.freeze(['normal','contador']);
export const USER_TYPE_LABELS=Object.freeze({normal:'Normal',contador:'Contador'});
export const WINDOW_LIMIT=10;
export const WEEKDAYS=Object.freeze(['D','S','T','Q','Q','S','S']);
export const WEEKDAY_NAMES=Object.freeze(['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado']);
const sub=(key,label)=>Object.freeze({key,label});
const card=(key,label,{ie=false,ex=false,subs=[],applied=false,admin=false}={})=>Object.freeze({key,label,ie,ex,subs:Object.freeze(subs.map(([k,l])=>sub(k,l))),applied,admin});
const LANCAR=[['lancar_estoque','Lançar estoque'],['lancar_contas','Lançar contas']];
export const PERMISSION_TABS=Object.freeze([
 Object.freeze({id:'cadastros',label:'Cadastros',cards:Object.freeze([
  card('clientes_fornecedores','Clientes e Fornecedores',{ie:true,ex:true,subs:[['limite_credito','Edição do limite de crédito'],['vendedores','Visualizar vendedores'],['transportadores','Visualizar transportadores'],
   ['tecnicos','Visualizar técnicos'],['fornecedores','Visualizar fornecedores'],['desenvolvedores','Visualizar desenvolvedores'],['clientes','Visualizar clientes'],['exportar','Exportar dados para planilha']]}),
  card('listas_precos','Listas de Preços',{ie:true,ex:true}),
  card('produtos','Produtos',{ie:true,ex:true,subs:[['reajuste','Reajuste de preços'],['preco_venda','Edição do Preço de Venda'],['fornecedor','Edição do fornecedor'],['estoque_cadastro','Edição do estoque no cadastro'],
   ['exportar','Exportar dados para planilha'],['imagens','Salvar imagens'],['variacoes','Salvar variações'],['relatorio_precos','Relatório de preço de produtos']]}),
  card('vendedores','Vendedores'),
  card('categorias_produtos','Categoria de Produtos',{ie:true,ex:true}),
  card('controle_lotes','Controle de Lotes',{ie:true,ex:true,subs:[['nfe_entrada','Controle de lotes NF-e (Entrada)'],['relatorio','Relatório Controle de Lotes']]}),
 ])}),
 Object.freeze({id:'suprimentos',label:'Suprimentos',cards:Object.freeze([
  card('controle_estoque','Controle de Estoque',{subs:[['precos_lancamentos','Visualizar preços dos lançamentos'],['insercao','Inserção de Estoque'],['importador_saldos','Importador de saldos'],
   ['edicao_exclusao','Edição e exclusão de Estoque'],['entradas_saidas','Entradas e Saídas'],['relatorio_transferencia','Relatório Transferência'],['transferencia','Transferência entre depósitos'],
   ['saldos','Saldos em Estoque'],['maior_circulacao','Maior Circulação'],['sem_movimentacao','Sem Movimentação'],['abaixo_minimo','Abaixo do Estoque Mínimo'],['visao_financeira','Visão Financeira do Estoque'],
   ['movimentacao_produto','Movimentação de um Produto']]}),
  card('pedidos_compra','Pedidos de Compra',{ie:true,ex:true,subs:[...LANCAR,['situacoes','Gerenciar situações'],['relatorio','Relatório de Pedidos de Compras']]}),
  card('notas_entrada','Notas de Entrada',{ie:true,ex:true,subs:[...LANCAR,['relatorios','Relatórios de compra']]}),
  card('conferencias','Conferências de Estoque',{subs:[['saldo_atual','Visualizar saldo atual durante a conferência']]}),
  card('checkin','Check-in de Recebimentos'),
  card('depositos','Depósitos de Estoque',{ie:true}),
 ])}),
 Object.freeze({id:'vendas',label:'Vendas',cards:Object.freeze([
  card('frente_caixa','Frente de Caixa',{subs:[['fechamento','Fechamento da Venda'],['forma_pagamento','Alterar forma de pagamento das parcelas'],['registro_itens','Registro de itens'],['exclusao_itens','Exclusão de itens'],
   ['preco_unitario','Editar o preço unitário'],['registro_pagamento','Registro de Pagamento']]}),
  card('nfce','NFC-e',{subs:[['totais','Exibição de totais na NFC-e']]}),
  card('propostas','Propostas Comerciais',{ie:true,ex:true,subs:[['situacoes','Gerenciar situações'],['limite_desconto','Desconsiderar limite de desconto do vendedor'],['exportar','Exportar dados para planilha']]}),
  card('pedidos_venda','Pedidos de Venda',{ie:true,ex:true,subs:[...LANCAR,['forma_pagamento','Editar forma de pagamento das parcelas'],['situacoes','Gerenciar situações'],
   ['limite_desconto','Desconsiderar limite de desconto do vendedor'],['exportar','Exportar dados para planilha']]}),
  card('relatorios_vendas','Relatórios de Vendas',{subs:[['romaneio','Romaneio'],['vendas','Vendas'],['agrupado_bairro','Vendas Agrupado por bairro']]}),
  card('notas_fiscais','Notas Fiscais',{ie:true,ex:true,subs:[...LANCAR,['importar_lote','Importar notas em lote'],['emissao','Emissão de NF-e'],['parcial','Gerar nota fiscal parcial'],['difal','Notas Fiscais ICMS DIFAL']]}),
  card('relatorios_notas','Relatórios de Notas Fiscais',{subs:[['operacao','por Operação'],['cliente','por Cliente'],['produto','por Produto'],['evolucao','Evolução do Faturamento']]}),
  card('comissoes','Comissões',{subs:[['complementar','Relatório Complementar de Comissões']]}),
  card('checkout','Checkout de Pedidos de Venda',{subs:[['produto_unico','Checkout por produto único'],['correcao','Permitir a correção de leituras'],['leitura_manual','Permitir a leitura manual dos itens'],
   ['automacoes','Automações no Checkout'],['separacao','Relatório de Separação']]}),
  card('controle_caixa','Controle de Caixa',{ie:true,ex:true,subs:[['caixas_unicos','Configurações de usuários com caixas únicos'],['relatorio','Relatório de Controle de Caixa']]}),
 ])}),
 Object.freeze({id:'financas',label:'Finanças',cards:Object.freeze([
  card('caixas_bancos','Caixas e Bancos',{ie:true,ex:true,subs:[['transferencia','Transferência entre contas'],['balancete','Balancete'],['dre','DRE'],['fluxo','Fluxo de Caixa'],['resumo_categoria','Resumo por Categoria'],['resumo_cliente','Resumo por Cliente']]}),
  card('contas_pagar','Contas a Pagar',{ie:true,ex:true,subs:[['cancelar','Cancelar'],['baixar','Baixar'],['relatorio','Relatório de Pagamentos']]}),
  card('contas_receber','Contas a Receber',{ie:true,ex:true,subs:[['cancelar','Cancelar'],['baixar','Baixar'],['relatorio','Relatório de Recebimentos']]}),
  card('remessas','Remessas e Retornos',{ie:true,ex:true,subs:[['gerar','Gerar remessas em arquivo']]}),
  card('ficha','Ficha Financeira',{ie:true,ex:true,subs:[['baixar','Baixar contas']]}),
  card('categorias','Categorias Receitas e Despesas',{ie:true,ex:true}),
  card('contas_contabeis','Contas Contábeis',{ie:true,ex:true}),
  card('retornos','Retornos',{ie:true,ex:true}),
  card('faturamento_agrupado','Faturamento Agrupado'),
  card('conciliacao','Conciliação Bancária'),
  card('boletos','Configurações de emissão de boletos'),
 ])}),
 Object.freeze({id:'servicos',label:'Serviços',cards:Object.freeze([
  // 202610200239 (documentos lane): enforced in the OS RPCs (Exclusão stays stored: the OS is not deleted in Brufap).
  card('ordem_servico','Ordem de Serviço',{ie:true,ex:true,applied:true,subs:[['historico_financeiro','Histórico financeiro'],...LANCAR,['situacoes','Gerenciar situações'],['forma_pagamento','Alterar forma de pagamento']]}),
 ])}),
 Object.freeze({id:'preferencias',label:'Preferências',cards:Object.freeze([
  card('central_notificacoes','Central de Notificações',{applied:true,subs:[['novidades','Permitir recebimento das novidades']]}),
  card('campos_customizados','Campos Customizados',{ie:true,ex:true,applied:true,subs:[['contatos','Clientes e Fornecedores'],['importador','Importador'],['os','Ordem de Serviço'],['produtos','Produtos']]}),
  card('gerenciador_transicoes','Gerenciador de transições',{admin:true}),
  card('registro_atividades','Registro de Atividades',{admin:true}),
 ])}),
 Object.freeze({id:'contabilidade',label:'Contabilidade',cards:Object.freeze([card('meu_contador','Espaço Meu Contador',{applied:true})])}),
 Object.freeze({id:'meu_negocio',label:'Meu Negócio',cards:Object.freeze([
  card('dashboard','Dashboard',{applied:true,subs:[['vendedor','Vendas por vendedor'],['canal','Venda canal (24 meses)'],['pedidos','Pedidos de venda'],['novos_recorrentes','Novo x recorrentes'],['metas','Metas'],
   ['estoque_produtos','Estoque de produtos'],['mensal','Mensal'],['diario','Diário'],['margem_sku','Margem por SKU'],['curva_abc','Curva ABC'],['sugestao_compras','Sugestão de compras'],
   ['sem_movimentacao','Sem movimentação'],['previsao_estoque','Previsão de estoque'],['carteira','Atividade da carteira']]}),
 ])}),
 Object.freeze({id:'outros',label:'Outros',cards:Object.freeze([
  card('dados_empresa','Acesso aos dados da empresa',{applied:true,subs:[['gerenciar','Gerenciar dados da empresa']]}),
  card('borderos','Borderos',{ex:true}),
  // 202610200282 (mixed lane, produtos): enforced on every write of Gerenciar grupos de tags and Gerenciar tags.
  card('grupos_tags','Cadastro de grupos de tags',{applied:true}),
  card('tags','Cadastro de tags',{applied:true}),
  card('controle_horarios','Controle de Horários para Login',{admin:true}),
  card('emissao_boletos','Emissão de Boletos'),
  card('etiquetas','Etiquetas customizadas',{admin:true}),
  card('sintegra','Exportação Sintegra'),
  card('gerenciador_arquivos','Gerenciador de Arquivos',{admin:true}),
  card('importacao_nfe_xml','Importação de NFe por XML'),
  card('importacao_pedido_xml','Importação Pedido XML'),
  card('relatorios_customizados','Relatórios customizados',{applied:true}),
  card('usuarios','Usuários e Usuário API',{admin:true}),
  card('dados_basicos','Visualizar os dados básicos da empresa'),
  card('sped','SPED Fiscal'),
 ])}),
]);
// Meu Negócio dashboards of the preferências lane that already follow the permission (the rest stay with the estoque screens).
export const DASHBOARD_PERMISSIONS=Object.freeze({mensal:'mensal',diario:'diario','pedidos-venda':'pedidos','vendas-vendedor':'vendedor','venda-canal':'canal','previsao-estoque':'previsao_estoque',
 'margem-pedido':'margem_sku','novos-recorrentes':'novos_recorrentes','atividade-carteira':'carteira','curva-abc':'curva_abc',metas:'metas'});
// Estoque lane (202610200260): the three Produtos dashboards (/painel-produtos-empresa?painel=) follow their permission too.
export const STOCK_DASHBOARD_PERMISSIONS=Object.freeze({estoque:'estoque_produtos',sugestao:'sugestao_compras','sem-movimentacao':'sem_movimentacao'});
// Produtos lane (wave E, migration 235): the Campos Customizados screen of Produtos (view, Inclusão e edição, Exclusão).
const APPLIED_SUBS=new Set([...[...Object.values(DASHBOARD_PERMISSIONS),...Object.values(STOCK_DASHBOARD_PERMISSIONS)].map(s=>`meu_negocio.dashboard.${s}`),
 'preferencias.campos_customizados.ie','preferencias.campos_customizados.ex','preferencias.campos_customizados.produtos',
 // 202610200239 (documentos lane): the OS keys and "Desconsiderar limite de desconto do vendedor" (pedidos de venda and propostas).
 ...['ie','historico_financeiro','lancar_estoque','lancar_contas','situacoes','forma_pagamento'].map(s=>`servicos.ordem_servico.${s}`),
 'vendas.pedidos_venda.limite_desconto','vendas.propostas.limite_desconto',
 // Leva H, lane acesso (202610210311): the module card and Inclusão e edição of documents, stock and notes; .ie of the catalog.
 'vendas.propostas','vendas.propostas.ie','vendas.pedidos_venda','vendas.pedidos_venda.ie','suprimentos.pedidos_compra','suprimentos.pedidos_compra.ie',
 'suprimentos.controle_estoque','suprimentos.controle_estoque.insercao','vendas.notas_fiscais','vendas.notas_fiscais.ie','suprimentos.notas_entrada','suprimentos.notas_entrada.ie',
 'cadastros.clientes_fornecedores.ie','cadastros.produtos.ie','suprimentos.depositos.ie']);
/** Every key in catalog order: module, .ie, .ex, then sub-permissions. The SQL keeps the same list (a PGlite test compares). */
export const PERMISSION_KEYS=Object.freeze(PERMISSION_TABS.flatMap(t=>t.cards.flatMap(c=>{const base=`${t.id}.${c.key}`;
 return[base,...(c.ie?[`${base}.ie`]:[]),...(c.ex?[`${base}.ex`]:[]),...c.subs.map(s=>`${base}.${s.key}`)];})));
/** Parent of a key (a module key has none). */
export const permissionParent=key=>{const parts=key.split('.');return parts.length>2?parts.slice(0,2).join('.'):null;};
/** How Brufap treats a key today: applied on the server, kept for the Administrador profile, or stored for the module to adopt. */
export function permissionStatus(key){
 const [tab,module]=key.split('.'),c=PERMISSION_TABS.find(t=>t.id===tab)?.cards.find(x=>x.key===module);if(!c)return null;
 if(c.admin)return'admin';if(key===`${tab}.${module}`&&c.applied)return'applied';if(APPLIED_SUBS.has(key))return'applied';return'stored';
}
/** Origin tooltips. */
export function permissionHint(key){
 const [tab,module,extra]=key.split('.'),c=PERMISSION_TABS.find(t=>t.id===tab)?.cards.find(x=>x.key===module);if(!c)return'';
 if(!extra)return`Permite visualizar os registros de ${c.label}`;if(extra==='ie')return`Permite realizar a inserção e a edição de ${c.label}`;if(extra==='ex')return`Permite realizar a exclusão de ${c.label}`;
 const s=c.subs.find(x=>x.key===extra);return s?`Permite ${s.label.charAt(0).toLowerCase()}${s.label.slice(1)} em ${c.label}`:'';
}
/** A saved set is valid when every key is known, distinct, and each child has its module. */
export function permissionsValid(keys){
 if(keys===null)return true;
 if(!Array.isArray(keys)||keys.length>PERMISSION_KEYS.length||new Set(keys).size!==keys.length)return false;
 return keys.every(k=>typeof k==='string'&&PERMISSION_KEYS.includes(k)&&permissionStatus(k)!=='admin'&&(!permissionParent(k)||keys.includes(permissionParent(k))));
}
/** Starting points of the editor ("Perfil modelo"): everything (null) or nothing. */
export const allPermissions=()=>PERMISSION_KEYS.filter(k=>permissionStatus(k)!=='admin');

// ---- Contract of the access controls ----
export class PermissionsContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new PermissionsContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys,...e)=>need(plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),...e);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,TIME=/^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const controlsUuid=v=>typeof v==='string'&&UUID.test(v);
const int=(v,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const stamp=v=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
/** One window: Início and Fim (hh:mm, Início before Fim) and the weekdays (0 = domingo .. 6 = sábado). */
export function windowValid(w){
 return plain(w)&&Object.keys(w).length===3&&TIME.test(w.start)&&TIME.test(w.end)&&w.start<w.end&&Array.isArray(w.days)&&w.days.length>=1&&w.days.length<=7
  &&w.days.every((d,i)=>int(d,0,6)&&(i===0||d>w.days[i-1]));
}
/** A window of Cadastros › Vendedores, with the rule of that screen (erp_catalog.seller_settings): distinct days in any order. */
const sellerWindowValid=w=>plain(w)&&Object.keys(w).length===3&&TIME.test(w.start)&&TIME.test(w.end)&&w.start<w.end&&Array.isArray(w.days)&&w.days.length>=1&&w.days.length<=7
 &&w.days.every(d=>int(d,0,6))&&new Set(w.days).size===w.days.length;
const schedule=(v,...e)=>{exact(v,['enabled','windows'],...e);need(typeof v.enabled==='boolean'&&Array.isArray(v.windows)&&v.windows.length<=WINDOW_LIMIT&&v.windows.every(windowValid)&&(!v.enabled||v.windows.length>0),...e);};
/** POST /v1/usuarios/:id/controles: {command_id, expected_version, data:{user_type, schedule:{enabled, windows}, permissions: null | keys}}. */
export function captureControlsSave(body){
 exact(body,['command_id','expected_version','data'],400,'ERP_INVALID_INPUT');
 need(controlsUuid(body.command_id)&&int(body.expected_version,0),400,'ERP_INVALID_INPUT');
 exact(body.data,['user_type','schedule','permissions'],400,'ERP_INVALID_INPUT');
 need(USER_TYPES.includes(body.data.user_type)&&permissionsValid(body.data.permissions),400,'ERP_INVALID_INPUT');schedule(body.data.schedule,400,'ERP_INVALID_INPUT');
 return Object.freeze({command_id:body.command_id,expected_version:body.expected_version,data:Object.freeze({user_type:body.data.user_type,
  schedule:{enabled:body.data.schedule.enabled,windows:body.data.schedule.windows.map(w=>({start:w.start,end:w.end,days:[...w.days]}))},permissions:body.data.permissions===null?null:[...body.data.permissions]})});
}
function controls(v,target){
 exact(v,['scope','data_mode','target','role','version','user_type','schedule','permissions','seller','updated_at','gate_required']);
 need(v.scope==='access_user_controls'&&v.data_mode==='erp_native'&&v.target===target&&(v.role===null||['admin','consulta','vendas','financeiro','estoque','fiscal'].includes(v.role))&&int(v.version)&&USER_TYPES.includes(v.user_type));
 schedule(v.schedule);need(permissionsValid(v.permissions)&&(v.role!=='admin'||v.permissions===null&&!v.schedule.enabled)&&typeof v.gate_required==='boolean'&&(v.updated_at===null||stamp(v.updated_at)));
 if(v.seller!==null){exact(v.seller,['name','enabled','windows']);need(typeof v.seller.name==='string'&&v.seller.name.length<=200&&typeof v.seller.enabled==='boolean'&&Array.isArray(v.seller.windows)&&v.seller.windows.length<=20&&v.seller.windows.every(sellerWindowValid));}
 return v;
}
export const parseControls=(raw,target)=>{let v;try{v=JSON.parse(JSON.stringify(raw));}catch{return fail();}return controls(v,target);};
export function parseControlsResult(raw,{target,input}){
 let v;try{v=JSON.parse(JSON.stringify(raw));}catch{return fail();}
 exact(v,['scope','data_mode','replayed','receipt','controls']);need(v.scope==='access_controls_command'&&v.data_mode==='erp_native'&&typeof v.replayed==='boolean');
 exact(v.receipt,['command_id','target','changed_at']);need(v.receipt.command_id===input.command_id&&v.receipt.target===target&&stamp(v.receipt.changed_at));
 controls(v.controls,target);
 // jsonb keeps its own key order: windows compare by value, permissions as a set (the server returns them in catalog order).
 const windows=list=>JSON.stringify(list.map(w=>[w.start,w.end,w.days])),keys=p=>p===null?null:JSON.stringify([...p].sort());
 if(!v.replayed)need(v.controls.user_type===input.data.user_type&&v.controls.schedule.enabled===input.data.schedule.enabled&&windows(v.controls.schedule.windows)===windows(input.data.schedule.windows)
  &&keys(v.controls.permissions)===keys(input.data.permissions));
 return v;
}
/** GET /v1/sistema/permissoes: what the signed-in user may open (the screens hide what the server would refuse). */
export function parseMyPermissions(raw){
 let v;try{v=JSON.parse(JSON.stringify(raw));}catch{return fail();}
 exact(v,['scope','data_mode','user_id','role','user_type','permissions','access']);need(v.scope==='access_permissions'&&v.data_mode==='erp_native'&&controlsUuid(v.user_id));
 need(['admin','consulta','vendas','financeiro','estoque','fiscal'].includes(v.role)&&USER_TYPES.includes(v.user_type)&&permissionsValid(v.permissions)&&(v.role!=='admin'||v.permissions===null));
 exact(v.access,['open','until']);need(typeof v.access.open==='boolean'&&(v.access.until===null||stamp(v.access.until)));
 return v;
}
/** Effective check in the browser, the same rule as erp_access.permitted (the server decides). */
export function allowedBy(view,key){if(!view||view.role==='admin'||view.permissions===null)return true;const parent=permissionParent(key);return view.permissions.includes(key)&&(!parent||view.permissions.includes(parent));}
