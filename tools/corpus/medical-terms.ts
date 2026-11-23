import { Array, String as Str, pipe } from "effect";
import type { ByLang } from "./people.ts";
import type { Diagnosis } from "./health.ts";
import type { Random } from "./random.ts";
import type { Sample } from "./conversation.ts";
import { diagnoses } from "./health.ts";
import { foreignLangs } from "./people.ts";

const fewestRows = 4;
const mostRows = 8;

const someDiagnoses = (rng: Random): Diagnosis[] =>
	pipe(rng.shuffle(diagnoses), Array.take(rng.between(fewestRows, mostRows)));

const codeTable = (rng: Random): Sample => ({
	payload: Array.join(
		[
			"/** ICD-10-CM codes the chronic care dashboard groups by. */",
			"export const chronicConditions: Record<string, string> = {",
			...pipe(
				someDiagnoses(rng),
				Array.map(({ code, text }) => `  "${code}": "${text.en}",`),
			),
			"};",
		],
		"\n",
	),
	scene: {
		asks: [
			"Can you turn this lookup into a Map and add a test for unknown codes?",
			"Is this ICD-10 table complete for the chronic care report?",
		],
		commands: ["sed -n '1,40p' src/reference/icd10.ts"],
		paths: ["src/reference/icd10.ts"],
	},
});

const drugOf = (sig: string): string => Array.headNonEmpty(Str.split(" ")(sig));

const rule = ({ code, text, medication }: Diagnosis): string =>
	Array.join(
		[
			`  if (codes.has("${code}") && !active.some((drug) => drug.startsWith("${drugOf(medication.en)}"))) {`,
			`    alerts.push({ code: "${code}", message: "${text.en}: consider ${medication.en}" });`,
			"  }",
		],
		"\n",
	);

const decisionSupport = (rng: Random): Sample => ({
	payload: Array.join(
		[
			"export function careGaps(codes: Set<string>, active: string[]): Alert[] {",
			"  const alerts: Alert[] = [];",
			...pipe(
				someDiagnoses(rng),
				Array.map((diagnosis) => rule(diagnosis)),
			),
			"  return alerts;",
			"}",
		],
		"\n",
	),
	scene: {
		asks: [
			"These care-gap alerts fire twice. Can you dedupe them?",
			"Refactor this rule engine into a table of rules.",
		],
		commands: ["git show HEAD:src/cds/care-gaps.ts | head -50"],
		paths: ["src/cds/care-gaps.ts"],
	},
});

const interactionRows = [
	"warfarin,amiodarone,major,Increased INR and bleeding risk; reduce warfarin dose",
	"sertraline,tramadol,major,Serotonin syndrome risk",
	"lisinopril,spironolactone,moderate,Hyperkalemia; monitor potassium",
	"metformin,iodinated contrast,moderate,Hold metformin 48 hours after contrast",
	"levetiracetam,alcohol,minor,Additive CNS depression",
	"simvastatin,clarithromycin,major,Myopathy and rhabdomyolysis",
	"furosemide,gentamicin,moderate,Ototoxicity",
	"apixaban,ketoconazole,major,Raised apixaban levels",
];

const interactions = (rng: Random): Sample => {
	const rows = pipe(rng.shuffle(interactionRows), Array.take(rng.between(fewestRows, mostRows)));

	return {
		payload: Array.join(["drug_a,drug_b,severity,note", ...rows], "\n"),
		scene: {
			asks: [
				"The interaction checker misses a pair from this table. Which one?",
				"Load this table into the formulary service.",
			],
			commands: ["head -20 data/formulary/interactions.csv"],
			paths: ["data/formulary/interactions.csv"],
		},
	};
};

const valueSet = (rng: Random): Sample => ({
	payload: Array.join(
		[
			'{"resourceType":"ValueSet","id":"chronic-conditions","status":"draft",',
			'"compose":{"include":[{"system":"http://hl7.org/fhir/sid/icd-10-cm","concept":[',
			...pipe(
				someDiagnoses(rng),
				Array.map(({ code, text }) => `{"code":"${code}","display":"${text.en}"},`),
			),
			'{"code":"Z00.00","display":"Encounter for general adult medical examination without abnormal findings"}',
			"]}]}}",
		],
		"\n",
	),
	scene: {
		asks: [
			"The terminology server rejects this ValueSet. Is the compose block valid?",
			"Add the missing codes to this ValueSet.",
		],
		commands: ["cat fhir/valuesets/chronic-conditions.json"],
		paths: ["fhir/valuesets/chronic-conditions.json"],
	},
});

const aggregateRow = (rng: Random, { code, text }: Diagnosis): string => {
	const january = 1;
	const september = 9;
	const codeWidth = 14;
	const descriptionWidth = 45;
	const encountersWidth = 10;
	const fewestEncounters = 40;
	const mostEncounters = 3000;
	const description = Str.padEnd(descriptionWidth)(Str.takeLeft(text.en, descriptionWidth));

	return ` 2025-0${String(rng.between(january, september))} | ${Str.padEnd(codeWidth)(code)} | ${description} | ${Str.padStart(encountersWidth)(String(rng.between(fewestEncounters, mostEncounters)))}`;
};

const aggregate = (rng: Random): Sample => ({
	payload: Array.join(
		[
			" month   | diagnosis_code | description                                   | encounters",
			"---------+----------------+-----------------------------------------------+-----------",
			...pipe(
				someDiagnoses(rng),
				Array.map((diagnosis) => aggregateRow(rng, diagnosis)),
			),
		],
		"\n",
	),
	scene: {
		asks: [
			"The monthly totals in this report don't add up. Can you check the SQL behind it?",
			"Plot these counts by month.",
		],
		commands: ["psql -c 'SELECT * FROM reporting.monthly_dx_counts' analytics"],
		paths: ["reports/monthly_dx_counts.txt"],
	},
});

const sigTest = (rng: Random): Sample => ({
	payload: Array.join(
		pipe(
			someDiagnoses(rng),
			Array.map(
				({ medication }) =>
					`test("${medication.en}", () => {\n  expect(parseSig("${medication.en}").dose).toBeDefined();\n});`,
			),
		),
		"\n\n",
	),
	scene: {
		asks: ["Why does the sig parser fail on these?", "Add cases for PRN dosing to this test."],
		commands: ["bun test test/sig-parser.test.ts"],
		paths: ["test/sig-parser.test.ts"],
	},
});

const titles = {
	de: "Diagnosen",
	en: "Diagnoses",
	es: "Diagnósticos",
	fr: "Diagnostics",
	pt: "Diagnósticos",
	vi: "Chẩn đoán",
} satisfies ByLang<string>;

const glossary = (rng: Random): Sample => {
	const lang = rng.pick(foreignLangs);

	return {
		payload: Array.join(
			[
				"{",
				...pipe(
					someDiagnoses(rng),
					Array.map(({ code, text }) => `  "dx.${code}": "${text[lang]}",`),
				),
				`  "dx.title": "${titles[lang]}"`,
				"}",
			],
			"\n",
		),
		scene: {
			asks: [
				"The translated diagnosis labels don't show up in the portal. Is this locale file wrong?",
				"Check these translations against the English keys.",
			],
			commands: [`cat locales/${lang}/diagnoses.json`],
			paths: [`locales/${lang}/diagnoses.json`],
		},
	};
};

export const medicalTerms: Array.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	codeTable,
	decisionSupport,
	interactions,
	valueSet,
	aggregate,
	sigTest,
	glossary,
];
