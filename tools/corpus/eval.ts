import {
	Array,
	Cause,
	Console,
	Effect,
	FileSystem,
	Number as Num,
	Option,
	Path,
	Predicate,
	Schema,
	pipe,
} from "effect";
import { CaseFromJsonLine, SyntheticIdentities } from "./manifest.ts";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Digest } from "effect/crypto";
import { Judge } from "#router/client/judge/index.ts";
import type { JudgeChoice } from "./judges.ts";
import { decodeJsonLines } from "./jsonl.ts";
import { evaluate } from "./evaluate.ts";
import { judgeOf } from "./judges.ts";
import { outputOf } from "./render.ts";
import { playGate } from "./gate-corpus.ts";

class GateFailed extends Schema.TaggedError<GateFailed, { readonly brand: unique symbol }>()("GateFailed", {
	message: Schema.String,
}) {}

const usage =
	"usage: bun tools/corpus/eval.ts [--judge recorded|live] [--record] [--corpus <manifest.jsonl>] [--recordings <recordings.jsonl>]";

const runtimeAndScript = 2;

const noUnrecordedCalls = 0;

interface Args {
	readonly manifest: Option.Option<string>;
	readonly judge: JudgeChoice;
}

const flags = ["--corpus", "--judge", "--recordings"];

const switches = ["--record"];

const flagAndValue = 2;

interface JudgeFlags {
	readonly source: string;
	readonly record: boolean;
	readonly recordings: string | undefined;
}

const choiceOf = ({ source, record, recordings }: JudgeFlags): Option.Option<JudgeChoice> => {
	if (source === "live") {
		return Option.some({ name: source, record, recordings });
	}

	if (source === "recorded" && !record) {
		return Option.some({ name: source, recordings });
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
		record: Array.contains(argv, "--record"),
		recordings: given.get("--recordings"),
		source: given.get("--judge") ?? "recorded",
	});

	if (!known || given.size * flagAndValue !== pairs.length || Option.isNone(judge)) {
		return Effect.fail(new Cause.IllegalArgumentError(usage));
	}

	return Effect.succeed({ judge: judge.value, manifest: Option.fromUndefinedOr(given.get("--corpus")) });
};

const decodeSynthetic = Schema.decodeUnknownEffect(Schema.fromJsonString(SyntheticIdentities));

const manifestReport = Effect.fn("manifestReport")(function* manifestReport(manifest: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const text = yield* fs.readFileString(manifest);
	const cases = yield* decodeJsonLines({ schema: CaseFromJsonLine, source: manifest, text });
	const listed = yield* fs.readFileString(path.join(path.dirname(manifest), "synthetic.json"));
	const synthetic = yield* decodeSynthetic(listed);
	const report = yield* evaluate({ cases, synthetic });

	return [{ report, title: `Corpus ${manifest}` }];
});

const gateReports = pipe(
	playGate,
	Effect.map(Array.map(({ seed, report }) => ({ report, title: `Draw of seed ${String(seed)}` }))),
);

const noLeaks = 0;

const gate = (leaks: number, unrecorded: number): Effect.Effect<void, GateFailed> => {
	if (leaks > noLeaks || unrecorded > noUnrecordedCalls) {
		const message = `${String(leaks)} leaked in-policy case(s), ${String(unrecorded)} unrecorded judge call(s)`;

		return Effect.fail(GateFailed.make({ message }));
	}

	return Effect.void;
};

const program = Effect.gen(function* program() {
	const args = yield* argsOf(Array.drop(process.argv, runtimeAndScript));

	const asked = yield* judgeOf(args.judge);

	const played = Option.match(args.manifest, {
		onNone: () => gateReports,
		onSome: (manifest) => manifestReport(manifest),
	});

	const sections = yield* Effect.provideService(played, Judge, asked.judge);
	const unrecorded = yield* asked.unrecorded;

	const outputs = pipe(
		sections,
		Array.map(({ title, report }) => `${title}\n${outputOf(report)}\n`),
	);

	const leaks = Num.sumAll(
		pipe(
			sections,
			Array.map(({ report }) => report.leaks.length),
		),
	);

	yield* Console.log(Array.join([...outputs, `unrecorded judge calls ${String(unrecorded)}`], "\n"));
	yield* asked.writeRecordings;

	return yield* gate(leaks, unrecorded);
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide([NodeServices.layer, Digest.layerWebCrypto])));
