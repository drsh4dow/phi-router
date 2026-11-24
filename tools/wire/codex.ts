import { Array, Config, Effect, FileSystem, Path, String as Str, Stream, Struct, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { CodexTurned, Listing, Outcome, Run } from "./checks.ts";
import { baaScript, catalogOf, files, installed, listedIn, openScript, sessionOf } from "./codex-mocks.ts";
import { codexChecksOf, leftOf, succeeded } from "./checks.ts";
import { during, followUp, withCredentialRule } from "./during.ts";
import { fakes, mocked } from "#tools/route/mocked-router.ts";
import { handOff, phiChecksOf, phiTurns, subagentChecksOf } from "./phi-checks.ts";
import type { Said } from "#router/client/mock-upstreams/index.ts";
import { routerProcess } from "#tools/route/router-process.ts";
import { storedIn } from "./stored.ts";

/** The plugin in this checkout, whose hooks every routed `codex` run loads. */
const plugin = decodeURIComponent(new URL("../../plugins/claude", import.meta.url).pathname);

/** A fresh home, a `CODEX_HOME` with no provider, one that points at the router, and a working folder for `codex`. */
const place = Effect.gen(function* place() {
	const fs = yield* FileSystem.FileSystem;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-home-" });
	const bundled = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-codex-bundled-" });
	const routed = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-codex-" });
	const work = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-work-" });

	return { bundled, home, routed, work };
});

type Place = Readonly<Effect.Success<typeof place>>;

/** Codex's update prompt starts a global install, so every `CODEX_HOME` of the run turns the check off. */
const noUpdateCheck = "check_for_update_on_startup = false";

/**
 * The config of a `CODEX_HOME` whose provider is the router. The login is `auth.command` printing the fake harness
 * token beside a fake `ChatGPT-Account-ID`, so the run needs no ChatGPT login. Analytics and plugins are off, because
 * with them on `codex exec` called chatgpt.com, ab.chatgpt.com and github.com in a probe.
 *
 * @param {string} router The router's URL.
 * @returns {string} The `config.toml` text.
 */
const configOf = (router: string): string =>
	Array.join(
		[
			noUpdateCheck,
			'model = "phi/auto"',
			'model_provider = "phi"',
			"[analytics]",
			"enabled = false",
			"[features]",
			"plugins = false",
			"[model_providers.phi]",
			'name = "phi"',
			`base_url = "${router}/v1"`,
			'wire_api = "responses"',
			"request_max_retries = 0",
			"stream_max_retries = 0",
			`http_headers = { "ChatGPT-Account-ID" = "${fakes.accountId}" }`,
			"[model_providers.phi.auth]",
			'command = "echo"',
			`args = ["${fakes.harnessToken}"]`,
		],
		"\n",
	);

/**
 * One `codex` run with `run.args` in the working folder and `CODEX_HOME` `run.codexHome`. Its environment holds nothing
 * of the caller's beside `PATH`, but the plugin's folder, the router's address and the router's XDG folders, which its
 * hooks read. Its stdin is closed.
 * Returns the exit code and what it printed on each stream.
 */
const codexRun = Effect.fnUntraced(
	function* codexRun(run: {
		readonly place: Place;
		readonly codexHome: string;
		readonly args: readonly string[];
		readonly folders: Readonly<Record<string, string>>;
		readonly router: string;
	}) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const searchPath = yield* Config.String("PATH");

		const command = ChildProcess.make("codex", run.args, {
			cwd: run.place.work,
			env: Struct.assign(run.folders, {
				CODEX_HOME: run.codexHome,
				HOME: run.place.home,
				PATH: searchPath,
				PHI_ROUTER_ADDRESS: run.router,
				PLUGIN_ROOT: plugin,
			}),
			extendEnv: false,
			stdin: "ignore",
		});

		const handle = yield* spawner.spawn(command);

		const [stdout = "", stderr = ""] = yield* Effect.forEach(
			[handle.stdout, handle.stderr],
			(stream) => Stream.mkString(Stream.decodeText(stream)),
			{ concurrency: 2 },
		);

		const exitCode = yield* handle.exitCode;

		return { exitCode, printed: `${stdout}${stderr}`, stderr, stdout };
	},
	Effect.scoped,
	Effect.timeout("3 minutes"),
);

const ok = 200;

/** The three mocks, the open one serving the bundled catalog with the target model, and the router as its own process. */
const routedOn = Effect.fnUntraced(function* routedOn(run: Run, where: Place) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.writeFileString(path.join(where.bundled, "config.toml"), noUpdateCheck);

	const bundled = yield* codexRun({
		args: ["debug", "models"],
		codexHome: where.bundled,
		folders: {},
		place: where,
		router: "",
	});

	const served = yield* catalogOf(bundled.stdout);

	const { breaches, env, received, roots, state } = yield* mocked({
		baa: baaScript,
		catalog: (): Said => ({ body: served.body, kind: "status", status: ok }),
		configExtras: { sealedModel: fakes.sealedModel },
		harness: "codex",
		holdsPhi: run.judgeSeals,
		open: openScript,
	});

	const router = yield* routerProcess(["bun", "src/router/main.ts"], env);

	yield* fs.writeFileString(path.join(where.routed, "config.toml"), configOf(router.url));
	yield* installed({ home: where.routed, plugin });

	return {
		breaches,
		folders: Struct.pick(env, ["XDG_CONFIG_HOME", "XDG_STATE_HOME"]),
		received,
		roots,
		router: router.url,
		served: served.slugs,
		state,
	};
});

