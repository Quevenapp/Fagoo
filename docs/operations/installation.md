# Instalação própria do FAGOO

O FAGOO é distribuído para instalações independentes. Cada cliente configura seu servidor, sua empresa e seu administrador. Uma base nova contém a estrutura, os catálogos oficiais e os padrões técnicos necessários ao funcionamento, sem cadastros, documentos, movimentos ou saldos de outra empresa. Fixtures de QA não participam do bootstrap.

## Estado desta revisão

A versão `0.2.0-dev.0` contém um instalador do **núcleo local**: PostgreSQL 17, autenticação, PostgREST, armazenamento de arquivos, proxy local e aplicação das 311 versões originais do schema. As imagens de execução estão fixadas por digest em `infra/compose.yaml`.

Esse núcleo já foi exercitado em Docker com banco vazio, autenticação real, RPC, arquivos e atualização. O script de provisionamento do sistema operacional é destinado ao Ubuntu 24.04; a instalação integral em uma VPS Ubuntu nova ainda precisa de ensaio. O script não publica Workers, frontend, DNS ou HTTPS. A integração dessas etapas, do runtime fiscal e da atualização pelo painel ainda é necessária antes de anunciar uma release de instalação completa.

## 1. Preparar o código no Ubuntu

Use Ubuntu 24.04, acesso administrativo e uma revisão pública que contenha estes scripts. Confira os requisitos do Docker e o espaço livre para imagens, banco, arquivos e backups. Prepare uma pasta persistente e obtenha o código público:

```sh
sudo apt-get update
sudo apt-get install -y git ca-certificates
sudo install -d -m 755 -o "$(id -un)" -g "$(id -gn)" /opt/fagoo
git clone https://github.com/Quevenapp/Fagoo.git /opt/fagoo
cd /opt/fagoo
```

O clone público não requer token GitHub. A branch `main` pode conter desenvolvimento; antes de uma instalação operacional, selecione a release compatível validada. A pasta de destino deve estar vazia ao executar `git clone`.

A partir da raiz do código, execute:

```sh
sudo bash scripts/install-runtime.sh
```

O script instala as dependências de sistema e o Docker Compose, se necessário, e solicita três origens públicas HTTPS, sem caminho ou porta personalizada:

- Interface web, por exemplo `https://erp.example.test`.
- Autenticação, dados e arquivos, por exemplo `https://services.example.test`.
- API de negócio do ERP, por exemplo `https://api.example.test`.

Os exemplos devem ser substituídos pelos domínios da instalação. A origem de serviços é um endereço HTTP do gateway; ela não publica a porta do PostgreSQL. Nenhuma conta de banco hospedado é necessária.

As credenciais são geradas no servidor, sem aparecer no terminal:

- `private/install/.env`: senhas, chaves e configuração privada dos serviços.
- `private/install/frontend.env`: somente as quatro variáveis públicas necessárias ao build da interface.

A criação é exclusiva: o gerador recusa sobrescrever arquivos existentes. Preserve a configuração privada e os volumes `database`, `database-config` e `objects`. O instalador recusa iniciar se encontrar containers ou volumes existentes do projeto `fagoo`, inclusive uma instalação parcial. Uma instalação inicializada usa o [atualizador](updates.md), que faz as verificações e o backup antes de substituir os serviços. Uma tentativa parcial exige inspeção privada antes da recuperação; não remova volumes para forçar nova instalação.

## 2. Verificar o núcleo local

```sh
sudo docker compose --env-file private/install/.env -f infra/compose.yaml ps
curl --fail http://127.0.0.1:8081/healthz
sudo python3 infra/migrate.py --check-only
```

A porta padrão `8081` fica vinculada apenas ao loopback. PostgreSQL, autenticação, PostgREST e armazenamento não têm portas publicadas diretamente no host. O histórico privado `fagoo_system.schema_migration` registra cada versão e seu hash; divergências ou lacunas interrompem a aplicação.

O serviço de autenticação inicia com cadastro público e contas anônimas desabilitados. Configure SMTP nas variáveis `SMTP_*` de `private/install/.env` antes de usar convites, recuperação de senha ou outros fluxos de e-mail. Recrie o serviço `auth` depois da configuração; o instalador não fornece um provedor SMTP.

## 3. Criar o primeiro administrador

```sh
sudo python3 infra/create-admin.py --email admin@example.test --name "Administrador"
```

Substitua os exemplos pelos dados do administrador. O programa solicita a senha duas vezes, sem eco e com pelo menos 12 caracteres. Não passe a senha em argumento nem a envie em mensagens.

O usuário é criado no serviço real de autenticação; a permissão administrativa e o marcador permanente de inicialização são gravados juntos no banco. O marcador impede repetir o bootstrap mesmo que permissões sejam posteriormente removidas. Se ocorrer falha parcial, confira o usuário e suas permissões privadamente antes da recuperação; não apague contas nem repita o procedimento indiscriminadamente.

A empresa será cadastrada pela interface existente após concluir a publicação e o acesso HTTPS. Esse comando não insere dados comerciais.

## 4. Preparar a interface e concluir a publicação

Em um ambiente com Node.js 22 ou superior, copie somente a configuração pública e compile:

```sh
sudo install -m 644 private/install/frontend.env apps/erp/.env.local
npm ci
npm run build:erp
```

Execute o build com um usuário que tenha acesso à configuração pública e permissão de escrita no diretório do código. Nunca copie `private/install/.env`, a chave de serviço ou o segredo JWT para variáveis `VITE_`.

A publicação ainda exige configurar o proxy ou túnel HTTPS até o gateway local, o Worker da API, o frontend e os respectivos domínios. Os arquivos `workers/*/wrangler.jsonc` são modelos sem destinos de cliente e precisam da configuração dessa instalação. Os serviços usam `SUPABASE_DEPLOYMENT=self-hosted`, a origem HTTPS local e as credenciais geradas no servidor; confira [configuração das conexões](backend-configuration.md). Os identificadores técnicos das variáveis preservam o contrato do código.

O runtime fiscal, os certificados e as credenciais bancárias são configurados conforme os módulos usados. Tarefas agendadas e integrações permanecem desabilitadas até configuração explícita. Esta revisão não automatiza essas etapas de publicação; não considere a instalação concluída apenas porque `/healthz` respondeu.

## Critérios de aceite da instalação completa

Antes do uso operacional, valide login, MFA, recuperação de acesso, permissões, cadastros vazios, envio e leitura de arquivos, operações da API, módulos fiscais/bancários habilitados, backup, restauração e atualização. O ensaio local do núcleo não valida carga de produção nem dimensionamento da VPS junto de agentes e outros containers.

Os dados e segredos ficam separados dos artefatos de aplicação. Todas as instalações usam o mesmo [contrato de atualização](updates.md), preservando empresa, usuários, configuração e volumes persistentes.
