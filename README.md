# FAGOO

ERP de código aberto para instalação própria. Reúne cadastros, compras, vendas, PDV, estoque, financeiro, cobrança/CNAB, fiscal, preferências e controle de acesso, com interface web e API. Licença [AGPL-3.0](LICENSE).

O FAGOO utiliza PostgreSQL, serviço de autenticação, API de dados, armazenamento de arquivos e serviços de aplicação. Cada instalação mantém sua empresa, usuários, dados, arquivos e credenciais em seu próprio ambiente.

## Instalação própria

A instalação inicial deve criar uma base sem dados comerciais. A empresa e o administrador são cadastrados durante a configuração inicial. Catálogos oficiais e configurações técnicas necessários ao funcionamento fazem parte do sistema; clientes, fornecedores, produtos, documentos, movimentos e saldos de uma empresa não acompanham a distribuição.

O código está na versão de desenvolvimento `0.2.0-dev.0`. O instalador Ubuntu e o fluxo de atualização pelo painel ainda precisam de integração e validação completas antes de uma release instalável. Consulte o [manual de instalação](docs/operations/installation.md) e o [estado do projeto](docs/status.md).

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

A distribuição prevista utiliza artefatos públicos, sem token GitHub do cliente, com verificação de assinatura e integridade, compatibilidade de versão, backup e recuperação após falha. O contrato e o estado de implementação estão em [atualizações](docs/operations/updates.md).

## Integrações e operação

A API é o ponto de integração com agentes externos e outros sistemas. As permissões, validações de negócio, registros de auditoria e controles de repetição de operações permanecem no ERP.

Os módulos fiscais e bancários conservam suas condições de disponibilidade e homologação. A habilitação de operações depende da configuração da empresa e da validação exigida por cada serviço. O dimensionamento da VPS precisa considerar a carga do ERP e os demais serviços executados no mesmo servidor.
