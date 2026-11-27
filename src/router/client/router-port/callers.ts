import { Array, Context, Effect, FileSystem, Layer, Option, Path, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { bytesOf, hmacOf, macs } from "./proof.ts";
import { isWindows, systemTool } from "#router/client/platform.ts";
import { storedToken, tokenUsed } from "./caller-token.ts";
import type { Mac } from "effect/crypto";

type Endpoint = `${string}:${number}`;

interface Connection {
	readonly router: Endpoint;
	readonly caller: Endpoint;
}

const unnamed = "unnamed";

type Caller = Connection | typeof unnamed;

interface Socket {
	readonly local: Endpoint;
	readonly remote: Endpoint;
	readonly owner: string;
}

interface Row {
	readonly local: Endpoint;
	readonly remote: Endpoint;
	readonly pid: number;
}

const procTable = "/proc/net/tcp";

const procRow =
	/^\s*\d+: (?<local>[\dA-F]{8}:[\dA-F]{4}) (?<remote>[\dA-F]{8}:[\dA-F]{4}) [\dA-F]{2} \S+ \S+ \S+ +(?<uid>\d+) /u;

const procEndpoint =
	/^(?<fourth>[\dA-F]{2})(?<third>[\dA-F]{2})(?<second>[\dA-F]{2})(?<first>[\dA-F]{2}):(?<port>[\dA-F]{4})$/u;

const lsofUid = /^u(?<uid>\d+)$/u;

const lsofSocket = /^n(?<localHost>\S+):(?<localPort>\d+)->(?<remoteHost>\S+):(?<remotePort>\d+)$/u;

const netstatRow =
	/^\s*TCP\s+(?<localHost>\d{1,3}(?:\.\d{1,3}){3}):(?<localPort>\d+)\s+(?<remoteHost>\d{1,3}(?:\.\d{1,3}){3}):(?<remotePort>\d+)\s+\S+\s+(?<pid>\d+)\s*$/u;

const tasklistRow = /^"[^"]*","(?<pid>\d+)","[^"]*","[^"]*","[^"]*","[^"]*","(?<owner>[^"\\]+\\[^"\\]+)",/u;

const undecoded = "\uFFFD";

const idleProcess = 0;

const listedFine = 0;

const hex = 16;

const groupsOf = (pattern: Readonly<RegExp>, text: string): Option.Option<Readonly<Record<string, string>>> =>
	pipe(
		Option.fromNullishOr(pattern.exec(text)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
	);

const linesOf = Str.split(/\r?\n/u);

const fromHex = (digits = ""): number => Number.parseInt(digits, hex);

const endpointOf = (printed: string): Option.Option<Endpoint> =>
	Option.map(
		groupsOf(procEndpoint, printed),
		({ first, second, third, fourth, port }): Endpoint =>
			`${fromHex(first)}.${fromHex(second)}.${fromHex(third)}.${fromHex(fourth)}:${fromHex(port)}`,
	);

const procSocketOf = (line: string): Option.Option<Socket> =>
	Option.flatMap(groupsOf(procRow, line), ({ local = "", remote = "", uid = "" }) =>
		Option.all({ local: endpointOf(local), owner: Option.some(uid), remote: endpointOf(remote) }),
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
						owner: named["uid"] ?? "",
						remote: `${remoteHost}:${Number(remotePort)}`,
					},
				],
			}),
		),
	);
};

const netstatRowOf = (line: string): Option.Option<Row> =>
	Option.map(
		groupsOf(netstatRow, line),
		({ localHost = "", localPort = "", remoteHost = "", remotePort = "", pid = "" }): Row => ({
			local: `${localHost}:${Number(localPort)}`,
			pid: Number(pid),
			remote: `${remoteHost}:${Number(remotePort)}`,
		}),
	);

const ownerOf = (printed: string, pid: number): Option.Option<string> => {
	const owners = pipe(
		linesOf(printed),
		Array.map((line) => groupsOf(tasklistRow, line)),
		Array.getSomes,
		Array.filter((row) => Number(row["pid"]) === pid),
		Array.map(({ owner = "" }) => owner),
	);

	return Array.matchLeft(owners, {
		onEmpty: () => Option.none(),
		onNonEmpty: (owner, others) =>
			Option.liftPredicate(owner, () => Array.isReadonlyArrayEmpty(others) && !Str.includes(undecoded)(owner)),
	});
};

const endsOf = (rows: readonly Row[], { caller, router }: Connection): readonly Row[] =>
	pipe(
		rows,
		Array.filter(
			({ local, remote }) => (local === caller && remote === router) || (local === router && remote === caller),
		),
	);

const heldByOneUser = (sockets: readonly Socket[], { caller, router }: Connection): boolean => {
	const callerEnd = pipe(
		sockets,
		Array.filter(({ local, remote }) => local === caller && remote === router),
	);

	const routerEnd = pipe(
		sockets,
		Array.filter(({ local, remote }) => local === router && remote === caller),
	);

	const routerOwner = Option.map(Array.head(routerEnd), ({ owner }) => owner);
	const both = [...callerEnd, ...routerEnd];

	return (
		Array.isReadonlyArrayNonEmpty(callerEnd) &&
		Option.exists(routerOwner, (expected) =>
			pipe(
				both,
				Array.every(({ owner }) => owner === expected),
			),
		)
	);
};

