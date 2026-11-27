import {
	Array,
	Effect,
	FileSystem,
	MutableHashSet,
	Option,
	Order,
	Path,
	PlatformError,
	Random,
	String as Str,
	Stream,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { isWindows, systemTool } from "./platform.ts";

type PrivateWriting = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

const privateModes = { file: 0o600, folder: 0o700 } as const;

const succeeded = 0;

const grants = { file: "(F)", folder: "(OI)(CI)(F)" } as const;

const sidPrefix = "S-1-";

const privateFolders = MutableHashSet.empty<string>();

const aclRefused = (target: string, description: string): PlatformError.PlatformError =>
	PlatformError.badArgument({
		description: `${target} could not be made private to the current user: ${description}`,
		method: "restrictToCurrentUser",
		module: "FileSystem",
	});

const printedBy = Effect.fnUntraced(function* printedBy(tool: string, args: readonly string[], target: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(ChildProcess.make(tool, args, { stdin: "ignore" }));
	const printed = yield* Stream.mkString(Stream.decodeText(handle.all));
	const exitCode = yield* handle.exitCode;

	if (exitCode !== succeeded) {
		return yield* aclRefused(target, `${tool} exited ${String(exitCode)}: ${Str.trim(printed)}`);
	}

	return printed;
}, Effect.scoped);

const sidIn = (printed: string): Option.Option<string> =>
	pipe(
		Str.trim(printed),
		Str.split(","),
		Array.last,
		Option.map(Str.replaceAll('"', "")),
		Option.filter(Str.startsWith(sidPrefix)),
	);

const userSid = Effect.fnUntraced(function* userSid(target: string) {
	const whoami = yield* systemTool("whoami.exe");
	const printed = yield* printedBy(whoami, ["/user", "/fo", "csv", "/nh"], target);
	const sid = sidIn(printed);

	if (Option.isNone(sid)) {
		return yield* aclRefused(target, `${whoami} printed no SID`);
	}

	return sid.value;
});

const topmostMissing = (
	folder: string,
): Effect.Effect<Option.Option<string>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* topmost() {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		if (yield* fs.exists(folder)) {
			return Option.none();
		}

		const parent = path.dirname(folder);

		if (parent === folder) {
			return Option.some(folder);
		}

		const above = yield* topmostMissing(parent);

		return Option.orElseSome(above, () => folder);
	});

