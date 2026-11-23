import { Array, Effect, Option, Order, Predicate, Schema, String as Str, pipe } from "effect";
import type { Clean, Harness, Target } from "#router/features/border/index.ts";
import { CleanLaneRefused, refusalsOf } from "./refusal.ts";
import { freshBlock, misaligned, quoted, turnEdit } from "./written.ts";
import { BodyJson } from "./wire.ts";
import type { Decoded } from "./turns.ts";
import type { Digest } from "effect/crypto";
import type { Edit } from "./spans.ts";
import type { Message } from "#router/features/parts/index.ts";
import type { OpenWrote } from "./reply.ts";
import { bridgesFor } from "#router/features/border/index.ts";
import { decodedOf } from "./turns.ts";
import { spanOf } from "./spans.ts";

type Section = Decoded["system"]["sections"][number];

type Turn = Decoded["turns"][number];

/** A /v1/messages request as the engine reads it. The wire stays inside, and `encode` is the only way back to bytes. */
interface MessagesRequest {
	/** The model the harness named, such as `phi/auto` or `phi/sealed`. */
	readonly model: string;
	/** The system message first, then one message per turn. A user turn holding tool results gives one per result. */
	readonly messages: readonly Message[];
	/**
	 * The body for the upstream: the bytes Claude Code sent with edits applied, so every byte no edit touches leaves as
	 * sent. The clean lane fails with `CleanLaneRefused` when a member it would carry is outside its shape. Dies when a
	 * clean lane's messages do not line up with `messages`.
	 */
	readonly encode: (upstream: Target) => Effect.Effect<string, CleanLaneRefused>;
}

/** The body is not one the codec can name. `reason` is Schema's message, which names the field and never its value. */
class UnreadableRequest extends Schema.TaggedError<UnreadableRequest, { readonly brand: unique symbol }>()(
	"UnreadableRequest",
	{ reason: Schema.String },
) {}

const textStart = 0;

const byStart = Order.mapInput(Order.Number, (edit: Edit) => edit.start);

/**
 * The body text with each edit applied. Text no edit touches stays byte for byte.
 *
 * @param {string} source The body as the harness sent it.
 * @param {readonly Edit[]} edits Edits that do not overlap.
 * @returns {string} The edited body.
 */
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

/** The harnesses that speak the Messages format. */
type MessagesHarness = Exclude<Harness, "codex">;

const bridgeEdit = Effect.fnUntraced(function* bridgeEdit(
	{ system: { bridge: slot } }: Decoded,
	bridge: string,
): Effect.fn.Return<Edit> {
	const text = yield* quoted(bridge);

	return { end: slot.end, start: slot.start, text: `${slot.before}{"type":"text","text":${text}}${slot.after}` };
});

const firstMessage = 0;

/** A section the border changed, or that the codec cannot read, as a fresh text block keeping its cache breakpoint. */
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

/**
 * Each wire message beside the border's messages for its runs.
 *
 * @param {readonly Turn[]} turns The wire messages.
 * @param {readonly Message[]} guarded The border's messages after the system message.
 * @returns {readonly (readonly [Turn, readonly Message[]])[]} The pairs.
 */
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

/** The attribution block stays first and untouched, each section takes the border's text, and the bridge goes last. */
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

/** A decoded body, the reasons it may not go to the clean lane, and the bridge its harness reads. */
interface Encoding {
	readonly decoded: Decoded;
	readonly refusals: readonly string[];
	readonly bridge: string;
}

/** Pinned: the model only. Sealed: the model and the bridge. Clean: those and each run or section the border changed. */
const encoded = Effect.fnUntraced(function* encoded(
	{ bridge, decoded, refusals }: Encoding,
	upstream: Target,
): Effect.fn.Return<string, CleanLaneRefused> {
	const model = yield* modelEdit(decoded, upstream.model);

	if (upstream.lane === "clean") {
		if (Array.isReadonlyArrayNonEmpty(refusals)) {
			return yield* CleanLaneRefused.make({ reason: Array.join(refusals, ", ") });
		}

		const edits = yield* cleanEdits(decoded, upstream, bridge);

		return edited(decoded.source, [model, ...edits]);
	}

	if (upstream.pinned) {
		return edited(decoded.source, [model]);
	}

	const bridged = yield* bridgeEdit(decoded, bridge);

	return edited(decoded.source, [model, bridged]);
});

/**
 * Decodes a /v1/messages body Claude Code or pi sent. `openWrote` holds the keys `replyKeys` gave for completed
 * open-account streams. A reply is `open-account` when its text and tool calls match one, and each thinking block goes
 * to the clean lane only when its own key is held. `harness` picks the bridge `encode` adds.
 */
const decodeRequest = Effect.fn("decodeRequest")(function* decodeRequest(
	body: string,
	openWrote: OpenWrote,
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
