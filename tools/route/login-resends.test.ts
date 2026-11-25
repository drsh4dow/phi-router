import { Array, Effect, FileSystem, Logger, Option, String as Str, Struct } from "effect";
import type { Said, Sent } from "#router/client/mock-upstreams/index.ts";
import { assert, it } from "@effect/vitest";
import { dayLong, loggedIn, logins, start, thirtyDays, warnings } from "./login-fixture.ts";
import { postedIn, routed } from "./mocked-router.ts";
import { replyMessage, replying, userMessage } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";
import { pinnedByModel } from "./target-models.ts";

const status = { ok: 200, rateLimited: 429, refused: 502, unauthorized: 401, unreadable: 400 } as const;

const minute = 60_000;

const claudeBody =
	'{"max_tokens":1024,"messages":[{"content":[{"text":"Go on.","type":"text"}],"role":"user"}],"model":"phi/auto","stream":true}';

const reasoning = {
	encrypted_content: "gAAAAABlogins-reasoning",
	id: "rs_logins",
	summary: [],
	type: "reasoning",
} as const;

const answer = replyMessage({ id: "msg_logins", text: "ok" });

const unauthorized = (): Said => ({ body: "{}", kind: "status", status: status.unauthorized });

const unreadable = (): Said => ({
	body: '{"error":{"code":"invalid_encrypted_content","message":"The encrypted content could not be verified.","type":"invalid_request_error"}}',
	kind: "status",
	status: status.unreadable,
});

const refusedFirst = 2;

const limited = (): Said => ({ body: "{}", kind: "status", status: status.rateLimited });

const thinks = (): Said => replying([reasoning, answer]);

const answers = (): Said => replying([answer]);

const bearersOf = Array.map(({ headers }: Sent) => headers["authorization"]);

interface InTurn {
	readonly asked: () => number;
	readonly script: () => Said;
}

const inTurn = (turns: readonly [() => Said, ...(() => Said)[]]): InTurn => {
	const asks = { count: 0 };

	return {
		asked: () => asks.count,
		script: () => {
			const said = Array.get(turns, asks.count);

			asks.count += 1;

			return Option.getOrElse(said, () => Array.lastNonEmpty(turns))();
		},
	};
};

const resendsAfterRule7 = Effect.gen(function* resendsAfterRule7() {
	yield* TestClock.setTime(start);

	const open = yield* loggedIn("codex", dayLong);
	const baa = yield* loggedIn("codex", { ends: start + thirtyDays, expires: start + minute });
	const opening = inTurn([thinks, unauthorized, unreadable, limited]);

	const { mocks, post } = yield* routed({
		baa: inTurn([unauthorized, answers]).script,
		baaFolder: baa.folder,
		harness: "codex",
		holdsPhi: () => false,
		open: opening.script,
		openFolder: open.folder,
		routerEnv: { PATH: `${open.bin}:/usr/bin:/bin` },
	});

	yield* postedIn(post, "logins-codex", [userMessage("Think.")]);

	const second = yield* postedIn(post, "logins-codex", [
		userMessage("Think."),
		reasoning,
		answer,
		userMessage("Go on."),
	]);

	const [opened = [], sealed = []] = yield* mocks.accounts;
	const { first, renewed } = open.tokens;

	assert.deepStrictEqual<unknown>(
		{ opened: bearersOf(opened), ran: yield* open.ran, sealed: bearersOf(sealed), second },
		{
			opened: [`Bearer ${first}`, `Bearer ${first}`, `Bearer ${renewed}`, `Bearer ${renewed}`],
			ran: "run\nrun\nrun\n",
			sealed: [`Bearer ${renewed}`, `Bearer ${renewed}`],
			second: status.ok,
		},
	);
});

