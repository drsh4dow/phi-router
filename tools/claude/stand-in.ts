import { Array, Config, Effect, Formatter, Option, Schema, Struct, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { sessionStartHooksRan } from "#tools/route/harnesses.ts";

const runtimeAndScript = 2;

const next = 1;

const ok = 200;

const session = "stand-in-session";

const Settings = Schema.fromJsonString(Schema.Struct({ env: Schema.Record(Schema.String, Schema.String) }));

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

const settings = valueOf("--settings").pipe(Effect.flatMap(Schema.decodeEffect(Settings)));

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
