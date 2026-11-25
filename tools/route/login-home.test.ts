import { Array, Effect, FileSystem, Option, Path, Struct } from "effect";
import type { Said, Sent } from "#router/client/mock-upstreams/index.ts";
import { assert, it, vi } from "@effect/vitest";
import { dayLong, loggedIn, start } from "./login-fixture.ts";
import { NodeServices } from "@effect/platform-node";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { harnesses } from "./harnesses.ts";
import { pinnedByModel } from "./target-models.ts";
import { routed } from "./mocked-router.ts";

const status = { ok: 200, unauthorized: 401 } as const;

const claudeBody =
	'{"max_tokens":1024,"messages":[{"content":[{"text":"Go on.","type":"text"}],"role":"user"}],"model":"phi/auto","stream":true}';

const homeConfig = '{"phi-test":"before"}';

const updatedConfig = '{"phi-test":"updated"}';

const refusesFirst = (): (() => Said) => {
	const asked = { once: false };

	return () => {
		if (asked.once) {
			return harnesses.claude.answersOk.baa();
		}

		asked.once = true;

		return { body: "{}", kind: "status", status: status.unauthorized };
	};
};

const bearersOf = Array.map(({ headers }: Sent) => headers["authorization"]);

const inheriting = (folder: string): Effect.Effect<void, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => {
			vi.stubEnv("CLAUDE_CONFIG_DIR", folder);
		}),
		() =>
			Effect.sync(() => {
				vi.unstubAllEnvs();
			}),
	);

const claudeLayoutUnder = (home: string): string =>
	Array.join(
		[
			`[ -n "$CLAUDE_CONFIG_DIR" ] || [ "$HOME" = '${home}' ] || exit 3`,
			`printf '%s' '${updatedConfig}' > "\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"`,
			`CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"`,
		],
		"\n",
	);

interface Spelled {
	readonly folder: string;
	readonly link?: string;
}

const homeWith = Effect.fnUntraced(function* homeWith(spelled: Spelled) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* TestClock.setTime(start);

	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-home-" });
	const folder = path.join(home, spelled.folder);

	yield* fs.writeFileString(path.join(home, ".claude.json"), homeConfig);

	const login = yield* loggedIn("claude", Struct.assign(dayLong, { standInRuns: claudeLayoutUnder(home) }), folder);

	const account = yield* Option.match(Option.fromUndefinedOr(spelled.link), {
		onNone: () => Effect.succeed(folder),
		onSome: (link) => Effect.as(fs.symlink(folder, path.join(home, link)), `${path.join(home, link)}/`),
	});

	const before = yield* fs.readDirectory(folder);

	return { account, before, folder, home, login };
});

const inHome = Effect.fnUntraced(function* inHome(spelled: Spelled) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const { account, before, folder, home, login } = yield* homeWith(spelled);
	const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-elsewhere-" });

	yield* inheriting(elsewhere);

	const { mocks, post } = yield* routed({
		baa: refusesFirst(),
		baaFolder: account,
		holdsPhi: () => false,
		routerEnv: { HOME: home, PATH: `${login.bin}:/usr/bin:/bin` },
	});

	const response = yield* post({ body: pinnedByModel(claudeBody), session: "login-home" });

	yield* response.text;

	const [, sealed = []] = yield* mocks.accounts;

	const [after, config] = yield* Effect.all(
		[fs.readDirectory(folder), fs.readFileString(path.join(home, ".claude.json"))],
		{ concurrency: 1 },
	);

	return {
		added: Array.difference(after, before),
		homeConfig: config,
		sealed: bearersOf(sealed),
		status: response.status,
		tokens: login.tokens,
	};
});

const ownFolder = Effect.fnUntraced(function* ownFolder(spelled: Spelled) {
	const seen = yield* inHome(spelled);

	assert.deepStrictEqual<unknown>(Struct.omit(seen, ["tokens"]), {
		added: [],
		homeConfig: updatedConfig,
		sealed: [`Bearer ${seen.tokens.first}`, `Bearer ${seen.tokens.renewed}`],
		status: status.ok,
	});
});

const folderBeside = Effect.gen(function* folderBeside() {
	const seen = yield* inHome({ folder: ".claude-work" });

	assert.deepStrictEqual<unknown>(Struct.omit(seen, ["tokens"]), {
		added: [".claude.json"],
		homeConfig,
		sealed: [`Bearer ${seen.tokens.first}`, `Bearer ${seen.tokens.renewed}`],
		status: status.ok,
	});
});

it.layer(NodeServices.layer)("a Claude login folder under the home folder", (test) => {
	test.effect.each([{ folder: ".claude" }, { folder: ".claude", link: "login" }])(
		"that is .claude, named %o, refreshes with CLAUDE_CONFIG_DIR unset even when the router inherits it, and adds nothing to it",
		ownFolder,
	);
	test.effect("beside .claude refreshes with CLAUDE_CONFIG_DIR pointing at it", () => folderBeside);
});
