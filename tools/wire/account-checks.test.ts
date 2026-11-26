import { Array, Effect, Option, String as Str, Struct, pipe } from "effect";
import type { Ran, StepRan } from "./account-checks.ts";
import { assert, describe, it } from "@effect/vitest";
import { checksOf, reportOf } from "./account-checks.ts";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import type { Relayed } from "./relay.ts";
import { voidedSsn } from "./cases.ts";

const line = (lane: "clean" | "sealed", reason: LaneLogLine["reason"]): LaneLogLine => ({
	account: lane,
	judgeCost: 0,
	judgeFailures: 0,
	lane,
	model: "claude-haiku-5-5",
	reason,
	session: "29292929-2929-4929-8929-292929292930",
	substitute: false,
	time: "2026-01-01T00:00:00.000Z",
});

const clean = line("clean", "clean");

const pinnedLine = line("sealed", "pinned");

const answered = (answer: string): StepRan["turns"] => [
	{ exitCode: 0, printed: `{"type":"result","subtype":"success","result":"${answer}"}` },
];

const noPinnedRun = { gaveUp: 0, rewrites: 0, runs: 0 };

const handedOff = (name: StepRan["name"], answer: string): StepRan => ({
	lines: [clean, pinnedLine, clean],
	name,
	pinned: { gaveUp: 0, rewrites: 1, runs: 1 },
	turns: answered(answer),
});

const steps: readonly StepRan[] = [
	{ lines: [clean, clean], name: "prompts", pinned: noPinnedRun, turns: [...answered("ok"), ...answered("ok")] },
	handedOff("tool result", "The overdue payment is p-4821."),
	handedOff("sealed answer", "It returned p-4821."),
	handedOff("sealed answer in auto mode", "It returned a handle."),
];

const usage = { read: true, tokens: { cacheRead: 0, cacheWrite: 0, output: 1_000_000, uncachedInput: 0 } } as const;

const relayed = (lane: Relayed["lane"], holdsCanary: boolean): Relayed => ({
	account: lane,
	holdsCanary,
	lane,
	model: "claude-haiku-5-5",
	status: 200,
	usage,
});

const requests = { baa: 3, open: 8 };

const ran: Ran = {
	relayed: [
		...Array.replicate(relayed("open", false), requests.open),
		...Array.replicate(relayed("baa", false), requests.baa),
	],
	stateFileTexts: ["{}"],
	steps,
};

type Change = Pick<StepRan, "lines"> | Pick<StepRan, "pinned"> | Pick<StepRan, "turns">;

const changed = (name: StepRan["name"], change: Change): Ran =>
	Struct.assign(ran, {
		steps: pipe(
			steps,
			Array.map((step): StepRan => {
				if (step.name !== name) {
					return step;
				}

				return Struct.assign(step, change);
			}),
		),
	});

const wrongId = answered("The overdue payment is p-4822.");

const canaryAnswer = answered(`It returned ${voidedSsn}.`);

const notPinned = [clean, clean];

const pinnedAfterAnotherSealedLine = [line("sealed", "overflow"), pinnedLine];

const openWithCanary = Struct.assign(ran, { relayed: [...ran.relayed, relayed("open", true)] });

const unpricedBaa = Struct.assign(ran, {
	relayed: [...ran.relayed, Struct.assign(relayed("baa", false), { model: "unpriced" })],
});

const canaryOnDisk = Struct.assign(ran, { stateFileTexts: ["{}", `{"note":"SSN ${voidedSsn}"}`] });

const noRewrite = { gaveUp: 0, rewrites: 0, runs: 1 };

const failedTurn = [{ exitCode: 1, printed: "" }];

const holds = (run: Ran): boolean =>
	pipe(
		checksOf(run),
		Array.every(({ ok }) => ok),
	);

const checked = Effect.sync(() => {
	assert.deepStrictEqual(
		pipe(
			[
				ran,
				changed("tool result", { turns: wrongId }),
				changed("tool result", { lines: notPinned }),
				changed("tool result", { lines: pinnedAfterAnotherSealedLine }),
				changed("sealed answer", { pinned: noRewrite }),
				changed("sealed answer", { turns: canaryAnswer }),
				changed("sealed answer in auto mode", { turns: failedTurn }),
				openWithCanary,
				unpricedBaa,
				canaryOnDisk,
			],
			Array.map(holds),
		),
		[true, false, false, false, false, false, false, false, false, false],
	);
});

const handBack = (event: string): StepRan["turns"] => [
	{
		exitCode: 0,
		printed: Array.join(
			[
				'{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}]}}',
				'{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"text","text":"p-4821"}]}}',
				event,
				'{"type":"result","subtype":"success","result":"done"}',
			],
			"\n",
		),
	},
];

const cleared = handBack(
	'{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"p-4821"}]}}',
);

const wrapped = handBack(
	String.raw`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"[Subagent hand-back] The text below is the final report of a subagent.\n\np-4821"}]}}`,
);

const fallback = handBack(
	'{"type":"system","subtype":"task_notification","tool_use_id":"toolu_1","status":"failed","summary":"Agent stopped"}',
);

const noteOn = (step: StepRan): string => {
	const report = reportOf({ checks: [], harness: "claude", ran: Struct.assign(ran, { steps: [step] }) });

	return pipe(
		Str.split(report, "\n"),
		Array.findFirst(Str.startsWith(`${step.name}: `)),
		Option.getOrElse(() => ""),
	);
};

const received = Effect.sync(() => {
	const auto = handedOff("sealed answer in auto mode", "done");

	assert.deepStrictEqual(
		[
			noteOn(Struct.assign(auto, { turns: cleared })),
			noteOn(Struct.assign(auto, { turns: wrapped })),
			noteOn(Struct.assign(auto, { turns: fallback })),
			noteOn(Struct.assign(auto, { pinned: { gaveUp: 1, rewrites: 5, runs: 1 }, turns: cleared })),
		],
		[
			'sealed answer in auto mode: the pinned subagent ran 1 times, with 1 rewrites and 0 answers withheld; the root agent received the cleared answer "p-4821"',
			'sealed answer in auto mode: the pinned subagent ran 1 times, with 1 rewrites and 0 answers withheld; the root agent received the cleared answer "[Subagent hand-back] The text below is the final report of a subagent.',
			'sealed answer in auto mode: the pinned subagent ran 1 times, with 1 rewrites and 0 answers withheld; the root agent received the harness\'s own fallback text "Agent stopped"',
			"sealed answer in auto mode: the pinned subagent ran 1 times, with 5 rewrites and 1 answers withheld; the root agent received phi-router's withheld reply, the handle of the answer it could not clear",
		],
	);
});

describe("an accounts run", () => {
	it.effect(
		"fails when the root misses the id, the pinned subagent skips the BAA account or the rewrite, the canary reaches the root, an open account or a state file, or a BAA request has no price",
		() => checked,
	);
	it.effect(
		"reports whether the root received the cleared answer, the harness's own fallback or phi-router's withheld reply",
		() => received,
	);
});
