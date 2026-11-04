// Leva H, lane plataforma (PRF-255): as novidades do Brufap, mantidas no repositório e publicadas com cada entrega.
// Cada publicação acrescenta uma versão no topo (a mais nova primeiro). Só entra o que o Brufap passou a fazer; nada do Origin.
// O teste release-notes-ui confere ordem, datas e textos.
export interface ReleaseNote { version: string; date: string; title: string; items: readonly string[] }

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  { version: '2026.11.04', date: '2026-11-04', title: 'Conexão opcional persistente e segurança no sincronismo', items: [
    'A configuração privada da integração externa permanece nas atualizações. O administrador acompanha a conexão pelo botão Sincronizar.',
    'Modos de operação: pausado, somente recebimento ou sincronização nos dois sentidos, conforme os recursos do conector.',
    'Entregas sem confirmação exigem conferência antes de novo envio, evitando repetir gravações cuja resposta se perdeu.',
    'Contas, categorias e formas de pagamento exigem vínculos seguros. Parcelas com formas diferentes preservam suas referências.',
    'A numeração local acompanha os documentos recebidos, sem renumerar os existentes.',
    'As notas próprias continuam em homologação; as notas da conexão externa permanecem disponíveis para consulta.',
  ] },
  { version: '2026.11.03', date: '2026-11-03', title: 'FAGOO com instalação própria e início sem dados', items: [
    'Instalação própria com administrador, autenticação, banco e arquivos da empresa.',
    'Cadastros, vendas, compras, estoque e financeiro disponíveis na interface web do FAGOO.',
    'Visão geral preparada para uma empresa nova, com indicadores preenchidos pelos seus registros.',
    'Ferramentas de integrações opcionais aparecem quando habilitadas para a instalação.',
  ] },
  { version: '2026.10.22', date: '2026-10-22', title: 'Sincronização de mão dupla com o Origin; estoque, notas e documentos comerciais do Origin', items: [
    'Botão Sincronizar na barra superior: o que é criado, alterado ou excluído no FAGOO vai para o Origin, e o que muda no Origin chega ao FAGOO. Em conflito, vale a alteração mais recente.',
    'Contatos, produtos, propostas, pedidos de venda e de compra, contas a receber e a pagar (com baixas) e lançamentos de estoque vão e voltam. Ordens de serviço chegam do Origin, mas a API do Origin não permite gravá-las.',
    'Documentos vindos do Origin passam a abrir no editor do FAGOO, com edição, exclusão, situação e lançamentos; o painel da sincronização mostra filas, horários e pendências em linguagem simples.',
    'Controle de estoque mostra os saldos físicos e virtuais observados no Origin por produto e depósito, com origem, horário da leitura e filtros de negativos e pendências.',
    'O espelho preserva o histórico das observações e atualiza em lotes. Dados ausentes aparecem como cobertura parcial; os saldos de origem FAGOO ficam separados.',
    'Notas fiscais de saída, NFC-e e entrada mostram origem Origin, identificação externa, horário da sincronização e cobertura dos XMLs, com consulta mais rápida.',
    'Notas espelhadas ficam somente para consulta. O acesso aos detalhes, relatórios e XMLs respeita a carteira do vendedor; dados incompletos permanecem sinalizados.',
    'Pedidos de venda, propostas, ordens de serviço e pedidos de compra do Origin aparecem nas listas com busca, filtro de origem, impressão e horário da observação.',
    'Documentos do Origin ficam somente para consulta, com valores originais e totais separados. Edição, cópia, conversão e lançamentos operacionais são bloqueados também no banco.',
    'Relatórios e indicadores operacionais identificam os registros do FAGOO e informam quando documentos do Origin ficaram fora do cálculo.',
  ] },
  { version: '2026.10.21', date: '2026-10-21', title: 'Leva H: acesso, plataforma, espelho do Origin, financeiro, documentos e produtos', items: [
    'Central de ajuda do FAGOO no ícone ?, com os principais fluxos, as regras de convivência com o Origin, notas fiscais e naturezas de operação.',
    'Backup e Exportação › Backup: o administrador gera um pacote ZIP com os dados e os arquivos da empresa e baixa por um link de 2 minutos; o pacote fica 7 dias.',
    'Consultar gestão de ações mostra também as tarefas do servidor, com tentativas e histórico.',
    'Notificações internas geradas de hora em hora pelo servidor, sem duplicar avisos.',
    'Tabelas oficiais embarcadas: CNAE 2.3 (IBGE/CONCLA), países da NF-e e municípios do IBGE, com fonte e versão registradas.',
    'CNAE da empresa com sugestões da tabela oficial; País do contato estrangeiro com os nomes e códigos da tabela da NF-e.',
    'Pendências do pedido conferem o Município na tabela do IBGE.',
    'Buscar CEP no endereço de entrega da nota e do pedido (o preenchimento manual continua).',
    'Card Notas Fiscais da página inicial conta as NF-es reais sincronizadas do Origin ou recebidas da SEFAZ desde a sua última visualização.',
    'Segundo fator (aplicativo autenticador), troca da própria senha e recuperação por e-mail; permissões salvas valem também no servidor.',
    'Contatos e produtos mostram os Dados do Origin (origem, id e última sincronização); categorias de produtos sincronizadas do Origin com a hierarquia.',
    'Produtos excluídos no Origin ficam identificados e não voltam sozinhos; notas fiscais mostram o pedido de origem quando o Origin informa.',
    'Relatórios de notas fiscais e de DIFAL a partir das notas reais, com aviso de cobertura parcial em vez de zero.',
    'Salvar rascunho de NF-e não gera contas; uma venda gera as contas uma vez só e a nota do pedido aponta para elas.',
    'Destino Caixa indica a conta prevista sem registrar recebimento; recebimento agrupado mantém cada título.',
    'Comissão calculada sobre os itens líquidos, congelada na confirmação e liberada conforme o recebimento.',
    'Frete cobrado e frete pago separados, com o custo usado em cada operação guardado para a margem.',
    'Gerar nota fiscal parcial: várias notas por pedido, cada uma com as quantidades escolhidas até o saldo de cada item.',
    'IPI e ICMS ST devidos entram sempre no total; o pedido de compra ganhou o Total ICMS ST.',
    'Lixeira de propostas, pedidos e OS sem efeitos: Excluir com motivo e Restaurar.',
    'Técnico da OS sugerido a partir dos contatos do tipo Técnico; etiquetas dos produtos das notas de entrada selecionadas.',
    'Produtos com variações: cada variação é um produto próprio (código, preço, GTIN e estoque) e é ela que se vende.',
    'Localização no comprovante e no relatório de produção conforme as preferências de produtos.',
  ] },
  { version: '2026.10.20', date: '2026-10-20', title: 'Levas A a G: paridade item a item com o Origin', items: [
    'Cadastros, vendas, compras, estoque, financeiro, notas fiscais e preferências reproduzem as telas do Origin item a item.',
    'Emissão fiscal em produção e operações bancárias reais continuam desligadas; as notas do FAGOO ficam em homologação.',
  ] },
];
export const LATEST_RELEASE = RELEASE_NOTES[0]!;
/** Per browser: the last version whose panel the user closed on the home page. */
export const RELEASE_SEEN_KEY = 'brufap.erp.novidades.vista';
export function releaseSeen(storage: Pick<Storage, 'getItem'> | null | undefined) {
  try { return storage?.getItem(RELEASE_SEEN_KEY) === LATEST_RELEASE.version; } catch { return false; }
}
export function markReleaseSeen(storage: Pick<Storage, 'setItem'> | null | undefined) {
  try { storage?.setItem(RELEASE_SEEN_KEY, LATEST_RELEASE.version); } catch { /* Private window: the panel shows again next time. */ }
}
