import { Array, Boolean as Bool, String as Str, pipe } from "effect";
import type { Random } from "./random.ts";
import type { Sample } from "./conversation.ts";
import { identifierKind } from "#router/features/policy/index.ts";

type ColumnKind = "text" | "date";

interface Column {
	readonly name: string;
	readonly camel: string;
	readonly sql: string;
	readonly kind: ColumnKind;
	readonly required: boolean;
}

const kindOf = (sql: string): ColumnKind => {
	if (Str.startsWith("date")(sql) || Str.startsWith("timestamp")(sql)) {
		return "date";
	}

	return "text";
};

const column = (name: string, sql: string, required: boolean): Column => ({
	camel: Str.snakeToCamel(name),
	kind: kindOf(sql),
	name,
	required,
	sql: Bool.match(required, { onFalse: () => sql, onTrue: () => `${sql} NOT NULL` }),
});

const ormTypeByColumnKind = { date: "DateTime", text: "String" } satisfies Record<ColumnKind, string>;

const columns: Array.NonEmptyReadonlyArray<Column> = [
	column("first_name", "varchar(100)", true),
	column("last_name", "varchar(100)", true),
	column("date_of_birth", "date", true),
	column(identifierKind.socialSecurityNumber, "char(11)", false),
	column(identifierKind.medicalRecordNumber, "varchar(20)", true),
	column("medicare_beneficiary_id", "char(11)", false),
	column("member_id", "varchar(30)", false),
	column("phone", "varchar(20)", false),
	column("email", "varchar(254)", false),
	column("street_address", "text", false),
	column("postal_code", "varchar(10)", false),
	column("diagnosis_code", "varchar(8)", false),
	column("primary_diagnosis", "text", false),
	column("medication", "text", false),
	column("admit_date", "timestamptz", false),
	column("discharge_date", "timestamptz", false),
	column("drivers_license", "varchar(20)", false),
	column("insurance_plan_id", "varchar(30)", false),
];

const tables: Array.NonEmptyReadonlyArray<string> = [
	"patients",
	"members",
	"encounters",
	"claim_subscribers",
	"referrals",
];

const revisionLength = 12;

const pickColumns = (rng: Random): Column[] => {
	const fewestColumns = 6;
	const mostColumns = 11;

	return pipe(rng.shuffle(columns), Array.take(rng.between(fewestColumns, mostColumns)));
};

const ddl = (rng: Random): Sample => {
	const table = rng.pick(tables);

	const lines = pipe(
		pickColumns(rng),
		Array.map(({ name, sql }) => `  ${name} ${sql},`),
	);

	return {
		payload: Array.join(
			[
				`CREATE TABLE ${table} (`,
				"  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),",
				...lines,
				"  created_at timestamptz NOT NULL DEFAULT now()",
				");",
				`CREATE INDEX ${table}_created_at_idx ON ${table} (created_at);`,
			],
			"\n",
		),
		scene: {
			asks: [
				"Review this table before I run the migration. Anything missing for HIPAA?",
				"Should any of these columns be encrypted at rest?",
			],
			commands: [`pg_dump --schema-only -t ${table} intake_dev`],
			paths: [`db/schema/${table}.sql`],
		},
	};
};

const prisma = (rng: Random): Sample => {
	const fieldNameWidth = 22;
	const model = rng.pick(["Patient", "Member", "Subscriber", "Enrollee"]);

	const fields = pipe(
		pickColumns(rng),
		Array.map(({ name, camel, kind, required }) => {
			const optional = Bool.match(required, { onFalse: () => "?", onTrue: () => "" });

			return `  ${Str.padEnd(fieldNameWidth)(camel)} ${ormTypeByColumnKind[kind]}${optional} @map("${name}")`;
		}),
	);

	return {
		payload: Array.join(
			[
				`model ${model} {`,
				"  id                     String   @id @default(uuid())",
				...fields,
				`  @@map("${Str.toLowerCase(model)}s")`,
				"}",
			],
			"\n",
		),
		scene: {
			asks: [
				"Prisma complains about this model after the rename. What did I miss?",
				"Can you add an index for lookups on this model?",
			],
			commands: ["npx prisma validate"],
			paths: ["prisma/schema.prisma"],
		},
	};
};

