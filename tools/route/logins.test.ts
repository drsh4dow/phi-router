import { Array, Effect, FileSystem, Option, Path, String as Str, Struct, pipe } from "effect";
import type { Lifetime, Tokens, Vendor } from "./login-fixture.ts";
import { assert, it } from "@effect/vitest";
import { codexBodyOf, harnesses, userMessage } from "./harnesses.ts";
import { day, dayLong, loggedIn, logins, start, thirtyDays } from "./login-fixture.ts";
import { NodeServices } from "@effect/platform-node";
import type { Script } from "./harnesses.ts";
import type { Sent } from "#router/client/mock-accounts.ts";
import { TestClock } from "effect/testing";
import { routed } from "./mocked-router.ts";

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

type Answering = (vendor: Vendor) => Script;

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
		env: { PATH: login.bin },
		harness: vendor,
		holdsPhi: () => false,
		open: answering(vendor),
		openFolder: login.folder,
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

const resendsOnEachAccount = Effect.gen(function* resendsOnEachAccount() {
	const fs = yield* FileSystem.FileSystem;

	yield* TestClock.setTime(start);

	const open = yield* loggedIn("claude", Struct.assign(dayLong, { standInRuns: sealing }));
	const baa = yield* loggedIn("claude", dayLong);

	const { mocks, post, state } = yield* routed({
		baa: refusesFirst("claude"),
		baaFolder: baa.folder,
		env: { PATH: `${open.bin}:/usr/bin:/bin` },
		holdsPhi: () => false,
		open: refusesFirst("claude"),
		openFolder: open.folder,
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
		"answered 401 twice, once open and once BAA after the resend went sealed, resends to each once",
		() => resendsOnEachAccount,
	);
});
