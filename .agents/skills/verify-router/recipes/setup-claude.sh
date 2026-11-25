#!/bin/sh
set -u
run=${1:-found-keys}
failed=0
fail() {
	echo "FAIL $1"
	failed=1
}
pass() { echo "pass $1"; }
w=$ROOT/world
mkdir -p "$w" "$ROOT/bin"
cd "$w"

printf '127.0.0.1 localhost api.anthropic.com api.openai.com\n' >hosts
printf 'hosts: files\n' >nsswitch.conf
mount --bind hosts /etc/hosts && mount --bind nsswitch.conf /etc/nsswitch.conf || {
	echo "FAIL run me with ISO_UNSHARE=-rnm"
	exit 1
}
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=phi-recipe-ca \
	-addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj /CN=api.anthropic.com -keyout tls.key -out tls.csr 2>/dev/null
printf 'subjectAltName=DNS:api.anthropic.com,DNS:api.openai.com\nextendedKeyUsage=serverAuth\n' >tls.ext
openssl x509 -req -in tls.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -extfile tls.ext -out tls.pem 2>/dev/null
export NODE_EXTRA_CA_CERTS=$w/ca.pem

open_token=sk-ant-oat01-phirecipeopen$(printf '%080d' 7)
baa_key=sk-ant-api03-phirecipebaa$(printf '%080d' 3)
openai_key=sk-proj-phirecipejudge$(printf '%060d' 5)
enterprise_token=sk-ant-oat01-phirecipeenterprise$(printf '%080d' 9)
MOCK_LOG=$ROOT/mock.jsonl
export MOCK_LOG
FAKE_OPEN_TOKEN=$open_token FAKE_ENTERPRISE_TOKEN=$enterprise_token FAKE_BAA_KEY=$baa_key FAKE_OPENAI_KEY=$openai_key MOCK_CERT=$w/tls.pem MOCK_CERT_KEY=$w/tls.key \
	MOCK_BODIES=${MOCK_BODIES:-} bun "$RECIPES/setup-claude-mock.ts" >mock.out 2>&1 &
mock=$!
until grep -qs listening mock.out || ! kill -0 "$mock" 2>/dev/null; do sleep 0.2; done

printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"sk-ant-ort01-phirecipe","expiresAt":4102444800000,"scopes":["user:inference","user:profile"],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}' \
	"$open_token" >"$CLAUDE_CONFIG_DIR/.credentials.json"
chmod 600 "$CLAUDE_CONFIG_DIR/.credentials.json"
printf '{"hasCompletedOnboarding":true,"hasSeenAutoDefaultNotice":true,"oauthAccount":{"accountUuid":"%s1","emailAddress":"you@example.com","organizationUuid":"%s2"},"projects":{"%s":{"hasTrustDialogAccepted":true}}}' \
	00000000-0000-4000-8000-00000000000 00000000-0000-4000-8000-00000000000 "$ROOT/work" >"$CLAUDE_CONFIG_DIR/.claude.json"

cat >"$ROOT/bin/npx" <<EOF
#!/bin/sh
[ "\$1" = phi-router ] || exit 127
shift
case "\$*" in setup*--apply*) out=$ROOT/apply.out ;; *) out=/dev/null ;; esac
{
	if [ "\$1" = setup ]; then "$REPO/plugins/claude/bin/phi-router" "\$@" --source "$REPO"; else "$REPO/plugins/claude/bin/phi-router" "\$@"; fi
	echo \$? >"$ROOT/npx.code"
} 2>&1 | tee "\$out"
code=\$(cat "$ROOT/npx.code")
echo "exit \$code: \$*" >>"$ROOT/npx.log"
exit "\$code"
EOF
chmod +x "$ROOT/bin/npx"
export PATH="$ROOT/bin:$PATH"