/** What `codex exec` prints on stderr when the prompt-submit hook blocks the prompt. It shows the reason nowhere. */
const promptBlocked = "hook: UserPromptSubmit Blocked";

/** What Codex prints when no catalog entry names the model. */
const fallback = "Defaulting to fallback metadata";

/** The working folder's `origin`. Codex 0.166.0 sends a git folder's remotes in its turn metadata. */
const remote = "https://github.com/example/phi-wire.git";

/**
 * The working folder as a git repository with one commit and an `origin` remote. Git reads no config beyond the
 * repository's own, and writes none.
 */
const gitRepo = Effect.fnUntraced(function* gitRepo(where: Place) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const searchPath = yield* Config.String("PATH");
	const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: where.home, PATH: searchPath };
	const identity = ["-c", "user.name=phi-wire", "-c", "user.email=phi-wire@example.invalid"];

	const steps = [
		["init", "-q"],
		["add", "-A"],
		[...identity, "commit", "-q", "-m", "Plant the notes and the chart."],
		["remote", "add", "origin", remote],
	];

	yield* Effect.forEach(
		steps,
		(args) =>
			spawner
				.exitCode(ChildProcess.make("git", args, { cwd: where.work, env, extendEnv: false, stdin: "ignore" }))
				.pipe(
					Effect.filterOrFail(
						(code) => code === succeeded,
						(code) => `git ${Array.join(args, " ")} exited ${String(code)}`,
					),
				),
		{ concurrency: 1 },
	);
});

/** The plugin's hooks are trusted in a TUI. A run with no TUI trusts them with this flag. */
const exec = ["exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust"];

/**
 * The routed `CODEX_HOME` and the planted files in a git repository: a clean note, and a chart holding the PHI case's text. Returns the
 * state folder, the slugs served and `turn`, which plays one `codex` run against the router and returns what each mock
 * received during it.
 */
const setUp = Effect.fnUntraced(function* setUp(run: Run) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const where = yield* place;
	const { breaches, folders, received, roots, router, served, state } = yield* routedOn(run, where);

	yield* fs.writeFileString(path.join(where.work, files.notes), "The build runs at noon on Fridays.");
	yield* fs.writeFileString(path.join(where.work, files.chart), run.phi.text);
	yield* gitRepo(where);

	const turn = Effect.fnUntraced(function* turn(args: readonly string[]) {
		const ran = yield* during(
			() => received,
			() => codexRun({ args, codexHome: where.routed, folders, place: where, router }),
		);

		return Struct.assign(ran, {
			blocked: Str.includes(promptBlocked)(ran.stderr),
			fellBackToDefaultMetadata: Str.includes(fallback)(`${ran.stdout}${ran.stderr}`),
		}) satisfies CodexTurned;
	});

	const handingOff = Effect.gen(function* handingOff() {
		const handedOff = yield* turn([...exec, handOff]);
		const handing = yield* sessionOf(handedOff.stderr);
		const after = yield* turn([...exec, "resume", handing, followUp]);

		return { after, handedOff, handing };
	});

	return { breaches, handingOff, roots, served, state, turn };
});

const readChart = `Read the file ${files.chart} and tell me what it says.`;

const codexPlay = Effect.fnUntraced(function* codexPlay(run: Run) {
	const { breaches, handingOff, roots, served, state, turn } = yield* setUp(run);
	const resumed = (prompt: string): ReturnType<typeof turn> => turn([...exec, "resume", "--last", prompt]);

	const turns = yield* Effect.all(
		[
			turn(["debug", "models"]),
			turn([...exec, run.clean.text]),
			resumed(run.phi.text),
			resumed(followUp),
			resumed(readChart),
		],
		{ concurrency: 1 },
	);

	const [phi, { after, handedOff, handing }] = yield* Effect.all(
		[phiTurns({ clean: run.clean.text, command: resumed, prompt: resumed }), handingOff],
		{ concurrency: 1 },
	);

	const [models, clean] = turns;
	const listing = { listed: yield* listedIn(models.stdout), remote, served } satisfies Listing;
	const stored = yield* storedIn(state, roots);

	const left = leftOf({
		prompts: [run.clean.text, run.phi.text, followUp, readChart, handOff],
		run,
		sessions: [yield* sessionOf(clean.stderr), handing],
		stored,
		turns: [...turns, ...phi.inOrder, handedOff, after] as const,
	});

	const checks = yield* withCredentialRule(
		[
			...codexChecksOf(Struct.assign(left, listing)),
			...phiChecksOf({ cleanText: run.clean.text, turns: phi }),
			...subagentChecksOf({ after, handedOff, harness: "codex" }),
			{
				name: "codex blocks /phi, /phi pin and /phi unpin in the prompt hook",
				ok: pipe(
					[phi.status, phi.pin, phi.unpin],
					Array.every((turned) => turned.blocked),
				),
			},
		],
		() => breaches,
	);

	return { checks, stored, turns: left.turns } satisfies Outcome;
});

export { codexPlay, codexRun, configOf, place };
