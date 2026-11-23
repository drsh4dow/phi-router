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
python3 "$RECIPES/proxy.py" "$ROOT/other.log" >other.url &
other=$!
python3 "$RECIPES/proxy.py" "$ROOT/proxy.log" >proxy.url &
proxy=$!
until [ -s other.url ] && [ -s proxy.url ]; do sleep 0.2; done
other_url=$(cat other.url)
proxy_url=$(cat proxy.url)
{
	claude plugin marketplace add "$REPO" &&
		claude plugin install phi-router@phi-router --scope user &&
		"$REPO/plugins/claude/bin/phi-router" on claude
} >setup.log 2>&1 || {
	echo "FAIL setup"
	tail -5 setup.log
	exit 1
}
echo "plugin installed and phi-router on claude: ok"

turn() {
	name=$1
	project=$2
	shift 2
	mkdir -p "$ROOT/work/$name/.claude"
	[ -n "$project" ] && printf '{"env":%s}' "$project" >"$ROOT/work/$name/.claude/settings.json"
	before=$(wc -l <"$ROOT/other.log" 2>/dev/null || echo 0)
	printf '{"request":"%s"}\n' "$name" >>"$ROOT/proxy.log"
	(cd "$ROOT/work/$name" && env ANTHROPIC_AUTH_TOKEN=phi-test-harness-token CLAUDE_CODE_MAX_RETRIES=0 \
		HTTPS_PROXY="$proxy_url" HTTP_PROXY="$proxy_url" no_proxy=127.0.0.1 \
		timeout 120 claude -p "Member $CANARY called. Reply ok." --model phi/auto "$@" >"$ROOT/$name.out" 2>&1)
	code=$?
	after=$(wc -l <"$ROOT/other.log" 2>/dev/null || echo 0)
	echo "$name: exit $code, other listener got $((after - before)) requests"
	sed 's/^/  /' "$ROOT/$name.out" | head -6
}

turn unchanged ''
grep -q '^ok' "$ROOT/unchanged.out" || fail "the session with no override did not reply ok"
for setting in "ANTHROPIC_BASE_URL $other_url" "ANTHROPIC_BASE_URL $other_url/project" "CLAUDE_CODE_USE_BEDROCK 1" "CLAUDE_CODE_USE_VERTEX 1"; do
	name=${setting% *}
	value=${setting#* }
	turn "$name" "{\"$name\":\"$value\"}"
	grep -q "$name moves this Claude Code session off the router" "$ROOT/$name.out" || fail "$name=$value was not named"
done
export CLAUDE_CODE_SESSION_ACCESS_TOKEN=phi-test-session-token
turn file '' --file file_phi38:doc.txt --debug-file "$ROOT/file.debug"
unset CLAUDE_CODE_SESSION_ACCESS_TOKEN
grep -i 'file_phi38\|download' "$ROOT/file.debug" | sed 's/^/  /' | head -5
grep -q '^{' "$ROOT/other.log" 2>/dev/null && fail "the other listener got a request"
echo "the proxy saw, by turn:"
jq -r .request "$ROOT/proxy.log" | sed 's/^/  /'
kill "$other" "$proxy" "$world"
wait "$world"
exit "$failed"
