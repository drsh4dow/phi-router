#!/bin/sh
run=${1:-found-keys}
harness=claude
case $run in *-tool) after_apply=tool ;; *-delay) after_apply=delay ;; *) after_apply= ;; esac
. "$RECIPES/setup-world.sh"

printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"sk-ant-ort01-phirecipe","expiresAt":4102444800000,"scopes":["user:inference","user:profile"],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}' \
	"$open_token" >"$CLAUDE_CONFIG_DIR/.credentials.json"
chmod 600 "$CLAUDE_CONFIG_DIR/.credentials.json"
printf '{"hasCompletedOnboarding":true,"hasSeenAutoDefaultNotice":true,"oauthAccount":{"accountUuid":"%s1","emailAddress":"you@example.com","organizationUuid":"%s2"},"projects":{"%s":{"hasTrustDialogAccepted":true}}}' \
	00000000-0000-4000-8000-00000000000 00000000-0000-4000-8000-00000000000 "$ROOT/work" >"$CLAUDE_CONFIG_DIR/.claude.json"

typed() { screen | grep -A1 '^─' | grep -qF -- "❯ $(printf %.30s "$1")"; }
pick() {
	waits "Enter to select" 120 || {
		fail "no picker offered $1"
		return
	}
	n=$(screen | sed -n "s/^[^0-9]*\([0-9]\)\. $1 *\$/\1/p" | tail -1)
	[ -n "$n" ] || {
		fail "the picker has no choice $1"
		return
	}
	while [ "$n" -gt 1 ]; do
		tm send-keys -t claude Down
		n=$((n - 1))
	done
	tm send-keys -t claude Enter
	t=$(date +%s)
	while screen | grep -qF 'Enter to select' && [ $(($(date +%s) - t)) -lt 30 ]; do sleep 0.5; done
}
configure() {
	for try in 1 2 3 4 5; do
		say '/plugin configure phi-router'
		waits 'Configure phi-router' 5 && break
		echo "/plugin configure try $try: $(screen | grep -F 'phi-router" isn' | tail -1 | sed 's/^ *⎿ *//')"
		tm send-keys -t claude Escape
		sleep 3
	done
	waits 'Configure phi-router' 1 || {
		fail "/plugin configure showed no options"
		return 1
	}
	for key in "$1" "$2"; do
		[ -n "$key" ] && tm send-keys -t claude -l "$key"
		sleep 0.5
		tm send-keys -t claude Down
	done
	tm send-keys -t claude Enter
	waits 'Saved plugin options' 15 || fail "/plugin configure did not save"
}

case $run in
found-keys | found-keys-tool | found-keys-delay)
	applies=1 ending='Done. Type `/reload-plugins` to turn it on.'
	start() {
		printf '{"anthropic":{"type":"api_key","key":"%s"}}' "$baa_key" >"$PI_CODING_AGENT_DIR/auth.json"
		export OPENAI_API_KEY="$openai_key"
	}
	drive() {
		pick "Anthropic key saved in pi"
		pick "OpenAI key from OPENAI_API_KEY"
	}
	;;
pasted-keys)
	applies=2 ending='Done. This window is protected.'
	start() { :; }
	drive() {
		pick "Anthropic API key"
		applied 1 || fail "the agent never ran apply"
		waits "I need two keys" 60 && shot paste-asked || fail "the agent did not ask for the keys"
		configure "$baa_key" "$openai_key"
		shot configured
		say done
	}
	;;
