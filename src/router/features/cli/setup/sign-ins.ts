import { Console, Effect, Option } from "effect";
import { claudeFolder, claudeSignIn } from "#router/client/harnesses/index.ts";
import { opensBrowser, subscriptionLogin } from "#router/features/cli/accounts/index.ts";
import { shown, signInElsewhere, signInNamed } from "./copy.ts";
import type { Filler } from "./plan.ts";
import type { HarnessName } from "./harnesses.ts";
import type { Named } from "./copy.ts";
import { harnesses } from "./harnesses.ts";
import { isTerminal } from "#router/client/terminal.ts";
import { logIn } from "#router/client/accounts/index.ts";
import { loginFolderOf } from "#router/client/keys/index.ts";
import { stopped } from "./keys.ts";

interface Folder {
	readonly kind: "loginFolder";
	readonly folder: string;
	readonly label: Named;
}

type Signed = Exclude<Filler, { kind: "signIn" | "harnessFolder" }> | Folder;

const succeeded = 0;

const wanted = {
	baa: { kind: "enterprise", plan: "Claude Enterprise" },
	open: { kind: "plan", plan: "Claude Pro or Max" },
} as const;

type SignInRole = keyof typeof wanted;

const loggedIn = Effect.fnUntraced(function* loggedIn(role: SignInRole, harness: HarnessName) {
	const folder = yield* loginFolderOf(`claude-${role}`);
	const before = yield* claudeSignIn(folder);

	if (before.kind === wanted[role].kind) {
		return { folder, kind: "loginFolder", label: signInNamed(before) } satisfies Folder;
	}

	const terminal = yield* isTerminal;
	const browser = yield* opensBrowser;

	if (!terminal && !browser) {
		return yield* stopped(signInElsewhere({ folder, harness }));
	}

	const code = yield* logIn("anthropic", folder);
	const after = yield* claudeSignIn(folder);

	if (code !== succeeded || after.kind === "none") {
		return yield* stopped("The sign-in did not finish. Run setup again to retry.");
	}

	if (after.kind !== wanted[role].kind) {
		return yield* stopped(
			`You signed in to ${shown(signInNamed(after))}, not ${wanted[role].plan}. Run setup again to sign in again.`,
		);
	}

	yield* Console.log(`✓ Signed in as ${shown(signInNamed(after))}`);

	return { folder, kind: "loginFolder", label: signInNamed(after) } satisfies Folder;
});

const signedIn = Effect.fnUntraced(function* signedIn(filler: Filler, harness: HarnessName) {
	if (filler.kind === "signIn") {
		return yield* loggedIn(filler.role, harness);
	}

	if (filler.kind === "harnessFolder") {
		const folder = yield* claudeFolder("");

		return { folder, kind: "loginFolder", label: filler.label } satisfies Folder;
	}

	return filler satisfies Signed;
});

const addLater = "Add one later: run `npx phi-router accounts add` in a terminal.";

const anotherSignedIn = Effect.fnUntraced(function* anotherSignedIn(name: HarnessName, open: Named) {
	const taken = Option.toArray(Option.fromUndefinedOr(open.account));

	return yield* subscriptionLogin(harnesses[name].vendor, taken).pipe(
		Effect.map(({ account, signIn }) => ({ account, label: signInNamed(signIn) })),
		Effect.tap(({ label }) => Console.log(`✓ Signed in as ${shown(label)}`)),
		Effect.asSome,
		Effect.catchTag("AddRefused", ({ reason }) => Effect.as(Console.log(`! ${reason} ${addLater}`), Option.none())),
	);
});

export { anotherSignedIn, signedIn };

export type { Signed };
