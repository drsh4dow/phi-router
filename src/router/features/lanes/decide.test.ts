import { Array, Effect, String as Str, pipe } from "effect";
import type { Lookup, Standing } from "#router/features/verdicts/index.ts";
import { assert, it } from "@effect/vitest";
import { guard, stubsFor } from "#router/features/border/index.ts";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge.ts";
import { JudgeFailed } from "#router/client/judge-failed.ts";
import type { Lane } from "./index.ts";
import type { Message } from "#router/features/parts/index.ts";
import { Verdicts } from "#router/features/verdicts/index.ts";
import { decide } from "./index.ts";
import { partsOf } from "#router/features/parts/index.ts";

const patient = "Canary Fakesmith";

const syntheticChart = `Chart for ${patient}, DOB 1900-01-01, Ward 4 bed 12.`;

const ssnRecord = "member_id,ssn\n4471,078-05-1120";

const row = "4471,U2546280,E11.9,metformin";

const usage = { calls: 1, cost: 0, inputTokens: 1, ms: 1 };

const sealsHigh = 0.9;

/** Scores a piece that names the patient as an identifier, and clears the rest. */
const answering = Judge.of({
	identifier: ({ piece }) => {
		if (Str.includes(patient)(piece)) {
			return Effect.succeed({ score: sealsHigh, usage });
		}

		return Effect.succeed({ score: 0, usage });
	},
	kind: () => Effect.fail(JudgeFailed.make({ why: "judge-refused" })),
});

const failing = Judge.of({
	identifier: () => Effect.fail(JudgeFailed.make({ why: "judge-error" })),
	kind: () => Effect.fail(JudgeFailed.make({ why: "judge-error" })),
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

const opening = [system, asked("Why does the admissions import drop rows?")];

/** One session's verdicts, and `send`, which decides a request's lane and records what it found. */
interface Session {
	readonly lookup: Lookup;
	readonly send: (messages: readonly Message[], judge?: Judge["Service"]) => Effect.Effect<Lane, never, Digest.Digest>;
}

/**
 * One session with its verdicts in memory, a sealed verdict never overwritten, as the router's verdict store keeps them.
 *
 * @returns {Session} The session.
 */
const sessionOf = (): Session => {
	const book = new Map<string, Standing>();
	const lookup: Lookup = (key) => book.get(key) ?? "unknown";

	const send = (
		messages: readonly Message[],
		judge: Judge["Service"] = answering,
	): Effect.Effect<Lane, never, Digest.Digest> =>
		pipe(
			decide({ lookup, messages }),
			Effect.provideService(Judge, judge),
			Effect.map(({ found, laneAt }) => {
				for (const [key, verdict] of found) {
					const sealed = Verdicts.$is("Sealed")(verdict);

					if (sealed) {
						book.set(key, "sealed");
					}

					if (!sealed && book.get(key) !== "sealed") {
						book.set(key, "cleared");
					}
				}

				return laneAt(lookup);
			}),
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
	const view = yield* guard({ harness: "claude", lookup: session.lookup, messages: next });

	assert.deepStrictEqual([...lanes, after], ["clean", "sealed", "clean"]);
	assert.deepStrictEqual(view, [...opening, ranCat, catOutput(stubsFor.claude), ...done]);
});

const repeated = Effect.gen(function* repeated() {
	const { read, next, session } = yield* sealedSession;
	const retried = yield* session.send(read);
	const after = yield* session.send(next);
	const reread = yield* session.send([...next, ranCat, catOutput(ssnRecord)]);

	assert.deepStrictEqual([retried, after, reread], ["sealed", "clean", "sealed"]);
});

const judged = Effect.gen(function* judged() {
	const session = sessionOf();
	const clean = yield* session.send([...opening, ranCat, catOutput("export const x = 1;")]);
	const flagged = yield* session.send([...opening, ranCat, catOutput(syntheticChart)]);

	assert.deepStrictEqual([clean, flagged], ["clean", "sealed"]);
});

const afterSeal = Effect.gen(function* afterSeal() {
	const session = sessionOf();
	const read = [...opening, ranCat, catOutput(syntheticChart)];
	const sealed = yield* session.send(read);
	const after = yield* session.send([...read, reply("other", "Done."), asked("Now add a test.")]);

	assert.deepStrictEqual([sealed, after], ["sealed", "clean"]);
});

const quoted = Effect.gen(function* quoted() {
	const session = sessionOf();
	const read = [...opening, ranCat, catOutput(`${syntheticChart}\n${row}`)];
	const fixIt = asked("Fix it.");
	const done = [reply("open-account", "Done."), asked("Now add a test.")];
	const asking = [...read, reply("other", `The failing row:\n${row}`), fixIt];
	const later = [...asking, ...done];
	const lanes = [yield* session.send(read), yield* session.send(asking), yield* session.send(later)];
	const view = yield* guard({ harness: "codex", lookup: session.lookup, messages: later });

	assert.deepStrictEqual(lanes, ["sealed", "sealed", "clean"]);
	assert.deepStrictEqual(view, [
		...opening,
		ranCat,
		catOutput(stubsFor.codex),
		reply("other", stubsFor.codex),
		fixIt,
		...done,
	]);
});

const judgeFails = Effect.gen(function* judgeFails() {
	const session = sessionOf();
	const failed = yield* session.send(opening, failing);
	const next = yield* session.send([...opening, reply("other", "Sorry, try again."), asked("Thanks.")]);

	assert.deepStrictEqual([failed, next], ["sealed", "clean"]);
});

/**
 * A store that holds the parts of `message` sealed and every other part cleared.
 *
 * @param {Message} message The sealed message.
 * @returns {Effect.Effect<Lookup, never, Digest.Digest>} The store's lookup.
 */
const sealing = (message: Message): Effect.Effect<Lookup, never, Digest.Digest> =>
	Effect.map(partsOf(message), (parts) => (key) => {
		if (
			pipe(
				parts,
				Array.some((part) => part.key === key),
			)
		) {
			return "sealed";
		}

		return "cleared";
	});

const sealedMeanwhile = Effect.gen(function* sealedMeanwhile() {
	const earlier = asked("Why does the admissions import drop rows?");
	const latest = asked("Now add a test.");
	const historySealed = yield* sealing(earlier);
	const newSealed = yield* sealing(latest);

	const { laneAt } = yield* decide({
		lookup: () => "unknown",
		messages: [system, earlier, reply("other", "Done."), latest],
	}).pipe(Effect.provideService(Judge, answering));

	assert.deepStrictEqual(
		[laneAt(() => "cleared"), laneAt(historySealed), laneAt(newSealed)],
		["clean", "clean", "sealed"],
	);
});

it.layer(Digest.layerWebCrypto)("decide", (test) => {
	test.effect(
		"a tool result with a valid SSN goes sealed, and the next request clean with that result stubbed",
		() => ssnResult,
	);
	test.effect("a retry of a sealed request and a repeated read of the sealed content go sealed", () => repeated);
	test.effect("a tool result the judge flags goes sealed, and a clean one stays clean", () => judged);
	test.effect(
		"a reply right after sealed content is judged beside its stub, so the next request goes clean",
		() => afterSeal,
	);
	test.effect(
		"a reply that repeats a line of sealed content goes sealed, though the judge clears it alone",
		() => quoted,
	);
	test.effect(
		"a failed judgment seals only its piece: the request goes sealed and the next one clean",
		() => judgeFails,
	);
	test.effect(
		"a request judged clean goes sealed when its new content is stored sealed before the send, and history does not",
		() => sealedMeanwhile,
	);
});
