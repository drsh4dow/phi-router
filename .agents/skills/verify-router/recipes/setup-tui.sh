#!/bin/sh
set -u
world=${1:-max}
failed=0
fail() {
	echo "FAIL $1"
	failed=1
}
key=PHI-KEY-CANARY
anthropic_key="sk-ant-api03-$key-anthropic-0123456789"
openai_key="sk-proj-$key-openai-9876543210"
shots=$ROOT/captures
mkdir -p "$shots"
CANARY=$key bun "$WORLD" pi none >world.out 2>world.err &
mocks=$!
until [ -s world.out ]; do sleep 0.2; done
open=$(jq -r '.clean[0].endpoint' "$(head -1 world.out | jq -r '.env.XDG_CONFIG_HOME')/phi-router/config.json")
bun "$RECIPES/key-check.ts" "$ROOT/key-checks.log" >key-check.out &
checks=$!
until [ -s key-check.out ]; do sleep 0.2; done
export PHI_ROUTER_KEY_CHECK_ENDPOINT="$(cat key-check.out)"
login='{"anthropic":{"type":"oauth","access":"phi-test-harness-token","refresh":"r","expires":4102444800000}}'
case $world in *apikey) login='{"anthropic":{"type":"api_key","key":"sk-ant-api03-phi-test-harness-key"}}' ;; esac
printf '%s' "$login" >"$PI_CODING_AGENT_DIR/auth.json"
printf '{"packages":["%s"],"retry":{"enabled":false}}' "$REPO" >"$PI_CODING_AGENT_DIR/settings.json"
printf '{"providers":{"anthropic":{"baseUrl":"%s"}}}' "$open" >"$PI_CODING_AGENT_DIR/models.json"
case $world in enterprise | headless)
	mkdir -p "$ROOT/bin"
	cat >"$ROOT/bin/claude" <<'EOF'
#!/bin/sh
case "$*" in
"auth status --json")
	if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
		echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"you@example.com","subscriptionType":"enterprise"}'
	else
		echo '{"loggedIn":false}'
	fi ;;
"auth login"*)
	echo "Opening browser to sign in…"
	printf '{"claudeAiOauth":{"accessToken":"fake","refreshToken":"r","expiresAt":4102444800000}}' >"$CLAUDE_CONFIG_DIR/.credentials.json" ;;
*) exit 1 ;;
esac
EOF
	chmod +x "$ROOT/bin/claude"
	export PATH="$ROOT/bin:$PATH"
	;;
esac
[ "$world" = enterprise ] && export BROWSER=true
[ "$world" = headless ] && echo "pi starts with DISPLAY='${DISPLAY-}' BROWSER='${BROWSER-}' WAYLAND_DISPLAY='${WAYLAND_DISPLAY-}'"
tm() { tmux -S "$ROOT/tmux.sock" "$@"; }
shot() { tm capture-pane -p -J -t pi >"$shots/$1.txt"; }
wait_for() {
	t=$(date +%s)
	until tm capture-pane -p -J -t pi | grep -qF "$1"; do
		[ $(($(date +%s) - t)) -ge "${2:-20}" ] && return 1
		sleep 0.3
	done
}
case $world in terminal*)
	tm new-session -d -s pi -x 140 -y 40 "$REPO/plugins/claude/bin/phi-router setup pi; sleep 30"
	wait_for "phi-router found" 30 || fail "the terminal form showed nothing"
	sleep 2
	shot "$world"
	grep -v '^\s*$' "$shots/$world.txt"
	tm kill-server 2>/dev/null
	kill "$checks" "$mocks"
	exit "$failed"
	;;
esac
phi_setup() {
	tm send-keys -t pi -l '/phi setup'
	sleep 0.5
	tm send-keys -t pi Enter
}
keys_in() {
	wait_for "Which account does your BAA cover?" 30 || fail "pi showed no BAA question"
	shot baa-pick
	if [ "$world" != max ]; then tm send-keys -t pi Down; sleep 0.3; fi
	tm send-keys -t pi Enter
	if [ "$world" = max ]; then
		wait_for "Anthropic key (BAA):" 30 || fail "pi asked for no Anthropic key"
		tm send-keys -t pi -l "$anthropic_key"
		sleep 0.5
		shot anthropic-typed
		tm send-keys -t pi Enter
	fi
	wait_for "OpenAI key (PHI check):" 30 || fail "pi asked for no OpenAI key"
	printf '%s' "$openai_key" | tm load-buffer -
	tm paste-buffer -p -t pi
	sleep 0.5
	shot openai-pasted
	tm send-keys -t pi Enter
}
tm new-session -d -s pi -x 140 -y 40 pi
wait_for "phi" 30
sleep 2
phi_setup
if [ "$world" = apikey ]; then
	wait_for "Nothing changed." 30 || fail "setup did not stop"
	shot apikey-stop
	grep -v '^\s*$' "$shots/apikey-stop.txt" | grep -A3 "phi-router found"
else
	keys_in
	if [ "$world" = headless ]; then
		login="$XDG_CONFIG_HOME/phi-router/logins/claude-baa"
		wait_for "type /phi setup again." 60 || fail "setup with no browser did not name the sign-in command"
		sleep 1
		shot no-browser
		grep -v '^\s*$' "$shots/no-browser.txt" | grep -A12 "^ ! Check"
		grep -qF "CLAUDE_CONFIG_DIR='$login' claude auth login" "$shots/no-browser.txt" || fail "the line does not name the login folder's command"
		tail -3 "$shots/no-browser.txt" | grep -qF "(phi) auto" && fail "pi switched to phi/auto before the sign-in"
		CLAUDE_CONFIG_DIR="$login" claude auth login </dev/null >/dev/null
		echo "ran in another shell: CLAUDE_CONFIG_DIR=<login folder> claude auth login"
		phi_setup
		keys_in
	fi
	sleep 3
	shot applying
	wait_for "phi/auto. Only" 180 || fail "setup did not finish on phi/auto"
	sleep 1
	shot done
	grep -v '^\s*$' "$shots/done.txt" | sed -n '/✓\|^ !/,$p'
	tail -3 "$shots/done.txt" | grep -qF "(phi) auto" || fail "the footer does not name phi/auto"
	for s in anthropic-typed openai-pasted; do
		[ -f "$shots/$s.txt" ] || continue
		grep -F -- "$key" "$shots/$s.txt" >/dev/null && fail "the pane showed the key in $s"
		echo "$s: $(grep -F '> ' "$shots/$s.txt" | grep -F '*' | sed 's/^ *//')"
	done
fi
tm send-keys -t pi C-c
sleep 0.3
tm send-keys -t pi C-c
sleep 1
tm kill-server 2>/dev/null
kill "$checks" "$mocks"
wait "$mocks"
echo "mocks: $(tail -1 world.out)"
tail -1 world.out | jq -e '.received.open == 0 and (.canaryAt.open | not)' >/dev/null || fail "the open mock got a request"
echo "key checks: $(sort "$ROOT/key-checks.log" 2>/dev/null | uniq -c | tr -s ' ' | paste -sd ';')"
holders=$(grep -rlF -- "$key" "$ROOT" | sed "s|$ROOT/||" | sort | paste -sd ' ')
echo "files holding the key canary: ${holders:-none}"
case "$world" in
max) [ "$holders" = "config/phi-router/keys/anthropic config/phi-router/keys/openai" ] || fail "the key canary is outside phi-router's key files" ;;
enterprise | headless) [ "$holders" = "config/phi-router/keys/openai" ] || fail "the key canary is outside phi-router's key file" ;;
esac
exit "$failed"
