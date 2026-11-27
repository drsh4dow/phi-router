import { Array, Effect, pipe } from "effect";
import { defaultSeed, generate } from "./generate.ts";
import type { Report } from "./report.ts";
import { evaluate } from "./evaluate.ts";
import { loadImages } from "./images.ts";
import { synthetic } from "./synthetic.ts";

const gatedDraws = 1;

const gatedSeeds = Array.makeBy(gatedDraws, (index) => defaultSeed + index);

interface DrawReport {
	readonly seed: number;
	readonly report: Report;
}

const playGate = Effect.gen(function* playGate() {
	const images = yield* loadImages;

	return yield* Effect.forEach(
		gatedSeeds,
		(seed) =>
			pipe(
				evaluate({ cases: generate({ images, seed }), synthetic }),
				Effect.map((report): DrawReport => ({ report, seed })),
			),
		{ concurrency: "unbounded" },
	);
});

export { playGate };

export type { DrawReport };
