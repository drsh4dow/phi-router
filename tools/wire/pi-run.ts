import {
	Array,
	Config,
	Deferred,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Path,
	Schedule,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { freePort, ran } from "#tools/lifecycle/launched.ts";
import { bundles } from "#tools/plugin/bundles.ts";
import { fakes } from "#tools/route/mocked-router.ts";
import { succeeded } from "./checks.ts";

const checkout = decodeURIComponent(new URL("../..", import.meta.url).pathname);

/** The repository `pi install` takes, served by `git daemon` on loopback under the path GitHub gives it. */
const repository = "drsh4dow/phi-router";

/**
 * The caller's `PATH` without the `node_modules/.bin` folders that `bun run` puts first, this checkout's and those of
 * every folder above it, so `pi`, `npm` and the scripts of `pi install` find only the tools a user has.
 */
const userPath = Effect.map(Config.String("PATH"), (searchPath) =>
	pipe(
		Str.split(searchPath, ":"),
		Array.filter((folder) => !Str.endsWith("/node_modules/.bin")(folder)),
		Array.join(":"),
	),
);

/** The folders a served snapshot uses: git's home, and the folder `git daemon` serves from. */
interface SnapshotFolders {
	readonly home: string;
	readonly daemonBase: string;
}

/** Runs `git` with no config beyond the repository's own, and fails naming the command unless it exits 0. */
const gitAsks = Effect.fnUntraced(function* gitAsks(args: readonly string[], where: SnapshotFolders) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const searchPath = yield* userPath;
	const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: where.home, PATH: searchPath };
	const command = ChildProcess.make("git", args, { env, extendEnv: false, stdin: "ignore" });

	yield* spawner.exitCode(command).pipe(
		Effect.filterOrFail(
			(exitCode) => exitCode === succeeded,
			(exitCode) => `git ${Array.join(args, " ")} exited ${String(exitCode)}`,
		),
	);
});

const snapshot = Effect.fnUntraced(function* snapshot(where: SnapshotFolders) {
	const path = yield* Path.Path;
	const repo = path.join(where.daemonBase, repository);
	const tree = ["--git-dir", path.join(repo, ".git"), "--work-tree", checkout];
	const author = ["-c", "user.name=phi-wire", "-c", "user.email=phi-wire@127.0.0.1"];

	const built = pipe(
		bundles,
		Array.map(({ out }) => out),
	);

	yield* gitAsks(["init", "--quiet", repo], where);
	yield* gitAsks([...tree, "add", "--all"], where);
	yield* gitAsks([...tree, "add", "--force", ...built], where);
	yield* gitAsks([...author, ...tree, "commit", "--quiet", "--no-verify", "-m", "the tree under test"], where);
});

/**
 * `git daemon` serving a snapshot of the tree under test on a free loopback port until the scope ends. Returns the
 * address `pi install` takes.
 */
const gitServed = Effect.fnUntraced(function* gitServed(where: SnapshotFolders) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const port = yield* freePort;
	const address = `git://127.0.0.1:${String(port)}/${repository}`;
	const flags = ["--export-all", "--reuseaddr", "--listen=127.0.0.1", `--port=${String(port)}`];

	yield* snapshot(where);
	yield* spawner.spawn(
		ChildProcess.make("git", ["daemon", ...flags, `--base-path=${where.daemonBase}`], { stdin: "ignore" }),
	);
	yield* gitAsks(["ls-remote", address], where).pipe(
		Effect.retry({ schedule: Schedule.spaced("100 millis") }),
		Effect.timeout("10 seconds"),
	);

	return `git:${address}`;
});

const entry = decodeURIComponent(new URL("../../src/router/main.ts", import.meta.url).pathname);

/**
 * Gives the agent folder `agent` a fake subscription login, and settings that turn retries off, so a request the router
 * does not take fails its turn, and keep one recent token, so `/compact` has turns to summarize.
 */
const agentFolder = Effect.fnUntraced(function* agentFolder(agent: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const login = { access: fakes.harnessToken, expires: 4_102_444_800_000, refresh: "phi-wire-refresh", type: "oauth" };
	const settings = { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } };

	yield* fs.writeFileString(path.join(agent, "auth.json"), Formatter.formatJson({ anthropic: login }), {
		mode: 0o600,
	});
	yield* fs.writeFileString(path.join(agent, "settings.json"), Formatter.formatJson(settings));
});

/** A fresh home, pi agent folder and working folder for `pi`, and a folder `git daemon` serves from. */
const place = Effect.gen(function* place() {
	const fs = yield* FileSystem.FileSystem;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-home-" });
	const agent = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-pi-" });
	const work = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-work-" });
	const daemonBase = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-git-" });
	const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-tmp-" });

	yield* agentFolder(agent);

	return { agent, daemonBase, home, temporary, work };
});

type Place = Readonly<Effect.Success<typeof place>>;

/** What pi's RPC mode prints once it has handled a command. */
const rpcAnswered = `"type":"response"`;

/** A line pi's RPC mode reads, and what pi prints once it has done with it, which ends the turn. */
interface RpcLine {
	readonly stdinLine: string;
	readonly turnEnd: string;
}

/**
 * One `pi` run with `args` in the working folder, the agent folder of `where`, and the router's port and `env` beside
 * `PATH`. Its stdin holds `rpc`, when there is one, until pi prints `until`, such as `rpcAnswered`, and then closes,
 * since pi's RPC mode cancels a command still running at the close. Returns its pid, the exit code, and what it
 * printed.
 */
