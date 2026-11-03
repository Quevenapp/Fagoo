// Preferências > Suprimentos > Estoque (Origin preferencias.php#suprimento/suprimento-estoque).
// Migration 145 applies most keys to the stock RPCs (see docs/integrations/estoque-origin-paridade.md); the notes say what is
// applied and what is still only stored. Changing status or notes never changes the generated definitions of migration 115.
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{applied,integer,multi,radio,toggle}from'../fields.mjs';
const E='estoque',R='reserva';
export const SALES_SITUATIONS=[['em_aberto','Em aberto'],['atendido','Atendido'],['cancelado','Cancelado'],['em_andamento','Em andamento'],['venda_agenciada','Venda Agenciada'],
 ['em_digitacao','Em digitação'],['verificado','Verificado'],['checkout_parcial','Checkout parcial']];
const on=extra=>({...extra,status:'applied'});
// 299: the sales order status each default option reserves (erp_stock.reserve_statuses, 145). A custom situação based on one of
// them is already reserved when the option is chosen; Venda Agenciada and Checkout parcial have no status in Brufap.
export const SALES_SITUATION_STATUS=Object.freeze({em_aberto:'open',atendido:'fulfilled',cancelado:'cancelled',em_andamento:'in_progress',em_digitacao:'draft',verificado:'verified'});
export default definePage({id:'suprimentos-estoque',category:'suprimentos',path:'estoque',title:'Estoque',scope:'company',readRoles:PREFERENCE_READERS.stock,subsections:false,
 sections:[{id:E,title:'Estoque'},{id:R,title:'Reserva de estoque'}],
 fields:[
  toggle('estoque.exibir_preco_unitario',E,'Exibir campo preço unitário nos lançamentos de estoque manual',false,on({note:'Aplicada no Novo Lançamento e na Transferência entre depósitos. Desligada, os campos de preço e custo não aparecem e o lançamento fica sem preço.'})),
  radio('estoque.tipo_preco_entrada',E,'Tipo do preço unitário para os lançamentos de entrada manual e transferências entre depósitos',
   [['ultima_compra','Preço da última compra'],['compra_fornecedor','Preço de compra (Fornecedor padrão)'],['custo_fornecedor','Preço de custo (Fornecedor padrão)']],'ultima_compra',
   on({hint:'O preço da última compra considera as entradas manuais, os pedidos de compra e as notas de entrada.',
    note:'Aplicada ao preço sugerido da Entrada, do Balanço, da Transferência e da transferência dos produtos selecionados. A última compra vem das entradas manuais, dos lançamentos de pedidos de compra e, a partir da migração 259, das notas de entrada do FAGOO que lançaram o estoque (⋮ Lançar estoque ou o Check-in), pelo preço do item da nota. As opções do fornecedor padrão usam o preço de compra ou de custo do fornecedor padrão da aba Fornecedores do produto; sem esse preço, o campo fica para ser informado.'})),
  toggle('estoque.considerar_balancos',E,'Considerar balanços para o Preço da última compra',false,on({note:'Aplicada: ligada, o preço informado em um Balanço também conta como última compra.'})),
  applied('estoque.negativo',E,'Permite lançar estoque negativo','Política da empresa já aplicada a todos os lançamentos de estoque. A alteração exige motivo e confirmação do administrador.',
   {source:'stock_negative_policy',link:{label:'Alterar em Saldo de abertura e estoque negativo',to:'/estoque-abertura',roles:['admin']}}),
  toggle('estoque.nf_estoque_negativo',E,'Permite geração de NF a partir da venda e ordem de serviço com estoque negativo',false,{hint:'Permite gerar a nota fiscal mesmo que o saldo fique negativo no depósito do documento.',
   status:'applied',note:'Aplicada em "Gerar nota fiscal" do pedido de venda e da ordem de serviço: desligada, a nota não é gerada enquanto algum produto ficaria com saldo negativo no depósito do documento (documentos que já lançaram o estoque não são conferidos de novo).'}),
  radio('estoque.data_lancamento',E,'Ao lançar estoque utilizar data atual ou data entrada/saída',[['data_atual','Data atual'],['data_documento','Data entrada/saída']],'data_atual',{status:'applied',note:'Aplicada (migração 164) ao Lançar estoque de pedidos, OS e pedidos de compra e às transições do Gerenciador: Data entrada/saída usa a Data saída (pedido e OS) ou a Data prevista (compra), senão a data do documento; uma data futura vira a de hoje. No pedido de compra, a partir da migração 277, o recebimento (Lançar estoque pela lista e Recebimentos da compra) não pede a data: usa a de hoje ou a Data prevista do pedido (senão a data do pedido), conferida pelo servidor. A partir da migração 259 vale também no ⋮ Lançar estoque da nota fiscal do FAGOO e no Finalizar do Check-in com lançamento: Data entrada/saída usa a Data de saída/entrada da nota, senão a data de emissão.'}),
  radio('estoque.custo_medio_base',E,'Fazer o cálculo do custo médio com base no preço de compra ou no custo de lançamento',[['preco_compra','Preço de compra'],['custo_lancamento','Custo Lançamento']],'preco_compra',
   on({note:'Aplicada: o custo médio de cada produto é refeito pelo razão a cada entrada com preço (média ponderada pelo saldo) e dá o Valor de Custo do Estoque e a coluna Custo dos dashboards. Trocar a base recalcula com os mesmos lançamentos.'})),
  integer('estoque.cross_docking_dias',E,'Cross-Docking',0,9999,0,{hint:'Dias somados ao prazo de entrega para calcular a data prevista.',status:'applied',note:'Aplicada (migração 164): no pedido de venda, a Data prevista passa a ser a data do pedido mais o Prazo de entrega e o Cross-Docking; ao gerar venda da proposta, também.'}),
  toggle('estoque.estorno_balanco',E,'Considerar estorno para o cálculo do saldo atual se houver balanço após o lançamento original',true,on({hint:'Desativado, o estorno de um lançamento anterior a um balanço fica no histórico sem mudar o saldo atual.',
   note:'Aplicada ao Estornar lançamento do extrato: desligada, o estorno vem com um ajuste de compensação e o saldo atual não muda, mesmo com o produto ou o depósito inativado depois. Um balanço já estornado não conta. A partir da migração 224 vale também para o estorno do lançamento de estoque do pedido de venda, da OS e do pedido de compra e para o estorno de um recebimento de compra: a conferência mostra as posições com o saldo mantido.'})),
  toggle('estoque.reserva_por_situacao',R,'Considerar situações de vendas para obter o saldo atual (Reserva de estoque)',false,on({note:'Aplicada ao Reservado do extrato, a Visualizar vendas e à Sugestão de Compras com Reserva = Sim. Pedidos sem estoque lançado nas situações marcadas ficam reservados; essa reserva não impede lançamentos, e a reserva feita no pedido continua protegendo o saldo.'})),
  multi('estoque.reserva_situacoes',R,'Situações de vendas consideradas',SALES_SITUATIONS,[],{widget:'chips',showIf:{key:'estoque.reserva_por_situacao',equals:true},status:'applied',
   situations:{kind:'sales_orders',bases:SALES_SITUATION_STATUS},
   note:'Venda Agenciada e Checkout parcial não existem no FAGOO e não reservam. A partir da migração 299 a lista também traz as situações personalizadas dos pedidos de venda (Sistema › Gerenciador de transições), e o estoque reserva os pedidos que estiverem nelas (migração 277). Marcar a situação padrão já considera as personalizadas baseadas nela.'}),
  toggle('estoque.reserva_por_deposito',R,'Reserva de estoque por depósito',true,on({hint:'A reserva usa o depósito do pedido; sem depósito, o depósito padrão.',showIf:{key:'estoque.reserva_por_situacao',equals:true},
   note:'Aplicada. Ligada, a reserva vale no depósito do pedido (ou no depósito padrão); desligada, vale para todos os depósitos considerados.'})),
 ]});
