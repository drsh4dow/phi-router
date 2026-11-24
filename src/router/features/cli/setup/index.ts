import { Array, Console, Effect, Option, String as Str, pipe } from "effect";
import { Command, Flag } from "effect/cli";
import { baaAsk, keyFor, savedKeyFile, stillHeld, stopped, vendorWords } from "./keys.ts";
import { enterPressed, handedOver, isTerminal } from "#router/client/terminal.ts";
import { installedIn, sourceOf } from "./install.ts";
import type { HarnessName } from "./harnesses.ts";
import type { HeldKey } from "./keys.ts";
import { KeyChecks } from "#router/client/keys/index.ts";
import { Platform } from "#router/features/cli/platform.ts";
import { addAccounts } from "#router/client/config-writer.ts";
import { harnesses } from "./harnesses.ts";
import { packageOf } from "#router/client/own-package.ts";

const baaKeyStates = { missing: "needs an API key", stillAccepted: "already set up" } as const;

const columnGap = 3;

const header = (name: HarnessName, baa: keyof typeof baaKeyStates): string => {
	const { subscription } = harnesses[name];

	const rows = [
		[`Your ${subscription} subscription`, "already set up"],
		["Your BAA account", baaKeyStates[baa]],
	] as const;

	const width =
		Math.max(
			...pipe(
				rows,
				Array.map(([label]) => label.length),
			),
		) + columnGap;

	const lines = pipe(
		rows,
		Array.map(([label, state]) => `  ${Str.padEnd(width)(label)}${state}`),
	);

	return Array.join([`phi-router keeps patient data off your ${subscription} subscription.`, "", ...lines, ""], "\n");
};

const keyOf = Effect.fnUntraced(function* keyOf(name: HarnessName, fresh: boolean) {
	const { baaVendor, title } = harnesses[name];
	const saved = yield* stillHeld(baaVendor, fresh);

	yield* Console.log(header(name, Option.match(saved, { onNone: () => "missing", onSome: () => "stillAccepted" })));

	const key = yield* Option.match(saved, {
		onNone: () => keyFor(baaAsk({ harnessTitle: title, vendor: baaVendor })),
		onSome: Effect.succeed,
	});

	yield* Console.log(`✓ ${vendorWords[baaVendor].name} accepted the key`);

	return key;
});

const configured = Effect.fnUntraced(function* configured(name: HarnessName, held: HeldKey) {
	const { title } = harnesses[name];
	const { vendor } = held;
	const keyFile = yield* savedKeyFile(held);

	yield* addAccounts({
		accounts: [
			{ account: { forwarded: true, vendor }, lane: "clean" },
			{ account: { keyFile, scheme: "apiKey", vendor }, lane: "sealed" },
		],
	}).pipe(
		Effect.mapError((error) =>
			stopped(
				`Setup could not write config.json, so ${title} was left as it was. Your key is saved. ${error.message}`,
			),
		),
	);
});

const tested = Effect.fnUntraced(function* tested(name: HarnessName) {
	const { canary, title } = harnesses[name];

	const failed = stopped(
		`The test failed, so ${title} was left as it was. Your key is saved. For details, run: npx phi-router doctor ${name}`,
	);

	const { entry } = yield* Platform;

	const checks = yield* pipe(
		packageOf(entry),
		Effect.flatMap(Effect.fromOption),
		Effect.flatMap(canary),
		Effect.mapError(() => failed),
	);

	const passed = pipe(
		checks,
		Array.every((check) => check.passed),
	);

	return yield* Effect.when(failed, Effect.succeed(!passed));
});

const switched = Effect.fnUntraced(function* switched(name: HarnessName) {
	const { title } = harnesses[name];

	const writing = Effect.gen(function* writing() {
		const line = yield* harnesses[name].switchOn;

		yield* Effect.forEach(Option.toArray(line), (said) => Console.log(`✓ ${said}`), {
			concurrency: 1,
			discard: true,
		});
	});

	yield* Effect.mapError(writing, (error) =>
		stopped(`Setup could not change the settings of ${title}. Your key is saved. ${error.message}`),
	);
});

const noVersion = stopped(
	"Setup could not read the version of phi-router, so it cannot tell which release to install. Nothing was changed.",
);

const noTerminal = stopped(
	"phi-router setup asks for a key, so it needs your own terminal. Run it yourself, outside your coding agent. Nothing was changed.",
);

const setup = Effect.fn("setup")(function* setup(name: HarnessName, checkout: string | undefined, fresh: boolean) {
	const { closingLines, start } = harnesses[name];
	const source = yield* Effect.mapError(sourceOf(checkout), () => noVersion);

	yield* Effect.filterOrFail(isTerminal, Boolean, () => noTerminal);
	yield* Effect.flatMap(keyOf(name, fresh), (key) => configured(name, key));

	yield* tested(name);
	yield* installedIn(name, source);
	yield* Console.log("✓ Test passed: a fake patient record went to your BAA account, not your subscription");
	yield* switched(name);
	yield* Console.log(Array.join(["", ...closingLines(source)], "\n"));
	yield* Effect.when(Effect.asVoid(handedOver(start)), enterPressed);
});

const flags = {
	newKey: Flag.Boolean("new-key").pipe(Flag.withDefault(false)),
	source: Flag.optional(Flag.Directory("source", { mustExist: true })),
};

const claude = Command.make("claude", flags, (given) =>
	setup("claude", Option.getOrUndefined(given.source), given.newKey),
);

const codex = Command.make("codex", flags, (given) =>
	setup("codex", Option.getOrUndefined(given.source), given.newKey),
);

const pi = Command.make("pi", flags, (given) => setup("pi", Option.getOrUndefined(given.source), given.newKey));

const setupCommand = Command.make("setup").pipe(
	Command.withSubcommands([claude, codex, pi]),
	Command.provide(KeyChecks.layer),
);

export { setupCommand };
