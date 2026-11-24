import { Array, Config, Effect, Formatter, Option, Schema, Struct, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { sessionStartHooksRan } from "#tools/route/harnesses.ts";

const runtimeAndScript = 2;

const next = 1;

const ok = 200;

const session = "stand-in-session";

/** The `--settings` JSON `doctor claude` passes: its `env` entries, the model address among them. */
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

/** The Messages request Claude Code sends for a one-line `-p` prompt, to the model address of its `--settings`. */
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

/** Set in the environment of the stand-in's second run, which has the settings' `env` in its own. */
const settled = "PHI_STAND_IN_SETTLED";

/** The session as `claude -p` runs it once its settings' `env` is in its environment. */
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

/** The stand-in run again with the `env` of its `--settings` laid over its own environment, as Claude Code lays it. */
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

/**
 * A stand-in for `claude -p` in `check`, which has no real binary. Like Claude Code, it lays the `env` of its
 * `--settings` over its own environment before its first request, by running itself again with it, so Bun's `fetch`
 * takes the proxy and `no_proxy` from there, as Claude Code does. It runs the SessionStart hooks of the plugin
 * `doctor claude` passes, posts one streamed Messages request built from what `doctor claude` passes, reads the whole
 * reply, and exits 0 when the router answered 200.
 */
const program = Effect.gen(function* program() {
	const again = yield* Config.String(settled).pipe(Config.withDefault(""));

	if (again === "") {
		return yield* settledRun;
	}

	return yield* turn;
});

NodeRuntime.runMain(Effect.provide(program, [NodeServices.layer, FetchHttpClient.layer]));
