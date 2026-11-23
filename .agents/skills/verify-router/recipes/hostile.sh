#!/bin/sh
set -u
bun "$WORLD" claude none >world.out 2>world.err &
world=$!
until [ -s world.out ]; do sleep 0.2; done
eval "$(head -1 world.out | jq -r '.env | to_entries[] | "export \(.key)=\(.value | @sh)"')"
router() { bun "$REPO/src/router/main.ts" "$@"; }
sleep 300 &
holder=$!
post() {
	label=$1 port=$2 text=$3
	shift 3
	"$@" curl -s -o /dev/null -w "$label %{http_code}\n" "http://127.0.0.1:$port/v1/messages" \
		-H 'content-type: application/json' -H 'authorization: Bearer phi-test-harness-token' \
		-H "x-claude-code-session-id: hostile-$port" \
		-d "{\"model\":\"phi/auto\",\"max_tokens\":64,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"$text\"}]}]}"
}
first_error() { grep -m1 -E "ERROR|listens" | sed "s/^.*ERROR ([^)]*): //"; }

router start --pid "$holder" --session hostile --folder "$PWD" --port 47411
post "uid 4242 canary" 47411 "Member $CANARY called." setpriv --reuid 4242 --regid 4242 --clear-groups
post "own uid clean" 47411 "List the build steps."

odd="$ROOT/state -q' \$HOME \`b\` é
nl"
ln -s "$XDG_CONFIG_HOME" "$ROOT/config-link"
XDG_STATE_HOME="$odd" XDG_CONFIG_HOME="$ROOT/config-link" router start --pid "$holder" --session hostile --folder "$PWD" --port 47412
post "odd state folder, symlinked config folder" 47412 "List the build steps."
(cd "$odd" && find . -printf '%m %p\n' | sort -k2)

bad="$ROOT/bad/phi-router"
mkdir -p -m 700 "$bad"
printf '{"clean":' >"$bad/config.json"
chmod 600 "$bad/config.json"
echo "corrupt config: $(XDG_CONFIG_HOME="$ROOT/bad" timeout 8 bun "$REPO/src/router/main.ts" serve --port 47413 2>&1 | first_error)"
cp "$XDG_CONFIG_HOME/phi-router/config.json" "$bad/config.json"
chmod 644 "$bad/config.json"
echo "config mode 0644: $(XDG_CONFIG_HOME="$ROOT/bad" timeout 8 bun "$REPO/src/router/main.ts" serve --port 47414 2>&1 | first_error)"
echo "BAA key env unset: $(env -u PHI_TEST_BAA_KEY timeout 8 bun "$REPO/src/router/main.ts" serve --port 47415 2>&1 | first_error)"

kill "$holder" "$world"
wait "$world"
tail -1 world.out
