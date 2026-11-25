#!/bin/sh
set -u
failed=0
fail() {
	echo "FAIL $1"
	failed=1
}
pass() { echo "pass $1"; }
w=$ROOT/world
mkdir -p "$w" "$ROOT/bin"
cd "$w"

printf '127.0.0.1 localhost api.anthropic.com api.openai.com chatgpt.com\n' >hosts
printf 'hosts: files\n' >nsswitch.conf
mount --bind hosts /etc/hosts && mount --bind nsswitch.conf /etc/nsswitch.conf || {
	echo "FAIL run me with ISO_UNSHARE=-rnm"
	exit 1
}
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=phi-recipe-ca \
	-addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj /CN=api.anthropic.com -keyout tls.key -out tls.csr 2>/dev/null
printf 'subjectAltName=DNS:api.anthropic.com,DNS:api.openai.com,DNS:chatgpt.com\nextendedKeyUsage=serverAuth\n' >tls.ext
openssl x509 -req -in tls.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -extfile tls.ext -out tls.pem 2>/dev/null
export NODE_EXTRA_CA_CERTS=$w/ca.pem CODEX_CA_CERTIFICATE=$w/ca.pem

open_token=sk-ant-oat01-phirecipeopen$(printf '%080d' 7)
baa_key=sk-ant-api03-phirecipebaa$(printf '%080d' 3)
openai_key=sk-proj-phirecipejudge$(printf '%060d' 5)
enterprise_token=sk-ant-oat01-phirecipeenterprise$(printf '%080d' 9)
jwt() { printf 'eyJhbGciOiJub25lIn0.%s.phirecipe' "$(printf %s "$1" | base64 -w0 | tr '+/' '-_' | tr -d =)"; }
chatgpt_token=$(jwt '{"exp":4102444800,"sub":"phirecipe"}')
MOCK_LOG=$ROOT/mock.jsonl
export MOCK_LOG
FAKE_OPEN_TOKEN=$open_token FAKE_ENTERPRISE_TOKEN=$enterprise_token FAKE_BAA_KEY=$baa_key FAKE_OPENAI_KEY=$openai_key \
	FAKE_CHATGPT_TOKEN=$chatgpt_token MOCK_CERT=$w/tls.pem MOCK_CERT_KEY=$w/tls.key \
	MOCK_AFTER_APPLY=${after_apply-} MOCK_BODIES=${MOCK_BODIES:-} bun "$RECIPES/setup-mock.ts" >mock.out 2>&1 &
mock=$!
until grep -qs listening mock.out || ! kill -0 "$mock" 2>/dev/null; do sleep 0.2; done

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
[ "${after_apply-}" = delay ] && [ "\$code" = 0 ] && case "\$*" in setup*--apply*) sleep 3 ;; esac
echo "exit \$code: \$*" >>"$ROOT/npx.log"
exit "\$code"
EOF
chmod +x "$ROOT/bin/npx"
export PATH="$ROOT/bin:$PATH"

printf 'set -g remain-on-exit on\n' >tmux.conf
tm() { tmux -S "$ROOT/tmux.sock" -f "$w/tmux.conf" "$@"; }
screen() { tm capture-pane -p -t "$harness" -S -; }
shot() { screen >"$ROOT/screen-$1.txt"; }
waits() {
	t=$(date +%s)
	until screen | grep -qF -- "$1"; do
		[ $(($(date +%s) - t)) -ge "$2" ] && return 1
		sleep 0.5
	done
}
applied() {
	t=$(date +%s)
	until [ "$(cat "$ROOT/npx.log" 2>/dev/null | grep -c -- '--apply')" -ge "$1" ]; do
		[ $(($(date +%s) - t)) -ge 300 ] && return 1
		sleep 1
	done
}
router() { curl -s -o /dev/null -m 1 http://127.0.0.1:47411/; }
say() {
	tm send-keys -t "$harness" -l "$1"
	sleep 1
	for _ in 1 2 3 4 5; do
		tm send-keys -t "$harness" Enter
		sleep 3
		typed "$1" || return 0
	done
	fail "$harness kept $1 in its input box"
}

readme='Install phi-router for your harness by following its SETUP.md in https://github.com/drsh4dow/phi-router/blob/main/SETUP.md'

lanes=$XDG_STATE_HOME/phi-router/lanes.jsonl
lines() { cat "$lanes" 2>/dev/null | wc -l; }
grows() {
	t=$(date +%s)
	until [ "$(lines)" -gt "$1" ] || [ $(($(date +%s) - t)) -ge 60 ]; do sleep 1; done
	sleep 3
}

prompted() {
	say 'Reply with the single word ok.'
	grows 0
	router && pass "a router answers on 47411 after the first prompt" || fail "no router on 47411 after the first prompt"
	before=$(lines)
	say "Member $CANARY called about her claim. Reply ok."
	grows "$before"
	shot end

	[ "$before" -gt 0 ] && head -n "$before" "$lanes" | jq -e -s 'map(select(.reason != "title")) | all(.lane == "clean")' >/dev/null &&
		tail -n +"$((before + 1))" "$lanes" | jq -e -s 'any(.reason == "sealed new content")' >/dev/null &&
		pass "lane log: clean, then sealed for the canary" || fail "lane log: $(jq -c '[.lane, .account, .reason]' "$lanes" 2>/dev/null | tr '\n' ' ')"
	jq -e -s 'any(.who == "baa" and .holdsCanary)' "$MOCK_LOG" >/dev/null && pass "the canary reached the BAA account" || fail "the canary never reached the BAA account"
	jq -e -s 'any(.who != "baa" and (.path | test("/(messages|responses)$")) and .holdsCanary) | not' "$MOCK_LOG" >/dev/null && pass "the canary reached no other account" || fail "the canary reached the open account"
	jq -e -s 'any(.who == "open" and .holdsKey) | not' "$MOCK_LOG" >/dev/null && pass "no fake key reached the open account" || fail "a fake key reached the open account"
	holders=$(grep -rlF -e "$baa_key" -e "$openai_key" "$ROOT" 2>/dev/null | sort)
	leaks=$holders
	for place in "$@"; do leaks=$(printf '%s\n' "$leaks" | grep -v -e "$place"); done
	[ -z "$leaks" ] && pass "the keys are only in: $(printf '%s' "$holders" | sed "s|^$ROOT/||" | tr '\n' ' ')" || fail "fake keys in: $leaks"
}

ended() {
	tm kill-server 2>/dev/null
	pkill -f "^$CODEX_HOME/packages/app-server-daemon/" 2>/dev/null
	t=$(date +%s)
	while router && [ $(($(date +%s) - t)) -lt 15 ]; do sleep 0.5; done
	router && fail "router still up 15 s after $harness exited"
	kill "$mock" 2>/dev/null
	exit "$failed"
}
