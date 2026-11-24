import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge/index.ts";
import { NodeServices } from "@effect/platform-node";
import { encodeCorpus } from "./generate.ts";
import { evaluate } from "./evaluate.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { recording } from "./recorded.ts";

const usage = { calls: 1, cost: 0, inputTokens: 1, ms: 0 };

const clears = Judge.of({
	identifier: () => Effect.succeed({ score: 0, usage }),
	kind: () => Effect.die("a score of 0 asks no kind"),
	model: "scripted",
	name: "decisions",
});

/** A canary whose halves reach an open account in two user messages, with a reply between them. */
const apart = {
	canaries: ["canary-apart-tail"],
	canaryParts: { "canary-apart-tail": ["canary-apart", "-tail"] },
	expect: "phi",
	fragments: [],
	id: "apart",
	messages: [
		{ role: "user", text: "The id starts canary-apart" },
		{ role: "assistant", text: "Go on." },
		{ role: "user", text: "Then it ends -tail" },
	],
	strata: { carrier: "log-line", entry: "user", identifier: identifierKind.memberNumber, transform: "split" },
} as const;

/** A canary the judge clears, so it reaches an open account whole in the second user message. */
const whole = {
	canaries: ["canary-whole-7731"],
	expect: "phi",
	fragments: [],
	id: "whole",
	messages: [
		{ role: "user", text: "Why does the import drop a row?" },
		{ role: "assistant", text: "Which row?" },
		{ role: "user", text: "The one with canary-whole-7731" },
	],
	strata: { carrier: "log-line", entry: "user", identifier: identifierKind.memberNumber, transform: "plain" },
} as const;

const noSynthetic = '{"exact":[],"prefixes":[]}';

const clean = 0;

const corpusOf = Effect.fn("corpusOf")(function* corpusOf(subject: typeof apart | typeof whole) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-corpus-" });
	const recorder = yield* recording(clears);
	const played = evaluate({ cases: [subject], synthetic: { exact: [], prefixes: [] } });

	yield* Effect.provideService(played, Judge, recorder.judge);

	const files = [
		["manifest.jsonl", yield* encodeCorpus([subject])],
		["synthetic.json", noSynthetic],
		["recordings.jsonl", yield* recorder.contents],
	] as const;

	yield* Effect.forEach(files, ([name, text]) => fs.writeFileString(path.join(folder, name), text), {
		concurrency: 1,
	});

	return folder;
});

const replayOf = Effect.fn("replayOf")(function* replayOf(folder: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const cwd = path.resolve(import.meta.dirname, "../..");
	const manifest = path.join(folder, "manifest.jsonl");
	const recordings = path.join(folder, "recordings.jsonl");

	const command = ChildProcess.make(
		"bun",
		["tools/corpus/eval.ts", "--corpus", manifest, "--recordings", recordings],
		{ cwd },
	);

	const handle = yield* spawner.spawn(command);
	const stdout = yield* Stream.mkString(Stream.decodeText(Stream.drainFork(handle.stdout, handle.stderr)));
	const exitCode = yield* handle.exitCode;

	return { exitCode, stdout };
});

const splitReported = Effect.gen(function* splitReported() {
	const folder = yield* corpusOf(apart);
	const { exitCode, stdout } = yield* replayOf(folder);

	assert.strictEqual(exitCode, clean, stdout);
	assert.include(stdout, "Leaked cases: none");
	assert.match(stdout, /split across messages[^\n]*\n[^\n]*\napart +\S+ +log-line +split +user +2\n/u);
	assert.include(stdout, "unrecorded judge calls 0");
}).pipe(Effect.scoped);

const leakFails = Effect.gen(function* leakFails() {
	const folder = yield* corpusOf(whole);
	const { exitCode, stdout } = yield* replayOf(folder);

	assert.notStrictEqual(exitCode, clean, stdout);
	assert.match(stdout, /Leaked cases\n[^\n]*\nwhole +\S+ +log-line +plain +user +2\n/u);
	assert.include(stdout, "in-policy positive cases 1: leaked 1");
	assert.include(stdout, "unrecorded judge calls 0");
}).pipe(Effect.scoped);

it.layer(Layer.mergeAll(NodeServices.layer, Digest.layerWebCrypto))("bun run eval:recorded", (test) => {
	test.effect("reports a split canary with recorded answers, and exits 0", () => splitReported, { timeout: 60_000 });
	test.effect("reports a complete canary that reached an open account, and exits non-zero", () => leakFails, {
		timeout: 60_000,
	});
});
