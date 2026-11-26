import {
	Array,
	Config,
	Effect,
	FileSystem,
	Option,
	Path,
	Schedule,
	Schema,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Check } from "./checks.ts";
import type { ClaudeSettings } from "#tools/claude/configured.ts";
import type { Received } from "./during.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { during } from "./during.ts";
import { fakes } from "#tools/route/mocked-router.ts";
import { isModelPost } from "./stored.ts";
import { pluginCopy } from "#tools/plugin/copied.ts";
import { succeeded } from "./checks.ts";
import { writeSettings } from "#tools/claude/configured.ts";

const place = Effect.gen(function* place() {
	const fs = yield* FileSystem.FileSystem;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-home-" });
	const config = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-claude-" });
	const work = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-work-" });
	const plugin = yield* pluginCopy;

	return { config, home, plugin, work };
});

type Place = Readonly<Effect.Success<typeof place>>;

const claudeEnvOf = Effect.fnUntraced(function* claudeEnvOf(turn: {
	readonly folders: Readonly<Record<string, string>>;
	readonly place: Place;
	readonly router: string;
}) {
	const searchPath = yield* Config.String("PATH");

	return Struct.assign(turn.folders, {
		ANTHROPIC_AUTH_TOKEN: fakes.harnessToken,
		ANTHROPIC_BASE_URL: turn.router,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CONFIG_DIR: turn.place.config,
		DISABLE_ERROR_REPORTING: "1",
		DISABLE_TELEMETRY: "1",
		HOME: turn.place.home,
		PATH: searchPath,
		TZ: "UTC",
	});
});

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
		const env = yield* claudeEnvOf(turn);

		const args = [
			"-p",
			turn.prompt,
			"--model",
			"phi/auto",
			"--allowedTools",
			"Read,Bash,Edit",
			"--plugin-dir",
			turn.place.plugin,
		];

		const command = ChildProcess.make("claude", [...args, ...turn.session], {
			cwd: path.resolve(turn.place.work),
			env,
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

const window = { height: "50", name: "claude", width: "120" } as const;

const pasteSettles = "1 second";

const rowSettles = "3 seconds";

const timedOut = 1;

const nextRow = 1;

const userLine = "user-status-line";

const statusRow = "phi · ";

const hookSaid = /(?:SessionStart|Stop|UserPromptSubmit|PreCompact)(?::\w+)? says:/u;

const noBreakSpace = "\u00A0";

const Onboarded = Schema.fromJsonString(Schema.Unknown);

interface Step {
	readonly typed: string;
	readonly done: (pane: string) => boolean;
}

interface Windowed {
	readonly exitCode: number;
	readonly printed: string;
	readonly printedTail: string;
	readonly piecesJudged: number;
	readonly open: readonly Sent[];
	readonly baa: readonly Sent[];
}

const rowsOf = (pane: string): readonly string[] => {
	const lines = Str.split(pane, "\n");

	return pipe(
		lines,
		Array.findLastIndex(Str.startsWith("❯")),
		Option.match({ onNone: () => [], onSome: (prompt) => Array.drop(lines, prompt + nextRow) }),
		Array.map(Str.trim),
	);
};

const paneOf = (captured: string): string =>
	pipe(
		Str.split(Str.replaceAll(noBreakSpace, " ")(captured), "\n"),
		Array.map(Str.trimEnd),
		Array.filter((row) => Str.isNonEmpty(row) && !Str.startsWith("─")(row)),
		Array.join("\n"),
	);

const showsRow = (pane: string): boolean => pipe(rowsOf(pane), Array.some(Str.startsWith(statusRow)));

const showsUserLine = (pane: string): boolean => pipe(rowsOf(pane), Array.contains(userLine));

const afterLast = (pane: string, echoed: string): string =>
	pipe(
		Str.split(pane, echoed),
		Array.last,
		Option.getOrElse(() => ""),
	);

interface WindowRun {
	readonly env: Readonly<Record<string, string>>;
	readonly args: readonly string[];
	readonly place: Place;
	readonly received: () => Effect.Effect<Received>;
	readonly started: (pane: string) => boolean;
}

const openWindow = Effect.fnUntraced(function* openWindow(run: WindowRun) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const socket = path.join(run.place.home, "tmux.sock");
	const env = Struct.assign(run.env, { TERM: "xterm-256color" });

	const tmux = (args: readonly string[]): ReturnType<typeof spawner.string> =>
		spawner.string(
			ChildProcess.make("tmux", ["-S", socket, ...args], {
				cwd: run.place.work,
				env,
				extendEnv: false,
				stdin: "ignore",
			}),
		);

	const pane = tmux(["capture-pane", "-p", "-J", "-S", "-", "-t", window.name]).pipe(Effect.map(paneOf));

	const settled = Effect.fnUntraced(function* settled(done: (shown: string) => boolean) {
		const shown = yield* pane.pipe(
			Effect.repeat({ schedule: Schedule.spaced("1 second"), until: done }),
			Effect.timeoutOption("2 minutes"),
		);

		yield* Effect.sleep(rowSettles);

		const printed = yield* pane;

		return { exitCode: Option.match(shown, { onNone: () => timedOut, onSome: () => succeeded }), printed };
	});

	const opened = ["-d", "-s", window.name, "-x", window.width, "-y", window.height];
	const claude = ["claude", "--plugin-dir", run.place.plugin, ...run.args];

	yield* Effect.acquireRelease(tmux(["new-session", ...opened, ...claude]), () =>
		Effect.ignore(tmux(["kill-server"])),
	);

	const start: Windowed = yield* during(run.received, () => settled(run.started));

	const typed = (step: Step): Effect.Effect<Windowed, Effect.Error<typeof pane>> =>
		during(run.received, () =>
			Effect.gen(function* typing() {
				yield* tmux(["send-keys", "-t", window.name, "-l", step.typed]);
				yield* Effect.sleep(pasteSettles);
				yield* tmux(["send-keys", "-t", window.name, "Enter"]);

				return yield* settled(step.done);
			}),
		);

	return { start, typed };
});

const windowSettings = Effect.fnUntraced(function* windowSettings(at: Place, settings: ClaudeSettings) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const onboarded = { hasCompletedOnboarding: true, projects: { [at.work]: { hasTrustDialogAccepted: true } } };
	const text = yield* Schema.encodeEffect(Onboarded)(onboarded);

	yield* writeSettings(at.config, Struct.assign(settings, { disableDeepLinkRegistration: "disable" as const }));
	yield* fs.writeFileString(path.join(at.config, ".claude.json"), text);
});

