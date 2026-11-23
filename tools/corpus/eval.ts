import { Array, Cause, Console, Effect, FileSystem, Option, Path, Predicate, Schema, pipe } from "effect";
import { CaseFromJsonLine, SyntheticIdentities } from "./manifest.ts";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge.ts";
import type { JudgeChoice } from "./judges.ts";
import { decodeJsonLines } from "./jsonl.ts";
import { defaultCorpus } from "./default-corpus.ts";
import { evaluate } from "./evaluate.ts";
import { judgeOf } from "./judges.ts";
import { outputOf } from "./render.ts";

class GateFailed extends Schema.TaggedError<GateFailed, { readonly brand: unique symbol }>()("GateFailed", {
	message: Schema.String,
}) {}

const usage =
	"usage: bun tools/corpus/eval.ts [--judge recorded|live] [--claude] [--record] [--corpus <manifest.jsonl>] [--recordings <recordings.jsonl>]";

/** `process.argv` holds the runtime and the script before the arguments. */
const runtimeAndScript = 2;

const noUnrecordedCalls = 0;

/** The corpus the command plays, none for the default one, and the judge that answers. */
interface Args {
	readonly corpus: Option.Option<string>;
	readonly judge: JudgeChoice;
}

const flags = ["--corpus", "--judge", "--recordings"];

const switches = ["--claude", "--record"];

const flagAndValue = 2;

/** The judge the flags name: its source, whether it is the Claude judge, and where its recordings are. */
interface Named {
	readonly name: string;
	readonly claude: boolean;
	readonly record: boolean;
	readonly recordings: string | undefined;
}

const choiceOf = ({ name, claude, record, recordings }: Named): Option.Option<JudgeChoice> => {
	if (name === "live") {
		return Option.some({ claude, name, record, recordings });
	}

	if (name === "recorded" && !record) {
		return Option.some({ claude, name, recordings });
	}

	return Option.none();
};

const argsOf = (argv: readonly string[]): Effect.Effect<Args, Cause.IllegalArgumentError> => {
	const pairs = pipe(
		argv,
		Array.filter((arg) => !Array.contains(switches, arg)),
	);

	const given = new Map(
		pipe(
			pairs,
			Array.chunksOf(flagAndValue),
			Array.map(([flag, value]) => [flag, value] as const),
		),
	);

	const known = Array.every(
		Array.fromIterable(given),
		([flag, value]) => Array.contains(flags, flag) && Predicate.isString(value),
	);

	const judge = choiceOf({
		claude: Array.contains(argv, "--claude"),
		name: given.get("--judge") ?? "recorded",
		record: Array.contains(argv, "--record"),
		recordings: given.get("--recordings"),
	});

	if (!known || given.size * flagAndValue !== pairs.length || Option.isNone(judge)) {
		return Effect.fail(new Cause.IllegalArgumentError(usage));
	}

	return Effect.succeed({ corpus: Option.fromUndefinedOr(given.get("--corpus")), judge: judge.value });
};

const decodeSynthetic = Schema.decodeUnknownEffect(Schema.fromJsonString(SyntheticIdentities));

/** A corpus from a manifest, with the test identities in the `synthetic.json` beside it. */
const corpusAt = Effect.fn("corpusAt")(function* corpusAt(manifest: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const text = yield* fs.readFileString(manifest);
	const cases = yield* decodeJsonLines({ schema: CaseFromJsonLine, source: manifest, text });
	const listed = yield* fs.readFileString(path.join(path.dirname(manifest), "synthetic.json"));
	const synthetic = yield* decodeSynthetic(listed);

	return { cases, synthetic };
});

const noLeaks = 0;

const gate = (leaks: number, unrecorded: number): Effect.Effect<void, GateFailed> => {
	if (leaks > noLeaks || unrecorded > noUnrecordedCalls) {
		const message = `${String(leaks)} leaked in-policy case(s), ${String(unrecorded)} unrecorded judge call(s)`;

		return Effect.fail(GateFailed.make({ message }));
	}

	return Effect.void;
};

/**
 * `bun tools/corpus/eval.ts [--judge recorded|live] [--claude] [--record] [--corpus <manifest.jsonl>] [--recordings <recordings.jsonl>]`
 * plays a corpus through `decide` and `guard` with a judge and prints, per stratum, the positive cases whose complete
 * canary reached an open account, then the split canaries, over-routing, fragments, lanes and judge cost. Without
 * `--corpus` it plays the default generated corpus, and a `--corpus` manifest needs its `synthetic.json` beside it.
 * `--judge recorded`, the default, answers from `--recordings`, or the judge's recordings kept beside this file.
 * `--judge live` asks the judge the router's configuration file picks, and costs money. It prints the judge's name,
 * model and start time first. `--claude` takes the Claude judge instead: live, on the configuration's first Anthropic
 * BAA account, or its recordings. `--record`, taken only with `--judge live`, writes the live judge's answers to
 * `--recordings`, or its recordings beside this file, once the report prints and before the run exits, so a run that
 * leaks keeps them.
 *
 * It exits non-zero on a leak among positive cases, on an unrecorded judge call and on a manifest line that does not
 * decode. A canary split across messages is reported apart and never fails it.
 */
const program = Effect.gen(function* program() {
	const args = yield* argsOf(Array.drop(process.argv, runtimeAndScript));

	const { cases, synthetic } = yield* Option.match(args.corpus, {
		onNone: () => defaultCorpus,
		onSome: (manifest) => corpusAt(manifest),
	});

	const asked = yield* judgeOf(args.judge);
	const report = yield* Effect.provideService(evaluate({ cases, synthetic }), Judge, asked.judge);
	const unrecorded = yield* asked.unrecorded;

	yield* Console.log(Array.join([outputOf(report), `unrecorded judge calls ${String(unrecorded)}`], "\n"));
	yield* asked.writeRecordings;

	return yield* gate(report.leaks.length, unrecorded);
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide([NodeServices.layer, Digest.layerWebCrypto])));
