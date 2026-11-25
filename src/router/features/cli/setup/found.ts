import { Array, Effect, Option, Predicate, pipe } from "effect";
import type { Found, Kept } from "./plan.ts";
import type { HarnessName } from "./harnesses.ts";
import { Platform } from "#router/features/cli/platform.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { claudeBlocked } from "./blocked.ts";
import { harnesses } from "./harnesses.ts";
import { keptRoles } from "./kept.ts";
import { machineKeys } from "./machine-keys.ts";

const others: Readonly<Record<HarnessName, readonly HarnessName[]>> = {
	claude: ["codex", "pi"],
	codex: ["claude", "pi"],
	pi: ["claude", "codex"],
};

const signedInAs = Effect.fnUntraced(function* signedInAs(name: HarnessName) {
	const signIn = yield* harnesses[name].signIn;

	return { signIn, title: harnesses[name].title };
});

const signedInOthers = Effect.fnUntraced(function* signedInOthers(name: HarnessName) {
	const seen = yield* Effect.forEach(others[name], signedInAs, { concurrency: 1 });

	return pipe(
		seen,
		Array.filter(({ signIn }) => signIn.kind !== "none"),
	);
});

const unfilled = (vendor: Vendor, kept: Kept): readonly Vendor[] => {
	const roles = [
		[vendor, kept.baa],
		["openai", kept.judge],
	] as const;

	return pipe(
		roles,
		Array.filter(([, role]) => Predicate.isUndefined(role)),
		Array.map(([needs]) => needs),
		Array.dedupe,
	);
};

const find = Effect.fn("setup find")(function* find(name: HarnessName, newKey: boolean) {
	const { title, vendor } = harnesses[name];
	const { os } = yield* Platform;
	const { signIn: own } = yield* signedInAs(name);
	const signedIn = yield* signedInOthers(name);
	const kept = yield* keptRoles(vendor, own, newKey);
	const keys = yield* Effect.forEach(unfilled(vendor, kept), machineKeys, { concurrency: 1 });
	const blocked = yield* Effect.when(claudeBlocked(os), Effect.succeed(name === "claude"));

	return {
		blocked: Option.getOrUndefined(Option.flatten(blocked)),
		kept,
		keys: Array.flatten(keys),
		mac: os === "darwin",
		others: signedIn,
		own,
		signInHow: harnesses[name].signInHow,
		title,
		vendor,
	} satisfies Found;
});

export { find };
