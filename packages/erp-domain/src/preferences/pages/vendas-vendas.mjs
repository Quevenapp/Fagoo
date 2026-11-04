// Preferências > Vendas > Vendas (Origin preferencias.php#vendas/vendas-parametros/<subsecao>).
// Left out (loja virtual, marketplace, logística, ordens de produção): número do pedido da loja virtual na listagem, importar endereço de
// entrega (Lojas Virtuais e APIv2), frete pela cotação, bloqueio por ordem de produção, número da loja no checkout, título "Integração",
// "Número loja" e "Nome da loja", e a seção auxiliar "Número loja".
import{definePage,PREFERENCE_READERS,HEADER_TYPES}from'../core.mjs';
import{applied,area,choice,emailBlock,info,integer,multi,radio,toggle,users}from'../fields.mjs';
const C='configuracoes',K='checkout',R='contas-receber',M='email',I='impressao',V='comprovante',P='relatorio-producao';
const YES_OPTIONAL_NO=[['sim','Sim'],['opcional','Opcional'],['nao','Não']];
const print='Guardado. A impressão do pedido de venda ainda usa o modelo padrão do FAGOO.';
// 202610200291: Vendas › Checkout de pedidos follows these options.
const checkout='Aplicada no Checkout de pedidos (migração 291).';
// 202610200129: the comprovante não fiscal (⋮ Imprimir comprovante) follows these options.
const receipt='Aplicada em Imprimir comprovante (não fiscal).';
// 202610200240: the Relatório de produção (⋮ of the pedidos de venda) follows these options.
const production='Aplicada no Relatório de produção (⋮ da listagem de pedidos de venda).';
// 202610200129: the print of the pedido follows the toggles marked applied (the others are kept for later).
const p=(key,label,value=false,used=false)=>toggle(`vendas.imprimir_${key}`,I,label,value,used?{status:'applied',note:'Aplicada na impressão do pedido.'}:{note:print});
export default definePage({id:'vendas-vendas',category:'vendas',path:'vendas',title:'Vendas',scope:'company',readRoles:PREFERENCE_READERS.all,subsections:true,
 sections:[{id:C,title:'Configurações de vendas'},{id:K,title:'Checkout de Pedidos'},{id:R,title:'Lançamento de contas a receber'},{id:M,title:'Envio por E-mail de Pedido de Vendas'},
  {id:I,title:'Configuração de Impressão'},{id:V,title:'Configuração de Impressão do Comprovante'},{id:P,title:'Configuração de Impressão do Relatório de Produção'}],
 fields:[
  applied('vendas.proximo_numero',C,'Próximo número','O próximo número é ajustado pelo administrador; os números já usados não podem ser repetidos.',{link:{label:'Ajustar próximo número',to:'/documentos-empresa?tipo=sales_orders&acao=numeracao',roles:['admin']}}),
  toggle('vendas.vendedor_obrigatorio',C,'Vendedor obrigatório nos pedidos de vendas',false,{status:'applied',note:'Aplicada (migração 164): o pedido exige o Vendedor do cadastro de vendedores (também no servidor e ao gerar venda da proposta).'}),
  area('vendas.observacao_padrao',C,'Observação padrão para os pedidos de vendas',2000,{status:'applied',note:'Aplicada: o pedido novo já começa com esta observação.'}),
  choice('vendas.exibir_detalhes',C,'Exibe campos relativos detalhes da venda nos pedidos',YES_OPTIONAL_NO,'sim',{status:'applied',note:'Aplicada no pedido: Opcional mostra Data saída e Pedido de compra recolhidos; Não os esconde enquanto estiverem vazios.'}),
  choice('vendas.exibir_dados_adicionais',C,'Exibe campos relativos aos dados adicionais nos pedidos',YES_OPTIONAL_NO,'sim',{status:'applied',note:'Aplicada no pedido: Opcional mostra Observações e Observações internas recolhidas; Não as esconde enquanto estiverem vazias.'}),
  choice('vendas.exibir_transportadora',C,'Exibe a transportadora nos pedidos',YES_OPTIONAL_NO,'sim',{status:'applied',note:'Aplicada no pedido: Opcional mostra o transportador recolhido; Não o esconde enquanto estiver vazio.'}),
  choice('vendas.data_parcelas',C,'Data para geração de parcelas',[['data_venda','Data da venda'],['data_saida','Data saída'],['data_prevista','Data prevista']],'data_venda',{status:'applied',note:'Aplicada em Gerar parcelas e na coluna Dias das parcelas do pedido.'}),
  toggle('vendas.ver_contas_receber',C,'Permite a visualização das contas a receber em aberto nos pedidos/notas fiscais',false,{status:'applied',note:'Aplicada nos pedidos de venda: o pedido mostra as contas a receber em aberto do cliente, também para o perfil de vendas. Desde a migração 215, as notas fiscais de saída do FAGOO mostram o mesmo painel na aba Destinatário.'}),
  toggle('vendas.produtos_nao_cadastrados',C,'Permite venda de produtos não cadastrados',true,{hint:'Desativado, o pedido só aceita itens ligados a um produto cadastrado.',status:'applied',note:'Aplicada: desativada, o pedido e a cópia recusam itens sem produto cadastrado (também no servidor).'}),
  toggle('vendas.desmembrar_fisico',C,'Desmembrar produtos com tipo de estoque Físico em uma estrutura na nota fiscal',false,{status:'applied',note:'Aplicada em Gerar nota fiscal do pedido de venda e da OS (migração 254): a composição de estoque Físico (aba Estrutura do produto) vai para a nota como os seus componentes, com a quantidade de cada um e o valor do item dividido pelo preço de venda dos componentes (o total do pedido não muda). Uma estrutura com componente inativo ou excluído não é desmembrada e a nota avisa.'}),
  toggle('vendas.desmembrar_virtual',C,'Desmembrar produtos com tipo de estoque Virtual em uma estrutura na nota fiscal',false,{status:'applied',note:'Aplicada em Gerar nota fiscal do pedido de venda e da OS (migração 254): a composição de estoque Virtual (aba Estrutura do produto) vai para a nota como os seus componentes, com a quantidade de cada um e o valor do item dividido pelo preço de venda dos componentes (o total do pedido não muda). Uma estrutura com componente inativo ou excluído não é desmembrada e a nota avisa.'}),
  toggle('vendas.editar_numero',C,'Editar número do pedido de venda',false,{status:'applied',note:'Aplicada: o número fica editável no pedido; um número já usado vira o próximo número livre, com o aviso "O número do seu pedido foi modificado para".'}),
  toggle('vendas.exibir_totais',C,'Exibir totais em listas de pedidos de venda para os usuários',true,{status:'applied',note:'Aplicada: sem esta opção (ou fora dos usuários marcados), o Valor total some das Informações, da impressão e da planilha da listagem (o servidor deixa de enviá-lo).'}),
  users('vendas.exibir_totais_usuarios',C,'Usuários que visualizam os totais',{hint:'Sem nenhum usuário marcado, todos visualizam os totais.',showIf:{key:'vendas.exibir_totais',equals:true},status:'applied'}),
  toggle('vendas.somar_peso_bruto',C,'Somar peso bruto dos produtos nos pedidos de vendas',false,{status:'applied',note:'Aplicada: o Peso bruto do pedido passa a ser a soma do peso bruto dos produtos × quantidade, somente leitura.'}),
  toggle('vendas.gerar_nfe',C,'Gerar NF-e ao incluir pedidos de venda',false,{note:'Guardado. A emissão continua só em homologação até a decisão da troca do módulo fiscal.'}),
  toggle('vendas.frete_primeira_parcela',C,'Cobrar frete na primeira parcela',false,{status:'applied',note:'Aplicada em Gerar parcelas: o frete entra inteiro na primeira parcela.'}),
  toggle('vendas.estoque_negativo',C,'Permite venda de produtos com estoque negativo',false,{status:'applied',note:'Aplicada ao lançamento de estoque do pedido de venda: o saldo só fica negativo com esta opção e a política "Permite lançar estoque negativo" de Preferências > Suprimentos > Estoque ligadas.'}),
  multi('vendas.base_comissao',C,'Adicionais da base de comissão',[['desconto','Desconto'],['frete','Frete'],['icms_st','ICMS ST'],['ipi','IPI'],['taxas_pagamento','Taxas de pagamento']],[],
   {migratedDefaults:[['desconto']],widget:'chips',hint:'Desconto e taxas de pagamento subtraem da base; frete, ICMS ST e IPI somam.',status:'applied',note:'Aplicada (leva H, migração 370): a base padrão passa a ser os itens líquidos após o desconto (Desconto marcado); frete, IPI e ICMS ST só somam e a taxa de pagamento só subtrai quando marcados. A política vale para as vendas confirmadas depois da mudança; cada venda guarda a política, a base e o percentual da sua confirmação comercial.'}),
  applied('vendas.situacao_aprovacao_desconto',C,'Situação para aprovação de descontos','Aplicada (migração 239): o pedido de venda de um vendedor com desconto acima do Limite de desconto vai para Em digitação na primeira situação personalizada escolhida (até cinco, de Em digitação), com a ocorrência "Venda enviada para aprovação do desconto", e só quem tem "Desconsiderar limite de desconto do vendedor" o tira dessas situações. Sem situação escolhida, o pedido acima do limite é recusado; a Frente de caixa, as propostas e as OS continuam recusando.',{link:{label:'Escolher situações',to:'/documentos-empresa?tipo=sales_orders&acao=aprovacao-descontos',roles:['admin']}}),
  radio('vendas.checkout_ordenar',K,'Ordenar itens do checkout por localização',[['crescente','Crescente'],['nao_ordenar','Não ordenar']],'nao_ordenar',{status:'applied',note:checkout}),
  toggle('vendas.checkout_desmembrar',K,'Desmembrar produtos Físico / Virtual em uma estrutura no checkout',false,{status:'applied',note:checkout}),
  toggle('vendas.checkout_picking',K,'Utilizar método picking no checkout',false,{status:'applied',note:checkout}),
  toggle('vendas.checkout_salvar_auto',K,'Salvar automaticamente ao ler todos itens',false,{status:'applied',note:checkout}),
  toggle('vendas.checkout_quantidade',K,'Permite inserir quantidade do item no checkout',false,{status:'applied',note:checkout}),
  toggle('vendas.numero_documento_conta',R,'Utilizar número da venda no número do documento das contas a receber',false,{status:'applied',note:'Aplicada: as contas lançadas pelo pedido recebem o número da venda no Nº documento.'}),
  toggle('vendas.contas_automaticas_pedido',R,'Lançamento automático de contas em Pedidos de Venda',false,{status:'applied',note:'Aplicada (migração 196): ao salvar um pedido numa situação de lançamento (Verificado, Em andamento, Atendido parcialmente, Atendido) ou ao mudar para uma delas, as contas a receber são lançadas na mesma gravação, com as parcelas do pedido (sem parcelas, uma à vista na data do pedido) e com o perfil de quem salva; sem permissão de contas, o pedido é salvo e o aviso diz que nada foi lançado.'}),
  toggle('vendas.contas_automaticas_nota',R,'Lançamento automático de contas em Notas Fiscais',false,{note:'Guardado (leva H, política de contas): salvar o rascunho de uma NF-e nunca lança contas. Quando a emissão em produção existir, a nota autorizada avulsa lançará as contas a receber; a nota gerada de um pedido usa as contas já lançadas pelo pedido.'}),
  ...emailBlock('vendas',M,{subjectLength:50}),
  choice('vendas.imprimir_codigo',I,'Código utilizado na venda detalhada',[['codigo','Código do produto'],['gtin','GTIN produto'],['gtin_tributario','GTIN tributário']],'codigo',{status:'applied',note:'Aplicada na impressão detalhada do pedido.'}),
  choice('vendas.imprimir_ordem',I,'Padrão da ordem de impressão dos itens',[['insercao','Inserção'],['alfabetica','Alfabética'],['localizacao','Localização'],['codigo','Código']],'insercao',{status:'applied',note:'Aplicada: ordem inicial das Opções de impressão e da impressão do pedido.'}),
  multi('vendas.imprimir_titulo',I,'Título',[['numero_pedido','Número pedido']],['numero_pedido'],{widget:'chips',maxItems:2,status:'applied',note:'Aplicada no título da impressão do pedido.'}),
  multi('vendas.imprimir_secao_auxiliar',I,'Seção auxiliar',[['ordem_compra','Número da ordem de compra']],[],{widget:'chips',hint:'Informações exibidas ao lado do título.',status:'applied',note:'Aplicada ao lado do título da impressão do pedido.'}),
  radio('vendas.tipo_cabecalho',I,'Exibir tipo de cabeçalho',HEADER_TYPES,'padrao',{status:'applied',note:'Aplicada (migração 270): Personalizado imprime o pedido de venda com o cabeçalho personalizado (texto formatado editado pelo administrador); Padrão do Sistema, o logotipo e a identificação da empresa. Sem texto personalizado, vale o padrão.'}),
  applied('vendas.cabecalho_personalizado',I,'Cabeçalho personalizado','Texto do cabeçalho impresso quando “Exibir tipo de cabeçalho” é Personalizado.',{link:{label:'Editar cabeçalho personalizado',to:'/documentos-empresa?tipo=sales_orders&acao=cabecalho',roles:['admin']}}),
  p('codigo_barras','Código de barras do código',false,true),
  p('descricao_complementar','Exibir descrição complementar nos itens (impressão normal)',true,true),
  p('localizacao','Exibir localização dos itens na impressão normal',false,true),
  p('rodape','Imprimir rodapé pela impressão normal',false,true),
  p('descricao_fornecedor','Exibir descrição do produto no fornecedor',false,true),
  p('codigo_barras_titulo','Código de barras no número do título',false,true),
  p('ncm','Exibir NCM',false,true),
  p('imagem','Exibir imagem do produto na venda detalhada',false,true),
  p('codigo_cliente','Exibir código do cliente',false,true),
  p('soma_quantidades','Exibir soma das quantidades',false,true),
  p('endereco_alternativo','Substituir endereço do contato com o alternativo',false,true),
  p('numero_item','Exibir número do item',false,true),
  p('desconto_lista','Exibir desconto e preço de lista na impressão detalhada',false,true),
  // Leva H (PRF-133, VND-315): the Marca of the product of the cadastro under each item (pedido de venda and OS); no other column is invented.
  toggle('vendas.imprimir_colunas_pecas',I,'Exibir colunas adicionais para Peças',false,{status:'applied',note:'Aplicada na impressão do pedido e da OS: mostra a Marca do produto em cada item. Fabricante, referência e aplicação dependem de campos que o cadastro ainda não tem.'}),
  toggle('vendas.comprovante_limitar_descricao',V,'Limitar caracteres da descrição (25)',false,{status:'applied',note:receipt}),
  toggle('vendas.comprovante_codigo',V,'Exibir código do produto',false,{status:'applied',note:receipt}),
  toggle('vendas.comprovante_observacao',V,'Exibir observação da venda (100 caracteres)',false,{status:'applied',note:receipt}),
  toggle('vendas.comprovante_comentario',V,'Exibir comentário dos itens',false,{status:'applied',note:receipt}),
  toggle('vendas.comprovante_desconto',V,'Exibir desconto dos itens',false,{status:'applied',note:receipt}),
  area('vendas.comprovante_rodape',V,'Texto padrão para rodapé de comprovante não fiscal',500,{status:'applied',note:receipt}),
  integer('vendas.comprovante_fonte',V,'Tamanho da fonte no comprovante',6,72,12,{status:'applied',note:receipt}),
  toggle('vendas.producao_numero_item',P,'Exibir número do item',false,{status:'applied',note:production}),
  toggle('vendas.producao_endereco_transportadora',P,'Exibir endereço da transportadora',false,{status:'applied',note:production}),
  toggle('vendas.producao_estrutura',P,'Exibir estrutura de itens',false,{status:'applied',note:production}),
  toggle('vendas.producao_dados_cliente',P,'Exibir dados do cliente',false,{status:'applied',note:production}),
  toggle('vendas.producao_descricao_complementar',P,'Exibir descrição complementar do produto',false,{status:'applied',note:production}),
 ]});
