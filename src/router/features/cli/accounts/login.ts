import { Array, Config, DateTime, Effect, Option, Path, Redacted, String as Str, Struct, pipe } from "effect";
import type { NamedAccount, Vendor } from "#router/client/configuration/index.ts";
import { claudeSignIn, codexFolderSignIn, codexSignIn } from "#router/client/harnesses/index.ts";
import { fromFolder, refused, summaryOf, tokenKindOf } from "./found.ts";
import { handedOver, hiddenLine, isTerminal, picked } from "#router/client/terminal.ts";
import { loginFolderOf, saveToken } from "#router/client/keys/index.ts";
import { loginFolders, readKey } from "#router/client/accounts/index.ts";
import type { Found } from "./found.ts";
import { Platform } from "#router/features/cli/platform.ts";
import type { SignIn } from "#router/client/harnesses/index.ts";
import { configuredAccounts } from "#router/client/configuration/index.ts";

interface Subscription extends Found {
	readonly signIn: SignIn;
}

const browserVariables = ["BROWSER", "DISPLAY", "WAYLAND_DISPLAY"] as const;

const opensBrowser = Effect.gen(function* opensBrowser() {
	const { os } = yield* Platform;

	const values = yield* Effect.forEach(browserVariables, (name) => Config.String(name).pipe(Config.withDefault("")), {
		concurrency: 1,
	});

	return os === "darwin" || pipe(values, Array.some(Str.isNonEmpty));
});

const canLogIn = Effect.fnUntraced(function* canLogIn({ withBrowser }: { readonly withBrowser: boolean }) {
	const terminal = yield* isTerminal;
	const browser = yield* opensBrowser;

	if (!terminal && !(withBrowser && browser)) {
		return yield* refused("Logging in to another subscription needs a terminal or a browser, and here is neither.");
	}

	return terminal;
});

const unfinished = (args: readonly string[]): ReturnType<typeof refused> =>
	refused(`\`${Array.join(args, " ")}\` did not finish.`);

const succeeded = 0;

const notRun = -1;

const emailOf = (signIn: SignIn): Option.Option<string> => {
	if (signIn.kind === "plan" || signIn.kind === "enterprise") {
		return Option.fromUndefinedOr(signIn.account);
	}

	return Option.none();
};

const isSubscription = (signIn: SignIn): boolean => signIn.kind === "plan" || signIn.kind === "enterprise";

const folderSignIns = { anthropic: claudeSignIn, openai: codexFolderSignIn } as const;

const takenIn = (signIn: SignIn, taken: readonly string[]): Option.Option<string> =>
	pipe(
		emailOf(signIn),
		Option.filter((email) => Array.contains(taken, email)),
	);

const folderLogin = Effect.fnUntraced(function* folderLogin(vendor: Vendor, folder: string, taken: readonly string[]) {
	const held = yield* folderSignIns[vendor](folder);

	if (isSubscription(held) && Option.isNone(takenIn(held, taken))) {
		return held;
	}

	yield* canLogIn({ withBrowser: true });

	const { env, loginArgs } = loginFolders[vendor];
	const code = yield* handedOver(loginArgs, { [env]: folder }).pipe(Effect.orElseSucceed(() => notRun));
	const after = yield* folderSignIns[vendor](folder);

	if (code !== succeeded || after.kind === "none") {
		return yield* unfinished(loginArgs);
	}

	if (!isSubscription(after)) {
		return yield* refused("That login is an API key, not a subscription.");
	}

	const again = takenIn(after, taken);

	if (Option.isSome(again)) {
		return yield* refused(`You logged in to ${again.value}, which phi-router already uses.`);
	}

	return after;
});

const setupToken = ["claude", "setup-token"] as const;

const typedToken = Effect.fnUntraced(function* typedToken(keyFile: string) {
	yield* canLogIn({ withBrowser: false });

	const code = yield* handedOver(setupToken).pipe(Effect.orElseSucceed(() => notRun));

	if (code !== succeeded) {
		return yield* unfinished(setupToken);
	}

	const typed = yield* Effect.flatMap(hiddenLine("Paste the token it printed: "), Effect.fromOption).pipe(
		Effect.mapError(() => unfinished(setupToken)),
	);

	const token = Redacted.make(Str.trim(Redacted.value(typed)));

	if (!Option.exists(tokenKindOf(Redacted.value(token)), ({ scheme }) => scheme === "oauth")) {
		return yield* refused("That is not a Claude subscription token, which starts with sk-ant-oat.");
	}

	yield* saveToken(keyFile, token);

	return token;
});

const tokenLogin = Effect.fnUntraced(function* tokenLogin(folder: string) {
	const path = yield* Path.Path;
	const keyFile = path.join(folder, "token");
	const held = yield* Effect.option(readKey({ keyFile }));
	const token = yield* Option.match(held, { onNone: () => typedToken(keyFile), onSome: Effect.succeed });
	const value = Redacted.value(token);

	const summary = Option.match(tokenKindOf(value), {
		onNone: () => "Claude token.",
		onSome: (kind) => summaryOf({ kind, value }),
	});

	return {
		account: { keyFile, scheme: "oauth", vendor: "anthropic" },
		signIn: { kind: "plan", plan: "Claude subscription" },
		summary,
		vendorName: "Claude",
	} satisfies Subscription;
});

