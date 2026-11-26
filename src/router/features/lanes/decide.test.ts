import { Array, Effect, Equal, String as Str, pipe } from "effect";
import { Judge, JudgeFailed } from "#router/client/judge/index.ts";
import type { Keep, ToolsNotCleared } from "#router/features/border/index.ts";
import type { Lookup, Standing } from "#router/features/verdicts/index.ts";
import { assert, it } from "@effect/vitest";
import { guard, sealedStub } from "#router/features/border/index.ts";
import { Digest } from "effect/crypto";
import type { Message } from "#router/features/parts/index.ts";
import { Verdicts } from "#router/features/verdicts/index.ts";
import { decide } from "./index.ts";
import { handleAt } from "#router/primitives/handle.ts";

const firstSequence = 1;

const h1 = handleAt(firstSequence);

const patient = "Canary Fakesmith";

const syntheticChart = `Chart for ${patient}, DOB 1900-01-01, Ward 4 bed 12.`;

const ssnRecord = "member_id,ssn\n4471,078-05-1120";

const row = "4471,U2546280,E11.9,metformin";

const usage = { calls: 1, cost: 0, inputTokens: 1, ms: 1 };

const sealsHigh = 0.9;

const answering = Judge.of({
	identifier: ({ piece }) => {
		if (Str.includes(patient)(piece)) {
			return Effect.succeed({ score: sealsHigh, usage });
		}

		return Effect.succeed({ score: 0, usage });
	},
	kind: () => Effect.fail(JudgeFailed.make({ why: "judge-refused" })),
	model: "scripted",
});

const failing = Judge.of({
	identifier: () => Effect.fail(JudgeFailed.make({ why: "judge-error" })),
	kind: () => Effect.fail(JudgeFailed.make({ why: "judge-error" })),
	model: "scripted",
});

const system: Message = { content: "You are a coding agent.", role: "system", sections: [], tools: [] };

const asked = (text: string): Message => ({ content: [{ text, type: "text" }], role: "user" });

const ranCat: Message = {
	content: [{ arguments: '{"path":"data.csv"}', id: "toolu_1", name: "read", type: "toolCall" }],
	role: "assistant",
	writtenBy: "open-account",
};

const catOutput = (text: string): Message => ({
	content: [{ text, type: "text" }],
	isError: false,
	role: "toolResult",
	toolCallId: "toolu_1",
});

const reply = (writtenBy: "open-account" | "other", text: string): Message => ({
	content: [{ text, type: "text" }],
	role: "assistant",
	writtenBy,
});

const firstHandle: Keep<never> = (parts) =>
	pipe(
		parts,
		Array.map(({ key }) => [key, h1] as const),
		(pairs) => new Map(pairs),
		Effect.succeed,
	);

const noStub = 0;

const oneStub = 1;

const twoStubs = 2;

const opening = [system, asked("Why does the admissions import drop rows?")];

interface Session {
	readonly lookup: Lookup;
	readonly send: (
		messages: readonly Message[],
		judge?: Judge["Service"],
	) => Effect.Effect<number, ToolsNotCleared, Digest.Digest>;
}

const sessionOf = (): Session => {
	const book = new Map<string, Standing>();
	const lookup: Lookup = (key) => book.get(key) ?? "unknown";

	const send = (
		messages: readonly Message[],
		judge: Judge["Service"] = answering,
	): Effect.Effect<number, ToolsNotCleared, Digest.Digest> =>
		pipe(
			decide({ lookup, messages }),
			Effect.provideService(Judge, judge),
			Effect.tap(({ found }) =>
				Effect.sync(() => {
					for (const [key, verdict] of found) {
						const sealed = Verdicts.$is("Sealed")(verdict);

						if (sealed) {
							book.set(key, "sealed");
						}

						if (!sealed && book.get(key) !== "sealed") {
							book.set(key, "cleared");
						}
					}
				}),
			),
			Effect.flatMap(() => guard({ harness: "claude", keep: firstHandle, lookup, messages })),
			Effect.map((view) => Array.countBy(Array.zip(view, messages), ([seen, sent]) => !Equal.equals(seen, sent))),
		);

	return { lookup, send };
};

