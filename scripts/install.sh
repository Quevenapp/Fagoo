#!/usr/bin/env bash
# One-command FAGOO installation for Ubuntu 24.04.
# Run from a downloaded copy, it fetches the latest stable release into /opt/fagoo and starts
# the assistant; run from a checkout (sudo bash scripts/install.sh), it uses that checkout.
# Repeating the command continues an installation from the stage that was missing.
set -euo pipefail
task_fail() { printf '\n%s\n' "$1" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || task_fail 'Execute com sudo: sudo bash '"${BASH_SOURCE[0]:-instalar-fagoo.sh}"
[[ -r /etc/os-release ]] || task_fail 'Este instalador funciona somente no Ubuntu 24.04.'
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || task_fail 'Este instalador funciona somente no Ubuntu 24.04.'

task_self=${BASH_SOURCE[0]:-}
task_root=/opt/fagoo
if [[ -n "$task_self" && -f "$(dirname -- "$task_self")/../infra/install-assistant.py" ]]; then
  task_root=$(cd -- "$(dirname -- "$task_self")/.." && pwd)
fi

if [[ ! -f "$task_root/infra/install-assistant.py" ]]; then
  printf '%s\n' 'Preparando o servidor para baixar o FAGOO...'
  apt-get update
  apt-get install -y git ca-certificates curl python3
  if [[ -d "$task_root/.git" || -f "$task_root/infra/compose.yaml" ]]; then
    task_fail "A pasta $task_root já contém uma versão do FAGOO sem o assistente de instalação. Siga o manual dessa versão (docs/operations/installation.md) ou atualize pelo painel; o instalador não substitui uma instalação existente."
  fi
  if [[ -e "$task_root" && -n "$(ls -A -- "$task_root" 2>/dev/null)" ]]; then
    task_fail "A pasta $task_root já existe e não está vazia. O instalador não apaga arquivos: confira o conteúdo com quem administra o servidor."
  fi
  # The stable channel is the release marked Latest, the same one the update button offers.
  task_latest=$(curl --proto '=https' --tlsv1.2 -fsSL -o /dev/null -w '%{url_effective}' https://github.com/Quevenapp/Fagoo/releases/latest) \
    || task_fail 'Não foi possível consultar a versão mais recente do FAGOO. Confira a conexão do servidor com a internet e repita o comando.'
  task_tag=${task_latest##*/}
  [[ $task_tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || task_fail 'A consulta da versão mais recente devolveu uma resposta inesperada. Aguarde alguns minutos e repita o comando.'
  printf '%s\n' "Baixando o FAGOO $task_tag..."
  install -d -m 755 "$task_root"
  git clone --branch "$task_tag" --single-branch https://github.com/Quevenapp/Fagoo.git "$task_root" \
    || task_fail 'O download do FAGOO não terminou. Confira a conexão e o espaço em disco; se a pasta '"$task_root"' ficou incompleta, peça a quem administra o servidor para conferi-la antes de repetir.'
  [[ -f "$task_root/infra/install-assistant.py" ]] \
    || task_fail "O FAGOO $task_tag ainda não inclui o assistente de instalação. Siga o manual dessa versão: $task_root/docs/operations/installation.md"
elif ! command -v python3 >/dev/null 2>&1; then
  apt-get update
  apt-get install -y python3
fi

cd "$task_root"
# The assistant asks questions and hides secrets, so it needs the terminal even when this
# script itself arrived through a pipe.
if [[ -t 0 ]]; then
  exec python3 infra/install-assistant.py "$@"
fi
[[ -r /dev/tty ]] || task_fail 'O instalador precisa de um terminal. Conecte-se ao servidor por SSH e execute o comando diretamente.'
exec python3 infra/install-assistant.py "$@" </dev/tty
