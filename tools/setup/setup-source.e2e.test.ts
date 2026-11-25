import { Array, Effect, String as Str, pipe } from "effect";
import type { FileSystem, PlatformError } from "effect";
import type { Typed, World } from "./world.ts";
import { argsOf, codexSignedIn, enter, layer, maxAnswers, noAnother, ok, patient, piHolds, piLogin } from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { keys, typedRun, world } from "./world.ts";

interface CheckoutInstall {
	readonly harness: "claude" | "codex" | "pi";
	readonly installs: (checkout: string) => readonly string[];
	readonly given: (of: World) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
	readonly answers: readonly Typed[];
}

const checkoutInstalls: readonly CheckoutInstall[] = [
	{
		answers: maxAnswers,
		given: () => Effect.void,
		harness: "claude",
		installs: (checkout) => [`plugin install phi-router --marketplace ${checkout} --scope user`],
	},
	{
		answers: [noAnother, { after: "OpenAI key (BAA)", typed: keys.openai }, enter],
		given: codexSignedIn,
		harness: "codex",
		installs: (checkout) => [`plugin marketplace add ${checkout}`, "plugin add phi-router@phi-router"],
	},
	{
		answers: maxAnswers,
		given: (of) => piHolds(of, { anthropic: piLogin }),
		harness: "pi",
		installs: (checkout) => [`install ${checkout}`],
	},
];

const isInstall = (line: string): boolean => Str.startsWith("plugin ")(line) || Str.startsWith("install ")(line);

const fromCheckout = Effect.fnUntraced(function* fromCheckout({ answers, given, harness, installs }: CheckoutInstall) {
	const of = yield* world;
	const checkout = of.copies.piPackage;

	yield* given(of);

	const run = yield* typedRun(of, ["setup", harness, "--source", checkout], answers);
	const args = yield* argsOf(of, harness);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.deepStrictEqual(pipe(args, Array.filter(isInstall)), installs(checkout));
}, Effect.scoped);

it.layer(layer)("setup --source", (test) => {
	test.effect.each(checkoutInstalls)(
		"setup $harness installs from the checkout --source names",
		fromCheckout,
		patient,
	);
});
