// Central de Notificações (Origin central.notificacoes.php, opened from the bell ⋮ "Configurar notificações"). Inserted by
// migration 151; migration 187 adds "Cliente a ser visitado" and "Produto com data de validade próxima" (their keys come last,
// so the keys of 151 keep their ordinals; the screen NotificationRecipients shows the rows in the Origin order); migration 283 (mixed lane,
// wave F) adds "Lote próximo ao vencimento" from the lots of the stock lane (258), last for the same reason. Each notification
// lists its Destinatários; with nobody chosen the administradores receive it. A recipient whose role does not read the module
// never receives it (finanças, estoque, produtos, contatos or propostas).
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{users}from'../fields.mjs';
const S='notificacoes';
const note='Sem destinatários escolhidos, os administradores recebem. Quem não consulta o módulo da notificação não a recebe.';
export const NOTIFICATION_TYPES=Object.freeze([
 ['contas_pagar_atrasadas','Contas a pagar atrasadas'],['contas_receber_atrasadas','Contas a receber atrasadas'],
 ['estoque_abaixo_minimo','Estoque disponível abaixo do mínimo'],['estoque_maximo','Estoque disponível chegou ao máximo'],['estoque_zerado','Estoque disponível zerado ou negativo'],
 ['pagamento_efetuado','Pagamento efetuado'],['pagamento_recebido','Pagamento recebido'],['proximo_contato','Próximo contato proposta comercial'],
 // 187.
 ['cliente_visitado','Cliente a ser visitado'],['validade','Produto com data de validade próxima'],
 // 187, a Brufap notice beside the Origin types.
 ['certificado_a1','Certificado A1 próximo do vencimento'],
 // 283.
 ['lote_vencimento','Lote próximo ao vencimento'],
]);
const field=([type,label],extra={})=>users(`notificacoes.${type}`,S,label,{status:'applied',note,...extra});
export default definePage({id:'central-notificacoes',category:'sistema',path:'central-notificacoes',title:'Central de Notificações',scope:'company',readRoles:PREFERENCE_READERS.all,subsections:false,since:'151',
 sections:[{id:S,title:'Notificações'}],
 fields:[
  ...NOTIFICATION_TYPES.slice(0,8).map(t=>field(t)),
  field(NOTIFICATION_TYPES[8],{since:'187',hint:'Contatos com Próxima visita no dia (cadastro do contato).'}),
  field(NOTIFICATION_TYPES[9],{since:'187',hint:'Produtos cuja Data de validade vence em até o número de dias de Preferências › Cadastros › Configurações de produtos.'}),
  field(NOTIFICATION_TYPES[10],{since:'187',hint:'O certificado A1 em custódia vence em até 30 dias ou já venceu (só administrador e fiscal recebem).'}),
  field(NOTIFICATION_TYPES[11],{since:'283',hint:'Lotes com saldo cuja Data de validade vence em até o número de dias de Preferências › Cadastros › Controle de lotes.'}),
 ]});
