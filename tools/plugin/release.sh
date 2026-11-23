#!/bin/sh
# Usage: tools/plugin/release.sh tag <version>
#        tools/plugin/release.sh publish <version>
#
# tag: in a clone made for it, as the release workflow's runner is, builds the bundles, sets <version> in the three
# manifests, commits them with the bundles on top of the commit checked out, tags that commit v<version>, and prints
# what the tag holds. It pushes nothing, so it is the dry run.
#
# publish: pushes the tag v<version> that tag made to origin and creates its GitHub release. When origin already holds
# the tag, as after a run that stopped before the release, it only creates the release if it is missing.
set -eu

step=${1-}
version=${2-}
tag=v$version
manifests="package.json plugins/claude/.claude-plugin/plugin.json plugins/claude/.codex-plugin/plugin.json"
bundles="plugins/claude/phi-router.mjs plugins/pi/extension.mjs"

if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
	echo "Give the version as major.minor.patch, such as 0.2.0. Got: '$version'" >&2
	exit 1
fi

cd "$(dirname "$0")/../.."

case $step in
tag)
	bun run build
	for manifest in $manifests; do
		jq --tab --arg version "$version" '.version = $version' "$manifest" >"$manifest.new"
		mv "$manifest.new" "$manifest"
	done

	git checkout --quiet --detach
	git add $manifests
	git add --force $bundles
	git commit --quiet --no-verify -m "phi-router $version"
	git tag "$tag"

	echo "$tag is $(git rev-parse HEAD), on top of $(git rev-parse HEAD~1). It holds:"
	git ls-tree -r -l --full-tree "$tag" | awk '{ printf "%10s  %s\n", $4, $5 }'
	for manifest in $manifests; do
		echo "$manifest version: $(git show "$tag:$manifest" | jq -r .version)"
	done
	echo "Pushed nothing."
	;;
publish)
	if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
		echo "origin already holds $tag."
	else
		git push origin "refs/tags/$tag"
	fi
	if ! gh release view "$tag" >/dev/null 2>&1; then
		gh release create "$tag" --verify-tag --title "$tag" --generate-notes
	fi
	;;
*)
	echo "Give the step, tag or publish. Got: '$step'" >&2
	exit 1
	;;
esac
