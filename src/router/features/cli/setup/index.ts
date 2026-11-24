import { Array, Console, Effect, Option, Predicate, String as Str, pipe } from "effect";
import { Command, Flag } from "effect/cli";
import type { HarnessName, InstallSource } from "./harnesses.ts";
import { baaAsk, keyFor, savedKeyFile, stillHeld, stopped, vendorWords } from "./keys.ts";
import { enterPressed, handedOver, isTerminal } from "#router/client/terminal.ts";
import { packageOf, versionOf } from "#router/client/own-package.ts";
import type { HeldKey } from "./keys.ts";
import { KeyChecks } from "#router/client/keys/index.ts";
import { Platform } from "#router/features/cli/platform.ts";
import type { Turn } from "#router/client/harnesses/index.ts";
import { addAccounts } from "#router/client/config-writer.ts";
import { harnesses } from "./harnesses.ts";
import { installRun } from "#router/client/harnesses/index.ts";

/** The repository setup installs from unless `--source` names a checkout. */
const repository = "drsh4dow/phi-router";

const baaKeyStates = { missing: "needs an API key", stillAccepted: "already set up" } as const;

const columnGap = 3;

/**
 * The screen's first lines: what setup protects, and which of the two accounts still needs a key.
 *
 * @param {HarnessName} name The harness.
 * @param {string} baa The BAA account's state.
 * @returns {string} The lines.
 */
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

/** Saves the key, then names it in `config.json`: the harness's login on the clean lane, the BAA key on the sealed. */
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

const succeeded = 0;

/**
 * Why an install command failed, as the human reads it, none when it exited 0.
 *
 * @param {HarnessName} name The harness.
 * @param {Turn} turn How the command ended.
 * @returns {Option.Option<string>} The copy.
 */
const installFailure = (name: HarnessName, turn: Turn): Option.Option<string> => {
	const {
		start: [binary],
		title,
	} = harnesses[name];

	if (turn.kind === "notStarted") {
		return Option.some(`Setup could not find ${binary}. Install ${title}, then rerun the command.`);
	}

	if (turn.kind === "timedOut") {
		return Option.some(`The install in ${title} took over 2 minutes.`);
	}

	return Option.liftPredicate(`The install in ${title} failed:\n${turn.printed}`, () => turn.exitCode !== succeeded);
};

/** Runs the harness's installer when it has not installed phi-router yet, and checks that it did. */
const installedIn = Effect.fnUntraced(function* installedIn(name: HarnessName, source: InstallSource) {
	const { installCommands, installed, title } = harnesses[name];
	const before = yield* installed;

	const installs = Option.match(before, { onNone: () => installCommands(source), onSome: () => [] });

	yield* Effect.forEach(
		installs,
		(argv) =>
			Effect.flatMap(installRun(argv), (turn) =>
				Option.match(installFailure(name, turn), {
					onNone: () => Effect.void,
					onSome: (failure) => stopped(`${failure}\n${title} was left as it was. Your key is saved.`),
				}),
			),
		{ concurrency: 1, discard: true },
	);

	yield* pipe(
		installed,
		Effect.flatMap(Effect.fromOption),
		Effect.mapError(() => stopped(`${title} did not install phi-router. Your key is saved.`)),
	);

	yield* Console.log(`✓ Installed phi-router in ${title}`);
});

/**
 * Runs the canary through the plugin of the phi-router package setup runs from, before the harness has anything
 * installed, and stops setup unless the canary reached the BAA mock alone.
 */
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

/** Writes the harness's own settings, the last change setup makes, and prints the line that says so. */
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

/**
 * What each installer takes: the checkout `--source` names, else the release of the version of the phi-router package
 * setup runs from, which is the repository at the tag `v<version>` and the npm package of that version.
 */
const sourceOf = Effect.fnUntraced(function* sourceOf(checkout: string | undefined) {
	if (Predicate.isNotUndefined(checkout)) {
		return {
			claudeMarketplace: checkout,
			codexMarketplaceArgs: [checkout],
			piPackage: checkout,
		} satisfies InstallSource;
	}

	const { entry } = yield* Platform;
	const version = yield* versionOf(entry);
	const tag = `v${version}`;

	return {
		claudeMarketplace: `${repository}@${tag}`,
		codexMarketplaceArgs: [repository, "--ref", tag],
		piPackage: `npm:phi-router@${version}`,
	} satisfies InstallSource;
});

const noVersion = stopped(
	"Setup could not read the version of phi-router, so it cannot tell which release to install. Nothing was changed.",
);

const noTerminal = stopped(
	"phi-router setup asks for a key, so it needs your own terminal. Run it yourself, outside your coding agent. Nothing was changed.",
);

/**
 * `phi-router setup <harness>`: asks for the BAA account's key at a hidden prompt, checks it with its vendor, saves it,
 * names it in `config.json`, runs the canary test through its own plugin, and only then installs phi-router with the
 * harness's own installer and writes the harness's settings, so a failed or stopped test leaves the harness as it was.
 * It starts the harness on Enter. It needs a terminal. Each step changes only what
 * differs, so a rerun with a saved key that still works asks nothing and changes no file.
 */
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
