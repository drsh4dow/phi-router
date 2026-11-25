import { Console, Effect } from "effect";
import { claudeFolder, claudeLogin, claudeSignIn } from "#router/client/harnesses/index.ts";
import { shown, signInNamed } from "./copy.ts";
import type { Filler } from "./plan.ts";
import type { Named } from "./copy.ts";
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

const loggedIn = Effect.fnUntraced(function* loggedIn(role: SignInRole) {
	const folder = yield* loginFolderOf(`claude-${role}`);
	const before = yield* claudeSignIn(folder);

	if (before.kind === wanted[role].kind) {
		return { folder, kind: "loginFolder", label: signInNamed(before) } satisfies Folder;
	}

	const code = yield* claudeLogin(folder);
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

const signedIn = Effect.fnUntraced(function* signedIn(filler: Filler) {
	if (filler.kind === "signIn") {
		return yield* loggedIn(filler.role);
	}

	if (filler.kind === "harnessFolder") {
		const folder = yield* claudeFolder("");

		return { folder, kind: "loginFolder", label: filler.label } satisfies Folder;
	}

	return filler satisfies Signed;
});

export { signedIn };

export type { Signed };