printf 'set -g remain-on-exit on\n' >tmux.conf
tm() { tmux -S "$ROOT/tmux.sock" -f "$w/tmux.conf" "$@"; }
screen() { tm capture-pane -p -t claude -S -; }
shot() { screen >"$ROOT/screen-$1.txt"; }
waits() {
	t=$(date +%s)
	until screen | grep -qF -- "$1"; do
		[ $(($(date +%s) - t)) -ge "$2" ] && return 1
		sleep 0.5
	done
}
typed() { screen | grep -A1 '^─' | grep -qF -- "❯ $(printf %.30s "$1")"; }
say() {
	tm send-keys -t claude -l "$1"
	sleep 1
	for _ in 1 2 3 4 5; do
		tm send-keys -t claude Enter
		sleep 3
		typed "$1" || return 0
	done
	fail "claude kept $1 in its input box"
}
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
applied() {
	t=$(date +%s)
	until [ "$(grep -cs -- '--apply' "$ROOT/npx.log")" -ge "$1" ]; do
		[ $(($(date +%s) - t)) -ge 300 ] && return 1
		sleep 1
	done
}
router() { curl -s -o /dev/null -m 1 http://127.0.0.1:47411/; }

readme='Install phi-router for your harness by following its SETUP.md in https://github.com/drsh4dow/phi-router/blob/main/SETUP.md'

case $run in
found-keys)
	applies=1 ending='Done. Type `/reload-plugins` to turn it on.'
	start() {
		printf '{"anthropic":{"type":"api_key","key":"%s"}}' "$baa_key" >"$PI_CODING_AGENT_DIR/auth.json"
		export OPENAI_API_KEY="$openai_key"
	}
	drive() {
		say "$readme"
		waits "Enter to select" 120 && shot picker
		pick "Anthropic key saved in pi"
		pick "OpenAI key from OPENAI_API_KEY"
	}
	;;
pasted-keys)
	applies=2 ending='Done. This window is protected.'
	start() { :; }
	drive() {
		say "$readme"
		waits "Enter to select" 120 && shot picker
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
		say "$readme"
		waits "Enter to select" 120 && shot picker
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
drive
if applied "$applies"; then
	tail -1 "$ROOT/npx.log" | grep -q '^exit 0: setup claude --apply' && pass "apply exited 0" || fail "apply: $(tail -1 "$ROOT/npx.log")"
else
	fail "the agent never ran apply"
fi

waits "● $(printf %s "$ending" | tr -d '`')" 60 && pass "the agent ended with: $ending" || fail "the agent did not end with: $ending"
sleep 10
router && echo "after apply: a router answers on 47411" || echo "after apply: no router on 47411"
echo "after apply: $(screen | grep -cE 'ECONNREFUSED|retrying') retry lines"
shot after-apply
screen | grep -qE 'retrying|Retrying' && tm send-keys -t claude Escape && sleep 1

case $ending in *reload-plugins*)
	say /reload-plugins
	waits 'Reloaded' 30 && pass "/reload-plugins reloaded" || fail "/reload-plugins showed no Reloaded line"
	;;
esac
lanes=$XDG_STATE_HOME/phi-router/lanes.jsonl
lines() { cat "$lanes" 2>/dev/null | wc -l; }
grows() {
	t=$(date +%s)
	until [ "$(lines)" -gt "$1" ] || [ $(($(date +%s) - t)) -ge 60 ]; do sleep 1; done
	sleep 3
}
say 'Reply with the single word ok.'
grows 0
router && pass "a router answers on 47411 after the first prompt" || fail "no router on 47411 after the first prompt"
before=$(lines)
say "Member $CANARY called about her claim. Reply ok."
grows "$before"
shot end

[ "$before" -gt 0 ] && head -n "$before" "$lanes" | jq -e -s 'all(.lane == "clean")' >/dev/null &&
	tail -n +"$((before + 1))" "$lanes" | jq -e -s 'any(.lane == "sealed")' >/dev/null &&
	pass "lane log: clean, then sealed for the canary" || fail "lane log: $(jq -c '[.lane, .account, .reason]' "$lanes" 2>/dev/null | tr '\n' ' ')"
jq -e -s 'any(.who == "baa" and .holdsCanary)' "$MOCK_LOG" >/dev/null && pass "the canary reached the BAA account" || fail "the canary never reached the BAA account"
jq -e -s 'any(.who != "baa" and .path == "/v1/messages" and .holdsCanary) | not' "$MOCK_LOG" >/dev/null && pass "the canary reached no other account" || fail "the canary reached the open account"
jq -e -s 'any(.who == "open" and .holdsKey) | not' "$MOCK_LOG" >/dev/null && pass "no fake key reached the open account" || fail "a fake key reached the open account"
holders=$(grep -rlF -e "$baa_key" -e "$openai_key" "$ROOT" 2>/dev/null | sort)
leaks=$(printf '%s\n' "$holders" | grep -v -e "^$XDG_CONFIG_HOME/phi-router/keys/" -e "^$CLAUDE_CONFIG_DIR/.credentials.json\$" -e "^$PI_CODING_AGENT_DIR/auth.json\$" -e '^$')
[ -z "$leaks" ] && pass "the keys are only in: $(printf '%s' "$holders" | sed "s|^$ROOT/||" | tr '\n' ' ')" || fail "fake keys in: $leaks"

tm kill-server 2>/dev/null
t=$(date +%s)
while router && [ $(($(date +%s) - t)) -lt 15 ]; do sleep 0.5; done
router && fail "router still up 15 s after claude exited"
kill "$mock" 2>/dev/null
exit "$failed"
