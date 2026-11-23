import { Array, Effect, Option, Predicate, Record, Result, Schema, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import type { MessagesRequest } from "./index.ts";
import { decodeRequest } from "./index.ts";
import { guard } from "#router/features/border/index.ts";
import { partsOf } from "#router/features/parts/index.ts";
import { requests } from "./captures/requests.ts";

/** A parsed JSON value, read only. */
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

type Path = readonly (string | number)[];

const JsonText = Schema.fromJsonString(Schema.Json);

const isList = (value: Json): value is readonly Json[] => Array.isArray(value);

type JsonObject = Exclude<Json, string | number | boolean | null | readonly Json[]>;

const isObject = (value: Json): value is JsonObject => Predicate.isObject(value) && !Array.isArray(value);

const nobodyWrote = (): boolean => false;

/** Each capture is decoded once per object and string in it, up to 416 times, which takes over 5 s under a loaded CPU. */
const sweepTimeout = 60_000;

/** One planted body: a marker as a new member of one object, or appended to one string. */
interface Site {
	readonly path: Path;
	readonly marker: string;
	readonly body: string;
}

/**
 * `value` with the value at `path` replaced by `change` of it. Copies only the objects and arrays along the path.
 *
 * @param {Json} value The tree.
 * @param {Path} path Where to change it.
 * @param {(at: Json) => Json} change The change.
 * @returns {Json} The changed tree.
 */
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

/**
 * The path of every object and every string in `value`.
 *
 * @param {Json} value The tree.
 * @param {Path} path Its path.
 * @returns {readonly { readonly path: Path; readonly kind: "object" | "string" }[]} The sites.
 */
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

/**
 * One body per site of `body`, each with its own marker planted there.
 *
 * @param {string} body A captured request.
 * @returns {Effect.Effect<readonly Site[]>} The planted bodies, `metadata` left out.
 */
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

/** What one planted body does under one border: no clean body, a clean body without the marker, judged, or a leak. */
type Outcome = "no clean body" | "absent" | "judged" | "leaked";

type Lookup = (key: string) => "cleared" | "unknown";

const everyPartCleared: Lookup = () => "cleared";

const onlyCleared =
	(cleared: string): Lookup =>
	(key) => {
		if (key === cleared) {
			return "cleared";
		}

		return "unknown";
	};

/**
 * The body the clean lane would send, if any: none when guard or the codec refuses the clean lane.
 *
 * @param {MessagesRequest} request The decoded request.
 * @param {Lookup} lookup The border's verdicts.
 * @returns {Effect.Effect<Option.Option<string>>} The clean body.
 */
const cleanBodyOf = (
	request: MessagesRequest,
	lookup: Lookup,
): Effect.Effect<Option.Option<string>, never, Digest.Digest> =>
	pipe(
		guard({ harness: "claude", lookup, messages: request.messages }),
		Effect.flatMap((guarded) => request.encode({ lane: "clean", messages: guarded, model: "target" })),
		Effect.option,
	);

/**
 * The key of the request's tool-list part.
 *
 * @param {MessagesRequest} request The decoded request.
 * @returns {Effect.Effect<string>} The key, empty when the request has no system message.
 */
const toolsKeyOf = Effect.fnUntraced(function* toolsKeyOf(
	request: MessagesRequest,
): Effect.fn.Return<string, never, Digest.Digest> {
	const system = Option.toArray(Array.head(request.messages));
	const systemParts = yield* Effect.forEach(system, partsOf, { concurrency: 1 });

	return pipe(
		Array.flatten(systemParts),
		Array.findFirst((part) => Predicate.isTagged(part.slot, "SystemTools")),
		Option.match({ onNone: () => "", onSome: (part) => part.key }),
	);
});

/**
 * The outcomes of one planted body, under a border that clears every part and one that clears only the tool list.
 *
 * @param {Site} site The planted body.
 * @returns {Effect.Effect} One outcome per border.
 */
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

	const lookups = [everyPartCleared, onlyCleared(toolsKey)];

	const cleanBodies = yield* Effect.forEach(lookups, (lookup) => cleanBodyOf(request, lookup), { concurrency: 1 });

	return pipe(
		cleanBodies,
		Array.map((clean): Outcome => {
			if (Option.isNone(clean)) {
				return "no clean body";
			}

			if (!Str.includes(site.marker)(clean.value)) {
				return "absent";
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
