import { Array, Effect, FileSystem, Layer, Predicate, Schema, Struct, pipe } from "effect";
import { ConfigFile, JsonText, leaks, phiRouter, prepared, tokens } from "./accounts-run.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest, mocked } from "#tools/route/mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import type { Said } from "#router/client/mock-upstreams/index.ts";
import { harnesses } from "#tools/route/harnesses.ts";
import { routerProcess } from "#tools/route/router-process.ts";

const secondMock = 1;

const exited = 0;

const sessionId = "added-1";

const Named = Schema.Array(Schema.Struct({ name: Schema.String }));

/** The clean lane of what `status` prints. */
const PrintedStatus = Schema.fromJsonString(Schema.Struct({ accounts: Schema.Struct({ clean: Named }) }));

const limited = (): Said => ({ body: "{}", kind: "status", status: 429 });

const ok = harnesses.claude.answersOk.open;

type Entry = (typeof ConfigFile.Type)["clean"][number];

/** Rewrites the config file's clean lane, keeping each entry `kept` keeps, as `edit` returns it, as no add does. */
const edited = Effect.fnUntraced(function* edited(
	file: string,
	edit: { readonly name: string; readonly kept: boolean; readonly endpoint?: string },
) {
	const fs = yield* FileSystem.FileSystem;
	const written = yield* Effect.flatMap(fs.readFileString(file), Schema.decodeEffect(ConfigFile));

	const clean = pipe(
		written.clean,
		Array.filter((entry) => entry["name"] !== edit.name || edit.kept),
		Array.map((entry): Entry => {
			if (entry["name"] !== edit.name || Predicate.isUndefined(edit.endpoint)) {
				return entry;
			}

			return Struct.assign(entry, { endpoint: edit.endpoint });
		}),
	);

	const text = yield* Schema.encodeEffect(JsonText)(Struct.assign(written, { clean }));

	yield* fs.writeFileString(file, text);
});

const posted = Effect.fnUntraced(function* posted(url: string, session: string) {
	const client = yield* HttpClient.HttpClient;
	const body = yield* bodyOf([{ role: "user", text: "Go on." }]);
	const response = yield* client.execute(HttpClientRequest.prependUrl(url)(claudeRequest({ body, session })));

	yield* response.text;

	return response.status;
}, Effect.scoped);

const cleanLane = Effect.fnUntraced(function* cleanLane(
	env: Readonly<Record<string, string>>,
	asked: readonly string[],
) {
	const printed = yield* phiRouter(env, ["status", ...asked]);
	const status = yield* Schema.decodeEffect(PrintedStatus)(printed.stdout);

	return pipe(
		status.accounts.clean,
		Array.map(({ name }) => name),
	);
});

/**
 * A router serving one open account, which answers 429, and the second open mock, which no account names yet, with a
 * login folder and a token command for `accounts add`.
 */
const running = Effect.gen(function* running() {
	const { env, mocks } = yield* mocked({ holdsPhi: () => false, opens: [limited, ok] });

	const routerEnv = Struct.assign(env, { TZ: "UTC" });
	const file = `${env.XDG_CONFIG_HOME}/phi-router/config.json`;
	const second = yield* Effect.fromOption(pipe(mocks.opens, Array.get(secondMock)));

	yield* edited(file, { kept: false, name: "open-2" });

	const router = yield* routerProcess(["bun", "src/router/main.ts"], routerEnv);
	const { commands, folders } = yield* prepared("claudeOnly");

	return {
		asked: ["--session", sessionId, "--port", new URL(router.url).port],
		env: routerEnv,
		file,
		logins: { command: ["--command", commands.token], folder: [folders.claude] },
		roots: [env.XDG_CONFIG_HOME, env.XDG_STATE_HOME],
		second,
		url: router.url,
	};
});

const ways = [
	{
		added: "Claude login folder. Its login ends 2100-01-01. claude refreshes it.",
		login: "folder",
		sent: `Bearer ${tokens.claudeFolder}`,
		way: "a login folder",
	},
	{
		added: `Claude token, ${String(tokens.command.length)} characters. Lasts 1 year. Needs no refresh.`,
		login: "command",
		sent: `Bearer ${tokens.command}`,
		way: "a token command",
	},
] as const;

const servedAtOnce = Effect.fnUntraced(function* servedAtOnce(way: (typeof ways)[number]) {
	const router = yield* running;
	const before = yield* cleanLane(router.env, router.asked);
	const beforeStatus = yield* posted(router.url, sessionId);
	const added = yield* phiRouter(router.env, ["accounts", "add", ...router.logins[way.login]]);
	const listed = yield* cleanLane(router.env, router.asked);

	yield* edited(router.file, { endpoint: router.second.endpoint, kept: true, name: "claude-1" });

	const afterStatus = yield* posted(router.url, sessionId);
	const onSecond = yield* router.second.received;
	const leaked = yield* leaks(router.roots, [added.stdout, added.stderr]);

	assert.deepStrictEqual<unknown>(
		{
			added: [added.exitCode, added.stdout],
			afterStatus,
			before,
			beforeStatus,
			leaked,
			listed,
			second: pipe(
				onSecond,
				Array.map(({ headers }) => headers["authorization"]),
			),
		},
		{
			added: [
				exited,
				`Added claude-1 to the clean lane, after open.\n  ${way.added}\nA running router serves it from its next request.\n`,
			],
			afterStatus: 200,
			before: ["open"],
			beforeStatus: 200,
			leaked: [],
			listed: ["open", "claude-1"],
			second: [way.sent],
		},
	);
}, Effect.scoped);

const unservable = Effect.gen(function* unservable() {
	const router = yield* running;

	yield* edited(router.file, { kept: false, name: "open" });

	const status = yield* posted(router.url, sessionId);
	const listed = yield* cleanLane(router.env, router.asked);

	assert.deepStrictEqual({ listed, status }, { listed: ["open"], status: 200 });
}).pipe(Effect.scoped);

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("a running router", (test) => {
	test.effect.each(ways)(
		"serves an account accounts add writes by $way at once: status lists it, and the next request after the home account's 429 reaches it",
		servedAtOnce,
		{ timeout: 60_000 },
	);
	test.effect("keeps the accounts it serves when config.json changes to a file it cannot serve", () => unservable, {
		timeout: 60_000,
	});
});