headless)
	applies=2 ending='Done. Type `/reload-plugins` to turn it on.'
	start() {
		export OPENAI_API_KEY="$openai_key"
		echo "DISPLAY='${DISPLAY-}' BROWSER='${BROWSER-}' WAYLAND_DISPLAY='${WAYLAND_DISPLAY-}'"
		mkdir -p "$ROOT/login-bin"
		cat >"$ROOT/login-bin/claude" <<EOF
#!/bin/sh
if [ "\$*" = "auth login" ]; then
	printf '{"claudeAiOauth":{"accessToken":"$enterprise_token","refreshToken":"sk-ant-ort01-phirecipe","expiresAt":4102444800000,"scopes":["user:inference","user:profile"],"subscriptionType":"enterprise"}}' >"\$CLAUDE_CONFIG_DIR/.credentials.json"
	printf '{"oauthAccount":{"accountUuid":"00000000-0000-4000-8000-000000000003","emailAddress":"dr.roe@clinic.example","organizationUuid":"00000000-0000-4000-8000-000000000004"}}' >"\$CLAUDE_CONFIG_DIR/.claude.json"
	echo "Login successful."
	exit 0
fi
PATH=\$(printf %s "\$PATH" | sed "s|^$ROOT/login-bin:||") exec claude "\$@"
EOF
		chmod +x "$ROOT/login-bin/claude"
	}
	drive() {
		pick "Claude Enterprise login"
		pick "OpenAI key from OPENAI_API_KEY"
		applied 1 || fail "the agent never ran apply"
		waits "This machine has no browser." 60 && shot sign-in-asked || fail "the agent did not name a sign-in command"
		command=$(awk 'NF { line = $0 } END { print line }' "$ROOT/apply.out" | cut -d'`' -f2)
		echo "the terminal runs setup's command: $command"
		printf '%s\n' "$command" >"$ROOT/terminal.sh"
		tm new-window -d -t claude: -n terminal "PATH='$ROOT/login-bin':\$PATH sh '$ROOT/terminal.sh'; echo signed-in-terminal-done; sleep 600"
		t=$(date +%s)
		until tm capture-pane -p -t claude:terminal | grep -q signed-in-terminal-done; do
			[ $(($(date +%s) - t)) -ge 30 ] && fail "the terminal's sign-in did not end" && break
			sleep 0.5
		done
		tm capture-pane -p -t claude:terminal >"$ROOT/screen-terminal.txt"
		say done
	}
	;;
*)
	echo "FAIL no run named $run"
	exit 1
	;;
esac

start
tm new-session -d -s claude -x 150 -y 50 -c "$ROOT/work" claude
t=$(date +%s)
until screen | grep -A1 '^─' | grep -q '^❯'; do
	[ $(($(date +%s) - t)) -ge 60 ] && fail "claude showed no input box" && break
	sleep 0.5
done
say "$readme"
waits "Enter to select" 120 && shot picker
drive
if applied "$applies"; then
	tail -1 "$ROOT/npx.log" | grep -q '^exit 0: setup claude --apply' && pass "apply exited 0" || fail "apply: $(tail -1 "$ROOT/npx.log")"
else
	fail "the agent never ran apply"
fi

waits "● $(printf %s "$ending" | tr -d '`')" 60 && pass "the agent ended with: $ending" || fail "the agent did not end with: $ending"
sleep 10
router && pass "a router answers on 47411 10 s after apply" || fail "no router on 47411 10 s after apply"
retried() { screen | grep -cE 'ECONNREFUSED|[Rr]etrying|attempt [0-9]+/[0-9]+'; }
[ "$(retried)" -eq 0 ] && pass "no connection retry after apply" || fail "claude retried a connection after apply: $(retried) lines"
shot after-apply

case $ending in *reload-plugins*)
	say /reload-plugins
	waits 'Reloaded' 30 && pass "/reload-plugins reloaded" || fail "/reload-plugins showed no Reloaded line"
	;;
esac
prompted "^$XDG_CONFIG_HOME/phi-router/keys/" "^$CLAUDE_CONFIG_DIR/.credentials.json\$" "^$PI_CODING_AGENT_DIR/auth.json\$"
[ "$(retried)" -eq 0 ] && pass "no connection retry in the whole run" || fail "claude retried a connection: $(retried) lines"
ended
