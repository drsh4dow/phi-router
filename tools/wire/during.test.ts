import { Array, Effect, Ref, String as Str } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { claudeJudgeCheck, during, judgeCallsApart, withCredentialRule } from "./during.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { fakes } from "#tools/route/fake-credentials.ts";

const posted = (body: string, key: string): Sent => ({
	body,
	headers: { "x-api-key": key },
	method: "POST",
	path: "/v1/messages",
	query: "",
});

const modelRequest = (prompt: string): Sent =>
	posted(`{"model":"target-under-test","messages":[{"role":"user","content":"${prompt}"}]}`, fakes.baaKey);

const judgeCall = (piece: string, key: string): Sent =>
	posted(
		`{"messages":[{"role":"user","content":[{"type":"text","text":"{\\"piece\\":\\"${piece}\\"}"}]}],"tool_choice":{"name":"identifier","type":"tool"}}`,
		key,
	);

const printedTailLength = 400;

const passing = { name: "a check of the play", ok: true };

const verdicts = Array.map(({ ok }: { readonly ok: boolean }) => ok);

const oneRun = Effect.gen(function* oneRun() {
	const earlier = { baa: modelRequest("earlier"), open: modelRequest("earlier open") };
	const now = { baa: modelRequest("now"), open: modelRequest("now open") };
	const tail = Str.repeat(printedTailLength)("z");

	const mocks = yield* Ref.make<readonly [readonly Sent[], readonly Sent[], readonly string[]]>([
		[earlier.open],
		[earlier.baa],
		["earlier piece"],
	]);

	const ran = yield* during(
		() => Ref.get(mocks),
		() =>
			Ref.set(mocks, [
				[earlier.open, now.open],
				[earlier.baa, now.baa],
				["earlier piece", "first piece", "second piece"],
			]).pipe(Effect.as({ printed: `${Str.repeat(printedTailLength)("a")}${tail}` })),
	);

	assert.deepStrictEqual(
		{ baa: ran.baa, open: ran.open, piecesJudged: ran.piecesJudged, printedTail: ran.printedTail },
		{ baa: [now.baa], open: [now.open], piecesJudged: 2, printedTail: tail },
	);
});

const credentialRule = Effect.gen(function* credentialRule() {
	const breached = yield* withCredentialRule([passing], () =>
		Effect.succeed(["the open mock received the baa credential"]),
	);

	const kept = yield* withCredentialRule([passing], () => Effect.succeed([]));

	assert.deepStrictEqual(
		[verdicts(breached), verdicts(kept)],
		[
			[true, false],
			[true, true],
		],
	);
});

const judgeCallsMoved = Effect.sync(() => {
	const open = modelRequest("open");
	const [first, second] = [modelRequest("first"), modelRequest("second")];
	const [asked, askedAgain] = [judgeCall("Jane Roe", fakes.baaKey), judgeCall("p-17", fakes.baaKey)];

	assert.deepStrictEqual(judgeCallsApart([[open], [first, asked, second, askedAgain], ["decided"]]), [
		[open],
		[first, second],
		[asked, askedAgain, "decided"],
	]);
});

const claudeJudgeChecked = Effect.sync(() => {
	const asked = judgeCall("Jane Roe", fakes.baaKey);
	const model = modelRequest("prompt");

	const checks = [
		claudeJudgeCheck([[], [model, asked], []]),
		claudeJudgeCheck([[], [model], []]),
		claudeJudgeCheck([[], [asked, judgeCall("p-17", fakes.judgeKey)], []]),
		claudeJudgeCheck([[], [asked], ["decided"]]),
	];

	assert.deepStrictEqual(verdicts(checks), [true, false, false, false]);
});

describe("what a wire run's mocks received", () => {
	it.effect("a turn holds only what the mocks received while it ran, and the end of what it printed", () => oneRun);
	it.effect(
		"the credential rule added to a play's checks fails only when a mock received another's credential",
		() => credentialRule,
	);
	it.effect(
		"each Claude judge call on the BAA mock counts as the judge's, ahead of what the judge mock received",
		() => judgeCallsMoved,
	);
	it.effect(
		"the Claude judge check fails without a judge call on the BAA mock, with another key, or with a Decisions call",
		() => claudeJudgeChecked,
	);
});
