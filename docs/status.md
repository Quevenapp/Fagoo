# Estado da implementação

Esta primeira versão é destinada a avaliação e instalação piloto com dados de teste. O repositório e os pacotes são independentes de qualquer instalação comercial existente.

| Área | Situação |
|---|---|
| Banco e API | PostgreSQL próprio, migrações verificadas, permissões por empresa e operações transacionais implementadas. |
| Compras, vendas, estoque e financeiro | Fluxos de pedido, confirmação, recebimento parcial, entrega, parcelas e estornos implementados; ainda não representam todos os recursos de um ERP completo. |
| Interface | Fluxos reais sobre a API, administração de usuários e integrações, configuração fiscal e atualização. |
| Agentes | REST/OpenAPI e MCP implementados. O container específico do cliente precisa ser configurado e testado com suas ferramentas habilitadas. |
| Documentos recebidos | Importação de XML, validações estruturais, correspondência de produtos e armazenamento privado; assinatura, situação fiscal atual e tributação não são atestadas pelo parser. |
| Engine fiscal | Engine de homologação incorporado: XML 55/65, assinatura local, XSD, regras e composição de autorização. Envio permanece desativado; o diário operacional PostgreSQL e a integração de execução precisam ser concluídos. Veja [engine fiscal](fiscal/engine.md). |
| Emissão e distribuição automática | Dependem da integração operacional do serviço fiscal, certificado, ambiente e homologação. Não estão habilitadas nesta versão. |
| Tributação e NCM | Dados e pendências disponíveis. Não há motor homologado que cubra todos os regimes e operações. |
| Bancos | Perfis só podem ser liberados operacionalmente após homologação. Cadastro de obrigação financeira não é pagamento bancário. |
| Android/iOS | Descoberta, OAuth e PKCE preparados. Aplicativos nativos ainda não são distribuídos. |
| Backup | Dump completo e envio opcional para armazenamento externo. Arquivamento contínuo de WAL/PITR não está implementado; a meta de RPO de 15 minutos não está atendida. |
| Capacidade | Recursos dos containers limitados; a capacidade na VPS de 1 vCPU/4 GB com Hermes em uso precisa de medição no ambiente do cliente. |

As verificações automatizadas incluem regras decimais, isolamento de empresa, permissões, repetição e concorrência de comandos, recebimento parcial, preços, estornos, paginação completa, importação de XML, assinatura de releases e autenticação. Também há ensaio com PostgreSQL 17 e navegação real na interface usando dados fictícios.

O instalador foi exercitado em uma distribuição Ubuntu 24.04 limpa e isolada, com systemd e Docker Engine próprios, no WSL2. O ensaio criou banco, administrador, interface local, serviço de atualização e backup; restaurou o dump em outro banco de teste e verificou a preservação da instalação ao executar o bootstrap novamente. Isso não mede capacidade na VPS nem substitui a restauração no ambiente do cliente, a emissão autorizada pelo serviço fiscal ou a homologação com bancos. Os serviços Cloudflare devem ser configurados somente pelo assistente explicitamente acionado durante a instalação do cliente.
