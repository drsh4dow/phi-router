import {
	Array,
	DateTime,
	Effect,
	FileSystem,
	Option,
	Path,
	Redacted,
	Schema,
	String as Str,
	Stream,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

interface Login {
	readonly token: Redacted.Redacted;
	readonly expires: DateTime.Utc;
	/** A Claude login's end, `refreshTokenExpiresAt`. No refresh moves it. */
	readonly ends: Option.Option<DateTime.Utc>;
	readonly chatgptAccountId: Option.Option<string>;
}

class LoginEnded extends Schema.TaggedError<LoginEnded, { readonly brand: unique symbol }>()("LoginEnded", {
	account: Schema.String,
	endedOn: Schema.Option(Schema.DateTimeUtc),
	folder: Schema.String,
	loginCommand: Schema.String,
}) {
	public override get message(): string {
		const on = Option.match(this.endedOn, {
			onNone: () => "",
			onSome: (day) => ` on ${DateTime.formatIsoDateUtc(day)}`,
		});

		return `phi-router: ${this.account}'s login ended${on}. Fix: ${this.loginCommand}`;
	}
}

const ClaudeOauth = Schema.Struct({
	accessToken: Schema.NonEmptyString,
	expiresAt: Schema.Finite,
	refreshTokenExpiresAt: Schema.optionalKey(Schema.Finite),
});

const ClaudeFile = Schema.fromJsonString(Schema.Struct({ claudeAiOauth: ClaudeOauth }));

const CodexTokens = Schema.Struct({ access_token: Schema.NonEmptyString, account_id: Schema.NonEmptyString });

const CodexFile = Schema.fromJsonString(Schema.Struct({ tokens: CodexTokens }));

const Exp = Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite }));

const JwtClaims = Schema.StringFromBase64Url.pipe(Schema.decodeTo(Exp));

const millisPerSecond = 1000;

const jwtClaimsSegment = 1;

const claudeLogin = Effect.fnUntraced(function* claudeLogin(text: string) {
	const { claudeAiOauth } = yield* Schema.decodeEffect(ClaudeFile)(text);
	const ends = Option.fromUndefinedOr(claudeAiOauth.refreshTokenExpiresAt).pipe(Option.map(DateTime.makeUnsafe));

	return {
		chatgptAccountId: Option.none(),
		ends,
		expires: DateTime.makeUnsafe(claudeAiOauth.expiresAt),
		token: Redacted.make(claudeAiOauth.accessToken),
	} satisfies Login;
});

const codexLogin = Effect.fnUntraced(function* codexLogin(text: string) {
	const { tokens } = yield* Schema.decodeEffect(CodexFile)(text);
	const claims = yield* Effect.fromOption(pipe(Str.split(tokens.access_token, "."), Array.get(jwtClaimsSegment)));
	const { exp } = yield* Schema.decodeEffect(JwtClaims)(claims);

	return {
		chatgptAccountId: Option.some(tokens.account_id),
		ends: Option.none(),
		expires: DateTime.makeUnsafe(exp * millisPerSecond),
		token: Redacted.make(tokens.access_token),
	} satisfies Login;
});

const ClaudeEnd = Schema.Struct({ refreshTokenExpiresAt: Schema.optionalKey(Schema.Finite) });

const ClaudeSeen = Schema.fromJsonString(Schema.Struct({ claudeAiOauth: ClaudeEnd }));

const CodexSeen = Schema.fromJsonString(Schema.Struct({ tokens: Schema.Struct({}) }));

const claudeEnds = (text: string): Effect.Effect<Option.Option<DateTime.Utc>, Schema.SchemaError> =>
	Effect.map(Schema.decodeEffect(ClaudeSeen)(text), ({ claudeAiOauth }) =>
		Option.map(Option.fromUndefinedOr(claudeAiOauth.refreshTokenExpiresAt), DateTime.makeUnsafe),
	);

const codexEnds = (text: string): Effect.Effect<Option.Option<DateTime.Utc>, Schema.SchemaError> =>
	Effect.as(Schema.decodeEffect(CodexSeen)(text), Option.none());

