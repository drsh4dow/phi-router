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
command=$(jq -r .statusLine.command "$settings")
echo "statusLine: $command"
jq --arg c "tee -a '$ROOT/statusline.in' | $command | tee -a '$ROOT/statusline.out'" '.statusLine.command = $c' "$settings" >"$settings.new"
mv "$settings.new" "$settings"
jq -n --arg work "$ROOT/work" '{hasCompletedOnboarding: true, hasSeenAutoDefaultNotice: true, projects: {($work): {hasTrustDialogAccepted: true}}}' >"$CLAUDE_CONFIG_DIR/.claude.json"
tm() { tmux -S "$ROOT/tmux.sock" "$@"; }
say() {
	tm send-keys -t claude -l "$1"
	sleep 0.5
	tm send-keys -t claude Enter
	sleep "${2:-8}"
}
line() { tm capture-pane -p -t claude | grep -o 'phi · .*' | tail -1; }
tm new-session -d -s claude -x 160 -y 45 env ANTHROPIC_AUTH_TOKEN=phi-test-harness-token CLAUDE_CODE_MAX_RETRIES=0 claude --model phi/auto
sleep 10
say "Reply ok for a clean prompt."
say "Member $CANARY called. Reply ok."
on_phi=$(line)
echo "on phi/auto: $on_phi"
say /phi 4
counts=$(tm capture-pane -p -t claude | sed -n 's/^ *Messages: \([0-9]*\) sealed, \([0-9]*\) cleared$/\1 sealed · \2 cleared/p' | tail -1)
echo "/phi: $counts"
case $on_phi in *" · 0 sealed · "* | "") fail "the status line shows no sealed message on phi/auto" ;; esac
case $on_phi in *" · $counts") ;; *) fail "the status line's counts are not /phi's" ;; esac
link=$CLAUDE_CONFIG_DIR/plugins/data/phi-router-phi-router/phi-router
echo "link: $(readlink "$link")"
tm kill-session -t claude
tm new-session -d -s claude -x 160 -y 45 env ANTHROPIC_AUTH_TOKEN=phi-test-harness-token CLAUDE_CODE_MAX_RETRIES=0 claude --continue --model claude-sonnet-4-5
sleep 10
say "Reply ok for a clean prompt."
off_phi=$(line)
echo "on claude-sonnet-4-5: ${off_phi:-nothing}"
[ -z "$off_phi" ] || fail "the status line shows counts on claude-sonnet-4-5"
tm capture-pane -p -t claude >"$ROOT/pane.txt"
tm kill-server 2>/dev/null
kill "$world"
wait "$world"
echo "stdin: $(jq -c '{session_id, model}' "$ROOT/statusline.in" | sort | uniq -c | tr -s ' \n' ' ')"
exit "$failed"
