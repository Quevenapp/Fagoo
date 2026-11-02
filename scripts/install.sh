#!/usr/bin/env bash
# Public bootstrap. Download this file, inspect it, then execute it as root.
set -euo pipefail
umask 077
if [[ "${1:-}" = '--help' ]]; then
  echo 'Usage: sudo bash install.sh [vX.Y.Z] [--local]'; echo 'Requires Ubuntu 24.04 amd64. Downloads signed public release; no download token.'; exit 0
fi
[[ "$EUID" -eq 0 ]] || { echo 'Run installer as root.' >&2; exit 1; }
[[ ! -f /opt/fagoo/state/installed.json ]] || { echo 'FAGOO is already installed. Use the administrator update button.'; exit 0; }
[[ -f /etc/os-release ]] || { echo 'Ubuntu 24.04 required.' >&2; exit 1; }
. /etc/os-release
[[ "$ID" = ubuntu && "$VERSION_ID" = 24.04 && "$(uname -m)" = x86_64 ]] || { echo 'Supported platform: Ubuntu 24.04 amd64.' >&2; exit 1; }
version=latest
local_install=0
for argument in "$@"; do
  if [[ "$argument" = '--local' ]]; then local_install=1; elif [[ "$version" = latest ]]; then version="$argument"; else echo 'Unexpected installer argument.' >&2; exit 2; fi
done
[[ "$version" = latest || "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$ ]] || { echo 'Invalid release version.' >&2; exit 2; }
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl openssl python3
scratch="$(mktemp -d)"
trap 'rm -f -- "$scratch/manifest.json" "$scratch/manifest.sig" "$scratch/public.pem" "$scratch/deployment.tar.gz"; rmdir -- "$scratch" 2>/dev/null || true' EXIT
cat > "$scratch/public.pem" <<'KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9xReh8TYP6xR/oR6FAl1n3LnrDI8yEEL4Q57VKpOm4o=
-----END PUBLIC KEY-----
KEY
if [[ "$version" = latest ]]; then base='https://github.com/Quevenapp/Fagoo/releases/latest/download'; else base="https://github.com/Quevenapp/Fagoo/releases/download/$version"; fi
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-filesize 65536 "$base/manifest.json" -o "$scratch/manifest.json"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-filesize 64 "$base/manifest.sig" -o "$scratch/manifest.sig"
openssl pkeyutl -verify -pubin -inkey "$scratch/public.pem" -rawin -in "$scratch/manifest.json" -sigfile "$scratch/manifest.sig" > /dev/null
mapfile -t fields < <(python3 - "$scratch/manifest.json" <<'PY'
import json,re,sys
m=json.load(open(sys.argv[1]))
assert m['schema']==1 and m['product']=='fagoo' and m['platform']=='linux/amd64' and m['minimum_updater']==1
assert re.fullmatch(r'v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?',m['version'])
assert re.fullmatch(r'(?:ghcr\.io/quevenapp/fagoo@)?sha256:[a-f0-9]{64}',m['image'])
a=m['artifact']; assert a['url']==f"https://github.com/Quevenapp/Fagoo/releases/download/{m['version']}/deployment.tar.gz"
assert re.fullmatch('[a-f0-9]{64}',a['sha256']) and type(a['size']) is int and 0<a['size']<=50*1024*1024
assert type(m['database_version']) is int and type(m['compatible_database_min']) is int and 1<=m['compatible_database_min']<=m['database_version']
for x in (m['version'],m['image'],a['url'],a['size']): print(x)
PY
)
[[ "${#fields[@]}" -eq 4 ]] || { echo 'Invalid release manifest.' >&2; exit 1; }
[[ "$version" = latest || "$version" = "${fields[0]}" ]] || { echo 'Release version mismatch.' >&2; exit 1; }
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --max-filesize "${fields[3]}" "${fields[2]}" -o "$scratch/deployment.tar.gz"
fagoo_home='/opt/fagoo'
release="$fagoo_home/releases/${fields[0]}"
install -d -m 0700 "$fagoo_home" "$fagoo_home/releases" "$fagoo_home/updater" "$fagoo_home/state"
python3 - "$scratch/manifest.json" "$scratch/deployment.tar.gz" "$release" <<'PY'
import hashlib,json,pathlib,sys,tarfile
m=json.load(open(sys.argv[1])); path=pathlib.Path(sys.argv[2]); data=path.read_bytes()
assert len(data)==m['artifact']['size'] and hashlib.sha256(data).hexdigest()==m['artifact']['sha256'],'Invalid package digest'
root=pathlib.Path(sys.argv[3]); root.mkdir(parents=True,exist_ok=True); root=root.resolve(); total=0
with tarfile.open(path,'r:gz') as bundle:
 members=bundle.getmembers(); assert len(members)<=5000
 for item in members:
  assert (root/item.name).resolve().is_relative_to(root) and '\\' not in item.name and (item.isfile() or item.isdir()),'Unsafe archive path'
  total+=item.size; assert total<=100*1024*1024,'Expanded archive too large'
 bundle.extractall(root,members=members,filter='data')
assert (root/'infra/provision.sh').is_file(),'Incomplete deployment package'
PY
install -m 0644 "$scratch/public.pem" "$fagoo_home/updater/release-root.pem"
install -m 0600 "$scratch/manifest.json" "$fagoo_home/state/install-manifest.json"
install -m 0600 "$scratch/manifest.sig" "$fagoo_home/state/install-manifest.sig"
export FAGOO_RELEASE_VERSION="${fields[0]}" FAGOO_RELEASE_IMAGE="${fields[1]}" FAGOO_HOME="$fagoo_home" FAGOO_LOCAL_INSTALL="$local_install"
bash "$release/infra/provision.sh" "$release"
install -m 0600 "$scratch/manifest.json" "$fagoo_home/state/installed.json"
echo "Installed verified FAGOO ${fields[0]}. Cloudflare is configured separately by the installation guide."
