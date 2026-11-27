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
import { behindDeadProxy, harnessFolder, harnessTurn } from "./turn.ts";
import { forPlatform, homeFolder } from "#router/client/platform.ts";

const fakeLogin = "phi-doctor-fake-login";

const PackageManifest = Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String }));

interface Asked {
	readonly prompt: string;
	readonly model: string;
	readonly packageFolder: string;
	readonly env: Readonly<Record<string, string>>;
}

const offline = { PI_OFFLINE: "1" };

const namedAgentFolder = harnessFolder({ fallback: ".pi/agent", variable: "PI_CODING_AGENT_DIR" });

const tilde = /^~(?=\/|$)/u;

const windowsTilde = /^~(?=[/\\]|$)/u;

const agentFolder = Effect.fnUntraced(function* agentFolder(named: string) {
	const path = yield* Path.Path;
	const folder = yield* namedAgentFolder(named);
	const home = yield* homeFolder;
	const leading = yield* forPlatform({ posix: tilde, windows: windowsTilde });

	if (!leading.test(folder)) {
		return folder;
	}

	return path.join(home, Str.replace(leading, "")(folder));
});

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

const routerVersion = Effect.fnUntraced(function* routerVersion(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const text = yield* Effect.option(fs.readFileString(path.join(folder, "package.json")));

	return pipe(
		text,
		Option.flatMap(Schema.decodeUnknownOption(PackageManifest)),
		Option.filter(({ name }) => name === "phi-router"),
		Option.map(({ version }) => version),
	);
});

interface Listed {
	readonly folder: string;
	readonly narrowedBySettings: boolean;
	readonly source: string;
}

const filteredMark = " (filtered)";

const installsOf = (printed: string, isAbsolute: (line: string) => boolean): readonly Listed[] => {
	const lines = pipe(Str.split(printed, "\n"), Array.map(Str.trim));

	return pipe(
		Array.zip(Array.prepend(lines, ""), lines),
		Array.filter(([, line]) => isAbsolute(line)),
		Array.map(([source, folder]) => ({
			folder,
			narrowedBySettings: Str.endsWith(filteredMark)(source),
			source: Str.replace(filteredMark, "")(source),
		})),
	);
};

const installedPackage = Effect.fnUntraced(function* installedPackage(agentDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const agent = yield* agentFolder(agentDir);
	const exists = yield* fs.exists(agent);

	if (!exists) {
		return Option.none<Listed & { readonly version: string }>();
	}

	const printed = yield* listed(agent);

	const found = yield* Effect.forEach(
		installsOf(printed, path.isAbsolute),
		(install) =>
			Effect.map(
				routerVersion(install.folder),
				Option.map((version) => Struct.assign(install, { version })),
			),
		{ concurrency: 1 },
	);

	return Array.head(Array.getSomes(found));
});

const commandOf = Effect.fnUntraced(function* commandOf(asked: Asked) {
	const fs = yield* FileSystem.FileSystem;
	const searchPath = yield* Config.String("PATH");
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-home-" });
	const agent = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-pi-" });
	const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-tmp-" });
	const args = ["-p", asked.prompt, "--model", asked.model, "--no-extensions", "-e", asked.packageFolder];

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

const piTurn = harnessTurn(commandOf);

const printPatience = "30 seconds";

const succeeded = 0;

const printedKey = Effect.fnUntraced(
	function* printedKey(agent: string, provider: string) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const searchPath = yield* Config.String("PATH");
		const home = yield* homeFolder;

		const command = ChildProcess.make("pi", ["auth", "print-api-key", "--provider", provider], {
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

const storedKey = Effect.fnUntraced(function* storedKey(provider: "anthropic" | "openai") {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const agent = yield* agentFolder("");
	const stored = yield* fs.exists(path.join(agent, "auth.json"));

	if (!stored) {
		return Option.none<Redacted.Redacted>();
	}

	return yield* printedKey(agent, provider);
});

export { agentFolder, installedPackage, piTurn, storedKey };
