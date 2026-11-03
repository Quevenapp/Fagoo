// Leva H, lane plataforma (PRF-287, NFE-187, NFE-222): a Central de ajuda do Brufap, numa rota interna (/ajuda), mantida no
// repositório. Descreve só o que o Brufap faz hoje. Os links oficiais (Portal da NF-e, IBGE) complementam os temas fiscais;
// o manual do Origin não é usado como instrução, porque as telas e os comportamentos diferem.
export interface HelpLink { label: string; to?: string; href?: string }
export interface HelpSection { title: string; paragraphs: readonly string[]; links?: readonly HelpLink[] }
export interface HelpTopic { slug: string; title: string; summary: string; sections: readonly HelpSection[] }

export const OFFICIAL_LINKS = {
  portalNfe: { label: 'Portal Nacional da NF-e', href: 'https://www.nfe.fazenda.gov.br/portal/principal.aspx' },
  nfeDocs: { label: 'Portal da NF-e › Documentos (manuais, notas técnicas e tabelas)', href: 'https://www.nfe.fazenda.gov.br/portal/listaSubMenu.aspx?Id=04BIflQt1aY=' },
  cfop: { label: 'Portal da NF-e › Diversos (tabela de CFOP e demais tabelas)', href: 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=/NJarYc9nus=' },
  concla: { label: 'IBGE/CONCLA › CNAE', href: 'https://concla.ibge.gov.br/' },
} as const satisfies Record<string, HelpLink>;

export const HELP_TOPICS: readonly HelpTopic[] = [
  { slug: 'primeiros-passos', title: 'Primeiros passos', summary: 'Como entrar, encontrar as telas e o que cada perfil pode fazer.', sections: [
    { title: 'Entrar e sair', paragraphs: [
      'Entre com o e-mail e a senha do convite. Esqueceu a senha? Use "Esqueci minha senha" na tela de acesso: o e-mail de recuperação abre a página de definir uma senha nova.',
      'Se a empresa exigir o segundo fator, o FAGOO pede o código do aplicativo autenticador depois da senha. Perdeu o celular? O administrador redefine o seu segundo fator em Preferências › Sistema › Usuários.',
    ], links: [{ label: 'Minha conta e segurança', to: '/empresa-configuracoes' }] },
    { title: 'Encontrar uma tela', paragraphs: [
      'O menu do topo segue a organização do Origin: Cadastros, Suprimentos, Vendas, Finanças, Serviços e Notas Fiscais. A busca "Pesquisar" encontra qualquer tela pelo nome.',
      'O ícone de engrenagem abre as Preferências. O menu do usuário traz Dados da empresa, Consultar gestão de ações e Armazenamento.',
    ] },
    { title: 'Perfis', paragraphs: [
      'Administrador vê e altera tudo. Consulta lê cadastros, documentos, estoque, finanças e notas, sem alterar. Vendas, Financeiro, Estoque e Fiscal alteram só o próprio módulo.',
      'As permissões gravadas em Preferências › Sistema › Usuários valem no servidor e no banco, não só na tela: uma ação recusada mostra o motivo.',
    ], links: [{ label: 'Usuários e permissões', to: '/preferencias/sistema/usuarios' }] },
  ] },
  { slug: 'convivencia', title: 'Convivência com o Origin', summary: 'FAGOO e Origin sincronizados nos dois sentidos: use qualquer um dos dois.', sections: [
    { title: 'Sincronização de mão dupla', paragraphs: [
      'O que é criado, alterado ou excluído no FAGOO vai para o Origin, e o que muda no Origin chega ao FAGOO, não importa onde o registro nasceu. Em conflito, vale a alteração mais recente.',
      'Vão e voltam: contatos, produtos, propostas, pedidos de venda e de compra, contas a receber e a pagar com as baixas, e os lançamentos de estoque. Ordens de serviço chegam do Origin, mas a API do Origin não permite gravá-las.',
      'O envio e o recebimento rodam sozinhos a cada dois minutos. O botão Sincronizar, na barra superior, faz uma rodada completa na hora: envia a fila, procura no Origin o que foi criado ou excluído lá e aplica tudo. O painel mostra o que está na fila e as pendências.',
    ] },
    { title: 'Cuidados', paragraphs: [
      'Um efeito nasce uma vez: lance estoque e contas de um pedido em um dos dois sistemas, não nos dois. No Origin, desligue as ações automáticas de estoque e contas nas mudanças de situação dos pedidos.',
      'Estorno de baixa feito no FAGOO precisa ser repetido no Origin, porque a API do Origin não estorna baixas. O painel avisa quando isso acontece.',
      'Movimentos de estoque só vão ao Origin em depósitos vinculados a um depósito do Origin.',
    ] },
    { title: 'O que continua desligado', paragraphs: [
      'Emissão fiscal em produção e operações bancárias reais (remessa, boleto e Pix) continuam no Origin. As notas emitidas pelo FAGOO ficam em homologação, sem valor fiscal; o FAGOO nunca escreve notas no Origin.',
    ] },
  ] },
  { slug: 'notas-fiscais', title: 'Manual de notas fiscais', summary: 'As notas do Origin, os rascunhos de homologação e as notas recebidas.', sections: [
    { title: 'As duas visões', paragraphs: [
      '"Notas do Origin" lista as notas sincronizadas do Origin, com situação, XML e DANFE quando o XML autorizado está no acervo. É a visão de consulta durante a convivência.',
      '"Notas do FAGOO" lista os rascunhos e as notas de homologação criadas aqui, por pedido, por importação ou à mão. Elas não têm valor fiscal e não aparecem nos relatórios de produção.',
    ], links: [{ label: 'Notas fiscais de saída', to: '/historico-fiscal?modelo=55' }, { label: 'Notas de entrada', to: '/notas-entrada' }] },
    { title: 'Situações e o card da página inicial', paragraphs: [
      'O card "Notas Fiscais" da página inicial conta só notas reais desde a sua última visualização: as autorizadas ou com DANFE emitido sincronizadas do Origin e as recebidas da SEFAZ pela Distribuição DF-e. Rascunhos e homologação não entram.',
    ] },
    { title: 'Parâmetros', paragraphs: [
      'Série, numeração de homologação, natureza padrão e textos ficam em Preferências › Notas fiscais. O certificado A1 fica em custódia própria; a conexão com a SEFAZ só usa o ambiente de homologação.',
    ], links: [{ label: 'Parâmetros de nota fiscal', to: '/preferencias/notas-fiscais/nfe' }, { label: 'Naturezas de operação', to: '/naturezas-operacao' }] },
    { title: 'Referências oficiais', paragraphs: ['O leiaute, as regras de validação e as tabelas da NF-e são os publicados no Portal Nacional da NF-e.'],
      links: [OFFICIAL_LINKS.portalNfe, OFFICIAL_LINKS.nfeDocs] },
  ] },
  { slug: 'naturezas-operacao', title: 'Manual de operações fiscais', summary: 'Como as naturezas de operação definem CFOP e tributação das notas do FAGOO.', sections: [
    { title: 'O que é uma natureza', paragraphs: [
      'A natureza de operação descreve a operação da nota (venda, devolução, remessa) e guarda as regras que preenchem CFOP, situação tributária e alíquotas dos itens.',
      'Cada nota usa a natureza escolhida ou a padrão das preferências. Alterar uma natureza não muda notas já gravadas.',
    ], links: [{ label: 'Naturezas de operação', to: '/naturezas-operacao' }] },
    { title: 'Regras e revisão', paragraphs: [
      'As regras tributárias ficam para a revisão do contador antes de qualquer emissão em produção. Enquanto isso, as notas do FAGOO seguem em homologação.',
      'O CFOP deve existir na tabela oficial vigente; a escolha entre operação interna (5xxx), interestadual (6xxx) e exterior (7xxx) depende da UF do destinatário.',
    ], links: [{ label: 'Parâmetros de operações fiscais', to: '/preferencias/notas-fiscais/nfe' }, OFFICIAL_LINKS.cfop] },
  ] },
  { slug: 'exportacao', title: 'Backup e exportação dos dados', summary: 'O pacote ZIP com os dados da empresa e o que fica de fora.', sections: [
    { title: 'Gerar e baixar', paragraphs: [
      'Em Preferências › Backup e Exportação › Backup, o administrador pede a exportação. O servidor gera o pacote em segundo plano; acompanhe em Consultar gestão de ações.',
      'O pacote fica 7 dias numa área privada. Cada download gera um link novo, válido por 2 minutos, só para o administrador.',
    ], links: [{ label: 'Backup', to: '/preferencias/backup/exportacao' }, { label: 'Consultar gestão de ações', to: '/preferencias/sistema/gestao-acoes' }] },
    { title: 'O que vem no pacote', paragraphs: [
      'Um arquivo JSON por tabela da empresa (cadastros, documentos, finanças, estoque, notas, empresa, preferências, frente de caixa, preços, anexos, atividades, cobrança e cópia espelhada do Origin), os arquivos anexados e o manifesto.json com a data, o escopo e o que ficou de fora.',
      'Ficam de fora credenciais, tokens, o cofre do certificado A1 e os usuários do login. Arquivos que passariam do limite de 50 MB do pacote são listados no manifesto.',
    ] },
  ] },
];
export const helpTopic = (slug: string | undefined) => HELP_TOPICS.find(topic => topic.slug === slug) ?? null;
export const HELP_ROOT = '/ajuda';
export const helpHref = (slug: string) => `${HELP_ROOT}/${slug}`;
export const isHelpPath = (pathname: string) => pathname === HELP_ROOT || pathname.startsWith(`${HELP_ROOT}/`);
