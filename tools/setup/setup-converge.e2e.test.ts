import { Array, Effect, FileSystem, Formatter, Option, String as Str, Struct, pipe } from "effect";
import { argsOf, codexSignedIn, layer, ok, patient, piHolds, piLogin, version, withEnv } from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { keys, world } from "./world.ts";
import type { PlatformError } from "effect";
import type { World } from "./world.ts";
import { phiRouter } from "#tools/cli/accounts-run.ts";

const older = "0.0.1";

interface GithubSource {
	readonly ref: string;
	readonly repo: string;
	readonly source: "github";
}

const github = (ref: string): GithubSource => ({ ref, repo: "drsh4dow/phi-router", source: "github" });

const codexMarketplace = (ref: string): string =>
	`[marketplaces.phi-router]\nsource_type = "git"\nsource = "https://github.com/drsh4dow/phi-router.git"\nref = "${ref}"\n`;

type Preset = (of: World) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;

const written = Effect.fnUntraced(function* written(file: string, text: string) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.makeDirectory(Str.replace(/\/[^/]*$/u, "")(file), { recursive: true });
	yield* fs.writeFileString(file, text);
});

const claudeAt =
	({
		declared,
		fetched,
		installed,
	}: {
		readonly declared: object;
		readonly fetched: string;
		readonly installed?: string;
	}): Preset =>
	(of) =>
		Effect.gen(function* claudeHeld() {
			const folder = of.folders.CLAUDE_CONFIG_DIR;

			const ours = Option.match(Option.fromUndefinedOr(installed), {
				onNone: () => ({}),
				onSome: (at) => ({
					"phi-router@phi-router": [{ installPath: of.copies.claudePlugin, scope: "user", version: at }],
				}),
			});

			const plugins = Struct.assign({ "other@skills-dir": [{ installPath: of.root, scope: "user" }] }, ours);

			yield* written(
				`${folder}/settings.json`,
				Formatter.formatJson({ extraKnownMarketplaces: { "phi-router": declared } }),
			);
			yield* written(
				`${folder}/plugins/known_marketplaces.json`,
				Formatter.formatJson({ "phi-router": { source: github(fetched) } }),
			);
			yield* written(`${folder}/plugins/installed_plugins.json`, Formatter.formatJson({ plugins, version: 2 }));
		});

const codexAt =
	({ config, installed }: { readonly config: string; readonly installed?: string }): Preset =>
	(of) =>
		Effect.gen(function* codexHeld() {
			const fs = yield* FileSystem.FileSystem;
			const home = of.folders.CODEX_HOME;

			yield* codexSignedIn(of);
			yield* written(`${home}/config.toml`, config);
			yield* Effect.forEach(
				Option.toArray(Option.fromUndefinedOr(installed)),
				(at) => fs.copy(of.copies.claudePlugin, `${home}/plugins/cache/phi-router/phi-router/${at}`),
				{ concurrency: 1, discard: true },
			);
		});

const piAt =
	({ spec, installed }: { readonly spec: string; readonly installed: string }): Preset =>
	(of) =>
		Effect.gen(function* piHeld() {
			const folder = of.folders.PI_CODING_AGENT_DIR;

			yield* piHolds(of, { anthropic: piLogin });
			yield* written(`${folder}/settings.json`, Formatter.formatJson({ packages: [spec] }));
			yield* written(
				`${folder}/npm/node_modules/phi-router/package.json`,
				Formatter.formatJson({ name: "phi-router", version: installed }),
			);
		});

interface Converge {
	readonly harness: "claude" | "codex" | "pi";
	readonly title: string;
	readonly state: string;
	readonly given: Preset;
	readonly installs: readonly string[];
}

const followed = { autoUpdate: true, source: github("release") };

const claudeUpdate = ["plugin marketplace update phi-router", "plugin update phi-router@phi-router --scope user"];

const claudeMove = [
	"plugin marketplace update phi-router",
	"plugin install phi-router@phi-router --scope user",
	"plugin update phi-router@phi-router --scope user",
];

const codexInstall = ["plugin marketplace add drsh4dow/phi-router --ref release", "plugin add phi-router@phi-router"];

