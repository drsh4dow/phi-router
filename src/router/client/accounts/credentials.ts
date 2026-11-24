import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
	Config,
	DateTime,
	Effect,
	FileSystem,
	Option,
	Path,
	Redacted,
	Ref,
	Schema,
	Semaphore,
	String as Str,
	Stream,
	Struct,
} from "effect";
import type { KeySource, Vendor } from "#router/client/configuration/index.ts";
import { LoginEnded, loginFolders } from "./login-folders.ts";
import type { Login } from "./login-folders.ts";

class KeyUnreadable extends Schema.TaggedError<KeyUnreadable, { readonly brand: unique symbol }>()("KeyUnreadable", {
	cause: Schema.Defect(),
	source: Schema.String,
}) {
	public override get message(): string {
		return `${this.source} gave no key`;
	}
}

const succeeded = 0;

const printedBy = Effect.fnUntraced(function* printedBy(command: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(ChildProcess.make(command, { shell: "/bin/sh" }));
	const stdout = yield* Stream.mkString(Stream.decodeText(Stream.drainFork(handle.stdout, handle.stderr)));
	const exitCode = yield* handle.exitCode;
	const key = Str.trim(stdout);

	if (exitCode !== succeeded) {
		return yield* KeyUnreadable.make({ cause: `exit code ${String(exitCode)}`, source: `keyCommand ${command}` });
	}

	if (Str.isEmpty(key)) {
		return yield* KeyUnreadable.make({ cause: "printed nothing", source: `keyCommand ${command}` });
	}

	return Redacted.make(key);
}, Effect.scoped);

const fileKey = Effect.fnUntraced(function* fileKey(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(file);
	const key = Str.trim(text);

	if (Str.isEmpty(key)) {
		return yield* KeyUnreadable.make({ cause: "holds nothing", source: `keyFile ${file}` });
	}

	return Redacted.make(key);
});

/**
 * Reads the key a source names and keeps it redacted. `keyEnv` reads the variable through `Config`. `keyCommand` runs
 * the text in a POSIX shell and takes its trimmed stdout. `keyFile` takes the file's trimmed text. An unset or empty
 * variable, a non-zero exit, empty output, or a missing or empty file fails.
 */
const readKey = Effect.fn("readKey")(function* readKey(
	source: KeySource,
): Effect.fn.Return<Redacted.Redacted, KeyUnreadable, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> {
	if ("keyEnv" in source) {
		return yield* Effect.mapError(Config.Redacted(source.keyEnv), (cause) =>
			KeyUnreadable.make({ cause, source: `keyEnv ${source.keyEnv}` }),
		);
	}

	if ("keyFile" in source) {
		return yield* Effect.catchTag(fileKey(source.keyFile), "PlatformError", (cause) =>
			Effect.fail(KeyUnreadable.make({ cause, source: `keyFile ${source.keyFile}` })),
		);
	}

	return yield* Effect.catchTag(printedBy(source.keyCommand), "PlatformError", (cause) =>
		Effect.fail(KeyUnreadable.make({ cause, source: `keyCommand ${source.keyCommand}` })),
	);
});

const refreshAhead = { minutes: 5 };

const refreshLimit = "30 seconds";

const onePermit = 1;

interface LoginFolder {
	readonly name: string;
	readonly vendor: Vendor;
	readonly folder: string;
}

/** An `env` value that removes the variable from what a child process inherits. */
const unset = Option.getOrUndefined(Option.none<string>());

const homeOf = Effect.fnUntraced(function* homeOf(folder: string, name: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const home = yield* Config.String("HOME");
	const own = yield* fs.realPath(path.join(home, name));
	const given = yield* fs.realPath(folder);

	return yield* Effect.fromOption(Option.liftPredicate(home, () => own === given));
});

/**
 * What a login folder's vendor CLI runs with beside the router's environment: `PATH` from `Config`, and the variable
 * that points the CLI at the folder. In the CLI's own folder under `HOME`, `HOME` and the variable unset instead.
 */
