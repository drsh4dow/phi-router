/** Each one-file bundle `bun run build` writes: its entry, and its path from the repository root. */
const bundles = [
	{ entry: "src/router/main.ts", out: "plugins/claude/phi-router.mjs" },
	{ entry: "src/pi/index.ts", out: "plugins/pi/extension.mjs" },
] as const;

export { bundles };
