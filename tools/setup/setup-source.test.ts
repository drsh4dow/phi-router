import { Array, Effect, String as Str, pipe } from "effect";
import { argsOf, enter, layer, ok, patient, writeOwnSettings } from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { keys, typedRun, world } from "./world.ts";

interface CheckoutInstall {
	readonly harness: "claude" | "codex" | "pi";
	readonly installs: (checkout: string) => readonly string[];
	readonly key: string;
}

const checkoutInstalls: readonly CheckoutInstall[] = [
	{
		harness: "claude",
		installs: (checkout) => [`plugin install phi-router --marketplace ${checkout} --scope user`],
		key: keys.anthropic,
	},
	{
		harness: "codex",
		installs: (checkout) => [`plugin marketplace add ${checkout}`, "plugin add phi-router@phi-router"],
		key: keys.openai,
	},
	{ harness: "pi", installs: (checkout) => [`install ${checkout}`], key: keys.anthropic },
];

const isInstall = (line: string): boolean => Str.startsWith("plugin ")(line) || Str.startsWith("install ")(line);

const fromCheckout = Effect.fnUntraced(function* fromCheckout({ harness, installs, key }: CheckoutInstall) {
	const of = yield* world;
	const checkout = of.copies.piPackage;

	yield* writeOwnSettings(of);

	const run = yield* typedRun(of, ["setup", harness, "--source", checkout], [{ after: "Key: ", typed: key }, enter]);
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
