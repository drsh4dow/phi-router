import { Array, Config, Effect, FileSystem, Schema, String as Str, Stream, Struct } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { mocked } from "#tools/route/mocked-router.ts";
import { pluginCopy } from "./copied.ts";
import { routerProcess } from "#tools/route/router-process.ts";

const session = "s-phi-hooks";

/** A name the judge mock seals a piece for. */
const canary = "Testperson";

const HookCommand = Schema.Struct({ command: Schema.String, type: Schema.Literal("command") });

const Matcher = Schema.Struct({ hooks: Schema.NonEmptyArray(HookCommand) });

const Events = Schema.Struct({ Stop: Schema.Tuple([Matcher]), UserPromptSubmit: Schema.Tuple([Matcher]) });

const Hooks = Schema.fromJsonString(Schema.Struct({ hooks: Events }));

/** Where each harness finds the plugin's hooks, and the names it gives the plugin's folder and the model address. */
const harnesses = {
	claude: { address: "ANTHROPIC_BASE_URL", file: "hooks/hooks.json", root: "CLAUDE_PLUGIN_ROOT" },
	codex: { address: "PHI_ROUTER_ADDRESS", file: "hooks/codex.json", root: "PLUGIN_ROOT" },
} as const;

type Harness = keyof typeof harnesses;

/** One run of a hook: the harness whose hook file names it, its event, its stdin and the model address, empty for none. */
interface HookRun {
	readonly harness: Harness;
	readonly event: "Stop" | "UserPromptSubmit";
	readonly input: string;
	readonly address: string;
}

/** Where a hook runs: the plugin's copy, the router's XDG folders, a home, and the router's address. */
interface World {
	readonly copy: string;
	readonly folders: Readonly<Record<"XDG_CONFIG_HOME" | "XDG_STATE_HOME", string>>;
	readonly home: string;
	readonly url: string;
}

/** The plugin's copy, the router's XDG folders, a home, and the router with its mocks as its own process at `url`. */
const setUp = Effect.gen(function* setUp() {
	const fs = yield* FileSystem.FileSystem;
	const copy = yield* pluginCopy;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-hooks-home-" });
	const { env } = yield* mocked({ holdsPhi: Str.includes(canary) });
	const router = yield* routerProcess(["bun", "src/router/main.ts"], env);
	const folders = { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, XDG_STATE_HOME: env.XDG_STATE_HOME };

	return { copy, folders, home, url: router.url } satisfies World;
});

/** The phi-router subcommand each event runs for `/phi`, beside the router check before each prompt. */
const subcommands = { Stop: "turn-end", UserPromptSubmit: "prompt-submit" } as const;

const commandOf = Effect.fnUntraced(function* commandOf(world: World, run: HookRun) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(`${world.copy}/${harnesses[run.harness].file}`);
	const { hooks } = yield* Schema.decodeEffect(Hooks)(text);
	const [{ hooks: matched }] = hooks[run.event];
	const ran = Str.includes(` ${subcommands[run.event]} `);

	const { command } = yield* Effect.fromOption(Array.findFirst(matched, ({ command: line }) => ran(line)));

	return command;
});

/**
 * Runs the plugin's own hook command for `run`, as the harness does, under umask 000 so a file written without its own
 * mode shows as 0666: `sh -c` with no environment but the plugin's
 * folder, the model address, the router's XDG folders, a home and `PATH`, and `run.input` on stdin. Returns its exit
 * code and what it printed on each stream.
 */
const hook = Effect.fnUntraced(function* hook(world: World, run: HookRun) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const command = yield* commandOf(world, run);
	const searchPath = yield* Config.String("PATH");
	const named = harnesses[run.harness];

	const env = Struct.assign(world.folders, {
		HOME: world.home,
		PATH: searchPath,
		[named.address]: run.address,
		[named.root]: world.copy,
	});

	const options = { env, extendEnv: false, stdin: Stream.encodeText(Stream.make(run.input)) };
	const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", `umask 000 && ${command}`], options));

	const printed = yield* Effect.all(
		{
			stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
			stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
		},
		{ concurrency: "unbounded" },
	);

	const exitCode = yield* handle.exitCode;

	return Struct.assign(printed, { exitCode: Number(exitCode) });
}, Effect.scoped);

export { canary, hook, session, setUp };

export type { Harness, World };
