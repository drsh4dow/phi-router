import { Array, ConfigProvider, Context, Effect, FileSystem, Layer, Path, Schema, String as Str, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { Post, Turn } from "./mocked-router.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest, laneLines, mocked, routed } from "./mocked-router.ts";
import { Base64Url } from "effect/encoding";
import { NodeServices } from "@effect/platform-node";
import { VerdictStore } from "#router/client/verdict-store.ts";
import { routerProcess } from "./router-process.ts";

const session = "store-1";

const racing = 20;

const storeIn = Effect.fnUntraced(function* storeIn(state: string) {
	const env = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { XDG_STATE_HOME: state } }));
	const built = yield* Layer.build(Layer.provide(VerdictStore.layer, env));

	return Context.get(built, VerdictStore);
});

const stateFolder = FileSystem.FileSystem.pipe(
	Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "phi-router-store-" })),
);

const store = stateFolder.pipe(Effect.flatMap(storeIn));

const sessionFile = Effect.fnUntraced(function* sessionFile(state: string, of: string) {
	const path = yield* Path.Path;

	return path.join(state, "sessions", `${Base64Url.encode(of)}.json`);
});

const keysFrom = (prefix: string): readonly string[] => Array.makeBy(racing, (index) => `${prefix}-${String(index)}`);

const raced = Effect.gen(function* raced() {
	const verdicts = yield* store;
	const sealing = keysFrom("sealing");
	const clearing = keysFrom("clearing");

	const records = [
		...pipe(
			sealing,
			Array.map((key) =>
				verdicts.record(session, "p", [
					[key, "cleared"],
					["shared", "sealed"],
				]),
			),
		),
		...pipe(
			clearing,
			Array.map((key) =>
				verdicts.record(session, "p", [
					[key, "cleared"],
					["shared", "cleared"],
				]),
			),
		),
	];

	yield* Effect.all(records, { concurrency: "unbounded" });

	const known = yield* verdicts.read(session, "p");

	assert.deepStrictEqual(pipe([...sealing, ...clearing], Array.map(known.standing), Array.dedupe), ["cleared"]);
	assert.strictEqual(known.standing("shared"), "sealed");
});

const ordered = Effect.gen(function* ordered() {
	const verdicts = yield* store;

	yield* verdicts.record(session, "p", [["first", "sealed"]]);
	yield* verdicts.record(session, "p", [
		["first", "cleared"],
		["second", "cleared"],
	]);
	yield* verdicts.record(session, "p", [["second", "sealed"]]);

	const known = yield* verdicts.read(session, "p");

	assert.deepStrictEqual([known.standing("first"), known.standing("second")], ["sealed", "sealed"]);
});

const retired = Effect.gen(function* retired() {
	const verdicts = yield* store;

	yield* verdicts.record(session, "old", [["first", "sealed"]]);

	const underNew = yield* verdicts.read(session, "new");

	yield* verdicts.record(session, "new", [["second", "cleared"]]);

	const underOld = yield* verdicts.read(session, "old");

	assert.deepStrictEqual(
		[underNew.standing("first"), underOld.standing("first"), underOld.standing("second")],
		["unknown", "unknown", "unknown"],
	);
});

const oldFileText = (pinned: boolean): string =>
	`{"openWrote":["first-reply"],"pinned":${String(pinned)},"policy":"p","verdicts":{"first":"sealed","second":"cleared"}}`;

const privateModes = { file: 0o600, folder: 0o700 } as const;

const oldFileLoads = Effect.fnUntraced(function* oldFileLoads(pinned: boolean) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const state = yield* stateFolder;
	const verdicts = yield* storeIn(state);
	const file = yield* sessionFile(path.join(state, "phi-router"), session);

	yield* fs.makeDirectory(path.dirname(file), { mode: privateModes.folder, recursive: true });
	yield* fs.writeFileString(file, oldFileText(pinned), { mode: privateModes.file });

	const readOf = Effect.fnUntraced(function* readOf() {
		const known = yield* verdicts.read(session, "p");

		return {
			openWrote: pipe(["first-reply", "second-reply"], Array.map(known.openWrote)),
			standing: pipe(["first", "second", "third"], Array.map(known.standing)),
			summary: yield* verdicts.summary(session, "p"),
		};
	});

	const loaded = yield* readOf();

	yield* verdicts.record(session, "p", [["third", "cleared"]]);
	yield* verdicts.wrote(session, "p", ["second-reply"]);

	const rewritten = yield* readOf();
	const written = yield* fs.readFileString(file);
	const keepsPin = Str.includes('"pinned"')(written);

	assert.deepStrictEqual(
		{ keepsPin, loaded, rewritten },
		{
			keepsPin: false,
			loaded: {
				openWrote: [true, false],
				standing: ["sealed", "cleared", "unknown"],
				summary: { cleared: 1, sealed: 1 },
			},
			rewritten: {
				openWrote: [true, true],
				standing: ["sealed", "cleared", "cleared"],
				summary: { cleared: 2, sealed: 1 },
			},
		},
	);
});

