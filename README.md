# FAGOO

Sistema de gestão de código aberto para instalação própria na nuvem. Reúne ERP, atendimento, filas e painéis e CRM em uma empresa, com usuários, contatos e configuração compartilhados. O aplicativo Android/iOS oferece painéis e comunicação; a administração e os módulos completos continuam no navegador. Licença [AGPL-3.0](LICENSE).

O FAGOO utiliza PostgreSQL, serviço de autenticação, API de dados, armazenamento de arquivos e serviços de aplicação. Cada instalação mantém sua empresa, usuários, dados, arquivos e credenciais em seu próprio ambiente.

Na v1.0.0, o motor de atendimento herdado é um serviço interno com D1, R2 e Durable Objects. As filas operam por transações PostgreSQL. Aparelhos dependem da internet, inclusive quando conectados por hotspot: não há central local nem comandos offline. Consulte o [contrato da consolidação](docs/architecture/fagoo-1.0.0-contract.md), o [aplicativo](apps/mobile/README.md) e os [critérios de homologação](docs/operations/fagoo-1.0.0-acceptance.md).

## Instalação própria

A instalação inicial deve criar uma base sem dados comerciais. A empresa e o administrador são cadastrados durante a configuração inicial. Catálogos oficiais e configurações técnicas necessários ao funcionamento fazem parte do sistema; clientes, fornecedores, produtos, documentos, movimentos e saldos de uma empresa não acompanham a distribuição.

A distribuição inclui instalador para Ubuntu 24.04, publicação da interface/API na Cloudflare e atualização pelo painel administrativo. Use uma [release pública](https://github.com/Quevenapp/Fagoo/releases) e siga o [manual de instalação](docs/operations/installation.md). O [estado do projeto](docs/status.md) descreve o escopo e as validações operacionais ainda necessárias.

## Desenvolvimento

Use Node.js 24. Para as verificações fiscais completas, use Linux/Ubuntu, OpenSSL 3 e Python com as dependências de `packages/fiscal-schema/requirements.txt`.

```sh
npm run install:deployment
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

A API é o ponto de integração com agentes externos e outros sistemas. As permissões, validações de negócio, registros de auditoria e controles de repetição de operações permanecem no ERP.

Os módulos fiscais e bancários conservam suas condições de disponibilidade e homologação. A habilitação de operações depende da configuração da empresa e da validação exigida por cada serviço. O dimensionamento da VPS precisa considerar a carga do ERP e os demais serviços executados no mesmo servidor.
