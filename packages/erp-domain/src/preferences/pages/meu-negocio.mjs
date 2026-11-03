// Meu Negócio > Ajustes (Origin modal "Configurações Meu negócio" of dashboard.meu.negocio.php). Inserted by migration 150;
// migration 188 adds the tax rate the Margem por Pedido asks for ("Configure sua alíquota de imposto — Ir para ajustes").
// The statuses below are the default "Situação de Venda" of every Meu Negócio dashboard and the only ones Venda Canal reads.
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{applied,decimal,info,multi}from'../fields.mjs';
const S='situacoes',T='impostos';
// Origin order of the Brufap sales order statuses (Venda Agenciada, Faturado parcialmente, Aguardando pagamento, Pagamento
// confirmado and Checkout parcial do not exist in Brufap).
export const BUSINESS_SALES_STATUS_OPTIONS=Object.freeze([['open','Em aberto'],['fulfilled','Atendido'],['cancelled','Cancelado'],['in_progress','Em andamento'],
 ['draft','Em digitação'],['verified','Verificado'],['partially_fulfilled','Atendido parcialmente']]);
export default definePage({id:'meu-negocio',category:'meu-negocio',path:'ajustes',title:'Configurações Meu negócio',scope:'company',readRoles:PREFERENCE_READERS.all,subsections:false,since:'150',
 sections:[{id:S,title:'Situações de pedidos'},{id:T,title:'Impostos'}],
 fields:[
  info('negocio.taxas',S,'Taxas de Marketplace','Marketplaces estão fora do escopo do FAGOO; não há taxas de venda a configurar.'),
  multi('negocio.situacoes_finalizado',S,'Adicione as situações que considera como Pedido Finalizado',BUSINESS_SALES_STATUS_OPTIONS,['fulfilled','in_progress','verified'],
   {status:'applied',note:'Vale para toda a empresa: é a "Situação de Venda" inicial de cada dashboard de Meu Negócio e a única considerada em Venda Canal (24 meses), Previsão de Estoque, Atividade da Carteira e Metas. Sem nenhuma situação marcada, valem Em andamento, Atendido e Verificado.'}),
  info('negocio.integracoes',S,'Configurações de integrações','Lojas virtuais e integrações de marketplace estão fora do escopo do FAGOO.'),
  decimal('negocio.aliquota_imposto',T,'Alíquota de imposto sobre as vendas (%)',{min:0,max:100,scale:2},'0',{since:'188',status:'applied',
   hint:'Percentual sobre o faturamento sem frete de cada pedido, para estimar os impostos.',
   note:'Aplicado em Meu Negócio: IMPOSTOS e LUCRO dos dashboards Mensal e Diário, Impostos e Margem Contribuição % de Vendas por canal e a margem de contribuição da Margem por Pedido. É uma estimativa: não muda a nota fiscal.'}),
 ]});
