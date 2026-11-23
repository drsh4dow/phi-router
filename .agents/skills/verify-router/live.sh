#!/bin/sh
set -u

repo=$(cd "$(dirname "$0")/../../.." && pwd)
evidence=${1:-$(mktemp -d /tmp/phi-verify-router-XXXXXX)}
bun=${PHI_BUN:-bun}
minutes=10
dollars=2
mkdir -p "$evidence"
cd "$repo" || exit 1

if [ ! -f "${XDG_CONFIG_HOME:-$HOME/.config}/phi-router/config.json" ]; then
	echo "no ${XDG_CONFIG_HOME:-$HOME/.config}/phi-router/config.json: write the account config first"
	exit 2
fi

offline() {
	if unshare -rn true 2>/dev/null; then
		unshare -rn sh -c 'ip link set lo up && exec "$@"' sh "$@"
	else
		"$@"
	fi
}

failed=""
began=$(date +%s)

step() {
	name=$1
	shift
	started=$(date +%s)
	"$@" >"$evidence/$name.log" 2>&1
	code=$?
	echo "$name: exit $code, $(($(date +%s) - started)) s"
	[ "$code" -eq 0 ] || failed="$failed $name"
}

step eval "$bun" tools/corpus/eval.ts --judge live
for harness in pi claude codex; do
	step "wire-$harness" offline "$bun" tools/wire/run.ts "$harness" "$evidence/wire-$harness.json"
done
step border offline node_modules/.bin/vitest run tools/route/border.test.ts tools/route/codex-border.test.ts
for harness in pi claude codex; do
	step "accounts-$harness" "$bun" tools/wire/accounts.ts "$harness"
done

seconds=$(($(date +%s) - began))
leaked=$(sed -n 's/.*: leaked \([0-9]*\)$/\1/p' "$evidence/eval.log")
canaries=$(cat "$evidence"/wire-*.log "$evidence"/accounts-*.log | grep -c '^FAIL .*canary')
leaks=$((${leaked:-0} + canaries))
judge=$(sed -n 's/.*, cost \$\([0-9.]*\),.*/\1/p' "$evidence/eval.log")
accounts=$(cat "$evidence"/accounts-*.log | sed -n 's/^cost: judge \$\([0-9.]*\), BAA tokens \$\([0-9.]*\)$/\1 \2/p')
cost=$(echo "${judge:-0} $accounts" | awk '{ for (i = 1; i <= NF; i++) total += $i } END { printf "%.4f", total }')

echo "leaks: $leaks (eval ${leaked:-unknown}, canary checks failed $canaries)"
echo "wall time: $seconds s, limit $((minutes * 60)) s"
echo "cost: \$$cost (eval judge \$${judge:-unknown}, then judge and BAA tokens per harness: $(echo $accounts)), limit \$$dollars"
echo "evidence: $evidence"

over=$(awk -v cost="$cost" -v limit="$dollars" 'BEGIN { print (cost >= limit) }')
if [ -n "$failed" ] || [ "$leaks" -ne 0 ] || [ "$seconds" -ge $((minutes * 60)) ] || [ "$over" -eq 1 ] || [ -z "$judge" ]; then
	echo "verify-router live: FAIL${failed:+ (steps:$failed)}"
	exit 1
fi
echo "verify-router live: pass"
