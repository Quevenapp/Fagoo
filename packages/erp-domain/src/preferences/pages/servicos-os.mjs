// Preferências > Serviços > Ordens de serviço (Origin preferencias.php#servicos/servicos-ordem-servico).
import{definePage,PREFERENCE_READERS,HEADER_TYPES}from'../core.mjs';
import{applied,area,choice,emailBlock,radio,text,toggle}from'../fields.mjs';
const C='configuracoes',L='rotulos',I='impressao',M='email';
const print='Guardado. A impressão da OS ainda usa o modelo padrão do FAGOO.';
const labels='Guardado. Em branco, o editor e a impressão mantêm o rótulo padrão.';
// 202610200129: Dados Gerais and Peças labels are used by the editor and the print; 202610200268: also the Serviços ones (Serviços
// executados grid; Quantidade is the Horas column, Valor the Preço and Observações the Observações do Serviço).
const label=(key,title,group,used=false)=>text(`os.rotulo_${key}`,L,title,40,used?{group,status:'applied',note:'Aplicada no formulário e na impressão da OS. Em branco, vale o rótulo padrão.'}:{group,note:labels});
export default definePage({id:'servicos-os',category:'servicos',path:'ordens-servico',title:'Ordens de serviço',scope:'company',readRoles:PREFERENCE_READERS.services,subsections:false,
 sections:[{id:C,title:'Configurações'},{id:L,title:'Rótulos'},{id:I,title:'Impressão'},{id:M,title:'E-mail'}],
 fields:[
  applied('os.proximo_numero',C,'Próximo número','O próximo número é ajustado pelo administrador; os números já usados não podem ser repetidos.',{link:{label:'Ajustar próximo número',to:'/documentos-empresa?tipo=service_orders&acao=numeracao',roles:['admin']}}),
  toggle('os.editar_numero',C,'Editar número da ordem de serviço',false,{status:'applied',note:'Aplicada: o número fica editável na OS; um número já usado vira o próximo número livre (aviso "O número foi modificado para").'}),
  toggle('os.exibir_totais',C,'Exibir totais em listas de OS',true,{status:'applied',note:'Aplicada: desativada, o Valor total some das Informações, da impressão e da planilha da listagem (o servidor deixa de enviá-lo).'}),
  toggle('os.imprimir_localizacao',C,'Exibir a localização dos produtos na impressão',false,{status:'applied',note:'Aplicada na impressão da OS.'}),
  choice('os.data_contas',C,'Utilizar data atual no lançamento de contas de ordens de serviço',[['nao','Não'],['data_atual','Utilizar data atual em todas parcelas'],['recalcular','Recalcular datas das parcelas a partir da data atual']],'nao',{status:'applied',note:'Aplicada no lançamento de contas da OS: a emissão e as parcelas usam a data do lançamento.'}),
  choice('os.garantia_base',C,'Data base da garantia',[['nao_utilizar','Não utilizar garantia'],['data_os','Data da ordem de serviço'],['data_prevista','Data prevista'],['data_conclusao','Data conclusão'],['data_saida','Data de saída']],'nao_utilizar',{status:'applied',note:'Aplicada no filtro Garantia da listagem de OS (Não utilizar mantém a data de saída, senão a da OS) e na data "Garantia até" do formulário e da impressão da OS (Não utilizar não mostra a data). Os itens da OS têm Garantia (dias) própria (migração 287), com a data de término pela mesma base.'}),
  choice('os.data_parcelas',C,'Data para geração de parcelas',[['data_os','Data da ordem de serviço'],['data_saida','Data saída'],['data_prevista','Data prevista']],'data_os',{status:'applied',note:'Aplicada em Gerar parcelas e na coluna Dias das parcelas da OS.'}),
  toggle('os.numero_documento_conta',C,'Utilizar número da OS no número do documento das contas a receber',false,{status:'applied',note:'Aplicada: as contas lançadas pela OS recebem o número da OS no Nº documento.'}),
  toggle('os.desconto_lista',C,'Exibir desconto e preço de lista dos itens',false,{status:'applied',note:'Aplicada no formulário da OS: mostra Desc (%) e o Preço lista (preço do cadastro guardado no item).'}),
  toggle('os.insercao_partes',C,'Inserção de dados da OS por partes',false,{status:'applied',note:'Aplicada: a OS salva mostra o Resumo do recebimento, com Editar dados do recebimento.'}),
  toggle('os.servicos_nfe',C,'Enviar serviços para a nota fiscal eletrônica'),
  toggle('os.vendedor_obrigatorio',C,'Vendedor obrigatório',false,{status:'applied',note:'Aplicada (migração 164): a OS exige o Vendedor do cadastro de vendedores (também no servidor e ao gerar a OS).'}),
  toggle('os.itens_repetidos',C,'Permitir itens repetidos',true,{status:'applied',note:'Aplicada: desativada, a OS recusa o mesmo produto em mais de uma linha (também no servidor).'}),
  area('os.observacao_padrao',C,'Observação padrão para as OS',2000,{status:'applied',note:'Aplicada: a OS nova já começa com esta observação.'}),
  area('os.mensagem_whatsapp',C,'Mensagem padrão para envio de OS por Whatsapp',1000,{status:'applied',hint:'Variáveis: {nome_cliente}, {numero_os}, {data_os}, {data_prevista}, {equipamento}, {numero_serie} e {valor_total}.',note:'Aplicada no ⋮ Enviar por whatsapp da OS; vazia, vale o resumo da OS.'}),
  label('cliente','Cliente','Dados Gerais',true),label('equipamento','Equipamento','Dados Gerais',true),label('numero_serie','Número de série','Dados Gerais',true),label('problema','Problema','Dados Gerais',true),
  label('observacoes_recebimento','Observações de recebimento','Dados Gerais',true),label('peca_descricao','Descrição','Peças',true),
  label('servico_descricao','Descrição','Serviços',true),label('servico_codigo','Código','Serviços',true),label('servico_quantidade','Quantidade','Serviços',true),label('servico_valor','Valor','Serviços',true),
  label('servico_orcar','Orçar','Serviços',true),label('servico_observacoes','Observações','Serviços',true),label('data_entrada','Rótulo para data entrada','Detalhes',true),
  text('os.rotulo_vencimento',I,'Rótulo data de vencimento do pagamento',40,{status:'applied',note:'Aplicada na impressão da OS (coluna do vencimento das parcelas).'}),
  text('os.rotulo_assinatura',I,'Rótulo padrão de assinatura',60,{status:'applied',note:'Aplicada com “Exibir assinatura padrão”.'}),
  toggle('os.ocultar_valores',I,'Ocultar colunas de valores',false,{status:'applied',note:'Aplicada em “Imprimir para técnico”.'}),
  toggle('os.ocultar_cliente',I,'Ocultar dados do cliente',false,{status:'applied',note:'Aplicada em “Imprimir para técnico”.'}),
  toggle('os.imprimir_contatos',I,'Imprimir pessoas de contato',false,{status:'applied',note:'Aplicada: a impressão da OS lista as pessoas de contato do cliente (nome, e-mail e telefones).'}),
  toggle('os.exibir_assinatura',I,'Exibir assinatura padrão',false,{status:'applied',note:'Aplicada: a impressão da OS termina com a linha de assinatura.'}),
  toggle('os.imprimir_desconto_lista',I,'Exibir descontos e preço lista dos itens',false,{status:'applied',note:'Aplicada: a impressão mostra o preço de lista (preço do cadastro guardado no item).'}),
  radio('os.tipo_cabecalho',I,'Exibir tipo de cabeçalho',HEADER_TYPES,'padrao',{status:'applied',note:'Aplicada (migração 270): Personalizado imprime a OS com o cabeçalho personalizado (texto formatado editado pelo administrador); Padrão do Sistema, o logotipo e a identificação da empresa. Sem texto personalizado, vale o padrão.'}),
  applied('os.cabecalho_personalizado',I,'Cabeçalho personalizado','Texto do cabeçalho impresso quando “Exibir tipo de cabeçalho” é Personalizado.',{link:{label:'Editar cabeçalho personalizado',to:'/documentos-empresa?tipo=service_orders&acao=cabecalho',roles:['admin']}}),
  toggle('os.email_anexos',M,'Enviar anexos por e-mail',false,{note:'Guardado. O FAGOO ainda não envia e-mails.'}),
  ...emailBlock('os',M),
 ]});
