import { Array, Context, Effect, Layer, pipe } from "effect";
import type { Case, CleanCase, Message, PhiCase } from "./manifest.ts";
import { defaultSeed, generate } from "./generate.ts";
import type { Images } from "./images.ts";
import { NodeServices } from "@effect/platform-node";
import { loadImages } from "./images.ts";
import { synthetic } from "./synthetic.ts";

type Phi = typeof PhiCase.Type;

const defaultCorpus = Effect.gen(function* defaultCorpus() {
	const images = yield* loadImages;

	return { cases: generate({ images, seed: defaultSeed }), images, synthetic };
});

class DefaultCorpus extends Context.Service<
	DefaultCorpus,
	{
		readonly cases: readonly Case[];
		readonly cleanCases: readonly (typeof CleanCase.Type)[];
		readonly images: Images;
		readonly phiCases: readonly Phi[];
	}
>()("phi-router/tools/corpus/default-corpus/DefaultCorpus") {
	public static readonly layer = Layer.effect(
		DefaultCorpus,
		pipe(
			defaultCorpus,
			Effect.map(({ cases, images }) => ({
				cases,
				cleanCases: pipe(
					cases,
					Array.filter((item) => item.expect === "clean"),
				),
				images,
				phiCases: pipe(
					cases,
					Array.filter((item) => item.expect === "phi"),
				),
			})),
		),
	).pipe(Layer.provide(NodeServices.layer));
}

const textsOf = (messages: readonly Message[]): readonly string[] =>
	pipe(
		messages,
		Array.flatMap((message) => {
			if ("text" in message) {
				return [message.text];
			}

			return [];
		}),
	);

const idsOf = (cases: readonly Case[]): readonly string[] =>
	pipe(
		cases,
		Array.map(({ id }) => id),
	);

export { DefaultCorpus, idsOf, textsOf };

export type { Phi };
