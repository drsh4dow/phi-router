# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `63dbb09f73438e550a6991dc6d778f979ffbf183`.

Installed with `skills/install-anti-slop/scripts/install.mjs` from that commit, which copies `skills/install-anti-slop/assets/anti-slop/` unchanged.

Plugins:

- `anti-slop`: `./tools/oxlint/anti-slop/index.ts`
- `anti-slop-effect`: `./tools/oxlint/anti-slop/effect/index.ts`

## Local deviations

- None in these files. `tsconfig.json` excludes this directory, and oxlint, oxfmt and ast-grep ignore it.
