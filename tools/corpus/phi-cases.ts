import { Array, Option, pipe } from "effect";
import { asBase64, asGzipHex, splitPayload, withTypos } from "./transforms.ts";
import type { PhiCase } from "./manifest.ts";
import type { PhiCaseRequest } from "./phi-records.ts";
import type { PhiRecord } from "./record.ts";
import type { TextStrata } from "./plan.ts";
import { bury } from "./filler.ts";
import { carriers } from "./carriers.ts";
import { converse } from "./conversation.ts";
import { drawRecord } from "./phi-records.ts";

const buriedSize = 600_000;

interface Delivered {
	readonly parts: readonly [string] | readonly [string, string];
	readonly canaryParts: Option.Option<Readonly<Record<string, readonly [string, string]>>>;
}

const whole = (text: string): Delivered => ({ canaryParts: Option.none(), parts: [text] });

const deliver = (
	request: PhiCaseRequest,
	record: PhiRecord,
	canaries: Array.NonEmptyReadonlyArray<string>,
): Delivered => {
	const { strata, rng } = request;
	const spec = carriers[strata.carrier];
	const payload = spec.render({ minified: strata.transform === "minified", record, rng });

	const byTransform = {
		base64: (): Delivered => whole(asBase64({ mimeType: spec.mimeType, rng })(payload)),
		buried: (): Delivered => whole(bury({ carrier: strata.carrier, rng, size: buriedSize })(payload)),
		"gzip-hex": (): Delivered => whole(asGzipHex(rng)(payload)),
		minified: (): Delivered => whole(payload),
		"non-english": (): Delivered => whole(payload),
		plain: (): Delivered => whole(payload),
		split: (): Delivered => {
			const canary = Array.headNonEmpty(canaries);
			const { canaryParts, payloadHalves } = splitPayload({ canary, payload });

			return { canaryParts: Option.some({ [canary]: canaryParts }), parts: payloadHalves };
		},
		typos: (): Delivered => whole(withTypos({ canaries, rng })(payload)),
	} satisfies Record<TextStrata["transform"], () => Delivered>;

	return byTransform[strata.transform]();
};

const phiCase = (request: PhiCaseRequest): Omit<typeof PhiCase.Type, "id"> => {
	const { strata, rng } = request;
	const record = drawRecord(request);

	const canaries = pipe(
		record.fields,
		Array.map(({ value }) => value),
	);

	const { parts, canaryParts } = deliver(request, record, canaries);

	const messages = converse({
		entry: strata.entry,
		parts,
		quotes: canaries,
		rng,
		scene: carriers[strata.carrier],
	});

	return Option.match(canaryParts, {
		onNone: () => ({ canaries, expect: "phi", fragments: [], messages, strata }) as const,
		onSome: (cut) => ({ canaries, canaryParts: cut, expect: "phi", fragments: [], messages, strata }) as const,
	});
};

export { phiCase };
