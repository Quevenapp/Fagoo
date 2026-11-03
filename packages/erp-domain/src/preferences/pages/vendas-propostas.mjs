// Preferências > Vendas > Propostas comerciais (Origin preferencias.php#vendas/vendas-propostas-comerciais/<subsecao>).
import{definePage,PREFERENCE_READERS,BOOLEAN_YES_NO,HEADER_TYPES}from'../core.mjs';
import{applied,area,choice,emailBlock,radio,toggle}from'../fields.mjs';
const C='configuracoes',I='impressao',M='email';
const print='Guardado. A impressão da proposta ainda usa o modelo padrão do FAGOO.';
// 202610200129: the print of the proposta follows the toggles marked applied (the others are kept for later).
const p=(key,label,value=false,used=false)=>toggle(`propostas.imprimir_${key}`,I,label,value,used?{status:'applied',note:'Aplicada na impressão da proposta.'}:{note:print});
export default definePage({id:'vendas-propostas',category:'vendas',path:'propostas-comerciais',title:'Propostas comerciais',scope:'company',readRoles:PREFERENCE_READERS.proposals,subsections:true,
 sections:[{id:C,title:'Configurações de propostas comerciais'},{id:I,title:'Configuração de Impressão'},{id:M,title:'Envio por E-mail de Propostas comerciais'}],
 fields:[
  applied('propostas.proximo_numero',C,'Próximo número','O próximo número é ajustado pelo administrador; os números já usados não podem ser repetidos.',{link:{label:'Ajustar próximo número',to:'/documentos-empresa?tipo=sales_proposals&acao=numeracao',roles:['admin']}}),
  toggle('propostas.editar_numero',C,'Editar número da proposta comercial',false,{status:'applied',note:'Aplicada: o número fica editável na proposta; um número já usado é recusado.'}),
  toggle('propostas.exibir_ipi_st',C,'Exibe campos IPI e ST nos pedidos de venda e em propostas comerciais',false,{status:'applied',note:'Aplicada: pedidos e propostas mostram Total do IPI e Total do ICMS ST estimados pela natureza de operação, pelo mesmo cálculo da nota fiscal (sem a opção, só aparecem quando há valor). Com a opção (migração 196), o total do documento soma o IPI e o ICMS ST estimados e as parcelas seguem esse total.'}),
  area('propostas.observacao_padrao',C,'Observação padrão para as propostas comerciais',2000,{status:'applied',note:'Aplicada: a proposta nova já começa com esta observação.'}),
  choice('propostas.exibir_transportadora',C,'Exibe a transportadora nas propostas comerciais',BOOLEAN_YES_NO,'sim',{status:'applied',note:'Aplicada: Não esconde o transportador da proposta enquanto ele estiver vazio.'}),
  toggle('propostas.somar_peso_bruto',C,'Somar peso bruto dos produtos nos pedidos das propostas comerciais',false,{status:'applied',note:'Aplicada: o Peso bruto da proposta passa a ser a soma do peso bruto dos produtos × quantidade, somente leitura.'}),
  toggle('propostas.exibir_totais',C,'Exibir totais em listas de propostas comerciais',true,{status:'applied',note:'Aplicada: desativada, o Valor total some das Informações, da impressão e da planilha da listagem (o servidor deixa de enviá-lo).'}),
  toggle('propostas.proximo_contato_obrigatorio',C,'Tornar campo data do próximo contato obrigatório',false,{status:'applied',note:'Aplicada: a proposta (exceto modelo) só é salva com o próximo contato; o servidor confere.'}),
  toggle('propostas.bloquear_limite_credito',C,'Bloquear a geração da proposta comercial quando o valor total parcelado excede o limite de crédito do cliente',false,{status:'applied',note:'Aplicada (migração 196): ao incluir a proposta, ou quando as parcelas aumentam, a soma das parcelas com as contas a receber em aberto do cliente não pode passar do Limite de crédito do cadastro (Zero ou valor; Sem limite não bloqueia). O administrador grava assim mesmo, como a permissão "Desconsiderar limite de crédito" do Origin.'}),
  toggle('propostas.vendedor_obrigatorio',C,'Vendedor obrigatório',false,{status:'applied',note:'Aplicada (migração 164): a proposta exige o Vendedor do cadastro de vendedores, exceto nos modelos (também no servidor).'}),
  toggle('propostas.data_prevista_prazo',C,'Calcular data prevista a partir do prazo de entrega ao gerar venda',false,{status:'applied',note:'Aplicada: o pedido gerado recebe Data prevista = data + prazo de entrega da proposta.'}),
  p('descricao_complementar','Exibir descrição complementar nos itens das propostas pela impressão normal',true,true),
  p('quantidades','Exibir quantidades',true,true),
  p('valores','Exibir valores totais e unitários',true,true),
  toggle('propostas.enviar_descricao_venda',I,'Enviar informações da descrição detalhada dos produtos para a venda',true,{status:'applied',note:'Aplicada (migração 240): desligada, o pedido de venda aberto pelo Gerar venda começa sem a descrição detalhada dos itens (a OS gerada da proposta continua com ela).'}),
  p('ncm','Exibir NCM dos produtos',false,true),
  p('desconto_lista','Exibir desconto e preço de lista dos itens',false,true),
  p('totais','Exibir valores totais do orçamento',true,true),
  p('aprovacao','Exibir campos de data da aprovação e assinatura do cliente',false,true),
  p('imagem','Exibir imagem de produtos',false,true),
  p('numero_item','Exibir número do item',false,true),
  p('vencimento_parcelas','Exibir data de vencimento das parcelas',false,true),
  radio('propostas.tipo_cabecalho',I,'Exibir tipo de cabeçalho',HEADER_TYPES,'padrao',{status:'applied',note:'Aplicada (migração 270): Personalizado imprime a proposta com o cabeçalho personalizado (texto formatado editado pelo administrador); Padrão do Sistema, o logotipo e a identificação da empresa. Sem texto personalizado, vale o padrão.'}),
  applied('propostas.cabecalho_personalizado',I,'Cabeçalho personalizado','Texto do cabeçalho impresso quando “Exibir tipo de cabeçalho” é Personalizado.',{link:{label:'Editar cabeçalho personalizado',to:'/documentos-empresa?tipo=sales_proposals&acao=cabecalho',roles:['admin']}}),
  ...emailBlock('propostas',M,{copy:'E-mail padrão como cópia'}),
 ]});
