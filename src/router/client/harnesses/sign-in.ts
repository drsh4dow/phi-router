import { Array, Effect, FileSystem, Option, Path, Record, Schema, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { agentFolder } from "./pi.ts";
import { codexHome } from "./codex.ts";

type SignIn =
	| { readonly kind: "plan"; readonly plan: string; readonly account?: string | undefined }
	| { readonly kind: "enterprise"; readonly account?: string | undefined }
	| { readonly kind: "apiKey" }
	| { readonly kind: "none" }
	| { readonly kind: "provider"; readonly provider: string };

const signedOut: SignIn = { kind: "none" };

const succeeded = 0;

const optionalText = Schema.optionalKey(Schema.String);

const NullableText = Schema.NullOr(Schema.String);

const ClaudeStatus = Schema.fromJsonString(
	Schema.Struct({
		apiProvider: optionalText,
		authMethod: optionalText,
		email: Schema.optionalKey(NullableText),
		loggedIn: Schema.Boolean,
		subscriptionType: Schema.optionalKey(NullableText),
	}),
);

const claudePlans: Readonly<Record<string, string>> = { max: "Claude Max", pro: "Claude Pro", team: "Claude Team" };

const providers: Readonly<Record<string, string>> = { bedrock: "Bedrock", foundry: "Foundry", vertex: "Vertex AI" };

const firstParty = "firstParty";

const claudeSignInOf = (status: typeof ClaudeStatus.Type): SignIn => {
	const { apiProvider = firstParty, authMethod, email, loggedIn, subscriptionType } = status;
	const account = Option.getOrUndefined(Option.fromNullishOr(email));

	if (apiProvider !== firstParty) {
		return { kind: "provider", provider: Option.getOrElse(Record.get(providers, apiProvider), () => apiProvider) };
	}

	if (!loggedIn) {
		return signedOut;
	}

	if (authMethod === "oauth_token") {
		return { kind: "plan", plan: "Claude subscription" };
	}

	if (authMethod !== "claude.ai") {
		return { kind: "apiKey" };
	}

	if (subscriptionType === "enterprise") {
		return { account, kind: "enterprise" };
	}

	const plan = Option.getOrElse(Record.get(claudePlans, subscriptionType ?? ""), () => "Claude");

	return { account, kind: "plan", plan };
};

const printed = Effect.fnUntraced(function* printed(args: readonly string[], env: Readonly<Record<string, string>>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const [command = "", ...rest] = args;
	const options = { env, extendEnv: true, stdin: "ignore" } as const;
	const started = yield* Effect.option(spawner.spawn(ChildProcess.make(command, rest, options)));

	if (Option.isNone(started)) {
		return Option.none<{ readonly code: number; readonly said: string; readonly text: string }>();
	}

	const { exitCode, stderr, stdout } = started.value;

	const [out, error] = yield* Effect.all(
		[Stream.mkString(Stream.decodeText(stdout)), Stream.mkString(Stream.decodeText(stderr))],
		{
			concurrency: "unbounded",
		},
	);

	const code = yield* exitCode;

	return Option.some({ code: Number(code), said: `${out}${error}`, text: out });
}, Effect.scoped);

const claudeSignIn = Effect.fnUntraced(function* claudeSignIn(folder: string) {
	const env = pipe(
		Option.liftPredicate(folder, Str.isNonEmpty),
		Option.match({
			onNone: () => ({}),
			onSome: (named): Readonly<Record<string, string>> => ({
				CLAUDE_CODE_OAUTH_TOKEN: "",
				CLAUDE_CONFIG_DIR: named,
			}),
		}),
	);

	const status = yield* printed(["claude", "auth", "status", "--json"], env);

	return yield* Option.match(status, {
		onNone: () => Effect.succeed(signedOut),
		onSome: ({ text }) =>
			Schema.decodeEffect(ClaudeStatus)(text).pipe(
				Effect.map(claudeSignInOf),
				Effect.orElseSucceed(() => signedOut),
			),
	});
});

const claudeLogin = Effect.fnUntraced(function* claudeLogin(folder: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

	return yield* spawner.exitCode(
		ChildProcess.make("claude", ["auth", "login"], {
			env: { CLAUDE_CONFIG_DIR: folder },
			extendEnv: true,
			stderr: "inherit",
			stdin: "inherit",
			stdout: "inherit",
		}),
	);
});

const IdToken = Schema.fromJsonString(Schema.Struct({ tokens: Schema.Struct({ id_token: Schema.String }) }));

const chatgptAuth = "https://api.openai.com/auth";

const ChatgptAuth = Schema.Struct({ chatgpt_plan_type: optionalText });

const Claims = Schema.fromJsonString(
	Schema.Struct({ [chatgptAuth]: Schema.optionalKey(ChatgptAuth), email: optionalText }),
);

const IdClaims = Schema.StringFromBase64Url.pipe(Schema.decodeTo(Claims));

const claimsSegment = 1;

const chatgptPlan = Effect.gen(function* chatgptPlan() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const home = yield* codexHome("");
	const text = yield* fs.readFileString(path.join(home, "auth.json"));
	const { tokens } = yield* Schema.decodeEffect(IdToken)(text);
	const segment = yield* Effect.fromOption(Array.get(Str.split(tokens.id_token, "."), claimsSegment));
	const claims = yield* Schema.decodeEffect(IdClaims)(segment);

	const plan = pipe(
		Option.fromUndefinedOr(claims[chatgptAuth]),
		Option.flatMap(({ chatgpt_plan_type: type }) => Option.fromUndefinedOr(type)),
		Option.map((type) => `ChatGPT ${Str.capitalize(type)}`),
		Option.getOrElse(() => "ChatGPT"),
	);

	return { account: claims.email, kind: "plan", plan } satisfies SignIn;
}).pipe(Effect.orElseSucceed((): SignIn => ({ kind: "plan", plan: "ChatGPT" })));

const codexSignIn = Effect.gen(function* codexSignIn() {
	const status = yield* printed(["codex", "login", "status"], {});

	if (Option.isNone(status) || status.value.code !== succeeded) {
		return signedOut;
	}

	if (Str.includes("ChatGPT")(status.value.said)) {
		return yield* chatgptPlan;
	}

	return { kind: "apiKey" } satisfies SignIn;
});

const PiAuth = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Struct({ type: Schema.String })));

const piSignIn = Effect.gen(function* piSignIn() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const agent = yield* agentFolder("");

	const stored = yield* fs.readFileString(path.join(agent, "auth.json")).pipe(
		Effect.flatMap(Schema.decodeEffect(PiAuth)),
		Effect.map((auth) => Record.get(auth, "anthropic")),
		Effect.orElseSucceed(() => Option.none<{ readonly type: string }>()),
	);

	return Option.match(stored, {
		onNone: () => signedOut,
		onSome: ({ type }): SignIn => {
			if (type === "oauth") {
				return { kind: "plan", plan: "Claude" };
			}

			return { kind: "apiKey" };
		},
	});
});

export { claudeLogin, claudeSignIn, codexSignIn, piSignIn };

export type { SignIn };
