import { Array, Effect, Option, Predicate, Record, Result, String as Str, pipe } from "effect";
import { Base64, Hex } from "effect/encoding";
import { DefaultCorpus, idsOf, textsOf } from "./default-corpus.ts";
import { assert, it } from "@effect/vitest";
import type { Message } from "./manifest.ts";
import type { Phi } from "./default-corpus.ts";
import { identifierKind } from "#router/features/policy/index.ts";

const minImageCanaryLength = 24;

const jpegHeaderLength = 8;

const runPatterns = { base64: /[A-Za-z0-9+/]{40,}={0,2}/gu, gzipHex: /1f8b08[0-9a-f]+/gu };

const roles: readonly Message["role"][] = ["system", "user", "assistant", "tool"];

const imagesOf = (item: Phi): readonly string[] =>
	pipe(
		item.messages,
		Array.flatMap((message) => {
			if ("image" in message) {
				return [message.image.data];
			}

			return [];
		}),
	);

const plainViews = (item: Phi): readonly string[] => {
	const texts = textsOf(item.messages);

	const byRole = pipe(
		roles,
		Array.map((role) =>
			pipe(
				item.messages,
				Array.filter((message) => message.role === role),
				textsOf,
				Array.join(""),
			),
		),
	);

	return [...texts, ...byRole, Array.join(texts, ""), ...imagesOf(item)];
};

const runsIn = (texts: readonly string[], kind: keyof typeof runPatterns): readonly string[] =>
	pipe(
		texts,
		Array.flatMap((text) => Array.fromIterable(Str.matchAll(runPatterns[kind])(text))),
		Array.map(([run]) => run),
	);

const decodedViews = (item: Phi): Effect.Effect<readonly string[]> => {
	const texts = textsOf(item.messages);

	const base64 = pipe(
		runsIn(texts, "base64"),
		Array.flatMap((run) => Option.toArray(Result.getSuccess(Base64.decodeString(run)))),
	);

	const gzipped = pipe(
		runsIn(texts, "gzipHex"),
		Array.flatMap((run) => Option.toArray(Result.getSuccess(Hex.decode(run)))),
	);

	const gunzipped = Effect.forEach(
		gzipped,
		(bytes) => {
			const stream = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));

			return Effect.promise((): PromiseLike<string> => new Response(stream).text());
		},
		{ concurrency: 1 },
	);

	return pipe(
		gunzipped,
		Effect.map((unzipped) => [...base64, ...unzipped]),
	);
};

const misplacedInImage = ({ canary, data }: { readonly canary: string; readonly data: string }): boolean =>
	canary.length < minImageCanaryLength || !Option.exists(Str.indexOf(canary)(data), (at) => at >= jpegHeaderLength);

const lostCanaries = (item: Phi, decoded: readonly string[]): readonly string[] => {
	const plain = plainViews(item);
	const encoded = item.strata.transform === "base64" || item.strata.transform === "gzip-hex";

	return pipe(
		item.canaries,
		Array.filter((canary) => {
			const inPlain = pipe(plain, Array.some(Str.includes(canary)));

			if (encoded) {
				return inPlain || !pipe(decoded, Array.some(Str.includes(canary)));
			}

			return !inPlain;
		}),
		Array.map((canary) => `${item.id} ${canary}`),
	);
};

const badlySplit = (item: Phi): boolean => {
	const cuts = Record.toEntries(item.canaryParts ?? {});
	const texts = textsOf(item.messages);

	const wrong = pipe(
		cuts,
		Array.some(([canary, parts]) => {
			const holders = pipe(
				parts,
				Array.map((part) => Array.findFirstIndex(texts, Str.includes(part))),
			);

			return (
				Array.join(parts, "") !== canary ||
				pipe(texts, Array.some(Str.includes(canary))) ||
				pipe(holders, Array.some(Option.isNone)) ||
				new Set(Array.getSomes(holders)).size !== parts.length
			);
		}),
	);

	return !Array.isReadonlyArrayNonEmpty(cuts) || wrong;
};

const partsOutsideSplit = (item: Phi): boolean =>
	item.strata.transform !== "split" && Predicate.isNotUndefined(item.canaryParts);

const imageCanaries = Effect.gen(function* imageCanaries() {
	const { phiCases } = yield* DefaultCorpus;

	const placed = pipe(
		phiCases,
		Array.filter(({ strata }) => strata.carrier === "screenshot"),
		Array.flatMap((item) =>
			pipe(
				item.canaries,
				Array.map((canary) => ({ canary, data: Array.join(imagesOf(item), "") })),
			),
		),
	);

	assert.isNotEmpty(placed);
	assert.deepStrictEqual(pipe(placed, Array.filter(misplacedInImage)), []);
});

const recoverable = Effect.gen(function* recoverable() {
	const { phiCases } = yield* DefaultCorpus;

	const lost = yield* Effect.forEach(
		phiCases,
		(item) => Effect.map(decodedViews(item), (decoded) => lostCanaries(item, decoded)),
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(Array.flatten(lost), []);
});

const splits = Effect.gen(function* splits() {
	const { phiCases } = yield* DefaultCorpus;

	const splitCases = pipe(
		phiCases,
		Array.filter(({ strata }) => strata.transform === "split"),
	);

	const broken = pipe(splitCases, Array.filter(badlySplit));
	const unsplit = pipe(phiCases, Array.filter(partsOutsideSplit));

	assert.isNotEmpty(splitCases);
	assert.deepStrictEqual(idsOf(broken), []);
	assert.deepStrictEqual(idsOf(unsplit), []);
});

const fictionPhones = Effect.gen(function* fictionPhones() {
	const { phiCases } = yield* DefaultCorpus;

	const phones = pipe(
		phiCases,
		Array.filter(({ strata }) => strata.identifier === identifierKind.personalPhone),
		Array.map(({ canaries }) => Array.headNonEmpty(canaries)),
	);

	const real = pipe(
		phones,
		Array.filter((phone) => !/^1?\d{3}55501\d{2}$/u.test(Str.replaceAll(/\D/gu, "")(phone))),
	);

	assert.isNotEmpty(phones);
	assert.deepStrictEqual(real, []);
});

it.layer(DefaultCorpus.layer)("generate's canaries", (test) => {
	test.effect("every personal phone is 555-0100 to 555-0199, the range reserved for fiction", () => fictionPhones);
	test.effect(
		"an image canary is a base64 run of 24 or more characters from past its JPEG header",
		() => imageCanaries,
	);
	test.effect("every canary is recoverable from its case, and an encoded one only by decoding", () => recoverable);

	test.effect(
		"a split case cuts its canary into parts in separate messages, and no message holds it whole",
		() => splits,
	);
});
