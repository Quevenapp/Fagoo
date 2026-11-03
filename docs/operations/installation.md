# Instalação própria do FAGOO

O FAGOO é distribuído para instalações independentes. Cada cliente configura seu servidor, sua empresa e seu administrador. Uma base nova contém a estrutura, os catálogos oficiais e os padrões técnicos necessários ao funcionamento, sem cadastros, documentos, movimentos ou saldos de outra empresa. Fixtures de QA não participam do bootstrap.

## Estado desta revisão

A distribuição inclui instalador Ubuntu 24.04, serviço de atualização pelo painel, PostgreSQL 17, autenticação, PostgREST, armazenamento de arquivos, proxy local e aplicação das 311 versões originais do schema. As imagens de execução estão fixadas por digest em `infra/compose.yaml`.

Esse núcleo já foi exercitado em Docker com banco vazio, autenticação real, RPC, arquivos e atualização. A instalação é dividida em fases: núcleo local, administrador, ferramentas de publicação, túnel HTTPS, publicação da interface/API e verificação do atualizador. A conclusão depende das verificações finais pela origem pública. SMTP, runtime fiscal e integrações têm configurações próprias.

A sequência também foi exercitada em uma VPS Ubuntu 24.04 recém-instalada: núcleo, túnel, publicação web/API, login do administrador e consultas sem dados comerciais. Os ajustes encontrados nessa instalação foram incorporados ao manual e aos helpers. Esse resultado valida a implantação técnica vazia, sem substituir a validação operacional dos módulos utilizados.

## Antes de começar: domínio e subdomínios

Adicione o domínio à conta Cloudflare da instalação. Em **Domínios → seu domínio → Visão geral**, copie os dois servidores de nomes atribuídos pela Cloudflare e configure-os no registrador do domínio. Use os valores da sua zona: eles podem ser diferentes dos de outra instalação. Se o registrador informar transição ou propagação, aguarde o prazo indicado. A conclusão no registrador não significa que todos os resolvedores DNS já receberam a alteração.

No Cloudflare, aguarde o domínio ficar ativo. A tela pode apresentar **Seu domínio agora está protegido pela Cloudflare**. Se ainda aparecer **Aguardando que seu registrador propague seus novos servidores de nomes**, confira os dois valores no registrador e use **Verificar nameservers agora**, quando disponível. A preparação local pode avançar durante a propagação, mas o aceite de login exige DNS e HTTPS públicos funcionando.

Escolha três endereços diferentes, todos de primeiro nível do domínio:

| Exemplo | Para que serve | Como o DNS é criado |
| --- | --- | --- |
| `fagoo.example.com` | Interface que o usuário abre no navegador | Domínio personalizado do Worker web, criado pela publicação da etapa 7 |
| `fagoo-api.example.com` | API de negócio e integrações | Domínio personalizado do Worker da API, criado pela publicação da etapa 7 |
| `fagoo-services.example.com` | Autenticação, dados e arquivos na VPS | Rota de aplicativo publicado do túnel, criada na etapa 5 |

O domínio principal pode ficar reservado para o site institucional. Não é necessário criar um endereço público para o PostgreSQL. O envio de e-mails depende de configuração SMTP própria; não é habilitado pela criação desses três endereços.

## 1. Preparar o código no Ubuntu

Use Ubuntu 24.04, acesso administrativo, uma conta Cloudflare com a zona do domínio e uma revisão pública que contenha estes scripts. Confira os requisitos do Docker e o espaço livre para imagens, banco, arquivos e backups. Prepare uma pasta persistente e obtenha o código público:

```sh
sudo apt-get update
sudo apt-get install -y git ca-certificates
sudo install -d -m 755 -o "$(id -un)" -g "$(id -gn)" /opt/fagoo
git clone --branch v0.2.0 --single-branch https://github.com/Quevenapp/Fagoo.git /opt/fagoo
cd /opt/fagoo
```

