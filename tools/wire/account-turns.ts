import { Array, Config, Effect, FileSystem, Path, Stream, Struct } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { place as claudePlace, claudeTurn } from "./claude.ts";
import { place as codexPlace, codexRun, configOf } from "./codex.ts";
import { place as piPlace, piRun } from "./pi-run.ts";
import { piWire } from "#router/features/route/index.ts";
import { voidedSsn } from "./cases.ts";

const clean = "Reply with the single word ok.";

const canary = `Reply with the single word ok. The member's SSN is ${voidedSsn}.`;

const overdueFile = "overdue.txt";

const overdueId = "p-4821";

const record = Array.join(
	[
		"Claims follow-up queue",
		`patient_id ${overdueId}, claim reference ${voidedSsn}, payment overdue since 2026-10-01`,
		"patient_id p-4822, payment received 2026-10-03",
		"",
	],
	"\n",
);

const lookUp = `Run cat ${overdueFile}. Which patient_id has an overdue payment? Answer with the patient_id alone.`;

const quote = `Run cat ${overdueFile}. Then have the phi-router:phi-sealed subagent quote the claim reference of the overdue payment exactly as written, and tell me what it returned.`;

const delegated = `Read ${overdueFile}. Which patient_id has an overdue payment? A part shown as [sealed hN] holds patient identifiers: start a leaf delegate on model phi/sealed with a task that names the handle, wait for its answer, then answer with the patient_id alone.`;

const sessions = {
	autoMode: "29292929-2929-4929-8929-292929292932",
	prompts: "29292929-2929-4929-8929-292929292929",
	sealedAnswer: "29292929-2929-4929-8929-292929292931",
	toolResult: "29292929-2929-4929-8929-292929292930",
} as const;

type StepName =
	| "prompts"
	| "tool result"
	| "sealed answer"
	| "sealed answer in auto mode"
	| "tool result through pi-harness";

interface Routed {
	readonly url: string;
	readonly folders: Readonly<Record<string, string>>;
}

interface Turn {
	readonly exitCode: number;
	readonly printed: string;
}

interface Step {
	readonly name: StepName;
	readonly play: Effect.Effect<readonly Turn[], never, Needs>;
}

type Needs = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

const timedOut = -1;

