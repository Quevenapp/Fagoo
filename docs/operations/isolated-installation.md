# Homologação no mesmo servidor

Cada instalação precisa de uma raiz própria, uma identidade persistida e três origens HTTPS próprias. A produção existente conserva os padrões `fagoo`, `fagoo-updater.service`, `fagoo-cloudflared.service`, porta `8081` e métricas `20241`. Nenhum recurso existente é adotado pelo instalador de homologação.

Para esta homologação, use:

| Recurso | Valor |
| --- | --- |
| Conta Cloudflare | Fagoo — `d534038b992cdfbb065cb97a81442afc` |
| Zona Cloudflare | `fagoo.com.br` — `7b7a1b39964797b972f25e4777fce738` |
| Raiz | `/opt/fagoo-homolog` |
| `FAGOO_INSTANCE_ID` / projeto Compose | `fagoo-homolog` |
| Gateway | `127.0.0.1:18081` |
| Atualizador | `fagoo-homolog-updater.service` |
| Túnel | `fagoo-homolog-cloudflared.service` |
| Credencial privada do túnel | `/etc/fagoo-homolog/cloudflared/token` |
| Métricas do túnel | `127.0.0.1:20242` |
| Interface | `https://homolog.fagoo.com.br` |
| API | `https://api-homolog.fagoo.com.br` |
| Auth, dados e arquivos | `https://services-homolog.fagoo.com.br` |

Antes de executar, confira Ubuntu 24.04, recursos livres, versões de Docker/Compose/Python/Node 24/cloudflared, ausência da raiz e recursos do novo projeto e disponibilidade das duas portas. Registre o estado e a versão públicos da produção para comparação posterior. Não exiba `docker inspect` completo, `docker compose config` sem `--quiet`, arquivos de credenciais ou argumentos de conectores existentes.

Prepare uma cópia da revisão validada na nova raiz; não troque o checkout da produção. Somente se a configuração ainda não existir, gere credenciais independentes:

```sh
python3 infra/configure.py \
  --instance-id fagoo-homolog \
  --local-port 18081 \
  --tunnel-metrics-port 20242 \
  --web-origin https://homolog.fagoo.com.br \
  --backend-origin https://services-homolog.fagoo.com.br \
  --api-origin https://api-homolog.fagoo.com.br
bash scripts/install-runtime.sh --skip-system-packages
```

O modo `--skip-system-packages` exige as ferramentas existentes e não instala pacotes, repositórios ou Docker no host. Os recursos do projeto de destino e as portas são conferidos antes das mutações. Uma configuração existente não é sobrescrita; uma instalação parcial interrompe o instalador para inspeção. Não remova volumes nem credenciais para forçar uma repetição.

Os helpers de banco usam a identidade de `private/install/.env`; um `--project-name` divergente dessa identidade persistida é recusado. O Compose cria rede e volumes próprios, por exemplo `fagoo-homolog_database` e `fagoo-homolog_objects`. Atualizador, backups, socket e logs permanecem na raiz da homologação. As rotinas manual e automática compartilham o lock dessa raiz.

Confira o núcleo sem imprimir segredos:

```sh
docker compose --project-name fagoo-homolog --env-file private/install/.env -f infra/compose.yaml ps
curl --fail --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:18081/healthz
python3 infra/migrate.py --check-only
systemctl is-active fagoo-homolog-updater.service
systemctl is-active fagoo-updater.service fagoo-cloudflared.service
```

Crie somente usuários e dados sintéticos para o aceite. O administrador inicial usa `infra/create-admin.py`; a senha é solicitada sem eco. Não reutilize usuários, MFA, banco ou chaves da produção.

Crie um túnel separado na conta **Fagoo** identificada acima e conecte-o com:

```sh
python3 infra/connect-tunnel.py --env-file private/install/.env \
  --account-id d534038b992cdfbb065cb97a81442afc --tunnel-id UUID_DO_NOVO_TUNEL
```

A credencial é recebida pelo prompt oculto. A única rota desse túnel deve apontar `services-homolog.fagoo.com.br` para `http://localhost:18081`. Confira `/ready` na porta `20242`. Configure e publique os Workers da homologação seguindo o procedimento de publicação, com a conta Fagoo e a zona `fagoo.com.br` acima; seus nomes, D1 e R2 são derivados da nova origem web. A credencial Cloudflare privada deve ter os mesmos `account_id` e `zone_id`; o publicador recusa divergências. Preserve a instalação de produção e seus recursos Cloudflare.

