#!/bin/sh
set -u
failed=0
fail() {
	echo "FAIL $1"
	failed=1
}
bun "$WORLD" pi none >world.out 2>world.err &
world=$!
until [ -s world.out ]; do sleep 0.2; done
eval "$(head -1 world.out | jq -r '.env | to_entries[] | "export \(.key)=\(.value | @sh)"')"
printf '{"anthropic":{"type":"oauth","access":"phi-test-harness-token","refresh":"r","expires":4102444800000}}' >"$PI_CODING_AGENT_DIR/auth.json"
printf '{"packages":["%s"],"retry":{"enabled":false}}' "$REPO" >"$PI_CODING_AGENT_DIR/settings.json"
tm() { tmux -S "$ROOT/tmux.sock" "$@"; }
type_in() { tm send-keys -t pi -l "$1"; sleep 0.5; tm send-keys -t pi Enter; sleep "${2:-4}"; }
answers() { curl -s -o /dev/null -m 1 http://127.0.0.1:47411/; }
if answers; then fail "a router answered on 47411 before pi started"; else echo "no router before pi"; fi
tm new-session -d -s pi -x 140 -y 45 pi
sleep 5
type_in '/model phi/auto' 1
tm send-keys -t pi Enter
sleep 2
type_in 'Reply ok for a clean prompt.'
type_in "Member $CANARY called. Reply ok."
tm capture-pane -p -t pi -S -200 >"$ROOT/pane.txt"
oks=$(grep -c '^ *ok$' "$ROOT/pane.txt")
echo "ok replies on screen: $oks"
[ "$oks" -ge 2 ] || fail "pi showed $oks ok replies, not 2"
t=$(date +%s)
until answers || [ $(($(date +%s) - t)) -ge 10 ]; do sleep 0.5; done
if answers; then echo "router answers on 47411 while pi runs"; else fail "no router answered on 47411 within 10 s while pi ran"; fi
tm send-keys -t pi C-c
sleep 0.3
tm send-keys -t pi C-c
t=$(date +%s)
while answers && [ $(($(date +%s) - t)) -lt 15 ]; do sleep 0.2; done
if answers; then fail "router still up 15 s after pi exited"; else echo "router down $(($(date +%s) - t)) s after pi exited"; fi
tm kill-server 2>/dev/null
kill "$world"
wait "$world"
received=$(tail -1 world.out)
echo "$received"
echo "$received" | jq -e '.canaryAt.baa and (.canaryAt.open | not)' >/dev/null || fail "the canary did not reach the BAA mock alone"
exit "$failed"
