import { Array, Record, String as Str, pipe } from "effect";
import type { PhiRecord, RenderInput } from "./record.ts";
import { labelledValues, recordObject } from "./record.ts";
import type { ByLang } from "./people.ts";
import type { Random } from "./random.ts";
import { compactJson } from "./encodings.ts";

const tables = {
	de: ["patienten_aufnahme", "abrechnung_export", "ueberweisungen"],
	en: ["member_claims", "patient_intake", "encounter_staging", "billing_export", "referral_queue"],
	es: ["pacientes_ingreso", "reclamos_afiliados", "citas_pendientes"],
	fr: ["dossiers_patients", "demandes_remboursement", "admissions"],
	pt: ["atendimentos_pacientes", "guias_faturamento", "internacoes"],
	vi: ["benh_nhan_kham", "ho_so_thanh_toan", "luot_nhap_vien"],
} satisfies ByLang<Array.NonEmptyReadonlyArray<string>>;

const sqlString = (value: string): string => `'${Str.replaceAll("'", "''")(value)}'`;

/**
 * A record as one row object, its internal id first.
 *
 * @param {PhiRecord} record The record.
 * @returns {Record<string, number | string>} The row, keyed by column name.
 */
const rowObject = (record: PhiRecord): Record<string, number | string> => {
	const labelled = recordObject(labelledValues(record));

	return Record.fromEntries([["id", record.internalId], ...Record.toEntries(labelled)]);
};

const pgDump = (table: string, columns: readonly string[], row: readonly string[]): string =>
	Array.join(
		[
			"--",
			"-- PostgreSQL database dump",
			"--",
			"",
			"-- Dumped from database version 15.6",
			"-- Dumped by pg_dump version 15.6",
			"",
			"SET statement_timeout = 0;",
			"SET client_encoding = 'UTF8';",
			"SET standard_conforming_strings = on;",
			"",
			`COPY public.${table} (${Array.join(columns, ", ")}) FROM stdin;`,
			Array.join(row, "\t"),
			String.raw`\.`,
			"",
		],
		"\n",
	);

const mysqlDump = (table: string, columns: Array.NonEmptyReadonlyArray<string>, row: readonly string[]): string =>
	Array.join(
		[
			"-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)",
			"--",
			`-- Table structure for table \`${table}\``,
			"--",
			"",
			`DROP TABLE IF EXISTS \`${table}\`;`,
			`CREATE TABLE \`${table}\` (`,
			"  `id` bigint NOT NULL AUTO_INCREMENT,",
			...pipe(
				Array.tailNonEmpty(columns),
				Array.map((column) => `  \`${column}\` varchar(255) DEFAULT NULL,`),
			),
			"  PRIMARY KEY (`id`)",
			") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
			"",
			`INSERT INTO \`${table}\` VALUES (${Array.join(row, ",")});`,
			"",
		],
		"\n",
	);

const postgresShare = 0.5;

const sqlDump = ({ record, rng, minified }: RenderInput): string => {
	const values = labelledValues(record);
	const table = rng.pick(tables[record.lang]);

	const columns: Array.NonEmptyReadonlyArray<string> = [
		"id",
		...pipe(
			values,
			Array.map(({ snakeCaseKey }) => snakeCaseKey),
		),
	];

	const quoted = [
		String(record.internalId),
		...pipe(
			values,
			Array.map(({ value }) => sqlString(value)),
		),
	];

	if (minified) {
		const columnList = pipe(
			columns,
			Array.map((column) => `\`${column}\``),
			Array.join(","),
		);

		return `/*!40101 SET NAMES utf8mb4 */;LOCK TABLES \`${table}\` WRITE;INSERT INTO \`${table}\` (${columnList}) VALUES (${Array.join(quoted, ",")});UNLOCK TABLES;`;
	}

	if (rng.chance(postgresShare)) {
		return pgDump(table, columns, [
			String(record.internalId),
			...pipe(
				values,
				Array.map(({ value }) => value),
			),
		]);
	}

	return mysqlDump(table, columns, quoted);
};

const csvField = (value: string): string => {
	if (/[",\n]/u.test(value)) {
		return `"${Str.replaceAll('"', '""')(value)}"`;
	}

	return value;
};

const semicolonShare = 0.2;

const csvSeparator = (rng: Random): string => {
	if (rng.chance(semicolonShare)) {
		return ";";
	}

	return ",";
};

const csv = ({ record, rng, minified }: RenderInput): string => {
	const values = labelledValues(record);

	if (minified) {
		return compactJson([rowObject(record)]);
	}

	const separator = csvSeparator(rng);

	const header = pipe(
		[
			"id",
			...pipe(
				values,
				Array.map(({ snakeCaseKey }) => snakeCaseKey),
			),
		],
		Array.join(separator),
	);

	const row = pipe(
		[
			String(record.internalId),
			...pipe(
				values,
				Array.map(({ value }) => csvField(value)),
			),
		],
		Array.join(separator),
	);

	return `${header}\n${row}\n`;
};

export { csv, rowObject, sqlDump, sqlString };
