import { Array, Effect, Option, Order, Predicate, Schema, String as Str, pipe } from "effect";
import type { Clean, Harness, Target } from "#router/features/border/index.ts";
import { CleanLaneRefused, bridgesFor } from "#router/features/border/index.ts";
import { freshBlock, misaligned, quoted, turnEdit } from "./written.ts";
import { BodyJson } from "./wire.ts";
import type { Decoded } from "./turns.ts";
import type { Digest } from "effect/crypto";
import type { Edit } from "./spans.ts";
import type { HoldsReplyKey } from "./reply.ts";
import type { Message } from "#router/features/parts/index.ts";
import { decodedOf } from "./turns.ts";
import { refusalsOf } from "./refusal.ts";
import { spanOf } from "./spans.ts";

type Section = Decoded["system"]["sections"][number];

type Turn = Decoded["turns"][number];

interface MessagesRequest {
	readonly model: string;
	readonly messages: readonly Message[];
	readonly encode: (upstream: Target) => Effect.Effect<string, CleanLaneRefused>;
}

class UnreadableRequest extends Schema.TaggedError<UnreadableRequest, { readonly brand: unique symbol }>()(
	"UnreadableRequest",
	{ reason: Schema.String },
) {}

const textStart = 0;

const byStart = Order.mapInput(Order.Number, (edit: Edit) => edit.start);

const edited = (source: string, edits: readonly Edit[]): string => {
	const [end, pieces] = Array.mapAccum(Array.sort(edits, byStart), textStart, (at, edit) => [
		edit.end,
		`${Str.slice(at, edit.start)(source)}${edit.text}`,
	]);

	return `${Array.join(pieces, "")}${Str.slice(end)(source)}`;
};

const modelEdit = Effect.fnUntraced(function* modelEdit(decoded: Decoded, model: string): Effect.fn.Return<Edit> {
	const text = yield* quoted(model);

	return { end: decoded.model.end, start: decoded.model.start, text };
});

type MessagesHarness = Exclude<Harness, "codex">;

const bridgeEdit = Effect.fnUntraced(function* bridgeEdit(
	{ system: { bridge: slot } }: Decoded,
	bridge: string,
): Effect.fn.Return<Edit> {
	const text = yield* quoted(bridge);

	return { end: slot.end, start: slot.start, text: `${slot.before}{"type":"text","text":${text}}${slot.after}` };
});

const firstMessage = 0;

const sectionEdit = Effect.fnUntraced(function* sectionEdit(
	section: Section,
	guarded: string,
): Effect.fn.Return<Option.Option<Edit>> {
	if (section.readable && guarded === section.text) {
		return Option.none();
	}

	const text = yield* freshBlock({ text: guarded, type: "text" }, section.kept);

	return Option.some({ end: section.span.end, start: section.span.start, text });
});

const guardedTurns = (
	turns: readonly Turn[],
	guarded: readonly Message[],
): readonly (readonly [Turn, readonly Message[]])[] => {
	const [, pairs] = Array.mapAccum(turns, firstMessage, (at, turn) => {
		const next = at + turn.runs.length;

		return [next, [turn, pipe(guarded, Array.drop(at), Array.take(turn.runs.length))] as const];
	});

	return pairs;
};

const cleanEdits = Effect.fnUntraced(function* cleanEdits(
	decoded: Decoded,
	upstream: Clean,
	bridge: string,
): Effect.fn.Return<readonly Edit[]> {
	const [head, ...rest] = upstream.messages;

	const runs = pipe(
		decoded.turns,
		Array.flatMap((turn) => turn.runs),
	);

	if (
		Predicate.isUndefined(head) ||
		head.role !== "system" ||
		rest.length !== runs.length ||
		head.sections.length !== decoded.system.sections.length
	) {
		return yield* misaligned;
	}

	const sections = yield* Effect.forEach(
		Array.zip(decoded.system.sections, head.sections),
		([section, guarded]) => sectionEdit(section, guarded.text),
		{ concurrency: 1 },
	);

	const turns = yield* Effect.forEach(
		guardedTurns(decoded.turns, rest),
		([turn, guarded]) => turnEdit(turn, guarded),
		{ concurrency: 1 },
	);

	const bridged = yield* bridgeEdit(decoded, bridge);

	return [bridged, ...Array.getSomes(sections), ...Array.getSomes(turns)];
});

interface Encoding {
	readonly decoded: Decoded;
	readonly refusals: readonly string[];
	readonly bridge: string;
}

const encoded = Effect.fnUntraced(function* encoded(
	{ bridge, decoded, refusals }: Encoding,
	upstream: Target,
): Effect.fn.Return<string, CleanLaneRefused> {
	const model = yield* modelEdit(decoded, upstream.upstreamModel);

	if (upstream.lane === "clean") {
		if (Array.isReadonlyArrayNonEmpty(refusals)) {
			return yield* CleanLaneRefused.make({ reason: Array.join(refusals, ", ") });
		}

		const edits = yield* cleanEdits(decoded, upstream, bridge);

		return edited(decoded.sentBody, [model, ...edits]);
	}

	if (upstream.pinned) {
		return edited(decoded.sentBody, [model]);
	}

	const bridged = yield* bridgeEdit(decoded, bridge);

	return edited(decoded.sentBody, [model, bridged]);
});

const decodeRequest = Effect.fn("decodeRequest")(function* decodeRequest(
	body: string,
	openWrote: HoldsReplyKey,
	harness: MessagesHarness,
): Effect.fn.Return<MessagesRequest, UnreadableRequest, Digest.Digest> {
	const wire = yield* Effect.mapError(Schema.decodeEffect(BodyJson)(body, { onExcessProperty: "error" }), (failure) =>
		UnreadableRequest.make({ reason: failure.message }),
	);

	const span = yield* Effect.mapError(spanOf(body), (reason) => UnreadableRequest.make({ reason }));
	const decoded = yield* decodedOf(wire, span, openWrote);

	const messages = [
		decoded.system.message,
		...pipe(
			decoded.turns,
			Array.flatMap((turn) => turn.runs),
			Array.map((run) => run.message),
		),
	];

	const refusals = refusalsOf(span);

	const encoding = { bridge: bridgesFor[harness], decoded, refusals };

	return { encode: (upstream) => encoded(encoding, upstream), messages, model: wire.model };
});

export { UnreadableRequest, decodeRequest };

export type { MessagesRequest };
