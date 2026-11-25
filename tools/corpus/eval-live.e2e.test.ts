import { Array, DateTime, Effect, FileSystem, Option, Path, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, it } from "@effect/vitest";
import { configuredEnv, mockOn } from "#tools/judge/configured.ts";
import { NodeServices } from "@effect/platform-node";
import type { Reply } from "#router/client/mock-upstreams/index.ts";
import { encodeCorpus } from "./generate.ts";
import { identifierKind } from "#router/features/policy/index.ts";

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

const tokensPerCall = 1000;

const costPerCall = 0.0001;

const clears: Reply = {
	body: {
		answers: [{ name: "identifier", probability: 0, type: "predicate" }],
		usage: { input_tokens: tokensPerCall },
	},
	kind: "body",
};

const costDecimals = 4;

const leakLine = "in-policy positive cases 1: leaked 1";

const clean = 0;

const manifestOf = Effect.fn("manifestOf")(function* manifestOf(subject: typeof whole) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-corpus-" });
	const manifest = path.join(folder, "manifest.jsonl");
	const encoded = yield* encodeCorpus([subject]);

	yield* fs.writeFileString(manifest, encoded);
	yield* fs.writeFileString(path.join(folder, "synthetic.json"), '{"exact":[],"prefixes":[]}');

	return manifest;
});

const evalOf = Effect.fn("evalOf")(function* evalOf(args: readonly string[], env: Readonly<Record<string, string>>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const path = yield* Path.Path;
	const cwd = path.resolve(import.meta.dirname, "../..");

	const command = ChildProcess.make("bun", ["tools/corpus/eval.ts", ...args], { cwd, env, extendEnv: true });

	const handle = yield* spawner.spawn(command);
	const stdout = yield* Stream.mkString(Stream.decodeText(Stream.drainFork(handle.stdout, handle.stderr)));
	const exitCode = yield* handle.exitCode;

	return { exitCode, stdout };
});

const judgedLine = (calls: number): string => {
	const cost = (calls * costPerCall).toFixed(costDecimals);

	return `judge calls ${String(calls)}, input tokens ${String(calls * tokensPerCall)}, cost $${cost}, pieces sealed by a judge failure 0`;
};

const liveRun = Effect.gen(function* liveRun() {
	const mock = yield* mockOn(() => clears);
	const env = yield* configuredEnv(mock.endpoint, { keyEnv: "PHI_TEST_KEY" });
	const manifest = yield* manifestOf(whole);
	const { exitCode, stdout } = yield* evalOf(["--judge", "live", "--corpus", manifest], env);
	const received = yield* mock.received;
	const judged = judgedLine(received.length);

	assert.deepStrictEqual(
		pipe(
			received,
			Array.map(({ bearer }) => bearer),
			Array.dedupe,
		),
		["env-key"],
		stdout,
	);
	assert.deepNestedPropertyVal(received, "[0].body.model", "gpt-6-luna");
	assert.includeMembers(Str.split(stdout, "\n"), [leakLine, judged]);
	assert.notStrictEqual(exitCode, clean, stdout);
}).pipe(Effect.scoped);

const recordThenReplay = Effect.gen(function* recordThenReplay() {
	const path = yield* Path.Path;
	const mock = yield* mockOn(() => clears);
	const env = yield* configuredEnv(mock.endpoint, { keyEnv: "PHI_TEST_KEY" });
	const manifest = yield* manifestOf(whole);
	const recordings = path.join(path.dirname(manifest), "recordings.jsonl");

	const [began, live, ended] = yield* Effect.all(
		[
			DateTime.now,
			evalOf(["--judge", "live", "--record", "--corpus", manifest, "--recordings", recordings], env),
			DateTime.now,
		],
		{ concurrency: 1 },
	);

	const asked = (yield* mock.received).length;
	const replay = yield* evalOf(["--corpus", manifest, "--recordings", recordings], env);

	return { asked, began, ended, live, received: mock.received, replay };
});

const recordedRun = Effect.gen(function* recordedRun() {
	const { asked, began, ended, live, received, replay } = yield* recordThenReplay;
	const [first] = Str.split(live.stdout, "\n");
	const prefix = `live judge decisions, model gpt-6-luna, started `;
	const started = DateTime.make(Str.slice(prefix.length)(first));
	const after = yield* received;

	assert.isTrue(Str.startsWith(prefix)(first), live.stdout);
	assert.isTrue(
		Option.exists(started, (at) => DateTime.between(at, { maximum: ended, minimum: began })),
		first,
	);
	assert.include(Str.split(live.stdout, "\n"), leakLine);
	assert.includeMembers(Str.split(replay.stdout, "\n"), [leakLine, "unrecorded judge calls 0"], replay.stdout);
	assert.lengthOf(after, asked);
}).pipe(Effect.scoped);

it.layer(NodeServices.layer, { excludeTestServices: true })("eval.ts --judge live", (test) => {
	test.effect(
		"--record writes answers that replay the run with no unrecorded call, and prints the judge, its model and the start time",
		() => recordedRun,
		{ timeout: 60_000 },
	);

	test.effect("asks the configured judge, prints its calls and cost, and exits non-zero on a leak", () => liveRun, {
		timeout: 60_000,
	});
});
