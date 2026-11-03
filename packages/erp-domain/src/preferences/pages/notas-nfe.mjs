// Preferências > Notas Fiscais > Configurações de NF-e (Origin preferencias.php#notas-fiscais/notas-fiscais-nfe-configuracoes/<subsecao>).
// Left out: GNRE and DARE-SP (out of scope) and "Adicionar endereço da etiqueta" (logística).
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{applied,choice,decimal,documents,emailBlock,integer,multi,toggle}from'../fields.mjs';
import{ENVIRONMENT_TEXT}from'./notas-nfce.mjs';
const E='emissao',G='gerais',P='preenchimento',N='numeracao',I='impressao',M='email';
// Notas lane (wave F): what the notes of the Brufap post today. Stock (migration 259) and contas (migration 247) are posted and reversed by
// the ⋮ of the lists, never on emission or cancellation: the notes of the Brufap are not transmitted, so they are never emitted or cancelled.
const STOCK_ON_EMISSION='Guardado. Hoje o estoque das notas do FAGOO (NF-e de saída, NFC-e e NF-e de entrada) é lançado e estornado pelo ⋮ Lançar estoque / Estornar estoque da listagem (migração 259) e, na entrada, também pelo Finalizar do Check-in de Recebimentos. Como as notas do FAGOO ainda não são transmitidas, elas não são emitidas nem canceladas e nada é lançado nesses momentos.';
const FINANCE_ON_EMISSION='Guardado. Hoje as contas das notas do FAGOO (a receber nas NF-e de saída e NFC-e, a pagar nas NF-e de entrada) são lançadas e estornadas pelo ⋮ Lançar contas / Estornar contas da listagem (migração 247), e a NF de entrada nova também pela "Automação lançamento de contas pagar ao criar NF de Entrada". Como as notas do FAGOO ainda não são transmitidas, elas não são emitidas nem canceladas e nada é lançado nesses momentos.';
// Fields the notes of Brufap already follow (migration 202610200140 and the note form); the note says where.
const wired=note=>({status:'applied',note});
const danfe=wired('Aplicada no DANFE impresso pelo FAGOO a partir do XML autorizado (notas do Origin com XML coletado e notas importadas): 0 usa a paginação automática pelas linhas impressas.');
const update=wired('Aplicada em "Importar XML NF-e" das notas de entrada (migração 217): o produto ligado ao item recebe o valor do XML que mudou, pela gravação do cadastro de produtos (com versão e auditoria), para quem cadastra produtos. Atualizar o cadastro pela nota de entrada pode gerar erros: um produto que o cadastro recusa fica como estava e a importação diz quantos foram.');
const NEW_NOTES='Aplicada nas notas novas do FAGOO (testes de homologação e notas registradas).';
const AUTO='Aplicada no cálculo automático das notas do FAGOO.';
export const FREIGHT_MODES=[['0','0 - Contratação do Frete por conta do Remetente (CIF)'],['1','1 - Contratação do Frete por conta do Destinatário (FOB)'],['2','2 - Contratação do Frete por conta de Terceiros'],
 ['3','3 - Transporte Próprio por conta do Remetente'],['4','4 - Transporte Próprio por conta do Destinatário'],['9','9 - Sem Ocorrência de Transporte']];
