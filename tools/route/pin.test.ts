import { Array, Effect, Exit, FileSystem, Layer, Path, Schema, String as Str, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { autoOf, posted, unreadableLeases } from "./target-models.ts";
import { fakes, laneLines, routed } from "./mocked-router.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { SessionRequests } from "#router/client/router-port/index.ts";
import type { Turn } from "./mocked-router.ts";
import { pinnedModel } from "#router/features/lanes/index.ts";

const asked = {
	first: "PIN-FIRST: list the build steps.",
	last: "PIN-LAST: and the release.",
	second: "PIN-SECOND: now the tests.",
};

const replies = { first: "PIN-REPLY-ONE", second: "PIN-REPLY-TWO" };

const user = (text: string): Turn => ({ role: "user", text });

const assistant = (text: string): Turn => ({ role: "assistant", text });

const whilePinned: readonly (readonly Turn[])[] = [
	[user(asked.first)],
	[user(asked.first), assistant(replies.first), user(asked.second)],
];

const marked = [asked.first, replies.first, asked.second, replies.second, asked.last];

const none = 0;

const afterThePinnedStretch: readonly Turn[] = [
	user(asked.first),
	assistant(replies.first),
	user(asked.second),
	assistant(replies.second),
	user(asked.last),
];

const piModels = { auto: autoOf.pi, sealed: "sealed" } as const;

const jsonText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const judgedOf = Effect.fnUntraced(function* judgedOf(
	received: readonly { readonly body: unknown }[],
	texts: readonly string[],
) {
	const bodies = yield* Effect.forEach(received, ({ body }) => jsonText(body), { concurrency: 1 });

	return pipe(
		texts,
		Array.filter((text) =>
			pipe(
				bodies,
				Array.some((sent) => Str.includes(text)(sent)),
			),
		),
	);
});

const emptySystemPart = 1;

const session = "pin-1";

const onePart = 1;

const portOf = (url: string): number => Number(new URL(url).port);

const statusOn = Effect.fnUntraced(function* statusOn(url: string, of: string) {
	const requests = yield* SessionRequests;
	const status = yield* requests.status(portOf(url), of);

	return Struct.assign(status, { session: String(status.session) });
});

type Shown = Effect.Success<ReturnType<typeof statusOn>>;

const sealedThenAuto = Effect.gen(function* sealedThenAuto() {
	const { mocks, post, state, url } = yield* routed({ harness: "pi", holdsPhi: () => false });
	const sealed = { harness: "pi", model: piModels.sealed, session } as const;

	yield* Effect.forEach(whilePinned, (turns) => posted(post, sealed, turns), { concurrency: 1 });

	const whilePinnedSeen = {
		judged: yield* mocks.judge.received,
		status: yield* statusOn(url, session),
	};

	yield* posted(post, { harness: "pi", model: piModels.auto, session }, afterThePinnedStretch);

	const judged = yield* mocks.judge.received;
	const lines = yield* laneLines(state);

	return {
		judged: { asked: yield* judgedOf(judged, marked), calls: judged.length },
		lines: pipe(
			lines,
			Array.map(({ account, judgeCost, judgeFailures, lane, reason }) => [
				account,
				lane,
				reason,
				judgeCost > none,
				judgeFailures,
			]),
		),
		status: yield* statusOn(url, session),
		whilePinned: { judged: whilePinnedSeen.judged.length, status: whilePinnedSeen.status },
	};
});

const statusOf = (seen: { readonly cleared: number; readonly account: string }): Shown => ({
	accounts: { clean: [{ name: "open", vendor: "anthropic" }], sealed: [{ name: "baa", vendor: "anthropic" }] },
	cleared: seen.cleared,
	last: { account: seen.account, model: fakes.targetModel, substitute: false },
	pinned: false,
	sealed: none,
	session,
});

const pinnedStretch = Effect.gen(function* pinnedStretch() {
	const seen = yield* sealedThenAuto;

	assert.deepStrictEqual(seen, {
		judged: { asked: marked, calls: marked.length },
		lines: [
			["baa", "sealed", "pinned", false, none],
			["baa", "sealed", "pinned", false, none],
			["open", "clean", "clean", true, none],
		],
		status: statusOf({ account: "open", cleared: marked.length + emptySystemPart }),
		whilePinned: { judged: none, status: statusOf({ account: "baa", cleared: none }) },
	});
});

const ok = 200;

const accountsAndReasons = Effect.fnUntraced(function* accountsAndReasons(state: string) {
	const lines = yield* laneLines(state);

	return pipe(
		lines,
		Array.map(({ account, reason }) => [account, reason]),
	);
});

const unreadableRegistry = Effect.gen(function* unreadableRegistry() {
	const fs = yield* FileSystem.FileSystem;
	const repo = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-repo-" });
	const listed = yield* routed({ configExtras: { baaRepos: [repo] }, holdsPhi: () => false });
	const unlisted = yield* routed({ holdsPhi: () => false });

	const routers = [
		{ model: pinnedModel, run: listed },
		{ model: autoOf.claude, run: unlisted },
	];

	yield* Effect.forEach(routers, ({ run }) => unreadableLeases(run.state), { concurrency: 1 });

	const statuses = yield* Effect.forEach(
		routers,
		({ model, run }) => posted(run.post, { harness: "claude", model, session }, [user(asked.first)]),
		{ concurrency: 1 },
	);

	const lines = yield* Effect.forEach(routers, ({ run }) => accountsAndReasons(run.state), { concurrency: 1 });

	assert.deepStrictEqual<unknown>(
		{ lines, statuses },
		{ lines: [[["baa", "pinned"]], [["open", "clean"]]], statuses: [ok, ok] },
	);
});

const ruleSealedFixture = "Fixture patient, SSN 536-22-8726.";

const fixtures = Effect.gen(function* fixtures() {
	const { mocks, post, state, url } = yield* routed({
		configExtras: { fixtures: [ruleSealedFixture] },
		holdsPhi: () => false,
	});

	yield* Effect.forEach(
		[
			["fixture-1", ruleSealedFixture],
			["fixture-2", `${ruleSealedFixture} `],
			["fixture-3", Str.uncapitalize(ruleSealedFixture)],
		],
		([of = "", text = ""]) => posted(post, { harness: "claude", model: autoOf.claude, session: of }, [user(text)]),
		{ concurrency: 1 },
	);

	const judged = yield* mocks.judge.received;
	const lines = yield* laneLines(state);
	const counted = yield* Effect.forEach(["fixture-1", "fixture-2"], (of) => statusOn(url, of), { concurrency: 1 });

	const counts = pipe(
		counted,
		Array.map(({ cleared, sealed }) => ({ cleared, sealed })),
	);

	assert.deepStrictEqual(
		{
			counts,
			judged: judged.length,
			lines: pipe(
				lines,
				Array.map(({ account, reason }) => [account, reason]),
			),
		},
		{
			counts: [
				{ cleared: emptySystemPart + onePart, sealed: none },
				{ cleared: emptySystemPart, sealed: onePart },
			],
			judged: 0,
			lines: [
				["open", "clean"],
				["baa", "sealed new content"],
				["baa", "sealed new content"],
			],
		},
	);
});

const judgeEndpoint = "http://127.0.0.1:9/v1";

const modes = Effect.gen(function* modes() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-judge-key-" });
	const keyFile = path.join(folder, "judge");

	yield* fs.writeFileString(keyFile, `${fakes.judgeKey}\n`);

	const relativeKeyFile = path.relative(path.resolve(), keyFile);

	const built = yield* Effect.forEach(
		[
			{ mode: "shadow" },
			{ mode: "baa" },
			{ mode: false },
			{ baaRepos: ["phi-repo"] },
			{ judge: { endpoint: judgeEndpoint, keyFile: relativeKeyFile } },
			{ judge: { endpoint: judgeEndpoint, keyFile } },
			{},
		],
		(configExtras) => Effect.exit(Effect.scoped(routed({ configExtras, holdsPhi: () => false }))),
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(
		pipe(
			built,
			Array.map((exit) => Exit.isSuccess(exit)),
		),
		[false, false, false, false, false, true, true],
	);
}).pipe(Effect.scoped);

it.layer(Layer.mergeAll(NodeServices.layer, SessionRequests.layer, FetchHttpClient.layer))(
	"pin and fixtures",
	(test) => {
		test.effect(
			"pi: requests on phi/sealed run on the BAA account with nothing judged, and the first on phi/auto after them judges the parts they never judged",
			() => pinnedStretch,
		);
		test.effect(
			"a listed fixture clears with no rule and no judge call, and the same text with one more space or one letter's case changed seals",
			() => fixtures,
		);
		test.effect(
			"an unreadable lease registry fails no request that is pinned or that comes while no BAA repo is listed",
			() => unreadableRegistry,
		);
		test.effect(
			"the configuration refuses a mode key, whatever its value, a relative BAA repo and a relative judge key file",
			() => modes,
		);
	},
);
