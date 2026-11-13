# Instalar o FAGOO

Este guia instala o FAGOO em um servidor seu com **um comando**. O instalador faz as perguntas em português, cria os endereços no seu domínio e publica o sistema. Se parar no meio, repetir o mesmo comando continua de onde parou.

Para fazer cada etapa à mão, entender o que o instalador executa ou usar um token com menos permissões, siga o [manual passo a passo](installation.md).

## O que você precisa

- **Um servidor (VPS) com Ubuntu 24.04**, novo, e os dados de acesso que a hospedagem envia: endereço IP, usuário e senha ou chave. A instalação de referência usou 1 vCPU, 4 GB de RAM e processador x86-64 (amd64).
- **Um domínio seu**, como `empresa.com.br`.
- **Uma conta na Cloudflare**. O plano gratuito atende.
- **Um gerenciador de senhas** para guardar o token da Cloudflare e a senha do administrador.

O instalador cria três endereços dentro do domínio. Não crie nada à mão:

| Endereço | Para que serve |
| --- | --- |
| `fagoo.empresa.com.br` | O sistema, que as pessoas abrem no navegador |
| `fagoo-api.empresa.com.br` | API de negócio e integrações |
| `fagoo-services.empresa.com.br` | Autenticação, dados e arquivos, que ficam no seu servidor |

O domínio principal continua livre para o site e o e-mail da empresa.

## 1. Coloque o domínio na Cloudflare

1. No painel da Cloudflare, adicione o domínio. A Cloudflare importa os registros que encontra: se o domínio já tem site ou e-mail, confira se eles aparecem na lista antes de continuar.
2. Em **Domínios → seu domínio → Visão geral**, copie os dois servidores de nomes indicados e troque-os no site onde o domínio foi registrado.
3. Aguarde a Cloudflare mostrar o domínio como **ativo**. Pode levar de minutos a algumas horas.

O instalador confere isso e avisa se o domínio ainda não estiver ativo.

## 2. Crie o token da Cloudflare

O token é a autorização para o instalador criar os endereços e publicar o sistema na sua conta.

1. Abra este link, já com quatro permissões preenchidas:
   [criar token para o FAGOO](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_routes%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=%2A&zoneId=all&name=FAGOO)
2. Acrescente a quinta permissão, que o link não preenche: **Conta → Cloudflare Tunnel → Editar**. Em algumas versões do painel ela aparece como **Cloudflare One Connector: cloudflared**.
3. Confira as cinco linhas com a tabela abaixo. Se o link não abrir o formulário preenchido, use **Perfil → Tokens de API → Criar token → Token personalizado** e adicione as cinco.

| Escopo | Permissão | Acesso |
| --- | --- | --- |
| Conta / Account | Scripts do Workers / Workers Scripts | Editar / Edit |
| Conta / Account | Cloudflare Tunnel | Editar / Edit |
| Zona / Zone | Rotas de Workers / Workers Routes | Editar / Edit |
| Zona / Zone | Zona / Zone | Lido / Read |
| Zona / Zone | DNS | Editar / Edit |

4. Em **Recursos da conta / Account Resources**, escolha a sua conta. Em **Recursos da zona / Zone Resources**, escolha **Zona específica / Specific zone** e o seu domínio.
5. Defina uma validade longa, por exemplo um ano, e anote a data. Quando o token vence, o botão **Atualizar agora** para de funcionar até você salvar um token novo.
6. Crie o token. O valor aparece **uma única vez**: salve-o no gerenciador de senhas antes de fechar a tela. Não o envie por mensagem nem o mostre em gravações.

## 3. Rode o instalador no servidor

Conecte-se ao servidor pelo terminal do seu computador (PowerShell no Windows, Terminal no macOS), trocando o usuário e o IP pelos da hospedagem:

```sh
ssh usuario@IP-DO-SERVIDOR
```

No servidor, baixe e inicie o instalador:

```sh
curl -fsSL https://raw.githubusercontent.com/Quevenapp/Fagoo/main/scripts/install.sh -o instalar-fagoo.sh
```

