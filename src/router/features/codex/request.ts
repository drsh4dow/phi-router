import { Array, Effect, Option, Record, Schema, String as Str, Struct, pipe } from "effect";
import { Body, Raw } from "./wire.ts";
import { CleanLaneRefused, cleanItems } from "./stub.ts";
import type { Sealed, Target } from "#router/features/border/index.ts";
import type { CleanLaneWrote } from "./clean-lane.ts";
import type { Digest } from "effect/crypto";
import type { Message } from "#router/features/parts/index.ts";
import type { WirePart } from "./wire-parts.ts";
import { bridgesFor } from "#router/features/border/index.ts";
import { rawText } from "./json.ts";
import { wirePartsOf } from "./wire-parts.ts";

/**
 * A body that is not a Codex request: not a JSON object, a top-level field Codex does not send, or `model` not a string,
 * not first or named twice. `reason` holds the path, never a value.
 */
class CodexRequestRejected extends Schema.TaggedError<CodexRequestRejected, { readonly brand: unique symbol }>()(
	"CodexRequestRejected",
	{ reason: Schema.String },
) {}

/** A Codex request as the engine reads it, and the way back to the wire. */
interface CodexRequest {
	/** The model Codex named, such as `phi/auto`. */
	readonly model: string;
	readonly messages: readonly Message[];
	/**
	 * The body for one lane, in Codex's own key order, with the bridge as `instructions` right after `model` unless
	 * pinned. The sealed lane gets Codex's bytes with only those changed. The clean lane gets each part the border
	 * passed as sent, less the reasoning no clean-lane reply wrote, and every other part as the border's stub with each
	 * item and its ids kept, or `CleanLaneRefused`. Dies when the messages do not line up with `messages`.
	 */
	readonly encode: (target: Target) => Effect.Effect<string, CleanLaneRefused>;
	/** `encode` with every reasoning item dropped from the clean body, for an account that could not read one. */
	readonly withoutReasoning: (target: Target) => Effect.Effect<string, CleanLaneRefused>;
	/** Whether its turn metadata says `"thread_source":"thread_title"`: the TUI's request for the thread's title. */
	readonly title: boolean;
}

const decodeRaw = Schema.decodeUnknownEffect(Schema.fromJsonString(Raw));

/** The top-level fields Codex sends, read no further than the model. */
const TopLevel = Schema.Struct(
	pipe(
		Body.fields,
		Record.map(() => Schema.optionalKey(Schema.Unknown)),
	),
);

const decodeTopLevel = Schema.decodeUnknownEffect(TopLevel);

const decodeModel = Schema.decodeUnknownEffect(Schema.Struct({ model: Schema.String }));

const decodeTop = Effect.fnUntraced(function* decodeTop(text: string) {
	const raw = yield* decodeRaw(text);

	yield* decodeTopLevel(raw, { onExcessProperty: "error" });

	const { model } = yield* decodeModel(raw);

	return { model, raw };
});

const readBody = Schema.decodeUnknownOption(Body);

const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

/**
 * How Codex opens every body, so the sealed lane can swap the model without writing the rest again.
 *
 * @param {string} model The model slug.
 * @returns {Effect.Effect<string>} The body's opening up to the end of the model's value.
 */
const modelField = (model: string): Effect.Effect<string> =>
	Effect.map(Effect.orDie(quote(model)), (quoted) => `{"model":${quoted}`);

const notAString = 0;

/**
 * Whether the body names `model` once, so the model the sealed lane swaps in is the one the upstream reads. A parser
 * keeps the last of two equal keys, and the body's last `model` is a string, so a number survives only when alone.
 *
 * @param {string} afterModel The body after its first model's value.
 * @returns {Effect.Effect<boolean>} Whether no later `model` follows.
 */
const modelOnce = (afterModel: string): Effect.Effect<boolean> =>
	Effect.match(decodeRaw(`{"model":${notAString}${afterModel}`), {
		onFailure: () => false,
		onSuccess: (raw) => raw["model"] === notAString,
	});

/** What a request is written back from. `bodyRead` when its fields are all ones the clean lane may get. */
interface Encoding {
	readonly afterModel: string;
	readonly bodyRead: boolean;
	readonly raw: typeof Raw.Type;
	readonly wireParts: readonly WirePart[];
}

const isReasoning = (item: typeof Raw.Type): boolean => item["type"] === "reasoning";

/**
 * The clean lane's items, part by part from what the border returned.
 *
 * @param {Encoding} encoding What the request is written back from.
 * @param {readonly Message[]} messages What the border returned, one per wire part.
 * @returns {Effect.Effect<readonly Raw[], CleanLaneRefused>} The items.
 */
const cleanInput = (
	{ bodyRead, wireParts }: Encoding,
	messages: readonly Message[],
): Effect.Effect<readonly (typeof Raw.Type)[], CleanLaneRefused> =>
	Effect.gen(function* cleanParts() {
		if (!bodyRead) {
			return yield* CleanLaneRefused.make({});
		}

		if (messages.length !== wireParts.length) {
			return yield* Effect.die("the border's messages do not line up with the request's parts");
		}

		const parts = yield* Effect.forEach(
			Array.zip(wireParts, messages),
			([wirePart, guarded]) => cleanItems(wirePart)(guarded),
			{ concurrency: 1 },
		);

		return Array.flatten(parts);
	});

const turnKey = "x-codex-turn-metadata";

const readObject = Schema.decodeUnknownOption(Raw);

