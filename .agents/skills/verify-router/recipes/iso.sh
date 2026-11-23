#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
scratch=${PHI_VERIFY_SCRATCH:-/tmp/phi-verify-router}
root=$scratch/$1
shift
rm -rf "$root"
mkdir -p "$root"
for d in home config state data cache claude codex agent tmp work; do mkdir -m 700 "$root/$d"; done
printf 'check_for_update_on_startup = false\n' >"$root/codex/config.toml"
exec env -i \
	PATH="$here:$PATH" HOME="$root/home" TMPDIR="$root/tmp" LANG=C.UTF-8 TERM=xterm-256color \
	XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state" XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache" \
	CLAUDE_CONFIG_DIR="$root/claude" CODEX_HOME="$root/codex" PI_CODING_AGENT_DIR="$root/agent" \
	PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 \
	ROOT="$root" SCRATCH="$scratch" REPO="$repo" CANARY="${CANARY:-PHI-RECIPE-CANARY-29}" WORLD="$here/world.ts" RECIPES="$here" \
	unshare ${ISO_UNSHARE:--rn} sh -c 'ip link set lo up && cd "$ROOT/work" && exec "$@"' sh "$@"
