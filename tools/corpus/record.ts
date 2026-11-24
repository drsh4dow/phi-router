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
	readonly fields: readonly Field[];
	readonly diagnosis: Diagnosis;
	readonly internalId: number;
}

interface RenderInput {
	readonly record: PhiRecord;
	readonly rng: Random;
	readonly minified: boolean;
}

interface Labelled {
	readonly snakeCaseKey: string;
	readonly label: string;
	readonly value: string;
}

const topicWords = 4;

const twoDigits = 2;

const january = 1;

const december = 12;

const firstDay = 1;

const lastDayInEveryMonth = 28;

const hoursPerDay = 24;

const minutesPerHour = 60;

const secondsPerMinute = 60;

const millisecondDigits = 3;

const uuidHexDigits = {
	clockSequenceAfterVariant: 3,
	node: 12,
	timeHighAfterVersion: 3,
	timeLow: 8,
	timeMid: 4,
} as const;

const uuidVariants: Array.NonEmptyReadonlyArray<string> = ["8", "9", "a", "b"];

const labelled = (label: string, value: string): Labelled => ({ label, snakeCaseKey: slug("_")(label), value });

const labelledValues = ({ lang, fields, diagnosis, internalId }: PhiRecord): Labelled[] => [
	{ label: "patient_id", snakeCaseKey: "patient_id", value: String(internalId) },
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
			Array.map(({ snakeCaseKey, value }) => [snakeCaseKey, value] as const),
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

const uuidWith =
	(variant: (rng: Random) => string) =>
	(rng: Random): string =>
		`${rng.hex(uuidHexDigits.timeLow)}-${rng.hex(uuidHexDigits.timeMid)}-4${rng.hex(uuidHexDigits.timeHighAfterVersion)}-${variant(rng)}${rng.hex(uuidHexDigits.clockSequenceAfterVariant)}-${rng.hex(uuidHexDigits.node)}`;

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
