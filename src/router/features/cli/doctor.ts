import {
	Array,
	Console,
	Effect,
	Layer,
	Match,
	Option,
	Random,
	Schedule,
	Schema,
	String as Str,
	Struct,
	pipe,
} from "effect";
import type { Arrived, Vendor } from "#router/client/mock-world.ts";
import { Listener, listensOn } from "#router/client/server.ts";
import {
	auto,
	claudeEnv,
	claudeSettings,
	exempted,
	exemption,
	modelAddress,
	plugin,
	routerAddress,
	shellLists,
} from "./claude-settings.ts";
import { claudeTurn, installedPlugin, userSettings } from "#router/client/claude-code.ts";
import type { Own } from "./claude-settings.ts";
import type { Turn } from "#router/client/harness-turn.ts";
import type { UserSettings } from "#router/client/claude-code.ts";
import { mockWorld } from "#router/client/mock-world.ts";

/** One line of the doctor's report: a claim about the installation, and whether it holds. */
interface Check {
	readonly name: string;
	readonly passed: boolean;
}

class DoctorFailed extends Schema.TaggedError<DoctorFailed, { readonly brand: unique symbol }>()("DoctorFailed", {
	failed: Schema.Int,
	harness: Schema.String,
	next: Schema.String,
}) {
	public override get message(): string {
		return `phi-router doctor ${this.harness}: failed checks: ${String(this.failed)}. ${this.next}`;
	}
}

const exitedCleanly = 0;

const noneFailed = 0;

const anyFreePort = 0;

/** What `doctor claude` finds before its canary run: the user's settings, the shell's lists, and the plugin's install. */
interface Found {
	readonly installed: boolean;
	readonly settings: UserSettings;
	readonly shell: Own["shell"];
}

const canaryRange = { high: 1_000_000_000, low: 0 } as const;

/**
 * One check per setting `on claude` writes, which holds when the `env` block has its value, one that holds when the list
 * of hosts Claude Code reaches without a proxy, from its settings over the shell, takes it to the router, and two for
 * the plugin, which hold when `enabledPlugins` holds its id at `true` and Claude Code installed it.
 *
 * @param {object} found What the user's settings and shell hold, and whether Claude Code installed the plugin.
 * @param {boolean} found.installed Whether Claude Code installed the plugin.
 * @param {UserSettings} found.settings What the user's settings hold.
 * @param {object} found.shell `no_proxy` and `NO_PROXY` as the shell gives them.
 * @returns {readonly Check[]} The checks.
 */
const settingsChecks = ({ installed, settings, shell }: Found): readonly Check[] => [
	...pipe(
		claudeSettings,
		Array.map(({ name, value }) => ({ name: `${name} is ${value}`, passed: settings.env[name] === value })),
	),
	{
		name: `no_proxy or NO_PROXY takes Claude Code to ${routerAddress} without a proxy`,
		passed: Option.isNone(exemption(routerAddress)({ settings: settings.env, shell })),
	},
	{ name: `the plugin ${plugin} is enabled`, passed: pipe(settings.enabledPlugins, Array.contains(plugin)) },
	{ name: `the plugin ${plugin} is installed`, passed: installed },
];

/**
 * The doctor's two checks, from what the mocks received. The canary arrived at the BAA mock when one BAA body holds
 * it whole, and at an open mock when one open body does, a leak.
 *
 * @param {object} run The run's canary, and the bodies each mock received.
 * @returns {readonly Check[]} The checks.
 */
const canaryChecks = (run: { readonly canary: string; readonly arrived: Arrived }): readonly Check[] => {
	const holdsIt = (bodies: readonly string[]): boolean => pipe(bodies, Array.some(Str.includes(run.canary)));

	return [
		{ name: "the canary arrived at the BAA mock", passed: holdsIt(run.arrived.baa) },
		{ name: "the canary arrived at no open mock", passed: !holdsIt(run.arrived.open) },
	];
};

/**
 * The check of how the headless turn ended, which holds when it exited 0.
 *
 * @param {object} command The harness's binary, and its headless command.
 * @returns {Function} The check of a turn.
 */
const turnCheck = (command: { readonly binary: string; readonly headless: string }): ((turn: Turn) => Check) =>
	Match.type<Turn>().pipe(
		Match.discriminatorsExhaustive("kind")({
			exited: ({ exitCode, printed }): Check => {
				if (exitCode === exitedCleanly) {
					return { name: `${command.headless} exited 0`, passed: true };
				}

				return {
					name: `${command.headless} exited 0, but it exited ${String(exitCode)}: ${Str.trim(printed)}`,
					passed: false,
				};
			},
			notStarted: (): Check => ({ name: `${command.binary} is on PATH`, passed: false }),
			timedOut: (): Check => ({ name: `${command.headless} finished within 2 minutes`, passed: false }),
		}),
	);

