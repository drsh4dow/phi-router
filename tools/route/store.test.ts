import { Array, ConfigProvider, Context, Effect, FileSystem, Layer, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { VerdictStore } from "#router/client/verdict-store.ts";

const session = "store-1";

const racing = 20;

/** The verdict store over a fresh temp state folder. */
const store = Effect.gen(function* store() {
	const fs = yield* FileSystem.FileSystem;
	const state = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-store-" });
	const env = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { XDG_STATE_HOME: state } }));
	const built = yield* Layer.build(Layer.provide(VerdictStore.layer, env));

	return Context.get(built, VerdictStore);
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

const pinOutlivesVersion = Effect.gen(function* pinOutlivesVersion() {
	const verdicts = yield* store;

	yield* verdicts.record(session, "old", [["first", "sealed"]]);
	yield* verdicts.pin(session, "old", true);

	const known = yield* verdicts.read(session, "new");
	const summary = yield* verdicts.summary(session, "new");

	assert.deepStrictEqual(
		{ pinned: known.pinned, standing: known.standing("first"), summary },
		{ pinned: true, standing: "unknown", summary: { cleared: 0, pinned: true, sealed: 0 } },
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

it.layer(NodeServices.layer)("the verdict store", (test) => {
	test.effect("judgments stored at once all land, and a sealed verdict wins over a racing cleared one", () => raced);
	test.effect("a sealed verdict stays sealed whichever request stores first", () => ordered);
	test.effect(
		"a verdict of another policy version reads as unknown, and a write under the new one retires it",
		() => retired,
	);
	test.effect(
		"a session's pin outlives a change of policy version, in its read and its summary",
		() => pinOutlivesVersion,
	);
	test.effect("the reply keys of each completed open stream add to those stored before", () => replyKeysAdd);
});
