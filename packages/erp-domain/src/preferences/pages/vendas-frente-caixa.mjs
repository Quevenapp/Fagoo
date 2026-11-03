// Preferências > Vendas > Frente de caixa (Origin preferencias.php#vendas/vendas-frente-caixa/<subsecao>).
// Left out: "PIX - Gerar QR Code" and "Pagamento por POS" (payment integrations) and the POS receipt option.
// 202610200204-206: the real Frente de caixa (/frente-caixa-empresa) reads every option below; the SQL of the PDV checks the
// caixa, the caixas únicos, the mesas and the stock options again (erp_pos.sale_write).
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{choice,keymap,multi,radio,toggle,users}from'../fields.mjs';
const G='gerais',I='item',A='atalhos';
const applied=note=>({status:'applied',note});
// Same actions and keys as apps/erp/src/lib/pdv-shortcuts.ts (Origin defaults).
export const PDV_ACTIONS=[['cliente','C','Aba de cliente'],['pagamento','B','Aba de pagamento'],['produto','Z','Aba de produto'],['pesquisa','A','Pesquisa avançada'],['buscar','P','Buscar venda'],
 ['excluir','Q','Excluir'],['fechar','M','Fechar caixa'],['finalizar','S','Finalizar'],['imprimir','I','Imprimir'],['nova','N','Nova venda'],['favoritos','G','Produtos favoritos'],
 ['remover-gtin','R','Remover produto a partir do GTIN'],['sangria',',','Sangria'],['suprimento','.','Suprimento'],['trocar-loja','L','Trocar loja'],['balcao','T','Nova venda balcão'],['mesa','V','Nova venda mesa']];
export const PDV_KEYS=[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',',','.'];
export default definePage({id:'vendas-frente-caixa',category:'vendas',path:'frente-caixa',title:'Frente de caixa',scope:'company',readRoles:PREFERENCE_READERS.pdv,subsections:true,
 sections:[{id:G,title:'Configurações gerais'},{id:I,title:'Configurações do item'},{id:A,title:'Configurações de teclas de atalho'}],
 fields:[
  toggle('pdv.controle_mesas',G,'Utilizar controle de mesas',false,applied('Aplicada: a Frente de caixa ganha a Nova venda mesa (V), a comanda aberta por mesa (Salvar comanda) e Transferir mesa.')),
  toggle('pdv.controle_caixa',G,'Utilizar controle de caixa',false,applied('Aplicada: a venda só é finalizada num caixa aberto do Controle de caixa (Financeiro); a abertura pede a loja e o Troco.')),
  toggle('pdv.dinheiro_cheque',G,'Exibir formas de pagamento Dinheiro e Cheque no Controle de caixa',false,applied('Aplicada no Fechar caixa da Frente de caixa e no Controle de caixa: Dinheiro e Cheque aparecem mesmo sem vendas.')),
  users('pdv.usuarios_caixa_unico',G,'Usuários com caixas únicos',applied('Aplicada: os usuários marcados vendem só no próprio caixa; os demais compartilham o caixa aberto da loja.')),
  choice('pdv.operacao_padrao',G,'Operação padrão ao finalizar venda',[['nenhum','Nenhum'],['gerar_nfce','Gerar NFC-e'],['comprovante','Imprimir comprovante não fiscal'],['pre_venda','Enviar pré-venda'],['nfe_simplificada','Emitir NF-e Simplificada']],'nenhum',
   applied('Aplicada ao finalizar: o comprovante de 80 mm, a pré-venda para o caixa ou a nota a partir do pedido nas notas fiscais. A emissão continua só em homologação até a decisão da troca do módulo fiscal.')),
  choice('pdv.metodo_pagamento',G,'Método de pagamento padrão',[['nenhum','Nenhum'],['pix_qrcode_impresso','PIX - QR Code impresso']],'nenhum',
   applied('Aplicada: o pagamento começa em Pix e, ao finalizar, mostra o QR estático com a chave Pix das configurações da frente de caixa; o recebimento é conferido pelo operador (nenhum banco é chamado).')),
  radio('pdv.ordem_comprovante',G,'Ordem de impressão do comprovante não fiscal',[['alfabetica','Alfabética'],['insercao','Inserção']],'insercao',applied('Aplicada no comprovante da Frente de caixa.')),
  toggle('pdv.desconto_percentual',G,'Utilizar desconto em porcentagem',false,{hint:'Se desativado, o desconto padrão é em reais.',...applied('Aplicada: os descontos do item e da venda começam em %.')}),
  multi('pdv.situacoes_fechamento',G,'Situações da venda consideradas para o fechamento de caixa',[['atendido','Atendido'],['verificado','Verificado']],['atendido','verificado'],
   {widget:'chips',...applied('Aplicada no Total registrado do Fechar caixa e do Controle de caixa.')}),
  toggle('pdv.estoque_negativo',G,'Permite incluir produtos com estoque negativo',false,applied('Aplicada ao incluir o item e ao gravar a venda (saldo físico do depósito). O lançamento do estoque segue também a política de estoque negativo de Suprimentos e de Vendas.')),
  toggle('pdv.bloquear_quantidade_zero',G,'Bloquear vendas com quantidade zero',false,applied('Aplicada: produto com estoque zero no depósito da venda não é incluído nem vendido.')),
  toggle('pdv.desconto_item',I,'Permitir desconto no Item',false,applied('Aplicada: sem a opção, a aba Produto não tem o desconto do item.')),
  toggle('pdv.agrupar_itens',I,'Agrupar itens idênticos',false,{hint:'Itens com o mesmo desconto, valor unitário e comentário somam as quantidades.',...applied('Aplicada ao inserir o item na Frente de caixa.')}),
  keymap('pdv.teclas_atalho',A,'Teclas de atalho',{actions:PDV_ACTIONS.map(a=>a[0]),keys:PDV_KEYS,labels:PDV_ACTIONS.map(a=>a[2])},Object.fromEntries(PDV_ACTIONS.map(a=>[a[0],a[1]])),
   applied('Aplicada na Frente de caixa (Alt + tecla; no macOS, Ctrl + Shift + tecla). Trocar loja só aparece com mais de uma loja e Nova venda mesa com o controle de mesas.')),
 ]});
