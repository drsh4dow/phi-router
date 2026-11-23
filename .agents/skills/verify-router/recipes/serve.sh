#!/bin/sh
set -eu
bun "$WORLD" claude 0 >world.out 2>world.err &
world=$!
until [ -s world.out ]; do sleep 0.2; done
url=$(head -1 world.out | jq -r .url)
port=${url##*:}
ss -Hltn "sport = :$port" | awk '{print "listening on " $4}'
curl -s -m 2 -o /dev/null "http://127.0.0.2:$port/" && echo "127.0.0.2 answered" || echo "127.0.0.2 refused"
post() {
	curl -s -o /dev/null -w "$1 %{http_code}\n" -X "${3:-POST}" "$url${4:-/v1/messages}" \
		-H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
		-H 'authorization: Bearer phi-test-harness-token' -H 'x-claude-code-session-id: recipe-serve' -d "$2"
}
user() { printf '{"role":"user","content":[{"type":"text","text":"%s"}]}' "$1"; }
body() { printf '{"model":"phi/auto","max_tokens":64,"stream":true,"messages":[%s]}' "$1"; }
canary="Member $CANARY called about the claim."
post clean "$(body "$(user 'List the build steps.')")"
post canary "$(body "$(user "$canary")")"
post follow-up "$(body "$(user "$canary"),{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]},$(user 'Go on.')")"
post unknown-path "$(body "$(user "$canary")")" POST /v1/files
post wrong-method '' DELETE /v1/messages
kill "$world"
wait "$world" || true
tail -1 world.out
