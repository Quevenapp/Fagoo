# Verificação da primeira versão

Registro de 2 de novembro de 2026 para a versão `0.1.0-alpha.1`. Todos os dados de execução são fictícios. Os resultados abaixo não representam homologação fiscal, bancária ou medição de capacidade na VPS.

| Verificação | Resultado |
|---|---|
| Sintaxe JavaScript | 224 módulos aprovados. |
| Suíte geral Node | 370 casos: 364 aprovados, zero falhas, seis ignorados. |
| Casos em PostgreSQL 17 | 29 aprovados, incluindo as duas verificações de concorrência ignoradas no banco embarcado. |
| Autenticação e integração | Instalação nova, sessão, credencial restrita, revogação, MCP, webhooks administrativos e OAuth com PKCE exercitados em PostgreSQL real dentro da suíte geral. |
| Atualizador Python | Nove testes aprovados de assinatura, pacote, imagem, backup, estado e proteção contra downgrade. |
| Interface e página institucional | Builds aprovados; navegação desktop/mobile, cadastros e fluxos comerciais reais; impressão A4 conferida. |
| Dependências JavaScript de produção | Auditoria sem vulnerabilidades conhecidas no momento da execução. |
| Engine fiscal | XML, assinatura sintética, schemas e composição exercitados offline. Quatro verificações opcionais de snapshots privados não foram executadas. |
| Instalação Ubuntu | Distribuição 24.04 limpa, isolada no WSL2, com systemd e Docker Engine próprios. Dependências, banco, administrador, interface local, atualizador e primeiro backup concluídos. |
| Recuperação | Dump da instalação restaurado em banco separado, conferindo empresa e administrador; banco de teste removido ao concluir. |
| Retomada | Novo acionamento do instalador preserva a instalação concluída. |

O cliente de integração testado executou compra, confirmação física, parcelas, venda, consulta de estoque/movimentos, fornecedores, histórico de preço e confirmação dos eventos usando somente as ferramentas expostas. Isso comprova o contrato do FAGOO; a configuração do container do agente e a qualidade de suas análises exigem avaliação própria.

O teste visual do atualizador verificou o contrato e acompanhamento do estado, sem aplicar uma atualização real pela interface. Os testes do serviço validam a aplicação de pacotes com executores isolados. A primeira release não dispõe de uma versão estável sucessora para um ensaio público de atualização entre versões.

Nenhum recurso Cloudflare foi publicado, nenhum certificado de cliente foi carregado e nenhuma chamada de emissão foi enviada à SEFAZ. O engine mantém os gates de homologação descritos em [engine fiscal](fiscal/engine.md). Consulte também os [limites da implementação](status.md) antes de usar dados operacionais.