const listPatience = "2 seconds";

const tokenMatches = Effect.fnUntraced(function* tokenMatches(presented: string) {
	const held = yield* storedToken;
	const given = yield* hmacOf(bytesOf(held), bytesOf(presented));
	const expected = yield* hmacOf(bytesOf(held), bytesOf(held));

	return given === expected;
});

class Callers extends Context.Service<
	Callers,
	{
		readonly isThisUser: (caller: Caller) => Effect.Effect<boolean>;
		readonly tokenFine: (presented: string) => Effect.Effect<boolean>;
	}
>()("phi-router/router/client/router-port/callers") {
	public static readonly layer = Layer.effect(
		Callers,
		Effect.gen(function* make() {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const hasProcTable = yield* Effect.orElseSucceed(fs.exists(procTable), () => false);
			const onWindows = isWindows(path);

			const tasklist = yield* systemTool("tasklist.exe");
			const netstat = yield* systemTool("netstat.exe");

			const printedBy = Effect.fnUntraced(function* printedBy(command: string, args: readonly string[]) {
				const options = { forceKillAfter: "1 second", stderr: "ignore", stdin: "ignore" } as const;
				const handle = yield* spawner.spawn(ChildProcess.make(command, args, options));
				const printed = yield* Stream.mkString(Stream.decodeText(handle.stdout));
				const exitCode = yield* handle.exitCode;

				return Option.liftPredicate(printed, () => exitCode === listedFine);
			});

			const windowsOwnerOf = Effect.fnUntraced(function* windowsOwnerOf(pid: number) {
				if (pid === idleProcess) {
					return Option.none();
				}

				const printed = yield* printedBy(tasklist, ["/v", "/fo", "csv", "/nh", "/fi", `PID eq ${pid}`]);

				return pipe(
					printed,
					Option.flatMap((listing) => ownerOf(listing, pid)),
				);
			}, Effect.scoped);

			const windowsListed = Effect.fnUntraced(function* windowsListed(connection: Connection) {
				const table = yield* printedBy(netstat, ["-ano", "-p", "TCP"]);
				const lines = linesOf(Option.getOrElse(table, () => ""));
				const rows = endsOf(pipe(lines, Array.map(netstatRowOf), Array.getSomes), connection);

				const pids = pipe(
					rows,
					Array.map(({ pid }) => pid),
					Array.dedupe,
				);

				const owners = yield* Effect.forEach(
					pids,
					(pid) =>
						Effect.map(
							windowsOwnerOf(pid),
							Option.map((owner) => ({ owner, pid })),
						),
					{ concurrency: "unbounded" },
				);

				return Option.match(Option.all(owners), {
					onNone: (): readonly Socket[] => [],
					onSome: (named) =>
						pipe(
							rows,
							Array.flatMap(({ local, pid, remote }): readonly Socket[] =>
								pipe(
									named,
									Array.findFirst((held) => held.pid === pid),
									Option.match({ onNone: () => [], onSome: ({ owner }) => [{ local, owner, remote }] }),
								),
							),
						),
				});
			}, Effect.scoped);

			const listed = Effect.fnUntraced(function* listed(connection: Connection) {
				if (hasProcTable) {
					const table = yield* fs.readFileString(procTable);

					return pipe(Str.split("\n")(table), Array.map(procSocketOf), Array.getSomes);
				}

				if (onWindows) {
					return yield* windowsListed(connection);
				}

				const printed = yield* printedBy("lsof", ["-nP", `-iTCP@${connection.router}`, "-Fun"]);

				return Array.flatMap(Str.split(/^p/mu)(Option.getOrElse(printed, () => "")), lsofSocketsOf);
			}, Effect.scoped);

			const heldByThisUser = (connection: Connection): Effect.Effect<boolean> =>
				listed(connection).pipe(
					Effect.map((sockets) => heldByOneUser(sockets, connection)),
					Effect.timeout(listPatience),
					Effect.catchCause(() => Effect.succeed(false)),
				);

			const isThisUser = (caller: Caller): Effect.Effect<boolean> => {
				if (caller === unnamed) {
					return Effect.succeed(false);
				}

				return heldByThisUser(caller);
			};

			const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | Mac.Mac>();

			const tokenFine = (presented: string): Effect.Effect<boolean> => {
				if (!tokenUsed(path)) {
					return Effect.succeed(true);
				}

				return tokenMatches(presented).pipe(
					Effect.provideContext(services),
					Effect.orElseSucceed(() => false),
				);
			};

			return Callers.of({ isThisUser, tokenFine });
		}),
	).pipe(Layer.provide(macs));
}

export { Callers, unnamed };

export type { Caller, Connection };
