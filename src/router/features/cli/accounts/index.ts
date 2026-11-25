import { AccountState, loginFolders, loginIn } from "#router/client/accounts/index.ts";
import { Argument, Command, Flag } from "effect/cli";
import { Array, Clock, Console, DateTime, Effect, Option, String as Str, flow, pipe } from "effect";
import type { Lane, NamedAccount } from "#router/client/configuration/index.ts";
import { accountsAdd } from "./add.ts";
import { configuredAccounts } from "#router/client/configuration/index.ts";

interface AccountRow {
	readonly lane: Lane;
	readonly name: string;
	readonly vendor: "Claude" | "Codex" | "OpenAI";
	readonly kind: string;
	readonly state: string;
}

const renewWithinDays = 3;

const millisPerDay = 86_400_000;

const gap = 2;

const twoDigits = Str.padStart(gap, "0");

const localDayOf = flow(DateTime.setZoneCurrent, Effect.map(DateTime.formatIsoDate));

const localTimeOf = flow(
	DateTime.setZoneCurrent,
	Effect.map(DateTime.toParts),
	Effect.map(({ hour, minute }) => `${twoDigits(String(hour))}:${twoDigits(String(minute))}`),
);

const vendorOf = (account: NamedAccount): AccountRow["vendor"] => {
	if (account.vendor === "anthropic") {
		return "Claude";
	}

	if (account.credential.kind === "key") {
		return "OpenAI";
	}

	return "Codex";
};

const kindOf = (account: NamedAccount): string => {
	const { credential } = account;

	if (credential.kind === "forwarded") {
		return "forwarded";
	}

	if (credential.kind === "loginFolder") {
		return { anthropic: "login folder", openai: "home folder" }[account.vendor];
	}

	if ("keyEnv" in credential.source) {
		return "key env";
	}

	if ("keyFile" in credential.source) {
		return "key file";
	}

	return { apiKey: "key command", oauth: "token" }[credential.scheme];
};

const stampOf = Effect.fnUntraced(function* stampOf(name: string) {
	const state = yield* AccountState;
	const stamps = yield* state.stamps([name]);
	const back = Option.fromUndefinedOr(stamps.get(name));
	const clock = yield* Effect.transposeOption(pipe(back, Option.map(localTimeOf)));

	return pipe(
		clock,
		Option.map((at) => `rate-limited. Back at ${at}.`),
	);
});

const endOf = Effect.fnUntraced(function* endOf(end: number, fix: string) {
	const now = yield* Clock.currentTimeMillis;
	const day = yield* localDayOf(DateTime.makeUnsafe(end));
	const days = Math.ceil((end - now) / millisPerDay);

	if (end <= now) {
		return { ending: Option.none(), gone: Option.some(`login ended ${day}. Fix: ${fix}`) };
	}

	if (end - now <= millisPerDay) {
		return { ending: Option.some(`Login ends in under a day. Renew: ${fix}`), gone: Option.none() };
	}

	if (end - now <= renewWithinDays * millisPerDay) {
		return { ending: Option.some(`Login ends in ${String(days)} days. Renew: ${fix}`), gone: Option.none() };
	}

	return { ending: Option.some(`ok. Login ends ${day}.`), gone: Option.none() };
});

const loginOf = Effect.fnUntraced(function* loginOf(account: NamedAccount) {
	const nothing = { ending: Option.none<string>(), gone: Option.none<string>() };

	if (account.credential.kind !== "loginFolder") {
		return nothing;
	}

	const fix = loginFolders[account.vendor].loginCommand(account.credential.folder);
	const seen = yield* loginIn(account.credential.folder);

	const login = pipe(
		seen,
		Option.filter(({ vendor }) => vendor === account.vendor),
	);

	if (Option.isNone(login)) {
		return { ending: Option.none<string>(), gone: Option.some(`no login. Fix: ${fix}`) };
	}

	return yield* Option.match(login.value.ends, {
		onNone: () => Effect.succeed(nothing),
		onSome: (end) => endOf(DateTime.toEpochMillis(end), fix),
	});
});

const rowOf = Effect.fnUntraced(function* rowOf(lane: Lane, account: NamedAccount) {
	const login = yield* loginOf(account);
	const stamp = yield* stampOf(account.name);

	const state = pipe(
		Option.firstSomeOf([login.gone, stamp, login.ending]),
		Option.getOrElse(() => "ok."),
	);

	const lacking = Array.match(account.lacks, {
		onEmpty: () => "",
		onNonEmpty: (models) => ` Lacks ${Array.join(models, ", ")}.`,
	});

	return {
		kind: kindOf(account),
		lane,
		name: account.name,
		state: `${state}${lacking}`,
		vendor: vendorOf(account),
	} satisfies AccountRow;
});

const accountRows = Effect.gen(function* accountRows() {
	const configured = yield* configuredAccounts;

	if (Option.isNone(configured)) {
		return [];
	}

	const { clean, sealed } = configured.value;
	const cleanRows = yield* Effect.forEach(clean, (account) => rowOf("clean", account), { concurrency: 1 });
	const sealedRows = yield* Effect.forEach(sealed, (account) => rowOf("sealed", account), { concurrency: 1 });

	return [...cleanRows, ...sealedRows];
});

const headers = { clean: "Clean lane", sealed: "Sealed lane" } as const;

const widthOf = (rows: readonly AccountRow[], column: "name" | "vendor" | "kind"): number =>
	Math.max(
		...pipe(
			rows,
			Array.map((row) => row[column].length + gap),
		),
	);

const listed = Effect.gen(function* listed() {
	const rows = yield* accountRows;

	if (!Array.isReadonlyArrayNonEmpty(rows)) {
		return yield* Console.log(
			"No accounts yet. The install for your harness writes the first ones, and phi-router accounts add adds more.",
		);
	}

	const name = Str.padEnd(widthOf(rows, "name"));
	const vendor = Str.padEnd(widthOf(rows, "vendor"));
	const kind = Str.padEnd(widthOf(rows, "kind"));

	const lines = pipe(
		["clean", "sealed"] as const,
		Array.flatMap((lane) => [
			headers[lane],
			...pipe(
				rows,
				Array.filter((row) => row.lane === lane),
				Array.map((row) => `  ${name(row.name)}${vendor(row.vendor)}${kind(row.kind)}${row.state}`),
			),
		]),
	);

	return yield* Console.log(Array.join(lines, "\n"));
}).pipe(DateTime.withCurrentZoneLocal);

const add = Command.make(
	"add",
	{
		command: Flag.optional(Flag.String("command")),
		folder: Argument.optional(Argument.Directory("folder", { mustExist: true })),
		sealed: Flag.Boolean("sealed").pipe(Flag.withDefault(false)),
	},
	(flags) =>
		accountsAdd({
			keyCommand: Option.getOrUndefined(flags.command),
			loginFolder: Option.getOrUndefined(flags.folder),
			sealed: flags.sealed,
		}),
);

const accounts = Command.make("accounts", {}, () => listed).pipe(
	Command.provide(AccountState.layer),
	Command.withSubcommands([add]),
);

export { accounts };

export { opensBrowser } from "./login.ts";

export { tokenKindOf } from "./found.ts";