const converges: readonly Converge[] = [
	{
		given: claudeAt({ declared: { source: github("v0.0.1") }, fetched: "v0.0.1", installed: older }),
		harness: "claude",
		installs: claudeMove,
		state: "held on a release tag",
		title: "Claude Code",
	},
	{
		given: claudeAt({ declared: { source: github("v0.0.1") }, fetched: "v0.0.1" }),
		harness: "claude",
		installs: claudeMove,
		state: "whose plugin is gone from a marketplace held on a release tag, as claude plugin uninstall leaves it",
		title: "Claude Code",
	},
	{
		given: claudeAt({ declared: followed, fetched: "release", installed: older }),
		harness: "claude",
		installs: claudeUpdate,
		state: "on the channel at an older version",
		title: "Claude Code",
	},
	{
		given: claudeAt({ declared: { source: github("release") }, fetched: "release", installed: version }),
		harness: "claude",
		installs: claudeMove,
		state: "installed from the channel with auto-update still off, as a crash after the install leaves it",
		title: "Claude Code",
	},
	{
		given: claudeAt({ declared: followed, fetched: "release", installed: version }),
		harness: "claude",
		installs: [],
		state: "on the channel at this version",
		title: "Claude Code",
	},
	{
		given: codexAt({ config: codexMarketplace("v0.0.1"), installed: older }),
		harness: "codex",
		installs: ["plugin marketplace remove phi-router", ...codexInstall],
		state: "held on a release tag",
		title: "Codex",
	},
	{
		given: codexAt({ config: codexMarketplace("v0.0.1") }),
		harness: "codex",
		installs: ["plugin marketplace remove phi-router", ...codexInstall],
		state: "whose plugin never arrived from a marketplace held on a release tag, as a crash before plugin add leaves it",
		title: "Codex",
	},
	{
		given: codexAt({ config: "", installed: older }),
		harness: "codex",
		installs: codexInstall,
		state: "left without its marketplace, as a crash after the removal leaves it",
		title: "Codex",
	},
	{
		given: codexAt({ config: codexMarketplace("release"), installed: older }),
		harness: "codex",
		installs: ["plugin marketplace upgrade phi-router", "plugin add phi-router@phi-router"],
		state: "on the channel at an older version",
		title: "Codex",
	},
	{
		given: codexAt({ config: codexMarketplace("release"), installed: version }),
		harness: "codex",
		installs: [],
		state: "on the channel at this version",
		title: "Codex",
	},
	{
		given: piAt({ installed: older, spec: `npm:phi-router@${older}` }),
		harness: "pi",
		installs: ["install npm:phi-router", "update npm:phi-router"],
		state: "held on an exact version",
		title: "pi",
	},
	{
		given: piAt({ installed: older, spec: "npm:phi-router" }),
		harness: "pi",
		installs: ["update npm:phi-router"],
		state: "on the channel at an older version",
		title: "pi",
	},
	{
		given: piAt({ installed: version, spec: "npm:phi-router" }),
		harness: "pi",
		installs: [],
		state: "on the channel at this version",
		title: "pi",
	},
];

const isInstall = (line: string): boolean =>
	pipe(
		["plugin ", "install ", "update "],
		Array.some((start) => Str.startsWith(start)(line)),
	);

const installsOf = Effect.fnUntraced(function* installsOf(of: World, harness: string) {
	const args = yield* argsOf(of, harness);

	return pipe(args, Array.filter(isInstall));
});

const converged = Effect.fnUntraced(function* converged({ given, harness, installs, title }: Converge) {
	const made = yield* world;
	const of = withEnv({ PHI_ROUTER_ANTHROPIC_KEY: keys.anthropic, PHI_ROUTER_OPENAI_KEY: keys.openai })(made);
	const apply = ["setup", harness, "--apply", "--answers", '{"baa":"key"}'];

	yield* given(of);

	const first = yield* phiRouter(of.env, apply);
	const ran = yield* installsOf(of, harness);
	const again = yield* phiRouter(of.env, apply);
	const reran = yield* installsOf(of, harness);
	const reported = `✓ Installed phi-router ${version} in ${title}`;

	assert.strictEqual(first.exitCode, ok, first.stderr);
	assert.deepStrictEqual(ran, installs);
	assert.include(first.stdout, reported);
	assert.strictEqual(again.exitCode, ok, again.stderr);
	assert.deepStrictEqual(reran, ran, "a second run installs nothing");
	assert.include(again.stdout, reported);
}, Effect.scoped);

it.layer(layer)("setup converges an existing install to the release channel", (test) => {
	test.effect.each(converges)("setup $harness over an install $state", converged, patient);
});
