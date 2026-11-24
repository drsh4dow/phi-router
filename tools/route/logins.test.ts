import { Array, Effect, FileSystem, Option, Path, String as Str, Struct, pipe } from "effect";
import type { Lifetime, Tokens, Vendor } from "./login-fixture.ts";
import { assert, it } from "@effect/vitest";
import { claudeRequest, routed } from "./mocked-router.ts";
import { codexBodyOf, harnesses, userMessage } from "./harnesses.ts";
import { day, dayLong, loggedIn, logins, start, thirtyDays } from "./login-fixture.ts";
import type { AccountScript } from "./harnesses.ts";
import { HttpClientRequest } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { TestClock } from "effect/testing";

const minute = 60_000;

const status = { ok: 200, unauthorized: 401 } as const;

const bodies = {
	claude: Effect.succeed(
		'{"max_tokens":1024,"messages":[{"content":[{"text":"Go on.","type":"text"}],"role":"user"}],"model":"phi/auto","stream":true}',
	),
	codex: codexBodyOf([userMessage("Go on.")]),
};

const sealing = `sed -i 's/"cleared"/"sealed"/g' "$(cat "$(dirname "$0")/state")/sessions/bG9naW5zLWNsYXVkZQ.json"`;

const holding = Effect.fnUntraced(function* holding(roots: readonly string[], tokens: Tokens) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const names = yield* Effect.forEach(
		roots,
		(root) =>
			fs.readDirectory(root, { recursive: true }).pipe(Effect.map(Array.map((name) => path.join(root, name)))),
		{ concurrency: 1 },
	);

	const files = yield* Effect.forEach(
		Array.flatten(names),
		(file) =>
			fs.readFileString(file).pipe(
				Effect.orElseSucceed(() => ""),
				Effect.map((text) => ({ file, text })),
			),
		{ concurrency: 1 },
	);

	return pipe(
		files,
		Array.filter(({ text }) => Str.includes(tokens.first)(text) || Str.includes(tokens.renewed)(text)),
		Array.map(({ file }) => file),
	);
});

const bearersOf = Array.map(({ headers }: Sent) => headers["authorization"]);

type Answering = (vendor: Vendor) => AccountScript;

const answersOk: Answering = (vendor) => () => harnesses[vendor].answersOk.open();

const refusesFirst: Answering = (vendor) => {
	const asked: unknown[] = [];

	return (request) => {
		const first = Array.isReadonlyArrayEmpty(asked);

		asked.push(request);

		if (first) {
			return { body: "{}", kind: "status", status: status.unauthorized };
		}

		return harnesses[vendor].answersOk.open();
	};
};

const through = Effect.fnUntraced(function* through(vendor: Vendor, first: Lifetime, answering: Answering) {
	yield* TestClock.setTime(start);

	const login = yield* loggedIn(vendor, first);

	const { env, mocks, post } = yield* routed({
		harness: vendor,
		holdsPhi: () => false,
		open: answering(vendor),
		openFolder: login.folder,
		routerEnv: { PATH: login.bin },
	});

	const body = yield* bodies[vendor];
	const response = yield* post({ body, session: `logins-${vendor}` });

	yield* response.text;

	const [opened = [], sealed = []] = yield* mocks.accounts;
	const leaked = yield* holding([env.XDG_CONFIG_HOME, env.XDG_STATE_HOME], login.tokens);
	const ran = yield* login.ran;

	return {
		account: pipe(
			opened,
			Array.map(({ headers }) => Option.fromUndefinedOr(headers["chatgpt-account-id"])),
		),
		leaked,
		opened: bearersOf(opened),
		ran,
		sealed: Array.isReadonlyArrayNonEmpty(sealed),
		status: response.status,
		tokens: login.tokens,
	};
});

const nearExpiry = Effect.fnUntraced(function* nearExpiry(vendor: Vendor) {
	const seen = yield* through(vendor, { ends: start + thirtyDays, expires: start + minute }, answersOk);

	assert.deepStrictEqual<unknown>(
		{ account: seen.account, leaked: seen.leaked, opened: seen.opened, ran: seen.ran, status: seen.status },
		{
			account: [logins[vendor].account],
			leaked: [],
			opened: [`Bearer ${seen.tokens.renewed}`],
			ran: "run\n",
			status: status.ok,
		},
	);
});

const afterUnauthorized = Effect.fnUntraced(function* afterUnauthorized(vendor: Vendor) {
	const seen = yield* through(vendor, dayLong, refusesFirst);

	assert.deepStrictEqual<unknown>(
		{ leaked: seen.leaked, opened: seen.opened, ran: seen.ran, status: seen.status },
		{
			leaked: [],
			opened: [`Bearer ${seen.tokens.first}`, `Bearer ${seen.tokens.renewed}`],
			ran: "run\n",
			status: status.ok,
		},
	);
});

