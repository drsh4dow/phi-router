#!/bin/sh
# Usage: tools/plugin/release.sh tag <version>
#        tools/plugin/release.sh publish <version>
#
# tag: in a clone made for it, as the release workflow's runner is, sets <version> in the three manifests, builds the
# bundles, commits them with the manifests on top of the commit checked out, tags that commit v<version>, and prints
# what the tag holds. It then packs the npm package phi-router-<version>.tgz from the tag and lists its files with
# npm publish --dry-run. It pushes and publishes nothing, so it is the dry run.
#
# publish: pushes the tag v<version> that tag made to origin, and moves origin's release branch to the tag's commit
# unless <version> is a prerelease or older than the version the branch holds. It creates the tag's GitHub release and
# publishes phi-router-<version>.tgz to npm with provenance through trusted publishing, which needs npm 11.5.1 or newer.
# Each step it finds done, as after a run that stopped partway, it skips.
set -eu

step=${1-}
version=${2-}
tag=v$version
tarball=phi-router-$version.tgz
manifests="package.json plugins/claude/.claude-plugin/plugin.json plugins/claude/.codex-plugin/plugin.json"
bundles="plugins/claude/phi-router.mjs plugins/pi/extension.mjs"

if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
	echo "Give the version as major.minor.patch, such as 0.2.0. Got: '$version'" >&2
	exit 1
fi

cd "$(dirname "$0")/../.."

case $step in
tag)
	for manifest in $manifests; do
		jq --tab --arg version "$version" '.version = $version' "$manifest" >"$manifest.new"
		mv "$manifest.new" "$manifest"
	done
	bun run build

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
	npm pack
	npm publish --dry-run --access public "$tarball"
	echo "Pushed and published nothing."
	;;
publish)
	if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
		echo "origin already holds $tag."
	else
		git push origin "refs/tags/$tag"
	fi
	commit=$(git rev-parse "$tag^{commit}")
	channel=$(git ls-remote origin refs/heads/release | cut -f1)
	channel_version=
	if [ -n "$channel" ]; then
		git fetch --quiet origin "$channel"
		channel_version=$(git show "$channel:package.json" | jq -r .version)
	fi
	if [ "$channel" = "$commit" ]; then
		echo "origin's release already points at $tag."
	elif [ "$version" != "${version%%-*}" ]; then
		echo "$tag is a prerelease, so origin's release stays."
	elif [ "$(printf '%s\n' "$version" "$channel_version" | sort -V | tail -n 1)" != "$version" ]; then
		echo "origin's release holds $channel_version, newer than $version, so it stays."
	else
		git push --force-with-lease="refs/heads/release:$channel" origin "$commit:refs/heads/release"
	fi
	if ! gh release view "$tag" >/dev/null 2>&1; then
		gh release create "$tag" --verify-tag --title "$tag" --generate-notes
	fi
	if npm view "phi-router@$version" version >/dev/null 2>&1; then
		echo "npm already holds phi-router@$version."
	else
		npm publish --provenance --access public "$tarball"
	fi
	;;
*)
	echo "Give the step, tag or publish. Got: '$step'" >&2
	exit 1
	;;
esac
