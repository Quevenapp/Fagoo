# Instalação do FAGOO

O instalador é destinado a **Ubuntu Server 24.04 LTS, amd64, com systemd**, pelo menos 4 GB de RAM e 5 GB de espaço livre além dos dados previstos. Ele administra somente `/opt/fagoo`, serviços `fagoo-*` e o projeto Docker Compose `fagoo`. O PostgreSQL não publica porta externa; o acesso inicial à API fica em `127.0.0.1:8080`.

O container de atendimento existente e seus volumes não são removidos nem reconfigurados. Se a porta 8080 já estiver ocupada, o instalador escolhe uma porta livre até 8099 e informa o endereço final; ajuste os exemplos de acesso a essa porta. Confirme a disponibilidade de recursos considerando todos os serviços da VPS. A capacidade de 5–15 usuários simultâneos ainda depende de ensaio com a carga real.

## Instalação por release pública

Escolha uma versão publicada em [Releases](https://github.com/Quevenapp/Fagoo/releases). Uma pré-release exige informar a versão explicitamente; o endereço `latest` do GitHub não seleciona pré-releases.

```bash
curl --proto '=https' --tlsv1.2 -fL \
  https://github.com/Quevenapp/Fagoo/releases/download/v0.1.0-alpha.1/install.sh \
  -o install.sh
less install.sh
sudo bash install.sh v0.1.0-alpha.1
```

Não há token de licença ou download. O bootstrap verifica a assinatura Ed25519 e os hashes dos pacotes. A imagem pré-compilada pode ser distribuída como arquivo público: o instalador verifica o arquivo, carrega-o no Docker e confere o identificador exato da imagem. Não é necessário acesso a um registry privado nem compilar a aplicação na VPS.

O instalador solicita o endereço público HTTPS, empresa, nome e e-mail do administrador e uma senha de 12–128 caracteres. A senha é enviada à criação do administrador pela entrada padrão, sem aparecer na linha de comando. Ao retomar uma instalação incompleta, verifica se o administrador já existe.

A instalação não publica recursos Cloudflare automaticamente. Depois de iniciar os serviços locais, execute o assistente abaixo na VPS do cliente. O endereço definitivo informado no instalador deve ser o mesmo hostname público do assistente.

Para ensaiar a instalação completa sem configurar Cloudflare ou domínio, use explicitamente `sudo bash install.sh v0.1.0-alpha.1 --local`. Nesse modo a interface e a API são servidas na mesma origem `http://localhost:8080`, vinculada apenas ao loopback. Em uma VPS remota, abra um túnel SSH com `ssh -L 8080:127.0.0.1:8080 usuario@servidor` e acesse esse endereço no seu navegador. O modo local não publica HTTP na internet. Para adotar o domínio definitivo posteriormente, atualize `FAGOO_PUBLIC_URL` no arquivo privado de configuração antes de executar o assistente Cloudflare.

## Configuração Cloudflare do cliente

Use uma conta e zona próprias do cliente. Separe os hostnames público (`erp.exemplo.com`) e de origem (`origem-erp.exemplo.com`). Ambos precisam pertencer à zona escolhida e estar livres para esta instalação.

Crie um token limitado à conta/zona necessárias com permissões de edição de Cloudflare Tunnel, Workers Scripts, Workers Routes e DNS, além da leitura da zona. O token de configuração e atualização é diferente de um token de download: o primeiro autoriza alterações nos recursos do cliente; o segundo não existe no FAGOO.

Revise primeiro o plano local, sem chamadas de alteração:

```bash
sudo python3 /opt/fagoo/current/scripts/install-cloudflare.py \
  --account-id SEU_ACCOUNT_ID --zone-id SEU_ZONE_ID \
  --hostname erp.exemplo.com --origin-hostname origem-erp.exemplo.com
```

Para executar a configuração na conta informada, acrescente `--apply`. O token será solicitado sem eco no terminal. O assistente cria um túnel exclusivo, configura a origem `http://api:3000`, cria o CNAME de origem, inicia somente o túnel do FAGOO e publica os arquivos web pré-compilados. Uma chave compartilhada entre Worker e API protege o acesso à origem.

O assistente recusa registros DNS preexistentes que não pertençam à configuração local. Se uma chamada falhar, conserva o estado para retomar o mesmo túnel, sem apagar recursos. Não execute o assistente em uma zona de outra instalação.

Depois da primeira configuração, o atualizador pode publicar a interface da mesma instalação junto com a atualização da API. Sem configuração Cloudflare, o resultado informa expressamente que a interface pública continua pendente.

As credenciais ficam em arquivos privados de `/opt/fagoo/secrets`. O container da API não recebe o token Cloudflare nem o socket do Docker. O runtime de publicação usa uma versão fixa do Wrangler incluída na imagem verificada.

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
