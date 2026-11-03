# Instalação própria do FAGOO

O FAGOO é distribuído para instalações independentes. Cada cliente configura seu servidor, sua empresa e seu administrador. Uma base nova contém a estrutura, os catálogos oficiais e os padrões técnicos necessários ao funcionamento, sem cadastros, documentos, movimentos ou saldos de outra empresa. Fixtures de QA não participam do bootstrap.

## Estado desta revisão

A versão `0.2.0-dev.0` contém um instalador do **núcleo local**: PostgreSQL 17, autenticação, PostgREST, armazenamento de arquivos, proxy local e aplicação das 311 versões originais do schema. As imagens de execução estão fixadas por digest em `infra/compose.yaml`.

Esse núcleo já foi exercitado em Docker com banco vazio, autenticação real, RPC, arquivos e atualização. Os scripts de provisionamento são destinados ao Ubuntu 24.04. A instalação é dividida em fases: núcleo local, administrador, ferramentas de publicação, túnel HTTPS e publicação da interface/API. Este manual apresenta a sequência dos helpers disponíveis; a conclusão depende das verificações finais pela origem pública. SMTP, runtime fiscal, integrações e atualização pelo painel têm configurações e limites próprios.

## 1. Preparar o código no Ubuntu

Use Ubuntu 24.04, acesso administrativo, uma conta Cloudflare com a zona do domínio e uma revisão pública que contenha estes scripts. Confira os requisitos do Docker e o espaço livre para imagens, banco, arquivos e backups. Prepare uma pasta persistente e obtenha o código público:

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

- Interface web, por exemplo `https://fagoo.example.com`.
- Autenticação, dados e arquivos, por exemplo `https://fagoo-services.example.com`.
- API de negócio do ERP, por exemplo `https://fagoo-api.example.com`.

Os exemplos devem ser substituídos pelos domínios da instalação, mantendo a ordem **web, serviços, API** apresentada pelos prompts. Para seguir este manual, use três hostnames no mesmo nível da zona Cloudflare, como no exemplo `example.com`. A origem de serviços é um endereço HTTP do gateway; ela não publica a porta do PostgreSQL. Nenhuma conta de banco hospedado é necessária. Não crie registros A/CNAME provisórios para web e API: eles serão domínios personalizados dos Workers na etapa de publicação.

As credenciais são geradas no servidor, sem aparecer no terminal:

- `private/install/.env`: senhas, chaves e configuração privada dos serviços.
- `private/install/frontend.env`: somente as quatro variáveis públicas necessárias ao build da interface.

A criação é exclusiva: o gerador recusa sobrescrever arquivos existentes. Preserve a configuração privada e os volumes `database`, `database-config` e `objects`. O instalador recusa iniciar se encontrar containers ou volumes existentes do projeto `fagoo`, inclusive uma instalação parcial. Uma instalação inicializada usa o [atualizador](updates.md), que faz as verificações e o backup antes de substituir os serviços. Uma tentativa parcial exige inspeção privada antes da recuperação; não remova volumes para forçar nova instalação.

## 2. Verificar o núcleo local

```sh
sudo docker compose --project-name fagoo --env-file private/install/.env -f infra/compose.yaml ps
curl --fail --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:8081/healthz
sudo python3 infra/migrate.py --check-only
```

A primeira verificação deve mostrar os cinco serviços saudáveis; a segunda deve imprimir `200`; a terceira deve confirmar o histórico do schema. A porta padrão `8081` fica vinculada apenas ao loopback. PostgreSQL, autenticação, PostgREST e armazenamento não têm portas publicadas diretamente no host. O histórico privado `fagoo_system.schema_migration` registra cada versão e seu hash; divergências ou lacunas interrompem a aplicação. Em uma gravação, não mostre o arquivo privado nem use `docker compose config` sem `--quiet`, pois esse comando expande segredos.

O serviço de autenticação inicia com cadastro público e contas anônimas desabilitados. Configure SMTP nas variáveis `SMTP_*` de `private/install/.env` antes de usar convites, recuperação de senha ou outros fluxos de e-mail. Recrie o serviço `auth` depois da configuração; o instalador não fornece um provedor SMTP.

