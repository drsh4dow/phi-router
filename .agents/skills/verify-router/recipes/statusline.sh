#!/bin/sh
set -u
failed=0
fail() {
	echo "FAIL $1"
	failed=1
}
bun "$WORLD" claude 47411 >world.out 2>world.err &
world=$!
until [ -s world.out ]; do sleep 0.2; done
eval "$(head -1 world.out | jq -r '.env | to_entries[] | "export \(.key)=\(.value | @sh)"')"
{
	claude plugin marketplace add "$REPO" &&
		claude plugin install phi-router@phi-router --scope user &&
		"$REPO/plugins/claude/bin/phi-router" on claude
} >setup.log 2>&1 || {
	echo "FAIL setup"
	tail -5 setup.log
	exit 1
}
settings=$CLAUDE_CONFIG_DIR/settings.json
jq -e 'has("statusLine")' "$settings" >/dev/null && fail "on claude wrote a statusLine"
jq '.statusLine = {type: "command", command: "echo user-status-line"}' "$settings" >"$settings.new"
mv "$settings.new" "$settings"
jq -n --arg work "$ROOT/work" '{hasCompletedOnboarding: true, hasSeenAutoDefaultNotice: true, projects: {($work): {hasTrustDialogAccepted: true}}}' >"$CLAUDE_CONFIG_DIR/.claude.json"
tm() { tmux -S "$ROOT/tmux.sock" "$@"; }
say() {
	tm send-keys -t claude -l "$1"
	sleep 0.5
	tm send-keys -t claude Enter
	sleep "${2:-8}"
}
open() {
	tm new-session -d -s claude -x 160 -y 45 env ANTHROPIC_AUTH_TOKEN=phi-test-harness-token CLAUDE_CODE_MAX_RETRIES=0 claude "$@"
	sleep 10
}
under() { tm capture-pane -p -t claude | awk '/^❯/ { rows = ""; next } { rows = rows $0 "\n" } END { printf "%s", rows }' | grep -v '^[[:space:]─]*$' | sed 's/^ *//'; }
open --model phi/auto
say "Reply ok for a clean prompt."
say "Member $CANARY called. Reply ok."
rows=$(under)
echo "on phi/auto: $rows" | tr '\n' '|'
echo
row=$(echo "$rows" | sed -n 2p)
[ "$(echo "$rows" | sed -n 1p)" = user-status-line ] || fail "the user's status line is not the first row under the prompt"
case $row in "phi · "*" · 0 sealed · "* | "") fail "the phi row shows no sealed message on phi/auto" ;; "phi · "*) ;; *) fail "the phi row is not under the user's status line" ;; esac
say /phi 5
tm capture-pane -p -J -t claude >"$ROOT/phi.txt"
grep -q "⎿.*phi-router: session " "$ROOT/phi.txt" || fail "/phi gave no plain reply"
grep -q -e 'blocked by hook' -e 'Original prompt' "$ROOT/phi.txt" && fail "/phi shows a blocked prompt"
counts=$(sed -n 's/^ *Messages: \([0-9]*\) sealed, \([0-9]*\) cleared$/\1 sealed · \2 cleared/p' "$ROOT/phi.txt" | tail -1)
echo "/phi: $counts"
case $row in *" · $counts" | *" · $counts · "*) ;; *) fail "the phi row's counts are not /phi's" ;; esac
tm kill-session -t claude
open --continue --model claude-sonnet-4-5
off_phi=$(under | tr '\n' '|')
echo "on claude-sonnet-4-5: $off_phi"
case $off_phi in *"phi · "*) ;; *) fail "the phi row does not show on claude-sonnet-4-5, which the router routes too" ;; esac
tm kill-session -t claude
jq 'del(.statusLine)' "$settings" >"$settings.new"
mv "$settings.new" "$settings"
open --continue --model phi/auto
alone=$(under | sed -n 1p)
echo "alone: $alone"
case $alone in "phi · "*) ;; *) fail "the phi row does not show alone without a status line of the user's" ;; esac
tm capture-pane -p -t claude >"$ROOT/pane.txt"
tm kill-server 2>/dev/null
kill "$world"
wait "$world"
exit "$failed"
