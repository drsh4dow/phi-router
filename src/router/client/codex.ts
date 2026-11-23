import { Array, Config, Effect, FileSystem, Option, Path, Schema, Stream, Struct, pipe } from "effect";
import { behindDeadProxy, harnessFolder, harnessTurn } from "./harness-turn.ts";
import { copyPrivately, writePrivately } from "./private-file.ts";
import { ChildProcess } from "effect/process";

/**
 * One headless turn: its prompt, the `config.toml` and `.env` it runs with, the user's Codex home and the plugin folder
 * installed in it, which the turn's own home gets a copy of at the same place, and the environment the turn and its
 * hooks get beside `PATH`.
 */
interface Asked {
	readonly prompt: string;
	readonly config: string;
	readonly dotenv: string;
	readonly home: string;
	readonly installed: string;
	readonly env: Readonly<Record<string, string>>;
}

/** Codex's home folder: `named` when it is not empty, else `CODEX_HOME`, else `.codex` under the home folder. */
const codexHome = harnessFolder({ fallback: ".codex", variable: "CODEX_HOME" });

/** A file phi-router must change is not UTF-8 text, so it cannot change it without changing other bytes. */
class NotUtf8 extends Schema.TaggedError<NotUtf8, { readonly brand: unique symbol }>()("NotUtf8", {
	cause: Schema.Defect(),
	path: Schema.String,
}) {
	public override get message(): string {
		return `phi-router cannot read ${this.path} as UTF-8 text, and left it as it was. Save it as UTF-8 and run the command again.`;
	}
}

/** Decodes UTF-8 and keeps a byte order mark, so the text encodes back to the same bytes. */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of `file`, none when there is no file. */
const fileText = Effect.fnUntraced(function* fileText(file: string) {
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

/** The text of `file`, empty when there is no file. */
const textOf = Effect.fnUntraced(function* textOf(file: string) {
	const text = yield* fileText(file);

	return Option.getOrElse(text, () => "");
});

/** The first line of `file`, read without the rest, such as the `session_meta` line that opens a Codex transcript. */
const firstLine = Effect.fnUntraced(function* firstLine(file: string) {
	const fs = yield* FileSystem.FileSystem;

	return yield* fs.stream(file).pipe(Stream.decodeText, Stream.splitLines, Stream.runHead);
});

/** Removes `file`, and gives whether it was there. */
const removed = Effect.fnUntraced(function* removed(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(file);

	if (exists) {
		yield* fs.remove(file);
	}

	return exists;
});

/**
 * The folder Codex installed a plugin's version into, from its install cache `cache`, if it installed one: the first
 * version folder that holds `.codex-plugin/plugin.json`.
 */
const installedPlugin = Effect.fnUntraced(function* installedPlugin(cache: string) {
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

/**
 * `codex exec` in a fresh home and Codex home that hold `asked.config`, `asked.dotenv` and a copy of the installed
 * plugin, with nothing of the caller's environment but `PATH` and a dead proxy, so its own calls to GitHub and
 * chatgpt.com never leave the machine. Its stdin is closed, so it reads no more of the prompt.
 */
const commandOf = Effect.fnUntraced(function* commandOf(asked: Asked) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const searchPath = yield* Config.String("PATH");
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-home-" });
	const codex = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-codex-" });

	yield* copyPrivately(asked.installed, path.join(codex, path.relative(asked.home, asked.installed)));
	yield* writePrivately(path.join(codex, "config.toml"), asked.config);
	yield* writePrivately(path.join(codex, ".env"), asked.dotenv);

	const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", asked.prompt];

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

/** Runs the installed `codex exec` once in a fresh home and Codex home, and ends the turn after 2 minutes. */
const codexTurn = harnessTurn(commandOf);

export { codexHome, codexTurn, firstLine, installedPlugin, removed, textOf };
