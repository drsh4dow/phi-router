#!/bin/sh
set -u
harness=$1
cd /tmp
mount -t tmpfs tmpfs /tmp
for kept in "$ROOT" "$REPO"; do
	case $kept in /tmp/*)
		mkdir -p "$kept"
		mount --no-canonicalize --bind "./${kept#/tmp/}" "$kept"
		;;
	esac
done
cd "$ROOT/work"

left() {
	find /tmp -mindepth 1 | while IFS= read -r entry; do
		for kept in "$ROOT" "$REPO"; do
			case "$kept/" in "$entry/"*) continue 2 ;; esac
			case $entry in "$kept"/*) continue 2 ;; esac
		done
		printf '%s ' "$entry"
	done
}

step() {
	label=$1
	shift
	if "$@" >>setup.log 2>&1; then
		echo "$label: ok"
	else
		echo "FAIL $label exited $?"
		tail -5 setup.log
		exit 1
	fi
}

phi() { "$REPO/plugins/claude/bin/phi-router" "$@"; }

if [ "$harness" = claude ]; then
	step "add the marketplace" claude plugin marketplace add "$REPO"
	step "install the plugin" claude plugin install phi-router@phi-router --scope user
else
	step "add the marketplace" codex plugin marketplace add "$REPO"
	step "add the plugin" codex plugin add phi-router@phi-router
	printf '{"OPENAI_API_KEY":"phi-test-harness-token"}' >"$CODEX_HOME/auth.json"
fi
step "phi-router on $harness" phi on "$harness"

if [ "$harness" = codex ]; then
	tm() { tmux -S "$ROOT/tmux.sock" "$@"; }
	tm new-session -d -s codex -x 140 -y 45 codex --no-daemon
	trusted=no
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		sleep 2
		if tm capture-pane -p -t codex | grep -q 'Trust all and continue'; then
			tm send-keys -t codex Down Enter
			sleep 3
			trusted=yes
			break
		fi
		tm send-keys -t codex Enter
	done
	tm kill-server
	if [ "$trusted" = no ]; then
		echo "FAIL the Codex TUI never offered to trust the plugin's hook"
		exit 1
	fi
	echo "trusted the plugin's hook"
fi

echo "/tmp before doctor holds: $(left)"
phi doctor "$harness"
code=$?
echo "doctor $harness exited $code"
echo "/tmp after doctor holds: $(left)"
echo "TMPDIR holds: $(find "$TMPDIR" -mindepth 1 | wc -l) entries"
exit "$code"