## 3. Criar o primeiro administrador

```sh
sudo python3 infra/create-admin.py --email admin@example.test --name "Administrador"
```

Substitua os exemplos pelos dados do administrador. O programa solicita a senha duas vezes, sem eco e com pelo menos 12 caracteres. Não passe a senha em argumento nem a envie em mensagens.

O usuário é criado no serviço real de autenticação; a permissão administrativa e o marcador permanente de inicialização são gravados juntos no banco. O marcador impede repetir o bootstrap mesmo que permissões sejam posteriormente removidas. Se ocorrer falha parcial, confira o usuário e suas permissões privadamente antes da recuperação; não apague contas nem repita o procedimento indiscriminadamente.

A empresa será cadastrada pela interface existente após concluir a publicação e o acesso HTTPS. Esse comando não insere dados comerciais.

## 4. Instalar as ferramentas de publicação

Ainda na raiz `/opt/fagoo`, execute:

```sh
sudo bash scripts/install-deployment-tools.sh
npm ci
```

O primeiro comando instala Node.js 24 a partir dos arquivos oficiais com checksum fixado e `cloudflared` pelo repositório APT oficial com verificação da chave e das assinaturas. Ele recusa substituir uma instalação Node de outra versão principal ou arquivos de configuração incompatíveis. O `npm ci` instala as dependências fixadas pelo projeto; execute-o como o usuário dono da pasta do código. Nenhum desses dois comandos solicita token Cloudflare.

O helper de publicação da etapa 7 gera a configuração pública do build a partir da instalação. Não é necessário copiar segredos nem preencher manualmente os arquivos Wrangler de exemplo. Nunca copie `private/install/.env`, a chave de serviço ou o segredo JWT para variáveis `VITE_`.

## 5. Conectar o túnel e publicar o hostname de serviços

No painel Cloudflare, abra a área de Cloudflare Tunnel, crie um túnel do tipo `cloudflared` e escolha um nome para esta instalação. Anote o UUID do túnel. Na tela de instalação do conector Linux, use o botão para copiar o comando de instalação; ele contém uma credencial e não deve ser colado diretamente na linha de comandos durante a gravação.

No console da VPS, substitua `TUNNEL_UUID` pelo identificador do painel e execute:

```sh
sudo python3 infra/connect-tunnel.py --tunnel-id TUNNEL_UUID
```

Quando surgir o prompt oculto, cole o comando completo copiado do painel ou somente o token. O helper aceita as formas `cloudflared service install TOKEN` e `cloudflared tunnel run --token TOKEN`, com `sudo` opcional, sem executar o texto colado. Ele valida que a credencial corresponde ao UUID informado. A entrada não aparece no terminal.

O token fica em `/etc/fagoo/cloudflared/token`, com permissão `0600`, e o serviço `fagoo-cloudflared.service` passa apenas o caminho desse arquivo ao conector. Nenhum token entra na linha de comandos, na unit ou nos logs. O helper não sobrescreve configuração existente; se uma tentativa falhar, preserve os arquivos e confira o estado antes de recuperar.

Depois que o conector aparecer como saudável no painel, avance e configure o hostname público de serviços:

| Campo | Exemplo para esta etapa |
| --- | --- |
| Hostname público | `fagoo-services.example.com` |
| Tipo do serviço | `HTTP` |
| Serviço de origem | `localhost:8081` |
| Caminho | Vazio, para encaminhar todos os caminhos |

O endereço público precisa ser exatamente o `FAGOO_BACKEND_ORIGIN` escolhido na instalação. O helper atual verifica o gateway local na porta padrão `8081`. Salve a rota do túnel pelo painel e valide:

```sh
sudo systemctl is-active fagoo-cloudflared.service
curl --fail --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:20241/ready
curl --fail --silent --output /dev/null --write-out '%{http_code}\n' https://fagoo-services.example.com/healthz
```

