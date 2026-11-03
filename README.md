# FAGOO

ERP de código aberto baseado na aplicação completa do [Brufap](https://github.com/brunovnq/brufap), preservando o template original, os módulos, as regras de negócio e os contratos do banco. Licença [AGPL-3.0](LICENSE).

Esta linha de reconstrução parte do commit `97be7a7eab5c132e540748757120a55897f1e971`. A mudança visual está adiada. A identidade apresentada ao usuário é FAGOO; identificadores técnicos usados em criptografia, arquivos e protocolos históricos permanecem quando sua alteração poderia quebrar compatibilidade.

## Estado desta linha

O piloto `v0.1.0-alpha.1` usava outra aplicação e outro modelo de banco. Ele não é a base funcional desta reconstrução. Não aplique esta árvore como atualização automática do piloto e não use o instalador daquela versão para instalar o ERP desta linha. Consulte [instalação e validação](docs/operations/installation.md).

A aplicação original está em `apps/erp`, a API em `workers/erp-api`, os serviços fiscais em `packages` e `workers`, e o histórico completo de migrações em `supabase/migrations`. Isso inclui cadastros, documentos comerciais, PDV, estoque, financeiro, cobrança/CNAB, fiscal, preferências e controle de acesso. Cada módulo conserva seus limites de homologação e disponibilidade; presença de código não equivale a autorização para operação fiscal ou bancária em produção.

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

Preencha apenas as variáveis públicas do frontend. Chaves de serviço, senhas, certificados e tokens de infraestrutura pertencem ao ambiente privado dos serviços. As rotas de QA e seus dados sintéticos não são um servidor de produção.

Verificações disponíveis:

```sh
npm run typecheck:erp
npm run test:erp
npm run test:backend
npm run test:portability
npm run check:reference
npm run build:erp
npm run check:erp:build
```

Algumas suítes herdadas precisam de dependências fiscais e configuração de ambiente descritas em [verificação](docs/verification.md).

## Supabase e VPS

O ERP usa PostgreSQL, RPCs/PostgREST, Auth e Storage. Uma VPS com somente PostgreSQL não substitui esses contratos. O caminho de menor alteração funcional é manter serviços compatíveis com Auth e Storage, além de PostgREST e um proxy HTTPS, enquanto se valida a restauração do banco e dos objetos.

O modo hospedado continua sendo o padrão. Uma instalação própria deve configurar explicitamente `SUPABASE_DEPLOYMENT=self-hosted` nos serviços e `VITE_SUPABASE_DEPLOYMENT=self-hosted` no build do frontend. Os adaptadores aceitam uma origem HTTPS configurada pelo instalador; URLs fornecidas por requisições não selecionam o destino de credenciais. Veja [conexões](docs/operations/backend-configuration.md).

As ferramentas em `tools/portability` preparam um inventário somente leitura e comparam estrutura e contagens. Não exportam linhas de negócio, não restauram dados e não declaram uma migração concluída. O procedimento e os critérios de aceite estão em [migração do Supabase](docs/operations/supabase-migration.md).

## Evolução prevista

O instalador Ubuntu, o provisionamento Cloudflare, a atualização pública pelo painel, a API para agentes externos e a descoberta de servidor para aplicativos devem ser integrados sobre este ERP completo. Cada entrega precisa manter os mesmos fluxos e dados da referência. Não há nova publicação ou implantação implícita ao executar os testes locais.

A análise de dimensionamento da VPS deve incluir o ERP e o container Hermes. A configuração de 1 vCPU e 4 GB precisa de medição com esses serviços antes de ser assumida como suficiente para produção.