const daclOf = Effect.fnUntraced(function* daclOf(target: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-acl-" });
	const saved = path.join(folder, "acl");
	const icacls = yield* systemTool("icacls.exe");

	yield* printedBy(icacls, [target, "/save", saved], target);

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

const daclTargets = {
	file: { flags: "", header: "D:PAI" },
	folder: { flags: "OICI", header: "D:PAI" },
	inheritedFile: { flags: "ID", header: "D:AI" },
	inheritedFolder: { flags: "OICIID", header: "D:AI" },
} as const;

type DaclTarget = keyof typeof daclTargets;

interface DaclOwner {
	readonly sid: string;
	readonly target: DaclTarget;
}

const trustedAccounts = ["SY", "BA"] as const;

const builtinAdministrator = { alias: "LA", rid: "-500" } as const;

const acePattern = /\([^)]*\)/gu;

const ownNames = (sid: string): readonly string[] => {
	if (Str.endsWith(builtinAdministrator.rid)(sid)) {
		return [sid, builtinAdministrator.alias];
	}

	return [sid];
};

const isPrivateDacl =
	(owner: DaclOwner) =>
	(dacl: string): boolean => {
		const { flags, header } = daclTargets[owner.target];
		const names = ownNames(owner.sid);
		const aceOf = (account: string): string => `(A;${flags};FA;;;${account})`;

		const aces = pipe(
			dacl,
			Str.matchAll(acePattern),
			Array.fromIterable,
			Array.map(([ace]) => ace),
		);

		const allowed = Array.map([...names, ...trustedAccounts], aceOf);

		return (
			dacl === `${header}${Array.join(aces, "")}` &&
			pipe(
				names,
				Array.some((name) => Array.contains(aces, aceOf(name))),
			) &&
			pipe(
				aces,
				Array.every((ace) => Array.contains(allowed, ace)),
			)
		);
	};

const restrictToCurrentUser = Effect.fnUntraced(function* restrictToCurrentUser(
	target: string,
	kind: keyof typeof grants,
) {
	const sid = yield* userSid(target);
	const icacls = yield* systemTool("icacls.exe");

	yield* printedBy(icacls, [target, "/inheritance:r", "/grant:r", `*${sid}:${grants[kind]}`], target);

	const dacl = yield* daclOf(target);

	if (!isPrivateDacl({ sid, target: kind })(dacl)) {
		return yield* aclRefused(target, `another account keeps access to it (${dacl})`);
	}

	return dacl;
});

const stagingName = Random.nextInt.pipe(Effect.map((unique) => `.phi-router-${String(unique)}`));

const staged = Effect.fnUntraced(function* staged(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const name = yield* stagingName;
	const staging = path.join(folder, name);

	yield* Effect.acquireRelease(fs.makeDirectory(staging), () =>
		Effect.ignore(fs.remove(staging, { recursive: true })),
	);
	yield* restrictToCurrentUser(staging, "folder");

	const inside = yield* fs.readDirectory(staging);

	if (Array.isReadonlyArrayNonEmpty(inside)) {
		return yield* aclRefused(staging, "another account wrote in it before it was made private");
	}

	return staging;
});

const inheritedTargets = { file: "inheritedFile", folder: "inheritedFolder" } as const;

const passesPrivacyOn = Effect.fnUntraced(function* passesPrivacyOn(target: string, kind: keyof typeof grants) {
	const sid = yield* userSid(target);
	const dacl = yield* daclOf(target);

	return isPrivateDacl({ sid, target: kind })(dacl) || isPrivateDacl({ sid, target: inheritedTargets[kind] })(dacl);
});

const madeTopmost = Effect.fnUntraced(function* madeTopmost(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const staging = yield* staged(path.dirname(folder));

	yield* fs.rename(staging, folder);
}, Effect.scoped);

const madeOnWindows = Effect.fnUntraced(function* madeOnWindows(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const resolved = path.resolve(folder);

	if (MutableHashSet.has(privateFolders, resolved) && (yield* fs.exists(resolved))) {
		return true;
	}

	const missing = yield* topmostMissing(resolved);

	if (Option.isSome(missing)) {
		yield* madeTopmost(missing.value);
	}

	yield* fs.makeDirectory(resolved, { mode: privateModes.folder, recursive: true });

	const inherits = Option.isSome(missing) || (yield* passesPrivacyOn(resolved, "folder"));

	if (inherits) {
		MutableHashSet.add(privateFolders, resolved);
	} else {
		MutableHashSet.remove(privateFolders, resolved);
	}

	return inherits;
});

const madePrivately = Effect.fnUntraced(function* madePrivately(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	if (isWindows(path)) {
		return yield* madeOnWindows(folder);
	}

	yield* fs.makeDirectory(folder, { mode: privateModes.folder, recursive: true });

	return true;
});

const writtenThroughStaging = Effect.fnUntraced(function* writtenThroughStaging(
	file: string,
	bytes: readonly number[],
	mode: number,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const staging = yield* staged(path.dirname(file));
	const temp = path.join(staging, path.basename(file));

	yield* fs.writeFile(temp, Uint8Array.from(bytes), { flag: "wx", mode });
	yield* restrictToCurrentUser(temp, "file");
	yield* fs.rename(temp, file);
}, Effect.scoped);

const writePrivately = Effect.fnUntraced(function* writePrivately(
	file: string,
	text: string,
	mode: number = privateModes.file,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const temp = yield* Random.nextInt.pipe(Effect.map((unique) => `${file}.${String(unique)}.tmp`));

	const inherits = yield* madePrivately(path.dirname(file));

	if (!inherits) {
		return yield* writtenThroughStaging(file, Array.fromIterable(new TextEncoder().encode(text)), mode);
	}

	const handle = yield* fs.open(temp, { flag: "wx", mode: privateModes.file });

	yield* handle.writeAll(new TextEncoder().encode(text));
	yield* handle.sync;

	if (mode !== privateModes.file) {
		yield* fs.chmod(temp, mode);
	}

	return yield* fs.rename(temp, file);
}, Effect.scoped);

const folderPrivately = Effect.fnUntraced(function* folderPrivately(folder: string) {
	yield* madePrivately(folder);
});

const appendPrivately = Effect.fnUntraced(function* appendPrivately(file: string, text: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const inherits = yield* madePrivately(path.dirname(file));

	if (!inherits && (yield* fs.exists(file))) {
		yield* restrictToCurrentUser(file, "file");
	} else if (!inherits) {
		yield* writtenThroughStaging(file, [], privateModes.file);
	}

	yield* fs.writeFileString(file, text, { flag: "a", mode: privateModes.file });
});

const permissionModulus = 0o1000;

const rewritePrivately = Effect.fnUntraced(function* rewritePrivately(file: string, text: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(file);

	if (!exists) {
		return yield* writePrivately(file, text);
	}

	const target = yield* fs.realPath(file);
	const info = yield* fs.stat(target);

	return yield* writePrivately(target, text, info.mode % permissionModulus);
});

const ownerBits = { execute: 0o100, write: 0o200 } as const;

const copyMode = (original: Readonly<Pick<FileSystem.File.Info, "mode">>): number => {
	if (original.mode % ownerBits.write >= ownerBits.execute) {
		return privateModes.folder;
	}

	return privateModes.file;
};

const copyPrivately = Effect.fnUntraced(function* copyPrivately(from: string, to: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const listed = yield* fs.readDirectory(from, { recursive: true });
	const entries = Array.sort(listed, Order.String);
	const inherits = yield* madePrivately(to);

	yield* Effect.forEach(
		entries,
		Effect.fnUntraced(function* copied(entry) {
			const info = yield* fs.stat(path.join(from, entry));

			if (info.type === "Directory") {
				return yield* fs.makeDirectory(path.join(to, entry), { mode: privateModes.folder, recursive: true });
			}

			const bytes = yield* fs.readFile(path.join(from, entry));

			if (inherits) {
				return yield* fs.writeFile(path.join(to, entry), bytes, { flag: "wx", mode: copyMode(info) });
			}

			return yield* writtenThroughStaging(path.join(to, entry), Array.fromIterable(bytes), copyMode(info));
		}),
		{ concurrency: 1, discard: true },
	);
});

export {
	appendPrivately,
	copyPrivately,
	daclOf,
	folderPrivately,
	isPrivateDacl,
	passesPrivacyOn,
	rewritePrivately,
	userSid,
	writePrivately,
};

export type { PrivateWriting };
