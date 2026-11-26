import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Config, Effect, FileSystem, Layer, Option, Schema, Stream, Struct } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest } from "#tools/route/mocked-router.ts";
import { canary, session, setUp } from "./hooked.ts";
import { claudeFolders, claudeIn, phiRouter, statusLineOf } from "#tools/claude/configured.ts";
import { NodeServices } from "@effect/platform-node";
import type { World } from "./hooked.ts";
import { freePort } from "#tools/lifecycle/launched.ts";

const patient = { timeout: 120_000 };

const pluginData = "plugins/data/phi-router-phi-router";

const HookCommand = Schema.Struct({ command: Schema.String });

const SessionStart = Schema.Tuple([Schema.Struct({ hooks: Schema.NonEmptyArray(HookCommand) })]);

const Hooks = Schema.fromJsonString(Schema.Struct({ hooks: Schema.Struct({ SessionStart }) }));

const StatusLineInput = Schema.fromJsonString(
	Schema.Struct({
		model: Schema.Struct({ display_name: Schema.String, id: Schema.String }),
		session_id: Schema.String,
	}),
);

type Env = Readonly<Record<string, string>>;

const shell = Effect.fnUntraced(function* shell(command: string, given: { readonly env: Env; readonly input: string }) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const searchPath = yield* Config.String("PATH");
	const stdin = Stream.encodeText(Stream.make(given.input));
	const env = Struct.assign(given.env, { PATH: searchPath });
	const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", command], { env, extendEnv: false, stdin }));
	const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout));
	const exitCode = yield* handle.exitCode;

	return { exitCode: Number(exitCode), stdout };
}, Effect.scoped);

const linkedAtSessionStart = Effect.fnUntraced(function* linkedAtSessionStart(world: World, data: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(`${world.pluginCopy}/hooks/hooks.json`);
	const { hooks } = yield* Schema.decodeEffect(Hooks)(text);

	const [
		{
			hooks: [link],
		},
	] = hooks.SessionStart;

	yield* fs.makeDirectory(data, { recursive: true });

	return yield* shell(link.command, {
		env: { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: world.pluginCopy },
		input: "{}",
	});
});

const turnOn = Effect.fnUntraced(function* turnOn(url: string, text: string) {
	const client = yield* HttpClient.HttpClient;
	const body = yield* bodyOf([{ role: "user", text }]);
	const response = yield* client.execute(HttpClientRequest.prependUrl(claudeRequest({ body, session }), url));

	yield* response.text;
}, Effect.scoped);

const shown = Effect.gen(function* shown() {
	const world = yield* setUp;
	const { dir, env } = yield* claudeFolders;
	const on = yield* phiRouter(claudeIn(dir).on, env);
	const written = yield* statusLineOf(dir);
	const statusLine = yield* Effect.fromOption(Option.fromUndefinedOr(written));
	const linked = yield* linkedAtSessionStart(world, `${dir}/${pluginData}`);
	const deadPort = yield* freePort;
	const routed = Struct.assign(world.folders, { ANTHROPIC_BASE_URL: world.routerUrl, HOME: world.home });
	const deadRouter = Struct.assign(routed, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(deadPort)}` });
	const unrouted = Struct.assign(world.folders, { HOME: world.home });

	const statusLineOn = Effect.fnUntraced(function* statusLineOn(model: string, given: Env) {
		const input = yield* Schema.encodeEffect(StatusLineInput)({
			model: { display_name: model, id: model },
			session_id: session,
		});

		return yield* shell(statusLine.command, { env: given, input });
	});

	const fresh = yield* statusLineOn("phi/auto", routed);

	yield* turnOn(world.routerUrl, `Patient Fakesmith ${canary} called about her refill.`);
	yield* turnOn(world.routerUrl, "Say hi.");

	const lines = yield* Effect.all(
		{
			auto: statusLineOn("phi/auto", routed),
			deadRouter: statusLineOn("phi/auto", deadRouter),
			notJson: shell(statusLine.command, { env: routed, input: "not json" }),
			other: statusLineOn("claude-sonnet-4-5", routed),
			sealed: statusLineOn("phi/sealed", routed),
			unrouted: statusLineOn("phi/auto", unrouted),
		},
		{ concurrency: 1 },
	);

	const nothing = { exitCode: 0, stdout: "" };
	const counted = { exitCode: 0, stdout: "phi · open, model target-under-test · 1 sealed · 2 cleared\n" };

	assert.deepStrictEqual(
		{ fresh, lines, linked, on: on.exitCode },
		{
			fresh: { exitCode: 0, stdout: "phi · none yet · 0 sealed · 0 cleared\n" },
			lines: {
				auto: counted,
				deadRouter: nothing,
				notJson: nothing,
				other: nothing,
				sealed: counted,
				unrouted: nothing,
			},
			linked: nothing,
			on: 0,
		},
	);
}).pipe(Effect.scoped);

it.layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))("the Claude Code status line", (test) => {
	test.effect(
		"the status line on writes runs the plugin through the link its SessionStart hook keeps, and prints this session's counts on phi/auto and phi/sealed and nothing on another model, with no router or with input it cannot read",
		() => shown,
		patient,
	);
});
