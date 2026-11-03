# Identidade FAGOO · versão 1

Status: proposta implementada em branch de revisão. Base: `1509174fb4007539fec9816760de9960271d0c09`. Este documento registra decisões de design, não uma publicação em produção.

## Direção

FAGOO é uma área de trabalho para administrar a operação da empresa. A identidade combina grafite, violeta, superfícies claras, tipografia com maior diferenciação entre títulos e dados e ícones de traço. O redesenho altera composição, navegação e hierarquia, mantendo as regras de negócio.

| Uso | Claro | Escuro |
| --- | --- | --- |
| Fundo | #F5F4F8 | #17151E |
| Superfície | #FFFFFF | #211E2B |
| Títulos | #221E30 | #FBF8FF |
| Texto | #393546 | #E5DFF0 |
| Texto secundário | #6A6378 | #B7AEC7 |
| Ação principal | #6941C6 | #B89AF7 |
| Texto da ação principal | #FFFFFF | #211238 |
| Destaque suave | #EFE8FC | #342647 |
| Navegação lateral | #252131 | #252131 |

Verde é reservado para estados semânticos de sucesso. Gráficos usam violeta, azul petróleo e terracota; rótulos e tabelas continuam disponíveis para que a leitura não dependa apenas de cor.

## Tipografia, marca e ícones

- Títulos e marca tipográfica: Manrope variável, pesos 200–800.
- Texto, formulários e tabelas: Source Sans 3 variável, pesos 200–900.
- As fontes são servidas pela própria instalação, sem requisições a serviços de fontes.
- Símbolo: dois percursos deslocados formando um F aberto e um ponto separado. Vetor criado diretamente para o projeto em `FagooBrand.tsx` e `public/fagoo-mark.svg`.
- FAGOO Line: caminhos geométricos originais em uma malha de 24 unidades, traço de 1,7 e terminações arredondadas. Os nomes antigos continuam como aliases para preservar os módulos.
- Ícones históricos de terceiros e fontes anteriores mantêm seus avisos no código e no histórico. O novo componente Icon não importa os caminhos históricos.

Fontes não são autoria do FAGOO. Autores, origem e licenças estão em [atribuições](../../THIRD_PARTY_NOTICES.md).

## Composição

| Família | Decisão |
| --- | --- |
| Navegação | Barra lateral grafite; módulos reorganizados em Resultados, Comercial, Compras, Catálogo, Estoque, Financeiro, Fiscal e Pessoas; busca e ferramentas no cabeçalho |
| Dashboard | Cabeçalho editorial; três indicadores do período quando autorizados; gráfico principal; detalhamento expansível; acompanhamento e favoritos à direita |
| Listagens | Registros ocupam a largura disponível; filtros e operações abrem acima da tabela; chips aplicados permanecem visíveis; seleção, exportação e ações em lote preservadas |
| Cadastro de produto | Dados principais em bloco próprio; navegação vertical por assunto; painéis de características, imagens, estoque, fornecedores e tributação |
| Cadastro de contato | Índice lateral com acesso às sete seções; identificação em bloco próprio; campos distribuídos em duas colunas; foco transferido à seção escolhida |
| Configurações | Busca em destaque; categorias em cartões acima dos destinos agrupados; subseções das regras em navegação horizontal |
| Documentos | Resumo com total calculado e navegação por identificação, itens, pagamento e operações; formulário em área própria; ações de gravação e validações preservadas |
| Mobile | Navegação lateral recolhida; ferramentas acessíveis no cabeçalho; painéis empilhados; tabelas largas mantêm rolagem dentro de sua região |
| Tema escuro | Tokens independentes para superfície, texto, ações, bordas e foco |

As permissões são resolvidas antes da composição do menu. `workspaceMenu` recebe somente os destinos autorizados. Testes com os seis perfis comparam os conjuntos de rotas antes e depois.

## Componentes e limites

`OriginTopBar` mantém o nome de arquivo para compatibilidade de imports; sua composição visual foi substituída. `NativeListLayout` mantém os contratos de filtros, ações e conteúdo. A camada `fagoo-system.css` fornece o acabamento comum; componentes específicos continuam responsáveis por estados de erro, validação e regras de negócio.

O redesenho não modifica schema, contratos de API, autenticação, integrações, cálculos monetários ou confirmações operacionais. Isso deve continuar sendo verificado por testes de regressão; uma captura de tela não prova equivalência funcional.

## Revisão reproduzível

1. Instale as dependências conforme o manual.
2. Execute `npm run dev:erp`.
3. Abra `http://127.0.0.1:5173/review.html`.
4. Use `?screen=products` para produtos, `?screen=contact` para o cadastro de contato, `?screen=order` para o pedido e `?screen=settings` para configurações.
5. Compare com a mesma fixture aplicada à base 1509174, sem alterar seus componentes visuais.
6. Confira desktop, mobile, tema escuro, foco, Escape, menus, filtros e navegação por teclado.

Essa entrada usa componentes nativos e dados fictícios. Não possui conexão de rede com a API, não grava dados e não faz parte dos arquivos de entrada do build de produção. Consultas adicionais não simuladas podem mostrar estados de indisponibilidade. Ela cobre as telas principais da revisão e não substitui a homologação operacional de todos os módulos.
