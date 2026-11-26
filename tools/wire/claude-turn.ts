import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Config, Effect, FileSystem, Path, Stream, Struct } from "effect";
import { fakes } from "#tools/route/mocked-router.ts";
import { pluginCopy } from "#tools/plugin/copied.ts";

const place = Effect.gen(function* place() {
	const fs = yield* FileSystem.FileSystem;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-home-" });
	const config = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-claude-" });
	const work = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-work-" });
	const plugin = yield* pluginCopy;

	return { config, home, plugin, work };
});

type Place = Readonly<Effect.Success<typeof place>>;

const claudeTurn = Effect.fnUntraced(
	function* claudeTurn(turn: {
		readonly folders: Readonly<Record<string, string>>;
		readonly place: Place;
		readonly router: string;
		readonly prompt: string;
		readonly session: readonly string[];
	}) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const path = yield* Path.Path;
		const searchPath = yield* Config.String("PATH");

		const args = [
			"-p",
			turn.prompt,
			"--model",
			"phi/auto",
			"--allowedTools",
			"Read,Bash,Edit",
			"--plugin-dir",
			turn.place.plugin,
		];

		const command = ChildProcess.make("claude", [...args, ...turn.session], {
			cwd: path.resolve(turn.place.work),
			env: Struct.assign(turn.folders, {
				ANTHROPIC_AUTH_TOKEN: fakes.harnessToken,
				ANTHROPIC_BASE_URL: turn.router,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				CLAUDE_CONFIG_DIR: turn.place.config,
				DISABLE_ERROR_REPORTING: "1",
				DISABLE_TELEMETRY: "1",
				HOME: turn.place.home,
				PATH: searchPath,
				TZ: "UTC",
			}),
			extendEnv: false,
		});

		const handle = yield* spawner.spawn(command);
		const printed = yield* Stream.mkString(Stream.decodeText(Stream.drainFork(handle.stdout, handle.stderr)));
		const exitCode = yield* handle.exitCode;

		return { exitCode, printed };
	},
	Effect.scoped,
	Effect.timeout("3 minutes"),
);

export { claudeTurn, place };