O clone público não requer token GitHub. O comando seleciona a tag `v0.2.0`, que inclui o atualizador pelo painel. Confira as [releases](https://github.com/Quevenapp/Fagoo/releases) ao instalar; não use uma branch de desenvolvimento para uma instalação operacional. A pasta de destino deve estar vazia ao executar `git clone`.

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
sudo systemctl is-active fagoo-updater.service
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
npm run install:deployment
```

O primeiro comando instala Node.js 24 a partir dos arquivos oficiais com checksum fixado e `cloudflared` pelo repositório APT oficial com verificação da chave e das assinaturas. Ele recusa substituir uma instalação Node de outra versão principal ou arquivos de configuração incompatíveis. Execute `npm run install:deployment` como o usuário dono da pasta do código: ele executa `npm ci` na raiz, em `workers/erp-api`, em `packages/fiscal-xml` e em `packages/fiscal-danfe`, respeitando os quatro lockfiles e incluindo as ferramentas de build. Nenhum desses comandos solicita token Cloudflare.

Executar somente `npm ci` na raiz não prepara os três pacotes independentes: o frontend pode compilar, mas o empacotamento da API falha por falta das dependências XML. A preparação completa é explícita e não depende de um `postinstall` automático. O helper de publicação verifica essas dependências antes do build; se indicar `DEPENDENCIES_REQUIRED`, execute novamente `npm run install:deployment` na revisão selecionada.

O helper de publicação da etapa 7 gera a configuração pública do build a partir da instalação. Não é necessário copiar segredos nem preencher manualmente os arquivos Wrangler de exemplo. Nunca copie `private/install/.env`, a chave de serviço ou o segredo JWT para variáveis `VITE_`.

## 5. Conectar o túnel e publicar o hostname de serviços

Na página da **conta** Cloudflare, abra **Rede → Túneis → Criar túnel** (**Networking → Tunnels → Create Tunnel**, em inglês), informe um nome para esta instalação e crie o túnel. Esse menu da conta é diferente do item Rede dentro de uma zona de domínio. Anote seu UUID no campo **ID do túnel**. Na tela de instalação do conector Linux, use o botão para copiar o comando de **Install as service**; ele contém uma credencial e não deve ser colado diretamente na linha de comandos durante a gravação.

No console da VPS, substitua `TUNNEL_UUID` pelo identificador do painel e execute:

```sh
sudo python3 infra/connect-tunnel.py --tunnel-id TUNNEL_UUID
```

Quando surgir o prompt oculto, cole o comando completo copiado do painel ou somente o token. O helper aceita as formas `cloudflared service install TOKEN` e `cloudflared tunnel run --token TOKEN`, com `sudo` opcional, sem executar o texto colado. Ele valida que a credencial corresponde ao UUID informado. A entrada não aparece no terminal.

O token fica em `/etc/fagoo/cloudflared/token`, com permissão `0600`, e o serviço `fagoo-cloudflared.service` passa apenas o caminho desse arquivo ao conector. Nenhum token entra na linha de comandos, na unit ou nos logs. O helper não sobrescreve configuração existente; se uma tentativa falhar, preserve os arquivos e confira o estado antes de recuperar.

Depois que o conector aparecer como **Túnel conectado com êxito**, **Íntegro** ou **Healthy**, clique em **Continuar / Continue**. Na interface observada, esse botão retorna à lista de túneis; a rota é criada em uma etapa separada:

1. Abra o túnel pelo nome na lista.
2. Entre em **Rotas → Adicionar rota → Aplicativo publicado** (**Routes → Add route → Published application**).
3. Preencha o formulário abaixo. Confira o **Hostname completo** e clique em **Adicionar rota**.

| Campo | Exemplo para esta etapa |
| --- | --- |
| Subdomínio / Subdomain | `fagoo-services`, somente o prefixo, sem `https://` |
| Domínio / Domain | `example.com`, a zona do seu domínio |
| Caminho / Path | Deixe vazio, para encaminhar todos os caminhos |
| URL do serviço / Service URL | `http://localhost:8081`, incluindo `http://` |

O formulário atual recebe o protocolo no próprio **Service URL**; não há um seletor separado de tipo HTTP. A combinação de **Subdomain** e **Domain** deve formar exatamente o hostname de `FAGOO_BACKEND_ORIGIN` escolhido na instalação. Ao salvar, o painel cria o registro DNS automaticamente; não crie um segundo registro manual para o mesmo hostname. O helper atual verifica o gateway local na porta padrão `8081`. Valide:

```sh
sudo systemctl is-active fagoo-cloudflared.service
curl --fail --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:20241/ready
curl --fail --silent --output /dev/null --write-out '%{http_code}\n' https://fagoo-services.example.com/healthz
```

Substitua o domínio de exemplo pelo hostname real. Espere `active` e respostas `200`. A verificação pública confirma DNS, certificado HTTPS e encaminhamento até a VPS. Nenhuma porta do PostgreSQL precisa ser aberta. O token do túnel é diferente do token de publicação criado na próxima etapa.

A confirmação **Rota adicionada com sucesso** mostra um CNAME apontando para `<UUID-do-túnel>.cfargotunnel.com`. Na zona do domínio, abra **DNS → Registros**: a interface atual pode exibir esse registro como tipo **Túnel**, com o nome do túnel na coluna Conteúdo, status **Com proxy** e TTL **Auto**. No túnel, a aba **Rotas** deve mostrar o hostname e `http://localhost:8081`. Se a rota já existir com esses valores, apenas confira; não salve uma segunda rota para o mesmo endereço.

## 6. Preparar a conta Cloudflare para publicar web e API

Obtenha o **ID da conta / Account ID** e o **ID da Zona / Zone ID** no painel:

1. Entre em **Domínios → seu domínio → Visão geral**.
2. Role a página até o quadro **API**, na coluna direita.
3. Use o ícone de cópia ao lado de **ID da Zona** e guarde esse valor identificado.
4. Repita para **ID da conta**, sem trocar os dois valores. Cada um tem 32 caracteres hexadecimais.

Esses identificadores não são senhas e serão argumentos do helper. Para criar o token de publicação:

1. Clique no ícone do usuário, no canto superior direito, e abra **Perfil → Tokens de API → Criar token** (**Profile → API Tokens → Create Token**).
2. Em **Token personalizado / Custom token**, clique em **Iniciar / Get started** e dê um nome ao token, por exemplo `FAGOO publicação`.
3. Em **Permissões / Permissions**, adicione estas quatro linhas:

| Escopo | Permissão | Acesso |
| --- | --- | --- |
| Conta / Account | Scripts do Workers / Workers Scripts | Editar / Edit |
| Zona / Zone | Rotas de Workers / Workers Routes | Editar / Edit |
| Zona / Zone | Zona / Zone | Lido / Read |
| Zona / Zone | DNS | Lido / Read |

4. Em **Account Resources**, restrinja o token à conta específica da instalação. Em **Zone Resources**, selecione **Specific zone** e o domínio dessa instalação.
5. Defina uma validade e anote a data: as atualizações pelo painel precisam dessa credencial válida. Um token de **30 dias** exige renovação depois desse prazo. Clique em **Continue to summary** e confira as quatro permissões, os escopos e a validade. **Pause a gravação antes de clicar em Create Token**, pois a próxima tela mostra o segredo.
6. Clique em **Criar token / Create Token**. O valor completo é mostrado **uma única vez**: copie e salve-o no seu gerenciador de senhas, com um nome como `FAGOO publicação`, a conta, o domínio e a data de expiração. Faça isso antes de clicar em **Veja todos os tokens de API** (ou **Done**, em outras versões do painel) e retomar a gravação. Use esse valor no prompt oculto da etapa 7, sem enviá-lo em mensagens ou capturas de tela.

O token de publicação será solicitado em um prompt oculto. Após uma publicação concluída, o helper o salva em `private/install/cloudflare/credentials.json`, com acesso exclusivo de root, para permitir atualizações pelo painel. Guarde também uma cópia no gerenciador de senhas. Não use o token do túnel nesse prompt. O cliente não precisa de token GitHub. Os detalhes estão em [Publicação da interface e da API](application-deployment.md).

Verifique o DNS de **somente dois hostnames**: web e API, por exemplo `fagoo.example.com` e `fagoo-api.example.com`. Se houver registros A/CNAME provisórios que entrem em conflito com esses destinos, remova apenas esses registros pelo painel antes do deploy. Preserve o domínio principal, os registros de e-mail, os demais serviços e o hostname `fagoo-services.example.com` do túnel. Se um hostname já pertencer a outro Worker, resolva sua atribuição antes de prosseguir.

O helper verifica esses conflitos e recusa a publicação quando encontra uma atribuição incompatível. Os domínios personalizados dos Workers criarão seus próprios registros gerenciados; não use opção de força para substituir outro serviço.

### Se perder o token ou ele expirar

O painel permite conferir os dados do token, mas não recuperar seu valor completo depois de fechar a tela de criação. Se você perdeu o valor e o token **ainda está válido**, substitua-o pelo fluxo abaixo:

1. Abra **Profile → API Tokens**. Na linha do token de publicação, clique em **Actions → View summary**.
2. Confira as quatro permissões, a conta, a zona e a data de expiração (**Expiration**). Se estiver expirado, siga a orientação de criação de um novo token abaixo.
3. Clique em **Back** e, na mesma linha, em **Actions → Roll**. Será exibida uma janela de confirmação.
4. **Pause a gravação antes de confirmar Roll**. Ao confirmar, o Cloudflare invalida o valor antigo e mostra o novo valor uma única vez.
5. Atualize a entrada no seu gerenciador de senhas com o novo valor. Somente depois clique em **Done** e retome a gravação. Use o novo valor na próxima publicação; qualquer outra ferramenta que usava o antigo também precisará dele.

**Roll preserva as permissões, os recursos autorizados e a validade: não prorroga a expiração.** Se o token expirou ou você precisa de uma nova validade, crie outro em **Profile → API Tokens → Create Token**, seguindo os passos desta seção com as mesmas quatro permissões e a conta/zona da instalação. Pause a gravação antes de gerar o segredo e guarde-o no gerenciador de senhas antes de fechar a tela. Esse procedimento é para o token de publicação; não substitui a credencial do túnel.

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

Os identificadores de conta e zona precisam ter os 32 caracteres hexadecimais fornecidos pelo painel. O `sudo` permite ao helper ler a configuração privada criada pelo instalador. O programa compila a interface, verifica os artefatos e empacota os Workers; só então solicita o token Cloudflare sem eco. Ele publica primeiro a API e depois a interface web do FAGOO, com os domínios definidos na instalação. A chave de serviço fica exclusivamente no Worker autorizado da API, como segredo; ela não entra no frontend.

Se uma fase falhar, confira a fase indicada e o log privado antes de repetir. Uma publicação anterior bem-sucedida não é desfeita automaticamente. Veja os controles de concorrência e os detalhes de recuperação em [Publicação da interface e da API](application-deployment.md).

Os serviços usam `SUPABASE_DEPLOYMENT=self-hosted`, a origem HTTPS local e as credenciais geradas no servidor; confira [configuração das conexões](backend-configuration.md). Os identificadores técnicos das variáveis preservam o contrato do código.

O runtime fiscal, os certificados e as credenciais bancárias são configurados conforme os módulos usados. O helper publica web e API, mas não publica o gateway/executor/Container fiscal nem habilita SMTP. Tarefas agendadas e integrações permanecem desabilitadas até configuração explícita.

### Conferir os subdomínios web e API no painel

Após `API_DEPLOY: OK` e `WEB_DEPLOY: OK`, os dois domínios já devem ter sido associados automaticamente. Para conferir:

1. Volte à página da **conta** e abra **Computação → Workers e Pages**.
2. Abra o Worker `fagoo-web-<sufixo>` e entre na aba **Domínios**. Confira o endereço web, por exemplo `fagoo.example.com`, com tipo **Produção**.
3. Volte à lista, abra `fagoo-api-<sufixo>` e entre em **Domínios**. Confira `fagoo-api.example.com`.
4. Na zona do domínio, abra **DNS → Registros**. Os dois nomes devem aparecer como **Worker**, apontando para seus respectivos aplicativos. Os registros gerenciados podem aparecer como AAAA ao abrir seus detalhes; não substitua o conteúdo por um IP da VPS.

O botão **Adicionar domínio** fica nessa aba de cada Worker. O fluxo manual atual é **Adicionar domínio → escolher a zona → digitar somente o subdomínio → Habilitar para: Produção → Adicionar domínio**. Ele serve para uma associação manual deliberada de um endereço ainda não vinculado. Na instalação padrão, o helper já fez essa etapa: não a repita nem acrescente outro hostname sem alinhar a configuração das origens do FAGOO. **Adicionar rota** é uma opção diferente; para esses endereços, use domínios personalizados.

## Critérios de aceite da instalação vazia

A implantação técnica de uma base nova está validada quando os cinco serviços estão saudáveis, o histórico do schema corresponde à revisão instalada, a origem pública de serviços responde por HTTPS, a interface permite o login do administrador e os cadastros comerciais estão vazios. Uma chamada a `/v1/me` sem sessão deve retornar `401`. Não considere a instalação validada apenas porque `/healthz` respondeu.

Abra o hostname web e entre com o administrador criado na etapa 3. Confira produtos, contatos, pedidos, estoque e financeiro pelos menus da sessão autenticada. Use a sessão conectada aos serviços da instalação para conferir os registros reais do banco. A integração externa deve permanecer desabilitada em uma instalação nova que não a configurou.

O cadastro da empresa pode ser realizado posteriormente, pela interface. Esta validação confirma a instalação vazia e o acesso ao sistema; a ativação operacional inclui configurar a empresa, os serviços de e-mail e os módulos utilizados, além de validar backup e recuperação.

Antes do uso operacional, valide também MFA, recuperação de acesso, envio e leitura de arquivos, operações da API, módulos fiscais/bancários habilitados, backup, restauração e atualização. O ensaio local do núcleo não valida carga de produção nem dimensionamento da VPS junto de agentes e outros containers.

O backup feito antes de atualizar não substitui uma rotina periódica com cópia protegida fora da VPS. Preserve também a credencial de publicação e a do túnel em `/etc/fagoo/cloudflared/token`, que não integra o backup do núcleo.

Os dados e segredos ficam separados dos artefatos de aplicação. Todas as instalações usam o mesmo [contrato de atualização](updates.md), preservando empresa, usuários, configuração e volumes persistentes.

## 8. Conferir a atualização pelo sistema

Entre como administrador e abra **Preferências → Sistema → Atualizações do sistema**. A versão instalada deve aparecer, sem aviso de publicação não configurada. Clique em **Verificar atualizações**. Se você acabou de instalar a versão mais recente, **Atualizar agora** ficará desabilitado até existir uma release posterior.

Quando houver uma versão nova, confira as notas e clique em **Atualizar agora**. O sistema obtém a release pública assinada, prepara a aplicação, salva um backup, pausa o acesso, atualiza os serviços e o banco e publica a API e a interface na Cloudflare. Aguarde **FAGOO atualizado** antes de voltar ao trabalho. Não é necessário copiar tokens para cada atualização.

Se o token Cloudflare expirar ou for renovado, salve o novo valor sem recompilar:

```sh
cd /opt/fagoo
sudo python3 infra/configure-updates.py --root /opt/fagoo
```

Cole o token no prompt oculto. Os IDs existentes são reaproveitados. Na primeira configuração manual, acrescente `--account-id ACCOUNT_ID --zone-id ZONE_ID`. Confira os detalhes, as limitações e o procedimento de [recuperação](updates.md#recuperação) antes da primeira atualização operacional. O serviço instalado na etapa 1 deve responder `active` à verificação `systemctl is-active`.