const lineOf = ({ name, passed }: Check): string => {
	if (passed) {
		return `pass ${name}`;
	}

	return `FAIL ${name}`;
};

/**
 * Prints `pass <name>` or `FAIL <name>` for each check, then fails with `DoctorFailed` naming `harness` and `next` when
 * one failed.
 */
const reported = Effect.fnUntraced(function* reported(harness: string, checks: readonly Check[], next: string) {
	yield* Effect.forEach(checks, (check) => Console.log(lineOf(check)), {
		concurrency: 1,
		discard: true,
	});

	const failed = Array.countBy(checks, ({ passed }) => !passed);

	if (failed > noneFailed) {
		return yield* DoctorFailed.make({ failed, harness, next });
	}

	return failed;
});

/** Binds `port` on loopback and lets it go, and gives its address, `http://127.0.0.1:<port>`. */
const bound = Effect.fnUntraced(function* bound(port: number) {
	const { on } = yield* Listener;
	const built = yield* Layer.build(on(port));

	return yield* Effect.provideContext(listensOn, built);
}, Effect.scoped);

/** The router the hook started stops one lease check after the harness exits. */
const routerStops = { schedule: Schedule.spaced("100 millis"), times: 100 } as const;

/** Waits until the port of `address`, where the plugin's hook started a router, is free again, for 10 seconds at most. */
const routerStopped = Effect.fnUntraced(function* routerStopped(address: string) {
	yield* bound(Number(new URL(address).port)).pipe(Effect.retry(routerStops), Effect.ignore);
});

/** A canary made for one run: a word no prompt would hold by chance, which the mock judge seals. */
const madeCanary = Effect.map(
	Random.nextIntBetween(canaryRange.low, canaryRange.high),
	(number) => `phi-doctor-canary-${String(number)}`,
);

/** What a harness's headless turn gets from a canary run: the router's address, the mocks' environment and the prompt. */
interface Canaried {
	readonly address: string;
	readonly env: Readonly<Record<string, string>>;
	readonly prompt: string;
}

/**
 * Starts the mocks of `harness.vendor`, and runs the harness's installed headless command once through `turnOf`, with a
 * canary made for this run in its prompt and a free loopback port as the router's address. The harness's own hook and
 * launcher start its router there over the mocks. Once the turn ends, or doctor is interrupted, it waits for that
 * router to stop before the mocks' folders go, so the router writes nothing into them after they are removed. It gives
 * the checks of the turn and of where the canary arrived.
 */
const canaryRun = Effect.fnUntraced(function* canaryRun<Failure, Needs>(
	harness: { readonly vendor: Vendor; readonly binary: string; readonly headless: string },
	turnOf: (canaried: Canaried) => Effect.Effect<Turn, Failure, Needs>,
) {
	const canary = yield* madeCanary;
	const world = yield* mockWorld(harness.vendor, Str.includes(canary));
	const address = yield* bound(anyFreePort);

	const turn = yield* turnOf({ address, env: world.env, prompt: `Reply with the word ok. ${canary}` }).pipe(
		Effect.ensuring(routerStopped(address)),
	);

	const arrived = yield* world.arrived;

	return [turnCheck(harness)(turn), ...canaryChecks({ arrived, canary })];
}, Effect.scoped);

/**
 * Checks the settings and the plugin's install first, and stops there when one fails, since Claude Code would only
 * retry a refused connection for three minutes. Then it runs the canary through the installed plugin, and passes only
 * when `claude` exited 0, the canary arrived at the BAA mock, and it arrived at no open mock. It changes no setting, and
 * never touches the product port, the user's router configuration, or a real account.
 */
const doctor = Effect.fn("doctor claude")(function* doctor(configDir: string) {
	const settings = yield* userSettings(configDir);
	const installed = yield* installedPlugin(configDir, plugin);
	const shell = yield* shellLists;

	yield* reported(
		"claude",
		settingsChecks({ installed: Option.isSome(installed), settings, shell }),
		`Run phi-router on claude for a missing setting, and claude plugin install ${plugin} for the plugin.`,
	);

	const checks = yield* Option.match(installed, {
		onNone: () => Effect.succeed([]),
		onSome: (folder) =>
			canaryRun({ binary: "claude", headless: "claude -p", vendor: "anthropic" }, ({ address, env, prompt }) =>
				claudeTurn({
					env,
					model: auto,
					plugin: folder,
					prompt,
					settingsEnv: Struct.assign(
						Struct.assign(claudeEnv, { [modelAddress]: address }),
						exempted(address)({ settings: {}, shell: {} }).set,
					),
				}),
			),
	});

	yield* reported(
		"claude",
		checks,
		`The canary must reach the BAA mock alone, through the router the plugin's hook starts. Each FAIL line names what did not hold. When claude -p fails, run claude plugin install ${plugin} again.`,
	);
});

export { canaryChecks, canaryRun, doctor, reported };

export type { Check };
