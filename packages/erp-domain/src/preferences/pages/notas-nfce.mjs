// Preferências > Notas Fiscais > Configurações de NFC-e (Origin preferencias.php#notas-fiscais/notas-fiscais-nfce-configuracoes/<subsecao>).
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{applied,documents,info,toggle}from'../fields.mjs';
const E='emissao',S='csc',N='numeracao',P='preenchimento';
// Notas lane (wave F): what the NFC-e of the Brufap post today (contas by migration 247, stock by 259), always by the ⋮ of the list.
const FINANCE_ON_EMISSION='Guardado. Hoje as contas a receber das NFC-e do FAGOO são lançadas e estornadas pelo ⋮ Lançar contas / Estornar contas da listagem (migração 247). Como as NFC-e do FAGOO ainda não são transmitidas, elas não são emitidas nem canceladas e nada é lançado nesses momentos.';
const STOCK_ON_EMISSION='Guardado. Hoje o estoque das NFC-e do FAGOO é lançado e estornado pelo ⋮ Lançar estoque / Estornar estoque da listagem (migração 259). Como as NFC-e do FAGOO ainda não são transmitidas, elas não são emitidas nem canceladas e nada é lançado nesses momentos.';
const wired=note=>({status:'applied',note});
export const ENVIRONMENT_TEXT='2 - Homologação (teste). A emissão com valor fiscal (1 - Produção) fica bloqueada até a decisão da troca do módulo fiscal; as notas reais continuam saindo do Origin.';
export default definePage({id:'notas-nfce',category:'notas-fiscais',path:'nfce',title:'Configurações de NFC-e',scope:'company',readRoles:PREFERENCE_READERS.fiscal,subsections:true,
 sections:[{id:E,title:'Configurações de emissão'},{id:S,title:'Código de segurança do contribuinte (CSC)'},{id:N,title:'Configurações de controle de numeração'},{id:P,title:'Configurações de preenchimento'}],
 fields:[
  applied('nfce.ambiente',E,'Tipo de ambiente da NFC-e',ENVIRONMENT_TEXT),
  applied('nfce.versao_layout',E,'Versão do layout','4.00'),
  applied('nfce.disponibilidade',E,'Disponibilidade dos ambientes da SEFAZ SP','A verificação da conexão com a SEFAZ de homologação usa o certificado A1 e fica na tela Conexão com a SEFAZ. A consulta de status do serviço ainda não existe.',{link:{label:'Testar comunicação',to:'/conexao-sefaz',roles:['admin','fiscal']}}),
  toggle('nfce.lancar_contas',E,'Lançar contas ao emitir ou cancelar NFC-e',false,{note:FINANCE_ON_EMISSION}),
  toggle('nfce.lancar_estoque',E,'Lançar estoque ao emitir ou cancelar NFC-e',false,{note:STOCK_ON_EMISSION}),
  info('nfce.csc',S,'Código de Segurança do Contribuinte','O CSC e o ID do CSC são segredos fiscais. Eles serão guardados no cofre fiscal do FAGOO, nunca nesta página, quando o cadastro do CSC existir.'),
  applied('nfce.numeracao',N,'Controle de numeração','Séries de homologação da NFC-e (CNPJ, série e próximo número), mantidas em Séries fiscais. As séries de produção ficam travadas até a decisão da numeração de produção.',{source:'fiscal_numbering_65',link:{label:'Abrir séries fiscais',to:'/numeracao-fiscal',roles:['admin','fiscal']}}),
  toggle('nfce.grupo_combustiveis',P,'Exibir grupo combustíveis',false,wired('Aplicada: mostra a aba Combustível no item das NFC-e do FAGOO.')),
  toggle('nfce.grupo_armamento',P,'Exibir grupo armamento',false,wired('Aplicada: mostra a aba Armamento no item das NFC-e do FAGOO.')),
  toggle('nfce.grupo_veiculos',P,'Exibir grupo veículos',false,wired('Aplicada: mostra a aba Veículo no item das NFC-e do FAGOO.')),
  toggle('nfce.grupo_bebidas',P,'Exibir grupo bebidas',false,{note:'Guardado. O grupo de bebidas ainda não existe no item das notas do FAGOO.'}),
  toggle('nfce.autxml_transportadora',P,'Incluir transportadora como pessoa autorizada',false,{group:'Pessoas autorizadas a acessar o XML',...wired('Aplicada: a transportadora escolhida na NFC-e do FAGOO entra nas pessoas autorizadas a acessar o XML.')}),
  documents('nfce.autxml_pessoas',P,'Pessoas autorizadas a acessar o XML',10,{group:'Pessoas autorizadas a acessar o XML',...wired('Aplicada nas NFC-e novas do FAGOO: a lista é copiada para a aba Pessoas autorizadas a acessar o XML da nota.')}),
 ]});
