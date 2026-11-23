#!/bin/sh
set -u
odd="$ROOT/${ODD-"-quote' \$HOME \`backtick\` é
nl"}"
for d in home config state data cache agent "tmp with space é"; do mkdir -p -m 700 "$odd/$d"; done
cd "$REPO"
HOME="$odd/home" XDG_CONFIG_HOME="$odd/config" XDG_STATE_HOME="$odd/state" XDG_DATA_HOME="$odd/data" \
	XDG_CACHE_HOME="$odd/cache" PI_CODING_AGENT_DIR="$odd/agent" TMPDIR="$odd/tmp with space é" \
	bun run wire "${1:-pi}" "$ROOT/report.json"
echo "wire ${1:-pi} in hostile folders exited $?"
