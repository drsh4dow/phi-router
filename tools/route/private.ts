import { Array, Effect, FileSystem, Path, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { daclOf, isPrivateDacl, userSid } from "#router/client/private-file.ts";
import type { DaclTarget } from "#router/client/private-file.ts";
import { systemTool } from "#router/client/platform.ts";

const fileTypeBit = 0o1000;

const permissionsOf = (mode: number): number => mode % fileTypeBit;

const octal = 8;

const modes = { file: 0o600, folder: 0o700 } as const;

const windowsSeparator = "\\";

const daclTargets: Readonly<Record<keyof typeof modes, readonly DaclTarget[]>> = {
	file: ["file", "inheritedFile"],
	folder: ["folder", "inheritedFolder"],
};

const kindOf = (type: FileSystem.File.Type): keyof typeof modes => {
	if (type === "Directory") {
		return "folder";
	}

	return "file";
};

const everyone = "*S-1-1-0:(R)";

const grantedToEveryone = Effect.fnUntraced(function* grantedToEveryone(file: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const icacls = yield* systemTool("icacls.exe");
	const handle = yield* spawner.spawn(ChildProcess.make(icacls, [file, "/grant", everyone], { stdin: "ignore" }));

	return yield* handle.exitCode;
}, Effect.scoped);

const privacyUnder = Effect.fnUntraced(function* privacyUnder(roots: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const windows = path.sep === windowsSeparator;

	const under = Effect.fnUntraced(function* under(root: string) {
		const names = yield* fs.readDirectory(root, { recursive: true });

		return pipe(
			names,
			Array.map((name) => path.join(root, name)),
		);
	});

	const seenAt = Effect.fnUntraced(function* seenAt(named: string) {
		const info = yield* fs.stat(named);
		const kind = kindOf(info.type);

		if (windows) {
			const sid = yield* userSid(named);
			const dacl = yield* daclOf(named);

			return {
				isPrivate: pipe(
					daclTargets[kind],
					Array.some((target) => isPrivateDacl({ sid, target })(dacl)),
				),
				shown: `${named} ${dacl}`,
			};
		}

		return {
			isPrivate: permissionsOf(info.mode) === modes[kind],
			shown: `${named} ${permissionsOf(info.mode).toString(octal)}`,
		};
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

export { grantedToEveryone, privacyUnder };
