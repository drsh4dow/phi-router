import { Array, pipe } from "effect";
import type { Synthetic, TextCarrier } from "./manifest.ts";
import type { PersonName } from "./people.ts";
import type { Random } from "./random.ts";
import type { Sample } from "./conversation.ts";
import { TextCarriers } from "./manifest.ts";
import { carriers } from "./carriers.ts";
import { diagnoses } from "./health.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { nameIn } from "./identifiers.ts";

const personas: Array.NonEmptyReadonlyArray<{ readonly name: PersonName; readonly member: string }> = [
	{ member: "ZQA900000417", name: { family: "Testmember", given: "Quinlan", lang: "en" } },
	{ member: "ZQA900000522", name: { family: "Fixtureson", given: "Avery", lang: "en" } },
	{ member: "ZQA900000638", name: { family: "Stagingly", given: "Morgan", lang: "en" } },
];

const clientCodePrefix = "STGQA-";

const synthetic: Synthetic = {
	exact: pipe(
		personas,
		Array.flatMap(({ name, member }) => [
			...pipe(
				TextCarriers.literals,
				Array.map((carrier) => nameIn(carrier)(name)),
			),
			member,
		]),
		Array.dedupe,
	),
	prefixes: [clientCodePrefix],
};

const recordSample =
	(carrier: TextCarrier): ((rng: Random) => Sample) =>
	(rng: Random): Sample => {
		const fewestRowId = 1000;
		const mostRowId = 99_999;
		const { name, member } = rng.pick(personas);

		const record = {
			diagnosis: rng.pick(diagnoses),
			fields: [
				{ kind: identifierKind.patientName, value: nameIn(carrier)(name) },
				{ kind: identifierKind.memberNumber, value: member },
			],
			internalId: rng.between(fewestRowId, mostRowId),
			lang: "en",
		} as const;

		return { payload: carriers[carrier].render({ minified: false, record, rng }), scene: carriers[carrier] };
	};

const stagingLogLine = (rng: Random): string => {
	const clientDigits = 4;
	const firstDay = 1;
	const lastSingleDigitDay = 9;
	const firstHour = 0;
	const lastSingleDigitHour = 9;
	const firstTwoDigitMinute = 10;
	const lastMinute = 59;
	const { member } = rng.pick(personas);
	const client = `${clientCodePrefix}${rng.digits(clientDigits)}`;

	return `2025-03-0${String(rng.between(firstDay, lastSingleDigitDay))}T0${String(rng.between(firstHour, lastSingleDigitHour))}:${String(rng.between(firstTwoDigitMinute, lastMinute))}:00Z staging eligibility client=${client} member=${member} result=${rng.pick(["active", "inactive", "timeout"])}`;
};

const stagingLog = (rng: Random): Sample => {
	const fewestLines = 3;
	const mostLines = 5;
	const lines = Array.makeBy(rng.between(fewestLines, mostLines), () => stagingLogLine(rng));

	return {
		payload: Array.join(lines, "\n"),
		scene: {
			asks: ["Staging eligibility checks time out for our QA members. What's different about them?"],
			commands: ["kubectl -n staging logs deploy/eligibility --since=1h | grep member="],
			paths: ["logs/staging-eligibility.log"],
		},
	};
};

const syntheticListed: Array.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	stagingLog,
	...pipe(
		TextCarriers.literals,
		Array.map((carrier) => recordSample(carrier)),
	),
];

export { synthetic, syntheticListed };