Substitua o domínio de exemplo pelo hostname real. Espere `active` e respostas `200`. A verificação pública confirma DNS, certificado HTTPS e encaminhamento até a VPS. Nenhuma porta do PostgreSQL precisa ser aberta. O token do túnel é diferente do token de publicação criado na próxima etapa.

## 6. Preparar a conta Cloudflare para publicar web e API

Obtenha o **Account ID** da conta e o **Zone ID** da zona no painel. Esses identificadores não são senhas e serão argumentos do helper. Crie um token de API restrito somente à conta e à zona desta instalação, com as permissões:

- Conta: `Workers Scripts — Edit`.
- Zona: `Workers Routes — Edit`, `Zone — Read` e `DNS — Read`.

O token de publicação será solicitado em um prompt oculto e não será salvo pelo helper. Não use o token do túnel nesse prompt. Os passos detalhados e os requisitos de publicação estão em [Publicação da interface e da API](application-deployment.md).

Verifique o DNS de **somente dois hostnames**: web e API, por exemplo `fagoo.example.com` e `fagoo-api.example.com`. Se houver registros A/CNAME provisórios que entrem em conflito com esses destinos, remova apenas esses registros pelo painel antes do deploy. Preserve o domínio principal, os registros de e-mail, os demais serviços e o hostname `fagoo-services.example.com` do túnel. Se um hostname já pertencer a outro Worker, resolva sua atribuição antes de prosseguir.

O helper verifica esses conflitos e recusa a publicação quando encontra uma atribuição incompatível. Os domínios personalizados dos Workers criarão seus próprios registros gerenciados; não use opção de força para substituir outro serviço.

## 7. Compilar e publicar a interface e a API

Para ensaiar o build e o empacotamento sem publicar e sem solicitar token, substitua os dois identificadores e execute:

```sh
sudo python3 infra/deploy-application.py \
  --account-id ACCOUNT_ID \
  --zone-id ZONE_ID \
  --dry-run
```

Depois da preparação do DNS, publique com:

```sh
sudo python3 infra/deploy-application.py \
  --account-id ACCOUNT_ID \
  --zone-id ZONE_ID \
  --deploy
```

Os identificadores de conta e zona precisam ter os 32 caracteres hexadecimais fornecidos pelo painel. O `sudo` permite ao helper ler a configuração privada criada pelo instalador. O programa compila a interface, verifica os artefatos e empacota os Workers; só então solicita o token Cloudflare sem eco. Ele publica primeiro a API e depois a interface original, com os domínios definidos na instalação. A chave de serviço fica exclusivamente no Worker autorizado da API, como segredo; ela não entra no frontend.

Se uma fase falhar, confira a fase indicada e o log privado antes de repetir. Uma publicação anterior bem-sucedida não é desfeita automaticamente. Veja os controles de concorrência e os detalhes de recuperação em [Publicação da interface e da API](application-deployment.md).

Os serviços usam `SUPABASE_DEPLOYMENT=self-hosted`, a origem HTTPS local e as credenciais geradas no servidor; confira [configuração das conexões](backend-configuration.md). Os identificadores técnicos das variáveis preservam o contrato do código.

O runtime fiscal, os certificados e as credenciais bancárias são configurados conforme os módulos usados. O helper publica web e API, mas não publica o gateway/executor/Container fiscal nem habilita SMTP. Tarefas agendadas e integrações permanecem desabilitadas até configuração explícita.

## Critérios de aceite da instalação completa

Abra o hostname web no navegador, entre com o administrador criado na etapa 3, confirme as permissões e os cadastros vazios e cadastre a empresa pela interface. Uma chamada à API `/v1/me` sem sessão deve ser recusada. Não considere a instalação concluída apenas porque `/healthz` respondeu.

Antes do uso operacional, valide também MFA, recuperação de acesso, envio e leitura de arquivos, operações da API, módulos fiscais/bancários habilitados, backup, restauração e atualização. O ensaio local do núcleo não valida carga de produção nem dimensionamento da VPS junto de agentes e outros containers.

Os dados e segredos ficam separados dos artefatos de aplicação. Todas as instalações usam o mesmo [contrato de atualização](updates.md), preservando empresa, usuários, configuração e volumes persistentes.
