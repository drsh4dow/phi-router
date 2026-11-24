import type { Asked, Said } from "#router/client/mock-upstreams/index.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Config, Effect, FileSystem, Path, String as Str, Stream, Struct } from "effect";
import type { Outcome, Run } from "./checks.ts";
import { checksOf, leftOf } from "./checks.ts";
import { claudeJudgeCheck, during, followUp, judgeCallsApart, withCredentialRule } from "./during.ts";
import { fakes, mocked } from "#tools/route/mocked-router.ts";
import {
	handOff,
	isSubagent,
	phiChecksOf,
	phiTurns,
	sealCheckOf,
	shownChecksOf,
	subagent,
	subagentChecksOf,
} from "./phi-checks.ts";
import { textEvents, toolEvents } from "#router/client/mock-upstreams/index.ts";
import { pluginCopy } from "#tools/plugin/copied.ts";
import { routerProcess } from "#tools/route/router-process.ts";
import { storedIn } from "./stored.ts";

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

/** A file the open mock asks Claude Code to read in the fourth turn. It holds no PHI. */
const planted = { name: "planted-notes.txt", text: "The build runs at noon on Fridays, after the lint step." };

const readPlanted = `Read the file ${planted.name} and tell me what it says.`;

const said = (texts: readonly string[]): Said => ({ events: Stream.fromIterable(textEvents(texts)), kind: "events" });

const calling = (call: { readonly id: string; readonly name: string; readonly input: string }): Said => ({
	events: Stream.fromIterable(toolEvents(call)),
	kind: "events",
});

/** The open mock's `Agent` call, which starts the plugin's pinned subagent. */
const startSubagent = calling({
	id: "toolu_wire_agent",
	input: `{"description":"Look up the member","prompt":"${subagent.prompt}","run_in_background":false,"subagent_type":"phi-router:phi-sealed"}`,
	name: "Agent",
});

/**
 * The open mock: text after a tool result, a `Read` of the planted file when the last message names it, the pinned
 * subagent's start when it asks for the hand-off, and `ok` otherwise.
 *
 * @param {string} file The planted file's absolute path.
 * @returns {Function} The script.
 */
const openScript =
	(file: string) =>
	(asked: Asked): Said => {
		if (Str.includes('"tool_result"')(asked.last)) {
			return said(["The note says the build runs at noon."]);
		}

		if (Str.includes(planted.name)(asked.last)) {
			return calling({ id: "toolu_wire_1", input: `{"file_path":"${file}"}`, name: "Read" });
		}

		if (Str.includes(handOff)(asked.last)) {
			return startSubagent;
		}

		return said(["ok"]);
	};

/**
 * The BAA mock: the pinned subagent's answer, which names the member, to the subagent, and `ok` otherwise.
 *
 * @param {Asked} asked What it was asked.
 * @returns {Said} Its answer.
 */
const baaScript = (asked: Asked): Said => {
	if (isSubagent(asked)) {
		return said([subagent.answer]);
	}

	return said(["ok"]);
};

/**
 * The three mocks, the router as its own process from the source entry, and a fresh place for `claude` with the
 * planted file in its working folder. Returns the router's state folder and `turn`, which plays one `claude -p` turn
 * and returns what each mock received during it.
 */
const setUp = Effect.fnUntraced(function* setUp(judgeSeals: (piece: string) => boolean) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const where = yield* place;
	const file = path.join(where.work, planted.name);

	yield* fs.writeFileString(file, planted.text);

	const { breaches, env, received, roots, state } = yield* mocked({
		baa: baaScript,
		configExtras: { sealedModel: fakes.sealedModel },
		holdsPhi: judgeSeals,
		judgeName: "claude",
		open: openScript(file),
	});

	const router = yield* routerProcess(["bun", "src/router/main.ts"], env);
	const folders = Struct.pick(env, ["XDG_CONFIG_HOME", "XDG_STATE_HOME"]);

	const turn = Effect.fnUntraced(function* turn(prompt: string, flags: readonly string[]) {
		return yield* during(
			() => received.pipe(Effect.map(judgeCallsApart)),
			() => claudeTurn({ folders, place: where, prompt, router: router.url, session: flags }),
		);
	});

	return { breaches, judging: received.pipe(Effect.map(claudeJudgeCheck)), roots, state, turn };
});

const session = "17171717-1717-4717-8717-171717171717";

const handingOff = "27272727-2727-4727-8727-272727272727";

const events = ["--output-format", "stream-json", "--verbose"];

const started = ["--session-id", session, ...events];

const resumed = ["--resume", session];

const resumedEvents = [...resumed, ...events];

const claudePlay = Effect.fnUntraced(function* claudePlay(run: Run) {
	const { breaches, judging, roots, state, turn } = yield* setUp(run.judgeSeals);

	const [clean, canary, followed, tool, handedOff, after] = yield* Effect.all(
		[
			turn(run.clean.text, started),
			turn(run.phi.text, resumedEvents),
			turn(followUp, resumedEvents),
			turn(readPlanted, resumedEvents),
			turn(handOff, ["--session-id", handingOff, ...events]),
			turn(followUp, ["--resume", handingOff, ...events]),
		],
		{ concurrency: 1 },
	);

	const phi = yield* phiTurns({
		clean: run.clean.text,
		command: (prompt) => turn(prompt, resumed),
		prompt: (prompt) => turn(prompt, resumedEvents),
	});

	const all = [clean, canary, followed, tool, ...phi.inOrder, handedOff, after] as const;
	const stored = yield* storedIn(state, roots);

	const left = leftOf({
		prompts: [run.clean.text, run.phi.text, followUp, readPlanted, handOff],
		run,
		sessions: [session, handingOff],
		stored,
		turns: all,
	});

	const phiChecks = [...phiChecksOf({ cleanText: run.clean.text, turns: phi }), ...shownChecksOf(phi)];
	const sealed = sealCheckOf([canary, clean, followed, tool, ...phi.inOrder]);

	const handing = subagentChecksOf({ after, handedOff, harness: "claude" });

	return {
		checks: yield* withCredentialRule(
			[...checksOf(left), ...phiChecks, sealed, ...handing, yield* judging],
			() => breaches,
		),
		stored,
		turns: all,
	} satisfies Outcome;
});

export { claudePlay, claudeTurn, place };
