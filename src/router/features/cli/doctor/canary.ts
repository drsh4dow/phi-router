import { Array, Console, Effect, Layer, Match, Random, Schedule, Schema, String as Str, pipe } from "effect";
import type { Arrived, Vendor } from "#router/client/mock-upstreams/index.ts";
import { Listener, listensOn } from "#router/client/router-port/index.ts";
import type { Turn } from "#router/client/harnesses/index.ts";
import { mockWorld } from "#router/client/mock-upstreams/index.ts";

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

const canaryRange = { high: 1_000_000_000, low: 0 } as const;

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

interface Canaried {
	readonly routerAddress: string;
	readonly mockEnv: Readonly<Record<string, string>>;
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

	const turn = yield* turnOf({
		mockEnv: world.env,
		prompt: `Reply with the word ok. ${canary}`,
		routerAddress: address,
	}).pipe(Effect.ensuring(routerStopped(address)));

	const arrived = yield* world.arrived;

	return [turnCheck(harness)(turn), ...canaryChecks({ arrived, canary })];
}, Effect.scoped);

export { canaryChecks, canaryRun, reported };

export type { Check };