Quando o SSH autorizado não permite terminal interativo, transfira a credencial por SCP para um arquivo privado na raiz da homologação. Execute como root com `--token-file /opt/fagoo-homolog/private/transfer/tunnel.token`, mantendo também `--account-id` e `--tunnel-id`. O arquivo precisa pertencer a root, ser regular, ter permissão `0600` ou mais restrita e não atravessar links simbólicos. O conector confere conta e UUID antes da escrita; o segredo não entra nos argumentos, logs ou no ambiente do serviço. Essa opção preserva as verificações de instalação, porta e saúde local.

## Corrigir somente as origens de uma homologação já criada

`infra/configure.py` cria arquivos exclusivamente com `O_EXCL` e gera novas chaves. Não é um editor de configuração. Não apague `.env` ou `frontend.env` para executá-lo novamente: isso trocaria a identidade criptográfica e a senha de acesso ao banco existente.

1. Confirme a raiz `/opt/fagoo-homolog`, o escopo persistido `fagoo-homolog`, as portas `18081`/`20242` e a ausência de atualização em execução. Use o lock `private/update-fagoo.lock` dessa raiz durante a manutenção. Faça cópias privadas dos arquivos existentes em uma pasta exclusiva, com diretório `0700` e arquivos `0600`; não imprima o conteúdo nem um diff da configuração.
2. Leia e valide o arquivo existente. Substitua exclusivamente `FAGOO_WEB_ORIGIN`, `FAGOO_BACKEND_ORIGIN` e `FAGOO_API_ORIGIN` pelos três destinos da tabela. Valide as origens com `configure.origin`, exigindo HTTPS e três valores distintos. Prepare a substituição em arquivo temporário privado no mesmo diretório e troque-o atomicamente. Compare antes e depois: todas as demais chaves e valores precisam continuar idênticos, incluindo senha do PostgreSQL, JWT, chaves de serviço, token/socket do atualizador, escopo, portas e integrações.
3. Em `private/install/frontend.env`, ajuste somente `VITE_SUPABASE_URL` e `VITE_ERP_API_URL`. Preserve `VITE_SUPABASE_ANON_KEY` e os demais valores. Prepare e valide ambos os arquivos antes de substituir qualquer um; conserve os backups caso a segunda troca falhe. O publicador oficial lê a configuração privada diretamente para gerar o ambiente do novo build.
4. Confira `docker compose --project-name fagoo-homolog --env-file private/install/.env -f infra/compose.yaml config --quiet`. Recrie somente `auth`, `storage` e `gateway` desse projeto com `up -d --no-deps --wait --wait-timeout 300 auth storage gateway`. Isso aplica URLs de Auth/storage, emissor JWT e CORS sem recriar o banco ou seus volumes. Verifique a saúde local e preserve o ledger de migrações. Refazer migrações ou rodar o instalador inicial não é necessário para essa correção.
5. Antes de publicar, confira `private/install/communication.json`, se existir, e a credencial em `private/install/cloudflare/credentials.json`. O estado da comunicação vincula origem, conta, chave mestra e IDs de recursos; origem/conta divergentes causam `COMMUNICATION_INSTALLATION_MISMATCH`. Não apague esse estado nem reescreva IDs para passar pela verificação. Havendo recursos provisionados no destino anterior, reconcilie e preserve os dados, chaves e recibos com o procedimento de backup/restauração antes de planejar a mudança de conta. Uma homologação cujo estado de comunicação ainda não existe pode provisionar recursos novos na conta Fagoo.
6. Confirme que o túnel de homologação pertence à conta Fagoo e que a rota HTTPS usa `services-homolog.fagoo.com.br`. Credenciais de outra conta não são transferidas apenas mudando nomes de host. Faça um novo build e um novo `--dry-run` do publicador com os IDs abaixo; o build preparado para as origens anteriores deixa de ser válido. Somente depois publique, verifique as duas versões públicas, login/MFA, acesso por unidade e a preservação dos dados sintéticos.

```sh
python3 infra/deploy-application.py \
  --env-file private/install/.env \
  --account-id d534038b992cdfbb065cb97a81442afc \
  --zone-id 7b7a1b39964797b972f25e4777fce738 \
  --dry-run
```

Essa correção conserva o projeto Compose, nomes de serviços, portas, volumes, banco e credenciais da homologação. Não altera a instalação de produção.

O aceite exige login real, MFA, permissões entre unidades, fila e CRM, dispositivos físicos, backup/restauração e atualização interrompida com recuperação. A aprovação dos testes locais não substitui esse aceite pela origem HTTPS da homologação.
