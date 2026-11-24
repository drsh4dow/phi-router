import { Array, Effect, Option, Predicate, Record, Result, Schema, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import type { MessagesRequest } from "./index.ts";
import { decodeRequest } from "./index.ts";
import { guard } from "#router/features/border/index.ts";
import { partsOf } from "#router/features/parts/index.ts";
import { requests } from "./captures/index.ts";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

type Path = readonly (string | number)[];

const JsonText = Schema.fromJsonString(Schema.Json);

const isList = (value: Json): value is readonly Json[] => Array.isArray(value);

type JsonObject = Exclude<Json, string | number | boolean | null | readonly Json[]>;

const isObject = (value: Json): value is JsonObject => Predicate.isObject(value) && !Array.isArray(value);

const nobodyWrote = (): boolean => false;

const sweepTimeout = 60_000;

interface Site {
	readonly path: Path;
	readonly marker: string;
	readonly body: string;
}

const changed = (value: Json, path: Path, change: (at: Json) => Json): Json => {
	const [step, ...rest] = path;

	if (Predicate.isUndefined(step)) {
		return change(value);
	}

	const along = (item: Json, at: string | number): Json => {
		if (at === step) {
			return changed(item, rest, change);
		}

		return item;
	};

	if (isList(value)) {
		return pipe(value, Array.map(along));
	}

	if (isObject(value)) {
		return pipe(value, Record.map(along));
	}

	return value;
};

const sitesIn = (value: Json, path: Path): readonly { readonly path: Path; readonly kind: "object" | "string" }[] => {
	if (Predicate.isString(value)) {
		return [{ kind: "string", path }];
	}

	if (isList(value)) {
		return pipe(
			value,
			Array.flatMap((item, index) => sitesIn(item, [...path, index])),
		);
	}

	if (isObject(value)) {
		const inside = pipe(
			Record.toEntries(value),
			Array.flatMap(([key, item]) => sitesIn(item, [...path, key])),
		);

		return [{ kind: "object", path }, ...inside];
	}

	return [];
};

const plantedSites = Effect.fnUntraced(function* plantedSites(body: string): Effect.fn.Return<readonly Site[]> {
	const tree: Json = yield* Effect.orDie(Schema.decodeEffect(JsonText)(body));

	const sites = pipe(
		sitesIn(tree, []),
		Array.filter(({ path }) => !Option.contains(Array.head(path), "metadata")),
	);

	return yield* Effect.forEach(
		sites,
		({ kind, path }, index) => {
			const marker = `phi${String(index)}mark`;

			const plant = (at: Json): Json => {
				if (kind === "string" && Predicate.isString(at)) {
					return `${at}${marker}`;
				}

				if (isObject(at)) {
					return Record.set(at, "phi_planted", marker);
				}

				return at;
			};

			const write = Effect.orDie(Schema.encodeEffect(JsonText)(changed(tree, path, plant)));

			return pipe(
				write,
				Effect.map((planted) => ({ body: planted, marker, path })),
			);
		},
		{ concurrency: 1 },
	);
});

type Outcome = "no clean body" | "marker absent" | "judged" | "leaked";

type Lookup = (key: string) => "cleared" | "unknown";

const everyPartCleared: Lookup = () => "cleared";

const nothingCleared: Lookup = () => "unknown";

const onlyCleared =
	(cleared: string): Lookup =>
	(key) => {
		if (key === cleared) {
			return "cleared";
		}

		return "unknown";
	};

const cleanBodyOf = (
	request: MessagesRequest,
	lookup: Lookup,
): Effect.Effect<Option.Option<string>, never, Digest.Digest> =>
	pipe(
		guard({ harness: "claude", lookup, messages: request.messages }),
		Effect.flatMap((guarded) => request.encode({ lane: "clean", messages: guarded, upstreamModel: "target" })),
		Effect.option,
	);

const toolsKeyOf = Effect.fnUntraced(function* toolsKeyOf(
	request: MessagesRequest,
): Effect.fn.Return<Option.Option<string>, never, Digest.Digest> {
	const system = Option.toArray(Array.head(request.messages));
	const systemParts = yield* Effect.forEach(system, partsOf, { concurrency: 1 });

	return pipe(
		Array.flatten(systemParts),
		Array.findFirst((part) => Predicate.isTagged(part.slot, "SystemTools")),
		Option.map((part) => part.key),
	);
});

const outcomesOf = Effect.fnUntraced(function* outcomesOf(
	site: Site,
): Effect.fn.Return<readonly Outcome[], never, Digest.Digest> {
	const decoded = yield* Effect.result(decodeRequest(site.body, nobodyWrote, "claude"));

	if (Result.isFailure(decoded)) {
		return ["no clean body"];
	}

	const request = decoded.success;
	const judged = yield* Effect.orDie(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(request.messages));
	const toolsKey = yield* toolsKeyOf(request);

	const lookups = [everyPartCleared, Option.match(toolsKey, { onNone: () => nothingCleared, onSome: onlyCleared })];

	const cleanBodies = yield* Effect.forEach(lookups, (lookup) => cleanBodyOf(request, lookup), { concurrency: 1 });

	return pipe(
		cleanBodies,
		Array.map((clean): Outcome => {
			if (Option.isNone(clean)) {
				return "no clean body";
			}

			if (!Str.includes(site.marker)(clean.value)) {
				return "marker absent";
			}

			if (Str.includes(site.marker)(judged)) {
				return "judged";
			}

			return "leaked";
		}),
	);
});

it.layer(Digest.layerWebCrypto)("a value planted anywhere in a captured request", (test) => {
	for (const [name, body] of Record.toEntries(requests)) {
		test.effect(
			`${name}: reaches the clean lane only when the engine's messages hold it`,
			() =>
				Effect.gen(function* planted() {
					const sites = yield* plantedSites(body);
					const outcomes = yield* Effect.forEach(sites, outcomesOf, { concurrency: 1 });

					const leaks = pipe(
						Array.zip(sites, outcomes),
						Array.filter(([, each]) => Array.contains(each, "leaked")),
						Array.map(([site]) => pipe(site.path, Array.map(String), Array.join("."))),
					);

					assert.deepStrictEqual(leaks, [], `${name}: planted values reached the clean lane unjudged`);

					assert.include(
						Array.flatten(outcomes),
						"judged",
						`${name}: no planted value reached the clean lane, so the test saw nothing`,
					);
				}),
			sweepTimeout,
		);
	}
});
