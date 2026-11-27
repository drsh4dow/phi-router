import { Array, Config, Effect, FileSystem, Option, Path, String as Str, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const fileTypeBit = 0o1000;

const permissionsOf = (mode: number): number => mode % fileTypeBit;

const octal = 8;

const modes = { file: 0o600, folder: 0o700 } as const;

const windowsSeparator = "\\";

const defaultSystemRoot = String.raw`C:\Windows`;

const allowed = "A";

const entriesAfterHeader = 1;

const systemTool = Effect.fnUntraced(function* systemTool(name: string) {
	const path = yield* Path.Path;

	const root = yield* Config.String("SystemRoot").pipe(
		Config.withDefault(defaultSystemRoot),
		Effect.orElseSucceed(() => defaultSystemRoot),
	);

	return path.join(root, "System32", name);
});

const printedBy = Effect.fnUntraced(function* printedBy(tool: string, args: readonly string[]) {
	const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);

	if (Option.isNone(spawner)) {
		return yield* Effect.die(`no process spawner to run ${tool}`);
	}

	return yield* spawner.value.string(ChildProcess.make(tool, args, { stdin: "ignore" }));
});

const currentUserSid = Effect.gen(function* currentUserSid() {
	const whoami = yield* systemTool("whoami.exe");
	const printed = yield* printedBy(whoami, ["/user", "/fo", "csv", "/nh"]);

	return pipe(
		Str.trim(printed),
		Str.split(","),
		Array.last,
		Option.map(Str.replaceAll('"', "")),
		Option.getOrElse(() => ""),
	);
});

const daclOf = Effect.fnUntraced(function* daclOf(named: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-acl-" });
	const saved = path.join(folder, "acl");
	const icacls = yield* systemTool("icacls.exe");

	yield* printedBy(icacls, [named, "/save", saved]);

	const bytes = yield* fs.readFile(saved);

	return pipe(
		new TextDecoder("utf-16le").decode(bytes),
		Str.split("\n"),
		Array.map(Str.trim),
		Array.filter(Str.isNonEmpty),
		Array.last,
		Option.getOrElse(() => ""),
	);
}, Effect.scoped);

const grantsOnlyTo = (dacl: string, sid: string): boolean => {
	const entries = pipe(
		Str.split("(")(dacl),
		Array.drop(entriesAfterHeader),
		Array.map(Str.replaceAll(")", "")),
		Array.map(Str.split(";")),
	);

	return (
		Array.isReadonlyArrayNonEmpty(entries) &&
		pipe(
			entries,
			Array.every(
				(fields) =>
					Array.head(fields).pipe(Option.contains(allowed)) && Array.last(fields).pipe(Option.contains(sid)),
			),
		)
	);
};

const windowsUser = Effect.fnUntraced(function* windowsUser(windows: boolean) {
	if (windows) {
		return yield* currentUserSid;
	}

	return "";
});

const privacyUnder = Effect.fnUntraced(function* privacyUnder(roots: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const windows = path.sep === windowsSeparator;
	const sid = yield* windowsUser(windows);

	const under = Effect.fnUntraced(function* under(root: string) {
		const names = yield* fs.readDirectory(root, { recursive: true });

		return pipe(
			names,
			Array.map((name) => path.join(root, name)),
		);
	});

	const seenAt = Effect.fnUntraced(function* seenAt(named: string) {
		if (windows) {
			const dacl = yield* daclOf(named);

			return { isPrivate: grantsOnlyTo(dacl, sid), shown: `${named} ${dacl}` };
		}

		const info = yield* fs.stat(named);
		const shown = `${named} ${permissionsOf(info.mode).toString(octal)}`;

		if (info.type === "Directory") {
			return { isPrivate: permissionsOf(info.mode) === modes.folder, shown };
		}

		return { isPrivate: permissionsOf(info.mode) === modes.file, shown };
	});

	const listed = yield* Effect.forEach(roots, under, { concurrency: 1 });
	const seen = yield* Effect.forEach(Array.flatten(listed), seenAt, { concurrency: 1 });

	const notPrivate = pipe(
		seen,
		Array.filter(({ isPrivate }) => !isPrivate),
		Array.map(({ shown }) => shown),
	);

	return {
		notPrivate,
		shown: pipe(
			seen,
			Array.map(({ shown }) => shown),
		),
	};
});

export { currentUserSid, daclOf, privacyUnder, systemTool };
