import { Array, Effect, Option, Struct } from "effect";
import type { Said, Sent } from "#router/client/mock-upstreams/index.ts";
import { assert, it } from "@effect/vitest";
import { dayLong, loggedIn, start, thirtyDays } from "./login-fixture.ts";
import { postedIn, routed } from "./mocked-router.ts";
import { replyMessage, replying, userMessage } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";
import type { VerdictStore } from "#router/client/verdict-store.ts";

const status = { ok: 200, unauthorized: 401, unreadable: 400 } as const;

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

const refusedOn = 3;

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

const sealedOnce =
	(sealed: () => boolean): ((real: VerdictStore["Service"]) => VerdictStore["Service"]) =>
	(real: VerdictStore["Service"]): VerdictStore["Service"] =>
		Struct.assign(real, {
			read: (session: string, policy: string) =>
				Effect.map(real.read(session, policy), (known) => {
					if (!sealed()) {
						return known;
					}

					return Struct.assign(known, { standing: () => "sealed" as const });
				}),
		});

/**
 * Two Codex turns, the second sending reasoning back. On it the open login folder answers 401, then refuses the
 * reasoning once its login is fit again, which seals the session, so the reasoning resend sends sealed to the BAA login folder. Its
 * token expires within 5 minutes, so its login is made fit before its first send, and it answers 401 once.
 */
const resendsAfterRule7 = Effect.gen(function* resendsAfterRule7() {
	yield* TestClock.setTime(start);

	const open = yield* loggedIn("codex", dayLong);
	const baa = yield* loggedIn("codex", { ends: start + thirtyDays, expires: start + minute });
	const opening = inTurn([thinks, unauthorized, unreadable]);

	const { mocks, post } = yield* routed({
		baa: inTurn([unauthorized, answers]).script,
		baaFolder: baa.folder,
		harness: "codex",
		holdsPhi: () => false,
		open: opening.script,
		openFolder: open.folder,
		routerEnv: { PATH: `${open.bin}:/usr/bin:/bin` },
		store: sealedOnce(() => opening.asked() >= refusedOn),
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
			opened: [`Bearer ${first}`, `Bearer ${first}`, `Bearer ${renewed}`],
			ran: "run\nrun\nrun\n",
			sealed: [`Bearer ${renewed}`, `Bearer ${renewed}`],
			second: status.ok,
		},
	);
});

/**
 * An open login folder that answers 401 to every token, and a BAA login folder whose token expires within 5 minutes.
 * The open account spends its one resend and the walk moves on, and the BAA account starts unfit, so its vendor CLI
 * runs before its first send.
 */
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

it.layer(NodeServices.layer)("a login-folder account", (test) => {
	test.effect(
		"reached by the reasoning resend after an open 401, makes its login fit, and answered 401 resends there once",
		() => resendsAfterRule7,
	);
	test.effect(
		"answered 401 twice sends to the next account, whose login is made fit before its first send",
		() => movesOnAfterSecond401,
	);
});
