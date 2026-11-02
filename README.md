# FAGOO

ERP open source para instalação própria, com PostgreSQL, interface web e API para agentes externos. Licença AGPL-3.0-only.

**Estado: versão alpha de avaliação.** O núcleo comercial funciona em uma instalação nova; emissão fiscal operacional, coleta automática de documentos e homologação bancária ainda possuem dependências descritas em [estado da implementação](docs/status.md). Não use a presença de uma tela ou de um parser como indicação de autorização fiscal ou bancária.

## Instalar do zero

Plataforma suportada pelo instalador: **Ubuntu Server 24.04 LTS, x86-64**. A instalação usa Docker Compose e não exige token para baixar o FAGOO. O container do Hermes e os demais serviços existentes são preservados.

Para a primeira avaliação, sem publicar recursos no Cloudflare:

```bash
curl -fL https://github.com/Quevenapp/Fagoo/releases/download/v0.1.0-alpha.1/install.sh -o install.sh
less install.sh
sudo bash install.sh v0.1.0-alpha.1 --local
```

O instalador solicita empresa, administrador e senha; verifica a assinatura da release, carrega a imagem pronta, cria o banco, aplica as migrações e prepara o backup e o atualizador. A aplicação fica acessível apenas em `http://localhost:8080` no servidor.

Se estiver instalando em uma VPS, abra um túnel no seu computador para testar a interface:

```bash
ssh -L 8080:127.0.0.1:8080 usuario@seu-servidor
```

Depois acesse `http://localhost:8080` no navegador. O modo local não cria DNS, túnel Cloudflare ou publicação de site. A configuração pública é uma etapa separada e explícita do [guia de instalação](docs/operations/installation.md).

Essa release foi instalada a partir dos downloads públicos, sem autenticação GitHub, em um segundo Ubuntu limpo. Consulte o [registro de verificação](docs/verification.md) para os resultados e os limites do ensaio.

## O que já funciona

- Produtos, clientes, fornecedores, depósitos e códigos de fornecedor com conversão de unidades.
- Pedidos de compra e venda, preços por condição comercial, reserva e movimentação de estoque.
- Recebimento parcial com confirmação física e lançamentos financeiros por parcelas.
- Estornos com verificação de versão, disponibilidade e efeitos associados.
- Histórico comercial, séries de vendas e dados completos de reposição com paginação.
- Credenciais individuais de integração, permissões, auditoria e comandos idempotentes.
- API REST documentada e ferramentas MCP para consulta e operações de negócio.
- Descoberta de servidor e OAuth com PKCE para preparar o futuro aplicativo nativo.
- Importação de XML para armazenamento privado configurado, sem lançamento automático de estoque ou financeiro.
- Instalador público e atualização administrativa a partir de releases assinadas.

## Agentes externos

Hermes/WABABOTAI pode consultar e operar o FAGOO pela API. O sistema não executa um modelo de linguagem próprio e não inclui uma API de WhatsApp. O bot equipe recebe uma credencial restrita; o bot atendente não recebe credenciais administrativas.

As análises podem ser feitas externamente com ferramentas de cálculo. Use os metadados de cobertura e percorra a paginação inteira. Preços, demanda e classificação fiscal não devem ser inferidos a partir de dados ausentes.

- Descoberta: `GET /.well-known/fagoo.json`
- OpenAPI: `GET /api/openapi.json`
- Negócio: `/api/v1`
- MCP HTTP: `/api/mcp`
- Autenticação: `/api/auth`

Consulte [integração com agentes](docs/integrations/agents.md), [API de negócio](docs/api/business.md), [documentos fiscais](docs/api/fiscal.md) e [aplicativos móveis](docs/integrations/mobile.md).

## Desenvolvimento e validação

Requer Node.js 24 e PostgreSQL 17 para a API completa. Os testes do engine fiscal também usam Python 3, OpenSSL e as dependências fixadas em `packages/fiscal-schema/requirements.txt`; a imagem de instalação já inclui esse runtime. Em desenvolvimento, use um ambiente virtual Python e configure `FAGOO_TEST_PYTHON` com o caminho absoluto do executável.

```bash
npm ci
python -m venv .venv
# Instale packages/fiscal-schema/requirements.txt com o pip desse ambiente virtual.
# Configure FAGOO_TEST_PYTHON para o executável Python dentro de .venv.
npm run check
npm test
npm run build
```

Os testes de domínio usam PostgreSQL embarcado. A suíte adicional de autenticação, instalação e OAuth usa uma instância PostgreSQL local indicada por `FAGOO_TEST_DATABASE_URL`; ela cria e remove somente bancos temporários com prefixo próprio. Sem essa variável, esse teste é explicitamente marcado como não executado.

Copie `.env.example` para um arquivo privado `.env`, configure banco, origem e uma chave de sessão aleatória e longa. Em seguida:

```bash
node --env-file=.env apps/api/src/migrate.mjs
node --env-file=.env apps/api/src/bootstrap.mjs --email admin@empresa.example --name Administrador --company "Minha empresa" --password-stdin
node --env-file=.env apps/api/src/server.mjs
```

A senha do bootstrap é recebida pela entrada padrão, não pelos argumentos do processo. O bootstrap recusa criar outro administrador inicial depois que a instalação foi inicializada.

## Distribuição e operações

GitHub Actions permanece desativado. Builds, testes e assinatura de releases são executados pelo mantenedor seguindo [publicação de versões](docs/operations/releases.md). Downloads são públicos; operações administrativas do ERP continuam autenticadas.

O [procedimento de recuperação](docs/operations/recovery.md) descreve backups e falhas de atualização. A configuração inicial de 1 vCPU/4 GB precisa de medição com o uso real, incluindo o container do agente. O serviço de IA e os recursos de infraestrutura são contratados pelo cliente.

A página institucional está em `apps/site`; o código está preparado para o domínio `fagoo.queven.app`. Sua presença neste repositório não significa que tenha sido publicado.
