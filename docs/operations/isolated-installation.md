# Homologação no mesmo servidor

Cada instalação precisa de uma raiz própria, uma identidade persistida e três origens HTTPS próprias. A produção existente conserva os padrões `fagoo`, `fagoo-updater.service`, `fagoo-cloudflared.service`, porta `8081` e métricas `20241`. Nenhum recurso existente é adotado pelo instalador de homologação.

Para esta homologação, use:

| Recurso | Valor |
| --- | --- |
| Raiz | `/opt/fagoo-homolog` |
| `FAGOO_INSTANCE_ID` / projeto Compose | `fagoo-homolog` |
| Gateway | `127.0.0.1:18081` |
| Atualizador | `fagoo-homolog-updater.service` |
| Túnel | `fagoo-homolog-cloudflared.service` |
| Credencial privada do túnel | `/etc/fagoo-homolog/cloudflared/token` |
| Métricas do túnel | `127.0.0.1:20242` |
| Interface | `https://fagoo-homolog.queven.app` |
| API | `https://api-fagoo-homolog.queven.app` |
| Auth, dados e arquivos | `https://services-fagoo-homolog.queven.app` |

Antes de executar, confira Ubuntu 24.04, recursos livres, versões de Docker/Compose/Python/Node 24/cloudflared, ausência da raiz e recursos do novo projeto e disponibilidade das duas portas. Registre o estado e a versão públicos da produção para comparação posterior. Não exiba `docker inspect` completo, `docker compose config` sem `--quiet`, arquivos de credenciais ou argumentos de conectores existentes.

Prepare uma cópia da revisão validada na nova raiz; não troque o checkout da produção. Na raiz nova, gere credenciais independentes:

```sh
python3 infra/configure.py \
  --instance-id fagoo-homolog \
  --local-port 18081 \
  --tunnel-metrics-port 20242 \
  --web-origin https://fagoo-homolog.queven.app \
  --backend-origin https://services-fagoo-homolog.queven.app \
  --api-origin https://api-fagoo-homolog.queven.app
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

Crie um túnel separado na conta selecionada e conecte-o com:

```sh
python3 infra/connect-tunnel.py --env-file private/install/.env --tunnel-id UUID_DO_NOVO_TUNEL
```

A credencial é recebida pelo prompt oculto. A única rota desse túnel deve apontar `services-fagoo-homolog.queven.app` para `http://localhost:18081`. Confira `/ready` na porta `20242`. Configure e publique os Workers da homologação seguindo o procedimento de publicação; seus nomes, D1 e R2 são derivados da nova origem web. Preserve a instalação de produção e seus recursos Cloudflare.

O aceite exige login real, MFA, permissões entre unidades, fila e CRM, dispositivos físicos, backup/restauração e atualização interrompida com recuperação. A aprovação dos testes locais não substitui esse aceite pela origem HTTPS da homologação.
