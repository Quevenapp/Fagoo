// Preferências > Cadastros > Controle de lotes (Origin preferencias.php#cadastro/cadastros-configuracoes-lotes).
// Estoque lane (202610200258): the lots exist in the stock (Estoque › Lançamentos de estoque › Lotes e validades and the lot grid of the
// product form); the notes say where each option is applied. Changing status or notes never changes the generated definitions of 115.
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{integer,toggle}from'../fields.mjs';
const S='lotes';
const required=what=>`Aplicada a partir da migração 258: o lote só é gravado com a ${what} ao ser cadastrado (“+ Adicionar lote” do produto e “Novo lote” do Novo Lançamento) e ao salvar os Detalhes de lotes. Lotes gravados antes continuam valendo até serem editados.`;
export default definePage({id:'cadastros-lotes',category:'cadastros',path:'lotes',title:'Controle de lotes',scope:'company',readRoles:PREFERENCE_READERS.products,subsections:false,
 sections:[{id:S,title:'Controle de lotes'}],
 fields:[
  toggle('lotes.validade_obrigatoria',S,'Tornar obrigatório data de validade',false,{widget:'legend',status:'applied',note:required('Data de validade')}),
  toggle('lotes.fabricacao_obrigatoria',S,'Tornar obrigatório data de fabricação',false,{widget:'legend',status:'applied',note:required('Data de fabricação')}),
  integer('lotes.dias_aviso_validade',S,'Número de dias antes da data de validade',0,9999,0,{hint:'A notificação é enviada este número de dias antes da validade do lote.',status:'applied',
   note:'Aplicado a partir da migração 258 na aba Lotes e validades e na grade de lotes do produto: o lote com saldo que vence até este número de dias aparece como “Vence em N dias” (e “Vencido” depois da validade). A partir da migração 283, a notificação “Lote próximo ao vencimento” da Central de Notificações avisa uma vez por dia os lotes com saldo que vencem de hoje até este número de dias (depósitos considerados); não há envio por e-mail.'}),
 ]});
