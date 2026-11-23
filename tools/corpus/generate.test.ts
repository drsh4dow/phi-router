import { Array, Effect, Schema, String as Str, pipe } from "effect";
import { Carrier, CaseFromJsonLine, Entry, Identifier, Negative, Transform } from "./manifest.ts";
import { DefaultCorpus, idsOf, textsOf } from "./default-corpus.ts";
import { assert, it } from "@effect/vitest";
import { defaultSeed, encodeCorpus, generate } from "./generate.ts";
import type { Case } from "./manifest.ts";
import type { Phi } from "./default-corpus.ts";
import { synthetic } from "./synthetic.ts";

const countOf = (values: readonly string[], value: string): number =>
	pipe(
		values,
		Array.filter((each) => each === value),
	).length;

const holdsText = (item: Case, found: (text: string) => boolean): boolean =>
	pipe(textsOf(item.messages), Array.some(found));

const listed = (text: string): boolean =>
	pipe(
		synthetic.exact,
		Array.some((identity) => Str.includes(identity)(text)),
	) ||
	pipe(
		synthetic.prefixes,
		Array.some((prefix) => Str.includes(prefix)(text)),
	);

const quotesCanaryBack = (item: Phi): boolean =>
	pipe(
		item.messages,
		Array.some(
			(message) =>
				message.role === "assistant" &&
				"text" in message &&
				pipe(
					item.canaries,
					Array.some((canary) => Str.includes(canary)(message.text)),
				),
		),
	);

const roundTrips = Effect.gen(function* roundTrips() {
	const { cases } = yield* DefaultCorpus;
	const manifest = yield* encodeCorpus(cases);
	const lines = Str.split("\n")(Str.trimEnd(manifest));
	const decode = Schema.decodeEffect(CaseFromJsonLine);
	const decoded = yield* Effect.forEach(lines, (line) => decode(line), { concurrency: 1 });

	assert.deepStrictEqual(idsOf(decoded), idsOf(cases));
});

const unique = Effect.gen(function* unique() {
	const minCanaryLength = 8;
	const minFragmentLength = 6;
	const { cases } = yield* DefaultCorpus;
	const ids = idsOf(cases);

	const canaries = pipe(
		cases,
		Array.flatMap(({ canaries: planted }) => planted),
	);

	const fragments = pipe(
		cases,
		Array.flatMap(({ fragments: planted }) => planted),
	);

	assert.strictEqual(new Set(ids).size, ids.length);
	assert.strictEqual(new Set([...canaries, ...fragments]).size, canaries.length + fragments.length);
	assert.deepStrictEqual(
		pipe(
			canaries,
			Array.filter((canary) => canary.length < minCanaryLength),
		),
		[],
	);
	assert.deepStrictEqual(
		pipe(
			fragments,
			Array.filter((fragment) => fragment.length < minFragmentLength),
		),
		[],
	);
});

const plantedFragments = Effect.gen(function* plantedFragments() {
	const { cleanCases } = yield* DefaultCorpus;

	const fragmentCases = pipe(
		cleanCases,
		Array.filter(({ strata }) => strata.negative === "fragment"),
	);

	const missing = pipe(
		fragmentCases,
		Array.flatMap((item) =>
			pipe(
				item.fragments,
				Array.filter((fragment) => !pipe(textsOf(item.messages), Array.some(Str.includes(fragment)))),
			),
		),
	);

	assert.isTrue(
		pipe(
			fragmentCases,
			Array.every(({ fragments }) => Array.isReadonlyArrayNonEmpty(fragments)),
		),
	);
	assert.deepStrictEqual(missing, []);
});

const syntheticListed = Effect.gen(function* syntheticListed() {
	const { cleanCases, phiCases } = yield* DefaultCorpus;

	const syntheticCases = pipe(
		cleanCases,
		Array.filter(({ strata }) => strata.negative === "synthetic-listed"),
	);

	const unlisted = pipe(
		syntheticCases,
		Array.filter((item) => !holdsText(item, listed)),
	);

	const phiListed = pipe(
		phiCases,
		Array.filter((item) => holdsText(item, listed)),
	);

	assert.isNotEmpty(syntheticCases);
	assert.deepStrictEqual(idsOf(unlisted), []);
	assert.deepStrictEqual(idsOf(phiListed), []);
});

