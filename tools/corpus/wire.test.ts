import { Array, Effect, Option, String as Str, Struct, pipe } from "effect";
import type { Case, Message, PhiStrata } from "./manifest.ts";
import { MockReplies, Steps, narrativeCap, planOf } from "./wire.ts";
import { assert, it } from "@effect/vitest";
import { identifierKind } from "#router/features/policy/index.ts";
import { requestsOf } from "./requests.ts";
import { tokensOf } from "./canary-tokens.ts";

const mrn = "MRN 4417-2290";

const record = `{"patient":"Synthetic Person","mrn":"${mrn}","diagnosis":"E11.9"}`;

const pixel = { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ", mimeType: "image/png" };

const summaryLead = "The conversation history before this point was compacted into the following summary:";

const phiCase = (entry: PhiStrata["entry"], messages: readonly [Message, ...Message[]]): Case => ({
	canaries: [mrn],
	expect: "phi",
	fragments: [],
	id: "t-1",
	messages,
	strata: { carrier: "fhir-json", entry, identifier: identifierKind.medicalRecordNumber, transform: "plain" },
});

const opening = Steps.Turn({ prompt: "Go on with the task.", steer: Option.none() });

const pinned = [
	Steps.Turn({ prompt: "/phi pin", steer: Option.none() }),
	opening,
	Steps.Turn({ prompt: "/phi unpin", steer: Option.none() }),
];

const compactionIndex = 2;

const piOutputLimitBytes = 51_200;

const pageLineCount = 2000;

const pageLineLength = 50;

const firstLine = 1;

const newlineBytes = 1;

const onePage = 1;

it.effect("a steering message is sent while the slow tool call of its turn runs, with its image", () =>
	Effect.sync(() => {
		const plan = planOf(
			phiCase("steering", [
				{ role: "system", text: "You are a coding agent." },
				{ role: "user", text: "Run the test." },
				{ role: "assistant", text: "Running it." },
				{ role: "tool", text: "FAIL mapper" },
				{ role: "user", text: `Also this: ${record}` },
				{ image: pixel, role: "user" },
				{ role: "assistant", text: "Looking." },
				{ role: "user", text: "Thanks." },
			]),
		);

		assert.deepStrictEqual(plan, {
			files: [{ bytes: new TextEncoder().encode("FAIL mapper"), path: "files/2.txt" }],
			replies: [
				MockReplies.ToolUse({
					input: { command: "sleep 3; cat files/2.txt" },
					name: "bash",
					textBefore: Option.some("Running it."),
				}),
				MockReplies.Text({ text: "Looking." }),
			],
			steps: [
				Steps.Turn({
					prompt: "Run the test.",
					steer: Option.some({
						images: [pixel],
						text: `Also this: ${record}`,
					}),
				}),
				Steps.Turn({ prompt: "Thanks.", steer: Option.none() }),
			],
		});
	}),
);

it.effect("only a plain message right after a tool result steers, and only the first in a turn", () =>
	Effect.sync(() => {
		const steered = planOf(
			phiCase("steering", [
				{ role: "user", text: "Run the test." },
				{ role: "assistant", text: "Running it." },
				{ role: "tool", text: "FAIL mapper" },
				{ role: "user", text: "Steer one." },
				{ role: "assistant", text: "Again." },
				{ role: "tool", text: "FAIL parser" },
				{ role: "user", text: "Steer two." },
				{ role: "assistant", text: "Ok." },
				{ role: "user", text: "Thanks." },
			]),
		);

		const summarized = planOf(
			phiCase("steering", [
				{ role: "user", text: "Run the test." },
				{ role: "assistant", text: "Running it." },
				{ role: "tool", text: "FAIL mapper" },
				{ role: "user", text: `${summaryLead}\n\n<summary>\nFix the parser.\n</summary>` },
			]),
		);

		assert.deepStrictEqual(steered.steps, [
			Steps.Turn({ prompt: "Run the test.", steer: Option.some("Steer one.") }),
			Steps.Turn({ prompt: "Steer two.", steer: Option.none() }),
			Steps.Turn({ prompt: "Thanks.", steer: Option.none() }),
		]);

		const compactions = pipe(summarized.steps, Array.map(Steps.$is("Compact")));

		assert.deepStrictEqual(compactions, [false, false, false, true, false]);
	}),
);

it.effect(
	"a case that opens with a tool result starts with a neutral prompt that the mock answers with the tool call",
	() =>
		Effect.sync(() => {
			const plan = planOf(phiCase("tool-result", [{ role: "tool", text: record }]));

			assert.deepStrictEqual(plan.steps, [opening]);

			assert.deepStrictEqual(plan.replies, [
				MockReplies.ToolUse({ input: { command: "cat files/0.txt" }, name: "bash", textBefore: Option.none() }),
			]);
		}),
);

it.effect(
	"a case that opens with a reply gets it from the BAA account in a pinned stretch, then plays on unpinned",
	() =>
		Effect.sync(() => {
			const plan = planOf(
				phiCase("ent-reply", [
					{ role: "assistant", text: record },
					{ role: "tool", text: "FAIL mapper" },
					{ role: "user", text: "Fix it." },
				]),
			);

			assert.deepStrictEqual(plan.steps, [
				...pinned,
				opening,
				Steps.Turn({ prompt: "Fix it.", steer: Option.none() }),
			]);

			assert.deepStrictEqual(plan.replies, [
				MockReplies.Text({ text: record }),
				MockReplies.ToolUse({ input: { path: "files/0.txt" }, name: "read", textBefore: Option.none() }),
			]);
		}),
);

it.effect("a compaction summary comes back from the mock after two filler turns, and a new turn carries it", () =>
	Effect.sync(() => {
		const summary = `## Goal\nFix the parser.\n${record}`;
		const wrapped = `${summaryLead}\n\n<summary>\n${summary}\n\n</summary>`;
		const { steps } = planOf(phiCase("compaction-summary", [{ role: "user", text: wrapped }]));

		const compactions = pipe(steps, Array.map(Steps.$is("Compact")));

		assert.deepStrictEqual(compactions, [false, false, true, false]);

		assert.deepStrictEqual(steps[compactionIndex], Steps.Compact({ summary }));
	}),
);

it.effect("a summary written without pi's line breaks is still a compaction", () =>
	Effect.sync(() => {
		const subject = phiCase("compaction-summary", [
			{ role: "user", text: `${summaryLead}<summary>Import of the chart: MRN 4417-</summary>` },
			{ role: "user", text: "2290\nreschedule the visit" },
		]);

		assert.deepStrictEqual(
			planOf(subject).steps[compactionIndex],
			Steps.Compact({ summary: "Import of the chart: MRN 4417-" }),
		);
	}),
);

it.effect("a summary loses the space it ends with, as compaction trims it", () =>
	Effect.sync(() => {
		const subject = phiCase("compaction-summary", [
			{ role: "user", text: `${summaryLead}\n<summary>\nImport of the chart: MRN \n</summary>` },
			{ role: "user", text: "4417-2290\nreschedule the visit" },
		]);

		assert.deepStrictEqual(
			planOf(subject).steps[compactionIndex],
			Steps.Compact({ summary: "Import of the chart: MRN" }),
		);
	}),
);

it.effect(
	"a summary longer than compaction keeps is played as a pasted turn, so its canary still reaches a request",
	() =>
		Effect.gen(function* pastedSummary() {
			const text = `${summaryLead}\n\n<summary>\n${Str.repeat(narrativeCap)("x")}\n${record}\n</summary>`;
			const subject = phiCase("compaction-summary", [{ role: "user", text }]);

			const turns = pipe(planOf(subject).steps, Array.map(Steps.$is("Turn")));

			assert.deepStrictEqual(turns, [true]);

			const { wholeCanaryTokens } = yield* tokensOf(subject);

			assert.deepStrictEqual(wholeCanaryTokens, [mrn]);
		}),
);

it.effect("a tool text over pi's 50 KB output limit is read a page at a time, every line once and none cut", () =>
	Effect.sync(() => {
		const line = Str.repeat(pageLineLength)("x");
		const text = Array.join(Array.replicate(line, pageLineCount), "\n");

		const plan = planOf(
			phiCase("file-read", [
				{ role: "user", text: "Read the log." },
				{ role: "assistant", text: "Reading it." },
				{ role: "tool", text },
			]),
		);

		const ranges = pipe(
			plan.replies,
			Array.flatMap((reply) => {
				if (MockReplies.$is("ToolUse")(reply) && reply.input["path"] === "files/2.txt") {
					return [{ limit: Number(reply.input["limit"]), offset: Number(reply.input["offset"]) }];
				}

				return [];
			}),
		);

		const covered = pipe(
			ranges,
			Array.flatMap(({ offset, limit }) => Array.makeBy(limit, (index) => offset + index)),
		);

		assert.lengthOf(ranges, plan.replies.length);
		assert.isAbove(ranges.length, onePage);
		assert.deepStrictEqual(covered, Array.range(firstLine, pageLineCount));

		const fits = pipe(
			ranges,
			Array.every(({ limit }) => limit * (line.length + newlineBytes) <= piOutputLimitBytes),
		);

		assert.isTrue(fits);
	}),
);

it.effect("a canary cut at the end of a compaction summary is tracked by pieces the case's requests carry", () =>
	Effect.gen(function* summarySplit() {
		const subject = Struct.assign(
			phiCase("compaction-summary", [
				{ role: "user", text: `${summaryLead}<summary>Import of the chart: MRN 4417-</summary>` },
				{ role: "user", text: "2290\nreschedule the visit" },
			]),
			{ canaryParts: { [mrn]: ["MRN 4417-", "2290"] as const } },
		);

		const { splits } = yield* tokensOf(subject);
		const requests = yield* requestsOf(subject);

		const sent = pipe(
			requests,
			Array.flatten,
			Array.flatMap(({ parts }) => parts),
			Array.flatMap((part) => {
				if (part.kind === "text") {
					return [part.text];
				}

				return [];
			}),
		);

		const carried = pipe(
			splits,
			Array.map(({ parts }) =>
				pipe(
					parts,
					Array.every((part) => pipe(sent, Array.some(Str.includes(part)))),
				),
			),
		);

		assert.deepStrictEqual(carried, [true]);
	}),
);