const movesOnAfterSecond401 = Effect.gen(function* movesOnAfterSecond401() {
	yield* TestClock.setTime(start);

	const open = yield* loggedIn("claude", dayLong);
	const baa = yield* loggedIn("claude", { ends: start + thirtyDays, expires: start + minute });

	const { mocks, post } = yield* routed({
		baa: answers,
		baaFolder: baa.folder,
		holdsPhi: () => false,
		open: unauthorized,
		openFolder: open.folder,
		routerEnv: { PATH: `${open.bin}:/usr/bin:/bin` },
	});

	const response = yield* post({ body: claudeBody, session: "logins-claude" });

	yield* response.text;

	const [opened = [], sealed = []] = yield* mocks.accounts;
	const { first, renewed } = open.tokens;

	assert.deepStrictEqual<unknown>(
		{ opened: bearersOf(opened), ran: yield* open.ran, sealed: bearersOf(sealed), status: response.status },
		{
			opened: [`Bearer ${first}`, `Bearer ${renewed}`],
			ran: "run\nrun\n",
			sealed: [`Bearer ${baa.tokens.renewed}`],
			status: status.ok,
		},
	);
});

const endedBeforeResend = Effect.gen(function* endedBeforeResend() {
	const fs = yield* FileSystem.FileSystem;

	yield* TestClock.setTime(start);

	const open = yield* loggedIn("codex", dayLong);
	const opening = inTurn([thinks, unreadable]);
	const endLogin = Effect.orDie(fs.writeFileString(`${open.folder}/${logins.codex.file}`, "{}"));

	const ending = Effect.when(
		endLogin,
		Effect.sync(() => opening.asked() >= refusedFirst),
	);

	const warned = warnings();

	const { mocks, post } = yield* routed({
		harness: "codex",
		holdsPhi: () => false,
		open: opening.script,
		openFolder: open.folder,
		store: (real) =>
			Struct.assign(real, {
				read: (session: string, policy: string) => Effect.andThen(ending, real.read(session, policy)),
			}),
	}).pipe(Effect.provideService(Logger.CurrentLoggers, warned.loggers));

	yield* postedIn(post, "logins-ended", [userMessage("Think.")]);

	const second = yield* postedIn(post, "logins-ended", [
		userMessage("Think."),
		reasoning,
		answer,
		userMessage("Go on."),
	]);

	const [opened = [], sealed = []] = yield* mocks.accounts;

	assert.deepStrictEqual<unknown>(
		{ opened: opened.length, sealed: sealed.length, second, warnings: warned.said },
		{
			opened: refusedFirst,
			sealed: 1,
			second: status.ok,
			warnings: [[`phi-router: open's login ended. Fix: CODEX_HOME=${open.folder} codex login`]],
		},
	);
});

const lastRefusedTwice = Effect.gen(function* lastRefusedTwice() {
	yield* TestClock.setTime(start);

	const baa = yield* loggedIn("claude", dayLong);

	const { mocks, post } = yield* routed({
		baa: unauthorized,
		baaFolder: baa.folder,
		holdsPhi: () => false,
		routerEnv: { PATH: `${baa.bin}:/usr/bin:/bin` },
	});

	const response = yield* post({ body: pinnedByModel(claudeBody), session: "logins-claude" });
	const text = yield* response.text;
	const [opened = [], sealed = []] = yield* mocks.accounts;

	assert.deepStrictEqual(
		{
			named: Str.includes("account baa ")(text),
			opened: opened.length,
			sealed: sealed.length,
			status: response.status,
		},
		{ named: true, opened: 0, sealed: 2, status: status.refused },
	);
});

it.layer(NodeServices.layer)("a login-folder account", (test) => {
	test.effect(
		"reached by overflow when the reasoning resend after an open 401 gets 429, makes its login fit before its first send, and answered 401 resends there once",
		() => resendsAfterRule7,
	);
	test.effect(
		"answered 401 twice sends to the next account, whose login is made fit before its first send",
		() => movesOnAfterSecond401,
	);
	test.effect(
		"of codex whose login ends before the reasoning resend sends the request to the next account and warns with the command that fixes it",
		() => endedBeforeResend,
	);
	test.effect(
		"as the last BAA account answered 401 twice to a pinned request, gets 502 naming that account",
		() => lastRefusedTwice,
	);
});
