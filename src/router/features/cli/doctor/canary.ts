import { Array, Console, Effect, Layer, Match, Random, Schedule, Schema, String as Str, pipe } from "effect";
import type { Arrived, Vendor } from "#router/client/mock-upstreams/index.ts";
import { Listener, listensOn } from "#router/client/router-port/index.ts";
import { handleAt, stubTag } from "#router/primitives/handle.ts";
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

const firstSequence = 1;

const firstSealed = stubTag(handleAt(firstSequence));

const canaryChecks = (run: { readonly canary: string; readonly arrived: Arrived }): readonly Check[] => {
	const holds = (text: string): boolean => pipe(run.arrived.open, Array.some(Str.includes(text)));

	return [
		{ name: `the canary's prompt arrived at the open mock as the stub ${firstSealed}`, passed: holds(firstSealed) },
		{ name: "the canary arrived at no open mock", passed: !holds(run.canary) },
	];
};

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

const bound = Effect.fnUntraced(function* bound(port: number) {
	const { on } = yield* Listener;
	const built = yield* Layer.build(on(port));

	return yield* Effect.provideContext(listensOn, built);
}, Effect.scoped);

const routerStops = { schedule: Schedule.spaced("100 millis"), times: 100 } as const;

const routerStopped = Effect.fnUntraced(function* routerStopped(address: string) {
	yield* bound(Number(new URL(address).port)).pipe(Effect.retry(routerStops), Effect.ignore);
});

const madeCanary = Effect.map(
	Random.nextIntBetween(canaryRange.low, canaryRange.high),
	(number) => `phi-doctor-canary-${String(number)}`,
);

interface Canaried {
	readonly routerAddress: string;
	readonly mockEnv: Readonly<Record<string, string>>;
	readonly prompt: string;
}

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

export { canaryChecks, canaryRun, reported, turnCheck };

export type { Check };
