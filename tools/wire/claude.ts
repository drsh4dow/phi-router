import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Config, Effect, FileSystem, Path, Stream, Struct } from "effect";
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
import { pluginCopy } from "#tools/plugin/copied.ts";
import { routerProcess } from "#tools/route/router-process.ts";

const place = Effect.gen(function* place() {
	const fs = yield* FileSystem.FileSystem;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-home-" });
	const config = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-claude-" });
	const work = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-work-" });
	const plugin = yield* pluginCopy;

	return { config, home, plugin, work };
});

type Place = Readonly<Effect.Success<typeof place>>;

const claudeTurn = Effect.fnUntraced(
	function* claudeTurn(turn: {
		readonly folders: Readonly<Record<string, string>>;
		readonly place: Place;
		readonly router: string;
		readonly prompt: string;
		readonly session: readonly string[];
	}) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const path = yield* Path.Path;
		const searchPath = yield* Config.String("PATH");

		const args = [
			"-p",
			turn.prompt,
			"--model",
			"phi/auto",
			"--allowedTools",
			"Read,Bash",
			"--plugin-dir",
			turn.place.plugin,
		];

		const command = ChildProcess.make("claude", [...args, ...turn.session], {
			cwd: path.resolve(turn.place.work),
			env: Struct.assign(turn.folders, {
				ANTHROPIC_AUTH_TOKEN: fakes.harnessToken,
				ANTHROPIC_BASE_URL: turn.router,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				CLAUDE_CONFIG_DIR: turn.place.config,
				DISABLE_ERROR_REPORTING: "1",
				DISABLE_TELEMETRY: "1",
				HOME: turn.place.home,
				PATH: searchPath,
				TZ: "UTC",
			}),
			extendEnv: false,
		});

		const handle = yield* spawner.spawn(command);
		const printed = yield* Stream.mkString(Stream.decodeText(Stream.drainFork(handle.stdout, handle.stderr)));
		const exitCode = yield* handle.exitCode;

		return { exitCode, printed };
	},
	Effect.scoped,
	Effect.timeout("3 minutes"),
);

const sealedWithRestoredChart = "Go on.";

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

		const turn = Effect.fnUntraced(function* turn(prompt: string, flags: readonly string[]) {
			return yield* during(
				() => received,
				() => claudeTurn({ folders, place: where, prompt, router: router.url, session: flags }),
			);
		});

		return { stop: router.kill, turn };
	});

	return { breaches, roots, routed, state, tasks };
});

const session = "17171717-1717-4717-8717-171717171717";

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
	const restoredChart = yield* restarted.turn(sealedWithRestoredChart, resumedEvents);
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

	const rewritten = [judged, withheld, toolFirst, listed] as const;

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

	const beforeOverflow = [
		clean,
		canary,
		followed,
		tool,
		...untilCompaction,
		restoredChart,
		reopened,
		...rewritten,
	] as const;

	const all = [...beforeOverflow, ...overflow] as const;
	yield* restarted.stop;

	const stored = yield* storedIn(state, roots);
	const files = yield* listedIn(state);

	const left = leftOf({
		prompts: [run.clean.text, run.phi.text, followUp, readChart, handOff, tasks.lookUpAgain.asks],
		run,
		sessions: [session],
		stored,
		turns: all,
	});

	const phiChecks = [...phiChecksOf(phi), ...shownChecksOf({ harness: "claude", turns: phi })];

	const sealed = sealCheckOf({
		others: [clean, followed, handedOff, after, ...phi.inOrder, compacted, reopened, ...rewritten, ...overflow],
		sealing: [canary, tool, restoredChart],
	});

	const handles = handleChecksOf({
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

	const rewrites = answerChecksOf({
		all,
		canaries: left.canaries,
		files,
		handedOff,
		ids: {
			judged: tasks.judged.id,
			listed: tasks.listed.id,
			lookUp: tasks.lookUp.id,
			lookUpAgain: tasks.lookUpAgain.id,
			toolFirst: tasks.toolFirst.id,
			withheld: tasks.withheld.id,
		},
		judged,
		listed,
		reopened,
		status,
		toolFirst,
		withheld,
	});

	return {
		checks: yield* withCredentialRule(
			[...checksOf(left), ...handles, ...phiChecks, sealed, ...handing, ...rewrites, ...overflowChecks],
			() => breaches,
		),
		stored,
		turns: all,
	} satisfies Outcome;
});

export { claudePlay, claudeTurn, place };
