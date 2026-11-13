# Estado do FAGOO

O FAGOO reúne interface web, API, módulos comerciais, estoque, PDV, financeiro, CNAB, fiscal, preferências e permissões.

## Instalação e atualização

- Núcleo em Docker com PostgreSQL 17, autenticação, PostgREST, armazenamento e gateway restrito ao loopback; imagens fixadas por digest.
- Instalador Ubuntu 24.04, geração privada de credenciais e aplicação das 311 versões do schema com histórico e verificação de hashes.
- Cadastro inicial pelo serviço real de autenticação, com permissão administrativa e marcador que impede repetir o bootstrap.
- Preparação de Node.js e Cloudflare Tunnel, publicação dos Workers web/API e associação dos domínios próprios.
- Assistente de instalação em um comando: pergunta o domínio, um token Cloudflare e o administrador; descobre conta e zona, cria túnel, rota e DNS pela API e retoma a etapa que faltava. Coberto por testes unitários; a execução completa em uma VPS nova ainda precisa ser registrada.
- Atualização pelo painel administrativo com releases públicas assinadas, download sem token GitHub, backup, manutenção, migrações e publicação coordenada na Cloudflare.
- Recuperação explícita da atualização interrompida, verificando backups e preservando os dados anteriores.

## Configuração operacional

A instalação vazia e o atualizador não habilitam automaticamente SMTP, emissão fiscal, certificados, bancos, agentes externos ou rotinas agendadas. Cada módulo exige sua configuração e validação. A descoberta de servidor pelos aplicativos móveis e novos contratos para agentes/filas continuam como evolução do produto.

Valide cadastro da empresa, MFA, recuperação de acesso, SMTP e os módulos utilizados antes da operação. A VPS de referência deve ser medida sob carga, especialmente quando compartilhada com agentes e outros containers. Testes funcionais não constituem um teste de capacidade.

## Contrato da distribuição

O bootstrap cria uma instalação própria, sem dados comerciais de demonstração ou de outra empresa. Catálogos oficiais, permissões e padrões técnicos fazem parte da estrutura. Todas as instalações recebem a mesma distribuição, preservando dados e configurações enquanto aplicam mudanças compatíveis e versionadas do banco.

Consulte a [instalação rápida](operations/quick-install.md), o [manual de instalação](operations/installation.md), o [fluxo de atualização e recuperação](operations/updates.md) e os registros de [verificação](verification.md). A habilitação e homologação de operações fiscais e bancárias permanecem próprias de cada módulo.