/** The `codex app-server` lines that ask for the account with a refreshed token. Its answer to id 2 says it is done. */
const accountRead = [
	'{"id":1,"method":"initialize","params":{"clientInfo":{"name":"phi-router","version":"0.0.0"}}}\n',
	'{"method":"initialized"}\n',
	'{"id":2,"method":"account/read","params":{"refreshToken":true}}\n',
];

const accountReadAnswer = '"id":2';

/** A vendor CLI stopped for taking too long gets SIGKILL this long after SIGTERM, so one that ignores SIGTERM ends too. */
const forceKillAfter = "1 second";

/** `claude auth status --json`, which refreshes a Claude config folder's token in place. */
const claudeRefresh = Effect.fnUntraced(function* claudeRefresh(env: Readonly<Record<string, string | undefined>>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	const options = {
		env,
		extendEnv: true,
		forceKillAfter,
		stderr: "ignore",
		stdin: "ignore",
		stdout: "ignore",
	} as const;

	const handle = yield* spawner.spawn(ChildProcess.make("claude", ["auth", "status", "--json"], options));

	yield* handle.exitCode;
});

/**
 * `codex app-server` asked `account/read` with `refreshToken`, which refreshes a Codex home folder's token in place. Its
 * stdin stays open until the answer comes, since it exits with no answer when stdin closes first.
 */
const codexRefresh = Effect.fnUntraced(function* codexRefresh(env: Readonly<Record<string, string | undefined>>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const stdin = { endOnDone: false, stream: Stream.encodeText(Stream.fromIterable(accountRead)) };

	const handle = yield* spawner.spawn(
		ChildProcess.make("codex", ["app-server"], { env, extendEnv: true, forceKillAfter, stdin }),
	);

	yield* handle.stdout.pipe(
		Stream.decodeText,
		Stream.splitLines,
		Stream.filter(Str.includes(accountReadAnswer)),
		Stream.runHead,
	);
});

/**
 * Each vendor's login folder: its credential file, how it reads whole and for the login's end alone, the variable that
 * points the vendor's CLI at the folder, the CLI run that refreshes the token in place, and the command that logs in
 * again. `atHome` names Claude Code's own folder under `HOME`: its CLI runs there with the variable unset, since the
 * variable moves `.claude.json` from `HOME` into the folder.
 */
const loginFolders = {
	anthropic: {
		atHome: Option.some(".claude"),
		ends: claudeEnds,
		env: "CLAUDE_CONFIG_DIR",
		file: ".credentials.json",
		login: claudeLogin,
		loginCommand: (folder: string) => `CLAUDE_CONFIG_DIR=${folder} claude auth login`,
		refresh: claudeRefresh,
	},
	openai: {
		atHome: Option.none<string>(),
		ends: codexEnds,
		env: "CODEX_HOME",
		file: "auth.json",
		login: codexLogin,
		loginCommand: (folder: string) => `CODEX_HOME=${folder} codex login`,
		refresh: codexRefresh,
	},
} as const;

/**
 * Which vendor's CLI logged in to `folder`, and a Claude login's end, read without its tokens: a Claude config folder
 * when its `.credentials.json` holds `claudeAiOauth`, else a Codex home folder when its `auth.json` holds `tokens`.
 * None when neither does.
 */
const loginIn = Effect.fnUntraced(function* loginIn(folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const seen = (
		vendor: keyof typeof loginFolders,
	): Effect.Effect<Option.Option<{ readonly vendor: typeof vendor; readonly ends: Option.Option<DateTime.Utc> }>> =>
		fs.readFileString(path.join(folder, loginFolders[vendor].file)).pipe(
			Effect.flatMap(loginFolders[vendor].ends),
			Effect.map((ends) => ({ ends, vendor })),
			Effect.option,
		);

	const claude = yield* seen("anthropic");

	if (Option.isSome(claude)) {
		return claude;
	}

	return yield* seen("openai");
});

export { LoginEnded, loginFolders, loginIn };

export type { Login };
