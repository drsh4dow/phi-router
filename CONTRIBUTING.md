# Contributing

Read [AGENTS.md](AGENTS.md) first. It points to [GLOSSARY.md](GLOSSARY.md) for the words the code uses, [CODING_STANDARDS.md](CODING_STANDARDS.md) for the rules the gates enforce, and [docs/adr/](docs/adr/) for why the code is the way it is.

1. Install the dependencies with `bun install --frozen-lockfile`. It also turns on the pre-commit hook.
2. Make your change, with a test that drives it through its interface.
3. Run `bun run check`. It must exit 0. CI also runs `bun run test:e2e` and `bun run test:perf` on every pull request.
4. If your change touches the router, an adapter, the policy or the accounts, drive it on mock accounts as [verify-router](.agents/skills/verify-router/SKILL.md) says, for example `unshare -rn sh -c 'ip link set lo up && exec bun run wire claude'`. Mock runs spend nothing.

Never put real PHI or a real key in code, a test, an issue or a pull request. Use synthetic canaries, as the corpus in `tools/corpus` does.

Report a bug with the issue form. Report a vulnerability or a suspected leak as [SECURITY.md](SECURITY.md) says.
