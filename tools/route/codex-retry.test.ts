import { Array, Effect, Option, String as Str, Struct, pipe } from "effect";
import type { Asked, Said } from "#router/client/mock-accounts.ts";
import { assert, it } from "@effect/vitest";
import { codexBodyOf, replyMessage, replying, userMessage } from "./harnesses.ts";
import { laneLines, postedIn, routed } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import type { VerdictStore } from "#router/client/verdict-store.ts";

const canary = "PATIENT-CANARY-2W6N";

const status = { ok: 200, unreadable: 400 } as const;

const none = 0;

const blob = "gAAAAABretry-reasoning-blob-0001";

const reasoning = { encrypted_content: blob, id: "rs_retry", summary: [], type: "reasoning" } as const;

const answer = replyMessage({ id: "msg_retry", text: "ok" });

const unreadableBlob =
	'{"error":{"code":"invalid_encrypted_content","message":"The encrypted content could not be verified.","type":"invalid_request_error"}}';

const tooLong = '{"error":{"code":"context_length_exceeded","message":"Too long.","type":"invalid_request_error"}}';

const rejected = (body: string): Said => ({ body, kind: "status", status: status.unreadable });

/** What the open account refuses a body with the blob with, and whether it refuses the one without as well. */
interface Script {
	readonly toBlob: string;
	readonly again: boolean;
}

/**
 * The open account: a reply with reasoning to "Think.", then `toBlob` to a body that carries the reasoning, and to the
 * follow-up with none either `ok` or, when `again` holds, the same refusal.
 *
 * @param {Script} script What it refuses with.
 * @returns {Function} The script.
 */
const openScript =
	(script: Script) =>
	({ body, last }: Asked): Said => {
		if (Str.includes(blob)(body) || (script.again && Str.includes("Go on.")(last))) {
			return rejected(script.toBlob);
		}

		if (Str.includes("Think.")(last)) {
			return replying([reasoning, answer]);
		}

		return replying([answer]);
	};

/**
 * Two turns of one session through a router whose open account answers by `script`: the first writes the reasoning,
 * the second sends it back. Returns the second answer, which bodies reached the open account with the blob, and the
 * lane log's lanes.
 */
const twoTurns = Effect.fnUntraced(function* twoTurns(script: Script) {
	const { mocks, post, state } = yield* routed({
		harness: "codex",
		holdsPhi: Str.includes(canary),
		open: openScript(script),
	});

	yield* postedIn(post, "retry-1", [userMessage("Think.")]);

	const second = yield* codexBodyOf([userMessage("Think."), reasoning, answer, userMessage("Go on.")]);

	const response = yield* post({ body: second, session: "retry-1" });
	const text = yield* response.text;
	const opened = yield* mocks.open.received;
	const lines = yield* laneLines(state);

	return {
		answer: { status: response.status, text },
		blobs: pipe(
			opened,
			Array.map((sent) => Str.includes(blob)(sent.body)),
		),
		judged: pipe(
			lines,
			Array.map(({ judgeCost, judgeFailures }) => [judgeCost > none, judgeFailures]),
		),
		lanes: pipe(
			lines,
			Array.map(({ lane }) => lane),
		),
	};
});

const retried = Effect.gen(function* retried() {
	const seen = yield* twoTurns({ again: false, toBlob: unreadableBlob });

	assert.deepStrictEqual(
		{ blobs: seen.blobs, judged: seen.judged, lanes: seen.lanes, status: seen.answer.status },
		{
			blobs: [false, true, false],
			judged: [
				[true, none],
				[true, none],
			],
			lanes: ["clean", "clean"],
			status: status.ok,
		},
	);
});

const refusedTwice = Effect.gen(function* refusedTwice() {
	const seen = yield* twoTurns({ again: true, toBlob: unreadableBlob });

	assert.deepStrictEqual(
		{ answer: seen.answer, blobs: seen.blobs },
		{ answer: { status: status.unreadable, text: unreadableBlob }, blobs: [false, true, false] },
	);
});

const otherRefusal = Effect.gen(function* otherRefusal() {
	const seen = yield* twoTurns({ again: false, toBlob: tooLong });

	assert.deepStrictEqual(
		{ answer: seen.answer, blobs: seen.blobs },
		{ answer: { status: status.unreadable, text: tooLong }, blobs: [false, true] },
	);
});

