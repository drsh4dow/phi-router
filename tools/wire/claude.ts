import { Effect, FileSystem, Path, Struct } from "effect";
import type { Outcome, Run } from "./checks.ts";
import {
	answerChecksOf,
	baaScriptOf,
	chart,
	judgeOf,
	listedIn,
	openScriptOf,
	readChart,
	tasksFor,
} from "./answer-checks.ts";
import { checksOf, leftOf } from "./checks.ts";
import { claudeEnvOf, claudeTurn, claudeWindows, place, windowChecksOf } from "./claude-turn.ts";
import { during, followUp, withCredentialRule } from "./during.ts";
import { fakes, mocked } from "#tools/route/mocked-router.ts";
import {
	handOff,
	handleChecksOf,
	insideStamp,
	overflowChecksOf,
	phiChecksOf,
	phiTurns,
	refusing,
	sealCheckOf,
	shownChecksOf,
	subagentChecksOf,
} from "./phi-checks.ts";
import { overflowing, stampClockIn, storedIn } from "./stored.ts";
import { uncheckedChecksOf, uncheckedPlugins } from "./unchecked.ts";
import { routerProcess } from "#tools/route/router-process.ts";

const session = "17171717-1717-4717-8717-171717171717";

const setUp = Effect.fnUntraced(function* setUp(run: Run) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const where = yield* place;
	const file = path.join(where.work, chart);

	const tasks = tasksFor(file);

	yield* fs.writeFileString(file, run.phi.text);

	const { breaches, env, received, roots, state } = yield* mocked({
		baa: baaScriptOf(tasks),
		configExtras: { sealedModel: fakes.sealedModel },
		holdsPhi: run.judgeSeals,
		judge: judgeOf(run.judgeSeals),
		open: refusing(openScriptOf({ file, tasks })),
	});

	const folders = Struct.pick(env, ["XDG_CONFIG_HOME", "XDG_STATE_HOME"]);

	const routed = Effect.gen(function* routed() {
		const router = yield* routerProcess(["bun", "src/router/main.ts"], env);

		const turn = Effect.fnUntraced(function* turn(
			prompt: string,
			flags: readonly string[],
			plugin: string = where.plugin,
		) {
			const at = Struct.assign(where, { plugin });

			return yield* during(
				() => received,
				() => claudeTurn({ folders, place: at, prompt, router: router.url, session: flags }),
			);
		});

		const harnessEnv = yield* claudeEnvOf({ folders, place: where, router: router.url });

		const windows = (clean: string): ReturnType<typeof claudeWindows> =>
			claudeWindows({ clean, env: harnessEnv, place: where, received: () => received, session });

		return { stop: router.kill, turn, url: router.url, windows };
	});

	return { breaches, roots, routed, state, tasks };
});

const events = ["--output-format", "stream-json", "--verbose"];

const started = ["--session-id", session, ...events];

const resumed = ["--resume", session];

const resumedEvents = [...resumed, ...events];

const hookEvents = [...resumedEvents, "--include-hook-events"];

