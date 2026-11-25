import {
	Array,
	Config,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Path,
	Record,
	Schema,
	Stream,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { sessionStartHooksRan } from "#tools/route/harnesses.ts";

const runtimeAndScript = 2;

const next = 1;

const ok = 200;

const session = "stand-in-session";

const Env = Schema.Record(Schema.String, Schema.String);

const Settings = Schema.fromJsonString(Schema.Struct({ env: Schema.optionalKey(Env) }));

const PromptMatcher = Schema.Struct({ hooks: Schema.Array(Schema.Struct({ command: Schema.String })) });

const PromptEvents = Schema.Struct({ UserPromptSubmit: Schema.Array(PromptMatcher) });

const PromptHooks = Schema.fromJsonString(Schema.Struct({ hooks: PromptEvents }));

const Text = Schema.Struct({ text: Schema.String, type: Schema.Literal("text") });

const Message = Schema.Struct({ content: Schema.Array(Text), role: Schema.Literal("user") });

const Body = Schema.fromJsonString(
	Schema.Struct({
		max_tokens: Schema.Int,
		messages: Schema.Array(Message),
		model: Schema.String,
		stream: Schema.Boolean,
	}),
);

const exited = 0;

const valueOf = (flag: string): Effect.Effect<string, string> =>
	pipe(
		Array.drop(process.argv, runtimeAndScript),
		(args) =>
			pipe(
				Array.findFirstIndex(args, (arg) => arg === flag),
				Option.flatMap((index) => Array.get(args, index + next)),
			),
		Effect.fromOption,
		Effect.mapError(() => `the stand-in claude needs ${flag}`),
	);

const envIn = Effect.fnUntraced(function* envIn(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(file);

	if (!exists) {
		return {};
	}

	const { env = {} } = yield* Effect.flatMap(fs.readFileString(file), Schema.decodeEffect(Settings));

	return env;
});

const settings = Effect.gen(function* settings() {
	const path = yield* Path.Path;
	const user = yield* Config.String("CLAUDE_CONFIG_DIR");
	const project = path.join(process.cwd(), ".claude");

	const files = [
		path.join(user, "settings.json"),
		path.join(project, "settings.json"),
		path.join(project, "settings.local.json"),
	];

	const envs = yield* Effect.forEach(files, envIn, { concurrency: 1 });

	const env = Array.reduce(envs, Record.empty<string, string>(), (merged, each) =>
		Record.union(merged, each, (_before, after) => after),
	);

	return { env };
});

const blocked = 2;

const firstHook = 1;

const hookPassed = Effect.fnUntraced(function* hookPassed(command: string, plugin: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const input = Formatter.formatJson({ cwd: process.cwd(), hook_event_name: "UserPromptSubmit", session_id: session });
	const stdin = Stream.encodeText(Stream.make(input));
	const env = { CLAUDE_PLUGIN_ROOT: plugin };
	const hook = yield* spawner.spawn(ChildProcess.make("sh", ["-c", command], { env, extendEnv: true, stdin }));
	const said = yield* Stream.mkString(Stream.decodeText(hook.stderr));
	const code = yield* hook.exitCode;
	const stopped = Effect.fail(`UserPromptSubmit operation blocked by hook: ${said}`);

	yield* Effect.when(stopped, Effect.succeed(code === blocked));
}, Effect.scoped);

const promptHooksPassed = Effect.gen(function* promptHooksPassed() {
	const fs = yield* FileSystem.FileSystem;
	const plugin = yield* valueOf("--plugin-dir");
	const text = yield* fs.readFileString(`${plugin}/hooks/hooks.json`);
	const { hooks } = yield* Schema.decodeEffect(PromptHooks)(text);

	const first = pipe(
		hooks.UserPromptSubmit,
		Array.flatMap((matcher) => matcher.hooks),
		Array.take(firstHook),
	);

	yield* Effect.forEach(first, ({ command }) => hookPassed(command, plugin), { concurrency: 1, discard: true });
});

const sessionStarted = Effect.fnUntraced(function* sessionStarted() {
	const plugin = yield* valueOf("--plugin-dir");

	yield* sessionStartHooksRan({
		env: { CLAUDE_PLUGIN_ROOT: plugin },
		file: `${plugin}/hooks/hooks.json`,
		input: Formatter.formatJson({ cwd: process.cwd(), hook_event_name: "SessionStart", session_id: session }),
	});
});

const request = Effect.fnUntraced(function* request(env: Readonly<Record<string, string>>) {
	const prompt = yield* valueOf("-p");
	const model = yield* valueOf("--model");
	const login = yield* Config.String("ANTHROPIC_AUTH_TOKEN");
	const message = { content: [{ text: prompt, type: "text" as const }], role: "user" as const };
	const body = yield* Schema.encodeEffect(Body)({ max_tokens: 1024, messages: [message], model, stream: true });

	return HttpClientRequest.post(`${env["ANTHROPIC_BASE_URL"] ?? ""}/v1/messages`).pipe(
		HttpClientRequest.setHeaders({
			"anthropic-version": "2023-06-01",
			authorization: `Bearer ${login}`,
			"x-claude-code-session-id": session,
		}),
		HttpClientRequest.bodyText(body, "application/json"),
	);
});

const settled = "PHI_STAND_IN_SETTLED";

const turn = Effect.gen(function* turn() {
	const client = yield* HttpClient.HttpClient;
	const { env } = yield* settings;

	yield* sessionStarted();
	yield* promptHooksPassed;

	const response = yield* request(env).pipe(Effect.flatMap(client.execute));

	yield* response.text;

	return yield* Effect.filterOrFail(
		Effect.succeed(response.status),
		(status) => status === ok,
		(status) => `the router answered ${String(status)}`,
	);
});

const settledRun = Effect.gen(function* settledRun() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const { env } = yield* settings;
	const again = Struct.assign(env, { [settled]: "1" });
	const args = Array.drop(process.argv, next);

	const code = yield* spawner.exitCode(
		ChildProcess.make(process.execPath, args, { env: again, extendEnv: true, stderr: "inherit", stdout: "inherit" }),
	);

	return yield* Effect.filterOrFail(
		Effect.succeed(code),
		(exitCode) => exitCode === exited,
		(exitCode) => `the stand-in claude exited ${String(exitCode)}`,
	);
});

const program = Effect.gen(function* program() {
	const again = yield* Config.String(settled).pipe(Config.withDefault(""));

	if (again === "") {
		return yield* settledRun;
	}

	return yield* turn;
});

NodeRuntime.runMain(Effect.provide(program, [NodeServices.layer, FetchHttpClient.layer]));