const nothingToDrop = Effect.gen(function* nothingToDrop() {
	const { mocks, post, state } = yield* routed({
		harness: "codex",
		holdsPhi: Str.includes(canary),
		open: openScript({ again: true, toBlob: unreadableBlob }),
	});

	const body = yield* codexBodyOf([userMessage("Go on.")]);
	const response = yield* post({ body, session: "retry-3" });
	const text = yield* response.text;
	const opened = yield* mocks.open.received;
	const lines = yield* laneLines(state);

	assert.deepStrictEqual(
		{ lines: lines.length, opened: opened.length, status: response.status, text },
		{ lines: 1, opened: 1, status: status.unreadable, text: unreadableBlob },
	);
});

const sealedRefusal = Effect.gen(function* sealedRefusal() {
	const { mocks, post } = yield* routed({
		baa: () => rejected(unreadableBlob),
		harness: "codex",
		holdsPhi: Str.includes(canary),
	});

	const body = yield* codexBodyOf([userMessage(`Member ${canary} called.`)]);
	const response = yield* post({ body, session: "retry-2" });
	const text = yield* response.text;
	const sealed = yield* mocks.baa.received;

	assert.deepStrictEqual(
		{ sealed: sealed.length, status: response.status, text },
		{ sealed: 1, status: status.unreadable, text: unreadableBlob },
	);
});

/** Whether the open account has refused a body with the reasoning, after which the store reads every part sealed. */
const refused = { blob: false };

const refusing = openScript({ again: false, toBlob: unreadableBlob });

/**
 * The open account, which marks that it refused the reasoning.
 *
 * @param {Asked} asked What it was asked.
 * @returns {Said} What it says.
 */
const marking = (asked: Asked): Said => {
	refused.blob ||= Str.includes(blob)(asked.body);

	return refusing(asked);
};

/**
 * The router's store, but every part reads sealed once the open account refused the reasoning.
 *
 * @param {VerdictStore["Service"]} real The router's store.
 * @returns {VerdictStore["Service"]} The store.
 */
const sealedOnRefusal = (real: VerdictStore["Service"]): VerdictStore["Service"] =>
	Struct.assign(real, {
		read: (session: string, policy: string) =>
			Effect.map(real.read(session, policy), (known) => {
				if (!refused.blob) {
					return known;
				}

				return Struct.assign(known, { standing: () => "sealed" as const });
			}),
	});

/**
 * The session's parts are sealed while the open account refuses the reasoning, so the second send goes sealed to the BAA
 * account, which answers, and the line names it.
 */
const resentSealed = Effect.gen(function* resentSealed() {
	const { mocks, post, state } = yield* routed({
		harness: "codex",
		holdsPhi: () => false,
		open: marking,
		store: sealedOnRefusal,
	});

	yield* postedIn(post, "retry-4", [userMessage("Think.")]);

	const second = yield* codexBodyOf([userMessage("Think."), reasoning, answer, userMessage("Go on.")]);
	const response = yield* post({ body: second, session: "retry-4" });

	yield* response.text;

	const sealed = yield* mocks.baa.received;
	const lines = yield* laneLines(state);
	assert.deepStrictEqual(
		{
			last: Array.last(lines).pipe(Option.map(({ account, lane, reason }) => [account, lane, reason])),
			sealed: sealed.length,
			status: response.status,
		},
		{ last: Option.some(["baa", "sealed", "failover"]), sealed: 1, status: status.ok },
	);
});

it.layer(NodeServices.layer)("an open account that cannot read the reasoning", (test) => {
	test.effect("gets the request once more with no reasoning, and the harness gets that answer", () => retried);
	test.effect("refusing twice, the harness gets the second refusal", () => refusedTwice);
	test.effect("with no reasoning to drop, the refusal passes to the harness with no second send", () => nothingToDrop);
	test.effect("another 400 passes to the harness as it came, with no second send", () => otherRefusal);
	test.effect("a BAA account's refusal is never sent again", () => sealedRefusal);
	test.effect("gets the second send on the BAA account when the session is sealed meanwhile", () => resentSealed);
});
