import { Array, Effect, Layer, Path, Schema, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest, fakes, mocked } from "#tools/route/mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import type { Turn } from "#tools/route/mocked-router.ts";
import { routerProcess } from "#tools/route/router-process.ts";

const clean = 0;

const bundle = "plugins/claude/phi-router.mjs";

const patient = { timeout: 60_000 };

const run = Effect.fn("run")(function* run(
	env: Readonly<Record<string, string>>,
	command: string,
	args: readonly string[],
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const cwd = path.resolve(import.meta.dirname, "../..");
	const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd, env, extendEnv: true }));
	const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout));
	const stderr = yield* Stream.mkString(Stream.decodeText(handle.stderr));
	const exitCode = yield* handle.exitCode;

	return { exitCode, stderr, stdout };
}, Effect.scoped);

const ran = Effect.fn("ran")(function* ran(
	env: Readonly<Record<string, string>>,
	command: string,
	args: readonly string[],
) {
	const { exitCode, stderr, stdout } = yield* run(env, command, args);

	assert.strictEqual(exitCode, clean, `${command} ${Array.join(args, " ")} printed ${stdout}${stderr}`);

	return stdout;
});

const ok = 200;

const markers = ["RESTART-FIRST", "RESTART-SECOND", "RESTART-THIRD"] as const;

const [first, second, third] = markers;

const reply: Turn = { role: "assistant", text: "ok" };

const opening: readonly Turn[] = [{ role: "user", text: `${first}: list the build steps.` }];

const followed: readonly Turn[] = [...opening, reply, { role: "user", text: `${second}: now the tests.` }];

const after: readonly Turn[] = [...followed, reply, { role: "user", text: `${third}: and the release.` }];

const posted = Effect.fn("posted")(function* posted(url: string, sent: readonly Turn[]) {
	const client = yield* HttpClient.HttpClient;
	const body = yield* bodyOf(sent);
	const request = HttpClientRequest.prependUrl(url)(claudeRequest({ body, session: "restart-1" }));
	const response = yield* client.execute(request);

	yield* response.text;

	return response.status;
});

const judgedText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const markedIn = Effect.fn("markedIn")(function* markedIn(received: readonly { readonly body: unknown }[]) {
	const texts = yield* Effect.forEach(received, ({ body }) => judgedText(body), { concurrency: 1 });

	return pipe(
		markers,
		Array.filter((marker) =>
			pipe(
				texts,
				Array.some((text) => Str.includes(marker)(text)),
			),
		),
	);
});

const command = (name: string, url: string): readonly string[] => [
	bundle,
	name,
	"--session",
	"restart-1",
	"--port",
	new URL(url).port,
];

const statusAcross = Effect.fn("statusAcross")(function* statusAcross(
	runtime: string,
	env: Readonly<Record<string, string>>,
) {
	const killed = yield* Effect.scoped(
		Effect.gen(function* firstRouter() {
			const router = yield* routerProcess([runtime, bundle], env);

			yield* posted(router.url, opening);

			const status = yield* ran(env, runtime, command("status", router.url));

			yield* router.kill;

			const unanswered = yield* run(env, runtime, command("status", router.url));
			const named = Str.includes("no router answers there")(`${unanswered.stdout}${unanswered.stderr}`);

			return { status, unanswered: { exitCode: unanswered.exitCode, named } };
		}),
	);

	const restartedRouter = yield* Effect.scoped(
		Effect.flatMap(routerProcess([runtime, bundle], env), (router) =>
			ran(env, runtime, command("status", router.url)),
		),
	);

	return { killed, restartedRouter };
});

const accounts = '{"clean":[{"name":"open","vendor":"anthropic"}],"sealed":[{"name":"baa","vendor":"anthropic"}]}';

const statusLine = `{"accounts":${accounts},"cleared":2,"last":{"account":"open","model":"${fakes.targetModel}","substitute":false},"overflowed":0,"pinned":{"cleared":[],"gaveUp":0,"rewrites":0,"runs":0,"withheld":[]},"sealed":0,"session":"restart-1"}\n`;

const statusAcrossKill = {
	killed: { status: statusLine, unanswered: { exitCode: 1, named: true } },
	restartedRouter: statusLine,
};

const beforeKill = Effect.fn("beforeKill")(function* beforeKill(
	runtime: string,
	env: Readonly<Record<string, string>>,
) {
	const client = yield* HttpClient.HttpClient;
	const router = yield* routerProcess([runtime, bundle], env);
	const statuses = yield* Effect.forEach([opening, followed], (sent) => posted(router.url, sent), { concurrency: 1 });
	const hello = yield* client.execute(HttpClientRequest.head(`${router.url}/api/hello`));

	yield* router.kill;

	return [...statuses, hello.status];
}, Effect.scoped);

const restarted = Effect.fn("restarted")(function* restarted(runtime: string) {
	const { env, mocks } = yield* mocked({ holdsPhi: () => false });

	const statuses = yield* beforeKill(runtime, env);
	const judgedBefore = yield* mocks.judge.received;
	const restartedRouter = routerProcess([runtime, bundle], env);

	const status = yield* restartedRouter.pipe(
		Effect.flatMap(({ url }) => posted(url, after)),
		Effect.scoped,
	);

	const judgedAll = yield* mocks.judge.received;
	const markedBefore = yield* markedIn(judgedBefore);
	const markedAfter = yield* markedIn(Array.drop(judgedAll, judgedBefore.length));

	assert.deepStrictEqual(
		{ markedAfter, markedBefore, status, statuses },
		{ markedAfter: [third], markedBefore: [first, second], status: ok, statuses: [ok, ok, ok] },
	);
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("the committed bundle", (test) => {
	test.effect.each(["bun", "node"])(
		"started with %s, names its platform layer, and status reaches the router across a SIGKILL",
		(runtime) =>
			Effect.gen(function* entry() {
				const { env } = yield* mocked({ holdsPhi: () => false });
				const bare = yield* ran(env, runtime, [bundle]);
				const seen = yield* statusAcross(runtime, env);

				assert.deepStrictEqual(
					{ bare, seen },
					{ bare: `phi-router runs on the ${runtime} platform layer\n`, seen: statusAcrossKill },
				);
			}),
		patient,
	);

	test.effect.each(["bun", "node"])(
		"serving with %s, keeps the session's verdicts across a SIGKILL and judges only new parts after it",
		(runtime) => restarted(runtime),
		patient,
	);
});
