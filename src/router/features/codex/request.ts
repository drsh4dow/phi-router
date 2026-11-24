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

class CodexRequestRejected extends Schema.TaggedError<CodexRequestRejected, { readonly brand: unique symbol }>()(
	"CodexRequestRejected",
	{ reason: Schema.String },
) {}

interface CodexRequest {
	readonly model: string;
	readonly messages: readonly Message[];
	readonly encode: (target: Target) => Effect.Effect<string, CleanLaneRefused>;
	readonly withoutReasoning: (target: Target) => Effect.Effect<string, CleanLaneRefused>;
	readonly title: boolean;
}

const decodeRaw = Schema.decodeUnknownEffect(Schema.fromJsonString(Raw));

const TopLevelKeys = Schema.Struct(
	pipe(
		Body.fields,
		Record.map(() => Schema.optionalKey(Schema.Unknown)),
	),
);

const decodeTopLevelKeys = Schema.decodeUnknownEffect(TopLevelKeys);

const decodeModel = Schema.decodeUnknownEffect(Schema.Struct({ model: Schema.String }));

const decodeTop = Effect.fnUntraced(function* decodeTop(text: string) {
	const raw = yield* decodeRaw(text);

	yield* decodeTopLevelKeys(raw, { onExcessProperty: "error" });

	const { model } = yield* decodeModel(raw);

	return { model, raw };
});

const readBody = Schema.decodeUnknownOption(Body);

const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const modelField = (model: string): Effect.Effect<string> =>
	Effect.map(Effect.orDie(quote(model)), (quoted) => `{"model":${quoted}`);

const notAString = 0;

const modelOnce = (afterModel: string): Effect.Effect<boolean> =>
	Effect.match(decodeRaw(`{"model":${notAString}${afterModel}`), {
		onFailure: () => false,
		onSuccess: (raw) => raw["model"] === notAString,
	});

interface Encoding {
	readonly afterModel: string;
	readonly everyFieldRead: boolean;
	readonly raw: typeof Raw.Type;
	readonly wireParts: readonly WirePart[];
}

const isReasoning = (item: typeof Raw.Type): boolean => item["type"] === "reasoning";

const cleanInput = (
	{ everyFieldRead, wireParts }: Encoding,
	messages: readonly Message[],
): Effect.Effect<readonly (typeof Raw.Type)[], CleanLaneRefused> =>
	Effect.gen(function* cleanParts() {
		if (!everyFieldRead) {
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

const withoutWorkspaces = (raw: typeof Raw.Type): Effect.Effect<typeof Raw.Type> =>
	Option.match(turnOf(raw), {
		onNone: () => Effect.succeed(raw),
		onSome: ({ metadata, turn }) =>
			Effect.map(rawText(Record.remove(turn, "workspaces")), (text) =>
				Record.set(raw, "client_metadata", Record.set(metadata, turnKey, text)),
			),
	});

const isTitleRequest = (raw: typeof Raw.Type): boolean =>
	Option.exists(turnOf(raw), ({ turn }) => turn["thread_source"] === "thread_title");

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

	return Struct.assign(encoderOf({ afterModel, everyFieldRead: Option.isSome(body), raw, wireParts }), {
		messages: pipe(
			wireParts,
			Array.map(({ message }) => message),
		),
		model,
		title: isTitleRequest(raw),
	});
});

export { CodexRequestRejected, decodeRequest };

export type { CodexRequest };
