# Instalação do FAGOO

O instalador é destinado a **Ubuntu Server 24.04 LTS, amd64, com systemd**, pelo menos 4 GB de RAM e 5 GB de espaço livre além dos dados previstos. Ele administra somente `/opt/fagoo`, serviços `fagoo-*` e o projeto Docker Compose `fagoo`. O PostgreSQL não publica porta externa; o acesso inicial à API fica em `127.0.0.1:8080`.

O container de atendimento existente e seus volumes não são removidos nem reconfigurados. Se a porta 8080 já estiver ocupada, o instalador escolhe uma porta livre até 8099 e informa o endereço final; ajuste os exemplos de acesso a essa porta. Confirme a disponibilidade de recursos considerando todos os serviços da VPS. A capacidade de 5–15 usuários simultâneos ainda depende de ensaio com a carga real.

## Antes de começar

Tenha acesso ao painel da VPS e à conta Cloudflare que administra o domínio da empresa. Separe o nome da empresa, o nome e o e-mail do administrador e uma senha de 12–128 caracteres. Digite senhas e tokens diretamente nos campos indicados; se estiver gravando a instalação, pause a gravação antes de exibir qualquer segredo.

Escolha dois endereços antes de executar o instalador. Os exemplos deste manual devem ser substituídos pelos endereços da sua empresa:

| Uso | Exemplo | Onde será usado |
| --- | --- | --- |
| Domínio já ativo na Cloudflare | `exemplo.com` | Seleção da zona e das permissões do token |
| Endereço público do FAGOO | `erp.exemplo.com` | Navegador, aplicativo e API pública |
| Endereço de origem | `origem-erp.exemplo.com` | Ligação protegida entre Cloudflare e a API na VPS |

Prefira nomes com um único nível antes do domínio, como nos exemplos. O certificado Universal SSL de `exemplo.com` normalmente cobre `*.exemplo.com`, mas não cobre `api.erp.exemplo.com`. Nomes com mais níveis exigem cobertura de certificado adicional; confira em **SSL/TLS → Edge Certificates** antes de escolhê-los.

Os dois nomes precisam estar livres no DNS. **Não crie registros A ou CNAME para eles antecipadamente:** o assistente cria o CNAME da origem e o domínio personalizado do Worker. Em **DNS → Records**, pesquise os nomes escolhidos e preserve os registros dos outros serviços da empresa.

A API pública usa o mesmo endereço do sistema, com caminhos `/api/...`. O endereço de origem é protegido por uma chave interna; ele não é o endereço que se deve entregar ao agente de atendimento. O PostgreSQL fica privado na VPS, sem subdomínio ou porta pública. O atendimento do Hermes usa sua própria integração de mensagens e não exige criar um subdomínio de WhatsApp para este instalador.

O plano da zona e as assinaturas dos produtos são separados: a zona pode aparecer como **Free** e a conta já ter **Workers Paid Plan**. Confira as assinaturas existentes antes de contratar outro plano. R2, usado para documentos e backups, tem ativação e cobrança próprias.

## Abrir o console da VPS na Hostinger

