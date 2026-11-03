// Preferências > Finanças > Contas a pagar (Origin preferencias.php#financas/financas-contas-pagar).
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{email,integer,toggle}from'../fields.mjs';
const S='contas-pagar',mail='Guardado. O FAGOO ainda não envia e-mails.';
export default definePage({id:'financas-pagar',category:'financas',path:'contas-pagar',title:'Contas a pagar',scope:'company',readRoles:PREFERENCE_READERS.finance,subsections:false,
 sections:[{id:S,title:'Contas a pagar'}],
 fields:[
  toggle('financas.pagar_cabecalho_recibo',S,'Exibir cabeçalho com logo e informações da empresa ao imprimir recibo',false,{note:'Aplicado: o comprovante de pagamento mostra o logo (Empresa › Dados da empresa › Sua marca, a partir da migração 262) e a identificação dos Dados da empresa.'}),
  toggle('financas.pagar_aviso_vencimento',S,'Avisar por e-mail das contas a pagar na sua data de vencimento',false,{note:mail}),
  toggle('financas.pagar_aviso_antes',S,'Avisar por e-mail das contas a pagar antes da sua data de vencimento',false,{note:mail}),
  toggle('financas.comissoes_contas_pagar',S,'Gerenciar comissões através de contas à pagar',false,{status:'applied',note:'Aplicada em Financeiro > Comissões: o Pagamento de comissões inclui uma conta a pagar ao vendedor em vez do lançamento no caixa.'}),
  integer('financas.pagar_dias_aviso',S,'Dias antes do vencimento da conta a pagar para envio do aviso',0,365,0,{note:mail}),
  email('financas.pagar_email_aviso',S,'Endereço de e-mail para receber os avisos',{note:mail}),
 ]});
