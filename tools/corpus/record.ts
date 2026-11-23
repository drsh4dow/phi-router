import { Array, Option, Record, String as Str, pipe } from "effect";
import { healthLabels, identifierLabels } from "./labels.ts";
import type { Diagnosis } from "./health.ts";
import type { Lang } from "./people.ts";
import type { Random } from "./random.ts";
import type { TextIdentifier } from "./manifest.ts";
import { slug } from "./people.ts";

interface Field {
	readonly kind: TextIdentifier;
	readonly value: string;
}

interface PhiRecord {
	readonly lang: Lang;
	/**
	 * The direct identifiers it holds: the stratum's first, then any the case or the carrier's format cannot leave out.
	 * None for a record keyed only by its internal id.
	 */
	readonly fields: readonly Field[];
	readonly diagnosis: Diagnosis;
	/** The internal patient id, which identifies nobody outside the system. */
	readonly rowId: number;
}

interface RenderInput {
	readonly record: PhiRecord;
	readonly rng: Random;
	readonly minified: boolean;
}

interface Labelled {
	/** The label as a snake_case column or key name. */
	readonly key: string;
	readonly label: string;
	readonly value: string;
}

const topicWords = 4;

const twoDigits = 2;

const january = 1;

const december = 12;

const firstDay = 1;

/** The last day every month has, so a drawn date is always valid. */
const lastDayInEveryMonth = 28;

const hoursPerDay = 24;

const minutesPerHour = 60;

const secondsPerMinute = 60;

const millisecondDigits = 3;

/** The hex digits of each group of a version-4 UUID, around its fixed version digit and its variant digit. */
const uuidHexDigits = { clockSequence: 3, node: 12, timeHigh: 3, timeLow: 8, timeMid: 4 } as const;

const uuidVariants: Array.NonEmptyReadonlyArray<string> = ["8", "9", "a", "b"];

const labelled = (label: string, value: string): Labelled => ({ key: slug("_")(label), label, value });

const labelledValues = ({ lang, fields, diagnosis, rowId }: PhiRecord): Labelled[] => [
	{ key: "patient_id", label: "patient_id", value: String(rowId) },
	...pipe(
		fields,
		Array.map((field) => labelled(identifierLabels[field.kind][lang], field.value)),
	),
	labelled(healthLabels.code[lang], diagnosis.code),
	labelled(healthLabels.diagnosis[lang], diagnosis.text[lang]),
	labelled(healthLabels.medication[lang], diagnosis.medication[lang]),
];

const recordObject = (values: readonly Labelled[]): Record<string, string> =>
	Record.fromEntries(
		pipe(
			values,
			Array.map(({ key, value }) => [key, value] as const),
		),
	);

const topicOf = ({ diagnosis, lang }: PhiRecord): string => {
	const words = Str.split("-")(slug("-")(diagnosis.text[lang]));

	return Array.join(Array.take(words, topicWords), "-");
};

const valueOf =
	(kind: TextIdentifier) =>
	(record: PhiRecord): Option.Option<string> =>
		pipe(
			record.fields,
			Array.findFirst((field) => field.kind === kind),
			Option.map((field) => field.value),
		);

/**
 * A version-4 UUID whose variant digit `variant` gives.
 *
 * @param {(rng: Random) => string} variant Gives the variant digit.
 * @returns {(rng: Random) => string} Draws the UUID.
 */
const uuidWith =
	(variant: (rng: Random) => string) =>
	(rng: Random): string =>
		`${rng.hex(uuidHexDigits.timeLow)}-${rng.hex(uuidHexDigits.timeMid)}-4${rng.hex(uuidHexDigits.timeHigh)}-${variant(rng)}${rng.hex(uuidHexDigits.clockSequence)}-${rng.hex(uuidHexDigits.node)}`;

const uuid = uuidWith((rng) => rng.pick(uuidVariants));

const two = (value: number): string => Str.padStart(twoDigits, "0")(String(value));

const month = (rng: Random): string => two(rng.between(january, december));

const dayOfMonth = (rng: Random): string => two(rng.between(firstDay, lastDayInEveryMonth));

const dateIn2025 = (rng: Random): string => `2025-${month(rng)}-${dayOfMonth(rng)}`;

const systemTime = (rng: Random): string =>
	`${dateIn2025(rng)}T${two(rng.int(hoursPerDay))}:${two(rng.int(minutesPerHour))}:${two(rng.int(secondsPerMinute))}.${rng.digits(millisecondDigits)}Z`;

export {
	dateIn2025,
	dayOfMonth,
	labelledValues,
	month,
	recordObject,
	systemTime,
	topicOf,
	two,
	uuid,
	uuidWith,
	valueOf,
};

export type { Field, Labelled, PhiRecord, RenderInput };
