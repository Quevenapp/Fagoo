#!/usr/bin/env bash
# Ubuntu deployment tools. No connector credentials are requested by this script.
# Node binaries: https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
# Signed Cloudflare apt repository: https://pkg.cloudflare.com/index.html
set -euo pipefail
umask 022
[[ $(id -u) == 0 ]] || { printf '%s\n' 'Run as root on Ubuntu 24.04.' >&2; exit 1; }
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || { printf '%s\n' 'Ubuntu 24.04 is required.' >&2; exit 1; }
case $(dpkg --print-architecture) in
  amd64) task_arch=x64; task_node_sha=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75 ;;
  arm64) task_arch=arm64; task_node_sha=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8 ;;
  *) printf '%s\n' 'Only amd64 and arm64 are supported.' >&2; exit 1 ;;
esac
task_install_node=true
if command -v node >/dev/null 2>&1; then
  [[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || { printf '%s\n' 'An existing Node installation uses another major version. Review it before installing Node 24.' >&2; exit 1; }
  command -v npm >/dev/null || { printf '%s\n' 'The existing Node 24 installation has no npm.' >&2; exit 1; }
  task_install_node=false
fi
apt-get update
apt-get install -y ca-certificates curl xz-utils
task_tmp=$(mktemp -d /tmp/fagoo-tools.XXXXXX)
trap '[[ "$task_tmp" == /tmp/fagoo-tools.* ]] && rm -rf -- "$task_tmp"' EXIT
if [[ "$task_install_node" == true ]]; then
  task_name="node-v24.22.2-linux-$task_arch"
  task_destination="/opt/fagoo-tools/$task_name"
  [[ ! -e "$task_destination" && ! -L "$task_destination" ]] || { printf '%s\n' 'The Node destination already exists; inspect it before retrying.' >&2; exit 1; }
  for task_program in node npm npx; do
    [[ ! -e "/usr/local/bin/$task_program" && ! -L "/usr/local/bin/$task_program" ]] || { printf '%s\n' 'An existing executable link would be replaced; installation stopped.' >&2; exit 1; }
  done
  curl --proto '=https' --tlsv1.2 -fsSL "https://nodejs.org/dist/v24.22.2/$task_name.tar.xz" -o "$task_tmp/node.tar.xz"
  printf '%s  %s\n' "$task_node_sha" "$task_tmp/node.tar.xz" | sha256sum --check --status || { printf '%s\n' 'The official Node archive checksum did not match the pinned release.' >&2; exit 1; }
  tar -xJf "$task_tmp/node.tar.xz" -C "$task_tmp"
  install -d -m 755 /opt/fagoo-tools /usr/local/bin
  mv -T -- "$task_tmp/$task_name" "$task_destination"
  for task_program in node npm npx; do
    ln -s -- "$task_destination/bin/$task_program" "/usr/local/bin/$task_program"
  done
fi
export PATH="/usr/local/bin:$PATH"
if ! command -v cloudflared >/dev/null 2>&1; then
  task_key=/usr/share/keyrings/fagoo-cloudflare.gpg
  task_repo=/etc/apt/sources.list.d/fagoo-cloudflared.list
  curl --proto '=https' --tlsv1.2 -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o "$task_tmp/cloudflare.gpg"
  printf '%s  %s\n' 1bd95f4082b320d541bee351560fc2765aa9f9cd8efa4c9e32135e63f252721d "$task_tmp/cloudflare.gpg" | sha256sum --check --status || { printf '%s\n' 'The Cloudflare signing key changed. Review the official key before updating this installer.' >&2; exit 1; }
  printf '%s\n' 'deb [signed-by=/usr/share/keyrings/fagoo-cloudflare.gpg] https://pkg.cloudflare.com/cloudflared any main' > "$task_tmp/cloudflared.list"
  for task_pair in 'cloudflare.gpg:/usr/share/keyrings/fagoo-cloudflare.gpg' 'cloudflared.list:/etc/apt/sources.list.d/fagoo-cloudflared.list'; do
    task_source=${task_pair%%:*}; task_target=${task_pair#*:}
    if [[ -e "$task_target" || -L "$task_target" ]]; then
      [[ ! -L "$task_target" ]] && cmp -s -- "$task_tmp/$task_source" "$task_target" || { printf '%s\n' 'Existing Cloudflare repository configuration differs; installation stopped.' >&2; exit 1; }
    else
      install -m 644 -- "$task_tmp/$task_source" "$task_target"
    fi
  done
  apt-get update
  apt-get install -y cloudflared
fi
cloudflared tunnel run --help > "$task_tmp/cloudflared-help.txt"
grep -q -- '--token-file' "$task_tmp/cloudflared-help.txt" || { printf '%s\n' 'This cloudflared version lacks --token-file. Update it through its package manager.' >&2; exit 1; }
node --version
npm --version
cloudflared --version
printf '%s\n' 'Deployment tools are ready. No tunnel token was requested or displayed.'