```sh
sudo bash instalar-fagoo.sh
```

Se o primeiro comando responder que `curl` não existe, execute `sudo apt-get install -y curl` e repita.

O instalador baixa a versão estável mais recente para `/opt/fagoo` e pergunta:

1. **O domínio**, como `empresa.com.br`.
2. **O token da Cloudflare**. Cole e pressione Enter; o valor não aparece na tela. O instalador confere o token, o domínio e os três endereços antes de instalar qualquer coisa.
3. **E-mail, nome e senha do administrador**. A senha tem no mínimo 12 caracteres e também não aparece ao digitar.

Depois da confirmação ele segue sozinho por seis etapas: serviços e banco de dados, administrador, ferramentas, ligação do servidor ao domínio, publicação e conferência. As etapas de serviços e de publicação são as mais demoradas. Ao terminar, mostra **FAGOO instalado** e o endereço do sistema.

## 4. Entre no sistema

Abra o endereço mostrado, por exemplo `https://fagoo.empresa.com.br`, e entre com o e-mail e a senha do administrador. Cadastre a empresa pelo próprio sistema.

## Se algo der errado

O instalador para, diz o que aconteceu e o que fazer. Ele não apaga nada. Depois de corrigir, **repita o mesmo comando**: as etapas concluídas não são refeitas.

| Aviso | O que fazer |
| --- | --- |
| A Cloudflare não aceitou o token | Confira se copiou o valor inteiro. Se perdeu o valor, crie outro token. |
| Falta uma permissão no token | O aviso informa qual. Edite o token no painel, acrescente a permissão e repita. |
| O domínio ainda não está ativo | Confira os servidores de nomes no registrador e aguarde a Cloudflare ativar o domínio. |
| O endereço já é usado por outro serviço | Existe um registro de DNS com esse nome. Remova-o no painel se não for mais usado, ou use outro domínio. |
| O endereço ainda não respondeu | Endereços novos podem demorar alguns minutos. Aguarde e repita. |
| Tentativa anterior deixou os serviços incompletos | O instalador não refaz essa etapa sozinho. Veja [Instalação parcial](installation.md#instalação-parcial) e peça apoio técnico. |

O registro técnico fica em `/opt/fagoo/private/install/assistant.log`, sem senhas. Envie-o a quem der suporte, se pedirem.

## Depois de instalar

- **Atualizações:** em **Preferências → Sistema → Atualizações do sistema**, pelo botão **Atualizar agora**. Veja [Atualizações do FAGOO](updates.md).
- **Token vencido ou trocado:** crie outro com as mesmas permissões e salve-o com `sudo python3 infra/configure-updates.py --root /opt/fagoo`, dentro de `/opt/fagoo`.
- **Cópia de segurança:** mantenha uma rotina com cópia fora do servidor. O backup feito antes de cada atualização não a substitui.
- **E-mail, fiscal e bancos:** convites e recuperação de senha por e-mail, emissão fiscal e cobrança bancária têm configuração própria, descrita no [manual](installation.md).

## O que o instalador cria

- **No servidor:** Docker, os serviços do FAGOO, o serviço de atualização, o conector do túnel e a pasta `/opt/fagoo`. Os dados e as credenciais ficam em `/opt/fagoo/private`, com acesso exclusivo do administrador do servidor.
- **Na Cloudflare:** um túnel com nome `fagoo-…`, os três endereços no DNS e dois aplicativos em **Workers e Pages** (`fagoo-web-…` e `fagoo-api-…`).
- **O token** fica salvo em `/opt/fagoo/private/install/cloudflare/credentials.json` para as atualizações pelo painel. Ele permite editar os aplicativos, os túneis e o DNS do domínio escolhido. As atualizações precisam de menos: depois de instalar, você pode criar um token só com as quatro permissões da [tabela do manual](installation.md#6-preparar-a-conta-cloudflare-para-publicar-web-e-api) e salvá-lo com o comando de troca acima. O túnel já criado continua funcionando, porque usa uma credencial própria.