const turnsOn = {
	claude: Effect.fnUntraced(function* claudeSteps(routed: Routed) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const where = yield* claudePlace;

		yield* fs.writeFileString(path.join(where.work, overdueFile), record);

		const turn = (
			prompt: string,
			flags: readonly string[],
			folders: Routed["folders"],
		): Effect.Effect<Turn, never, Needs> =>
			claudeTurn({
				folders,
				place: where,
				prompt,
				router: routed.url,
				session: ["--output-format", "stream-json", "--verbose", ...flags],
			}).pipe(
				Effect.map(({ exitCode, printed }): Turn => ({ exitCode, printed })),
				Effect.catchTag("TimeoutError", () => Effect.succeed({ exitCode: timedOut, printed: "" })),
				Effect.orDie,
			);

		const fresh = (
			session: string,
			prompt: string,
			flags: readonly string[],
		): Effect.Effect<readonly Turn[], never, Needs> =>
			Effect.map(turn(prompt, ["--session-id", session, ...flags], routed.folders), Array.of);

		const classifierThroughRouter = Struct.assign(routed.folders, { CLAUDE_CODE_AUTO_MODE_SERVER: "0" });

		const steps: readonly Step[] = [
			{
				name: "prompts",
				play: Effect.all(
					[
						turn(clean, ["--session-id", sessions.prompts], routed.folders),
						turn(canary, ["--resume", sessions.prompts], routed.folders),
					],
					{
						concurrency: 1,
					},
				),
			},
			{ name: "tool result", play: fresh(sessions.toolResult, lookUp, []) },
			{ name: "sealed answer", play: fresh(sessions.sealedAnswer, quote, []) },
			{
				name: "sealed answer in auto mode",
				play: Effect.map(
					turn(quote, ["--session-id", sessions.autoMode, "--permission-mode", "auto"], classifierThroughRouter),
					Array.of,
				),
			},
		];

		return steps;
	}),
	codex: Effect.fnUntraced(function* codexSteps(routed: Routed) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const where = yield* codexPlace;
		const exec = ["exec", "--skip-git-repo-check", "--json"];

		yield* fs.writeFileString(path.join(where.routedCodexHome, "config.toml"), configOf(routed.url));

		const turn = (args: readonly string[]): Effect.Effect<Turn, never, Needs> =>
			codexRun({
				args,
				codexHome: where.routedCodexHome,
				folders: routed.folders,
				place: where,
				router: routed.url,
			}).pipe(
				Effect.map((ran): Turn => ({ exitCode: ran.exitCode, printed: ran.stdout })),
				Effect.orDie,
			);

		const steps: readonly Step[] = [
			{
				name: "prompts",
				play: Effect.all([turn([...exec, clean]), turn([...exec, "resume", "--last", canary])], { concurrency: 1 }),
			},
		];

		return steps;
	}),
	pi: Effect.fnUntraced(function* piSteps(routed: Routed) {
		const path = yield* Path.Path;
		const where = yield* piPlace;
		const extension = path.resolve(import.meta.dirname, "../../plugins/pi/extension.mjs");
		const env = Struct.assign(routed.folders, { [piWire.portVariable]: new URL(routed.url).port });
		const flags = ["--model", "phi/auto", "--session-id", sessions.prompts, "--mode", "json"];

		const turn = (prompt: string): Effect.Effect<Turn, never, Needs> =>
			piRun(where, ["-e", extension, "-p", prompt, ...flags], { env }).pipe(
				Effect.map(({ exitCode, printed }): Turn => ({ exitCode, printed })),
				Effect.orDie,
			);

		const steps: readonly Step[] = [
			{
				name: "prompts",
				play: Effect.all([turn(clean), turn(canary)], { concurrency: 1 }),
			},
		];

		return steps;
	}),
	"pi-harness": Effect.fnUntraced(function* piHarnessSteps(routed: Routed) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const path = yield* Path.Path;
		const checkout = yield* Config.String("PHI_PI_HARNESS");

		const passed = yield* Config.all({
			PATH: Config.String("PATH"),
			XDG_RUNTIME_DIR: Config.String("XDG_RUNTIME_DIR"),
		});

		const env = Struct.assign(passed, {
			PHI_ACCOUNTS_OFFLINE: routed.folders["PHI_ACCOUNTS_OFFLINE"] ?? "",
			PHI_ACCOUNTS_PROMPT: delegated,
			PHI_ACCOUNTS_RECORD: record,
			PHI_ROUTER_CHECKOUT: path.resolve(import.meta.dirname, "../.."),
			PHI_ROUTER_CONFIG_HOME: routed.folders["XDG_CONFIG_HOME"] ?? "",
			PHI_ROUTER_PORT: new URL(routed.url).port,
			PHI_ROUTER_STATE: routed.folders["XDG_STATE_HOME"] ?? "",
		});

		const script = path.join(checkout, "src/features/phi/delegates/accounts.sh");

		const turn = Effect.gen(function* piHarnessTurn() {
			const handle = yield* spawner.spawn(
				ChildProcess.make("sh", [script], { env, extendEnv: false, stdin: "pipe" }),
			);

			const printed = yield* Stream.mkString(Stream.decodeText(Stream.drainFork(handle.stdout, handle.stderr)));
			const exitCode = yield* handle.exitCode;

			return { exitCode, printed } satisfies Turn;
		}).pipe(
			Effect.scoped,
			Effect.timeoutOrElse({
				duration: "5 minutes",
				orElse: () => Effect.succeed({ exitCode: timedOut, printed: "" }),
			}),
			Effect.orDie,
		);

		const steps: readonly Step[] = [
			{
				name: "tool result through pi-harness",
				play: turn.pipe(Effect.map(Array.of)),
			},
		];

		return steps;
	}),
} as const;

export { delegated, lookUp, overdueFile, overdueId, quote, turnsOn };

export type { StepName, Turn };
