#!/bin/sh
set -u
bun "$WORLD" claude none >world.out 2>world.err &
world=$!
until [ -s world.out ]; do sleep 0.2; done
eval "$(head -1 world.out | jq -r '.env | to_entries[] | "export \(.key)=\(.value | @sh)"')"
router() { bun "$REPO/src/router/main.ts" "$@"; }
answers() { curl -s -o /dev/null -m 1 "http://127.0.0.1:$1/"; }
since() { echo "$(($(date +%s) - $1))"; }

t=$(date +%s)
router serve --port 47411
echo "no lease: serve exited $? after $(since "$t") s"

sleep 300 &
holder=$!
router start --pid "$holder" --session recipe --folder "$PWD" --port 47411
echo "start exited $?"
answers 47411 && echo "router answers on 47411"
kill "$holder"
t=$(date +%s)
while answers 47411; do sleep 0.2; done
echo "lease ended: port closed $(since "$t") s after the holder died"

sh -c 'exit 0' &
dead=$!
wait "$dead"
router start --pid "$dead" --session recipe --folder "$PWD" --port 47412
echo "dead pid: start exited $?"

sleep 300 &
holder=$!
mkdir -p "$ROOT/empty-config"
t=$(date +%s)
XDG_CONFIG_HOME="$ROOT/empty-config" router start --pid "$holder" --session recipe --folder "$PWD" --port 47413
echo "no config: start exited $? after $(since "$t") s"
XDG_CONFIG_HOME="$ROOT/empty-config" router serve --port 47413
echo "no config: serve exited $?"
kill "$holder" "$world"
wait "$world"