const cliEnv = Effect.fnUntraced(function* cliEnv(account: LoginFolder) {
	const vendor = loginFolders[account.vendor];
	const searched = yield* Config.option(Config.String("PATH"));

	const home = yield* Effect.option(
		Effect.flatMap(Effect.fromOption(vendor.atHome), (name) => homeOf(account.folder, name)),
	);

	const pointed = Option.match(home, {
		onNone: () => ({ [vendor.env]: account.folder }),
		onSome: (at) => ({ HOME: at, [vendor.env]: unset }),
	});

	return Option.match(searched, {
		onNone: () => pointed,
		onSome: (found) => Struct.assign(pointed, { PATH: found }),
	});
});

const folderOf = Effect.fnUntraced(function* folderOf(account: LoginFolder) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const vendor = loginFolders[account.vendor];
	const env = yield* cliEnv(account);

	const services = yield* Effect.context<
		FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
	>();

	const ending = { account: account.name, folder: account.folder, loginCommand: vendor.loginCommand(account.folder) };
	const ended = LoginEnded.make(Struct.assign(ending, { endedOn: Option.none() }));

	return {
		cliRefresh: vendor
			.refresh(env)
			.pipe(Effect.scoped, Effect.timeout(refreshLimit), Effect.ignore, Effect.provideContext(services)),
		ended,
		ending,
		keptTokenWarning: Effect.logWarning(
			`phi-router: ${account.name}'s token got a 401 and its CLI left it as it was, so it is sent once more. If 401s go on, log in again: ${ending.loginCommand}`,
		),
		read: fs.readFileString(path.join(account.folder, vendor.file)).pipe(
			Effect.flatMap(vendor.login),
			Effect.mapError(() => ended),
		),
	};
});

interface LoginToSend {
	readonly login: Login;
	readonly markRejected: Effect.Effect<void>;
}

interface FolderLogin {
	/**
	 * Makes the folder's token fit to send, before the send reads the verdict store, so no vendor CLI runs between that
	 * read and the send. When the token is under 5 minutes from expiry or is the token last rejected, the vendor's CLI
	 * runs once and the folder is read again. That run spends the rejection, so the resend takes whatever token the
	 * folder holds. A login past its end, or a token still near expiry, fails. One permit per folder, so one CLI runs at
	 * a time. A CLI that fails or is missing is no error by itself: the read after it decides.
	 */
	readonly ready: Effect.Effect<void, LoginEnded>;
	readonly current: Effect.Effect<LoginToSend, LoginEnded>;
}

const folderLogin = Effect.fnUntraced(function* folderLogin(account: LoginFolder) {
	const folder = yield* folderOf(account);
	const permit = yield* Semaphore.make(onePermit);
	const refused = yield* Ref.make(Option.none<Redacted.Redacted>());

	const current = Effect.gen(function* current() {
		const now = yield* DateTime.now;
		const login = yield* folder.read;

		if (Option.exists(login.ends, (end) => DateTime.isLessThanOrEqualTo(end, now))) {
			return yield* LoginEnded.make(Struct.assign(folder.ending, { endedOn: login.ends }));
		}

		return { login, markRejected: Ref.set(refused, Option.some(login.token)) } satisfies LoginToSend;
	});

	const stillRefused = Effect.gen(function* stillRefused() {
		const last = yield* Ref.get(refused);
		const { login } = yield* current;

		return Option.exists(last, (token) => Redacted.value(token) === Redacted.value(login.token));
	});

	const sendable = Effect.gen(function* sendable() {
		const now = yield* DateTime.now;
		const { login } = yield* current;
		const rejected = yield* stillRefused;

		return !rejected && DateTime.isGreaterThanOrEqualTo(login.expires, DateTime.add(now, refreshAhead));
	});

	const refreshing = Effect.gen(function* refreshing() {
		yield* folder.cliRefresh;
		yield* Effect.when(folder.keptTokenWarning, stillRefused);
		yield* Ref.set(refused, Option.none());

		return yield* sendable;
	}).pipe(
		Effect.filterOrFail(
			(fit) => fit,
			() => folder.ended,
		),
	);

	const unfit = sendable.pipe(Effect.map((fit) => !fit));

	const ready = Effect.when(refreshing, unfit).pipe(Effect.asVoid, Semaphore.withPermit(permit));

	return { current, ready } satisfies FolderLogin;
});

export { KeyUnreadable, folderLogin, readKey };
