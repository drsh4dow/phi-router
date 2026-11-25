#!/bin/sh
run=${1:-found-key}
harness=codex
. "$RECIPES/setup-world.sh"

claims=$(printf '{"email":"you@example.com","https://api.openai.com/auth":{"chatgpt_plan_type":"plus","chatgpt_account_id":"acct-phirecipe","chatgpt_user_id":"user-phirecipe"}}')
printf '{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"%s","access_token":"%s","refresh_token":"rt-phirecipe","account_id":"acct-phirecipe"},"last_refresh":"%s"}' \
	"$(jwt "$claims")" "$chatgpt_token" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$ROOT/work" >>"$CODEX_HOME/config.toml"

typed() { screen | grep -F '›' | tail -1 | grep -qF -- "$(printf %.30s "$1")"; }
say() {
	tm send-keys -t codex -l "$1"
	sleep 1
	for _ in 1 2 3 4 5; do
		tm send-keys -t codex Enter
		sleep 3
		typed "$1" || return 0
	done
	fail "codex kept $1 in its input box"
}
approved() {
	waits 'Would you like to run the following command?' 60 || return 1
	shot approval
	screen | grep -qF "Yes, and don't ask again for commands that start with \`npx phi-router setup codex\` (p)" || {
		fail "the approval offers no prefix rule"
		return 1
	}
	for _ in 1 2 3; do
		sleep 1
		tm send-keys -t codex p
		t=$(date +%s)
		while screen | grep -qF 'Would you like to run the following command?'; do
			[ $(($(date +%s) - t)) -ge 10 ] && continue 2
			sleep 0.5
		done
		return 0
	done
	return 1
}
spoken() { waits "• $1" "$2"; }

question='Which OpenAI key does your BAA cover?'
ending="Done. In Codex, type /new, then /hooks and press t to trust phi-router's hooks."
case $run in
found-key)
	applies=1 snapshots="^$CODEX_HOME/shell_snapshots/"
	start() { export OPENAI_API_KEY="$openai_key"; }
	drive() {
		say "$readme"
		approved || fail "codex asked no approval for setup"
		spoken "$question" 120 && shot question || fail "the agent did not ask: $question"
		n=$(screen | sed -n 's/^ *\([0-9]\)\. OpenAI key from OPENAI_API_KEY *$/\1/p' | tail -1)
		say "${n:-2}"
		applied 1 || fail "the agent never ran apply"
		spoken "$ending" 120 && pass "the agent ended with: $ending" || fail "the agent did not end with: $ending"
	}
	;;
no-key)
	applies=2 snapshots='^$'
	start() { :; }
	drive() {
		say "$readme"
		approved || fail "codex asked no approval for setup"
		applied 1 || fail "the agent never ran apply"
		spoken "I need an OpenAI key" 60 && shot key-asked || fail "the agent did not name a terminal command"
		echo "the agent said: $(tail -1 "$ROOT/apply.out")"
		command=$(tail -1 "$ROOT/apply.out" | cut -d'`' -f2)
		echo "the terminal runs setup's command: $command"
		printf '%s\n' "$command" >"$ROOT/terminal.sh"
		tm new-window -d -t codex: -n terminal "sh '$ROOT/terminal.sh'; echo terminal-done; sleep 600"
		term() { tm capture-pane -p -t codex:terminal -S -; }
		t=$(date +%s)
		until term | grep -qF 'OpenAI key (BAA):'; do
			[ $(($(date +%s) - t)) -ge 60 ] && fail "the terminal showed no key prompt" && return
			sleep 0.5
		done
		tm send-keys -t codex:terminal -l "$openai_key"
		tm send-keys -t codex:terminal Enter
		t=$(date +%s)
		until term | grep -q terminal-done; do
			[ $(($(date +%s) - t)) -ge 300 ] && fail "the terminal's setup did not end" && break
			sleep 0.5
		done
		term >"$ROOT/screen-terminal.txt"
		[ "$(grep -c 'OpenAI key (BAA):' "$ROOT/screen-terminal.txt")" -eq 1 ] && pass "one hidden prompt, for one OpenAI key" || fail "the terminal asked $(grep -c 'OpenAI key (BAA):' "$ROOT/screen-terminal.txt") times"
		grep -v -e '^ *$' -e terminal-done "$ROOT/screen-terminal.txt" | tail -1 | tr -d '`' | grep -qxF "$ending" && pass "the terminal ended with: $ending" || fail "the terminal did not end with: $ending"
	}
	;;
*)
	echo "FAIL no run named $run"
	exit 1
	;;
esac

start
tm new-session -d -s codex -x 150 -y 50 -c "$ROOT/work" codex
t=$(date +%s)
until screen | grep -q '›'; do
	[ $(($(date +%s) - t)) -ge 60 ] && fail "codex showed no input box" && break
	sleep 0.5
done
shot start
drive
if applied "$applies"; then
	sleep 2
	tail -1 "$ROOT/npx.log" | grep -q '^exit 0: setup codex --apply' && pass "apply exited 0" || fail "apply: $(tail -1 "$ROOT/npx.log")"
else
	fail "the agent never ran apply"
fi

shot after-apply

config=$XDG_CONFIG_HOME/phi-router/config.json
case $run in
found-key) jq -e '.sealed[0].keyEnv == "OPENAI_API_KEY" and .judge.keyEnv == "OPENAI_API_KEY"' "$config" >/dev/null ;;
no-key) jq -e '.sealed[0].keyFile != null and .judge.keyFile == .sealed[0].keyFile' "$config" >/dev/null ;;
esac && pass "config.json: $(jq -c '{clean, sealed, judge}' "$config")" || fail "config.json: $(cat "$config" 2>/dev/null)"
grep -q '^model_provider = "phi"' "$CODEX_HOME/config.toml" && pass "config.toml sends Codex to phi-router" || fail "config.toml: $(grep -n 'model_provider' "$CODEX_HOME/config.toml")"

say /new
sleep 3
say /hooks
waits 'Hooks' 15 && shot hooks || fail "/hooks showed no hooks"
tm send-keys -t codex t
sleep 2
shot trusted
tm send-keys -t codex Escape
sleep 1
prompted "^$XDG_CONFIG_HOME/phi-router/keys/" "$snapshots"
ended
