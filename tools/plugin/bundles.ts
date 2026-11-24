const bundles = [
	{ entry: "src/router/main.ts", out: "plugins/claude/phi-router.mjs" },
	{ entry: "src/pi/index.ts", out: "plugins/pi/extension.mjs" },
] as const;

export { bundles };