const claudePlay = Effect.fnUntraced(function* claudePlay(run: Run) {
	const { breaches, roots, routed, state, tasks } = yield* setUp(run);
	const first = yield* routed;

	const [clean, canary, followed, tool, handedOff, after] = yield* Effect.all(
		[
			first.turn(run.clean.text, started),
			first.turn(run.phi.text, resumedEvents),
			first.turn(followUp, resumedEvents),
			first.turn(readChart, resumedEvents),
			first.turn(handOff, hookEvents),
			first.turn(followUp, resumedEvents),
		],
		{ concurrency: 1 },
	);

	const phi = yield* phiTurns((prompt) => first.turn(prompt, resumed));
	const compacted = yield* first.turn("/compact", resumed);

	yield* first.stop;

	const restarted = yield* routed;
	const reopened = yield* restarted.turn(tasks.lookUpAgain.asks, hookEvents);

	const [judged, withheld, toolFirst, listed] = yield* Effect.all(
		[
			restarted.turn(tasks.judged.asks, hookEvents),
			restarted.turn(tasks.withheld.asks, hookEvents),
			restarted.turn(tasks.toolFirst.asks, hookEvents),
			restarted.turn(tasks.listed.asks, hookEvents),
		],
		{ concurrency: 1 },
	);

	const unreached = yield* uncheckedPlugins(restarted.url);

	const unchecked = yield* Effect.all(
		[
			restarted.turn(tasks.noRouter.asks, hookEvents, unreached.noRouter),
			restarted.turn(tasks.failing.asks, hookEvents, unreached.failing),
			restarted.turn(tasks.unreadable.asks, hookEvents, unreached.unreadable),
			restarted.turn(tasks.inBackground.asks, hookEvents),
			restarted.turn(tasks.failingInBackground.asks, hookEvents, unreached.failing),
			restarted.turn(tasks.otherInBackground.asks, hookEvents),
		],
		{ concurrency: 1 },
	);

	const [noRouter, failing, unreadable, inBackground, failingInBackground, otherInBackground] = unchecked;
	const rewritten = [judged, withheld, toolFirst, listed, ...unchecked] as const;

	const overflow = yield* Effect.all(
		[
			restarted.turn(overflowing, resumedEvents),
			restarted.turn(insideStamp, resumedEvents),
			restarted.turn("/phi", resumed),
		],
		{ concurrency: 1 },
	);

	const [overflowed, quiet, status] = overflow;

	const untilCompaction = [handedOff, after, ...phi.inOrder, compacted];

	const beforeOverflow = [clean, canary, followed, tool, ...untilCompaction, reopened, ...rewritten] as const;

	const all = [...beforeOverflow, ...overflow] as const;
	const windows = yield* restarted.windows(run.clean.text);
	const turned = [...all, windows.beside, windows.phi, windows.after, windows.otherModel, windows.alone] as const;

	yield* restarted.stop;

	const stored = yield* storedIn(state, roots);
	const files = yield* listedIn(state);

	const left = leftOf({
		prompts: [run.clean.text, run.phi.text, followUp, readChart, handOff, tasks.lookUpAgain.asks],
		run,
		sessions: [session],
		stored,
		turns: turned,
	});

	const phiChecks = [...phiChecksOf(phi), ...shownChecksOf({ harness: "claude", turns: phi })];

	const sealed = sealCheckOf(all);

	const handles = handleChecksOf({
		afterCompaction: tasks.lookUpAgain.asks,
		beforeOverflow,
		canaries: left.canaries,
		compacted,
		handedOff,
		lines: stored.lines,
		read: tool,
		reopened,
		untilCompaction,
	});

	const overflowChecks = overflowChecksOf({
		after: [overflowed, quiet],
		all,
		canaries: left.canaries,
		clock: yield* stampClockIn(state),
		command: "/phi",
		harness: "claude",
		lines: stored.lines,
		session,
		status,
	});

	const handing = subagentChecksOf({ after, handedOff, harness: "claude" });

	const played = {
		all,
		canaries: left.canaries,
		failing,
		failingInBackground,
		files,
		handedOff,
		ids: {
			failing: tasks.failing.id,
			failingInBackground: tasks.failingInBackground.id,
			inBackground: tasks.inBackground.id,
			judged: tasks.judged.id,
			listed: tasks.listed.id,
			lookUp: tasks.lookUp.id,
			lookUpAgain: tasks.lookUpAgain.id,
			noRouter: tasks.noRouter.id,
			otherInBackground: tasks.otherInBackground.id,
			toolFirst: tasks.toolFirst.id,
			unreadable: tasks.unreadable.id,
			withheld: tasks.withheld.id,
		},
		inBackground,
		judged,
		listed,
		noRouter,
		otherInBackground,
		reopened,
		status,
		toolFirst,
		unreadable,
		withheld,
	};

	const rewrites = [...answerChecksOf(played), ...uncheckedChecksOf(played)];

	return {
		checks: yield* withCredentialRule(
			[
				...checksOf(left),
				...handles,
				...phiChecks,
				sealed,
				...handing,
				...rewrites,
				...overflowChecks,
				...windowChecksOf({ session, windows }),
			],
			() => breaches,
		),
		stored,
		turns: turned,
	} satisfies Outcome;
});

export { claudePlay };
