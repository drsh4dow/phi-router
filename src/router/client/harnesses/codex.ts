import { Array, Config, Effect, FileSystem, Option, Path, Schema, Stream, Struct, pipe } from "effect";
import { behindDeadProxy, harnessFolder, harnessTurn } from "./turn.ts";
import { copyPrivately, rewritePrivately, writePrivately } from "#router/client/private-file.ts";
import { ChildProcess } from "effect/process";

interface Asked {
	readonly prompt: string;
	readonly hookTrust: "persisted" | "bypassed";
	readonly config: string;
	readonly dotenv: string;
	readonly installedPlugin: string;
	readonly pluginCachePlace: string;
	readonly env: Readonly<Record<string, string>>;
}

const codexHome = harnessFolder({ fallback: ".codex", variable: "CODEX_HOME" });

class NotUtf8 extends Schema.TaggedError<NotUtf8, { readonly brand: unique symbol }>()("NotUtf8", {
	cause: Schema.Defect(),
	path: Schema.String,
}) {
	public override get message(): string {
		return `phi-router cannot read ${this.path} as UTF-8 text, and left it as it was. Save it as UTF-8 and run the command again.`;
	}
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const textIfPresent = Effect.fnUntraced(function* textIfPresent(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(file);

	if (!exists) {
		return Option.none<string>();
	}

	const bytes = yield* fs.readFile(file);

	return yield* Effect.try({
		catch: (cause) => NotUtf8.make({ cause, path: file }),
		try: () => Option.some(utf8.decode(bytes)),
	});
});

const textOrEmpty = Effect.fnUntraced(function* textOrEmpty(file: string) {
	const text = yield* textIfPresent(file);

	return Option.getOrElse(text, () => "");
});

/** The first line of `file`, read without the rest, such as the `session_meta` line that opens a Codex transcript. */
const firstLine = Effect.fnUntraced(function* firstLine(file: string) {
	const fs = yield* FileSystem.FileSystem;

	return yield* fs.stream(file).pipe(Stream.decodeText, Stream.splitLines, Stream.runHead);
});

const removedIfPresent = Effect.fnUntraced(function* removedIfPresent(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(file);

	if (exists) {
		yield* fs.remove(file);
	}

	return exists;
});

const rewritten = Effect.fnUntraced(function* rewritten(file: string, before: string, after: string) {
	if (after !== before) {
		yield* rewritePrivately(file, after);
	}
});

const codexPlugin = Effect.fnUntraced(function* codexPlugin(cache: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const exists = yield* fs.exists(cache);

	if (!exists) {
		return Option.none<string>();
	}

	const versions = yield* fs.readDirectory(cache);

	const manifests = yield* Effect.forEach(
		versions,
		(version) => fs.exists(path.join(cache, version, ".codex-plugin", "plugin.json")),
		{ concurrency: 1 },
	);

	return pipe(
		Array.zip(versions, manifests),
		Array.findFirst(([, manifest]) => manifest),
		Option.map(([version]) => path.join(cache, version)),
	);
});

const commandOf = Effect.fnUntraced(function* commandOf(asked: Asked) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const searchPath = yield* Config.String("PATH");
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-home-" });
	const codex = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-codex-" });

	yield* copyPrivately(asked.installedPlugin, path.join(codex, asked.pluginCachePlace));
	yield* writePrivately(path.join(codex, "config.toml"), asked.config);
	yield* writePrivately(path.join(codex, ".env"), asked.dotenv);

	const args = [
		"exec",
		...{ bypassed: ["--dangerously-bypass-hook-trust"], persisted: [] }[asked.hookTrust],
		"--skip-git-repo-check",
		"--sandbox",
		"read-only",
		"--color",
		"never",
		asked.prompt,
	];

	return ChildProcess.make("codex", args, {
		cwd: home,
		env: pipe(
			asked.env,
			Struct.assign(behindDeadProxy),
			Struct.assign({ CODEX_HOME: codex, HOME: home, PATH: searchPath }),
		),
		extendEnv: false,
		stdin: "ignore",
	});
});

const codexTurn = harnessTurn(commandOf);

export { codexHome, codexPlugin, codexTurn, firstLine, removedIfPresent, rewritten, textOrEmpty };