const piRun = Effect.fnUntraced(
	function* piRun(
		where: Place,
		args: readonly string[],
		given: { readonly env: Readonly<Record<string, string>>; readonly rpc?: RpcLine },
	) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const searchPath = yield* userPath;
		const answered = yield* Deferred.make<boolean>();
		const rpc = Option.fromUndefinedOr(given.rpc);

		const input = Option.match(rpc, {
			onNone: () => Stream.empty,
			onSome: ({ stdinLine }) =>
				Stream.concat(Stream.make(stdinLine), Stream.fromEffectDrain(Deferred.await(answered))),
		});

		const command = ChildProcess.make("pi", args, {
			cwd: where.work,
			env: Struct.assign(given.env, {
				HOME: where.home,
				PATH: searchPath,
				PI_CODING_AGENT_DIR: where.agent,
				PI_OFFLINE: "1",
				TMPDIR: where.temporary,
				XDG_CACHE_HOME: `${where.home}/.cache`,
				XDG_DATA_HOME: `${where.home}/.local/share`,
			}),
			extendEnv: false,
			stdin: Stream.encodeText(input),
		});

		const handle = yield* spawner.spawn(command);

		const printed = yield* Stream.merge(handle.stdout, handle.stderr).pipe(
			Stream.decodeText,
			Stream.tap((text) =>
				Effect.when(
					Deferred.succeed(answered, true),
					Effect.succeed(Option.exists(rpc, ({ turnEnd }) => Str.includes(turnEnd)(text))),
				),
			),
			Stream.mkString,
		);

		const exitCode = yield* handle.exitCode;

		return { exitCode, pid: Number(handle.pid), printed, showedLogin: Str.includes(fakes.harnessToken)(printed) };
	},
	Effect.scoped,
	Effect.timeout("3 minutes"),
);

/**
 * Mounts an empty `/tmp` and runs a command in it. Its arguments are the file that receives the listing, the number of
 * folders to keep, those folders relative to `/tmp`, then the command. It binds each kept folder back from the old
 * `/tmp`, runs the command with no `TMPDIR`, and writes the name of each entry `/tmp` then holds to the listing, each
 * ended by a NUL. It exits as the command did. No path passes through a shell string, so any byte but NUL may be in one.
 */
const emptyTmpScript = `set -eu
listing=$1
kept=$2
shift 2
cd /tmp
mount -t tmpfs tmpfs /tmp
while [ "$kept" -gt 0 ]; do
	mkdir -p "/tmp/$1"
	mount --no-canonicalize --bind "./$1" "/tmp/$1"
	kept=$((kept - 1))
	shift
done
cd /
unset TMPDIR
code=0
"$@" || code=$?
find /tmp -mindepth 1 -maxdepth 1 -printf '%f\\0' > "$listing"
exit "$code"`;

/** The entries `/tmp` held after the command, from the listing at `listing`, but for those `kept` lie in. */
const leftBeside = Effect.fnUntraced(function* leftBeside(listing: string, kept: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;
	const listed = yield* fs.readFileString(listing).pipe(Effect.orElseSucceed(() => ""));

	const keptEntries = pipe(
		kept,
		Array.map((relative) => Array.headNonEmpty(Str.split(relative, "/"))),
	);

	return pipe(Str.split(listed, "\0"), Array.filter(Str.isNonEmpty), Array.difference(keptEntries));
});

/**
 * Runs `command` with `home` as its home and no variable of the caller's but `PATH`, in a mount namespace whose `/tmp`
 * starts empty but for each of `folders` that lives there. Returns its exit code, what it printed, and each entry of
 * `/tmp` it left beside those folders, wherever the harness it runs chose to write.
 */
const inEmptyTmp = Effect.fnUntraced(function* inEmptyTmp(
	command: readonly string[],
	home: string,
	folders: readonly string[],
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const searchPath = yield* userPath;
	const listingFolder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-listing-" });
	const listing = path.join(listingFolder, "left");

	const kept = pipe(
		[...folders, listingFolder],
		Array.map((folder) => path.relative("/tmp", folder)),
		Array.filter((relative) => relative !== ".." && !Str.startsWith("../")(relative)),
	);

	const isolated = ["unshare", "-rm", "sh", "-c", emptyTmpScript, "sh", listing, String(kept.length), ...kept];
	const run = yield* ran(["env", "-i", `HOME=${home}`, `PATH=${searchPath}`, ...isolated, ...command], {});

	const left = yield* leftBeside(listing, kept);

	return { exitCode: run.exitCode, left, printed: run.printed };
}, Effect.scoped);

/**
 * `pi install` with the git address of a snapshot of the tree under test in the agent folder of `where`, then `pi list`
 * and `phi-router doctor pi` on that folder in an empty `/tmp`. Fails with what `pi install` printed when it does not
 * exit 0. Returns whether pi lists the package, whether the doctor passed, and what it left in `/tmp`.
 */
const installedIn = Effect.fnUntraced(function* installedIn(where: Place) {
	const none = { env: {} };
	const source = yield* gitServed(where);

	yield* piRun(where, ["install", source], none).pipe(
		Effect.filterOrFail(
			({ exitCode }) => exitCode === succeeded,
			({ exitCode, printed }) => `pi install exited ${String(exitCode)}: ${printed}`,
		),
	);
	const listed = yield* piRun(where, ["list"], none);

	const doctor = yield* inEmptyTmp(["bun", entry, "doctor", "pi", "--agent-dir", where.agent], where.home, [
		checkout,
		where.home,
		where.agent,
	]);

	return {
		doctored: doctor.exitCode === succeeded,
		installed: Str.includes(source)(listed.printed),
		leftInTmp: doctor.left,
	};
}, Effect.scoped);

export { inEmptyTmp, installedIn, piRun, place, rpcAnswered };

export type { RpcLine };