export default definePage({id:'notas-nfe',category:'notas-fiscais',path:'nfe',title:'Configurações de NF-e',scope:'company',readRoles:PREFERENCE_READERS.fiscal,subsections:true,
 sections:[{id:E,title:'Configurações de emissão'},{id:G,title:'Configurações gerais'},{id:P,title:'Configurações de preenchimento'},{id:N,title:'Configurações de controle de numeração'},
  {id:I,title:'Configurações de impressão'},{id:M,title:'Configurações de email'}],
 fields:[
  applied('nfe.ambiente',E,'Tipo de ambiente da NF-e',ENVIRONMENT_TEXT),
  applied('nfe.versao_layout',E,'Versão do layout','4.00'),
  applied('nfe.disponibilidade',E,'Disponibilidade dos ambientes da SEFAZ SP','A verificação da conexão com a SEFAZ de homologação usa o certificado A1 e fica na tela Conexão com a SEFAZ. A consulta de status do serviço ainda não existe.',{link:{label:'Testar comunicação',to:'/conexao-sefaz',roles:['admin','fiscal']}}),
  applied('nfe.busca_recebidas',G,'Ativar busca automática de NF-es recebidas na SEFAZ','A coleta de NF-e recebidas continua desligada durante a convivência: o NFStock do contador consome a mesma sequência na SEFAZ.',{link:{label:'Abrir notas fiscais de entrada',to:'/notas-recebidas',roles:['admin','fiscal','consulta']}}),
  toggle('nfe.exibir_totais',G,'Exibir totais em listas de Notas Fiscais',true,wired('Aplicada nas listas de notas de saída, NFC-e e entrada: desligada, as Informações deixam de mostrar a quantidade e o valor total.')),
  toggle('nfe.lancar_estoque',G,'Lançar estoque ao emitir ou cancelar nota',false,{note:STOCK_ON_EMISSION}),
  toggle('nfe.lancar_contas',G,'Lançar contas ao emitir ou cancelar nota',false,{note:FINANCE_ON_EMISSION}),
  toggle('nfe.marcar_envio_email',G,'Marcar envio de e-mail ao emitir nota manualmente',false,{note:'Guardado. O FAGOO ainda não envia e-mails.'}),
  toggle('nfe.data_venda_parcelas',G,'Considerar a data da venda nas parcelas',false,wired('Aplicada em "Gerar nota fiscal" do pedido de venda (migração 215): ligada, as parcelas da nota mantêm os vencimentos do pedido; desligada, cada parcela mantém os dias depois da data do pedido, contados da data da nota.')),
  toggle('nfe.data_os_parcelas',G,'Considerar a data da ordem de serviço nas parcelas',false,wired('Aplicada em "Gerar nota fiscal" da ordem de serviço (migração 215), como a da venda: ligada, vencimentos da OS; desligada, os dias depois da data da OS, contados da data da nota.')),
  choice('nfe.emitir_lote',G,'Emitir NFe automaticamente após geração em lote (Somente Certificado A1)',[['nao_emitir','Não Emitir automaticamente'],['emitir_todas','Emitir para todas as NF-e']],'nao_emitir',{note:'Guardado. "Gerar NF-e dos pedidos selecionados" grava uma nota de homologação por pedido, mas a emissão das notas do FAGOO ainda não existe: nenhuma nota é emitida depois do lote.'}),
  toggle('nfe.email_automatico',G,'Enviar e-Mail após emitir NF-e automaticamente (Somente Certificado A1)',false,{note:'Guardado. O FAGOO ainda não envia e-mails.'}),
  toggle('nfe.consulta_automatica',G,'Consultar automaticamente notas em consulta recibo/protocolo',false,{note:'Guardado. Hoje a consulta de recibo é feita pela ação no rascunho fiscal.'}),
  toggle('nfe.bloquear_edicao_estoque',G,'Bloquear edição da nota quando o estoque foi lançado pela venda',false,wired('Aplicada nas notas do FAGOO ligadas a um pedido de venda que já lançou o estoque: itens e pedidos de origem ficam só em leitura, e o banco recusa a alteração.')),
  toggle('nfe.bloquear_edicao_contas',G,'Bloquear edição da nota quando a conta foi lançada pela venda',false,wired('Aplicada nas notas do FAGOO ligadas a um pedido de venda que já lançou a conta: parcelas e pedidos de origem ficam só em leitura, e o banco recusa a alteração.')),
  toggle('nfe.contas_pagar_entrada',G,'Automação lançamento de contas pagar ao criar NF de Entrada',false,wired('Aplicada (migração 247): ao gravar uma NF de entrada nova do FAGOO, as contas a pagar são lançadas pelas parcelas da nota na mesma gravação, com o perfil de quem grava (administrador ou financeiro). A nota que não pode lançar (pedido de compra com contas, parcelas que não somam o total, perfil sem contas) é gravada sem contas.')),
  toggle('nfe.estoque_checkin',G,'Lançar estoque ao finalizar Check-in na NF de Entrada',false,wired('Aplicada a partir da migração 259: o Finalizar do Check-in de Recebimentos já vem com “Lançar estoque ao finalizar Check-in” marcado, e o mesmo comando finaliza o check-in e lança a entrada da Qtde Recebida no depósito escolhido. A opção pode ser desmarcada no Finalizar; uma nota que já lançou o estoque (pela nota ou pela referência) não lança de novo.')),
  choice('nfe.frete_por_conta',P,'Padrão do campo frete por conta',FREIGHT_MODES,'9',wired(`${NEW_NOTES} Os pedidos de venda seguem a configuração própria de vendas.`)),
  decimal('nfe.markup',P,'Markup para formação do preço de venda',{min:0,max:99999,scale:2},'0',{hint:'Percentual sobre o custo usado para sugerir o preço de venda na entrada.',
   ...wired('Aplicada na Formação de preços das notas de entrada do FAGOO, como sugestão; a gravação do preço fica no cadastro de produtos.')}),
  integer('nfe.volume_padrao',P,'Quantidade de volume padrão',0,99999,0,wired(`${NEW_NOTES} Zero deixa a quantidade em branco.`)),
  choice('nfe.especie_padrao',P,'Informação padrão para o campo Espécie',[['outros','Outros(s)'],['volumes','Volume(s)'],['unidades','Unidade(s)'],['caixas','Caixa(s)'],['pacotes','Pacote(s)'],['envelopes','Envelope(s)']],'volumes',wired(NEW_NOTES)),
  toggle('nfe.ipi_primeira_parcela',P,'Cobrar IPI na primeira parcela',false,wired('Aplicada em "Gerar parcelas" das notas do FAGOO: o IPI vai inteiro na primeira parcela.')),
  toggle('nfe.st_primeira_parcela',P,'Cobrar ICMS ST na primeira parcela',false,wired('Aplicada em "Gerar parcelas" das notas do FAGOO: o ICMS ST vai inteiro na primeira parcela.')),
  toggle('nfe.base_comissao_total',P,'Considerar total da nota como base de comissão',false,wired('Aplicada em Financeiro > Comissões (migração 248): as contas lançadas por uma NF-e de saída com Vendedor geram a comissão com o total da nota como base; desligada, a base são os produtos da nota com os adicionais de Preferências > Vendas (desconto, frete, ICMS ST e IPI).')),
  toggle('nfe.rastreio_infcpl',P,'Mostrar código de rastreio nas informações complementares',false,wired(`${AUTO} O texto "Código de rastreio" entra nas informações complementares.`)),
  toggle('nfe.somar_peso',P,'Somar peso dos produtos',false,wired('Aplicada nas notas do FAGOO: os pesos bruto e líquido somam o peso de cada produto vezes a quantidade.')),
  toggle('nfe.calcular_volume',P,'Calcular volume dos produtos',false,wired('Aplicada nas notas do FAGOO: a quantidade de volumes soma os volumes de cada produto vezes a quantidade.')),
  toggle('nfe.desconto_itens',P,'Informar desconto individualmente nos itens',true,wired('Aplicada nas notas do FAGOO: ligada, o desconto é informado em cada item e o desconto da nota é a soma; desligada, o desconto da nota é rateado entre os itens.')),
  toggle('nfe.ordem_compra_infcpl',P,'Adicionar nº da ordem de compra/pedido loja nas informações complementares',false,{hint:'O número do pedido da loja virtual não se aplica ao FAGOO.',
   ...wired(`${AUTO} O texto "Ordem de compra" usa o número do pedido de compra informado nos itens; na nota gerada do pedido de venda, é o Pedido de compra do pedido.`)}),
  toggle('nfe.grupo_combustiveis',P,'Exibir grupo combustíveis',false,wired('Aplicada: mostra a aba Combustível no item das notas do FAGOO.')),
  toggle('nfe.grupo_armamento',P,'Exibir grupo armamento',false,wired('Aplicada: mostra a aba Armamento no item das notas do FAGOO.')),
  toggle('nfe.grupo_veiculos',P,'Exibir grupo veículos',false,wired('Aplicada: mostra a aba Veículo no item das notas do FAGOO.')),
  toggle('nfe.grupo_bebidas',P,'Exibir grupo bebidas',false,{note:'Guardado. O grupo de bebidas ainda não existe no item das notas do FAGOO.'}),
  toggle('nfe.grupo_retencao',P,'Exibir grupo e configurações de retenção de impostos',false,wired('Aplicada: mostra a aba Retenções da nota e do item nas notas do FAGOO.')),
  toggle('nfe.destino_manual',P,'Preencher manualmente Destino da Operação',false,wired('Aplicada nas NF-e do FAGOO (migração 215): ligada, o Cabeçalho mostra Destino da Operação (1 interna, 2 interestadual, 3 exterior), conferido contra o destinatário; 1 - Operação interna não calcula a partilha do DIFAL. Desligada, o destino segue as UFs.')),
  toggle('nfe.mensagem_credito_simples',P,'Mensagem de aproveitamento de crédito do Simples Nacional',false,wired(`${AUTO} Inclui o texto do art. 23 da LC 123/2006 com o valor e a alíquota do crédito.`)),
  multi('nfe.validacao_opcional',P,'Campos com validação opcional',[['parcelas','Parcelas']],[],{widget:'chips',...wired('Aplicada nas notas do FAGOO: sem Parcelas marcado, a nota só é salva quando a soma das parcelas é igual ao total, e o banco confere a mesma regra. Parcelas que seguem as contas já lançadas pelo pedido de venda (com o bloqueio de edição ligado) não são conferidas.')}),
  toggle('nfe.atualizar_ncm',P,'NCM',false,{group:'Automatização de atualização de dados',...update}),
  toggle('nfe.atualizar_gtin',P,'GTIN',false,{group:'Automatização de atualização de dados',...update}),
  toggle('nfe.atualizar_cest',P,'CEST',false,{group:'Automatização de atualização de dados',...update}),
  toggle('nfe.atualizar_descricao_fornecedor',P,'Descrição do fornecedor',false,{group:'Automatização de atualização de dados',...update}),
  toggle('nfe.autxml_transportadora',P,'Incluir transportadora como pessoa autorizada',false,{group:'Pessoas autorizadas a acessar o XML',...wired('Aplicada: a transportadora escolhida na nota do FAGOO entra nas pessoas autorizadas a acessar o XML.')}),
  documents('nfe.autxml_pessoas',P,'Pessoas autorizadas a acessar o XML',10,{group:'Pessoas autorizadas a acessar o XML',...wired(`${NEW_NOTES} A lista é copiada para a aba Pessoas autorizadas a acessar o XML da nota.`)}),
  applied('nfe.numeracao',N,'Controle de numeração','Séries de homologação da NF-e (CNPJ, série e próximo número), mantidas em Séries fiscais. As séries de produção ficam travadas até a decisão da numeração de produção.',{source:'fiscal_numbering_55',link:{label:'Abrir séries fiscais',to:'/numeracao-fiscal',roles:['admin','fiscal']}}),
  integer('nfe.itens_primeira_pagina',I,'Nro de itens impressos na primeira página',0,999,0,{hint:'0 usa a paginação automática.',...danfe}),
  integer('nfe.itens_demais_paginas',I,'Nro de itens impressos nas demais páginas',0,999,0,{hint:'0 usa a paginação automática.',...danfe}),
  toggle('nfe.danfe_simplificado_produtos',I,'Listar produtos no DANFE Simplificado',false,wired('Aplicada no DANFE Simplificado - Etiqueta impresso pelo FAGOO a partir do XML autorizado: ligada, a etiqueta lista código, descrição, quantidade e valor dos produtos.')),
  toggle('nfe.danfe_simplificado_total',I,'Exibir valor total da nota no DANFE Simplificado',false,wired('Aplicada no DANFE Simplificado - Etiqueta impresso pelo FAGOO a partir do XML autorizado: ligada, a etiqueta mostra o valor total da nota.')),
  toggle('nfe.email_transportadora',M,'Enviar e-mail de cópia para a transportadora',false,{note:'Guardado. O FAGOO ainda não envia e-mails.'}),
  toggle('nfe.email_boleto',M,'Enviar junto com a DANFE o boleto das contas lançadas',false,{note:'Guardado. O FAGOO ainda não envia e-mails.'}),
  ...emailBlock('nfe',M,{subject:'Assunto padrão para envio da DANFE',copy:'E-mail padrão como cópia'}),
 ]});
