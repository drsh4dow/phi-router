import {
	Array,
	Config,
	Effect,
	FileSystem,
	Option,
	Path,
	Redacted,
	Schema,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { behindDeadProxy, harnessFolder, harnessTurn } from "./harness-turn.ts";

/** A login pi sends as its Anthropic subscription. No real account ever sees it. */
const fakeLogin = "phi-doctor-fake-login";

const PackageName = Schema.fromJsonString(Schema.Struct({ name: Schema.String }));

/** One headless turn: its prompt and model, the package folder it loads, and the environment beside `PATH`. */
interface Asked {
	readonly prompt: string;
	readonly model: string;
	readonly package: string;
	readonly env: Readonly<Record<string, string>>;
}

const offline = { PI_OFFLINE: "1" };

/**
 * The agent folder of pi: `named` when it is not empty, else `PI_CODING_AGENT_DIR`, else `.pi/agent` under the home
 * folder.
 */
const agentFolder = harnessFolder({ fallback: ".pi/agent", variable: "PI_CODING_AGENT_DIR" });

/**
 * What `pi list` prints of the packages pi installed in `agent`, empty when pi did not run. It gets nothing of the
 * caller's environment but `PATH`, so no variable of the caller's shell changes what it prints or where it writes. Its
 * home and working folder, which holds no project resources, and its temporary files go to folders of its own that end
 * with it. The two differ, since jiti ignores a `TMPDIR` that is the working folder.
 */
const listed = Effect.fnUntraced(function* listed(agent: string) {
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const searchPath = yield* Config.String("PATH");
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-list-" });
	const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-list-tmp-" });

	const command = ChildProcess.make("pi", ["list"], {
		cwd: home,
		env: Struct.assign(offline, { HOME: home, PATH: searchPath, PI_CODING_AGENT_DIR: agent, TMPDIR: temporary }),
		extendEnv: false,
		stdin: "ignore",
	});

	const started = yield* Effect.option(spawner.spawn(command));

	return yield* Option.match(started, {
		onNone: () => Effect.succeed(""),
		onSome: (handle) => Stream.mkString(Stream.decodeText(handle.stdout)),
	});
}, Effect.scoped);

/** Whether the folder holds the package `phi-router`, by the name in its `package.json`. */
const holdsRouter = Effect.fnUntraced(function* holdsRouter(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const text = yield* Effect.option(fs.readFileString(path.join(folder, "package.json")));

	return pipe(
		text,
		Option.flatMap(Schema.decodeUnknownOption(PackageName)),
		Option.exists(({ name }) => name === "phi-router"),
	);
});

/** Where pi installed the package `phi-router`, and whether the user's settings narrow what pi loads of it. */
interface Installed {
	readonly folder: string;
	readonly filtered: boolean;
}

const filteredMark = " (filtered)";

/**
 * Each install `pi list` printed: an absolute folder, and whether the source line above it carries the filter mark.
 *
 * @param {string} printed What `pi list` printed.
 * @param {Function} isAbsolute Whether a line is an absolute folder.
 * @returns {readonly Installed[]} The installs.
 */
const installsOf = (printed: string, isAbsolute: (line: string) => boolean): readonly Installed[] => {
	const lines = pipe(Str.split(printed, "\n"), Array.map(Str.trim));

	return pipe(
		Array.zip(Array.prepend(lines, ""), lines),
		Array.filter(([, line]) => isAbsolute(line)),
		Array.map(([source, folder]) => ({ filtered: Str.endsWith(filteredMark)(source), folder })),
	);
};

/**
 * Where pi installed the package `phi-router`, from pi's own record as `pi list` prints it: each source, marked when
 * settings narrow what pi loads of it, and under it the absolute folder of an installed one. A package that settings
 * name but pi did not install prints no folder, so it reads as not installed. Only absolute lines count, so no line
 * reads a folder relative to the caller's. It does not run pi when the agent folder does not exist, since pi would
 * make one.
 */
const installedPackage = Effect.fnUntraced(function* installedPackage(agentDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const agent = yield* agentFolder(agentDir);
	const exists = yield* fs.exists(agent);

	if (!exists) {
		return Option.none<Installed>();
	}

	const printed = yield* listed(agent);
	const found = yield* Effect.filter(installsOf(printed, path.isAbsolute), ({ folder }) => holdsRouter(folder));

	return Array.head(found);
});

/**
 * `pi -p` in a fresh home and agent folder with a fake login, only the package in `asked.package`, offline, a dead
 * proxy, and nothing of the caller's environment but `PATH`. Its temporary files, such as node's compile
 * cache and jiti's, go to a folder of their own that ends with the turn. It is not the working folder, since jiti
 * ignores a `TMPDIR` that is. Its stdin is closed, since `pi -p` reads an open one into the prompt.
 */
const commandOf = Effect.fnUntraced(function* commandOf(asked: Asked) {
	const fs = yield* FileSystem.FileSystem;
	const searchPath = yield* Config.String("PATH");
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-home-" });
	const agent = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-pi-" });
	const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-tmp-" });
	const args = ["-p", asked.prompt, "--model", asked.model, "--no-extensions", "-e", asked.package];

	return ChildProcess.make("pi", args, {
		cwd: home,
		env: pipe(
			asked.env,
			Struct.assign(behindDeadProxy),
			Struct.assign({
				ANTHROPIC_OAUTH_TOKEN: fakeLogin,
				HOME: home,
				PATH: searchPath,
				PI_CODING_AGENT_DIR: agent,
				PI_OFFLINE: offline.PI_OFFLINE,
				PI_SKIP_VERSION_CHECK: "1",
				TMPDIR: temporary,
			}),
		),
		extendEnv: false,
		stdin: "ignore",
	});
});

/** Runs the installed `pi -p` once in a fresh home and agent folder, and ends the turn after 2 minutes. */
const piTurn = harnessTurn(commandOf);

const printPatience = "30 seconds";

const succeeded = 0;

/**
 * The key `pi auth print-api-key --provider anthropic` prints for the agent folder `agent`. None when pi is not on
 * `PATH`, exits non-zero, as it does for a subscription login, or takes over 30 seconds. pi gets nothing of the
 * caller's environment but `PATH` and the home folder, so it prints no key an environment variable holds. The key
 * comes through a pipe, and nothing pi prints reaches the terminal.
 */
const printedKey = Effect.fnUntraced(
	function* printedKey(agent: string) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const searchPath = yield* Config.String("PATH");
		const home = yield* Config.String("HOME");

		const command = ChildProcess.make("pi", ["auth", "print-api-key", "--provider", "anthropic"], {
			env: Struct.assign(offline, { HOME: home, PATH: searchPath, PI_CODING_AGENT_DIR: agent }),
			extendEnv: false,
			stderr: "ignore",
			stdin: "ignore",
		});

		const started = yield* Effect.option(spawner.spawn(command));

		if (Option.isNone(started)) {
			return Option.none<Redacted.Redacted>();
		}

		const printed = yield* Stream.mkString(Stream.decodeText(started.value.stdout));
		const code = yield* started.value.exitCode;

		return Option.liftPredicate(Redacted.make(Str.trim(printed)), () => code === succeeded);
	},
	Effect.timeoutOption(printPatience),
	Effect.map(Option.flatten),
	Effect.scoped,
);

/**
 * The Anthropic key pi stored, as pi prints it. None when pi's agent folder holds no `auth.json`, so pi, which would
 * make one, does not run.
 */
const storedAnthropicKey = Effect.fnUntraced(function* storedAnthropicKey() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const agent = yield* agentFolder("");
	const stored = yield* fs.exists(path.join(agent, "auth.json"));

	if (!stored) {
		return Option.none<Redacted.Redacted>();
	}

	return yield* printedKey(agent);
});

export { installedPackage, piTurn, storedAnthropicKey };