const heldFolders = Effect.gen(function* heldFolders() {
	const path = yield* Path.Path;
	const configured = yield* configuredAccounts;

	const folderOf = ({ credential }: NamedAccount): readonly string[] => {
		if (credential.kind === "loginFolder") {
			return [credential.folder];
		}

		if (credential.kind === "key" && "keyFile" in credential.source) {
			return [path.dirname(credential.source.keyFile)];
		}

		return [];
	};

	return pipe(
		Option.match(configured, { onNone: () => [], onSome: ({ clean, sealed }) => [...clean, ...sealed] }),
		Array.flatMap(folderOf),
	);
});

const slotWords = { anthropic: "claude", openai: "codex" } as const;

const firstSlot = 2;

const nextSlot = 1;

const slotFrom = (vendor: Vendor, held: readonly string[], at: number): ReturnType<typeof loginFolderOf> =>
	loginFolderOf(`${slotWords[vendor]}-open-${String(at)}`).pipe(
		Effect.filterOrElse(
			(folder) => !Array.contains(held, folder),
			() => slotFrom(vendor, held, at + nextSlot),
		),
	);

const subscriptionLogin = Effect.fnUntraced(
	function* subscriptionLogin(vendor: Vendor, taken: readonly string[]) {
		const { os } = yield* Platform;
		const held = yield* heldFolders;
		const folder = yield* slotFrom(vendor, held, firstSlot);

		if (os === "darwin" && vendor === "anthropic") {
			return yield* tokenLogin(folder);
		}

		const signIn = yield* folderLogin(vendor, folder, taken);
		const found = yield* fromFolder(folder);

		return Struct.assign(found, { signIn }) satisfies Subscription;
	},
	DateTime.withCurrentZoneLocal,
	Effect.catchTags({
		PlatformError: (error) => Effect.fail(refused(`phi-router could not read or write its files. ${error.message}`)),
		SchemaError: (error) => Effect.fail(refused(`phi-router could not read config.json. ${error.message}`)),
	}),
);

const ownSignIns = { anthropic: claudeSignIn(""), openai: codexSignIn } as const;

const emailsOf = Effect.fnUntraced(function* emailsOf(account: NamedAccount) {
	const { credential, vendor } = account;

	if (credential.kind === "forwarded") {
		const own = yield* ownSignIns[vendor];

		return Option.toArray(emailOf(own));
	}

	if (credential.kind === "loginFolder") {
		const held = yield* folderSignIns[vendor](credential.folder);

		return Option.toArray(emailOf(held));
	}

	return [];
});

const subscriptionNames = { anthropic: "Claude", openai: "ChatGPT" } as const;

const bothVendors = ["anthropic", "openai"] as const;

const pickedVendor = Effect.fnUntraced(function* pickedVendor(vendors: Array.NonEmptyReadonlyArray<Vendor>) {
	const [first, ...others] = vendors;

	if (!Array.isReadonlyArrayNonEmpty(others)) {
		return first;
	}

	const terminal = yield* isTerminal;

	if (!terminal) {
		return yield* refused(
			`Your clean lane holds Claude and ChatGPT subscriptions. Run \`npx phi-router accounts add\` in a terminal to pick one.`,
		);
	}

	const names = pipe(
		vendors,
		Array.map((vendor) => subscriptionNames[vendor]),
	);

	const at = yield* picked("Which subscription do you want to add?", names);

	const vendor = pipe(
		at,
		Option.flatMap((index) => pipe(vendors, Array.get(index))),
	);

	return yield* Effect.mapError(Effect.fromOption(vendor), () => refused("Nothing was picked."));
});

const fromLogin = Effect.fnUntraced(function* fromLogin() {
	const configured = yield* Effect.mapError(configuredAccounts, (error) =>
		refused(`phi-router could not read config.json. ${error.message}`),
	);

	const clean = Option.match(configured, {
		onNone: (): readonly NamedAccount[] => [],
		onSome: (accounts) => accounts.clean,
	});

	const vendors = pipe(
		bothVendors,
		Array.filter((vendor) =>
			pipe(
				clean,
				Array.some((account) => account.vendor === vendor),
			),
		),
	);

	if (!Array.isReadonlyArrayNonEmpty(vendors)) {
		return yield* refused("config.json holds no accounts yet. Run `npx phi-router setup <harness>` first.");
	}

	const vendor = yield* pickedVendor(vendors);

	const taken = yield* Effect.forEach(
		pipe(
			clean,
			Array.filter((account) => account.vendor === vendor),
		),
		emailsOf,
		{ concurrency: 1 },
	);

	return yield* subscriptionLogin(vendor, Array.flatten(taken));
});

export { fromLogin, opensBrowser, subscriptionLogin };
