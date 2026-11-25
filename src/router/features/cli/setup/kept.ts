import { Array, Effect, Option, Struct, pipe } from "effect";
import type { Kept, KeptRole } from "./plan.ts";
import { KeyChecks, keyFileOf } from "#router/client/keys/index.ts";
import type { KeySource, Lane, NamedAccount, Vendor } from "#router/client/configuration/index.ts";
import { configuredJudge, configuredLanes } from "#router/client/configuration/index.ts";
import { named, signInNamed, vendorNames } from "./copy.ts";
import type { Named } from "./copy.ts";
import type { SignIn } from "#router/client/harnesses/index.ts";
import { claudeSignIn } from "#router/client/harnesses/index.ts";
import { readKey } from "#router/client/accounts/index.ts";

const sourceOf = (account: NamedAccount): Option.Option<KeySource> => {
	if (account.credential.kind === "key") {
		return Option.some(account.credential.source);
	}

	return Option.none();
};

const ownKeyIn = Effect.fnUntraced(function* ownKeyIn(vendor: Vendor, role: KeptRole) {
	const ownFile = yield* keyFileOf(vendor);

	return pipe(
		Option.fromUndefinedOr(role.key),
		Option.filter((source) => "keyFile" in source && source.keyFile === ownFile),
	);
});

const accepted = Effect.fnUntraced(function* accepted(vendor: Vendor, own: KeySource) {
	const key = yield* Effect.option(readKey(own));

	if (Option.isNone(key)) {
		return false;
	}

	const checks = yield* KeyChecks;
	const answer = yield* checks.check(vendor, key.value);

	return answer === "accepted";
});

const accountName = Effect.fnUntraced(function* accountName(account: NamedAccount, forwarded: Named) {
	const { credential, vendor } = account;

	if (credential.kind === "forwarded") {
		return forwarded;
	}

	if (credential.kind === "loginFolder" && vendor === "anthropic") {
		const signIn = yield* claudeSignIn(credential.folder);

		return signInNamed(signIn);
	}

	if (credential.kind === "loginFolder") {
		return named("ChatGPT");
	}

	return named(`${vendorNames[vendor]} API key`);
});

const checkedRole = Effect.fnUntraced(function* checkedRole(vendor: Vendor, role: KeptRole, newKey: boolean) {
	const own = yield* ownKeyIn(vendor, role);

	if (Option.isNone(own)) {
		return Option.liftPredicate(role, () => !newKey);
	}

	if (newKey) {
		return Option.some(Struct.assign(role, { rekey: true }));
	}

	const works = yield* accepted(vendor, own.value);

	return Option.some(Struct.assign(role, { rekey: !works }));
});

const keptAccount = Effect.fnUntraced(function* keptAccount(
	vendor: Vendor,
	account: NamedAccount,
	given: { readonly forwarded: Named; readonly newKey: boolean },
) {
	const label = yield* accountName(account, given.forwarded);

	return yield* checkedRole(
		vendor,
		{ key: Option.getOrUndefined(sourceOf(account)), label, rekey: false },
		given.newKey,
	);
});

const keptRoles = Effect.fnUntraced(function* keptRoles(vendor: Vendor, own: SignIn, newKey: boolean) {
	const lanes = yield* configuredLanes;
	const forwarded = signInNamed(own);

	const first = (lane: Lane): Option.Option<NamedAccount> =>
		pipe(
			lanes,
			Option.flatMap((all) => all[vendor]),
			Option.map((ofVendor) => Array.headNonEmpty(ofVendor[lane])),
		);

	const openRole = pipe(
		first("clean"),
		Option.map((each) => keptAccount(vendor, each, { forwarded, newKey: false })),
	);

	const baaRole = pipe(
		first("sealed"),
		Option.map((each) => keptAccount(vendor, each, { forwarded, newKey })),
	);

	const judgeKey = yield* configuredJudge;

	const judgeRole = pipe(
		judgeKey,
		Option.map((key) => checkedRole("openai", { key, label: named("OpenAI"), rekey: false }, false)),
	);

	const open = yield* Effect.transposeOption(openRole);
	const baa = yield* Effect.transposeOption(baaRole);
	const judge = yield* Effect.transposeOption(judgeRole);

	return {
		baa: Option.getOrUndefined(Option.flatten(baa)),
		judge: Option.getOrUndefined(Option.flatten(judge)),
		open: Option.getOrUndefined(Option.flatten(open)),
	} satisfies Kept;
});

export { keptRoles };