const negativeClasses = Effect.gen(function* negativeClasses() {
	const minCasesPerNegative = 30;
	const { cleanCases, phiCases } = yield* DefaultCorpus;

	const negatives = pipe(
		cleanCases,
		Array.map(({ strata }) => strata.negative),
	);

	const canaries = pipe(
		phiCases,
		Array.flatMap(({ canaries: planted }) => planted),
	);

	const holdsCanary = (text: string): boolean =>
		pipe(
			canaries,
			Array.some((canary) => Str.includes(canary)(text)),
		);

	const leaked = pipe(
		cleanCases,
		Array.filter((item) => holdsText(item, holdsCanary)),
	);

	const short = pipe(
		Negative.literals,
		Array.filter((negative) => countOf(negatives, negative) < minCasesPerNegative),
	);

	assert.deepStrictEqual(short, []);
	assert.deepStrictEqual(idsOf(leaked), []);
});

const phiAxes = Effect.gen(function* phiAxes() {
	const minCasesPerValue = 20;
	const minBuried = 8;
	const maxBuried = 12;
	const { phiCases } = yield* DefaultCorpus;

	const axes: readonly (readonly [keyof Phi["strata"], readonly string[]])[] = [
		["identifier", Identifier.literals],
		["carrier", Carrier.literals],
		[
			"transform",
			pipe(
				Transform.literals,
				Array.filter((transform) => transform !== "buried"),
			),
		],
		["entry", Entry.literals],
	];

	const short = pipe(
		axes,
		Array.flatMap(([axis, values]) => {
			const seen = pipe(
				phiCases,
				Array.map(({ strata }) => strata[axis]),
			);

			return pipe(
				values,
				Array.filter((value) => countOf(seen, value) < minCasesPerValue),
				Array.map((value) => `${axis}=${value}`),
			);
		}),
	);

	const buried = pipe(
		phiCases,
		Array.filter(({ strata }) => strata.transform === "buried"),
	).length;

	assert.deepStrictEqual(short, []);
	assert.isAtLeast(buried, minBuried);
	assert.isAtMost(buried, maxBuried);
});

const buriedLength = Effect.gen(function* buriedLength() {
	const minBuriedChars = 500_000;
	const { phiCases } = yield* DefaultCorpus;

	const buried = pipe(
		phiCases,
		Array.filter(({ strata }) => strata.transform === "buried"),
	);

	const thin = pipe(
		buried,
		Array.filter((item) => Array.join(textsOf(item.messages), "").length < minBuriedChars),
	);

	assert.isNotEmpty(buried);
	assert.deepStrictEqual(idsOf(thin), []);
});

const quotedBack = Effect.gen(function* quotedBack() {
	const { phiCases } = yield* DefaultCorpus;

	const replies = pipe(
		phiCases,
		Array.filter(({ strata }) => strata.entry === "ent-reply"),
	);

	const silent = pipe(
		replies,
		Array.filter((item) => !quotesCanaryBack(item)),
	);

	assert.isNotEmpty(replies);
	assert.deepStrictEqual(idsOf(silent), []);
});

const seeded = Effect.gen(function* seeded() {
	const seedStep = 1;
	const otherSeed = defaultSeed + seedStep;
	const { cases, images } = yield* DefaultCorpus;
	const first = yield* encodeCorpus(cases);
	const again = yield* encodeCorpus(generate({ images, seed: defaultSeed }));
	const other = yield* encodeCorpus(generate({ images, seed: otherSeed }));

	assert.strictEqual(again, first);
	assert.notStrictEqual(other, first);
});

it.layer(DefaultCorpus.layer)("generate", (test) => {
	test.effect("the default corpus round-trips line by line through the manifest schema", () => roundTrips);
	test.effect(
		"ids, canaries and fragments are unique across the file, at least 8 and 6 characters long",
		() => unique,
	);
	test.effect("every fragment case plants its fragments in its own text", () => plantedFragments);
	test.effect("a synthetic-listed case names a listed identity, and no PHI case holds one", () => syntheticListed);
	test.effect("every negative class has at least 30 clean cases, and none holds a canary", () => negativeClasses);

	test.effect("every value of every PHI axis has at least 20 cases, except buried, which has 8 to 12", () => phiAxes);

	test.effect("a buried case carries at least 500,000 characters around its PHI", () => buriedLength);
	test.effect("in an ent-reply case, the assistant quotes a canary back", () => quotedBack);
	test.effect("the same seed gives byte-identical output and another seed differs", () => seeded, {
		timeout: 30_000,
	});
});
