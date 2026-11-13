# FAGOO

ERP de código aberto para instalação própria. Reúne cadastros, compras, vendas, PDV, estoque, financeiro, cobrança/CNAB, fiscal, preferências e controle de acesso, com interface web e API. Licença [AGPL-3.0](LICENSE).

O FAGOO utiliza PostgreSQL, serviço de autenticação, API de dados, armazenamento de arquivos e serviços de aplicação. Cada instalação mantém sua empresa, usuários, dados, arquivos e credenciais em seu próprio ambiente.

## Instalação própria

A instalação inicial deve criar uma base sem dados comerciais. A empresa e o administrador são cadastrados durante a configuração inicial. Catálogos oficiais e configurações técnicas necessários ao funcionamento fazem parte do sistema; clientes, fornecedores, produtos, documentos, movimentos e saldos de uma empresa não acompanham a distribuição.

A distribuição inclui instalador para Ubuntu 24.04, publicação da interface/API na Cloudflare e atualização pelo painel administrativo. Com um servidor Ubuntu 24.04, um domínio na Cloudflare e um token, a [instalação rápida](docs/operations/quick-install.md) usa um comando:

```sh
curl -fsSL https://raw.githubusercontent.com/Quevenapp/Fagoo/main/scripts/install.sh -o instalar-fagoo.sh
sudo bash instalar-fagoo.sh
```

O assistente baixa a [release estável](https://github.com/Quevenapp/Fagoo/releases) mais recente, pergunta o domínio, o token e os dados do administrador, e continua de onde parou se o comando for repetido. O [manual passo a passo](docs/operations/installation.md) descreve as mesmas etapas uma a uma. O [estado do projeto](docs/status.md) descreve o escopo e as validações operacionais ainda necessárias.

## Desenvolvimento

Use Node.js 24. Para as verificações fiscais completas, use Linux/Ubuntu, OpenSSL 3 e Python com as dependências de `packages/fiscal-schema/requirements.txt`.

```sh
npm ci
npm ci --prefix packages/fiscal-xml --ignore-scripts
npm ci --prefix packages/fiscal-danfe --ignore-scripts
npm ci --prefix workers/erp-api --ignore-scripts
cp apps/erp/.env.example apps/erp/.env.local
npm run dev:erp
```

Preencha somente a configuração pública no frontend. Chaves de serviço, senhas, certificados e tokens de infraestrutura pertencem ao ambiente privado dos serviços. O ambiente de QA e seus dados sintéticos são destinados a desenvolvimento e testes.

Verificações disponíveis:

```sh
npm run typecheck:erp
npm run test:erp
npm run test:backend
npm run build:erp
npm run check:erp:build
```

Para gerar o pacote da interface, consulte o [build de distribuição](docs/operations/release-build.md).

O [guia de verificação](docs/verification.md) descreve o ambiente e os resultados dos testes. A [configuração das conexões](docs/operations/backend-configuration.md) apresenta as variáveis técnicas usadas pelos serviços.

## Atualizações

Todas as instalações usam a mesma distribuição e o mesmo contrato de atualização. Uma instalação que já contém dados recebe as releases do FAGOO preservando sua empresa, usuários, arquivos e configurações locais. O histórico versionado do banco acompanha as mudanças necessárias a cada versão.

Em **Preferências → Sistema → Atualizações do sistema**, o administrador obtém releases públicas assinadas sem token GitHub. O processo verifica compatibilidade, salva backup e coordena serviços, banco, API e interface. A credencial Cloudflare é configurada uma vez na instalação e renovada quando necessário. Consulte [atualizações e recuperação](docs/operations/updates.md).

Para mantenedores e agentes que precisam enviar correções ao repositório e disponibilizá-las nesse botão, siga [Publicar correções e atualizações](docs/operations/publishing-updates.md).

## Integrações e operação

A API é o ponto de integração com agentes externos e outros sistemas. As permissões, validações de negócio, registros de auditoria e controles de repetição de operações permanecem no ERP. Um agente usa um token próprio, desligado por padrão e sem acesso às operações que exigem segundo fator. Assistentes que trabalham com ferramentas podem usar o servidor MCP da própria API (`/mcp`), com consultas e um conjunto pequeno de gravações comuns. Consulte [acesso de agentes externos](docs/operations/agent-access.md).

Os módulos fiscais e bancários conservam suas condições de disponibilidade e homologação. A habilitação de operações depende da configuração da empresa e da validação exigida por cada serviço. O dimensionamento da VPS precisa considerar a carga do ERP e os demais serviços executados no mesmo servidor.
