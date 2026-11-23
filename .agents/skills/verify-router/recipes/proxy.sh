#!/bin/sh
set -u
harness=$1
python3 "$RECIPES/proxy.py" "$ROOT/proxy.jsonl" >proxy.out &
proxy=$!
bun "$WORLD" "$harness" 47411 >world.out 2>world.err &
world=$!
until [ -s world.out ] && [ -s proxy.out ]; do sleep 0.2; done
address=$(cat proxy.out)
export HTTP_PROXY="$address" HTTPS_PROXY="$address" http_proxy="$address" https_proxy="$address"
phi() { "$REPO/plugins/claude/bin/phi-router" "$@"; }
phi on "$harness"
echo "on $harness exited $?"
if [ "$harness" = claude ]; then
	ANTHROPIC_AUTH_TOKEN=phi-test-harness-token timeout 45 claude -p "Reply with the word ok. $CANARY" --model phi/auto >turn.out 2>&1
else
	printf '{"OPENAI_API_KEY":"phi-test-harness-token"}' >"$CODEX_HOME/auth.json"
	timeout 45 codex exec --skip-git-repo-check "Reply with the word ok. $CANARY" >turn.out 2>&1
fi
echo "$harness turn exited $?, printed: $(tail -1 turn.out)"
sleep 3
phi off "$harness"
echo "off $harness exited $?"
echo "proxy saw $(wc -l <"$ROOT/proxy.jsonl") requests, $(grep -c 47411 "$ROOT/proxy.jsonl") to the router, $(grep -c '"canary": true' "$ROOT/proxy.jsonl") holding the canary"
jq -r .request "$ROOT/proxy.jsonl" | sort | uniq -c
kill "$world" "$proxy"
wait "$world"
tail -1 world.out
