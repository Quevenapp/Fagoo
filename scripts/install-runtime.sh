#!/usr/bin/env bash
# Installs the common local runtime only. Public HTTPS/Worker setup is a separate step.
# Usage: install-runtime.sh [--domain example.com | --web-origin URL --backend-origin URL --api-origin URL]
# Without arguments it asks for the domain. scripts/install.sh runs the whole installation.
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$task_root"
if [[ $(id -u) -ne 0 ]]; then
  printf '%s\n' 'Execute este script com sudo no Ubuntu. Ele instala dependências do sistema operacional.' >&2
  exit 1
fi
. /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 ]]; then
  printf '%s\n' 'Este instalador funciona somente no Ubuntu 24.04.' >&2
  exit 1
fi
apt-get update
apt-get install -y ca-certificates curl python3 openssl
task_origins=("$@")
if [[ ! -f private/install/.env ]]; then
  # Validate the addresses before installing Docker; create nothing until the runtime checks pass.
  if [[ ${#task_origins[@]} -eq 0 ]]; then
    printf '%s\n' 'O FAGOO usa três endereços dentro do seu domínio: fagoo, fagoo-services e fagoo-api.'
    read -r -p 'Domínio da instalação (exemplo: empresa.com.br): ' task_domain
    task_origins=(--domain "$task_domain")
  fi
  if ! python3 infra/configure.py --check "${task_origins[@]}"; then
    printf '%s\n' 'Domínio ou endereços inválidos. Informe somente o domínio, como empresa.com.br, sem https:// e sem caminho.' >&2
    exit 1
  fi
fi
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
task_existing_containers=$(docker ps -aq --filter label=com.docker.compose.project=fagoo)
task_existing_volumes=$(docker volume ls -q --filter label=com.docker.compose.project=fagoo)
task_all_volumes=$(docker volume ls -q)
task_named_volume_exists=false
while IFS= read -r task_volume; do
  case "$task_volume" in
    fagoo_database|fagoo_database-config|fagoo_objects) task_named_volume_exists=true ;;
  esac
done <<< "$task_all_volumes"
if [[ -n "$task_existing_containers" || -n "$task_existing_volumes" || "$task_named_volume_exists" == true ]]; then
  printf '%s\n' 'FAGOO_RUNTIME_EXISTS: já existe uma instalação do FAGOO, completa ou parcial, neste servidor. Este instalador não substitui serviços nem volumes. Use o painel para atualizar uma instalação concluída; uma instalação parcial precisa ser conferida antes da recuperação. Não remova volumes para forçar uma nova instalação.' >&2
  exit 1
fi
if [[ ! -f private/install/.env ]]; then
  python3 infra/configure.py "${task_origins[@]}"
fi
docker compose --project-name fagoo --env-file private/install/.env -f infra/compose.yaml config --quiet
docker compose --project-name fagoo --env-file private/install/.env -f infra/compose.yaml up -d --wait --wait-timeout 300
python3 infra/bootstrap-owner.py
python3 infra/migrate.py --initialize-standalone
python3 infra/install-updater.py
printf '%s\n' 'Núcleo local e banco prontos, acessíveis somente dentro do servidor. Faltam o administrador, o endereço HTTPS, a interface e a API.'
printf '%s\n' 'Para continuar com o assistente: sudo bash scripts/install.sh'
printf '%s\n' 'Para continuar pelo manual: sudo python3 infra/create-admin.py --email SEU_EMAIL --name "SEU NOME"'
