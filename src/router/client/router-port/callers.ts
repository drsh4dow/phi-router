import { Array, Context, Effect, FileSystem, Layer, Option, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

type Endpoint = `${string}:${number}`;

interface Connection {
	readonly router: Endpoint;
	readonly caller: Endpoint;
}

interface Socket {
	readonly local: Endpoint;
	readonly remote: Endpoint;
	readonly uid: number;
}

const procTable = "/proc/net/tcp";

const procRow =
	/^\s*\d+: (?<local>[\dA-F]{8}:[\dA-F]{4}) (?<remote>[\dA-F]{8}:[\dA-F]{4}) [\dA-F]{2} \S+ \S+ \S+ +(?<uid>\d+) /u;

const procEndpoint =
	/^(?<fourth>[\dA-F]{2})(?<third>[\dA-F]{2})(?<second>[\dA-F]{2})(?<first>[\dA-F]{2}):(?<port>[\dA-F]{4})$/u;

const lsofUid = /^u(?<uid>\d+)$/u;

const lsofSocket = /^n(?<localHost>\S+):(?<localPort>\d+)->(?<remoteHost>\S+):(?<remotePort>\d+)$/u;

const lsofListed = 0;

const hex = 16;

const groupsOf = (pattern: Readonly<RegExp>, text: string): Option.Option<Readonly<Record<string, string>>> =>
	pipe(
		Option.fromNullishOr(pattern.exec(text)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
	);

const fromHex = (digits = ""): number => Number.parseInt(digits, hex);

const endpointOf = (printed: string): Option.Option<Endpoint> =>
	Option.map(
		groupsOf(procEndpoint, printed),
		({ first, second, third, fourth, port }): Endpoint =>
			`${fromHex(first)}.${fromHex(second)}.${fromHex(third)}.${fromHex(fourth)}:${fromHex(port)}`,
	);

const procSocketOf = (line: string): Option.Option<Socket> =>
	Option.flatMap(groupsOf(procRow, line), ({ local = "", remote = "", uid = "" }) =>
		Option.all({ local: endpointOf(local), remote: endpointOf(remote), uid: Option.some(Number(uid)) }),
	);

const lsofSocketsOf = (block: string): readonly Socket[] => {
	const lines = Str.split("\n")(block);
	const uid = Array.findFirst(lines, (line) => groupsOf(lsofUid, line));

	return pipe(
		lines,
		Array.map((line) => groupsOf(lsofSocket, line)),
		Array.getSomes,
		Array.flatMap(({ localHost = "", localPort = "", remoteHost = "", remotePort = "" }) =>
			Option.match(uid, {
				onNone: () => [],
				onSome: (named): readonly Socket[] => [
					{
						local: `${localHost}:${Number(localPort)}`,
						remote: `${remoteHost}:${Number(remotePort)}`,
						uid: Number(named["uid"]),
					},
				],
			}),
		),
	);
};

const heldByOneUser = (sockets: readonly Socket[], { caller, router }: Connection): boolean => {
	const callerEnd = pipe(
		sockets,
		Array.filter(({ local, remote }) => local === caller && remote === router),
	);

	const routerEnd = pipe(
		sockets,
		Array.filter(({ local, remote }) => local === router && remote === caller),
	);

	const routerUid = Option.map(Array.head(routerEnd), ({ uid }) => uid);
	const both = [...callerEnd, ...routerEnd];

	return (
		Array.isReadonlyArrayNonEmpty(callerEnd) &&
		Option.exists(routerUid, (expected) =>
			pipe(
				both,
				Array.every(({ uid }) => uid === expected),
			),
		)
	);
};

const listPatience = "2 seconds";

class Callers extends Context.Service<
	Callers,
	{
		readonly isThisUser: (connection: Connection) => Effect.Effect<boolean>;
	}
>()("phi-router/router/client/router-port/callers") {
	public static readonly layer = Layer.effect(
		Callers,
		Effect.gen(function* make() {
			const fs = yield* FileSystem.FileSystem;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const hasProcTable = yield* Effect.orElseSucceed(fs.exists(procTable), () => false);

			const listed = Effect.fnUntraced(function* listed({ router }: Connection) {
				if (hasProcTable) {
					const table = yield* fs.readFileString(procTable);

					return pipe(Str.split("\n")(table), Array.map(procSocketOf), Array.getSomes);
				}

				const options = { forceKillAfter: "1 second", stderr: "ignore", stdin: "ignore" } as const;
				const handle = yield* spawner.spawn(ChildProcess.make("lsof", ["-nP", `-iTCP@${router}`, "-Fun"], options));
				const printed = yield* Stream.mkString(Stream.decodeText(handle.stdout));
				const exitCode = yield* handle.exitCode;

				if (exitCode !== lsofListed) {
					return [];
				}

				return Array.flatMap(Str.split(/^p/mu)(printed), lsofSocketsOf);
			}, Effect.scoped);

			const isThisUser = (connection: Connection): Effect.Effect<boolean> =>
				listed(connection).pipe(
					Effect.map((sockets) => heldByOneUser(sockets, connection)),
					Effect.timeout(listPatience),
					Effect.catchCause(() => Effect.succeed(false)),
				);

			return Callers.of({ isThisUser });
		}),
	);
}

export { Callers };

export type { Connection };
