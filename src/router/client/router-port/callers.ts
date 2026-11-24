import { Array, Context, Effect, FileSystem, Layer, Option, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** One end of a TCP connection, as `127.0.0.1:47411`. */
type Endpoint = string;

/** The two ends of one connection to the router. */
interface Connection {
	readonly router: Endpoint;
	readonly caller: Endpoint;
}

/** One TCP socket the machine lists: its own end, the far end, and the uid that holds it. */
interface Socket {
	readonly local: Endpoint;
	readonly remote: Endpoint;
	readonly uid: number;
}

/** Linux lists every IPv4 TCP socket of the network namespace here, each user's included. */
const procTable = "/proc/net/tcp";

/** A row such as `0: 0100007F:B92B 0100007F:DD8D 01 00000000:00000000 00:00000000 00000000  1000 ...`. */
const procRow =
	/^\s*\d+: (?<local>[\dA-F]{8}:[\dA-F]{4}) (?<remote>[\dA-F]{8}:[\dA-F]{4}) [\dA-F]{2} \S+ \S+ \S+ +(?<uid>\d+) /u;

/** The kernel prints an address's bytes in the host's order, which is little-endian on every machine the router runs on. */
const procEndpoint =
	/^(?<fourth>[\dA-F]{2})(?<third>[\dA-F]{2})(?<second>[\dA-F]{2})(?<first>[\dA-F]{2}):(?<port>[\dA-F]{4})$/u;

/** An `lsof -F` line that names a process's uid, such as `u501`. */
const lsofUid = /^u(?<uid>\d+)$/u;

/** An `lsof -F` line that names a connected socket, such as `n127.0.0.1:52000->127.0.0.1:47411`. A listener has no `->`. */
const lsofSocket = /^n(?<local>\S+)->(?<remote>\S+)$/u;

/** `lsof` exits 0 only when it listed what it was asked for. A failed list proves nothing, whatever it printed. */
const lsofListed = 0;

const hex = 16;

const groupsOf = (pattern: Readonly<RegExp>, text: string): Option.Option<Readonly<Record<string, string>>> =>
	pipe(
		Option.fromNullishOr(pattern.exec(text)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
	);

const fromHex = (digits = ""): string => String(Number.parseInt(digits, hex));

/**
 * `0100007F:B92B` as `127.0.0.1:47403`.
 *
 * @param {string} printed An address and port as `/proc/net/tcp` prints them.
 * @returns {Option.Option<Endpoint>} The endpoint, or `None` for one that does not parse.
 */
const endpointOf = (printed: string): Option.Option<Endpoint> =>
	Option.map(
		groupsOf(procEndpoint, printed),
		({ first, second, third, fourth, port }) =>
			`${fromHex(first)}.${fromHex(second)}.${fromHex(third)}.${fromHex(fourth)}:${fromHex(port)}`,
	);

const procSocketOf = (line: string): Option.Option<Socket> =>
	Option.flatMap(groupsOf(procRow, line), ({ local = "", remote = "", uid = "" }) =>
		Option.all({ local: endpointOf(local), remote: endpointOf(remote), uid: Option.some(Number(uid)) }),
	);

/**
 * The sockets of one process in `lsof -F un` output: its `u<uid>` line, then an `n<local>-><remote>` line for each
 * connected socket it holds.
 *
 * @param {string} block The lines of one process.
 * @returns {readonly Socket[]} Its connected sockets, each with its uid.
 */
const lsofSocketsOf = (block: string): readonly Socket[] => {
	const lines = Str.split("\n")(block);
	const uid = Array.findFirst(lines, (line) => groupsOf(lsofUid, line));

	return pipe(
		lines,
		Array.map((line) => groupsOf(lsofSocket, line)),
		Array.getSomes,
		Array.flatMap(({ local = "", remote = "" }) =>
			Option.match(uid, {
				onNone: () => [],
				onSome: (named) => [{ local, remote, uid: Number(named["uid"]) }],
			}),
		),
	);
};

/**
 * Whether one user holds both ends of the connection: the machine lists the caller's end and the router's end, and
 * every socket on either end has the same uid. The router's end carries the router's own uid, so a socket of another
 * user, or no socket at all, on the caller's end leaves the connection unproven.
 *
 * @param {readonly Socket[]} sockets What the machine lists.
 * @param {Connection} connection The connection.
 * @returns {boolean} Whether one user holds both ends.
 */
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

/** A list of the sockets that has not answered by then has not proven anything. */
const listPatience = "2 seconds";

/** Who is at the far end of a connection to the router. */
class Callers extends Context.Service<
	Callers,
	{
		/**
		 * Whether the caller runs as the user the router runs as. False for another user, and false whenever the
		 * machine's list of sockets did not prove it: unreadable, `lsof` missing or failing, slower than 2 s, or no
		 * socket on the caller's end.
		 */
		readonly isThisUser: (connection: Connection) => Effect.Effect<boolean>;
	}
>()("phi-router/router/client/router-port/callers") {
	/**
	 * Reads `/proc/net/tcp` where it exists, which is Linux. Elsewhere, which is macOS, runs `lsof` for the router's
	 * end: a user who is not root sees only the sockets of their own processes there, so another user's end is never
	 * listed. One read per request, nothing cached.
	 */
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
