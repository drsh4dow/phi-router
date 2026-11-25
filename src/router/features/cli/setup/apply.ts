import { Array, Console, Effect, Option, Struct, pipe } from "effect";
import type { HarnessName, InstallSource } from "./harnesses.ts";
import { checkedKeys, savedKey } from "./held-keys.ts";
import { enterpriseNote, roleNames, rows, shown } from "./copy.ts";
import type { NewAccount } from "#router/client/config-writer.ts";
import type { Ready } from "./plan.ts";
import type { Signed } from "./sign-ins.ts";
import type { Typed } from "./held-keys.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { addAccounts } from "#router/client/config-writer.ts";
import { harnesses } from "./harnesses.ts";
import { signedIn } from "./sign-ins.ts";
import { stopped } from "./keys.ts";
import { turnedOn } from "./install.ts";

type Settled = Exclude<Signed, { kind: "key" }>;

const accountOf = (filler: Settled, vendor: Vendor): Option.Option<NewAccount> => {
	if (filler.kind === "kept") {
		return Option.none();
	}

	if (filler.kind === "forwarded") {
		return Option.some({ forwarded: true, vendor });
	}

	if (filler.kind === "loginFolder") {
		return Option.some({ loginFolder: filler.folder, vendor });
	}

	return Option.some(Struct.assign(filler.source, { scheme: "apiKey", vendor: filler.vendor } as const));
};

const settled = Effect.fnUntraced(function* settled(roles: Ready["roles"], typed: Typed) {
	const open = yield* Effect.flatMap(signedIn(roles.open), (filler) => savedKey(filler, typed));
	const baa = yield* Effect.flatMap(signedIn(roles.baa), (filler) => savedKey(filler, typed));
	const judge = yield* Effect.flatMap(signedIn(roles.judge), (filler) => savedKey(filler, typed));

	return { baa, judge, open };
});

const written = Effect.fnUntraced(function* written(
	title: string,
	vendor: Vendor,
	roles: Readonly<Record<"open" | "baa" | "judge", Settled>>,
) {
	const accounts = [
		...Array.map(Option.toArray(accountOf(roles.open, vendor)), (account) => ({ account, lane: "clean" as const })),
		...Array.map(Option.toArray(accountOf(roles.baa, vendor)), (account) => ({ account, lane: "sealed" as const })),
	];

	const additions = pipe(
		Option.liftPredicate(roles.judge, (judge) => judge.kind === "source"),
		Option.match({
			onNone: () => ({ accounts }),
			onSome: (judge) => ({ accounts, judge: judge.source }),
		}),
	);

	yield* addAccounts(additions).pipe(
		Effect.mapError((error) =>
			stopped(
				`Setup could not write config.json, so ${title} was left as it was. Your key is saved. ${error.message}`,
			),
		),
	);
});

const apply = Effect.fn("setup apply")(function* apply(
	name: HarnessName,
	ready: { readonly roles: Ready["roles"]; readonly typed: Typed },
	source: InstallSource,
) {
	const { title, vendor } = harnesses[name];
	const { roles, typed } = ready;

	if (roles.baa.kind === "harnessFolder" || roles.baa.kind === "signIn") {
		yield* Console.log(enterpriseNote);
	}

	yield* checkedKeys(title, roles, typed);

	const done = yield* settled(roles, typed);

	yield* written(title, vendor, done);
	yield* turnedOn(name, source, done.open.label.plan);

	const summary = rows([
		[roleNames.open, shown(done.open.label)],
		[roleNames.baa, shown(done.baa.label)],
		[roleNames.judge, "OpenAI"],
	]);

	yield* Console.log(Array.join(["", ...summary], "\n"));
});

export { apply };
