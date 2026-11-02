#!/usr/bin/env bash
# Development/pilot fallback; production installations use signed public releases.
set -euo pipefail
umask 077
[[ "${1:-}" = '--development' && ( "$#" = 1 || ( "$#" = 2 && "${2:-}" = '--local' ) ) ]] || { echo 'Usage: sudo bash scripts/install-source.sh --development [--local]'; exit 2; }
[[ "$EUID" -eq 0 ]] || { echo 'Root is required.' >&2; exit 1; }
[[ ! -f /opt/fagoo/state/installed.json ]] || { echo 'FAGOO is already installed. Use the administrator update button.'; exit 0; }
. /etc/os-release
[[ "$ID" = ubuntu && "$VERSION_ID" = 24.04 && "$(uname -m)" = x86_64 ]] || { echo 'Supported platform: Ubuntu 24.04 amd64.' >&2; exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$root/package-lock.json" && -f "$root/infra/Dockerfile" ]] || { echo 'Run from a full checkout.' >&2; exit 1; }
[[ -f "$root/apps/web/dist/index.html" ]] || { echo 'Build the web application before running source installation: npm ci && npm run build'; exit 1; }
apt-get update -qq
if ! command -v docker >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io; fi
if ! docker compose version >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2; fi
systemctl enable --now docker
version="source-$(date -u +%Y%m%dT%H%M%SZ)"
image="fagoo/local:$version"
docker build --platform linux/amd64 -f "$root/infra/Dockerfile" -t "$image" "$root"
fagoo_home=/opt/fagoo
release="$fagoo_home/releases/$version"
install -d -m 0700 "$release"
cp -a "$root/infra" "$root/scripts" "$release/"
install -d -m 0700 "$release/apps/web"
cp -a "$root/apps/web/dist" "$root/apps/web/worker.mjs" "$release/apps/web/"
local_install=0
[[ "${2:-}" != '--local' ]] || local_install=1
export FAGOO_HOME="$fagoo_home" FAGOO_SOURCE_IMAGE=1 FAGOO_RELEASE_IMAGE="$image" FAGOO_RELEASE_VERSION="$version" FAGOO_LOCAL_INSTALL="$local_install"
bash "$release/infra/provision.sh" "$release"
python3 - "$fagoo_home/state/installed.json" "$version" <<'PY'
import json,sys
with open(sys.argv[1],'w') as f: json.dump({'version':sys.argv[2],'database_version':1,'source_install':True},f)
PY
echo 'Source installation completed. This build is not a signed production release.'