const replyKeysAdd = Effect.gen(function* replyKeysAdd() {
	const verdicts = yield* store;

	yield* verdicts.wrote(session, "p", ["first-reply"]);
	yield* verdicts.wrote(session, "p", ["second-reply"]);

	const known = yield* verdicts.read(session, "p");

	assert.deepStrictEqual(pipe(["first-reply", "second-reply", "never-streamed"], Array.map(known.openWrote)), [
		true,
		true,
		false,
	]);
});

const patient = { timeout: 60_000 };

const nothingJudged = 0;

const reused = Effect.gen(function* reused() {
	const client = yield* HttpClient.HttpClient;
	const { env, mocks } = yield* mocked({ holdsPhi: () => false });
	const body = yield* bodyOf([{ role: "user", text: "List the build steps." }]);

	const judgedByOneRun = Effect.gen(function* judgedByOneRun() {
		const before = yield* mocks.judge.received;
		const router = yield* routerProcess(["bun", "src/router/main.ts"], env);

		const answer = yield* client.execute(
			HttpClientRequest.prependUrl(router.url)(claudeRequest({ body, session: "policy-1" })),
		);

		yield* answer.text;
		yield* router.kill;

		const after = yield* mocks.judge.received;

		return after.length - before.length;
	}).pipe(Effect.scoped);

	const first = yield* judgedByOneRun;
	const second = yield* judgedByOneRun;

	assert.isAbove(first, second);
	assert.strictEqual(second, nothingJudged);
});

const asked = { first: "OLD-PIN-FIRST: list the build steps.", second: "OLD-PIN-SECOND: now the tests." };

const judgedText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const judgedIn = Effect.fnUntraced(function* judgedIn(received: readonly { readonly body: unknown }[]) {
	const bodies = yield* judgedText(
		pipe(
			received,
			Array.map(({ body }) => body),
		),
	);

	return pipe(
		[asked.first, asked.second],
		Array.map((text) => Str.includes(text)(bodies)),
	);
});

const postedIn = Effect.fnUntraced(function* postedIn(post: Post, turns: readonly Turn[]) {
	const body = yield* bodyOf(turns);
	const response = yield* post({ body, session: "old-pin-1" });

	yield* response.text;
});

const oldPinRouted = Effect.gen(function* oldPinRouted() {
	const fs = yield* FileSystem.FileSystem;
	const { mocks, post, state } = yield* routed({ holdsPhi: () => false });
	const file = yield* sessionFile(state, "old-pin-1");

	yield* postedIn(post, [{ role: "user", text: asked.first }]);

	const judgedFirst = yield* mocks.judge.received.pipe(Effect.flatMap(judgedIn));
	const written = yield* fs.readFileString(file);

	yield* fs.writeFileString(file, Str.replace('"policy":', '"pinned":true,"policy":')(written));

	const before = yield* mocks.judge.received;

	yield* postedIn(post, [
		{ role: "user", text: asked.first },
		{ role: "assistant", text: "ok" },
		{ role: "user", text: asked.second },
	]);

	const lines = yield* laneLines(state);
	const judgedAfter = yield* mocks.judge.received;

	assert.deepStrictEqual<unknown>(
		{
			baa: (yield* mocks.baa.received).length,
			judged: yield* judgedIn(Array.drop(judgedAfter, before.length)),
			judgedFirst,
			lines: pipe(
				lines,
				Array.map(({ account, reason }) => [account, reason]),
			),
			open: (yield* mocks.open.received).length,
		},
		{
			baa: 0,
			judged: [false, true],
			judgedFirst: [true, false],
			lines: [
				["open", "clean"],
				["open", "clean"],
			],
			open: 2,
		},
	);
});

it.layer(NodeServices.layer)("a session whose file the old code wrote with pinned true", (test) => {
	test.effect(
		"routes by its verdicts: a new part is judged, a cleared part is not judged again, and the request reaches the open account",
		() => oldPinRouted,
	);
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("a restarted router", (test) => {
	test.effect("reuses the verdicts its last run stored", () => reused, patient);
});

it.layer(NodeServices.layer)("the verdict store", (test) => {
	test.effect("judgments stored at once all land, and a sealed verdict wins over a racing cleared one", () => raced);
	test.effect("a sealed verdict stays sealed whichever request stores first", () => ordered);
	test.effect(
		"a verdict of another policy version reads as unknown, and a write under the new one retires it",
		() => retired,
	);
	test.effect.each([true, false])(
		"a file the old code wrote with pinned %s loads its verdicts and reply keys, counts them, and takes later writes",
		oldFileLoads,
	);
	test.effect("the reply keys of each completed open stream add to those stored before", () => replyKeysAdd);
});
