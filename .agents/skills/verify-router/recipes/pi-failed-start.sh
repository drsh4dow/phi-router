#!/bin/sh
set -u
printf '{"anthropic":{"type":"oauth","access":"phi-test-harness-token","refresh":"r","expires":4102444800000}}' >"$PI_CODING_AGENT_DIR/auth.json"
printf '{"packages":["%s"],"retry":{"enabled":false}}' "$REPO" >"$PI_CODING_AGENT_DIR/settings.json"
timeout 60 pi -p "Reply ok. $CANARY" --model phi/auto >pi.out 2>&1
echo "pi with no config.json exited $?"
grep -v '^\s*$' pi.out | head -3
echo "lines holding the login: $(grep -c phi-test-harness-token pi.out)"