const readObjectText = Schema.decodeUnknownOption(Schema.fromJsonString(Raw));

const turnOf = (raw: typeof Raw.Type): Option.Option<Readonly<Record<"metadata" | "turn", typeof Raw.Type>>> =>
	Option.flatMap(readObject(raw["client_metadata"]), (metadata) =>
		Option.map(readObjectText(metadata[turnKey]), (turn) => ({ metadata, turn })),
	);

/**
 * Codex's fields with `workspaces` dropped from its turn metadata, since their folder paths and remote URLs are text no
 * judge saw (ADR 0001). The rest of that JSON keeps Codex's compact form and key order, which the decode held it to.
 *
 * @param {Raw} raw The body as sent.
 * @returns {Effect.Effect<Raw>} The fields an open account may get.
 */
const withoutWorkspaces = (raw: typeof Raw.Type): Effect.Effect<typeof Raw.Type> =>
	Option.match(turnOf(raw), {
		onNone: () => Effect.succeed(raw),
		onSome: ({ metadata, turn }) =>
			Effect.map(rawText(Record.remove(turn, "workspaces")), (text) =>
				Record.set(raw, "client_metadata", Record.set(metadata, turnKey, text)),
			),
	});

/**
 * Whether the turn metadata names the thread-title request, read from the body as sent, so a field the codec does not
 * read elsewhere in the body cannot hide it.
 *
 * @param {Raw} raw The body as sent.
 * @returns {boolean} Whether it is the title request.
 */
const isTitle = (raw: typeof Raw.Type): boolean =>
	Option.exists(turnOf(raw), ({ turn }) => turn["thread_source"] === "thread_title");

/**
 * The clean body: `model`, the bridge, then Codex's fields in its order with `input` replaced and no workspaces.
 *
 * @param {Raw} raw The body as sent.
 * @param {string} model The model slug.
 * @returns {(input: readonly Raw[]) => Effect.Effect<string>} The body for the clean lane's items.
 */
const cleanBody =
	(raw: typeof Raw.Type, model: string) =>
	(input: readonly (typeof Raw.Type)[]): Effect.Effect<string> =>
		Effect.flatMap(withoutWorkspaces(raw), (sent) => {
			const fields = pipe(sent, Record.remove("model"), Record.set("input", input), Record.toEntries);

			return rawText(Record.fromEntries([["model", model], ["instructions", bridgesFor.codex], ...fields]));
		});

const sealedBody = Effect.fnUntraced(function* sealedBody({ afterModel }: Encoding, { model, pinned }: Sealed) {
	const head = yield* modelField(model);

	if (pinned) {
		return head + afterModel;
	}

	const bridge = yield* Effect.orDie(quote(bridgesFor.codex));

	return `${head},"instructions":${bridge}${afterModel}`;
});

const encodeKeeping =
	(encoding: Encoding, keep: (item: typeof Raw.Type) => boolean) =>
	(target: Target): Effect.Effect<string, CleanLaneRefused> => {
		if (target.lane === "sealed") {
			return sealedBody(encoding, target);
		}

		return cleanInput(encoding, target.messages).pipe(
			Effect.map(Array.filter(keep)),
			Effect.flatMap(cleanBody(encoding.raw, target.model)),
		);
	};

const keptAll = (): boolean => true;

const encoderOf = (encoding: Encoding): Pick<CodexRequest, "encode" | "withoutReasoning"> => ({
	encode: encodeKeeping(encoding, keptAll),
	withoutReasoning: encodeKeeping(encoding, (item) => !isReasoning(item)),
});

/**
 * Reads a Codex request into the engine's messages: each user, developer or agent message, each tool output, each
 * reply's items and the tool list is one message. It fails only on a body that is not a Codex request. Anything below
 * the top level the codec cannot read is unjudged: the clean lane gets the stub in its place, or refuses the request.
 *
 * @param {string} text The request body as Codex sent it.
 * @param {CleanLaneWrote} cleanLaneWrote Answers for the keys `cleanLaneKeys` gave for this session's clean-lane
 *   replies. It sets `writtenBy`, keeps their reasoning on the clean lane and lets their blobs through.
 * @returns The request, or the path it was refused at.
 */
const decodeRequest = Effect.fnUntraced(function* decodeRequest(
	text: string,
	cleanLaneWrote: CleanLaneWrote,
): Effect.fn.Return<CodexRequest, CodexRequestRejected, Digest.Digest> {
	const { model, raw } = yield* Effect.mapError(decodeTop(text), (error) =>
		CodexRequestRejected.make({ reason: error.message }),
	);

	const head = yield* modelField(model);

	if (!Str.startsWith(head)(text)) {
		return yield* CodexRequestRejected.make({ reason: "`model` is not the body's first field" });
	}

	const afterModel = Str.slice(head.length)(text);

	if (!(yield* modelOnce(afterModel))) {
		return yield* CodexRequestRejected.make({ reason: "`model` is named twice" });
	}

	const body = readBody(raw, { onExcessProperty: "error" });
	const wireParts = yield* wirePartsOf(cleanLaneWrote)({ body: Option.getOrUndefined(body), raw });

	return Struct.assign(encoderOf({ afterModel, bodyRead: Option.isSome(body), raw, wireParts }), {
		messages: pipe(
			wireParts,
			Array.map(({ message }) => message),
		),
		model,
		title: isTitle(raw),
	});
});

export { CodexRequestRejected, decodeRequest };

export type { CodexRequest };