1. Entre em [hpanel.hostinger.com](https://hpanel.hostinger.com/).
2. No menu, abra **VPS**.
3. Identifique o servidor correto e clique em **Gerenciar**.
4. Na visão geral, confira o sistema operacional, a memória e o disco. Este instalador exige Ubuntu 24.04 amd64; não reinstale o sistema de uma VPS que já possui serviços em uso.
5. Clique em **Web console**. Uma aba **Hostinger VPS Web Terminal** será aberta.

Digite os comandos deste manual nesse console Linux, um bloco de cada vez. Eles não devem ser executados no PowerShell do seu computador. O caractere `\` no final de uma linha continua o mesmo comando na linha seguinte; copie o bloco completo, sem as marcas de formatação do Markdown.

Antes de instalar, confira os recursos e os containers existentes:

```bash
free -h
nproc
df -h /
docker ps --format 'table {{.Names}} | {{.Status}} | {{.Ports}}'
```

Se `docker` ainda não existir em uma VPS nova, o instalador instalará o Docker e o Compose. Se já existir, ele os reaproveitará. A memória disponível precisa acomodar o FAGOO e os demais serviços; a verificação automática do instalador considera a memória total, não desconta o consumo de outros containers.

## Instalação por release pública

Escolha uma versão publicada em [Releases](https://github.com/Quevenapp/Fagoo/releases). Uma pré-release exige informar a versão explicitamente; o endereço `latest` do GitHub não seleciona pré-releases.

Crie uma pasta de trabalho no console:

```bash
mkdir -p /tmp/fagoo-install
cd /tmp/fagoo-install
```

Baixe o instalador da versão escolhida:

```bash
curl --proto '=https' --tlsv1.2 -fL \
  https://github.com/Quevenapp/Fagoo/releases/download/v0.1.0-alpha.1/install.sh \
  -o install.sh
```

Abra o arquivo para revisão:

```bash
less install.sh
```

No visualizador `less`, **Espaço** avança uma página e **Q** volta ao console. Depois da revisão, execute:

```bash
sudo bash install.sh v0.1.0-alpha.1
```

Não há token de licença ou download. O bootstrap verifica a assinatura Ed25519 e os hashes dos pacotes. A imagem pré-compilada pode ser distribuída como arquivo público: o instalador verifica o arquivo, carrega-o no Docker e confere o identificador exato da imagem. Não é necessário acesso a um registry privado nem compilar a aplicação na VPS.

O instalador solicita os dados nesta ordem. Digite uma resposta e pressione **Enter** a cada pergunta:

| Pergunta | O que informar |
| --- | --- |
| Endereço público HTTPS do servidor | A URL definitiva, por exemplo `https://erp.exemplo.com` |
| Nome da empresa | Nome da empresa que usará o FAGOO |
| Nome do administrador | Nome da pessoa responsável pelo acesso inicial |
| E-mail do administrador | E-mail que será usado para entrar no sistema |
| Senha do administrador | Senha de 12–128 caracteres |
| Confirme a senha | A mesma senha novamente |

Entre a pergunta do endereço e a do nome da empresa, o instalador baixa e carrega a imagem, inicia o PostgreSQL e aplica as migrações. O download pode ficar alguns minutos sem novas mensagens no console. Aguarde; não interrompa as migrações ou a criação do administrador.

**A senha não mostra letras nem asteriscos durante a digitação.** Ela é enviada à criação do administrador pela entrada padrão, sem aparecer na linha de comando. Se houver erro de confirmação da senha, o instalador encerra antes do cadastro; execute o mesmo comando de instalação novamente para retomar. Ao retomar, a configuração existente é preservada e o cadastro é pulado se o administrador já estiver inicializado.

Ao concluir, o console informa `FAGOO services are healthy` e o endereço local escolhido. Também cria e verifica um primeiro backup local. A mensagem `Offsite backup is not configured` indica que ainda falta configurar a cópia fora da VPS, conforme a seção de backup abaixo.

Confira a saúde local, substituindo `8080` se o instalador tiver escolhido outra porta:

```bash
curl -fsS http://127.0.0.1:8080/health/ready
```

O resultado esperado contém `"status":"ready"` e a versão instalada. Esse endereço funciona dentro da VPS. O acesso público pelo domínio depende da configuração Cloudflare a seguir.

A instalação não publica recursos Cloudflare automaticamente. Depois de iniciar os serviços locais, execute o assistente abaixo na VPS do cliente. O endereço definitivo informado no instalador deve ser o mesmo hostname público do assistente.

Para ensaiar a instalação completa sem configurar Cloudflare ou domínio, use explicitamente `sudo bash install.sh v0.1.0-alpha.1 --local`. Nesse modo a interface e a API são servidas na mesma origem `http://localhost:8080`, vinculada apenas ao loopback. Em uma VPS remota, abra um túnel SSH com `ssh -L 8080:127.0.0.1:8080 usuario@servidor` e acesse esse endereço no seu navegador. O modo local não publica HTTP na internet. Para adotar o domínio definitivo posteriormente, atualize `FAGOO_PUBLIC_URL` no arquivo privado de configuração antes de executar o assistente Cloudflare.

## Configuração Cloudflare do cliente

Use uma conta e zona próprias do cliente. **Zona** é o domínio administrado na Cloudflare, como `exemplo.com`. O assistente precisa de três valores diferentes:

| Informação | O que identifica ou autoriza | Onde informar |
| --- | --- | --- |
| **Account ID** | A conta Cloudflare | Parâmetro `--account-id` do comando |
| **Zone ID** | O domínio escolhido | Parâmetro `--zone-id` do comando |
| **API Token** | Permissão para configurar e atualizar os recursos | Prompt oculto que aparece depois de executar o comando com `--apply` |

Account ID e Zone ID são identificadores, não senhas. O API Token é secreto. Não há token de licença ou download no FAGOO; este token autoriza operações na Cloudflare do próprio cliente.

### 1. Encontrar Account ID e Zone ID pelas telas

1. Abra [dash.cloudflare.com](https://dash.cloudflare.com/) e selecione a conta que administra seu domínio.
2. Na página inicial da conta, localize o quadro **Domains** e clique no domínio. Se ele não estiver nesse quadro, abra **Domains → Overview** pelo menu e selecione-o.
3. Na página do domínio, abra **Overview / Visão geral**.
4. Role a página para baixo. Na coluna da direita, procure o quadro **API**, próximo de **Active Subscriptions** e acima de **Advanced Actions**.
5. Ao lado de **Zone ID**, clique no ícone de dois quadrados, identificado como **Copy zone ID**. Copie o valor para o lugar de `SEU_ZONE_ID` no comando abaixo.
6. Logo abaixo, use **Copy account ID** para copiar o **Account ID** e substituir `SEU_ACCOUNT_ID`.

Copie os valores inteiros, sem espaços. Ambos têm 32 caracteres. Cada cliente deve usar os valores da própria conta e do próprio domínio.

### 2. Criar o API Token pelas telas

No mesmo quadro **API**, clique em **Get your API token**. Também é possível abrir diretamente [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens).

1. Na tela **User API Tokens**, clique em **Create Token**.
2. Em **Custom token / Create Custom Token**, clique em **Get started**.
3. Em **Token name**, informe um nome reconhecível, por exemplo `FAGOO - instalação e atualizações`.
4. Em **Permissions**, configure a primeira linha e use **Add more** para incluir as demais:

| Resources | Permissions | Permissions levels |
| --- | --- | --- |
| Account | Cloudflare Tunnel | Edit |
| Account | Workers Scripts | Edit |
| Zone | DNS | Edit |
| Zone | Workers Routes | Edit |
| Zone | Zone | Read |

5. Em **Account Resources**, mantenha **Include** e selecione **somente a conta da instalação**, substituindo `All accounts`.
6. Em **Zone Resources**, selecione **Include → Specific zone** e escolha **somente o domínio da instalação**, substituindo `All zones`.
7. Em **Token expiration**, escolha uma validade compatível com a manutenção. Se usar **No expiration**, o token permanece válido até ser revogado. Se definir prazo, programe sua substituição: um token expirado impede novos deploys e atualizações da interface.
8. Em **Client IP address filtering**, mantenha o padrão se não tiver confirmado todos os IPs de saída da VPS. Uma restrição que não corresponda à saída IPv4/IPv6 do servidor impede o uso do token.
9. Clique em **Continue to summary**. Confira o nome, a validade, as cinco permissões, a conta e o domínio.
10. **Pause a gravação antes da próxima etapa**, se estiver gravando. Clique em **Create Token** e copie o valor exibido. A Cloudflare informa que ele não será mostrado novamente; mantenha-o em um gerenciador de senhas até concluir a configuração.

O escopo de Workers e Tunnel dessas permissões é a conta selecionada; o de DNS e rotas é a zona selecionada. Não use a **Global API Key** para este procedimento. Credenciais S3 do R2 serão obtidas separadamente nas etapas de armazenamento e backup.

Os nomes da tabela correspondem às permissões clássicas disponíveis no painel durante a validação deste manual. Se o painel apresentar o modelo novo de papéis de Workers, consulte a [documentação de permissões de Workers](https://developers.cloudflare.com/workers/authorization/workers/): a criação de um Worker novo exige **Admin** no escopo do produto; **Editor** de um Worker existente não substitui essa permissão de criação.

### 3. Mostrar o plano no console da VPS

Volte à aba do **Web console** da Hostinger. Substitua os dois IDs e os dois nomes no comando. Os parâmetros `--hostname` e `--origin-hostname` recebem **somente o nome**, sem `https://` ou caminhos. O nome público precisa ser o mesmo da URL informada ao instalar o FAGOO.

Execute primeiro sem `--apply`:

```bash
sudo python3 /opt/fagoo/current/scripts/install-cloudflare.py \
  --account-id SEU_ACCOUNT_ID \
  --zone-id SEU_ZONE_ID \
  --hostname erp.exemplo.com \
  --origin-hostname origem-erp.exemplo.com
```

O console mostra `"apply": false`, os dois endereços e as ações planejadas. Essa etapa é local: não solicita token, não cria recursos e ainda não comprova que os IDs pertencem à conta ou que os nomes estão livres. Confira os endereços exibidos antes de continuar.

### 4. Aplicar a configuração e guardar o token

Execute o comando completo abaixo, com os mesmos valores e com `--apply` no final:

```bash
sudo python3 /opt/fagoo/current/scripts/install-cloudflare.py \
  --account-id SEU_ACCOUNT_ID \
  --zone-id SEU_ZONE_ID \
  --hostname erp.exemplo.com \
  --origin-hostname origem-erp.exemplo.com \
  --apply
```

O console ficará aguardando esta mensagem:

```text
Cloudflare scoped API token:
```

Cole o API Token copiado da Cloudflare e pressione **Enter**. **Nada aparece enquanto você cola ou digita, nem asteriscos.** Cole somente o valor do token; não cole o comando `curl` de teste sugerido pela Cloudflare. Retome a gravação apenas depois de sair da tela que exibe o segredo.

**Esse comando configura a Cloudflare e salva o token; não é apenas um comando de armazenamento.** O assistente verifica a zona e a conta, cria um túnel exclusivo, configura a origem `http://api:3000`, cria o CNAME de origem, inicia o túnel do FAGOO e publica os arquivos web pré-compilados com o domínio personalizado. Uma chave compartilhada entre Worker e API protege o acesso à origem.

Durante a configuração, o token de deploy é gravado automaticamente em `/opt/fagoo/secrets/cloudflare.env`, com permissão `0600` (leitura e escrita somente para o proprietário). O instalador não pede um segundo comando para salvá-lo. Não é necessário colocar o segredo na linha de comando, em `export` ou no histórico do shell. O token do conector e a chave de proxy são administrados pelo assistente; o cliente não precisa copiá-los manualmente.

Ao terminar com sucesso, aparece:

```text
Cloudflare configured for this installation. Existing services were not modified.
```

O assistente recusa registros DNS preexistentes que não pertençam à configuração local. Se uma chamada falhar, conserva o estado para retomar o mesmo túnel, sem apagar recursos. Não execute o assistente em uma zona de outra instalação.

Para retomar uma configuração interrompida ou substituir um token expirado/revogado, execute novamente o comando com **os mesmos quatro parâmetros e `--apply`**. O assistente pede o token novamente; informe uma credencial válida com as mesmas permissões. Não apague `/opt/fagoo/cloudflare.json` para tentar forçar a retomada, pois ele identifica os recursos desta instalação.

Depois da primeira configuração, o atualizador usa a credencial salva e pode publicar a interface da mesma instalação junto com a atualização da API. Sem configuração Cloudflare, o resultado informa expressamente que a interface pública continua pendente. O container da API não recebe o token Cloudflare nem o socket do Docker. O runtime de publicação usa uma versão fixa do Wrangler incluída na imagem verificada.

### 5. Conferir DNS, HTTPS e acesso ao FAGOO

1. No domínio da Cloudflare, abra **DNS → Records** e procure os nomes escolhidos. Confira o CNAME de origem criado para o túnel, com proxy ativo.
2. Em **Overview**, confira o Worker associado ao endereço público em **Connected Workers**. O domínio público é gerenciado como **Custom Domain** do Worker, não como um registro A para o IP da VPS.
3. Em **SSL/TLS → Edge Certificates**, confira que há certificado ativo cobrindo os nomes utilizados.
4. Abra `https://erp.exemplo.com` no navegador, substituindo pelo endereço real, e entre com o e-mail e a senha do administrador criados na instalação.
5. Abra `https://erp.exemplo.com/.well-known/fagoo.json`. Deve retornar JSON com `"product":"fagoo"`; esse é o documento de descoberta do servidor.

O assistente não substitui esses testes de acesso público. No console, também é possível verificar a descoberta e a proteção da origem:

```bash
curl -fsS https://erp.exemplo.com/.well-known/fagoo.json
curl -i https://origem-erp.exemplo.com/api/openapi.json
```

Na segunda chamada, o resultado esperado é **HTTP 403** com o código **`PROXY_REQUIRED`**, porque a chamada direta não possui a chave interna do Worker. Essa proteção é esperada; agentes e aplicativos devem acessar o domínio público.

Use `/health/ready` apenas no endereço local da VPS. No domínio público, esse caminho pode retornar a página web e não é uma verificação válida da saúde da API. Para conferir a API pública, use `/.well-known/fagoo.json` e faça o login pelo navegador.

### Problemas comuns nesta etapa

| Mensagem ou situação | O que conferir |
| --- | --- |
| `INVALID_ACCOUNT_OR_ZONE_ID` | Copie novamente o identificador completo do quadro API, sem espaços. Não use o API Token no lugar de um ID. |
| `FAGOO_PUBLIC_URL_MUST_MATCH_PUBLIC_HOSTNAME` | O parâmetro `--hostname` deve corresponder à URL definida na instalação. Para corrigir a URL, use `sudoedit /opt/fagoo/config.env`; esse arquivo contém segredos, então pause a gravação antes de abri-lo. |
| `ZONE_ACCOUNT_OR_HOSTNAME_MISMATCH` | Verifique se a zona pertence à conta e se os dois endereços estão dentro desse domínio. |
| `CLOUDFLARE_HTTP_401` ou `CLOUDFLARE_HTTP_403` | Confira token, validade, cinco permissões, conta, zona e eventual filtro de IP. Nas falhas do Wrangler, leia o erro original; mensagens posteriores de diagnóstico não são motivo para conceder permissões extras indiscriminadamente. |
| `PUBLIC_DNS_ALREADY_EXISTS_REVIEW_BEFORE_CONFIGURING` ou `ORIGIN_DNS_ALREADY_EXISTS_NOT_OWNED_BY_THIS_INSTALLATION` | O nome já possui um registro. Confira quem o utiliza; escolha outro nome livre ou resolva o conflito antes de repetir. Não apague registros de serviços existentes sem verificar seu uso. |
| `EXISTING_CLOUDFLARE_CONFIGURATION_DIFFERS` | A VPS já tem estado de configuração com outros IDs ou endereços. Retome com os valores originais; não force a troca apagando os arquivos de estado. |
| Aviso de certificado no navegador | Confira o nome e a cobertura do certificado. Um wildcard de primeiro nível não cobre `api.erp.exemplo.com`. Não ignore o aviso para concluir a instalação. |

Referências oficiais: [identificadores de conta e zona](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/), [criação de API Tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) e [limitações do Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

## Armazenamento privado de XML e documentos

O bucket de documentos é separado do backup do PostgreSQL. Crie um bucket R2 privado para documentos e uma credencial S3 com leitura e escrita limitada a esse bucket. O assistente de backup abaixo não configura o armazenamento da API.

Use `sudoedit /opt/fagoo/config.env` para preencher as variáveis, mantendo o arquivo com permissão `0600`:

```dotenv
FAGOO_R2_ENDPOINT=https://SEU_ACCOUNT_ID.r2.cloudflarestorage.com
FAGOO_R2_BUCKET=seu-bucket-de-documentos
FAGOO_R2_ACCESS_KEY_ID=sua-chave-de-acesso
FAGOO_R2_SECRET_ACCESS_KEY=sua-chave-secreta
```

Recrie somente os processos do FAGOO para carregar a configuração:

```bash
sudo docker compose --project-name fagoo --env-file /opt/fagoo/config.env \
  -f /opt/fagoo/current/infra/compose.yaml up -d --wait api jobs
```

Verifique a capacidade de armazenamento na interface e faça uma importação autorizada de teste para validar escrita e leitura. O bucket não deve receber acesso público. As credenciais não são enviadas ao navegador nem ao agente de atendimento. Configurar o bucket não ativa emissão fiscal, coleta automática ou regras tributárias ainda não homologadas.

## Backup fora da VPS

O agendador faz um `pg_dump` diário e verifica se o arquivo é legível pelo `pg_restore`. A cópia local sozinha não protege contra perda da VPS. Crie um bucket R2 privado e uma credencial S3 limitada a esse bucket; depois execute:

```bash
sudo python3 /opt/fagoo/current/scripts/install-backup.py \
  --account-id SEU_ACCOUNT_ID --bucket seu-bucket-privado
```

O assistente solicita as chaves sem eco e envia um primeiro backup. Falhas de upload fazem a tarefa falhar. Arquivos do R2 e configurações/segredos da instalação precisam de política própria de retenção e recuperação, além do dump do banco.

**Esta versão implementa dumps completos; não implementa ainda arquivamento contínuo de WAL/PITR.** Portanto, a meta de RPO de 15 minutos não está atendida. O RPO depende do último dump concluído; o RTO deve ser medido num ensaio de restauração. Não interprete o temporizador diário como garantia de recuperação em quatro horas.

## Instalação de desenvolvimento a partir do código

Para teste antes de uma release ou para desenvolver uma alteração, prepare o código e os arquivos web no seu ambiente de desenvolvimento:

```bash
npm ci
npm test
npm run build
sudo bash scripts/install-source.sh --development
```

Este caminho compila uma imagem local e não equivale à instalação de uma release assinada. Ele exige o checkout completo. A publicação dos recursos Cloudflare continua separada e explícita.

## Verificação e manutenção

```bash
sudo systemctl status fagoo-updater fagoo-backup.timer
sudo docker compose --project-name fagoo --env-file /opt/fagoo/config.env \
  -f /opt/fagoo/current/infra/compose.yaml ps
curl -fsS http://127.0.0.1:8080/health/ready
sudo python3 /opt/fagoo/updater/updater.py status
```

Uma instalação já concluída é preservada quando o bootstrap é executado novamente. Use o botão de atualização para trocar de versão. Para problemas durante migração, consulte [recuperação](recovery.md) antes de reiniciar serviços ou restaurar dados.

O instalador completo deve ser ensaiado em uma VM Ubuntu 24.04 nova. Testes de Docker e scripts em outros sistemas não equivalem à validação do systemd, do DNS ou da conectividade fiscal de produção.
