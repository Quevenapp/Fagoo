// Preferências > Finanças > Contas a receber (Origin preferencias.php#financas/financas-contas-receber).
// Left out (payment integrations / Origin Conta): payment link on save, Pix and payment-link charge models and the transaction status e-mail.
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{area,choice,email,emails,info,integer,text,toggle}from'../fields.mjs';
const G='geral',B='boletos',C='cobrancas',K='carta',R='retornos',mail='Guardado. O FAGOO ainda não envia e-mails.';
export default definePage({id:'financas-receber',category:'financas',path:'contas-receber',title:'Contas a receber',scope:'company',readRoles:PREFERENCE_READERS.finance,subsections:false,
 sections:[{id:G,title:'Geral'},{id:B,title:'Envio automático de boletos'},{id:C,title:'E-mails de cobranças'},{id:K,title:'Carta de Cobrança'},{id:R,title:'Leitura de retornos'}],
 fields:[
  toggle('financas.receber_data_baixa',G,'Utilizar data do vencimento do título como data da baixa',false,{note:'Aplicado: a baixa de contas a receber (individual e em lote) começa com “Utilizar data de vencimento” ligado.'}),
  toggle('financas.receber_cabecalho_recibo',G,'Exibir cabeçalho com logo e informações da empresa ao imprimir recibo',false,{note:'Aplicado: o recibo mostra o logo (Empresa › Dados da empresa › Sua marca, a partir da migração 262) e a identificação dos Dados da empresa.'}),
  choice('financas.receber_titulo_credito',G,'Habilitar tipo de título de crédito para impressão',[['duplicata','Duplicata'],['nota_promissoria','Nota Promissória'],['ambos','Ambos']],'duplicata',{note:'Aplicado: define os modelos impressos pelo ⋮ Imprimir duplicata das contas a receber.'}),
  choice('financas.boletos_vinculo',B,'Enviar boletos automaticamente para contas a receber vinculadas com',[['formas_pagamento','Formas de pagamento'],['contas_financeiras','Contas financeiras']],'formas_pagamento',{note:mail}),
  info('financas.boletos_formas',B,'Formas de pagamento','As formas de pagamento com boleto vêm de Cadastros > Formas de pagamento. O envio automático de boletos depende de e-mail, que o FAGOO ainda não envia.'),
  integer('financas.boletos_dias_antes',B,'Dias antes do vencimento',0,365,0,{note:mail}),
  integer('financas.boletos_dias_apos',B,'Dias após o vencimento',0,365,0,{note:mail}),
  toggle('financas.boletos_no_vencimento',B,'No dia do vencimento',false,{note:mail}),
  emails('financas.cobranca_email_copia',C,'E-mail padrão de cópia',{note:mail}),
  text('financas.cobranca_remetente',C,'Nome padrão do remetente',100,{note:mail}),
  email('financas.cobranca_email_resposta',C,'E-mail padrão de resposta',{note:mail}),
  choice('financas.cobranca_email_contato',C,'E-mail do contato',[['principal','E-mail principal'],['nfe','E-mail para envio da NFe'],['nfe_ou_principal','E-mail para envio da NFe ou Principal']],'principal',{note:mail}),
  text('financas.cobranca_boleto_assunto',C,'Assunto padrão do e-mail',100,{group:'Cobrança por boleto',note:mail}),
  area('financas.cobranca_boleto_mensagem',C,'Mensagem padrão',4000,{group:'Cobrança por boleto',note:mail}),
  text('financas.carta_assunto',K,'Assunto',100,{note:mail}),
  emails('financas.carta_email_copia',K,'Email de cópia',{note:mail}),
  text('financas.carta_remetente',K,'Nome do remetente',100,{note:mail}),
  email('financas.carta_email_resposta',K,'Email de resposta',{note:mail}),
  area('financas.carta_mensagem',K,'Mensagem padrão',4000,{note:mail}),
  area('financas.carta_mensagem_inicial',K,'Mensagem inicial',2000,{note:mail}),
  area('financas.carta_mensagem_final',K,'Mensagem final',2000,{note:mail}),
  toggle('financas.carta_observacoes_contato',K,'Adicionar \'Observações\' do contato na mensagem da carta de cobrança',false,{note:mail}),
  toggle('financas.retorno_taxas',R,'Registrar taxas automaticamente referente a boletos pagos e registrados',true,{note:'Guardado. Hoje a leitura do retorno do Itaú já registra a tarifa junto da liquidação; desligar ainda não muda esse comportamento.'}),
 ]});
