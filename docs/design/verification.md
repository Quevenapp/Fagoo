# Verificação da proposta visual

2026-11-03 · branch `feat/fagoo-visual-identity`

## Resultado executado

- TypeScript do ERP: aprovado.
- 64 testes selecionados: aprovados. Incluem os seis perfis de navegação, manutenção dos destinos autorizados, 214 aliases de ícones, painéis de filtros/ações, dashboard, cadastros, seletores de documentos, cálculos e recuperação de operações.
- Após os últimos ajustes de busca e do indicador de vendas, 14 testes de navegação/dashboard foram repetidos e aprovados.
- A ampliação do redesenho de contatos/configurações e o reposicionamento da validação do produto foram seguidos por uma bateria de 49 testes de contatos, preferências, acesso e edição de produtos, todos aprovados. Há sobreposição entre as baterias; os números não representam testes distintos somáveis.
- Build de produção e scanner do projeto: aprovados com configuração pública sintética. Não foi realizado deploy.
- A entrada `review.html` e o identificador da fixture local não aparecem no build.
- GitHub Actions: permanecia desativado na verificação.

Os testes antigos que falhavam foram reproduzidos na base 1509174 e corrigidos nas fixtures/expectativas. Os fluxos de negócio não foram modificados para acomodar essas falhas.

## Navegador

Prévia com componentes nativos e dados fictícios, sem backend. Viewports CSS usados: 1440 × 960 e 390 × 844, além da dimensão normal da janela. As capturas principais têm dimensões iguais nos pares; as de contatos/produtos incluem diferenças de recorte da janela de captura e devem ser avaliadas pela composição, não por alinhamento de pixels.

- Menu lateral, abertura/recolhimento dos módulos e busca.
- Filtros e ações reposicionados acima da listagem.
- Produto: abertura do formulário e navegação entre abas com seta para baixo.
- Pedido: resumo com total calculado e acesso às seções.
- Contatos: navegação direta até a seção Financeiro e transferência do foco para a seção escolhida.
- Configurações: categorias em cartões e busca por “estoque” com destinos preservados.
- Contatos/configurações no mobile: `scrollWidth` de 375 px em viewport de 390 px, sem transbordamento horizontal do documento.
- Mobile: sem transbordamento horizontal do documento; tabelas mantêm rolagem dentro da região.
- Escape fecha o menu mobile e devolve foco ao botão de abertura.
- Tema escuro revisado visualmente.
- Comparações da mesma fixture antes/depois: dashboard, menu, produtos, formulário de produto, pedido, contato e configurações.

Os sete pares principais de cores de texto verificados atendem contraste AA para texto normal, conforme [contrast.json](contrast.json). Isso não representa certificação completa de acessibilidade.

## Limites da evidência

O ERP possui outros módulos e estados operacionais. A cobertura visual desta revisão está concentrada nas famílias compartilhadas e nas telas principais acima. Capturas de dados fictícios não comprovam emissão fiscal, conciliação bancária, movimentação real de estoque, integrações ou homologação de todos os estados de cada módulo.

O build preserva assets de versões anteriores para atualização segura, conforme a política existente do projeto. Os avisos dos materiais históricos continuam disponíveis. O Vite apresenta avisos de chunks grandes e de diretivas de dependências; não houve falha de compilação.