const sealedSession = Effect.gen(function* sealedSession() {
	const session = sessionOf();
	const read = [...opening, ranCat, catOutput(ssnRecord)];
	const done = [reply("other", "Done."), asked("Now add a test.")];
	const next = [...read, ...done];
	const lanes = [yield* session.send(opening), yield* session.send(read)];

	return { done, lanes, next, read, session };
});

const ssnResult = Effect.gen(function* ssnResult() {
	const { done, lanes, next, session } = yield* sealedSession;
	const after = yield* session.send(next);
	const view = yield* guard({ harness: "claude", keep: firstHandle, lookup: session.lookup, messages: next });

	assert.deepStrictEqual([...lanes, after], [noStub, oneStub, oneStub]);
	assert.deepStrictEqual(view, [...opening, ranCat, catOutput(sealedStub("claude")(h1)), ...done]);
});

const repeated = Effect.gen(function* repeated() {
	const { read, next, session } = yield* sealedSession;
	const retried = yield* session.send(read);
	const after = yield* session.send(next);
	const reread = yield* session.send([...next, ranCat, catOutput(ssnRecord)]);

	assert.deepStrictEqual([retried, after, reread], [oneStub, oneStub, twoStubs]);
});

const judged = Effect.gen(function* judged() {
	const session = sessionOf();
	const clean = yield* session.send([...opening, ranCat, catOutput("export const x = 1;")]);
	const flagged = yield* session.send([...opening, ranCat, catOutput(syntheticChart)]);

	assert.deepStrictEqual([clean, flagged], [noStub, oneStub]);
});

const historySeals = Effect.gen(function* historySeals() {
	const session = sessionOf();

	const stubbed = yield* session.send([
		system,
		asked(syntheticChart),
		reply("other", "Done."),
		asked("Now add a test."),
	]);

	assert.strictEqual(stubbed, oneStub);
});

const afterSeal = Effect.gen(function* afterSeal() {
	const session = sessionOf();
	const read = [...opening, ranCat, catOutput(syntheticChart)];
	const sealed = yield* session.send(read);
	const after = yield* session.send([...read, reply("other", "Done."), asked("Now add a test.")]);

	assert.deepStrictEqual([sealed, after], [oneStub, oneStub]);
});

const quoted = Effect.gen(function* quoted() {
	const session = sessionOf();
	const read = [...opening, ranCat, catOutput(`${syntheticChart}\n${row}`)];
	const fixIt = asked("Fix it.");
	const done = [reply("open-account", "Done."), asked("Now add a test.")];
	const asking = [...read, reply("other", `The failing row:\n${row}`), fixIt];
	const later = [...asking, ...done];
	const lanes = [yield* session.send(read), yield* session.send(asking), yield* session.send(later)];
	const view = yield* guard({ harness: "codex", keep: firstHandle, lookup: session.lookup, messages: later });

	assert.deepStrictEqual(lanes, [oneStub, twoStubs, twoStubs]);
	assert.deepStrictEqual(view, [
		...opening,
		ranCat,
		catOutput(sealedStub("codex")(h1)),
		reply("other", sealedStub("codex")(h1)),
		fixIt,
		...done,
	]);
});

const judgeFails = Effect.gen(function* judgeFails() {
	const session = sessionOf();
	const failed = yield* session.send(opening, failing);
	const next = yield* session.send([...opening, reply("other", "Sorry, try again."), asked("Thanks.")]);

	assert.deepStrictEqual([failed, next], [twoStubs, twoStubs]);
});

it.layer(Digest.layerWebCrypto)("decide", (test) => {
	test.effect(
		"a tool result with a valid SSN seals, and the open account sees it as a stub from then on",
		() => ssnResult,
	);
	test.effect("a repeated read of sealed content seals again and reaches the open account as a stub", () => repeated);
	test.effect("a tool result the judge flags is stubbed, and a clean one passes", () => judged);
	test.effect("a never-judged history that seals is stubbed, though the new content is clean", () => historySeals);
	test.effect("a reply right after sealed content is judged beside its stub and passes", () => afterSeal);
	test.effect(
		"a reply that repeats a line of sealed content is stubbed, though the judge clears it alone",
		() => quoted,
	);
	test.effect("a failed judgment stubs only its pieces, and later content passes", () => judgeFails);
});
