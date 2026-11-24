import { Array, Effect, FileSystem, Option, Path, Schema, String as Str, Struct, pipe } from "effect";
import { CaseFromJsonLine, SyntheticIdentities } from "./manifest.ts";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { cleanCase, planNegatives } from "./clean-cases.ts";
import { cleanImageCases, imageCases, loadImages } from "./images.ts";
import type { Case } from "./manifest.ts";
import type { Images } from "./images.ts";
import { phiCase } from "./phi-cases.ts";
import { planStrata } from "./plan.ts";
import { seeded } from "./random.ts";
import { synthetic } from "./synthetic.ts";

const defaultSeed = 1729;

const idDigits = 4;

const firstCaseNumber = 1;

type ReadImages = { readonly [Name in keyof Images]: Readonly<Uint8Array<Readonly<ArrayBufferLike>>> };

const caseId = (index: number): string => `h-${Str.padStart(idDigits, "0")(String(index + firstCaseNumber))}`;

const generate = ({ seed, images }: { readonly seed: number; readonly images: ReadImages }): readonly Case[] => {
	const rng = seeded(seed);
	const used = new Set<string>();

	const text = pipe(
		planStrata(rng),
		Array.map((strata) => phiCase({ rng, strata, used })),
	);

	const pictured = imageCases({ images, rng, used });

	const clean = pipe(
		planNegatives(),
		Array.map(({ negative, turn }) => cleanCase({ negative, rng, turn, used })),
	);

	const cleanPictured = cleanImageCases({ images, rng });

	return pipe(
		[...text, ...pictured, ...clean, ...cleanPictured],
		Array.map((item, index): Case => Struct.assign({ id: caseId(index) }, item)),
	);
};

const encodeCase = Schema.encodeEffect(CaseFromJsonLine);

/**
 * The corpus as a JSONL manifest, one case per line, each encoded through the manifest schema.
 *
 * @param {readonly Case[]} cases The corpus.
 * @returns {Effect.Effect<string, Schema.SchemaError>} The manifest's text.
 */
const encodeCorpus = (cases: readonly Case[]): Effect.Effect<string, Schema.SchemaError> =>
	Effect.map(
		Effect.forEach(cases, (item) => encodeCase(item), { concurrency: 1 }),
		(lines) => `${Array.join(lines, "\n")}\n`,
	);

class UsageError extends Schema.TaggedError<UsageError, { readonly brand: unique symbol }>()("UsageError", {
	message: Schema.String,
}) {}

const usage = "usage: bun tools/corpus/generate.ts <out.jsonl> [--seed N]";

const encodeSynthetic = Schema.encodeEffect(Schema.fromJsonString(SyntheticIdentities));

const Seed = Schema.NumberFromString.check(Schema.isInt());

const decodeOut = Schema.decodeUnknownEffect(Schema.Tuple([Schema.String]));

/** Parses `<out.jsonl> [--seed N]`. */
const argsOf = Effect.fn("argsOf")(function* argsOf(argv: readonly string[]) {
	const flagValueOffset = 1;
	const usageError = UsageError.make({ message: usage });
	const seedFlag = Array.findFirstIndex(argv, (arg) => arg === "--seed");

	const positional = Option.match(seedFlag, {
		onNone: () => argv,
		onSome: (at) => pipe(argv, Array.remove(at + flagValueOffset), Array.remove(at)),
	});

	const seedText = pipe(
		seedFlag,
		Option.flatMap((at) => Array.get(argv, at + flagValueOffset)),
	);

	if (Option.isSome(seedFlag) && Option.isNone(seedText)) {
		return yield* usageError;
	}

	const [out] = yield* Effect.mapError(decodeOut(positional), () => usageError);

	const seed = yield* Option.match(seedText, {
		onNone: () => Effect.succeed(defaultSeed),
		onSome: (text) => Effect.mapError(Schema.decodeEffect(Seed)(text), () => usageError),
	});

	return { out, seed };
});

const writeSynthetic = Effect.fn("writeSynthetic")(function* writeSynthetic(out: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const syntheticPath = path.join(path.dirname(out), "synthetic.json");
	const json = yield* encodeSynthetic(synthetic);

	yield* fs.writeFileString(syntheticPath, `${json}\n`);

	return syntheticPath;
});

const main = Effect.gen(function* main() {
	const scriptArgsStart = 2;
	const fs = yield* FileSystem.FileSystem;
	const { out, seed } = yield* argsOf(Array.drop(process.argv, scriptArgsStart));
	const images = yield* loadImages;
	const cases = generate({ images, seed });
	const manifest = yield* encodeCorpus(cases);

	yield* fs.writeFileString(out, manifest);

	const syntheticPath = yield* writeSynthetic(out);

	yield* Effect.log(`wrote ${String(cases.length)} cases with seed ${String(seed)} to ${out}, and ${syntheticPath}`);
});

if (import.meta.main) {
	NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
}

/** Generates the default corpus: `bun tools/corpus/generate.ts <out.jsonl> [--seed N]` writes it and `synthetic.json`. */
export { defaultSeed, encodeCorpus, generate };
