# Interface do FAGOO

FAGOO é uma área de trabalho para administrar a operação da empresa. A identidade combina grafite e violeta, superfícies claras, títulos em Manrope, dados em Source Sans 3 e ícones de traço.

## Cores

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

Verde sinaliza sucesso. Os gráficos usam violeta, azul petróleo e terracota, acompanhados por rótulos e tabelas. Os pares de texto medidos estão em [contrast.json](contrast.json); essa medição não representa uma avaliação completa de acessibilidade.

## Tipografia, marca e ícones

- Títulos: Manrope variável, pesos 200–800.
- Texto, formulários e tabelas: Source Sans 3 variável, pesos 200–900.
- Fontes servidas pela própria instalação, com licenças e origens em [atribuições](../../THIRD_PARTY_NOTICES.md).
- Marca vetorial em `FagooBrand.tsx` e `public/fagoo-mark.svg`.
- Ícones FAGOO Line: malha de 24 unidades, traço de 1,7, terminações arredondadas e aliases semânticos em `fagoo-icons.ts`.

## Áreas de trabalho

| Família | Organização |
| --- | --- |
| Navegação | Menu lateral com Resultados, Comercial, Compras, Catálogo, Estoque, Financeiro, Fiscal e Pessoas; busca no cabeçalho |
| Dashboard | Indicadores do período, gráfico principal, detalhamento expansível, acompanhamento e favoritos |
| Listagens | Filtros e operações acima da tabela; chips, seleção, exportação e ações em lote |
| Produtos | Dados principais e navegação vertical por assunto |
| Contatos | Índice lateral com sete seções, transferência de foco e campos em duas colunas |
| Configurações | Busca, categorias em cartões e destinos agrupados |
| Documentos | Resumo, total calculado e navegação por identificação, itens, pagamento e operações |
| Mobile | Menu recolhível, painéis empilhados e rolagem de tabelas dentro de sua região |

O menu recebe os destinos já filtrados pelas permissões. Componentes compartilhados atendem aos temas claro e escuro; cada módulo mantém suas validações, mensagens, confirmações e operações. Interações devem continuar acessíveis por teclado, com foco visível e rótulos que não dependam apenas de ícones ou cores.
