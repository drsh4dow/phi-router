import { Array, Config, Effect, FileSystem, Path, String as Str, Stream, Struct, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { CodexTurned, Listing, Outcome, Run } from "./checks.ts";
import { baaScript, catalogOf, catalogSlugsOf, execSessionOf, files, installed, openScript } from "./codex-mocks.ts";
import { codexChecksOf, leftOf, succeeded } from "./checks.ts";
import { during, followUp, withCredentialRule } from "./during.ts";
import { fakes, mocked } from "#tools/route/mocked-router.ts";
import { handOff, phiChecksOf, phiTurns, subagentChecksOf } from "./phi-checks.ts";
import type { Said } from "#router/client/mock-upstreams/index.ts";
import { routerProcess } from "#tools/route/router-process.ts";
import { storedIn } from "./stored.ts";

const plugin = decodeURIComponent(new URL("../../plugins/claude", import.meta.url).pathname);

const place = Effect.gen(function* place() {
	const fs = yield* FileSystem.FileSystem;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-home-" });
	const bundledCodexHome = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-codex-bundled-" });
	const routedCodexHome = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-codex-" });
	const work = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-work-" });

	return { bundledCodexHome, home, routedCodexHome, work };
});

type Place = Readonly<Effect.Success<typeof place>>;

const noUpdateCheck = "check_for_update_on_startup = false";

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

const routedOn = Effect.fnUntraced(function* routedOn(run: Run, where: Place) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.writeFileString(path.join(where.bundledCodexHome, "config.toml"), noUpdateCheck);

	const bundled = yield* codexRun({
		args: ["debug", "models"],
		codexHome: where.bundledCodexHome,
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

	yield* fs.writeFileString(path.join(where.routedCodexHome, "config.toml"), configOf(router.url));
	yield* installed({ home: where.routedCodexHome, plugin });

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

const promptBlocked = "hook: UserPromptSubmit Blocked";

const fallback = "Defaulting to fallback metadata";

const remote = "https://github.com/example/phi-wire.git";

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

const exec = ["exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust"];

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
			() => codexRun({ args, codexHome: where.routedCodexHome, folders, place: where, router }),
		);

		return Struct.assign(ran, {
			blocked: Str.includes(promptBlocked)(ran.stderr),
			fellBackToDefaultMetadata: Str.includes(fallback)(`${ran.stdout}${ran.stderr}`),
		}) satisfies CodexTurned;
	});

	const handingOff = Effect.gen(function* handingOff() {
		const handedOff = yield* turn([...exec, handOff]);
		const handing = yield* execSessionOf(handedOff.stderr);
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

	const [phi, { after, handedOff, handing }] = yield* Effect.all([phiTurns(resumed), handingOff], { concurrency: 1 });

	const [models, clean] = turns;

	const listing = {
		listedByCodex: yield* catalogSlugsOf(models.stdout),
		remote,
		servedByOpenMock: served,
	} satisfies Listing;

	const stored = yield* storedIn(state, roots);

	const left = leftOf({
		prompts: [run.clean.text, run.phi.text, followUp, readChart, handOff],
		run,
		sessions: [yield* execSessionOf(clean.stderr), handing],
		stored,
		turns: [...turns, ...phi.inOrder, handedOff, after] as const,
	});

	const checks = yield* withCredentialRule(
		[
			...codexChecksOf(Struct.assign(left, listing)),
			...phiChecksOf(phi),
			...subagentChecksOf({ after, handedOff, harness: "codex" }),
			{
				name: "codex blocks /phi and /phi pin in the prompt hook",
				ok: pipe(
					phi.inOrder,
					Array.every((turned) => turned.blocked),
				),
			},
		],
		() => breaches,
	);

	return { checks, stored, turns: left.turns } satisfies Outcome;
});

export { codexPlay, codexRun, configOf, gitRepo, place };