const validator = (rng: Random): Sample => {
	const fewestDiagnosisCodes = 4;
	const mostDiagnosisCodes = 12;

	return {
		payload: Array.join(
			[
				'import { z } from "zod";',
				"",
				"export const PatientIntake = z.object({",
				"  firstName: z.string().min(1).max(100),",
				"  lastName: z.string().min(1).max(100),",
				String.raw`  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),`,
				String.raw`  ssn: z.string().regex(/^\d{3}-\d{2}-\d{4}$/, "format ###-##-####").optional(),`,
				String.raw`  mbi: z.string().regex(/^[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[AC-HJKMNP-RT-Y]{2}\d{2}$/).optional(),`,
				String.raw`  phone: z.string().regex(/^\(?\d{3}\)?[ -]?\d{3}-\d{4}$/),`,
				"  email: z.string().email(),",
				String.raw`  diagnosisCode: z.string().regex(/^[A-TV-Z]\d{2}(\.\w{1,4})?$/).array().max(${String(rng.between(fewestDiagnosisCodes, mostDiagnosisCodes))}),`,
				"});",
			],
			"\n",
		),
		scene: {
			asks: [
				"The intake form validator lets bad input through. Can you tighten these patterns?",
				"Write tests for this validator.",
			],
			commands: ["sed -n '1,60p' src/intake/validate.ts"],
			paths: ["src/intake/validate.ts"],
		},
	};
};

const migration = (rng: Random): Sample => {
	const table = rng.pick(tables);
	const { name, kind } = rng.pick(columns);
	const revision = rng.hex(revisionLength);

	return {
		payload: Array.join(
			[
				`"""add ${name} to ${table}`,
				"",
				`Revision ID: ${revision}`,
				`Revises: ${rng.hex(revisionLength)}`,
				'"""',
				"from alembic import op",
				"import sqlalchemy as sa",
				"",
				"def upgrade():",
				`    op.add_column("${table}", sa.Column("${name}", sa.${ormTypeByColumnKind[kind]}(), nullable=True))`,
				`    op.create_index("ix_${table}_${name}", "${table}", ["${name}"])`,
				"",
				"def downgrade():",
				`    op.drop_index("ix_${table}_${name}", table_name="${table}")`,
				`    op.drop_column("${table}", "${name}")`,
			],
			"\n",
		),
		scene: {
			asks: [
				"Alembic says the head is diverged after this migration. Can you fix the chain?",
				"Does this downgrade path lose data?",
			],
			commands: ["alembic history --verbose | head -40"],
			paths: [`migrations/versions/${revision}_add_${name}.py`],
		},
	};
};

const segmentRows = [
	"| PID-3 | Patient identifier list (MRN, CX type MR) | patients.mrn |",
	"| PID-5 | Patient name (XPN) | patients.last_name, patients.first_name |",
	"| PID-7 | Date/time of birth | patients.date_of_birth |",
	"| PID-11 | Patient address (XAD) | patients.street_address |",
	"| PID-13 | Home phone (XTN) | patients.phone |",
	"| PID-19 | SSN number, patient | patients.ssn |",
	"| PV1-44 | Admit date/time | encounters.admit_date |",
	"| DG1-3 | Diagnosis code (CWE, ICD-10-CM) | encounters.diagnosis_code |",
	"| IN1-36 | Policy number | coverage.member_id |",
];

const segmentMap = (rng: Random): Sample => {
	const fewestRows = 5;
	const mostRows = 9;
	const rows = pipe(rng.shuffle(segmentRows), Array.take(rng.between(fewestRows, mostRows)));

	return {
		payload: Array.join(["| Segment field | Meaning | Target column |", "| --- | --- | --- |", ...rows], "\n"),
		scene: {
			asks: [
				"Our HL7 mapping doc is out of date. Can you check it against the parser?",
				"Generate TypeScript types from this mapping table.",
			],
			commands: ["cat docs/interfaces/adt-mapping.md"],
			paths: ["docs/interfaces/adt-mapping.md"],
		},
	};
};

const emptyExport = (rng: Random): Sample => {
	const header = pipe(
		pickColumns(rng),
		Array.map(({ name }) => name),
	);

	return {
		payload: `${Array.join(["record_id", ...header], ",")}\n`,
		scene: {
			asks: ["The export job writes only the header. Why are there no rows?", "Why is the nightly extract empty?"],
			commands: [`head -5 exports/${rng.pick(tables)}_extract.csv && wc -l exports/*.csv`],
			paths: [`exports/${rng.pick(tables)}_extract.csv`],
		},
	};
};

const sqlalchemy = (rng: Random): Sample => {
	const fields = pipe(
		pickColumns(rng),
		Array.map(({ name, kind, required }) => {
			const nullable = Bool.match(required, { onFalse: () => "True", onTrue: () => "False" });

			return `    ${name} = Column(${ormTypeByColumnKind[kind]}, nullable=${nullable})`;
		}),
	);

	return {
		payload: Array.join(
			[
				"class Patient(Base):",
				'    __tablename__ = "patients"',
				"",
				"    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)",
				...fields,
			],
			"\n",
		),
		scene: {
			asks: [
				"Convert this SQLAlchemy model to the 2.0 typed style.",
				"Mark which of these columns need the encrypted type.",
			],
			commands: ["sed -n '1,40p' app/models/patient.py"],
			paths: ["app/models/patient.py"],
		},
	};
};

export const schemaOnly: Array.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	ddl,
	prisma,
	validator,
	migration,
	segmentMap,
	emptyExport,
	sqlalchemy,
];
