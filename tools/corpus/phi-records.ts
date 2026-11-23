import { Array, pipe } from "effect";
import type { Field, PhiRecord } from "./record.ts";
import type { TextCarrier, TextIdentifier } from "./manifest.ts";
import type { DrawContext } from "./identifiers.ts";
import type { Random } from "./random.ts";
import type { TextStrata } from "./plan.ts";
import { diagnoses } from "./health.ts";
import { drawIdentifier } from "./identifiers.ts";
import { foreignLangs } from "./people.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { unique } from "./random.ts";
import { x12Requires } from "./x12.ts";

interface PhiCaseRequest {
	readonly strata: TextStrata;
	readonly rng: Random;
	readonly used: Readonly<Set<string>>;
}

/** The record a PHI case plants, which holds at least the identifier of its stratum. */
interface PlantedRecord extends PhiRecord {
	readonly fields: Array.NonEmptyReadonlyArray<Field>;
}

const companionsByIdentifier: Partial<Record<TextIdentifier, readonly TextIdentifier[]>> = {
	[identifierKind.birthDate]: [identifierKind.patientName],
};

const companionsByCarrier: Partial<Record<TextCarrier, readonly TextIdentifier[]>> = { "x12-837": x12Requires };

/**
 * Identifiers the case needs beside its stratum's: a birth date is planted with its owner's name.
 *
 * @param {TextStrata} strata The case's stratum.
 * @returns {readonly TextIdentifier[]} The other identifiers its record holds.
 */
const companionsOf = (strata: TextStrata): readonly TextIdentifier[] =>
	pipe(
		[...(companionsByIdentifier[strata.identifier] ?? []), ...(companionsByCarrier[strata.carrier] ?? [])],
		Array.dedupe,
		Array.filter((kind) => kind !== strata.identifier),
	);

const fieldsOf = (
	strata: TextStrata,
	context: DrawContext,
	used: Readonly<Set<string>>,
): Array.NonEmptyReadonlyArray<Field> => {
	const field = (kind: TextIdentifier): Field => ({
		kind,
		value: unique({ draw: () => drawIdentifier(kind)(context), used }),
	});

	return [
		field(strata.identifier),
		...pipe(
			companionsOf(strata),
			Array.map((kind) => field(kind)),
		),
	];
};

const firstRowId = 1000;
const lastRowId = 99_999;

const langOf = ({ strata, rng }: PhiCaseRequest): PhiRecord["lang"] => {
	if (strata.transform === "non-english") {
		return rng.pick(foreignLangs);
	}

	return "en";
};

const drawRecord = (request: PhiCaseRequest): PlantedRecord => {
	const { strata, rng, used } = request;
	const lang = langOf(request);
	const fields = fieldsOf(strata, { carrier: strata.carrier, lang, rng }, used);

	return { diagnosis: rng.pick(diagnoses), fields, lang, rowId: rng.between(firstRowId, lastRowId) };
};

export { drawRecord };

export type { PhiCaseRequest };
