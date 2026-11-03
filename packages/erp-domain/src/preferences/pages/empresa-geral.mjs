// Preferências > Empresa > Geral (Origin preferencias.php#empresa/empresa-geral).
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{integer,toggle}from'../fields.mjs';
const S='geral';
export default definePage({id:'empresa-geral',category:'empresa',path:'geral',title:'Geral',scope:'company',readRoles:PREFERENCE_READERS.all,subsections:false,
 sections:[{id:S,title:'Geral'}],
 fields:[
  integer('empresa.decimais_quantidade',S,'Número de casas decimais na quantidade',0,10,6,{widget:'select',status:'applied',note:'Aplicada (migração 287) nas quantidades dos pedidos de venda, propostas, ordens de serviço e pedidos de compra, também no servidor. O FAGOO guarda até 6 casas decimais: de 7 a 10, valem 6.'}),
  integer('empresa.decimais_preco_entrada',S,'Número de casas decimais no preço nas entradas',0,10,10,{widget:'select',status:'applied',note:'Aplicada (migração 164) aos pedidos de compra: o preço unitário aceita até este número de casas (também no servidor). A partir da migração 277 vale também em Estoque › Lançamentos de estoque: o Preço de Compra e o Preço de Custo da Entrada e do Balanço (também com Lote) e a alteração do preço de uma entrada no extrato.'}),
  integer('empresa.decimais_preco_saida',S,'Número de casas decimais no preço nas saídas',0,10,10,{widget:'select',status:'applied',note:'Aplicada (migração 164) a pedidos de venda, propostas e OS e às conversões: o preço unitário aceita até este número de casas (também no servidor).'}),
  integer('empresa.decimais_peso',S,'Número de casas decimais no peso do produto',0,5,3,{widget:'select',status:'applied',note:'Aplicada no cadastro de produtos: os pesos aparecem com estas casas decimais e um peso alterado aceita até este número de casas. Nos pedidos, propostas, OS e pedidos de compra (migração 199), o peso bruto aceita e mostra até este número de casas.'}),
  toggle('empresa.nao_enviar_link',S,'Não enviar link no envio de documentos',false,{note:'Guardado. O FAGOO ainda não envia documentos por e-mail.'}),
  toggle('empresa.editar_data_ocorrencia',S,'Permite a edição da data e hora das ocorrências',false,{status:'applied',note:'Aplicada nas ocorrências de pedidos, propostas, OS e pedidos de compra (a partir da migração 163): desligada, a ocorrência registra a data e a hora atuais; ligada, aceita a data e a hora informadas até agora. O horário real do registro continua guardado.'}),
 ]});
