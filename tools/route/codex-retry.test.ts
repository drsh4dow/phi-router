import { Array, Effect, Option, String as Str, Struct, pipe } from "effect";
import type { Asked, Said } from "#router/client/mock-upstreams/index.ts";
import { assert, it } from "@effect/vitest";
import { codexBodyOf, jsonText, replyMessage, replying, userMessage } from "./harnesses.ts";
import { laneLines, postedIn, routed } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import type { VerdictStore } from "#router/client/verdict-store.ts";
import { handleAt } from "#router/primitives/handle.ts";
import { pinnedByModel } from "./target-models.ts";
import { sealedStub } from "#router/features/border/index.ts";

const firstSequence = 1;

const h1 = handleAt(firstSequence);

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

interface OpenRefusal {
	readonly refusal: string;
	readonly refusesWithoutReasoning: boolean;
}

const openScript =
	(refusing: OpenRefusal) =>
	({ body, last }: Asked): Said => {
		if (Str.includes(blob)(body) || (refusing.refusesWithoutReasoning && Str.includes("Go on.")(last))) {
			return rejected(refusing.refusal);
		}

		if (Str.includes("Think.")(last)) {
			return replying([reasoning, answer]);
		}

		return replying([answer]);
	};

const twoTurns = Effect.fnUntraced(function* twoTurns(refusing: OpenRefusal) {
	const { mocks, post, state } = yield* routed({
		harness: "codex",
		holdsPhi: Str.includes(canary),
		open: openScript(refusing),
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
	const seen = yield* twoTurns({ refusal: unreadableBlob, refusesWithoutReasoning: false });

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
	const seen = yield* twoTurns({ refusal: unreadableBlob, refusesWithoutReasoning: true });

	assert.deepStrictEqual(
		{ answer: seen.answer, blobs: seen.blobs },
		{ answer: { status: status.unreadable, text: unreadableBlob }, blobs: [false, true, false] },
	);
});

const otherRefusal = Effect.gen(function* otherRefusal() {
	const seen = yield* twoTurns({ refusal: tooLong, refusesWithoutReasoning: false });

	assert.deepStrictEqual(
		{ answer: seen.answer, blobs: seen.blobs },
		{ answer: { status: status.unreadable, text: tooLong }, blobs: [false, true] },
	);
});

const nothingToDrop = Effect.gen(function* nothingToDrop() {
	const { mocks, post, state } = yield* routed({
		harness: "codex",
		holdsPhi: Str.includes(canary),
		open: openScript({ refusal: unreadableBlob, refusesWithoutReasoning: true }),
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
	const response = yield* post({ body: pinnedByModel(body), session: "retry-2" });
	const text = yield* response.text;
	const sealed = yield* mocks.baa.received;

	assert.deepStrictEqual(
		{ sealed: sealed.length, status: response.status, text },
		{ sealed: 1, status: status.unreadable, text: unreadableBlob },
	);
});

const openAccount = { refusedReasoning: false };

const refusing = openScript({ refusal: unreadableBlob, refusesWithoutReasoning: false });

const marking = (asked: Asked): Said => {
	openAccount.refusedReasoning ||= Str.includes(blob)(asked.body);

	return refusing(asked);
};

const sealedOnRefusal = (real: VerdictStore["Service"]): VerdictStore["Service"] =>
	Struct.assign(real, {
		read: (session: string, policy: string) =>
			Effect.map(real.read(session, policy), (known) => {
				if (!openAccount.refusedReasoning) {
					return known;
				}

				return Struct.assign(known, { standing: () => "sealed" as const });
			}),
	});

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

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;
	const lines = yield* laneLines(state);
	const stub = yield* jsonText(sealedStub("codex")(h1));

	assert.deepStrictEqual(
		{
			last: Array.last(lines).pipe(Option.map(({ account, lane, reason }) => [account, lane, reason])),
			opened: pipe(
				opened,
				Array.map(({ body }) => ({ asked: Str.includes("Go on.")(body), stubbed: Str.includes(stub)(body) })),
			),
			sealed: sealed.length,
			status: response.status,
		},
		{
			last: Option.some(["open", "clean", "clean"]),
			opened: [
				{ asked: false, stubbed: false },
				{ asked: true, stubbed: false },
				{ asked: false, stubbed: true },
			],
			sealed: none,
			status: status.ok,
		},
	);
});

it.layer(NodeServices.layer)("an open account that cannot read the reasoning", (test) => {
	test.effect("gets the request once more with no reasoning, and the harness gets that answer", () => retried);
	test.effect("refusing twice, the harness gets the second refusal", () => refusedTwice);
	test.effect("with no reasoning to drop, the refusal passes to the harness with no second send", () => nothingToDrop);
	test.effect("another 400 passes to the harness as it came, with no second send", () => otherRefusal);
	test.effect("a BAA account's refusal of a pinned request is never sent again", () => sealedRefusal);
	test.effect(
		"builds the second send from the session as it stands, so a part sealed meanwhile reaches the open account as the stub",
		() => resentSealed,
	);
});