interface Windows {
	readonly beside: Windowed;
	readonly phi: Windowed;
	readonly after: Windowed;
	readonly otherModel: Windowed;
	readonly alone: Windowed;
}

const claudeWindows = Effect.fnUntraced(function* claudeWindows(run: {
	readonly env: Readonly<Record<string, string>>;
	readonly place: Place;
	readonly received: () => Effect.Effect<Received>;
	readonly session: string;
	readonly clean: string;
}) {
	const opened = (model: string, started: (pane: string) => boolean): WindowRun =>
		Struct.assign(Struct.pick(run, ["env", "place", "received"]), {
			args: ["--resume", run.session, "--model", model],
			started,
		});

	yield* windowSettings(run.place, { statusLine: { command: `echo ${userLine}`, type: "command" } });

	const typedIn = yield* Effect.scoped(
		Effect.gen(function* typedIn() {
			const beside = yield* openWindow(opened("phi/auto", showsRow));

			const phi = yield* beside.typed({
				done: Str.includes(`⎿  phi-router: session ${run.session}`),
				typed: "/phi",
			});

			const after = yield* beside.typed({
				done: (pane) => Str.includes("● ok")(afterLast(pane, `❯ ${run.clean}`)),
				typed: run.clean,
			});

			return { after, beside: beside.start, phi };
		}),
	);

	const otherModel = yield* Effect.scoped(openWindow(opened("claude-sonnet-4-5", showsUserLine)));

	yield* windowSettings(run.place, {});

	const alone = yield* Effect.scoped(openWindow(opened("phi/auto", showsRow)));

	return Struct.assign(typedIn, { alone: alone.start, otherModel: otherModel.start }) satisfies Windows;
});

const noJudgeCalls = 0;

const replyOf = (phi: Windowed): string => afterLast(phi.printed, "❯ /phi-router:phi");

const holdsStatus = ({ body }: Sent): boolean => Str.includes("Sealed lane:")(body);

const windowChecksOf = (played: { readonly windows: Windows; readonly session: string }): readonly Check[] => {
	const { after, alone, beside, otherModel, phi } = played.windows;
	const besideRows = rowsOf(beside.printed);
	const userAt = Array.findFirstIndex(besideRows, (row) => row === userLine);
	const reply = replyOf(phi);
	const afterPhi = [...after.open, ...after.baa];
	const [aloneFirst = ""] = rowsOf(alone.printed);

	return [
		{
			name: "with a status line of the user's, Claude Code on phi/auto shows phi-router's row right under it",
			ok: Option.exists(userAt, (at) =>
				Option.exists(Array.get(besideRows, at + nextRow), Str.startsWith(statusRow)),
			),
		},
		{
			name: "/phi in the window answers with the plain reply phi-router: session …, no blocked-by-hook header and no Original prompt line",
			ok:
				Str.includes(`⎿  phi-router: session ${played.session}`)(reply) &&
				!Str.includes("blocked by hook")(reply) &&
				!Str.includes("Original prompt")(reply),
		},
		{
			name: "/phi in the window sends no model request and no judge call",
			ok: phi.piecesJudged === noJudgeCalls && !pipe([...phi.open, ...phi.baa], Array.some(isModelPost)),
		},
		{
			name: "the model request after /phi in the window does not carry the status /phi showed",
			ok: pipe(afterPhi, Array.some(isModelPost)) && !pipe(afterPhi, Array.some(holdsStatus)),
		},
		{
			name: "on claude-sonnet-4-5, a model the router routes too, the window shows the user's status line and phi-router's row",
			ok: showsUserLine(otherModel.printed) && showsRow(otherModel.printed),
		},
		{
			name: "after the overflow, phi-router's row marks it with the stamp's HH:MM",
			ok: pipe(rowsOf(beside.printed), Array.some(Str.includes(" overflow till "))),
		},
		{
			name: "no window shows a line a hook of phi-router said, at the session's start or after a turn",
			ok: !pipe(
				[beside, phi, after, otherModel, alone],
				Array.some(({ printed }) => hookSaid.test(printed)),
			),
		},
		{
			name: "with no status line of the user's, Claude Code on phi/auto shows phi-router's row alone",
			ok: Str.startsWith(statusRow)(aloneFirst) && !showsUserLine(alone.printed),
		},
	];
};

export { claudeEnvOf, claudeTurn, claudeWindows, place, windowChecksOf };
