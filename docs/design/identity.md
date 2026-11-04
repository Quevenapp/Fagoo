# Interface do FAGOO

FAGOO é uma área de trabalho para administrar a operação da empresa durante o dia inteiro. A versão 2.0 da interface ("Calmo") prioriza conforto em jornadas longas: superfícies neutras e silenciosas, um único violeta para ações e foco, controles com 14 px e números tabulares. Títulos usam Manrope; texto, formulários e tabelas usam Source Sans 3; os ícones são de traço.

## Princípios

- **Uma ação principal por área.** O violeta marca o botão principal, o link e o foco; o resto da tela fica em neutros.
- **Sequência visível.** Documentos comerciais mostram as etapas na ordem em que o vendedor trabalha e a etapa atual acompanha a rolagem.
- **Teclado primeiro.** Toda ação frequente tem atalho, listado em **Ajuda › Atalhos de teclado** (tecla `?`). Atalhos de uma letra ficam desligados enquanto a pessoa digita.
- **Menos cansaço.** Fundo `#F5F5F8` em vez de branco puro, texto quase preto (`#2B2834`), status em tons suaves, sombras discretas e movimento curto (respeita "reduzir movimento").

## Cores

| Uso | Claro | Escuro |
| --- | --- | --- |
| Fundo | #F5F5F8 | #131218 |
| Superfície | #FFFFFF | #1B1A22 |
| Superfície alternativa | #F2F2F6 | #22212A |
| Bordas | #E6E5EC | #2D2B36 |
| Títulos | #18161F | #F7F5FC |
| Texto | #2B2834 | #E7E4EF |
| Texto secundário | #5F5A6B | #AAA5B8 |
| Texto de apoio | #6E697C | #8F8A9E |
| Ação principal | #5B3DC8 | #A993F6 |
| Texto da ação principal | #FFFFFF | #1A1330 |
| Destaque suave | #EFEBFC | #2B2445 |
| Navegação lateral | #F9F9FB | #16151C |
| Item ativo da navegação | #EBE7FB / #4A2FAE | #2B2445 / #D4C9FC |

Status usam fundo tingido e texto escuro do mesmo tom: sucesso `#1C6B40`/`#E7F4EC`, atenção `#835000`/`#FFF2D6`, erro `#A3261E`/`#FDECEA`, informação `#1B5A8C`/`#E8F1FA`. Cores de situação definidas pela empresa continuam vindo do cadastro de situações. Os gráficos usam violeta, azul petróleo e terracota, acompanhados por rótulos e tabelas. Os pares medidos estão em [contrast.json](contrast.json); essa medição não representa uma avaliação completa de acessibilidade.

## Medidas

| Elemento | Valor |
| --- | --- |
| Texto base, campos e tabelas | 14 px (16 px em telas estreitas, para o celular não ampliar o campo) |
| Altura de campos e botões | 38 px (42 px em telas estreitas); 32 px em ferramentas de tabela |
| Raio | 8 px em controles, 12 px em cartões e painéis |
| Linha de tabela | 46 px, cabeçalho em 12 px semibold |
| Barra superior | 60 px; menu lateral com 248 px |
| Títulos de página | Manrope 24 px, peso 700 |

Os tokens ficam em `apps/erp/src/styles.css` (claro e escuro) e são o contrato de todos os módulos.

## Tipografia, marca e ícones

- Títulos: Manrope variável, pesos 200–800.
- Texto, formulários e tabelas: Source Sans 3 variável, pesos 200–900.
- Fontes servidas pela própria instalação, com licenças e origens em [atribuições](../../THIRD_PARTY_NOTICES.md).
- Marca vetorial em `FagooBrand.tsx` e `public/fagoo-mark.svg`.
- Ícones FAGOO Line: malha de 24 unidades, traço de 1,7, terminações arredondadas e aliases semânticos em `fagoo-icons.ts`.

## Áreas de trabalho

| Família | Organização |
| --- | --- |
| Navegação | Menu lateral claro com o botão **Novo pedido** (quando o perfil pode vender), módulos ordenados pelo perfil (Comercial, Catálogo e Pessoas primeiro para Vendas) e trilha de localização na barra superior |
| Busca de telas e ações | Campo da barra superior (`Ctrl K` ou `/`): sem texto, mostra as ações rápidas; com texto, telas e ações; setas e Enter para escolher |
| Menu **Novo** | Novo pedido, nova proposta e frente de caixa, conforme as permissões |
| Visão geral | Ações rápidas com atalho, indicadores do período, gráfico, detalhamento expansível, acompanhamento e favoritos |
| Listagens | Cabeçalho compacto com Filtros e Ações; busca e tipo de registro na mesma linha; chips, seleção, exportação e ações em lote |
| Pedidos e propostas | Barra fixa com título, situação, total, Cancelar e Salvar; etapas **Cliente → Itens → Pagamento → Entrega → Observações → Operações**; seções numeradas |
| Produtos | Dados principais e navegação vertical por assunto |
| Contatos | Índice lateral com sete seções, transferência de foco e campos em duas colunas |
| Configurações | Busca, categorias em cartões e destinos agrupados |
| Mobile | Menu recolhível, barra do documento não fixa, etapas com rolagem horizontal e tabelas rolando dentro da sua região |

O menu e as ações rápidas recebem apenas destinos já filtrados pelas permissões; cada tela mantém suas validações, mensagens, confirmações e operações. Interações continuam acessíveis por teclado, com foco visível e rótulos que não dependem apenas de ícones ou cores.

## Atalhos de teclado

| Atalho | Ação |
| --- | --- |
| `Ctrl K` ou `/` | Buscar telas e ações |
| `N` | Novo pedido de venda |
| `O` | Nova proposta comercial |
| `G` e uma letra | Ir para: `I` Visão geral, `P` Pedidos, `O` Propostas, `C` Clientes, `A` Catálogo, `E` Estoque, `F` Frente de caixa, `R` Relatórios de vendas |
| `?` | Mostrar os atalhos |
| `Ctrl S` | Salvar o pedido ou a proposta aberta (passa pelas mesmas validações do botão Salvar) |
| `Alt 1…6` | Ir para a etapa do documento e focar o primeiro campo |
| `Alt Z` | Incluir uma linha de item |
| `↓` na busca de cliente ou produto | Abrir a lista de resultados |
| `Alt` + letra | Atalhos próprios da Frente de caixa |

Um pedido novo abre com o foco na busca do cliente. Navegar por atalho com alterações não salvas mostra a mesma confirmação de saída usada pelos links.