const keptToken = Effect.gen(function* keptToken() {
	const seen = yield* through("claude", Struct.assign(dayLong, { standInRuns: "exit 0" }), refusesFirst);

	assert.deepStrictEqual<unknown>(
		{ opened: seen.opened, ran: seen.ran, sealed: seen.sealed, status: seen.status },
		{
			opened: [`Bearer ${seen.tokens.first}`, `Bearer ${seen.tokens.first}`],
			ran: "run\n",
			sealed: false,
			status: status.ok,
		},
	);
});

const ended = Effect.gen(function* ended() {
	const seen = yield* through("claude", { ends: start - day, expires: start + day }, answersOk);

	assert.deepStrictEqual<unknown>(
		{ leaked: seen.leaked, opened: seen.opened, ran: seen.ran, sealed: seen.sealed, status: seen.status },
		{ leaked: [], opened: [], ran: "", sealed: true, status: status.ok },
	);
});

const twoAtOnce = Effect.gen(function* twoAtOnce() {
	yield* TestClock.setTime(start);

	const login = yield* loggedIn("claude", {
		ends: start + thirtyDays,
		expires: start + minute,
		standInRuns: "sleep 1",
	});

	const { mocks, post } = yield* routed({
		holdsPhi: () => false,
		open: answersOk("claude"),
		openFolder: login.folder,
		routerEnv: { PATH: `${login.bin}:/usr/bin:/bin` },
	});

	const body = yield* bodies.claude;

	const statuses = yield* Effect.forEach(
		["logins-first", "logins-second"],
		(session) => Effect.flatMap(post({ body, session }), (response) => Effect.as(response.text, response.status)),
		{ concurrency: "unbounded" },
	);

	const [opened = []] = yield* mocks.accounts;
	const renewed = `Bearer ${login.tokens.renewed}`;

	assert.deepStrictEqual<unknown>(
		{ opened: bearersOf(opened), ran: yield* login.ran, statuses },
		{ opened: [renewed, renewed], ran: "run\n", statuses: [status.ok, status.ok] },
	);
});

const harnessKey = Effect.gen(function* harnessKey() {
	yield* TestClock.setTime(start);

	const login = yield* loggedIn("claude", dayLong);
	const { client, mocks } = yield* routed({ holdsPhi: () => false, openFolder: login.folder });
	const body = yield* bodies.claude;
	const request = claudeRequest({ body, session: "logins-harness-key" });
	const response = yield* client.execute(HttpClientRequest.setHeader(request, "x-api-key", "phi-test-harness-key"));

	yield* response.text;

	const [opened = []] = yield* mocks.accounts;

	assert.deepStrictEqual<unknown>(
		pipe(
			opened,
			Array.map(({ headers }) => [headers["authorization"], Option.fromUndefinedOr(headers["x-api-key"])]),
		),
		[[`Bearer ${login.tokens.first}`, Option.none()]],
	);
});

const resendsOnEachAccount = Effect.gen(function* resendsOnEachAccount() {
	const fs = yield* FileSystem.FileSystem;

	yield* TestClock.setTime(start);

	const open = yield* loggedIn("claude", Struct.assign(dayLong, { standInRuns: sealing }));
	const baa = yield* loggedIn("claude", dayLong);

	const { mocks, post, state } = yield* routed({
		baa: refusesFirst("claude"),
		baaFolder: baa.folder,
		holdsPhi: () => false,
		open: refusesFirst("claude"),
		openFolder: open.folder,
		routerEnv: { PATH: `${open.bin}:/usr/bin:/bin` },
	});

	yield* fs.writeFileString(`${open.bin}/state`, state);

	const response = yield* bodies.claude.pipe(Effect.flatMap((body) => post({ body, session: "logins-claude" })));
	const [opened = [], sealed = []] = yield* mocks.accounts;
	const resent = [`Bearer ${baa.tokens.first}`, `Bearer ${baa.tokens.renewed}`];

	assert.deepStrictEqual<unknown>(
		[response.status, bearersOf(opened), bearersOf(sealed)],
		[status.ok, [`Bearer ${open.tokens.first}`], resent],
	);
});

it.layer(NodeServices.layer)("a login-folder account", (test) => {
	test.effect.each(["claude", "codex"] as const)(
		"of %s whose token expires within 5 minutes runs the vendor CLI once and sends the new token",
		nearExpiry,
	);
	test.effect.each(["claude", "codex"] as const)(
		"of %s answered 401 reads the folder again, runs the vendor CLI once and resends with the new token",
		afterUnauthorized,
	);
	test.effect(
		"of claude answered 401 once, whose CLI leaves the token as it was, resends that token once to the same account",
		() => keptToken,
	);
	test.effect("of claude whose login ended sends the request to the next account and runs nothing", () => ended);
	test.effect(
		"of claude whose token expires within 5 minutes runs the vendor CLI once for two requests at once",
		() => twoAtOnce,
	);
	test.effect("of claude sends its own token and never the harness's x-api-key", () => harnessKey);
	test.effect(
		"answered 401 twice, once open and once BAA after the resend went sealed, resends to each once",
		() => resendsOnEachAccount,
	);
});
