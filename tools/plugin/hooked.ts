import { Array, Config, Effect, FileSystem, Option, Record, Schema, String as Str, Stream, Struct } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { AccountScript } from "#tools/route/harnesses.ts";
import type { Harness } from "./session-hook.ts";
import { harnesses } from "./session-hook.ts";
import { mocked } from "#tools/route/mocked-router.ts";
import { pluginCopy } from "./copied.ts";
import { routerProcess } from "#tools/route/router-process.ts";

const session = "s-phi-hooks";

const canary = "Testperson";

const HookCommand = Schema.Struct({ command: Schema.String, type: Schema.Literal("command") });

const Matcher = Schema.Struct({ hooks: Schema.NonEmptyArray(HookCommand) });

const Events = Schema.Struct({ Stop: Schema.Tuple([Matcher]), UserPromptSubmit: Schema.Tuple([Matcher]) });

const Hooks = Schema.fromJsonString(Schema.Struct({ hooks: Events }));

interface HookRun {
	readonly harness: Harness;
	readonly event: "Stop" | "UserPromptSubmit";
	readonly input: string;
	readonly address?: string;
}

interface World {
	readonly pluginCopy: string;
	readonly folders: Readonly<Record<"XDG_CONFIG_HOME" | "XDG_STATE_HOME", string>>;
	readonly home: string;
	readonly routerUrl: string;
}

const setUpWith = Effect.fnUntraced(function* setUpWith(open: { readonly open?: AccountScript }) {
	const fs = yield* FileSystem.FileSystem;
	const copy = yield* pluginCopy;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-hooks-home-" });
	const { env } = yield* mocked(Struct.assign({ holdsPhi: Str.includes(canary) }, open));
	const router = yield* routerProcess(["bun", "src/router/main.ts"], env);
	const folders = { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, XDG_STATE_HOME: env.XDG_STATE_HOME };

	return { folders, home, pluginCopy: copy, routerUrl: router.url } satisfies World;
});

const setUp = setUpWith({});

const subcommandBesideRouterCheck = { Stop: "turn-end", UserPromptSubmit: "prompt-submit" } as const;

const commandOf = Effect.fnUntraced(function* commandOf(world: World, run: HookRun) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(`${world.pluginCopy}/${harnesses[run.harness].hooksFile}`);
	const { hooks } = yield* Schema.decodeEffect(Hooks)(text);
	const [{ hooks: matched }] = hooks[run.event];
	const ran = Str.includes(` ${subcommandBesideRouterCheck[run.event]} `);

	const { command } = yield* Effect.fromOption(Array.findFirst(matched, ({ command: line }) => ran(line)));

	return command;
});

const unmasked = "umask 000";

const hook = Effect.fnUntraced(function* hook(world: World, run: HookRun) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const command = yield* commandOf(world, run);
	const searchPath = yield* Config.String("PATH");
	const named = harnesses[run.harness];

	const base = Struct.assign(world.folders, {
		HOME: world.home,
		PATH: searchPath,
		TZ: "UTC",
		[named.pluginFolderVariable]: world.pluginCopy,
	});

	const env = Option.match(Option.fromUndefinedOr(run.address), {
		onNone: () => base,
		onSome: (url) => Record.set(base, named.modelAddressVariable, url),
	});

	const options = { env, extendEnv: false, stdin: Stream.encodeText(Stream.make(run.input)) };
	const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", `${unmasked} && ${command}`], options));

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

export { canary, hook, session, setUp, setUpWith };

export type { World };

export type { Harness } from "./session-hook.ts";
