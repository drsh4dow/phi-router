#!/bin/sh
set -u
harness=$1
phi() { "$REPO/plugins/claude/bin/phi-router" "$@"; }
tm() { tmux -S "$ROOT/tmux.sock" "$@"; }

case $harness in
claude)
	claude plugin marketplace add "$REPO" >setup.log 2>&1
	claude plugin install phi-router@phi-router --scope user >>setup.log 2>&1
	;;
codex)
	codex plugin marketplace add "$REPO" >setup.log 2>&1
	codex plugin add phi-router@phi-router >>setup.log 2>&1
	printf '{"OPENAI_API_KEY":"phi-test-harness-token"}' >"$CODEX_HOME/auth.json"
	;;
pi)
	printf '{"anthropic":{"type":"oauth","access":"phi-test-harness-token","refresh":"r","expires":4102444800000}}' >"$PI_CODING_AGENT_DIR/auth.json"
	printf '{"packages":["%s"],"retry":{"enabled":false}}' "$REPO" >"$PI_CODING_AGENT_DIR/settings.json"
	;;
esac
[ "$harness" = pi ] || phi on "$harness" >>setup.log 2>&1 || {
	echo "FAIL phi-router on $harness"
	tail -5 setup.log
	exit 1
}

# Sends one canary prompt the way a person does and prints the lines the harness shows for it.
prompted() {
	case $harness in
	claude)
		ANTHROPIC_AUTH_TOKEN=phi-test-harness-token timeout 120 claude -p "Reply ok. $CANARY" --model "${MODEL:-phi/auto}" 2>&1
		;;
	pi)
		timeout 120 pi -p "Reply ok. $CANARY" --model "${MODEL:-phi/auto}" 2>&1
		;;
	codex)
		tm new-session -d -s codex -x 200 -y 50 codex --no-daemon --dangerously-bypass-hook-trust ${MODEL:+-m "$MODEL"}
		sleep 4
		tm send-keys -t codex -l "Reply ok. $CANARY"
		sleep 1
		tm send-keys -t codex Enter
		sleep "${CODEX_WAIT:-15}"
		tm capture-pane -p -J -t codex
		tm kill-server
		;;
	esac
}

shown() {
	label=$1
	echo "== $label"
	prompted >"$label.out"
	grep -F phi-router "$label.out" | sed 's/^[[:space:]│■⚠✗•]*//' | sort -u
}

config="$XDG_CONFIG_HOME/phi-router"

shown "no config.json"

# Starts the mocks with the BAA mock answering $1 and waits for the line that names their folders.
mocks() {
	rm -f world.out
	BAA_STATUS=$1 bun "$WORLD" "$harness" none >world.out 2>world.err &
	world=$!
	until [ -s world.out ]; do sleep 0.2; done
}

mocks 200
mkdir -p "$config"
jq --arg key "$ROOT/baa.key" '.sealed[0] |= (del(.keyEnv) + {keyCommand: "cat \($key)"})' \
	"$(head -1 world.out | jq -r .env.XDG_CONFIG_HOME)/phi-router/config.json" >"$config/config.json"
shown "a config.json whose key file is missing"
kill "$world"
wait "$world" 2>/dev/null

printf '{' >"$config/config.json"
CODEX_WAIT=30 shown "a router that cannot start"
rm -rf "$config"

mocks 401
eval "$(head -1 world.out | jq -r '.env | to_entries[] | "export \(.key)=\(.value | @sh)"')"
MODEL=phi/sealed shown "a BAA account that answers 401"
kill "$world"
wait "$world" 2>/dev/null
tail -1 world.out
