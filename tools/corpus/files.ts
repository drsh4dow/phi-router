import { Array, Order, String as Str, pipe } from "effect";
import type { PhiRecord, RenderInput } from "./record.ts";
import { compactJson, prettyJson } from "./encodings.ts";
import { labelledValues, topicOf } from "./record.ts";
import { rowObject, sqlString } from "./tabular.ts";
import type { Random } from "./random.ts";

const abbreviatedHashLength = 7;

const diffHeader = ({ rng, path }: { readonly rng: Random; readonly path: string }): readonly string[] => [
	`diff --git a/${path} b/${path}`,
	`index ${rng.hex(abbreviatedHashLength)}..${rng.hex(abbreviatedHashLength)} 100644`,
	`--- a/${path}`,
	`+++ b/${path}`,
];

const hunk = (context: Array.NonEmptyReadonlyArray<string>, added: readonly string[]): readonly string[] => [
	`@@ -1,${String(context.length)} +1,${String(context.length + added.length)} @@`,
	` ${Array.headNonEmpty(context)}`,
	...pipe(
		added,
		Array.map((line) => `+${line}`),
	),
	...pipe(
		Array.tailNonEmpty(context),
		Array.map((line) => ` ${line}`),
	),
];

interface Fixture {
	readonly path: string;
	readonly context: Array.NonEmptyReadonlyArray<string>;
	readonly added: (record: PhiRecord) => readonly string[];
}

const fixtures: Array.NonEmptyReadonlyArray<Fixture> = [
	{
		added: (record) => {
			const json = prettyJson(rowObject(record));

			return pipe(
				Str.split("\n")(`${json},`),
				Array.map((line) => `  ${line}`),
			);
		},
		context: ["[", "  {", '    "id": 1,', '    "status": "pending"'],
		path: "test/fixtures/claims.json",
	},
	{
		added: (record) => [
			`  - id: ${String(record.rowId)}`,
			...pipe(
				labelledValues(record),
				Array.map(({ key, value }) => `    ${key}: "${value}"`),
			),
		],
		context: ["patients:", "  - id: 1", "    status: pending"],
		path: "db/seeds/patients.yml",
	},
	{
		added: (record) => {
			const values = labelledValues(record);

			const columns = pipe(
				values,
				Array.map(({ key }) => key),
				Array.join(", "),
			);

			const row = pipe(
				values,
				Array.map(({ value }) => sqlString(value)),
				Array.join(", "),
			);

			return [`INSERT INTO member_claims (id, ${columns}) VALUES (${String(record.rowId)}, ${row});`];
		},
		context: ["-- seed data for local development", "INSERT INTO member_claims (id, status) VALUES (1, 'pending');"],
		path: "db/seeds/002_claims.sql",
	},
];

const gitDiff = ({ record, rng, minified }: RenderInput): string => {
	if (minified) {
		const path = "test/fixtures/claims.min.json";
		const row = compactJson([rowObject(record)]);

		return Array.join(
			[...diffHeader({ path, rng }), "@@ -1 +1 @@", "-[]", `+${row}`, String.raw`\ No newline at end of file`],
			"\n",
		);
	}

	const { path, context, added } = rng.pick(fixtures);

	return Array.join([...diffHeader({ path, rng }), ...hunk(context, added(record))], "\n");
};

const neighbours = [
	"claims_batch_0447.csv",
	"manifest.json",
	"remits/era_835_0447.txt",
	"README.txt",
	"eligibility/270_batch_0447.x12",
	"summary.xlsx",
];

const neighboursListed = 4;

const fileName = ({ record, rng, minified }: RenderInput): string => {
	const root = `exports/2025-${rng.pick(["01", "02", "03", "04"])}`;
	const topic = topicOf(record);
	const document = rng.pick(["referral", "discharge-summary", "lab-results", "intake-form", "prior-auth"]);

	const owner = Array.join(
		[
			String(record.rowId),
			...pipe(
				record.fields,
				Array.map(({ value }) => value),
			),
		],
		"_",
	);

	const phiPath = `${root}/${rng.pick(["referrals", "scans", "outbox"])}/${owner}_${topic}_${document}.pdf`;

	const others = pipe(
		Array.take(rng.shuffle(neighbours), neighboursListed),
		Array.map((name) => `${root}/${name}`),
	);

	const listing = pipe([...others, phiPath], Array.sortBy(Order.String));

	if (minified) {
		return compactJson({ files: listing });
	}

	return Array.join(listing, "\n");
};

export { diffHeader, fileName, gitDiff };
