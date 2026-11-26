import { Array, Config, Effect, FileSystem, Option, Path, String as Str, Stream, Struct, pipe } from "effect";
import type { Asked, Said } from "#router/client/mock-upstreams/index.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Outcome, Run } from "./checks.ts";
import { checksOf, leftOf } from "./checks.ts";
import { during, followUp, withCredentialRule } from "./during.ts";
import { fakes, mocked } from "#tools/route/mocked-router.ts";
import {
	handOff,
	handleChecksOf,
	insideStamp,
	isSubagent,
	overflowChecksOf,
	phiChecksOf,
	phiTurns,
	refusing,
	sealCheckOf,
	shownChecksOf,
	subagent,
	subagentChecksOf,
} from "./phi-checks.ts";
import { overflowing, stampClockIn, storedIn } from "./stored.ts";
import { textEvents, toolEvents } from "#router/client/mock-upstreams/index.ts";
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
			"Read",
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

const chart = "planted-chart.txt";

const readChart = `Read the file ${chart} and tell me what it says.`;

const sealedWithRestoredChart = "Go on.";

const handOffAgain = "Ask the pinned subagent for that member's internal id once more.";

const said = (texts: readonly string[]): Said => ({ events: Stream.fromIterable(textEvents(texts)), kind: "events" });

interface Call {
	readonly id: string;
	readonly name: string;
	readonly input: string;
}

const calling = (call: Call): Said => ({ events: Stream.fromIterable(toolEvents(call)), kind: "events" });

const lookUp = (id: string): Call => ({
	id,
	input: `{"description":"Look up the member","prompt":"${subagent.prompt} The member is in h1.","run_in_background":false,"subagent_type":"phi-router:phi-sealed"}`,
	name: "Agent",
});

const openScript = (file: string): ((asked: Asked) => Said) => {
	const calls = [
		{ asks: readChart, call: { id: "toolu_wire_read", input: `{"file_path":"${file}"}`, name: "Read" } },
		{ asks: handOff, call: lookUp("toolu_wire_agent") },
		{ asks: handOffAgain, call: lookUp("toolu_wire_agent_again") },
	];

	return ({ body }) =>
		pipe(
			calls,
			Array.findFirst(({ asks, call }) => Str.includes(asks)(body) && !Str.includes(call.id)(body)),
			Option.match({ onNone: () => said(["ok"]), onSome: ({ call }) => calling(call) }),
		);
};

const baaScript = (asked: Asked): Said => {
	if (isSubagent(asked)) {
		return said([subagent.answer]);
	}

	return said(["ok"]);
};

const setUp = Effect.fnUntraced(function* setUp(run: Run) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const where = yield* place;
	const file = path.join(where.work, chart);

	yield* fs.writeFileString(file, run.phi.text);

	const { breaches, env, received, roots, state } = yield* mocked({
		baa: baaScript,
		configExtras: { sealedModel: fakes.sealedModel },
		holdsPhi: run.judgeSeals,
		open: refusing(openScript(file)),
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

	return { breaches, roots, routed, state };
});

const session = "17171717-1717-4717-8717-171717171717";

const events = ["--output-format", "stream-json", "--verbose"];

const started = ["--session-id", session, ...events];

const resumed = ["--resume", session];

const resumedEvents = [...resumed, ...events];

const claudePlay = Effect.fnUntraced(function* claudePlay(run: Run) {
	const { breaches, roots, routed, state } = yield* setUp(run);
	const first = yield* routed;

	const [clean, canary, followed, tool, handedOff, after] = yield* Effect.all(
		[
			first.turn(run.clean.text, started),
			first.turn(run.phi.text, resumedEvents),
			first.turn(followUp, resumedEvents),
			first.turn(readChart, resumedEvents),
			first.turn(handOff, resumedEvents),
			first.turn(followUp, resumedEvents),
		],
		{ concurrency: 1 },
	);

	const phi = yield* phiTurns((prompt) => first.turn(prompt, resumed));
	const compacted = yield* first.turn("/compact", resumed);

	yield* first.stop;

	const restarted = yield* routed;
	const restoredChart = yield* restarted.turn(sealedWithRestoredChart, resumedEvents);
	const reopened = yield* restarted.turn(handOffAgain, resumedEvents);

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
	const beforeOverflow = [clean, canary, followed, tool, ...untilCompaction, restoredChart, reopened] as const;
	const all = [...beforeOverflow, ...overflow] as const;
	const stored = yield* storedIn(state, roots);

	const left = leftOf({
		prompts: [run.clean.text, run.phi.text, followUp, readChart, handOff, handOffAgain],
		run,
		sessions: [session],
		stored,
		turns: all,
	});

	const phiChecks = [...phiChecksOf(phi), ...shownChecksOf({ harness: "claude", turns: phi })];

	const sealed = sealCheckOf({
		others: [clean, followed, after, ...phi.inOrder, compacted, ...overflow],
		sealing: [canary, tool, handedOff, restoredChart, reopened],
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

	const handing = subagentChecksOf({ after, answer: "h3", handedOff, harness: "claude" });

	return {
		checks: yield* withCredentialRule(
			[...checksOf(left), ...handles, ...phiChecks, sealed, ...handing, ...overflowChecks],
			() => breaches,
		),
		stored,
		turns: all,
	} satisfies Outcome;
});

export { claudePlay, claudeTurn, place };
